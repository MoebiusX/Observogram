#!/usr/bin/env node
/**
 * server/test-control-room.mjs — POST /api/services/:id/control-room (Overview's control room), in
 * process over HTTP on one stand-alone identity server: acme {ada: admin, oscar: operator, vera:
 * viewer}, a service "Shop" whose prod environment names a fake MCP endpoint by id.
 *
 * What the route does once the guard let it through (who may reach it in each posture is
 * test-authz's matrix; another org's service is test-tenancy's): every refusal before a wire call;
 * the read through the endpoint's server-held read token, the queries the engine's alone (nothing
 * of the request body reaches PromQL); the answer key by key, no token, no variable name, no query
 * text; no audit row, no pack; one read shared for 30 s and while it runs, a fresh one at most every
 * 5 s; the kept firing history checked against each read's alerts, a failed one kept 2 minutes; a
 * repointed endpoint, or the same one under another token, read anew; at most four reads at once in
 * one org; the deadline: a read cut keeps what it read, a transport that ignores the cut is answered
 * at the grace and counted until it ends; a tool not offered, an endpoint that does not answer; a
 * downstream's families file, read when the route is mounted.
 *
 * The suite's transport hook (OBSERVOGRAM_TRANSPORT_HOOK, a module written into the workspace) passes
 * every request to fetch, unless a test asks it to slow some down or to hold them past any abort.
 */

const { STRIP, signIn, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();
delete process.env.OBSERVOGRAM_CONTROL_ROOM_FAMILIES;

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-control-room-'));
const READ_TOKEN = 'acme-read-token-SECRET-control-77';
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_ORG_ACME_MCP_TOKEN = READ_TOKEN;
process.env.OBSERVOGRAM_ORG_ACME_OTHER_TOKEN = 'acme-other-token-control-88';
// The hook: fetch, unless globalThis.__controlRoomHook says to slow a request (ignoring nothing) or to
// hold it past its abort (a transport that ignores the cut) until released.
const HOOK = join(WORKSPACE, 'control-room-hook.mjs');
writeFileSync(HOOK, [
  'export async function fetchImpl(url, init) {',
  '  const ctl = globalThis.__controlRoomHook;',
  '  ctl?.methods?.push(init.method);',
  "  const body = typeof init.body === 'string' ? init.body : '';",
  '  if (ctl?.hold?.(body)) return new Promise((resolve, reject) => { ctl.held.push(() => reject(new Error(\'released\'))); });',
  '  if (ctl?.slow?.(body)) await new Promise((r) => setTimeout(r, ctl.slowMs));',
  '  return fetch(url, init);',
  '}',
].join('\n'));
process.env.OBSERVOGRAM_TRANSPORT_HOOK = HOOK;
const hook = { hold: null, slow: null, slowMs: 0, held: [], methods: [] };
globalThis.__controlRoomHook = hook;
const releaseHeld = () => { const all = hook.held.splice(0); hook.hold = null; for (const f of all) f(); };

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const pw = (login) => `${login}-passw0rd-control`;
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
const { capabilityTool } = await import('../tools/lib/contracts/mcp-capabilities.mjs');
const { setControlRoomSeams, resetControlRoom, controlRoomRoutes, reconcileTiming, CONTROL_ROOM_TTL_MS, CONTROL_ROOM_MAX_IN_FLIGHT_PER_ORG } = await import('./routes/control-room.mjs');

const QUERY = capabilityTool('control_room_query');
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
const headersOf = (who) => ({ Cookie: cookies[who], 'X-Observogram-CSRF': '1', 'X-Observogram-Org': 'acme' });
async function call(who, method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headersOf(who) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}
const room = (who, id, body = { env: 'prod' }) => call(who, 'POST', `/api/services/${id}/control-room`, body);

// The live side: an instant-vector answer per query the engine asks.
const NOW = Math.floor(Date.now() / 1000);
const vec = (...rows) => ({ resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [NOW, String(v)] })) });
// ShopDown fires until a test says it cleared; the firing history answers until a test makes it fail.
let shopDownFiring = true;
let historyFails = false;
let statesFail = false;
const ANSWERS = [
  [/^count by \(__name__\)/, () => vec([{ __name__: 'http_requests_total' }, 1], [{ __name__: 'http_request_duration_seconds_bucket' }, 1], [{ __name__: 'example_queue_depth' }, 1])],
  [/^count by \(alertname, severity, alertstate\) \(ALERTS\)$/, () => (statesFail ? { __isError: 'HTTP 503: Service Temporarily Unavailable' } : shopDownFiring ? vec([{ alertname: 'ShopDown', severity: 'critical', alertstate: 'firing' }, 1]) : vec())],
  [/^min by \(alertname, alertstate\) \(ALERTS_FOR_STATE \* ignoring\(alertstate\) group_left\(alertstate\) ALERTS\)$/, () => (shopDownFiring ? vec([{ alertname: 'ShopDown', alertstate: 'firing' }, NOW - 300]) : vec())],
  [/^count\(last_over_time\(ALERTS\[30d\]\)\)$/, () => vec([{}, 1])],
  [/^count\(up\)$/, () => vec([{}, 4])], [/^sum\(up\)$/, () => vec([{}, 3])], [/^count by \(job\) \(up == 0\)$/, () => vec([{ job: 'shop' }, 1])],
  [/^max by \(alertname, severity\) \(ALERTS\{alertstate="firing"\}\)\[30d:2m\]$/, () => (historyFails ? { __isError: 'HTTP 422: Unprocessable Entity' } : { resultType: 'matrix', result: [{ metric: { alertname: 'ShopDown', severity: 'critical' }, values: [[NOW - 240, '1'], [NOW - 120, '1']] }] })],
  [/^sum\(rate\(http_requests_total\[5m\]\)\)$/, () => vec([{}, 7.5])],
  [/^max\(example_queue_depth\)$/, () => vec([{}, 42])],
];
const handler = (name, args) => {
  if (name !== QUERY) return { error: 'unexpected tool' };
  for (const [re, fn] of ANSWERS) if (re.test(args.query)) return fn();
  return { resultType: 'vector', result: [] };
};
const live = await startFakeMcp([QUERY], handler);
fakes.push(live);
const reg = await registerMcpEndpoint(BASE, { name: 'acme-live', url: live.url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') });
assert.equal(reg.status, 201, reg.text);

const ids = {};

test('refusals come before any call to the live side: no service, no environment, an unknown one, no endpoint, a viewer', async () => {
  const shop = await call('ada', 'POST', '/api/services', { name: 'Shop' });
  assert.equal(shop.status, 201, shop.text);
  ids.shop = shop.json.service.id;
  const before = live.calls.length;
  assert.deepEqual([(await room('oscar', 999999)).status, (await room('oscar', 999999)).json.error], [404, 'no service 999999']);
  const noEnv = await room('oscar', ids.shop, {});
  assert.deepEqual([noEnv.status, noEnv.json.error], [400, 'Shop has no environment yet — add one, with the MCP endpoint that reads it']);
  assert.equal((await call('ada', 'POST', `/api/services/${ids.shop}/environments`, { name: 'prod' })).status, 201);
  const noEndpoint = await room('oscar', ids.shop);
  assert.deepEqual([noEndpoint.status, noEndpoint.json.error], [409, 'Shop in prod has no live target yet — choose the MCP endpoint that reads it']);
  const envId = (await call('ada', 'GET', `/api/services/${ids.shop}`)).json.service.environments[0].id;
  assert.equal((await call('ada', 'PATCH', `/api/environments/${envId}`, { mcpEndpointId: reg.id })).status, 200);
  const unknown = await room('oscar', ids.shop, { env: 'staging' });
  assert.deepEqual([unknown.status, unknown.json.error], [404, 'Shop has no environment "staging" — add it to the service first']);
  const viewer = await room('vera', ids.shop);
  assert.equal(viewer.status, 403);
  assert.equal(viewer.json.denied, 'role');
  assert.equal(live.calls.length, before, 'no refusal reached the live side');
});

test('an operator\'s read: the answer key by key, through the endpoint\'s read token, the engine\'s queries only, nothing secret in it, nothing written', async () => {
  resetControlRoom();
  const auditBefore = listAudit(db, { orgId: 'acme', limit: 1000 }).length;
  const before = live.calls.length;
  const r = await room('oscar', ids.shop, { env: 'prod', query: 'up{job="mine"}', jobs: ['x'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ['ok', 'readAt', 'service', 'env', 'endpoint', 'scope', 'tookMs', 'cached', 'calls', 'alerts', 'scrape', 'timing', 'families', 'absent']);
  assert.deepEqual([r.json.service.name, r.json.env.name, r.json.endpoint.name, r.json.cached, r.json.scope], ['Shop', 'prod', 'acme-live', false, { kind: 'endpoint', declaredJobs: 0 }]);
  assert.deepEqual(r.json.alerts.bySeverity, { critical: 1, warning: 0, info: 0, other: 0 });
  assert.deepEqual(r.json.alerts.active.map((a) => [a.name, a.state]), [['ShopDown', 'firing']]);
  assert.ok(r.json.alerts.active[0].seconds >= 300 && r.json.alerts.active[0].seconds < 330, 'active for the 300 s since its activeAt');
  assert.deepEqual([r.json.scrape.up, r.json.scrape.total, r.json.scrape.downJobs], [3, 4, ['shop']]);
  assert.deepEqual([r.json.timing.outcome, r.json.timing.incidents, r.json.timing.open.map((o) => o.name)], ['data', 1, ['ShopDown']]);
  assert.deepEqual(r.json.families.rows.map((f) => f.id), ['http'], 'the built-in families the endpoint exposes');
  const calls = live.calls.slice(before);
  assert.ok(calls.length > 5 && calls.every((c) => c.name === QUERY), 'every call the query capability\'s tool');
  assert.ok(calls.every((c) => !c.arguments.query.includes('mine') && !c.arguments.query.includes('"x"')), 'nothing of the request body reaches a query');
  assert.ok(live.authHeaders.slice(-calls.length).every((h) => h === `Bearer ${READ_TOKEN}`), 'the endpoint\'s read token rides every call');
  for (const secret of [READ_TOKEN, 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN', 'count by (', live.url]) assert.ok(!r.text.includes(secret), `the answer holds no ${secret}`);
  assert.equal(listAudit(db, { orgId: 'acme', limit: 1000 }).length, auditBefore, 'a read writes no audit row');
  assert.ok(!existsSync(join(WORKSPACE, 'orgs', 'acme', 'live')) || readdirSync(join(WORKSPACE, 'orgs', 'acme', 'live')).length === 0, 'and no live file');
});

test('one read serves every viewer for 30 s and while it runs; a fresh read at most every 5 s', async () => {
  resetControlRoom();
  let clock = Date.now();
  setControlRoomSeams({ now: () => clock });
  const before = live.calls.length;
  const [a, b] = await Promise.all([room('oscar', ids.shop), room('ada', ids.shop)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  const one = live.calls.length - before;
  assert.ok([a.json.cached, b.json.cached].includes(true), 'the second waited on the first');
  const cached = await room('oscar', ids.shop);
  assert.deepEqual([cached.json.cached, live.calls.length - before], [true, one], 'within 30 s: no call');
  clock += 1000;
  const fresh = await room('oscar', ids.shop, { env: 'prod', fresh: true });
  assert.deepEqual([fresh.json.cached, live.calls.length - before > one], [false, true], 'Refresh reads again');
  const calls = live.calls.length;
  clock += 1000;
  const tooSoon = await room('oscar', ids.shop, { env: 'prod', fresh: true });
  assert.deepEqual([tooSoon.json.cached, live.calls.length], [true, calls], 'a second Refresh within 5 s is the cached read');
  const historyQueries = (from) => live.calls.slice(from).filter((c) => /\[30d:2m\]$/.test(c.arguments.query)).length;
  clock += CONTROL_ROOM_TTL_MS + 1;
  const mark = live.calls.length;
  const later = await room('oscar', ids.shop);
  assert.deepEqual([later.json.cached, historyQueries(mark)], [false, 0], 'after 30 s it reads again, but the firing history is kept 10 minutes');
  assert.equal(later.json.timing.outcome, 'data');
  assert.deepEqual(later.json.timing.open.map((o) => o.name), ['ShopDown'], 'still firing: still open');
  // ShopDown clears; the kept history still holds it open: the fresh alerts close it.
  shopDownFiring = false;
  try {
    clock += CONTROL_ROOM_TTL_MS + 1;
    const cleared = await room('oscar', ids.shop);
    assert.deepEqual([cleared.json.cached, cleared.json.alerts.outcome, cleared.json.alerts.evidence], [false, 'empty', true]);
    assert.deepEqual([cleared.json.timing.open, cleared.json.timing.closedSince], [[], 1], 'not firing now: not said as open');
  } finally { shopDownFiring = true; }
  resetControlRoom();
});

test('a repointed endpoint, or the same one under another token, is read anew; at most four reads at once in one org; a read cut at its deadline keeps what it read', async () => {
  resetControlRoom();
  const first = await room('oscar', ids.shop);
  assert.equal(first.status, 200);
  const other = await startFakeMcp([QUERY], handler);
  fakes.push(other);
  assert.equal((await call('ada', 'PATCH', `/api/mcp-endpoints/${reg.id}`, { url: other.url })).status, 200);
  try {
    const moved = await room('oscar', ids.shop);
    assert.deepEqual([moved.status, moved.json.cached, other.calls.length > 0], [200, false, true], 'the new address: a new read, through it');
  } finally {
    assert.equal((await call('ada', 'PATCH', `/api/mcp-endpoints/${reg.id}`, { url: live.url })).status, 200);
  }
  // The same address under another token: another backend for the cache, never the first token's answer.
  resetControlRoom();
  assert.equal((await room('oscar', ids.shop)).status, 200);
  assert.equal((await room('oscar', ids.shop)).json.cached, true);
  assert.equal((await call('ada', 'PATCH', `/api/mcp-endpoints/${reg.id}`, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_OTHER_TOKEN' })).status, 200);
  try {
    const other = await room('oscar', ids.shop);
    assert.deepEqual([other.status, other.json.cached], [200, false], 'another credential: a new read');
    assert.equal(live.authHeaders.at(-1), 'Bearer acme-other-token-control-88', 'through it');
  } finally {
    assert.equal((await call('ada', 'PATCH', `/api/mcp-endpoints/${reg.id}`, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' })).status, 200);
  }
  // Four environments of one service, each its own read, all held at the endpoint: the fifth is refused.
  resetControlRoom();
  for (const name of ['e1', 'e2', 'e3', 'e4', 'e5']) assert.equal((await call('ada', 'POST', `/api/services/${ids.shop}/environments`, { name, mcpEndpointId: reg.id })).status, 201);
  const gate = live.hold(QUERY);
  const held = ['e1', 'e2', 'e3', 'e4'].map((env) => room('oscar', ids.shop, { env }));
  await gate.reached;
  for (let i = 0; i < 100 && live.calls.filter((c) => c.arguments?.query?.startsWith('count by (__name__)')).length < 4; i += 1) await new Promise((r) => setTimeout(r, 20));
  const fifth = await room('oscar', ids.shop, { env: 'e5' });
  assert.deepEqual([fifth.status, fifth.headers.get('retry-after'), fifth.json.error], [429, '5', 'Too many live reads are running for this organisation — try again in a few seconds'], `past ${CONTROL_ROOM_MAX_IN_FLIGHT_PER_ORG} reads in one org`);
  gate.release();
  assert.deepEqual((await Promise.all(held)).map((r) => r.status), [200, 200, 200, 200]);
  assert.equal((await room('oscar', ids.shop, { env: 'e5' })).status, 200, 'the slots are free again');
  // Cut at the deadline with the alerts and targets read, the history and the families slowed past it:
  // what was read is answered, the rest said as out of time.
  resetControlRoom();
  setControlRoomSeams({ deadlineMs: 700 });
  hook.slow = (body) => /\[30d:2m\]|http_requests_total\[5m\]|example_queue_depth|\[6h:10m\]/.test(body);
  hook.slowMs = 1500;
  try {
    const cut = await room('oscar', ids.shop);
    assert.equal(cut.status, 200, cut.text);
    assert.equal(cut.json.calls.outOfTime, true);
    assert.deepEqual([cut.json.alerts.outcome, cut.json.scrape.outcome], ['data', 'data'], 'read before the cut: answered');
    assert.deepEqual([cut.json.timing.outcome, cut.json.timing.reason], ['not-attempted', 'the read ran out of time']);
  } finally { hook.slow = null; resetControlRoom(); }
});

test('the firing history is the endpoint\'s: two services reading one endpoint read it once; a kept one is read again when an alert fires that it does not hold', async () => {
  resetControlRoom();
  const cart = await call('ada', 'POST', '/api/services', { name: 'Cart' });
  assert.equal(cart.status, 201, cart.text);
  assert.equal((await call('ada', 'POST', `/api/services/${cart.json.service.id}/environments`, { name: 'prod', mcpEndpointId: reg.id })).status, 201);
  const historyCalls = () => live.calls.filter((c) => /\[30d:2m\]$/.test(c.arguments?.query || '')).length;
  const before = historyCalls();
  assert.equal((await room('oscar', ids.shop)).status, 200);
  const other = await room('oscar', cart.json.service.id);
  assert.deepEqual([other.status, other.json.timing.outcome, historyCalls() - before], [200, 'data', 1], 'one history for the endpoint');
  // The unit rules: an empty kept history beside alerts firing (even past the listed twelve) is outdated;
  // an alert firing that the kept history does not hold open makes it outdated; one it holds that is
  // not firing now is closed since.
  const empty = { outcome: 'empty', open: [] };
  assert.equal(reconcileTiming(empty, { outcome: 'data', bySeverity: { critical: 20 }, active: [], more: 8 }).outdated, true);
  const held = { outcome: 'data', open: [{ name: 'A' }, { name: 'B' }] };
  assert.deepEqual(reconcileTiming(held, { outcome: 'data', bySeverity: { warning: 2 }, active: [{ name: 'A', state: 'firing' }, { name: 'C', state: 'firing' }], more: 0 }), { outcome: 'data', open: [{ name: 'A' }], closedSince: 1, outdated: true });
  assert.equal(reconcileTiming(held, { outcome: 'data', bySeverity: { warning: 2 }, active: [{ name: 'A', state: 'firing' }, { name: 'B', state: 'firing' }], more: 0 }), held, 'nothing changed: the same');
  assert.equal(reconcileTiming(held, { outcome: 'failed' }), held, 'alerts not read: nothing said about it');
  assert.equal(reconcileTiming(held, { outcome: 'data', bySeverity: { warning: 20 }, active: [{ name: 'C', state: 'firing' }], more: 13 }).outdated, true, 'past the listed twelve: an alert firing it does not hold still makes it outdated');
  resetControlRoom();
});

test('a cut read: a history cut is kept 2 minutes; nothing read is a 502 quoting what the endpoint did answer; the sessions end after the cut', async () => {
  resetControlRoom();
  let clock = Date.now();
  setControlRoomSeams({ now: () => clock, deadlineMs: 700 });
  hook.slow = (body) => /\[30d:2m\]/.test(body);
  hook.slowMs = 1500;
  hook.methods.length = 0;
  const historyCalls = () => live.calls.filter((c) => /\[30d:2m\]$/.test(c.arguments?.query || '')).length;
  try {
    const before = historyCalls();
    const first = await room('oscar', ids.shop);
    assert.deepEqual([first.status, first.json.timing.outcome, first.json.alerts.outcome], [200, 'not-attempted', 'data'], 'the history cut, the rest read');
    for (let i = 0; i < 50 && !hook.methods.includes('DELETE'); i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.ok(hook.methods.includes('DELETE'), 'the session ended after the cut');
    hook.slow = null;
    clock += CONTROL_ROOM_TTL_MS + 1;
    const again = await room('oscar', ids.shop);
    assert.deepEqual([again.json.cached, again.json.timing.outcome, historyCalls() - before], [false, 'not-attempted', 0], 'within 2 minutes the cut history is kept, not started again (the cut one never reached the endpoint)');
    clock += 2 * 60_000;
    const later = await room('oscar', ids.shop);
    assert.deepEqual([later.json.timing.outcome, historyCalls() - before], ['data', 1], 'after 2 minutes it is read again');
    // Nothing read before the cut: the 502 says what the endpoint did answer.
    resetControlRoom();
    setControlRoomSeams({ deadlineMs: 700 });
    statesFail = true;
    hook.slow = (body) => /\[30d:2m\]|timestamp\(up\)|"count\(up\)"|sum\(up\)|up == 0|__name__/.test(body);
    const none = await room('oscar', ids.shop);
    assert.deepEqual([none.status, none.json.error], [502, 'The live endpoint did not answer: no answer within 1 s (before that: HTTP 503: Service Temporarily Unavailable)']);
  } finally { hook.slow = null; statesFail = false; resetControlRoom(); }
});

test('a transport that ignores the cut is answered at the grace, its slot freed and counted until it ends; a failed history is kept 2 minutes; the families file is read when the route is mounted', async () => {
  resetControlRoom();
  setControlRoomSeams({ deadlineMs: 200, graceMs: 200 });
  hook.held = [];
  hook.hold = (body) => body.includes('"tools/call"');
  try {
    for (const env of ['e1', 'e2', 'e3', 'e4']) {
      const late = await room('oscar', ids.shop, { env });
      assert.deepEqual([late.status, late.json.error], [502, 'The live endpoint did not answer: no answer within 1 s'], env);
    }
    const refused = await room('oscar', ids.shop, { env: 'e5' });
    assert.deepEqual([refused.status, refused.json.error], [429, 'Earlier live reads of this organisation have not ended yet — they are given time to end'], 'four reads still pending: the org waits');
  } finally { releaseHeld(); }
  setControlRoomSeams({ deadlineMs: 20_000, graceMs: 2_000 });
  let back = null;
  for (let i = 0; i < 100; i += 1) { back = await room('oscar', ids.shop, { env: 'e5' }); if (back.status !== 429) break; await new Promise((r) => setTimeout(r, 20)); }
  assert.equal(back.status, 200, 'once they ended, the org reads again');
  // A history that failed is kept 2 minutes, not asked again on every read.
  resetControlRoom();
  let clock = Date.now();
  setControlRoomSeams({ now: () => clock });
  historyFails = true;
  try {
    const historyCalls = () => live.calls.filter((c) => /\[30d:2m\]$/.test(c.arguments?.query || '')).length;
    const before = historyCalls();
    const first = await room('oscar', ids.shop);
    assert.deepEqual([first.json.timing.outcome, historyCalls() - before], ['failed', 1]);
    clock += CONTROL_ROOM_TTL_MS + 1;
    const again = await room('oscar', ids.shop);
    assert.deepEqual([again.json.cached, again.json.timing.outcome, historyCalls() - before], [false, 'failed', 1], 'within 2 minutes: the failed history kept');
    clock += 2 * 60_000;
    await room('oscar', ids.shop);
    assert.equal(historyCalls() - before, 2, 'after 2 minutes it is asked again');
  } finally { historyFails = false; resetControlRoom(); }
  // The families file: read, and its warning said, when the route is mounted.
  const file = join(WORKSPACE, 'families-bad.json');
  writeFileSync(file, JSON.stringify({ families: [{ id: 'Broken' }] }));
  process.env.OBSERVOGRAM_CONTROL_ROOM_FAMILIES = file;
  const said = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { said.push(String(chunk)); return write.call(process.stderr, chunk, ...rest); };
  try {
    resetControlRoom();
    controlRoomRoutes({ authorize: () => (req, res, next) => next() });
  } finally {
    process.stderr.write = write;
    delete process.env.OBSERVOGRAM_CONTROL_ROOM_FAMILIES;
    resetControlRoom();
  }
  assert.ok(said.some((l) => /^\[control-room\] family Broken: .*; dropped\.\n$/.test(l)), 'the warning at mount');
});

test('a tool not offered: every part not attempted, said; an endpoint that does not answer, and one past the deadline: 502 with the reason, no figure', async () => {
  resetControlRoom();
  const bare = await startFakeMcp(['some_other_tool'], () => ({ ok: true }));
  fakes.push(bare);
  const other = await registerMcpEndpoint(BASE, { name: 'acme-bare', url: bare.url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') });
  const svc = await call('ada', 'POST', '/api/services', { name: 'Bare' });
  assert.equal((await call('ada', 'POST', `/api/services/${svc.json.service.id}/environments`, { name: 'prod', mcpEndpointId: other.id })).status, 201);
  const r = await room('oscar', svc.json.service.id);
  assert.equal(r.status, 200);
  for (const part of ['alerts', 'scrape', 'timing', 'families']) assert.deepEqual([r.json[part].outcome, r.json[part].reason], ['not-attempted', 'the endpoint offers no PromQL query tool, so nothing live could be read'], part);
  assert.equal(bare.calls.length, 0);
  // Gone.
  const gone = await registerMcpEndpoint(BASE, { name: 'acme-gone', url: 'http://127.0.0.1:2/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') });
  const svc2 = await call('ada', 'POST', '/api/services', { name: 'Gone' });
  assert.equal((await call('ada', 'POST', `/api/services/${svc2.json.service.id}/environments`, { name: 'prod', mcpEndpointId: gone.id })).status, 201);
  const down = await room('oscar', svc2.json.service.id);
  assert.equal(down.status, 502);
  assert.match(down.json.error, /^The live endpoint did not answer: /);
  assert.ok(!down.text.includes(READ_TOKEN));
  // Past the deadline.
  resetControlRoom();
  setControlRoomSeams({ deadlineMs: 1000 });
  const gate = live.hold(QUERY);
  const slow = room('oscar', ids.shop);
  await gate.reached;
  const late = await slow;
  gate.release();
  assert.deepEqual([late.status, late.json.error], [502, 'The live endpoint did not answer: no answer within 1 s']);
  resetControlRoom();
});

test('a downstream\'s families file adds its own family, read when the endpoint exposes it', async () => {
  const file = join(WORKSPACE, 'families.json');
  writeFileSync(file, JSON.stringify({ families: [{
    id: 'example-queue', title: 'Example queue', layer: 'platform',
    variants: [{ requires: ['example_queue_depth'], tiles: [{ id: 'depth', label: 'Deepest queue', unit: 'count', expr: 'max(example_queue_depth)', judge: { kind: 'ceiling', bound: 100, from: 'stated' } }], chart: null }],
  }, { id: 'Broken' }] }));
  process.env.OBSERVOGRAM_CONTROL_ROOM_FAMILIES = file;
  resetControlRoom();
  try {
    const r = await room('oscar', ids.shop);
    assert.equal(r.status, 200);
    const own = r.json.families.rows.find((f) => f.id === 'example-queue');
    assert.deepEqual(own?.tiles.map((t) => [t.id, t.value, t.tone]), [['depth', 42, 'good']]);
  } finally {
    delete process.env.OBSERVOGRAM_CONTROL_ROOM_FAMILIES;
    resetControlRoom();
  }
});
