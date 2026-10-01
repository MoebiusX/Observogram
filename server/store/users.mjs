// server/store/users.mjs — users (deployment-level; docs/STORE_PLAN.md §2).
//
// login is the stable name: the username for a local user, and
// <issuerKey>#<sub> for an OIDC one (built by the caller). password keeps
// today's users.json record verbatim ({ algo: 'scrypt', N, r, p, salt,
// hash }) as JSON. Booleans are stored 0/1 and read back as booleans.
//
// session_epoch starts at 1 (0 for a row the legacy import or the first
// sight of a pre-upgrade cookie creates: such cookies read as epoch 0).
// Disabling a user,
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

// The row insert every creator shares, with the repository's rules and no
// audit row: internal to server/store/ (the import, the identity
// operations), and only inside the one tx() whose own audit row covers it
// — it throws anywhere else. A local login is at most 200 characters; an
// OIDC login is <issuerKey>#<sub>, each part capped at 2000, so 4100.
// session_epoch defaults to 1 (a fresh row); the import and the first
// sight of a pre-upgrade cookie create rows at 0.
export function insertUserRow(db, {
  kind = 'local', login, issuer = null, sub = null, email = null, emailVerified = false, name = null,
  password = null, mustChange = false, seededDefault = false, isOwner = false,
  sessionEpoch = 1, disabled = false, createdAt,
}) {
  if (!db.isTransaction) throw new Error('observogram store: insertUserRow() runs inside the tx() whose audit row covers it');
  if (kind !== 'local' && kind !== 'oidc') throw new TypeError(`observogram store: user kind is local or oidc, not ${JSON.stringify(kind)}`);
  requireText(login, 'login', { max: kind === 'oidc' ? 4100 : 200 });
  if (password !== null && (typeof password !== 'object' || Array.isArray(password))) {
    throw new TypeError('observogram store: password is the hashed record object, or null');
  }
  if (!Number.isSafeInteger(sessionEpoch) || sessionEpoch < 0) {
    throw new TypeError('observogram store: sessionEpoch is a non-negative integer');
  }
  if (createdAt !== undefined && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)))) {
    throw new TypeError('observogram store: createdAt is an ISO timestamp');
  }
  const row = prepare(db, `INSERT INTO users (kind, login, issuer, sub, email, email_verified, name, password,
      must_change, seeded_default, is_owner, disabled, session_epoch, created_at)
    VALUES (:kind, :login, :issuer, :sub, :email, :email_verified, :name, :password,
      :must_change, :seeded_default, :is_owner, :disabled, :session_epoch, :created_at) RETURNING *`).get({
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
    disabled: bit(disabled),
    session_epoch: sessionEpoch,
    created_at: createdAt ?? nowIso(),
  });
  return rowToUser(row);
}

export function createUser(db, actor, fields) {
  return atomic(db, () => {
    const user = insertUserRow(db, { ...fields, createdAt: undefined });
    writeAudit(db, actor, {
      action: 'user.create', targetKind: 'user', targetId: user.login,
      detail: { kind: user.kind, isOwner: user.isOwner, sessionEpoch: user.sessionEpoch, disabled: user.disabled },
    });
    return user;
  });
}

// Audit-free bookkeeping, like packs.touch(): the time of the last
// successful sign-in.
export function touchLogin(db, id, at = nowIso()) {
  return atomic(db, () => {
    prepare(db, 'UPDATE users SET last_login_at = ? WHERE id = ?').run(at, id);
  });
}

// Internal (tx required, no audit): the owner flag, for the operations in
// server/store/identity.mjs that write one audit row of their own.
export function setOwnerRow(db, id, isOwner) {
  if (!db.isTransaction) throw new Error('observogram store: setOwnerRow() runs inside the tx() whose audit row covers it');
  prepare(db, 'UPDATE users SET is_owner = ? WHERE id = ?').run(bit(isOwner), id);
  return getUser(db, id);
}

// Internal (tx required, no audit): the replace's update of a row it
// re-imports (server/store/import.mjs applyReplace, whose one store.replace
// row covers it). `fields` holds only what changes — password, mustChange,
// seededDefault, name, email, disabled; `bump` ends the user's sessions.
export function updateUserRow(db, id, fields, { bump = false } = {}) {
  if (!db.isTransaction) throw new Error('observogram store: updateUserRow() runs inside the tx() whose audit row covers it');
  if (fields.password !== undefined && fields.password !== null
    && (typeof fields.password !== 'object' || Array.isArray(fields.password))) {
    throw new TypeError('observogram store: password is the hashed record object, or null');
  }
  const values = {
    password: fields.password === undefined ? undefined : fields.password === null ? null : toJson(fields.password),
    mustChange: fields.mustChange === undefined ? undefined : bit(fields.mustChange),
    seededDefault: fields.seededDefault === undefined ? undefined : bit(fields.seededDefault),
    name: fields.name === undefined ? undefined : optionalText(fields.name, 'name'),
    email: fields.email === undefined ? undefined : optionalText(fields.email, 'email', { max: 320 }),
    disabled: fields.disabled === undefined ? undefined : bit(fields.disabled),
  };
  const { sql, params } = setClause(values, {
    password: 'password', mustChange: 'must_change', seededDefault: 'seeded_default', name: 'name', email: 'email', disabled: 'disabled',
  });
  const sets = [sql, bump ? 'session_epoch = session_epoch + 1' : ''].filter(Boolean).join(', ');
  if (sets) prepare(db, `UPDATE users SET ${sets} WHERE id = :id`).run({ ...params, id });
  return getUser(db, id);
}

// Internal (tx required, no audit): `packc store rekey-issuer --to`
// (server/store/ops.mjs, whose one issuer.rekey row covers it). Every
// kind 'oidc' login that starts with `fromPrefix` ('<old key>#') is spelled
// with `toPrefix` instead; the sub after it is kept. Refused, before any
// write, when a rewritten login is already taken. → the number of rows.
export function rewriteLoginPrefix(db, fromPrefix, toPrefix) {
  if (!db.isTransaction) throw new Error('observogram store: rewriteLoginPrefix() runs inside the tx() whose audit row covers it');
  requireText(fromPrefix, 'fromPrefix', { max: 2001 });
  requireText(toPrefix, 'toPrefix', { max: 2001 });
  const n = fromPrefix.length;
  const params = { from: fromPrefix, to: toPrefix, n: n + 1 };
  const taken = prepare(db, `SELECT u.login AS login, t.login AS target FROM users u JOIN users t
      ON t.login = :to || substr(u.login, :n)
    WHERE u.kind = 'oidc' AND substr(u.login, 1, :n - 1) = :from ORDER BY u.id`).all(params);
  if (taken.length) {
    const err = new Error(`observogram store: rewriting ${fromPrefix} to ${toPrefix} would reuse a login that exists: `
      + taken.map((r) => `${r.login} → ${r.target}`).join(', '));
    err.code = 'ERR_OBSERVOGRAM_LOGIN_TAKEN';
    err.taken = taken.map((r) => r.target);
    throw err;
  }
  return prepare(db, `UPDATE users SET login = :to || substr(login, :n)
    WHERE kind = 'oidc' AND substr(login, 1, :n - 1) = :from`).run(params).changes;
}

// Internal (tx required, no audit): `packc store rekey-issuer --clear`.
// Every enabled kind 'oidc' row is disabled with its epoch bumped, so its
// cookies stop working. → the logins it disabled, by id.
export function disableOidcRows(db) {
  if (!db.isTransaction) throw new Error('observogram store: disableOidcRows() runs inside the tx() whose audit row covers it');
  return prepare(db, `UPDATE users SET disabled = 1, session_epoch = session_epoch + 1
    WHERE kind = 'oidc' AND disabled = 0 RETURNING id, login`).all()
    .sort((a, b) => a.id - b.id).map((r) => r.login);
}

// For `npm run users -- list`: every user by id, with its memberships in
// live orgs ([{ orgId, role }], first membership first).
export function listUsersWithMemberships(db) {
  const byUser = new Map();
  for (const m of prepare(db, `SELECT m.user_id, m.org_id, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id
      WHERE o.removed_at IS NULL ORDER BY m.created_at, m.rowid`).all()) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id).push({ orgId: m.org_id, role: m.role });
  }
  return listUsers(db).map((u) => ({ ...u, memberships: byUser.get(u.id) || [] }));
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
