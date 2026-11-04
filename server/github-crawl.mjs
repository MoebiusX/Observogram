// server/github-crawl.mjs — helpers for the public-GitHub crawl route.
//
// Server-only (ghFetch reads GITHUB_TOKEN from the environment, which the
// browser-safe tools/lib layer is not allowed to do). parseGithubUrl,
// isCrawlerFile, isExporterCandidateFile and selectCrawlerFiles are pure;
// ghFetch is the single authenticated wrapper
// around the GitHub REST API.

import { isTestOrFixturePath } from '../tools/lib/exporter-metrics.mjs';

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

// Files the crawler will actually look at — keep the network round
// trips down by filtering BEFORE downloading.
export function isCrawlerFile(path) {
  if (typeof path !== 'string') return false;
  const p = path.toLowerCase();
  if (p.includes('node_modules/') || p.includes('.git/') || p.startsWith('.git/')) return false;
  const sourceMetricCandidate =
    /\.(cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/.test(p) &&
    !/(\.test\.|\.spec\.|\.d\.ts$|package-lock|yarn\.lock|pnpm-lock|tokenizer\.json)/.test(p) &&
    /(metrics?|prometheus|observability|telemetry|instrumentation|monitor|otel|mcp|bayesian|processor)/.test(p);
  return (
    sourceMetricCandidate ||
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

/**
 * The blobs of a GitHub tree a crawl downloads, at most `maxFiles` of at most
 * `fileCapBytes` each: every isCrawlerFile blob first, in tree order, then
 * the exporter candidates — so a monorepo's many `config.yaml` files never
 * push out a rule file, an Alertmanager config or a collector config.
 */
export function selectCrawlerFiles(tree, { maxFiles = 200, fileCapBytes = Infinity } = {}) {
  const blobs = (Array.isArray(tree) ? tree : []).filter(node => node?.type === 'blob' && typeof node.path === 'string');
  return [
    ...blobs.filter(node => isCrawlerFile(node.path)),
    ...blobs.filter(node => isExporterCandidateFile(node.path)),
  ]
    .filter(node => !node.size || node.size <= fileCapBytes)
    .slice(0, maxFiles);
}

export async function ghFetch(path, init = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'observogram-crawler/1.0',
    'Accept-Encoding': 'identity',   // no decompression of a third party's bytes (the Brotli decoder, CVE-2026-111497)
    ...(init.headers || {}),
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub ${res.status} on ${path}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// A public file's bytes from raw.githubusercontent.com — outside the REST
// API's quota (60 requests an hour without a token, which a 200-file scan
// would spend in its first minute). Never sent a token.
export async function rawFetch(owner, repo, ref, path) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref).replace(/%2F/g, '/')}/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'observogram-crawler/1.0', 'Accept-Encoding': 'identity' }, redirect: 'error' });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status} on ${path}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * The files a crawl of a GitHub repository reads, fetched: the default
 * branch when `ref` is null; selectCrawlerFiles' blobs (at most 200, 1 MB
 * each, 16 MB in all) downloaded in parallel — through the contents API
 * with GITHUB_TOKEN set (a private repository), else from
 * raw.githubusercontent.com (rawFetch: a public one, no quota spent). A file
 * that fails or does not fit is skipped and named, never fatal; a tree or
 * repository error throws (err.status is GitHub's).
 * → { ref, candidates, files, skipped, truncated } — the POST
 * /api/crawl-github route and a service's Run share it.
 */
export async function fetchGithubFiles({ owner, repo, ref = null }, { fetchFn = ghFetch, rawFn = process.env.GITHUB_TOKEN ? null : rawFetch } = {}) {
  let at = ref;
  if (!at) {
    const repoMeta = await fetchFn(`/repos/${owner}/${repo}`).then(r => r.json());
    at = repoMeta.default_branch || 'main';
  }
  const treeResp = await fetchFn(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(at)}?recursive=1`).then(r => r.json());
  const FILE_CAP_BYTES = 1 * 1024 * 1024;        // 1 MB / file
  const TOTAL_CAP_BYTES = 16 * 1024 * 1024;      // 16 MB total
  const MAX_FILES = 200;
  // isCrawlerFile's blobs first, the exporter candidates after them.
  const candidates = selectCrawlerFiles(treeResp.tree, { maxFiles: MAX_FILES, fileCapBytes: FILE_CAP_BYTES });
  let totalBytes = 0;
  const files = {};
  const skipped = [];
  await Promise.all(candidates.map(async (node) => {
    try {
      const contentRes = rawFn
        ? await rawFn(owner, repo, at, node.path)
        : await fetchFn(`/repos/${owner}/${repo}/contents/${encodeURIComponent(node.path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(at)}`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
        });
      const text = await contentRes.text();
      if (text.length > FILE_CAP_BYTES) { skipped.push(`${node.path} (size ${text.length})`); return; }
      if (totalBytes + text.length > TOTAL_CAP_BYTES) { skipped.push(`${node.path} (total cap)`); return; }
      files[node.path] = text;
      totalBytes += text.length;
    } catch (e) {
      skipped.push(`${node.path} (${e.message})`);
    }
  }));
  return { ref: at, candidates: candidates.length, files, skipped, truncated: !!treeResp.truncated };
}
