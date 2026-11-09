// server/ado-crawl.mjs — an Azure DevOps repository as a scan source, the
// sibling of server/github-crawl.mjs.
//
// Server-only: adoFetch sends the token its caller names (a personal access
// token with Code (Read)) and no other — the person's own, or the server's
// AZURE_DEVOPS_TOKEN on a server without sign-in (server/repo-auth.mjs), as
// ghFetch does for GitHub. parseAdoUrl and adoHostRefusal are pure.
//
// Where the token goes: only to Azure DevOps Services (dev.azure.com and
// <org>.visualstudio.com) or to an Azure DevOps Server origin the server
// lists in OBSERVOGRAM_ADO_ORIGINS (comma-separated https origins). Any other
// host is refused before a request is made — a repository URL is typed by
// a person, and the token is theirs or the server's.
//
// The REST calls (api-version 7.0, available on Services and on Server 2022):
//   GET {base}/{project}/_apis/git/repositories/{repo}/items?recursionLevel=Full
//       → { value: [{ path, gitObjectType: 'blob' | 'tree', … }] }
//   GET {base}/{project}/_apis/git/repositories/{repo}/items?path=…&includeContent=true
//       → { content, … }
// with versionDescriptor.version=<branch> when the repository names one
// (else the repository's default branch).

import { READ_TIMEOUT_MS, unreachable } from './fetch-failure.mjs';

const SERVICES_HOST = /^(?:dev\.azure\.com|[a-z0-9][a-z0-9-]*\.visualstudio\.com)$/i;
const SEGMENT = /^[^/?#\s][^/?#]*$/;
const API_VERSION = '7.0';

// The origins of an Azure DevOps Server the server lists (https only).
export function listedAdoOrigins(raw = process.env.OBSERVOGRAM_ADO_ORIGINS) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    try { const u = new URL(s); return u.protocol === 'https:' ? u.origin.toLowerCase() : null; } catch { return null; }
  }).filter(Boolean);
}

// Whether a repository URL is on Azure DevOps Services, where the person's
// Entra ID sign-in reads (server/repo-sign-in.mjs); an Azure DevOps Server
// takes a personal access token only.
export function isAdoServices(location) {
  try { const u = new URL(location); return u.protocol === 'https:' && SERVICES_HOST.test(u.hostname); } catch { return false; }
}

// Why the server will not fetch from this origin, or '' when it will.
export function adoHostRefusal(origin, { listed = listedAdoOrigins() } = {}) {
  let u;
  try { u = new URL(origin); } catch { return 'it is not a URL'; }
  if (u.protocol !== 'https:') return 'an Azure DevOps repository is fetched over https only';
  if (SERVICES_HOST.test(u.hostname)) return '';
  if (listed.includes(u.origin.toLowerCase())) return '';
  return `${u.origin} is not Azure DevOps Services (dev.azure.com, <org>.visualstudio.com) — an Azure DevOps Server is fetched only when its origin is listed in OBSERVOGRAM_ADO_ORIGINS on the server`;
}

const decodeSegment = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// A repository URL as the web or a clone shows it →
//   { base, project, repo, ref, location } | null
//   https://dev.azure.com/{org}/{project}/_git/{repo}
//   https://{user}@dev.azure.com/{org}/{project}/_git/{repo}   (a clone URL: the user is dropped)
//   https://{org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}
//   https://{server}[/{path}]/{collection}/{project}/_git/{repo}   (Azure DevOps Server)
//   …/_git/{repo} with the project left out when the repository is named after it
//   ?version=GB{branch} names a branch.
// `location` is the URL without user, query or fragment; `base` is
// everything before the project ({org} on Services, the collection on Server).
export function parseAdoUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let u;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('_git');
  if (at < 0 || at !== parts.length - 2) return null;
  const repo = decodeSegment(parts[at + 1]).replace(/\.git$/i, '');
  const before = parts.slice(0, at);
  // The base has at least minBase segments: the org on dev.azure.com, none on
  // <org>.visualstudio.com, the collection on a Server. With no segment
  // between the base and _git, the project is left out: it is the
  // repository's name.
  const devAzure = /^dev\.azure\.com$/i.test(u.hostname);
  const minBase = devAzure || !SERVICES_HOST.test(u.hostname) ? 1 : 0;
  let baseParts, project;
  if (before.length > minBase) { project = decodeSegment(before[before.length - 1]); baseParts = before.slice(0, -1); }
  else { project = repo; baseParts = before; }
  if (!repo || !project || !SEGMENT.test(repo) || !SEGMENT.test(project)) return null;
  if (devAzure ? baseParts.length !== 1 : baseParts.length < minBase) return null;   // dev.azure.com/{org}/…, a Server's collection
  const base = `${u.origin}${baseParts.length ? `/${baseParts.join('/')}` : ''}`;
  const version = u.searchParams.get('version') || '';
  const ref = /^GB.+/.test(version) ? version.slice(2) : null;
  const enc = encodeURIComponent;
  const location = `${base}/${enc(project)}/_git/${enc(repo)}`;
  return { base, project, repo, ref, location };
}

// A refused Entra ID sign-in, when the tenants say why: Azure DevOps's
// refusal names the tenant the organization signs in through
// (`WWW-Authenticate: Bearer authorization_uri=https://login.microsoftonline.com/<tenant>`),
// and the sign-in's access token names its own (the JWT's `tid`, read, never
// verified: it only words the sentence). → { organization, yours } when both
// are known and differ, else null. Tenant ids are not secrets; the token
// itself never leaves this function.
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTHORIZATION_URI = /authorization_uri="?https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=["/\s,]|$)/gi;
export function tenantMismatch(wwwAuthenticate, token) {
  const found = [...String(wwwAuthenticate || '').matchAll(AUTHORIZATION_URI)];
  const organization = found.length ? found[0][1].toLowerCase() : null;
  let yours = null;
  try {
    const payload = JSON.parse(Buffer.from(String(token || '').split('.')[1] || '', 'base64url').toString('utf8'));
    if (typeof payload?.tid === 'string' && TENANT_ID.test(payload.tid)) yours = payload.tid.toLowerCase();
  } catch { /* not a JWT: nothing to compare */ }
  return organization && yours && organization !== yours ? { organization, yours } : null;
}

// Whether a redirect is Azure DevOps's way to its sign-in page: a Location
// on its identity service's /_signin, or Entra ID's sign-in, or a challenge
// beside it. Any other redirect (a moved host, a proxy) is not a refusal.
export function isSignInRedirect(location, base, wwwAuthenticate = null) {
  if (wwwAuthenticate) return true;
  let u;
  try { u = new URL(String(location || ''), base); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return (/\.vssps\.visualstudio\.com$/i.test(u.hostname) && /^\/_signin\b/i.test(u.pathname)) || /^login\.microsoftonline\.com$/i.test(u.hostname);
}

// The one authenticated wrapper around the Azure DevOps REST API. A refused
// host never reaches fetch.
//
// How Azure DevOps refuses a read it will not serve (no token, a wrong one, a
// sign-in it does not take): with `X-TFS-FedAuthRedirect: Suppress`, sent on
// every call, a 401 with JSON (TF400813) — measured against dev.azure.com
// on 2026-11-07. Without it, Services answers a 302 to its sign-in page
// (https://<x>.vssps.visualstudio.com/_signin), and an older host may answer
// 203 with a sign-in page: all of these read as the token. A redirect is read,
// never followed, so the token goes to the repository's host and nowhere
// else; a redirect anywhere else is named as one — to another host (give the
// address that host serves), or to a page on the request's own host (a
// sign-in page or a proxy in front of the repository answers instead of it:
// nothing to re-address, and no token asked for). A host the server cannot
// reach, or whose answer cannot be read to the end, says why
// (server/fetch-failure.mjs).
//
// The sentence is the fact, for whoever can fix it; the Run's tail
// (server/repo-auth.mjs repoAuthTail) says what the person can do here:
//   none     "this repository is not public"
//   request  "not authorised to read this repository"
//   link     the same, and the two tenants when they differ
//   server   "the token in AZURE_DEVOPS_TOKEN was refused" (no tail: the operator's to fix)
// A personal access token goes as Basic; the person's Entra ID sign-in
// ('link', server/repo-sign-in.mjs) as a Bearer token.
export async function adoFetch(url, { fetchImpl = fetch, token = null, tokenSource = token ? 'server' : 'none' } = {}) {
  const why = adoHostRefusal(new URL(url).origin);
  if (why) { const err = new Error(`Azure DevOps: ${why}`); err.status = 400; throw err; }
  if (tokenSource === 'link' && !isAdoServices(url)) {
    const err = new Error(`Azure DevOps: an Azure DevOps sign-in reads Azure DevOps Services only — ${new URL(url).origin} takes a personal access token`);
    err.status = 400;
    throw err;
  }
  const headers = { Accept: 'application/json', 'User-Agent': 'observogram-crawler/1.0', 'Accept-Encoding': 'identity', 'X-TFS-FedAuthRedirect': 'Suppress' };
  if (token) headers.Authorization = tokenSource === 'link' ? `Bearer ${token}` : `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  let res;
  try { res = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) }); }
  catch (e) { throw unreachable('Azure DevOps', url, e); }
  const ct = res.headers.get('content-type') || '';
  const www = res.headers.get('www-authenticate');
  const redirected = res.status >= 300 && res.status < 400;
  if (redirected && !isSignInRedirect(res.headers.get('location'), url, www)) {
    const requested = new URL(url);
    const origin = requested.origin;
    let target = null;
    const location = res.headers.get('location');
    if (location) { try { target = new URL(location, url); } catch { /* no usable Location */ } }
    // The same host, whatever the scheme or port (http: on an https host, a
    // sign-in port beside the repository's): a sign-in page (a Server that
    // ignores the suppress header, a sign-in proxy) or a proxy answers for
    // the repository, so there is no other address to give — and an http:
    // one could not be given anyway, adoHostRefusal taking https only. The
    // pathname only: the query may carry a reply address. No Location, or
    // one with no host in it (an opaque origin, which the URL reads as
    // "null"): another address, unnamed.
    const named = target && target.origin !== 'null';
    if (named && target.hostname === requested.hostname) {
      throw new Error(`Azure DevOps ${res.status}: ${origin} redirects this read to ${target.pathname} on the same host, which the server does not follow — a sign-in page or a proxy in front of the repository answers instead of it`);
    }
    throw new Error(`Azure DevOps ${res.status}: ${origin} redirects this read to ${named ? target.origin : 'another address'}, which the server does not follow — give the repository's address on the host that serves it`);
  }
  if (res.status === 203 || res.status === 401 || redirected || (res.ok && !ct.includes('json'))) {
    const tenants = tokenSource === 'link' ? tenantMismatch(www, token) : null;
    const fact = tokenSource === 'request' ? 'not authorised to read this repository'
      : tokenSource === 'link' ? `not authorised to read this repository${tenants ? `: this organization signs in through Entra tenant ${tenants.organization}, and your sign-in is for tenant ${tenants.yours}` : ''}`
      : token ? 'the token in AZURE_DEVOPS_TOKEN was refused'
        : 'this repository is not public';
    const err = new Error(`Azure DevOps 401: ${fact}`);
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let text = body.slice(0, 200);
    try { text = JSON.parse(body).message || text; } catch { /* keep the raw slice */ }
    const err = new Error(`Azure DevOps ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  // The body: the status was read, so an answer that does not finish or
  // cannot be read to the end is said as that, not as the host not reached
  // (unreachable leaves a body that is not JSON as the SyntaxError it was).
  try { return await res.json(); }
  catch (e) { throw unreachable('Azure DevOps', url, e, { answered: true }); }
}

const itemsUrl = (repo, params) => {
  const enc = encodeURIComponent;
  const q = new URLSearchParams({ ...params, 'api-version': API_VERSION });
  if (repo.ref) { q.set('versionDescriptor.version', repo.ref); q.set('versionDescriptor.versionType', 'branch'); }
  return `${repo.base}/${enc(repo.project)}/_apis/git/repositories/${enc(repo.repo)}/items?${q}`;
};

// The repository's tree as GitHub's tree API shapes it ({ type: 'blob', path }),
// so selectCrawlerFiles filters both alike; paths lose ADO's leading slash.
export async function adoTree(repo, opts = {}) {
  const doc = await adoFetch(itemsUrl(repo, { scopePath: '/', recursionLevel: 'Full' }), opts);
  return (Array.isArray(doc?.value) ? doc.value : [])
    .filter((i) => i && i.gitObjectType === 'blob' && typeof i.path === 'string')
    .map((i) => ({ type: 'blob', path: i.path.replace(/^\/+/, '') }));
}

// One file's text.
export async function adoFileText(repo, path, opts = {}) {
  const doc = await adoFetch(itemsUrl(repo, { path: `/${path}`, includeContent: 'true' }), opts);
  return typeof doc?.content === 'string' ? doc.content : '';
}
