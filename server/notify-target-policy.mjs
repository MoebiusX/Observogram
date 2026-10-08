// server/notify-target-policy.mjs — which variables a server-run journey's
// notification may read, and where it may post (the follow-up
// journey-notify-env-ownership). The twin of server/mcp-target-policy.mjs;
// SQL-free: the orgs and the variable owners come from server/store/*.
//
// The hook rule. A journey run by the server in org <org> reads at most two
// variables for its notification: the org's hook URL
// OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL and, when the journey names it,
// that same hook's token OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_TOKEN — <HOOK>
// words of A–Z and 0–9 joined by single _, the whole name at most 200
// characters, upper case exactly (process.env reads case-insensitively on
// Windows, so a mixed-case spelling never passes). The org must be the SOLE
// owner of the URL name by the longest-prefix rule of
// server/store/mcp-endpoints.mjs (every org row counts, removed ones too): a
// name another org's id also maps onto — a KEY tie (a-b, a_b), or an org
// whose id extends this one's (acme-notify-eu owns
// OBSERVOGRAM_ORG_ACME_NOTIFY_EU_*) — is refused for everyone (SHADOW), and
// the text names neither org. The rule allows by shape and ownership and
// denies everything else: the server's own secrets, another org's variables,
// anything outside OBSERVOGRAM_ORG_, the org's MCP token.
//
// Names are judged before anything is read (notifyNamesRefusal reads no env):
// a refused name gets the same sentence whether its variable is set or not,
// so no caller learns which variables exist. Only then are the two hook
// variables read and their values checked: an http(s) URL without
// user:password of at most 2000 characters, a token of printable ASCII
// without spaces once its surrounding HTTP whitespace is trimmed (what undici
// trims before it sends), and the notify origin allowlist.
//
// The notify origin allowlist (N2 (a), fail closed): OBSERVOGRAM_NOTIFY_ORIGINS
// (every org; TOMOGRAPH_ honoured) ∪ OBSERVOGRAM_ORG_<KEY>_NOTIFY_ORIGINS (one
// org: read only when that org is the name's sole owner), read per call.
// Loopback passes; with a list set the URL's origin must be in it (or the
// list holds `*`; a list without an accepted entry allows nothing); with no
// list, nothing but loopback. A separate list from the MCP one: an MCP origin
// is a host the server sends an MCP read token to, a webhook origin a data
// sink, and listing one never opens the other. A refusal makes no lookup.
//
// No part of a hook's value leaves this module but in resolveJourneyNotify's
// answer, which the run route hands to the engine and nothing else: the texts,
// the listing and the boot report name VARIABLES, never a value and never an
// origin (for a capability-host webhook the host is the credential), and the
// once-per-process stderr note about an origin list names an entry's position
// only, never the entry.

import { brandEnvFrom } from '../tools/lib/brand-env.mjs';
import { isLoopbackOrigin, parseOriginList } from '../tools/lib/mcp-url-safety.mjs';
import { authzDecision } from './authz.mjs';
import { envNameOwnedBy, orgEnvPrefix } from './store/mcp-endpoints.mjs';
import { listOrgs } from './store/orgs.mjs';

export const NOTIFY_ORIGINS_VAR = 'OBSERVOGRAM_NOTIFY_ORIGINS';        // TOMOGRAPH_ honoured (brandEnvFrom)
export const ORG_NOTIFY_ORIGINS_NAME = 'NOTIFY_ORIGINS';               // OBSERVOGRAM_ORG_<KEY>_NOTIFY_ORIGINS
export const HOOK_RE = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
export const NOTIFY_HOOKS_ROUTE = 'GET /api/journeys/notify-hooks';    // named by the texts
export const orgNotifyOriginsVar = (org) => `${orgEnvPrefix(org)}${ORG_NOTIFY_ORIGINS_NAME}`;
export const hookVarsOf = (org, hook) => ({ urlEnv: `${orgEnvPrefix(org)}NOTIFY_${hook}_URL`, tokenEnv: `${orgEnvPrefix(org)}NOTIFY_${hook}_TOKEN` });

// The row text rule (server/store/rows.mjs): a hook variable's whole name.
const NAME_MAX = 200;
// The store's URL bound (requireUrl in server/store/mcp-endpoints.mjs).
const URL_MAX = 2000;
// A bearer token the server can send: printable ASCII without spaces.
const TOKEN_RE = /^[\x21-\x7E]{1,4096}$/;
// Every name of some org's hook URL shape (the boot report's third line).
const ANY_HOOK_URL_RE = /^OBSERVOGRAM_ORG_[A-Z0-9_]+_NOTIFY_[A-Z0-9_]+_URL$/;

const q = (v) => JSON.stringify(v);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOOK_SRC = HOOK_RE.source.slice(1, -1);   // the words, unanchored
// What undici trims from a header value before it sends it: space, tab, CR, LF.
const trimHttp = (v) => String(v).replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');

// The hook <HOOK> of org's URL (suffix 'URL') or token (suffix 'TOKEN') name,
// by shape only — exact case, at most NAME_MAX characters; null otherwise.
function hookOfShape(name, org, suffix = 'URL') {
  if (typeof name !== 'string' || name.length > NAME_MAX) return null;
  const m = new RegExp(`^${escapeRe(orgEnvPrefix(org))}NOTIFY_(${HOOK_SRC})_${suffix}$`).exec(name);
  return m ? m[1] : null;
}

const soleOwner = (db, name, org) => {
  const owners = envNameOwnedBy(db, name);
  return owners.length === 1 && owners[0] === org;
};

// ---------- names (no env read) ----------

// What `name` is to `org` as a notify.urlEnv: { kind: 'hook', hook, urlEnv,
// tokenEnv } when it has the org's hook URL shape and the org is its sole
// owner; { kind: 'shadow' } when it has the shape but another org's id also
// maps onto it (or only another's does); { kind: 'name' } otherwise. Reads no
// environment.
export function notifyHookOf(db, name, org) {
  const hook = hookOfShape(name, org);
  if (hook === null) return { kind: 'name' };
  const owners = envNameOwnedBy(db, name);
  if (!owners.length) return { kind: 'name' };
  if (owners.length !== 1 || owners[0] !== org) return { kind: 'shadow' };
  return { kind: 'hook', hook, ...hookVarsOf(org, hook) };
}

// Does `name` have the URL or TOKEN shape of SOME org's hook, live or
// removed, whoever owns it by the general rule? (An MCP endpoint's
// readTokenEnv never names one: a hook's variables go only to its webhook.)
export function isOrgHookShaped(db, name) {
  if (typeof name !== 'string') return false;
  return listOrgs(db, { includeRemoved: true })
    .some((o) => hookOfShape(name, o.id, 'URL') !== null || hookOfShape(name, o.id, 'TOKEN') !== null);
}

const journeyFile = (journey) => `journeys/${journey}.journey.yaml`;
const runPrefix = (journey) => `journey ${journey} is not run: `;

// The NAME / SHADOW / PAIR refusal of a notify block's names for `org`, at
// 'capture' or 'run' (the run text names the journey file) — null when the
// names pass. Reads no environment (non-negotiable 2): a refused name gets
// the same sentence whether its variable is set or not.
export function notifyNamesRefusal(db, notify, { org, at, journey }) {
  if (at !== 'capture' && at !== 'run') throw new TypeError(`notifyNamesRefusal: at is capture or run, not ${q(at)}`);
  const urlEnv = notify?.urlEnv;
  const authEnv = notify?.authEnv;
  const P = orgEnvPrefix(org);
  const L = NOTIFY_HOOKS_ROUTE;
  const J = journeyFile(journey);
  const h = notifyHookOf(db, urlEnv, org);
  if (h.kind === 'name') {
    return at === 'capture'
      ? `notify.urlEnv ${q(urlEnv)} is not a notify hook of org '${org}' — the server posts a journey's notification only to ${P}NOTIFY_<HOOK>_URL (<HOOK>: words of A–Z and 0–9 joined by single _), with its token, if any, from ${P}NOTIFY_<HOOK>_TOKEN: name one that ${L} lists`
      : `${runPrefix(journey)}its notify.urlEnv ${q(urlEnv)} is not a notify hook of org '${org}' — the server posts only to ${P}NOTIFY_<HOOK>_URL (<HOOK>: words of A–Z and 0–9 joined by single _), with its token, if any, from ${P}NOTIFY_<HOOK>_TOKEN; whoever holds the workspace sets notify.urlEnv in ${J} to one that ${L} lists (packc journey run reads any name from its own environment)`;
  }
  if (h.kind === 'shadow') {
    return at === 'capture'
      ? `notify.urlEnv ${q(urlEnv)} has the shape of a notify hook of org '${org}', but another org's id also maps onto it by the longest-prefix rule, so it is not this org's — name one that ${L} lists`
      : `${runPrefix(journey)}its notify.urlEnv ${q(urlEnv)} has the shape of a notify hook of org '${org}', but another org's id also maps onto it by the longest-prefix rule — whoever holds the workspace sets notify.urlEnv in ${J} to one that ${L} lists`;
  }
  if (authEnv !== undefined && authEnv !== null && authEnv !== h.tokenEnv) {
    return at === 'capture'
      ? `notify.authEnv ${q(authEnv)} is not the token of the hook notify.urlEnv names — a hook's token goes only to its own URL: name ${h.tokenEnv}, or leave authEnv out`
      : `${runPrefix(journey)}its notify.authEnv ${q(authEnv)} is not the token of the hook its urlEnv names — a hook's token goes only to its own URL: whoever holds the workspace sets notify.authEnv in ${J} to ${h.tokenEnv}, or removes it`;
  }
  return null;
}

// ---------- the notify origin allowlist ----------

const noted = new Set();
function noteOnce(line) {
  if (noted.has(line)) return;
  noted.add(line);
  process.stderr.write(`[notify-origins] ${line}\n`);
}

// Why an origin-list entry is not an origin — by its position only: a pasted
// webhook URL carries its secret path, and a capability host is a secret too.
function rejectedNote(name, entry, position) {
  let url = null;
  try { url = new URL(entry); } catch { /* not a URL at all */ }
  if (url && (url.protocol === 'http:' || url.protocol === 'https:') && url.href !== `${url.origin}/`) {
    return `${name}: entry ${position} is a URL, not an origin — list only its scheme://host[:port]`;
  }
  return `${name}: entry ${position} is not an origin (http(s)://host[:port])`;
}

// The notify origin list that applies to `org`: { set: false } when neither
// variable is set (or both are empty); else { set: true, any, origins, from,
// names } — `from` the sources set ('deployment', 'org', in that order),
// `names` their variables. The org's variable counts only when the org is its
// sole owner. A set list without an accepted entry allows nothing. `*` and
// every rejected entry are said once per process on stderr, by position.
export function notifyOriginList(db, org, env = process.env) {
  const sources = [];
  const global = brandEnvFrom(env, 'NOTIFY_ORIGINS');   // OBSERVOGRAM_NOTIFY_ORIGINS (TOMOGRAPH_ honoured)
  if (global) sources.push({ from: 'deployment', name: NOTIFY_ORIGINS_VAR, value: global });
  if (org) {
    const name = orgNotifyOriginsVar(org);
    const value = String(env[name] ?? '').trim();
    if (value && soleOwner(db, name, org)) sources.push({ from: 'org', name, value });
  }
  if (!sources.length) return { set: false };
  const list = { set: true, any: false, origins: new Set(), from: [], names: [] };
  for (const s of sources) {
    list.from.push(s.from);
    list.names.push(s.name);
    const entries = s.value.split(',').map((e) => e.trim()).filter(Boolean);
    entries.forEach((entry, i) => {
      const parsed = parseOriginList(entry);
      if (parsed.any) { list.any = true; noteOnce(`every notify origin is allowed (${s.name}=*)`); }
      for (const o of parsed.origins) list.origins.add(o);
      if (parsed.rejected.length) noteOnce(rejectedNote(s.name, entry, i + 1));
    });
  }
  return list;
}

// ---------- values ----------

// Steps 2–5 for a hook whose names passed: the URL's value, the token's, and
// the origin — null, or the capture text (UNSET-URL, UNSET-TOKEN, BAD-URL,
// BAD-TOKEN, ORIGIN); at 'run' UNSET-URL and UNSET-TOKEN take the run's way
// out and every text the run's prefix. Never a value and never an origin.
// With `resolved`, the values that passed are written to it.
export function notifyValueRefusal(hookVars, { org, at = 'capture', journey, env = process.env, db, resolved = null }) {
  const { urlEnv, authEnv = null } = hookVars;
  const tokenEnv = `${urlEnv.slice(0, -'URL'.length)}TOKEN`;
  const L = NOTIFY_HOOKS_ROUTE;
  const J = journeyFile(journey);
  const run = at === 'run';
  const said = (text) => (run ? `${runPrefix(journey)}${text}` : text);
  // 2. the URL's variable
  const rawUrl = env[urlEnv];
  const url = rawUrl === undefined || rawUrl === null ? '' : String(rawUrl).trim();
  if (!url) {
    return run
      ? said(`its notify hook ${urlEnv} is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace sets notify.urlEnv in ${J} to one that ${L} lists`)
      : `notify.urlEnv ${urlEnv} is not set in the server's environment — name one that ${L} lists, or the server's operator sets it and restarts the server`;
  }
  // 3. the URL rule
  let parsed = null;
  try { parsed = new URL(url); } catch { /* BAD-URL below */ }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || url.length > URL_MAX) {
    return said(`${urlEnv} does not hold an http(s) URL without user:password — the server's operator corrects its value and restarts the server (the server sends only Authorization: Bearer from ${tokenEnv}; a webhook that needs Basic auth is not supported)`);
  }
  // 4. the token's variable, when named
  let auth = null;
  if (authEnv) {
    const rawAuth = env[authEnv];
    auth = rawAuth === undefined || rawAuth === null ? '' : trimHttp(rawAuth);
    if (!auth) {
      return run
        ? said(`its notify.authEnv ${authEnv} is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace removes notify.authEnv from ${J}`)
        : `notify.authEnv ${authEnv} is not set in the server's environment — leave authEnv out, or the server's operator sets it and restarts the server`;
    }
    if (!TOKEN_RE.test(auth)) {
      return said(`${authEnv} holds a value the server cannot send as a bearer token (printable ASCII without spaces, once surrounding whitespace is trimmed) — the server's operator corrects it and restarts the server`);
    }
  }
  // 5. the origin
  const origin = parsed.origin;
  if (!isLoopbackOrigin(origin)) {
    const list = notifyOriginList(db, org, env);
    if (!list.set) {
      return said(`the webhook in ${urlEnv} is not on this machine, and no notify origin is listed, so the server posts only to this machine — the server's operator lists that URL's origin (scheme://host[:port]) in ${NOTIFY_ORIGINS_VAR} or ${orgNotifyOriginsVar(org)}, comma-separated, and restarts the server`);
    }
    if (!list.any && !list.origins.has(origin)) {
      return said(`the webhook in ${urlEnv} is at an origin that is not in ${list.names.join(', nor in ')} — the server's operator adds that URL's origin (scheme://host[:port]) there and restarts the server`);
    }
  }
  if (resolved) Object.assign(resolved, { url, auth });
  return null;
}

// The run's notification, resolved before anything runs: the names (no env
// read), then the two hook variables' values and the origin. → { refused:
// null, url, auth, urlEnv } (auth the trimmed token, or null) | { refused:
// <the run text> }.
export function resolveJourneyNotify(db, notify, { org, journey, env = process.env }) {
  const names = notifyNamesRefusal(db, notify, { org, at: 'run', journey });
  if (names) return { refused: names };
  const resolved = {};
  const value = notifyValueRefusal({ urlEnv: notify.urlEnv, authEnv: notify.authEnv ?? null }, { org, at: 'run', journey, env, db, resolved });
  if (value) return { refused: value };
  return { refused: null, url: resolved.url, auth: resolved.auth, urlEnv: notify.urlEnv };
}

// Capture's check of a notify block: the same steps, the capture texts —
// an unset hook is refused (the listing names the hooks that are set).
// → null | text.
export function captureNotifyRefusal(db, notify, { org, env = process.env }) {
  const names = notifyNamesRefusal(db, notify, { org, at: 'capture', journey: null });
  if (names) return names;
  return notifyValueRefusal({ urlEnv: notify.urlEnv, authEnv: notify.authEnv ?? null }, { org, at: 'capture', env, db });
}

// ---------- the listing and the boot report ----------

const setValue = (env, name) => {
  const v = env[name];
  return v !== undefined && v !== null && String(v).trim() !== '';
};

// GET /api/journeys/notify-hooks: the org's hooks — every set variable of the
// org's hook URL shape the org solely owns (a shadowed name is left out, so
// no other org is revealed), sorted by hook; `tokenEnv` the hook's token
// variable when it is set, else null; `usable`/`problem` capture's value and
// origin checks. `none` says who sets one when there is none. Names only:
// never a value, an origin or a list entry.
export function notifyHooksOf(db, org, env = process.env) {
  const P = orgEnvPrefix(org);
  const hooks = [];
  for (const name of Object.keys(env)) {
    const hook = hookOfShape(name, org);
    if (hook === null || !setValue(env, name) || !soleOwner(db, name, org)) continue;
    const vars = hookVarsOf(org, hook);
    const token = env[vars.tokenEnv];
    const tokenEnv = token !== undefined && token !== null && trimHttp(token) !== '' ? vars.tokenEnv : null;
    const problem = notifyValueRefusal({ urlEnv: vars.urlEnv, authEnv: tokenEnv }, { org, at: 'capture', env, db });
    hooks.push({ hook, urlEnv: vars.urlEnv, tokenEnv, usable: problem === null, problem });
  }
  hooks.sort((a, b) => (a.hook < b.hook ? -1 : a.hook > b.hook ? 1 : 0));
  return {
    org,
    pattern: `${P}NOTIFY_<HOOK>_URL`,
    hooks,
    none: hooks.length ? null : `no notify hook is set for org '${org}' — the server's operator sets ${P}NOTIFY_<HOOK>_URL (and ${P}NOTIFY_<HOOK>_TOKEN when the webhook takes a bearer token) in the server's environment and restarts the server`,
  };
}

// The start's report to the server's operator (R4's "at registration" for a
// hook registered by setting env): every set hook a run would refuse, every
// set name of an org's hook shape another org's id also maps onto, and every
// set name of the general hook shape no live org owns. [] when no such
// variable is set. Lines name variables and org ids, never a value, an origin
// or a list entry.
export function notifyBootReport(db, env = process.env) {
  const live = listOrgs(db);
  const lines = [];
  for (const o of live) {
    for (const h of notifyHooksOf(db, o.id, env).hooks) {
      if (!h.usable) lines.push(`[notify-hooks] org '${o.id}': ${h.urlEnv} — ${h.problem}`);
    }
  }
  const liveIds = new Set(live.map((o) => o.id));
  for (const name of Object.keys(env).filter((n) => ANY_HOOK_URL_RE.test(n) && setValue(env, n)).sort()) {
    const owners = envNameOwnedBy(db, name);
    const shapedFor = live.filter((o) => hookOfShape(name, o.id) !== null).map((o) => o.id);
    for (const org of shapedFor) {
      if (owners.length === 1 && owners[0] === org) continue;
      const others = owners.filter((x) => x !== org);
      lines.push(`[notify-hooks] ${name} has the shape of org '${org}''s notify hook, but org '${others.join("', '")}' also maps onto it by the longest-prefix rule — no journey can use it`);
    }
    if (!shapedFor.length && !owners.some((x) => liveIds.has(x))) {
      lines.push(owners.length
        ? `[notify-hooks] ${name} is no org's notify hook (only a removed org's id maps onto it)`
        : `[notify-hooks] ${name} is no org's notify hook (no org's id maps onto it)`);
    }
  }
  return lines;
}

// ---------- the posture (N11 (a)) ----------

// Running a journey that notifies posts a server-held hook token: without
// sign-in it is answered only for a request sent straight to a loopback
// address, and never on an exposed bind — the live MCP API's rule, applied by
// the run route to a journey with `notify` only. The entry is
// authzDecision's, so the texts and their ways out are batch 3's.
const NOTIFY_RUN_ENTRY = Object.freeze({ class: 'operator', exposed: 'refuse', direct: true, closedAs: 'running a journey that notifies' });
// Every request of the open postures acts as the anonymous local caller (the
// auth gate stamps it); the run route's own guard already judged the class.
const OPEN_PRINCIPAL = Object.freeze({ kind: 'local', actor: 'local', role: 'admin', owner: true });

// caller: mcpCallerOf(req) (server/mcp-target-policy.mjs), with the bind's
// `host` when known. → null | { status: 403, denied: 'posture', error }.
export function notifyPostureRefusal(caller) {
  const posture = caller?.posture;
  if (posture !== 'open-loopback' && posture !== 'open-exposed') return null;
  const d = authzDecision(NOTIFY_RUN_ENTRY, {
    posture, principal: caller.principal ?? OPEN_PRINCIPAL, csrf: true, direct: caller.direct === true,
    org: caller.org ?? null, authOff: caller.authOff === true, host: caller.host ?? 'a non-loopback address', port: caller.port ?? null,
  });
  if (!d || d.body.denied !== 'posture') return null;
  return { status: 403, denied: 'posture', error: d.body.error };
}
