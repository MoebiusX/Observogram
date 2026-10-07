// server/mcp-target-policy.mjs — who may name an MCP target, which targets
// the server may reach, and what it does with a resolved target beyond
// fetching it. SQL-free: the org's endpoints and the variable owners come
// from server/store/*.
//
// The typed-URL rule (rebadge batch 3, RULINGS R2/R4): supplying a target URL
// is the privilege, not which endpoint uses it. A typed `mcpUrl` needs
// TYPED_MCP_URL_ROLE (admin, owner included) — one constant, against which
// every principal that has a role is judged by rank: a session and the
// bearer (an operator). The anonymous `local` caller of the open postures is
// refused by kind, even on loopback: its role is admin, so a rank check
// alone would let it type. Everyone else fetches from the org's registered
// endpoints (mcpEndpointId). typedMcpUrlDecision answers it;
// mcpTargetView tells the studio (GET /api/mcp-endpoints `policy`).
//
// The origin allowlist (rebadge batch 3, RULINGS R4, decision D2). Every MCP
// target — a typed URL, a registered endpoint at use, and an endpoint at
// registration (POST, and a PATCH of url or readTokenEnv) — meets
// mcpOriginDecision, whatever the caller's role. The list is
// OBSERVOGRAM_MCP_ORIGINS (every org) ∪ OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS
// (one org: read only by the org that owns the name, the longest-prefix rule
// of server/store/mcp-endpoints.mjs), read per call so a suite can flip it.
// Loopback (localhost, 127.0.0.0/8, [::1], [::ffff:127.x.y.z]) is this
// machine and always passes the origin rule (OBSERVOGRAM_ALLOW_LOCAL_MCP=0
// still closes it, in validateMcpUrl). With a list set, every other origin
// must be in it. With no list set (D2 (c), credential-gated), no credential
// leaves for an unlisted origin but loopback — a credential is anything that
// rides: the endpoint's server-held token, the caller's mcpAuth, a
// credential in the URL, or a loaded transport hook (operator code that may
// attach its own credentials to every request). Without a credential a
// typed URL reaches only the origin of one of this org's registered
// endpoints, and a registered endpoint (registering it was the vetting) and
// a session admin's token-less registration are allowed; without sign-in
// (the anonymous local caller) only a loopback MCP or a listed origin may
// be registered at all (decision D4).
//
// redactTarget(text, target) is the route-level backstop for every text an
// MCP route sends back or logs after a fetch went wrong. The MCP client
// (tools/lib/mcp-client.mjs) already redacts by value every text an MCP
// answer puts into an error; each MCP route — draft-from-mcp, refresh-live,
// deploy, deploy-bulk, rollback — runs its error texts through this again,
// with the target resolveMcpTarget answered, before a 502 body, a deploy
// record's item error or a log line. The secrets are the resolved token (a
// server-held variable's value or the caller's mcpAuth — the client's
// bearer), the URL's userinfo and every credential-named query parameter
// value (stripMcpUrl's rule), each decoded and as written, longest first;
// then redactCredentials masks any `//user:pass@` left in the text.

import { brandEnvFrom } from '../tools/lib/brand-env.mjs';
import { mcpTransportLoaded } from '../tools/mcp-transport.mjs';
import { authDisabled } from './auth.mjs';
import { directLoopbackRequest, noSignInWay, rankOf, rankOfRole, requestPosture } from './authz.mjs';
import { redactCredentials, stripMcpUrl } from './mcp-url.mjs';
import { currentOrg } from './org-context.mjs';
import { envNameOwnedBy, listMcpEndpoints, orgEnvPrefix } from './store/mcp-endpoints.mjs';

export const TYPED_MCP_URL_ROLE = 'admin';            // R4, confirmed 2026-10-06 — the one constant
export const MCP_ORIGINS_VAR = 'OBSERVOGRAM_MCP_ORIGINS';
export const ORG_MCP_ORIGINS_NAME = 'MCP_ORIGINS';    // OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS

// OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS for an org id.
export const orgMcpOriginsVar = (org) => `${orgEnvPrefix(org)}${ORG_MCP_ORIGINS_NAME}`;

// ---------- the caller ----------

// Who the request acts as, and the facts the rules read — pure over the
// request the org middleware stamped: { principal, org, port, posture,
// direct, authOff }.
export function mcpCallerOf(req) {
  return {
    principal: req.observogramPrincipal ?? null,
    org: req.observogramOrg ?? null,
    port: req.socket?.localPort ?? null,
    posture: requestPosture(req),
    direct: directLoopbackRequest(req),
    authOff: authDisabled(),
  };
}

const roleOf = (p) => (p.owner ? 'admin' : p.role);

// May this caller supply a target URL? `role` defaults to the constant.
// → null | { status: 403, denied: 'posture' | 'role', need?, error } — the
// way out each text names works for the reader, in the posture they are in.
export function typedMcpUrlDecision(caller, { role = TYPED_MCP_URL_ROLE } = {}) {
  const p = caller?.principal ?? null;
  const org = caller?.org ?? null;
  const deny = (denied, error, need) => ({ status: 403, denied, ...(need ? { need } : {}), error });
  if (p?.kind === 'local') {
    if (caller.posture === 'open-exposed') {
      return deny('posture', 'a typed MCP URL is refused on a server without sign-in, and MCP endpoints cannot be registered while it is exposed — add the first user with npm run users -- add <login> (it arms sign-in; the first user is an owner), or bind the server to loopback');
    }
    return deny('posture', `a typed MCP URL is refused on a server without sign-in, even from this machine — choose a registered MCP endpoint (mcpEndpointId), or register one in Settings → MCP endpoints from http://127.0.0.1:${caller.port ?? '<port>'} (a loopback MCP, or an origin listed in ${MCP_ORIGINS_VAR})`);
  }
  if (p?.kind === 'session' || p?.kind === 'bearer') {
    if (rankOf(p) >= rankOfRole(role)) return null;
    if (p.kind === 'bearer') {
      const tail = caller.posture === 'token'
        ? `; registering one needs a signed-in admin — ${noSignInWay(caller)}`
        : `; an admin of '${org}' registers a new one in Settings → MCP endpoints`;
      return deny('role', `the bearer token acts as an operator: it fetches from the org's registered MCP endpoints only — send mcpEndpointId (GET /api/mcp-endpoints lists them)${tail}`, role);
    }
    return deny('role', `a typed MCP URL needs the ${role} role in org '${org}' (you are ${roleOf(p)}) — choose one of the org's registered MCP endpoints (mcpEndpointId; GET /api/mcp-endpoints lists them), or ask an admin of ${org} to register this one in Settings → MCP endpoints`, role);
  }
  // The token posture's anonymous viewer never reaches a fetching route
  // (each is operator class); no principal at all fails closed.
  return deny('role', `a typed MCP URL needs a signed-in ${role}; ${noSignInWay(caller ?? {})}`, role);
}

// ---------- origins ----------

// The origin of an http(s) URL as the WHATWG parser normalises it (lower-cased
// host, default port dropped, IDN to punycode, a trailing dot kept), or null.
export function originOf(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// [::ffff:127.x.y.z] normalises to [::ffff:7fxx:yyzz].
const LOOPBACK_MAPPED = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

// This machine, after URL normalisation: localhost, 127.0.0.0/8, [::1],
// [::ffff:7f00:0]/104. Takes an origin or any http(s) URL.
export function isLoopbackOrigin(origin) {
  let host;
  try { host = new URL(String(origin)).hostname; } catch { return false; }
  return host === 'localhost' || LOOPBACK_V4.test(host) || host === '[::1]' || LOOPBACK_MAPPED.test(host);
}

// A list's value → { any, origins: Set<origin>, rejected: [entry] }. Entries
// are comma-separated; a lone `*` is the any-origin switch. An entry is kept
// only when it parses as http(s) with no userinfo, a path of `/` or none, no
// query, no fragment and no `*` in the host; `localhost:8080` (no scheme),
// `https://*.example.com` or one with a path is rejected, never kept.
export function parseOriginList(value) {
  const out = { any: false, origins: new Set(), rejected: [] };
  for (const entry of String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    if (entry === '*') { out.any = true; continue; }
    let url = null;
    try { url = new URL(entry); } catch { /* rejected below */ }
    // An origin and nothing else: the parsed URL is its origin plus `/` (no
    // userinfo, path, query or fragment — even an empty `?` or `#`).
    const ok = url && (url.protocol === 'http:' || url.protocol === 'https:') && url.href === `${url.origin}/`
      && !url.hostname.includes('*');
    if (ok) out.origins.add(url.origin); else out.rejected.push(entry);
  }
  return out;
}

const noted = new Set();
function noteOnce(line) {
  if (noted.has(line)) return;
  noted.add(line);
  process.stderr.write(`[mcp-origins] ${line}\n`);
}

// The allowlist that applies to `org`: { set: false } when neither variable
// is set (or both are empty); else { set: true, any, origins, from } with
// `from` the sources that are set, ['deployment', 'org'] in that order. A
// set list without an accepted entry allows nothing (fail closed). Every
// rejected entry and the `*` switch are said once per process on stderr.
export function mcpOriginList(db, org = currentOrg(), env = process.env) {
  const sources = [];
  const global = brandEnvFrom(env, 'MCP_ORIGINS');   // OBSERVOGRAM_MCP_ORIGINS (TOMOGRAPH_ honoured)
  if (global) sources.push({ from: 'deployment', name: MCP_ORIGINS_VAR, value: global });
  if (org) {
    const name = orgMcpOriginsVar(org);
    const value = String(env[name] ?? '').trim();
    if (value && envNameOwnedBy(db, name).includes(org)) sources.push({ from: 'org', name, value });
  }
  if (!sources.length) return { set: false };
  const list = { set: true, any: false, origins: new Set(), from: [] };
  for (const s of sources) {
    const parsed = parseOriginList(s.value);
    list.from.push(s.from);
    if (parsed.any) { list.any = true; noteOnce(`every MCP origin is allowed (${s.name}=*)`); }
    for (const o of parsed.origins) list.origins.add(o);
    for (const r of parsed.rejected) noteOnce(`${s.name}: ${JSON.stringify(r)} is not an origin (http(s)://host[:port], no path, no credentials) — ignored`);
  }
  return list;
}

// ---------- credentials ----------

// The credential kinds, strongest first: what mcpOriginDecision names.
export const CREDENTIALS = Object.freeze(['server', 'request', 'url', 'hook']);

// Is an operator's transport hook loaded in this process
// (OBSERVOGRAM_TRANSPORT_HOOK)? The server loads it once at start.
export function transportHookLoaded() {
  return !!mcpTransportLoaded()?.hookPath;
}

// The strongest credential that rides with a request: the endpoint's
// server-held token, the caller's mcpAuth, a credential in the URL
// (userinfo or a credential-named query parameter), a loaded transport hook
// — else 'none'.
export function credentialThatRides({ serverToken = false, requestToken = false, url = null, hook = transportHookLoaded() } = {}) {
  if (serverToken) return 'server';
  if (requestToken) return 'request';
  if (url) {
    let u = null;
    try { u = new URL(String(url)); } catch { /* no URL, no credential in it */ }
    if (u && (u.username || u.password || stripMcpUrl(String(url)).dropped.length)) return 'url';
  }
  if (hook) return 'hook';
  return 'none';
}

// ---------- the origin rule ----------

const ORIGINS_WAY = (org) => `${MCP_ORIGINS_VAR} (or ${orgMcpOriginsVar(org)})`;

function credentialText(credential, tokenVar) {
  switch (credential) {
    case 'server': return tokenVar ? `the endpoint's variable ${tokenVar}` : "the endpoint's variable";
    case 'request': return 'the auth key sent with this request';
    case 'url': return 'a credential in the URL';
    default: return "the transport hook's";
  }
}

// The way out beside the operator's list, for what rides.
function credentialWay(credential, use) {
  if (credential === 'hook') return '';
  if (use === 'register') return ', or register it without readTokenEnv';
  if (credential === 'request') return ', or send the request without mcpAuth';
  if (credential === 'url') return ', or send the URL without its credential';
  return '';
}

function listedTail(use) {
  if (use === 'register') return 'or register an endpoint at a listed origin';
  if (use === 'typed') return "or choose one of the org's registered endpoints";
  return 'or choose another registered endpoint';
}

// May the server send this request? use: 'typed' (a URL the caller typed) |
// 'registered' (an endpoint at use) | 'register' (registration);
// credential: 'none' | 'server' | 'request' | 'url' | 'hook' (the strongest
// that rides). → null | { status: 403, denied: 'origin', error } — the
// registration routes answer the error as a 400 (AdminRefusal 'invalid').
// Texts name the origin only, never a path or a query.
export function mcpOriginDecision(db, url, { use, credential = 'none', caller = null, tokenVar = null, env = process.env } = {}) {
  if (!['typed', 'registered', 'register'].includes(use)) throw new TypeError(`mcpOriginDecision: use is typed, registered or register, not ${JSON.stringify(use)}`);
  if (credential !== 'none' && !CREDENTIALS.includes(credential)) throw new TypeError(`mcpOriginDecision: unknown credential ${JSON.stringify(credential)}`);
  const origin = originOf(url);
  const refuse = (error) => ({ status: 403, denied: 'origin', error });
  if (!origin) return refuse('the MCP URL is not an http(s) URL');
  if (isLoopbackOrigin(origin)) return null;
  const org = caller?.org ?? currentOrg();
  const list = mcpOriginList(db, org, env);
  if (list.set) {
    if (list.any || list.origins.has(origin)) return null;
    const names = list.from.map((f) => (f === 'deployment' ? MCP_ORIGINS_VAR : orgMcpOriginsVar(org)));
    return refuse(`${origin} is not in ${names.join(', nor in ')} — the server's operator adds it there (comma-separated origins, e.g. https://mcp.example.com), ${listedTail(use)}`);
  }
  // Without sign-in (the open postures' anonymous local caller) only a
  // loopback MCP or a listed origin may be registered, token or not (D4):
  // registering any other would let an anonymous caller aim the server at
  // any host, which the typed-URL rule refuses it.
  if (use === 'register' && caller?.principal?.kind === 'local') {
    const signIn = caller.authOff
      ? 'restart it without OBSERVOGRAM_AUTH=off once a user exists — npm run users -- add <login>'
      : 'npm run users -- add <login> arms sign-in';
    return refuse(`on a server without sign-in, only a loopback MCP or an origin listed in ${MCP_ORIGINS_VAR} may be registered — list ${origin} there, or sign in as an admin (${signIn})`);
  }
  if (credential !== 'none') {
    return refuse(`${origin} is not a listed MCP origin, and the server sends a credential (${credentialText(credential, tokenVar)}) only to a listed origin or this machine — the server's operator adds ${origin} to ${ORIGINS_WAY(org)}${credentialWay(credential, use)}`);
  }
  if (use === 'typed') {
    const known = listMcpEndpoints(db).some((ep) => originOf(ep.url) === origin);
    if (known) return null;
    return refuse(`${origin} is not an origin this org's MCP endpoints use — an admin registers the endpoint in Settings → MCP endpoints, or the server's operator lists the origin in ${ORIGINS_WAY(org)}`);
  }
  return null;
}

// ---------- what the studio is told ----------

// The allowlist as one reader may see it: its own org's only. `listed` —
// a list applies; `origins` — its origins, sorted (null: any origin, `*`).
function originsView(db, org) {
  const list = mcpOriginList(db, org);
  if (!list.set) return { listed: false, origins: [] };
  return { listed: true, origins: list.any ? null : [...list.origins].sort() };
}

// May this caller register an MCP endpoint (POST /api/mcp-endpoints, admin
// class, direct and closed when exposed without sign-in)? null | the
// reason, naming the way out for this reader.
function registerRefusal(caller) {
  const p = caller?.principal ?? null;
  const org = caller?.org ?? null;
  if (p?.kind === 'local') {
    if (caller.posture === 'open-exposed') return 'MCP endpoints cannot be registered on a server without sign-in while it is exposed — add the first user with npm run users -- add <login> (it arms sign-in; the first user is an owner), or bind the server to loopback';
    if (!caller.direct) return `on a server without sign-in MCP endpoints are registered only from this machine — open the studio at http://127.0.0.1:${caller.port ?? '<port>'}`;
    return null;
  }
  if (p?.kind === 'session') {
    if (rankOf(p) >= rankOfRole('admin')) return null;
    return `registering an MCP endpoint needs the admin role in org '${org}' (you are ${roleOf(p)}) — ask an admin of ${org}`;
  }
  if (p?.kind === 'bearer') {
    return `the bearer token acts as an operator and never registers an MCP endpoint — a signed-in admin of '${org}' registers it in Settings → MCP endpoints${caller.posture === 'token' ? `; ${noSignInWay(caller)}` : ''}`;
  }
  return `anonymous callers are viewers here; registering an MCP endpoint needs a signed-in admin; ${noSignInWay(caller ?? {})}`;
}

// What GET /api/mcp-endpoints tells the studio about this caller:
// { typed: { allowed, why, listed, origins }, register: { allowed, why,
// listed, origins, listedOnly } } — `why` the refusal's sentence (null when
// allowed), `listed`/`origins` the reader's own org's allowlist
// (originsView); `listedOnly` — only a loopback MCP or a listed origin may
// be registered, even without readTokenEnv: a list applies, or the caller
// has no sign-in (D4).
export function mcpTargetView(db, caller) {
  const typedRefusal = typedMcpUrlDecision(caller);
  const register = registerRefusal(caller);
  const origins = originsView(db, caller?.org ?? currentOrg());
  const listedOnly = origins.listed || caller?.principal?.kind === 'local';
  return {
    typed: { allowed: typedRefusal === null, why: typedRefusal?.error ?? null, ...origins },
    register: { allowed: register === null, why: register, ...origins, listedOnly },
  };
}

// ---------- redaction ----------

function secretsOf({ mcpUrl = null, mcpAuth = null } = {}) {
  const set = new Set();
  const add = (v) => { if (typeof v === 'string' && v !== '') set.add(v); };
  add(mcpAuth);
  try {
    const url = new URL(String(mcpUrl));
    for (const part of [url.username, url.password]) {
      add(part);
      try { add(decodeURIComponent(part)); } catch { /* malformed escape: the raw form is in */ }
    }
    for (const name of stripMcpUrl(mcpUrl).dropped) {
      for (const value of url.searchParams.getAll(name)) { add(value); add(encodeURIComponent(value)); }
    }
  } catch { /* no URL: the token alone */ }
  return [...set].sort((a, b) => b.length - a.length);
}

// `text` with the target's secrets replaced by <redacted>; '' for null or
// undefined. A target of null redacts URL userinfo only.
export function redactTarget(text, target) {
  let out = String(text ?? '');
  for (const secret of secretsOf(target ?? {})) out = out.split(secret).join('<redacted>');
  return redactCredentials(out);
}

// A refusal of resolveMcpTarget as a route answers it.
export function mcpRefusalBody(t) {
  return { ok: false, error: t.error, ...(t.denied ? { denied: t.denied } : {}) };
}
