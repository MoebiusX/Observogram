// server/boot.mjs — the boot order of a store build (docs/STORE_PLAN.md §4).
//
// bootStore() runs steps 1–5 of every start; start() in server/index.mjs
// calls it, then does step 6 (the workspace resolver, rehydrating each
// org's packs) and listens:
//
//   step 0  bootContext()          the environment, read once; a malformed
//                                  issuer, join role or bootstrap admin
//                                  refuses before any file is created
//   step 1  openStore()            version check, filesystem check, migrations
//   step 2  staleImportGuard()     the store and the legacy files still belong
//                                  together: a stale store, a changed issuer,
//                                  files edited after the import refuse
//   step 3  the legacy import      once: read strictly, decide, check (no
//                                  write before the checks pass), migrate the
//                                  flat workspace, read again, import, mark
//           — or the repairs       a file that disappeared is recorded
//                                  absent; the marker is rewritten from the
//                                  database
//   step 4  the seed decision      seed admin / rescue a still-seeded admin /
//                                  nothing, checked first; the issuer record;
//                                  the sign-in mode record; the every-boot
//                                  warnings
//   step 5  importPacksOnce()      slice 4's hook
//
// The seed decision (today's maybeSeedDefaultAdmin, split): seedDecision()
// is pure over a view of the facts; the legacy view (step 3) takes them
// from the users file, the store view (step 4) from the store — the same
// inputs in both, so the boot after the import reaches the decision the
// import boot reached. applySeedDecision() re-reads the row it changes in
// its own transaction: a decision never carries a row.
//
// The fail-closed checks (assertBootChecks) refuse with the first failing
// one, A to E; A and B keep today's texts verbatim.

import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { baseWorkspacePath, brandEnv } from '../tools/lib/brand-env.mjs';
import { authDisabled, hashPassword, oidcEnabled } from './auth.mjs';
import { migrateFlatWorkspace, planFlatMigration, resetOrgRootCache } from './tenancy.mjs';
import { atomic, nowIso, openStore, prepare, resolveDbPath, tx } from './store/db.mjs';
import { getMeta, getMetaJson, isIdentityArmed, putMeta, setMeta, storeId } from './store/meta.mjs';
import { listOrgs } from './store/orgs.mjs';
import { validOrgId } from './org-context.mjs';
import { addMembership } from './store/memberships.mjs';
import { createUser, getUserByLogin, setPassword } from './store/users.mjs';
import {
  canonIssuer, ensureDefaultOrg, parseBootstrapAdmin, parseJoinRole, signInOwnerCount, SYSTEM,
} from './store/identity.mjs';
import { applyImport, formatReport, planImport, projectedMigration, readLegacy, unreadDefaultText } from './store/import.mjs';
import {
  compareHashes, hasData, legacyUsersPath, lexists, markerPath, MIGRATABLE, orgsFilePath, readMarker, sha256File, writeMarker,
} from './store/legacy-files.mjs';

// ---------- the refusal ----------

export class BootRefusal extends Error {
  constructor(message, { nothingMoved = false } = {}) {
    super(message);
    this.name = 'BootRefusal';
    this.code = 'ERR_OBSERVOGRAM_BOOT_REFUSED';
    this.nothingMoved = nothingMoved;
  }
}

export function isLoopbackHost(h) {
  const host = String(h || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

// ---------- step 0: the boot context ----------

function envRefusal(e) {
  return new BootRefusal(`refusing to start: ${e.message}. Nothing was written.`, { nothingMoved: true });
}

// The environment, read once per boot. The request posture (authOff,
// oidc) follows auth.mjs; who the keys are (identityMode, issuerKey)
// follows the issuer variable even with OBSERVOGRAM_AUTH=off (A-51).
export function bootContext({ host }) {
  const issuerRaw = brandEnv('OIDC_ISSUER') || null;
  const dbPath = resolveDbPath();
  let issuerKey;
  let joinRoleEnv;
  let bootstrap;
  try {
    issuerKey = issuerRaw ? canonIssuer(issuerRaw) : null;
    joinRoleEnv = parseJoinRole(brandEnv('OIDC_JOIN_ROLE'));
    bootstrap = issuerRaw ? parseBootstrapAdmin(brandEnv('BOOTSTRAP_ADMIN')) : null;
  } catch (e) {
    if (e instanceof TypeError) throw envRefusal(e);
    throw e;
  }
  const usersFile = brandEnv('USERS_FILE');
  return {
    host, loopback: isLoopbackHost(host), base: baseWorkspacePath(), now: nowIso(),
    dbPath, memory: dbPath === ':memory:',
    authOff: authDisabled(), oidc: oidcEnabled(),
    issuerRaw, issuerKey, identityMode: issuerRaw ? 'oidc' : 'local',
    token: !!brandEnv('API_TOKEN'), adminPassword: brandEnv('ADMIN_PASSWORD') || null,
    insecure: brandEnv('INSECURE_NO_AUTH') === '1',
    joinRoleEnv, bootstrap,
    bootstrapIgnored: !issuerRaw && !!brandEnv('BOOTSTRAP_ADMIN'),
    usersFileEnv: usersFile ? resolve(usersFile) : null,
  };
}

// ---------- the seed decision ----------

const none = (reason) => ({ kind: 'none', password: null, reason });

// Pure. Never a row or an id: the write re-reads the row it changes.
export function seedDecision({ authOff, oidc, token, armed, adminPassword, loopback, adminStillSeeded }) {
  if (authOff) return none('OBSERVOGRAM_AUTH=off');
  if (oidc) return none('OIDC');
  if (token) return none('OBSERVOGRAM_API_TOKEN');
  if (armed) {
    if (!adminPassword) return none('identity is armed');
    if (!adminStillSeeded) return none('the admin is not the seeded default');
    return { kind: 'rescue', password: adminPassword, reason: 'OBSERVOGRAM_ADMIN_PASSWORD replaces the still-seeded admin' };
  }
  if (!adminPassword && !loopback) return none('the default credential never binds beyond loopback');
  return { kind: 'seed', password: adminPassword, reason: adminPassword ? 'OBSERVOGRAM_ADMIN_PASSWORD' : 'first boot' };
}

function storeAdminStillSeeded(db) {
  const admin = getUserByLogin(db, 'admin');
  return !!admin && admin.kind === 'local' && !admin.disabled && admin.seededDefault && admin.mustChange;
}

const postureOf = (ctx) => ({
  authOff: ctx.authOff, oidc: ctx.oidc, token: ctx.token, adminPassword: ctx.adminPassword, loopback: ctx.loopback,
});

// Step 3: the users file's facts (a CLI-armed store that was never
// imported is armed too — A-2).
export function legacyView(db, ctx, legacy) {
  let adminStillSeeded;
  if (legacy.users.exists) {
    const rec = legacy.users.entries.find(([name]) => name === 'admin')?.[1];
    adminStillSeeded = !!(rec && rec.seededDefault && rec.mustChange) && ctx.identityMode === 'local';
  } else {
    adminStillSeeded = storeAdminStillSeeded(db);
  }
  return { ...postureOf(ctx), armed: legacy.users.exists || isIdentityArmed(db), adminStillSeeded };
}

// Step 4: the store's facts.
export function storeView(db, ctx) {
  return { ...postureOf(ctx), armed: isIdentityArmed(db), adminStillSeeded: storeAdminStillSeeded(db) };
}

const SEEDED_LOG = "[studio] seeded user 'admin' from OBSERVOGRAM_ADMIN_PASSWORD — sign in at /auth/login";
const SEEDED_DEFAULT_LOG = '[studio] first boot: seeded default sign-in admin / admin — a password change is asked at sign-in (skippable until it lands). OBSERVOGRAM_AUTH=off runs open with no login.';
const RESCUED_LOG = '[studio] replaced the still-default admin password from OBSERVOGRAM_ADMIN_PASSWORD';

export function applySeedDecision(db, decision, { log = () => {}, warn = () => {} } = {}) {
  if (decision.kind === 'seed') {
    const password = hashPassword(decision.password || 'admin');
    let outcome = 'armed';
    atomic(db, () => {
      if (isIdentityArmed(db)) return;
      if (getUserByLogin(db, 'admin')) { outcome = 'exists'; return; }
      const org = ensureDefaultOrg(db, SYSTEM);
      const seeded = !decision.password;
      const user = createUser(db, SYSTEM, {
        login: 'admin', name: 'Admin', password, mustChange: seeded, seededDefault: seeded, isOwner: true,
      });
      addMembership(db, SYSTEM, { orgId: org.id, userId: user.id, role: 'admin' });
      setMeta(db, SYSTEM, 'identity_armed', '1');
      outcome = 'seeded';
    });
    if (outcome === 'seeded') log(decision.password ? SEEDED_LOG : SEEDED_DEFAULT_LOG);
    else if (outcome === 'exists') warn("[store] admin not seeded: the store already has a user 'admin' (kept as it is)");
    return outcome;
  }
  if (decision.kind === 'rescue') {
    const password = hashPassword(decision.password);
    let applied = false;
    atomic(db, () => {
      // Today's invariant: the env may replace only a still-seeded
      // record, never a real credential — re-checked here, on the row.
      const row = getUserByLogin(db, 'admin');
      if (!row || row.kind !== 'local' || row.disabled || !row.seededDefault || !row.mustChange) return;
      setPassword(db, SYSTEM, row.id, password, { mustChange: false, seededDefault: false });
      applied = true;
    });
    if (applied) log(RESCUED_LOG);
    else warn("[store] OBSERVOGRAM_ADMIN_PASSWORD not applied: the store's admin is not the seeded default (kept as it is)");
    return applied ? 'rescued' : 'kept';
  }
  return 'none';
}

// True while a still-seeded default credential can sign in, or come back
// (a disabled row counts: `users -- enable` would restore it), after the
// decision: the one row a rescue fixes (an enabled admin) is not counted.
export function defaultCredentialActive(db, ctx, decision = null) {
  return stillSeededRows(db, ctx, decision).length > 0;
}

function stillSeededRows(db, ctx, decision) {
  if (ctx.authOff || ctx.oidc || !isIdentityArmed(db)) return [];
  const rescue = decision?.kind === 'rescue' ? 1 : 0;
  return prepare(db, `SELECT login, disabled FROM users WHERE kind = 'local' AND seeded_default = 1
    AND must_change = 1 AND NOT (:rescue = 1 AND login = 'admin' AND disabled = 0) ORDER BY login`).all({ rescue });
}

// The logins check B counts when every one is disabled (neither a loopback
// sign-in nor a rescue reaches them; `users -- passwd` does), else null.
function stillSeededDisabled(db, ctx, decision) {
  const rows = stillSeededRows(db, ctx, decision);
  return rows.length && rows.every((r) => r.disabled) ? rows.map((r) => r.login) : null;
}

// ---------- the fail-closed checks ----------

// A live org keeps its data at the base: a CLI initialised the store.
export function keepsDefaultAtRoot(db) {
  return listOrgs(db).some((o) => o.root === '.');
}

// Check E's facts, on every boot: a store keeping the default org at '.'
// beside an orgs.json, and data in orgs/default that no live org reads —
// what a pre-store build's flat migration leaves, before the import or
// after a rollback to one.
function strandedDefault(db, ctx, orgsFileExists) {
  return keepsDefaultAtRoot(db) && orgsFileExists && hasData(join(ctx.base, 'orgs', 'default'))
    && !listOrgs(db).some((o) => o.root === 'orgs/default')
    ? { storeId: storeId(db), base: ctx.base } : null;
}

// Step 3's facts: the legacy files, the decision and plan1.
export function legacyChecksInput(db, ctx, legacy, decision, plan1) {
  const armed = isIdentityArmed(db);
  const usersFile = legacy.users.exists;
  return {
    step: 'import', host: ctx.host, loopback: ctx.loopback, token: ctx.token, insecure: ctx.insecure, dbPath: ctx.dbPath,
    auth: !ctx.authOff && (ctx.oidc || usersFile || armed || decision.kind === 'seed'),
    stillSeeded: !ctx.authOff && !ctx.oidc && usersFile && legacy.users.entries.some(([name, rec]) =>
      rec.seededDefault && rec.mustChange && !(decision.kind === 'rescue' && name === 'admin')),
    orgIds: [...plan1.liveOrgsAfter],
    identity: !ctx.authOff && (ctx.oidc || usersFile || armed),
    strandedDefault: strandedDefault(db, ctx, legacy.orgs.exists),
  };
}

// Step 4's facts, projected: the decision's effect counted, not yet applied.
export function storeChecksInput(db, ctx, decision) {
  const armed = isIdentityArmed(db);
  return {
    step: 'store', host: ctx.host, loopback: ctx.loopback, token: ctx.token, insecure: ctx.insecure, dbPath: ctx.dbPath,
    auth: !ctx.authOff && (ctx.oidc || armed || decision.kind === 'seed'),
    stillSeeded: defaultCredentialActive(db, ctx, decision),
    stillSeededDisabled: stillSeededDisabled(db, ctx, decision),
    orgIds: listOrgs(db).map((o) => o.id),
    identity: !ctx.authOff && (ctx.oidc || armed),
    strandedDefault: strandedDefault(db, ctx, existsSync(orgsFilePath(ctx.base))),
  };
}

export const INSECURE_WARNING = (host) => `[studio] WARNING: bound to ${host} with NO auth (OBSERVOGRAM_INSECURE_NO_AUTH=1). `
  + 'Every write route is open to the network. Do not run this posture outside a trusted network.';

// Refuses with the first failing check; returns { insecure } — true when
// check A failed and OBSERVOGRAM_INSECURE_NO_AUTH=1 overrode it (the
// caller prints today's warning once).
export function assertBootChecks(input) {
  const nothingMoved = input.step === 'import';
  let insecure = false;
  // A — no auth at all beyond loopback.
  if (!input.loopback && !input.token && !input.auth) {
    if (input.insecure) insecure = true;
    else {
      throw new BootRefusal(
        `refusing to bind to ${input.host} without auth: mutating /api routes would be open to the network.\n` +
        '  Set OBSERVOGRAM_API_TOKEN=<secret> (clients send Authorization: Bearer <secret>),\n' +
        "  or seed a sign-in with OBSERVOGRAM_ADMIN_PASSWORD=<secret> (user 'admin'),\n" +
        '  or bind to loopback (HOST=127.0.0.1), or set OBSERVOGRAM_INSECURE_NO_AUTH=1 to override knowingly.',
        { nothingMoved });
    }
  }
  // B — the seeded default credential never binds beyond loopback.
  if (!input.loopback && input.stillSeeded && input.stillSeededDisabled?.length) {
    const logins = input.stillSeededDisabled;
    const which = logins.length === 1 ? `user ${logins[0]} is` : `users ${logins.join(', ')} are`;
    const cmd = logins.length === 1 ? logins[0] : '<login>';
    throw new BootRefusal(
      `refusing to bind to ${input.host} while the seeded default admin password is unchanged.\n` +
      `  The ${which} disabled but still hold${logins.length === 1 ? 's' : ''} it (a loopback sign-in or OBSERVOGRAM_ADMIN_PASSWORD cannot reach a disabled user).\n` +
      `  With the server stopped, run npm run users -- passwd ${cmd} to set a real password${logins.length === 1 ? '' : ' for each'};\n` +
      `  the user can then stay disabled, or be enabled with npm run users -- enable ${cmd}.`,
      { nothingMoved });
  }
  if (!input.loopback && input.stillSeeded) {
    throw new BootRefusal(
      `refusing to bind to ${input.host} while the seeded default admin password is unchanged.\n` +
      '  Sign in once on loopback (admin / admin) to set a real password,\n' +
      '  or seed a fresh workspace with OBSERVOGRAM_ADMIN_PASSWORD=<secret>.',
      { nothingMoved });
  }
  // C — more than one org needs to know who the user is (a bearer is not identity).
  if (input.orgIds.length > 1 && !input.identity) {
    const n = input.orgIds.length;
    const ids = input.orgIds.join(', ');
    throw new BootRefusal(input.step === 'import'
      ? `orgs.json would leave ${n} orgs (${ids}) but no identity is configured: more than one org needs to know who the user is.\n` +
        '  Configure OIDC (OBSERVOGRAM_OIDC_*), or start once with one org — one org boots with a bearer token alone, or on loopback:\n' +
        '  with the server stopped, edit orgs.json down to one org (or move it aside when the flat workspace is the other org).\n' +
        '  Then add stand-alone users with npm run users -- add <login>, and each other org with npm run orgs -- create <id> --adopt\n' +
        '  (the CLIs refuse until that first start has imported). Nothing was moved or imported.'
      : `the store holds ${n} orgs (${ids}) but no identity is configured: more than one org needs to know who the user is.\n` +
        '  Configure OIDC (OBSERVOGRAM_OIDC_*) or stand-alone users (npm run users),\n' +
        '  or keep one org — remove the others with npm run orgs -- remove <id>.',
      { nothingMoved });
  }
  // E — a store at '.', and a pre-store build moved its data (before the
  // import, or on a rollback after it).
  if (input.strandedDefault) {
    const { storeId: id, base } = input.strandedDefault;
    const moved = join(base, 'orgs', 'default');
    const why = input.step === 'import' ? ' (a CLI initialised it before this first start)' : '';
    throw new BootRefusal(
      `refusing to start: store ${id} keeps the default org at ${base}${why}, ` +
      `but ${moved} holds data no org reads — a pre-store build moved the default org's entries there. ` +
      `Nothing was moved or imported. With the server stopped, move the entries of ${moved} back into ${base} ` +
      '(or move that directory aside if it is not the default org\'s data), then start again.',
      { nothingMoved: true });
  }
  return { insecure };
}

// ---------- step 2: the stale-import guard ----------

// A legacy_hashes key → its file: an absolute key is the recorded users
// file, anything else is relative to the base.
const keyPath = (base, key) => (isAbsolute(key) ? key : join(base, key));

function describeStore(db, id, importDone) {
  if (importDone) return `store ${id}`;
  const empty = prepare(db, 'SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM orgs) AS n').get().n === 0;
  return empty ? `a new, empty store (${id})` : `store ${id}, never imported`;
}

// Refuses a stale store (a), a changed issuer (b) and files edited after
// the import (d); returns what (e) repairs. Writes nothing.
export function staleImportGuard(db, ctx) {
  const id = storeId(db);
  const importDone = getMeta(db, 'import_done');
  const marker = ctx.memory ? null : readMarker(ctx.base);   // corrupt → LegacyFileError naming it
  const usersPath = legacyUsersPath(db, ctx.base);
  const orgsPath = orgsFilePath(ctx.base);
  const legacyPresent = existsSync(usersPath) || existsSync(orgsPath);

  // (a) the legacy files were imported into another store. The marker
  // outlives the files: once (d)'s "move it aside" has recorded them
  // absent, it is the only record of the store this workspace belongs to,
  // so a lost or re-pointed database still refuses rather than seeding a
  // new store over it.
  if (!ctx.memory && marker && (marker.storeId !== id || !importDone)) {
    const holds = `${ctx.dbPath} holds ${describeStore(db, id, importDone)}`;
    throw new BootRefusal(
      (legacyPresent
        ? `refusing to start: the legacy users.json/orgs.json in ${ctx.base} were imported into store ${marker.storeId} ` +
          `(${markerPath(ctx.base)}), but ${holds}.\n`
        : `refusing to start: the workspace ${ctx.base} was imported into store ${marker.storeId} ` +
          `(${markerPath(ctx.base)}), but ${holds}. Its legacy files are gone, so that marker is the only record ` +
          'of the store that holds its users and orgs.\n') +
      `Nothing was ${legacyPresent ? 'imported' : 'imported or seeded'}. Ways out:\n` +
      '  - point OBSERVOGRAM_DB at that store, or at a copy of its backup;\n' +
      '  - with the server stopped, `packc store restore <backup>`;\n' +
      (legacyPresent
        ? `  - or, to accept the legacy files as they stand, move ${markerPath(ctx.base)} aside:\n` +
          '    the next start imports them and says so.'
        : `  - or, to start this workspace on ${ctx.dbPath} as it stands, move ${markerPath(ctx.base)} aside:\n` +
          '    the next start starts a new store with the default org at the workspace root and, on loopback with no other\n' +
          '    sign-in configured, seeds admin / admin;\n' +
          '    the imported users and orgs are lost unless a backup of that store is restored, and the org directories\n' +
          '    they read are logged as left behind.'),
      { nothingMoved: true });
  }

  // (b) the OIDC users were recorded under another issuer key.
  const recordedIssuer = getMeta(db, 'oidc_issuer');
  if (ctx.issuerKey && recordedIssuer && recordedIssuer !== ctx.issuerKey) {
    throw new BootRefusal(
      `refusing to start: OBSERVOGRAM_OIDC_ISSUER is ${ctx.issuerRaw} (key ${ctx.issuerKey}), but store ${id} records its ` +
      `OIDC users under ${recordedIssuer}. Nothing was changed. If the IdP is the same, set OBSERVOGRAM_OIDC_ISSUER back to ` +
      `the value that key was recorded from (a spelling that canonicalises to ${recordedIssuer}: its trailing path slash, ` +
      'its well-known suffix).',
      { nothingMoved: true });
  }

  const repairs = { disappeared: [], returned: [], recorded: null };
  if (!importDone) return { replacePending: false, repairs };

  // (d) files edited since the import.
  const recorded = getMetaJson(db, 'legacy_hashes', {}) || {};
  const usersKey = getMeta(db, 'users_file') || 'users.json';
  const current = {};
  for (const key of new Set([...Object.keys(recorded), usersKey, 'orgs.json'])) {
    current[key] = sha256File(key === usersKey ? usersPath : keyPath(ctx.base, key));
  }
  // A file recorded absent after the import keeps the hash it was imported
  // with, and is compared as that: put back byte for byte it passes (and
  // (e) records it present again); any other file refuses as a change.
  const importedOf = (key) => (recorded[key]?.absent && typeof recorded[key].importedSha256 === 'string'
    ? recorded[key].importedSha256 : null);
  const asImported = {};
  for (const [key, value] of Object.entries(recorded)) {
    asImported[key] = importedOf(key) ? { sha256: importedOf(key) } : value;
  }
  const cmp = compareHashes(asImported, current);
  const stale = [...cmp.changed, ...cmp.appeared];
  if (stale.length) {
    const pathOf = (key) => (key === usersKey ? usersPath : keyPath(ctx.base, key));
    const lines = stale.map((key) => (!cmp.changed.includes(key)
      ? `${pathOf(key)} appeared since store ${id} last imported it (it was absent then).`
      : importedOf(key)
        ? `${pathOf(key)} came back since store ${id} recorded it absent, but not as it was imported ` +
          `(it was SHA-256 ${importedOf(key)} at the import, it is ${current[key].sha256}).`
        : `${pathOf(key)} changed since store ${id} last imported it (it was SHA-256 ${recorded[key].sha256}, it is ${current[key].sha256}) — ` +
          'it was edited outside the store (a pre-store build during a rollback, or config management).'));
    const ways = [
      ...cmp.changed.map((key) => `  - put ${pathOf(key)} back exactly as it was imported (SHA-256 ${asImported[key].sha256}; ` +
        `the store's legacy_hashes and ${markerPath(ctx.base)} record it), or`),
      ...stale.map((key) => `  - move ${pathOf(key)} aside: a file that disappears is recorded as absent and changes no user or org;`),
    ];
    throw new BootRefusal(
      `refusing to start: ${lines.join('\n  ')}\n` +
      'Nothing was changed. The store keeps its own users and orgs; the file is only compared, never read again. ' +
      'With the server stopped:\n' +
      `${ways.join('\n')}\n` +
      'then make the change with `npm run users` / `npm run orgs`.',
      { nothingMoved: true });
  }
  repairs.disappeared = cmp.disappeared.filter((key) => !recorded[key]?.absent);
  repairs.returned = Object.keys(recorded).filter((key) => importedOf(key) && current[key]?.sha256 === importedOf(key));
  repairs.recorded = recorded;
  return { replacePending: false, repairs };
}

// (e) — only when nothing refused and no import runs this boot: a file
// that disappeared is recorded absent (no audit row, no user, org or
// membership row touched — A-20); the marker is rewritten from the
// database whenever it differs.
export function applyRepairs(db, ctx, guard, { log = () => {} } = {}) {
  const { disappeared, returned = [], recorded } = guard.repairs;
  if (disappeared.length || returned.length) {
    const next = { ...recorded };
    // The imported hash is kept, so the file put back byte for byte is
    // accepted (and recorded present again) rather than refused as new.
    for (const key of disappeared) next[key] = { absent: true, importedSha256: recorded[key].sha256 };
    for (const key of returned) next[key] = { sha256: recorded[key].importedSha256 };
    tx(db, () => putMeta(db, 'legacy_hashes', JSON.stringify(next)));
    for (const key of disappeared) log(`[store] ${key} disappeared since the import; recorded as absent`);
    for (const key of returned) log(`[store] ${key} is back as it was imported; recorded as present`);
  }
  if (!getMeta(db, 'import_done') || ctx.memory) return;
  const id = storeId(db);
  const files = getMetaJson(db, 'legacy_hashes', {}) || {};
  const marker = readMarker(ctx.base);
  if (!marker || marker.storeId !== id || JSON.stringify(marker.files) !== JSON.stringify(files)) {
    const path = writeMarker(ctx.base, { storeId: id, files, by: 'repair' });
    log(`[store] rewrote ${path} from store ${id}`);
  }
}

// ---------- step 4: the issuer record and the every-boot warnings ----------

// OIDC configured (the issuer variable, even with OBSERVOGRAM_AUTH=off)
// and nothing recorded: record the key, after every check has passed.
export function recordIssuer(db, ctx) {
  if (ctx.issuerKey && !getMeta(db, 'oidc_issuer')) {
    setMeta(db, SYSTEM, 'oidc_issuer', ctx.issuerKey);
    return true;
  }
  return false;
}

// The sign-in mode this start runs, for the CLIs: they cannot see the
// server's env, and a shell's may differ (a docker exec, a sudo shell).
// 'oidc:<issuerKey>' whenever the issuer variable is set (the keys follow
// it even with OBSERVOGRAM_AUTH=off — A-51); else 'off' (OBSERVOGRAM_AUTH=off),
// 'local' (identity armed), 'token' (a bearer only) or 'open' (neither).
export function identityModeOf(db, ctx) {
  if (ctx.issuerKey) return `oidc:${ctx.issuerKey}`;
  if (ctx.authOff) return 'off';
  if (isIdentityArmed(db)) return 'local';
  return ctx.token ? 'token' : 'open';
}

// Recorded at every start, written (meta.set) only when it changes.
export function recordIdentityMode(db, ctx) {
  const mode = identityModeOf(db, ctx);
  if (getMeta(db, 'identity_mode') === mode) return false;
  setMeta(db, SYSTEM, 'identity_mode', mode);
  return true;
}

// Only in the identity postures (A-49).
export function warnNoOwner(db, ctx, warn) {
  const localIdentity = !ctx.authOff && !ctx.oidc && isIdentityArmed(db);
  if (localIdentity && signInOwnerCount(db, { mode: 'local' }) === 0) {
    warn('[store] no owner — run `npm run users -- owner <login>` (or `npm run users -- add <name>`: the first local user becomes the owner)');
  } else if (ctx.oidc && signInOwnerCount(db, { mode: 'oidc', issuerKey: ctx.issuerKey }) === 0) {
    warn(`[store] no owner who can sign in with OIDC — set OBSERVOGRAM_BOOTSTRAP_ADMIN=${ctx.issuerKey}#<sub> (or a verified email) and sign in, ` +
      `or run \`npm run users -- owner ${ctx.issuerKey}#<sub>\``);
  }
}

// Data that nothing reads, in both directions (§4), until an operator
// resolves it.
export function warnLeftBehind(db, ctx, warn) {
  warnUnreadOrgRoots(ctx, warn, listOrgs(db, { includeRemoved: true }));
  const live = listOrgs(db);
  const atBase = live.some((o) => o.root === '.');
  const moved = join(ctx.base, 'orgs', 'default');
  const movedUnread = !live.some((o) => o.root === 'orgs/default') && hasData(moved);
  if (!atBase) {
    for (const entry of MIGRATABLE) {
      const path = join(ctx.base, entry);
      if (!hasData(path)) continue;
      // :memory: over a half-migrated workspace: a file-store start would
      // move this entry (orgs/default has no twin), so nothing to merge.
      if (ctx.memory && !lexists(join(moved, entry))) {
        warn(`[store] left behind: ${path} — nothing reads it (the default org's root is orgs/default/); ` +
          'OBSERVOGRAM_DB=:memory: moves nothing; a file-store start finishes the move');
      } else {
        warn(`[store] left behind: ${path} — nothing reads it (the default org's copy is orgs/default/${entry}); merge it by hand`);
      }
    }
    if (movedUnread) {
      const id = getMeta(db, 'default_org');
      const root = id ? live.find((o) => o.id === id)?.root : null;
      warn(`[store] left behind: ${unreadDefaultText({ path: moved, defaultOrg: root ? id : null, defaultRoot: root ? join(ctx.base, root) : null })}`);
    }
    return;
  }
  if (movedUnread) {
    warn(`[store] left behind: ${moved} — nothing reads it (the default org's root is .); move its entries back to ${ctx.base} by hand`);
  }
}

// Every other orgs/<id> with data that no org row reads — an org the store
// lost (a database started anew). A removed org's root is left to
// `packc store purge-org`.
function warnUnreadOrgRoots(ctx, warn, rows) {
  const dir = join(ctx.base, 'orgs');
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return;
    throw e;
  }
  const known = new Set(rows.map((o) => o.root));
  for (const name of names.sort()) {
    if (name === 'default' || known.has(`orgs/${name}`)) continue;
    const path = join(dir, name);
    if (!hasData(path)) continue;
    warn(validOrgId(name)
      ? `[store] left behind: ${path} — no org reads it (the store has no org ${name}); adopt it with \`npm run orgs -- create ${name} --adopt\` or move it aside by hand`
      : `[store] left behind: ${path} — no org reads it; move it aside by hand`);
  }
}

// OBSERVOGRAM_OIDC_JOIN_ROLE is read at the first start only (A-4).
export function warnIgnoredJoinRole(db, ctx, warn, { imported = false } = {}) {
  if (ctx.joinRoleEnv === undefined || imported) return;
  const recorded = getMeta(db, 'oidc_join_role');
  if ((ctx.joinRoleEnv ?? null) !== recorded) {
    warn(`[store] OBSERVOGRAM_OIDC_JOIN_ROLE is read at the first start only; the store records ${recorded ?? 'none'}`);
  }
}

// ---------- step 5 ----------

function importPacksOnce(db) {
  if (getMeta(db, 'packs_imported')) return;
  // slice 4: boot step 5 (STORE_PLAN §4 items 4–5)
}

// ---------- the boot ----------

export async function bootStore({ host, log = () => {}, warn = () => {} } = {}) {
  // step 0
  const ctx = bootContext({ host });
  if (ctx.bootstrapIgnored) warn('[store] OBSERVOGRAM_BOOTSTRAP_ADMIN applies only with OIDC (OBSERVOGRAM_OIDC_ISSUER is not set) — ignored');

  // step 1
  const db = await openStore({ path: ctx.dbPath });
  resetOrgRootCache();
  if (ctx.memory) warn('[store] OBSERVOGRAM_DB=:memory: — nothing persists: every restart imports again and seeds admin/admin again');

  // step 2
  const guard = staleImportGuard(db, ctx);

  // step 3
  let decision = null;
  let report = null;
  if (!getMeta(db, 'import_done')) {
    const legacy1 = readLegacy(db, ctx);                       // strict: a throw names the path, nothing moved
    const migrate = legacy1.orgs.exists && !keepsDefaultAtRoot(db);
    const flat = migrate ? planFlatMigration({ base: ctx.base }) : null;
    decision = seedDecision(legacyView(db, ctx, legacy1));
    const plan1 = planImport(db, legacy1, ctx, projectedMigration({ flat, migrate, orgs: legacy1.orgs }));
    assertBootChecks(legacyChecksInput(db, ctx, legacy1, decision, plan1));   // no write before this line
    // :memory: never writes the workspace (it would move a file store's
    // data and rewrite orgs.json under it): the import stands on the
    // projected migration, and nothing moves.
    const migration = migrate && !ctx.memory
      ? { ...migrateFlatWorkspace({ log, base: ctx.base }), skipped: null }
      : projectedMigration({ flat, migrate, orgs: legacy1.orgs });
    const legacy2 = readLegacy(db, ctx);
    const plan2 = planImport(db, legacy2, ctx, migration);
    report = applyImport(db, plan2, ctx);
    if (!ctx.memory) writeMarker(ctx.base, { storeId: storeId(db), files: plan2.legacyHashes, by: 'import' });
    // The report's "no owner" line stays in the report, not the log:
    // warnNoOwner (step 4) speaks for it, in the identity postures only
    // (A-49). In open, token-only and :memory: postures the command it
    // names cannot help; a seed boot makes admin the owner in step 4.
    for (const line of formatReport(report)) if (!line.startsWith('[store]   no owner')) log(line);
  } else {
    applyRepairs(db, ctx, guard, { log });
  }

  // step 4
  decision ??= seedDecision(storeView(db, ctx));
  let checked;
  try {
    checked = assertBootChecks(storeChecksInput(db, ctx, decision));
  } catch (e) {
    if (e instanceof BootRefusal) e.nothingMoved = report === null;
    throw e;
  }
  // Today's warning, printed whatever `silent` says: an open network bind is never quiet.
  if (checked.insecure) process.stderr.write(`${INSECURE_WARNING(ctx.host)}\n`);
  applySeedDecision(db, decision, { log, warn });
  recordIssuer(db, ctx);
  recordIdentityMode(db, ctx);
  warnNoOwner(db, ctx, warn);
  warnLeftBehind(db, ctx, warn);
  warnIgnoredJoinRole(db, ctx, warn, { imported: report !== null });

  // step 5
  importPacksOnce(db);
  return { db, ctx, decision, report };
}

