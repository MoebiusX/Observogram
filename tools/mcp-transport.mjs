// tools/mcp-transport.mjs — loads the MCP transport hook (Node only).
//
// OBSERVOGRAM_TRANSPORT_HOOK=<path.mjs | file:URL> names a module whose
// named exports shape every MCP request Observogram makes
// (docs/MCP_INTEGRATION.md "Transport hook"):
//   export function prepareRequest({ url, headers }) → { url?, headers? }  (sync or async)
//   export function fetchImpl(url, init) → Promise<Response-like>
// Either or both. The legacy TOMOGRAPH_TRANSPORT_HOOK spelling is honoured by
// brand-env's rule (OBSERVOGRAM_ wins); every error text spells the modern
// name. Unset or empty → the inert transport: no import, no log line, the
// client behaves exactly as without a hook.
//
// Loading rules
//   - the value is a path — absolute, or relative to process.cwd() (the way
//     OUTPUT and MCP_URL are read) — or an explicit file: URL kept as is;
//   - any import failure, a module exporting neither function, or one
//     exporting a non-function under either name is a TransportHookError
//     (the CLI exits 1 writing nothing; the server refuses to start);
//   - the transport carries validateUrl = the shared MCP URL policy
//     (tools/lib/mcp-url-safety.mjs mcpUrlPolicy) with the process's
//     OBSERVOGRAM_ALLOW_LOCAL_MCP posture, run by the client on the FINAL
//     URL a prepareRequest returns.
//
// loadTransportHook({ env }) is NOT memoised (suites call it with their own
// env); mcpTransport() is the process-wide memo every entrypoint shares —
// loaded once, a rejected load stays rejected (the process is
// misconfigured). This module never logs: each entrypoint prints the hook
// path once itself (fetch-live-pack main(), the server's start()), so a
// silent boot stays silent.
//
// The hook is operator-installed code running with the process's trust: it
// sees the Authorization header and the raw caller URL and may replace
// both; it must never log them. The client redacts the bearer and the URL's
// credential parameters from the hook's own error text as a backstop,
// nothing else.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { brandEnvFrom } from './lib/brand-env.mjs';
import { INERT_TRANSPORT, TransportHookError } from './lib/mcp-client.mjs';
import { mcpUrlPolicy } from './lib/mcp-url-safety.mjs';

export const TRANSPORT_HOOK_VAR = 'OBSERVOGRAM_TRANSPORT_HOOK';

// The URL policy with the posture read from `env` at call time.
export function validateUrlFrom(env = process.env) {
  return (url) => mcpUrlPolicy(url, { allowLocal: brandEnvFrom(env, 'ALLOW_LOCAL_MCP') !== '0' });
}

// The hook path's import URL: a file: URL as given, else a path resolved
// against process.cwd().
export function hookImportUrl(value) {
  return /^file:/i.test(value) ? value : pathToFileURL(resolve(value)).href;
}

// → Promise<transport>: { prepareRequest, fetchImpl, validateUrl, hookPath }.
export async function loadTransportHook({ env = process.env, validateUrl = validateUrlFrom(env) } = {}) {
  const value = brandEnvFrom(env, 'TRANSPORT_HOOK');
  if (!value) return { ...INERT_TRANSPORT };
  let mod;
  try {
    mod = await import(hookImportUrl(value));
  } catch (e) {
    throw new TransportHookError(`${TRANSPORT_HOOK_VAR}: cannot load ${value}: ${e?.message ?? e}`, { hookPath: value, cause: e });
  }
  const picked = {};
  for (const name of ['prepareRequest', 'fetchImpl']) {
    const fn = mod[name];
    if (fn === undefined) { picked[name] = null; continue; }
    if (typeof fn !== 'function') throw new TransportHookError(`${TRANSPORT_HOOK_VAR}: ${value} exports ${name}, which is not a function`, { hookPath: value });
    picked[name] = fn;
  }
  if (!picked.prepareRequest && !picked.fetchImpl) {
    throw new TransportHookError(`${TRANSPORT_HOOK_VAR}: ${value} exports neither prepareRequest nor fetchImpl`, { hookPath: value });
  }
  return { ...picked, validateUrl, hookPath: value };
}

let memo = null;
let settled = null;

// The process-wide transport: the first call loads from process.env, every
// later call returns the same promise.
export function mcpTransport() {
  if (!memo) {
    memo = loadTransportHook();
    memo.then((t) => { settled = t; }, () => {});
  }
  return memo;
}

// The loaded transport, or null while loading / when the load failed / before
// the first mcpTransport() — for log lines, never for sending.
export function mcpTransportLoaded() {
  return settled;
}

// One line for an entrypoint's log — the path only, never a header or URL.
export function describeTransport(t) {
  if (!t?.hookPath) return null;
  return `${TRANSPORT_HOOK_VAR}=${t.hookPath} (prepareRequest: ${t.prepareRequest ? 'yes' : 'no'}, fetchImpl: ${t.fetchImpl ? 'yes' : 'no'})`;
}
