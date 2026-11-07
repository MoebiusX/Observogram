// server/github-crawl.mjs — helpers for the public-GitHub crawl route.
//
// Server-only. parseGithubUrl, isCrawlerFile, isExporterCandidateFile,
// planCrawlerFetch, selectCrawlerFiles and settleFetched are pure; ghFetch is the single authenticated wrapper
// around the GitHub REST API. It sends the token its caller names and no
// other: whose token that is — the person's own, or the server's on a
// server without sign-in — is server/repo-auth.mjs's rule, never read here.

import { isTestOrFixturePath } from '../tools/lib/exporter-metrics.mjs';
import { SCAN_MAX_FILE_BYTES, SCAN_WHY, scanReadsPath, scanRefusal } from '../tools/lib/crawler.mjs';
import { unreachable } from './fetch-failure.mjs';

export function parseGithubUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const cleaned = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
  // owner/repo bare form
  const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  if (bare) return { owner: bare[1], repo: bare[2] };
  // Full URL form
  const url = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([A-Za-z0-9._/-]+))?/.exec(cleaned);
  if (url) return { owner: url[1], repo: url[2], ref: url[3] };
  return null;
}

// The names an observability artefact usually has — a host read FETCHES
// these first. They never decide what is read: that is the crawler's own
// rule (scanReadsPath), the same for a folder, an upload and the CLI;
// planCrawlerFetch only orders by them under its file cap.
export function isCrawlerFile(path) {
  if (typeof path !== 'string') return false;
  const p = path.toLowerCase();
  if (p.includes('node_modules/') || p.includes('.git/') || p.startsWith('.git/')) return false;
  const sourceMetricCandidate =
    /\.(cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/.test(p) &&
    !/(\.test\.|\.spec\.|\.d\.ts$|package-lock|yarn\.lock|pnpm-lock|tokenizer\.json)/.test(p) &&
    /(metrics?|prometheus|observability|telemetry|instrumentation|monitor|otel|mcp|bayesian|processor|chaos)/.test(p);
  return (
    sourceMetricCandidate ||
    // The repository's own pack (tools/lib/repo-pack.mjs): its declared chaos
    // experiments and their newest runs.
    /(^|\/)\.observability\/[^/]+\.ya?ml$/.test(p) ||
    /(^|\/)(application|bootstrap)[\w.-]*\.ya?ml$/.test(p) ||
    // A prebuilt exporter's metrics manifest (named precisely; the broad
    // exporter patterns are isExporterCandidateFile's, fetched last).
    /(^|[/.])metrics-manifest\.json$/.test(p) ||
    /(^|\/)docker[-_]compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /\.rules\.(ya?ml)$/.test(p) ||
    /(^|\/)prometheus[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)alertmanager[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otel[a-z0-9._-]*config[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otelcol[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)collector[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)chart\.(ya?ml)$/.test(p) ||
    /(^|\/)values[\w.-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)templates\/.*\.(ya?ml)$/.test(p) ||
    /(^|\/)k8s\/.*\.(ya?ml)$/.test(p) ||
    /(^|\/)dashboards?\/.*\.json$/.test(p) ||
    /(^|\/)grafana\/.*\.json$/.test(p) ||
    /\.dashboard\.json$/.test(p) ||
    /(^|\/)kustomization\.(ya?ml)$/.test(p)
  );
}

// Files that MAY say what a prebuilt exporter exposes or how a collector
// scrapes it, by names too common to fetch first: a saved /metrics (`.prom`,
// `.metrics`, never from a test or fixture folder), any `config.yaml` (an
// mq-metric-samples config), a Helm chart's `files/*.yaml` (a collector
// config). Never one isCrawlerFile already takes.
export function isExporterCandidateFile(path) {
  if (typeof path !== 'string' || isCrawlerFile(path)) return false;
  const p = path.toLowerCase();
  if (p.includes('node_modules/') || p.startsWith('.git/') || p.includes('/.git/')) return false;
  // The test-folder rule reads the path as written (camelCase source sets).
  return (/\.(prom|metrics)$/.test(p) && !isTestOrFixturePath(path))
    || /(^|\/)config\.ya?ml$/.test(p)
    || /(^|\/)files\/.*\.ya?ml$/.test(p);
}

// Files a cap reaches last: tests and fixtures, lock files, type
// declarations, tokenizer dumps — read when there is room, never before an
// artefact.
const LAST = /(\.test\.|\.spec\.|\.d\.ts$|package-lock\.json$|yarn\.lock$|pnpm-lock\.ya?ml$|tokenizer\.json$)/i;
const tierOf = (path) => (isCrawlerFile(path) ? 0
  : isExporterCandidateFile(path) ? 1
    : isTestOrFixturePath(path) || LAST.test(path) ? 3 : 2);

/**
 * What a host read (a GitHub or an Azure DevOps tree) downloads: every blob
 * the crawler's rule reads (scanReadsPath — the rule a folder, an upload and
 * the CLI apply), at most `maxFiles` of them, ordered so the cap reaches the
 * likely artefacts last: isCrawlerFile's names first, then
 * isExporterCandidateFile's, then the rest, then tests, fixtures and lock
 * files — each group in tree order — so a monorepo's many `config.yaml` files
 * never push out a rule file, an Alertmanager config or a collector config.
 * A secrets file, a blob the tree says is over `fileCapBytes` and a blob past
 * `totalCapBytes` (by the tree's sizes, in that order) are skipped and named,
 * never fetched.
 * → { selected: [node], candidates, capped, skipped: [{ path, why }] }
 *   candidates  how many blobs the rule reads in the whole tree
 *   capped      how many of them the file cap left out
 */
export function planCrawlerFetch(tree, { maxFiles = 200, fileCapBytes = SCAN_MAX_FILE_BYTES, totalCapBytes = Infinity } = {}) {
  const blobs = (Array.isArray(tree) ? tree : []).filter(node => node?.type === 'blob' && typeof node.path === 'string');
  const skipped = [];
  const takes = [];
  for (const node of blobs) {
    const why = scanRefusal(node.path);   // a secrets file (git keeps a .gitignore'd one out of the tree)
    if (why) { skipped.push({ path: node.path, why }); continue; }
    if (scanReadsPath(node.path)) takes.push(node);
  }
  const ordered = takes.map((node, i) => ({ node, i, tier: tierOf(node.path) }))
    .sort((x, y) => x.tier - y.tier || x.i - y.i)
    .map(x => x.node);
  const selected = [];
  let capped = 0;
  let total = 0;
  for (const node of ordered) {
    const size = Number(node.size) || 0;
    if (size > fileCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.tooLarge(fileCapBytes) }); continue; }
    if (selected.length >= maxFiles) { capped++; continue; }
    if (total + size > totalCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.totalCap(totalCapBytes) }); continue; }
    total += size;
    selected.push(node);
  }
  return { selected, candidates: takes.length, capped, skipped };
}

// planCrawlerFetch's blobs alone.
export function selectCrawlerFiles(tree, opts = {}) {
  return planCrawlerFetch(tree, opts).selected;
}

const byPath = (x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

/**
 * The files a host read downloaded, settled in the plan's order (downloads
 * finish in any order): a text over `fileCapBytes` (a tree with no sizes:
 * Azure DevOps) or past `totalCapBytes` is skipped and named, as is a
 * download that failed, with its error. `texts`: path → { text } | { error }.
 * → { files, skipped } — files in path order, which is the order crawlFiles
 * reads them in, whatever order they arrived in; skipped in path order, the
 * plan's own skips with them (`planned`).
 */
export function settleFetched(selected, texts, { fileCapBytes = SCAN_MAX_FILE_BYTES, totalCapBytes = Infinity, planned = [] } = {}) {
  const kept = [];
  const skipped = [...planned];
  let total = 0;
  for (const node of selected) {
    const got = texts.get(node.path);
    if (!got) continue;
    if (got.error) { skipped.push({ path: node.path, why: `it could not be downloaded (${got.error})` }); continue; }
    if (got.text.length > fileCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.tooLarge(fileCapBytes) }); continue; }
    if (total + got.text.length > totalCapBytes) { skipped.push({ path: node.path, why: SCAN_WHY.totalCap(totalCapBytes) }); continue; }
    total += got.text.length;
    kept.push({ path: node.path, text: got.text });
  }
  kept.sort(byPath);
  return { files: Object.fromEntries(kept.map(k => [k.path, k.text])), skipped: skipped.sort(byPath) };
}

// A host read's caps: at most 200 files of the scan's 5 MB each, 16 MB in all.
export const HOST_READ_CAPS = Object.freeze({ maxFiles: 200, fileCapBytes: SCAN_MAX_FILE_BYTES, totalCapBytes: 16 * 1024 * 1024 });

export async function ghFetch(path, init = {}, { token = null } = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'observogram-crawler/1.0',
    'Accept-Encoding': 'identity',   // no decompression of a third party's bytes (the Brotli decoder, CVE-2026-111497)
    ...(init.headers || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let res;
  try { res = await fetch(`https://api.github.com${path}`, { ...init, headers }); }
  catch (e) { throw unreachable('GitHub', 'https://api.github.com', e); }
  if (!res.ok) {
    const said = githubSays(await res.text().catch(() => ''));
    const err = new Error(`GitHub ${res.status} on ${path}${said ? `: ${said}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// What a failed GitHub REST call says, for a sentence a person reads: the
// JSON body's `message` ("Not Found", "Bad credentials") — never the body
// itself, with its documentation_url and status — else the text, on one
// line. At most 200 characters.
function githubSays(body) {
  const text = String(body ?? '');
  let message = null;
  try { const j = JSON.parse(text); if (j && typeof j.message === 'string') message = j.message; } catch { /* not JSON */ }
  return (message ?? text).replace(/\s+/g, ' ').trim().slice(0, 200);
}

// A public file's bytes from raw.githubusercontent.com — outside the REST
// API's quota (60 requests an hour without a token, which a 200-file scan
// would spend in its first minute). Never sent a token.
export async function rawFetch(owner, repo, ref, path) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, '/')}/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  let res;
  try { res = await fetch(url, { headers: { 'User-Agent': 'observogram-crawler/1.0', 'Accept-Encoding': 'identity' }, redirect: 'manual' }); }
  catch (e) { throw unreachable('GitHub', url, e); }
  // A redirect is read, never followed, and named as what it is.
  if (res.status >= 300 && res.status < 400) {
    const err = new Error(`GitHub ${res.status} on ${path}: raw.githubusercontent.com redirected it, which the server does not follow (the repository may have moved)`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * The files a crawl of a GitHub repository reads, fetched: the default
 * branch when `ref` is null; planCrawlerFetch's blobs (HOST_READ_CAPS: at
 * most 200, 5 MB each, 16 MB in all) downloaded in parallel — through the
 * contents API with a `token` (a private repository; repo-auth.mjs says
 * whose), else from raw.githubusercontent.com (rawFetch: a public one, no
 * quota spent). A file that fails or does not fit is skipped and named,
 * never fatal; a tree or repository error throws (err.status is GitHub's).
 * → { ref, candidates, capped, files, skipped: [{ path, why }], truncated }
 * — candidates the blobs the crawler's rule reads, capped how many of them
 * the 200-file cap left out, truncated GitHub's own flag (a tree too large
 * to list whole: files may be missing that nothing here can name). The
 * POST /api/crawl-github route and a service's Run share it.
 */
export async function fetchGithubFiles({ owner, repo, ref = null }, { token = null, fetchFn = (path, init) => ghFetch(path, init, { token }), rawFn = token ? null : rawFetch } = {}) {
  let at = ref;
  if (!at) {
    const repoMeta = await fetchFn(`/repos/${owner}/${repo}`).then(r => r.json());
    at = repoMeta.default_branch || 'main';
  }
  const treeResp = await fetchFn(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(at)}?recursive=1`).then(r => r.json());
  const plan = planCrawlerFetch(treeResp.tree, HOST_READ_CAPS);
  const texts = new Map();
  await Promise.all(plan.selected.map(async (node) => {
    try {
      const contentRes = rawFn
        ? await rawFn(owner, repo, at, node.path)
        : await fetchFn(`/repos/${owner}/${repo}/contents/${encodeURIComponent(node.path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(at)}`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
        });
      texts.set(node.path, { text: await contentRes.text() });
    } catch (e) {
      texts.set(node.path, { error: e.message });
    }
  }));
  const { files, skipped } = settleFetched(plan.selected, texts, { ...HOST_READ_CAPS, planned: plan.skipped });
  return { ref: at, candidates: plan.candidates, capped: plan.capped, files, skipped, truncated: !!treeResp.truncated };
}
