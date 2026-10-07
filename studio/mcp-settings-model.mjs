// studio/mcp-settings-model.mjs
//
// The pure models of the MCP panel's Server settings modal (rebadge batch 4,
// D1/D2): who may open it (settingsGateModel), whether the browser may send
// settings to the target at all (settingsTargetModel), what the descriptor
// read means (descriptorReadModel), the status line of each state, the
// inputs' attributes, what an action sends, what the settings policy's
// findings show and block (policyView), and what the modal says after the
// connection test (verifiedLine); and, when the studio server passes the
// settings through (OBSERVOGRAM_MCP_ADMIN_PROXY=1), what its describe and
// submit answered (proxyDescribeModel, proxyOutcomeModel). No DOM, no state, no fetch
// (docs/UI_CONVENTIONS.md §2): every input explicit — the URL rules of
// tools/lib/mcp-url-safety.mjs and the contract of
// tools/lib/mcp-server-settings.mjs are handed in (`safety`, `lib`), because
// the browser loads them from /lib only when the modal opens — so the same
// functions run headlessly under node:test (tools/test-mcp-settings-model.mjs).
//
// What the modal shows of a server (labels, reasons, the outcome) is data:
// the renderer (studio/mcp-settings-view.mjs) puts every string into the DOM
// as text, never as markup.

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const LOOPBACK_MAPPED = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

// Is this page served from this machine? (tools/lib/mcp-url-safety.mjs
// isLoopbackOrigin's rule, for the gate, which runs before /lib is loaded.)
// A file:// page has origin "null": not loopback.
export function pageIsLoopback(pageOrigin) {
  let host;
  try { host = new URL(String(pageOrigin)).hostname; } catch { return false; }
  return host === 'localhost' || LOOPBACK_V4.test(host) || host === '[::1]' || LOOPBACK_MAPPED.test(host);
}

function effectivePort(u) {
  let url;
  try { url = u instanceof URL ? u : new URL(String(u)); } catch { return null; }
  return url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : null);
}

const NO_SIGN_IN = 'this server has no sign-in: add the first user with npm run users -- add <login>, or configure OIDC';

// ---------- the gate (A.2.1) ----------

/**
 * Who may open the modal — the reader who may change an MCP endpoint
 * (GET /api/mcp-endpoints `policy.register.allowed`: a session admin or
 * owner, or the open posture's caller on a direct loopback request) — and
 * whether the panel has a target. → { enabled, reason }: `reason` (null when
 * enabled) is the sentence the aria-disabled button carries.
 *   access          state.access ({ posture, role, orgName })
 *   mcpTargetPolicy state.mcpTargetPolicy (null while unread)
 *   hasTarget       the panel's picker would send something
 *   missing         the panel's own "nothing to send" sentence
 *   pageOrigin      location.origin
 *   bundleOrigins   the static bundle's baked MCP origin list ({ listed,
 *                   origins }), null when none was baked, undefined unread
 */
export function settingsGateModel({ access = null, mcpTargetPolicy = null, hasTarget = false, missing = '', pageOrigin = '', bundleOrigins } = {}) {
  const posture = access?.posture ?? 'unknown';
  const org = access?.orgName || 'this organisation';
  const deny = (reason) => ({ enabled: false, reason });
  if (posture === 'static') {
    if (bundleOrigins === undefined) return deny('Checking what this bundle may send settings to…');
    if (!pageIsLoopback(pageOrigin) && !bundleOrigins) {
      return deny(`This bundle was built without an MCP origin list, so from ${pageOrigin} it can send settings to no MCP server — rebuild it with --mcp-origins <origin>, or serve it from this machine (http://127.0.0.1) to configure a loopback MCP server.`);
    }
  } else if (posture === 'token') {
    return deny(`Configuring the MCP server needs a signed-in admin — ${NO_SIGN_IN}.`);
  } else if (posture === 'identity' || posture === 'open') {
    if (mcpTargetPolicy === null) return deny('Checking whether you may configure the MCP server…');
    if (mcpTargetPolicy.failed) return deny('Could not check whether you may configure the MCP server — close and reopen the panel to try again.');
    if (mcpTargetPolicy.register?.allowed !== true) {
      if (posture === 'identity') {
        return deny(`Configuring the MCP server is endpoint configuration: it needs the admin role in org '${org}' (you are ${access?.role ?? 'not a member'}) — ask an admin of ${org}.`);
      }
      const why = mcpTargetPolicy.register?.why;
      return deny(why ? `Configuring the MCP server is endpoint configuration: ${why}.` : 'Configuring the MCP server is endpoint configuration, which is not open to you here.');
    }
  } else {
    return deny('Could not check whether you may configure the MCP server — close and reopen the panel to try again.');
  }
  if (!hasTarget) return deny(missing ? missing.charAt(0).toUpperCase() + missing.slice(1) + '.' : 'Choose an MCP endpoint first.');
  return { enabled: true, reason: null };
}

// ---------- the target rule (A.2.3) ----------

/**
 * May the browser send settings to the MCP server at `url`? Runs before any
 * request. → { ok: true, origin, descriptorUrl } | { ok: false, reason }.
 *   posture     'identity' | 'open' | 'static' (the way out depends on it)
 *   origins     the allowlist mirror: { listed, origins: [origin] | null }
 *               (null origins: any), or null for none
 *   pageOrigin  location.origin ("null" for a file:// page)
 *   proxyWayOut the same-machine refusal may name OBSERVOGRAM_MCP_ADMIN_PROXY
 *   proxy       the studio server passes the settings through
 *               (OBSERVOGRAM_MCP_ADMIN_PROXY=1): only rule 1 runs here — the
 *               server applies its own origin, https and own-address rules
 *   safety      { mcpUrlPolicy, isLoopbackOrigin, mayBeThisMachine }
 *   lib         { resolveSettingsPath, SETTINGS_DESCRIPTOR_PATH }
 */
export function settingsTargetModel({ url, posture = 'identity', origins = null, pageOrigin = '', proxyWayOut = false, proxy = false }, { safety, lib }) {
  const refuse = (reason) => ({ ok: false, reason });
  const policy = safety.mcpUrlPolicy(url);
  if (policy.error) return refuse(policy.error);
  let target;
  try { target = new URL(String(url).trim()); } catch { return refuse('the MCP URL is not a valid URL'); }
  const origin = target.origin;
  const describeAt = () => {
    const d = lib.resolveSettingsPath(lib.SETTINGS_DESCRIPTOR_PATH, target.href, { noun: "the server's settings description" });
    return d.reason ? refuse(d.reason) : { ok: true, origin, descriptorUrl: d.url };
  };
  if (proxy) return describeAt();
  // The studio's own origin, or another name for it: a loopback page and a
  // target that may be this machine on the page's port reach the studio
  // process (the server form compares ports for loopback the same way).
  if (origin === pageOrigin || (pageIsLoopback(pageOrigin) && safety.mayBeThisMachine(target.hostname) && effectivePort(target) === effectivePort(pageOrigin))) {
    return refuse(`the MCP server shares the studio's origin (${origin}), so its settings would go to the studio server — give the MCP server its own origin (another port or host)`);
  }
  const loopback = safety.isLoopbackOrigin(origin);
  if ((loopback || safety.mayBeThisMachine(target.hostname)) && !pageIsLoopback(pageOrigin)) {
    if (posture === 'static') {
      return refuse(`${origin} names a loopback address, and this bundle is served from ${pageOrigin}: the static bundle sends settings to a loopback MCP server only from a page served on that machine — serve the bundle over http://127.0.0.1 (not file://)`);
    }
    return refuse(`${origin} names the studio server's own machine, which your browser cannot reach as the same host — open the studio on that machine (http://127.0.0.1:<port>)${proxyWayOut ? ', or the studio\'s operator turns on OBSERVOGRAM_MCP_ADMIN_PROXY=1' : ''}`);
  }
  if (!loopback && target.protocol !== 'https:') {
    return refuse(`${origin} is plain http, and settings carry a credential across the network — serve the MCP server over https, or run it on this machine`);
  }
  const listed = origins && origins.listed !== false && (origins.origins === null || (Array.isArray(origins.origins) && origins.origins.includes(origin)));
  if (!loopback && !listed) {
    return refuse(posture === 'static'
      ? `${origin} is not a listed MCP origin, and settings carry a credential, which goes only to a listed origin or this machine — rebuild the bundle with --mcp-origins ${origin}`
      : `${origin} is not a listed MCP origin, and settings carry a credential, which goes only to a listed origin or this machine — the server's operator adds ${origin} to OBSERVOGRAM_MCP_ORIGINS (or the org's OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS)`);
  }
  return describeAt();
}

// ---------- the descriptor read (A.1.2–A.1.4, A.2.2) ----------

/**
 * What the descriptor read means. `read` is what studio/mcp-settings-api.mjs
 * readDescriptorDirect answered:
 *   { kind: 'answer', status, contentType, text }
 *   { kind: 'oversize', bytes }      a declared or read length over 16 KiB
 *   { kind: 'redirect' }             an opaqueredirect (never followed)
 *   { kind: 'unreachable' }          no answer the page may read
 * → { state: 'described', descriptor } | { state: 'generic', reason }
 *   | { state: 'refused', reason } | { state: 'unreachable', redirect }.
 */
export function descriptorReadModel(read, { mcpUrl, descriptorUrl }, { lib }) {
  if (!read || read.kind === 'unreachable') return { state: 'unreachable', redirect: false };
  if (read.kind === 'redirect') return { state: 'unreachable', redirect: true };
  if (read.kind === 'oversize') return { state: 'refused', reason: `the settings description is larger than 16 KiB${Number.isFinite(read.bytes) ? ` (${read.bytes} bytes)` : ''}` };
  let path = '/admin/schema';
  try { path = new URL(descriptorUrl).pathname; } catch { /* the default */ }
  const s = Number(read.status);
  if (s === 404 || s === 405 || s === 501) return { state: 'generic', reason: `GET ${path} answered ${s}` };
  if (s === 401 || s === 403) return { state: 'generic', reason: `it answered ${s} — a settings description must be readable without a key` };
  if (s !== 200) return { state: 'refused', reason: `GET ${path} answered HTTP ${s}, so the server's settings description could not be read` };
  const parsed = lib.parseSettingsDescriptor(read.text, { mcpUrl, contentType: read.contentType ?? null });
  if (parsed.descriptor) return { state: 'described', descriptor: parsed.descriptor };
  if (parsed.notDescriptor) return { state: 'generic', reason: `what it answered is not a settings description: ${parsed.notDescriptor}` };
  return { state: 'refused', reason: parsed.reason };
}

/**
 * What the pass-through's describe answered (POST /api/mcp-settings/describe,
 * OBSERVOGRAM_MCP_ADMIN_PROXY=1): { ok, status, descriptor | notDescriptor |
 * reason }, read by the same rules as the browser's own read — the
 * description is parsed again here (the path rule runs in the page too).
 * `error` is the studio server's refusal (an Error from requestJson: its
 * message `<status>: <text>`). → descriptorReadModel's states but
 * 'unreachable': a refusal is 'refused', in the studio server's words.
 */
export function proxyDescribeModel(answer, { mcpUrl, descriptorUrl, error = null }, { lib }) {
  if (error || !answer || answer.ok !== true) {
    return { state: 'refused', reason: `the studio server answered ${error?.message || 'nothing it could read'}` };
  }
  let path = '/admin/schema';
  try { path = new URL(descriptorUrl).pathname; } catch { /* the default */ }
  const s = Number(answer.status);
  if (s === 404 || s === 405 || s === 501) return { state: 'generic', reason: `GET ${path} answered ${s}` };
  if (s === 401 || s === 403) return { state: 'generic', reason: `it answered ${s} — a settings description must be readable without a key` };
  if (s !== 200) return { state: 'refused', reason: `GET ${path} answered HTTP ${s}, so the server's settings description could not be read` };
  if (answer.descriptor) {
    // The studio server sends the normalised form (absent keys as null): read again as written.
    const parsed = lib.parseSettingsDescriptor(JSON.stringify(answer.descriptor, (k, v) => (v === null ? undefined : v)), { mcpUrl, contentType: 'application/json' });
    if (parsed.descriptor) return { state: 'described', descriptor: parsed.descriptor };
    return { state: 'refused', reason: parsed.reason ?? `what it answered is not a settings description: ${parsed.notDescriptor}` };
  }
  if (answer.notDescriptor) return { state: 'generic', reason: `what it answered is not a settings description: ${answer.notDescriptor}` };
  return { state: 'refused', reason: answer.reason || 'the server\'s settings description could not be read' };
}

/**
 * The outcome of a configure the studio server passed through
 * (POST /api/mcp-settings/submit: { ok, status, contentType, bytes, outcome:
 * { ok?, message?, checks? } | null, redacted }) in outcomeOf's form: the
 * headline by the same table (the shape's `ok` the only source of
 * "verified"), the message and the checks; no body (`raw` null) — the
 * studio server passes none back, and `note` says so when the answer was
 * not in the outcome shape.
 */
export function proxyOutcomeModel(answer, { lib }) {
  const shape = answer?.outcome ?? null;
  const o = lib.outcomeOf({ status: answer?.status, contentType: shape ? 'application/json' : null, text: shape ? JSON.stringify(shape) : '' });
  const bytes = Number.isFinite(answer?.bytes) ? answer.bytes : 0;
  const note = shape ? null
    : `The server's answer was not in the outcome shape (${bytes} byte${bytes === 1 ? '' : 's'} of ${answer?.contentType || 'no stated type'}); the studio server does not pass other bodies through.`;
  return { ...o, raw: null, capped: null, redacted: Number.isFinite(answer?.redacted) ? answer.redacted : 0, note };
}

// ---------- the status line of each state (A.2.2) ----------

const UNKNOWN = 'The request was sent, but its answer could not be read (no CORS header on the answer, a network error, or no answer within 15 s). The server may have applied the settings — test the connection, or check the server\'s log.';
const UNKNOWN_PROXY = 'The studio server sent the settings, but no answer came back from the MCP server. The server may have applied the settings — test the connection, or check the server\'s log.';

/**
 * The status line: { text, kind } (kind '' | 'ok' | 'warn' | 'error').
 * `m` holds the modal's state and what it needs to word it:
 *   { state, descriptorUrl, reason, genericReason, redirect, pageOrigin,
 *     proxyWayOut, proxy, sendingTo, outcome: { headline, tone }, verified: { text, kind } }
 * `proxy`: the studio server passes the requests through.
 */
export function statusLine(m) {
  switch (m.state) {
    case 'reading': return { text: m.descriptorUrl ? `Reading the server's settings description from ${m.descriptorUrl}${m.proxy ? ' through the studio server' : ''}…` : 'Reading the server\'s settings description…', kind: '' };
    case 'described': return { text: 'The server describes its settings (version 1).', kind: '' };
    case 'generic': return { text: `This server publishes no settings description (${m.genericReason}). This is a generic form: check the field names and the path against the server's documentation.`, kind: 'warn' };
    case 'refused': return { text: sentence(m.reason), kind: 'error' };
    case 'unreachable':
      if (m.redirect) return { text: 'The server answered with a redirect, which the studio never follows — configure the MCP endpoint\'s final URL.', kind: 'error' };
      return {
        text: `Your browser could not read ${m.descriptorUrl}. The server may be down, or it does not answer this page's origin (${m.pageOrigin}) with CORS headers — its operator adds that origin to the MCP server's allowed origins (MCP_INTEGRATION "Server settings")${m.proxyWayOut ? ', or the studio\'s operator turns on OBSERVOGRAM_MCP_ADMIN_PROXY=1' : ''}.`,
        kind: 'error',
      };
    case 'target-refused': return { text: sentence(m.reason), kind: 'error' };
    case 'sending': return { text: `Sending to ${m.sendingTo}${m.proxy ? ' through the studio server' : ''}…`, kind: '' };
    case 'outcome': return { text: m.outcome.headline, kind: toneKind(m.outcome.tone) };
    case 'unknown': return { text: m.proxy ? UNKNOWN_PROXY : UNKNOWN, kind: 'warn' };
    case 'verifying': return { text: `${m.outcome ? `${m.outcome.headline} ` : ''}Testing the connection through the studio…`, kind: '' };
    case 'verified': return m.verified;
    default: return { text: '', kind: '' };
  }
}

const toneKind = (tone) => (tone === 'ok' ? 'ok' : tone === 'error' ? 'error' : tone === 'warn' ? 'warn' : '');
function sentence(s) {
  const t = String(s ?? '').trim();
  if (!t) return '';
  // A reason that starts with a URL keeps it as the operator types it.
  const up = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1);
  return /[.…?!]$/.test(up) ? up : `${up}.`;
}

// The lede under the title: where the values go — from the browser, or
// through the studio server when it says the pass-through is on.
export function ledeText(origin, { proxy = false } = {}) {
  const how = proxy
    ? `the studio server passes them through to ${origin} without keeping them (OBSERVOGRAM_MCP_ADMIN_PROXY)`
    : `your browser sends them directly to ${origin}`;
  return `These settings go to the MCP server itself — ${how}. The studio keeps none of them.`;
}

// ---------- the form ----------

const IGNORE = Object.freeze({ 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': '' });

/**
 * One field's input: { type, attrs } — `type` the input type (text, url,
 * password, checkbox), `attrs` every attribute the renderer sets. Never a
 * `name` (no form field a browser fills or submits), never a value; a
 * secret is a password input with autocomplete="new-password", which keeps
 * a login saved for the studio's origin out of it; every text-like input
 * carries the password managers' ignore attributes and maxlength 2048.
 */
export function fieldInputSpec(field) {
  if (field.type === 'boolean') return { type: 'checkbox', attrs: { 'data-field': field.name } };
  const type = field.type === 'secret' ? 'password' : field.type === 'url' ? 'url' : 'text';
  const attrs = {
    'data-field': field.name,
    maxlength: '2048',
    autocomplete: field.type === 'secret' ? 'new-password' : 'off',
    spellcheck: 'false',
    ...IGNORE,
  };
  if (field.required) attrs['aria-required'] = 'true';
  if (field.placeholder && field.type !== 'secret') attrs.placeholder = field.placeholder;
  return { type, attrs };
}

const listOf = (labels) => (labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`);

/**
 * The note beside a server action: what it sends, from settingsRequest's
 * `carries` ([{ label, empty }]).
 */
export function actionNote(carries) {
  const list = Array.isArray(carries) ? carries : [];
  if (!list.length) return 'Sends: only the action.';
  const full = list.filter((c) => !c.empty).map((c) => c.label);
  const empty = list.filter((c) => c.empty).map((c) => c.label);
  if (!empty.length) return `Sends: ${listOf(full)}.`;
  const are = empty.length === 1 ? 'is' : 'are';
  const it = empty.length === 1 ? 'it' : 'them';
  if (!full.length) return `Sends: nothing but the action — ${listOf(empty)} ${are} empty, so a server that needs ${it} will refuse; type ${it} above.`;
  return `Sends: ${listOf(full)}. ${listOf(empty)} ${are} empty, so a server that needs ${it} will refuse; type ${it} above.`;
}

// ---------- the settings policy in the modal (A.3.4) ----------

/**
 * What the modal shows of the policy's findings (tools/lib/
 * mcp-server-settings.mjs policyFindings: [{ rule, field, warn, ack,
 * unevaluated, note }]), one entry per rule in rule order — a `type` rule
 * that matches two fields warns once — and whether an acknowledgement still
 * blocks the send. `ticked` lists the rule indexes whose ack box is ticked
 * (read from the DOM: acks live nowhere else).
 * → { rules: [{ rule, warn, ack, notes }], block }: `block` (null when
 * none) names the first unticked ack and its rule's warning.
 */
export function policyView(findings, ticked = []) {
  const byRule = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    let r = byRule.get(f.rule);
    if (!r) { r = { rule: f.rule, warn: f.warn, ack: f.ack ?? null, notes: [] }; byRule.set(f.rule, r); }
    const note = f.note ? sentence(f.note) : '';
    if (note && !r.notes.includes(note)) r.notes.push(note);
  }
  const rules = [...byRule.values()].sort((a, b) => a.rule - b.rule);
  const done = new Set((ticked ?? []).map(Number));
  const open = rules.find((r) => r.ack && !done.has(r.rule));
  return { rules, block: open ? `Tick "${open.ack}" to send — ${open.warn}` : null };
}

/**
 * Why the primary may not send yet, or null: an unreadable (or unread)
 * settings policy, then a generic form whose expectations do not hold, then
 * an unticked policy acknowledgement (policyView's `block`), then a missing
 * required field (settingsRequest's reason).
 *   policyState  'none' | 'served' | 'failed' | 'loading'
 */
export function primaryBlock({ policyState = 'none', requestReason = null, genericReason = null, ackReason = null } = {}) {
  if (policyState === 'failed') return 'Could not read the settings policy, so its checks cannot run — close and reopen to try again.';
  if (policyState === 'loading') return 'Reading the settings policy…';
  if (genericReason) return sentence(`What the server expects: ${genericReason}`);
  if (ackReason) return ackReason;
  if (requestReason) return sentence(requestReason);
  return null;
}

/**
 * Why a server action may not send yet, or null — the pass-through's rule
 * (server/routes/mcp-settings.mjs) in the browser: an action that sends no
 * field sets no value the policy checks and is never blocked; one that sends
 * fields waits on a settings policy not read (or unreadable), then on the
 * unticked ack of a rule that matched a field it sends (an unevaluated
 * finding concerns the form, not the action).
 *   sent  the field names settingsRequest's `sent` lists for the action
 */
export function actionBlock({ policyState = 'none', findings = [], sent = [], ticked = [] } = {}) {
  const fields = Array.isArray(sent) ? sent : [];
  if (!fields.length) return null;
  if (policyState === 'failed' || policyState === 'loading') return primaryBlock({ policyState });
  const applies = (Array.isArray(findings) ? findings : []).filter((f) => !f.unevaluated && fields.includes(f.field));
  return policyView(applies, ticked).block;
}

// ---------- after the send (A.2.4) ----------

/**
 * The modal's line once the connection test ran after a configure: the
 * outcome's headline, then what the ping showed — from its read's outcome,
 * never from the verdict alone (a ping is "connected" when its read
 * failed). `ping` is { model (studio/live-model.mjs pingResultModel), answer }
 * or null (the panel had nothing to send, or the server refused the test);
 * `error` the refusal's text.
 * → { text, kind }.
 */
export function verifiedLine(headline, ping, { error = null, isStatic = false } = {}) {
  const head = headline ? `${headline} ` : '';
  if (isStatic) return { text: `${head}The connection test needs the studio server; the static bundle has none.`, kind: 'warn' };
  const model = ping?.model ?? null;
  if (!model) return { text: `${head}Connection test: ${error ? `could not run — ${error}` : 'could not run'}.`, kind: 'error' };
  const read = ping.answer?.read ?? null;
  if (model.verdict === 'connected' && read?.outcome === 'ok') {
    return { text: `${head}Connection test: connected, and the read ${read.tool} answered: ${read.detail ?? 'ok'}.`, kind: 'ok' };
  }
  if (model.verdict === 'connected' && read?.outcome === 'not-advertised') {
    return { text: `${head}Connection test: connected; this server offers no read the studio tests with.`, kind: '' };
  }
  if (model.verdict === 'connected') {
    // The ping passes no target-supplied text back (R2): the read is worded from its outcome.
    const tool = read?.tool ?? 'the read tool';
    const why = read?.error ? read.error
      : read?.backendAuthRefused ? `${tool}'s backend refused the MCP's own credentials`
        : read?.outcome === 'timeout' ? `${tool} did not answer in time`
          : `${tool} answered with an error`;
    return { text: `${head}Connection test: connected, but the read failed: ${why}.`, kind: 'warn' };
  }
  return { text: `${head}Connection test: ${model.status}.`, kind: 'error' };
}
