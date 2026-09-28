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
// The posture is read per request (a CLI arms a running server; a suite
// flips the token mid-run). The bind is per server, not per process: each
// server stamps its own on the requests it receives (server/index.mjs
// start(), req.observogramListen); a request without the stamp is treated
// as exposed (fail closed).

import { createHash, timingSafeEqual } from 'node:crypto';
import { authEnabled, resolveSession } from './auth.mjs';
import { brandEnv } from '../tools/lib/brand-env.mjs';
import { runWithOrg } from './tenancy.mjs';
import { currentStore } from './store/db.mjs';
import { listMembershipsForUser } from './store/memberships.mjs';
import { defaultOrgId, liveOrg } from './store/identity.mjs';

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
    req.observogramActor = apiTokenLabel();
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
      const csrf = req.headers['x-observogram-csrf'] || req.headers['x-tomograph-csrf'];
      if (mutating && isApi && csrf !== '1') {
        return res.status(403).json({ ok: false, error: 'missing X-Observogram-CSRF header on a session-authenticated mutation' });
      }
      req.observogramActor = session.email || session.sub;
      req.observogramUser = session.user;   // the org middleware resolves memberships by the store row
      return next();
    }
    // Identity mode protects ALL /api data (reads included) — "your
    // services" is enforced server-side. The static studio shell stays
    // open so the client can land and redirect to the login page.
    if (isApi) {
      return res.status(401).json({ ok: false, error: 'unauthorized: sign in required', login: '/auth/login' });
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
  });
}

// ---------- tenancy (Stage 2 — workspace-per-org) ----------
//
// Always on (server/tenancy.mjs): every /api request runs inside an
// AsyncLocalStorage org context, and workspaceRoot() everywhere
// underneath answers <workspace>/<that org's root>. The org comes from
// the X-Observogram-Org header (or ?org=; the legacy X-Tomograph-Org
// spelling still works) for the bearer and a session; membership is
// enforced here — Stage 3 adds per-route roles on top of this same seam.
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
    if (!liveOrg(db, orgId)) return res.status(403).json({ ok: false, error: `unknown org '${orgId}'` });
  } else if (req.observogramUser) {
    const user = req.observogramUser;
    memberships = listMembershipsForUser(db, user.id);   // live orgs, first first
    if (user.isOwner) {
      // An owner may request any live org; they land in their first
      // membership, else the default org.
      orgId = requested || memberships[0]?.orgId || defaultOrg;
      if (!liveOrg(db, orgId)) return res.status(403).json({ ok: false, error: `unknown org '${orgId}'` });
    } else {
      if (!memberships.length) return res.status(403).json({ ok: false, error: 'no org membership — ask an admin to add you' });
      orgId = requested || memberships[0].orgId;
      if (!memberships.some((m) => m.orgId === orgId)) {
        return res.status(403).json({ ok: false, error: `not a member of org '${orgId}'` });
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
