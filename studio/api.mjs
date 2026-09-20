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

// Active org (Stage 2 tenancy — server/tenancy.mjs). When the server has
// orgs.json, every /api call carries X-Observogram-Org so the request runs
// in that org's workspace. Resolved at boot from /auth/me memberships +
// the persisted choice; null outside tenancy mode.
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

// The headers every session-authenticated studio request needs: CSRF
// always, the active org when tenancy is on. Raw fetch() call sites use
// this too — one source of truth.
export function authHeaders() {
  return { ...CSRF_HEADER, ...(activeOrg ? { 'X-Observogram-Org': activeOrg } : {}) };
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
  // HTML fallback from a stale server, or a proxy error page).
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    throw new Error(`/api/validate: server returned non-JSON (${ct || 'no content-type'}, ${r.status}). Restart \`npm run dev\` if the route is new.${text ? '\n' + text.slice(0, 200) : ''}`);
  }
  return r.json();
}
