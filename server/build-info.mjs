// server/build-info.mjs — which build is this?
//
// One answer for the studio footer, `packc --version`, GET /api/version and
// /healthz: the commit a running Observogram was started from. There is no
// build step (plain ESM served straight from the checkout), so the honest
// identity of a process is git's, read once per process:
//
//   build   `git rev-list --count HEAD` — an integer that climbs with every
//           commit on the branch (975 on develop the day this landed). Two
//           branches can share a number, so it is never unique on its own …
//   commit  `git rev-parse --short HEAD` — … the sha is what makes it unique.
//   branch  `git rev-parse --abbrev-ref HEAD` ('HEAD' when detached).
//   dirty   `git status --porcelain` non-empty: uncommitted or untracked
//           files — the running code is NOT exactly that commit.
//   date    `git log -1 --format=%cI` — the commit's ISO-8601 date.
//   version package.json's, always.
//   source  'git' | 'file' | 'package' — where the answer came from.
//
// Precedence: git (a checkout, including a worktree) → build.json at the
// root, written by `npm run build:stamp` (tools/stamp-build.mjs) for a tree
// that will be copied somewhere without .git — a tarball, a container →
// package.json alone (build null; buildLabel says "build unknown").
//
// Every git call is guarded: no git binary, no repository, a repository that
// is not THIS tree (a git-less copy extracted inside some other checkout
// must not report that checkout's commits) all fall through. Node built-ins
// only — and Node-only (child_process), which is why this lives under
// server/ and not tools/lib/: that directory is served to the browser at
// /lib and must stay free of node:* imports (.github/copilot-instructions.md,
// browser-safety rule). Imported by server/, the CLI and the stamp tool;
// the studio reads GET /api/version instead.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_FILE = 'build.json';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Per-root memo: git is spawned once at first use, `refresh: true` re-reads.
const cache = new Map();

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function git(root, args) {
  try {
    const out = execFileSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true, encoding: 'utf8',
    });
    return String(out).trim();
  } catch { return null; }
}

// Same directory, tolerant of separators, case (Windows) and short names.
function samePath(a, b) {
  const norm = (p) => {
    let r = resolve(p);
    try { r = realpathSync.native(r); } catch { /* keep the resolved form */ }
    r = r.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

function fromGit(root, version) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (!top || !samePath(top, root)) return null;      // no git, no repo, or somebody else's
  const commit = git(root, ['rev-parse', '--short', 'HEAD']);
  if (!commit) return null;                             // a repo with no commit yet
  const count = git(root, ['rev-list', '--count', 'HEAD']);
  const build = /^\d+$/.test(count || '') ? Number(count) : null;
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  const status = git(root, ['status', '--porcelain']);
  const date = git(root, ['log', '-1', '--format=%cI']) || null;
  return { version, build, commit, branch, dirty: status == null ? false : status.length > 0, date, source: 'git' };
}

function fromFile(root, version) {
  const stamped = readJson(join(root, BUILD_FILE));
  if (!stamped || typeof stamped !== 'object') return null;
  const build = Number.isInteger(stamped.build) ? stamped.build
    : /^\d+$/.test(String(stamped.build ?? '')) ? Number(stamped.build) : null;
  return {
    version: version ?? (typeof stamped.version === 'string' ? stamped.version : null),
    build,
    commit: typeof stamped.commit === 'string' && stamped.commit ? stamped.commit : null,
    branch: typeof stamped.branch === 'string' && stamped.branch ? stamped.branch : null,
    dirty: stamped.dirty === true,
    date: typeof stamped.date === 'string' && stamped.date ? stamped.date : null,
    source: 'file',
  };
}

// The uncached read — what buildInfo() memoises and stamp-build writes.
export function readBuildInfo(root = DEFAULT_ROOT) {
  const dir = resolve(root);
  const pkg = readJson(join(dir, 'package.json'));
  const version = typeof pkg?.version === 'string' ? pkg.version : null;
  return Object.freeze(
    fromGit(dir, version)
    || fromFile(dir, version)
    || { version, build: null, commit: null, branch: null, dirty: false, date: null, source: 'package' }
  );
}

// buildInfo({ root, refresh }) → { version, build, commit, branch, dirty, date, source }
export function buildInfo({ root = DEFAULT_ROOT, refresh = false } = {}) {
  const key = resolve(root);
  if (!refresh && cache.has(key)) return cache.get(key);
  const info = readBuildInfo(key);
  cache.set(key, info);
  return info;
}

// 'v0.4.0 · build 975 · 9c4f827 · develop' (+ ' · dirty'); 'v0.4.0 · build unknown'
// when there is no build number. The version is always the first token so
// `packc --version | grep 0.4.0` keeps working.
export function buildLabel(info) {
  const v = `v${info?.version ?? '?'}`;
  if (info?.build == null) return `${v} · build unknown`;
  const parts = [v, `build ${info.build}`];
  if (info.commit) parts.push(info.commit);
  if (info.branch) parts.push(info.branch);
  if (info.dirty) parts.push('dirty');
  return parts.join(' · ');
}

// The short form for tight chrome (a header subtitle): 'v0.4.0 · build 975'.
export function buildShortLabel(info) {
  return `v${info?.version ?? '?'} · build ${info?.build ?? 'unknown'}`;
}
