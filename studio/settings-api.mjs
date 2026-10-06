// studio/settings-api.mjs
//
// The loaders of Settings (docs/STORE_PLAN.md §6 item 3, slice 6b): the org's
// environments (written through the services routes), its MCP endpoints, its
// members and name, and its audit. The controller (studio/app.mjs) owns WHEN
// each is called; the models (studio/settings-model.mjs) own what is drawn.
//
// Every call goes through requestJson() (studio/services-api.mjs): the CSRF
// and org headers on every request, the 401 sign-in rule, and the server's
// refusal thrown as `<status>: <sentence>` — never a raw body. Ids in a path
// are encodeURIComponent'ed. No loader logs. The member loaders drop `email`
// before any model sees it: Settings renders no member's email.

import { requestJson } from './services-api.mjs';

const enc = encodeURIComponent;
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// A member as Settings keeps it: no email.
const memberOf = (m) => ({ userId: m.userId, login: m.login, kind: m.kind, name: m.name ?? null, role: m.role, disabled: m.disabled === true, since: m.since ?? null });

// ---------- MCP endpoints ----------

// GET /api/mcp-endpoints → McpEndpointView[] (url / readTokenEnv null for a viewer).
export async function loadMcpEndpoints({ fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/mcp-endpoints');
  return Array.isArray(doc?.endpoints) ? doc.endpoints : [];
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
