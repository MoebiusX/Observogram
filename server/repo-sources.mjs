// server/repo-sources.mjs — a service's repository, read for its Run.
//
// fetchRepositoryFiles(repository, { crawlScope }) reads what the crawler
// looks at from where the service record says its declaration lives
// (server/service-admin.mjs parseRepository's { kind, location, ref }):
//   github  GitHub's tree and contents API (server/github-crawl.mjs; GITHUB_TOKEN
//           when set, for private repositories and the rate limit)
//   ado     Azure DevOps' items API (server/ado-crawl.mjs; AZURE_DEVOPS_TOKEN)
//   path    a folder on the server, walked under the org's crawl scope
//           (tools/lib/journey.mjs walkRepoFiles — never another org's part
//           of the workspace)
// → { files, ref, candidates, skipped, source } — `files` the map
// crawlFiles() takes, `source` the words for where it came from. A remote
// file that fails or does not fit is skipped and named; a repository the
// host refuses throws with the host's status.

import { statSync } from 'node:fs';
import { walkRepoFiles } from '../tools/lib/journey.mjs';
import { fetchGithubFiles, parseGithubUrl, selectCrawlerFiles } from './github-crawl.mjs';
import { adoFileText, adoTree, parseAdoUrl } from './ado-crawl.mjs';

const FILE_CAP_BYTES = 1 * 1024 * 1024;
const TOTAL_CAP_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 200;
const PARALLEL = 8;

// Azure DevOps: the tree, the crawler's files (selectCrawlerFiles, as
// GitHub), each downloaded — at most PARALLEL at once.
async function fetchAdoFiles(location, ref, opts = {}) {
  const parsed = parseAdoUrl(location);
  if (!parsed) { const err = new Error(`${location} is not an Azure DevOps repository URL`); err.status = 400; throw err; }
  const repo = { ...parsed, ref: ref ?? parsed.ref ?? null };
  const tree = await adoTree(repo, opts);
  const candidates = selectCrawlerFiles(tree, { maxFiles: MAX_FILES });
  const files = {};
  const skipped = [];
  let total = 0;
  for (let i = 0; i < candidates.length; i += PARALLEL) {
    await Promise.all(candidates.slice(i, i + PARALLEL).map(async (node) => {
      try {
        const text = await adoFileText(repo, node.path, opts);
        if (text.length > FILE_CAP_BYTES) { skipped.push(`${node.path} (size ${text.length})`); return; }
        if (total + text.length > TOTAL_CAP_BYTES) { skipped.push(`${node.path} (total cap)`); return; }
        files[node.path] = text;
        total += text.length;
      } catch (e) {
        skipped.push(`${node.path} (${e.message})`);
      }
    }));
  }
  return { files, ref: repo.ref, candidates: candidates.length, skipped, source: `${repo.project}/${repo.repo} on Azure DevOps` };
}

// `fetchImpl` (Azure DevOps), `ghFetchFn` and `rawFn` (GitHub) are the test seams.
export async function fetchRepositoryFiles(repository, { crawlScope = null, fetchImpl, ghFetchFn, rawFn } = {}) {
  const kind = repository?.kind;
  if (kind === 'github') {
    const gh = parseGithubUrl(repository.location);
    if (!gh) { const err = new Error(`${repository.location} is not a GitHub repository`); err.status = 400; throw err; }
    const seams = { ...(ghFetchFn ? { fetchFn: ghFetchFn } : {}), ...(rawFn !== undefined ? { rawFn } : {}) };
    const out = await fetchGithubFiles({ owner: gh.owner, repo: gh.repo, ref: repository.ref ?? gh.ref ?? null }, seams);
    return { files: out.files, ref: out.ref, candidates: out.candidates, skipped: out.skipped, source: `${gh.owner}/${gh.repo} on GitHub` };
  }
  if (kind === 'ado') return fetchAdoFiles(repository.location, repository.ref ?? null, fetchImpl ? { fetchImpl } : {});
  if (kind === 'path') {
    let isDir = false;
    try { isDir = statSync(repository.location).isDirectory(); } catch { /* not there */ }
    if (!isDir) { const err = new Error(`no folder ${repository.location} on the server`); err.status = 404; throw err; }
    let files;
    try { files = walkRepoFiles(repository.location, { scope: crawlScope }); }
    catch (e) { const err = new Error(e.message); err.status = 403; throw err; }
    return { files, ref: null, candidates: Object.keys(files).length, skipped: [], source: `the folder ${repository.location}` };
  }
  const err = new Error(`a repository of kind ${JSON.stringify(kind)} cannot be read`);
  err.status = 400;
  throw err;
}
