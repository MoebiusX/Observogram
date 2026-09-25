// server/store/meta.mjs — schema_meta: deployment-level key/value
// (store_id, default_org, identity_armed, oidc_join_role, import_done, …;
// docs/STORE_PLAN.md §2). Values are strings or null; a caller that stores
// structure stringifies it. store_id is written once, by migration 1.

import { atomic, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { requireText } from './rows.mjs';

export function getMeta(db, key) {
  const row = prepare(db, 'SELECT value FROM schema_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function storeId(db) {
  return getMeta(db, 'store_id');
}

function checkWrite(key, value) {
  requireText(key, 'key', { max: 100 });
  if (key === 'store_id') throw new Error('observogram store: store_id is fixed at creation');
  if (value !== null && typeof value !== 'string') throw new TypeError('observogram store: a meta value is a string or null');
}

function upsert(db, key, value) {
  prepare(db, 'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function setMeta(db, actor, key, value) {
  checkWrite(key, value);
  return atomic(db, () => {
    upsert(db, key, value);
    writeAudit(db, actor, { action: 'meta.set', targetKind: 'meta', targetId: key });
    return value;
  });
}

// Internal to server/store/ (the import, the step-2 bookkeeping): no audit
// row, so only inside the one tx() whose own audit row covers it — or
// bookkeeping that is audit-free by rule. null deletes the key.
export function putMeta(db, key, value) {
  if (!db.isTransaction) throw new Error('observogram store: putMeta() runs inside the tx() whose audit row covers it');
  checkWrite(key, value);
  if (value === null) prepare(db, 'DELETE FROM schema_meta WHERE key = ?').run(key);
  else upsert(db, key, value);
  return value;
}

// A key that holds JSON (legacy_hashes, import_report). A value that does
// not parse throws naming the key: it was written by this code, so a bad
// one is damage, not an absent value.
export function getMetaJson(db, key, fallback = null) {
  const value = getMeta(db, key);
  if (value === null) return fallback;
  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`observogram store: schema_meta ${key} is not valid JSON (${e.message})`, { cause: e });
  }
}

// Stand-alone sign-in is armed by a flag, not a row count: once set
// (the import of a users file, the seed, the first local user) nothing
// clears it, so removing users never reopens a server.
export function isIdentityArmed(db) {
  return getMeta(db, 'identity_armed') === '1';
}
