// server/version.mjs — /healthz's answer to "what exactly is running?".
//
// Version comes from package.json; the build identifier is the composite
// `<build>.<sha>` (+`+dirty` for an uncommitted tree) that /healthz has
// carried since 0.4 — kept stable for probes and dashboards that parse it.
// The structured form (build, commit, branch, dirty, date, source) is
// GET /api/version, and both come from ONE reader, server/build-info.mjs:
// git (a checkout, a worktree), else build.json (`npm run build:stamp`, for
// a copy without .git), else package.json alone ('untracked' here).
//
// OBSERVOGRAM_BUILD, when set and non-empty, overrides the composite only:
// a CI run number or tag baked into an image (Dockerfile ARG/ENV) that a
// deployment wants to see on /healthz. It never changes /api/version.
//
// Resolved once at module load — build-info memoises the git calls.

import { brandEnv } from '../tools/lib/brand-env.mjs';
import { buildInfo } from './build-info.mjs';

function compositeBuild(info) {
  const fromEnv = brandEnv('BUILD');
  if (fromEnv) return fromEnv;
  if (info.build == null && !info.commit) return 'untracked';
  const dirty = info.dirty ? '+dirty' : '';
  return `${info.build != null ? `${info.build}.` : ''}${info.commit || '?'}${dirty}`;
}

const BUILD = buildInfo();
const INFO = Object.freeze({
  version: BUILD.version || '0.0.0',
  build: compositeBuild(BUILD),
  node: process.version,
});

export function versionInfo() { return INFO; }

// The display form: `v0.4.0 · build 975.9c4f827`
export function versionLabel() { return `v${INFO.version} · build ${INFO.build}`; }
