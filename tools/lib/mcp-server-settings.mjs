// tools/lib/mcp-server-settings.mjs — the MCP server-settings contract
// (rebadge batch 4, D1–D3): what an MCP server publishes so an admin can
// push its runtime configuration from the studio's page, and the rules the
// studio applies to that description, to the request it builds, to the
// answer it shows and to a deployment's settings policy.
//
// One module, three consumers: the studio (loaded with
// import('/lib/mcp-server-settings.mjs') when the Server settings modal
// opens), the studio server (the settings-policy loader and the opt-in
// pass-through) and an MCP server author or a downstream, who vendors it to
// validate their own descriptor or policy file. Pure and browser-safe: the
// WHATWG URL, TextEncoder and two sibling modules, nothing else.
//
// The descriptor (version 1), served at <MCP server root>/admin/schema:
//   { "version": 1, "endpoint": "/configure",
//     "auth":    { "field": "apiKey", "scheme": "bearer" },          optional
//     "fields":  [ { "name", "label", "type", "required"?, "help"?, "placeholder"? } ],   1..24
//     "actions": [ { "name", "label", "endpoint"?, "fields"?, "confirm"? } ] }            0..4
// Unknown keys are ignored (additive change inside version 1), an unknown
// field type is read as text, and a `value` key is never read: the
// description is an unauthenticated GET, never a state read.
//
// The MCP server root is the MCP URL's path without its last segment (one
// trailing slash ignored), with no query, fragment or userinfo:
// http://127.0.0.1:9000/mcp → http://127.0.0.1:9000/, https://gw/team-a/mcp/
// → https://gw/team-a/. Every path a descriptor, the generic form or a
// policy names is a plain relative path under that root (letters, digits,
// "-", "_", ".", "~" and "/"; no "." or ".." segment, none starting ".."),
// a leading "/" relative to the root, and is re-checked after resolving.
//
// The outcome (optional for servers): { "ok"?, "message"?, "checks"?: [
// { "label", "status": pass|fail|skip, "detail"? } ] }. outcomeOf reads an
// answer into what the modal shows, after hiding every submitted secret the
// server echoed — by value in each form it may take (raw, URI-encoded,
// JSON-escaped, base64, Basic credentials), then on every parsed string,
// then by key class.
//
// The settings policy (OBSERVOGRAM_MCP_SETTINGS_POLICY, strict):
//   { "version": 1, "rules": [ { "when": { "field" | "type", "pattern", "flags"? },
//                                "warn", "require"?: { "ack" } } ],          1..32
//     "generic"?: { "path"?, "names"?: { url?, user?, secret?, apiKey? }, "auth"?: "body" | "bearer" } }
// A rule only adds friction: a warning, and an acknowledgement that blocks
// the send until it is ticked. A rule that cannot be evaluated (its field is
// absent, or a secret) fails closed. Patterns follow the taxonomy's rule
// (compileBoundedPattern) plus a bound for URL-length values — checks of
// shape, not of speed: policyFindings runs the patterns on the caller's
// thread, so the studio server runs it in a worker under a deadline
// (server/mcp-settings-eval.mjs) and the page runs it in the admin's tab.

import { compileBoundedPattern } from './artefact-classify.mjs';
import { mcpUrlPolicy } from './mcp-url-safety.mjs';

export const SETTINGS_DESCRIPTOR_VERSION = 1;
export const SETTINGS_DESCRIPTOR_PATH = 'admin/schema';
export const SETTINGS_LIMITS = Object.freeze({
  descriptorBytes: 16384, fields: 24, actions: 4, name: 64, label: 80, help: 240, placeholder: 120,
  path: 128, confirm: 160, value: 2048, policyValue: 512, bodyBytes: 65536, outcomeBytes: 65536,
  outcomeShown: 8192, message: 500, checks: 24, checkDetail: 240, policyRules: 32, warn: 240, ack: 160,
});
export const FIELD_TYPES = Object.freeze(['text', 'url', 'secret', 'boolean']);
export const GENERIC_NAMES = Object.freeze({ url: 'url', user: 'user', secret: 'secret', apiKey: 'apiKey' });

const NAME_RULE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype', 'action']);
const PATH_RULE = /^\/?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const POLICY_TYPES = Object.freeze(['url', 'text', 'boolean']);
const CHECK_STATUSES = Object.freeze(['pass', 'fail', 'skip']);
const SECRET_KEY_CLASS = /^(pass(word)?|secret|token|api[-_]?key|credential|authorization)$/i;
const REDACTED = '<redacted>';
const MIN_ECHO_LENGTH = 4;

const encoder = new TextEncoder();
const byteLength = (s) => encoder.encode(s).length;
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const hasControl = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; };
// One line of text within [1, max] characters (the taxonomy's isLine rule).
const isLine = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !hasControl(v);
// A descriptor value quoted in a reason: JSON, cut at 80 characters.
function q(v) {
  let s;
  try { s = JSON.stringify(v); } catch { s = undefined; }
  if (typeof s !== 'string') s = String(v);
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}
// Control characters (a line break, a tab) as one space, then capped: a
// server-supplied string shown as one line.
function oneLine(s, max) {
  let out = '';
  for (const ch of String(s)) { const c = ch.charCodeAt(0); out += c < 32 || c === 127 ? ' ' : ch; }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
const freezeDeep = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freezeDeep(v); } return o; };

/** Why `name` breaks the field-name rule, or null. */
function nameReason(name, where) {
  if (typeof name !== 'string' || !NAME_RULE.test(name)) {
    return `${where} ${q(name)} is not a field name (a letter or "_", then up to 63 letters, digits, "_", "." or "-")`;
  }
  if (RESERVED_NAMES.includes(name)) return `${where} ${q(name)} is reserved`;
  return null;
}

// ---------- the root and the path rule ----------

/**
 * The MCP server root of an MCP URL: its path without the last segment (one
 * trailing slash ignored), with no query, fragment or userinfo — a URL
 * credential is the studio's connection to the MCP endpoint and never rides
 * to a settings path. null for anything but an http(s) URL.
 * @returns {URL | null}
 */
export function settingsRoot(mcpUrl) {
  let url;
  try { url = new URL(String(mcpUrl)); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  // `./` drops the last segment; `../` also drops the one a trailing slash
  // left empty (and stays at the origin's root for `/`).
  return new URL(url.href.endsWith('/') ? '../' : './', url.href);
}

// Why a path breaks the shape half of the rule (no root needed), or null.
// `under` (" under <root>") goes into the plain-path sentence.
function pathShapeReason(path, noun, under = '') {
  if (typeof path !== 'string' || !path) return `${noun} is missing`;
  if (path.length > SETTINGS_LIMITS.path) return `${noun} ${q(path)} is longer than ${SETTINGS_LIMITS.path} characters`;
  if (!PATH_RULE.test(path)) return `${noun} ${q(path)} is not a plain path${under} (letters, digits, "-", "_", ".", "~" and "/" only)`;
  for (const seg of path.replace(/^\//, '').split('/')) {
    if (seg === '.' || seg.startsWith('..')) return `${noun} ${q(path)} has a segment that is "." or starts with ".."`;
  }
  return null;
}

/**
 * A descriptor path (an endpoint, an action's endpoint, the generic form's
 * path, a policy's generic.path) resolved under the MCP server root of
 * `mcpUrl` by the strict rule, then re-checked: the same origin, under the
 * root, no userinfo, search or hash, and mcpUrlPolicy has no error.
 * `noun` and `fix` word the reason for the caller (a descriptor's author,
 * the generic form's reader).
 * @returns {{ url: string } | { reason: string }}
 */
export function resolveSettingsPath(path, mcpUrl, { noun = "the server's settings endpoint", fix = 'its author fixes the descriptor' } = {}) {
  const root = settingsRoot(mcpUrl);
  if (!root) return { reason: `the MCP URL is not an http(s) URL, so it has no settings root — ${fix}` };
  const tail = ` — the studio sends settings only to the MCP server itself; ${fix}`;
  const shape = pathShapeReason(path, noun, ` under ${root.href}`);
  if (shape) return { reason: `${shape}${tail}` };
  let url;
  try { url = new URL(path.replace(/^\//, ''), root); } catch { return { reason: `${noun} ${q(path)} does not resolve under ${root.href}${tail}` }; }
  const policy = mcpUrlPolicy(url.href);
  if (url.origin !== root.origin || !url.href.startsWith(root.href) || url.username || url.password || url.search || url.hash || policy.error) {
    return { reason: `${noun} ${q(path)} resolves outside ${root.href}${tail}` };
  }
  return { url: url.href };
}

// ---------- values ----------

/**
 * A `url` field's value as it is sent and matched: trimmed, parsed, http(s),
 * no userinfo; the normalised href (lower-cased scheme and host). The value
 * is never quoted in a reason (a userinfo password would be).
 * @returns {{ href: string } | { reason: string }}
 */
export function normaliseUrlValue(value) {
  if (typeof value !== 'string' || !value.trim()) return { reason: 'the backend URL is empty' };
  if (value.length > SETTINGS_LIMITS.value) return { reason: `the backend URL is longer than ${SETTINGS_LIMITS.value} characters` };
  let url;
  try { url = new URL(value.trim()); } catch { return { reason: 'the backend URL is not a valid URL' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: `the backend URL must be http or https; got scheme '${url.protocol.replace(/:$/, '')}'` };
  if (url.username || url.password) return { reason: 'the backend URL carries a user or password before "@" — put them in their own fields, so they are treated as secrets' };
  return { href: url.href };
}

// ---------- the descriptor ----------

const isJsonType = (t) => /^\s*application\/(?:[a-z0-9.+-]*\+)?json\s*(?:;|$)/i.test(String(t ?? ''));

function readField(raw, i, errors) {
  const where = `fields[${i}]`;
  if (!isPlainObject(raw)) { errors.push(`${where} is not an object`); return null; }
  const bad = nameReason(raw.name, `${where}.name`);
  if (bad) { errors.push(bad); return null; }
  if (!isLine(raw.label, SETTINGS_LIMITS.label)) { errors.push(`${where}.label must be one line of 1–${SETTINGS_LIMITS.label} characters (got ${q(raw.label)})`); return null; }
  const type = typeof raw.type === 'string' && FIELD_TYPES.includes(raw.type) ? raw.type : 'text';
  if (raw.required !== undefined && typeof raw.required !== 'boolean') { errors.push(`${where}.required must be true or false`); return null; }
  const field = { name: raw.name, label: raw.label, type, required: raw.required === true, help: null, placeholder: null };
  for (const [k, max] of [['help', SETTINGS_LIMITS.help], ['placeholder', SETTINGS_LIMITS.placeholder]]) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (!isLine(raw[k], max)) { errors.push(`${where}.${k} must be one line of 1–${max} characters (got ${q(raw[k])})`); return null; }
    field[k] = raw[k];
  }
  if (type === 'secret') field.placeholder = null;
  return field;
}

function readAction(raw, i, fieldNames, endpoint, errors) {
  const where = `actions[${i}]`;
  if (!isPlainObject(raw)) { errors.push(`${where} is not an object`); return null; }
  const bad = nameReason(raw.name, `${where}.name`);
  if (bad) { errors.push(bad); return null; }
  if (!isLine(raw.label, SETTINGS_LIMITS.label)) { errors.push(`${where}.label must be one line of 1–${SETTINGS_LIMITS.label} characters (got ${q(raw.label)})`); return null; }
  const action = { name: raw.name, label: raw.label, endpoint, fields: null, confirm: null };
  if (raw.endpoint !== undefined) action.endpoint = raw.endpoint;
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields)) { errors.push(`${where}.fields must be an array of field names`); return null; }
    const unknown = raw.fields.find((n) => typeof n !== 'string' || !fieldNames.includes(n));
    if (unknown !== undefined) { errors.push(`${where}.fields names an unknown field ${q(unknown)}`); return null; }
    action.fields = [...new Set(raw.fields)];
  }
  if (raw.confirm !== undefined && raw.confirm !== null) {
    if (!isLine(raw.confirm, SETTINGS_LIMITS.confirm)) { errors.push(`${where}.confirm must be one line of 1–${SETTINGS_LIMITS.confirm} characters (got ${q(raw.confirm)})`); return null; }
    action.confirm = raw.confirm;
  }
  return action;
}

/**
 * The answer to GET <root>/admin/schema → one of
 *   { descriptor }       version 1, valid: the normalised description (frozen)
 *   { notDescriptor }    not a settings description at all (a JSON-RPC answer,
 *                        an object without "version" and "fields", a type
 *                        that is not JSON) — the modal offers the generic form
 *                        and names this phrase
 *   { reason }           it tries to be one and breaks the contract (named)
 * `contentType` omitted is not checked (a file read); given — null included
 * — it must be JSON. `mcpUrl` given, every endpoint is resolved under its
 * root (resolveSettingsPath); omitted, only the path's shape is checked.
 */
export function parseSettingsDescriptor(text, { mcpUrl, contentType } = {}) {
  if (contentType !== undefined && !isJsonType(contentType)) {
    return { notDescriptor: contentType ? `${oneLine(String(contentType).split(';')[0].trim(), 80)}, not JSON` : 'an answer with no content type, not JSON' };
  }
  if (typeof text !== 'string') return { reason: 'the settings description is not text' };
  const bytes = byteLength(text);
  if (bytes > SETTINGS_LIMITS.descriptorBytes) return { reason: `the settings description is larger than 16 KiB (${bytes} bytes)` };
  let doc;
  try { doc = JSON.parse(text); } catch (e) { return { reason: `the settings description is not JSON (${oneLine(e.message, 120)})` }; }
  if (!isPlainObject(doc)) return { reason: 'the settings description is not a JSON object' };
  if (!own(doc, 'version') && !own(doc, 'fields')) {
    return { notDescriptor: own(doc, 'jsonrpc') ? 'a JSON-RPC message' : 'a JSON object without "version" and "fields"' };
  }
  if (!Number.isInteger(doc.version)) return { reason: `the settings description's "version" must be an integer (got ${q(doc.version)})` };
  if (doc.version > SETTINGS_DESCRIPTOR_VERSION) {
    return { reason: `this server describes its settings in version ${doc.version}; this studio reads version ${SETTINGS_DESCRIPTOR_VERSION} — update the studio, or use the generic form` };
  }
  if (doc.version < SETTINGS_DESCRIPTOR_VERSION) return { reason: `the settings description's version ${doc.version} is not one (version ${SETTINGS_DESCRIPTOR_VERSION} is the first)` };
  const checkPath = (path, noun) => {
    if (mcpUrl === undefined) return pathShapeReason(path, noun);
    const r = resolveSettingsPath(path, mcpUrl, { noun });
    return r.reason ?? null;
  };
  const endpointBad = checkPath(doc.endpoint, "the server's settings endpoint");
  if (endpointBad) return { reason: endpointBad };
  if (!Array.isArray(doc.fields) || doc.fields.length === 0) return { reason: 'the settings description declares no fields' };
  if (doc.fields.length > SETTINGS_LIMITS.fields) return { reason: `the settings description declares ${doc.fields.length} fields (at most ${SETTINGS_LIMITS.fields})` };
  const errors = [];
  const fields = [];
  for (let i = 0; i < doc.fields.length; i++) {
    const f = readField(doc.fields[i], i, errors);
    if (!f) return { reason: errors[0] };
    if (fields.some((x) => x.name === f.name)) return { reason: `duplicate field name ${q(f.name)}` };
    fields.push(f);
  }
  let auth = null;
  if (doc.auth !== undefined && doc.auth !== null) {
    if (!isPlainObject(doc.auth)) return { reason: 'auth must be { field, scheme: "bearer" }' };
    const target = fields.find((f) => f.name === doc.auth.field);
    if (!target || target.type !== 'secret') return { reason: `auth.field ${q(doc.auth.field)} does not name a secret field` };
    if (doc.auth.scheme !== 'bearer') return { reason: `auth.scheme must be "bearer" (got ${q(doc.auth.scheme)})` };
    auth = { field: target.name, scheme: 'bearer' };
  }
  const actions = [];
  if (doc.actions !== undefined && doc.actions !== null) {
    if (!Array.isArray(doc.actions)) return { reason: 'actions must be an array' };
    if (doc.actions.length > SETTINGS_LIMITS.actions) return { reason: `the settings description declares ${doc.actions.length} actions (at most ${SETTINGS_LIMITS.actions})` };
    const names = fields.map((f) => f.name);
    for (let i = 0; i < doc.actions.length; i++) {
      const a = readAction(doc.actions[i], i, names, doc.endpoint, errors);
      if (!a) return { reason: errors[0] };
      if (actions.some((x) => x.name === a.name)) return { reason: `duplicate action name ${q(a.name)}` };
      const bad = checkPath(a.endpoint, `the server's endpoint for action ${q(a.name)}`);
      if (bad) return { reason: bad };
      actions.push(a);
    }
  }
  return { descriptor: freezeDeep({ version: SETTINGS_DESCRIPTOR_VERSION, endpoint: doc.endpoint, auth, fields, actions }) };
}

/**
 * The generic form for a server that publishes no description: a URL, a
 * user, a password and a server API key, sent to `path` (default
 * /configure) with every field in the body, or the API key as
 * `Authorization: Bearer` (`auth: 'bearer'`). `names` overrides any subset
 * of GENERIC_NAMES; each must pass the field-name rule and differ from the
 * others. The path's shape is checked here, its root when it is resolved.
 * @returns {object | { reason: string }}  a descriptor (as parseSettingsDescriptor's) or a reason
 */
export function genericDescriptor({ names = GENERIC_NAMES, path = '/configure', auth = 'body' } = {}) {
  if (!isPlainObject(names)) return { reason: 'the field names must be { url, user, secret, apiKey }' };
  const unknown = Object.keys(names).find((k) => !own(GENERIC_NAMES, k));
  if (unknown !== undefined) return { reason: `unknown generic field ${q(unknown)} (url, user, secret, apiKey)` };
  const n = { ...GENERIC_NAMES };
  for (const k of Object.keys(GENERIC_NAMES)) if (own(names, k)) n[k] = names[k];
  for (const k of Object.keys(GENERIC_NAMES)) {
    const bad = nameReason(n[k], `the ${k} field's name`);
    if (bad) return { reason: bad };
  }
  const all = Object.values(n);
  const dup = all.find((v, i) => all.indexOf(v) !== i);
  if (dup !== undefined) return { reason: `the field name ${q(dup)} is used twice` };
  const shape = pathShapeReason(path, 'the settings path');
  if (shape) return { reason: shape };
  if (auth !== 'body' && auth !== 'bearer') return { reason: `the API key goes in "body" or "bearer" (got ${q(auth)})` };
  return freezeDeep({
    version: SETTINGS_DESCRIPTOR_VERSION,
    endpoint: path,
    auth: auth === 'bearer' ? { field: n.apiKey, scheme: 'bearer' } : null,
    fields: [
      { name: n.url, label: 'Backend base URL', type: 'url', required: true, help: null, placeholder: null },
      { name: n.user, label: 'User', type: 'text', required: false, help: null, placeholder: null },
      { name: n.secret, label: 'Password / token', type: 'secret', required: false, help: null, placeholder: null },
      { name: n.apiKey, label: 'Server API key', type: 'secret', required: false, help: 'leave empty only if the server needs none', placeholder: null },
    ],
    actions: [],
  });
}

// ---------- the request ----------

const valueOf = (values, name) => (own(values, name) ? values[name] : undefined);
const isEmptyValue = (field, v) => (field.type === 'boolean' ? false
  : field.type === 'secret' ? (typeof v !== 'string' || v === '')
    : (v === undefined || v === null || String(v).trim() === ''));
const USER_NAME = /^(user(name)?|login)$/i;

/**
 * The configure request (or `action`'s) for a descriptor and the values
 * read from the form (name → string, or boolean for a checkbox):
 *   { path, body, payload, headers, sent, carries, secretValues, secretNames, user }
 * or { reason, missing? } when it must not be sent. `body` is the JSON text
 * (`payload` the null-prototype object it encodes); `headers` holds
 * Content-Type and, when the descriptor's `auth` field has a value,
 * `Authorization: Bearer <it>` (that field then leaves the body). A url
 * value travels normalised, a secret exactly as typed, a boolean as
 * true/false; an empty optional field is omitted. An action sends
 * `{ action }` plus the fields it carries — its declared `fields`, else the
 * `auth` field, else every non-empty secret — skips the required check, and
 * `carries` lists the candidates with `empty` set, so the modal can say what
 * goes. `secretValues` are the secrets it sends (for redaction), `user` the
 * value of a field named user/username/login.
 */
export function settingsRequest(descriptor, values, { action = null } = {}) {
  const fieldsByName = new Map(descriptor.fields.map((f) => [f.name, f]));
  let act = null;
  if (action !== null) {
    act = descriptor.actions.find((a) => a.name === action);
    if (!act) return { reason: `the server declares no action ${q(action)}` };
  }
  let candidates;
  if (!act) candidates = descriptor.fields;
  else if (act.fields) candidates = act.fields.map((n) => fieldsByName.get(n));
  else if (descriptor.auth) candidates = [fieldsByName.get(descriptor.auth.field)];
  else candidates = descriptor.fields.filter((f) => f.type === 'secret');
  if (!act) {
    const missing = descriptor.fields.filter((f) => f.required && isEmptyValue(f, valueOf(values, f.name))).map((f) => f.label);
    if (missing.length) return { reason: `fill in ${missing.join(', ')} — the server requires ${missing.length === 1 ? 'it' : 'them'}`, missing };
  }
  const payload = Object.create(null);
  if (act) payload.action = act.name;
  const headers = { 'Content-Type': 'application/json' };
  const sent = [];
  const secretValues = [];
  const carries = [];
  for (const f of candidates) {
    const v = valueOf(values, f.name);
    const empty = isEmptyValue(f, v);
    carries.push({ name: f.name, label: f.label, empty });
    if (empty) continue;
    if (f.type !== 'boolean' && String(v).length > SETTINGS_LIMITS.value) return { reason: `${f.label} is longer than ${SETTINGS_LIMITS.value} characters` };
    let out;
    if (f.type === 'boolean') out = v === true;
    else if (f.type === 'secret') out = v;
    else if (f.type === 'url') {
      const u = normaliseUrlValue(String(v));
      if (u.reason) return { reason: `${f.label}: ${u.reason}` };
      out = u.href;
    } else out = String(v);
    if (descriptor.auth && f.name === descriptor.auth.field) {
      // fetch refuses a header value with a line break or a character above U+00FF.
      if (/[^\t\x20-\x7e\x80-\xff]/.test(out)) return { reason: `${f.label} cannot travel in an Authorization header (it holds a line break or a character outside Latin-1)` };
      headers.Authorization = `Bearer ${out}`;
    } else {
      payload[f.name] = out;
    }
    sent.push(f.name);
    if (f.type === 'secret') secretValues.push(out);
  }
  const body = JSON.stringify(payload);
  const bytes = byteLength(body);
  if (bytes > SETTINGS_LIMITS.bodyBytes) return { reason: `the settings are ${bytes} bytes, more than the ${SETTINGS_LIMITS.bodyBytes} a request may carry` };
  const userField = descriptor.fields.find((f) => f.type === 'text' && USER_NAME.test(f.name) && sent.includes(f.name));
  return {
    path: act ? act.endpoint : descriptor.endpoint,
    body,
    payload,
    headers,
    sent,
    carries: act ? carries : carries.filter((c) => !c.empty),
    secretValues,
    secretNames: descriptor.fields.filter((f) => f.type === 'secret').map((f) => f.name),
    user: userField ? String(valueOf(values, userField.name)) : null,
  };
}

// ---------- redaction ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64(text) {
  const b = encoder.encode(text);
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
  }
  return out;
}
const asciiEscape = (s, upper) => s.replace(/[^\x20-\x7e]/g, (c) => {
  const h = c.charCodeAt(0).toString(16).padStart(4, '0');
  return `\\u${upper ? h.toUpperCase() : h}`;
});

// Every form an echoed secret may take in a body, longest first.
function echoForms(secretValues, user) {
  const forms = new Set();
  for (const s of secretValues ?? []) {
    if (typeof s !== 'string' || s.length < MIN_ECHO_LENGTH) continue;
    const json = JSON.stringify(s).slice(1, -1);
    const variants = [s, encodeURIComponent(s), json, asciiEscape(json, false), asciiEscape(json, true)];
    for (const v of [...variants]) if (v.includes('/')) variants.push(v.replace(/\//g, '\\/'));
    const b = base64(s);
    variants.push(b, b.replace(/=+$/, ''));
    if (typeof user === 'string' && user) { const basic = base64(`${user}:${s}`); variants.push(basic, basic.replace(/=+$/, '')); }
    for (const v of variants) if (v.length >= MIN_ECHO_LENGTH) forms.add(v);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function replaceForms(text, forms) {
  let out = String(text);
  let count = 0;
  for (const f of forms) {
    const parts = out.split(f);
    if (parts.length > 1) { count += parts.length - 1; out = parts.join(REDACTED); }
  }
  return { text: out, count };
}

/**
 * `value` (a text) with every submitted secret of 4+ characters replaced by
 * `<redacted>` in each form it may take — raw, encodeURIComponent,
 * JSON-escaped (with `\uXXXX` for non-ASCII and `\/` variants), base64 —
 * and base64 of `<user>:<secret>` (Basic credentials) when `user` is given.
 * Longest form first. `redacted` counts the replacements.
 * @returns {{ text: string, redacted: number }}
 */
export function redactEchoes(value, secretValues, { user = null } = {}) {
  const { text, count } = replaceForms(value, echoForms(secretValues, user));
  return { text, redacted: count };
}

const isSecretKey = (key, names) => (names ?? []).includes(key) || SECRET_KEY_CLASS.test(key);
const isRedactable = (v) => v !== null && v !== undefined && typeof v !== 'boolean' && v !== '' && v !== REDACTED;

// A parsed JSON value walked: by value on every string (and key), then by
// key class. Objects are rebuilt on a null prototype (a "__proto__" key
// stays a key).
function walk(value, forms, names, tally) {
  if (typeof value === 'string') {
    const r = replaceForms(value, forms);
    tally.n += r.count;
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, forms, names, tally));
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      const kr = replaceForms(k, forms);
      tally.n += kr.count;
      if (isSecretKey(k, names) && isRedactable(v)) {
        const inner = walk(v, forms, names, { n: 0 });
        if (inner !== REDACTED) tally.n += 1;
        out[kr.text] = REDACTED;
      } else {
        out[kr.text] = walk(v, forms, names, tally);
      }
    }
    return out;
  }
  return value;
}

/**
 * A parsed JSON value with the value of every key that is a submitted
 * secret field's name, or matches
 * /^(pass(word)?|secret|token|api[-_]?key|credential|authorization)$/i,
 * replaced by "<redacted>" whatever its length. A copy, on null
 * prototypes; `redacted` counts the keys.
 * @returns {{ json: unknown, redacted: number }}
 */
export function redactSecretKeys(json, secretNames) {
  const tally = { n: 0 };
  return { json: walk(json, [], secretNames, tally), redacted: tally.n };
}

// ---------- the outcome ----------

function outcomeShape(doc) {
  if (!isPlainObject(doc)) return null;
  const shape = {};
  let any = false;
  if (typeof doc.ok === 'boolean') { shape.ok = doc.ok; any = true; }
  if (typeof doc.message === 'string') { shape.message = oneLine(doc.message, SETTINGS_LIMITS.message); any = true; }
  if (Array.isArray(doc.checks)) {
    shape.checks = doc.checks.filter((c) => isPlainObject(c) && typeof c.label === 'string' && c.label.trim())
      .slice(0, SETTINGS_LIMITS.checks)
      .map((c) => ({
        label: oneLine(c.label, SETTINGS_LIMITS.label),
        status: CHECK_STATUSES.includes(c.status) ? c.status : 'unknown',
        detail: typeof c.detail === 'string' && c.detail ? oneLine(c.detail, SETTINGS_LIMITS.checkDetail) : null,
      }));
    any = true;
  }
  return any ? shape : null;
}

/**
 * What the modal shows for the configure (or action) answer:
 *   { tone, headline, success, ok, message, checks, shape, raw, json, redacted, capped }
 * `type: 'opaqueredirect'` is a redirect the browser did not follow (status
 * 0). `truncated` says the reader stopped at its cap. The body is redacted
 * before anything is read from it (A.2.5: by value on the raw text, then
 * on every parsed string, then by key class), `raw` is the redacted text —
 * JSON pretty-printed — cut at 8 KiB shown, and `capped` names a cap that
 * was hit ('read' | 'shown' | null). `success` (2xx, `ok` not false) is
 * what runs the connection test. `shape` is the outcome's own keys
 * ({ ok?, message?, checks? }) or null — all the proxy passes back.
 */
export function outcomeOf({ status, contentType, text, type = null, truncated = false }, { secretValues = [], secretNames = [], user = null } = {}) {
  const forms = echoForms(secretValues, user);
  let body = typeof text === 'string' ? text : '';
  let capped = truncated ? 'read' : null;
  if (byteLength(body) > SETTINGS_LIMITS.outcomeBytes) {
    body = new TextDecoder().decode(encoder.encode(body).slice(0, SETTINGS_LIMITS.outcomeBytes)).replace(/�$/, '');
    capped = 'read';
  }
  // A body cut at the read cap may end in part of a secret: drop the tail a
  // partial echo could occupy.
  if (capped === 'read' && forms.length) body = body.slice(0, Math.max(0, body.length - (forms[0].length - 1)));
  const step1 = replaceForms(body, forms);
  let redacted = step1.count;
  let json = null;
  let raw = step1.text;
  if (isJsonType(contentType)) {
    let parsed;
    let parsedOk = false;
    try { parsed = JSON.parse(step1.text); parsedOk = true; } catch { /* shown as text */ }
    if (parsedOk) {
      const tally = { n: 0 };
      json = walk(parsed, forms, secretNames, tally);
      redacted += tally.n;
      raw = JSON.stringify(json, null, 2);
    }
  }
  if (raw.length > SETTINGS_LIMITS.outcomeShown) { raw = raw.slice(0, SETTINGS_LIMITS.outcomeShown); capped = capped ?? 'shown'; }
  const shape = outcomeShape(json);
  const ok = shape && typeof shape.ok === 'boolean' ? shape.ok : null;
  const s = Number(status);
  const two = s >= 200 && s < 300;
  let tone;
  let headline;
  if (type === 'opaqueredirect') {
    tone = 'warn';
    headline = 'The server answered with a redirect, which the studio never follows. It may have applied the settings — test the connection.';
  } else if (two && ok === true) {
    tone = 'ok'; headline = `The server reports the settings verified (HTTP ${s}).`;
  } else if (two && ok === false) {
    tone = 'error'; headline = `The server answered HTTP ${s} but reports a failure.`;
  } else if (two) {
    tone = 'neutral'; headline = `The server accepted the settings (HTTP ${s}). It reported no verification.`;
  } else {
    tone = 'error'; headline = `The server refused the settings: HTTP ${s}.`;
  }
  return {
    tone,
    headline,
    success: type !== 'opaqueredirect' && two && ok !== false,
    ok,
    message: shape?.message ?? null,
    checks: shape?.checks ?? [],
    shape,
    raw,
    json,
    redacted,
    capped,
  };
}

// ---------- the settings policy ----------

// Unbounded quantifiers (*, +, {n,}) outside a character class.
function unboundedQuantifiers(pattern) {
  let n = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '*' || c === '+') n++;
    else if (c === '{' && /^\{\d+,\}/.test(pattern.slice(i))) n++;
  }
  return n;
}

const STRICT = (obj, keys, where, errors) => {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) { errors.push(`${where}: unknown key ${q(k)}`); return false; }
  return true;
};

/**
 * A parsed settings-policy document → { policy, errors }: `policy` (frozen)
 * when `errors` is empty, else null. Strict: an unknown key anywhere, a
 * version other than 1, 0 or more than 32 rules, a rule naming a secret are
 * errors. A pattern passes compileBoundedPattern (anchored, ≤ 200
 * characters, flags "" or "i", no quantified group, timed against ids) and
 * then the settings bound: at most one unbounded quantifier outside a
 * class. These are checks of shape: no load-time probe can prove a pattern
 * fast on every value, so none is run — a caller that must not block runs
 * policyFindings under a deadline (the studio server: a worker, 100 ms,
 * a rule that does not finish counting as matched). `timed: false` (the
 * browser, re-reading a file the server checked) skips only the id clocks.
 */
export function compileSettingsPolicy(json, { timed = true } = {}) {
  const errors = [];
  if (!isPlainObject(json)) return { policy: null, errors: ['the settings policy must be a JSON object'] };
  if (!STRICT(json, ['version', 'rules', 'generic'], 'the settings policy', errors)) return { policy: null, errors };
  if (json.version !== 1) errors.push(`version must be 1 (got ${q(json.version)})`);
  let generic = null;
  if (json.generic !== undefined) {
    const g = json.generic;
    if (!isPlainObject(g)) errors.push('generic must be { path?, names?, auth? }');
    else if (STRICT(g, ['path', 'names', 'auth'], 'generic', errors)) {
      if (g.names !== undefined && !isPlainObject(g.names)) errors.push('generic.names must be { url?, user?, secret?, apiKey? }');
      else {
        const d = genericDescriptor({ names: g.names ?? GENERIC_NAMES, path: g.path ?? '/configure', auth: g.auth ?? 'body' });
        if (d.reason) errors.push(`generic: ${d.reason}`);
        else {
          const names = { url: d.fields[0].name, user: d.fields[1].name, secret: d.fields[2].name, apiKey: d.fields[3].name };
          generic = { path: d.endpoint, names, auth: d.auth ? 'bearer' : 'body' };
        }
      }
    }
  }
  const secretNames = generic ? [generic.names.secret, generic.names.apiKey] : [GENERIC_NAMES.secret, GENERIC_NAMES.apiKey];
  const rules = [];
  if (!Array.isArray(json.rules) || json.rules.length === 0) errors.push('rules must be an array of 1–32 rules');
  else if (json.rules.length > SETTINGS_LIMITS.policyRules) errors.push(`rules: ${json.rules.length} rules (at most ${SETTINGS_LIMITS.policyRules})`);
  else {
    json.rules.forEach((raw, i) => {
      const where = `rules[${i}]`;
      if (!isPlainObject(raw)) { errors.push(`${where}: expected { when, warn, require? }`); return; }
      if (!STRICT(raw, ['when', 'warn', 'require'], where, errors)) return;
      const w = raw.when;
      if (!isPlainObject(w)) { errors.push(`${where}.when: expected { field | type, pattern, flags? }`); return; }
      if (!STRICT(w, ['field', 'type', 'pattern', 'flags'], `${where}.when`, errors)) return;
      if ((w.field === undefined) === (w.type === undefined)) { errors.push(`${where}.when: exactly one of field or type`); return; }
      let field = null;
      let type = null;
      if (w.field !== undefined) {
        const bad = nameReason(w.field, 'field');
        if (bad) { errors.push(`${where}.when: ${bad}`); return; }
        if (secretNames.includes(w.field)) { errors.push(`${where}.when: field ${q(w.field)} is a secret of the generic form — a rule cannot match a secret: its value is never read by the policy`); return; }
        field = w.field;
      } else {
        if (w.type === 'secret') { errors.push(`${where}.when: a rule cannot match a secret: its value is never read by the policy`); return; }
        if (!POLICY_TYPES.includes(w.type)) { errors.push(`${where}.when: type must be one of ${POLICY_TYPES.join(', ')} (got ${q(w.type)})`); return; }
        type = w.type;
      }
      const flags = w.flags ?? '';
      const compiled = compileBoundedPattern(w.pattern, { flags, noun: 'pattern', timed });
      if (compiled.reason) { errors.push(`${where}.when: ${compiled.reason}`); return; }
      if (unboundedQuantifiers(w.pattern) > 1) { errors.push(`${where}.when: pattern has more than one unbounded quantifier (*, + or {n,}), which a URL-length value can make slow`); return; }
      if (!isLine(raw.warn, SETTINGS_LIMITS.warn)) { errors.push(`${where}.warn must be one line of 1–${SETTINGS_LIMITS.warn} characters`); return; }
      let ack = null;
      if (raw.require !== undefined) {
        if (!isPlainObject(raw.require)) { errors.push(`${where}.require: expected { ack }`); return; }
        if (!STRICT(raw.require, ['ack'], `${where}.require`, errors)) return;
        if (!isLine(raw.require.ack, SETTINGS_LIMITS.ack)) { errors.push(`${where}.require.ack must be one line of 1–${SETTINGS_LIMITS.ack} characters`); return; }
        ack = raw.require.ack;
      }
      rules.push(Object.freeze({ index: i, field, type, re: compiled.re, pattern: w.pattern, flags, warn: raw.warn, ack }));
    });
  }
  if (errors.length) return { policy: null, errors };
  return { policy: Object.freeze({ version: 1, rules: Object.freeze(rules), generic: generic ? freezeDeep(generic) : null }), errors };
}

/**
 * The policy's findings for a form (a descriptor) and its current values:
 * [{ rule, field, warn, ack, unevaluated, note }]. A `field` rule checks
 * that field; a `type` rule every field of the type. A value is checked
 * only when non-empty; a url value as normaliseUrlValue's href (a value it
 * refuses cannot be sent, so it is not checked); a boolean as "true" /
 * "false". A value longer than 512 characters is itself a finding. A rule
 * whose field the form lacks, or holds as a secret, cannot run: an
 * `unevaluated` finding, whose ack is required like a match's. The patterns
 * run on the calling thread, unbounded in time: a server runs this under a
 * deadline (server/mcp-settings-eval.mjs).
 */
export function policyFindings(policy, descriptor, values) {
  if (!policy) return [];
  const out = [];
  for (const r of policy.rules) {
    const n = r.index + 1;
    let targets;
    if (r.field !== null) {
      const f = descriptor.fields.find((x) => x.name === r.field);
      if (!f || f.type === 'secret') {
        out.push({
          rule: r.index, field: r.field, warn: r.warn, ack: r.ack, unevaluated: true,
          note: !f ? `Policy rule ${n} checks ${r.field}, which this form does not have, so it cannot run`
            : `Policy rule ${n} checks ${r.field}, which is a secret on this form, so the policy cannot read it`,
        });
        continue;
      }
      targets = [f];
    } else {
      targets = descriptor.fields.filter((x) => x.type === r.type);
    }
    for (const f of targets) {
      const v = valueOf(values, f.name);
      let text;
      if (f.type === 'boolean') text = String(v === true);
      else if (isEmptyValue(f, v)) continue;
      else if (f.type === 'url') {
        const u = normaliseUrlValue(String(v));
        if (u.reason) continue;
        text = u.href;
      } else text = String(v);
      if (text.length > SETTINGS_LIMITS.policyValue) {
        out.push({ rule: r.index, field: f.name, warn: r.warn, ack: r.ack, unevaluated: false, note: `${f.label} is longer than ${SETTINGS_LIMITS.policyValue} characters, so the policy cannot check it` });
        continue;
      }
      if (r.re.test(text)) out.push({ rule: r.index, field: f.name, warn: r.warn, ack: r.ack, unevaluated: false, note: null });
    }
  }
  return out;
}
