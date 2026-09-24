#!/usr/bin/env node
/**
 * server/test-tenancy.mjs — Stage 2 tenancy (docs/PRODUCTIZATION_PLAN.md),
 * always on over the store (docs/STORE_PLAN.md slice 2): workspace-per-org.
 * The isolation gate: two orgs in one workspace, and org B can read/write
 * NOTHING of org A — proven at the API level AND by filesystem-path
 * assertion, over every /api route (the cross-org route sweep, built from
 * the app's router so an unclassified route fails). Plus: org header
 * enforcement, owners, the bearer service-account path, /api/orgs +
 * /auth/me surfaces, per-org reset, journeys, a chunked body, the ORG-chip
 * rule, the flat→orgs/default import migration, the fail-closed posture for
 * a multi-org orgs.json without identity, and the default org at '.'
 * (whose root contains every other org's root).
 *
 * The open-posture regression (the default org at the workspace root, the
 * header ignored) is asserted by test-smoke; test-auth-local asserts the
 * flat stand-alone deployment's look.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { createServer, request } from 'node:http';
import { spawnSync } from 'node:child_process';

// Environment BEFORE the server module loads.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-tenancy-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = 'ci-token-tenancy-0123456789';
process.env.OBSERVOGRAM_API_TOKEN_LABEL = 'ci-bot';
process.env.OBSERVOGRAM_USERS_FILE = join(WORKSPACE, 'users.json');
delete process.env.OBSERVOGRAM_OIDC_ISSUER;
delete process.env.OBSERVOGRAM_SESSION_SECRET;
delete process.env.OBSERVOGRAM_AUTH;
delete process.env.TOMOGRAPH_AUTH;
// Hermetic store: each block's database lives in its own workspace.
const STORE_ENV = ['DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH'];
for (const k of STORE_ENV) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, report } = createHarness({ indent: '  ', truncate: 200 });

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { currentStore } = await import('./store/db.mjs');
const { getOrg } = await import('./store/orgs.mjs');
const { getMeta, getMetaJson } = await import('./store/meta.mjs');
const { listUsers } = await import('./store/users.mjs');
const { orgWorkspaceRoot } = await import('./tenancy.mjs');
const { orgChipModel } = await import('../studio/api.mjs');
const { GRAFANA_ALERT_RULE_TOOL, GRAFANA_DASHBOARD_TOOL } = await import('./deploy-helpers.mjs');
const { allKnownToolNames } = await import('../tools/lib/contracts/mcp-capabilities.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');

writeUsersFile({ users: {
  alice:   { name: 'Alice',   createdAt: 'test', password: hashPassword('alice-passw0rd!') },
  bob:     { name: 'Bob',     createdAt: 'test', password: hashPassword('bob-passw0rd!!') },
  mallory: { name: 'Mallory', createdAt: 'test', password: hashPassword('mallory-passw0rd') },
} }, process.env.OBSERVOGRAM_USERS_FILE);
writeOrgsFile({
  acme:  { name: 'Acme',  members: { alice: 'admin' } },
  bravo: { name: 'Bravo', members: { bob: 'admin' } },
}, join(WORKSPACE, 'orgs.json'));

const { start, app } = await import('./index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const base = `http://127.0.0.1:${srv.address().port}`;

const loginAt = async (root, username, password) => {
  const r = await fetch(`${root}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    redirect: 'manual',
  });
  const cookie = (r.headers.getSetCookie?.() || []).find(c => c.startsWith('observogram_session='))?.split(';')[0];
  if (!cookie) throw new Error(`login failed for ${username}: ${r.status}`);
  return cookie;
};
const login = (username, password) => loginAt(base, username, password);

const PACK_YAML = readFileSync('examples/demo-skeleton.pack.yaml', 'utf8');
const PAY_YAML = readFileSync(resolvePath(SPEC_DIR, 'examples/payment-service.pack.yaml'), 'utf8');

// A fake MCP advertising the deploy tools (deploy-helpers.mjs) and the
// registry's names (the snapshot reads) — no tool-name literal here.
async function startFakeMcp() {
  const toolNames = [...new Set([GRAFANA_ALERT_RULE_TOOL, GRAFANA_DASHBOARD_TOOL, ...allKnownToolNames()])];
  const calls = [];
  const mcp = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch { msg = {}; }
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'tenancy-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }));
    };
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp' } });
    if (msg.method === 'tools/list') return send({ tools: toolNames.map(name => ({ name })) });
    if (msg.method === 'tools/call') {
      calls.push(msg.params);
      return send({ content: [{ type: 'text', text: JSON.stringify({ ok: true, name: msg.params?.name }) }] });
    }
    return send({});
  });
  await new Promise(r => mcp.listen(0, '127.0.0.1', r));
  const a = mcp.address();
  return { url: `http://${a.address}:${a.port}/mcp`, calls, close: () => new Promise(r => mcp.close(r)) };
}

// Every file under `dir`, sorted, with its size and mtime: "nothing changed".
function tree(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${p} ${st.size} ${st.mtimeMs}`);
    }
  };
  walk(dir);
  return out;
}

// Every /api route of the app (Express 5.2.1: app.router.stack; nested
// routers through layer.handle.stack).
function apiRoutes() {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods).filter(k => layer.route.methods[k])) {
          if (String(layer.route.path).startsWith('/api/')) out.push(`${m.toUpperCase()} ${layer.route.path}`);
        }
      } else if (layer.handle?.stack) walk(layer.handle.stack);
    }
  };
  walk(app.router.stack);
  return [...new Set(out)];
}

// The catalogue and the stateless routes, and the live pack (deployment-
// wide until slice 3 moves it per org).
const DEPLOYMENT_GLOBAL = new Set([
  'GET /api/version', 'GET /api/orgs', 'GET /api/examples', 'GET /api/references', 'GET /api/library',
  'GET /api/library/:id', 'GET /api/library/requirements/:tier', 'POST /api/library/instantiate',
  'POST /api/library/compile', 'GET /api/maturity-rubric', 'GET /api/compile/targets', 'GET /api/deploy/matrix',
  'POST /api/refresh-live', 'GET /api/live-status',
]);

// alice, in `org`, creates the objects the sweep addresses: a registered
// pack, a deploy with a snapshot against the fake MCP, a verify on it, and
// a journey captured and run once.
async function createObjects({ root, cookie, org, journey, mcp, dir }) {
  const h = { Cookie: cookie, 'X-Observogram-CSRF': '1', 'X-Observogram-Org': org };
  let r = await fetch(`${root}/api/validate?source=pay.yaml`, { method: 'POST', headers: { ...h, 'Content-Type': 'text/yaml' }, body: PAY_YAML });
  let j = await r.json();
  const packId = j.registered?.id;
  assert(!!packId && existsSync(join(dir, 'packs', `${packId}.pack.yaml`)), `alice registers a pack into ${org}`, j.registered);
  r = await fetch(`${root}/api/packs/${packId}/deploy-bulk`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mcpUrl: mcp.url, targetProduct: 'grafana', targetVersion: '12', targetFolder: 'observability-pack',
      items: [
        { group: 'rules', flavor: 'prometheus', artifact: 'declared:0', scope: 'recording' },
        { group: 'dashboards', flavor: 'grafana', dashboardId: 'payment-overview' },
      ],
    }),
  });
  j = await r.json();
  const deployId = j.deployId;
  assert(r.status === 200 && !!deployId && existsSync(join(dir, 'snapshots', deployId, 'meta.json')),
    `alice deploys in ${org}: a deployId with a snapshot under its root`, [r.status, deployId]);
  r = await fetch(`${root}/api/deploys/${deployId}/verify`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'pending' }),
  });
  assert(r.status === 200, `alice records a verify in ${org}`, r.status, 200);
  r = await fetch(`${root}/api/journeys/capture`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: journey, packAId: packId, packBId: 'production-curated', env: 'prod' }),
  });
  j = await r.json();
  assert(j.ok === true && existsSync(join(dir, 'journeys', `${journey}.journey.yaml`)), `alice captures ${journey} in ${org}`, j);
  r = await fetch(`${root}/api/journeys/${journey}/run`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
  j = await r.json();
  assert(j.ok === true && existsSync(join(dir, 'runs')), `alice runs ${journey} once in ${org} (a runs/ record)`, j.error);
  return { packId, deployId, journey };
}

// The cross-org route sweep: `who` (a session in another org) calls every
// org-scoped route with the other org's ids; each answers 404, an empty
// list or "no snapshot", no MCP call is made, and nothing under `dir`
// changes. An /api route in neither table fails the test.
async function sweep({ root, cookie, who, ids, mcp, dir }) {
  const h = { Cookie: cookie, 'X-Observogram-CSRF': '1' };
  const call = async (method, path, body) => {
    const r = await fetch(`${root}${path}`, {
      method, headers: { ...h, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    const parse = () => { try { return JSON.parse(text); } catch { return null; } };
    return { status: r.status, json: parse() };
  };
  const { packId, deployId, journey } = ids;
  const p = encodeURIComponent(packId);
  const is404 = (label) => (r) => assert(r.status === 404, `${who}: ${label} → 404`, r.status, 404);
  const ORG_SCOPED = {
    'GET /api/packs': ['/api/packs', undefined, (r) => assert(r.status === 200 && !r.json.packs.some(x => x.id === packId), `${who}: GET /api/packs lacks the other org's pack`)],
    'GET /api/packs/:id': [`/api/packs/${p}`, undefined, is404('GET /api/packs/:id')],
    'GET /api/packs/:id/canonical': [`/api/packs/${p}/canonical`, undefined, is404('GET /api/packs/:id/canonical')],
    'GET /api/packs/:id/conformance': [`/api/packs/${p}/conformance`, undefined, is404('GET /api/packs/:id/conformance')],
    'GET /api/packs/:id/compile-catalog': [`/api/packs/${p}/compile-catalog`, undefined, is404('GET /api/packs/:id/compile-catalog')],
    'GET /api/packs/:id/compile-artifact': [`/api/packs/${p}/compile-artifact?group=rules`, undefined, is404('GET /api/packs/:id/compile-artifact')],
    'GET /api/packs/:id/export.zip': [`/api/packs/${p}/export.zip`, undefined, is404('GET /api/packs/:id/export.zip')],
    'GET /api/packs/:id/compile/:target': [`/api/packs/${p}/compile/prometheus-rules`, undefined, is404('GET /api/packs/:id/compile/:target')],
    'GET /api/diff': [`/api/diff?a=${p}&b=${p}`, undefined, is404('GET /api/diff')],
    'POST /api/packs/:id/deploy-bulk': [`/api/packs/${p}/deploy-bulk`, { mcpUrl: mcp.url, items: [{ group: 'dashboards', flavor: 'grafana', dashboardId: 'payment-overview' }] }, is404('POST /api/packs/:id/deploy-bulk')],
    'POST /api/packs/:id/deploy/:target': [`/api/packs/${p}/deploy/grafana-dashboard`, { mcpUrl: mcp.url }, is404('POST /api/packs/:id/deploy/:target')],
    'POST /api/packs/:id/retrofeed': [`/api/packs/${p}/retrofeed`, {}, is404('POST /api/packs/:id/retrofeed')],
    'GET /api/deploys': ['/api/deploys?limit=500', undefined, (r) => assert(r.status === 200 && !r.json.deploys.some(d => d.deployId === deployId), `${who}: GET /api/deploys lacks the other org's deployId`)],
    'GET /api/deploys/:deployId/rollback-plan': [`/api/deploys/${deployId}/rollback-plan`, undefined, (r) => assert(r.json?.canRollback === false && (r.json.plan || []).length === 0, `${who}: rollback-plan of the other org's deploy → no snapshot`, r.json)],
    'POST /api/deploys/:deployId/rollback': [`/api/deploys/${deployId}/rollback`, { mcpUrl: mcp.url }, (r) => assert(r.status === 404 || r.status === 409, `${who}: rollback of the other org's deploy → 404/409`, r.status, '404|409')],
    'POST /api/deploys/:deployId/verify': [`/api/deploys/${deployId}/verify`, { outcome: 'verified' }, is404('POST /api/deploys/:deployId/verify')],
    'GET /api/journeys': ['/api/journeys', undefined, (r) => assert(r.status === 200 && !r.json.journeys.some(x => x.name === journey), `${who}: GET /api/journeys lacks the other org's journey`)],
    'GET /api/journeys/:name/runs': [`/api/journeys/${journey}/runs`, undefined, (r) => assert(r.status === 404 || (r.status === 200 && (r.json.runs || []).length === 0), `${who}: runs of the other org's journey → empty`, r.json)],
    'GET /api/journeys/:name/schedule': [`/api/journeys/${journey}/schedule`, undefined, is404('GET /api/journeys/:name/schedule')],
    'POST /api/journeys/:name/run': [`/api/journeys/${journey}/run`, {}, is404('POST /api/journeys/:name/run')],
    // Writes that take no id: a plain call lands in the caller's own org.
    'POST /api/journeys/capture': ['/api/journeys/capture', { name: `${journey}-x`, packAId: packId, packBId: packId }, (r) => assert(r.json?.ok !== true, `${who}: capture over the other org's pack id is refused`, r.status)],
    'POST /api/validate': ['/api/validate', { not: 'a pack' }, () => {}],
    'POST /api/crawl': ['/api/crawl', {}, () => {}],
    'POST /api/crawl-github': ['/api/crawl-github', {}, () => {}],
    'POST /api/draft-from-mcp': ['/api/draft-from-mcp', {}, () => {}],
    'POST /api/library/register': ['/api/library/register', {}, () => {}],
    'DELETE /api/uploads': ['/api/uploads', undefined, (r) => assert(r.status === 200, `${who}: DELETE /api/uploads clears only the caller's org`, r.status, 200)],
  };
  const before = tree(dir);
  const mcpCalls = mcp.calls.length;
  const routes = apiRoutes();
  const unclassified = routes.filter(k => !DEPLOYMENT_GLOBAL.has(k) && !ORG_SCOPED[k]);
  assert(unclassified.length === 0, 'every /api route is classified org-scoped or deployment-global', unclassified, []);
  // DELETE /api/uploads last: the reads above must see the caller's own registry.
  const order = Object.keys(ORG_SCOPED).filter(k => routes.includes(k)).sort((a, b) => (a === 'DELETE /api/uploads') - (b === 'DELETE /api/uploads'));
  for (const key of order) {
    const [path, body, check] = ORG_SCOPED[key];
    check(await call(key.split(' ')[0], path, body));
  }
  assert(mcp.calls.length === mcpCalls, `${who}: the sweep made no MCP call`, mcp.calls.length - mcpCalls, 0);
  assert(JSON.stringify(tree(dir)) === JSON.stringify(before), `${who}: nothing under ${dir} changed`);
}

const mcp = await startFakeMcp();

try {
  // ---- the import: orgs, roots, the default org, owners ----
  {
    const db = currentStore();
    assert(getOrg(db, 'acme')?.root === 'orgs/acme' && getOrg(db, 'bravo')?.root === 'orgs/bravo', 'orgs acme and bravo imported at orgs/<id>');
    assert(getMeta(db, 'default_org') === 'acme', 'default_org is acme', getMeta(db, 'default_org'), 'acme');
    const owners = listUsers(db).filter(u => u.isOwner).map(u => u.login);
    assert(JSON.stringify(owners) === JSON.stringify(['alice']), 'owners are the default org\'s admins: [alice]', owners, ['alice']);
  }

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

  // ---- owners: any live org, landing in their first membership ----
  r = await fetch(`${base}/api/packs`, { headers: { Cookie: alice, 'X-Observogram-Org': 'bravo' } });
  assert(r.status === 200 && r.headers.get('x-observogram-org') === 'bravo', 'alice (owner) may request bravo → 200, echo bravo', [r.status, r.headers.get('x-observogram-org')], [200, 'bravo']);

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

  // ---- journeys: loaded by name only, in the caller's org ----
  const pay = await (await fetch(`${base}/api/validate?source=pay.yaml`, {
    method: 'POST', headers: { Cookie: alice, 'Content-Type': 'text/yaml', 'X-Observogram-CSRF': '1' }, body: PAY_YAML,
  })).json();
  r = await fetch(`${base}/api/journeys/capture`, {
    method: 'POST', headers: { Cookie: alice, 'Content-Type': 'application/json', 'X-Observogram-CSRF': '1' },
    body: JSON.stringify({ name: 'acme-j', packAId: pay.registered?.id, packBId: 'production-curated', env: 'prod' }),
  });
  j = await r.json();
  const acmeJourney = join(WORKSPACE, 'orgs', 'acme', 'journeys', 'acme-j.journey.yaml');
  assert(j.ok === true && existsSync(acmeJourney), 'alice captures acme-j into orgs/acme/journeys/', j);
  r = await fetch(`${base}/api/journeys`, { headers: { Cookie: bob } });
  j = await r.json();
  assert(!j.journeys.some(x => x.name === 'acme-j'), "bob's GET /api/journeys lacks acme-j");
  const runsBefore = [...tree(join(WORKSPACE, 'orgs', 'acme', 'runs')), ...tree(join(WORKSPACE, 'orgs', 'bravo', 'runs'))];
  for (const name of ['acme-j', '../../orgs/acme/journeys/acme-j.journey.yaml', acmeJourney]) {
    r = await fetch(`${base}/api/journeys/${encodeURIComponent(name)}/run`, {
      method: 'POST', headers: { Cookie: bob, 'Content-Type': 'application/json', 'X-Observogram-CSRF': '1' }, body: '{}',
    });
    assert(r.status === 404, `bob POST /api/journeys/${name.length > 40 ? '<path>' : name}/run → 404`, r.status, 404);
  }
  const runsAfter = [...tree(join(WORKSPACE, 'orgs', 'acme', 'runs')), ...tree(join(WORKSPACE, 'orgs', 'bravo', 'runs'))];
  assert(JSON.stringify(runsAfter) === JSON.stringify(runsBefore), 'no new file under orgs/acme/runs/ or orgs/bravo/runs/');
  r = await fetch(`${base}/api/journeys/acme-j/schedule`, { headers: { Cookie: bob } });
  assert(r.status === 404, "bob's GET /api/journeys/acme-j/schedule → 404", r.status, 404);
  r = await fetch(`${base}/api/journeys/acme-j/schedule`, { headers: { Cookie: alice } });
  j = await r.json();
  assert(r.ok && /value: \/workspace\/orgs\/acme\n/.test(j.snippets?.k8s || ''), "alice's k8s snippet sets OBSERVOGRAM_WORKSPACE=/workspace/orgs/acme", (j.snippets?.k8s || '').slice(0, 120));
  assert((j.snippets?.cron || '').includes(join(WORKSPACE, 'orgs', 'acme')), "alice's cron line carries <WORKSPACE>/orgs/acme", j.snippets?.cron);

  // ---- a chunked body keeps its org context through the body parser ----
  {
    const acmeBefore = tree(join(WORKSPACE, 'orgs', 'acme'));
    const body = PACK_YAML.replace('demo-skeleton', 'chunky-skeleton') + '\n#' + 'x'.repeat(200 * 1024) + '\n';
    const buf = Buffer.from(body);
    const third = Math.ceil(buf.length / 3);
    const got = await new Promise((resolveReq, rejectReq) => {
      const req = request(`${base}/api/validate?source=chunky.yaml`, {
        method: 'POST',
        headers: { Cookie: bob, 'Content-Type': 'text/yaml', 'X-Observogram-CSRF': '1', 'Content-Length': buf.length },
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => resolveReq({ status: res.statusCode, json: JSON.parse(raw) }));
      });
      req.on('error', rejectReq);
      req.write(buf.subarray(0, third));
      setTimeout(() => {
        req.write(buf.subarray(third, 2 * third));
        setTimeout(() => { req.end(buf.subarray(2 * third)); }, 30);
      }, 30);
    });
    const id = got.json.registered?.id;
    assert(got.status === 200 && !!id && existsSync(join(WORKSPACE, 'orgs', 'bravo', 'packs', `${id}.pack.yaml`)),
      "a 200 KB body in three delayed chunks registers into orgs/bravo/packs", [got.status, id]);
    assert(JSON.stringify(tree(join(WORKSPACE, 'orgs', 'acme'))) === JSON.stringify(acmeBefore)
      && !existsSync(join(WORKSPACE, 'packs')), 'nothing of the chunked upload landed under orgs/acme/ or the base');
  }

  // ---- outside a context ----
  {
    let threw = false;
    try { orgWorkspaceRoot(); } catch { threw = true; }
    assert(threw, 'orgWorkspaceRoot() outside runWithOrg throws');
  }

  // ---- the cross-org route sweep: bob (bravo) against acme's objects ----
  const acmeIds = await createObjects({ root: base, cookie: alice, org: 'acme', journey: 'acme-sweep', mcp, dir: join(WORKSPACE, 'orgs', 'acme') });
  await sweep({ root: base, cookie: bob, who: 'bob (bravo)', ids: acmeIds, mcp, dir: join(WORKSPACE, 'orgs', 'acme') });
} finally {
  await new Promise(res => srv.close(res));
}

// ---- the ORG chip rule (studio/api.mjs, pure) ----
{
  const d = { id: 'default', name: 'Default', role: 'admin', default: true };
  const a = { id: 'acme', name: 'Acme', role: 'admin', default: false };
  assert(orgChipModel([]).kind === 'none', 'orgChipModel: no org → none');
  assert(orgChipModel([d]).kind === 'none', 'orgChipModel: the default org only → none');
  assert(orgChipModel([a]).kind === 'label' && orgChipModel([a]).active.id === 'acme', 'orgChipModel: one org that is not the default → label');
  assert(orgChipModel([d, a]).kind === 'switcher', 'orgChipModel: two orgs → switcher');
  assert(orgChipModel([d, a], 'acme').active.id === 'acme', 'orgChipModel: active is activeId when it is one of them');
  assert(orgChipModel([d, a], 'nope').active.id === 'default', 'orgChipModel: else the first');
}

// ---- the import migration: flat workspace → orgs/default/ ----
{
  const WS2 = mkdtempSync(join(tmpdir(), 'observogram-tenancy-mig-'));
  mkdirSync(join(WS2, 'packs'), { recursive: true });
  writeFileSync(join(WS2, 'packs', 'flat-pack.pack.yaml'), PACK_YAML);
  writeFileSync(join(WS2, 'packs', 'index.json'), JSON.stringify({ 'flat-pack': { label: 'Flat', source: 'upload', createdAt: 1, lastUsedAt: 1 } }));
  writeFileSync(join(WS2, 'deploys.jsonl'), JSON.stringify({ type: 'deploy', deployId: 'dep_1' }) + '\n');

  process.env.OBSERVOGRAM_WORKSPACE = WS2;
  process.env.OBSERVOGRAM_USERS_FILE = join(WS2, 'users.json');
  writeUsersFile({ users: { alice: { createdAt: 'test', password: hashPassword('alice-passw0rd!') } } }, process.env.OBSERVOGRAM_USERS_FILE);
  writeOrgsFile({ acme: { name: 'Acme', members: { alice: 'admin' } } }, join(WS2, 'orgs.json'));   // note: no 'default' declared

  const { resetWorkspaceCache } = await import('./workspace.mjs');
  resetWorkspaceCache();
  const srv2 = await start({ port: 0, host: '127.0.0.1', silent: true });
  try {
    assert(existsSync(join(WS2, 'orgs', 'default', 'packs', 'flat-pack.pack.yaml')),
      'migration moved the flat pack to orgs/default/packs/');
    assert(existsSync(join(WS2, 'orgs', 'default', 'deploys.jsonl')),
      'migration moved deploys.jsonl to orgs/default/');
    assert(!existsSync(join(WS2, 'packs')), 'the flat packs/ dir is gone after migration');
    const db = currentStore();
    assert(getOrg(db, 'default')?.root === 'orgs/default' && getMeta(db, 'default_org') === 'default',
      "the store records org 'default' at orgs/default as the default org", [getOrg(db, 'default')?.root, getMeta(db, 'default_org')]);
    assert(Object.hasOwn(JSON.parse(readFileSync(join(WS2, 'orgs.json'), 'utf8')), 'default'),
      "orgs.json gained 'default' because the migration moved data (the pre-store file contract)");
    assert(getMetaJson(db, 'import_report')?.noOwner === true && !listUsers(db).some(u => u.isOwner),
      'no owner: the default org had no admin member (report noOwner)');

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

// ---- fail closed: a multi-org orgs.json without identity ----
{
  const WS3 = mkdtempSync(join(tmpdir(), 'observogram-tenancy-noid-'));
  process.env.OBSERVOGRAM_WORKSPACE = WS3;
  process.env.OBSERVOGRAM_USERS_FILE = join(WS3, 'users.json');   // does not exist → no identity
  writeOrgsFile({ solo: { name: 'Solo', members: {} }, duo: { name: 'Duo', members: {} } }, join(WS3, 'orgs.json'));
  const orgsBytes = readFileSync(join(WS3, 'orgs.json'));
  let rejected = null;
  try { await start({ port: 0, host: '127.0.0.1', silent: true }); }
  catch (e) { rejected = e; }
  assert(rejected !== null && /orgs\.json.*identity|identity.*orgs\.json/is.test(rejected?.message || ''),
    'a two-org orgs.json without identity refuses to start with a clear message', rejected?.message?.slice(0, 80));
  assert(getMeta(currentStore(), 'import_done') === null, 'the refused boot imported nothing (no import_done)');
  assert(readFileSync(join(WS3, 'orgs.json')).equals(orgsBytes), 'orgs.json is byte-identical after the refusal');
  rmSync(WS3, { recursive: true, force: true });
}

// ---- a one-org orgs.json with only a bearer boots token-only ----
{
  const WS3B = mkdtempSync(join(tmpdir(), 'observogram-tenancy-solo-'));
  process.env.OBSERVOGRAM_WORKSPACE = WS3B;
  process.env.OBSERVOGRAM_USERS_FILE = join(WS3B, 'users.json');
  writeOrgsFile({ solo: { name: 'Solo', members: {} } }, join(WS3B, 'orgs.json'));
  const srv3 = await start({ port: 0, host: '127.0.0.1', silent: true });
  const base3 = `http://127.0.0.1:${srv3.address().port}`;
  try {
    let r = await fetch(`${base3}/api/packs`);
    assert(r.status === 200 && r.headers.get('x-observogram-org') === 'solo', 'one-org orgs.json + bearer: anonymous GET 200, echo solo', [r.status, r.headers.get('x-observogram-org')], [200, 'solo']);
    r = await fetch(`${base3}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body: PACK_YAML });
    assert(r.status === 401 && (r.headers.get('www-authenticate') || '').includes('Bearer'), 'one-org orgs.json + bearer: anonymous POST 401 + WWW-Authenticate', r.status, 401);
    r = await fetch(`${base3}/api/validate`, {
      method: 'POST', headers: { 'Content-Type': 'text/yaml', Authorization: `Bearer ${process.env.OBSERVOGRAM_API_TOKEN}` }, body: PACK_YAML,
    });
    const j = await r.json();
    assert(r.ok && j.ok === true && existsSync(join(WS3B, 'orgs', 'solo', 'packs', `${j.registered?.id}.pack.yaml`)), 'one-org orgs.json + bearer: bearer POST works, into orgs/solo');
  } finally {
    await new Promise(res => srv3.close(res));
    rmSync(WS3B, { recursive: true, force: true });
  }
}

// ---- the default org at '.' never reads inside orgs/ ----
{
  const WS4 = mkdtempSync(join(tmpdir(), 'observogram-tenancy-root-'));
  process.env.OBSERVOGRAM_WORKSPACE = WS4;
  process.env.OBSERVOGRAM_USERS_FILE = join(WS4, 'users.json');
  writeUsersFile({ users: { carlos: { createdAt: 'test', password: hashPassword('carlos-passw0rd') } } }, process.env.OBSERVOGRAM_USERS_FILE);
  const srv4 = await start({ port: 0, host: '127.0.0.1', silent: true });
  const base4 = `http://127.0.0.1:${srv4.address().port}`;
  // The CLIs against the running server's store: an explicit env, spawned
  // as process.execPath with the script (never npm run).
  const env = { ...process.env };
  for (const k of STORE_ENV) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  const cli = (script, args, input) => spawnSync(process.execPath, [script, ...args], { env, input, encoding: 'utf8' });
  try {
    assert(getOrg(currentStore(), 'default')?.root === '.', 'a flat stand-alone workspace: the default org at .');
    let c = cli('tools/user-admin.mjs', ['add', 'alice', '--password-stdin'], 'alice-passw0rd!\n');
    assert(c.status === 0, 'npm run users -- add alice (spawned) succeeds', c.stderr || c.stdout);
    c = cli('tools/org-admin.mjs', ['create', 'delta', '--admin', 'alice']);
    assert(c.status === 0 && getOrg(currentStore(), 'delta')?.root === 'orgs/delta', 'npm run orgs -- create delta --admin alice (spawned): delta at orgs/delta', c.stderr || c.stdout);

    const alice = await loginAt(base4, 'alice', 'alice-passw0rd!');
    const carlos = await loginAt(base4, 'carlos', 'carlos-passw0rd');
    const deltaDir = join(WS4, 'orgs', 'delta');
    const ids = await createObjects({ root: base4, cookie: alice, org: 'delta', journey: 'delta-j', mcp, dir: deltaDir });
    let r = await fetch(`${base4}/api/packs`, { headers: { Cookie: carlos } });
    let j = await r.json();
    assert(r.headers.get('x-observogram-org') === 'default' && !j.packs.some(p => p.id === ids.packId), "carlos's /api/packs in default never lists delta's pack");
    r = await fetch(`${base4}/api/journeys`, { headers: { Cookie: carlos } });
    j = await r.json();
    assert(!j.journeys.some(x => x.name === ids.journey), "carlos's /api/journeys in default never lists delta's journey");
    await sweep({ root: base4, cookie: carlos, who: 'carlos (default at .)', ids, mcp, dir: deltaDir });
  } finally {
    await new Promise(res => srv4.close(res));
    rmSync(WS4, { recursive: true, force: true });
  }
}

await mcp.close();
rmSync(WORKSPACE, { recursive: true, force: true });
report('tenancy');
