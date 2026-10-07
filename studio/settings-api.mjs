// studio/settings-api.mjs
//
// The loaders of Settings (docs/STORE_PLAN.md §6 item 3, slice 6b): the org's
// environments (written through the services routes), its MCP endpoints, its
// members and name, and its audit; and the deployment's users, organisations
// and join role (an owner's). The controller (studio/app.mjs) owns WHEN each
// is called; the models (studio/settings-model.mjs) own what is drawn.
//
// Every call goes through requestJson() (studio/services-api.mjs): the CSRF
// and org headers on every request, the 401 sign-in rule, and the server's
// refusal thrown as `<status>: <sentence>` — never a raw body. Ids in a path
// are encodeURIComponent'ed. No loader logs. The member and user loaders drop
// `email` (and `emailVerified`) before any model sees it: Settings renders no
// member's or user's email. A password goes out in a request body only and
// never comes back (the server returns none).

import { requestJson } from './services-api.mjs';

const enc = encodeURIComponent;
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// A member as Settings keeps it: no email.
const memberOf = (m) => ({ userId: m.userId, login: m.login, kind: m.kind, name: m.name ?? null, role: m.role, disabled: m.disabled === true, since: m.since ?? null });

// A user as Settings keeps it: named fields, no email.
const userOf = (u) => ({
  id: u.id, login: u.login, kind: u.kind, name: u.name ?? null, owner: u.owner === true, disabled: u.disabled === true,
  mustChange: u.mustChange === true, seededDefault: u.seededDefault === true, createdAt: u.createdAt ?? null, lastLoginAt: u.lastLoginAt ?? null,
  memberships: Array.isArray(u.memberships) ? u.memberships.map((m) => ({ orgId: m.orgId, role: m.role })) : [],
});

// ---------- MCP endpoints ----------

// GET /api/mcp-endpoints → McpEndpointView[] (url / readTokenEnv null for a
// viewer); `withPolicy` → { endpoints, policy } — policy the server's
// { typed, register } for this reader (R4), null when it sent none.
export async function loadMcpEndpoints({ fetchFn = requestJson, withPolicy = false } = {}) {
  const doc = await fetchFn('/api/mcp-endpoints');
  const endpoints = Array.isArray(doc?.endpoints) ? doc.endpoints : [];
  if (!withPolicy) return endpoints;
  const policy = doc?.policy && typeof doc.policy === 'object' ? doc.policy : null;
  return { endpoints, policy };
}

// POST /api/mcp-endpoints → the endpoint (admin).
export async function createEndpoint(body, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/mcp-endpoints', json('POST', body));
  return doc?.endpoint ?? null;
}

// PATCH /api/mcp-endpoints/:id → { endpoint, changed } (admin; readTokenEnv null clears).
export async function patchEndpoint(id, patch, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/mcp-endpoints/${enc(id)}`, json('PATCH', patch));
  return { endpoint: doc?.endpoint ?? null, changed: Array.isArray(doc?.changed) ? doc.changed : [] };
}

// DELETE /api/mcp-endpoints/:id → { deleted, unbound: [environment ids] } (admin).
export async function deleteEndpoint(id, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/mcp-endpoints/${enc(id)}`, { method: 'DELETE' });
  return { deleted: doc?.deleted ?? null, unbound: Array.isArray(doc?.unbound) ? doc.unbound : [] };
}

// ---------- environments ----------

// POST /api/services/:id/environments → the environment (operator).
export async function createEnvironment(serviceId, body, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/services/${enc(serviceId)}/environments`, json('POST', body));
  return doc?.environment ?? null;
}

// PATCH /api/environments/:id → { environment, changed } (operator; each field given replaces).
export async function patchEnvironment(id, patch, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/environments/${enc(id)}`, json('PATCH', patch));
  return { environment: doc?.environment ?? null, changed: Array.isArray(doc?.changed) ? doc.changed : [] };
}

// DELETE /api/environments/:id → the environment as it was (operator).
export async function deleteEnvironment(id, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/environments/${enc(id)}`, { method: 'DELETE' });
  return doc?.deleted ?? null;
}

// ---------- members and the org's name ----------

// GET /api/org/members → { org, members } with no email (admin; in the token
// and open postures this read is also Settings' probe — its refusal is the
// banner).
export async function loadMembers({ fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/org/members');
  return { org: doc?.org ?? null, members: Array.isArray(doc?.members) ? doc.members.map(memberOf) : [] };
}

// POST /api/org/members { login } | { email }, role? → { member, added, changed } (an upsert).
export async function addMember(body, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/org/members', json('POST', body));
  return { member: doc?.member ? memberOf(doc.member) : null, added: doc?.added === true, changed: doc?.changed ?? null };
}

// PATCH /api/org/members/:userId { role } → { member, changed: { from, to } | null }.
export async function patchMember(userId, role, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/org/members/${enc(userId)}`, json('PATCH', { role }));
  return { member: doc?.member ? memberOf(doc.member) : null, changed: doc?.changed ?? null };
}

// DELETE /api/org/members/:userId → the membership removed (no email).
export async function removeMember(userId, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/org/members/${enc(userId)}`, { method: 'DELETE' });
  return doc?.removed ? memberOf(doc.removed) : null;
}

// PATCH /api/org { name } → the org ({ id, name, default }); no `changed`.
export async function renameOrg(name, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/org', json('PATCH', { name }));
  return doc?.org ?? null;
}

// ---------- the audit ----------

// GET /api/audit<query> (auditQuery() builds it) → the body ({ scope, org, limit, rows, next }).
export async function loadAudit(query = '', { fetchFn = requestJson } = {}) {
  return fetchFn(`/api/audit${query}`);
}

// ---------- the deployment's users, organisations and join role (an owner's) ----------

// GET /api/admin/users → the users, no email.
export async function loadUsers({ fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/admin/users');
  return Array.isArray(doc?.users) ? doc.users.map(userOf) : [];
}

// POST /api/admin/users { login, password, name?, email?, role?, orgId? } →
// { user, owner, joined, armed, note } (the server returns no password).
export async function createUser(body, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/admin/users', json('POST', body));
  return {
    user: doc?.user ? userOf(doc.user) : null, owner: doc?.owner === true,
    joined: Array.isArray(doc?.joined) ? doc.joined : [], armed: doc?.armed === true, note: doc?.note ?? null,
  };
}

// POST /api/admin/users/:id/<disable|enable|password|signout> (password:
// { password } — a temporary one, changed at the next sign-in) →
// { user, you, mustChange }.
export async function userAction(id, action, body = null, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/admin/users/${enc(id)}/${enc(action)}`, json('POST', body ?? {}));
  return { user: doc?.user ? userOf(doc.user) : null, you: doc?.you === true, mustChange: doc?.mustChange === true };
}

// PUT /api/admin/users/:id/owner { owner } → { user, changed, note }.
export async function setOwner(id, owner, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/admin/users/${enc(id)}/owner`, json('PUT', { owner: owner === true }));
  return { user: doc?.user ? userOf(doc.user) : null, changed: doc?.changed === true, note: doc?.note ?? null };
}

// GET /api/admin/orgs → { defaultOrg, orgs } (removed ones included: removedAt set).
export async function loadAdminOrgs({ fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/admin/orgs');
  return { defaultOrg: doc?.defaultOrg ?? null, orgs: Array.isArray(doc?.orgs) ? doc.orgs : [] };
}

// POST /api/admin/orgs { id, name?, adopt? } → { org, adopted, path } (the
// creator is its first admin; `path` the directory its files live in).
export async function createOrg(body, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/admin/orgs', json('POST', body));
  return { org: doc?.org ?? null, adopted: doc?.adopted === true, path: doc?.path ?? null };
}

// DELETE /api/admin/orgs/:id → { org, note } (a soft removal: the row and the
// files stay; `note` says where, and how to delete them).
export async function removeOrg(id, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/admin/orgs/${enc(id)}`, { method: 'DELETE' });
  return { org: doc?.org ?? null, note: doc?.note ?? null };
}

// GET /api/admin/join-role → { role, oidc, issuerKey, mode, proxy? } — the
// sign-in mode the server runs.
export async function loadJoinRole({ fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/admin/join-role');
  const { ok: _ok, ...rest } = doc || {};
  return rest;
}

// PUT /api/admin/join-role { role } — or { role: 'admin', confirm: true }
// (joinRoleBody: `confirm` rides an admin body only) → { role, from }.
export async function putJoinRole(role, confirm = false, { fetchFn = requestJson } = {}) {
  const body = confirm === true ? { role, confirm: true } : { role };
  const doc = await fetchFn('/api/admin/join-role', json('PUT', body));
  return { role: doc?.role ?? null, from: doc?.from ?? null };
}
