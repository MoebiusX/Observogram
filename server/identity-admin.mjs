// server/identity-admin.mjs — the identity management rules
// (docs/STORE_PLAN.md §4 "The CLIs", §5), shared by `npm run users` /
// `npm run orgs` now and by slice 3's identity API later: every refusal
// lives here once. Each operation runs in one atomic() and writes the
// repositories' audit rows under the caller's actor ('cli' from a shell).
//
// resolveLogin() is how an argument names a user: a local login, or an
// OIDC login `<issuerKey>#<sub>` built from this shell's issuer and checked
// against the issuer the store records — a miss never falls back to the
// other kind.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from './auth.mjs';
import { validOrgId } from './org-context.mjs';
import { atomic, prepare } from './store/db.mjs';
import { writeAudit } from './store/audit.mjs';
import { getMeta, isIdentityArmed, setMeta } from './store/meta.mjs';
import { createOrg, getOrg, listOrgs, removeOrg } from './store/orgs.mjs';
import { addMembership, getMembership, removeMembership, ROLES, setRole } from './store/memberships.mjs';
import { createUser, getUserByLogin, setDisabled, setPassword } from './store/users.mjs';
import { textOk } from './store/rows.mjs';
import {
  canonIssuer, ensureDefaultOrg, grantOwner, liveOrg, oidcLogin, signInOwnerCount, SYSTEM,
} from './store/identity.mjs';

export class AdminRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'AdminRefusal';
    this.code = 'ERR_OBSERVOGRAM_ADMIN_REFUSED';
  }
}

const refuse = (message) => { throw new AdminRefusal(message); };

// Today's rule for a new local username (existing ones are managed as
// written: an imported `John Smith` or `ops#1` can be given a password or
// disabled).
export const LOCAL_LOGIN_RE = /^[a-zA-Z0-9._@-]{2,64}$/;

// --role: viewer, operator or admin; default operator. 'member' is no
// longer written.
export function parseRole(value) {
  if (value === undefined || value === null) return 'operator';
  if (value === 'member') refuse("roles are viewer, operator or admin ('member' is now 'operator')");
  if (!ROLES.includes(value)) refuse(`roles are viewer, operator or admin, not ${JSON.stringify(value)}`);
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

function oidcTarget(db, login, sub, issuerKey) {
  const row = getUserByLogin(db, login);
  if (row && row.kind !== 'oidc') refuse(`the login ${login} is held by a local user — it never names an OIDC user`);
  return { kind: 'oidc', login, sub, issuerKey, row };
}

// → { login, kind: 'local' | 'oidc', sub?, issuerKey?, row } (row null when
// the user was never seen).
export function resolveLogin(db, arg, { shellIssuerRaw = null } = {}) {
  if (typeof arg !== 'string' || arg === '') refuse('a login is required');
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
    // 2. <issuer>#<sub>
    let key;
    try { key = canonIssuer(arg.slice(0, hash)); } catch { refuse(`${arg} is not <issuer>#<sub>`); }
    const sub = arg.slice(hash + 1);
    if (!textOk(sub, { max: 2000 })) refuse(`${arg} is not <issuer>#<sub>`);
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
  if (target.kind === 'local') refuse(`no local user ${target.login} — npm run users -- add ${target.login} first`);
  return createUser(db, actor, {
    kind: 'oidc', login: target.login, issuer: shellIssuerRaw || target.issuerKey, sub: target.sub,
  });
}

const enabledOwnerCount = (db) => prepare(db, 'SELECT count(*) AS n FROM users WHERE is_owner = 1 AND disabled = 0').get().n;

// ---------- users ----------

// The read-only refusals of `users -- add`, so the CLI can run them before
// it prompts for a password (a refusal never costs a typed password).
export function checkAddLocalUser(db, { login, role, orgId = null }) {
  if (typeof login !== 'string' || !LOCAL_LOGIN_RE.test(login)) refuse('username must be 2–64 chars of [a-zA-Z0-9._@-]');
  const parsedRole = parseRole(role);
  const existing = getUserByLogin(db, login);
  if (existing?.disabled) refuse(`user exists: ${login}, disabled (npm run users -- enable ${login}; passwd sets a new password)`);
  if (existing) refuse(`user exists: ${login} (use passwd)`);
  const live = listOrgs(db);
  if (orgId !== null && orgId !== undefined) {
    if (!liveOrg(db, orgId)) refuse(`no live org ${JSON.stringify(orgId)}`);
  } else if (live.length > 1) {
    refuse(`this deployment has ${live.length} orgs: name one with --org`);
  }
  return { role: parsedRole, orgId: orgId ?? null };
}

// → { user, owner, joined: [{ orgId, role }], armed }. `password` is the
// plain text; it is hashed before the transaction opens. The first local
// user created while no enabled local owner exists becomes the owner and
// admin of the default org, whatever --role says (A-16).
export function addLocalUser(db, actor, { login, name = null, email = null, password, role, orgId = null, via = 'cli' }) {
  checkAddLocalUser(db, { login, role, orgId });
  if (typeof password !== 'string' || password === '') refuse('a password is required');
  const hashed = hashPassword(password);
  return atomic(db, () => {
    const { role: parsedRole } = checkAddLocalUser(db, { login, role, orgId });
    const defaultOrg = ensureDefaultOrg(db, actor);
    const owner = signInOwnerCount(db, { mode: 'local' }) === 0;
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
    return { user, owner, joined, armed };
  });
}

// Local rows only, looked up exactly as given; bumps the epoch (every
// session of the user ends). A disabled row may be given a password.
export function setLocalPassword(db, actor, login, password) {
  if (typeof password !== 'string' || password === '') refuse('a password is required');
  const row = getUserByLogin(db, login);
  if (!row || row.kind !== 'local') refuse(`no local user ${login}`);
  const hashed = hashPassword(password);
  return setPassword(db, actor, row.id, hashed, { mustChange: false, seededDefault: false });
}

// Users are never deleted (the audit references them): disabling bumps the
// epoch and keeps the memberships. The last enabled owner stays.
export function disableUser(db, actor, login) {
  return atomic(db, () => {
    const row = getUserByLogin(db, login);
    if (!row) refuse(`no such user: ${login}`);
    if (row.disabled) return row;
    if (row.isOwner && enabledOwnerCount(db) === 1) {
      refuse(`${login} is the last enabled owner — grant another owner first (npm run users -- owner <login>)`);
    }
    return setDisabled(db, actor, row.id, true);
  });
}

// `users -- enable` undoes `remove`: the row, its memberships, owner flag
// and password come back as they were (the disable already ended its
// sessions). Looked up exactly as given, like `remove`.
export function enableUser(db, actor, login) {
  return atomic(db, () => {
    const row = getUserByLogin(db, login);
    if (!row) refuse(`no such user: ${login}`);
    if (!row.disabled) return row;
    return setDisabled(db, actor, row.id, false);
  });
}

// `users -- owner`: an owner and admin of the default org, whether or not
// an owner exists; an OIDC user never seen is created first.
export function grantOwnerByLogin(db, actor, arg, { shellIssuerRaw = null } = {}) {
  return atomic(db, () => {
    const target = resolveLogin(db, arg, { shellIssuerRaw });
    const user = userFor(db, actor, target, { shellIssuerRaw });
    if (user.disabled) refuse(`${user.login} is disabled — npm run users -- enable ${user.login} first`);
    ensureDefaultOrg(db, actor);
    return grantOwner(db, actor, user.id, { action: 'owner.bootstrap', via: actor === SYSTEM ? 'system' : 'cli' });
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

// `orgs -- create`: needs identity and an enabled owner (A-15); refuses a
// non-empty orgs/<id>/ unless adopted; a slug is never reused. With
// `admin`, that user's admin membership.
export function createOrgFromAdmin(db, actor, { id, name = null, adopt = false, admin = null, base, shellIssuerRaw = null }) {
  if (!validOrgId(id)) refuse(`${JSON.stringify(id)} is not an org id (a slug: lowercase letters, digits, - and _)`);
  if (name !== null && !textOk(name, { max: 200 })) refuse('an org name is 1–200 characters');
  return atomic(db, () => {
    if (!isIdentityArmed(db) && !getMeta(db, 'oidc_issuer')) {
      refuse('creating a second org needs identity: add the first user with npm run users -- add, or configure OIDC');
    }
    if (enabledOwnerCount(db) === 0) refuse('no owner — run npm run users -- owner <login> first');
    if (getOrg(db, id)) refuse(`org ${JSON.stringify(id)} exists or existed — a slug is never reused`);
    const dir = join(base, 'orgs', id);
    const occupied = nonEmptyDir(dir);
    if (occupied && !adopt) refuse(`${dir} exists and is not empty — pass --adopt to take it over`);
    const target = admin ? resolveLogin(db, admin, { shellIssuerRaw }) : null;
    const org = createOrg(db, actor, { id, name: name ?? id });
    if (occupied) writeAudit(db, actor, { action: 'org.adopt', targetKind: 'org', targetId: id, detail: { path: dir } });
    if (target) {
      const user = userFor(db, actor, target, { shellIssuerRaw });
      addMembership(db, actor, { orgId: id, userId: user.id, role: 'admin' });
    }
    return org;
  });
}

// Soft removal: the row and the files stay. The default org stays.
export function removeOrgSoft(db, actor, id) {
  return atomic(db, () => {
    if (!liveOrg(db, id)) refuse(`no live org ${JSON.stringify(id)}`);
    if (getMeta(db, 'default_org') === id) refuse(`${id} is the default org and cannot be removed`);
    return removeOrg(db, actor, id);
  });
}

// `orgs -- add-member`: an existing member with another role → setRole
// (changed: { from, to }); else a membership. A local member must exist; an
// OIDC member never seen is created (epoch 1).
export function addMemberByLogin(db, actor, { orgId, arg, role, shellIssuerRaw = null }) {
  const parsedRole = parseRole(role);
  return atomic(db, () => {
    if (!liveOrg(db, orgId)) refuse(`no live org ${JSON.stringify(orgId)}`);
    const target = resolveLogin(db, arg, { shellIssuerRaw });
    const user = userFor(db, actor, target, { shellIssuerRaw });
    const current = getMembership(db, orgId, user.id);
    if (current) {
      if (current.role === parsedRole) return { membership: current, changed: null, user };
      const membership = setRole(db, actor, orgId, user.id, parsedRole);
      return { membership, changed: { from: current.role, to: parsedRole }, user };
    }
    return { membership: addMembership(db, actor, { orgId, userId: user.id, role: parsedRole }), changed: null, user };
  });
}

// `orgs -- remove-member`: shell access is owner-equivalent, so the org's
// last admin may be removed (A-40).
export function removeMemberByLogin(db, actor, { orgId, arg, shellIssuerRaw = null }) {
  return atomic(db, () => {
    if (!liveOrg(db, orgId)) refuse(`no live org ${JSON.stringify(orgId)}`);
    const target = resolveLogin(db, arg, { shellIssuerRaw });
    if (!target.row) refuse(`${target.login} is not a member of ${orgId}`);
    if (!getMembership(db, orgId, target.row.id)) refuse(`${target.login} is not a member of ${orgId}`);
    return removeMembership(db, actor, orgId, target.row.id);
  });
}

