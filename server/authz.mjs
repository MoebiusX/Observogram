// server/authz.mjs — the request's identity and, from STORE_PLAN slice 3,
// its authorization.
//
// Two middlewares every request passes before any route (server/index.mjs
// registers them, in this order, after GET /api/version):
//
//   authGate    who is calling — the bearer, a session, or nobody — and
//               the posture's answer to an anonymous caller (401) or a
//               session mutation without the CSRF header (403).
//   orgContext  the request's org for every /api path (membership checked),
//               run inside runWithOrg(); stamps req.observogramPrincipal.
//
// Then, at every route, its guard: authorize('<METHOD> <path>'), the
// route's first handler, classified in server/route-table.mjs.
//
// The posture is read per request (a CLI arms a running server; a suite
// flips the token mid-run). The bind is per server, not per process: each
// server stamps its own on the requests it receives (server/index.mjs
// start(), req.observogramListen); a request without the stamp is treated
// as exposed (fail closed).

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  authDisabled, authEnabled, localUsersEnabled, resolveSession, resolvePwflow, identityOff, wantsJson,
} from './auth.mjs';
import { brandEnv } from '../tools/lib/brand-env.mjs';
import { runWithOrg } from './tenancy.mjs';
import { currentStore } from './store/db.mjs';
import { listMembershipsForUser } from './store/memberships.mjs';
import { defaultOrgId, liveOrg } from './store/identity.mjs';
import { routeEntry } from './route-table.mjs';

// ---------- write-route auth (VALUE_BACKLOG item 10B) ----------
//
// One token, three postures:
//   1. Local (default): loopback bind, no token, no auth — zero friction.
//   2. Exposed + OBSERVOGRAM_API_TOKEN set: mutating /api/* routes require
//      `Authorization: Bearer <token>`. Reads stay open. Once a token is
//      set it is enforced regardless of bind address — a reverse proxy
//      makes everything look local, so a loopback bypass would undermine
//      the token exactly when it matters.
//   3. Exposed + no token: the server REFUSES TO START (fail closed; see
//      start()). OBSERVOGRAM_INSECURE_NO_AUTH=1 is the explicit, loudly
//      logged override for trusted-network demos.
// MCP write tokens are unrelated and never stored here — they pass
// through per request. The audit log records the token's ownership label
// (OBSERVOGRAM_API_TOKEN_LABEL), never the secret.

export function apiToken() { return brandEnv('API_TOKEN'); }
export function apiTokenLabel() { return brandEnv('API_TOKEN_LABEL') || 'token'; }

export function tokenEquals(candidate, token) {
  // Constant-time compare over digests so length differences leak nothing.
  const a = createHash('sha256').update(String(candidate)).digest();
  const b = createHash('sha256').update(String(token)).digest();
  return timingSafeEqual(a, b);
}

// ---------- postures ----------

// The posture of one request, from the three facts that decide it. Pure.
export function postureOf({ identity, token, loopback }) {
  if (identity) return 'identity';            // authEnabled(): OIDC, or stand-alone armed; never with AUTH=off
  if (token) return 'token';                  // OBSERVOGRAM_API_TOKEN, no identity (AUTH=off + token included)
  return loopback ? 'open-loopback' : 'open-exposed';
}

// The bind of the server that received this request, or — an app mounted
// anywhere else — exposed.
export function listenOf(req) {
  return req?.observogramListen ?? { loopback: false };
}

export function requestPosture(req) {
  return postureOf({ identity: authEnabled(), token: !!apiToken(), loopback: listenOf(req).loopback });
}

// ---------- the auth gate ----------

export function authGate(req, res, next) {
  if (req.path.startsWith('/auth/')) return next();   // the login flow itself
  const token = apiToken();
  const identity = authEnabled();                     // OIDC or stand-alone users
  if (!token && !identity) return next();             // posture 1/3 — local, no friction
  const isApi = req.path.startsWith('/api/');
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  // Bearer token: the service-account / CI path — works in every posture.
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m && token && tokenEquals(m[1].trim(), token)) {
    req.observogramBearer = true;
    return next();
  }

  if (identity) {
    const session = resolveSession(req);
    if (session) {
      // Cookie-authenticated mutations require the custom header —
      // cross-origin pages can't set one without a CORS preflight, so
      // SameSite=Lax + this check closes the CSRF window. The legacy
      // X-Tomograph-CSRF spelling stays accepted for pre-rebrand clients.
      if (mutating && isApi && !hasCsrfHeader(req)) {
        return res.status(403).json({ ok: false, error: 'missing X-Observogram-CSRF header on a session-authenticated mutation', denied: 'csrf' });
      }
      req.observogramUser = session.user;   // the org middleware resolves memberships by the store row
      return next();
    }
    // Identity mode protects ALL /api data (reads included) — "your
    // services" is enforced server-side. The static studio shell stays
    // open so the client can land and redirect to the login page.
    if (isApi) {
      return res.status(401).json({ ok: false, error: 'unauthorized: sign in required', login: '/auth/login', denied: 'auth' });
    }
    return next();
  }

  // Token-only posture (no identity configured): original 10B contract —
  // mutating /api routes require the bearer, reads stay open.
  if (!mutating || !isApi) return next();
  res.set('WWW-Authenticate', 'Bearer realm="observogram"');
  return res.status(401).json({
    ok: false,
    error: 'unauthorized: mutating /api routes require `Authorization: Bearer <OBSERVOGRAM_API_TOKEN>`',
    denied: 'auth',
  });
}

// ---------- tenancy (Stage 2 — workspace-per-org) ----------
//
// Always on (server/tenancy.mjs): every /api request runs inside an
// AsyncLocalStorage org context, and workspaceRoot() everywhere
// underneath answers <workspace>/<that org's root>. The org comes from
// the X-Observogram-Org header (or ?org=; the legacy X-Tomograph-Org
// spelling still works) for the bearer and a session; membership is
// enforced here, and the principal stamped for the route's guard
// (authorize(), below), which enforces the role per route.
// The open and anonymous postures run in the default org and ignore the
// header (nothing else is reachable there). Placed before the body
// parsers: the context survives Express's body parsing.
export function orgContext(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const db = currentStore();
  const requested = String(req.headers['x-observogram-org'] || req.headers['x-tomograph-org'] || req.query.org || '').trim();
  const defaultOrg = defaultOrgId(db);
  let orgId;
  let memberships = null;
  if (req.observogramBearer) {
    // The bearer is the deployment-level service account: it may target
    // any live org explicitly; without a header it lands in the default org.
    orgId = requested || defaultOrg;
    if (!liveOrg(db, orgId)) return res.status(403).json({ ok: false, error: `unknown org '${orgId}'`, denied: 'org' });
  } else if (req.observogramUser) {
    const user = req.observogramUser;
    memberships = listMembershipsForUser(db, user.id);   // live orgs, first first
    if (user.isOwner) {
      // An owner may request any live org; they land in their first
      // membership, else the default org.
      orgId = requested || memberships[0]?.orgId || defaultOrg;
      if (!liveOrg(db, orgId)) return res.status(403).json({ ok: false, error: `unknown org '${orgId}'`, denied: 'org' });
    } else {
      if (!memberships.length) return res.status(403).json({ ok: false, error: 'no org membership — ask an admin to add you', denied: 'org' });
      orgId = requested || memberships[0].orgId;
      if (!memberships.some((m) => m.orgId === orgId)) {
        return res.status(403).json({ ok: false, error: `not a member of org '${orgId}'`, denied: 'org' });
      }
    }
  } else {
    // Open posture, or token-only anonymous (its mutations were already
    // 401'd by the gate): the default org, the header ignored (as before).
    orgId = defaultOrg;
  }
  res.set('X-Observogram-Org', orgId);   // echo so the client always knows the active org
  req.observogramOrg = orgId;
  req.observogramPrincipal = principalOf(req, { orgId, memberships });
  return runWithOrg(orgId, next);
}

// Who the request acts as in its context org (STORE_PLAN §5). The session's
// role is the membership OF THE CONTEXT ORG, never the first one; an owner
// is an admin in every live org. `null` — an anonymous request in the
// identity posture, which the gate's 401 never lets through — fails closed.
function principalOf(req, { orgId, memberships }) {
  const user = req.observogramUser;
  if (req.observogramBearer) return { kind: 'bearer', actor: apiTokenLabel(), role: 'operator', owner: false };
  if (user) {
    return {
      kind: 'session', actor: user.login, user, owner: user.isOwner,
      role: user.isOwner ? 'admin' : memberships.find((m) => m.orgId === orgId).role,
    };
  }
  if (authEnabled()) return null;
  if (apiToken()) return { kind: 'anonymous', actor: null, role: 'viewer', owner: false };
  return { kind: 'local', actor: 'local', role: 'admin', owner: true };
}

// ---------- the request's facts the guard reads ----------

// The CSRF header — X-Observogram-CSRF: 1, or the pre-rebrand
// X-Tomograph-CSRF: 1 — as the gate reads it.
export function hasCsrfHeader(req) {
  return (req.headers['x-observogram-csrf'] || req.headers['x-tomograph-csrf']) === '1';
}

// The browser's own statement of where a form post came from (Fetch
// Metadata). The server's own pages post as same-origin (or none, a
// typed-in navigation); a client that sends no Sec-Fetch-Site (curl, a
// script, an old browser) keeps today's behaviour. No Origin-vs-Host
// fallback: a reverse proxy commonly rewrites Host, and a false refusal
// here would lock every user out of sign-in.
export function crossSiteForm(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return site === 'cross-site' || site === 'same-site';
}

// A Host header's name (brackets removed) and port, or null.
function hostOf(value) {
  const m = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(String(value || '').trim().toLowerCase());
  if (!m) return null;
  return { name: m[1].replace(/^\[|\]$/g, ''), port: m[2] ?? null };
}
const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// The headers a proxy adds: Forwarded, Via, every X-Forwarded-* and
// X-Original-Forwarded-*, X-Real-IP, and the client-IP headers a CDN or a
// tunnel adds instead of X-Forwarded-For (CF-Connecting-IP, True-Client-IP,
// X-Client-IP, X-Cluster-Client-IP, Fastly-Client-IP, X-Azure-ClientIP).
const PROXY_HEADER = /^(?:forwarded|via|x-real-ip|x-forwarded-.*|x-original-forwarded-.*|cf-connecting-ip(?:v6)?|[a-z0-9-]*client-?ip)$/i;

// A request sent straight to a loopback address (the open postures'
// `direct` entries — the identity API and the MCP endpoint changes,
// STORE_PLAN §5 and slice 4): Host names localhost, 127.x.x.x or [::1];
// an Origin, if any, is that same host and port; no proxy header. Pure
// over the headers. A DNS-rebinding page sends its own name in Host, a
// browser behind a proxy the public origin in Origin, and most proxies add
// X-Forwarded-For.
export function directLoopbackRequest(req) {
  const h = req.headers || {};
  if (Object.keys(h).some((name) => PROXY_HEADER.test(name) && h[name] !== undefined)) return false;
  const host = hostOf(h.host);
  if (!host) return false;
  // Stricter than boot.mjs isLoopbackHost (a bind): a Host is attacker-
  // chosen, and '127.evil.example' starts with '127.' too.
  if (!(host.name === 'localhost' || host.name === '::1' || LOOPBACK_V4.test(host.name))) return false;
  if (h.origin !== undefined) {
    let origin;
    try { origin = new URL(String(h.origin)); } catch { return false; }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    let expected;
    try { expected = new URL(`${origin.protocol}//${String(h.host).trim()}`).host; } catch { return false; }
    if (origin.host !== expected) return false;
  }
  return true;
}

// ---------- roles ----------

const RANK = Object.freeze({ viewer: 0, operator: 1, admin: 2 });

// The rank of the role a principal acts as in its context org: an owner
// (and the open postures' local) is an admin, the bearer an operator,
// token-only anonymous a viewer. -1 for no principal.
export function rankOf(principal) {
  if (!principal) return -1;
  if (principal.owner) return RANK.admin;
  return RANK[principal.role] ?? -1;
}

// The rank of a role name (viewer 0, operator 1, admin 2; -1 otherwise).
export function rankOfRole(role) { return RANK[role] ?? -1; }

// The role the guard applies to a principal in an org where its
// membership role is `membershipRole` (the org lists' effectiveRole).
export function effectiveRoleOf(principal, membershipRole = null) {
  if (!principal) return null;
  if (principal.owner) return 'admin';
  if (principal.kind === 'session') return membershipRole;
  return principal.role;
}

// ---------- the decision ----------

// The token posture's way in. Under OBSERVOGRAM_AUTH=off adding a user arms
// nothing (authDisabled() beats an armed store, auth.mjs), and neither does
// configuring OIDC (authDisabled() beats oidcEnabled()), so the way in there
// is a restart without it — with a user, or with OIDC configured.
const NO_SIGN_IN_WAY = 'this server has no sign-in: add the first user with npm run users -- add <login>, or configure OIDC';
const NO_SIGN_IN_WAY_AUTH_OFF = 'this server has no sign-in (OBSERVOGRAM_AUTH=off): restart it without OBSERVOGRAM_AUTH=off, once a user exists (npm run users -- add <login>) or with OIDC configured';
export const noSignInWay = (ctx) => (ctx.authOff ? NO_SIGN_IN_WAY_AUTH_OFF : NO_SIGN_IN_WAY);
// The csrf: 'always' refusal, by what the entry is closed as: 'identity
// changes' for the identity API (and the self route that changes a
// session), 'changes to the MCP endpoint API' for those rows, 'requests to
// the live MCP API' for the live MCP API (a ping changes nothing) and
// 'requests to the MCP server-settings API' (a describe changes nothing; a
// submit changes the MCP server, not the studio).
export function csrfAlwaysText(entry) {
  const what = entry.closedAs === 'the identity API' ? 'identity changes'
    : entry.closedAs === 'the live MCP API' || entry.closedAs === 'the MCP server-settings API' ? `requests to ${entry.closedAs}` : `changes to ${entry.closedAs}`;
  return `missing X-Observogram-CSRF: 1 — ${what} need it in every posture, so a cross-site form cannot make them (the studio sends it; with curl add -H 'X-Observogram-CSRF: 1')`;
}

const deny = (status, denied, error, extra = {}) => ({ status, body: { ok: false, error, denied, ...extra } });

// Is this principal allowed this entry, in this posture? Pure: null when
// allowed, else { status, body } — the refusal, with `denied`.
//   ctx: { posture, principal, csrf (the header), direct (a direct loopback
//          request), org, authOff (OBSERVOGRAM_AUTH=off), host (the bind),
//          port (the listening port) }
export function authzDecision(entry, ctx) {
  const p = ctx.principal;
  const open = ctx.posture === 'open-loopback' || ctx.posture === 'open-exposed';
  // 1. The open, exposed posture closes what the entry says it refuses.
  if (ctx.posture === 'open-exposed' && entry.exposed === 'refuse') {
    const why = ctx.authOff
      ? `${entry.closedAs} is closed on a server bound to ${ctx.host} without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1, OBSERVOGRAM_AUTH=off): restart it without OBSERVOGRAM_AUTH=off and sign in as an owner, or bind it to loopback`
      : `${entry.closedAs} is closed on a server bound to ${ctx.host} without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1): add the first user with npm run users -- add <login> (it arms sign-in without a restart; the first local user is an owner), or configure OIDC`;
    return deny(403, 'posture', why);
  }
  // 2. Without sign-in, a `direct` entry (the identity API, the MCP endpoint
  //    changes, the audit reader, the live MCP API) answers a person at this
  //    machine only.
  //    The CLI way out is the identity API's, the audit's reader
  //    (`packc store audit`, tools/store-admin.mjs), or for the live MCP API
  //    the fetcher itself, which needs no server: no CLI manages endpoints.
  if (open && entry.direct && !ctx.direct) {
    const cli = entry.identityApi ? ', or use the CLIs from this machine (npm run users -- add <login>, passwd <login>, owner <login>)'
      : entry.closedAs === 'the audit API' ? ', or list it from this machine with packc store audit'
        : entry.closedAs === 'the live MCP API' ? ', or fetch without the server from this machine with node tools/fetch-live-pack.mjs (MCP_URL, OUTPUT)' : '';
    return deny(403, 'posture', `on a server without sign-in ${entry.closedAs} answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:${ctx.port ?? '<port>'}${cli}`);
  }
  // 3. An always-CSRF change carries the header from every principal but the bearer.
  if (entry.csrf === 'always' && p.kind !== 'bearer' && !ctx.csrf) return deny(403, 'csrf', csrfAlwaysText(entry));
  // 4–5. The class.
  const allowed = entry.class === 'owner' ? p.owner === true : rankOf(p) >= rankOfRole(entry.class);
  if (allowed) return null;
  const need = entry.class === 'owner' ? 'an owner' : `the ${entry.class} role`;
  const role = p.owner ? 'admin' : p.role;
  const extra = { need: entry.class, role, owner: p.owner === true, org: ctx.org ?? null };
  if (p.kind === 'bearer') {
    return deny(403, 'role', `the bearer token acts as an operator in org '${ctx.org}'; ${need} needs a signed-in user with that role${ctx.posture === 'token' ? `; ${noSignInWay(ctx)}` : ''}`, extra);
  }
  if (p.kind === 'anonymous') {
    return deny(403, 'role', `anonymous callers are viewers here; ${need} needs a signed-in user; ${noSignInWay(ctx)}`, extra);
  }
  if (entry.class === 'owner') {
    return deny(403, 'role', `requires an owner of this deployment (you are ${role} in org '${ctx.org}') — ask an owner`, extra);
  }
  return deny(403, 'role', `requires the ${entry.class} role in org '${ctx.org}' (you are ${role}) — ask an admin of ${ctx.org}`, extra);
}

// The form refusal (§7): JSON when the client asked for it, else text.
function refuseCrossSiteForm(entry, req, res) {
  const page = entry.path === '/auth/change-password/skip' ? '/auth/change-password' : entry.path;
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const error = `this form accepts posts from this server's own pages only (Sec-Fetch-Site: ${site}) — open ${page} on this server and submit it there`;
  if (wantsJson(req)) return res.status(403).json({ ok: false, error, denied: 'csrf' });
  return res.status(403).type('text/plain').send(error);
}

// ---------- the guard ----------
//
// authorize(key) is every route's first handler (per method), so the entry
// is the one Express itself matched. The key is looked up at registration:
// an unclassified route throws, and the server module fails to load. The
// returned function carries its key (`routeKey`), which is how the
// completeness test proves each route's first handler is its own guard.
//
// At request time, in order: a form route refuses a cross-site post; a
// public route passes; a self route resolves its caller (selfGate); every
// other route needs the principal the org middleware stamped and passes
// authzDecision(). Refused requests write nothing.
const missingPrincipalLogged = new Set();
export function authorize(key) {
  const entry = routeEntry(key);
  const guard = function authorize(req, res, next) {
    if (entry.csrf === 'form' && crossSiteForm(req)) return refuseCrossSiteForm(entry, req, res);
    if (entry.class === 'public') return next();
    if (entry.class === 'self') return selfGate(entry, req, res, next);
    const principal = req.observogramPrincipal;
    if (!principal) {
      if (!missingPrincipalLogged.has(key)) {
        missingPrincipalLogged.add(key);
        process.stderr.write(`[authz] no principal was resolved for ${key} — refused (500)\n`);
      }
      return res.status(500).json({
        ok: false,
        error: `no principal was resolved for ${key} — a bug: every /api route runs after the gate and the org middleware; please report it`,
      });
    }
    const listen = listenOf(req);
    const d = authzDecision(entry, {
      posture: requestPosture(req), principal, csrf: hasCsrfHeader(req), direct: directLoopbackRequest(req),
      org: req.observogramOrg ?? null, authOff: authDisabled(), host: listen.host ?? 'a non-loopback address',
      port: req.socket?.localPort ?? null,
    });
    if (d) return res.status(d.status).json(d.body);
    return next();
  };
  guard.routeKey = key;
  return guard;
}

// ---------- the self class: the caller's own row ----------
//
// The caller of a self route is resolved once, here, and the handler reads
// req.observogramSelf — { via: 'pwflow', user } or { via: 'session', user,
// session }. The pwflow cookie wins (the forced change of the first
// admin/admin boot works through it alone); resolveSession() runs at most
// once (it may write a first-sight row), and only when there is no flow.
export function selfGate(entry, req, res, next) {
  const localOnly = entry.modes.length === 1 && entry.modes[0] === 'local';
  if (localOnly ? !localUsersEnabled() : !authEnabled()) return identityOff(res);
  const db = currentStore();
  const flow = entry.self.pwflow ? resolvePwflow(req, db) : null;
  const session = !flow && entry.self.session ? resolveSession(req, { db }) : null;
  if (!flow && !session) {
    switch (entry.self.unauth) {
      case 'redirect':
        return res.redirect('/auth/login');
      case 'flow-expired':
        return wantsJson(req)
          ? res.status(401).json({ ok: false, error: 'password-change flow expired — sign in again', login: '/auth/login' })
          : res.redirect('/auth/login');
      default:
        return res.status(401).json({ ok: false, error: 'unauthorized: sign in required', login: '/auth/login', denied: 'auth' });
    }
  }
  // An identity change from the caller's own session carries the header too.
  if (entry.csrf === 'always' && !hasCsrfHeader(req)) return res.status(403).json({ ok: false, error: csrfAlwaysText(entry), denied: 'csrf' });
  req.observogramSelf = flow ? { via: 'pwflow', user: flow.user } : { via: 'session', user: session.user, session };
  return next();
}
