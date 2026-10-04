// tools/lib/mcp-client.mjs — the ONE place Observogram speaks MCP over HTTP.
//
// createMcpClient({ mcpUrl, mcpAuth, timeoutMs, transport }) returns the
// { rpc, notify, callTool } trio the fetch-live CLI, the fixture recorder,
// the live probes and the studio server all drive (tools/fetch-live-pack.mjs
// re-exports it with the Node-side defaults filled in). Every request —
// initialize, notifications/initialized, tools/list, tools/call — goes
// through the single private send() below, which is where the transport
// hook (docs/MCP_INTEGRATION.md "Transport hook") is applied.
//
// Pure and browser-safe: no Node built-in import, no process, no env. The only
// import is ./mcp-url-safety.mjs (the URL policy the final URL is checked
// against). A vendorable module (docs/DOWNSTREAM.md).
//
// The transport contract
//   transport: null | { prepareRequest?, fetchImpl?, validateUrl?, hookPath? }
//              | Promise<the same>
//   - null / undefined: inert — globalThis.fetch, the headers and URL below,
//     byte-identical to the client before the hook existed.
//   - prepareRequest({ url, headers }) → { url?, headers? } | Promise<…>:
//     applied to every request. An omitted field keeps the input; returned
//     headers are MERGED over the built ones ({ ...headers, ...returned }),
//     so a hook that adds one header need not forward Mcp-Session-Id. The
//     hook sees the Authorization header (Bearer <mcpAuth>) and the raw
//     caller URL and may replace both; it must never log them.
//   - fetchImpl(url, init) → Promise<Response-like>: replaces globalThis.fetch.
//     init carries { method: 'POST', headers, body, signal } — the
//     AbortSignal is advisory, a custom fetcher may ignore it. The result
//     must offer ok, status, headers.get(name), text(), json(), and
//     body.getReader() when it answers text/event-stream. `new Response()`
//     satisfies all of it.
//   - validateUrl(url) → { error } | anything: run on the FINAL URL after a
//     prepareRequest; { error } is a hook fault. The loader
//     (tools/mcp-transport.mjs) supplies mcpUrlPolicy here.
//   - hookPath: named in every error text (the path only).
//
// What is a hook fault (TransportHookError) and what is not
//   Only contract violations are wrapped: the transport fields are not
//   functions; prepareRequest throws, returns a non-object, a non-string
//   url, non-object headers, a header value that is not a string/number or
//   carries CR/LF, a URL that is not http(s) or that fails validateUrl;
//   fetchImpl returns something that is not Response-like. A rejection from
//   globalThis.fetch or from fetchImpl itself (ECONNREFUSED, a timeout) is
//   an ordinary error, exactly as native fetch's — callers keep their
//   probe-level retry/annotate semantics with a hook present.
//   isTransportHookError() is name-based so it survives module duplication.
//
// Redaction: a hook's own error text goes through redact() before it is
// rethrown — wrapped for prepareRequest, kept an ordinary error for a
// fetchImpl rejection or for the text of a Response fetchImpl RETURNS (a
// non-OK body, a JSON-RPC or SSE error message) — so the bearer, the URL's
// userinfo and every credential-named query parameter value of mcpUrl
// (stripMcpUrl's rule) become <redacted> in every log line, 502 body and
// run record downstream. Native fetch's answers pass through untouched.
// Nothing else the hook does is redacted for it; it runs with the
// process's trust.

import { mcpUrlOrigin, safeMcpUrl, stripMcpUrl } from './mcp-url-safety.mjs';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export class TransportHookError extends Error {
  constructor(message, { hookPath = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TransportHookError';
    this.hookPath = hookPath;
  }
}

export const isTransportHookError = (e) => !!e && e.name === 'TransportHookError';

// What `transport: null` means, spelled out — the loader resolves to the
// same shape when the hook variable is unset.
export const INERT_TRANSPORT = Object.freeze({ prepareRequest: null, fetchImpl: null, validateUrl: null, hookPath: null });

const describe = (v) => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v);

// A settled transport value → the normalised shape; a contract violation is
// a TransportHookError (thrown at the first send, not at construction).
export function normaliseTransport(t) {
  if (t == null) return { ...INERT_TRANSPORT };
  if (typeof t !== 'object') throw new TransportHookError(`transport hook: transport is ${describe(t)}, not an object`);
  const hookPath = typeof t.hookPath === 'string' && t.hookPath ? t.hookPath : null;
  const out = { prepareRequest: null, fetchImpl: null, validateUrl: null, hookPath };
  for (const name of ['prepareRequest', 'fetchImpl', 'validateUrl']) {
    const fn = t[name];
    if (fn == null) continue;
    if (typeof fn !== 'function') throw new TransportHookError(`transport hook ${hookPath ?? '(inline)'}: ${name} is ${describe(fn)}, not a function`, { hookPath });
    out[name] = fn;
  }
  return out;
}

// The secrets of one client: the bearer, the URL's userinfo and the values
// of its credential-named query parameters (decoded and as they appear in
// the href), longest first so a value that contains another is replaced
// whole.
function secretsOf(mcpUrl, mcpAuth) {
  const set = new Set();
  const add = (v) => { if (typeof v === 'string' && v !== '') set.add(v); };
  add(mcpAuth);
  try {
    const url = new URL(String(mcpUrl));
    for (const part of [url.username, url.password]) {
      add(part);
      try { add(decodeURIComponent(part)); } catch { /* malformed escape: the raw form is in */ }
    }
    for (const name of stripMcpUrl(mcpUrl).dropped) {
      for (const value of url.searchParams.getAll(name)) { add(value); add(encodeURIComponent(value)); }
    }
  } catch { /* not a URL: the bearer alone */ }
  return [...set].sort((a, b) => b.length - a.length);
}

// Build the client. Synchronous: the transport (possibly a promise) is
// awaited inside send(), once per request, so every destructuring caller
// (`const { rpc, callTool } = createMcpClient(…)`) keeps working.
export function createMcpClient({ mcpUrl, mcpAuth = null, timeoutMs = 30_000, transport = null } = {}) {
  if (!mcpUrl) throw new Error('createMcpClient: mcpUrl required');
  let session = null;
  let nextId = 1;
  const transportReady = Promise.resolve(transport).then(normaliseTransport);
  // A client that is built and never used must not crash the process on a
  // transport that fails to normalise: the rejection reaches each send().
  transportReady.catch(() => {});
  const secrets = secretsOf(mcpUrl, mcpAuth);
  const redact = (text) => secrets.reduce((acc, s) => acc.split(s).join('<redacted>'), String(text));

  async function send(method, params, { notification = false } = {}) {
    const t = await transportReady;
    const label = `transport hook ${t.hookPath ?? '(inline)'}`;
    const fault = (text, cause) => new TransportHookError(`${label}: ${text}`, { hookPath: t.hookPath, cause });

    // (1) the request as the client has always built it — a fresh object
    // per call, identical keys and order to the pre-hook client.
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    };
    if (mcpAuth) headers['Authorization'] = `Bearer ${mcpAuth}`;
    if (session) headers['Mcp-Session-Id'] = session;
    let url = mcpUrl;
    let reqHeaders = headers;

    // (2) the hook, sync or async, then its answer checked field by field.
    if (t.prepareRequest) {
      let out;
      try { out = await t.prepareRequest({ url: mcpUrl, headers }); }
      catch (e) { throw fault(`prepareRequest threw: ${redact(e?.message ?? e)}`, e); }
      if (out === null || typeof out !== 'object' || Array.isArray(out)) throw fault(`prepareRequest returned ${describe(out)}, not { url, headers }`);
      if (out.url !== undefined) {
        if (typeof out.url !== 'string') throw fault('prepareRequest returned a url that is not a string');
        url = out.url;
      }
      if (out.headers !== undefined) {
        if (out.headers === null || typeof out.headers !== 'object' || Array.isArray(out.headers)) throw fault('prepareRequest returned headers that are not an object');
        reqHeaders = { ...headers, ...out.headers };
      }
      for (const [name, value] of Object.entries(reqHeaders)) {
        const shown = name.replace(/[\r\n]/g, ' ');
        if (typeof value !== 'string' && typeof value !== 'number') throw fault(`prepareRequest returned header "${shown}" with a value that is not a string`);
        if (/[\r\n]/.test(name) || /[\r\n]/.test(String(value))) throw fault(`prepareRequest returned header "${shown}" containing CR or LF`);
      }
      // (3) the FINAL URL passes the same policy the caller's URL passed.
      if (mcpUrlOrigin(url) === null) throw fault(`prepareRequest returned a URL that is not http(s): ${safeMcpUrl(url) ?? '<not a URL>'}`);
      if (t.validateUrl) {
        const v = t.validateUrl(url);
        if (v?.error) throw fault(String(v.error));
      }
    }

    // (4) the wire. A rejection here is NOT a hook fault (see the header).
    // A fetchImpl's own rejection is still hook text, so it is redacted —
    // the error stays ordinary (same name and code, cause kept), only its
    // message changes; native fetch's rejections pass through untouched.
    const fetcher = t.fetchImpl || globalThis.fetch;
    const body = JSON.stringify(notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params });
    let res;
    try { res = await fetcher(url, { method: 'POST', headers: reqHeaders, body, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) {
      if (!t.fetchImpl) throw e;
      const err = new Error(redact(e?.message ?? e), { cause: e });
      if (e?.name && e.name !== 'Error') err.name = e.name;
      if (e?.code !== undefined) err.code = e.code;
      throw err;
    }
    if (t.fetchImpl && !(res && typeof res.ok === 'boolean' && typeof res.status === 'number'
        && typeof res.headers?.get === 'function' && typeof res.text === 'function' && typeof res.json === 'function')) {
      throw fault(`fetchImpl returned ${describe(res)}, not a Response`);
    }

    // (5) the answer, exactly as before — except that what a fetchImpl
    // RETURNS is hook text too (a non-OK body, an error message), so it is
    // redacted like its rejection; a native Response passes through as is.
    const wireText = (text) => (t.fetchImpl ? redact(text) : String(text));
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} on ${method}: ${wireText(await res.text().catch(() => ''))}`);
    if (res.headers.get('mcp-session-id')) session = res.headers.get('mcp-session-id');
    if (notification) return undefined;

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      if (t.fetchImpl && typeof res.body?.getReader !== 'function') throw fault('fetchImpl returned a text/event-stream Response without a readable body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        const frameEnd = buf.indexOf('\n\n');
        if (frameEnd !== -1) {
          const frame = buf.slice(0, frameEnd);
          const text = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.replace(/^data:\s?/, '')).join('\n');
          if (text) {
            const obj = JSON.parse(text);
            if (obj.error) throw new Error(`${method}: ${wireText(obj.error.message)}`);
            return obj.result;
          }
          buf = buf.slice(frameEnd + 2);
        }
        if (done) break;
      }
      throw new Error(`MCP ${method}: SSE stream ended with no complete frame`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`${method}: ${wireText(data.error.message)}`);
    return data.result;
  }

  const rpc = (method, params = {}) => send(method, params);
  const notify = (method, params = {}) => send(method, params, { notification: true });

  async function callTool(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result?.isError) {
      const txt = result?.content?.map(c => c.text).filter(Boolean).join(' ') || 'tool returned isError';
      throw new Error(`${name}: ${txt}`);
    }
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return result;
    try { return JSON.parse(text); }
    catch { return text; }
  }

  return { rpc, notify, callTool };
}
