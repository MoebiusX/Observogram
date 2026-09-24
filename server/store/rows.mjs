// server/store/rows.mjs — the small rules every repository shares.
//
// Two classes of repository (docs/STORE_PLAN.md §1):
//   - deployment-level (meta, users, orgs, memberships, audit) take explicit
//     ids and never read the org context;
//   - context-scoped (services, environments, mcp_endpoints, packs,
//     pack_services) read currentOrg() and throw outside a context, so a
//     caller that forgot runWithOrg() fails closed instead of reaching
//     another org's rows.
// Every mutating call takes an actor and writes its audit row in the same
// transaction.

import { currentOrg, validOrgId } from '../tenancy.mjs';

export function requireActor(actor) {
  if (typeof actor !== 'string' || !actor.trim()) {
    throw new TypeError('observogram store: a mutating call needs an actor (a login, a bearer label, local or system)');
  }
  return actor;
}

export function requireOrg(repo) {
  const org = currentOrg();
  if (!org) throw new Error(`observogram store: ${repo} is org-scoped — call it inside runWithOrg()`);
  if (!validOrgId(org)) throw new Error(`observogram store: invalid org id in context ${JSON.stringify(org)}`);
  return org;
}

export function toJson(value, fallback) {
  return JSON.stringify(value === undefined ? fallback : value);
}

export function fromJson(text, fallback = null) {
  if (text === null || text === undefined) return fallback;
  return JSON.parse(text);
}

export function notFound(kind, id) {
  const err = new Error(`observogram store: no ${kind} ${JSON.stringify(id)}`);
  err.code = 'ERR_OBSERVOGRAM_STORE_NOT_FOUND';
  return err;
}

export function requireText(value, field, { max = 200 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`observogram store: ${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

export function optionalText(value, field, opts) {
  return value === undefined || value === null ? null : requireText(value, field, opts);
}

// Builds `SET a = :a, b = :b` from a patch whose keys are mapped to
// columns, skipping undefined values. Column names come from the map,
// never from the caller.
export function setClause(patch, columns) {
  const sets = [];
  const params = {};
  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = :${column}`);
    params[column] = patch[key];
  }
  return { sql: sets.join(', '), params };
}
