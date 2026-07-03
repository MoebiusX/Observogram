#!/usr/bin/env node
/**
 * server/test-tenancy.mjs — Stage 2 tenancy (docs/PRODUCTIZATION_PLAN.md):
 * workspace-per-org. The isolation gate: two orgs in one workspace, and
 * org B can read/write NOTHING of org A — proven at the API level AND by
 * filesystem-path assertion. Plus: org header enforcement, the bearer
 * service-account path, /api/orgs + /auth/me surfaces, per-org reset,
 * the flat→orgs/default boot migration, and the fail-closed posture for
 * orgs.json without identity.
 *
 * Local-mode regression (no orgs.json → byte-identical flat workspace)
 * is asserted by every OTHER suite in `npm test` — none of them
 * configure tenancy.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Environment BEFORE the server module loads.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-tenancy-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = 'ci-token-tenancy-0123456789';
process.env.OBSERVOGRAM_API_TOKEN_LABEL = 'ci-bot';
process.env.OBSERVOGRAM_USERS_FILE = join(WORKSPACE, 'users.json');
delete process.env.OBSERVOGRAM_OIDC_ISSUER;
delete process.env.OBSERVOGRAM_SESSION_SECRET;

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 200 });

const { hashPassword, writeUsers } = await import('./auth.mjs');
const { writeOrgs } = await import('./tenancy.mjs');

writeUsers({ users: {
  alice:   { name: 'Alice',   createdAt: 'test', password: hashPassword('alice-passw0rd!') },
  bob:     { name: 'Bob',     createdAt: 'test', password: hashPassword('bob-passw0rd!!') },
  mallory: { name: 'Mallory', createdAt: 'test', password: hashPassword('mallory-passw0rd') },
} });
writeOrgs({
  acme:  { name: 'Acme',  members: { alice: 'admin' } },
  bravo: { name: 'Bravo', members: { bob: 'admin' } },
});

const { start } = await import('./index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const base = `http://127.0.0.1:${srv.address().port}`;

const login = async (username, password) => {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${username}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  const cookie = (r.headers.getSetCookie?.() || []).find(c => c.startsWith('observogram_session='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed for ${username}: ${r.status}`);
  return cookie;
};

const PACK_YAML = readFileSync('examples/demo-skeleton.pack.yaml', 'utf8');

try {
  const alice = await login('alice', 'alice-passw0rd!');
  const bob = await login('bob', 'bob-passw0rd!!');

  // ---- surfaces: /auth/me + /api/orgs ----
  let r = await fetch(`${base}/auth/me`, { headers: { Cookie: alice } });
  let j = await r.json();
  assert(Array.isArray(j.orgs) && j.orgs.length === 1 && j.orgs[0].id === 'acme' && j.orgs[0].role === 'admin',
    '/auth/me carries org memberships', JSON.stringify(j.orgs));

  r = await fetch(`${base}/api/orgs`, { headers: { Cookie: alice } });
  j = await r.json();
  assert(j.tenancy === true && j.active === 'acme' && j.orgs[0]?.id === 'acme',
    '/api/orgs reports memberships + resolved active org', JSON.stringify(j));

  // ---- alice uploads a pack into acme ----
  r = await fetch(`${base}/api/validate?source=demo.yaml`, {
    method: 'POST',
    headers: { Cookie: alice, 'Content-Type': 'text/yaml', 'X-Observogram-CSRF': '1' },
    body: PACK_YAML,
  });
  j = await r.json();
  assert(j.ok === true && j.registered?.id, 'alice registers a pack (org resolved from membership, no header needed)', JSON.stringify(j.registered));
  const packId = j.registered.id;

  // ---- API-level isolation ----
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: alice } });
  j = await r.json();
  assert(j.packs.some(p => p.id === packId), "alice's catalog lists her pack");

  r = await fetch(`${base}/api/packs`, { headers: { Cookie: bob } });
  j = await r.json();
  assert(!j.packs.some(p => p.id === packId), "bob's catalog does NOT list acme's pack");

  r = await fetch(`${base}/api/packs/${packId}/conformance`, { headers: { Cookie: bob } });
  assert(r.status === 404, "bob addressing acme's pack id directly → 404", r.status, 404);

  r = await fetch(`${base}/api/packs`, { headers: { Cookie: bob, 'X-Observogram-Org': 'acme' } });
  assert(r.status === 403, 'bob requesting org acme explicitly → 403 (membership enforced)', r.status, 403);

  r = await fetch(`${base}/api/packs`, { headers: { Cookie: alice, 'X-Observogram-Org': 'acme' } });
  assert(r.ok && r.headers.get('x-observogram-org') === 'acme', 'explicit org header works for members and is echoed', r.headers.get('x-observogram-org'), 'acme');

  // Rebrand shim: pre-rebrand clients still send the old header spelling.
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: alice, 'X-Tomograph-Org': 'acme' } });
  assert(r.ok && r.headers.get('x-observogram-org') === 'acme', 'legacy X-Tomograph-Org header is still honored', r.headers.get('x-observogram-org'), 'acme');

  // ---- filesystem-path isolation ----
  assert(existsSync(join(WORKSPACE, 'orgs', 'acme', 'packs', `${packId}.pack.yaml`)),
    "the pack file lives under orgs/acme/packs/");
  const bravoPacks = join(WORKSPACE, 'orgs', 'bravo', 'packs');
  const bravoFiles = existsSync(bravoPacks) ? readdirSync(bravoPacks).filter(f => f.endsWith('.pack.yaml')) : [];
  assert(bravoFiles.length === 0, "nothing of acme's leaked into orgs/bravo/", bravoFiles.join(','), 'empty');
  assert(!existsSync(join(WORKSPACE, 'packs', `${packId}.pack.yaml`)),
    'nothing was written to the flat (deployment-level) workspace');

  // ---- per-org reset: alice's reset must not touch bravo ----
  r = await fetch(`${base}/api/validate?source=bob.yaml`, {
    method: 'POST',
    headers: { Cookie: bob, 'Content-Type': 'text/yaml', 'X-Observogram-CSRF': '1' },
    body: PACK_YAML.replace('demo-skeleton', 'bob-skeleton'),
  });
  j = await r.json();
  const bobPackId = j.registered?.id;
  assert(!!bobPackId, 'bob registers his own pack in bravo');

  r = await fetch(`${base}/api/uploads`, { method: 'DELETE', headers: { Cookie: alice, 'X-Observogram-CSRF': '1' } });
  assert(r.ok, "alice resets HER uploads");
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: bob } });
  j = await r.json();
  assert(j.packs.some(p => p.id === bobPackId), "alice's reset did not touch bravo's registry");
  assert(existsSync(join(WORKSPACE, 'orgs', 'bravo', 'packs', `${bobPackId}.pack.yaml`)),
    "bravo's pack file survived acme's reset");

  // ---- the bearer service account ----
  const bearer = { Authorization: `Bearer ${process.env.OBSERVOGRAM_API_TOKEN}` };
  r = await fetch(`${base}/api/packs`, { headers: { ...bearer, 'X-Observogram-Org': 'bravo' } });
  j = await r.json();
  assert(r.ok && j.packs.some(p => p.id === bobPackId), 'bearer + org header reads that org');
  r = await fetch(`${base}/api/packs`, { headers: { ...bearer, 'X-Observogram-Org': 'nonexistent' } });
  assert(r.status === 403, 'bearer targeting an unknown org → 403', r.status, 403);
  r = await fetch(`${base}/api/orgs`, { headers: bearer });
  j = await r.json();
  assert(j.orgs.length === 2 && j.orgs.every(o => o.role === 'service-account'), 'bearer sees all orgs as service-account');

  // ---- a user with no membership sees nothing ----
  const mallory = await login('mallory', 'mallory-passw0rd');
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: mallory } });
  assert(r.status === 403, 'no org membership → 403 with guidance', r.status, 403);
} finally {
  await new Promise(res => srv.close(res));
}

// ---- boot migration: flat workspace → orgs/default/ ----
{
  const WS2 = mkdtempSync(join(tmpdir(), 'observogram-tenancy-mig-'));
  mkdirSync(join(WS2, 'packs'), { recursive: true });
  writeFileSync(join(WS2, 'packs', 'flat-pack.pack.yaml'), PACK_YAML);
  writeFileSync(join(WS2, 'packs', 'index.json'), JSON.stringify({ 'flat-pack': { label: 'Flat', source: 'upload', createdAt: 1, lastUsedAt: 1 } }));
  writeFileSync(join(WS2, 'deploys.jsonl'), JSON.stringify({ type: 'deploy', deployId: 'dep_1' }) + '\n');

  process.env.OBSERVOGRAM_WORKSPACE = WS2;
  process.env.OBSERVOGRAM_USERS_FILE = join(WS2, 'users.json');
  const { writeUsers: writeUsers2 } = await import('./auth.mjs');
  writeUsers2({ users: { alice: { createdAt: 'test', password: hashPassword('alice-passw0rd!') } } });
  const { writeOrgs: writeOrgs2, readOrgs: readOrgs2 } = await import('./tenancy.mjs');
  writeOrgs2({ acme: { name: 'Acme', members: { alice: 'admin' } } });   // note: no 'default' declared

  const { resetWorkspaceCache } = await import('./workspace.mjs');
  resetWorkspaceCache();
  const srv2 = await start({ port: 0, host: '127.0.0.1', silent: true });
  try {
    assert(existsSync(join(WS2, 'orgs', 'default', 'packs', 'flat-pack.pack.yaml')),
      'migration moved the flat pack to orgs/default/packs/');
    assert(existsSync(join(WS2, 'orgs', 'default', 'deploys.jsonl')),
      'migration moved deploys.jsonl to orgs/default/');
    assert(!existsSync(join(WS2, 'packs')), 'the flat packs/ dir is gone after migration');
    assert(Object.hasOwn(readOrgs2(), 'default'), "migration ensured a 'default' org exists in orgs.json");

    // The migrated state is reachable — the bearer can read org default.
    const base2 = `http://127.0.0.1:${srv2.address().port}`;
    const r2 = await fetch(`${base2}/api/packs`, {
      headers: { Authorization: `Bearer ${process.env.OBSERVOGRAM_API_TOKEN}`, 'X-Observogram-Org': 'default' },
    });
    const j2 = await r2.json();
    assert(r2.ok && j2.packs.some(p => p.id === 'flat-pack'), 'the migrated pack is served from orgs/default/');
  } finally {
    await new Promise(res => srv2.close(res));
    rmSync(WS2, { recursive: true, force: true });
  }
}

// ---- fail closed: orgs.json without identity ----
{
  const WS3 = mkdtempSync(join(tmpdir(), 'observogram-tenancy-noid-'));
  process.env.OBSERVOGRAM_WORKSPACE = WS3;
  process.env.OBSERVOGRAM_USERS_FILE = join(WS3, 'users.json');   // does not exist → identity OFF
  const { writeOrgs: writeOrgs3 } = await import('./tenancy.mjs');
  writeOrgs3({ acme: { name: 'Acme', members: {} } });
  let rejected = null;
  try { await start({ port: 0, host: '127.0.0.1', silent: true }); }
  catch (e) { rejected = e; }
  assert(rejected !== null && /orgs\.json.*identity|identity.*orgs\.json/is.test(rejected?.message || ''),
    'orgs.json without identity refuses to start with a clear message', rejected?.message?.slice(0, 80));
  rmSync(WS3, { recursive: true, force: true });
}

rmSync(WORKSPACE, { recursive: true, force: true });
report('tenancy');
