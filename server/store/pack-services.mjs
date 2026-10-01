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
  return { orgId: r.org_id, packId: r.pack_id, serviceId: r.service_id, role: r.role };
}

export function listServicesForPack(db, packId) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM pack_services WHERE org_id = ? AND pack_id = ? ORDER BY role DESC, service_id')
    .all(org, packId).map(rowToPackService);
}

export function listPacksForService(db, serviceId) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM pack_services WHERE org_id = ? AND service_id = ? ORDER BY pack_id')
    .all(org, serviceId).map(rowToPackService);
}

export function linkPackService(db, actor, { packId, serviceId, role = 'member' }) {
  const org = requireOrg(REPO);
  if (!PACK_SERVICE_ROLES.includes(role)) throw new TypeError(`observogram store: a pack link is primary or member, not ${JSON.stringify(role)}`);
  return atomic(db, () => {
    if (!getPack(db, packId)) throw notFound('pack', packId);
    const service = getService(db, serviceId);
    if (!service) throw notFound('service', serviceId);
    const row = prepare(db, 'INSERT INTO pack_services (org_id, pack_id, service_id, role) VALUES (?, ?, ?, ?) RETURNING *')
      .get(org, packId, service.id, role);
    writeAudit(db, actor, { orgId: org, action: 'pack.link', targetKind: 'pack', targetId: packId, detail: { service: service.slug, role } });
    return rowToPackService(row);
  });
}

export function unlinkPackService(db, actor, packId, serviceId) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const row = prepare(db, 'DELETE FROM pack_services WHERE org_id = ? AND pack_id = ? AND service_id = ? RETURNING *')
      .get(org, packId, serviceId);
    if (!row) throw notFound('pack link', `${packId}/${serviceId}`);
    const service = getService(db, serviceId);
    writeAudit(db, actor, { orgId: org, action: 'pack.unlink', targetKind: 'pack', targetId: packId, detail: { service: service?.slug ?? null } });
    return rowToPackService(row);
  });
}
