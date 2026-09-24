// server/tenancy.mjs — Stage 2 of docs/PRODUCTIZATION_PLAN.md: tenancy
// (workspace-per-org).
//
// The whole design is one move: workspaceRoot() becomes context-aware.
// When tenancy is armed, every org gets its own subtree —
//
//   <OBSERVOGRAM_WORKSPACE>/
//     users.json, session-secret, orgs.json     deployment-level (shared)
//     orgs/<orgId>/packs|deploys.jsonl|snapshots|journeys|runs
//
// — and the file-first machinery underneath (registry, deploys,
// snapshots, journeys, runs) is unchanged: it already resolves its root
// per call, so it only needed a context-aware answer. The request's org
// rides AsyncLocalStorage (node:async_hooks), so nothing threads an
// orgId parameter through twenty call sites.
//
// ARMING — mirrors users.json arming stand-alone auth: tenancy is ON
// when <workspace>/orgs.json exists. No file → byte-identical flat
// workspace, zero behaviour change (CI-asserted by every other suite).
//
//   orgs.json: { "<orgId>": { "name": "...", "members": { "<sub>": "<role>" } } }
//
// Roles are RECORDED here but not yet ENFORCED — that is Stage 3's
// per-route check. Stage 2 enforcement is membership only: you are in
// the org or you do not see it. Member management is admin-edited file
// (or tools/org-admin.mjs); mutation endpoints deliberately wait for
// Stage 3 roles — a members API any member can call would be a
// privilege-escalation hole, not a feature.
//
// MIGRATION — a deployment with an existing flat workspace gets it
// moved to orgs/default/ by a one-shot, idempotent boot migration that
// only runs once tenancy is armed (rename per entry that holds data;
// entries that already exist under orgs/default/ are left behind).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { baseWorkspacePath } from '../tools/lib/brand-env.mjs';
import { currentOrg, runWithOrg, validOrgId } from './org-context.mjs';
import {
  MIGRATABLE, hasData, lexists, orgsFilePath as legacyOrgsFilePath, readOrgsFileStrict, writeOrgsFile,
} from './store/legacy-files.mjs';

// The org context lives in server/org-context.mjs (no import cycle with
// server/store/); re-exported here for the callers that import it from
// tenancy.
export { currentOrg, runWithOrg, validOrgId };

// The deployment-level base — auth state (users.json, session-secret)
// and orgs.json always live here, never inside an org subtree.
export function baseWorkspaceRoot() { return baseWorkspacePath(); }

export function orgsFilePath() { return join(baseWorkspaceRoot(), 'orgs.json'); }

export function tenancyEnabled() { return existsSync(orgsFilePath()); }

// ---------- the org registry (file-first, like everything else) ----------

export function readOrgs(file = orgsFilePath()) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (_) { return {}; }
}

export function writeOrgs(orgs, file = orgsFilePath()) {
  mkdirSync(baseWorkspaceRoot(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(orgs, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, file); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch (_) {} throw e; }
}

export function orgsForUser(sub) {
  if (!sub) return [];
  const orgs = readOrgs();
  return Object.entries(orgs)
    .filter(([id, org]) => validOrgId(id) && org?.members && Object.hasOwn(org.members, sub))
    .map(([id, org]) => ({ id, name: org.name || id, role: String(org.members[sub] || 'member') }));
}

export function isMember(orgId, sub) {
  if (!validOrgId(orgId) || !sub) return false;
  const org = readOrgs()[orgId];
  return !!(org?.members && Object.hasOwn(org.members, sub));
}

export function orgExists(orgId) {
  return validOrgId(orgId) && Object.hasOwn(readOrgs(), orgId);
}

// ---------- per-request org context (server/org-context.mjs) ----------

// THE context-aware root. Flat (byte-identical v1 behaviour) unless
// tenancy is armed AND the request carries an org.
export function orgWorkspaceRoot() {
  const base = baseWorkspaceRoot();
  const org = currentOrg();
  if (!org || !tenancyEnabled()) return base;
  if (!validOrgId(org)) throw new Error(`tenancy: invalid org id ${JSON.stringify(org)}`);
  return join(base, 'orgs', org);
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
