// server/org-context.mjs — the request's org, and nothing else.
//
// The org rides AsyncLocalStorage (node:async_hooks), so nothing threads
// an orgId parameter through the call sites between a route and the code
// that resolves a path or reads an org-scoped row. It lives in its own
// module, importing only node:async_hooks, so the store's repositories
// (server/store/rows.mjs, orgs.mjs) and server/tenancy.mjs can both depend
// on it without importing each other: a cycle between them would let the
// evaluation order decide whether the context exists when first used.
// server/tenancy.mjs re-exports all three names.

import { AsyncLocalStorage } from 'node:async_hooks';

const orgContext = new AsyncLocalStorage();

export function runWithOrg(orgId, fn) { return orgContext.run(orgId, fn); }

export function currentOrg() { return orgContext.getStore() || null; }

// Org ids are path components — same shape as the spec's Slug.
export function validOrgId(id) { return /^[a-z][a-z0-9_-]{0,62}[a-z0-9]$/.test(String(id || '')); }
