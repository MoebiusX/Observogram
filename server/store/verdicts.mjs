// server/store/verdicts.mjs — a reviewer's verdicts on the artefacts of a
// registered pack (context-scoped; docs/STORE_PLAN.md §2 "Schema v2", GAP
// batch 2 B3.1). One row per (pack, artefact): the pack by its content-hash
// id, the artefact by the adapter's positional id (`SLI-01`) — frozen
// within that pack id — with the artefact's behavioural identity key and
// behaviour hash beside it, which is how a label re-registration carries
// a verdict onto the new pack's artefact (carryVerdicts). `unreviewed` is
// the absence of a row. The row cascades with its pack (ON DELETE CASCADE
// on the composite key): an eviction, a replace or the rehydrate's prune
// drops it silently; a replace carries first (server/verdict-admin.mjs).
//
// Diagnose's "verdict" (studio/verdict-ui.mjs) is the engine's grade;
// this is a reviewer's record. Nothing here sums into a score: the rules
// that read these rows are server/verdict-admin.mjs's, and this module
// holds the SQL.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getPack } from './packs.mjs';
import { notFound, optionalText, requireOrg, requireText } from './rows.mjs';

const REPO = 'verdicts';
export const VERDICT_STATUSES = Object.freeze(['trusted', 'suspect', 'failed']);
export const REASON_MAX = 2000;
const KEY_MAX = 4000;        // an identity key is a serialised identity object
const DETAIL_TEXT_MAX = 200; // a reason as the audit row quotes it
const DROPPED_LISTED = 50;   // how many dropped keys a verdict.carry row names
const DROPPED_KEY_MAX = 80;  // each cut, so 50 of them stay well inside the audit detail bound (8192)

export function rowToVerdict(r) {
  if (!r) return null;
  return {
    orgId: r.org_id, packId: r.pack_id, artefactId: r.artefact_id, artefactKey: r.artefact_key, family: r.family,
    status: r.status, reason: r.reason, behaviorHash: r.behavior_hash, actor: r.actor, setAt: r.set_at, carriedFrom: r.carried_from,
  };
}

function requireStatus(status) {
  if (!VERDICT_STATUSES.includes(status)) {
    throw new TypeError(`observogram store: a verdict status is one of ${VERDICT_STATUSES.join(', ')}, not ${JSON.stringify(status)}`);
  }
  return status;
}

const cut = (text) => (typeof text === 'string' ? text.slice(0, DETAIL_TEXT_MAX) : null);

export function listVerdicts(db, packId) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM verdicts WHERE org_id = ? AND pack_id = ? ORDER BY artefact_id').all(org, packId).map(rowToVerdict);
}

export function getVerdict(db, packId, artefactId) {
  const org = requireOrg(REPO);
  return rowToVerdict(prepare(db, 'SELECT * FROM verdicts WHERE org_id = ? AND pack_id = ? AND artefact_id = ?').get(org, packId, artefactId));
}

// Records or replaces the verdict on one artefact: INSERT … ON CONFLICT DO
// UPDATE, the carry mark cleared (a reviewer's own record now). Audit
// verdict.set on target artefact `<pack>/<artefact>` with the transition
// (`from` null for a first record). → { verdict, previous }.
export function setVerdict(db, actor, { packId, artefactId, artefactKey, family = null, status, reason = null, behaviorHash }) {
  const org = requireOrg(REPO);
  requireText(packId, 'packId');
  requireText(artefactId, 'artefactId', { max: 100 });
  requireText(artefactKey, 'artefactKey', { max: KEY_MAX });
  requireStatus(status);
  const nextReason = optionalText(reason, 'reason', { max: REASON_MAX });
  requireText(behaviorHash, 'behaviorHash', { max: 64 });
  const nextFamily = optionalText(family, 'family');
  return atomic(db, () => {
    if (!getPack(db, packId)) throw notFound('pack', packId);
    const previous = getVerdict(db, packId, artefactId);
    const row = prepare(db, `INSERT INTO verdicts (org_id, pack_id, artefact_id, artefact_key, family, status, reason, behavior_hash, actor, set_at, carried_from)
      VALUES (:org_id, :pack_id, :artefact_id, :artefact_key, :family, :status, :reason, :behavior_hash, :actor, :set_at, NULL)
      ON CONFLICT (org_id, pack_id, artefact_id) DO UPDATE SET
        artefact_key = excluded.artefact_key, family = excluded.family, status = excluded.status, reason = excluded.reason,
        behavior_hash = excluded.behavior_hash, actor = excluded.actor, set_at = excluded.set_at, carried_from = NULL
      RETURNING *`).get({
      org_id: org, pack_id: packId, artefact_id: artefactId, artefact_key: artefactKey, family: nextFamily, status,
      reason: nextReason, behavior_hash: behaviorHash, actor, set_at: nowIso(),
    });
    writeAudit(db, actor, {
      orgId: org, action: 'verdict.set', targetKind: 'artefact', targetId: `${packId}/${artefactId}`,
      detail: { pack: packId, artefact: artefactId, family: nextFamily, from: previous?.status ?? null, to: status, reason: cut(nextReason) },
    });
    return { verdict: rowToVerdict(row), previous };
  });
}

// Removes the verdict (the artefact is unreviewed again). Audit
// verdict.clear { pack, artefact, from }. Returns the row that was.
export function clearVerdict(db, actor, packId, artefactId) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const previous = getVerdict(db, packId, artefactId);
    if (!previous) throw notFound('verdict', `${packId}/${artefactId}`);
    prepare(db, 'DELETE FROM verdicts WHERE org_id = ? AND pack_id = ? AND artefact_id = ?').run(org, packId, artefactId);
    writeAudit(db, actor, {
      orgId: org, action: 'verdict.clear', targetKind: 'artefact', targetId: `${packId}/${artefactId}`,
      detail: { pack: packId, artefact: artefactId, from: previous.status },
    });
    return previous;
  });
}

// A label re-registration: every verdict of the replaced pack whose
// behavioural identity key the new pack's artefact index (`map`: key →
// { artefactId, family, behaviorHash }) still holds is written onto the new
// pack's artefact (ON CONFLICT DO NOTHING — a verdict already on the new
// pack wins), `carried_from` naming the old pack; the rest are dropped. One
// verdict.carry row on the new pack — { from, kept, dropped (the first 50
// keys), droppedCount } — only when there was anything to carry. The
// caller (server/verdict-admin.mjs) builds `map` before the old pack's row
// is removed and calls this after the new pack's row exists, inside the
// register's atomic(). → { kept, dropped }.
export function carryVerdicts(db, actor, { fromPackId, toPackId, rows, map }) {
  const org = requireOrg(REPO);
  requireText(fromPackId, 'fromPackId');
  requireText(toPackId, 'toPackId');
  if (!Array.isArray(rows)) throw new TypeError('observogram store: carryVerdicts takes the replaced pack\'s rows as an array');
  if (!(map instanceof Map)) throw new TypeError('observogram store: carryVerdicts takes the new pack\'s artefact index as a Map');
  return atomic(db, () => {
    if (rows.length === 0) return { kept: 0, dropped: [] };
    if (!getPack(db, toPackId)) throw notFound('pack', toPackId);
    const insert = prepare(db, `INSERT INTO verdicts (org_id, pack_id, artefact_id, artefact_key, family, status, reason, behavior_hash, actor, set_at, carried_from)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, pack_id, artefact_id) DO NOTHING`);
    let kept = 0;
    const dropped = [];
    for (const v of rows) {
      const hit = map.get(v.artefactKey);
      if (!hit) { dropped.push(v.artefactKey); continue; }
      const r = insert.run(org, toPackId, hit.artefactId, v.artefactKey, hit.family ?? v.family, v.status, v.reason, hit.behaviorHash, v.actor, v.setAt, fromPackId);
      if (r.changes > 0) kept++; else dropped.push(v.artefactKey);
    }
    writeAudit(db, actor, {
      orgId: org, action: 'verdict.carry', targetKind: 'pack', targetId: toPackId,
      detail: { from: fromPackId, kept, dropped: dropped.slice(0, DROPPED_LISTED).map((k) => k.slice(0, DROPPED_KEY_MAX)), droppedCount: dropped.length },
    });
    return { kept, dropped };
  });
}
