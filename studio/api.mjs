// studio/api.mjs
//
// The studio's thin HTTP layer. Every server call goes through `api()`,
// which sniffs for the HTML fallback a stale server can return at 200 and
// turns it into a clear, actionable error rather than a JSON parse crash.
// Pure of UI; depends only on `state` (to cache the pack catalog). Imported
// by app.mjs and the view modules.

import { state } from './state.mjs';

// Session-authenticated mutations must carry this header (CSRF defence
// in identity mode — see server/auth.mjs). Sent on every studio request;
// the server ignores it outside identity mode.
export const CSRF_HEADER = { 'X-Observogram-CSRF': '1' };

// Active org (Stage 2 tenancy — server/tenancy.mjs, always on). In the
// identity postures every /api call carries X-Observogram-Org so the
// request runs in that org's workspace. Resolved at boot from /auth/me
// memberships + the persisted choice; null in the open posture (the
// server runs it in the default org).
let activeOrg = null;
export function setActiveOrg(id) {
  activeOrg = id || null;
  try {
    if (activeOrg) localStorage.setItem('studioOrg.v1', activeOrg);
    else localStorage.removeItem('studioOrg.v1');
  } catch (_) {}
}
export function getActiveOrg() { return activeOrg; }
export function savedOrg() { try { return localStorage.getItem('studioOrg.v1') || null; } catch (_) { return null; } }

// The ORG chip, one pure rule for both header sites (studio/app.mjs):
// a switcher for a user in more than one org, a static label for a user
// whose only org is not the deployment's default one, and nothing
// otherwise (no org, or the default org only: the flat look of a fresh
// install or an upgraded single-org deployment). `orgs` is /auth/me's
// list ({ id, name, role, default }); `active` is `activeId` when it is
// one of them, else the first.
export function orgChipModel(orgs, activeId = null) {
  const list = Array.isArray(orgs) ? orgs : [];
  const active = list.find((o) => o.id === activeId) || list[0] || null;
  if (list.length > 1) return { kind: 'switcher', active };
  if (list.length === 1 && !list[0].default) return { kind: 'label', active };
  return { kind: 'none', active };
}

// The headers every session-authenticated studio request needs: CSRF
// always, the active org when tenancy is on. Raw fetch() call sites use
// this too — one source of truth.
export function authHeaders() {
  return { ...CSRF_HEADER, ...(activeOrg ? { 'X-Observogram-Org': activeOrg } : {}) };
}

// A navigation (a link, window.open, a download) cannot send a header, so
// it names the active org in the query instead — the org middleware reads
// ?org= (server/authz.mjs orgContext). '' without an active org; `sep` is
// '&' when the URL already has a query.
export function orgQuery(sep = '?') {
  return activeOrg ? `${sep}org=${encodeURIComponent(activeOrg)}` : '';
}

// A refusal by the server's auth gate, org middleware or route guard
// carries `denied` (auth · csrf · org · role · posture) and a sentence
// that names the way out — shown as is: `${status}: ${error}`. null for
// any other body (a handler's own error keeps its format).
export function deniedError(status, body) {
  let json = body;
  if (typeof body === 'string') { try { json = JSON.parse(body); } catch { return null; } }
  if (!json || typeof json !== 'object' || !json.denied) return null;
  const err = new Error(`${status}: ${json.error || 'refused'}`);
  err.denied = json.denied;
  err.status = status;
  return err;
}

// A deploy-bulk answer that is no deploy result — the guard's denial, or
// the route's own refusal (an unknown pack, a bad URL, strict snapshot
// mode) — as the Error the deploy modal shows: the server's text, as
// deniedError() words it. null for a result: it has a summary, even when
// every item failed (the result table shows each).
export function deployRefusal(status, body) {
  if (body && typeof body === 'object' && body.summary) return null;
  return deniedError(status, body) || new Error(`${status}: ${body?.error || 'no deploy result'}`);
}

// ---------- the remembered MCP URL (per user and org) ----------
//
// The MCP panels prefill the URL this user last used in the active org:
// remembered > the server's live-status url for this org > empty. Stored
// under mcpUrl.v2:<login or 'local'>:<active org or 'default'>, in its safe
// form (tools/lib/mcp-url-safety.mjs: no userinfo, fragment or credential
// query parameter — a token belongs in the auth field), and cleared at
// sign-out. The unscoped pre-slice-3 key 'mcpUrl' is never read again.
const MCP_URL_KEY_PREFIX = 'mcpUrl.v2:';
const LEGACY_MCP_URL_KEY = 'mcpUrl';
let signedInLogin = null;
// Set from /auth/me at boot; null in the open posture ('local').
export function setSignedInLogin(login) { signedInLogin = login || null; }
const mcpUrlKey = () => `${MCP_URL_KEY_PREFIX}${signedInLogin || 'local'}:${activeOrg || 'default'}`;

export function recallMcpUrl() {
  try { return localStorage.getItem(mcpUrlKey()) || null; } catch { return null; }
}

// Stores the safe form; returns the names of the parameters it dropped.
// The rule is loaded at call time — never statically: the Node suites that
// import this module have no /lib/.
export async function rememberMcpUrl(url) {
  const { stripMcpUrl } = await import('/lib/mcp-url-safety.mjs');
  const { safe, dropped } = stripMcpUrl(url);
  try {
    localStorage.removeItem(LEGACY_MCP_URL_KEY);
    if (safe) localStorage.setItem(mcpUrlKey(), safe);
  } catch { /* storage unavailable: nothing remembered */ }
  return dropped;
}

// Every URL this login remembered, in every org, and the legacy key.
export function forgetMcpUrls(login = signedInLogin) {
  try {
    const prefix = `${MCP_URL_KEY_PREFIX}${login || 'local'}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) localStorage.removeItem(k);
    }
    localStorage.removeItem(LEGACY_MCP_URL_KEY);
  } catch { /* storage unavailable */ }
}

export async function api(path, opts = {}) {
  // Merge headers instead of replacing them, so callers passing their own
  // Content-Type keep Accept + the CSRF/org headers.
  const r = await fetch(path, {
    ...opts,
    headers: { Accept: 'application/json', ...authHeaders(), ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    // Identity mode: the server points at the login page — go there.
    const body = await r.clone().json().catch(() => null);
    if (body?.login) { window.location.assign(body.login); throw new Error('signed out — redirecting to login'); }
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const denial = deniedError(r.status, body);
    if (denial) throw denial;
    throw new Error(`${r.status} ${r.statusText} on ${path}${body ? ': ' + body.slice(0, 200) : ''}`);
  }
  // Some routes might be missing on a stale server, returning an HTML
  // fallback even at 200. Sniff the content-type first.
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const body = await r.text().catch(() => '');
    throw new Error(`${path}: server returned non-JSON (${ct || 'no content-type'}, ${r.status}). Restart \`npm run dev\` if the route is new.${body ? '\n' + body.slice(0, 200) : ''}`);
  }
  return r.json();
}

export async function loadCatalog() {
  const { packs } = await api('/api/packs');
  state.catalog = packs || [];
}

export async function validateUploaded(body, contentType, env) {
  const q = env ? `?env=${encodeURIComponent(env)}` : '';
  const r = await fetch(`/api/validate${q}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, Accept: 'application/json', ...authHeaders() },
    body,
  });
  // /api/validate reports schema failures as JSON with a non-2xx status, so
  // only treat the response as an error when it isn't JSON at all (e.g. the
  // HTML fallback from a stale server, or a proxy error page) or when it is
  // a denial (below).
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    throw new Error(`/api/validate: server returned non-JSON (${ct || 'no content-type'}, ${r.status}). Restart \`npm run dev\` if the route is new.${text ? '\n' + text.slice(0, 200) : ''}`);
  }
  const json = await r.json();
  // A denial (a viewer, a signed-out session) is not a schema failure:
  // throw it, so every caller's catch shows the server's sentence.
  const denial = deniedError(r.status, json);
  if (denial) throw denial;
  return json;
}
