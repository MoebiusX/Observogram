// server/store/identity.mjs — who a user is, and the identity operations
// that write more than one table (docs/STORE_PLAN.md §4, §5).
//
// Two halves:
//   - pure rules, with no database: the OIDC issuer key and logins, the
//     ID-token claim sanitiser, the legacy roles map and the parsing of
//     OBSERVOGRAM_OIDC_JOIN_ROLE / OBSERVOGRAM_BOOTSTRAP_ADMIN. The server,
//     the import, the CLIs and the tests share them, so each rule lives
//     once;
//   - the atomic operations that must write exactly one specific audit
//     row for a change spanning users, memberships and meta (a just-in-time
//     OIDC user, an owner grant, the default org, the callback's sign-in,
//     the reverse proxy's per-request sign-in and its membership sync).
//     They compose the repositories' audit-free row helpers inside one
//     atomic() and write their own row.
//
// Every regex here is used through .test() / .match(): the store's source
// guard refuses a raw handle call's spelling in this directory.

import { atomic, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getMeta, setMeta } from './meta.mjs';
import { createOrg, getOrg } from './orgs.mjs';
import { deleteMembershipRow, getMembership, insertMembershipRow, ROLES, setRoleRow } from './memberships.mjs';
import { getUser, getUserByLogin, insertUserRow, setOwnerRow, updateUserProfile } from './users.mjs';
import { textOk } from './rows.mjs';
import { validOrgId } from '../org-context.mjs';

export const SYSTEM = 'system';
export const CLI = 'cli';

const ISSUER_MAX = 2000;
const SUB_MAX = 2000;

// ---------- pure rules ----------

// The issuer key: the one spelling OIDC logins are recorded under. It
// refuses only what can never discover (not a URL, a scheme other than
// http(s), userinfo — fetch refuses a URL with credentials, and a secret
// must not become part of every login) and folds what is spelling: a bare
// origin's slash, the /.well-known/openid-configuration suffix (stripped
// from the path, so a query after it no longer defeats it) and a fragment
// (never sent to the IdP; dropped, so a key never holds '#'). The query is
// kept. A path's trailing slash is not folded (the plan's literal rule).
// The error names the variable, never echoes the value beyond the scheme.
export function canonIssuer(value) {
  const raw = String(value ?? '').trim();
  if (raw.length > ISSUER_MAX) throw new TypeError(`OBSERVOGRAM_OIDC_ISSUER is longer than ${ISSUER_MAX} characters`);
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new TypeError('OBSERVOGRAM_OIDC_ISSUER is not a URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new TypeError(`OBSERVOGRAM_OIDC_ISSUER is an http(s) URL, not ${u.protocol}`);
  }
  if (u.username || u.password) throw new TypeError('OBSERVOGRAM_OIDC_ISSUER must not carry credentials (user:password@)');
  u.hash = '';
  u.pathname = u.pathname.replace(/\/\.well-known\/openid-configuration\/?$/, '');
  const key = u.href;
  if (key.length > ISSUER_MAX) throw new TypeError(`OBSERVOGRAM_OIDC_ISSUER is longer than ${ISSUER_MAX} characters`);
  return key;
}

export function oidcLogin(issuerKey, sub) {
  return `${issuerKey}#${sub}`;
}

// The reverse proxy's identity key (server/auth-proxy.mjs): `proxy://<realm>`,
// a realm of [a-z0-9._-]{1,64}. Its users are kind 'oidc' rows recorded as
// `proxy://<realm>#<user>` — no migration, and every store operation and
// CLI that knows an OIDC row knows these (including `packc store
// rekey-issuer --clear`, which disables them too). A proxy key is never an
// http(s) URL, so canonIssuer() refuses it and the two never collide.
export const PROXY_REALM_RE = /^[a-z0-9._-]{1,64}$/;
const PROXY_KEY_RE = /^proxy:\/\/[a-z0-9._-]{1,64}$/;
export function proxyIssuerKey(realm) {
  if (typeof realm !== 'string' || !PROXY_REALM_RE.test(realm)) {
    throw new TypeError('OBSERVOGRAM_PROXY_AUTH_REALM is 1–64 characters of [a-z0-9._-]');
  }
  return `proxy://${realm}`;
}
export function isProxyIssuerKey(value) {
  return typeof value === 'string' && PROXY_KEY_RE.test(value);
}

// The cookie's `sub` and the export's member key: what a pre-store build
// knows the user by (the username, or the bare IdP sub).
export function preStoreSub(user) {
  return user.kind === 'oidc' ? user.sub : user.login;
}

// orgs.json roles → store roles. Never refuses: anything unknown is an
// operator (a pre-store build gave every member full write). `exact` is
// false whenever the written value is not the store role verbatim.
export function mapLegacyRole(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const word = v === '' ? 'member' : v;
  let role = 'operator';
  if (word === 'admin' || word === 'owner') role = 'admin';
  else if (['viewer', 'read', 'readonly', 'read-only'].includes(word)) role = 'viewer';
  return { role, exact: typeof value === 'string' && value === role };
}

// OBSERVOGRAM_OIDC_JOIN_ROLE: unset → undefined; 'none' → null (no
// auto-join); a role → that role; anything else refuses.
export function parseJoinRole(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (value === undefined || value === null || v === '') return undefined;
  if (v === 'none') return null;
  if (ROLES.includes(v)) return v;
  throw new TypeError(`OBSERVOGRAM_OIDC_JOIN_ROLE is one of viewer, operator, admin or none, not ${JSON.stringify(v)}`);
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

// OBSERVOGRAM_BOOTSTRAP_ADMIN: '<issuer>#<sub>' (split at the FIRST '#':
// an issuer key never holds one, a sub may) or an email.
export function parseBootstrapAdmin(value) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v === '') return null;
  const hash = v.indexOf('#');
  if (hash !== -1) {
    const sub = v.slice(hash + 1);
    let issuerKey;
    try {
      issuerKey = canonIssuer(v.slice(0, hash));
    } catch (e) {
      throw new TypeError(`OBSERVOGRAM_BOOTSTRAP_ADMIN is <issuer>#<sub> or an email: its issuer part is unusable (${e.message.replace(/^OBSERVOGRAM_OIDC_ISSUER /, 'it ')})`, { cause: e });
    }
    if (!textOk(sub, { max: SUB_MAX })) throw new TypeError('OBSERVOGRAM_BOOTSTRAP_ADMIN is <issuer>#<sub> or an email: its sub is empty');
    return { kind: 'login', issuerKey, login: oidcLogin(issuerKey, sub) };
  }
  if (EMAIL.test(v)) return { kind: 'email', email: v.toLowerCase() };
  throw new TypeError('OBSERVOGRAM_BOOTSTRAP_ADMIN is <issuer>#<sub> or an email');
}

// An email counts only when the ID token says email_verified: true (the
// boolean; a string 'true' does not).
export function bootstrapMatches(spec, { login, email, emailVerified }, issuerKey) {
  if (!spec) return false;
  if (spec.kind === 'login') return spec.issuerKey === issuerKey && spec.login === login;
  if (spec.kind === 'email') return emailVerified === true && typeof email === 'string' && email.toLowerCase() === spec.email;
  return false;
}

// ID-token claims → values the users repository accepts (textOk is the one
// test of "storable"), so a profile sync never throws on an IdP's odd
// values. The sub is the IdP's identifier, compared byte for byte: never
// trimmed, and an unusable one (a C0/C1 control character included)
// refuses the sign-in. Control characters are stripped from name and email,
// so an IdP-supplied profile cannot forge lines in `npm run users -- list`.
export const isControlChar = (ch) => {
  const n = ch.charCodeAt(0);
  return n <= 0x1f || (n >= 0x7f && n <= 0x9f);
};
const stripControlChars = (s) => Array.from(s).filter((ch) => !isControlChar(ch)).join('');
export function sanitiseClaims(claims, envIssuer) {
  const c = claims && typeof claims === 'object' ? claims : {};
  if (!textOk(c.sub, { max: SUB_MAX }) || Array.from(c.sub).some(isControlChar)) {
    const err = new Error('sign-in failed: the ID token\'s sub is unusable');
    err.code = 'ERR_OBSERVOGRAM_UNUSABLE_SUB';
    throw err;
  }
  let name = typeof c.name === 'string' ? stripControlChars(c.name).trim().slice(0, 200) : null;
  if (!name) name = null;
  let email = typeof c.email === 'string' ? stripControlChars(c.email).trim() : null;
  if (!email || email.length > 320 || email.split('@').length !== 2) email = null;
  const iss = textOk(c.iss, { max: ISSUER_MAX }) ? c.iss : envIssuer;
  return { sub: c.sub, iss, email, email_verified: c.email_verified === true, name };
}

// ---------- the atomic operations ----------

export function defaultOrgId(db) {
  const id = getMeta(db, 'default_org');
  if (id) return id;
  const err = new Error('observogram store: the store has no default org (schema_meta default_org is unset)');
  err.code = 'ERR_OBSERVOGRAM_STORE_NO_DEFAULT_ORG';
  throw err;
}

export function liveOrg(db, id) {
  if (!validOrgId(id)) return null;
  const org = getOrg(db, id);
  return org && !org.removedAt ? org : null;
}

// A CLI on a store the server never started: the first user needs an org
// to be in. Creates 'default' at '.' (org.create) and records it
// (meta.set) when no default org is recorded; else returns it.
export function ensureDefaultOrg(db, actor) {
  return atomic(db, () => {
    const recorded = getMeta(db, 'default_org');
    if (recorded) return getOrg(db, recorded);
    const org = getOrg(db, 'default') || createOrg(db, actor, { id: 'default', name: 'Default', root: '.' });
    setMeta(db, actor, 'default_org', org.id);
    return org;
  });
}

// Enabled owners who can sign in under `mode`: 'local' → a local row with
// a password; 'oidc' → an OIDC row under this issuer key (a prefix test,
// not LIKE: a '%' or '_' in a key would act as a wildcard).
export function signInOwnerCount(db, { mode, issuerKey = null }) {
  if (mode === 'local') {
    return prepare(db, `SELECT count(*) AS n FROM users
      WHERE is_owner = 1 AND disabled = 0 AND kind = 'local' AND password IS NOT NULL`).get().n;
  }
  if (mode === 'oidc') {
    if (typeof issuerKey !== 'string' || !issuerKey) return 0;
    const prefix = `${issuerKey}#`;
    return prepare(db, `SELECT count(*) AS n FROM users
      WHERE is_owner = 1 AND disabled = 0 AND kind = 'oidc' AND substr(login, 1, :n) = :prefix`).get({ n: prefix.length, prefix }).n;
  }
  throw new TypeError(`observogram store: sign-in mode is local or oidc, not ${JSON.stringify(mode)}`);
}

// A just-in-time OIDC row: one user.jit row; then, when oidc_join_role is
// set and the default org is live, a membership at that role and one
// membership.jit row. The join happens only here, when the row is created,
// so an admin's later removal of the membership sticks. The reverse proxy
// (proxySignIn) passes its own join rule instead: `joinRole` (a role, or
// null for none) and `joinOrgId` (its configured org) — undefined keeps
// the OIDC rule, so the callback's rows are what they were.
export function createOidcUser(db, {
  issuerKey, issuerDisplay, sub, email = null, emailVerified = false, name = null, sessionEpoch = 1, via,
  joinRole = undefined, joinOrgId = undefined,
}) {
  return atomic(db, () => {
    const user = insertUserRow(db, {
      kind: 'oidc', login: oidcLogin(issuerKey, sub), issuer: issuerDisplay, sub,
      email, emailVerified: emailVerified === true, name, sessionEpoch,
    });
    writeAudit(db, SYSTEM, { action: 'user.jit', targetKind: 'user', targetId: user.login, detail: { via, sessionEpoch } });
    const role = joinRole === undefined ? getMeta(db, 'oidc_join_role') : joinRole;
    const orgId = joinOrgId === undefined ? getMeta(db, 'default_org') : joinOrgId;
    if (role && orgId && liveOrg(db, orgId)) {
      insertMembershipRow(db, { orgId, userId: user.id, role });
      writeAudit(db, SYSTEM, { orgId, action: 'membership.jit', targetKind: 'user', targetId: user.login, detail: { role } });
    }
    return user;
  });
}

const GRANT_ACTIONS = ['owner.bootstrap', 'owner.first-local-user', 'owner.grant'];

// Makes the user an owner and an admin of the default org (added, or a
// viewer/operator membership raised), writing ONE row of `action` — no
// user.owner.grant or membership.* rows. The row's `from` is the default
// org's role before the grant (null when the membership was added), read
// before it is raised: what a later revoke leaves behind is on record.
export function grantOwner(db, actor, userId, { action, via, match = null }) {
  if (!GRANT_ACTIONS.includes(action)) throw new TypeError(`observogram store: an owner grant is one of ${GRANT_ACTIONS.join(', ')}, not ${JSON.stringify(action)}`);
  return atomic(db, () => {
    const found = getUser(db, userId);
    if (!found) throw new Error(`observogram store: no user ${JSON.stringify(userId)}`);
    const org = defaultOrgId(db);
    if (!liveOrg(db, org)) throw new Error(`observogram store: the default org ${JSON.stringify(org)} is not live`);
    const current = getMembership(db, org, userId);
    const from = current ? current.role : null;
    const user = setOwnerRow(db, userId, true);
    let membership = 'kept';
    if (!current) { insertMembershipRow(db, { orgId: org, userId, role: 'admin' }); membership = 'added'; }
    else if (current.role !== 'admin') { setRoleRow(db, org, userId, 'admin'); membership = 'raised'; }
    writeAudit(db, actor, { action, targetKind: 'user', targetId: user.login, detail: { via, match, org, membership, from } });
    return user;
  });
}

// The twin of owner.grant: the owner flag cleared and ONE owner.revoke row
// (detail: via, the default org and the role the user keeps there — null
// without a membership). No membership changes: the default org's admin
// membership a grant gave stays until someone changes it. Like grantOwner
// it writes its row whatever the flag was: the caller skips a no-op.
export function revokeOwner(db, actor, userId, { via }) {
  return atomic(db, () => {
    const found = getUser(db, userId);
    if (!found) throw new Error(`observogram store: no user ${JSON.stringify(userId)}`);
    const org = defaultOrgId(db);
    const user = setOwnerRow(db, userId, false);
    const role = getMembership(db, org, userId)?.role ?? null;
    writeAudit(db, actor, { action: 'owner.revoke', targetKind: 'user', targetId: user.login, detail: { via, org, role } });
    return user;
  });
}

// The OIDC callback's store half, in one transaction: find or create the
// row, refuse a local row holding the login or a disabled row, sync the
// profile, and apply OBSERVOGRAM_BOOTSTRAP_ADMIN while no enabled owner can
// sign in under this issuer. `claims` are sanitiseClaims() output.
export function oidcSignIn(db, { issuerKey, issuerDisplay, claims, bootstrap = null }) {
  return atomic(db, () => {
    const login = oidcLogin(issuerKey, claims.sub);
    let user = getUserByLogin(db, login);
    let created = false;
    let granted = false;
    if (!user) {
      user = createOidcUser(db, {
        issuerKey, issuerDisplay, sub: claims.sub, email: claims.email ?? null,
        emailVerified: claims.email_verified === true, name: claims.name ?? null, sessionEpoch: 1, via: 'callback',
      });
      created = true;
    } else if (user.kind !== 'oidc') {
      return { user: null, refused: 'local-login', created, granted };
    } else if (user.disabled) {
      return { user, refused: 'disabled', created, granted };
    } else {
      const patch = {};
      if ((claims.email ?? null) !== user.email) patch.email = claims.email ?? null;
      if ((claims.email_verified === true) !== user.emailVerified) patch.emailVerified = claims.email_verified === true;
      if ((claims.name ?? null) !== user.name) patch.name = claims.name ?? null;
      if (Object.keys(patch).length) user = updateUserProfile(db, SYSTEM, user.id, patch);
    }
    if (bootstrap
      && bootstrapMatches(bootstrap, { login, email: claims.email, emailVerified: claims.email_verified }, issuerKey)
      && signInOwnerCount(db, { mode: 'oidc', issuerKey }) === 0) {
      user = grantOwner(db, SYSTEM, user.id, { action: 'owner.bootstrap', via: 'OBSERVOGRAM_BOOTSTRAP_ADMIN', match: bootstrap.kind });
      granted = true;
    }
    return { user, refused: null, created, granted };
  });
}

// The first sight of a pre-upgrade OIDC cookie with no row: created at
// epoch 0 (the cookie reads as 0). The caller sanitises the cookie's
// values first. Two parallel first requests: the loser re-reads the row.
export function firstSightOidc(db, { issuerKey, issuerDisplay, sub, email = null, name = null }) {
  try {
    return createOidcUser(db, { issuerKey, issuerDisplay, sub, email, emailVerified: false, name, sessionEpoch: 0, via: 'pre-upgrade-cookie' });
  } catch (e) {
    if (!/UNIQUE/.test(String(e?.message))) throw e;
    const user = getUserByLogin(db, oidcLogin(issuerKey, sub));
    if (!user) throw e;
    return user;
  }
}

// ---------- the reverse proxy (server/auth-proxy.mjs) ----------

// The proxy's statement of the user's role in `orgId`, made authoritative
// there and nowhere else: `role` null → the membership removed (one
// membership.remove row); a role → added (membership.jit) or changed
// (membership.role); unchanged → nothing written. An org that is not live
// (removed since the boot checked it) is left alone. Detail carries
// `via: 'proxy-groups'`, so the audit tells a proxy's change from an
// admin's. Inside the caller's atomic().
export function syncProxyMembership(db, { user, orgId, role }) {
  if (role !== null && !ROLES.includes(role)) throw new TypeError(`observogram store: a proxy membership role is one of ${ROLES.join(', ')} or null, not ${JSON.stringify(role)}`);
  return atomic(db, () => {
    if (!orgId || !liveOrg(db, orgId)) return 'no-org';
    const current = getMembership(db, orgId, user.id);
    if (role === null) {
      if (!current) return 'unchanged';
      deleteMembershipRow(db, orgId, user.id);
      writeAudit(db, SYSTEM, { orgId, action: 'membership.remove', targetKind: 'user', targetId: user.login, detail: { role: current.role, via: 'proxy-groups' } });
      return 'removed';
    }
    if (!current) {
      insertMembershipRow(db, { orgId, userId: user.id, role });
      writeAudit(db, SYSTEM, { orgId, action: 'membership.jit', targetKind: 'user', targetId: user.login, detail: { role, via: 'proxy-groups' } });
      return 'added';
    }
    if (current.role === role) return 'unchanged';
    setRoleRow(db, orgId, user.id, role);
    writeAudit(db, SYSTEM, { orgId, action: 'membership.role', targetKind: 'user', targetId: user.login, detail: { from: current.role, to: role, via: 'proxy-groups' } });
    return 'changed';
  });
}

// The reverse proxy's sign-in, once per request, in one transaction (the
// twin of oidcSignIn): find or create the row `proxy://<realm>#<user>`
// (user.jit { via: 'proxy' }, joined at `joinRole` in `orgId` only when the
// proxy made no statement about groups — `membershipRole` undefined),
// refuse a local row holding the login or a disabled row, sync the profile
// (the proxy's email is recorded as verified: the proxy is the authority on
// who the caller is), apply the groups' role in `orgId` when the proxy
// stated one (`membershipRole`: a role, or null for none), and grant owner
// (one owner.grant row, via 'proxy') when `owner` and not yet one — never
// revoked here. Writes only on change: the second request of a session
// writes nothing. `user` is the header's value, compared byte for byte.
export function proxySignIn(db, {
  issuerKey, issuerDisplay, user: sub, email = null, name = null, orgId, joinRole = null, membershipRole = undefined, owner = false,
}) {
  return atomic(db, () => {
    const login = oidcLogin(issuerKey, sub);
    let user = getUserByLogin(db, login);
    let created = false;
    let granted = false;
    let membership = null;
    if (!user) {
      user = createOidcUser(db, {
        issuerKey, issuerDisplay, sub, email, emailVerified: email !== null, name, sessionEpoch: 1, via: 'proxy',
        joinRole: membershipRole === undefined ? joinRole : null, joinOrgId: orgId,
      });
      created = true;
    } else if (user.kind !== 'oidc') {
      return { user: null, refused: 'local-login', created, granted, membership };
    } else if (user.disabled) {
      return { user, refused: 'disabled', created, granted, membership };
    } else {
      const patch = {};
      if (email !== user.email) patch.email = email;
      if ((email !== null) !== user.emailVerified) patch.emailVerified = email !== null;
      if (name !== user.name) patch.name = name;
      if (Object.keys(patch).length) user = updateUserProfile(db, SYSTEM, user.id, patch);
    }
    if (membershipRole !== undefined) membership = syncProxyMembership(db, { user, orgId, role: membershipRole });
    if (owner && !user.isOwner) {
      user = grantOwner(db, SYSTEM, user.id, { action: 'owner.grant', via: 'proxy' });
      granted = true;
    }
    return { user, refused: null, created, granted, membership };
  });
}
