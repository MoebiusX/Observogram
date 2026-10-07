#!/usr/bin/env node
/**
 * server/test-mcp-ping.mjs — POST /api/mcp/ping (rebadge batch 3, C2), in
 * process over HTTP on one stand-alone identity server: acme {ada: admin,
 * oscar: operator, vera: viewer}, plus the bearer token (an operator).
 *
 * What the route does once the guard let it through (who may reach it in
 * each posture is test-authz's matrix; another org's endpoint is
 * test-tenancy's): by id the endpoint's read token rides as a draft's
 * would, and a request's mcpAuth overrides it; a typed URL is an admin's
 * (the operator and the bearer are refused, nothing sent), and an admin's
 * typed ping writes one live.ping row (the origin, the verdict); a ping by
 * id writes nothing at all — no live file, no pack, no row; the answer is
 * R2's shape key by key (no protocol, no snapshot, no unmatched name, no
 * value of a token — even when the MCP echoes it); the verdicts an operator
 * meets (connected, auth-refused naming the variable, unreachable) with
 * their sentences.
 */

// Hermetic (§0): a developer shell's store, identity or per-org token
// variables never reach this process's imports.
const { STRIP, signIn } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
const { createServer } = await import('node:http');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-mcp-ping-'));
const TOKEN = 'mcp-ping-bearer-0123456789';
const READ_TOKEN = 'acme-read-token-SECRET-42';
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = TOKEN;
process.env.OBSERVOGRAM_ORG_ACME_MCP_TOKEN = READ_TOKEN;

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const pw = (login) => `${login}-passw0rd-ping`;
const LOGINS = ['ada', 'oscar', 'vera'];
writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(WORKSPACE, 'users.json'));
writeOrgsFile({
  default: { name: 'Default', members: { ada: 'admin' } },
  acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer' } },
}, join(WORKSPACE, 'orgs.json'));

const { start } = await import('./index.mjs');
const { currentStore, closeStore } = await import('./store/db.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { startFakeMcp, registerMcpEndpoint } = await import('./fixtures/fake-mcp.mjs');
const { candidateTool, capabilityTool } = await import('../tools/lib/contracts/mcp-capabilities.mjs');

const SEARCH = candidateTool('dashboards', 'search');
const HEALTH = capabilityTool('grafana_version');
const SYSTEM = capabilityTool('system_health');
const UNMATCHED = ['zz_vendor_private_tool', 'zz_other_private_tool'];

const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
const db = currentStore();
const fakes = [];
after(async () => {
  for (const f of fakes) await f.close();
  await new Promise((resolve) => srv.close(resolve));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const cookies = {};
for (const login of LOGINS) {
  const s = await signIn(BASE, login, pw(login));
  assert.equal(s.status, 200, `${login} signs in`);
  cookies[login] = s.session;
}

const CSRF = { 'X-Observogram-CSRF': '1' };
const ACME = { 'X-Observogram-Org': 'acme' };
const headersOf = (who) => (who === 'bearer'
  ? { Authorization: `Bearer ${TOKEN}`, ...ACME }
  : { Cookie: cookies[who], ...CSRF, ...ACME });
async function ping(who, body) {
  const r = await fetch(`${BASE}/api/mcp/ping`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headersOf(who) }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const acmeRows = () => listAudit(db, { orgId: 'acme', limit: 1000 });
const livePack = join(WORKSPACE, 'orgs', 'acme', 'live');
const packIds = async () => (await (await fetch(`${BASE}/api/packs`, { headers: headersOf('ada') })).json()).packs.map((p) => p.id).sort();

async function fake(tools, handler, opts) {
  const f = await startFakeMcp(tools, handler, opts);
  fakes.push(f);
  return f;
}
const searchAnswer = (name, args) => (name === SEARCH ? { count: 1, results: [{ uid: 'a', title: 'A' }].slice(0, args.limit ?? 1) } : { ok: true });

const full = await fake([SYSTEM, HEALTH, SEARCH, ...UNMATCHED], searchAnswer);
const reg = await registerMcpEndpoint(BASE, { name: 'acme-gw', url: full.url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') });
assert.equal(reg.status, 201, reg.text);
const ENDPOINT = reg.id;

const R2_KEYS = ['ok', 'verdict', 'origin', 'mcpEndpoint', 'reachable', 'auth', 'tools', 'read', 'timings', 'sentence', 'checked', 'notChecked'];

test('by id, an operator: connected through the endpoint\'s variable — the fake saw it — and the answer is R2\'s shape, key by key', async () => {
  const before = full.authHeaders.length;
  const r = await ping('oscar', { mcpEndpointId: ENDPOINT });
  assert.equal(r.status, 200, r.text);
  const a = r.json;
  assert.deepEqual(Object.keys(a), R2_KEYS);
  assert.equal(a.ok, true);
  assert.equal(a.verdict, 'connected');
  assert.equal(a.origin, full.origin);
  assert.deepEqual(a.mcpEndpoint, { id: ENDPOINT, name: 'acme-gw' });
  assert.deepEqual(a.reachable, { initialized: true });
  assert.deepEqual(a.auth, { outcome: 'sent', sent: 'endpoint-variable' });
  assert.deepEqual(a.tools, {
    count: 5, unmatched: 2, complete: true,
    capabilities: { system_health: [SYSTEM], dashboards: [SEARCH], grafana_version: [HEALTH] },
  });
  assert.deepEqual(a.read, { capability: 'dashboards', tool: SEARCH, outcome: 'ok', detail: '1 dashboard listed', backendAuthRefused: false, credentialFree: false });
  assert.deepEqual(Object.keys(a.timings), ['initializeMs', 'toolsListMs', 'readMs', 'totalMs']);
  assert.equal(a.sentence, `Connected to ${full.origin} in ${a.timings.totalMs} ms: the MCP answered initialize, listed 5 tools (3 that a fetch reads), and ${SEARCH} answered with the token sent.`);
  assert.deepEqual(a.checked, ['the MCP answered initialize', 'tools/list listed 5 tools', `${SEARCH} answered`]);
  assert.deepEqual(a.notChecked, ['whether each other family answers — a snapshot or a draft finds that out', 'the backends behind every other tool']);
  const seen = full.authHeaders.slice(before);
  assert.equal(seen.length, 4, 'initialize, notifications/initialized, tools/list, one read');
  assert.ok(seen.every((h) => h === `Bearer ${READ_TOKEN}`), 'the endpoint\'s read token rode');
  for (const leak of [READ_TOKEN, ...UNMATCHED, 'protocol', '"snapshot":', 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN']) assert.ok(!r.text.includes(leak), `the answer holds no ${leak}`);
  assert.equal(full.calls.at(-1).arguments.limit, 1, 'the search asked for one item');
});

test('by id with mcpAuth: the request\'s key overrides the variable', async () => {
  const before = full.authHeaders.length;
  const r = await ping('oscar', { mcpEndpointId: ENDPOINT, mcpAuth: 'request-key-77' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.auth, { outcome: 'sent', sent: 'request' });
  assert.ok(full.authHeaders.slice(before).every((h) => h === 'Bearer request-key-77'));
  assert.ok(!r.text.includes('request-key-77'));
});

test('a ping by id writes nothing: no live file, no pack, no audit row', async () => {
  const rows = acmeRows().length;
  const packs = await packIds();
  for (const who of ['oscar', 'ada', 'bearer']) assert.equal((await ping(who, { mcpEndpointId: ENDPOINT })).status, 200, who);
  assert.equal(existsSync(livePack), false, 'no live directory for acme');
  assert.equal(acmeRows().length, rows, 'no row');
  assert.deepEqual(await packIds(), packs, 'no pack');
});

test('a typed URL: the operator and the bearer are refused, nothing sent; an admin\'s typed ping writes one live.ping row — the origin and the verdict', async () => {
  const before = full.authHeaders.length;
  const rows = acmeRows().length;
  let r = await ping('oscar', { mcpUrl: full.url });
  assert.deepEqual([r.status, r.json.denied], [403, 'role']);
  assert.match(r.json.error, /^a typed MCP URL needs the admin role in org 'acme' \(you are operator\)/);
  r = await ping('bearer', { mcpUrl: full.url });
  assert.deepEqual([r.status, r.json.denied], [403, 'role']);
  assert.match(r.json.error, /^the bearer token acts as an operator: it fetches from the org's registered MCP endpoints only/);
  assert.equal(full.authHeaders.length, before, 'nothing was sent');
  assert.equal(acmeRows().length, rows, 'no row for a refusal');
  r = await ping('ada', { mcpUrl: `${full.url}?token=typed-secret` });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.verdict, 'connected');
  assert.equal(r.json.mcpEndpoint, null);
  assert.deepEqual(r.json.auth, { outcome: 'not-sent', sent: 'none' });
  assert.ok(!r.text.includes('typed-secret'));
  const added = acmeRows().slice(0, acmeRows().length - rows);
  assert.equal(added.length, 1);
  assert.deepEqual([added[0].action, added[0].actor, added[0].targetKind, added[0].targetId, added[0].detail], ['live.ping', 'ada', 'live', full.origin, { verdict: 'connected', typed: true }]);
});

test('neither or both targets: 400, nothing sent', async () => {
  const before = full.authHeaders.length;
  let r = await ping('oscar', {});
  assert.equal(r.status, 400);
  r = await ping('ada', { mcpEndpointId: ENDPOINT, mcpUrl: full.url });
  assert.equal(r.status, 400);
  assert.equal(full.authHeaders.length, before);
});

test('an MCP that refuses the token, echoing it: auth-refused naming the variable, the value never in the answer', async () => {
  const echo = await fake([SEARCH], null, { echo: 'http' });
  const id = (await registerMcpEndpoint(BASE, { name: 'acme-echo', url: echo.url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') })).id;
  const r = await ping('oscar', { mcpEndpointId: id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.verdict, 'auth-refused');
  assert.deepEqual(r.json.auth, { outcome: 'refused', sent: 'endpoint-variable' });
  assert.equal(r.json.tools, null);
  assert.equal(r.json.sentence, `${echo.origin} refused the connection: HTTP 401 on initialize — the endpoint's variable OBSERVOGRAM_ORG_ACME_MCP_TOKEN was sent, and refused`);
  assert.ok(!r.text.includes(READ_TOKEN), 'the echoed token is not in the answer');
  assert.deepEqual(r.json.checked, []);
  assert.ok(r.json.notChecked.includes('whether the MCP answers initialize'));
});

test('an MCP whose read is credential-free says what it did not check', async () => {
  const health = await fake([SYSTEM, HEALTH], (name) => (name === HEALTH ? { version: '12.4.4' } : { ok: true }));
  const id = (await registerMcpEndpoint(BASE, { name: 'acme-health', url: health.url }, { headers: headersOf('ada') })).id;
  const r = await ping('oscar', { mcpEndpointId: id });
  assert.equal(r.json.verdict, 'connected');
  assert.deepEqual(r.json.auth, { outcome: 'not-sent', sent: 'none' });
  assert.equal(r.json.read.credentialFree, true);
  assert.equal(r.json.read.detail, 'version 12.4.4');
  assert.match(r.json.sentence, new RegExp(`and ${HEALTH} answered without a token — but ${HEALTH} answers without backend credentials, so whether the MCP's own credentials to its backend work was not checked\\.$`));
  assert.ok(r.json.notChecked.includes(`${HEALTH} answers without backend credentials — whether the MCP's own credentials to its backend work was not checked`));
});

test('an MCP that repeats the token in a successful answer: the read\'s detail says <redacted>, never the value', async () => {
  let echoing = null;
  echoing = await fake([SYSTEM, HEALTH], (name) => (name === HEALTH ? { version: echoing.authHeaders.at(-1) } : { ok: true }));
  const id = (await registerMcpEndpoint(BASE, { name: 'acme-repeat', url: echoing.url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') })).id;
  const r = await ping('oscar', { mcpEndpointId: id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.verdict, 'connected');
  assert.equal(echoing.authHeaders.at(-1), `Bearer ${READ_TOKEN}`, 'the token rode and the MCP repeated it');
  assert.equal(r.json.read.detail, 'version Bearer <redacted>');
  assert.ok(!r.text.includes(READ_TOKEN), 'the repeated token is not in the answer');
});

test('an endpoint nobody answers: 200, unreachable, the sentence names the origin — and the token\'s outcome is null, never sent', async () => {
  const closed = createServer();
  await new Promise((ok) => closed.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${closed.address().port}/mcp`;
  await new Promise((ok) => closed.close(ok));
  const id = (await registerMcpEndpoint(BASE, { name: 'acme-gone', url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') })).id;
  const r = await ping('oscar', { mcpEndpointId: id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.verdict, 'unreachable');
  assert.deepEqual(r.json.reachable, { initialized: false });
  assert.deepEqual(r.json.auth, { outcome: null, sent: 'endpoint-variable' }, 'nothing answered: the ping does not claim the token was sent to an MCP');
  assert.ok(!r.text.includes(READ_TOKEN));
  assert.match(r.json.sentence, new RegExp(`^${new URL(url).origin.replace(/[.]/g, '\\.')} could not be reached: .*ECONNREFUSED`));
});

test('pingAnswer: silent before initialize leaves the token\'s outcome null; once initialize answered, a later timeout keeps sent', async () => {
  const { pingAnswer } = await import('./routes/live.mjs');
  const base = { tools: null, read: null, httpStatus: null, error: null, timings: { totalMs: 1 }, limitMs: 1000 };
  const ctx = { origin: 'http://127.0.0.1:1', sent: 'endpoint-variable', tokenVar: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' };
  assert.deepEqual(pingAnswer({ ...base, verdict: 'timeout', stage: 'initialize', initialized: false }, ctx).auth, { outcome: null, sent: 'endpoint-variable' });
  assert.deepEqual(pingAnswer({ ...base, verdict: 'unreachable', stage: 'initialize', initialized: false, error: 'connect ECONNREFUSED 127.0.0.1:1' }, ctx).auth, { outcome: null, sent: 'endpoint-variable' });
  assert.deepEqual(pingAnswer({ ...base, verdict: 'timeout', stage: 'tools/list', initialized: true }, ctx).auth, { outcome: 'sent', sent: 'endpoint-variable' });
  assert.deepEqual(pingAnswer({ ...base, verdict: 'timeout', stage: 'initialize', initialized: false }, { ...ctx, sent: 'none' }).auth, { outcome: 'not-sent', sent: 'none' });
});

test('a viewer is refused by the guard', async () => {
  const r = await ping('vera', { mcpEndpointId: ENDPOINT });
  assert.deepEqual([r.status, r.json.denied], [403, 'role']);
});
