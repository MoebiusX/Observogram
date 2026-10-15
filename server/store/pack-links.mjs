// server/store/pack-links.mjs — the one rule that turns a pack into service
// rows, environment rows and pack_services links (STORE_PLAN slice 4 §4
// item 5, the backfill; "register-time linking calls the same helper").
//
// linkPack() is a RECONCILE of the pack's links to its plan, so it is
// idempotent and total: the same plan twice writes nothing; a plan whose
// primary moved (a pack re-registered under another label with no service
// binding, where the primary falls back to the label; or a label that makes
// it a live aggregate) unlinks the old link first — the one-primary slot is
// free before the new primary's INSERT — then links the plan's. Service
// and environment ROWS are created when absent and never deleted here: a
// service without a pack exists (plan §0), and a pack's removal keeps the
// services it named. Tiers and owners stay unset at creation (null / []):
// nothing is invented — the row's name and slug come from the pack, its
// tier from a person.
//
// No SQL of its own: every write goes through services.mjs,
// environments.mjs and pack-services.mjs (new SQL lives in repositories
// only). The plan comes from tools/lib/service-keys.mjs — the same
// functions the studio draws its tiles with — over the catalogue entry
// GET /api/packs serves for the pack (catalogEntryOf), so the rows and the
// tiles can never name different services.

import { listEnvironments } from '../../tools/lib/adapter.mjs';
import { servicesForPack } from '../../tools/lib/service-keys.mjs';
import { atomic } from './db.mjs';
import { createService, getServiceBySlug } from './services.mjs';
import { createEnvironment, getEnvironmentByName } from './environments.mjs';
import { linkPackService, listServicesForPack, unlinkPackService } from './pack-services.mjs';
import { textOk } from './rows.mjs';

// Who called: the register path, boot step 5, the rehydrate's adoption of
// an orphan file, the replace, the export's adopt. The create rows carry
// it ({ via, pack }); a register's or a replace's unlink is 'relabelled',
// any other 'replan'.
export const LINK_VIAS = Object.freeze(['register', 'import', 'adopt', 'replace', 'export']);
const TEXT_MAX = 200;

// Reads only. The services the pack names (primary unless it is a live
// aggregate, then members) with their slugs and roles, and the environment
// names its canonical declares (an unusable name — empty, or over the
// text limit — is left out, never cut: a cut name would name an
// environment nobody spelt).
export function planPackServices(entry, canonical) {
  return {
    services: servicesForPack(entry),
    environments: listEnvironments(canonical).filter((name) => textOk(name, { max: TEXT_MAX })),
  };
}

export function linkPack(db, actor, { packId, entry, canonical, via }) {
  if (!LINK_VIAS.includes(via)) throw new TypeError(`observogram store: a pack is linked via one of ${LINK_VIAS.join(', ')}, not ${JSON.stringify(via)}`);
  const plan = planPackServices(entry, canonical);
  const reason = via === 'register' || via === 'replace' ? 'relabelled' : 'replan';
  return atomic(db, () => {
    const result = { services: [], environments: [], links: [], unlinked: [] };
    // 1. the links the plan no longer names, or names in another role, go
    //    first — so the one-primary slot is free.
    for (const link of listServicesForPack(db, packId)) {
      if (plan.services.some((s) => s.key === link.slug && s.role === link.role)) continue;
      unlinkPackService(db, actor, packId, link.serviceId, { detail: { service: link.slug, reason } });
      result.unlinked.push(link.slug);
    }
    // 2. the plan's services and environments, created when absent; the
    //    links, added when absent.
    for (const { name, key, role } of plan.services) {
      let service = getServiceBySlug(db, key);
      if (!service) {
        // The name is display text: cut to the text limit, never refused (the key is bounded by the plan).
        service = createService(db, actor, { slug: key, name: String(name).trim().slice(0, TEXT_MAX) || key }, { detail: { via, pack: packId } });
        result.services.push(key);
      }
      for (const env of plan.environments) {
        if (getEnvironmentByName(db, service.id, env)) continue;
        createEnvironment(db, actor, { serviceId: service.id, name: env }, { detail: { via, pack: packId } });
        result.environments.push(`${key}/${env}`);
      }
      if (linkPackService(db, actor, { packId, serviceId: service.id, role }, { ifAbsent: true })) result.links.push(key);
    }
    return result;
  });
}
