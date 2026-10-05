// server/store/packs.mjs — the pack registry's records (context-scoped;
// docs/STORE_PLAN.md §2–§3). The pack file <org root>/packs/<id>.pack.yaml
// stays the artefact; this table is the registry — it replaced
// packs/index.json at slice 4 (server/pack-registry.mjs over it, the
// one-shot import in server/store/pack-import.mjs). last_used_at is
// bookkeeping and goes through touch() / touchMany(), the one audit-free
// write.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { notFound, optionalText, requireIso, requireOrg, requireText } from './rows.mjs';

const REPO = 'packs';
const TEXT_MAX = 200;
// The removal actions a caller may record: the rehydrate's prune, the
// quick-start dedup (replaced by label) and the MAX_UPLOADS eviction.
export const PACK_REMOVE_ACTIONS = Object.freeze(['pack.remove', 'pack.replace', 'pack.evict']);

export function rowToPack(r) {
  if (!r) return null;
  return { orgId: r.org_id, id: r.id, label: r.label, source: r.source, createdAt: r.created_at, lastUsedAt: r.last_used_at };
}

// The clamp the callers (register, import, replace, export-adopt) run on a
// label or a source before the repository sees it: a string is trimmed and
// cut to the text limit, anything else (and an empty string) is null. Pure;
// no SQL. The repository's own limit stays the one rule every text column
// has — clamping here means a long label is kept cut, never refused.
export function clampPackText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, TEXT_MAX);
  return text.trim() === '' ? null : text;
}

export function getPack(db, id) {
  const org = requireOrg(REPO);
  return rowToPack(prepare(db, 'SELECT * FROM packs WHERE org_id = ? AND id = ?').get(org, id));
}

export function listPacks(db) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM packs WHERE org_id = ? ORDER BY created_at, id').all(org).map(rowToPack);
}

// createdAt / lastUsedAt are ISO strings (the import converts index.json's
// ms numbers before it calls); detail extends the pack.register row
// ({ imported: true }, { adopted: true }).
export function addPack(db, actor, { id, label = null, source = null, createdAt = nowIso(), lastUsedAt = createdAt, detail = null }) {
  const org = requireOrg(REPO);
  requireText(id, 'id');
  requireIso(createdAt, 'createdAt');
  requireIso(lastUsedAt, 'lastUsedAt');
  return atomic(db, () => {
    const row = prepare(db, 'INSERT INTO packs (org_id, id, label, source, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(org, id, optionalText(label, 'label'), optionalText(source, 'source'), createdAt, lastUsedAt);
    writeAudit(db, actor, { orgId: org, action: 'pack.register', targetKind: 'pack', targetId: id, detail: { label: row.label, source: row.source, ...(detail ?? {}) } });
    return rowToPack(row);
  });
}

// A register: absent → addPack (pack.register); present with another label
// or source → the fields and last_used_at updated (pack.update { fields,
// ...detail } — the replace adds { via: 'replace' }); present and equal → a
// touch, no audit row.
export function upsertPack(db, actor, { id, label = null, source = null }, { detail = null } = {}) {
  const org = requireOrg(REPO);
  requireText(id, 'id');
  const nextLabel = optionalText(label, 'label');
  const nextSource = optionalText(source, 'source');
  return atomic(db, () => {
    const current = getPack(db, id);
    if (!current) return { pack: addPack(db, actor, { id, label: nextLabel, source: nextSource }), created: true, changed: false };
    const fields = [];
    if (current.label !== nextLabel) fields.push('label');
    if (current.source !== nextSource) fields.push('source');
    const at = nowIso();
    if (fields.length === 0) {
      touch(db, id, at);
      return { pack: { ...current, lastUsedAt: at }, created: false, changed: false };
    }
    prepare(db, 'UPDATE packs SET label = :label, source = :source, last_used_at = :at WHERE org_id = :org_id AND id = :id')
      .run({ label: nextLabel, source: nextSource, at, org_id: org, id });
    writeAudit(db, actor, { orgId: org, action: 'pack.update', targetKind: 'pack', targetId: id, detail: { fields, ...(detail ?? {}) } });
    return { pack: getPack(db, id), created: false, changed: true };
  });
}

// Removes the record and its service links (ON DELETE CASCADE); the caller
// owns the pack file. action names why (PACK_REMOVE_ACTIONS); detail is the
// row's detail ({ reason: 'file gone' }, { label, replacedBy }, { cap }).
export function removePack(db, actor, id, { action = 'pack.remove', detail = null } = {}) {
  const org = requireOrg(REPO);
  if (!PACK_REMOVE_ACTIONS.includes(action)) {
    throw new TypeError(`observogram store: a pack removal is recorded as ${PACK_REMOVE_ACTIONS.join(', ')}, not ${JSON.stringify(action)}`);
  }
  return atomic(db, () => {
    const current = getPack(db, id);
    if (!current) throw notFound('pack', id);
    prepare(db, 'DELETE FROM packs WHERE org_id = ? AND id = ?').run(org, id);
    writeAudit(db, actor, { orgId: org, action, targetKind: 'pack', targetId: id, detail });
    return current;
  });
}

// DELETE /api/uploads: every pack of the org (its links cascade; services
// and environments stay), one pack.clear { dropped } row.
export function clearPacks(db, actor) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const dropped = prepare(db, 'DELETE FROM packs WHERE org_id = ?').run(org).changes;
    writeAudit(db, actor, { orgId: org, action: 'pack.clear', targetKind: 'pack', targetId: null, detail: { dropped } });
    return dropped;
  });
}

// Bookkeeping, not a change anyone acted on: no actor, no audit row.
export function touch(db, id, at = nowIso()) {
  const org = requireOrg(REPO);
  return atomic(db, () => prepare(db, 'UPDATE packs SET last_used_at = ? WHERE org_id = ? AND id = ?').run(at, org, id).changes > 0);
}

// The debounced flush: [[id, at]] entries in one transaction, audit-free;
// returns how many rows changed (an id of another org, or none, changes 0).
export function touchMany(db, entries) {
  const org = requireOrg(REPO);
  if (!Array.isArray(entries)) throw new TypeError('observogram store: touchMany takes an array of [id, at] entries');
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('observogram store: touchMany takes [id, at] entries');
    requireText(entry[0], 'id');
    requireIso(entry[1], 'at');
  }
  return atomic(db, () => {
    const stmt = prepare(db, 'UPDATE packs SET last_used_at = ? WHERE org_id = ? AND id = ?');
    let changed = 0;
    for (const [id, at] of entries) changed += stmt.run(at, org, id).changes;
    return changed;
  });
}
