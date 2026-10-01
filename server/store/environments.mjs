// server/store/environments.mjs — a service's environments (context-scoped
// through service_id; docs/STORE_PLAN.md §2). Rows carry no org_id of
// their own, so every statement joins services on the context's org: an
// environment of another org's service is not found, and neither is
// another org's MCP endpoint when binding one. tier overrides the
// service's tier for this environment.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getService } from './services.mjs';
import { getMcpEndpoint } from './mcp-endpoints.mjs';
import { fromJson, notFound, optionalText, requireOrg, requireText, setClause, toJson } from './rows.mjs';

const REPO = 'environments';

export function rowToEnvironment(r) {
  if (!r) return null;
  return {
    id: r.id, serviceId: r.service_id, name: r.name, tier: r.tier,
    bindings: fromJson(r.bindings, {}), endpoints: fromJson(r.endpoints, {}),
    mcpEndpointId: r.mcp_endpoint_id, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`observogram store: ${field} is an object`);
  return value;
}

function requireEndpoint(db, id) {
  if (id === null || id === undefined) return null;
  if (!getMcpEndpoint(db, id)) throw notFound('MCP endpoint', id);
  return id;
}

export function getEnvironment(db, id) {
  const org = requireOrg(REPO);
  return rowToEnvironment(prepare(db, `SELECT e.* FROM environments e JOIN services s ON s.id = e.service_id
    WHERE s.org_id = ? AND e.id = ?`).get(org, id));
}

export function listEnvironments(db, serviceId) {
  const org = requireOrg(REPO);
  return prepare(db, `SELECT e.* FROM environments e JOIN services s ON s.id = e.service_id
    WHERE s.org_id = ? AND e.service_id = ? ORDER BY e.name`).all(org, serviceId).map(rowToEnvironment);
}

export function createEnvironment(db, actor, { serviceId, name, tier = null, bindings = {}, endpoints = {}, mcpEndpointId = null }) {
  const org = requireOrg(REPO);
  requireText(name, 'name');
  const at = nowIso();
  return atomic(db, () => {
    const service = getService(db, serviceId);
    if (!service) throw notFound('service', serviceId);
    const row = prepare(db, `INSERT INTO environments (service_id, name, tier, bindings, endpoints, mcp_endpoint_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
      service.id, name, optionalText(tier, 'tier'), toJson(requireObject(bindings, 'bindings')),
      toJson(requireObject(endpoints, 'endpoints')), requireEndpoint(db, mcpEndpointId), at, at);
    writeAudit(db, actor, { orgId: org, action: 'environment.create', targetKind: 'environment', targetId: `${service.slug}/${name}` });
    return rowToEnvironment(row);
  });
}

export function updateEnvironment(db, actor, id, patch) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const current = getEnvironment(db, id);
    if (!current) throw notFound('environment', id);
    const values = {
      name: patch.name === undefined ? undefined : requireText(patch.name, 'name'),
      tier: patch.tier === undefined ? undefined : optionalText(patch.tier, 'tier'),
      bindings: patch.bindings === undefined ? undefined : toJson(requireObject(patch.bindings, 'bindings')),
      endpoints: patch.endpoints === undefined ? undefined : toJson(requireObject(patch.endpoints, 'endpoints')),
      mcpEndpointId: patch.mcpEndpointId === undefined ? undefined : requireEndpoint(db, patch.mcpEndpointId),
    };
    const { sql, params } = setClause(values, { name: 'name', tier: 'tier', bindings: 'bindings', endpoints: 'endpoints', mcpEndpointId: 'mcp_endpoint_id' });
    if (!sql) return current;
    prepare(db, `UPDATE environments SET ${sql}, updated_at = :updated_at WHERE id = :id`).run({ ...params, updated_at: nowIso(), id });
    const service = getService(db, current.serviceId);
    writeAudit(db, actor, { orgId: org, action: 'environment.update', targetKind: 'environment', targetId: `${service.slug}/${current.name}`, detail: { fields: Object.keys(params) } });
    return getEnvironment(db, id);
  });
}

export function deleteEnvironment(db, actor, id) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const current = getEnvironment(db, id);
    if (!current) throw notFound('environment', id);
    prepare(db, 'DELETE FROM environments WHERE id = ?').run(id);
    const service = getService(db, current.serviceId);
    writeAudit(db, actor, { orgId: org, action: 'environment.delete', targetKind: 'environment', targetId: `${service.slug}/${current.name}` });
    return current;
  });
}
