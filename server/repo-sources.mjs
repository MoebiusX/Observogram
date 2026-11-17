// server/repo-sources.mjs — a service's repository, read for its Run.
//
// fetchRepositoryFiles(repository, { crawlScope }) reads what the crawler
// looks at from where the service record says its declaration lives
// (server/service-admin.mjs parseRepository's { kind, location, ref }):
//   github  GitHub's tree and contents API (server/github-crawl.mjs), with the
//           `credential`'s token when there is one (a private repository)
//   ado     Azure DevOps' items API (server/ado-crawl.mjs), with the same
// `credential` is server/repo-auth.mjs repositoryCredential's answer: the
// person's own token, the server's on a server without sign-in, or none.
//   path    a folder on the server, walked under the org's crawl scope
//           (tools/lib/journey.mjs scanRepoFolder — never another org's part
//           of the workspace), its .gitignore files honoured
//   upload  the copy the person uploaded from their own machine
//           (server/repository-uploads.mjs), read by `readUpload()`
// Every door reads by the crawler's own rule (tools/lib/crawler.mjs
// scanReadsPath): a host read downloads what the rule takes, its keywords
// only ordering the files under its 200-file cap (server/github-crawl.mjs
// planCrawlerFetch), at most 8 files at a time, each under its own 60 s
// deadline and all under one 120 s budget (downloadFiles: a file the host
// refused or dropped is tried again — after the wait it asks for, else a
// backoff — and the read slows down for every file after a refusal; a file
// still failing, or one the time ran out for, is skipped and named, never
// fatal); the repository and tree reads are tried again the same way, each
// under a 90 s budget of its own (retryRead); a secrets file is never read.
// → { files, ref, candidates, capped, cappedFiles, fileCap, truncated, skipped, source } —
// `files` the map crawlFiles() takes, in path order; `candidates` how many
// files the rule takes (a host's tree; a folder or an upload: those read and
// those the read did not, the ones left out on purpose aside); `capped` how
// many of them a host read's file cap left out (`cappedFiles` their paths,
// `fileCap` the cap); `truncated` the host cut its tree listing short;
// `skipped` [{ path, why }], every file the rule would read and this read did
// not (tools/lib/crawler.mjs scanSkipKind tells a loss from a limit and from
// a file left out on purpose); `source` the words for where it came from. A
// repository the host refuses throws with the host's status.
//
// partialScanPolicy(): what a service's Run does with a scan that lost files
// (server/index.mjs POST /api/services/:id/run) — OBSERVOGRAM_PARTIAL_SCAN,
// read on each Run: `stop` (the default) keeps the service's last complete
// scan of the same repository and stops, `check` checks the partial scan,
// marked partial.
//
// repositoryKey(repository): which repository a { kind, location } names,
// whatever way its address was written — what "the same repository" means.

import { statSync } from 'node:fs';
import { scanRepoFolder } from '../tools/lib/journey.mjs';
import { scanRefusal, scanSkipKind } from '../tools/lib/crawler.mjs';
import { brandEnv } from '../tools/lib/brand-env.mjs';
import { HOST_READ_CAPS, downloadFiles, fetchGithubFiles, parseGithubUrl, planCrawlerFetch, retryRead, settleFetched } from './github-crawl.mjs';
import { adoFileText, adoTree, parseAdoUrl } from './ado-crawl.mjs';
import { UPLOAD_WAYS } from './repository-uploads.mjs';

const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

export const PARTIAL_SCAN_POLICIES = Object.freeze(['stop', 'check']);
let warnedPolicy = null;
export function partialScanPolicy(raw = brandEnv('PARTIAL_SCAN')) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return 'stop';
  if (PARTIAL_SCAN_POLICIES.includes(value)) return value;
  if (warnedPolicy !== value) {
    warnedPolicy = value;
    process.stderr.write(`[service-run] OBSERVOGRAM_PARTIAL_SCAN=${JSON.stringify(String(raw)).slice(1, -1).slice(0, 40)} is not stop or check: stop is used\n`);
  }
  return 'stop';
}

// The one name of the repository a { kind, location } names (a service's repository, a scan's
// `access`), for "is this the same repository": the host and the organisation as well as the
// names — GitHub's owner and repository; Azure DevOps' organisation (dev.azure.com/{org} and
// {org}.visualstudio.com are one) or a Server's origin and collection, then the project and the
// repository — each without case, as both hosts compare them; a folder's or an upload's location
// as written. null for anything that names none.
export function repositoryKey(repository) {
  const kind = repository?.kind;
  const location = typeof repository?.location === 'string' ? repository.location.trim() : '';
  if (!location) return null;
  if (kind === 'github') {
    const gh = parseGithubUrl(location);
    return gh ? `github:${gh.owner}/${gh.repo}`.toLowerCase() : null;
  }
  if (kind === 'ado') {
    const ado = parseAdoUrl(location);
    if (!ado) return null;
    // parseAdoUrl's base is the origin and then the segments before the project: the organisation on
    // dev.azure.com, none or a collection on {org}.visualstudio.com, the collection on a Server.
    const { origin, hostname } = new URL(ado.base);
    const segments = ado.base.slice(origin.length).split('/').filter(Boolean);
    const org = /^dev\.azure\.com$/i.test(hostname) ? segments[0]
      : /\.visualstudio\.com$/i.test(hostname) ? hostname.split('.')[0] : null;
    const where = org ? `services/${org}` : [origin, ...segments].join('/');
    return `ado:${where}/${ado.project}/${ado.repo}`.toLowerCase();
  }
  if (kind === 'path' || kind === 'upload') return `${kind}:${location}`;
  return null;
}

// A folder's or an upload's count of the files the rule takes: those read, and those not read
// but for the ones left out on purpose (a secrets file, one git ignores).
const takenCount = (files, skipped) => Object.keys(files).length + skipped.filter((s) => scanSkipKind(s?.why) !== 'on-purpose').length;

// Azure DevOps: the tree (under a budget of its own, tried again as a file is:
// retryRead), the crawler's files (planCrawlerFetch, as GitHub), downloaded as
// a GitHub read's are (downloadFiles: at most 8 at a time, 60 s each, 120 s
// together, a refused or dropped file tried again, one still failing skipped
// and named) and settled in the plan's order (its tree carries no sizes, so
// the caps apply to the texts). `limits` is the test seam.
async function fetchAdoFiles(location, ref, opts = {}, limits = {}) {
  const parsed = parseAdoUrl(location);
  if (!parsed) { const err = new Error(`${location} is not an Azure DevOps repository URL`); err.status = 400; throw err; }
  const repo = { ...parsed, ref: ref ?? parsed.ref ?? null };
  const tree = await retryRead((signal) => adoTree(repo, { ...opts, signal }), limits);
  const plan = planCrawlerFetch(tree, HOST_READ_CAPS);
  const texts = await downloadFiles(plan.selected, (node, signal) => adoFileText(repo, node.path, { ...opts, signal }), limits);
  const { files, skipped } = settleFetched(plan.selected, texts, { ...HOST_READ_CAPS, planned: plan.skipped });
  return { files, ref: repo.ref, candidates: plan.candidates, capped: plan.capped, cappedFiles: plan.cappedFiles, fileCap: HOST_READ_CAPS.maxFiles, truncated: false, skipped, source: `${repo.project}/${repo.repo} on Azure DevOps` };
}

// An uploaded copy: the files its browser read (the rule applied there, its
// .gitignore files honoured), what the browser named as not read, and —
// for a copy kept before the server refused them — any secrets file, left
// out here and named.
function readUploadedCopy(copy) {
  const files = {};
  const skipped = Array.isArray(copy.skipped) ? copy.skipped.filter((x) => x && typeof x.path === 'string').map((x) => ({ path: x.path, why: String(x.why || '') })) : [];
  for (const path of Object.keys(copy.files).sort()) {
    const why = scanRefusal(path);
    if (why) skipped.push({ path, why });
    else files[path] = copy.files[path];
  }
  return { files, skipped: skipped.sort(byPath) };
}

// `fetchImpl` (Azure DevOps), `ghFetchFn` and `rawFn` (GitHub) and `limits`
// (both hosts' downloadFiles and retryRead: { parallel, budgetMs, attempts,
// backoffMs, maxWaitMs, now, sleep, random }) are the test seams; the folder
// and upload kinds have no downloads, so `limits` means nothing there.
export async function fetchRepositoryFiles(repository, { crawlScope = null, readUpload = null, credential = null, fetchImpl, ghFetchFn, rawFn, limits = {} } = {}) {
  const token = credential?.token || null;
  const kind = repository?.kind;
  if (kind === 'upload') {
    const copy = typeof readUpload === 'function' ? readUpload() : null;
    if (!copy) { const err = new Error(UPLOAD_WAYS.gone(repository.location)); err.status = 404; throw err; }
    const { files, skipped } = readUploadedCopy(copy);
    return { files, ref: null, candidates: takenCount(files, skipped), capped: 0, truncated: false, skipped, source: `the upload ${copy.name}` };
  }
  if (kind === 'github') {
    const gh = parseGithubUrl(repository.location);
    if (!gh) { const err = new Error(`${repository.location} is not a GitHub repository`); err.status = 400; throw err; }
    const seams = { token, limits, ...(ghFetchFn ? { fetchFn: ghFetchFn } : {}), ...(rawFn !== undefined ? { rawFn } : {}) };
    const out = await fetchGithubFiles({ owner: gh.owner, repo: gh.repo, ref: repository.ref ?? gh.ref ?? null }, seams);
    return { files: out.files, ref: out.ref, candidates: out.candidates, capped: out.capped, cappedFiles: out.cappedFiles, fileCap: out.fileCap, truncated: out.truncated, skipped: out.skipped, source: `${gh.owner}/${gh.repo} on GitHub` };
  }
  if (kind === 'ado') return fetchAdoFiles(repository.location, repository.ref ?? null, { ...(fetchImpl ? { fetchImpl } : {}), token, tokenSource: credential?.source || (token ? 'server' : 'none') }, limits);
  if (kind === 'path') {
    let isDir = false;
    try { isDir = statSync(repository.location).isDirectory(); } catch { /* not there */ }
    if (!isDir) { const err = new Error(`no folder ${repository.location} on the server`); err.status = 404; throw err; }
    let read;
    try { read = scanRepoFolder(repository.location, { scope: crawlScope }); }
    catch (e) { const err = new Error(e.message); err.status = 403; throw err; }
    return { files: read.files, ref: null, candidates: takenCount(read.files, read.skipped), capped: 0, truncated: false, skipped: read.skipped, source: `the folder ${repository.location}` };
  }
  const err = new Error(`a repository of kind ${JSON.stringify(kind)} cannot be read`);
  err.status = 400;
  throw err;
}
