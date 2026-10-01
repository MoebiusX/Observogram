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
// Resolved on first use, not at import: the suites pin their environment
// after the hoisted `import './index.mjs'` has run (workspace, auth
// posture — and BUILD, so an OBSERVOGRAM_BUILD exported in the shell
// cannot change what they assert). build-info memoises the git calls.

import { brandEnv } from '../tools/lib/brand-env.mjs';
import { buildInfo } from './build-info.mjs';

function compositeBuild(info) {
  const fromEnv = brandEnv('BUILD');
  if (fromEnv) return fromEnv;
  if (info.build == null && !info.commit) return 'untracked';
  const dirty = info.dirty ? '+dirty' : '';
  return `${info.build != null ? `${info.build}.` : ''}${info.commit || '?'}${dirty}`;
}

let INFO = null;
function resolved() {
  if (!INFO) {
    const build = buildInfo();
    INFO = Object.freeze({
      version: build.version || '0.0.0',
      build: compositeBuild(build),
      node: process.version,
    });
  }
  return INFO;
}

export function versionInfo() { return resolved(); }

// The display form: `v0.4.0 · build 975.9c4f827`
export function versionLabel() { const i = resolved(); return `v${i.version} · build ${i.build}`; }
