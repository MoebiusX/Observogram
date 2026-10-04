// server/service-admin.mjs — the management rules for services,
// environments and MCP endpoints (docs/STORE_PLAN.md slice 4 §7), a
// sibling of identity-admin.mjs: every rule the services API applies
// lives here once, and every refusal is its AdminRefusal with a `kind` —
// 'invalid' (bad input), 'missing' (no such row) or 'conflict' (the state
// forbids it) — which the routes answer as 400, 404 and 409. No CLI speaks
// these rules yet, so there is no `surface` parameter; every way-out text
// sits in one table (WAYS) so a `cli` column can be added as
// identity-admin did.
//
// The repositories keep their own, permissive rules (a tier is any text,
// an env var name any string): the vocabulary — tier-1 | tier-2 | tier-3
// | null ("graded by the pack"), the slug as tools/lib/service-keys.mjs
// keys services, the shapes of owners, bindings and endpoints — is this
// module's, applied before a repository is called. A repository TypeError
// that still fires (the MCP URL and env-var rules of
// server/store/mcp-endpoints.mjs) reaches the route as a 400 with the
// repository's text.
//
// Also here: the views the routes serve (§7.3), serviceTierFor — the
// conformance route's tier from the service record (§9) — and
// resolveMcpTarget, how refresh-live, draft-from-mcp and the deploy routes
// take an MCP endpoint by id (§7.6; the read token from the org's own
// variable, read at request time, never logged, returned or stored).
//
// No SQL of its own: every read and write goes through server/store/*.

import { normalizeServiceKey } from '../tools/lib/service-keys.mjs';
import { mcpUrlOrigin } from '../tools/lib/mcp-url-safety.mjs';
import { rankOfRole } from './authz.mjs';
import { AdminRefusal } from './identity-admin.mjs';
import { validateMcpUrl } from './mcp-url.mjs';
import { currentOrg } from './org-context.mjs';
import { atomic } from './store/db.mjs';
import { createService, deleteService, getService, getServiceBySlug, listServices, updateService } from './store/services.mjs';
import {
  countEnvironmentsBoundTo, createEnvironment, deleteEnvironment, getEnvironment, getEnvironmentByName, listEnvironments,
  listEnvironmentsForOrg, updateEnvironment,
} from './store/environments.mjs';
import {
  assertNoCredential, countBound, createMcpEndpoint, deleteMcpEndpoint, envNameOwnedBy, envNameOwnerText, envNameShapeText,
  getMcpEndpoint, listMcpEndpoints, updateMcpEndpoint,
} from './store/mcp-endpoints.mjs';
import { getPack } from './store/packs.mjs';
import { listLinksForOrg, listPacksForService, listServicesForPack } from './store/pack-services.mjs';
import { textOk } from './store/rows.mjs';

const refuse = (message, kind = 'conflict') => { throw new AdminRefusal(message, kind); };
const invalid = (message) => refuse(message, 'invalid');
const missing = (message) => refuse(message, 'missing');

export const TIERS = Object.freeze(['tier-1', 'tier-2', 'tier-3']);
const TEXT_MAX = 200;
const DESCRIPTION_MAX = 4000;
const OWNERS_MAX = 50;
const BINDINGS_MAX = 32;
const BINDING_TEXT_MAX = 256;
const ENDPOINTS_MAX = 20;
const URL_MAX = 2000;
const ID_MAX = 9007199254740991;

// Every way out a refusal names (the API's routes; no CLI manages these).
export const WAYS = Object.freeze({
  serviceName: 'a service name is 1–200 characters',
  slug: (x) => `${JSON.stringify(x)} is not a service slug (lowercase letters, digits and -, as the catalogue keys services: ${JSON.stringify(normalizeServiceKey(x))})`,
  noSlug: (name) => `${JSON.stringify(name)} yields no slug — send "slug"`,
  owners: 'owners is an array of at most 50 names of 1–200 characters',
  tier: (x) => `a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not ${JSON.stringify(x)}`,
  description: 'a description is at most 4000 characters',
  serviceExists: (s) => `service "${s.slug}" exists (id ${s.id}) — PATCH /api/services/${s.id} changes it`,
  slugFixed: "a service's slug is fixed (packs link to it by slug) — create a new service with POST /api/services",
  noService: (id) => `no service ${id}`,
  environmentName: 'an environment name is 1–200 characters',
  environmentExists: (env, slug) => `environment "${env.name}" of ${slug} exists (id ${env.id}) — PATCH /api/environments/${env.id} changes it`,
  bindings: 'bindings is an object of at most 32 string values; keys and values are 1–256 characters',
  endpoints: (name) => `endpoints is an object of at most 20 http(s) URLs by name${name === undefined ? '' : `; ${JSON.stringify(name)} is not one`}`,
  noMcpEndpointInOrg: (id) => `no MCP endpoint ${id} in this org — GET /api/mcp-endpoints lists them`,
  noEnvironment: (id) => `no environment ${id}`,
  mcpEndpointName: 'an MCP endpoint name is 1–200 characters',
  mcpEndpointExists: (ep) => `MCP endpoint "${ep.name}" exists (id ${ep.id}) — PATCH /api/mcp-endpoints/${ep.id} changes it`,
  noMcpEndpoint: (id) => `no MCP endpoint ${id}`,
  bothTargets: 'send mcpUrl or mcpEndpointId, not both',
  neitherTarget: 'mcpUrl or mcpEndpointId required in JSON body',
  mcpEndpointIdShape: 'mcpEndpointId must be a positive integer',
  anotherVariable: (id) => ` — PATCH /api/mcp-endpoints/${id} names another variable`,
  tokenUnset: (ep) => `MCP endpoint "${ep.name}" reads its token from ${ep.readTokenEnv}, which is not set in the server's environment — set it on the server (the k8s Deployment's env), or send mcpAuth with this request`,
});

// ---------- the field rules ----------

// null / undefined → null (graded by the pack); else one of TIERS.
export function parseTier(value) {
  if (value === null || value === undefined) return null;
  if (!TIERS.includes(value)) invalid(WAYS.tier(value));
  return value;
}

// The slug sent, or the one the name yields; a sent slug must already be
// normalised (what the catalogue would key the service under).
export function parseSlug(slug, name) {
  if (slug === undefined || slug === null) {
    const derived = normalizeServiceKey(name);
    if (!textOk(derived, { max: TEXT_MAX })) invalid(WAYS.noSlug(name));
    return derived;
  }
  if (typeof slug !== 'string' || !textOk(slug, { max: TEXT_MAX }) || slug !== normalizeServiceKey(slug)) invalid(WAYS.slug(slug));
  return slug;
}

// undefined → []; else at most 50 names of 1–200 characters (trimmed).
export function parseOwners(owners) {
  if (owners === undefined) return [];
  if (!Array.isArray(owners) || owners.length > OWNERS_MAX) invalid(WAYS.owners);
  return owners.map((o) => {
    if (!textOk(o, { max: TEXT_MAX })) invalid(WAYS.owners);
    return o.trim();
  });
}

// A name of 1–200 characters, trimmed like owners: ' prod ' is prod.
function parseName(value, text) {
  if (!textOk(value, { max: TEXT_MAX })) invalid(text);
  return value.trim();
}

function parseDescription(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > DESCRIPTION_MAX) invalid(WAYS.description);
  return value;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// undefined → {}; else string → string, at most 32 entries, keys and
// values 1–256 characters.
export function parseBindings(obj) {
  if (obj === undefined) return {};
  if (!isPlainObject(obj)) invalid(WAYS.bindings);
  const entries = Object.entries(obj);
  if (entries.length > BINDINGS_MAX) invalid(WAYS.bindings);
  for (const [k, v] of entries) {
    if (!textOk(k, { max: BINDING_TEXT_MAX }) || !textOk(v, { max: BINDING_TEXT_MAX })) invalid(WAYS.bindings);
  }
  return { ...obj };
}

// undefined → {}; else name → http(s) URL, at most 20, each free of
// userinfo, a fragment and credential-named parameters (§7.5's rule).
export function parseEndpoints(obj) {
  if (obj === undefined) return {};
  if (!isPlainObject(obj)) invalid(WAYS.endpoints());
  const entries = Object.entries(obj);
  if (entries.length > ENDPOINTS_MAX) invalid(WAYS.endpoints());
  for (const [name, value] of entries) {
    if (!textOk(name, { max: TEXT_MAX }) || !textOk(value, { max: URL_MAX })) invalid(WAYS.endpoints(name));
    let u;
    try { u = new URL(value); } catch { invalid(WAYS.endpoints(name)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') invalid(WAYS.endpoints(name));
    try { assertNoCredential(u, `endpoints.${name}`); } catch (e) { invalid(e.message); }
  }
  return { ...obj };
}

// An id as a route or a body carries it: a positive integer (or its
// decimal string), at most Number.MAX_SAFE_INTEGER; null otherwise.
export function positiveId(value) {
  const n = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= ID_MAX ? n : null;
}

// The org's endpoint by id, or the 400 (another org's id is the same 400:
// never found in this context).
function parseMcpEndpointId(db, value) {
  if (value === null || value === undefined) return null;
  const id = positiveId(value);
  if (id === null || !getMcpEndpoint(db, id)) invalid(WAYS.noMcpEndpointInOrg(value));
  return id;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The keys of `next` whose value differs from `current`'s (JSON-equal
// objects and arrays are the same).
function changedFields(current, next) {
  return Object.keys(next).filter((k) => !same(current[k], next[k]));
}

// ---------- services ----------

export function createServiceFromApi(db, actor, { slug, name, owners, tier, description } = {}) {
  name = parseName(name, WAYS.serviceName);
  const fields = {
    slug: parseSlug(slug, name), name, owners: parseOwners(owners), tier: parseTier(tier), description: parseDescription(description),
  };
  return atomic(db, () => {
    const existing = getServiceBySlug(db, fields.slug);
    if (existing) refuse(WAYS.serviceExists(existing));
    return createService(db, actor, fields);
  });
}

// → { service, changed: [fields] }; nothing differs → changed: [] and no row.
export function updateServiceFromApi(db, actor, id, patch = {}) {
  return atomic(db, () => {
    const current = getService(db, id);
    if (!current) missing(WAYS.noService(id));
    if (Object.hasOwn(patch, 'slug')) invalid(WAYS.slugFixed);
    const next = {};
    if (patch.name !== undefined) next.name = parseName(patch.name, WAYS.serviceName);
    if (patch.owners !== undefined) next.owners = parseOwners(patch.owners);
    if (patch.tier !== undefined) next.tier = parseTier(patch.tier);
    if (patch.description !== undefined) next.description = parseDescription(patch.description);
    const changed = changedFields(current, next);
    if (!changed.length) return { service: current, changed };
    const service = updateService(db, actor, id, Object.fromEntries(changed.map((k) => [k, next[k]])));
    return { service, changed };
  });
}

// → { service: ServiceView (as it was), environments: n, packLinks: n }.
// The packs stay registered; their links cascade with the environments.
export function deleteServiceFromApi(db, actor, id) {
  return atomic(db, () => {
    const current = getService(db, id);
    if (!current) missing(WAYS.noService(id));
    const view = serviceViewOf(db, current);
    const environments = view.environments.length;
    const packLinks = view.packs.length;
    deleteService(db, actor, id, { detail: { environments, packLinks } });
    return { service: view, environments, packLinks };
  });
}

// ---------- environments ----------

export function createEnvironmentFromApi(db, actor, serviceId, { name, tier, bindings, endpoints, mcpEndpointId } = {}) {
  return atomic(db, () => {
    const service = getService(db, serviceId);
    if (!service) missing(WAYS.noService(serviceId));
    name = parseName(name, WAYS.environmentName);
    const fields = {
      serviceId: service.id, name, tier: parseTier(tier), bindings: parseBindings(bindings), endpoints: parseEndpoints(endpoints),
      mcpEndpointId: parseMcpEndpointId(db, mcpEndpointId),
    };
    const existing = getEnvironmentByName(db, service.id, name);
    if (existing) refuse(WAYS.environmentExists(existing, service.slug));
    return createEnvironment(db, actor, fields);
  });
}

// → { environment, changed }; `mcpEndpointId: null` unbinds.
export function updateEnvironmentFromApi(db, actor, id, patch = {}) {
  return atomic(db, () => {
    const current = getEnvironment(db, id);
    if (!current) missing(WAYS.noEnvironment(id));
    const next = {};
    if (patch.name !== undefined) next.name = parseName(patch.name, WAYS.environmentName);
    if (patch.tier !== undefined) next.tier = parseTier(patch.tier);
    if (patch.bindings !== undefined) next.bindings = parseBindings(patch.bindings);
    if (patch.endpoints !== undefined) next.endpoints = parseEndpoints(patch.endpoints);
    if (patch.mcpEndpointId !== undefined) next.mcpEndpointId = parseMcpEndpointId(db, patch.mcpEndpointId);
    const changed = changedFields(current, next);
    if (!changed.length) return { environment: current, changed };
    if (changed.includes('name')) {
      const clash = getEnvironmentByName(db, current.serviceId, next.name);
      if (clash) refuse(WAYS.environmentExists(clash, getService(db, current.serviceId).slug));
    }
    const environment = updateEnvironment(db, actor, id, Object.fromEntries(changed.map((k) => [k, next[k]])));
    return { environment, changed };
  });
}

// → { environment: EnvironmentView (as it was) }.
export function deleteEnvironmentFromApi(db, actor, id) {
  return atomic(db, () => {
    const current = getEnvironment(db, id);
    if (!current) missing(WAYS.noEnvironment(id));
    const view = environmentViewOf(db, current);
    deleteEnvironment(db, actor, id);
    return { environment: view };
  });
}

// ---------- MCP endpoints ----------

export function createMcpEndpointFromApi(db, actor, { name, url, readTokenEnv } = {}) {
  name = parseName(name, WAYS.mcpEndpointName);
  return atomic(db, () => {
    const existing = listMcpEndpoints(db).find((ep) => ep.name === name);
    if (existing) refuse(WAYS.mcpEndpointExists(existing));
    // The URL and env-var rules are the repository's (TypeError → 400).
    return createMcpEndpoint(db, actor, { name, url, readTokenEnv: readTokenEnv === undefined ? null : readTokenEnv });
  });
}

// → { endpoint, changed }; `readTokenEnv: null` clears it.
export function updateMcpEndpointFromApi(db, actor, id, patch = {}) {
  return atomic(db, () => {
    const current = getMcpEndpoint(db, id);
    if (!current) missing(WAYS.noMcpEndpoint(id));
    const next = {};
    if (patch.name !== undefined) next.name = parseName(patch.name, WAYS.mcpEndpointName);
    if (patch.url !== undefined) next.url = patch.url;
    if (patch.readTokenEnv !== undefined) next.readTokenEnv = patch.readTokenEnv;
    const changed = changedFields(current, next);
    if (!changed.length) return { endpoint: current, changed };
    if (changed.includes('name')) {
      const clash = listMcpEndpoints(db).find((ep) => ep.name === next.name && ep.id !== current.id);
      if (clash) refuse(WAYS.mcpEndpointExists(clash));
    }
    const endpoint = updateMcpEndpoint(db, actor, id, Object.fromEntries(changed.map((k) => [k, next[k]])));
    return { endpoint, changed };
  });
}

// → { endpoint: McpEndpointView (the admin's, as it was), unbound: [environment ids] }.
export function deleteMcpEndpointFromApi(db, actor, id) {
  return atomic(db, () => {
    const current = getMcpEndpoint(db, id);
    if (!current) missing(WAYS.noMcpEndpoint(id));
    const view = mcpEndpointViewOf(db, current, { rank: rankOfRole('admin') });
    const unbound = countEnvironmentsBoundTo(db, id);
    deleteMcpEndpoint(db, actor, id);
    return { endpoint: view, unbound };
  });
}

// ---------- the views (§7.3) ----------

const OPERATOR = rankOfRole('operator');

// { id, name, origin } of an endpoint, or null.
const mcpEndpointSummary = (ep) => (ep ? { id: ep.id, name: ep.name, origin: mcpUrlOrigin(ep.url) } : null);

function environmentView(env, service, endpoint) {
  return {
    id: env.id, serviceId: env.serviceId, name: env.name, tier: env.tier, effectiveTier: env.tier ?? service.tier ?? null,
    bindings: env.bindings, endpoints: env.endpoints, mcpEndpoint: mcpEndpointSummary(endpoint),
    createdAt: env.createdAt, updatedAt: env.updatedAt,
  };
}

// Primary first, then by pack id.
const byRoleThenId = (a, b) => (a.role === b.role ? (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : 0) : a.role === 'primary' ? -1 : 1);

function serviceView(service, environments, links) {
  return {
    id: service.id, slug: service.slug, name: service.name, owners: service.owners, tier: service.tier, description: service.description,
    source: { kind: 'observogram' }, createdAt: service.createdAt, updatedAt: service.updatedAt,
    environments,
    packs: [...links].sort(byRoleThenId).map((l) => ({ id: l.packId, label: l.label ?? null, source: l.source ?? null, role: l.role })),
  };
}

// EnvironmentView; `service` saves the read when the caller has the row.
export function environmentViewOf(db, env, service = null) {
  const svc = service ?? getService(db, env.serviceId);
  const endpoint = env.mcpEndpointId === null ? null : getMcpEndpoint(db, env.mcpEndpointId);
  return environmentView(env, svc, endpoint);
}

// ServiceView: its environments by name, its packs with label and source.
export function serviceViewOf(db, service) {
  const environments = listEnvironments(db, service.id).map((env) => environmentViewOf(db, env, service));
  const links = listPacksForService(db, service.id).map((l) => {
    const pack = getPack(db, l.packId);
    return { ...l, label: pack?.label ?? null, source: pack?.source ?? null };
  });
  return serviceView(service, environments, links);
}

// McpEndpointView by the reader's rank: the URL and the variable to
// operators and above (the live-status precedent), null to a viewer; the
// origin to every member.
export function mcpEndpointViewOf(db, ep, { rank }) {
  const full = rank >= OPERATOR;
  return {
    id: ep.id, name: ep.name, origin: mcpUrlOrigin(ep.url), url: full ? ep.url : null, readTokenEnv: full ? ep.readTokenEnv : null,
    environments: countBound(db, ep.id), createdAt: ep.createdAt,
  };
}

// Every ServiceView of the org, sorted by slug, in four queries.
export function listServiceViews(db) {
  const endpoints = new Map(listMcpEndpoints(db).map((ep) => [ep.id, ep]));
  const envsByService = new Map();
  for (const env of listEnvironmentsForOrg(db)) {
    if (!envsByService.has(env.serviceId)) envsByService.set(env.serviceId, []);
    envsByService.get(env.serviceId).push(env);
  }
  const linksByService = new Map();
  for (const link of listLinksForOrg(db)) {
    if (!linksByService.has(link.serviceId)) linksByService.set(link.serviceId, []);
    linksByService.get(link.serviceId).push(link);
  }
  return listServices(db).map((service) => serviceView(
    service,
    (envsByService.get(service.id) ?? []).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((env) => environmentView(env, service, env.mcpEndpointId === null ? null : endpoints.get(env.mcpEndpointId) ?? null)),
    linksByService.get(service.id) ?? [],
  ));
}

// ---------- the tier rule (§9) ----------

// The record's tier for a pack graded for `envName`: the pack's primary
// service (none → null: graded by the pack), its environment of that name
// when one exists; tier = environment.tier ?? service.tier ?? null, and
// `from` says which set it. A catalogue pack has no link and gets null.
export function serviceTierFor(db, packId, envName = null) {
  const primary = listServicesForPack(db, packId).find((l) => l.role === 'primary');
  if (!primary) return null;
  const service = getService(db, primary.serviceId);
  if (!service) return null;
  const environment = typeof envName === 'string' && envName ? getEnvironmentByName(db, service.id, envName) : null;
  const tier = environment?.tier ?? service.tier ?? null;
  return {
    tier,
    from: environment?.tier ? 'environment' : service.tier ? 'service' : null,
    service: { id: service.id, slug: service.slug },
    environment: environment ? { id: environment.id, name: environment.name } : null,
  };
}

// ---------- an endpoint picked by id (§7.6) ----------

const MISSING = Symbol('missing');

// How a route reads its MCP target from the body: `mcpUrl` as today, or
// `mcpEndpointId` — the org's endpoint record, whose URL is fetched and
// whose READ token (forWrite: false — refresh-live, draft-from-mcp) comes
// from the named variable when the request sends no mcpAuth, after the
// variable's ownership is checked again against the orgs that exist now.
// With forWrite (deploy, rollback) the record's URL only: write tokens
// stay per-request pass-through. The SSRF rule (validateMcpUrl) runs last,
// where it does today. Returns { mcpUrl, safeMcpUrl, mcpAuth, endpoint }
// or { status: 400, error }; the token's value is in mcpAuth alone.
export function resolveMcpTarget(db, body = {}, { forWrite = false } = {}) {
  const bad = (error) => ({ status: 400, error });
  // The body's fields as the routes read them: a trimmed URL or null, a
  // non-empty token or null.
  const sentUrl = typeof body.mcpUrl === 'string' && body.mcpUrl.trim() ? body.mcpUrl.trim() : null;
  const sentAuth = typeof body.mcpAuth === 'string' && body.mcpAuth ? body.mcpAuth : null;
  const byId = body.mcpEndpointId !== null && body.mcpEndpointId !== undefined;
  if (sentUrl && byId) return bad(WAYS.bothTargets);
  let mcpUrl;
  let mcpAuth;
  let endpoint = null;
  if (byId) {
    const id = positiveId(body.mcpEndpointId);
    if (id === null) return bad(WAYS.mcpEndpointIdShape);
    const ep = getMcpEndpoint(db, id);
    if (!ep) return bad(WAYS.noMcpEndpointInOrg(body.mcpEndpointId));
    const readsToken = !forWrite && !!ep.readTokenEnv;
    if (readsToken) {
      const org = currentOrg();
      const owners = envNameOwnedBy(db, ep.readTokenEnv);
      if (!owners.includes(org)) {
        const text = owners.length ? envNameOwnerText(ep.readTokenEnv, owners) : envNameShapeText(ep.readTokenEnv, org);
        return bad(`${text}${WAYS.anotherVariable(ep.id)}`);
      }
    }
    mcpUrl = ep.url;
    mcpAuth = sentAuth ?? (readsToken ? process.env[ep.readTokenEnv] ?? MISSING : null);
    if (mcpAuth === MISSING) return bad(WAYS.tokenUnset(ep));
    endpoint = { id: ep.id, name: ep.name };
  } else {
    if (!sentUrl) return bad(WAYS.neitherTarget);
    mcpUrl = sentUrl;
    mcpAuth = sentAuth;
  }
  const { error, safeUrl } = validateMcpUrl(mcpUrl);
  if (error) return bad(error);
  return { mcpUrl, safeMcpUrl: safeUrl, mcpAuth, endpoint };
}
