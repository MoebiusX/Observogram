// server/mcp-settings-policy.mjs — the MCP server-settings policy
// (OBSERVOGRAM_MCP_SETTINGS_POLICY; rebadge batch 4, D3), the taxonomy
// override's twin (server/taxonomy.mjs).
//
// A downstream that wants friction in front of the studio's Server
// settings modal — a warning on a non-approved backend URL, an
// acknowledgement ticked before the send — points the server at a JSON
// file in the settings-policy schema (tools/lib/mcp-server-settings.mjs
// compileSettingsPolicy: strict, version 1, 1–32 rules, every pattern
// bounded; an optional `generic` block prefilling the generic form).
// start() reads it once, before the store boots. An unreadable or invalid
// file REFUSES the start — a guard silently dropped would let every send
// through with no sign of why — with `OBSERVOGRAM_MCP_SETTINGS_POLICY:
// <path>: <reason>` (the ENOENT text, the JSON parse error, or the first
// schema error and `(+N more)`). One leading U+FEFF is stripped first
// (Windows PowerShell 5 writes one; tools/lib/mini-yaml.mjs does the same).
// The path is logged once at start (`[studio] MCP settings policy: <path>
// (<n> rules)`), never served: GET /api/mcp-settings carries the document
// and `configured`, and whether the opt-in proxy is on.
//
// The policy only adds friction: it never enables a control, lifts a
// refusal or changes a target. The studio reads it when the modal opens and
// compiles it again with `timed: false` (the server ran the id clocks
// here). The load checks each pattern's shape, not its speed: the
// pass-through evaluates the policy in a worker under a 100 ms deadline
// (server/mcp-settings-eval.mjs), a rule that does not finish counting as
// matched. Unset (the default): nothing is read, and the route answers
// { ok: true, proxy, policy: null, configured: false }.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brandEnv, brandEnvFrom } from '../tools/lib/brand-env.mjs';
import { compileSettingsPolicy } from '../tools/lib/mcp-server-settings.mjs';

export const MCP_SETTINGS_POLICY_ENV = 'OBSERVOGRAM_MCP_SETTINGS_POLICY';
export const MCP_ADMIN_PROXY_ENV = 'OBSERVOGRAM_MCP_ADMIN_PROXY';

/**
 * { policy: object | null, compiled: frozen policy | null, path: string | null }
 * — `policy` the parsed document as the file holds it (what the GET serves),
 * `compiled` compileSettingsPolicy's. Throws on an unreadable or invalid file.
 */
export function readSettingsPolicyConfig(env = process.env) {
  const raw = brandEnvFrom(env, 'MCP_SETTINGS_POLICY');
  if (!raw) return { policy: null, compiled: null, path: null };
  const path = resolve(raw);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new Error(`${MCP_SETTINGS_POLICY_ENV}: ${path}: ${e.message}`, { cause: e }); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${MCP_SETTINGS_POLICY_ENV}: ${path}: invalid JSON: ${e.message}`, { cause: e }); }
  const { policy, errors } = compileSettingsPolicy(json);
  if (errors.length) throw new Error(`${MCP_SETTINGS_POLICY_ENV}: ${path}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
  return { policy: json, compiled: policy, path };
}

let current = { policy: null, compiled: null, path: null };

/** Read the file (if any), install it process-wide, log the path once. Returns { policy, compiled, path }. */
export function loadSettingsPolicy({ env = process.env, log = () => {} } = {}) {
  current = readSettingsPolicyConfig(env);
  if (current.path) {
    const n = current.compiled.rules.length;
    log(`[studio] MCP settings policy: ${current.path} (${n} rule${n === 1 ? '' : 's'})`);
  }
  return current;
}

/** The compiled policy the server applies (the opt-in proxy's re-check), or null. */
export function settingsPolicy() {
  return current.compiled;
}

/** Is the opt-in pass-through on? Read per request, so no restart is needed. */
export function mcpAdminProxyOn() {
  return brandEnv('MCP_ADMIN_PROXY') === '1';
}

/** The GET /api/mcp-settings body: the document the studio compiles, never the path. */
export function settingsPolicyAnswer() {
  return { ok: true, proxy: mcpAdminProxyOn(), policy: current.policy, configured: current.policy !== null };
}
