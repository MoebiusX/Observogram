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
// planCrawlerFetch); a secrets file is never read.
// → { files, ref, candidates, capped, truncated, skipped, source } — `files`
// the map crawlFiles() takes, in path order; `candidates` how many files the
// rule takes (a host's tree; a folder or an upload: those read); `capped`
// how many of them a host read's file cap left out; `truncated` the host cut
// its tree listing short; `skipped` [{ path, why }], every file the rule
// would read and this read did not; `source` the words for where it came
// from. A repository the host refuses throws with the host's status.

import { statSync } from 'node:fs';
import { scanRepoFolder } from '../tools/lib/journey.mjs';
import { scanRefusal } from '../tools/lib/crawler.mjs';
import { HOST_READ_CAPS, fetchGithubFiles, parseGithubUrl, planCrawlerFetch, settleFetched } from './github-crawl.mjs';
import { adoFileText, adoTree, parseAdoUrl } from './ado-crawl.mjs';
import { UPLOAD_WAYS } from './repository-uploads.mjs';

const PARALLEL = 8;
const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

// Azure DevOps: the tree, the crawler's files (planCrawlerFetch, as GitHub),
// each downloaded — at most PARALLEL at once — and settled in the plan's
// order (its tree carries no sizes, so the caps apply to the texts).
async function fetchAdoFiles(location, ref, opts = {}) {
  const parsed = parseAdoUrl(location);
  if (!parsed) { const err = new Error(`${location} is not an Azure DevOps repository URL`); err.status = 400; throw err; }
  const repo = { ...parsed, ref: ref ?? parsed.ref ?? null };
  const tree = await adoTree(repo, opts);
  const plan = planCrawlerFetch(tree, HOST_READ_CAPS);
  const texts = new Map();
  for (let i = 0; i < plan.selected.length; i += PARALLEL) {
    await Promise.all(plan.selected.slice(i, i + PARALLEL).map(async (node) => {
      try { texts.set(node.path, { text: await adoFileText(repo, node.path, opts) }); }
      catch (e) { texts.set(node.path, { error: e.message }); }
    }));
  }
  const { files, skipped } = settleFetched(plan.selected, texts, { ...HOST_READ_CAPS, planned: plan.skipped });
  return { files, ref: repo.ref, candidates: plan.candidates, capped: plan.capped, truncated: false, skipped, source: `${repo.project}/${repo.repo} on Azure DevOps` };
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

// `fetchImpl` (Azure DevOps), `ghFetchFn` and `rawFn` (GitHub) are the test seams.
export async function fetchRepositoryFiles(repository, { crawlScope = null, readUpload = null, credential = null, fetchImpl, ghFetchFn, rawFn } = {}) {
  const token = credential?.token || null;
  const kind = repository?.kind;
  if (kind === 'upload') {
    const copy = typeof readUpload === 'function' ? readUpload() : null;
    if (!copy) { const err = new Error(UPLOAD_WAYS.gone(repository.location)); err.status = 404; throw err; }
    const { files, skipped } = readUploadedCopy(copy);
    return { files, ref: null, candidates: Object.keys(files).length, capped: 0, truncated: false, skipped, source: `the upload ${copy.name}` };
  }
  if (kind === 'github') {
    const gh = parseGithubUrl(repository.location);
    if (!gh) { const err = new Error(`${repository.location} is not a GitHub repository`); err.status = 400; throw err; }
    const seams = { token, ...(ghFetchFn ? { fetchFn: ghFetchFn } : {}), ...(rawFn !== undefined ? { rawFn } : {}) };
    const out = await fetchGithubFiles({ owner: gh.owner, repo: gh.repo, ref: repository.ref ?? gh.ref ?? null }, seams);
    return { files: out.files, ref: out.ref, candidates: out.candidates, capped: out.capped, truncated: out.truncated, skipped: out.skipped, source: `${gh.owner}/${gh.repo} on GitHub` };
  }
  if (kind === 'ado') return fetchAdoFiles(repository.location, repository.ref ?? null, { ...(fetchImpl ? { fetchImpl } : {}), token, tokenSource: credential?.source || (token ? 'server' : 'none') });
  if (kind === 'path') {
    let isDir = false;
    try { isDir = statSync(repository.location).isDirectory(); } catch { /* not there */ }
    if (!isDir) { const err = new Error(`no folder ${repository.location} on the server`); err.status = 404; throw err; }
    let read;
    try { read = scanRepoFolder(repository.location, { scope: crawlScope }); }
    catch (e) { const err = new Error(e.message); err.status = 403; throw err; }
    return { files: read.files, ref: null, candidates: Object.keys(read.files).length, capped: 0, truncated: false, skipped: read.skipped, source: `the folder ${repository.location}` };
  }
  const err = new Error(`a repository of kind ${JSON.stringify(kind)} cannot be read`);
  err.status = 400;
  throw err;
}
