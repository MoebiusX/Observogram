// server/store/packs.mjs — the pack registry's records (context-scoped;
// docs/STORE_PLAN.md §2–§3). The pack file <org root>/packs/<id>.pack.yaml
// stays the artefact; this table replaces only packs/index.json (slice 4
// wires it in). last_used_at is bookkeeping and goes through touch(), the
// one audit-free write.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { notFound, optionalText, requireOrg, requireText } from './rows.mjs';

const REPO = 'packs';

export function rowToPack(r) {
  if (!r) return null;
  return { orgId: r.org_id, id: r.id, label: r.label, source: r.source, createdAt: r.created_at, lastUsedAt: r.last_used_at };
}

export function getPack(db, id) {
  const org = requireOrg(REPO);
  return rowToPack(prepare(db, 'SELECT * FROM packs WHERE org_id = ? AND id = ?').get(org, id));
}

export function listPacks(db) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM packs WHERE org_id = ? ORDER BY created_at, id').all(org).map(rowToPack);
}

export function addPack(db, actor, { id, label = null, source = null }) {
  const org = requireOrg(REPO);
  requireText(id, 'id');
  return atomic(db, () => {
    const at = nowIso();
    const row = prepare(db, 'INSERT INTO packs (org_id, id, label, source, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(org, id, optionalText(label, 'label'), optionalText(source, 'source'), at, at);
    writeAudit(db, actor, { orgId: org, action: 'pack.register', targetKind: 'pack', targetId: id, detail: { label: row.label, source: row.source } });
    return rowToPack(row);
  });
}

// Removes the record and its service links (ON DELETE CASCADE); the caller
// owns the pack file.
export function removePack(db, actor, id) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const current = getPack(db, id);
    if (!current) throw notFound('pack', id);
    prepare(db, 'DELETE FROM packs WHERE org_id = ? AND id = ?').run(org, id);
    writeAudit(db, actor, { orgId: org, action: 'pack.remove', targetKind: 'pack', targetId: id });
    return current;
  });
}

// Bookkeeping, not a change anyone acted on: no actor, no audit row.
export function touch(db, id, at = nowIso()) {
  const org = requireOrg(REPO);
  return atomic(db, () => prepare(db, 'UPDATE packs SET last_used_at = ? WHERE org_id = ? AND id = ?').run(at, org, id).changes > 0);
}
