// studio/mcp-settings-api.mjs
//
// The loaders of the MCP panel's Server settings modal (rebadge batch 4,
// D1/D2):
//
//   loadServerSettingsConfig()  GET /api/mcp-settings on the studio server —
//                               { ok, proxy, policy, configured, mcpOrigins? }
//                               (the bundle's shim answers it in the page)
//   loadSettingsLibs()          the contract and the URL rules from /lib,
//                               loaded when the modal opens, never at boot
//   readDescriptorDirect(url)   GET <MCP server root>/admin/schema from the
//                               BROWSER: a CORS "simple" GET with no header,
//                               no credential, no redirect followed, 10 s, read
//                               with a 16 KiB cap
//   submitDirect(url, request)  POST the configure (or an action) from the
//                               BROWSER to the MCP server: JSON, its own
//                               Authorization when the descriptor says so,
//                               no redirect followed, 15 s, read with a
//                               64 KiB cap
//   describeViaProxy(target)    POST /api/mcp-settings/describe on the studio
//   submitViaProxy(payload)     server, and /submit — the opt-in pass-through
//                               (OBSERVOGRAM_MCP_ADMIN_PROXY=1), used for every
//                               request while GET /api/mcp-settings says
//                               `proxy: true`, never as a fallback; through
//                               requestJson (authHeaders: the CSRF header and
//                               the org), so the studio server's admin gate,
//                               allowlist and audit apply
//
// The two requests to the MCP server are the studio's only fetch() that
// carries no authHeaders(): nothing of the studio's session goes to another
// origin — no cookie (credentials 'omit'), no CSRF header, no
// X-Observogram-Org — and the guard in server/test-authz.mjs exempts this
// file's one call by its exact text. directRequest() builds every option it
// sends with.

import { requestJson } from './services-api.mjs';

export const DESCRIPTOR_BYTES = 16384;
export const OUTCOME_BYTES = 65536;
export const DESCRIPTOR_TIMEOUT_MS = 10_000;
export const SUBMIT_TIMEOUT_MS = 15_000;

// GET /api/mcp-settings → the policy, the proxy flag (and in the bundle the baked MCP origin list).
export async function loadServerSettingsConfig({ fetchFn = requestJson } = {}) {
  return fetchFn('/api/mcp-settings');
}

// The pass-through's two calls; `target` is { mcpEndpointId } or { mcpUrl }.
const postJson = (path, body, signal, fetchFn) => fetchFn(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
});
export function describeViaProxy(target, { signal, fetchFn = requestJson } = {}) {
  return postJson('/api/mcp-settings/describe', target, signal, fetchFn);
}
// `payload`: { mcpEndpointId | mcpUrl, mode, generic?, action?, values, acks }.
// The body is built here, at call time: the values are read from the modal
// into the caller's local and go out of scope with it.
export function submitViaProxy(payload, { signal, fetchFn = requestJson } = {}) {
  return postJson('/api/mcp-settings/submit', payload, signal, fetchFn);
}

// The settings contract and the URL rules, from /lib (tools/lib), at call
// time — never statically: the Node suites that import this module have no
// /lib/. A failed load is not kept, so the next open tries again.
let libs = null;
export function loadSettingsLibs() {
  if (!libs) {
    libs = Promise.all([import('/lib/mcp-server-settings.mjs'), import('/lib/mcp-url-safety.mjs')])
      .then(([lib, safety]) => ({ lib, safety }))
      .catch((e) => { libs = null; throw e; });
  }
  return libs;
}

/**
 * A request to the MCP server's own origin, never the studio's: no
 * credentials, CORS mode, no redirect followed (an opaqueredirect is
 * refused by the caller), no referrer, no cache. `init` adds the method,
 * the headers, the body and the signal.
 */
export function directRequest(url, init = {}) {
  return {
    href: String(url),
    init: {
      method: init.method ?? 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    },
  };
}

// The one fetch to the MCP server; `onSent` runs as soon as it is issued.
function send(direct, onSent) {
  const pending = fetch(direct.href, direct.init);
  onSent?.();
  return pending;
}

// A signal that aborts on `outer` or after `ms`.
function deadline(outer, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  const stop = () => ctl.abort(outer?.reason);
  if (outer) { if (outer.aborted) stop(); else outer.addEventListener('abort', stop, { once: true }); }
  return { signal: ctl.signal, done: () => { clearTimeout(timer); outer?.removeEventListener?.('abort', stop); } };
}

// The body as text, at most `cap` bytes: { text, truncated, bytes }. A
// declared Content-Length over the cap is refused before reading
// ({ oversize: bytes }) when `refuseOver` is set.
async function readCapped(res, cap, { refuseOver = false } = {}) {
  const declared = Number(res.headers.get('content-length'));
  if (refuseOver && Number.isFinite(declared) && declared > cap) {
    res.body?.cancel?.().catch(() => {});
    return { oversize: declared };
  }
  if (!res.body?.getReader) {
    const text = await res.text();
    return { text, truncated: false };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > cap) {
      chunks.push(value.slice(0, value.byteLength - (bytes - cap)));
      truncated = true;
      reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
  }
  if (refuseOver && truncated) return { oversize: bytes };
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all), truncated };
}

/**
 * GET the settings description from the browser. → one of
 *   { kind: 'answer', status, contentType, text } · { kind: 'oversize', bytes }
 *   · { kind: 'redirect' } · { kind: 'unreachable' } · { kind: 'aborted' }
 */
export async function readDescriptorDirect(url, { signal } = {}) {
  const d = deadline(signal, DESCRIPTOR_TIMEOUT_MS);
  try {
    const res = await send(directRequest(url, { method: 'GET', signal: d.signal }));
    if (res.type === 'opaqueredirect') return { kind: 'redirect' };
    const body = await readCapped(res, DESCRIPTOR_BYTES, { refuseOver: true });
    if (body.oversize !== undefined) return { kind: 'oversize', bytes: body.oversize };
    return { kind: 'answer', status: res.status, contentType: res.headers.get('content-type'), text: body.text };
  } catch {
    return { kind: signal?.aborted ? 'aborted' : 'unreachable' };
  } finally {
    d.done();
  }
}

/**
 * POST the configure (or an action) from the browser. `request` is
 * { headers, body } (tools/lib/mcp-server-settings.mjs settingsRequest).
 * `onSent` runs as soon as the request is issued — the modal empties every
 * secret input then. → one of
 *   { kind: 'answer', status, contentType, text, truncated }
 *   · { kind: 'redirect' } (an opaqueredirect: it may have acted)
 *   · { kind: 'unknown' } (sent, but no answer the page may read)
 *   · { kind: 'aborted' }
 */
export async function submitDirect(url, request, { signal, onSent } = {}) {
  const d = deadline(signal, SUBMIT_TIMEOUT_MS);
  try {
    const res = await send(directRequest(url, { method: 'POST', headers: request.headers, body: request.body, signal: d.signal }), onSent);
    if (res.type === 'opaqueredirect') return { kind: 'redirect' };
    const body = await readCapped(res, OUTCOME_BYTES);
    return { kind: 'answer', status: res.status, contentType: res.headers.get('content-type'), text: body.text, truncated: body.truncated };
  } catch {
    return { kind: signal?.aborted ? 'aborted' : 'unknown' };
  } finally {
    d.done();
  }
}
