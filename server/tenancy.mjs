// server/tenancy.mjs — Stage 2 of docs/PRODUCTIZATION_PLAN.md: tenancy
// (workspace-per-org), always on since the store (docs/STORE_PLAN.md
// slice 2).
//
// The whole design is one move: workspaceRoot() is context-aware. Every
// /api request runs in an org (server/index.mjs's org middleware), and
// every org has a root fixed at its creation in the store (orgs.root):
//
//   <OBSERVOGRAM_WORKSPACE>/                      the default org's root ('.')
//     observogram.db, session-secret              deployment-level (shared)
//     packs|deploys.jsonl|snapshots|journeys|runs the default org at '.'
//     orgs/<orgId>/packs|deploys.jsonl|…          any other org ('orgs/<id>')
//
// — and the file-first machinery underneath (registry, deploys,
// snapshots, journeys, runs) is unchanged: it already resolves its root
// per call, so it only needed a context-aware answer. The request's org
// rides AsyncLocalStorage (server/org-context.mjs), so nothing threads an
// orgId parameter through twenty call sites. Outside an org context
// orgWorkspaceRoot() throws: the point of the rule.
//
// Membership lives in the store (server/store/memberships.mjs); roles are
// RECORDED but not yet ENFORCED — that is Stage 3's per-route check.
//
// MIGRATION — a pre-store deployment whose orgs.json armed tenancy while
// its flat workspace stayed at the base gets that state moved to
// orgs/default/ once, by the legacy import (server/boot.mjs step 3), which
// then records the default org's root there. Idempotent and per entry:
// an entry moves only when it holds data; an entry that already exists
// under orgs/default/ is left behind.

import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { baseWorkspacePath } from '../tools/lib/brand-env.mjs';
import { currentOrg, runWithOrg, validOrgId } from './org-context.mjs';
import {
  MIGRATABLE, hasData, lexists, orgsFilePath as legacyOrgsFilePath, readOrgsFileStrict, writeOrgsFile,
} from './store/legacy-files.mjs';
import { currentStore } from './store/db.mjs';
import { getOrg } from './store/orgs.mjs';

// The org context lives in server/org-context.mjs (no import cycle with
// server/store/); re-exported here for the callers that import it from
// tenancy.
export { currentOrg, runWithOrg, validOrgId };

// The deployment-level base — the store, the session secret and the
// legacy files always live here; the default org's root is usually the
// base itself.
export function baseWorkspaceRoot() { return baseWorkspacePath(); }

// THE context-aware root: <base>/<orgs.root of the request's org>.
export function orgWorkspaceRoot() {
  const org = currentOrg();
  if (!org) throw new Error('tenancy: orgWorkspaceRoot() outside an org context — wrap the caller in runWithOrg(id)');
  if (!validOrgId(org)) throw new Error(`tenancy: invalid org id ${JSON.stringify(org)}`);
  return join(baseWorkspaceRoot(), orgRootOf(org));
}

// ---------- an org's root in the store (STORE_PLAN slice 2) ----------
//
// orgs.root ('.' or 'orgs/<id>') is fixed at creation, so a lookup is
// cached per store handle and never needs invalidating at runtime; an
// offline root change happens with the server stopped or inside boot step
// 3, which resets the cache first. Keyed by handle, so a suite that
// re-points the workspace between boots never reads a stale root. A
// removed org keeps its root (its files are still there).
let rootCache = new WeakMap();   // db handle → Map(orgId → root)

export function orgRootOf(orgId, db = currentStore()) {
  let roots = rootCache.get(db);
  if (!roots) { roots = new Map(); rootCache.set(db, roots); }
  if (roots.has(orgId)) return roots.get(orgId);
  const org = typeof orgId === 'string' ? getOrg(db, orgId) : null;
  if (!org) throw new Error(`tenancy: unknown org ${JSON.stringify(orgId)}`);
  roots.set(orgId, org.root);
  return org.root;
}

export function resetOrgRootCache() {
  rootCache = new WeakMap();
}

// ---------- boot migration: flat workspace → orgs/default/ ----------
//
// Idempotent and per-entry. An entry moves only when it holds data
// (hasData(): an empty directory, a tree of empty directories or a
// zero-byte deploys.jsonl never moves, so an empty packs/ no longer
// manufactures orgs/default/ and a 'default' org) and its destination does
// not exist. A flat entry with data whose orgs/default/ twin exists is
// left behind — neither moved nor merged — and reported. A half-migrated
// workspace (crash mid-move) finishes on the next boot.

// Read-only: what the migration would do. Called before any write, so the
// boot can count the orgs the import will produce.
export function planFlatMigration({ base = baseWorkspaceRoot() } = {}) {
  const move = [];
  const leftBehind = [];
  const emptyLeftovers = [];
  for (const entry of MIGRATABLE) {
    const from = join(base, entry);
    if (!hasData(from)) {
      if (lexists(from)) emptyLeftovers.push(entry);
      continue;
    }
    if (lexists(join(base, 'orgs', 'default', entry))) leftBehind.push(entry);
    else move.push(entry);
  }
  return { move, leftBehind, emptyLeftovers };
}

export function migrateFlatWorkspace({ log = () => {}, base = baseWorkspaceRoot() } = {}) {
  const orgsPath = legacyOrgsFilePath(base);
  if (!existsSync(orgsPath)) return { moved: [], leftBehind: [], wroteDefault: false };
  const plan = planFlatMigration({ base });
  // Strict, and before anything moves: a corrupt orgs.json fails the start
  // naming its path (the lenient read returned {} and the write below
  // replaced the file with { default }).
  const orgs = plan.move.length ? readOrgsFileStrict(orgsPath) : null;
  const moved = [];
  for (const entry of plan.move) {
    mkdirSync(join(base, 'orgs', 'default'), { recursive: true });
    renameSync(join(base, entry), join(base, 'orgs', 'default', entry));
    moved.push(entry);
    log(`[tenancy] moved ${join(base, entry)} to orgs/default/${entry}`);
  }
  for (const entry of plan.leftBehind) {
    log(`[tenancy] left behind: ${join(base, entry)} — orgs/default/${entry} already exists; neither moved nor merged, merge it by hand`);
  }
  let wroteDefault = false;
  if (moved.length && !orgs.entries.some(([id]) => id === 'default')) {
    // The moved state must stay reachable: make sure a 'default' org
    // exists. Membership is left for the admin to fill in.
    const data = JSON.parse(orgs.raw.toString('utf8'));
    data.default = { name: 'Default', members: {} };
    writeOrgsFile(data, orgsPath);
    wroteDefault = true;
    log(`[tenancy] created org "default" in orgs.json — add members to grant access to the migrated workspace`);
  }
  return { moved, leftBehind: plan.leftBehind, wroteDefault };
}
