// server/store/users.mjs — users (deployment-level; docs/STORE_PLAN.md §2).
//
// login is the stable name: the username for a local user, and
// <issuerKey>#<sub> for an OIDC one (built by the caller). password keeps
// today's users.json record verbatim ({ algo: 'scrypt', N, r, p, salt,
// hash }) as JSON. Booleans are stored 0/1 and read back as booleans.
//
// session_epoch starts at the column default (1). Disabling a user,
// changing a password and "sign out everywhere" bump it, which is what
// revokes the user's cookies once sessions carry it (slice 2). Users are
// never deleted: the audit references them, and a disabled row is what
// revokes.

import { atomic, bit, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { fromJson, notFound, optionalText, requireText, setClause, toJson } from './rows.mjs';

export function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id, kind: r.kind, login: r.login, issuer: r.issuer, sub: r.sub,
    email: r.email, emailVerified: r.email_verified === 1, name: r.name,
    password: fromJson(r.password), mustChange: r.must_change === 1,
    seededDefault: r.seeded_default === 1, isOwner: r.is_owner === 1,
    disabled: r.disabled === 1, sessionEpoch: r.session_epoch,
    createdAt: r.created_at, lastLoginAt: r.last_login_at,
  };
}

export function getUser(db, id) {
  return rowToUser(prepare(db, 'SELECT * FROM users WHERE id = ?').get(id));
}

export function getUserByLogin(db, login) {
  return rowToUser(prepare(db, 'SELECT * FROM users WHERE login = ?').get(login));
}

export function listUsers(db) {
  return prepare(db, 'SELECT * FROM users ORDER BY id').all().map(rowToUser);
}

function mustGet(db, id) {
  const user = getUser(db, id);
  if (!user) throw notFound('user', id);
  return user;
}

export function createUser(db, actor, {
  kind = 'local', login, issuer = null, sub = null, email = null, emailVerified = false, name = null,
  password = null, mustChange = false, seededDefault = false, isOwner = false,
}) {
  if (kind !== 'local' && kind !== 'oidc') throw new TypeError(`observogram store: user kind is local or oidc, not ${JSON.stringify(kind)}`);
  requireText(login, 'login');
  if (password !== null && (typeof password !== 'object' || Array.isArray(password))) {
    throw new TypeError('observogram store: password is the hashed record object, or null');
  }
  return atomic(db, () => {
    const row = prepare(db, `INSERT INTO users (kind, login, issuer, sub, email, email_verified, name, password,
        must_change, seeded_default, is_owner, created_at)
      VALUES (:kind, :login, :issuer, :sub, :email, :email_verified, :name, :password,
        :must_change, :seeded_default, :is_owner, :created_at) RETURNING *`).get({
      kind, login,
      issuer: optionalText(issuer, 'issuer', { max: 2000 }),
      sub: optionalText(sub, 'sub', { max: 2000 }),
      email: optionalText(email, 'email', { max: 320 }),
      email_verified: bit(emailVerified),
      name: optionalText(name, 'name'),
      password: password === null ? null : toJson(password),
      must_change: bit(mustChange),
      seeded_default: bit(seededDefault),
      is_owner: bit(isOwner),
      created_at: nowIso(),
    });
    writeAudit(db, actor, { action: 'user.create', targetKind: 'user', targetId: login, detail: { kind, isOwner: !!isOwner } });
    return rowToUser(row);
  });
}

// name, email, emailVerified. Not a revocation, so the epoch stays.
export function updateUserProfile(db, actor, id, patch) {
  const values = {
    name: patch.name === undefined ? undefined : optionalText(patch.name, 'name'),
    email: patch.email === undefined ? undefined : optionalText(patch.email, 'email', { max: 320 }),
    emailVerified: patch.emailVerified === undefined ? undefined : bit(patch.emailVerified),
  };
  const { sql, params } = setClause(values, { name: 'name', email: 'email', emailVerified: 'email_verified' });
  return atomic(db, () => {
    const user = mustGet(db, id);
    if (!sql) return user;
    prepare(db, `UPDATE users SET ${sql} WHERE id = :id`).run({ ...params, id });
    writeAudit(db, actor, { action: 'user.update', targetKind: 'user', targetId: user.login, detail: { fields: Object.keys(params) } });
    return getUser(db, id);
  });
}

export function setPassword(db, actor, id, password, { mustChange = false, seededDefault = false } = {}) {
  if (!password || typeof password !== 'object' || Array.isArray(password)) {
    throw new TypeError('observogram store: password is the hashed record object');
  }
  return atomic(db, () => {
    const user = mustGet(db, id);
    prepare(db, `UPDATE users SET password = ?, must_change = ?, seeded_default = ?, session_epoch = session_epoch + 1
      WHERE id = ?`).run(toJson(password), bit(mustChange), bit(seededDefault), id);
    writeAudit(db, actor, { action: 'user.password', targetKind: 'user', targetId: user.login });
    return getUser(db, id);
  });
}

// Disabling bumps the epoch, so the user's live cookies stop working.
export function setDisabled(db, actor, id, disabled) {
  return atomic(db, () => {
    const user = mustGet(db, id);
    if (user.disabled === !!disabled) return user;
    prepare(db, `UPDATE users SET disabled = ?, session_epoch = session_epoch + ? WHERE id = ?`).run(bit(disabled), disabled ? 1 : 0, id);
    writeAudit(db, actor, { action: disabled ? 'user.disable' : 'user.enable', targetKind: 'user', targetId: user.login });
    return getUser(db, id);
  });
}

export function setOwner(db, actor, id, isOwner) {
  return atomic(db, () => {
    const user = mustGet(db, id);
    if (user.isOwner === !!isOwner) return user;
    prepare(db, 'UPDATE users SET is_owner = ? WHERE id = ?').run(bit(isOwner), id);
    writeAudit(db, actor, { action: isOwner ? 'user.owner.grant' : 'user.owner.revoke', targetKind: 'user', targetId: user.login });
    return getUser(db, id);
  });
}

// "Sign out everywhere".
export function bumpSessionEpoch(db, actor, id) {
  return atomic(db, () => {
    const user = mustGet(db, id);
    const { session_epoch: epoch } = prepare(db, 'UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ? RETURNING session_epoch').get(id);
    writeAudit(db, actor, { action: 'user.signout', targetKind: 'user', targetId: user.login, detail: { sessionEpoch: epoch } });
    return epoch;
  });
}
