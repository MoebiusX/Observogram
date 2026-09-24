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

export function setMeta(db, actor, key, value) {
  requireText(key, 'key', { max: 100 });
  if (key === 'store_id') throw new Error('observogram store: store_id is fixed at creation');
  if (value !== null && typeof value !== 'string') throw new TypeError('observogram store: a meta value is a string or null');
  return atomic(db, () => {
    prepare(db, 'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
    writeAudit(db, actor, { action: 'meta.set', targetKind: 'meta', targetId: key });
    return value;
  });
}
