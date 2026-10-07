#!/usr/bin/env node
/**
 * tools/test-mcp-transport.mjs
 *
 * The MCP transport hook (docs/MCP_INTEGRATION.md "Transport hook"):
 * tools/lib/mcp-client.mjs (the one send path), tools/mcp-transport.mjs
 * (the loader) and tools/lib/mcp-url-safety.mjs's mcpUrlPolicy (the policy
 * the FINAL URL passes). Hermetic: a fake MCP on loopback that records every
 * request, hook modules written into a temp dir, the CLI run as a child
 * with an explicit env. The inert proofs are the point: with no hook the
 * request is byte-identical to the pre-hook client, and an identity hook
 * changes nothing the fake can see.
 */

import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHarness } from './lib/harness.mjs';
import { createMcpClient, MAX_MCP_ANSWER_BYTES, INERT_TRANSPORT, isTransportHookError, TransportHookError, normaliseTransport } from './lib/mcp-client.mjs';
import { loadTransportHook, mcpTransport, mcpTransportLoaded, validateUrlFrom, hookImportUrl, describeTransport, TRANSPORT_HOOK_VAR } from './mcp-transport.mjs';
import { mcpUrlPolicy, isLocalOrPrivateHost, redactCredentials } from './lib/mcp-url-safety.mjs';
import { capabilityTool } from './lib/contracts/mcp-capabilities.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { childEnv } from '../server/fixtures/serve-child.mjs';

// This process never honours a developer's exported hook: the in-process
// memo (mcpTransport) must resolve inert here.
delete process.env.OBSERVOGRAM_TRANSPORT_HOOK;
delete process.env.TOMOGRAPH_TRANSPORT_HOOK;
delete process.env.OBSERVOGRAM_ALLOW_LOCAL_MCP;
delete process.env.TOMOGRAPH_ALLOW_LOCAL_MCP;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CLI = resolve(ROOT, 'tools/fetch-live-pack.mjs');
const { assert, report } = createHarness({ indent: '  ', truncate: 240 });
const TMP = mkdtempSync(join(tmpdir(), 'observogram-transport-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const hookFile = (name, source) => { const p = join(TMP, name); writeFileSync(p, source); return p; };
const SYSTEM_HEALTH = capabilityTool('system_health');

// ---------- the fake MCP: records { method, path, headers, body } per request ----------

const FAKE_TOOLS = ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines', 'grafana_dashboards_search', 'grafana_dashboard_get'];

async function startFakeMcp({ tools = FAKE_TOOLS, handler = null, failWith = null } = {}) {
  const requests = [];
  const srv = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
    requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body: msg });
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'transport-test-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }));
    };
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp' } });
    if (msg.method === 'notifications/initialized') { res.writeHead(202, { 'Mcp-Session-Id': 'transport-test-session' }); return res.end(); }
    if (msg.method === 'tools/list') return send({ tools: tools.map(name => ({ name })) });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (failWith && failWith.tool === name) { res.writeHead(failWith.status, { 'Content-Type': 'text/plain' }); return res.end(failWith.text || 'upstream unavailable'); }
      const result = handler ? handler(name, msg.params?.arguments || {}) : defaultAnswer(name);
      return send({ content: [{ type: 'text', text: JSON.stringify(result) }] });
    }
    send({});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { address, port } = srv.address();
  return { url: `http://${address}:${port}/mcp`, origin: `http://${address}:${port}`, requests, close: () => new Promise(r => srv.close(r)) };
}
function defaultAnswer(name) {
  if (name === 'system_health') return { services: [] };
  if (name === 'system_topology') return { dependencies: [] };
  return {};
}

// The request as a hook-independent tuple: content-length depends on the
// body's exact bytes, which may embed a clock value in a probe's arguments.
const tuple = (r) => ({
  method: r.method, path: r.path,
  headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== 'content-length')),
  body: { method: r.body?.method, name: r.body?.params?.name },
});

// A client run: initialize, then one tools/call, through whichever transport.
async function twoCalls(fake, transport) {
  const { rpc, callTool } = createMcpClient({ mcpUrl: fake.url, mcpAuth: 'tok', transport });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  return callTool(SYSTEM_HEALTH, {});
}
const expectFail = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ---------- 1. inert by default ----------
{
  const inert = await loadTransportHook({ env: {} });
  assert(JSON.stringify(inert) === JSON.stringify({ prepareRequest: null, fetchImpl: null, validateUrl: null, hookPath: null }),
    'loadTransportHook with no variable resolves the inert transport (no import, no validateUrl)', inert);
  assert(JSON.stringify(normaliseTransport(null)) === JSON.stringify(INERT_TRANSPORT) && JSON.stringify(normaliseTransport(undefined)) === JSON.stringify(INERT_TRANSPORT),
    'normaliseTransport(null | undefined) is INERT_TRANSPORT');
  const memo = mcpTransport();
  assert(memo === mcpTransport() && JSON.stringify(await memo) === JSON.stringify(INERT_TRANSPORT) && mcpTransportLoaded()?.hookPath === null,
    'mcpTransport() memoises one process-wide load; unset here, it is inert');
  assert(describeTransport(await memo) === null, 'an inert transport has no log line');

  // One fake for every variant (the host header is part of the tuple).
  const logs = [];
  const fake = await startFakeMcp();
  try {
    for (const transport of [null, inert, Promise.resolve(inert), undefined]) {
      fake.requests.length = 0;
      await twoCalls(fake, transport);
      logs.push(fake.requests.map(tuple));
    }
  } finally { await fake.close(); }
  const [first] = logs;
  assert(first.length === 2 && first[0].path === '/mcp' && first[1].path === '/mcp', 'two requests, the path untouched');
  const keys = (h) => Object.keys(h).filter(k => !['host', 'connection', 'content-length', 'accept-encoding', 'user-agent', 'accept-language', 'sec-fetch-mode'].includes(k));
  assert(JSON.stringify(keys(first[0].headers)) === JSON.stringify(['content-type', 'accept', 'mcp-protocol-version', 'authorization'])
    && first[0].headers.authorization === 'Bearer tok' && first[0].headers['mcp-protocol-version'] === '2025-06-18'
    && first[0].headers.accept === 'application/json, text/event-stream',
    'call 1 carries exactly content-type, accept, mcp-protocol-version, authorization in that order', keys(first[0].headers));
  assert(JSON.stringify(keys(first[1].headers)) === JSON.stringify(['content-type', 'accept', 'mcp-protocol-version', 'authorization', 'mcp-session-id'])
    && first[1].headers['mcp-session-id'] === 'transport-test-session',
    'call 2 adds mcp-session-id last (the session the fake issued)', keys(first[1].headers));
  assert(logs.every(l => JSON.stringify(l) === JSON.stringify(first)),
    'transport null, the inert object, a promise of it and undefined produce identical request logs');
}

// ---------- 2. prepareRequest applied: sync and async ----------
for (const [label, hook] of [
  ['sync', 'export function prepareRequest({ url, headers }) { return { url: url.replace("/mcp", "/gw/mcp"), headers: { ...headers, "X-Gateway": "1" } }; }'],
  ['async', 'export async function prepareRequest({ url, headers }) { await new Promise(r => setTimeout(r, 2)); return { url: url.replace("/mcp", "/gw/mcp"), headers: { ...headers, "X-Gateway": "1" } }; }'],
]) {
  const path = hookFile(`gateway-${label}.mjs`, hook);
  const transport = await loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: path } });
  assert(typeof transport.prepareRequest === 'function' && transport.fetchImpl === null && transport.hookPath === path && typeof transport.validateUrl === 'function',
    `${label} hook loads with prepareRequest, no fetchImpl, the path and the URL policy`);
  assert(describeTransport(transport) === `${TRANSPORT_HOOK_VAR}=${path} (prepareRequest: yes, fetchImpl: no)`, `${label} hook's log line names the path only`);
  const fake = await startFakeMcp();
  try {
    const result = await twoCalls(fake, transport);
    assert(JSON.stringify(result) === JSON.stringify({ services: [] }), `${label} hook: the call still answers`);
    assert(fake.requests.length === 2 && fake.requests.every(r => r.path === '/gw/mcp' && r.headers['x-gateway'] === '1'),
      `${label} hook: every request carries X-Gateway and the rewritten path`, fake.requests.map(r => [r.path, r.headers['x-gateway']]));
    assert(fake.requests[1].headers['mcp-session-id'] === 'transport-test-session', `${label} hook: the session round-trips through the hook's headers`);
  } finally { await fake.close(); }
}

// ---------- 3. mutate in place, return {}; omitted fields keep the input; merge keeps the session ----------
{
  const inPlace = { prepareRequest: ({ headers }) => { headers['X-In-Place'] = 'yes'; return {}; } };
  const fake = await startFakeMcp();
  try {
    await twoCalls(fake, inPlace);
    assert(fake.requests.every(r => r.path === '/mcp' && r.headers['x-in-place'] === 'yes') && fake.requests[1].headers['mcp-session-id'] === 'transport-test-session',
      'a hook that mutates headers in place and returns {} keeps url and headers (session included)');
  } finally { await fake.close(); }
  const onlyNew = { prepareRequest: () => ({ headers: { 'X-Only': '1' } }) };
  const fake2 = await startFakeMcp();
  try {
    await twoCalls(fake2, onlyNew);
    assert(fake2.requests[1].headers['mcp-session-id'] === 'transport-test-session' && fake2.requests[1].headers.authorization === 'Bearer tok' && fake2.requests[1].headers['x-only'] === '1',
      'returned headers are merged over the built ones: a hook adding one header does not drop Mcp-Session-Id or Authorization');
  } finally { await fake2.close(); }
}

// ---------- 4. Authorization visible and replaceable ----------
{
  let seen = null;
  const exchange = { prepareRequest: ({ headers }) => { seen = headers.Authorization; return { headers: { Authorization: 'Bearer exchanged' } }; } };
  const fake = await startFakeMcp();
  try {
    await twoCalls(fake, exchange);
    assert(seen === 'Bearer tok', 'the hook receives Authorization: Bearer <mcpAuth>');
    assert(fake.requests.every(r => r.headers.authorization === 'Bearer exchanged') && !JSON.stringify(fake.requests.map(r => r.headers)).includes('tok"'),
      'the fake sees the exchanged bearer; the original appears in no header');
  } finally { await fake.close(); }
}

// ---------- 5. fetchImpl replaces the fetcher wholesale ----------
{
  const path = hookFile('fetch-impl.mjs', `
    export const inits = [];
    export async function fetchImpl(url, init) {
      inits.push({ url, init });
      const msg = JSON.parse(init.body);
      const result = msg.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ via: 'fetchImpl', name: msg.params.name }) }] } : {};
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }), { headers: { 'content-type': 'application/json' } });
    }`);
  const transport = await loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: path } });
  assert(transport.prepareRequest === null && typeof transport.fetchImpl === 'function' && describeTransport(transport).endsWith('(prepareRequest: no, fetchImpl: yes)'),
    'a fetchImpl-only hook loads');
  const fake = await startFakeMcp();
  try {
    const result = await twoCalls(fake, transport);
    const { inits } = await import(pathToFileURL(path).href);
    assert(JSON.stringify(result) === JSON.stringify({ via: 'fetchImpl', name: SYSTEM_HEALTH }), 'callTool returns what fetchImpl answered');
    assert(fake.requests.length === 0, 'the fake server saw no request');
    assert(inits.length === 2 && inits.every(i => i.url === fake.url && i.init.method === 'POST' && typeof i.init.body === 'string'
      && i.init.headers.Authorization === 'Bearer tok' && i.init.signal instanceof AbortSignal),
      'fetchImpl receives (url, { method: POST, headers, body, redirect, signal: AbortSignal })', inits.map(i => Object.keys(i.init)));
  } finally { await fake.close(); }

  // fetchImpl's own rejection is an ordinary error — NOT a hook fault.
  const rejecting = { fetchImpl: async () => { throw new Error('ECONNREFUSED gateway'); }, hookPath: '/x/gw.mjs' };
  const fake2 = await startFakeMcp();
  try {
    const e = await expectFail(() => twoCalls(fake2, rejecting));
    assert(e && !isTransportHookError(e) && /ECONNREFUSED gateway/.test(e.message), 'a rejection from fetchImpl propagates unwrapped, like native fetch', e?.message);
    const bad = { fetchImpl: async () => ({ nope: true }), hookPath: '/x/gw.mjs' };
    const e2 = await expectFail(() => twoCalls(fake2, bad));
    assert(isTransportHookError(e2) && e2.message === 'transport hook /x/gw.mjs: fetchImpl returned object, not a Response', 'fetchImpl returning a non-Response is a hook fault', e2?.message);
    // …but its text is still hook text: an echoed header or URL is redacted
    // while the error stays ordinary (name, code and cause kept).
    const echoing = { fetchImpl: async (url, init) => { const err = new Error(`gateway refused ${init.headers.Authorization} for ${url}`); err.code = 'EGATEWAY'; throw err; }, hookPath: '/x/gw.mjs' };
    const { rpc: echoRpc } = createMcpClient({ mcpUrl: `${fake2.url}?token=URLTOKENSENTINEL9&tier=x`, mcpAuth: 'BEARERSENTINEL7', transport: echoing });
    const e3 = await expectFail(() => echoRpc('tools/list', {}));
    assert(e3 && !isTransportHookError(e3) && e3.name === 'Error' && e3.code === 'EGATEWAY' && e3.cause?.message.includes('Bearer BEARERSENTINEL7'),
      'a rejection from fetchImpl that echoes the request stays an ordinary error with its code and cause', e3?.message);
    assert(e3 && !e3.message.includes('BEARERSENTINEL7') && !e3.message.includes('URLTOKENSENTINEL9') && e3.message === `gateway refused Bearer <redacted> for ${fake2.url}?token=<redacted>&tier=x`,
      'the bearer and the URL token value are <redacted> in a fetchImpl rejection; the harmless parameter stays', e3?.message);
    const abortLike = { fetchImpl: async () => { const err = new Error('The operation was aborted'); err.name = 'AbortError'; throw err; }, hookPath: '/x/gw.mjs' };
    const e4 = await expectFail(() => twoCalls(fake2, abortLike));
    assert(e4?.name === 'AbortError' && e4.message === 'The operation was aborted', 'a fetchImpl rejection with a typed name keeps it', e4?.name);

    // What fetchImpl RETURNS is hook text as well: a non-OK body, a JSON-RPC
    // error message and an SSE error message that echo the request are
    // redacted the same way (the error stays an ordinary wire error).
    const echoUrl = `${fake2.url}?token=URLTOKENSENTINEL9&tier=x`;
    const echoText = (url, init) => `gateway refused ${init.headers.Authorization} for ${url}`;
    const returning502 = { fetchImpl: async (url, init) => new Response(echoText(url, init), { status: 502 }), hookPath: '/x/gw.mjs' };
    const { rpc: r502 } = createMcpClient({ mcpUrl: echoUrl, mcpAuth: 'BEARERSENTINEL7', transport: returning502 });
    const e5 = await expectFail(() => r502('tools/list', {}));
    assert(e5 && !isTransportHookError(e5) && e5.message === `MCP HTTP 502 on tools/list: gateway refused Bearer <redacted> for ${fake2.url}?token=<redacted>&tier=x`,
      'the bearer and the URL token value are <redacted> in a non-OK Response body a fetchImpl returns', e5?.message);
    const returningRpcError = { fetchImpl: async (url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: echoText(url, init) } }), { status: 200, headers: { 'content-type': 'application/json' } }), hookPath: '/x/gw.mjs' };
    const { rpc: rRpc } = createMcpClient({ mcpUrl: echoUrl, mcpAuth: 'BEARERSENTINEL7', transport: returningRpcError });
    const e6 = await expectFail(() => rRpc('tools/list', {}));
    assert(e6 && !isTransportHookError(e6) && e6.message === `tools/list: gateway refused Bearer <redacted> for ${fake2.url}?token=<redacted>&tier=x`,
      'a JSON-RPC error message a fetchImpl returns is redacted', e6?.message);
    const returningSseError = { fetchImpl: async (url, init) => new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: echoText(url, init) } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } }), hookPath: '/x/gw.mjs' };
    const { rpc: rSse } = createMcpClient({ mcpUrl: echoUrl, mcpAuth: 'BEARERSENTINEL7', transport: returningSseError });
    const e7 = await expectFail(() => rSse('tools/list', {}));
    assert(e7 && !isTransportHookError(e7) && e7.message === `tools/list: gateway refused Bearer <redacted> for ${fake2.url}?token=<redacted>&tier=x`,
      'an SSE error message a fetchImpl returns is redacted', e7?.message);
  } finally { await fake2.close(); }

  // A native fetch answer is redacted the same way (a declared change: it
  // used to pass through untouched) — the body of a real upstream's 502
  // that repeats the bearer.
  const fake3 = await startFakeMcp({ failWith: { tool: SYSTEM_HEALTH, status: 502, text: 'upstream says Bearer tok' } });
  try {
    const { callTool: nativeCall, rpc: nativeRpc } = createMcpClient({ mcpUrl: `${fake3.url}?token=URLTOKENSENTINEL9`, mcpAuth: 'tok', transport: null });
    await nativeRpc('initialize', {});
    const e8 = await expectFail(() => nativeCall(SYSTEM_HEALTH, {}));
    assert(e8?.message === `MCP HTTP 502 on tools/call: upstream says Bearer <redacted>`, 'without a fetchImpl the upstream body is redacted too', e8?.message);
  } finally { await fake3.close(); }
}

// ---------- 5c. an echoing MCP: every answer text redacted by value, native fetch included ----------
{
  // A loopback MCP that repeats the request's Authorization header and URL
  // in each kind of error answer, reached with native fetch (no hook).
  const echoServer = (mode) => createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
    const echoed = `you sent ${req.headers.authorization} to ${req.url}`;
    if (mode === 'http') { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end(echoed); }
    if (mode === 'nonjson') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(echoed); }
    const frame = (body) => JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, ...body });
    if (mode === 'sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`data: ${frame({ error: { code: -32001, message: echoed } })}\n\n`); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (mode === 'rpc') return res.end(frame({ error: { code: -32001, message: echoed } }));
    return res.end(frame({ result: { isError: true, content: [{ type: 'text', text: echoed }] } }));   // 'tool'
  });
  const echoes = {};
  for (const mode of ['http', 'rpc', 'sse', 'tool', 'nonjson']) {
    const srv = echoServer(mode);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${srv.address().port}/mcp`;
      const { callTool } = createMcpClient({ mcpUrl: `${base}?token=URLTOKENSENTINEL9&tier=x`, mcpAuth: 'BEARERSENTINEL7', transport: null });
      echoes[mode] = (await expectFail(() => callTool(SYSTEM_HEALTH, {})))?.message ?? null;
    } finally { await new Promise(r => srv.close(r)); }
  }
  const said = 'you sent Bearer <redacted> to /mcp?token=<redacted>&tier=x';
  assert(echoes.http === `MCP HTTP 401 on tools/call: ${said}`, 'native fetch: a 401 body repeating the Authorization header is redacted', echoes.http);
  assert(echoes.rpc === `tools/call: ${said}` && echoes.sse === `tools/call: ${said}`, 'native fetch: a JSON-RPC error and an SSE error frame repeating it are redacted', { rpc: echoes.rpc, sse: echoes.sse });
  assert(echoes.tool === `${SYSTEM_HEALTH}: ${said}`, 'a tool\'s isError text repeating it is redacted', echoes.tool);
  assert(echoes.nonjson === 'MCP tools/call: the answer is not valid JSON', 'a body that is not JSON: the parser\'s message, which quotes a cut of it, is replaced whole', echoes.nonjson);

  // A successful answer that repeats the request — a tool's JSON text, a
  // plain text, a tools/list description, over JSON and SSE — is redacted
  // the same way; an answer that holds nothing to redact comes back as it was.
  const okServer = (sse) => createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const msg = JSON.parse(raw || '{}');
    const echoed = `${req.headers.authorization} to ${req.url}`;
    const result = msg.method === 'tools/list'
      ? { tools: [{ name: SYSTEM_HEALTH, description: `sees ${echoed}` }] }
      : msg.params?.arguments?.plain ? { content: [{ type: 'text', text: `plain ${echoed}` }] }
        : { content: [{ type: 'text', text: JSON.stringify({ version: echoed, [echoed]: [echoed, 3], kept: 'v1' }) }] };
    const frame = JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result });
    if (sse) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.end(`data: ${frame}\n\n`); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(frame);
  });
  for (const sse of [false, true]) {
    const srv = okServer(sse);
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${srv.address().port}/mcp`;
      const { rpc, callTool } = createMcpClient({ mcpUrl: `${base}?token=URLTOKENSENTINEL9&tier=x`, mcpAuth: 'BEARERSENTINEL7', transport: null });
      const red = 'Bearer <redacted> to /mcp?token=<redacted>&tier=x';
      const parsed = await callTool(SYSTEM_HEALTH, {});
      assert(JSON.stringify(parsed) === JSON.stringify({ version: red, [red]: [red, 3], kept: 'v1' }),
        `${sse ? 'SSE' : 'JSON'}: a tool's successful JSON answer repeating the Authorization header is redacted, keys included`, parsed);
      const plain = await callTool(SYSTEM_HEALTH, { plain: true });
      assert(plain === `plain ${red}`, `${sse ? 'SSE' : 'JSON'}: a tool's successful plain-text answer is redacted`, plain);
      const listed = await rpc('tools/list', {});
      assert(listed?.tools?.[0]?.description === `sees ${red}`, `${sse ? 'SSE' : 'JSON'}: a tools/list description repeating it is redacted`, listed);
      const bare = createMcpClient({ mcpUrl: base, mcpAuth: null, transport: null });
      const untouched = await bare.callTool(SYSTEM_HEALTH, {});
      assert(untouched.kept === 'v1' && untouched.version === 'undefined to /mcp', 'with nothing to redact the answer comes back as it was', untouched);
    } finally { await new Promise(r => srv.close(r)); }
  }
}

// ---------- 5b. redirects are never followed (D10) ----------
{
  // A fetchImpl that answers 307: refused, naming the Location's origin only
  // (never its path or query), and every request asked for redirect: 'manual'.
  const inits = [];
  const redirecting = {
    fetchImpl: async (url, init) => { inits.push(init); return new Response('', { status: 307, headers: { location: 'https://elsewhere.example:8443/mcp/v2?token=LOCSECRET5' } }); },
    hookPath: '/x/gw.mjs',
  };
  const { rpc: rRedirect } = createMcpClient({ mcpUrl: 'http://127.0.0.1:9/mcp', mcpAuth: 'tok', transport: redirecting });
  const e1 = await expectFail(() => rRedirect('initialize', {}));
  assert(e1 && !isTransportHookError(e1) && e1.message === 'MCP HTTP 307 on initialize: the MCP answered with a redirect to https://elsewhere.example:8443 — Observogram does not follow redirects; register (or type) the URL it points at',
    'a 307 a fetchImpl returns is refused, naming the origin it pointed at and nothing of its path or query', e1?.message);
  assert(inits.length === 1 && inits[0].redirect === 'manual', 'every request asks the fetcher for redirect: manual', inits.map(i => i.redirect));

  // Native fetch against a loopback server answering 302 to a second one:
  // the error names the target's origin and the target sees no request.
  const target = await startFakeMcp();
  const bouncer = createServer((req, res) => { req.resume(); res.writeHead(302, { Location: `${target.url}?from=bounce` }); res.end(); });
  await new Promise(r => bouncer.listen(0, '127.0.0.1', r));
  try {
    const { rpc: nativeRpc } = createMcpClient({ mcpUrl: `http://127.0.0.1:${bouncer.address().port}/mcp`, mcpAuth: 'tok', transport: null });
    const e2 = await expectFail(() => nativeRpc('initialize', {}));
    assert(e2?.message === `MCP HTTP 302 on initialize: the MCP answered with a redirect to ${target.origin} — Observogram does not follow redirects; register (or type) the URL it points at`
      && target.requests.length === 0,
    'native fetch: a 302 is refused with the same text and the redirect target receives no request', { message: e2?.message, reached: target.requests.length });
  } finally { await new Promise(r => bouncer.close(r)); await target.close(); }
}

// ---------- 5d. a caller's AbortSignal aborts requests in flight (C1) ----------
{
  // A fetchImpl that never answers but honours init.signal: the caller's
  // abort ends the request promptly, long before the request timeout.
  const inits = [];
  const hanging = {
    fetchImpl: (url, init) => new Promise((_, reject) => {
      inits.push(init);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
    hookPath: '/x/hang.mjs',
  };
  const controller = new AbortController();
  const { rpc } = createMcpClient({ mcpUrl: 'http://127.0.0.1:9/mcp', mcpAuth: 'tok', timeoutMs: 60_000, transport: hanging, signal: controller.signal });
  const started = Date.now();
  const pending = expectFail(() => rpc('tools/list', {}));
  await new Promise(r => setTimeout(r, 20));
  controller.abort();
  const e1 = await pending;
  assert(e1?.name === 'AbortError' && !isTransportHookError(e1) && Date.now() - started < 5_000,
    'aborting the caller\'s signal ends a request in flight with an AbortError, before its 60 s timeout', { name: e1?.name, ms: Date.now() - started });
  assert(inits.length === 1 && inits[0].signal !== controller.signal && inits[0].signal.aborted,
    'the request carried a signal of its own (the timeout combined with the caller\'s), now aborted');
  const e2 = await expectFail(() => rpc('tools/list', {}));
  assert(e2?.name === 'AbortError' && inits.length === 1, 'a request after the abort is refused at once, before the transport sees it', { name: e2?.name, sent: inits.length });

  // Native fetch against a loopback server that never answers.
  const sockets = new Set();
  const silent = createServer((req) => { req.resume(); });
  silent.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
  await new Promise(r => silent.listen(0, '127.0.0.1', r));
  try {
    const native = new AbortController();
    const { rpc: nativeRpc } = createMcpClient({ mcpUrl: `http://127.0.0.1:${silent.address().port}/mcp`, mcpAuth: 'tok', timeoutMs: 60_000, transport: null, signal: native.signal });
    const t0 = Date.now();
    const waiting = expectFail(() => nativeRpc('initialize', {}));
    setTimeout(() => native.abort(), 50);
    const e3 = await waiting;
    assert(e3?.name === 'AbortError' && Date.now() - t0 < 5_000, 'native fetch: the caller\'s abort ends the request in flight promptly', { name: e3?.name, ms: Date.now() - t0 });
  } finally { for (const sock of sockets) sock.destroy(); await new Promise(r => silent.close(r)); }

  // Without a signal each request still carries its own timeout, as before.
  const plain = [];
  const recording = { fetchImpl: async (url, init) => { plain.push(init); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'content-type': 'application/json' } }); } };
  await createMcpClient({ mcpUrl: 'http://127.0.0.1:9/mcp', transport: recording }).rpc('tools/list', {});
  assert(plain.length === 1 && plain[0].signal instanceof AbortSignal && !plain[0].signal.aborted, 'no caller signal: the request\'s timeout signal alone');
}

// ---------- 5e. an MCP answer is capped (C1): counted while read, past it the client stops ----------
{
  const KIB = 1024;
  const rpcBody = (result) => JSON.stringify({ jsonrpc: '2.0', id: 1, result });
  // The text as a stream of `size`-byte chunks, recording how many were pulled and whether it was released.
  const streamed = (text, { size = 512 } = {}) => {
    const bytes = new TextEncoder().encode(text);
    const pulled = { n: 0, cancelled: false };
    const body = new ReadableStream({
      pull(controller) {
        const start = pulled.n * size;
        if (start >= bytes.length) { controller.close(); return; }
        pulled.n++;
        controller.enqueue(bytes.slice(start, start + size));
      },
      cancel() { pulled.cancelled = true; },
    });
    return { body, pulled };
  };
  const client = (respond) => createMcpClient({ mcpUrl: 'http://127.0.0.1:9/mcp', mcpAuth: 'tok', maxAnswerBytes: 4 * KIB, transport: { fetchImpl: async () => respond() } });

  assert(MAX_MCP_ANSWER_BYTES === 32 * 1024 * 1024, 'the default cap is 32 MiB');
  // JSON past the cap: refused with the sentence, the stream released after the cap, not read to its end.
  const big = streamed(rpcBody({ blob: 'x'.repeat(64 * KIB) }));
  const e1 = await expectFail(() => client(() => new Response(big.body, { headers: { 'content-type': 'application/json' } })).rpc('tools/list', {}));
  assert(e1?.message === 'MCP tools/list: the answer exceeded 4 KiB — Observogram stopped reading it' && !isTransportHookError(e1),
    'a JSON body past the cap is cut with the cap\'s text', e1?.message);
  assert(big.pulled.n <= 10 && big.pulled.cancelled, 'the client stopped reading at the cap and released the stream', big.pulled);
  // An SSE stream past the cap before its first complete frame.
  const sse = streamed(`data: ${rpcBody({ blob: 'y'.repeat(64 * KIB) })}\n\n`);
  const e2 = await expectFail(() => client(() => new Response(sse.body, { headers: { 'content-type': 'text/event-stream' } })).rpc('tools/list', {}));
  assert(e2?.message === 'MCP tools/list: the answer exceeded 4 KiB — Observogram stopped reading it' && sse.pulled.cancelled,
    'an SSE stream past the cap is cut with the same text and released', { message: e2?.message, pulled: sse.pulled });
  // Under the cap: answered as before, JSON and SSE.
  const small = await client(() => new Response(rpcBody({ ok: 'é'.repeat(100) }), { headers: { 'content-type': 'application/json' } })).rpc('tools/list', {});
  const smallSse = await client(() => new Response(`data: ${rpcBody({ ok: 1 })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })).rpc('tools/list', {});
  assert(small?.ok === 'é'.repeat(100) && smallSse?.ok === 1, 'an answer under the cap reads as before (multi-byte text decoded whole)', [small, smallSse]);
  // A non-OK body past the cap: the error says so in place of the body.
  const e3 = await expectFail(() => client(() => new Response(streamed('z'.repeat(64 * KIB)).body, { status: 502 })).rpc('tools/call', {}));
  assert(e3?.message === 'MCP HTTP 502 on tools/call: the answer exceeded 4 KiB — Observogram stopped reading it', 'a non-OK body past the cap: the status, and the cap in place of the body', e3?.message);
  // A Response-like without a readable body: its content-length refuses it unread; else counted after text().
  let textRead = false;
  const declared = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json', 'content-length': String(64 * KIB) }), text: async () => { textRead = true; return rpcBody({}); }, json: async () => ({}) };
  const e4 = await expectFail(() => client(() => declared).rpc('tools/list', {}));
  assert(e4?.message === 'MCP tools/list: the answer exceeded 4 KiB — Observogram stopped reading it' && !textRead, 'a declared content-length past the cap is refused without reading', e4?.message);
  const undeclared = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), text: async () => rpcBody({ blob: 'w'.repeat(64 * KIB) }), json: async () => ({}) };
  const e5 = await expectFail(() => client(() => undeclared).rpc('tools/list', {}));
  assert(e5?.message === 'MCP tools/list: the answer exceeded 4 KiB — Observogram stopped reading it', 'without a readable body or a length, text() is counted', e5?.message);
  // Native fetch against loopback, a 1 MiB cap and a 2 MiB answer.
  const huge = createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(rpcBody({ blob: 'v'.repeat(2 * 1024 * 1024) })); });
  await new Promise(r => huge.listen(0, '127.0.0.1', r));
  try {
    const { rpc: nativeRpc } = createMcpClient({ mcpUrl: `http://127.0.0.1:${huge.address().port}/mcp`, maxAnswerBytes: 1024 * 1024, transport: null });
    const e6 = await expectFail(() => nativeRpc('tools/list', {}));
    assert(e6?.message === 'MCP tools/list: the answer exceeded 1 MiB — Observogram stopped reading it', 'native fetch: a JSON body past the cap is cut', e6?.message);
  } finally { await new Promise(r => huge.close(r)); }
}

// ---------- 6. load failures ----------
{
  const missing = join(TMP, 'does-not-exist.mjs');
  const e1 = await expectFail(() => loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: missing } }));
  assert(isTransportHookError(e1) && e1 instanceof TransportHookError && e1.message.startsWith(`OBSERVOGRAM_TRANSPORT_HOOK: cannot load ${missing}: `) && e1.hookPath === missing,
    'a missing hook file rejects with "cannot load <path>"', e1?.message);
  const empty = hookFile('empty.mjs', 'export const unrelated = 1;\n');
  const e2 = await expectFail(() => loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: empty } }));
  assert(e2?.message === `OBSERVOGRAM_TRANSPORT_HOOK: ${empty} exports neither prepareRequest nor fetchImpl`, 'a module without the two exports is refused', e2?.message);
  const notFn = hookFile('not-fn.mjs', 'export const prepareRequest = 42;\n');
  const e3 = await expectFail(() => loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: notFn } }));
  assert(e3?.message === `OBSERVOGRAM_TRANSPORT_HOOK: ${notFn} exports prepareRequest, which is not a function`, 'a non-function prepareRequest is refused', e3?.message);
  const notFn2 = hookFile('not-fn2.mjs', 'export function prepareRequest(r) { return r; }\nexport const fetchImpl = "fetch";\n');
  const e4 = await expectFail(() => loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: notFn2 } }));
  assert(e4?.message === `OBSERVOGRAM_TRANSPORT_HOOK: ${notFn2} exports fetchImpl, which is not a function`, 'a non-function fetchImpl is refused even beside a valid prepareRequest', e4?.message);
  const syntaxErr = hookFile('syntax.mjs', 'export function prepareRequest( {\n');
  const e5 = await expectFail(() => loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: syntaxErr } }));
  assert(e5?.message.startsWith(`OBSERVOGRAM_TRANSPORT_HOOK: cannot load ${syntaxErr}: `) && e5.cause instanceof Error, 'a module that fails to parse is "cannot load" with the cause kept', e5?.message);

  const identity = hookFile('identity.mjs', 'export const prepareRequest = (r) => r;\n');
  const legacy = await loadTransportHook({ env: { TOMOGRAPH_TRANSPORT_HOOK: identity } });
  assert(legacy.hookPath === identity && typeof legacy.prepareRequest === 'function', 'the TOMOGRAPH_TRANSPORT_HOOK spelling loads (brand-env rule)');
  const both = await loadTransportHook({ env: { TOMOGRAPH_TRANSPORT_HOOK: missing, OBSERVOGRAM_TRANSPORT_HOOK: identity } });
  assert(both.hookPath === identity, 'OBSERVOGRAM_ wins over TOMOGRAPH_ when both are set');
  const e6 = await expectFail(() => loadTransportHook({ env: { TOMOGRAPH_TRANSPORT_HOOK: missing } }));
  assert(e6?.message.startsWith('OBSERVOGRAM_TRANSPORT_HOOK: cannot load'), 'the error spells the modern name even when the legacy spelling supplied the path', e6?.message);
  const asUrl = await loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: pathToFileURL(identity).href } });
  assert(asUrl.hookPath === pathToFileURL(identity).href && typeof asUrl.prepareRequest === 'function', 'a file: URL is imported as given');
  const rel = relative(process.cwd(), identity);
  assert(hookImportUrl(rel) === pathToFileURL(identity).href && hookImportUrl(pathToFileURL(identity).href) === pathToFileURL(identity).href,
    'a relative path resolves against process.cwd(); a file: URL is kept', hookImportUrl(rel));
  assert(typeof (await loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: rel } })).prepareRequest === 'function', 'the relative path loads');
  const blank = await loadTransportHook({ env: { OBSERVOGRAM_TRANSPORT_HOOK: '   ' } });
  assert(blank.hookPath === null && blank.prepareRequest === null, 'a blank value is unset');
}

// ---------- 7. call-time faults: wrapped, redacted, no partial state ----------
{
  const URL_WITH_TOKEN = (fake) => `${fake.url}?token=URLTOKENSENTINEL9&tier=x`;
  const faultOf = async (fake, transport, { mcpUrl = fake.url, mcpAuth = 'tok' } = {}) => {
    const { rpc } = createMcpClient({ mcpUrl, mcpAuth, transport });
    return expectFail(() => rpc('initialize', {}));
  };
  const fake = await startFakeMcp();
  try {
    const throwing = { prepareRequest: ({ url, headers }) => { throw new Error(`gateway refused ${headers.Authorization} for ${url}`); }, hookPath: '/x/hook.mjs' };
    const e = await faultOf(fake, throwing, { mcpUrl: URL_WITH_TOKEN(fake) });
    assert(isTransportHookError(e) && e.hookPath === '/x/hook.mjs' && e.message.startsWith('transport hook /x/hook.mjs: prepareRequest threw: gateway refused'),
      'a throwing prepareRequest is a TransportHookError naming the hook and its text', e?.message);
    assert(!e.message.includes('tok') && !e.message.includes('URLTOKENSENTINEL9') && (e.message.match(/<redacted>/g) || []).length >= 2 && e.message.includes('tier=x'),
      'the bearer and the URL token value are <redacted> in the hook\'s error text; the harmless parameter stays', e?.message);
    const userinfo = { prepareRequest: ({ url }) => { throw new Error(`no route for ${url}`); } };
    const eu = await faultOf(fake, userinfo, { mcpUrl: fake.url.replace('http://', 'http://alice:s3cr3tpw@') });
    assert(!eu.message.includes('s3cr3tpw') && eu.message.includes('<redacted>'), 'the URL\'s password is redacted too', eu?.message);
    assert(fake.requests.length === 0, 'nothing reached the wire');

    const cases = [
      [{ prepareRequest: () => null }, 'prepareRequest returned null, not { url, headers }'],
      [{ prepareRequest: () => 'nope' }, 'prepareRequest returned string, not { url, headers }'],
      [{ prepareRequest: () => [] }, 'prepareRequest returned an array, not { url, headers }'],
      [{ prepareRequest: () => ({ url: 42 }) }, 'prepareRequest returned a url that is not a string'],
      [{ prepareRequest: () => ({ headers: 'x' }) }, 'prepareRequest returned headers that are not an object'],
      [{ prepareRequest: () => ({ headers: ['a'] }) }, 'prepareRequest returned headers that are not an object'],
      [{ prepareRequest: () => ({ headers: { 'X-Bad': { v: 1 } } }) }, 'prepareRequest returned header "X-Bad" with a value that is not a string'],
      [{ prepareRequest: () => ({ headers: { 'X-Split': 'a\r\nInjected: b' } }) }, 'prepareRequest returned header "X-Split" containing CR or LF'],
      [{ prepareRequest: () => ({ headers: { 'X-Nl\n': 'x' } }) }, 'prepareRequest returned header "X-Nl " containing CR or LF'],
      [{ prepareRequest: () => ({ url: 'file:///etc/passwd' }) }, 'prepareRequest returned a URL that is not http(s): file:///etc/passwd'],
      [{ prepareRequest: () => ({ url: 'not a url' }) }, 'prepareRequest returned a URL that is not http(s): <not a URL>'],
      [{ prepareRequest: 'nope' }, 'prepareRequest is string, not a function'],
    ];
    for (const [transport, text] of cases) {
      const err = await faultOf(fake, transport);
      assert(isTransportHookError(err) && err.message === `transport hook (inline): ${text}`, `fault: ${text}`, err?.message);
    }
    assert(fake.requests.length === 0, 'none of the faults reached the wire');
    const eNum = await faultOf(fake, { prepareRequest: () => ({ headers: { 'X-Num': 7 } }) });
    assert(eNum === null && fake.requests.at(-1)?.headers['x-num'] === '7', 'a numeric header value is allowed (sent as a string)');
  } finally { await fake.close(); }

  // The final URL passes the policy the loader supplies.
  const fake2 = await startFakeMcp();
  try {
    const toLoopback = ({ url }) => ({ url: url.replace(fake2.origin, 'http://127.0.0.1:1') });
    const strict = { prepareRequest: toLoopback, validateUrl: validateUrlFrom({ OBSERVOGRAM_ALLOW_LOCAL_MCP: '0' }), hookPath: '/x/h.mjs' };
    const e = await faultOf(fake2, strict);
    assert(e?.message === 'transport hook /x/h.mjs: mcpUrl targets a local/private address (127.0.0.1), which OBSERVOGRAM_ALLOW_LOCAL_MCP=0 forbids',
      'under OBSERVOGRAM_ALLOW_LOCAL_MCP=0 a hook cannot point at a loopback address', e?.message);
    const lax = { prepareRequest: ({ url }) => ({ url }), validateUrl: validateUrlFrom({}), hookPath: '/x/h.mjs' };
    assert((await faultOf(fake2, lax)) === null && fake2.requests.length === 1, 'the same loopback URL passes with the default posture');
    const legacyStrict = { prepareRequest: toLoopback, validateUrl: validateUrlFrom({ TOMOGRAPH_ALLOW_LOCAL_MCP: '0' }) };
    assert(/ALLOW_LOCAL_MCP=0 forbids/.test((await faultOf(fake2, legacyStrict))?.message), 'TOMOGRAPH_ALLOW_LOCAL_MCP=0 is read by the same rule');
    // A fetchImpl-only hook leaves the URL alone, so no policy runs.
    const fetchOnly = { fetchImpl: () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { headers: { 'content-type': 'application/json' } }), validateUrl: () => ({ error: 'must not run' }) };
    assert((await faultOf(fake2, fetchOnly)) === null, 'validateUrl is not consulted when no prepareRequest ran (the URL is the caller\'s, already validated)');
  } finally { await fake2.close(); }

  // Ordinary wire failures stay ordinary with a hook present.
  const closed = await startFakeMcp();
  const closedUrl = closed.url;
  await closed.close();
  const eWire = await (async () => { const { rpc } = createMcpClient({ mcpUrl: closedUrl, transport: { prepareRequest: (r) => r, hookPath: '/x/h.mjs' } }); return expectFail(() => rpc('initialize', {})); })();
  assert(eWire && !isTransportHookError(eWire), 'ECONNREFUSED through a prepareRequest-only hook is not a hook fault', eWire?.message);
  const fake503 = await startFakeMcp({ failWith: { tool: 'system_health', status: 503 } });
  try {
    const e503 = await expectFail(() => twoCalls(fake503, { prepareRequest: (r) => r, hookPath: '/x/h.mjs' }));
    assert(e503 && !isTransportHookError(e503) && /MCP HTTP 503 on tools\/call/.test(e503.message), 'an HTTP 503 through a hook is the ordinary MCP HTTP error', e503?.message);
  } finally { await fake503.close(); }
}

// ---------- 8. mcpUrlPolicy: the pure form of validateMcpUrl's table ----------
{
  for (const bad of ['file:///etc/passwd', 'ftp://host/x', 'gopher://host/x', 'javascript:alert(1)']) {
    assert(mcpUrlPolicy(bad).error === `mcpUrl must be http or https; got scheme '${bad.split(':')[0]}'`, `policy rejects scheme ${bad.split(':')[0]}:`, mcpUrlPolicy(bad));
  }
  assert(mcpUrlPolicy('not a url at all').error === 'mcpUrl is not a valid URL: not a url at all' && !!mcpUrlPolicy('').error, 'policy rejects unparseable and empty input');
  assert(mcpUrlPolicy('https://user:secret@host.invalid bad').error === 'mcpUrl is not a valid URL: https://***@host.invalid bad', 'the unparseable text is redacted', mcpUrlPolicy('https://user:secret@host.invalid bad'));
  const pub = mcpUrlPolicy('https://user:secret@mcp.example.com/path?token=1&tier=x');
  assert(JSON.stringify(pub) === JSON.stringify({ safeUrl: 'https://mcp.example.com/path?tier=x', local: false }), 'a public URL → { safeUrl (stripped), local: false }', pub);
  const loop = mcpUrlPolicy('http://127.0.0.1:3001/mcp');
  assert(JSON.stringify(loop) === JSON.stringify({ safeUrl: 'http://127.0.0.1:3001/mcp', local: true }), 'a loopback URL is allowed by default and flagged local', loop);
  assert(mcpUrlPolicy('http://127.0.0.1:3001/mcp', { allowLocal: false }).error === 'mcpUrl targets a local/private address (127.0.0.1), which OBSERVOGRAM_ALLOW_LOCAL_MCP=0 forbids'
    && mcpUrlPolicy('http://192.168.1.34:3001/mcp', { allowLocal: false }).error?.includes('192.168.1.34')
    && !mcpUrlPolicy('https://mcp.example.com/x', { allowLocal: false }).error, 'allowLocal: false refuses loopback and RFC1918, keeps public hosts');
  for (const [raw, label] of [['http://0x7f000001/', 'hex'], ['http://2130706433/', 'decimal'], ['http://0177.0.0.1/', 'octal']]) {
    assert(!mcpUrlPolicy(raw).error && !!mcpUrlPolicy(raw, { allowLocal: false }).error, `${label} IPv4 normalises to loopback (lax ok, strict refused)`);
  }
  const PRIVATE = ['127.0.0.1', '10.0.0.1', '192.168.1.34', '169.254.169.254', '0.0.0.0', '172.16.0.1', '172.31.255.255', 'localhost', 'foo.localhost', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'];
  const PUBLIC = ['8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', 'mcp.example.com', '2606:4700::1111', '::ffff:8.8.8.8'];
  assert(PRIVATE.every(isLocalOrPrivateHost) && !PUBLIC.some(isLocalOrPrivateHost), 'isLocalOrPrivateHost classifies the table');
  assert(redactCredentials('https://user:secret@x.test/a https://t0ken@y.test/b') === 'https://***@x.test/a https://***@y.test/b', 'redactCredentials masks userinfo');
}

// ---------- 9. the CLI: hard fail, no partial pack; positive run ----------

// The fake lives in this process, so the CLI is spawned asynchronously.
function runCli(env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI], { cwd: ROOT, env: childEnv(null, { OBSERVOGRAM_TRANSPORT_HOOK: '', TOMOGRAPH_TRANSPORT_HOOK: '', OBSERVOGRAM_DEBUG: '', ...env }) });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}
const outDir = join(TMP, 'out');
mkdirSync(outDir);
{
  const throwing = hookFile('cli-throwing.mjs', 'export function prepareRequest({ headers }) { throw new Error(`refused ${headers.Authorization}`); }\n');
  const fake = await startFakeMcp();
  try {
    const out1 = join(outDir, 'throwing.pack.yaml');
    const r = await runCli({ MCP_URL: fake.url, MCP_AUTH: 'cli-tok-sentinel', OUTPUT: out1, OBSERVOGRAM_TRANSPORT_HOOK: throwing });
    assert(r.status === 1 && /\[fetch-live-pack\] FATAL: transport hook .*prepareRequest threw: refused/.test(r.stderr), 'a throwing hook: exit 1 with the FATAL line', { status: r.status, stderr: r.stderr.slice(-300) });
    assert(!r.stderr.includes('cli-tok-sentinel') && r.stderr.includes('<redacted>'), 'the bearer is redacted from the FATAL line');
    assert(!existsSync(out1), 'no pack written');
    assert(fake.requests.length === 0, 'nothing reached the fake');
    const seeded = join(outDir, 'seeded.pack.yaml');
    writeFileSync(seeded, 'sentinel: previous pack\n');
    const r2 = await runCli({ MCP_URL: fake.url, OUTPUT: seeded, OBSERVOGRAM_TRANSPORT_HOOK: throwing });
    assert(r2.status === 1 && readFileSync(seeded, 'utf8') === 'sentinel: previous pack\n', 'a pre-existing OUTPUT is left byte-identical');
    const r3 = await runCli({ MCP_URL: fake.url, OUTPUT: join(outDir, 'missing.pack.yaml'), OBSERVOGRAM_TRANSPORT_HOOK: join(TMP, 'nope.mjs') });
    assert(r3.status === 1 && /FATAL: OBSERVOGRAM_TRANSPORT_HOOK: cannot load .*nope\.mjs/.test(r3.stderr) && !existsSync(join(outDir, 'missing.pack.yaml')),
      'a hook that cannot load: exit 1, "cannot load", no file', r3.stderr.slice(-300));
    const r4 = await runCli({ MCP_URL: fake.url, OUTPUT: join(outDir, 'legacy.pack.yaml'), TOMOGRAPH_TRANSPORT_HOOK: join(TMP, 'nope.mjs') });
    assert(r4.status === 1 && /OBSERVOGRAM_TRANSPORT_HOOK: cannot load/.test(r4.stderr), 'the legacy spelling is honoured by the CLI too (and the modern name reported)');
  } finally { await fake.close(); }

  // Positive: a header hook; every request the fake saw carries it.
  const gateway = hookFile('cli-gateway.mjs', 'export function prepareRequest({ url, headers }) { return { url, headers: { ...headers, "X-Gateway": "cli" } }; }\n');
  const fake2 = await startFakeMcp();
  try {
    const out2 = join(outDir, 'gateway.pack.yaml');
    const r = await runCli({ MCP_URL: fake2.url, OUTPUT: out2, OBSERVOGRAM_TRANSPORT_HOOK: gateway });
    assert(r.status === 0 && existsSync(out2), 'a header hook: exit 0 and the pack is written', { status: r.status, stderr: r.stderr.slice(-400) });
    const pack = parseYaml(readFileSync(out2, 'utf8'));
    assert(pack?.metadata?.name === 'production-live' && pack.metadata.annotations['mcp.url'] === fake2.url, 'the written pack parses and names the MCP URL');
    assert(fake2.requests.length > 0 && fake2.requests.every(r => r.headers['x-gateway'] === 'cli'), `every one of the fake's ${fake2.requests.length} requests carries X-Gateway`);
    const lines = r.stderr.split('\n').filter(l => l.includes('transport hook'));
    assert(lines.length === 1 && lines[0] === `[fetch-live-pack] transport hook: OBSERVOGRAM_TRANSPORT_HOOK=${gateway} (prepareRequest: yes, fetchImpl: no)`,
      'the CLI logs the hook path exactly once (the loader itself is silent)', lines);
  } finally { await fake2.close(); }
}

// ---------- 10. inert proof across the CLI: no hook vs an identity hook ----------
{
  const identity = hookFile('cli-identity.mjs', 'export const prepareRequest = (r) => r;\n');
  const runs = [];
  const fake = await startFakeMcp();   // one fake: the host header is part of the tuple
  try {
    for (const hook of ['', identity]) {
      fake.requests.length = 0;
      const out = join(outDir, `inert-${hook ? 'hook' : 'none'}.pack.yaml`);
      const r = await runCli({ MCP_URL: fake.url, MCP_AUTH: 'tok', OUTPUT: out, OBSERVOGRAM_TRANSPORT_HOOK: hook });
      assert(r.status === 0, `inert proof run (${hook ? 'identity hook' : 'no hook'}) exits 0`, r.stderr.slice(-300));
      runs.push({ tuples: fake.requests.map(tuple), stderr: r.stderr, hook });
    }
  } finally { await fake.close(); }
  const [none, ident] = runs;
  assert(none.tuples.length > 3 && JSON.stringify(none.tuples) === JSON.stringify(ident.tuples),
    `the normalised request logs (method, path, headers, body.method, body.params.name) are identical across ${none.tuples.length} requests`,
    { none: none.tuples.length, ident: ident.tuples.length });
  assert(!none.stderr.includes('transport hook') && ident.stderr.includes('transport hook: OBSERVOGRAM_TRANSPORT_HOOK='), 'only the hooked run logs a hook line');
}

// ---------- 11. a 503 on one probe with a hook present is a probe failure, not a FATAL ----------
{
  const identity = hookFile('cli-identity-503.mjs', 'export const prepareRequest = (r) => r;\n');
  const packs = [];
  for (const hook of ['', identity]) {
    const fake = await startFakeMcp({ failWith: { tool: 'grafana_dashboards_search', status: 503, text: 'upstream temporarily unavailable' } });
    try {
      const out = join(outDir, `probe503-${hook ? 'hook' : 'none'}.pack.yaml`);
      const r = await runCli({ MCP_URL: fake.url, OUTPUT: out, OBSERVOGRAM_TRANSPORT_HOOK: hook });
      assert(r.status === 0 && existsSync(out), `503 on a probe (${hook ? 'hook' : 'no hook'}): exit 0, pack written`, r.stderr.slice(-300));
      const ann = parseYaml(readFileSync(out, 'utf8')).metadata.annotations;
      const retried = fake.requests.filter(q => q.body?.params?.name === 'grafana_dashboards_search').length;
      packs.push({ failed: ann['mcp.probesFailed'] || '', err: ann['mcp.probeErrors.dashboards'] || '', retried });
    } finally { await fake.close(); }
  }
  assert(packs[0].failed.split(',').includes('dashboards') && /HTTP 503/.test(packs[0].err), 'the probe is annotated as failed with the HTTP 503', packs[0]);
  assert(JSON.stringify(packs[0]) === JSON.stringify(packs[1]) && packs[1].retried === 2, 'with the hook the annotation and the single retry are the same as without', packs);
}

// ---------- 12. purity ----------
{
  const src = readFileSync(resolve(ROOT, 'tools/lib/mcp-client.mjs'), 'utf8');
  assert(!/node:/.test(src) && !/process\.env/.test(src) && !/\bprocess\b\s*\./.test(src), 'tools/lib/mcp-client.mjs imports no node:* module and reads no process (browser-safe, vendorable)');
  assert([...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).join() === './mcp-url-safety.mjs', 'its only import is ./mcp-url-safety.mjs');
  const safety = readFileSync(resolve(ROOT, 'tools/lib/mcp-url-safety.mjs'), 'utf8');
  assert(!/^\s*import\b/m.test(safety) && !/process\./.test(safety), 'tools/lib/mcp-url-safety.mjs still imports nothing and reads no env');
}

report('mcp-transport', 'the transport hook applies to every MCP call, is inert when unset, and faults hard without a partial pack.');
