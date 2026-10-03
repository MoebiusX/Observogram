// server/store/mcp-endpoints.mjs — an org's named MCP endpoints
// (context-scoped; docs/STORE_PLAN.md §2, slice 4 §7.5). No secret is
// stored: read_token_env is the NAME of an env var (like a journey's
// packB.mcp.authEnv), and the two rules below keep a secret out of the row
// and the variable inside the org's own:
//
//   - requireUrl refuses a URL with userinfo (user:pass@), any fragment, or
//     a credential-named query parameter — the WORD rule of
//     tools/lib/mcp-url-safety.mjs (the one the live pack, the studio and
//     the fetch-live CLI apply): the URL is refused exactly when
//     stripMcpUrl(url) would drop something. The refusal names the
//     parameter NAMES, never a value and never the URL. assertNoCredential
//     is the same test for the URLs an environment's `endpoints` hold.
//   - requireEnvName restricts the variable to THIS org's: the shape
//     OBSERVOGRAM_ORG_<KEY>_<NAME> (KEY = the org id upper-cased, `-` → `_`),
//     and the owning org — the org whose prefix OBSERVOGRAM_ORG_<KEY>_ is
//     the LONGEST prefix of the name among every org row, live or removed
//     — must be the context org. `acme` and `acme-eu` may both exist, and
//     OBSERVOGRAM_ORG_ACME_EU_TOKEN is acme-eu's, though it starts with
//     acme's prefix: without the longest-prefix rule acme's admin could
//     point an endpoint at a URL of theirs and have the server send
//     acme-eu's token there at the next refresh. `a-b` and `a_b` share a
//     KEY and tie; a tie that includes the context org passes (one
//     deployment's orgs, both created by an owner). Removed orgs count:
//     their variables are nobody else's to claim. The same ownership is
//     re-checked at request time by resolveMcpTarget (envNameOwnedBy): an
//     org created later can change a stored name's owner.
//
// Write tokens stay per-request pass-through. The SSRF / local-address
// policy (validateMcpUrl) is applied where the URL is fetched, not here.
// The audit rows say where the org's read token will go next: the URL's
// ORIGIN (never its path or query) and the variable's NAME.

import { mcpUrlOrigin, stripMcpUrl } from '../../tools/lib/mcp-url-safety.mjs';
import { atomic, nowIso, prepare } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { listOrgs } from './orgs.mjs';
import { notFound, requireOrg, requireText, setClause } from './rows.mjs';

const REPO = 'mcp_endpoints';
export const ENV_NAME_RE = /^OBSERVOGRAM_ORG_[A-Z0-9_]+$/;

export function rowToMcpEndpoint(r) {
  if (!r) return null;
  return { id: r.id, orgId: r.org_id, name: r.name, url: r.url, readTokenEnv: r.read_token_env, createdAt: r.created_at };
}

// ---------- the URL rule ----------

// What a parsed http(s) URL carries that a credential-free URL may not:
// 'userinfo', 'a fragment', or 'the parameter(s) "a", "b", which look like
// credentials' — the dropped names of stripMcpUrl, so the server's one
// word rule decides; null when it is clean. Names only, never a value.
export function credentialNote(u) {
  if (u.username || u.password) return 'userinfo';
  if (u.hash) return 'a fragment';
  const { dropped } = stripMcpUrl(u.href);
  if (!dropped.length) return null;
  return `the parameter(s) ${dropped.map((n) => JSON.stringify(n)).join(', ')}, which look like credentials`;
}

// The same test for a URL that is not the MCP endpoint's (an environment's
// `endpoints`): `where` names the field, the text the API answers verbatim
// (a 400 from server/service-admin.mjs), so it carries no store prefix.
export function assertNoCredential(url, where) {
  const note = credentialNote(url instanceof URL ? url : new URL(url));
  if (note) throw new TypeError(`${where} carries ${note} — a token goes in the auth field, never in a URL`);
  return url;
}

function requireUrl(url) {
  requireText(url, 'url', { max: 2000 });
  let u;
  // No echo of the input and no `cause`: a URL that fails to parse may still
  // hold a password or a query token, and this message reaches logs and 400s.
  try { u = new URL(url); } catch { throw new TypeError('observogram store: url is not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TypeError('observogram store: an MCP endpoint is http(s)');
  if (u.username || u.password) throw new TypeError('observogram store: an MCP endpoint URL may not carry credentials — name an env var in readTokenEnv');
  if (u.hash) throw new TypeError('observogram store: an MCP endpoint URL has no fragment');
  const { dropped } = stripMcpUrl(url);
  if (dropped.length) {
    const names = dropped.map((n) => JSON.stringify(n)).join(', ');
    throw new TypeError(`observogram store: an MCP endpoint URL may not carry credentials in its query — the parameter(s) ${names} look like credentials; remove them and name an env var in readTokenEnv`);
  }
  return url;
}

// ---------- the env var rule ----------

// OBSERVOGRAM_ORG_<KEY>_ for an org id: acme → OBSERVOGRAM_ORG_ACME_,
// pay-eu → OBSERVOGRAM_ORG_PAY_EU_.
export function orgEnvPrefix(orgId) {
  return `OBSERVOGRAM_ORG_${String(orgId).toUpperCase().replaceAll('-', '_')}_`;
}

// The org ids whose prefix is the longest prefix of `name` among every org
// row, live or removed (several only when their KEYs tie: a-b and a_b);
// [] when no org's prefix matches (nobody's). Deployment-wide: it reads
// orgs, not the context.
export function envNameOwnedBy(db, name) {
  if (typeof name !== 'string') return [];
  let best = 0;
  let owners = [];
  for (const org of listOrgs(db, { includeRemoved: true })) {
    const prefix = orgEnvPrefix(org.id);
    if (!name.startsWith(prefix) || name.length === prefix.length) continue;
    if (prefix.length > best) { best = prefix.length; owners = [org.id]; } else if (prefix.length === best) owners.push(org.id);
  }
  return owners;
}

export function envNameShapeText(name, org) {
  return `observogram store: readTokenEnv names an env var of this org, OBSERVOGRAM_ORG_<KEY>_<NAME> with <NAME> of [A-Z0-9_]+ (for example ${orgEnvPrefix(org)}MCP_TOKEN), not ${JSON.stringify(name)} — an admin may only name variables set aside for their org`;
}

export function envNameOwnerText(name, owners) {
  return `observogram store: ${name} belongs to org ${owners.join(', ')} (the longest org prefix wins) — an admin may only name variables set aside for their org`;
}

// null stays null; a name must have the shape and be owned by `org`
// (envNameOwnedBy includes it). A name no org owns is refused with the
// shape text: it is nobody's.
export function requireEnvName(db, name, org) {
  if (name === null || name === undefined) return null;
  if (typeof name !== 'string' || !ENV_NAME_RE.test(name)) throw new TypeError(envNameShapeText(name, org));
  const owners = envNameOwnedBy(db, name);
  if (!owners.length) throw new TypeError(envNameShapeText(name, org));
  if (!owners.includes(org)) throw new TypeError(envNameOwnerText(name, owners));
  return name;
}

// ---------- the rows ----------

export function getMcpEndpoint(db, id) {
  const org = requireOrg(REPO);
  return rowToMcpEndpoint(prepare(db, 'SELECT * FROM mcp_endpoints WHERE org_id = ? AND id = ?').get(org, id));
}

export function listMcpEndpoints(db) {
  const org = requireOrg(REPO);
  return prepare(db, 'SELECT * FROM mcp_endpoints WHERE org_id = ? ORDER BY name').all(org).map(rowToMcpEndpoint);
}

// How many of the org's environments are checked through this endpoint
// (the view's `environments: n`, the delete row's `unbound`). The ids are
// environments.countEnvironmentsBoundTo (that module imports this one).
export function countBound(db, id) {
  const org = requireOrg(REPO);
  return prepare(db, `SELECT COUNT(*) AS n FROM environments e JOIN services s ON s.id = e.service_id
    WHERE s.org_id = ? AND e.mcp_endpoint_id = ?`).get(org, id).n;
}

export function createMcpEndpoint(db, actor, { name, url, readTokenEnv = null }) {
  const org = requireOrg(REPO);
  requireText(name, 'name');
  return atomic(db, () => {
    const row = prepare(db, 'INSERT INTO mcp_endpoints (org_id, name, url, read_token_env, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
      .get(org, name, requireUrl(url), requireEnvName(db, readTokenEnv, org), nowIso());
    const created = rowToMcpEndpoint(row);
    writeAudit(db, actor, {
      orgId: org, action: 'mcp_endpoint.create', targetKind: 'mcp_endpoint', targetId: name,
      detail: { fields: ['name', 'url', 'readTokenEnv'], origin: mcpUrlOrigin(created.url), readTokenEnv: created.readTokenEnv },
    });
    return created;
  });
}

// The row's detail carries the origin and the variable AFTER the change:
// where the org's read token goes next.
export function updateMcpEndpoint(db, actor, id, patch) {
  const org = requireOrg(REPO);
  const values = {
    name: patch.name === undefined ? undefined : requireText(patch.name, 'name'),
    url: patch.url === undefined ? undefined : requireUrl(patch.url),
    readTokenEnv: patch.readTokenEnv === undefined ? undefined : requireEnvName(db, patch.readTokenEnv, org),
  };
  const { sql, params } = setClause(values, { name: 'name', url: 'url', readTokenEnv: 'read_token_env' });
  return atomic(db, () => {
    const current = getMcpEndpoint(db, id);
    if (!current) throw notFound('MCP endpoint', id);
    if (!sql) return current;
    prepare(db, `UPDATE mcp_endpoints SET ${sql} WHERE org_id = :org_id AND id = :id`).run({ ...params, org_id: org, id });
    const updated = getMcpEndpoint(db, id);
    writeAudit(db, actor, {
      orgId: org, action: 'mcp_endpoint.update', targetKind: 'mcp_endpoint', targetId: current.name,
      detail: { fields: Object.keys(params), origin: mcpUrlOrigin(updated.url), readTokenEnv: updated.readTokenEnv },
    });
    return updated;
  });
}

// Environments bound to it keep their row, unbound (ON DELETE SET NULL);
// the row counts them.
export function deleteMcpEndpoint(db, actor, id) {
  const org = requireOrg(REPO);
  return atomic(db, () => {
    const current = getMcpEndpoint(db, id);
    if (!current) throw notFound('MCP endpoint', id);
    const unbound = countBound(db, id);
    prepare(db, 'DELETE FROM mcp_endpoints WHERE org_id = ? AND id = ?').run(org, id);
    writeAudit(db, actor, {
      orgId: org, action: 'mcp_endpoint.delete', targetKind: 'mcp_endpoint', targetId: current.name,
      detail: { origin: mcpUrlOrigin(current.url), unbound },
    });
    return current;
  });
}
