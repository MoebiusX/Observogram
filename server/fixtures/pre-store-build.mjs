// server/fixtures/pre-store-build.mjs — a frozen copy of what a pre-store
// build (tag v0.4.0; develop before STORE_PLAN slice 2) does with the
// identity files and the flat workspace, for the fast half of the Export
// gate (server/test-store-ops.mjs). The real build is booted over HTTP by
// tools/test-store-prestore-live.mjs in the CI job store-prestore; this
// copy lets every `npm test` run the same assertions without a checkout.
//
// Copied from v0.4.0's server/auth.mjs (readUsers, verifyPassword,
// usersFilePath, localUsersEnabled), server/tenancy.mjs (readOrgs,
// orgsForUser, tenancyEnabled, orgWorkspaceRoot, migrateFlatWorkspace —
// with the move of an EMPTY entry it had) and server/index.mjs's start()
// (the migration, then the rehydrate of the flat scope, whose
// loadWorkspacePacks() creates <base>/packs even with tenancy armed) and
// server/workspace.mjs / tools/lib/journey.mjs (what the catalog lists:
// every packs/<id>.pack.yaml; every journeys/<name>.journey.yaml). The
// only change: the env those functions read (OBSERVOGRAM_WORKSPACE,
// OBSERVOGRAM_USERS_FILE) is a parameter here, so one process can look at
// many workspaces. Do not "fix" anything in it: it is what the old build
// does, bugs included.

import { scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from '../../tools/lib/mini-yaml.mjs';

// ---------- auth.mjs ----------

export function usersFilePath(base, usersFile = null) { return usersFile || join(base, 'users.json'); }

// OIDC and OBSERVOGRAM_AUTH=off are out of the gate's scope: stand-alone
// sign-in is on exactly when the users file exists.
export function localUsersEnabled(base, usersFile = null) { return existsSync(usersFilePath(base, usersFile)); }

export function verifyPassword(password, rec) {
  if (!rec || rec.algo !== 'scrypt') return false;
  const salt = Buffer.from(rec.salt, 'base64');
  const want = Buffer.from(rec.hash, 'base64');
  const got = scryptSync(String(password), salt, want.length, { N: rec.N, r: rec.r, p: rec.p });
  return got.length === want.length && timingSafeEqual(got, want);
}

export function readUsers(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return (data && typeof data === 'object' && data.users && typeof data.users === 'object') ? data : { users: {} };
  } catch { return { users: {} }; }
}

// POST /auth/login's decision: null (401), or { sub, mustChange } — a
// mustChange user gets the password-change flow instead of a session.
export function signIn(base, username, password, { usersFile = null } = {}) {
  if (!localUsersEnabled(base, usersFile)) return null;
  const rec = readUsers(usersFilePath(base, usersFile)).users[String(username || '').trim()];
  const ok = rec ? verifyPassword(password, rec.password) : false;
  if (!ok) return null;
  return { sub: String(username).trim(), mustChange: !!rec.mustChange };
}

// ---------- tenancy.mjs ----------

export function orgsFilePath(base) { return join(base, 'orgs.json'); }

export function tenancyEnabled(base) { return existsSync(orgsFilePath(base)); }

export function readOrgs(base) {
  try {
    const data = JSON.parse(readFileSync(orgsFilePath(base), 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch { return {}; }
}

function writeOrgs(base, orgs) {
  const file = orgsFilePath(base);
  mkdirSync(base, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(orgs, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, file); } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}

export function validOrgId(id) { return /^[a-z][a-z0-9_-]{0,62}[a-z0-9]$/.test(String(id || '')); }

export function orgsForUser(base, sub) {
  if (!sub) return [];
  const orgs = readOrgs(base);
  return Object.entries(orgs)
    .filter(([id, org]) => validOrgId(id) && org?.members && Object.hasOwn(org.members, sub))
    .map(([id, org]) => ({ id, name: org.name || id, role: String(org.members[sub] || 'member') }));
}

export function orgWorkspaceRoot(base, org = null) {
  if (!org || !tenancyEnabled(base)) return base;
  if (!validOrgId(org)) throw new Error(`tenancy: invalid org id ${JSON.stringify(org)}`);
  return join(base, 'orgs', org);
}

const MIGRATABLE = ['packs', 'deploys.jsonl', 'snapshots', 'journeys', 'runs'];

export function migrateFlatWorkspace(base) {
  if (!tenancyEnabled(base)) return { migrated: [] };
  const migrated = [];
  for (const entry of MIGRATABLE) {
    const from = join(base, entry);
    const to = join(base, 'orgs', 'default', entry);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(join(base, 'orgs', 'default'), { recursive: true });
    renameSync(from, to);
    migrated.push(entry);
  }
  if (migrated.length) {
    const orgs = readOrgs(base);
    if (!Object.hasOwn(orgs, 'default')) {
      orgs.default = { name: 'Default', members: {} };
      writeOrgs(base, orgs);
    }
  }
  return { migrated };
}

// ---------- index.mjs start() and the catalog ----------

// start()'s file effects, in its order: the migration, then the flat-scope
// rehydrate (loadWorkspacePacks → ensureDirs() at the base, tenancy armed
// or not: every pre-store restart leaves an empty <base>/packs).
export function boot(base) {
  const r = migrateFlatWorkspace(base);
  mkdirSync(join(base, 'packs'), { recursive: true });
  return r;
}

// The uploaded packs GET /api/packs lists for a request in `org` (null
// with tenancy off): every packs/<id>.pack.yaml under that org's root that
// parses to an object, by id.
export function packIds(base, org = null) {
  const dir = join(orgWorkspaceRoot(base, org), 'packs');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.pack.yaml')); } catch { return []; }
  return files.filter((f) => {
    try { const c = parseYaml(readFileSync(join(dir, f), 'utf8')); return !!c && typeof c === 'object'; } catch { return false; }
  }).map((f) => f.slice(0, -'.pack.yaml'.length)).sort();
}

// GET /api/journeys for `org`: name → { packA, packB } (their file: values).
export function journeys(base, org = null) {
  const dir = join(orgWorkspaceRoot(base, org), 'journeys');
  let files;
  try { files = readdirSync(dir).filter((f) => f.endsWith('.journey.yaml')); } catch { return {}; }
  const out = {};
  for (const f of files.sort()) {
    let def = null;
    try { def = parseYaml(readFileSync(join(dir, f), 'utf8')); } catch { /* listed with no paths */ }
    out[f.slice(0, -'.journey.yaml'.length)] = { packA: def?.packA?.file ?? null, packB: def?.packB?.file ?? null };
  }
  return out;
}
