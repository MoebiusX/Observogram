// server/routes/mcp-settings.mjs — the MCP server-settings API (rebadge
// batch 4, D2/D3).
//
//   GET  /api/mcp-settings           { ok, proxy, policy, configured } — the
//                                    settings policy the server was started
//                                    with (OBSERVOGRAM_MCP_SETTINGS_POLICY,
//                                    server/mcp-settings-policy.mjs: the
//                                    document or null, never its path) and
//                                    whether the opt-in pass-through is on
//                                    (OBSERVOGRAM_MCP_ADMIN_PROXY=1, read per
//                                    request). A viewer route: neither is a
//                                    secret, and the studio reads it only when
//                                    the Server settings modal opens, never at
//                                    boot. `no-store` like /api/taxonomy: the
//                                    answer changes with the process, not with
//                                    the resource.
//   POST /api/mcp-settings/describe  { mcpEndpointId | mcpUrl } → the MCP
//                                    server's settings description, read by
//                                    the studio server
//   POST /api/mcp-settings/submit    { mcpEndpointId | mcpUrl, mode, generic?,
//                                    action?, values, acks } → the configure
//                                    (or an action), sent by the studio server
//
// The two POSTs are the opt-in pass-through (decision M5): off unless
// OBSERVOGRAM_MCP_ADMIN_PROXY=1 — a 404 `denied: 'off'` then, before the body
// is read. A server-side request carrying a secret, so `admin` by class
// (server/route-table.mjs: the CSRF header in every posture, closed when the
// server is exposed without sign-in, answered without sign-in only to a
// direct loopback request — 'the MCP server-settings API'). In order:
//
//   1. authorize(); then the switch.
//   2. The body, read by this route's own JSON parser (the app-wide parser
//      never sees these two paths: this router is mounted before it), at
//      most 64 KiB. A malformed body is answered `400 the request body is
//      not valid JSON` with no fragment of it and nothing logged (M6 (b): no
//      other route's answer changes). An `mcpAuth` is refused: the
//      pass-through sends no MCP token.
//   3. The target: resolveMcpTarget with `forWrite` (the endpoint's read
//      token stays home) — a registered endpoint, or an admin's typed URL
//      (R4) —, the origin allowlist (a submit carries a credential, so a
//      non-loopback origin must be listed), https unless loopback, and never
//      the studio server's own address.
//   4. The path is the server's: describe reads <root>/admin/schema; submit
//      re-reads the description and sends to the endpoint it declares (or
//      the named action's), or — the generic form — only to the settings
//      policy's generic.path (else /configure). Every path passes the strict
//      path rule (tools/lib/mcp-server-settings.mjs).
//   5. submit re-checks the settings policy against the description it just
//      read: an acknowledgement a matching (or unevaluable) rule requires and
//      the caller did not tick is a 409.
//   6. One request upstream with the platform's fetch — never the transport
//      hook (M10): no redirect followed (a 3xx is refused, naming its origin
//      only), 10 s, the answer read with a cap (16 KiB for a description,
//      64 KiB for an outcome), and exactly Content-Type (POST), Accept and
//      the description's own Authorization when it declares one.
//   7. The answer carries no upstream text (R2): describe the validated
//      description re-serialised (or the named reason), submit the upstream
//      status, its media type, the byte length and the outcome shape's three
//      keys re-read and redacted (outcomeOf) — or null.
//
// One stderr line per upstream request, `[mcp-settings] <op> <status> <ms>ms`
// (a status code or a failure word, nothing else). submit writes one
// `live.mcp-settings` row: field names and acknowledged rule indexes, never
// a value. The body is never logged, kept or put into an error: a failure
// past the parser is a fixed `502 the server-settings proxy failed (<error
// class>)`.
//
// SQL-free; the GET is deployment-global (no org is consulted).

import express from 'express';
import {
  SETTINGS_DESCRIPTOR_PATH, SETTINGS_LIMITS, genericDescriptor, outcomeOf, parseSettingsDescriptor, policyFindings,
  redactEchoes, resolveSettingsPath, settingsRequest, settingsRoot,
} from '../../tools/lib/mcp-server-settings.mjs';
import { isLoopbackOrigin } from '../../tools/lib/mcp-url-safety.mjs';
import { auditAfter } from '../audit-after.mjs';
import { mcpAdminProxyOn, settingsPolicy, settingsPolicyAnswer } from '../mcp-settings-policy.mjs';
import { mcpCallerOf, mcpOriginDecision, mcpRefusalBody, redactTarget } from '../mcp-target-policy.mjs';
import { resolveMcpTarget } from '../service-admin.mjs';
import { currentStore } from '../store/db.mjs';

export const UPSTREAM_TIMEOUT_MS = 10_000;
const DESCRIBE = 'POST /api/mcp-settings/describe';
const SUBMIT = 'POST /api/mcp-settings/submit';

const OFF = 'the MCP server-settings proxy is off — the browser talks to the MCP server directly; the server\'s operator sets OBSERVOGRAM_MCP_ADMIN_PROXY=1 to pass settings through the studio server';
const NOT_JSON = 'the request body is not valid JSON';
const TOO_LARGE = `the request body is larger than ${SETTINGS_LIMITS.bodyBytes / 1024} KiB`;
const NO_MCP_AUTH = 'the server-settings proxy sends no MCP token — a server API key goes in the descriptor\'s own field';
const VALUES = 'values must be an object of field name → text or true/false';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => isPlainObject(o) && Object.prototype.hasOwnProperty.call(o, k);

// The switch, before the body is read: off, nothing is parsed.
function proxySwitch(req, res, next) {
  if (!mcpAdminProxyOn()) return res.status(404).json({ ok: false, denied: 'off', error: OFF });
  return next();
}

// This route's own parser (the app-wide one is mounted after this router).
const settingsJson = express.json({ limit: SETTINGS_LIMITS.bodyBytes });

function errorClass(e) {
  const name = e?.constructor?.name ?? e?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : 'Error';
}
const failed = (e) => ({ ok: false, error: `the server-settings proxy failed (${errorClass(e)})` });

// The parser's failures, and anything a handler let escape: fixed texts, no
// fragment of the body, nothing logged (M6 (b), on these two paths only).
function settingsBodyError(err, req, res, next) {
  if (res.headersSent) return next(err);
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: NOT_JSON });
  if (err?.type === 'entity.too.large') return res.status(400).json({ ok: false, error: TOO_LARGE });
  if (typeof err?.type === 'string' && err.status >= 400 && err.status < 500) return res.status(400).json({ ok: false, error: 'the request body could not be read' });
  return res.status(502).json(failed(err));
}

// A media type as a short token (the upstream Content-Type without its
// parameters), or null — never more of what the server sent.
function mediaType(ct) {
  const t = String(ct ?? '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]{1,40}\/[a-z0-9!#$&^_.+-]{1,60}$/.test(t) ? t : null;
}

// The body as text, at most `cap` bytes: { text, bytes, truncated }; a
// declared or read length over the cap → { oversize } when `refuseOver`.
async function readCapped(res, cap, { refuseOver }) {
  const declared = Number(res.headers.get('content-length'));
  if (refuseOver && Number.isFinite(declared) && declared > cap) {
    res.body?.cancel().catch(() => {});
    return { oversize: declared };
  }
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        chunks.push(value.subarray(0, value.byteLength - (bytes - cap)));
        truncated = true;
        reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  if (refuseOver && truncated) return { oversize: bytes };
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated };
}

const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';

// One upstream request with the platform's fetch (never the transport hook,
// M10). → { status, contentType, text, bytes, truncated, ms } or
// { failure: 'timeout' | 'unreachable' | 'redirect' | 'oversize', to?, code?, ms }.
async function upstream(url, { method, headers, body, cap, refuseOver = false }) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  let res;
  try {
    res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (e) {
    const code = typeof e?.cause?.code === 'string' && /^[A-Z0-9_]{2,40}$/.test(e.cause.code) ? e.cause.code : null;
    return { failure: isTimeout(e) ? 'timeout' : 'unreachable', code, ms: ms() };
  }
  if (res.status >= 300 && res.status < 400) {
    res.body?.cancel().catch(() => {});
    let to = null;
    try { to = new URL(res.headers.get('location') ?? '', url).origin; } catch { /* no usable Location */ }
    return { failure: 'redirect', to: to && to !== 'null' ? to : null, ms: ms() };
  }
  let read;
  try {
    read = await readCapped(res, cap, { refuseOver });
  } catch (e) {
    return { failure: isTimeout(e) ? 'timeout' : 'unreachable', code: null, ms: ms() };
  }
  if (read.oversize !== undefined) return { failure: 'oversize', ms: ms() };
  return { status: res.status, contentType: res.headers.get('content-type'), text: read.text, bytes: read.bytes, truncated: read.truncated, ms: ms() };
}

const log = (op, status, ms) => process.stderr.write(`[mcp-settings] ${op} ${status} ${ms}ms\n`);

// Could a configure have arrived? Not when the connection was refused.
const mayHaveArrived = (u) => !(u.failure === 'unreachable' && u.code === 'ECONNREFUSED');

// The 502 a failed upstream request answers: the origin, never a path, a
// query or a value. `sent`: the configure may have arrived.
function failureText(u, origin, { sent }) {
  if (u.failure === 'redirect') {
    return `the MCP server at ${origin} answered with a redirect${u.to ? ` to ${u.to}` : ''} — the studio server never follows redirects; configure the MCP endpoint's final URL`;
  }
  if (u.failure === 'oversize') return `the MCP server at ${origin} answered with a settings description larger than ${SETTINGS_LIMITS.descriptorBytes / 1024} KiB`;
  const maybe = sent ? ' — the server may have applied the settings: test the connection, or check the server\'s log' : '';
  if (u.failure === 'timeout') return `the MCP server at ${origin} did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} s${maybe}`;
  return `the studio server could not reach the MCP server at ${origin}${u.code ? ` (${u.code})` : ''}${maybe}`;
}

function safeOrigin(href) {
  try { return new URL(href).origin; } catch { return null; }
}

// Both routes' body shape, then the target and the rules a settings request
// meets beyond a fetch's. → { body, target, origin, root } or { status, json }.
function settingsTarget(req, { credential }) {
  const body = req.body;
  const refuse = (status, json) => ({ status, json: { ok: false, ...json } });
  if (!isPlainObject(body)) return refuse(400, { error: 'the request body must be a JSON object' });
  if (JSON.stringify(body).length > SETTINGS_LIMITS.bodyBytes) return refuse(400, { error: TOO_LARGE });
  if (own(body, 'mcpAuth')) return refuse(400, { error: NO_MCP_AUTH });
  const db = currentStore();
  const caller = mcpCallerOf(req);
  const pick = {};
  if (own(body, 'mcpEndpointId')) pick.mcpEndpointId = body.mcpEndpointId;
  if (own(body, 'mcpUrl')) pick.mcpUrl = body.mcpUrl;
  // forWrite: the endpoint's read token is never resolved, so it cannot ride.
  const target = resolveMcpTarget(db, pick, { forWrite: true, caller });
  if (target.status) return { status: target.status, json: mcpRefusalBody(target) };
  const url = new URL(target.mcpUrl);
  const origin = url.origin;
  const use = target.endpoint ? 'registered' : 'typed';
  // A submit carries a credential (what the admin typed): the allowlist's
  // credential rule, worded for a settings request.
  if (credential !== 'none' && mcpOriginDecision(db, target.mcpUrl, { use, credential, caller })) {
    return refuse(403, {
      denied: 'origin',
      error: `${origin} is not a listed MCP origin, and settings carry a credential, which goes only to a listed origin or this machine — the server's operator adds ${origin} to OBSERVOGRAM_MCP_ORIGINS (or the org's OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS)`,
    });
  }
  const loopback = isLoopbackOrigin(origin);
  if (!loopback && url.protocol !== 'https:') {
    return refuse(403, { denied: 'target', error: `${origin} is plain http, and settings carry a credential across the network — serve the MCP server over https, or run it on this machine` });
  }
  const ownPort = String(req.socket?.localPort ?? '');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const ownOrigin = req.headers.host ? safeOrigin(`${req.protocol}://${req.headers.host}`) : null;
  if ((loopback && port === ownPort) || ownOrigin === origin) {
    return refuse(403, { denied: 'target', error: `the MCP server shares the studio's origin (${origin}), so its settings would go to the studio server — give the MCP server its own origin (another port or host)` });
  }
  return { body, target, origin, root: settingsRoot(target.mcpUrl) };
}

// GET <root>/admin/schema upstream.
function readDescription(t) {
  return upstream(new URL(SETTINGS_DESCRIPTOR_PATH, t.root).href, {
    method: 'GET', headers: { Accept: 'application/json' }, cap: SETTINGS_LIMITS.descriptorBytes, refuseOver: true,
  });
}

const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

export function mcpSettingsRoutes({ authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  router.get('/api/mcp-settings', authorize('GET /api/mcp-settings'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(settingsPolicyAnswer());
  });

  router.post(DESCRIBE.slice(5), authorize(DESCRIBE), proxySwitch, settingsJson, async (req, res) => {
    noStore(res);
    try {
      const t = settingsTarget(req, { credential: 'none' });
      if (t.status) return res.status(t.status).json(t.json);
      const u = await readDescription(t);
      log('describe', u.failure ?? u.status, u.ms);
      if (u.failure) return res.status(502).json({ ok: false, error: redactTarget(failureText(u, t.origin, { sent: false }), t.target) });
      if (u.status !== 200) return res.json({ ok: true, status: u.status });
      const parsed = parseSettingsDescriptor(u.text, { mcpUrl: t.target.mcpUrl, contentType: u.contentType ?? null });
      if (parsed.descriptor) return res.json({ ok: true, status: u.status, descriptor: parsed.descriptor });
      if (parsed.notDescriptor) return res.json({ ok: true, status: u.status, notDescriptor: parsed.notDescriptor });
      return res.json({ ok: true, status: u.status, reason: parsed.reason });
    } catch (e) {
      return res.status(502).json(failed(e));
    }
  }, settingsBodyError);

  router.post(SUBMIT.slice(5), authorize(SUBMIT), proxySwitch, settingsJson, async (req, res) => {
    noStore(res);
    let secrets = [];
    let target = null;
    // Every text this route sends back once values arrived: the target's
    // secrets, then every submitted text of 4+ characters, in every form.
    const scrub = (text) => redactEchoes(redactTarget(text, target), secrets).text;
    try {
      const t = settingsTarget(req, { credential: 'request' });
      if (t.status) return res.status(t.status).json(t.json);
      target = t.target;
      const { body } = t;
      const bad = (error, extra = {}) => res.status(400).json({ ok: false, ...extra, error });
      const values = body.values ?? {};
      if (!isPlainObject(values)) return bad(VALUES);
      const clean = Object.create(null);
      for (const [k, v] of Object.entries(values)) {
        if (typeof v !== 'string' && typeof v !== 'boolean') return bad(VALUES);
        clean[k] = v;
      }
      secrets = Object.values(clean).filter((v) => typeof v === 'string');
      const mode = body.mode;
      if (mode !== 'described' && mode !== 'generic') return bad('mode is described or generic');
      const acks = body.acks ?? [];
      if (!Array.isArray(acks) || !acks.every((n) => Number.isInteger(n) && n >= 0 && n < SETTINGS_LIMITS.policyRules)) {
        return bad('acks must be a list of settings-policy rule indexes');
      }
      const action = body.action ?? null;
      if (action !== null && typeof action !== 'string') return bad('action must be the name of an action the server declares');
      const policy = settingsPolicy();

      // The description the request is built from: the server's, read again
      // now — never the caller's —, or the generic form at the configured path.
      let descriptor;
      if (mode === 'described') {
        const u = await readDescription(t);
        log('describe', u.failure ?? u.status, u.ms);
        if (u.failure) return res.status(502).json({ ok: false, error: scrub(failureText(u, t.origin, { sent: false })) });
        const parsed = u.status === 200 ? parseSettingsDescriptor(u.text, { mcpUrl: target.mcpUrl, contentType: u.contentType ?? null }) : null;
        if (!parsed?.descriptor) {
          const why = !parsed ? `GET ${new URL(SETTINGS_DESCRIPTOR_PATH, t.root).pathname} answered ${u.status}`
            : parsed.notDescriptor ? `what it answered is not a settings description: ${parsed.notDescriptor}` : parsed.reason;
          return res.status(409).json({ ok: false, denied: 'descriptor', error: scrub(`the server's settings description does not read as one now (${why}) — close and reopen the server settings`) });
        }
        descriptor = parsed.descriptor;
      } else {
        const allowed = policy?.generic?.path ?? '/configure';
        const g = isPlainObject(body.generic) ? body.generic : {};
        const path = g.path ?? allowed;
        if (path !== allowed) {
          return bad(`the proxy sends a generic form only to ${allowed} — a downstream sets another in the settings policy's generic.path`, { denied: 'path' });
        }
        const d = genericDescriptor({ names: g.names ?? policy?.generic?.names ?? undefined, path, auth: g.auth ?? policy?.generic?.auth ?? 'body' });
        if (d.reason) return bad(scrub(`what the server expects: ${d.reason}`), { denied: 'generic' });
        descriptor = d;
      }

      const built = settingsRequest(descriptor, clean, { action });
      if (built.reason) return bad(scrub(built.reason));

      // The policy, against the description just read. An action sets no
      // value the modal checks, so only a rule that matches a field the
      // action sends applies to it.
      let findings = policyFindings(policy, descriptor, clean);
      if (action !== null) findings = findings.filter((f) => !f.unevaluated && built.sent.includes(f.field));
      const ticked = new Set(acks);
      const missing = findings.find((f) => f.ack && !ticked.has(f.rule));
      if (missing) {
        return res.status(409).json({ ok: false, denied: 'policy-ack', rule: missing.rule, error: `${missing.warn} — tick "${missing.ack}" in the server settings` });
      }
      const acknowledged = [...new Set(findings.filter((f) => f.ack).map((f) => f.rule))].sort((a, b) => a - b);

      const where = resolveSettingsPath(built.path, target.mcpUrl, mode === 'generic' ? { noun: 'the settings path', fix: 'the settings policy\'s generic.path sets it' } : {});
      if (where.reason) return bad(scrub(where.reason), { denied: 'path' });
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (built.headers.Authorization) headers.Authorization = built.headers.Authorization;
      const u = await upstream(where.url, { method: 'POST', headers, body: built.body, cap: SETTINGS_LIMITS.outcomeBytes });
      log(action === null ? 'submit' : `action:${action}`, u.failure ?? u.status, u.ms);
      const row = (status) => auditAfter(req, {
        action: 'live.mcp-settings', targetKind: 'live', targetId: t.origin,
        detail: {
          op: action === null ? 'configure' : `action:${action}`, path: new URL(where.url).pathname,
          endpointId: target.endpoint?.id ?? null, typed: target.endpoint === null, status, fields: built.sent, acks: acknowledged,
        },
      }, { tag: 'mcp-settings' });
      if (u.failure) {
        const sent = mayHaveArrived(u);
        const auditError = sent ? row(null) : null;
        return res.status(502).json({ ok: false, error: scrub(failureText(u, t.origin, { sent })), ...(auditError ? { auditError } : {}) });
      }
      const o = outcomeOf({ status: u.status, contentType: u.contentType, text: u.text, truncated: u.truncated },
        { secretValues: built.secretValues, secretNames: built.secretNames, user: built.user });
      const auditError = row(u.status);
      return res.json({
        ok: true, status: u.status, contentType: mediaType(u.contentType), bytes: u.bytes,
        outcome: o.shape, redacted: o.redacted, ...(auditError ? { auditError } : {}),
      });
    } catch (e) {
      return res.status(502).json(failed(e));
    }
  }, settingsBodyError);

  return router;
}
