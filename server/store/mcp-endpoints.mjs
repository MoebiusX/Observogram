// server/store/mcp-endpoints.mjs — an org's named MCP endpoints
// (context-scoped; docs/STORE_PLAN.md §2). No secret is ever stored:
// read_token_env is the NAME of an env var (like a journey's
// packB.mcp.authEnv), and a URL carrying credentials is refused. Write
// tokens stay per-request pass-through.

import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { notFound, requireOrg, requireText, setClause } from './rows.mjs';

const REPO = 'mcp_endpoints';

export function rowToMcpEndpoint(r) {
  if (!r) return null;
  return { id: r.id, orgId: r.org_id, name: r.name, url: r.url, readTokenEnv: r.read_token_env, createdAt: r.created_at };
}

function requireUrl(url) {
  requireText(url, 'url', { max: 2000 });
  let u;
  try { u = new URL(url); } catch (e) { throw new TypeError(`observogram store: url is not a URL: ${JSON.stringify(url)}`, { cause: e }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('observogram store: an MCP endpoint is http(s)');
  if (u.username || u.password) throw new TypeError('observogram store: an MCP endpoint URL may not carry credentials — name an env var in readTokenEnv');
  return url;
}

function requireEnvName(name) {
  if (name === null || name === undefined) return null;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
    throw new TypeError(`observogram store: readTokenEnv is an env var name, not ${JSON.stringify(name)}`);
  }
  return name;
}

export function getMcpEndpoint(db, id) {
  const org = requireOrg(REPO);
  return rowToMcpEndpoint(prepare(db, 'SELECT * FROM mcp_endpoints WHERE org_id = ? AND id = ?').get(org, id));
}

export function listMcpEndpoints(db) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM mcp_endpoints WHERE org_id = ? ORDER BY name').all(org).map(rowToMcpEndpoint);
}

export function createMcpEndpoint(db, actor, { name, url, readTokenEnv = null }) {
  const org = requireOrg(REPO);
  requireText(name, 'name');
  return atomic(db, () => {
    const row = prepare(db, 'INSERT INTO mcp_endpoints (org_id, name, url, read_token_env, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(org, name, requireUrl(url), requireEnvName(readTokenEnv), nowIso());
    writeAudit(db, actor, { orgId: org, action: 'mcp_endpoint.create', targetKind: 'mcp_endpoint', targetId: name });
    return rowToMcpEndpoint(row);
  });
}

export function updateMcpEndpoint(db, actor, id, patch) {
  const org = requireOrg(REPO);
  const values = {
    name: patch.name === undefined ? undefined : requireText(patch.name, 'name'),
    url: patch.url === undefined ? undefined : requireUrl(patch.url),
    readTokenEnv: patch.readTokenEnv === undefined ? undefined : requireEnvName(patch.readTokenEnv),
  };
  const { sql, params } = setClause(values, { name: 'name', url: 'url', readTokenEnv: 'read_token_env' });
  return atomic(db, () => {
    const current = getMcpEndpoint(db, id);
    if (!current) throw notFound('MCP endpoint', id);
    if (!sql) return current;
    prepare(db, `UPDATE mcp_endpoints SET ${sql} WHERE org_id = :org_id AND id = :id`).run({ ...params, org_id: org, id });
    writeAudit(db, actor, { orgId: org, action: 'mcp_endpoint.update', targetKind: 'mcp_endpoint', targetId: current.name, detail: { fields: Object.keys(params) } });
    return getMcpEndpoint(db, id);
  });
}

// Environments bound to it keep their row, unbound (ON DELETE SET NULL).
export function deleteMcpEndpoint(db, actor, id) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const current = getMcpEndpoint(db, id);
    if (!current) throw notFound('MCP endpoint', id);
    prepare(db, 'DELETE FROM mcp_endpoints WHERE org_id = ? AND id = ?').run(org, id);
    writeAudit(db, actor, { orgId: org, action: 'mcp_endpoint.delete', targetKind: 'mcp_endpoint', targetId: current.name });
    return current;
  });
}
