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
// conformance route's tier from the service record (§9) —,
// resolveMcpTarget, how refresh-live, draft-from-mcp and the deploy routes
// take an MCP endpoint by id (§7.6; the read token from the org's own
// variable, read at request time, never logged, returned or stored), and
// the org's repository sources (Settings → Repository sources): which
// repository kinds a save, an upload and a Run may use in the request's org.
//
// No SQL of its own: every read and write goes through server/store/*.

import { delimiter, isAbsolute, resolve as resolvePath, sep } from 'node:path';
import { normalizeServiceKey } from '../tools/lib/service-keys.mjs';
import { mcpUrlOrigin, safeMcpUrl } from '../tools/lib/mcp-url-safety.mjs';
import { noSignInWay, rankOfRole } from './authz.mjs';
import { AdminRefusal } from './identity-admin.mjs';
import { credentialThatRides, exposedWay, mcpOriginDecision, originOf, typedMcpUrlDecision } from './mcp-target-policy.mjs';
import { validateMcpUrl } from './mcp-url.mjs';
import { adoHostRefusal, parseAdoUrl } from './ado-crawl.mjs';
import { parseGithubUrl } from './github-crawl.mjs';
import { currentOrg } from './org-context.mjs';
import { atomic } from './store/db.mjs';
import { createService, deleteService, getService, getServiceBySlug, listServices, updateService } from './store/services.mjs';
import {
  countEnvironmentsBoundTo, createEnvironment, deleteEnvironment, getEnvironment, getEnvironmentByName, listEnvironments,
  listEnvironmentsForOrg, updateEnvironment,
} from './store/environments.mjs';
import {
  assertNoCredential, countBound, createMcpEndpoint, deleteMcpEndpoint, envNameHookText, envNameOwnedBy, envNameOwnerText, envNameShapeText,
  getMcpEndpoint, isOrgHookShaped, listMcpEndpoints, updateMcpEndpoint,
} from './store/mcp-endpoints.mjs';
import { REPOSITORY_SOURCES, repositorySourcesOf, setRepositorySources } from './store/orgs.mjs';
import { getPack } from './store/packs.mjs';
import { listLinksForOrg, listPacksForService, listServicesForPack } from './store/pack-services.mjs';
import { countWaivers } from './store/waivers.mjs';
import { requireOrg, textOk } from './store/rows.mjs';

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
  typedUserinfo: 'a typed MCP URL may not carry user:password — send the token as mcpAuth',
  repository: 'a repository is { kind, location, ref } — kind github, ado or path — or null',
  repositoryKind: (x) => `a repository's kind is github, ado or path, not ${JSON.stringify(x)}`,
  repositoryUploadNamed: 'an uploaded repository is set by uploading its files (PUT /api/services/:id/repository-upload), not named here',
  repositoryGithub: (x) => `${JSON.stringify(x)} is not a GitHub repository — https://github.com/<owner>/<repo>, or <owner>/<repo>`,
  repositoryAdo: (x) => `${JSON.stringify(x)} is not an Azure DevOps repository — https://dev.azure.com/<org>/<project>/_git/<repo>`,
  repositoryPath: (x) => `${JSON.stringify(x)} is not a folder path on the server — give its full path (C:\\src\\shop, /srv/src/shop)`,
  repositoryRef: 'a branch is 1–200 characters with no spaces',
  repositoryFolderRoots: (x) => `${JSON.stringify(x)} is not under a folder this server reads repositories from (OBSERVOGRAM_REPO_ROOTS)`,
  repositoryFolderPosture: "a folder is read on the server, so it is taken only under the folders listed in OBSERVOGRAM_REPO_ROOTS on the server, or from the server's own machine while it runs without sign-in on loopback — list the folder there, or give a GitHub or Azure DevOps repository",
  repositorySourceOff: (label) => `${label} is switched off in Settings → Repository sources — an org admin can switch it back on`,
  repositorySourcesBody: 'send at least one repository source to switch — { github, ado, path, upload }, each true (on) or false (off)',
  repositorySourceKey: (x) => `${JSON.stringify(x)} is not a repository source — github, ado, path or upload`,
  repositorySourceValue: (kind, x) => `${kind} is true (on) or false (off), not ${JSON.stringify(x) ?? String(x)}`,
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

// ---------- the repository ----------

export const REPOSITORY_KINDS = Object.freeze(['github', 'ado', 'path']);
const REF_RE = /^[^\s~^:?*[\\]{1,200}$/;

// The folders the server reads repositories from: OBSERVOGRAM_REPO_ROOTS,
// split on commas and on the platform's path-list delimiter, absolute ones only.
export function repositoryRoots(raw = process.env.OBSERVOGRAM_REPO_ROOTS) {
  const split = delimiter === ';' ? /[,;]/ : /[,:]/;
  return String(raw || '').split(split).map((x) => x.trim()).filter((x) => x && isAbsolute(x)).map((x) => resolvePath(x));
}

const ON_WINDOWS = process.platform === 'win32';
const folded = (x) => (ON_WINDOWS ? x.toLowerCase() : x);
const within = (p, dir) => folded(p) === folded(dir) || folded(p).startsWith(folded(dir.endsWith(sep) ? dir : dir + sep));

// Why the server will not read this folder for this caller, or '' when it
// will: under a listed root, or — no root listed — a request sent straight
// to a loopback server without sign-in (the person's own machine). Checked
// when the record is written and again when it runs.
export function folderRefusal(location, caller, { roots = repositoryRoots() } = {}) {
  if (roots.length) return roots.some((r) => within(resolvePath(location), r)) ? '' : WAYS.repositoryFolderRoots(location);
  return caller?.posture === 'open-loopback' && caller?.direct === true ? '' : WAYS.repositoryFolderPosture;
}

// undefined → undefined (not sent); null → null (none yet); else the
// normalised { kind, location, ref }: a GitHub repository as
// https://github.com/<owner>/<repo>, an Azure DevOps one as parseAdoUrl's
// location (its host Azure DevOps Services or a listed Server), a folder as
// its full path — which `caller` (mcpCallerOf(req)) may name. `ref` is a
// branch or null (the default branch); a URL that names one (…/tree/<ref>,
// ?version=GB<ref>) gives it when `ref` is not sent.
export function parseRepository(value, { caller = null } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value) || Object.keys(value).some((k) => !['kind', 'location', 'ref'].includes(k))) invalid(WAYS.repository);
  const { kind } = value;
  if (kind === 'upload') invalid(WAYS.repositoryUploadNamed);
  if (!REPOSITORY_KINDS.includes(kind)) invalid(WAYS.repositoryKind(kind));
  const location = typeof value.location === 'string' ? value.location.trim() : '';
  if (!location || location.length > URL_MAX) {
    invalid(kind === 'github' ? WAYS.repositoryGithub(value.location) : kind === 'ado' ? WAYS.repositoryAdo(value.location) : WAYS.repositoryPath(value.location));
  }
  let ref = null;
  if (value.ref !== undefined && value.ref !== null && value.ref !== '') {
    if (typeof value.ref !== 'string' || !REF_RE.test(value.ref.trim())) invalid(WAYS.repositoryRef);
    ref = value.ref.trim();
  }
  if (kind === 'github') {
    const gh = parseGithubUrl(location);
    if (!gh) invalid(WAYS.repositoryGithub(location));
    return { kind, location: `https://github.com/${gh.owner}/${gh.repo}`, ref: ref ?? gh.ref ?? null };
  }
  if (kind === 'ado') {
    const ado = parseAdoUrl(location);
    if (!ado) invalid(WAYS.repositoryAdo(location));
    const why = adoHostRefusal(new URL(ado.base).origin);
    if (why) invalid(why);
    return { kind, location: ado.location, ref: ref ?? ado.ref ?? null };
  }
  if (!isAbsolute(location)) invalid(WAYS.repositoryPath(location));
  const why = folderRefusal(location, caller);
  if (why) invalid(why);
  return { kind, location: resolvePath(location), ref: null };
}

// ---------- the org's repository sources ----------
//
// Settings → Repository sources (server/store/orgs.mjs): one switch per
// source the service form offers, per org, every source on until an org
// admin switches it off. Off, a save naming it, an upload and the Run of a
// service declared there are refused (409) with WAYS.repositorySourceOff;
// the records keep their repository, and switched back on they work again.

export const REPOSITORY_SOURCE_LABEL = Object.freeze({ github: 'GitHub', ado: 'Azure DevOps', path: 'Folder', upload: 'Upload' });

// The request's org's switches: { github, ado, path, upload }, true is on.
export function repositorySourcesView(db) {
  return repositorySourcesOf(db, requireOrg('the repository sources'));
}

// Why `kind` may not be used in the request's org now — the sentence — or
// '' when it may (on, or not a source this rule knows).
export function repositorySourceRefusal(db, kind) {
  if (!REPOSITORY_SOURCES.includes(kind)) return '';
  return repositorySourcesView(db)[kind] ? '' : WAYS.repositorySourceOff(REPOSITORY_SOURCE_LABEL[kind]);
}

function refuseSourceOff(db, kind) {
  const why = repositorySourceRefusal(db, kind);
  if (why) refuse(why);
}

// The source a save's repository names (github, ado or path), before it is
// parsed — so a source switched off is the refusal, not its address — or null.
const namedSource = (value) => (isPlainObject(value) && REPOSITORY_KINDS.includes(value.kind) ? value.kind : null);

// An org admin's switch: `body` is { github?, ado?, path?, upload? }, each
// true (on) or false (off), at least one. → { sources, from, changed }
// (setRepositorySources: one org.repository_sources row when a switch
// moved, none otherwise).
export function setRepositorySourcesFromApi(db, actor, body) {
  if (!isPlainObject(body) || !Object.keys(body).length) invalid(WAYS.repositorySourcesBody);
  for (const [kind, on] of Object.entries(body)) {
    if (!REPOSITORY_SOURCES.includes(kind)) invalid(WAYS.repositorySourceKey(kind));
    if (typeof on !== 'boolean') invalid(WAYS.repositorySourceValue(kind, on));
  }
  return setRepositorySources(db, actor, requireOrg('the repository sources'), { ...body });
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The keys of `next` whose value differs from `current`'s (JSON-equal
// objects and arrays are the same).
function changedFields(current, next) {
  return Object.keys(next).filter((k) => !same(current[k], next[k]));
}

// ---------- services ----------

// `caller` (mcpCallerOf(req)) decides whether a folder repository may be
// named; a repository of a source the org switched off is refused (409).
export function createServiceFromApi(db, actor, { slug, name, owners, tier, description, repository } = {}, { caller = null } = {}) {
  name = parseName(name, WAYS.serviceName);
  const fields = {
    slug: parseSlug(slug, name), name, owners: parseOwners(owners), tier: parseTier(tier), description: parseDescription(description),
  };
  if (namedSource(repository)) refuseSourceOff(db, namedSource(repository));
  fields.repository = parseRepository(repository, { caller }) ?? null;
  return atomic(db, () => {
    const existing = getServiceBySlug(db, fields.slug);
    if (existing) refuse(WAYS.serviceExists(existing));
    return createService(db, actor, fields);
  });
}

// → { service, changed: [fields] }; nothing differs → changed: [] and no row.
// A repository of a source the org switched off is refused (409) only when
// it changes: the record's own repository, sent again, still saves.
export function updateServiceFromApi(db, actor, id, patch = {}, { caller = null } = {}) {
  return atomic(db, () => {
    const current = getService(db, id);
    if (!current) missing(WAYS.noService(id));
    if (Object.hasOwn(patch, 'slug')) invalid(WAYS.slugFixed);
    const next = {};
    if (patch.name !== undefined) next.name = parseName(patch.name, WAYS.serviceName);
    if (patch.owners !== undefined) next.owners = parseOwners(patch.owners);
    if (patch.tier !== undefined) next.tier = parseTier(patch.tier);
    if (patch.description !== undefined) next.description = parseDescription(patch.description);
    if (patch.repository !== undefined) {
      // Another kind than the record's is a change whatever its address.
      const named = namedSource(patch.repository);
      if (named && named !== current.repository?.kind) refuseSourceOff(db, named);
      // Within a source switched off, an address the parse refuses is a change too:
      // the switch's 409 comes first, as on a create.
      try { next.repository = parseRepository(patch.repository, { caller }); }
      catch (e) { if (named && e instanceof AdminRefusal) refuseSourceOff(db, named); throw e; }
    }
    const changed = changedFields(current, next);
    if (changed.includes('repository') && next.repository) refuseSourceOff(db, next.repository.kind);
    if (!changed.length) return { service: current, changed };
    const service = updateService(db, actor, id, Object.fromEntries(changed.map((k) => [k, next[k]])));
    return { service, changed };
  });
}

// → { service: ServiceView (as it was), environments: n, packLinks: n,
// waivers: n }. The packs stay registered; their links cascade with the
// environments, and so do the record's waivers (GAP batch 2, B3.2 —
// history included).
export function deleteServiceFromApi(db, actor, id) {
  return atomic(db, () => {
    const current = getService(db, id);
    if (!current) missing(WAYS.noService(id));
    const view = serviceViewOf(db, current);
    const environments = view.environments.length;
    const packLinks = view.packs.length;
    const waivers = countWaivers(db, id);
    deleteService(db, actor, id, { detail: { environments, packLinks, waivers } });
    return { service: view, environments, packLinks, waivers };
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

// `caller` (mcpCallerOf(req)) is required, as for resolveMcpTarget: the
// origin rule at registration reads who registers (D4: without sign-in only
// a loopback MCP or a listed origin).
export function createMcpEndpointFromApi(db, actor, { name, url, readTokenEnv } = {}, { caller } = {}) {
  needCaller('createMcpEndpointFromApi', caller);
  name = parseName(name, WAYS.mcpEndpointName);
  return atomic(db, () => {
    const existing = listMcpEndpoints(db).find((ep) => ep.name === name);
    if (existing) refuse(WAYS.mcpEndpointExists(existing));
    // The URL and env-var rules are the repository's (TypeError → 400); the
    // origin rule then judges the record as written, and a refusal undoes
    // the row and its audit row with it.
    const endpoint = createMcpEndpoint(db, actor, { name, url, readTokenEnv: readTokenEnv === undefined ? null : readTokenEnv });
    checkRegistration(db, endpoint, caller);
    return endpoint;
  });
}

function needCaller(fn, caller) {
  if (!caller || typeof caller !== 'object') throw new TypeError(`${fn}: the caller (mcpCallerOf(req)) is required`);
}

// The origin rule at registration (mcp-target-policy.mjs): an endpoint that
// names readTokenEnv carries the server's credential; the caller decides
// whether an unlisted origin may be registered at all (D4).
function checkRegistration(db, ep, caller) {
  const refusal = mcpOriginDecision(db, ep.url, {
    use: 'register', credential: credentialThatRides({ serverToken: !!ep.readTokenEnv, hook: false }), tokenVar: ep.readTokenEnv, caller,
  });
  if (refusal) invalid(refusal.error);
}

// → { endpoint, changed }; `readTokenEnv: null` clears it. `caller` as for
// createMcpEndpointFromApi.
export function updateMcpEndpointFromApi(db, actor, id, patch = {}, { caller } = {}) {
  needCaller('updateMcpEndpointFromApi', caller);
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
    // A new URL or variable meets the origin rule against the state after
    // the change; a rename alone does not.
    if (changed.includes('url') || changed.includes('readTokenEnv')) checkRegistration(db, endpoint, caller);
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
    repository: service.repository ?? null,
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

// Does a typed URL carry user:password? (native fetch cannot send it, and
// would repeat it in its error.) An unparseable URL is validateMcpUrl's.
function hasUserinfo(raw) {
  try { const u = new URL(raw); return !!(u.username || u.password); } catch { return false; }
}

// How a route reads its MCP target from the body: `mcpUrl` as today, or
// `mcpEndpointId` — the org's endpoint record, whose URL is fetched and
// whose READ token (forWrite: false — refresh-live, draft-from-mcp) comes
// from the named variable when the request sends no mcpAuth, after the
// variable's ownership is checked again against the orgs that exist now,
// and that it is no org's notify hook variable (a name registered before
// that rule; a hook's variables go only to its webhook).
// With forWrite (deploy, rollback) the record's URL only: write tokens
// stay per-request pass-through. `caller` (mcpCallerOf(req)) is required —
// a call site that names none throws, fail closed. A typed URL with
// userinfo is a 400; then the typed-URL rule (typedMcpUrlDecision: admin
// and above; never the anonymous local caller) — at every call site, the
// deploy routes included (decision D3). The SSRF rule (validateMcpUrl) runs next, then the origin allowlist
// (server/mcp-target-policy.mjs: no credential leaves for an unlisted
// origin but loopback). Returns { mcpUrl, safeMcpUrl, mcpAuth, endpoint },
// or { status: 400, error } / { status: 403, denied, error }
// (mcpRefusalBody answers it); the token's value is in mcpAuth alone.
export function resolveMcpTarget(db, body = {}, { forWrite = false, caller } = {}) {
  if (!caller || typeof caller !== 'object') throw new TypeError('resolveMcpTarget: the caller (mcpCallerOf(req)) is required');
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
  let serverVar = null;   // the variable whose value rides, when one does
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
      if (isOrgHookShaped(db, ep.readTokenEnv)) return bad(`${envNameHookText(db, ep.readTokenEnv, org)}${WAYS.anotherVariable(ep.id)}`);
    }
    mcpUrl = ep.url;
    mcpAuth = sentAuth ?? (readsToken ? process.env[ep.readTokenEnv] ?? MISSING : null);
    if (mcpAuth === MISSING) return bad(WAYS.tokenUnset(ep));
    if (readsToken && !sentAuth) serverVar = ep.readTokenEnv;
    endpoint = { id: ep.id, name: ep.name };
  } else {
    if (!sentUrl) return bad(WAYS.neitherTarget);
    if (hasUserinfo(sentUrl)) return bad(WAYS.typedUserinfo);
    const refusal = typedMcpUrlDecision(caller);
    if (refusal) return refusal;
    mcpUrl = sentUrl;
    mcpAuth = sentAuth;
  }
  const { error, safeUrl } = validateMcpUrl(mcpUrl);
  if (error) return bad(error);
  // The origin rule (server/mcp-target-policy.mjs, every caller): the
  // strongest credential that rides — the endpoint's variable, the
  // request's mcpAuth, one in a typed URL, a loaded transport hook.
  const credential = credentialThatRides({ serverToken: !!serverVar, requestToken: !!sentAuth, url: endpoint ? null : mcpUrl });
  const refusal = mcpOriginDecision(db, mcpUrl, { use: endpoint ? 'registered' : 'typed', credential, caller, tokenVar: serverVar });
  if (refusal) return refusal;
  return { mcpUrl, safeMcpUrl: safeUrl, mcpAuth, endpoint };
}

// ---------- a journey's live Pack B (R4, decision D6) ----------
//
// A Pack B annotation is free text (any operator may register a pack), so
// a journey's live source is a caller-supplied URL like any other. Capture
// resolves it to one of the org's registered endpoints whose safe URL is
// the annotation's; without one, an admin's capture keeps the URL (it
// passes the typed-URL and origin rules then), anyone else's saves Pack B
// as a file. A server-run journey fetches through resolveMcpTarget with the
// runner's caller: endpointId by id, a raw url as a typed URL (an admin's).
// The def's authEnv is never read on the server.

// The source capture writes for a Pack B whose mcp.url is `url` →
// { mcp: { url, endpointId } } | { mcp: { url } } (an admin's) | null (save
// it as a file) | a refusal { status, error, denied? }.
export function journeyPackBSource(db, url, { caller } = {}) {
  if (!caller || typeof caller !== 'object') throw new TypeError('journeyPackBSource: the caller (mcpCallerOf(req)) is required');
  const safe = safeMcpUrl(String(url));
  const ep = safe ? listMcpEndpoints(db).find((e) => safeMcpUrl(e.url) === safe) : null;
  if (ep) return { mcp: { url: String(url), endpointId: ep.id } };
  if (typedMcpUrlDecision(caller)) return null;
  const t = resolveMcpTarget(db, { mcpUrl: String(url) }, { caller });
  return t.status ? t : { mcp: { url: String(url) } };
}

// A server-run journey's Pack B target: resolveMcpTarget's answer, or a
// refusal naming the way out for the runner — a raw url below the typed-URL
// role is refused before any wire call.
export function resolveJourneyMcp(db, mcp = {}, { caller } = {}) {
  if (!caller || typeof caller !== 'object') throw new TypeError('resolveJourneyMcp: the caller (mcpCallerOf(req)) is required');
  if (mcp.endpointId !== undefined && mcp.endpointId !== null) return resolveMcpTarget(db, { mcpEndpointId: mcp.endpointId }, { caller });
  if (typeof mcp.url !== 'string' || !mcp.url.trim()) return { status: 400, error: "this journey's Pack B names no MCP — give packB.mcp.url, or re-capture it" };
  const refusal = typedMcpUrlDecision(caller);
  if (refusal) {
    const origin = originOf(mcp.url.trim()) ?? 'an MCP';
    return { ...refusal, error: `this journey's Pack B fetches ${origin}, ${journeyTypedWay(caller, refusal)}` };
  }
  return resolveMcpTarget(db, { mcpUrl: mcp.url }, { caller });
}

function journeyTypedWay(caller, refusal) {
  if (refusal.denied === 'posture') {
    return caller.posture === 'open-exposed'
      ? `an MCP URL a server without sign-in never sends, and MCP endpoints cannot be registered while it is exposed — ${exposedWay(caller)}`
      : `an MCP URL a server without sign-in never sends — register the endpoint in Settings → MCP endpoints from http://127.0.0.1:${caller.port ?? '<port>'} (a loopback MCP, or an origin listed in OBSERVOGRAM_MCP_ORIGINS) and re-capture the journey (Pack B then names it)`;
  }
  const tail = caller.principal?.kind === 'bearer' && caller.posture === 'token' ? `; ${noSignInWay(caller)}` : '';
  return `an MCP URL only an admin may send — an admin re-captures it (Pack B then names a registered endpoint), or registers the endpoint and re-captures${tail}`;
}
