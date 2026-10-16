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
