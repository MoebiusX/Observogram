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

// What the account menu says after "sign out my other sessions" (POST
// /auth/signout-others): done, or the server's refusal as it words it —
// `${status}: ${error}`, as deniedError() does. `body` is the parsed answer
// or null; status 0 is no answer at all (`body.error` the network's).
export function signOutOthersText(status, body) {
  if (status === 200 && body?.ok === true) return 'other sessions signed out';
  if (body?.error) return status ? `${status}: ${body.error}` : String(body.error);
  return status ? `${status}: the other sessions were not signed out` : 'the other sessions were not signed out — the server did not answer';
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

// The safety rule (tools/lib/mcp-url-safety.mjs), loaded at call time —
// never statically: the Node suites that import this module have no /lib/.
// A load that failed is not kept: the next call tries again (a server
// mid-restart at boot must not disable every save until a reload).
let mcpUrlSafety = null;
const loadMcpUrlSafety = () => mcpUrlSafety || (mcpUrlSafety = import('/lib/mcp-url-safety.mjs').catch((e) => { mcpUrlSafety = null; throw e; }));

// Stores the safe form; returns the names of the parameters it dropped.
export async function rememberMcpUrl(url) {
  const { stripMcpUrl } = await loadMcpUrlSafety();
  const { safe, dropped } = stripMcpUrl(url);
  try {
    localStorage.removeItem(LEGACY_MCP_URL_KEY);
    if (safe) localStorage.setItem(mcpUrlKey(), safe);
  } catch { /* storage unavailable: nothing remembered */ }
  return dropped;
}

// ---------- deploy target profiles (per user) ----------
//
// The deploy modal's saved targets (name → { targetUrl, folder, product,
// version, mcpUrl }). Stored under deployProfiles.v2:<login or 'local'> —
// per user, not per org: a profile is a destination the user deploys to,
// not the org's data — each URL in its safe form, as the remembered URL
// is (stripMcpUrl: no userinfo, fragment or credential parameter, and
// nothing at all when it is not a URL; a token belongs in the auth field):
// the MCP URL, and the target URL (Grafana, kept for the profile's notes
// and never sent) by the same rule. Cleared at sign-out with the
// remembered URLs. The pre-slice-3 key 'deployProfiles.v1' (one map for
// the whole browser, its URLs as typed) is adopted once — every URL
// stripped, the map written under this user's key, the key removed — and
// never read again; the studio adopts it at boot once the login is known
// (app.mjs boot), else at the first read.
const DEPLOY_PROFILES_KEY_PREFIX = 'deployProfiles.v2:';
const LEGACY_DEPLOY_PROFILES_KEY = 'deployProfiles.v1';
export const deployProfilesKey = (login = signedInLogin) => `${DEPLOY_PROFILES_KEY_PREFIX}${login || 'local'}`;

// A stored map (name → profile object), or {} for anything else: absent,
// malformed, not an object; an entry that is no object is left out.
function parseProfiles(text) {
  if (typeof text !== 'string') return {};
  let map;
  try { map = JSON.parse(text); } catch { return {}; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  return Object.fromEntries(Object.entries(map).filter(([, p]) => p && typeof p === 'object' && !Array.isArray(p)));
}

// Pure. One profile as it may be stored: its MCP URL and its target URL in
// the safe form, the other fields as given. { profile, dropped, notUrl,
// droppedTarget, targetNotUrl }: the (decoded) names of the parameters
// each URL lost, and notUrl / targetNotUrl when something was typed that
// is no URL — kept as nothing, since no name rule can read it. The rule is
// handed in (the studio's is loaded from /lib; a test's from tools/lib).
export function safeDeployProfile(profile, stripMcpUrl) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const typed = String(p.mcpUrl ?? '').trim();
  const typedTarget = String(p.targetUrl ?? '').trim();
  const { safe, dropped } = stripMcpUrl(typed);
  const target = stripMcpUrl(typedTarget);
  return {
    profile: { ...p, targetUrl: target.safe || '', mcpUrl: safe || '' },
    dropped, notUrl: Boolean(typed) && !safe,
    droppedTarget: target.dropped, targetNotUrl: Boolean(typedTarget) && !target.safe,
  };
}

// Pure. The map to store when the pre-slice-3 key is found: its profiles,
// each stripped, under the ones this user already has (a name in both
// keeps the stored one: already safe, and the newer). `legacy` and
// `current` are the keys' texts (null when absent). { profiles, dropped,
// droppedTarget } — per legacy profile name, the parameters its MCP URL
// and its target URL lost.
export function migrateDeployProfiles(legacy, current, stripMcpUrl) {
  const profiles = {};
  const dropped = {};
  const droppedTarget = {};
  for (const [name, p] of Object.entries(parseProfiles(legacy))) {
    const r = safeDeployProfile(p, stripMcpUrl);
    profiles[name] = r.profile;
    if (r.dropped.length) dropped[name] = r.dropped;
    if (r.droppedTarget.length) droppedTarget[name] = r.droppedTarget;
  }
  return { profiles: { ...profiles, ...parseProfiles(current) }, dropped, droppedTarget };
}

// Pure. What the deploy modal's status line says after a save: null when
// the profile is stored as typed; else what was not kept, URL by URL —
// worded as the refresh panel's note is (the lib's droppedNote, handed in
// as stripMcpUrl is) — and, for the MCP URL, where a token goes: the auth
// field. (The target URL is notes: nothing of it is sent anywhere.)
export function deployProfileSavedText(name, { dropped = [], notUrl = false, droppedTarget = [], targetNotUrl = false } = {}, droppedNote) {
  const why = [
    notUrl
      ? 'not kept in the profile: the MCP URL, which is not a URL (scheme://host/…)'
      : droppedNote(dropped, { where: 'not kept in the profile' }),
    targetNotUrl
      ? 'not kept in the profile: the target URL, which is not a URL (scheme://host/…)'
      : droppedNote(droppedTarget, { where: 'not kept in the profile', of: 'the target URL', hint: '' }),
  ].filter(Boolean);
  return why.length ? `profile "${name}" saved · ${why.join(' · ')}` : null;
}

function writeDeployProfiles(profiles) {
  try { localStorage.setItem(deployProfilesKey(), JSON.stringify(profiles)); } catch { /* storage unavailable: nothing kept */ }
}

// This user's profiles — after adopting the pre-slice-3 key when it is
// there (once: it is removed, and only once its profiles are written
// stripped under this user's key). {} when storage is unavailable.
export async function loadDeployProfiles() {
  try {
    const legacy = localStorage.getItem(LEGACY_DEPLOY_PROFILES_KEY);
    if (legacy === null) return parseProfiles(localStorage.getItem(deployProfilesKey()));
    const { stripMcpUrl } = await loadMcpUrlSafety();
    const { profiles } = migrateDeployProfiles(legacy, localStorage.getItem(deployProfilesKey()), stripMcpUrl);
    localStorage.setItem(deployProfilesKey(), JSON.stringify(profiles));
    localStorage.removeItem(LEGACY_DEPLOY_PROFILES_KEY);
    return profiles;
  } catch { return {}; }
}

// Stores one profile in its safe form; returns the status line's text
// (null when the profile is stored as typed).
export async function storeDeployProfile(name, profile) {
  const { stripMcpUrl, droppedNote } = await loadMcpUrlSafety();
  const profiles = await loadDeployProfiles();
  const { profile: safe, dropped, notUrl, droppedTarget, targetNotUrl } = safeDeployProfile(profile, stripMcpUrl);
  profiles[name] = safe;
  writeDeployProfiles(profiles);
  return deployProfileSavedText(name, { dropped, notUrl, droppedTarget, targetNotUrl }, droppedNote);
}

// Nothing is written when the name is not there — a map that could not
// be read (storage unavailable, the rule not loaded) comes back as {},
// and {} must never be stored over the user's profiles.
export async function removeDeployProfile(name) {
  const profiles = await loadDeployProfiles();
  if (!Object.hasOwn(profiles, name)) return;
  delete profiles[name];
  writeDeployProfiles(profiles);
}

// At sign-out: every URL this login remembered, in every org, and the
// legacy key — and every deploy target profile in the browser (every
// user's, and the pre-slice-3 key): a shared browser keeps neither past
// a sign-out.
export function forgetMcpUrls(login = signedInLogin) {
  try {
    const prefix = `${MCP_URL_KEY_PREFIX}${login || 'local'}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(prefix) || k.startsWith(DEPLOY_PROFILES_KEY_PREFIX))) localStorage.removeItem(k);
    }
    localStorage.removeItem(LEGACY_MCP_URL_KEY);
    localStorage.removeItem(LEGACY_DEPLOY_PROFILES_KEY);
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
