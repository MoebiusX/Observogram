// server/fixtures/fake-mcp.mjs — the fake MCP the server suites share (moved
// from server/test-smoke.mjs) and the registration helper that points the
// studio at it.
//
// startFakeMcp(toolNames, handler, { echo }) is a plain node:http server on
// 127.0.0.1 that speaks the MCP JSON-RPC methods the fetcher and the deploy
// routes send: initialize, tools/list (the names given) and tools/call
// (`handler(name, args)` answers when given; the default echoes { ok, name },
// enough for the deploy path, whose tools return opaque ids). It records
// every tools/call's params (`calls`) and every request's Authorization
// header (`authHeaders`, null when none). Two test seams:
//
//   - hold(toolName): a gate that holds every tools/call of that tool open
//     until released — { reached, release() }, `reached` resolving on the
//     first held call — so a suite can observe a fetch in flight.
//   - echo: an MCP that repeats the request's Authorization header in its
//     error answers, so a suite can prove a credential never travels back
//     to a caller: 'http' answers every request HTTP 401 with the header in
//     the body; 'rpc' answers tools/call with a JSON-RPC error carrying it;
//     'tool' answers tools/call with an isError result carrying it.
//
// registerMcpEndpoint(base, body, { headers }) registers an MCP endpoint in
// the caller's org through POST /api/mcp-endpoints with the CSRF header
// (the open-loopback posture needs it; a session's cookie goes in
// `headers`), answering { status, json, id } — the suite asserts. Its
// endpointIdFor(base, url, opts) form throws unless the record was made and
// answers the id the draft, refresh and deploy routes take as
// mcpEndpointId.
//
// This module imports no server code.

import { createServer } from 'node:http';

const ECHO_MODES = new Set(['http', 'rpc', 'tool']);

export async function startFakeMcp(toolNames, handler = null, { echo = null } = {}) {
  if (echo !== null && !ECHO_MODES.has(echo)) throw new TypeError(`fake MCP: echo is one of ${[...ECHO_MODES].join(', ')}`);
  const calls = [];
  const authHeaders = [];   // the Authorization header of every request, null when none
  const gates = new Map();   // tool name → { hold, release }
  const srv = createServer(async (req, res) => {
    const authorization = req.headers.authorization ?? null;
    authHeaders.push(authorization);
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
    const echoed = `the request said Authorization: ${authorization}`;
    if (echo === 'http') {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end(`unauthorized — ${echoed}`);
      return;
    }
    const reply = (body) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'smoke-session',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, ...body }));
    };
    const send = (result) => reply({ result });
    if (msg.method === 'initialize') {
      send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp' } });
      return;
    }
    if (msg.method === 'tools/list') {
      send({ tools: toolNames.map(name => ({ name })) });
      return;
    }
    if (msg.method === 'tools/call') {
      calls.push(msg.params);
      const gate = gates.get(msg.params?.name);
      if (gate) await gate.hold();
      if (echo === 'rpc') { reply({ error: { code: -32001, message: echoed } }); return; }
      if (echo === 'tool') { send({ isError: true, content: [{ type: 'text', text: echoed }] }); return; }
      const answer = handler ? handler(msg.params?.name, msg.params?.arguments || {}) : { ok: true, name: msg.params?.name };
      send({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
      return;
    }
    send({});
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const url = `http://${addr.address}:${addr.port}/mcp`;
  return {
    url,
    origin: new URL(url).origin,
    calls,
    authHeaders,
    hold(toolName) {
      let reach;
      let open;
      const reached = new Promise(resolve => { reach = resolve; });
      const opened = new Promise(resolve => { open = resolve; });
      const release = () => { if (gates.get(toolName) === gate) gates.delete(toolName); open(); };
      const gate = { hold: () => { reach(); return opened; }, release };
      gates.set(toolName, gate);
      return { reached, release };
    },
    close: () => {
      for (const gate of [...gates.values()]) gate.release();   // a held call answers, so close() can finish
      return new Promise(resolve => srv.close(resolve));
    },
  };
}

// POST /api/mcp-endpoints with the CSRF header: { status, json, id } (id null unless 201).
export async function registerMcpEndpoint(base, body, { headers = {} } = {}) {
  const r = await fetch(`${base}/api/mcp-endpoints`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Observogram-CSRF': '1', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, id: r.status === 201 ? json?.endpoint?.id ?? null : null, text };
}

let seq = 0;
// The id of a fresh endpoint at `url` (a generated name unless one is given); throws unless it was made.
export async function endpointIdFor(base, url, { name = `fake-mcp-${++seq}`, readTokenEnv, headers } = {}) {
  const body = readTokenEnv === undefined ? { name, url } : { name, url, readTokenEnv };
  const r = await registerMcpEndpoint(base, body, { headers });
  if (r.id === null) throw new Error(`registering the MCP endpoint ${name} at ${url}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.id;
}
