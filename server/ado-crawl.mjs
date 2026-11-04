// server/ado-crawl.mjs — an Azure DevOps repository as a scan source, the
// sibling of server/github-crawl.mjs.
//
// Server-only: adoFetch reads AZURE_DEVOPS_TOKEN (a personal access token
// with Code (Read)) from the environment, as ghFetch reads GITHUB_TOKEN.
// parseAdoUrl and adoHostRefusal are pure.
//
// Where the token goes: only to Azure DevOps Services (dev.azure.com and
// <org>.visualstudio.com) or to an Azure DevOps Server origin the server
// lists in OBSERVOGRAM_ADO_ORIGINS (comma-separated https origins). Any other
// host is refused before a request is made — a repository URL is typed by
// a person, and the token is the server's.
//
// The REST calls (api-version 7.0, available on Services and on Server 2022):
//   GET {base}/{project}/_apis/git/repositories/{repo}/items?recursionLevel=Full
//       → { value: [{ path, gitObjectType: 'blob' | 'tree', … }] }
//   GET {base}/{project}/_apis/git/repositories/{repo}/items?path=…&includeContent=true
//       → { content, … }
// with versionDescriptor.version=<branch> when the repository names one
// (else the repository's default branch).

const SERVICES_HOST = /^(?:dev\.azure\.com|[a-z0-9][a-z0-9-]*\.visualstudio\.com)$/i;
const SEGMENT = /^[^/?#\s][^/?#]*$/;
const API_VERSION = '7.0';

// The origins of an Azure DevOps Server the server lists (https only).
export function listedAdoOrigins(raw = process.env.OBSERVOGRAM_ADO_ORIGINS) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    try { const u = new URL(s); return u.protocol === 'https:' ? u.origin.toLowerCase() : null; } catch { return null; }
  }).filter(Boolean);
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

// The one authenticated wrapper around the Azure DevOps REST API. A refused
// host never reaches fetch. Azure DevOps answers an unauthenticated call
// with 203 and a sign-in page, or 401: both read as "the token".
export async function adoFetch(url, { fetchImpl = fetch, token = process.env.AZURE_DEVOPS_TOKEN } = {}) {
  const why = adoHostRefusal(new URL(url).origin);
  if (why) { const err = new Error(`Azure DevOps: ${why}`); err.status = 400; throw err; }
  const headers = { Accept: 'application/json', 'User-Agent': 'observogram-crawler/1.0', 'Accept-Encoding': 'identity' };
  if (token) headers.Authorization = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  const res = await fetchImpl(url, { headers, redirect: 'error' });
  const ct = res.headers.get('content-type') || '';
  if (res.status === 203 || res.status === 401 || (res.ok && !ct.includes('json'))) {
    const err = new Error(`Azure DevOps ${res.status === 203 ? 401 : res.status}: ${token ? 'the token in AZURE_DEVOPS_TOKEN was refused' : 'sign-in needed — set AZURE_DEVOPS_TOKEN on the server (a personal access token with Code (Read))'}`);
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
  return res.json();
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
