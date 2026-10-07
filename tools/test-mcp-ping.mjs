#!/usr/bin/env node
/**
 * tools/test-mcp-ping.mjs
 *
 * pingMcp (tools/fetch-live-pack.mjs, rebadge batch 3 C2): initialize, the
 * whole tools/list and ONE cheap read within a deadline, and the verdict
 * read from where a failure surfaced. Hermetic: an in-process fetchImpl fake
 * (the transport seam, tools/lib/mcp-client.mjs) that serves the recorded
 * fixtures and honours init.signal — it rejects on abort, so a timeout case
 * cannot hang — plus one native-fetch case against a closed loopback port.
 * Tool names come from the capability registry, never typed here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pingMcp, pingVerdictOf, PING_READS, PING_DEADLINE_MS, TOOLS_LIST_MAX_PAGES } from './fetch-live-pack.mjs';
import { candidateTool, capabilityTool, productAttestedByTool } from './lib/contracts/mcp-capabilities.mjs';
import { isTransportHookError } from './lib/mcp-client.mjs';

delete process.env.OBSERVOGRAM_TRANSPORT_HOOK;
delete process.env.TOMOGRAPH_TRANSPORT_HOOK;

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'mcp', f), 'utf8'));

const SEARCH = candidateTool('dashboards', 'search');
const HEALTH = capabilityTool('grafana_version');
const SYSTEM = capabilityTool('system_health');
const TOPOLOGY = capabilityTool('system_topology');
const URL_ = 'https://mcp.ping.test/mcp';
const TOKEN = 'tok-ping-SECRET-123';

const DASHBOARDS = fixture('grafana_dashboards_search.json');

// The fake. `tools`: advertised names, split over `pages` pages (each page
// but the last carries a nextCursor; `cursorAfterLast` leaves one on the
// last page too). `status`: { <method>: <HTTP status> } with an optional
// body that echoes the Authorization header. `tool`: { <name>: (args) =>
// answer | { isError: text } }. `delayMs`: every answer waits that long,
// rejecting on abort. `hang`: never answer.
function fakeMcp({ tools = [], pages = 1, cursorAfterLast = false, status = {}, tool = {}, delayMs = 0, hang = false, raw = {} } = {}) {
  const calls = [];
  const perPage = Math.max(1, Math.ceil(tools.length / pages));
  const fetchImpl = (url, init) => new Promise((resolveP, rejectP) => {
    const msg = JSON.parse(init.body);
    calls.push({ method: msg.method, params: msg.params, auth: init.headers.Authorization ?? null, redirect: init.redirect });
    const onAbort = () => rejectP(init.signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (init.signal?.aborted) return onAbort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    if (hang) return;
    const answer = () => {
      init.signal?.removeEventListener('abort', onAbort);
      const method = msg.method === 'tools/call' ? `tools/call:${msg.params.name}` : msg.method;
      if (raw[method]) return resolveP(raw[method]());
      const st = status[method] ?? status[msg.method];
      if (st) {
        const body = `upstream refused: Authorization: ${init.headers.Authorization ?? '(none)'}`;
        return resolveP(new Response(body, { status: st, headers: { 'content-type': 'text/plain' } }));
      }
      if (msg.id === undefined) return resolveP(new Response(null, { status: 202 }));
      let result;
      if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
      else if (msg.method === 'tools/list') {
        const page = msg.params?.cursor ? Number(msg.params.cursor) : 0;
        const slice = tools.slice(page * perPage, (page + 1) * perPage).map((name) => ({ name, description: '' }));
        const last = page + 1 >= pages;
        result = { tools: slice, ...(!last || cursorAfterLast ? { nextCursor: String(page + 1) } : {}) };
      } else if (msg.method === 'tools/call') {
        const h = tool[msg.params.name];
        const out = h ? h(msg.params.arguments ?? {}) : { isError: 'unknown tool' };
        result = out && typeof out === 'object' && 'isError' in out
          ? { isError: true, content: [{ type: 'text', text: out.isError }] }
          : { content: [{ type: 'text', text: JSON.stringify(out) }] };
      }
      resolveP(new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    if (delayMs) setTimeout(answer, delayMs); else answer();
  });
  return { calls, transport: { fetchImpl } };
}

const searchAnswer = (args) => ({ ...DASHBOARDS, results: DASHBOARDS.results.slice(0, args.limit ?? DASHBOARDS.results.length) });
const ping = (fake, extra = {}) => pingMcp({ mcpUrl: URL_, transport: fake.transport, ...extra });

test('connected: initialize, tools/list and the dashboards search asked for one item', async () => {
  const fake = fakeMcp({ tools: [SYSTEM, TOPOLOGY, HEALTH, SEARCH, 'zz_unrelated'], tool: { [SEARCH]: searchAnswer } });
  const r = await ping(fake, { mcpAuth: TOKEN });
  assert.equal(r.verdict, 'connected');
  assert.equal(r.reachable, true);
  assert.equal(r.initialized, true);
  assert.equal(r.authSent, true);
  assert.deepEqual(r.tools, { names: [SYSTEM, TOPOLOGY, HEALTH, SEARCH, 'zz_unrelated'], pages: 1, more: false });
  assert.deepEqual(r.read, { capability: 'dashboards', tool: SEARCH, outcome: 'ok', detail: '1 dashboard listed', backendAuthRefused: false, credentialFree: false, error: null });
  const call = fake.calls.find((c) => c.method === 'tools/call');
  assert.equal(call.params.arguments.limit, 1, 'the search asks for one item');
  assert.deepEqual(fake.calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  assert.ok(fake.calls.every((c) => c.auth === `Bearer ${TOKEN}` && c.redirect === 'manual'));
  for (const k of ['initializeMs', 'toolsListMs', 'readMs', 'totalMs']) assert.equal(typeof r.timings[k], 'number', k);
  assert.equal(r.error, null);
  assert.equal(r.stage, null);
});

test('with the health read only, the read is marked credential-free', async () => {
  const fake = fakeMcp({ tools: [SYSTEM, HEALTH], tool: { [HEALTH]: () => ({ version: '12.4.4', database: 'ok' }) } });
  const r = await ping(fake);
  assert.equal(r.verdict, 'connected');
  assert.equal(r.authSent, false);
  assert.deepEqual(r.read, { capability: 'grafana_version', tool: HEALTH, outcome: 'ok', detail: 'version 12.4.4', backendAuthRefused: false, credentialFree: true, error: null });
});

test('with system_health only, it is the read', async () => {
  const fake = fakeMcp({ tools: [SYSTEM], tool: { [SYSTEM]: () => ({ status: 'healthy', services: [] }) } });
  const r = await ping(fake);
  assert.equal(r.read.capability, 'system_health');
  assert.equal(r.read.detail, 'status healthy');
  assert.equal(r.read.credentialFree, false);
});

test('no read advertised: connected, the read not advertised, no tools/call', async () => {
  const fake = fakeMcp({ tools: ['zz_one', 'zz_two'] });
  const r = await ping(fake);
  assert.equal(r.verdict, 'connected');
  assert.equal(r.read.outcome, 'not-advertised');
  assert.equal(r.timings.readMs, null);
  assert.ok(!fake.calls.some((c) => c.method === 'tools/call'));
});

test('HTTP 401 on initialize is auth-refused, nothing else sent', async () => {
  const fake = fakeMcp({ tools: [SEARCH], status: { initialize: 401 } });
  const r = await ping(fake);
  assert.equal(r.verdict, 'auth-refused');
  assert.equal(r.stage, 'initialize');
  assert.equal(r.httpStatus, 401);
  assert.equal(r.reachable, true);
  assert.equal(r.initialized, false);
  assert.equal(r.tools, null);
  assert.equal(fake.calls.length, 1);
});

test('HTTP 403 on tools/list is auth-refused at tools/list', async () => {
  const fake = fakeMcp({ tools: [SEARCH], status: { 'tools/list': 403 } });
  const r = await ping(fake);
  assert.equal(r.verdict, 'auth-refused');
  assert.equal(r.stage, 'tools/list');
  assert.equal(r.httpStatus, 403);
  assert.equal(r.initialized, true);
});

test('HTTP 403 on tools/call is auth-refused: the gateway refused the call', async () => {
  const fake = fakeMcp({ tools: [SEARCH], status: { 'tools/call': 403 } });
  const r = await ping(fake, { mcpAuth: TOKEN });
  assert.equal(r.verdict, 'auth-refused');
  assert.equal(r.stage, 'tools/call');
  assert.equal(r.httpStatus, 403);
  assert.equal(r.read.outcome, 'refused');
  assert.deepEqual(r.tools.names, [SEARCH]);
});

test("a read whose tool answers isError 'HTTP 401 from Grafana' is connected, the backend refused", async () => {
  const fake = fakeMcp({ tools: [SEARCH], tool: { [SEARCH]: () => ({ isError: 'HTTP 401 from Grafana: Unauthorized' }) } });
  const r = await ping(fake);
  assert.equal(r.verdict, 'connected');
  assert.equal(r.read.outcome, 'failed');
  assert.equal(r.read.backendAuthRefused, true);
  assert.equal(productAttestedByTool(r.read.tool), 'grafana');
  const plain = fakeMcp({ tools: [SEARCH], tool: { [SEARCH]: () => ({ isError: 'search index rebuilding' }) } });
  const r2 = await ping(plain);
  assert.equal(r2.read.outcome, 'failed');
  assert.equal(r2.read.backendAuthRefused, false);
});

test('a refused connection is unreachable — a fetcher rejection and native fetch to a closed port', async () => {
  const fake = { transport: { fetchImpl: async () => { const e = new Error('connect ECONNREFUSED 10.0.0.9:443'); e.code = 'ECONNREFUSED'; throw e; } } };
  const r = await ping(fake);
  assert.equal(r.verdict, 'unreachable');
  assert.equal(r.reachable, false);
  assert.equal(r.stage, 'initialize');
  assert.match(r.error, /ECONNREFUSED/);
  const server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  await new Promise((ok) => server.close(ok));
  const native = await pingMcp({ mcpUrl: `http://127.0.0.1:${port}/mcp`, transport: null });
  assert.equal(native.verdict, 'unreachable');
  assert.match(native.error, /ECONNREFUSED/);
});

test('a request that outlives its timeout is a timeout', async () => {
  const fake = fakeMcp({ hang: true });
  const r = await ping(fake, { timeoutMs: 50 });
  assert.equal(r.verdict, 'timeout');
  assert.equal(r.stage, 'initialize');
  assert.equal(r.reachable, false);
  assert.equal(r.limitMs, 50);
});

test('the deadline bounds the whole ping', async () => {
  const fake = fakeMcp({ tools: [SEARCH], delayMs: 80, tool: { [SEARCH]: searchAnswer } });
  const r = await ping(fake, { timeoutMs: 1000, deadlineMs: 200 });
  assert.equal(r.verdict, 'timeout');
  assert.equal(r.stage, 'tools/list');
  assert.match(r.error, /deadline/);
  assert.equal(r.limitMs, 200);
  assert.equal(PING_DEADLINE_MS, 10_000);
});

test('HTTP 404 with an HTML page, a body that is not JSON-RPC and a redirect are not-mcp', async () => {
  const html = fakeMcp({ raw: { initialize: () => new Response('<html>Not Found</html>', { status: 404, headers: { 'content-type': 'text/html' } }) } });
  const r = await ping(html);
  assert.equal(r.verdict, 'not-mcp');
  assert.equal(r.httpStatus, 404);
  assert.equal(r.reachable, true);
  const page = fakeMcp({ raw: { initialize: () => new Response('<html>a portal</html>', { status: 200, headers: { 'content-type': 'text/html' } }) } });
  const r2 = await ping(page);
  assert.equal(r2.verdict, 'not-mcp');
  assert.equal(r2.reachable, true);
  const moved = fakeMcp({ raw: { initialize: () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/x?token=1' } }) } });
  const r3 = await ping(moved);
  assert.equal(r3.verdict, 'not-mcp');
  assert.match(r3.error, /redirect to https:\/\/elsewhere\.test/);
  assert.doesNotMatch(r3.error, /token=1/);
});

test('a two-page tools/list is counted whole', async () => {
  const fake = fakeMcp({ tools: ['zz_a', 'zz_b', SEARCH, 'zz_c'], pages: 2, tool: { [SEARCH]: searchAnswer } });
  const r = await ping(fake);
  assert.deepEqual(r.tools, { names: ['zz_a', 'zz_b', SEARCH, 'zz_c'], pages: 2, more: false });
  assert.equal(r.read.tool, SEARCH);
  assert.equal(fake.calls.filter((c) => c.method === 'tools/list')[1].params.cursor, '1');
});

test('a cursor left after the page cap reads more, and the requests stay at 2 + pages + 1', async () => {
  const names = Array.from({ length: 12 }, (_, i) => `zz_${i}`);
  const fake = fakeMcp({ tools: [SEARCH, ...names], pages: 13, cursorAfterLast: true, tool: { [SEARCH]: searchAnswer } });
  const r = await ping(fake);
  assert.equal(r.tools.pages, TOOLS_LIST_MAX_PAGES);
  assert.equal(r.tools.more, true);
  assert.equal(fake.calls.length, 2 + TOOLS_LIST_MAX_PAGES + 1);
  assert.equal(fake.calls.filter((c) => c.method === 'tools/call').length, 1, 'one read, never a second');
});

test("the token an MCP echoes in a 401 body never reaches the result", async () => {
  for (const method of ['initialize', 'tools/list', 'tools/call']) {
    const fake = fakeMcp({ tools: [SEARCH], status: { [method]: 401 } });
    const r = await ping(fake, { mcpAuth: TOKEN });
    assert.equal(r.verdict, 'auth-refused', method);
    assert.ok(!JSON.stringify(r).includes(TOKEN), `${method}: no token in the result`);
    assert.match(r.error, /<redacted>/, method);
  }
});

test('a transport hook fault is thrown, never a verdict', async () => {
  const transport = { prepareRequest: () => { throw new Error('vault sealed'); } };
  await assert.rejects(pingMcp({ mcpUrl: URL_, transport }), (e) => isTransportHookError(e));
});

test('the verdict table and the read rows', () => {
  assert.equal(pingVerdictOf(new Error('MCP HTTP 502 on initialize: bad gateway'), 'initialize').verdict, 'unreachable');
  assert.equal(pingVerdictOf(new Error('initialize: method not found'), 'initialize').verdict, 'not-mcp');
  assert.equal(pingVerdictOf(Object.assign(new Error('x'), { name: 'TimeoutError' }), 'initialize').verdict, 'timeout');
  assert.deepEqual(PING_READS.map((r) => r.capability), ['dashboards', 'grafana_version', 'system_health']);
  assert.ok(Object.isFrozen(PING_READS));
});
