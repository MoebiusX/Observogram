// studio/settings-model.mjs
//
// The pure models of Settings (docs/STORE_PLAN.md §6 item 3, slice 6b) and of
// the MCP target the pickers send (an org's registered endpoint by id, or a
// typed URL). Every function takes its inputs explicitly — 6a's accessModel()
// (studio/services-model.mjs), the /auth/me body, the probe's answer, the
// GET /api/services rows (ServiceView), GET /api/mcp-endpoints
// (McpEndpointView), GET /api/org/members (already email-free: the loaders in
// studio/settings-api.mjs drop it), GET /api/audit — and returns plain data
// for the renderers and the controller (studio/app.mjs). No state reads, no
// fetches, no DOM: tools/test-settings-model.mjs exercises it under node:test
// (docs/UI_CONVENTIONS.md §2). Its one import is the tier vocabulary of
// services-model.mjs, itself import-free — one source for the tiers.
//
// The honesty rules the models carry: a control a rank or a posture cannot
// use is drawn disabled with a reason that names a way out working for the
// rank reading it; the server's refusal is shown as is (`<status>: <text>`);
// the MCP read token is a server environment variable's NAME, never a value;
// no member's email reaches a model.

import { TIERS, TIER_BY_PACK } from './services-model.mjs';

export const SETTINGS_SECTIONS = ['environments', 'endpoints', 'members', 'audit', 'users', 'orgs', 'join-role'];
// The sections this build draws (the nav lists only these — never a
// placeholder for one that is not built).
export const BUILT_SECTIONS = ['environments', 'endpoints', 'members', 'audit'];
// The record editors this build draws: a section whose editor is not built
// draws no primary and no row action, and no sentence names one.
export const BUILT_EDITORS = ['endpoint', 'environment', 'org-name', 'member-add', 'member'];

const SECTION_LABEL = {
  environments: 'Environments', endpoints: 'MCP endpoints', members: 'Members', audit: 'Audit',
  users: 'Users', orgs: 'Organisations', 'join-role': 'Join role',
};
const SECTION_GROUP = { environments: 'org', endpoints: 'org', members: 'org', audit: 'org', users: 'deployment', orgs: 'deployment', 'join-role': 'deployment' };
// What each section needs: everyone reads environments and endpoints; the
// members and the audit are an admin's; the deployment group an owner's.
const SECTION_NEEDS = { environments: null, endpoints: null, members: 'admin', audit: 'admin', users: 'own', orgs: 'own', 'join-role': 'own' };

const RANKS = { viewer: 0, operator: 1, admin: 2 };
const ORG_FALLBACK = 'this organisation';
const CLOSED_REASON = 'closed on this server without sign-in — the banner above names the way in';
// The token posture's reads that need a signed-in user (the members and the
// audit, design §3.3 "— (banner)"): `why.read`, which names no role that would
// not open them; 6a's write reason stays on every write (§3.4, B16). They
// point at the banner only when it holds the probe's 403 (`denied: 'role'`,
// the server's sentence naming the way in); a probe that failed otherwise (no
// answer, a 5xx) is a banner naming no way in, and before it answers there is
// no banner at all.
const TOKEN_READ_NEEDS = { admin: 'needs the admin role and a signed-in user', own: 'needs a signed-in owner' };
function tokenReadReasons(refusal) {
  const tail = !refusal ? '' : refusal.denied === 'role' ? ' — the banner above names the way in' : ' — the read above failed; reload this page to retry';
  return { admin: `${TOKEN_READ_NEEDS.admin}${tail}`, own: `${TOKEN_READ_NEEDS.own}${tail}` };
}
const OWN_REASON = "users, organisations and the join role belong to the deployment's owners — ask an owner";
const CREATE_ORG_REASON = 'a second organisation needs sign-in, and this server runs without it — start it with sign-in (npm run users -- add <login>, or OIDC) and sign in as an owner';
const OPEN_BANNER = 'This server runs without sign-in: you act as local, an owner, and every change here is audited as local.';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isArr = Array.isArray;

// The probe's answer as the controller hands it: null (not issued or not
// settled), { ok: true, body } (200), or the Error requestJson threw
// (`.message` is `<status>: <sentence>`, `.denied`, `.status`).
function probeRefusal(probe) {
  if (!probe || probe.ok === true) return null;
  const text = typeof probe.message === 'string' && probe.message ? probe.message : null;
  return text ? { text, denied: probe.denied ?? null, status: probe.status ?? null } : null;
}

// ---------- access: one model for every Settings control (design §4) ----------

// `access` is 6a's accessModel() ({ posture, role, rank, canWrite, reason,
// orgName }); `identity` the /auth/me body (null in the open and token
// postures); `probe` the answer of GET /api/org/members in the token and open
// postures (design §3.4) — and, in the static bundle, the frame's first read
// (its 501). For affordances only: the server decides every write.
export function settingsAccessModel({ access, identity = null, probe = null, chromeName = 'the studio' } = {}) {
  const posture = access?.posture ?? 'unknown';
  const role = access?.role ?? null;
  const rank = Object.hasOwn(RANKS, role) ? RANKS[role] : null;
  const org = access?.orgName ?? ORG_FALLBACK;
  const refusal = probeRefusal(probe);
  const owner = posture === 'identity' ? identity?.user?.owner === true : posture === 'open';
  const closed = posture === 'open' && refusal?.denied === 'posture' ? refusal.text : null;
  const none = { operate: false, admin: false, own: false, createOrg: false };

  if (posture === 'static') {
    const text = refusal?.text ?? `501: Settings needs the ${chromeName} server; this studio is a static bundle built without one.`;
    return { posture, role, owner: false, closed: null, can: none, why: { operate: text, admin: text, own: text, closed: null, createOrg: text }, banner: { kind: 'static', text } };
  }
  if (posture === 'token') {
    const reason = access?.reason ?? null;
    return {
      posture, role, owner: false, closed: null, can: none,
      why: { operate: reason, admin: reason, own: reason, closed: null, createOrg: reason, read: tokenReadReasons(refusal) },
      banner: refusal ? { kind: 'token', text: refusal.text } : null,
    };
  }
  const operate = access?.canWrite !== false;
  // An unknown rank (the org list failed and no identity said otherwise) is
  // left to the server, as 6a's accessModel does.
  const admin = (rank === null ? true : rank >= RANKS.admin) && !closed;
  const own = owner && !closed;
  const createOrg = own && posture === 'identity';
  const why = {
    operate: operate ? null : (access?.reason ?? null),
    admin: admin ? null : (closed ? CLOSED_REASON : `needs the admin role in ${org} — yours is ${role}; ask an admin of ${org}`),
    own: own ? null : (closed ? CLOSED_REASON : OWN_REASON),
    closed: closed ? CLOSED_REASON : null,
    createOrg: createOrg ? null : (closed ? CLOSED_REASON : posture === 'open' ? CREATE_ORG_REASON : OWN_REASON),
  };
  let banner = null;
  if (closed) banner = { kind: 'closed', text: closed };
  else if (posture === 'open' && probe?.ok === true) banner = { kind: 'open', text: OPEN_BANNER };
  return { posture, role, owner, closed, can: { operate, admin, own, createOrg }, why, banner };
}

// Why a section that needs `need` cannot be read: the posture's read reason
// where it has one (the token posture's), else the role's.
const readWhy = (access, need) => access.why?.read?.[need] ?? access.why?.[need] ?? null;

// Can this access read `section`? (environments and endpoints: everyone
// but the bundle; members and the audit: can.admin; the deployment: can.own).
function sectionReadable(access, id) {
  if (access.posture === 'static') return false;
  const need = SECTION_NEEDS[id];
  return need === null ? true : access.can[need] === true;
}

// The section the frame opens on: the one asked for when it is built and
// readable, else the first readable built one (null in the static bundle).
export function settingsSectionFor(access, wanted = null, builtSections = BUILT_SECTIONS) {
  const built = SETTINGS_SECTIONS.filter((id) => builtSections.includes(id));
  if (wanted && built.includes(wanted) && sectionReadable(access, wanted)) return wanted;
  return built.find((id) => sectionReadable(access, id)) ?? null;
}

// ---------- the frame (design §3.2) ----------

// `access` is settingsAccessModel(); `statusOf(id)` the section's status
// line ({ kind, text }) or null. The nav lists only `builtSections`.
export function buildSettingsFrameModel({ access, section = null, orgName = null, orgId = null, statusOf = null, builtSections = BUILT_SECTIONS } = {}) {
  const current = settingsSectionFor(access, section, builtSections);
  const where = orgName && orgId ? `${orgName} (${orgId})` : (orgName || orgId || null);
  const who = access.role ? `you are ${access.role}${access.owner ? ', an owner' : ''}` : null;
  const scope = ['Settings', where, who].filter(Boolean).join(' · ');
  const nav = access.posture === 'static' ? [] : SETTINGS_SECTIONS.filter((id) => builtSections.includes(id)).map((id) => {
    const enabled = sectionReadable(access, id);
    const need = SECTION_NEEDS[id];
    return { id, label: SECTION_LABEL[id], group: SECTION_GROUP[id], current: id === current, enabled, reason: enabled ? null : readWhy(access, need) };
  });
  return {
    title: 'Settings', scope, banner: access.banner, nav, section: current,
    status: current && typeof statusOf === 'function' ? (statusOf(current) ?? null) : null,
  };
}

// A section's heading and its one-line scope sentence; the status line
// while it is read.
export function settingsSectionHead(id, { orgName = null } = {}) {
  const org = orgName || ORG_FALLBACK;
  const title = SECTION_LABEL[id] ?? id;
  const scope = {
    environments: `Every environment of ${org}'s services — its tier, the MCP endpoint it is checked through, its bindings and links. Build registers a service; each opens on its own page.`,
    endpoints: `The MCP gateways registered in ${org}, and the environments checked through each. A read token stays on the server: a gateway names the variable that holds it, never its value.`,
    // The members' scope sentence is the section model's (it names the org's id, and an owner acting from outside).
  }[id] ?? null;
  return { title, scope, loading: `Reading ${title.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}…` };
}

// The cached Settings answers the access may still read (C-6): members and
// the org row need can.admin; the audit too, and a non-owner keeps only the
// rows of the active org; the deployment's answers need can.own. Returns a
// new object — forgetSettingsAbove's pure half.
export function settingsAboveRank(settings, access, { orgId = null } = {}) {
  if (!settings) return settings;
  const out = { ...settings };
  if (!access.can.admin) { out.members = null; out.org = null; out.audit = null; }
  if (out.audit && !access.owner) {
    const rows = isArr(out.audit.rows) ? out.audit.rows.filter((r) => r.orgId === orgId) : [];
    out.audit = { ...out.audit, rows };
  }
  if (!access.can.own) { out.users = null; out.orgs = null; out.joinRole = null; }
  return out;
}

// ---------- environments (design §5.1) ----------

const countOf = (obj) => (obj && typeof obj === 'object' ? Object.keys(obj).length : 0);
const endpointLabel = (ep) => `${ep.name} — ${ep.origin}`;

// `services` is GET /api/services (null when it failed — `error` is then the
// thrown `<status>: <sentence>`). Each environment carries its own
// mcpEndpoint summary, so the endpoint list is not needed here. `editable`
// says whether the environment editor is built: without it there is no
// primary (null), no row Edit, and the empty line names no control.
export function buildEnvironmentsSectionModel({ services, access, orgName = null, error = null, editable = true } = {}) {
  const org = orgName || ORG_FALLBACK;
  const can = access.can.operate === true;
  const primaryOf = (p) => (editable ? p : null);
  if (!isArr(services)) {
    const text = error || 'the services could not be read';
    return { groups: [], primary: primaryOf({ enabled: false, reason: text }), empty: null, error: text, build: false };
  }
  if (!services.length) {
    // Build is offered to a rank that may build; any other reader is told who
    // registers one (the 6a home's viewer wording) and gets no Build.
    const role = access.role ?? 'viewer';
    const text = can
      ? `No service in ${org} yet — Build registers one (its DEFINE names the service).`
      : `No service in ${org} yet — an operator registers one with Build (its DEFINE names the service); your role in ${org} is ${role}.`;
    return { groups: [], primary: primaryOf({ enabled: false, reason: text }), empty: text, error: null, build: can };
  }
  const groups = services.map((s) => ({
    serviceId: s.id, name: s.name, slug: s.slug,
    envs: (isArr(s.environments) ? s.environments : []).map((e) => ({
      id: e.id, name: e.name,
      tierText: e.effectiveTier ?? TIER_BY_PACK,
      mcpText: e.mcpEndpoint ? endpointLabel(e.mcpEndpoint) : 'none',
      bindingsCount: countOf(e.bindings), linksCount: countOf(e.endpoints),
      canEdit: can && editable,
    })),
  }));
  const anyEnv = groups.some((g) => g.envs.length);
  const empty = anyEnv ? null : `No environments in ${org} yet.${can && editable ? ' Add environment registers one.' : ''}`;
  return { groups, primary: primaryOf({ enabled: can, reason: can ? null : access.why.operate }), empty, error: null, build: false };
}

// ---------- MCP endpoints (design §5.3) ----------

// The environments bound to endpoint `id`, named `<service slug> / <env>`
// from the services table; null when the table is unavailable.
function boundNames(id, services) {
  if (!isArr(services)) return null;
  const names = [];
  for (const s of services) {
    for (const e of isArr(s.environments) ? s.environments : []) {
      if (e.mcpEndpoint && e.mcpEndpoint.id === id) names.push(`${s.slug} / ${e.name}`);
    }
  }
  return names;
}

// An environment id resolved through the services table: `<slug> / <env>`,
// or `environment <id>` when it does not resolve.
function environmentName(id, services) {
  for (const s of isArr(services) ? services : []) {
    const e = (isArr(s.environments) ? s.environments : []).find((x) => x.id === id);
    if (e) return `${s.slug} / ${e.name}`;
  }
  return `environment ${id}`;
}

const rankOfAccess = (access) => (Object.hasOwn(RANKS, access.role) ? RANKS[access.role] : -1);

// `editable` as for the environments: without the endpoint editor no
// primary, and the empty line names no control.
export function buildEndpointsSectionModel({ endpoints, services = null, access, orgName = null, error = null, editable = true } = {}) {
  const org = orgName || ORG_FALLBACK;
  const admin = access.can.admin === true;
  const primary = editable ? { enabled: admin, reason: admin ? null : access.why.admin } : null;
  if (!isArr(endpoints)) {
    const text = error || 'the MCP endpoints could not be read';
    return { rows: [], primary, empty: null, error: text };
  }
  // The URL and the variable's name only for operators and above — the
  // server nulls them for a viewer; the model does not read them either.
  const full = rankOfAccess(access) >= RANKS.operator;
  const rows = endpoints.map((ep) => {
    const n = Number.isInteger(ep.environments) ? ep.environments : 0;
    const names = boundNames(ep.id, services);
    const counted = `checked by ${plural(n, 'environment')}`;
    const boundText = names && names.length === n && n > 0 ? `${counted}: ${names.join(', ')}` : counted;
    return {
      id: ep.id, name: ep.name, origin: ep.origin,
      url: full ? (ep.url ?? null) : null,
      tokenText: full ? (ep.readTokenEnv ? `token: ${ep.readTokenEnv}` : 'token: none (requests send their own)') : null,
      boundText,
      // Edit… on the row: an admin's (the editor's writes are admin class);
      // not drawn for another rank — the row already shows every fact.
      canEdit: admin && editable,
    };
  });
  const how = editable ? ` ${admin ? 'New MCP endpoint registers one.' : 'An admin registers them.'}` : '';
  const empty = rows.length ? null : `No MCP endpoints in ${org} yet.${how}`;
  return { rows, primary, empty, error: null };
}

// 'OBSERVOGRAM_ORG_<KEY>_' — server/store/mcp-endpoints.mjs orgEnvPrefix, mirrored.
export function orgEnvPrefix(orgId) {
  return `OBSERVOGRAM_ORG_${String(orgId).toUpperCase().replaceAll('-', '_')}_`;
}

// ---------- members (design §5.4) ----------

// The member is the org's only enabled admin and the caller is not an
// owner (an owner passes the server's rule).
export function lastAdmin(member, members, { owner = false } = {}) {
  if (owner || !member || member.role !== 'admin' || member.disabled) return false;
  const enabledAdmins = (isArr(members) ? members : []).filter((m) => m.role === 'admin' && !m.disabled);
  return enabledAdmins.length === 1 && enabledAdmins[0].userId === member.userId;
}

const lastAdminText = (login, org) => `${login} is the last admin of ${org}: only an owner can demote or remove them — make another member an admin first`;

// What the confirm step says when the row is the caller's own (C-2).
function selfNotes(org, owner) {
  if (owner) {
    const t = `This is you: your membership changes, but as an owner you keep the admin role in ${org}.`;
    return { demote: t, remove: t };
  }
  return { demote: 'This is you: you lose the admin role at once.', remove: `This is you: you lose access to ${org} at once.` };
}

// The status after removing oneself from the org on screen: the page
// reloads with no active org — a member lands in their next organisation; an
// owner, whose requests are never refused, in their first membership or the
// default org (server/authz.mjs orgContext).
export function leftOrgText(orgName, owner = false) {
  return owner
    ? `You left ${orgName}; this browser reloads into your first organisation, or the default one.`
    : `You left ${orgName}; this browser switches to your next organisation.`;
}

// `members` already email-free; `org` the GET /api/org/members `org`; `me`
// the caller's login (/auth/me has no user id — "you" is by login).
export function buildMembersSectionModel({ members, org = null, access, me = null, acting = false, error = null } = {}) {
  const orgName = org?.name || access.orgName || ORG_FALLBACK;
  const orgId = org?.id ?? null;
  const admin = access.can.admin === true;
  const owner = access.owner === true;
  const orgRow = { id: orgId, name: orgName, canRename: admin, renameReason: admin ? null : access.why.admin };
  const where = orgId ? `${orgName} (${orgId})` : orgName;
  const scopeSentence = acting
    ? `The members of ${where} — you are an owner acting in ${orgId ?? orgName} — not a member.`
    : `The members of ${where} and their roles.`;
  const primary = { enabled: admin, reason: admin ? null : access.why.admin };
  if (!isArr(members)) return { org: orgRow, scopeSentence, rows: [], primary, empty: null, error: error || 'the members could not be read' };
  const rows = members.map((m) => {
    const isLast = lastAdmin(m, members, { owner });
    const wouldBeLast = owner && lastAdmin(m, members, { owner: false });
    const you = Boolean(me) && m.login === me;
    const base = admin ? null : access.why.admin;
    const lockText = isLast ? lastAdminText(m.login, orgName) : null;
    return {
      userId: m.userId, login: m.login, name: m.name ?? null, role: m.role, disabled: m.disabled === true, since: m.since ?? null,
      you, lastAdmin: isLast,
      ownerLastAdminNote: wouldBeLast ? `${m.login} is ${orgName}'s last admin: afterwards only an owner can manage its members, endpoints and audit.` : null,
      selfNote: you ? selfNotes(orgName, owner) : null,
      canEdit: admin,
      reasons: {
        remove: base ?? lockText,
        roles: { viewer: base ?? lockText, operator: base ?? lockText, admin: base },
      },
    };
  });
  return { org: orgRow, scopeSentence, rows, primary, empty: rows.length ? null : `No members in ${orgName}.`, error: null };
}

// ---------- the audit (design §5.5) ----------

// The kinds the server writes today (a text input's datalist: a kind added
// later is still reachable; the server's KIND check is the authority).
export const AUDIT_KINDS = ['deploy', 'environment', 'issuer', 'journey', 'live', 'mcp_endpoint', 'membership', 'meta', 'org', 'owner', 'pack', 'service', 'store', 'user', 'verdict', 'waiver'];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// 'YYYY-MM-DD' → the next UTC day; anything else is sent as typed (the
// server's refusal names the shape).
function nextUtcDay(text) {
  const m = DAY.exec(text);
  if (!m) return text;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return Number.isNaN(d.getTime()) ? text : d.toISOString().slice(0, 10);
}

// '?…' with only the filled parameters. `until` is exclusive on the server
// (at midnight UTC), so "through" a day sends the day after (A7); `scope`
// only for an owner (the server refuses an admin any other than org).
export function auditQuery(filters = {}, { owner = false, before = null, limit = 100 } = {}) {
  const f = filters || {};
  const val = (k) => (typeof f[k] === 'string' ? f[k].trim() : (f[k] == null ? '' : String(f[k]).trim()));
  const pairs = [];
  if (owner && val('scope')) pairs.push(['scope', val('scope')]);
  for (const k of ['actor', 'kind', 'action', 'targetKind', 'targetId']) if (val(k)) pairs.push([k, val(k)]);
  if (val('from')) pairs.push(['since', val('from')]);
  if (val('through')) pairs.push(['until', nextUtcDay(val('through'))]);
  pairs.push(['limit', String(limit)]);
  if (before !== null && before !== undefined && before !== '') pairs.push(['before', String(before)]);
  return `?${pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

// `doc` the last page's body (null before the first), `rows` the
// accumulated rows (newest first). `formatTime(iso)` the controller's local
// time (the model stays clock- and locale-free by default).
export function buildAuditSectionModel({ doc = null, rows = [], filters = {}, access, orgId = null, formatTime = (iso) => iso, error = null } = {}) {
  const owner = access.owner === true;
  const list = isArr(rows) ? rows : [];
  const scope = doc?.scope ?? (owner ? (filters?.scope || 'all') : 'org');
  const showOrg = scope === 'all' || scope === 'deployment';
  const caption = doc ? `${plural(list.length, 'row')}, newest first · scope ${scope}${doc.org ? ` · org ${doc.org}` : ''}` : null;
  const scopeControl = owner ? {
    options: [
      { value: 'all', label: 'all' },
      { value: 'org', label: `this org (${orgId ?? ORG_FALLBACK})` },
      { value: 'deployment', label: "the deployment's own rows" },
    ],
    value: filters?.scope || 'all',
  } : null;
  const scopeSentence = owner ? null : `This org's rows (${orgId ?? ORG_FALLBACK}) — the deployment's are an owner's.`;
  const out = list.map((r) => ({
    seq: r.seq, iso: r.at, when: formatTime(r.at),
    org: showOrg ? (r.orgId ?? null) : null,
    actor: r.actor, action: r.action,
    target: [r.targetKind, r.targetId].filter((x) => x !== null && x !== undefined && x !== '').join(' '),
    detailJson: JSON.stringify(r.detail ?? null, null, 2),
  }));
  const more = Boolean(doc) && doc.next !== null && doc.next !== undefined;
  const end = doc && (doc.next === null || doc.next === undefined) ? 'No older rows.' : null;
  return {
    canRead: access.can.admin === true, reason: access.can.admin ? null : readWhy(access, 'admin'),
    caption, showOrg, scopeControl, scopeSentence, kinds: AUDIT_KINDS, rows: out, more, end, error,
    // A filter the server refused (400) is answered by changing the filters, not by Retry.
    retry: error ? !/^400:/.test(String(error)) : null,
  };
}

// ---------- the editors (design §5) ----------

// 'k=v' per line → { k: 'v' }; blank lines skipped; the first '=' splits; a
// line without '=' is kept as { line: '' } so the server's refusal says
// what is wrong (the studio refuses nothing the server would accept).
export function parseKeyValueLines(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    if (at === -1) { out[line] = ''; continue; }
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

const linesOf = (obj) => Object.entries(obj && typeof obj === 'object' ? obj : {}).map(([k, v]) => `${k}=${v}`).join('\n');
const canon = (obj) => JSON.stringify(Object.keys(obj).sort().map((k) => [k, obj[k]]));
const asObject = (v) => (typeof v === 'string' ? parseKeyValueLines(v) : (v && typeof v === 'object' ? { ...v } : {}));
const asId = (v) => {
  if (v === null || v === '' || v === 'none') return null;
  const n = typeof v === 'string' && /^[1-9][0-9]{0,15}$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 ? n : null;
};
const asTier = (v) => (TIERS.includes(v) ? v : null);

// The PATCH body for an environment: only the fields that differ, parsed —
// tier → one of TIERS or null; mcpEndpointId → a positive id or null (left
// out when the draft's is undefined: the list was not read, the binding is
// kept); bindings / endpoints sent whole (the server replaces them).
export function buildEnvironmentPatch(current, draft = {}) {
  const patch = {};
  if (typeof draft.name === 'string' && draft.name.trim() !== current.name) patch.name = draft.name.trim();
  if (draft.tier !== undefined) {
    const tier = asTier(draft.tier);
    if (tier !== (current.tier ?? null)) patch.tier = tier;
  }
  if (draft.mcpEndpointId !== undefined) {
    const id = asId(draft.mcpEndpointId);
    if (id !== (current.mcpEndpoint?.id ?? null)) patch.mcpEndpointId = id;
  }
  for (const k of ['bindings', 'endpoints']) {
    if (draft[k] === undefined) continue;
    const next = asObject(draft[k]);
    if (canon(next) !== canon(current[k] && typeof current[k] === 'object' ? current[k] : {})) patch[k] = next;
  }
  return patch;
}

// The POST body for a new environment: the name and only the non-empty fields.
export function buildEnvironmentCreate(draft = {}) {
  const body = { name: typeof draft.name === 'string' ? draft.name.trim() : '' };
  const tier = asTier(draft.tier);
  if (tier) body.tier = tier;
  const id = draft.mcpEndpointId === undefined ? null : asId(draft.mcpEndpointId);
  if (id !== null) body.mcpEndpointId = id;
  for (const k of ['bindings', 'endpoints']) {
    const next = asObject(draft[k]);
    if (Object.keys(next).length) body[k] = next;
  }
  return body;
}

// The PATCH body for an MCP endpoint: name, url, readTokenEnv ('' → null: cleared).
export function buildEndpointPatch(current, draft = {}) {
  const patch = {};
  if (typeof draft.name === 'string' && draft.name.trim() !== current.name) patch.name = draft.name.trim();
  if (typeof draft.url === 'string' && draft.url.trim() !== (current.url ?? '')) patch.url = draft.url.trim();
  if (draft.readTokenEnv !== undefined) {
    const v = typeof draft.readTokenEnv === 'string' && draft.readTokenEnv.trim() ? draft.readTokenEnv.trim() : null;
    if (v !== (current.readTokenEnv ?? null)) patch.readTokenEnv = v;
  }
  return patch;
}

// The POST body for a new endpoint: readTokenEnv omitted when empty.
export function buildEndpointCreate(draft = {}) {
  const body = { name: String(draft.name ?? '').trim(), url: String(draft.url ?? '').trim() };
  const v = String(draft.readTokenEnv ?? '').trim();
  if (v) body.readTokenEnv = v;
  return body;
}

// The POST /api/org/members body: by login or by verified email, and the role.
export function buildMemberAddBody(draft = {}) {
  const value = String(draft.value ?? '').trim();
  const body = draft.by === 'email' ? { email: value } : { login: value };
  if (draft.role) body.role = draft.role;
  return body;
}

const ENV_LABELS = { name: 'name', tier: 'tier', mcpEndpointId: 'MCP endpoint', bindings: 'bindings', endpoints: 'links' };
const ENDPOINT_LABELS = { name: 'name', url: 'URL', readTokenEnv: 'token variable' };
const savedText = (changed, labels) => (isArr(changed) && changed.length
  ? { kind: 'saved', text: `Saved: ${changed.map((f) => labels[f] ?? f).join(', ')}` }
  : { kind: 'idle', text: 'Nothing changed.' });

export function environmentSaveStatus(changed = []) { return savedText(changed, ENV_LABELS); }
export function endpointSaveStatus(changed = []) { return savedText(changed, ENDPOINT_LABELS); }

// POST /api/org/members answers 201 (added), 200 with changed { from, to },
// or 200 with changed null; PATCH answers { member, changed }.
export function memberSaveStatus(answer = {}, { login = null } = {}) {
  const who = answer?.member?.login ?? login ?? 'the member';
  const role = answer?.member?.role ?? null;
  if (answer?.added === true) return { kind: 'saved', text: `Added ${who} as ${role}.` };
  if (answer?.changed && answer.changed.from !== undefined) {
    const text = answer.added === false ? `${who} was already a member: ${answer.changed.from} → ${answer.changed.to}.` : `${who}: ${answer.changed.from} → ${answer.changed.to}.`;
    return { kind: 'saved', text };
  }
  if (answer?.added === false) return { kind: 'idle', text: `${who} is already a${role === 'admin' || role === 'operator' ? 'n' : ''} ${role} — nothing changed.` };
  return { kind: 'idle', text: 'Nothing changed.' };
}

// PATCH /api/org answers no `changed`: compare the names (A-16).
export function orgRenameStatus(before, after) {
  return before === after ? { kind: 'idle', text: 'Nothing changed.' } : { kind: 'saved', text: `Renamed: ${before} → ${after}.` };
}

// DELETE /api/mcp-endpoints/:id answers `unbound`: the ids of the
// environments it unbound (B2), named through the services table.
export function endpointDeleteStatus(name, unbound = [], services = null) {
  const ids = isArr(unbound) ? unbound : [];
  if (!ids.length) return { kind: 'saved', text: `Deleted ${name}.` };
  const names = ids.map((id) => environmentName(id, services));
  return { kind: 'saved', text: `Deleted ${name} — ${plural(ids.length, 'environment')} unbound: ${names.join(', ')}` };
}

const ROLES = ['viewer', 'operator', 'admin'];
const idleStatus = (text) => ({ kind: 'idle', text });

// The environment's MCP endpoint field (A4): the record's binding is always
// an option; `[]` → the empty help; null (the read failed) → disabled, the
// binding kept (the draft's mcpEndpointId stays undefined).
function mcpEndpointField(record, endpoints, value, { orgName, endpointsError }) {
  const current = record?.mcpEndpoint ?? null;
  const list = isArr(endpoints) ? endpoints : [];
  const options = [{ value: null, label: 'none' }, ...list.map((ep) => ({ value: ep.id, label: endpointLabel(ep) }))];
  if (current && !options.some((o) => o.value === current.id)) options.push({ value: current.id, label: endpointLabel(current) });
  const selected = value === undefined ? (current?.id ?? null) : value;
  const field = { name: 'mcpEndpointId', label: 'MCP endpoint', type: 'select', value: selected, options: options.map((o) => ({ ...o, selected: o.value === selected })), help: null, disabled: false, reason: null };
  if (!isArr(endpoints)) {
    field.disabled = true;
    field.reason = `The org's MCP endpoints could not be read${endpointsError ? ` — ${endpointsError}` : ''}; the binding is kept.`;
    field.help = field.reason;
  } else if (!endpoints.length) {
    field.help = `No MCP endpoint is registered in ${orgName} yet — an admin registers one in Settings → MCP endpoints.`;
  }
  return field;
}

// The editor's model by kind (6b-i: environment, endpoint, org-name,
// member-add, member). `record` is the row edited (null to create), `draft`
// what was typed (keys of `fields`), `status` the footer line, `step`
// 'edit' | 'confirm-delete' | 'confirm-action'. `ctx`: { access
// (settingsAccessModel), orgName, orgId, services, endpoints,
// endpointsError, serviceId, members, me }. The returned `draft` is the
// effective one (record values under what was typed): its mcpEndpointId is
// undefined when the endpoint list was not read.
export function buildSettingsEditorModel(kind, record = null, { draft = null, status = null, step = 'edit', ctx = {} } = {}) {
  const d = draft || {};
  const access = ctx.access;
  const orgName = ctx.orgName || access?.orgName || ORG_FALLBACK;
  const st = status || null;
  const saving = st?.kind === 'pending';
  const services = isArr(ctx.services) ? ctx.services : [];
  const base = { kind, id: record?.id ?? record?.userId ?? null, step, saving, confirm: null };
  const primaryOf = (label, can, reason) => ({ label, enabled: can && !saving, reason: !can ? reason : (saving ? 'Saving…' : null) });
  const str = (k, fallback) => (typeof d[k] === 'string' ? d[k] : fallback);

  if (kind === 'environment') {
    const can = access?.can?.operate === true;
    const serviceId = record ? record.serviceId : (d.serviceId !== undefined ? Number(d.serviceId) : (ctx.serviceId ?? services[0]?.id ?? null));
    const service = services.find((s) => s.id === serviceId) || null;
    const serviceName = service?.name ?? 'the service';
    const mcpValue = d.mcpEndpointId !== undefined ? asId(d.mcpEndpointId) : (isArr(ctx.endpoints) ? (record?.mcpEndpoint?.id ?? null) : undefined);
    const eff = {
      serviceId,
      name: str('name', record?.name ?? ''),
      tier: d.tier !== undefined ? asTier(d.tier) : (record?.tier ?? null),
      mcpEndpointId: isArr(ctx.endpoints) ? mcpValue : undefined,
      bindings: str('bindings', linesOf(record?.bindings)),
      endpoints: str('endpoints', linesOf(record?.endpoints)),
    };
    const fields = [];
    if (!record) fields.push({ name: 'serviceId', label: 'Service', type: 'select', value: serviceId, options: services.map((s) => ({ value: s.id, label: `${s.name} (${s.slug})`, selected: s.id === serviceId })) });
    fields.push(
      { name: 'name', label: 'Name', type: 'text', value: eff.name, max: 200 },
      { name: 'tier', label: 'Tier', type: 'segmented', value: eff.tier,
        options: [...TIERS.map((t) => ({ value: t, label: t, selected: eff.tier === t })), { value: null, label: 'graded by the service', selected: eff.tier === null }],
        help: `Graded by the service: ${serviceName}'s tier, ${service?.tier ?? TIER_BY_PACK}.` },
      mcpEndpointField(record, ctx.endpoints, eff.mcpEndpointId, { orgName, endpointsError: ctx.endpointsError }),
      { name: 'bindings', label: 'Bindings', type: 'textarea', value: eff.bindings, help: 'One key=value per line, at most 32.' },
      { name: 'endpoints', label: 'Links', type: 'textarea', value: eff.endpoints, help: 'One name=https://… per line, at most 20 — http(s) only; a token never goes in a URL.' },
    );
    const confirm = record && step === 'confirm-delete' ? {
      text: `Delete ${record.name} of ${serviceName}? Its tier, bindings, links and endpoint binding go; the packs stay registered, and a pack that declares ${record.name} brings the name back without them.`,
      danger: `Delete ${record.name}`,
    } : null;
    return {
      ...base, title: record ? `Edit ${record.name}` : 'Add environment', eyebrow: record ? `Environment of ${serviceName}` : 'New environment',
      fields, limits: { name: 200, bindings: 32, endpoints: 20 }, draft: eff, confirm,
      remove: record ? { enabled: can, reason: can ? null : (access?.why?.operate ?? null) } : null,
      status: st || idleStatus(record ? 'Name, tier, MCP endpoint, bindings and links.' : `A new environment of ${serviceName}.`),
      primary: primaryOf(record ? 'Save' : 'Create', can, access?.why?.operate ?? null),
    };
  }

  if (kind === 'endpoint') {
    const can = access?.can?.admin === true;
    const prefix = orgEnvPrefix(ctx.orgId ?? 'default');
    const eff = { name: str('name', record?.name ?? ''), url: str('url', record?.url ?? ''), readTokenEnv: str('readTokenEnv', record?.readTokenEnv ?? '') };
    const fields = [
      { name: 'name', label: 'Name', type: 'text', value: eff.name, max: 200 },
      { name: 'url', label: 'URL', type: 'url', value: eff.url, help: "The gateway's address — no credentials in it: the server refuses a URL with a user, a fragment or a token-like parameter." },
      { name: 'readTokenEnv', label: 'Token variable', type: 'text', value: eff.readTokenEnv,
        help: `The NAME of an environment variable on the server, set aside for ${orgName}: ${prefix}<NAME> (for example ${prefix}MCP_TOKEN). Its value stays on the server — this page never sees it, and nothing here says whether it is set. Leave empty when requests send their own token.` },
    ];
    let confirm = null;
    if (record && step === 'confirm-delete') {
      const n = Number.isInteger(record.environments) ? record.environments : 0;
      const names = boundNames(record.id, ctx.services);
      const which = names && names.length === n && n > 0 ? ` (${names.join(', ')})` : '';
      const text = n
        ? `Delete ${record.name}? ${plural(n, 'environment is', 'environments are')} checked through it${which}; they keep their rows, unbound.`
        : `Delete ${record.name}? No environment is checked through it.`;
      confirm = { text, danger: `Delete ${record.name}` };
    }
    return {
      ...base, title: record ? `Edit ${record.name}` : 'New MCP endpoint', eyebrow: 'MCP endpoint',
      fields, limits: { name: 200, url: 2000 }, draft: eff, confirm,
      remove: record ? { enabled: can, reason: can ? null : (access?.why?.admin ?? null) } : null,
      status: st || idleStatus('A name, the gateway URL and, if the server holds its token, the variable naming it.'),
      primary: primaryOf(record ? 'Save' : 'Create', can, access?.why?.admin ?? null),
    };
  }

  if (kind === 'org-name') {
    const can = access?.can?.admin === true;
    const eff = { name: str('name', record?.name ?? '') };
    return {
      ...base, id: record?.id ?? null, title: `Rename ${record?.name ?? orgName}`, eyebrow: 'Organisation',
      fields: [{ name: 'name', label: 'Name', type: 'text', value: eff.name, max: 200, help: record?.id ? `The id ${record.id} stays; only the name changes.` : null }],
      limits: { name: 200 }, draft: eff,
      status: st || idleStatus('1–200 characters.'),
      primary: primaryOf('Save', can, access?.why?.admin ?? null),
    };
  }

  if (kind === 'member-add') {
    const can = access?.can?.admin === true;
    const by = d.by === 'email' ? 'email' : 'login';
    const role = ROLES.includes(d.role) ? d.role : 'operator';
    const eff = { by, value: str('value', ''), role };
    return {
      ...base, title: 'Add member', eyebrow: `Members of ${orgName}`,
      fields: [
        { name: 'by', label: 'Find the user', type: 'radio', value: by, options: [{ value: 'login', label: 'by login', selected: by === 'login' }, { value: 'email', label: 'by verified email', selected: by === 'email' }] },
        { name: 'value', label: by === 'email' ? 'Verified email' : 'Login', type: by === 'email' ? 'email' : 'text', value: eff.value, max: 200 },
        { name: 'role', label: 'Role', type: 'segmented', value: role, options: ROLES.map((r) => ({ value: r, label: r, selected: r === role })) },
      ],
      limits: {}, draft: eff,
      status: st || idleStatus(`An existing user joins ${orgName}; a member already here gets the role chosen.`),
      primary: primaryOf('Add', can, access?.why?.admin ?? null),
    };
  }

  if (kind === 'member') {
    const can = access?.can?.admin === true;
    const owner = access?.owner === true;
    const members = isArr(ctx.members) ? ctx.members : [];
    const isLast = lastAdmin(record, members, { owner });
    const role = ROLES.includes(d.role) ? d.role : record.role;
    const you = Boolean(ctx.me) && record.login === ctx.me;
    const lock = isLast ? lastAdminText(record.login, orgName) : null;
    const options = ROLES.map((r) => {
      const reason = !can ? (access?.why?.admin ?? null) : (lock && r !== 'admin' ? lock : null);
      return { value: r, label: r, selected: r === role, enabled: reason === null, reason };
    });
    let confirm = null;
    const notes = [];
    if (owner && lastAdmin(record, members, { owner: false })) notes.push(`${record.login} is ${orgName}'s last admin: afterwards only an owner can manage its members, endpoints and audit.`);
    if (step === 'confirm-delete') {
      if (you) notes.unshift(selfNotes(orgName, owner).remove);
      // An owner may request any live org (server/authz.mjs orgContext): the
      // refusal is never theirs. The caller knows whether they are one;
      // another member's row carries no owner flag, so it says "unless".
      const refused = `Remove ${record.login} from ${orgName}? Their sessions keep working elsewhere; here their next request is refused`;
      const lead = !you ? `${refused}, unless they are an owner.` : owner ? `Remove ${record.login} from ${orgName}?` : `${refused}.`;
      confirm = { text: [lead, ...notes].join(' '), danger: `Remove ${record.login}` };
    } else if (step === 'confirm-action') {
      if (you) notes.unshift(selfNotes(orgName, owner).demote);
      confirm = { text: [`Change ${record.login}'s role to ${role}?`, ...notes].join(' '), danger: `Make ${record.login} ${role}` };
    }
    const removeReason = !can ? (access?.why?.admin ?? null) : lock;
    // The role group's help says why a choice is unavailable (once, not per button).
    const roleHelp = !can ? (access?.why?.admin ?? null) : lock;
    return {
      ...base, id: record.userId, title: record.login, eyebrow: `Member of ${orgName}`,
      fields: [{ name: 'role', label: 'Role', type: 'segmented', value: role, options, help: roleHelp }],
      limits: {}, draft: { role }, confirm,
      remove: { enabled: removeReason === null, reason: removeReason, label: 'Remove…' },
      status: st || idleStatus(`${record.login} is ${record.role} in ${orgName}.`),
      primary: primaryOf('Save', can, access?.why?.admin ?? null),
    };
  }

  throw new Error(`no Settings editor of kind ${JSON.stringify(kind)}`);
}

// ---------- the MCP target: a registered endpoint, or a typed URL (design §6) ----------

const AUTH_WRITE = "MCP client key — a write token, sent with this request only, never stored. (The endpoint's read variable is never used to write.)";

// Whether a picker's empty-list hint may offer Settings → MCP endpoints:
// only when the reader is known to be an admin of the org (C-7) — the
// identity posture at rank admin, or the open posture whose probe answered
// 200 in this page for this org (`probe` { orgId, ok }: you act as local,
// an owner). A closed probe, another org's, none yet, or any other posture:
// false.
export function mcpPickerCanAdmin({ access = null, probe = null, orgId = null } = {}) {
  if (access?.posture === 'identity') return access.role === 'admin';
  if (access?.posture === 'open') return probe?.ok === true && probe.orgId === orgId;
  return false;
}

// `endpoints` is state.mcpEndpoints (null: not read or failed → typed only;
// [] → none registered); `remembered` the remembered endpoint id for this
// org; `liveUrl` the live status's URL; `typedUrl` the remembered typed URL
// (not a default demo URL — a default would outrank the list); `purpose`
// 'read' | 'write'; `canAdmin` whether the empty-list hint may offer a
// button to Settings → MCP endpoints (known true only — C-7); `chosen` the
// choice the person made in this picker ('' = Type a URL…, an id = that
// endpoint while it is listed), which outranks every preselection.
// Preselection: remembered endpoint > the endpoint whose url is the live
// status's > the remembered typed URL > the first endpoint > typed.
//
// `typed` is what the server said this reader may do with a typed URL
// (GET /api/mcp-endpoints `policy.typed`; R4 — an admin's, never without
// sign-in): `{ allowed: false }` makes the picker list-only — no "Type a
// URL…", never the typed value, no URL row — and the empty list's hint
// names the way in for this reader (`posture` 'token': registering needs a
// signed-in admin). `unreadable`: the list (and so the policy) could not
// be read — said, since nothing else can be sent.
export function mcpTargetModel({ endpoints = null, remembered = null, liveUrl = null, typedUrl = '', purpose = 'read', orgName = null, canAdmin = false, chosen = null, typed = { allowed: true }, posture = null, unreadable = false } = {}) {
  const typedAllowed = typed?.allowed !== false;
  const list = isArr(endpoints) ? endpoints : [];
  const options = [
    ...list.map((ep) => ({ value: String(ep.id), label: endpointLabel(ep), name: ep.name, origin: ep.origin, tokenText: ep.readTokenEnv ?? null })),
    ...(typedAllowed ? [{ value: '', label: 'Type a URL…', name: null, origin: null, tokenText: null }] : []),
  ];
  const has = (id) => id !== null && id !== undefined && list.some((ep) => String(ep.id) === String(id));
  let value = '';
  if (chosen === '' && list.length && typedAllowed) value = '';
  else if (has(chosen)) value = String(chosen);
  else if (has(remembered)) value = String(remembered);
  else if (liveUrl && list.some((ep) => ep.url && ep.url === liveUrl)) value = String(list.find((ep) => ep.url === liveUrl).id);
  else if (typedAllowed && typedUrl && String(typedUrl).trim()) value = '';
  else if (list.length) value = String(list[0].id);
  const picked = list.find((ep) => String(ep.id) === value) || null;
  let authHelp = null;
  if (picked) {
    if (purpose === 'write') authHelp = AUTH_WRITE;
    else if (picked.readTokenEnv) authHelp = `Optional — empty uses ${picked.readTokenEnv} on the server.`;
    else if (picked.url) authHelp = 'Optional — this endpoint names no token variable; send one here if the server needs it.';
    else authHelp = 'Optional.';
  }
  const org = orgName || ORG_FALLBACK;
  let hint = null;
  if (isArr(endpoints) && !endpoints.length) {
    if (canAdmin) hint = { text: `No MCP endpoint is registered in ${org} yet.`, button: 'Settings → MCP endpoints' };
    else if (typedAllowed) hint = { text: `No MCP endpoint is registered in ${org} yet — an admin registers them.`, button: null };
    else if (posture === 'token') hint = { text: `No MCP endpoint is registered in ${org} yet — registering one needs a signed-in admin (npm run users -- add <login>).`, button: null };
    else hint = { text: `No MCP endpoint is registered in ${org} yet — an admin registers them in Settings → MCP endpoints.`, button: null };
  } else if (!typedAllowed && unreadable) {
    hint = { text: `${org}'s MCP endpoints could not be read just now — reopen this to try again.`, button: null };
  }
  return { show: list.length > 0, options, value, showUrl: typedAllowed && picked === null, authHelp, hint };
}

// The status line when a picker has nothing to send: the typed URL named
// only for a reader who may type one (R4); with no endpoint, the way in for
// this reader (`canRegister`: the server says it may register one).
export function mcpTargetMissingText({ typedAllowed = true, orgName = null, empty = false, canRegister = false } = {}) {
  if (typedAllowed) return 'choose an MCP endpoint or type a URL';
  const org = orgName || ORG_FALLBACK;
  if (empty) return `no MCP endpoint is registered in ${org} yet — ${canRegister ? 'register one in Settings → MCP endpoints' : 'an admin registers them in Settings → MCP endpoints'}`;
  return `choose one of ${org}'s MCP endpoints`;
}

const LOOPBACK_V4 = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const LOOPBACK_MAPPED = /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/;

// Before the home card registers a typed URL as an endpoint (D4): would the
// server accept its origin from this reader? `register` is the policy's
// (`{ allowed, listed, origins, listedOnly }`). → { origin, name, error }:
// `error` null when the registration may be sent, else the sentence (the
// server's own rule: without sign-in, a loopback MCP or a listed origin);
// `name` the endpoint's name (its host). The server judges again.
export function mcpRegisterCheck(url, register = null) {
  let u = null;
  try { u = new URL(String(url ?? '').trim()); } catch { /* not a URL */ }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return { origin: null, name: null, error: 'type the MCP URL (http:// or https://)' };
  const origin = u.origin;
  const name = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  if (!register?.allowed) return { origin, name, error: register?.why || 'registering an MCP endpoint is not open to you here' };
  const host = u.hostname;
  const loopback = host === 'localhost' || LOOPBACK_V4.test(host) || host === '[::1]' || LOOPBACK_MAPPED.test(host);
  if (loopback || !register.listedOnly || register.origins === null || (isArr(register.origins) && register.origins.includes(origin))) return { origin, name, error: null };
  return { origin, name, error: `${origin} cannot be registered on a server without sign-in — only a loopback MCP or an origin listed in OBSERVOGRAM_MCP_ORIGINS; the server's operator lists it there, or a first user arms sign-in (npm run users -- add <login>)` };
}

// The request's target: an endpoint → { mcpEndpointId, mcpAuth? }; a typed
// URL → { mcpUrl, mcpAuth? } — never both (the server refuses both); null
// when nothing is chosen and nothing typed.
export function mcpTargetBody(selection, typedUrl, auth) {
  const key = typeof auth === 'string' && auth.trim() ? auth.trim() : null;
  const id = asId(selection === undefined ? null : selection);
  if (id !== null) return key ? { mcpEndpointId: id, mcpAuth: key } : { mcpEndpointId: id };
  const url = typeof typedUrl === 'string' ? typedUrl.trim() : '';
  if (!url) return null;
  return key ? { mcpUrl: url, mcpAuth: key } : { mcpUrl: url };
}

// A deploy profile that names an endpoint records its org (A-12): select it
// only in that org with the id still listed; otherwise typed mode and a note.
// `typedAllowed` (R4): for a reader who may not type a URL, a typed
// profile is said, and no sentence offers typing one.
export function profileEndpointNote(profile, { orgId = null, orgName = null, endpoints = null, profileName = null, typedAllowed = true } = {}) {
  const ep = profile?.mcpEndpoint;
  const name = profileName ?? profile?.name ?? 'this profile';
  const org = orgName || orgId || ORG_FALLBACK;
  if (!ep || ep.id === undefined || ep.id === null) {
    if (!typedAllowed && typeof profile?.mcpUrl === 'string' && profile.mcpUrl.trim()) {
      return { select: null, note: `Profile "${name}" sends a typed MCP URL, which only an admin may send — choose one of ${org}'s MCP endpoints.` };
    }
    return { select: null, note: null };
  }
  const listed = isArr(endpoints) && endpoints.some((x) => String(x.id) === String(ep.id));
  if (ep.orgId === orgId && listed) return { select: ep.id, note: null };
  return { select: null, note: `Profile "${name}" names MCP endpoint "${ep.name}" of ${ep.orgId} — choose one of ${org}'s${typedAllowed ? ', or type a URL.' : ' MCP endpoints.'}` };
}

// Before a write is sent (C-3): the chosen endpoint as the option showed it
// ({ id, name, origin }) against the list just re-read. null = send; else
// the sentence, and nothing is sent. A re-read that failed (not an array)
// cannot vouch for the origin, so it does not send either.
export function endpointDrift(chosen, endpoints, { orgName = null, typedAllowed = true } = {}) {
  if (!chosen) return null;
  const org = orgName || ORG_FALLBACK;
  if (!isArr(endpoints)) return `${chosen.name} could not be checked against ${org}'s MCP endpoints just now — send again${typedAllowed ? ', or type a URL.' : '.'}`;
  const now = endpoints.find((ep) => String(ep.id) === String(chosen.id));
  if (!now) return `${chosen.name} is no longer one of ${org}'s MCP endpoints — ${typedAllowed ? 'choose another or type a URL.' : `choose another of ${org}'s MCP endpoints.`}`;
  if (now.origin !== chosen.origin) return `${chosen.name} now points at ${now.origin} (it showed ${chosen.origin}) — check the target and send again.`;
  return null;
}
