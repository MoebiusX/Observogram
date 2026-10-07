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
import { endpointIdFor } from './fixtures/fake-mcp.mjs';

// Hermetic (§0): a developer shell's store, identity, taxonomy, transport-hook
// or brand variables never reach this process's imports — the children's STRIP
// list (server/fixtures/serve-child.mjs imports no server code), both
// spellings, BEFORE the suite sets its own posture and before any server
// module loads (every server import below is dynamic: a static one is
// hoisted above this line). server/test-hermetic-suites.mjs guards the shape.
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
// Environment BEFORE the server module loads; each block's database lives in
// its own workspace.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-tenancy-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = 'ci-token-tenancy-0123456789';
process.env.OBSERVOGRAM_API_TOKEN_LABEL = 'ci-bot';
process.env.OBSERVOGRAM_USERS_FILE = join(WORKSPACE, 'users.json');
// The MCP origin allowlist per org (server/mcp-target-policy.mjs): each org
// lists only its own sweep origin, where its endpoint sends a server-held token.
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];
process.env.OBSERVOGRAM_ORG_ACME_MCP_ORIGINS = 'https://acme.mcp.test';
process.env.OBSERVOGRAM_ORG_DELTA_MCP_ORIGINS = 'https://delta.mcp.test';
// acme's configured snapshot scope (server/live-jobs.mjs): never served to another org.
process.env.OBSERVOGRAM_ORG_ACME_SNAPSHOT_METRIC_PREFIXES = 'acme_';

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, report } = createHarness({ indent: '  ', truncate: 200 });

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { currentStore, closeStore } = await import('./store/db.mjs');
const { getOrg } = await import('./store/orgs.mjs');
const { getMeta, getMetaJson } = await import('./store/meta.mjs');
const { listUsers } = await import('./store/users.mjs');
const { listMembershipsForUser } = await import('./store/memberships.mjs');
const { orgWorkspaceRoot, runWithOrg } = await import('./tenancy.mjs');
const { listPacks } = await import('./store/packs.mjs');
const { listServices } = await import('./store/services.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { routeEntry } = await import('./route-table.mjs');
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

// The catalogue and the stateless routes. (The live pack is per org since
// STORE_PLAN slice 3: its two routes are org-scoped below.)
const DEPLOYMENT_GLOBAL = new Set([
  'GET /api/version', 'GET /api/orgs', 'GET /api/examples', 'GET /api/taxonomy', 'GET /api/mcp-settings', 'GET /api/references', 'GET /api/library',
  'GET /api/library/:id', 'GET /api/library/requirements/:tier', 'POST /api/library/instantiate',
  'POST /api/library/compile', 'GET /api/maturity-rubric', 'GET /api/compile/targets', 'GET /api/deploy/matrix',
]);

// The owner routes (STORE_PLAN slice 3b): the deployment's users, orgs and
// join role, whatever org the request names — not swept here (bob, a
// non-owner, is refused 403; carlos is an owner, who may act in any org).
// The AuthZ matrix (server/test-authz.mjs) covers them.
const OWNER_ONLY = new Set([
  'GET /api/admin/users', 'POST /api/admin/users', 'POST /api/admin/users/:id/disable', 'POST /api/admin/users/:id/enable',
  'POST /api/admin/users/:id/password', 'POST /api/admin/users/:id/signout', 'PUT /api/admin/users/:id/owner',
  'GET /api/admin/orgs', 'POST /api/admin/orgs', 'DELETE /api/admin/orgs/:id', 'GET /api/admin/join-role', 'PUT /api/admin/join-role',
]);

// The audit's newest seq, and the rows written after `seq` (oldest first) as
// [action, actor, orgId, targetId, detail] — STORE_PLAN slice 5: the deploy
// routes write their row after the deploys.jsonl line, the journey routes
// after the journey file and the run, in the request's org, by the
// principal's login; each action must be one the route table lists for its
// route, so a typo in the table fails here.
const auditSeq = () => listAudit(currentStore(), { limit: 1 })[0]?.seq ?? 0;
const rowsAfter = (seq) => listAudit(currentStore(), { limit: 1000 }).filter(r => r.seq > seq).reverse()
  .map(r => [r.action, r.actor, r.orgId, r.targetId, r.detail]);
const listedFor = (key, rows) => rows.every(([action]) => routeEntry(key).audit.includes(action));

// alice, in `org`, creates the objects the sweep addresses: a registered
// pack, a deploy with a snapshot against the fake MCP (its deploy.bulk row),
// a verify on it (its deploy.verify row), a journey captured and run once
// (its journey.capture and journey.run rows),
// the org's live pack (planted; the route's own write into a created org is
// the default-at-'.' block's), and — STORE_PLAN slice 4 — a service record
// with one environment and an MCP endpoint record (its variable named with
// the org's own prefix) through the API (rows in the store, nothing under
// `dir`).
async function createObjects({ root, cookie, org, journey, mcp, dir }) {
  const h = { Cookie: cookie, 'X-Observogram-CSRF': '1', 'X-Observogram-Org': org };
  mkdirSync(join(dir, 'live'), { recursive: true });
  writeFileSync(join(dir, 'live', 'production-live.pack.yaml'), [
    'apiVersion: observability.pack/v1', 'kind: ObservabilityPack', 'metadata:', `  name: ${org}-live`, '  annotations:',
    `    mcp.refreshedAt: "2026-06-06T00:00:00Z"`, `    mcp.url: "https://${org}.mcp.test/observability"`, 'spec: {}', '',
  ].join('\n'));
  let r = await fetch(`${root}/api/live-status`, { headers: h });
  let j = await r.json();
  assert(j.present === true && j.url === `https://${org}.mcp.test/observability`, `alice reads ${org}'s live pack`, j);
  r = await fetch(`${root}/api/validate?source=pay.yaml`, { method: 'POST', headers: { ...h, 'Content-Type': 'text/yaml' }, body: PAY_YAML });
  j = await r.json();
  const packId = j.registered?.id;
  assert(!!packId && existsSync(join(dir, 'packs', `${packId}.pack.yaml`)), `alice registers a pack into ${org}`, j.registered);
  // The fake MCP as this org's endpoint: the deploys go by its id.
  const fakeEndpointId = await endpointIdFor(root, mcp.url, { name: `${org} fake mcp`, headers: h });
  let seq = auditSeq();
  r = await fetch(`${root}/api/packs/${packId}/deploy-bulk`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mcpEndpointId: fakeEndpointId, targetProduct: 'grafana', targetVersion: '12', targetFolder: 'observability-pack',
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
  let rows = rowsAfter(seq);
  assert(rows.length === 1 && listedFor('POST /api/packs/:id/deploy-bulk', rows)
    && JSON.stringify(rows[0].slice(0, 4)) === JSON.stringify(['deploy.bulk', 'alice', org, deployId])
    && rows[0][4].items === 2 && rows[0][4].ok === 2 && rows[0][4].failed === 0 && rows[0][4].snapshot === 'captured'
    && rows[0][4].origin === new URL(mcp.url).origin && !('fileError' in rows[0][4]),
    `alice's deploy in ${org}: exactly one deploy.bulk row by alice in ${org} (an action the table lists), ok 2 of 2, snapshot captured`, rows);
  assert(!('auditError' in j), `alice's deploy in ${org}: the row was written (no auditError)`, j.auditError);
  seq = auditSeq();
  r = await fetch(`${root}/api/deploys/${deployId}/verify`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome: 'pending' }),
  });
  assert(r.status === 200, `alice records a verify in ${org}`, r.status, 200);
  rows = rowsAfter(seq);
  assert(rows.length === 1 && listedFor('POST /api/deploys/:deployId/verify', rows)
    && JSON.stringify(rows) === JSON.stringify([['deploy.verify', 'alice', org, deployId, { outcome: 'pending', alignment: null, attempts: null }]]),
    `alice's verify in ${org}: exactly one deploy.verify row by alice in ${org} (an action the table lists)`, rows);
  seq = auditSeq();
  r = await fetch(`${root}/api/journeys/capture`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: journey, packAId: packId, packBId: 'production-curated', env: 'prod' }),
  });
  j = await r.json();
  assert(j.ok === true && existsSync(join(dir, 'journeys', `${journey}.journey.yaml`)), `alice captures ${journey} in ${org}`, j);
  rows = rowsAfter(seq);
  assert(rows.length === 1 && listedFor('POST /api/journeys/capture', rows)
    && JSON.stringify(rows) === JSON.stringify([['journey.capture', 'alice', org, journey, { packA: packId, packB: 'production-curated', live: false, env: 'prod', service: null, scopeMode: null }]]),
    `alice's capture in ${org}: exactly one journey.capture row by alice in ${org} (an action the table lists): the pack ids, live false, env prod`, rows);
  seq = auditSeq();
  r = await fetch(`${root}/api/journeys/${journey}/run`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
  j = await r.json();
  assert(j.ok === true && existsSync(join(dir, 'runs')), `alice runs ${journey} once in ${org} (a runs/ record)`, j.error);
  rows = rowsAfter(seq);
  assert(rows.length === 1 && listedFor('POST /api/journeys/:name/run', rows)
    && JSON.stringify(rows[0].slice(0, 4)) === JSON.stringify(['journey.run', 'alice', org, journey])
    && JSON.stringify(Object.keys(rows[0][4])) === JSON.stringify(['startedAt', 'outcome', 'alignmentPct', 'gradeScore', 'gradePass', 'breaches', 'tookMs'])
    && rows[0][4].startedAt === j.record.startedAt && rows[0][4].outcome === j.record.outcome && ['pass', 'gate-failed'].includes(rows[0][4].outcome)
    && rows[0][4].alignmentPct === j.record.drift.alignmentPct && rows[0][4].gradeScore === j.record.grade.score && rows[0][4].gradePass === j.record.grade.pass
    && rows[0][4].breaches === j.record.gate.breaches.length && rows[0][4].tookMs === j.record.tookMs,
    `alice's run in ${org}: exactly one journey.run row by alice in ${org} (an action the table lists), the record's seven scalars`, rows);
  // A verdict by alice on the registered pack's first SLI (GAP batch 2, B3.1): a row in the store.
  seq = auditSeq();
  r = await fetch(`${root}/api/packs/${packId}/verdicts/SLI-01`, {
    method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'trusted', reason: 'reviewed' }),
  });
  j = await r.json();
  assert(r.status === 200 && j.verdict?.status === 'trusted', `alice records a verdict in ${org}`, [r.status, j]);
  rows = rowsAfter(seq);
  assert(rows.length === 1 && listedFor('PUT /api/packs/:id/verdicts/:artefact', rows)
    && JSON.stringify(rows) === JSON.stringify([['verdict.set', 'alice', org, `${packId}/SLI-01`, { pack: packId, artefact: 'SLI-01', family: 'sli', from: null, to: 'trusted', reason: 'reviewed' }]]),
    `alice's verdict in ${org}: exactly one verdict.set row by alice in ${org} (an action the table lists)`, rows);
  r = await fetch(`${root}/api/services`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `${org} sweep service` }),
  });
  j = await r.json();
  const serviceId = j.service?.id;
  assert(r.status === 201 && Number.isInteger(serviceId) && j.service.slug === `${org}-sweep-service`, `alice creates a service in ${org}`, [r.status, j]);
  r = await fetch(`${root}/api/services/${serviceId}/environments`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'prod' }),
  });
  j = await r.json();
  const environmentId = j.environment?.id;
  assert(r.status === 201 && Number.isInteger(environmentId) && j.environment.serviceId === serviceId, `alice creates an environment in ${org}`, [r.status, j]);
  r = await fetch(`${root}/api/mcp-endpoints`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${org} sweep mcp`, url: `https://${org}.mcp.test/mcp`, readTokenEnv: `OBSERVOGRAM_ORG_${org.toUpperCase()}_MCP_TOKEN` }),
  });
  j = await r.json();
  const mcpEndpointId = j.endpoint?.id;
  assert(r.status === 201 && Number.isInteger(mcpEndpointId) && j.endpoint.url === `https://${org}.mcp.test/mcp`, `alice (an admin) creates an MCP endpoint in ${org}`, [r.status, j]);
  // The other org's listed origin is not this org's: its variable lists its own.
  const other = org === 'acme' ? 'delta' : 'acme';
  seq = auditSeq();
  r = await fetch(`${root}/api/mcp-endpoints`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `${org} other mcp`, url: `https://${other}.mcp.test/mcp`, readTokenEnv: `OBSERVOGRAM_ORG_${org.toUpperCase()}_MCP_TOKEN` }),
  });
  j = await r.json();
  assert(r.status === 400 && j.error === `https://${other}.mcp.test is not in OBSERVOGRAM_ORG_${org.toUpperCase()}_MCP_ORIGINS — the server's operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or register an endpoint at a listed origin`
    && rowsAfter(seq).length === 0, `${other}'s listed MCP origin is not ${org}'s: registering it in ${org} is refused (400, no row)`, [r.status, j]);
  r = await fetch(`${root}/api/mcp-endpoints`, { headers: h });
  j = await r.json();
  assert(JSON.stringify(j.policy?.typed?.origins) === JSON.stringify([`https://${org}.mcp.test`]) && JSON.stringify(j.policy?.register?.origins) === JSON.stringify([`https://${org}.mcp.test`]),
    `GET /api/mcp-endpoints in ${org}: its policy shows ${org}'s origin list, never ${other}'s`, j.policy);
  // A waiver by alice on the service (GAP batch 2, B3.2): a row in the store, the author her login.
  const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
  seq = auditSeq();
  r = await fetch(`${root}/api/services/${serviceId}/waivers`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ruleId: 'L5.MUST.synthetic_probe', reason: 'the probe ships next sprint', expiresAt }),
  });
  j = await r.json();
  const waiverId = j.waiver?.id;
  assert(r.status === 201 && Number.isInteger(waiverId) && j.waiver.author === 'alice' && j.waiver.state === 'active', `alice records a waiver in ${org}`, [r.status, j]);
  rows = rowsAfter(seq);
  assert(rows.length === 1 && listedFor('POST /api/services/:id/waivers', rows)
    && JSON.stringify(rows) === JSON.stringify([['waiver.create', 'alice', org, String(waiverId), { service: `${org}-sweep-service`, ruleId: 'L5.MUST.synthetic_probe', artefactId: null, expiresAt, reason: 'the probe ships next sprint' }]]),
    `alice's waiver in ${org}: exactly one waiver.create row by alice in ${org} (an action the table lists)`, rows);
  // One snapshot job by alice through the fake (rebadge batch 3, C1): it
  // registers its pack in this org and writes one live.fetch row here.
  seq = auditSeq();
  r = await fetch(`${root}/api/mcp/jobs`, {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'snapshot', mcpEndpointId: fakeEndpointId }),
  });
  j = await r.json();
  const jobId = j.job?.id;
  assert(r.status === 202 && typeof jobId === 'string' && JSON.stringify(j.job.scope.metricPrefixes) === JSON.stringify(org === 'acme' ? ['acme_'] : []),
    `alice starts a snapshot job in ${org} (the org's own configured scope)`, [r.status, j]);
  let poll = null;
  for (let i = 0; i < 400; i++) {
    poll = await (await fetch(`${root}/api/mcp/jobs/${jobId}`, { headers: h })).json();
    if (poll.job?.state !== 'running') break;
    await new Promise(res => setTimeout(res, 25));
  }
  const jobPack = poll?.result?.registered?.id;
  assert(poll?.job?.state === 'done' && !!jobPack && existsSync(join(dir, 'packs', `${jobPack}.pack.yaml`)), `alice's snapshot job in ${org} ends done, its pack under ${org}'s root`, [poll?.job?.state, poll?.error]);
  rows = rowsAfter(seq);
  const fetchRows = rows.filter(([action]) => action === 'live.fetch');
  assert(listedFor('POST /api/mcp/jobs', rows) && fetchRows.length === 1 && fetchRows[0][1] === 'alice' && fetchRows[0][2] === org && fetchRows[0][4].jobId === jobId,
    `alice's snapshot job in ${org}: its rows are actions the table lists, one live.fetch by alice in ${org}`, rows);
  return { packId, deployId, journey, serviceId, environmentId, mcpEndpointId, fakeEndpointId, waiverId, jobId };
}

// The cross-org route sweep: `who` (a session in another org — `org` is its
// context org; an `owner` reads the deployment's audit by default) calls
// every org-scoped route with the other org's (`otherOrg`) ids — a user of
// the other org only among them; each answers 404, an empty list or "no
// snapshot", no MCP call is made, nothing under `dir` changes, that user's
// memberships stay as they were and the audit of the other org gains no row
// (STORE_PLAN slice 5: the sweep's own RESET writes one pack.clear row in
// the sweeper's org, none in the other's). An /api route in no table fails
// the test.
async function sweep({ root, cookie, who, owner, org, otherOrg, ids, mcp, dir }) {
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
  // The deploy rows send the other org's endpoint for the fake: the route
  // refuses the pack or the deploy first, so the fake sees no call.
  const { packId, deployId, journey, userId, serviceId, environmentId, mcpEndpointId, fakeEndpointId, waiverId, jobId } = ids;
  const p = encodeURIComponent(packId);
  const is404 = (label) => (r) => assert(r.status === 404, `${who}: ${label} → 404`, r.status, 404);
  const ORG_SCOPED = {
    'GET /api/packs': ['/api/packs', undefined, (r) => assert(r.status === 200 && !r.json.packs.some(x => x.id === packId), `${who}: GET /api/packs lacks the other org's pack`)],
    'GET /api/packs/:id': [`/api/packs/${p}`, undefined, is404('GET /api/packs/:id')],
    'GET /api/packs/:id/canonical': [`/api/packs/${p}/canonical`, undefined, is404('GET /api/packs/:id/canonical')],
    'GET /api/packs/:id/conformance': [`/api/packs/${p}/conformance`, undefined, is404('GET /api/packs/:id/conformance')],
    // The verdicts (GAP batch 2, B3.1): the other org's pack is unknown here, on every method.
    'GET /api/packs/:id/verdicts': [`/api/packs/${p}/verdicts`, undefined, is404('GET /api/packs/:id/verdicts')],
    'PUT /api/packs/:id/verdicts/:artefact': [`/api/packs/${p}/verdicts/SLI-01`, { status: 'failed' }, is404('PUT /api/packs/:id/verdicts/:artefact')],
    'DELETE /api/packs/:id/verdicts/:artefact': [`/api/packs/${p}/verdicts/SLI-01`, undefined, is404('DELETE /api/packs/:id/verdicts/:artefact')],
    // The audit report and the placeholders (GAP batch 2, B3.5): the other org's pack is unknown here.
    'GET /api/packs/:id/placeholders': [`/api/packs/${p}/placeholders`, undefined, is404('GET /api/packs/:id/placeholders')],
    'GET /api/packs/:id/audit-report': [`/api/packs/${p}/audit-report`, undefined, is404('GET /api/packs/:id/audit-report')],
    'GET /api/packs/:id/compile-catalog': [`/api/packs/${p}/compile-catalog`, undefined, is404('GET /api/packs/:id/compile-catalog')],
    'GET /api/packs/:id/compile-artifact': [`/api/packs/${p}/compile-artifact?group=rules`, undefined, is404('GET /api/packs/:id/compile-artifact')],
    'GET /api/packs/:id/export.zip': [`/api/packs/${p}/export.zip`, undefined, is404('GET /api/packs/:id/export.zip')],
    'GET /api/packs/:id/compile/:target': [`/api/packs/${p}/compile/prometheus-rules`, undefined, is404('GET /api/packs/:id/compile/:target')],
    'GET /api/diff': [`/api/diff?a=${p}&b=${p}`, undefined, is404('GET /api/diff')],
    'POST /api/packs/:id/deploy-bulk': [`/api/packs/${p}/deploy-bulk`, { mcpEndpointId: fakeEndpointId, items: [{ group: 'dashboards', flavor: 'grafana', dashboardId: 'payment-overview' }] }, is404('POST /api/packs/:id/deploy-bulk')],
    'POST /api/packs/:id/deploy/:target': [`/api/packs/${p}/deploy/grafana-dashboard`, { mcpEndpointId: fakeEndpointId }, is404('POST /api/packs/:id/deploy/:target')],
    'POST /api/packs/:id/retrofeed': [`/api/packs/${p}/retrofeed`, {}, is404('POST /api/packs/:id/retrofeed')],
    'GET /api/deploys': ['/api/deploys?limit=500', undefined, (r) => assert(r.status === 200 && !r.json.deploys.some(d => d.deployId === deployId), `${who}: GET /api/deploys lacks the other org's deployId`)],
    'GET /api/deploys/:deployId/rollback-plan': [`/api/deploys/${deployId}/rollback-plan`, undefined, (r) => assert(r.json?.canRollback === false && (r.json.plan || []).length === 0, `${who}: rollback-plan of the other org's deploy → no snapshot`, r.json)],
    'POST /api/deploys/:deployId/rollback': [`/api/deploys/${deployId}/rollback`, { mcpEndpointId: fakeEndpointId }, (r) => assert(r.status === 404 || r.status === 409, `${who}: rollback of the other org's deploy → 404/409`, r.status, '404|409')],
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
    // The live pack is the org's own: the other org's is never read, and a
    // refresh (here refused before any fetch) could only write the caller's.
    'GET /api/live-status': ['/api/live-status', undefined, (r) => assert(r.status === 200 && r.json.present === false, `${who}: GET /api/live-status does not read the other org's live pack`, r.json)],
    'POST /api/refresh-live': ['/api/refresh-live', {}, (r) => assert(r.status === 400, `${who}: POST /api/refresh-live {} → 400`, r.status, 400)],
    // The ping (rebadge batch 3, C2): the other org's endpoint id is no
    // endpoint here — 400 before any wire call (the sweep counts the fake's calls).
    'POST /api/mcp/ping': ['/api/mcp/ping', { mcpEndpointId }, (r) => assert(r.status === 400 && r.json?.error === `no MCP endpoint ${mcpEndpointId} in this org — GET /api/mcp-endpoints lists them`,
      `${who}: POST /api/mcp/ping by the other org's endpoint id → 400, no MCP endpoint in this org`, [r.status, r.json?.error])],
    // The live jobs (rebadge batch 3, C1): the other org's job is the
    // unknown-id 404 to read and to cancel; the list never shows it, nor the
    // other org's configured scope; a start without a kind is a 400.
    'GET /api/mcp/jobs': ['/api/mcp/jobs', undefined, (r) => assert(r.status === 200 && r.json.running === null
      && JSON.stringify(r.json.scope.defaults.metricPrefixes) === JSON.stringify(org === 'acme' ? ['acme_'] : []) && r.json.scope.from === (org === 'acme' ? 'org' : null),
    `${who}: GET /api/mcp/jobs holds no job and no configured scope of the other org's`, r.json)],
    'POST /api/mcp/jobs': ['/api/mcp/jobs', {}, (r) => assert(r.status === 400, `${who}: POST /api/mcp/jobs {} → 400`, r.status, 400)],
    'GET /api/mcp/jobs/:jobId': [`/api/mcp/jobs/${jobId}`, undefined, (r) => assert(r.status === 404 && r.json?.gone === true, `${who}: GET /api/mcp/jobs/:jobId of the other org's job → 404 gone`, [r.status, r.json])],
    'POST /api/mcp/jobs/:jobId/cancel': [`/api/mcp/jobs/${jobId}/cancel`, {}, (r) => assert(r.status === 404 && r.json?.gone === true, `${who}: cancel of the other org's job → 404 gone`, [r.status, r.json])],
    'DELETE /api/uploads': ['/api/uploads', undefined, (r) => assert(r.status === 200, `${who}: DELETE /api/uploads clears only the caller's org`, r.status, 200)],
    // The request's org, its name and its members (STORE_PLAN slice 3b): the
    // list holds none of the other org's users, and a member route naming
    // one of them answers "not a member" of the caller's org.
    'GET /api/org/members': ['/api/org/members', undefined, (r) => assert(r.status === 200 && !r.json.members.some(m => m.userId === userId), `${who}: GET /api/org/members holds no user of the other org`, r.json)],
    'PATCH /api/org/members/:userId': [`/api/org/members/${userId}`, { role: 'viewer' }, is404('PATCH /api/org/members/:userId')],
    'DELETE /api/org/members/:userId': [`/api/org/members/${userId}`, undefined, is404('DELETE /api/org/members/:userId')],
    'POST /api/org/members': ['/api/org/members', {}, (r) => assert(r.status === 400, `${who}: POST /api/org/members {} → 400`, r.status, 400)],
    'PATCH /api/org': ['/api/org', {}, (r) => assert(r.status === 400, `${who}: PATCH /api/org {} → 400`, r.status, 400)],
    // The services and environments API (STORE_PLAN slice 4): the list holds
    // none of the other org's ids, each :id route answers 404, and a write
    // that takes no id lands in the caller's own org (here refused: {} → 400).
    'GET /api/services': ['/api/services', undefined, (r) => assert(r.status === 200 && !r.json.services.some(s => s.id === serviceId), `${who}: GET /api/services lacks the other org's service`)],
    'GET /api/services/:id': [`/api/services/${serviceId}`, undefined, is404('GET /api/services/:id')],
    'GET /api/services/:id/environments': [`/api/services/${serviceId}/environments`, undefined, is404('GET /api/services/:id/environments')],
    'GET /api/environments/:id': [`/api/environments/${environmentId}`, undefined, is404('GET /api/environments/:id')],
    'POST /api/services': ['/api/services', {}, (r) => assert(r.status === 400, `${who}: POST /api/services {} → 400`, r.status, 400)],
    'PATCH /api/services/:id': [`/api/services/${serviceId}`, { tier: 'tier-1' }, is404('PATCH /api/services/:id')],
    'DELETE /api/services/:id': [`/api/services/${serviceId}`, undefined, is404('DELETE /api/services/:id')],
    'POST /api/services/:id/environments': [`/api/services/${serviceId}/environments`, { name: 'staging' }, is404('POST /api/services/:id/environments')],
    'PATCH /api/environments/:id': [`/api/environments/${environmentId}`, { tier: 'tier-1' }, is404('PATCH /api/environments/:id')],
    'DELETE /api/environments/:id': [`/api/environments/${environmentId}`, undefined, is404('DELETE /api/environments/:id')],
    // The waivers (GAP batch 2, B3.2): the other org's service and waiver are unknown here.
    'GET /api/services/:id/waivers': [`/api/services/${serviceId}/waivers`, undefined, is404('GET /api/services/:id/waivers')],
    'POST /api/services/:id/waivers': [`/api/services/${serviceId}/waivers`, { ruleId: 'L5.MUST.synthetic_probe', reason: 'sweep', expiresAt: new Date(Date.now() + 86400000).toISOString() }, is404('POST /api/services/:id/waivers')],
    'POST /api/waivers/:id/revoke': [`/api/waivers/${waiverId}/revoke`, {}, is404('POST /api/waivers/:id/revoke')],
    // The MCP endpoints (admin; `who` is an admin or an owner in their org):
    // the list holds none of the other org's, each :id route 404, {} → 400.
    'GET /api/mcp-endpoints': ['/api/mcp-endpoints', undefined, (r) => assert(r.status === 200 && !r.json.endpoints.some(e => e.id === mcpEndpointId), `${who}: GET /api/mcp-endpoints lacks the other org's endpoint`, r.json)],
    'POST /api/mcp-endpoints': ['/api/mcp-endpoints', {}, (r) => assert(r.status === 400, `${who}: POST /api/mcp-endpoints {} → 400`, r.status, 400)],
    'PATCH /api/mcp-endpoints/:id': [`/api/mcp-endpoints/${mcpEndpointId}`, { name: 'renamed' }, is404('PATCH /api/mcp-endpoints/:id')],
    'DELETE /api/mcp-endpoints/:id': [`/api/mcp-endpoints/${mcpEndpointId}`, undefined, is404('DELETE /api/mcp-endpoints/:id')],
    // The audit reader (STORE_PLAN slice 5; `who` is an admin or an owner in
    // their org): the org-scoped listing is the sweeper's org's — every row
    // its own, none of the other org's deploy or journey rows, none by alice
    // (who acted in the other org only); the owner-aware check because an
    // owner's default scope is `all`, so the row asks scope=org explicitly.
    'GET /api/audit': ['/api/audit?scope=org&limit=500', undefined, (r) => assert(r.status === 200 && r.json.scope === 'org' && r.json.org === org
      && r.json.rows.every(x => x.orgId === org) && !r.json.rows.some(x => x.targetId === deployId || x.targetId === journey || x.actor === 'alice'),
    `${who}: GET /api/audit?scope=org lists ${org}'s rows only — none of ${otherOrg}'s deploy or journey rows, none by alice`, r.json)],
  };
  const memberships = () => JSON.stringify(listMembershipsForUser(currentStore(), userId));
  const membershipsBefore = memberships();
  assert(membershipsBefore !== '[]', `${who}: the other org's user is a member there`, membershipsBefore);
  const before = tree(dir);
  const mcpCalls = mcp.calls.length;
  const otherRows = () => listAudit(currentStore(), { orgId: otherOrg, limit: 1000 }).length;
  const otherRowsBefore = otherRows();
  const routes = apiRoutes();
  const unclassified = routes.filter(k => !DEPLOYMENT_GLOBAL.has(k) && !ORG_SCOPED[k] && !OWNER_ONLY.has(k));
  assert(unclassified.length === 0, 'every /api route is classified org-scoped, deployment-global or owner-only', unclassified, []);
  const staleOwnerOnly = [...OWNER_ONLY].filter(k => !routes.includes(k));
  assert(staleOwnerOnly.length === 0, 'every owner-only entry is a registered route', staleOwnerOnly, []);
  // DELETE /api/uploads last: the reads above must see the caller's own registry.
  const order = Object.keys(ORG_SCOPED).filter(k => routes.includes(k)).sort((a, b) => (a === 'DELETE /api/uploads') - (b === 'DELETE /api/uploads'));
  for (const key of order) {
    const [path, body, check] = ORG_SCOPED[key];
    check(await call(key.split(' ')[0], path, body));
  }
  assert(mcp.calls.length === mcpCalls, `${who}: the sweep made no MCP call`, mcp.calls.length - mcpCalls, 0);
  assert(JSON.stringify(tree(dir)) === JSON.stringify(before), `${who}: nothing under ${dir} changed`);
  assert(memberships() === membershipsBefore, `${who}: the other org's user's memberships are unchanged`, memberships(), membershipsBefore);
  assert(otherRows() === otherRowsBefore, `${who}: the sweep wrote no audit row of ${otherOrg}'s`, otherRows(), otherRowsBefore);
  // The admin / owner split of GET /api/audit (STORE_PLAN slice 5, design
  // §6): a non-owner's plain listing is its org's (scope org, no deployment
  // row); an owner's scope=all is the deployment's — alice's rows in the
  // other org among them.
  const plain = await call('GET', '/api/audit?limit=500');
  const all = await call('GET', '/api/audit?scope=all&limit=500');
  if (owner) {
    assert(plain.status === 200 && plain.json.scope === 'all' && plain.json.org === null, `${who}, an owner: a plain GET /api/audit is scope all`, [plain.status, plain.json?.scope]);
    assert(all.status === 200 && all.json.rows.some(x => x.actor === 'alice' && x.orgId === otherOrg) && all.json.rows.some(x => x.targetId === deployId),
      `${who}, an owner: GET /api/audit?scope=all holds alice's rows of ${otherOrg} and the deploy row`, all.json?.rows?.length);
  } else {
    assert(plain.status === 200 && plain.json.scope === 'org' && plain.json.org === org && !plain.json.rows.some(x => x.orgId === null),
      `${who}, an admin: a plain GET /api/audit is scope org (${org}), no deployment row`, [plain.status, plain.json?.scope, plain.json?.org]);
    assert(all.status === 400 && all.json.error === `the deployment's audit (scope=deployment, scope=all) is an owner's: as an admin of org '${org}' you read its rows (scope=org, the default) — drop scope, or ask an owner`,
      `${who}, an admin: GET /api/audit?scope=all is refused, naming ${org}`, [all.status, all.json?.error]);
  }
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
  // A studio-run crawl: journey reads only the caller's org's part of the
  // workspace — a crawl root in orgs/bravo is refused through the route.
  {
    const bravoRoot = join(WORKSPACE, 'orgs', 'bravo');
    writeFileSync(join(bravoRoot, 'leak.yaml'), PAY_YAML);
    const pack = readdirSync(join(WORKSPACE, 'orgs', 'acme', 'packs')).find(f => f.endsWith('.pack.yaml'));
    writeFileSync(join(WORKSPACE, 'orgs', 'acme', 'journeys', 'acme-crawl.journey.yaml'), [
      'name: acme-crawl',
      `packA: { crawl: { path: ${JSON.stringify(bravoRoot)}, name: svc } }`,
      `packB: { file: ../packs/${pack} }`,
    ].join('\n') + '\n');
    const crawlSeq = auditSeq();
    r = await fetch(`${base}/api/journeys/acme-crawl/run`, {
      method: 'POST', headers: { Cookie: alice, 'Content-Type': 'application/json', 'X-Observogram-CSRF': '1' }, body: '{}',
    });
    j = await r.json();
    assert(r.status === 502 && j.error === `crawl source ${bravoRoot} belongs to another org's part of the workspace — refused`,
      "alice's crawl: journey whose root is orgs/bravo → 502 'belongs to another org'", [r.status, j.error]);
    // The attempt is on the record (slice 5): a journey.run row with outcome
    // `error` — a file source, not a lost vantage — and never the message.
    const crawlRows = rowsAfter(crawlSeq);
    assert(crawlRows.length === 1 && JSON.stringify(crawlRows[0].slice(0, 4)) === JSON.stringify(['journey.run', 'alice', 'acme', 'acme-crawl'])
      && crawlRows[0][4].outcome === 'error' && crawlRows[0][4].alignmentPct === null && crawlRows[0][4].breaches === null
      && typeof crawlRows[0][4].startedAt === 'string' && typeof crawlRows[0][4].tookMs === 'number' && !JSON.stringify(crawlRows).includes('bravo'),
      "alice's refused crawl run: one journey.run row, outcome error, no path in it", crawlRows);
    rmSync(join(bravoRoot, 'leak.yaml'));
    rmSync(join(WORKSPACE, 'orgs', 'acme', 'journeys', 'acme-crawl.journey.yaml'));
  }

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
  const aliceId = listUsers(currentStore()).find(u => u.login === 'alice').id;   // acme's admin, no member of bravo
  await sweep({ root: base, cookie: bob, who: 'bob (bravo)', owner: false, org: 'bravo', otherOrg: 'acme', ids: { ...acmeIds, userId: aliceId }, mcp, dir: join(WORKSPACE, 'orgs', 'acme') });
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

  const { resetPackRegistry } = await import('./pack-registry.mjs');
  resetPackRegistry();
  const srv2 = await start({ port: 0, host: '127.0.0.1', silent: true });
  try {
    assert(existsSync(join(WS2, 'orgs', 'default', 'packs', 'flat-pack.pack.yaml')),
      'migration moved the flat pack to orgs/default/packs/');
    // STORE_PLAN slice 4: the pre-slice-4 index.json moved with packs/ and
    // was imported at boot step 5 — the label survives the move + import as
    // a row, the file is frozen in place and hashed under its moved key.
    const rows = runWithOrg('default', () => listPacks(currentStore()));
    assert(JSON.stringify(rows.map(p => [p.id, p.label, p.source, p.createdAt])) === JSON.stringify([['flat-pack', 'Flat', 'upload', new Date(1).toISOString()]]),
      "the moved index.json's entry is a row of org default with its label", rows);
    assert(existsSync(join(WS2, 'orgs', 'default', 'packs', 'index.json')), 'the index.json moved with packs/ and stays in place (read once, never written)');
    const hashes = getMetaJson(currentStore(), 'pack_index_hashes');
    assert(Object.keys(hashes).sort().join() === 'orgs/acme/packs/index.json,orgs/default/packs/index.json'
      && hashes['orgs/acme/packs/index.json'].absent === true && hashes['orgs/default/packs/index.json'].canon === 'pack-index-v1',
      'pack_index_hashes holds the moved key (hashed canonically) and acme\'s root (absent)', hashes);
    assert(!Object.keys(getMetaJson(currentStore(), 'legacy_hashes')).some(k => k.endsWith('index.json')), 'legacy_hashes never holds a pack key');
    assert(runWithOrg('default', () => listServices(currentStore())).map(s => s.slug).join() === 'demo-skeleton',
      'the backfill created the service the pack names (demo-skeleton) in org default', runWithOrg('default', () => listServices(currentStore())).map(s => s.slug));
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
    closeStore();
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
  closeStore();
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
    closeStore();
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
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  // The suite's own posture (set above, after the strip) is the child's too.
  for (const k of ['WORKSPACE', 'USERS_FILE', 'API_TOKEN', 'API_TOKEN_LABEL']) {
    if (process.env[`OBSERVOGRAM_${k}`] !== undefined) env[`OBSERVOGRAM_${k}`] = process.env[`OBSERVOGRAM_${k}`];
  }
  const cli = (script, args, input) => spawnSync(process.execPath, [script, ...args], { env, input, encoding: 'utf8' });
  try {
    assert(getOrg(currentStore(), 'default')?.root === '.', 'a flat stand-alone workspace: the default org at .');
    let c = cli('tools/user-admin.mjs', ['add', 'alice', '--password-stdin'], 'alice-passw0rd!\n');
    assert(c.status === 0, 'npm run users -- add alice (spawned) succeeds', c.stderr || c.stdout);
    c = cli('tools/org-admin.mjs', ['create', 'delta', '--admin', 'alice']);
    assert(c.status === 0 && getOrg(currentStore(), 'delta')?.root === 'orgs/delta', 'npm run orgs -- create delta --admin alice (spawned): delta at orgs/delta', c.stderr || c.stdout);
    // dora: a member of delta only (alice is in the default org too).
    c = cli('tools/user-admin.mjs', ['add', 'dora', '--org', 'delta', '--password-stdin'], 'dora-passw0rd!\n');
    const dora = listUsers(currentStore()).find(u => u.login === 'dora');
    const doraOrgs = dora ? listMembershipsForUser(currentStore(), dora.id).map(m => m.orgId) : null;
    assert(c.status === 0 && JSON.stringify(doraOrgs) === JSON.stringify(['delta']), 'npm run users -- add dora --org delta (spawned): a member of delta only', c.stderr || doraOrgs);

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
    await sweep({ root: base4, cookie: carlos, who: 'carlos (default at .)', owner: true, org: 'default', otherOrg: 'delta', ids: { ...ids, userId: dora.id }, mcp, dir: deltaDir });

    // The refresh writes the caller's org's live pack — orgs/delta/live/ —
    // and never the default org's at the base (whose root contains delta's).
    const deltaLive = join(deltaDir, 'live', 'production-live.pack.yaml');
    const baseLive = join(WS4, 'live', 'production-live.pack.yaml');
    const liveUrl = `${mcp.url}?from=delta`;
    const deltaH = { Cookie: alice, 'X-Observogram-CSRF': '1', 'X-Observogram-Org': 'delta' };
    const liveEndpointId = await endpointIdFor(base4, liveUrl, { name: 'delta live mcp', headers: deltaH });
    r = await fetch(`${base4}/api/refresh-live`, {
      method: 'POST',
      headers: { ...deltaH, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpEndpointId: liveEndpointId }),
    });
    j = await r.json();
    assert(r.status === 200 && j.ok === true && j.annotations?.['mcp.url'] === liveUrl, 'alice refreshes the live pack in delta', [r.status, j.error]);
    assert(existsSync(deltaLive) && readFileSync(deltaLive, 'utf8').includes(liveUrl),
      "the refresh wrote orgs/delta/live/production-live.pack.yaml (its mcp.url is the refresh's)", existsSync(deltaLive) ? readFileSync(deltaLive, 'utf8').slice(0, 300) : 'absent');
    assert(!existsSync(baseLive), "delta's refresh wrote no live pack for the default org at the base", baseLive);
    r = await fetch(`${base4}/api/live-status`, { headers: { Cookie: alice, 'X-Observogram-Org': 'delta' } });
    j = await r.json();
    assert(j.present === true && j.url === liveUrl, "alice's live-status in delta reads the refreshed pack", [j.present, j.url]);
    r = await fetch(`${base4}/api/live-status`, { headers: { Cookie: carlos } });
    j = await r.json();
    assert(r.headers.get('x-observogram-org') === 'default' && j.present === false, "carlos's live-status in default: still no live pack", [r.headers.get('x-observogram-org'), j.present]);
  } finally {
    await new Promise(res => srv4.close(res));
    closeStore();
    rmSync(WS4, { recursive: true, force: true });
  }
}

await mcp.close();
closeStore();
rmSync(WORKSPACE, { recursive: true, force: true });
report('tenancy');
