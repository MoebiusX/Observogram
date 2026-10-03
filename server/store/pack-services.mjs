// server/store/pack-services.mjs — which services a pack covers
// (context-scoped; docs/STORE_PLAN.md §2). A pack is not always one
// service: the live aggregate packs carry many. At most one link per pack
// is 'primary'. The schema's composite foreign keys keep the pack and the
// service in the same org as the link.

import { atomic, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getPack } from './packs.mjs';
import { getService } from './services.mjs';
import { notFound, requireOrg } from './rows.mjs';

const REPO = 'pack_services';
export const PACK_SERVICE_ROLES = Object.freeze(['primary', 'member']);

export function rowToPackService(r) {
  if (!r) return null;
  const out = { orgId: r.org_id, packId: r.pack_id, serviceId: r.service_id, role: r.role };
  if ('slug' in r) out.slug = r.slug;
  if ('label' in r) out.label = r.label;
  if ('source' in r) out.source = r.source;
  return out;
}

// The links of one pack with the service's slug: the reconcile that turns
// a pack's plan into links compares slugs and roles.
export function listServicesForPack(db, packId) {
  const org = requireOrg(REPO);
  return prepare(db, `SELECT ps.*, s.slug FROM pack_services ps JOIN services s ON s.id = ps.service_id AND s.org_id = ps.org_id
    WHERE ps.org_id = ? AND ps.pack_id = ? ORDER BY ps.role DESC, ps.service_id`)
    .all(org, packId).map(rowToPackService);
}

export function listPacksForService(db, serviceId) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM pack_services WHERE org_id = ? AND service_id = ? ORDER BY pack_id')
    .all(org, serviceId).map(rowToPackService);
}

// Every link of the org with its pack's label and source, in one query.
export function listLinksForOrg(db) {
  const org = requireOrg(REPO);
  return prepare(db, `SELECT ps.*, p.label, p.source FROM pack_services ps JOIN packs p ON p.org_id = ps.org_id AND p.id = ps.pack_id
    WHERE ps.org_id = ? ORDER BY ps.service_id, ps.role DESC, ps.pack_id`).all(org).map(rowToPackService);
}

// With ifAbsent, a pair already linked (in any role) is left as it is:
// null, no audit row.
export function linkPackService(db, actor, { packId, serviceId, role = 'member' }, { ifAbsent = false } = {}) {
  const org = requireOrg(REPO);
  if (!PACK_SERVICE_ROLES.includes(role)) throw new TypeError(`observogram store: a pack link is primary or member, not ${JSON.stringify(role)}`);
  return atomic(db, () => {
    if (!getPack(db, packId)) throw notFound('pack', packId);
    const service = getService(db, serviceId);
    if (!service) throw notFound('service', serviceId);
    if (ifAbsent && prepare(db, 'SELECT 1 FROM pack_services WHERE org_id = ? AND pack_id = ? AND service_id = ?').get(org, packId, service.id)) return null;
    const row = prepare(db, 'INSERT INTO pack_services (org_id, pack_id, service_id, role) VALUES (?, ?, ?, ?) RETURNING *')
      .get(org, packId, service.id, role);
    writeAudit(db, actor, { orgId: org, action: 'pack.link', targetKind: 'pack', targetId: packId, detail: { service: service.slug, role } });
    return rowToPackService(row);
  });
}

// detail is the pack.unlink row's detail ({ service, reason }); without one
// the row names the service.
export function unlinkPackService(db, actor, packId, serviceId, { detail = null } = {}) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const row = prepare(db, 'DELETE FROM pack_services WHERE org_id = ? AND pack_id = ? AND service_id = ? RETURNING *')
      .get(org, packId, serviceId);
    if (!row) throw notFound('pack link', `${packId}/${serviceId}`);
    const service = getService(db, serviceId);
    writeAudit(db, actor, { orgId: org, action: 'pack.unlink', targetKind: 'pack', targetId: packId, detail: detail ?? { service: service?.slug ?? null } });
    return rowToPackService(row);
  });
}
