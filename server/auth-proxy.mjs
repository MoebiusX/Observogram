// server/auth-proxy.mjs — identity from a reverse proxy (docs/DOWNSTREAM.md,
// the auth seam; README "Behind a reverse proxy").
//
// An enterprise deployment terminates SSO at a proxy that sits in front of
// this port and sends who the caller is in headers. With
// OBSERVOGRAM_TRUST_PROXY_AUTH=1 the server trusts those headers as the
// session: no cookie, no login page — every request carries its identity,
// and the row `proxy://<realm>#<user>` is found or created (kind 'oidc',
// so every store operation and CLI that knows an OIDC row knows these).
//
// Trusting a header is safe only when clients cannot reach this port, so
// the mode refuses to start until the operator acknowledges that in words
// (OBSERVOGRAM_TRUST_PROXY_AUTH_ACK=only-the-proxy-reaches-this-port), and a
// bind beyond loopback also needs the shared secret the proxy sends in its
// own header (server/boot.mjs check F). On loopback without the secret
// every process that reaches the port is trusted as the proxy — one warn
// line says so at boot.
//
// Inert by default: proxyAuthEnabled() is false unless the flag is '1', and
// then nothing here runs and no header is read. OBSERVOGRAM_AUTH=off wins
// over the flag (one warn line, boot step 0). OIDC and the proxy are one
// sign-in mode each: both configured refuses the start.
//
// Env (every knob honours the legacy TOMOGRAPH_* spelling; the modern name
// is the one every message spells):
//   OBSERVOGRAM_TRUST_PROXY_AUTH          '1' enables the mode
//   OBSERVOGRAM_TRUST_PROXY_AUTH_ACK      must equal PROXY_ACK (a sentence, not '1')
//   OBSERVOGRAM_PROXY_AUTH_REALM          [a-z0-9._-]{1,64}, default 'proxy' → key proxy://<realm>
//   OBSERVOGRAM_PROXY_AUTH_USER_HEADER    default X-Forwarded-User (required on every request)
//   OBSERVOGRAM_PROXY_AUTH_EMAIL_HEADER   default X-Forwarded-Email
//   OBSERVOGRAM_PROXY_AUTH_NAME_HEADER    default unset
//   OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER  default unset; a comma list
//   OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES    'sre=admin,dev=operator,*=viewer' (viewer|operator|admin|owner; the top rank wins)
//   OBSERVOGRAM_PROXY_AUTH_ORG            the org the groups rule; default the store's default org
//   OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE      viewer|operator|admin|none (default none): the first-sight
//                                         membership when no groups header is configured; refused
//                                         beside one (a request that omits the header must grant nothing)
//   OBSERVOGRAM_PROXY_AUTH_OWNERS         comma list of user values granted owner (grant-only)
//   OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET  ≥ 32 chars; required beyond loopback
//   OBSERVOGRAM_PROXY_AUTH_SECRET_HEADER  default X-Proxy-Auth-Secret
//   OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL     http(s) URL the studio navigates to after sign-out
//
// The secret is compared in constant time and never appears in a message,
// a log line or an audit row — only its header's NAME does.

import { brandEnv, brandEnvFrom } from '../tools/lib/brand-env.mjs';
// auth.mjs imports this module too: a cycle ESM resolves because neither
// module calls the other at load, only from functions (as auth.mjs and
// identity-admin.mjs already do).
import { AUTH_PAGE_STYLE, authDisabled, identityOff, wantsJson, authPageChrome } from './auth.mjs';
import { escapeHtml as escapeBrand } from '../tools/lib/brand.mjs';
import { tokenEquals } from './authz.mjs';
import { validOrgId } from './org-context.mjs';
import { currentStore } from './store/db.mjs';
import { defaultOrgId, isControlChar, proxyIssuerKey, proxySignIn } from './store/identity.mjs';
import { ROLES } from './store/memberships.mjs';

export const PROXY_ACK = 'only-the-proxy-reaches-this-port';

// Every variable this mode reads, as brandEnv suffixes — the children's
// STRIP list (server/fixtures/serve-child.mjs) and the in-process suites
// blank them all.
export const PROXY_AUTH_ENV = Object.freeze([
  'TRUST_PROXY_AUTH', 'TRUST_PROXY_AUTH_ACK', 'PROXY_AUTH_REALM', 'PROXY_AUTH_USER_HEADER', 'PROXY_AUTH_EMAIL_HEADER',
  'PROXY_AUTH_NAME_HEADER', 'PROXY_AUTH_GROUPS_HEADER', 'PROXY_AUTH_GROUP_ROLES', 'PROXY_AUTH_ORG', 'PROXY_AUTH_JOIN_ROLE',
  'PROXY_AUTH_OWNERS', 'PROXY_AUTH_SHARED_SECRET', 'PROXY_AUTH_SECRET_HEADER', 'PROXY_AUTH_LOGOUT_URL',
]);

const HEADER_MAX = 2000;
const SECRET_MIN = 32;
// RFC 7230 token characters: what a header name may be made of.
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Never an identity header: the credential, hop-by-hop and framing headers,
// and the CSRF header the gate reads.
const FORBIDDEN_HEADERS = Object.freeze([
  'authorization', 'cookie', 'host', 'content-length', 'transfer-encoding', 'x-observogram-csrf', 'x-tomograph-csrf',
]);
const GROUP_ROLES = Object.freeze([...ROLES, 'owner']);
const RANK = Object.freeze({ viewer: 0, operator: 1, admin: 2, owner: 3 });

// The mode is on: the flag, and OBSERVOGRAM_AUTH=off not winning over it.
export function proxyAuthEnabled() { return !authDisabled() && brandEnv('TRUST_PROXY_AUTH') === '1'; }

// ---------- the env contract (pure) ----------

const headerList = (cfg) => [cfg.userHeader, cfg.emailHeader, cfg.groupsHeader].filter(Boolean).join(', ');

// (a) the acknowledgement, verbatim in README and CHANGELOG.
export const ACK_REFUSAL = (cfg) => 'OBSERVOGRAM_TRUST_PROXY_AUTH=1 trusts identity headers from a reverse proxy, which is safe only when clients '
  + `cannot reach this port — set OBSERVOGRAM_TRUST_PROXY_AUTH_ACK=${PROXY_ACK} once the proxy strips ${headerList(cfg)} `
  + 'from every client request, or unset OBSERVOGRAM_TRUST_PROXY_AUTH';
// (b) one sign-in mode per server.
export const OIDC_REFUSAL = 'OBSERVOGRAM_TRUST_PROXY_AUTH=1 and OBSERVOGRAM_OIDC_ISSUER are both set: one sign-in mode per server — unset one';
// (c) the exposed bind (server/boot.mjs check F).
export const EXPOSED_REFUSAL = ({ host, userHeader, secretHeader }) => `refusing to bind to ${host} with OBSERVOGRAM_TRUST_PROXY_AUTH=1 and no `
  + `OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: beyond loopback any client could set ${userHeader}. Set the shared secret (the proxy sends it `
  + `in ${secretHeader}), or bind to loopback (HOST=127.0.0.1) next to the proxy`;

function headerName(env, suffix, fallback) {
  const raw = brandEnvFrom(env, suffix);
  if (!raw) return fallback;
  if (!HEADER_TOKEN.test(raw)) throw new TypeError(`OBSERVOGRAM_${suffix} is not a header name (RFC 7230 token characters only)`);
  if (FORBIDDEN_HEADERS.includes(raw.toLowerCase())) throw new TypeError(`OBSERVOGRAM_${suffix} must not name ${raw}: it is never an identity header`);
  return raw;
}

// 'sre=admin,dev=operator,*=viewer' → Map group → role ('*' is every user
// the groups header names, whatever its groups).
function parseGroupRoles(raw) {
  const map = new Map();
  for (const part of String(raw || '').split(',')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    const group = eq === -1 ? '' : item.slice(0, eq).trim();
    const role = eq === -1 ? '' : item.slice(eq + 1).trim();
    if (!group || !GROUP_ROLES.includes(role)) {
      throw new TypeError(`OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES is a comma list of <group>=<role> (viewer, operator, admin or owner), not ${JSON.stringify(item)}`);
    }
    if (map.has(group)) throw new TypeError(`OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES names the group ${JSON.stringify(group)} twice`);
    map.set(group, role);
  }
  return map;
}

function parseProxyJoinRole(raw) {
  const v = String(raw || '').trim();
  if (v === '' || v === 'none') return null;
  if (ROLES.includes(v)) return v;
  throw new TypeError(`OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE is one of viewer, operator, admin or none, not ${JSON.stringify(v)}`);
}

function parseLogoutUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch { throw new TypeError('OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL is not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError(`OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL is an http(s) URL, not ${u.protocol}`);
  return u.href;
}

// The contract, read from a plain env object: null when the flag is not
// '1'; else the frozen configuration, or a TypeError that names the
// variable and never echoes the secret. Order: the header names, the
// acknowledgement (a), OIDC (b), then every other knob.
export function parseProxyAuthEnv(env = process.env) {
  if (brandEnvFrom(env, 'TRUST_PROXY_AUTH') !== '1') return null;
  const userHeader = headerName(env, 'PROXY_AUTH_USER_HEADER', 'X-Forwarded-User');
  const emailHeader = headerName(env, 'PROXY_AUTH_EMAIL_HEADER', 'X-Forwarded-Email');
  const nameHeader = headerName(env, 'PROXY_AUTH_NAME_HEADER', null);
  const groupsHeader = headerName(env, 'PROXY_AUTH_GROUPS_HEADER', null);
  const secretHeader = headerName(env, 'PROXY_AUTH_SECRET_HEADER', 'X-Proxy-Auth-Secret');
  const names = [['PROXY_AUTH_USER_HEADER', userHeader], ['PROXY_AUTH_EMAIL_HEADER', emailHeader], ['PROXY_AUTH_NAME_HEADER', nameHeader],
    ['PROXY_AUTH_GROUPS_HEADER', groupsHeader], ['PROXY_AUTH_SECRET_HEADER', secretHeader]].filter(([, h]) => h);
  for (let i = 1; i < names.length; i++) {
    const twin = names.slice(0, i).find(([, h]) => h.toLowerCase() === names[i][1].toLowerCase());
    if (twin) throw new TypeError(`OBSERVOGRAM_${names[i][0]} names the same header as OBSERVOGRAM_${twin[0]} (${names[i][1]})`);
  }
  const partial = { userHeader, emailHeader, groupsHeader };
  if (brandEnvFrom(env, 'TRUST_PROXY_AUTH_ACK') !== PROXY_ACK) throw new TypeError(ACK_REFUSAL(partial));
  if (brandEnvFrom(env, 'OIDC_ISSUER')) throw new TypeError(OIDC_REFUSAL);
  const realm = brandEnvFrom(env, 'PROXY_AUTH_REALM') || 'proxy';
  const issuerKey = proxyIssuerKey(realm);
  const groupRoles = parseGroupRoles(brandEnvFrom(env, 'PROXY_AUTH_GROUP_ROLES'));
  if (groupRoles.size && !groupsHeader) {
    throw new TypeError('OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES needs OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER: without a groups header no group reaches the server');
  }
  const org = brandEnvFrom(env, 'PROXY_AUTH_ORG') || null;
  if (org !== null && !validOrgId(org)) throw new TypeError('OBSERVOGRAM_PROXY_AUTH_ORG is not an org id');
  const joinRole = parseProxyJoinRole(brandEnvFrom(env, 'PROXY_AUTH_JOIN_ROLE'));
  // With a groups header the groups rule every membership: a join role beside
  // it would apply whenever the proxy omits the header, which the operator's
  // documentation says cannot happen — refuse, as GROUP_ROLES without the
  // header is refused ('none' spelled out is fine).
  if (joinRole !== null && groupsHeader) {
    throw new TypeError('OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE and OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER are both set: with a groups header the groups rule every membership, and a request that omits the header must grant none — set the join role to none, or unset the groups header');
  }
  const owners = Object.freeze(brandEnvFrom(env, 'PROXY_AUTH_OWNERS').split(',').map((s) => s.trim()).filter(Boolean));
  const secret = brandEnvFrom(env, 'PROXY_AUTH_SHARED_SECRET') || null;
  if (secret !== null && secret.length < SECRET_MIN) throw new TypeError(`OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET is at least ${SECRET_MIN} characters`);
  const logoutUrl = parseLogoutUrl(brandEnvFrom(env, 'PROXY_AUTH_LOGOUT_URL'));
  return Object.freeze({
    realm, issuerKey, userHeader, emailHeader, nameHeader, groupsHeader, secretHeader,
    groupRoles: Object.freeze(Object.fromEntries(groupRoles)), org, joinRole, owners, secret, logoutUrl,
  });
}

// The process's configuration, memoised against the raw variables (a
// suite flips them; a server never does). null when the mode is off.
const MEMO_VARS = [...PROXY_AUTH_ENV, 'OIDC_ISSUER'];
let memo = { key: null, cfg: null };
export function proxyAuthConfig() {
  if (!proxyAuthEnabled()) return null;
  const key = MEMO_VARS.map((v) => brandEnv(v)).join('\u0000');
  if (memo.key !== key) memo = { key, cfg: parseProxyAuthEnv(process.env) };
  return memo.cfg;
}

// Validates the contract: the configuration, or null when the mode is off
// (OBSERVOGRAM_AUTH=off included). Throws the TypeError that names the
// variable. initAuth() calls it after authDisabled() and before
// oidcEnabled(); bootContext() in the same order.
export function assertProxyAuthEnv() { return proxyAuthConfig(); }

// For the boot log (an entrypoint prints it, once; never the secret).
export function describeProxyAuth(cfg) {
  const headers = [cfg.userHeader, cfg.emailHeader, cfg.nameHeader, cfg.groupsHeader].filter(Boolean).join(', ');
  return `realm ${cfg.realm} (key ${cfg.issuerKey}); headers ${headers}; shared secret ${cfg.secret ? `required in ${cfg.secretHeader}` : 'none'}`
    + `${cfg.groupsHeader ? `; groups rule ${cfg.org ?? 'the default org'}` : `; join role ${cfg.joinRole ?? 'none'}`}`;
}

// ---------- the request's identity ----------

const INVALID = Symbol('invalid');

// A header's value as an identity value: undefined when absent; INVALID
// when not a single string, over HEADER_MAX, or holding a control
// character (a forged line in `npm run users -- list`); else trimmed.
function identityValue(req, name) {
  const v = req.headers[name.toLowerCase()];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > HEADER_MAX) return INVALID;
  if (Array.from(v).some(isControlChar)) return INVALID;
  return v.trim();
}

// Node joins duplicate custom headers with ', ' into one string, so
// `X-Forwarded-User: alice` + `X-Forwarded-User: root` would read as
// 'alice, root'. The raw header lines tell: any configured name seen twice
// refuses the request.
export function duplicatedHeader(req, names) {
  const want = new Set(names.filter(Boolean).map((n) => n.toLowerCase()));
  const seen = new Set();
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  for (let i = 0; i < raw.length; i += 2) {
    const n = String(raw[i]).toLowerCase();
    if (!want.has(n)) continue;
    if (seen.has(n)) return n;
    seen.add(n);
  }
  return null;
}

// The groups' statement: the top rank among the groups' roles and '*'
// → { membershipRole: viewer|operator|admin|null, owner }. 'owner' is the
// owner flag plus an admin membership.
export function rolesOf(groups, groupRoles) {
  let top = null;
  const consider = (role) => { if (role && (top === null || RANK[role] > RANK[top])) top = role; };
  consider(groupRoles['*']);
  for (const g of groups) consider(groupRoles[g]);
  if (top === null) return { membershipRole: null, owner: false };
  if (top === 'owner') return { membershipRole: 'admin', owner: true };
  return { membershipRole: top, owner: false };
}

function emailOf(value) {
  if (value === undefined || value === '') return null;
  if (value.length > 320 || value.split('@').length !== 2) return null;
  return value;
}

function resolveUncached(req, db, cfg) {
  if (duplicatedHeader(req, [cfg.userHeader, cfg.emailHeader, cfg.nameHeader, cfg.groupsHeader, cfg.secretHeader])) return null;
  if (cfg.secret !== null) {
    const given = req.headers[cfg.secretHeader.toLowerCase()];
    if (typeof given !== 'string' || !tokenEquals(given, cfg.secret)) return null;
  }
  const user = identityValue(req, cfg.userHeader);
  if (user === undefined || user === INVALID || user === '') return null;
  const email = identityValue(req, cfg.emailHeader);
  if (email === INVALID) return null;
  const name = cfg.nameHeader ? identityValue(req, cfg.nameHeader) : undefined;
  if (name === INVALID) return null;
  let membershipRole;
  let owner = cfg.owners.includes(user);
  if (cfg.groupsHeader) {
    const groups = identityValue(req, cfg.groupsHeader);
    if (groups === INVALID) return null;
    if (groups !== undefined) {
      // Present — an empty value is a statement too: no groups, no membership.
      const r = rolesOf(groups.split(',').map((g) => g.trim()).filter(Boolean), cfg.groupRoles);
      membershipRole = r.membershipRole;
      owner = owner || r.owner;
    }
  }
  const r = proxySignIn(db, {
    issuerKey: cfg.issuerKey, issuerDisplay: cfg.issuerKey, user, email: emailOf(email), name: name ? name.slice(0, 200) : null,
    orgId: cfg.org ?? defaultOrgOf(db), joinRole: cfg.joinRole, membershipRole, owner,
  });
  if (r.refused) return null;
  return {
    user: r.user, login: r.user.login, sub: r.user.sub, email: r.user.email ?? null, name: r.user.name ?? null,
    exp: null, preUpgrade: false, via: 'proxy',
  };
}

// The store's default org (a store without one — never after a boot —
// leaves the membership sync alone).
function defaultOrgOf(db) {
  try { return defaultOrgId(db); } catch { return null; }
}

// The session a request's headers name, or null (a refused header is the
// same as none): the secret, then the user header, email, name and groups,
// then proxySignIn in one transaction. Resolved ONCE per request (the gate
// and the handler share it — req.observogramProxySession), so a request
// opens one transaction, not two.
export function resolveProxySession(req, { db = currentStore() } = {}) {
  const cfg = proxyAuthConfig();
  if (!cfg) return null;
  if (req.observogramProxySession !== undefined) return req.observogramProxySession;
  const session = resolveUncached(req, db, cfg);
  req.observogramProxySession = session;
  return session;
}

// ---------- the routes ----------

// The brand as server/auth.mjs's pages read it (tools/lib/brand.mjs).
export const explainerPageHtml = (error, c = authPageChrome()) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeBrand(c.name)} — no sign-in page</title>
${AUTH_PAGE_STYLE}</head><body>
<form onsubmit="return false">
  <h1>${c.wordmarkHtml('i')}</h1><p>${escapeBrand(c.tagline)} · identity from the reverse proxy</p>
  <div class="err">${error}</div>
  <a class="skip" href="/">Back to the studio</a>
</form></body></html>`;

// GET /auth/login in proxy mode: there is no page to sign in on. A request
// whose headers resolve is sent to the studio; one without the user header
// (or with one that was refused) gets a 401 that says so — JSON for a
// client that asked for it.
export function initProxyAuth(app, authorize) {
  app.get('/auth/login', authorize('GET /auth/login'), (req, res) => {
    if (!proxyAuthEnabled()) return identityOff(res);
    const cfg = proxyAuthConfig();
    if (resolveProxySession(req, { db: currentStore() })) return res.redirect('/');
    const carried = req.headers[cfg.userHeader.toLowerCase()] !== undefined;
    const error = carried
      ? `no sign-in page: this server takes identity from its reverse proxy, and this request's ${cfg.userHeader} was refused `
        + `(a disabled or local user, a duplicated header${cfg.secret ? `, or a missing or wrong ${cfg.secretHeader}` : ''})`
      : `no sign-in page: this server takes identity from its reverse proxy, and this request carried no ${cfg.userHeader}`;
    if (wantsJson(req)) return res.status(401).json({ ok: false, error, denied: 'auth' });
    res.status(401).type('html').send(explainerPageHtml(error));
  });
}
