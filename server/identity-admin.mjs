// server/identity-admin.mjs — the identity management rules
// (docs/STORE_PLAN.md §4 "The CLIs", §5), shared by `npm run users` /
// `npm run orgs` and by the identity API (slice 3b): every refusal lives
// here once. Each operation runs in one atomic() and writes the
// repositories' audit rows under the caller's actor ('cli' from a shell,
// the principal's actor from the API).
//
// Two surfaces. A rule is called with `surface: 'cli'` (the default) or
// `'api'`; the condition that refuses is the same, and only the way out a
// refusal names differs — a command for a shell, a route for the API —
// taken from one table (WAYS). The CLI's texts are pinned byte for byte by
// server/test-store.mjs. Every refusal carries a `kind`: 'invalid' (bad
// input), 'missing' (no such row) or 'conflict' (the state forbids it),
// which the API answers as 400, 404 and 409; the CLIs ignore it.
//
// resolveLogin() is how a shell argument names a user: a local login, or
// an OIDC login `<issuerKey>#<sub>` built from this shell's issuer and
// checked against the issuer the store records — a miss never falls back
// to the other kind. The API names users by id and never creates one while
// adding a member (findMemberCandidate).

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { authDisabled, hashPassword, issuerKey } from './auth.mjs';
import { proxyAuthConfig } from './auth-proxy.mjs';
import { validOrgId } from './org-context.mjs';
import { atomic, prepare } from './store/db.mjs';
import { writeAudit } from './store/audit.mjs';
import { getMeta, isIdentityArmed, setMeta } from './store/meta.mjs';
import { createOrg, getOrg, listOrgs, removeOrg, renameOrg } from './store/orgs.mjs';
import {
  addMembership, countEnabledAdmins, getMembership, listMembershipsForUser, removeMembership, ROLES, setRole,
} from './store/memberships.mjs';
import {
  bumpSessionEpoch, createUser, getUser, getUserByLogin, listUsersByVerifiedEmail, setDisabled, setPassword,
} from './store/users.mjs';
import { textOk } from './store/rows.mjs';
import {
  canonIssuer, CLI, defaultOrgId, ensureDefaultOrg, grantOwner, liveOrg, oidcLogin, parseJoinRole, revokeOwner,
  signInOwnerCount, SYSTEM, isProxyIssuerKey,
} from './store/identity.mjs';

export const REFUSAL_KINDS = Object.freeze(['invalid', 'missing', 'conflict']);

export class AdminRefusal extends Error {
  constructor(message, kind = 'conflict') {
    super(message);
    if (!REFUSAL_KINDS.includes(kind)) throw new TypeError(`an admin refusal's kind is one of ${REFUSAL_KINDS.join(', ')}, not ${JSON.stringify(kind)}`);
    this.name = 'AdminRefusal';
    this.code = 'ERR_OBSERVOGRAM_ADMIN_REFUSED';
    this.kind = kind;
  }
}

const refuse = (message, kind = 'conflict') => { throw new AdminRefusal(message, kind); };
const invalid = (message) => refuse(message, 'invalid');
const missing = (message) => refuse(message, 'missing');

// The way out each refusal names, per surface. The `cli` column is the
// shells' texts as they were; the `api` column names the route that does
// the same. A route that no commit has yet is named only by a text no
// caller can reach (the rule is called with 'api' only from the routes).
const OWNER_ROUTE = 'PUT /api/admin/users/<id>/owner with {"owner": true}';
const WAYS = {
  cli: {
    org: '--org',
    adopt: 'pass --adopt to take it over',
    noUser: (login) => `no such user: ${login}`,
    exists: (u) => `user exists: ${u.login} (use passwd)`,
    existsDisabled: (u) => `user exists: ${u.login}, disabled (npm run users -- enable ${u.login}; passwd sets a new password)`,
    newPassword: { min: 1, text: 'a password is required' },
    resetPassword: { min: 1, text: 'a password is required' },
    ownerWithheld: (login) => 'grant owner to an IdP user with npm run users -- owner <login>, '
      + `or, once the server has started without OBSERVOGRAM_OIDC_ISSUER, npm run users -- owner ${login} from a shell without it`,
    anotherOwner: 'grant another owner first (npm run users -- owner <login>)',
    anotherSignInOwner: 'grant another owner first (npm run users -- owner <login>)',
    enableFirst: (u) => `npm run users -- enable ${u.login} first`,
    passwdFirst: (u) => `npm run users -- passwd ${u.login} first`,
    changeRole: (u, org) => `npm run orgs -- add-member ${org} ${u.login} --role <role>`,
  },
  api: {
    org: '"orgId"',
    adopt: 'send "adopt": true to take it over',
    noUser: (login) => `no user ${login}`,
    exists: (u) => `user exists: ${u.login} — reset its password with POST /api/admin/users/${u.id}/password`,
    existsDisabled: (u) => `user exists: ${u.login}, disabled — enable it with POST /api/admin/users/${u.id}/enable `
      + `(POST /api/admin/users/${u.id}/password sets a new password)`,
    newPassword: { min: 8, text: 'a password of at least 8 characters is required' },
    resetPassword: { min: 8, text: 'a temporary password of at least 8 characters is required' },
    ownerWithheld: (login) => `${login} is created without owner; make an IdP user an owner with ${OWNER_ROUTE}`,
    anotherOwner: `make another user an owner first (${OWNER_ROUTE})`,
    anotherSignInOwner: `make another user who signs in that way an owner first (${OWNER_ROUTE})`,
    enableFirst: (u) => `enable it first (POST /api/admin/users/${u.id}/enable)`,
    passwdFirst: (u) => `set a temporary one first (POST /api/admin/users/${u.id}/password)`,
    changeRole: (u, org) => `PATCH /api/org/members/${u.id} in org ${org}`,
  },
};

function waysOf(surface) {
  if (!Object.hasOwn(WAYS, surface)) throw new TypeError(`a surface is cli or api, not ${JSON.stringify(surface)}`);
  return WAYS[surface];
}

// Today's rule for a new local username (existing ones are managed as
// written: an imported `John Smith` or `ops#1` can be given a password or
// disabled).
export const LOCAL_LOGIN_RE = /^[a-zA-Z0-9._@-]{2,64}$/;

// The actor names the audit log writes for something other than a user
// (docs/STORE_PLAN.md §5): a user with one of these logins would be
// indistinguishable from it. Refused for a new user on both surfaces; the
// API also refuses the configured OBSERVOGRAM_API_TOKEN_LABEL.
const RESERVED_FOR = new Map([
  [SYSTEM, "the store's automatic grants"],
  [CLI, 'a shell'],
  ['local', 'the server without sign-in'],
  ['token', 'the API token'],
]);
export const RESERVED_LOGINS = Object.freeze([...RESERVED_FOR.keys()]);

function reservedFor(login, tokenLabel) {
  if (RESERVED_FOR.has(login)) return RESERVED_FOR.get(login);
  return typeof tokenLabel === 'string' && login === tokenLabel ? 'the API token' : null;
}

// --role: viewer, operator or admin; default operator. 'member' is no
// longer written.
export function parseRole(value) {
  if (value === undefined || value === null) return 'operator';
  if (value === 'member') invalid("roles are viewer, operator or admin ('member' is now 'operator')");
  if (!ROLES.includes(value)) invalid(`roles are viewer, operator or admin, not ${JSON.stringify(value)}`);
  return value;
}

function shellKey(shellIssuerRaw) {
  if (!shellIssuerRaw) return null;
  try {
    return canonIssuer(shellIssuerRaw);
  } catch (e) {
    return refuse(`this shell's ${e.message}`);
  }
}

function isHttpUrl(text) {
  try {
    const u = new URL(text);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function oidcTarget(db, login, sub, issuerKeyValue) {
  const row = getUserByLogin(db, login);
  if (row && row.kind !== 'oidc') refuse(`the login ${login} is held by a local user — it never names an OIDC user`);
  return { kind: 'oidc', login, sub, issuerKey: issuerKeyValue, row };
}

// → { login, kind: 'local' | 'oidc', sub?, issuerKey?, row } (row null when
// the user was never seen).
export function resolveLogin(db, arg, { shellIssuerRaw = null } = {}) {
  if (typeof arg !== 'string' || arg === '') invalid('a login is required');
  const R = getMeta(db, 'oidc_issuer');
  const S = shellKey(shellIssuerRaw);
  if (S && R && S !== R) refuse(`this shell's OBSERVOGRAM_OIDC_ISSUER is key ${S}; the store records ${R}`);
  const K = S ?? R;
  const hash = arg.indexOf('#');
  if (hash !== -1) {
    // 1. a local row with exactly that login (a users.json name such as ops#1)
    const local = getUserByLogin(db, arg);
    if (local && local.kind === 'local' && (K === null || !isHttpUrl(arg.slice(0, hash)))) {
      return { kind: 'local', login: arg, row: local };
    }
    // 2a. proxy://<realm>#<user> — a reverse proxy's user (server/auth-proxy.mjs):
    // never an http(s) key, so the recorded OIDC issuer has no say.
    if (isProxyIssuerKey(arg.slice(0, hash))) {
      const sub = arg.slice(hash + 1);
      if (!textOk(sub, { max: 2000 })) invalid(`${arg} is not proxy://<realm>#<user>`);
      return oidcTarget(db, arg, sub, arg.slice(0, hash));
    }
    // 2. <issuer>#<sub>
    let key;
    try { key = canonIssuer(arg.slice(0, hash)); } catch { invalid(`${arg} is not <issuer>#<sub>`); }
    const sub = arg.slice(hash + 1);
    if (!textOk(sub, { max: 2000 })) invalid(`${arg} is not <issuer>#<sub>`);
    if (K && key !== K) refuse(`${arg} names issuer ${key}; this store's OIDC users are recorded under ${K}`);
    return oidcTarget(db, oidcLogin(key, sub), sub, key);
  }
  // 3. a bare sub from a shell configured like the unit
  if (S) return oidcTarget(db, oidcLogin(S, arg), arg, S);
  // 4. an OIDC store operated from a plain shell: local only for an enabled local row
  if (R) {
    const local = getUserByLogin(db, arg);
    if (local && local.kind === 'local' && !local.disabled) return { kind: 'local', login: arg, row: local };
    refuse(`this store records OIDC issuer ${R}: for the IdP user set OBSERVOGRAM_OIDC_ISSUER in this shell or pass ${R}#${arg}; `
      + `for a local user, npm run users -- add ${arg} first`);
  }
  // 5. a local login
  return { kind: 'local', login: arg, row: getUserByLogin(db, arg) };
}

// The user a resolved login names, creating an OIDC row never seen (epoch
// 1, user.create under `actor`); a local login must exist.
function userFor(db, actor, target, { shellIssuerRaw }) {
  if (target.row) return target.row;
  if (target.kind === 'local') missing(`no local user ${target.login} — npm run users -- add ${target.login} first`);
  return createUser(db, actor, {
    kind: 'oidc', login: target.login, issuer: shellIssuerRaw || target.issuerKey, sub: target.sub,
  });
}

const enabledOwnerCount = (db) => prepare(db, 'SELECT count(*) AS n FROM users WHERE is_owner = 1 AND disabled = 0').get().n;

// The sign-in mode the server runs, as far as a shell can know it: a shell
// that sets OBSERVOGRAM_OIDC_ISSUER is configured like an OIDC server, so
// that issuer; else the mode the server recorded at its last start
// (identity_mode, boot step 4); else — a store no start of this build has
// booted — the store alone: local, plus the recorded issuer if any (the
// server may run either way). `why` names the source, for every text.
//   → { kind: 'oidc', issuerKey, why } | { kind: 'local', why }
//     | { kind: 'unknown', issuerKey (null when none recorded), why }
export function serverSignInMode(db, { shellIssuerRaw = null } = {}) {
  const S = shellKey(shellIssuerRaw);
  if (S) return { kind: 'oidc', issuerKey: S, why: `this shell configures OIDC issuer ${S}` };
  const M = getMeta(db, 'identity_mode');
  if (M !== null && M.startsWith('oidc:')) {
    const key = M.slice('oidc:'.length);
    return { kind: 'oidc', issuerKey: key, why: `the server last started with OIDC issuer ${key}` };
  }
  if (M !== null && M.startsWith('proxy:')) {
    const key = M.slice('proxy:'.length);
    return { kind: 'oidc', issuerKey: key, why: `the server last started behind a reverse proxy (identity key ${key})` };
  }
  const last = {
    local: 'the server last started without OIDC, with local sign-in',
    token: 'the server last started without OIDC, with only OBSERVOGRAM_API_TOKEN',
    open: 'the server last started without OIDC or any sign-in',
    off: 'the server last started with OBSERVOGRAM_AUTH=off and without OIDC',
  }[M];
  if (last) return { kind: 'local', why: last };
  const R = getMeta(db, 'oidc_issuer');
  return {
    kind: 'unknown',
    issuerKey: R,
    why: R ? `this store records OIDC issuer ${R} and no server start has recorded whether it still runs with it`
      : 'no server start has recorded a sign-in mode',
  };
}

// The server's own sign-in mode, from its environment — what the API
// passes as `mode` to every rule that needs one (a shell infers it with
// serverSignInMode()). OBSERVOGRAM_OIDC_ISSUER decides even with
// OBSERVOGRAM_AUTH=off: OIDC logins follow the issuer.
export function liveSignInMode() {
  const key = issuerKey();
  if (key) return { kind: 'oidc', issuerKey: key, why: `this server signs in through OIDC issuer ${key}` };
  const proxy = proxyAuthConfig();
  if (proxy) return { kind: 'oidc', issuerKey: proxy.issuerKey, why: `this server takes identity from its reverse proxy (key ${proxy.issuerKey})` };
  return {
    kind: 'local',
    why: authDisabled() ? 'this server runs with OBSERVOGRAM_AUTH=off and without OIDC' : 'this server signs in with local passwords',
  };
}

// The modes whose owners keep the web-usable owner set alive.
function signInModes(mode) {
  if (mode.kind === 'oidc') return [{ mode: 'oidc', issuerKey: mode.issuerKey }];
  if (mode.kind === 'unknown' && mode.issuerKey) return [{ mode: 'local' }, { mode: 'oidc', issuerKey: mode.issuerKey }];
  return [{ mode: 'local' }];
}

// A-16 applies only where a local user can sign in.
const localSignIn = (mode) => mode.kind === 'local' || (mode.kind === 'unknown' && !mode.issuerKey);

const modeText = ({ mode, issuerKey: key }) => (mode === 'oidc' ? `through OIDC issuer ${key}` : 'with a local password');

function signsInUnder(row, { mode, issuerKey: key }) {
  if (row.disabled || !row.isOwner) return false;
  if (mode === 'local') return row.kind === 'local' && row.password !== null && row.password !== undefined;
  return row.kind === 'oidc' && row.login.startsWith(`${key}#`);
}

// The owner set a disable or a revoke of `row` must leave: another enabled
// owner, and another owner who can sign in under the server's mode (`mode`,
// else serverSignInMode() — worked out only once the first check passes).
function assertKeepsOwner(db, row, { mode = null, shellIssuerRaw = null, surface }) {
  const ways = waysOf(surface);
  if (!row.disabled && row.isOwner && enabledOwnerCount(db) === 1) {
    refuse(`${row.login} is the last enabled owner — ${ways.anotherOwner}`);
  }
  const m = mode ?? serverSignInMode(db, { shellIssuerRaw });
  const modes = signInModes(m);
  const left = modes.reduce((n, x) => n + signInOwnerCount(db, x), 0);
  if (modes.some((x) => signsInUnder(row, x)) && left === 1) {
    refuse(`${row.login} is the last owner who can sign in ${modes.map(modeText).join(' or ')} (${m.why}) — ${ways.anotherSignInOwner}`);
  }
}

function checkPassword(password, { min, text }) {
  if (typeof password !== 'string' || password.length < min) invalid(text);
}

// ---------- users ----------

// The read-only refusals of `users -- add`, so the CLI can run them before
// it prompts for a password (a refusal never costs a typed password). The
// reserved logins are checked after the shape, so no other input's text
// moves; `tokenLabel` (the API's OBSERVOGRAM_API_TOKEN_LABEL) is one more.
export function checkAddLocalUser(db, { login, role, orgId = null, surface = 'cli', tokenLabel = null }) {
  const ways = waysOf(surface);
  if (typeof login !== 'string' || !LOCAL_LOGIN_RE.test(login)) invalid('username must be 2–64 chars of [a-zA-Z0-9._@-]');
  const use = reservedFor(login, tokenLabel);
  if (use) invalid(`${JSON.stringify(login)} is reserved — the audit log uses it for ${use}; choose another username`);
  const parsedRole = parseRole(role);
  const existing = getUserByLogin(db, login);
  if (existing?.disabled) refuse(ways.existsDisabled(existing));
  if (existing) refuse(ways.exists(existing));
  const live = listOrgs(db);
  if (orgId !== null && orgId !== undefined) {
    if (!liveOrg(db, orgId)) invalid(`no live org ${JSON.stringify(orgId)}`);
  } else if (live.length > 1) {
    invalid(`this deployment has ${live.length} orgs: name one with ${ways.org}`);
  }
  return { role: parsedRole, orgId: orgId ?? null };
}

// → { user, owner, ownerWithheld, joined: [{ orgId, role }], armed, mode }.
// `password` is the plain text; it is hashed before the transaction opens.
// The first local user created while no enabled local owner exists becomes
// the owner and admin of the default org, whatever --role says (A-16) —
// only when the server's sign-in mode is local (or unknown with no issuer
// recorded): elsewhere a local user cannot sign in, so owner would only let
// the last OIDC owner be disabled. Then `ownerWithheld` says why (null
// otherwise). `mode` is the mode it used: the caller's (the API passes
// liveSignInMode()), else serverSignInMode().
export function addLocalUser(db, actor, {
  login, name = null, email = null, password, role, orgId = null, via = 'cli', shellIssuerRaw = null,
  mode = null, surface = 'cli', tokenLabel = null,
}) {
  const ways = waysOf(surface);
  checkAddLocalUser(db, { login, role, orgId, surface, tokenLabel });
  checkPassword(password, ways.newPassword);
  if (!mode) serverSignInMode(db, { shellIssuerRaw });   // a malformed shell issuer refuses before the hash
  const hashed = hashPassword(password);
  return atomic(db, () => {
    const { role: parsedRole } = checkAddLocalUser(db, { login, role, orgId, surface, tokenLabel });
    const m = mode ?? serverSignInMode(db, { shellIssuerRaw });
    const defaultOrg = ensureDefaultOrg(db, actor);
    const noLocalOwner = signInOwnerCount(db, { mode: 'local' }) === 0;
    const owner = noLocalOwner && localSignIn(m);
    let ownerWithheld = null;
    if (noLocalOwner && !owner) {
      ownerWithheld = `${m.why}${m.kind === 'oidc' ? ' and local users cannot sign in under it' : ''} — ${ways.ownerWithheld(login)}`;
    }
    let user = createUser(db, actor, { kind: 'local', login, name, email, password: hashed });
    const joined = [];
    if (owner) {
      user = grantOwner(db, SYSTEM, user.id, { action: 'owner.first-local-user', via });
      joined.push({ orgId: defaultOrg.id, role: 'admin' });
    }
    const target = orgId ?? defaultOrg.id;
    if (!owner || target !== defaultOrg.id) {
      addMembership(db, actor, { orgId: target, userId: user.id, role: parsedRole });
      joined.push({ orgId: target, role: parsedRole });
    }
    let armed = false;
    if (!isIdentityArmed(db)) { setMeta(db, actor, 'identity_armed', '1'); armed = true; }
    return { user, owner, ownerWithheld, joined, armed, mode: m };
  });
}

// Local rows only, looked up exactly as given; bumps the epoch (every
// session of the user ends). A disabled row may be given a password. The
// API sets a temporary one (`mustChange`: changed at the next sign-in, no
// skip), never on the caller's own row (`callerId`: the self route exists)
// and never on an OIDC row, which has no password here.
export function setLocalPassword(db, actor, login, password, { mustChange = false, surface = 'cli', callerId = null } = {}) {
  const ways = waysOf(surface);
  checkPassword(password, ways.resetPassword);
  const row = getUserByLogin(db, login);
  if (surface === 'cli') {
    if (!row || row.kind !== 'local') missing(`no local user ${login}`);
  } else {
    if (!row) missing(ways.noUser(login));
    if (callerId !== null && row.id === callerId) refuse('this is your own account — change your password at /auth/change-password');
    if (row.kind !== 'local') {
      refuse(`${row.login} signs in through the IdP and has no password here — sign them out everywhere (POST /api/admin/users/${row.id}/signout) or disable them`);
    }
  }
  const hashed = hashPassword(password);
  return setPassword(db, actor, row.id, hashed, { mustChange, seededDefault: false });
}

// Users are never deleted (the audit references them): disabling bumps the
// epoch and keeps the memberships. The last enabled owner stays, and so
// does the last owner who can sign in under the server's mode (`mode`, else
// serverSignInMode()).
export function disableUser(db, actor, login, { shellIssuerRaw = null, mode = null, surface = 'cli' } = {}) {
  const ways = waysOf(surface);
  return atomic(db, () => {
    const row = getUserByLogin(db, login);
    if (!row) missing(ways.noUser(login));
    if (row.disabled) return row;
    assertKeepsOwner(db, row, { mode, shellIssuerRaw, surface });
    return setDisabled(db, actor, row.id, true);
  });
}

// `users -- enable` undoes `remove`: the row, its memberships, owner flag
// and password come back as they were (the disable already ended its
// sessions). Looked up exactly as given, like `remove`. A local row still
// holding the seeded default password is refused until a password is set:
// enabling it would put admin/admin on a server that may already listen
// beyond loopback, which boot check B only catches at the next start.
export function enableUser(db, actor, login, { surface = 'cli' } = {}) {
  const ways = waysOf(surface);
  return atomic(db, () => {
    const row = getUserByLogin(db, login);
    if (!row) missing(ways.noUser(login));
    if (!row.disabled) return row;
    if (row.kind === 'local' && row.seededDefault && row.mustChange) {
      refuse(`${login} still has the seeded default password — ${ways.passwdFirst(row)}`);
    }
    return setDisabled(db, actor, row.id, false);
  });
}

// `users -- owner`: an owner and admin of the default org, whether or not
// an owner exists; an OIDC user never seen is created first.
export function grantOwnerByLogin(db, actor, arg, { shellIssuerRaw = null } = {}) {
  return atomic(db, () => {
    const target = resolveLogin(db, arg, { shellIssuerRaw });
    const user = userFor(db, actor, target, { shellIssuerRaw });
    if (user.disabled) refuse(`${user.login} is disabled — ${WAYS.cli.enableFirst(user)}`);
    ensureDefaultOrg(db, actor);
    return grantOwner(db, actor, user.id, { action: 'owner.bootstrap', via: actor === SYSTEM ? 'system' : 'cli' });
  });
}

// The owner flag, both ways. A grant makes the user an owner and an admin
// of the default org (owner.grant, whose row records the role it replaced);
// a disabled row is refused. A revoke keeps the owner set (the last-owner
// rules of a disable) and touches no membership (owner.revoke). A no-op
// writes nothing. → { user, changed, memberships: [{ orgId, role }], note }:
// `note` says when a revoked owner is still the default org's admin.
export function setOwnerFlag(db, actor, login, owner, { mode = null, shellIssuerRaw = null, surface = 'cli' } = {}) {
  const ways = waysOf(surface);
  if (typeof owner !== 'boolean') invalid('"owner" is true or false');
  return atomic(db, () => {
    const row = getUserByLogin(db, login);
    if (!row) missing(ways.noUser(login));
    let user = row;
    let changed = false;
    if (owner) {
      if (row.disabled) refuse(`${row.login} is disabled — ${ways.enableFirst(row)}`);
      if (!row.isOwner) {
        ensureDefaultOrg(db, actor);
        user = grantOwner(db, actor, row.id, { action: 'owner.grant', via: surface });
        changed = true;
      }
    } else if (row.isOwner) {
      assertKeepsOwner(db, row, { mode, shellIssuerRaw, surface });
      user = revokeOwner(db, actor, row.id, { via: surface });
      changed = true;
    }
    const memberships = listMembershipsForUser(db, row.id).map((m) => ({ orgId: m.orgId, role: m.role }));
    let note = null;
    if (!owner && changed) {
      const org = defaultOrgId(db);
      if (getMembership(db, org, row.id)?.role === 'admin') {
        note = `${row.login} is still an admin of ${org}: an owner grant makes the user an admin of the default org `
          + `(the grant's audit row records the role before it) — change it with ${ways.changeRole(row, org)} if that was not their role`;
      }
    }
    return { user, changed, memberships, note };
  });
}

// "Sign out everywhere": the user's epoch bumped (user.signout), so every
// cookie issued before stops working at its next request.
// → { user, sessionEpoch }.
export function signOutEverywhere(db, actor, login, { surface = 'cli' } = {}) {
  const ways = waysOf(surface);
  return atomic(db, () => {
    const row = getUserByLogin(db, login);
    if (!row) missing(ways.noUser(login));
    const sessionEpoch = bumpSessionEpoch(db, actor, row.id);
    return { user: getUser(db, row.id), sessionEpoch };
  });
}

// ---------- orgs ----------

function nonEmptyDir(path) {
  try {
    return readdirSync(path).length > 0;
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    return true;   // a file, or unreadable: never taken over silently
  }
}

const NEEDS_IDENTITY = 'creating a second org needs identity: add the first user with npm run users -- add, or configure OIDC';
const NEEDS_IDENTITY_AUTH_OFF = 'creating a second org needs identity: this server runs with OBSERVOGRAM_AUTH=off, '
  + 'and a second org would make its next start refuse — restart it without OBSERVOGRAM_AUTH=off and sign in as an owner '
  + '(npm run users -- add <login> first when no user exists), or configure OIDC';

// `orgs -- create`: needs identity and an enabled owner (A-15); refuses a
// non-empty orgs/<id>/ unless adopted; a slug is never reused. With
// `admin` (a shell's login) or `adminUserId` (the API's creator), that
// user's admin membership. The API also passes the server's posture: a
// server without identity (`serverIdentity: false`) is refused first —
// the store alone may be armed while the server runs OBSERVOGRAM_AUTH=off,
// and a second org would make its next start refuse. → the org, with
// `adopted` (its directory was taken over) and `path` (that directory).
export function createOrgFromAdmin(db, actor, {
  id, name = null, adopt = false, admin = null, adminUserId = null, base, shellIssuerRaw = null,
  serverIdentity, authOff = false, surface = 'cli',
}) {
  const ways = waysOf(surface);
  if (serverIdentity === false) refuse(authOff ? NEEDS_IDENTITY_AUTH_OFF : NEEDS_IDENTITY);
  if (!validOrgId(id)) invalid(`${JSON.stringify(id)} is not an org id (a slug: lowercase letters, digits, - and _)`);
  if (name !== null && !textOk(name, { max: 200 })) invalid('an org name is 1–200 characters');
  return atomic(db, () => {
    if (!isIdentityArmed(db) && !getMeta(db, 'oidc_issuer')) refuse(NEEDS_IDENTITY);
    if (enabledOwnerCount(db) === 0) refuse('no owner — run npm run users -- owner <login> first');
    if (getOrg(db, id)) refuse(`org ${JSON.stringify(id)} exists or existed — a slug is never reused`);
    const dir = join(base, 'orgs', id);
    const occupied = nonEmptyDir(dir);
    if (occupied && !adopt) refuse(`${dir} exists and is not empty — ${ways.adopt}`);
    const target = admin ? resolveLogin(db, admin, { shellIssuerRaw }) : null;
    const org = createOrg(db, actor, { id, name: name ?? id });
    if (occupied) writeAudit(db, actor, { action: 'org.adopt', targetKind: 'org', targetId: id, detail: { path: dir } });
    if (target) {
      const user = userFor(db, actor, target, { shellIssuerRaw });
      addMembership(db, actor, { orgId: id, userId: user.id, role: 'admin' });
    }
    if (adminUserId !== null && adminUserId !== undefined) addMembership(db, actor, { orgId: id, userId: adminUserId, role: 'admin' });
    return { ...org, adopted: occupied, path: dir };
  });
}

// Soft removal: the row and the files stay. The default org stays. The
// texts name no way out, so both surfaces share them.
export function removeOrgSoft(db, actor, id, { surface = 'cli' } = {}) {
  waysOf(surface);
  return atomic(db, () => {
    if (!liveOrg(db, id)) missing(`no live org ${JSON.stringify(id)}`);
    if (getMeta(db, 'default_org') === id) refuse(`${id} is the default org and cannot be removed`);
    return removeOrg(db, actor, id);
  });
}

// The org's name (org.rename; unchanged → no row).
export function renameOrgFromAdmin(db, actor, id, name) {
  if (!textOk(name, { max: 200 })) invalid('an org name is 1–200 characters');
  return atomic(db, () => {
    if (!liveOrg(db, id)) missing(`no live org ${JSON.stringify(id)}`);
    return renameOrg(db, actor, id, name);
  });
}

// ---------- members ----------

const NAME_THE_USER = 'name the user with "login" (the exact login) or "email" (a verified email)';

// The user an admin adds to their org: an EXISTING user, by exact login or
// by the one enabled user whose sign-in verified that email. Never creates
// a row. What a refusal reveals depends on who asks: an owner (`detailed`)
// learns that a user is absent, disabled or ambiguous; an org admin gets
// one text for all three, which says nothing about users outside the org.
export function findMemberCandidate(db, { login, email, detailed = false }) {
  const given = (v) => v !== undefined && v !== null;
  if (given(login) === given(email)) invalid(NAME_THE_USER);
  const value = given(login) ? login : email;
  if (typeof value !== 'string' || value === '') invalid(NAME_THE_USER);
  const disabledText = (u) => `${u.login} is disabled — ${WAYS.api.enableFirst(u)}`;
  if (given(login)) {
    const row = getUserByLogin(db, login);
    if (!detailed) {
      if (!row || row.disabled) {
        missing(`no enabled user ${JSON.stringify(login)} — an owner creates local users and re-enables disabled ones; `
          + 'an IdP user can be added after their first sign-in');
      }
      return row;
    }
    if (!row) missing(`no user ${JSON.stringify(login)} — create a local user with POST /api/admin/users; an IdP user exists after their first sign-in`);
    if (row.disabled) refuse(disabledText(row));
    return row;
  }
  const enabled = listUsersByVerifiedEmail(db, email);
  if (enabled.length === 1) return enabled[0];
  if (!detailed) {
    missing(`no single enabled user has the verified email ${email} (an email counts only when the sign-in verified it) — `
      + 'add them by login; an IdP user can be added after their first sign-in');
  }
  if (enabled.length > 1) refuse(`${enabled.length} users have the verified email ${email} — add one by login`);
  const all = listUsersByVerifiedEmail(db, email, { includeDisabled: true });
  if (all.length === 1) refuse(disabledText(all[0]));
  if (all.length > 1) refuse(`${all.length} users have the verified email ${email} — add one by login`);
  return missing(`no user has the verified email ${email} — an email counts only when the sign-in verified it; add them by login`);
}

// Demoting or removing an org's last admin: refused (409) when the target
// holds an admin membership of the org, is enabled, is the org's only
// enabled admin, and the caller is not an owner (`byOwner`; a shell is
// owner-equivalent). Runs inside the atomic() of the change it guards, so
// two concurrent demotions cannot both pass.
export function assertNotLastAdmin(db, { orgId, userId, byOwner = false }) {
  if (!db.isTransaction) throw new Error('observogram: assertNotLastAdmin() runs inside the atomic() of the change it guards');
  if (byOwner) return;
  if (getMembership(db, orgId, userId)?.role !== 'admin') return;
  const user = getUser(db, userId);
  if (!user || user.disabled || countEnabledAdmins(db, orgId) !== 1) return;
  refuse(`${user.login} is the last admin of ${orgId}: only an owner can demote or remove them — `
    + 'make another member an admin first (PATCH /api/org/members/<id> with {"role": "admin"})');
}

function liveOrgOrMissing(db, orgId) {
  if (!liveOrg(db, orgId)) missing(`no live org ${JSON.stringify(orgId)}`);
}

// A membership at `role` (default operator), as an upsert: an existing
// member with another role gets membership.role — a demotion of the org's
// last admin refused unless `byOwner`. → { membership, changed: { from, to }
// | null, added, user }.
export function addMember(db, actor, { orgId, userId, role, byOwner = false }) {
  const parsedRole = parseRole(role);
  return atomic(db, () => {
    liveOrgOrMissing(db, orgId);
    const user = getUser(db, userId);
    if (!user) missing(`no user ${userId}`);
    const current = getMembership(db, orgId, userId);
    if (!current) {
      return { membership: addMembership(db, actor, { orgId, userId, role: parsedRole }), changed: null, added: true, user };
    }
    if (current.role === parsedRole) return { membership: current, changed: null, added: false, user };
    assertNotLastAdmin(db, { orgId, userId, byOwner });
    const membership = setRole(db, actor, orgId, userId, parsedRole);
    return { membership, changed: { from: current.role, to: parsedRole }, added: false, user };
  });
}

// A member's role (membership.role; unchanged → no row), the last admin kept
// unless `byOwner`. → { membership, changed: { from, to } | null, user }.
export function setMemberRole(db, actor, { orgId, userId, role, byOwner = false }) {
  if (role === undefined || role === null) invalid('a role is required: viewer, operator or admin');
  const parsedRole = parseRole(role);
  return atomic(db, () => {
    liveOrgOrMissing(db, orgId);
    const current = getMembership(db, orgId, userId);
    if (!current) missing(`user ${userId} is not a member of ${orgId}`);
    const user = getUser(db, userId);
    if (current.role === parsedRole) return { membership: current, changed: null, user };
    assertNotLastAdmin(db, { orgId, userId, byOwner });
    const membership = setRole(db, actor, orgId, userId, parsedRole);
    return { membership, changed: { from: current.role, to: parsedRole }, user };
  });
}

// A member removed (membership.remove), the last admin kept unless
// `byOwner`. → { membership (as it was), user }.
export function removeMember(db, actor, { orgId, userId, byOwner = false }) {
  return atomic(db, () => {
    liveOrgOrMissing(db, orgId);
    if (!getMembership(db, orgId, userId)) missing(`user ${userId} is not a member of ${orgId}`);
    assertNotLastAdmin(db, { orgId, userId, byOwner });
    const user = getUser(db, userId);
    return { membership: removeMembership(db, actor, orgId, userId), user };
  });
}

// `orgs -- add-member`: an existing member with another role → setRole
// (changed: { from, to }); else a membership. A local member must exist; an
// OIDC member never seen is created (epoch 1). Shell access is
// owner-equivalent: the org's last admin may be demoted (A-40).
export function addMemberByLogin(db, actor, { orgId, arg, role, shellIssuerRaw = null }) {
  const parsedRole = parseRole(role);
  return atomic(db, () => {
    liveOrgOrMissing(db, orgId);
    const target = resolveLogin(db, arg, { shellIssuerRaw });
    const user = userFor(db, actor, target, { shellIssuerRaw });
    const { membership, changed } = addMember(db, actor, { orgId, userId: user.id, role: parsedRole, byOwner: true });
    return { membership, changed, user };
  });
}

// `orgs -- remove-member`: shell access is owner-equivalent, so the org's
// last admin may be removed (A-40).
export function removeMemberByLogin(db, actor, { orgId, arg, shellIssuerRaw = null }) {
  return atomic(db, () => {
    liveOrgOrMissing(db, orgId);
    const target = resolveLogin(db, arg, { shellIssuerRaw });
    if (!target.row) missing(`${target.login} is not a member of ${orgId}`);
    if (!getMembership(db, orgId, target.row.id)) missing(`${target.login} is not a member of ${orgId}`);
    return removeMember(db, actor, { orgId, userId: target.row.id, byOwner: true }).membership;
  });
}

// ---------- the join role ----------

const JOIN_ROLES = 'the join role is viewer, operator, admin, or null for no automatic join';

// oidc_join_role: the role an IdP user gets in the default org when their
// row is created (it backfills nobody). JSON null or 'none' → no automatic
// join; a missing or unknown value is refused. 'admin' needs `confirm:
// true` — every user the IdP admits would become an admin. One meta.set
// row with { from, to }; unchanged → no row. → { role, from, changed }.
export function setJoinRole(db, actor, role, { confirm = false } = {}) {
  let value = null;
  if (role !== null) {
    try {
      value = parseJoinRole(role);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      value = undefined;
    }
    if (value === undefined) invalid(`${JOIN_ROLES} — not ${String(JSON.stringify(role))}`);
  }
  return atomic(db, () => {
    if (value === 'admin' && confirm !== true) {
      refuse(`every user the IdP lets in would become an admin of ${defaultOrgId(db)} — its name, its members and, from slice 4, `
        + 'its MCP endpoints; to add admins one by one use POST /api/org/members with {"role": "admin"}, '
        + 'or send {"role": "admin", "confirm": true}');
    }
    const from = getMeta(db, 'oidc_join_role');
    if (from === value) return { role: value, from, changed: false };
    setMeta(db, actor, 'oidc_join_role', value, { detail: { from, to: value } });
    return { role: value, from, changed: true };
  });
}
