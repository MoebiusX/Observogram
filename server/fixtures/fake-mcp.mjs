// server/fixtures/fake-mcp.mjs — the fake MCP the server suites share (moved
// from server/test-smoke.mjs) and the registration helper that points the
// studio at it.
//
// startFakeMcp(toolNames, handler, { echo }) is a plain node:http server on
// 127.0.0.1 that speaks the MCP JSON-RPC methods the fetcher and the deploy
// routes send: initialize, tools/list (the names given) and tools/call
// (`handler(name, args)` answers when given — an answer `{ __isError: text }`
// is a tool error result carrying that text; the default echoes { ok, name },
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
// A third seam, `admin` (rebadge batch 4), adds the MCP server's settings
// surface — a settings description, configure and disable, CORS for one
// origin, every admin request recorded — and is documented with its code
// below. Without it every answer is the one above.
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

export async function startFakeMcp(toolNames, handler = null, { echo = null, admin = null } = {}) {
  if (echo !== null && !ECHO_MODES.has(echo)) throw new TypeError(`fake MCP: echo is one of ${[...ECHO_MODES].join(', ')}`);
  const surface = admin === null ? null : adminSurface(adminOptions(admin), await startSink());
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
    if (surface) {
      const path = (req.url ?? '/').split('?')[0];
      if (surface.isAdminPath(path)) { surface.handle(req, res, path, raw); return; }
    }
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
      const gated = surface?.gated();
      if (gated) { send({ isError: true, content: [{ type: 'text', text: gated }] }); return; }
      const answer = handler ? handler(msg.params?.name, msg.params?.arguments || {}) : { ok: true, name: msg.params?.name };
      if (typeof answer?.__isError === 'string') { send({ isError: true, content: [{ type: 'text', text: answer.__isError }] }); return; }
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
    // The admin surface (null without `admin`): every admin request, the redirect sink, the configured state.
    adminRequests: surface ? surface.adminRequests : null,
    sink: surface ? surface.sink : null,
    adminConfigured: () => surface?.configured() ?? false,
    adminSettings: () => surface?.settings() ?? null,
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
      if (!surface) return new Promise(resolve => srv.close(resolve));
      surface.closeHeld();   // a held configure answer is dropped, so close() can finish
      return Promise.all([new Promise(resolve => srv.close(resolve)), surface.sink.close()]).then(() => undefined);
    },
  };
}

// ---------- the admin surface (rebadge batch 4: in-page MCP server settings) ----------
//
// startFakeMcp(…, { admin }) adds an MCP server's settings surface beside
// /mcp — off unless `admin` is given, so without it every answer above is
// unchanged. The fake is the MCP server: it may see the secret, and records
// it (adminRequests) so a suite can prove where a value went and where it
// did not.
//
//   GET  /admin/schema   the settings description (`descriptor`), or 404 /
//                        a non-JSON text / the old JSON-RPC body; with
//                        `descriptorStatus` a 401, a 500 or a 302 to the sink
//   POST /configure      (and every endpoint the description declares) the
//                        configure: `requireKey` checked, the settings
//                        applied, `outcome(body)` answered; `{ action:
//                        'disable' }` clears them
//   OPTIONS on both      the CORS preflight, answered with the allowed
//                        methods and headers for the `cors` origin only
//
// `cors` puts an exact Access-Control-Allow-Origin and `Vary: Origin` on
// every admin answer (`corsOnErrors: false` drops them from a non-2xx
// configure answer, the mistake a server author makes when CORS runs after
// auth). With `gateTools` (the default) every tools/call answers isError
// "backend not configured" until a configure lands, so configure → verify
// is real: the ping's read fails, then answers. `sink` (a second listener,
// started with the admin surface) records whatever a redirect would have
// delivered.

export const ADMIN_MARKUP = ' <img src=x onerror=window.__pwn=1> <svg onload=window.__pwn=1> <b>bold</b>';

// The descriptor the batch-4 SPEC gives as its example, as written (no `auth`).
export const EXAMPLE_SETTINGS_DESCRIPTOR = Object.freeze({
  version: 1,
  endpoint: '/configure',
  fields: [
    { name: 'grafanaUrl', label: 'Backend base URL', type: 'url', required: true },
    { name: 'user', label: 'User', type: 'text' },
    { name: 'secret', label: 'Password / token', type: 'secret' },
    { name: 'apiKey', label: 'Server API key', type: 'secret', help: 'leave empty on loopback dev' },
  ],
  actions: [{ name: 'disable', label: 'Clear server credential' }],
});

const ADMIN_KEYS = ['descriptor', 'descriptorStatus', 'cors', 'corsOnErrors', 'requireKey', 'outcome', 'configureStatus',
  'holdAnswer', 'echoSecret', 'markup', 'gateTools'];
const ECHO_SECRET = new Set([false, 'raw', 'json-escaped', 'base64-basic']);
const DESCRIPTOR_PATH = '/admin/schema';
const NOT_CONFIGURED = 'backend not configured';

function adminOptions(admin) {
  if (admin === true) admin = {};
  if (!admin || typeof admin !== 'object') throw new TypeError('fake MCP: admin is an object of options (or true for the defaults)');
  for (const k of Object.keys(admin)) if (!ADMIN_KEYS.includes(k)) throw new TypeError(`fake MCP: unknown admin option ${JSON.stringify(k)}`);
  const o = {
    descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, descriptorStatus: 200, cors: false, corsOnErrors: true, requireKey: null,
    outcome: null, configureStatus: null, holdAnswer: false, echoSecret: false, markup: false, gateTools: true, ...admin,
  };
  if (!ECHO_SECRET.has(o.echoSecret)) throw new TypeError(`fake MCP: admin.echoSecret is false or one of ${[...ECHO_SECRET].filter(Boolean).join(', ')}`);
  if (o.requireKey !== null && (typeof o.requireKey?.key !== 'string' || !['header', 'body'].includes(o.requireKey.in ?? 'header'))) {
    throw new TypeError('fake MCP: admin.requireKey is { key, in: "header" | "body", field? }');
  }
  return o;
}

const withMarkup = (s) => (typeof s === 'string' ? s + ADMIN_MARKUP : s);

// The descriptor as served: `markup` appends the payloads to every string slot.
function servedDescriptor(descriptor, markup) {
  if (!markup || !descriptor || typeof descriptor !== 'object') return descriptor;
  const d = structuredClone(descriptor);
  for (const f of Array.isArray(d.fields) ? d.fields : []) for (const k of ['label', 'help', 'placeholder']) if (k in f) f[k] = withMarkup(f[k]);
  for (const a of Array.isArray(d.actions) ? d.actions : []) for (const k of ['label', 'confirm']) if (k in a) a[k] = withMarkup(a[k]);
  return d;
}

// The configure paths: /configure and every endpoint the description declares, rooted at /.
function configurePaths(descriptor) {
  const paths = new Set(['/configure']);
  if (descriptor && typeof descriptor === 'object') {
    for (const e of [descriptor.endpoint, ...(Array.isArray(descriptor.actions) ? descriptor.actions.map((a) => a?.endpoint) : [])]) {
      if (typeof e === 'string' && e) paths.add(`/${e.replace(/^\//, '')}`);
    }
  }
  paths.delete(DESCRIPTOR_PATH);
  return paths;
}

// The secret-typed field names (the description's, else the generic form's).
function secretFieldsOf(descriptor) {
  if (descriptor && typeof descriptor === 'object' && Array.isArray(descriptor.fields)) {
    return descriptor.fields.filter((f) => f?.type === 'secret').map((f) => f.name);
  }
  return ['secret', 'apiKey'];
}

// JSON text in which every non-ASCII character is \uXXXX and every "/" is "\/" — it parses back to the literal.
function jsonEscapedText(value) {
  let out = '';
  for (const ch of JSON.stringify(value)) {
    const c = ch.codePointAt(0);
    if (ch === '/') out += '\\/';
    else if (c > 0x7e) out += ch.split('').map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    else out += ch;
  }
  return out;
}

function echoAnswer(mode, body, secretFields) {
  const secrets = secretFields.map((n) => body?.[n]).filter((v) => typeof v === 'string' && v);
  if (mode === 'raw') return { contentType: 'text/plain; charset=utf-8', text: `the backend refused the credential: ${secrets.join(' / ')}` };
  if (mode === 'json-escaped') return { contentType: 'application/json', text: `{"ok":false,"error":${jsonEscapedText(`the backend refused the credential ${secrets.join(' / ')}`)}}` };
  const user = typeof body?.user === 'string' ? body.user : '';
  const basic = secrets.map((s) => Buffer.from(`${user}:${s}`, 'utf8').toString('base64'));
  return { contentType: 'text/plain; charset=utf-8', text: `the backend answered 401 to Authorization: Basic ${basic.join(' / ')}` };
}

function defaultOutcome(body) {
  if (body?.action === 'disable') return { status: 200, json: { ok: true, message: 'The server forgot the backend credential.', checks: [] } };
  return {
    status: 200,
    json: {
      ok: true,
      message: 'Settings applied.',
      checks: [
        { label: 'Identity', status: 'pass', detail: 'the backend accepted the credential' },
        { label: 'Toolset', status: 'pass', detail: 'every tool answered' },
      ],
    },
  };
}

function markupOutcome(json) {
  if (!json || typeof json !== 'object') return json;
  const out = { ...json, message: withMarkup(json.message) };
  if (Array.isArray(json.checks)) out.checks = json.checks.map((c) => ({ ...c, label: withMarkup(c.label), detail: withMarkup(c.detail) }));
  return out;
}

async function startSink() {
  const requests = [];
  const srv = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, body: raw });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('sink');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  return { url: `http://127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => srv.close(resolve)) };
}

// The admin surface's state and its one request handler.
function adminSurface(o, sink) {
  const adminRequests = [];
  const held = new Set();
  const state = { configured: false, settings: null };
  const configure = configurePaths(o.descriptor);
  const secretFields = secretFieldsOf(o.descriptor);
  const keyField = o.requireKey?.field ?? 'apiKey';

  const corsHeaders = () => (o.cors ? { 'Access-Control-Allow-Origin': o.cors, Vary: 'Origin' } : {});
  const answer = (res, status, { json, text, contentType, headers = {}, cors = true } = {}) => {
    const body = json !== undefined ? JSON.stringify(json) : (text ?? '');
    const type = contentType ?? (json !== undefined ? 'application/json' : 'text/plain; charset=utf-8');
    res.writeHead(status, { ...(cors ? corsHeaders() : {}), 'Cache-Control': 'no-store', ...(status === 204 ? {} : { 'Content-Type': type }), ...headers });
    res.end(status === 204 ? undefined : body);
  };
  const keyArrived = (req, body) => {
    if (!o.requireKey) return true;
    if ((o.requireKey.in ?? 'header') === 'header') return req.headers.authorization === `Bearer ${o.requireKey.key}`;
    return body?.[keyField] === o.requireKey.key;
  };

  return {
    adminRequests,
    sink,
    isAdminPath: (path) => path === DESCRIPTOR_PATH || configure.has(path),
    // Every tools/call while gateTools holds and nothing is configured answers this isError text.
    gated: () => (o.gateTools && !state.configured ? NOT_CONFIGURED : null),
    configured: () => state.configured,
    settings: () => (state.settings ? { ...state.settings } : null),
    closeHeld: () => { for (const res of held) res.destroy(); held.clear(); },
    handle(req, res, path, raw) {
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = raw; } }
      adminRequests.push({
        method: req.method, path, origin: req.headers.origin ?? null, host: req.headers.host ?? null,
        headers: { ...req.headers }, body,
      });
      if (req.method === 'OPTIONS') {
        if (o.cors && req.headers.origin === o.cors) {
          answer(res, 204, { headers: { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Max-Age': '0' } });
        } else answer(res, 204, { cors: false });
        return;
      }
      if (path === DESCRIPTOR_PATH) {
        if (req.method !== 'GET') { answer(res, 405, { json: { error: 'GET only' }, headers: { Allow: 'GET, OPTIONS' } }); return; }
        const status = o.descriptorStatus;
        if (status >= 300 && status < 400) { answer(res, status, { text: '', headers: { Location: `${sink.url}/` } }); return; }
        if (status === 401) { answer(res, 401, { json: { error: 'authentication required' } }); return; }
        if (status !== 200) { answer(res, status, { text: 'internal error' }); return; }
        if (o.descriptor === null) { answer(res, 404, { json: { error: 'not found' } }); return; }
        if (o.descriptor === 'not-json') { answer(res, 200, { text: 'This server has no settings description.' }); return; }
        if (o.descriptor === 'jsonrpc') { answer(res, 200, { json: { jsonrpc: '2.0', id: 1, result: {} } }); return; }
        answer(res, 200, { json: servedDescriptor(o.descriptor, o.markup) });
        return;
      }
      // A configure path.
      const fail = (status, payload) => answer(res, status, { ...payload, cors: o.corsOnErrors });
      if (req.method !== 'POST') { fail(405, { json: { ok: false, message: 'POST only' }, headers: { Allow: 'POST, OPTIONS' } }); return; }
      if (o.configureStatus !== null && o.configureStatus >= 300 && o.configureStatus < 400) {
        fail(o.configureStatus, { text: '', headers: { Location: `${sink.url}${path}` } });
        return;
      }
      if (o.configureStatus !== null) { fail(o.configureStatus, { json: { ok: false, message: `HTTP ${o.configureStatus}` } }); return; }
      if (!body || typeof body !== 'object' || Array.isArray(body)) { fail(400, { json: { ok: false, message: 'the body is not a JSON object' } }); return; }
      if (o.echoSecret) { fail(keyArrived(req, body) ? 400 : 401, echoAnswer(o.echoSecret, body, secretFields)); return; }
      if (!keyArrived(req, body)) { fail(401, { json: { ok: false, message: 'the server API key is missing or wrong' } }); return; }
      const disable = body.action === 'disable';
      if (body.action !== undefined && !disable) { fail(400, { json: { ok: false, message: 'unknown action' } }); return; }
      const out = (o.outcome ?? defaultOutcome)(body) ?? defaultOutcome(body);
      const ok2xx = out.status >= 200 && out.status < 300;
      if (ok2xx && out.json?.ok !== false) {
        if (disable) { state.configured = false; state.settings = null; } else { state.configured = true; state.settings = { ...body }; }
      }
      if (o.holdAnswer) { held.add(res); res.on('close', () => held.delete(res)); return; }
      const payload = out.json !== undefined ? { json: o.markup ? markupOutcome(out.json) : out.json } : { text: o.markup ? withMarkup(out.text ?? '') : (out.text ?? ''), contentType: out.contentType };
      if (ok2xx) answer(res, out.status, payload); else fail(out.status, payload);
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
