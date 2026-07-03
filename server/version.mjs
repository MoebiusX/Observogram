// server/version.mjs — one answer to "what exactly is running?".
//
// Version comes from package.json; the build identifier is resolved once
// at module load, in precedence order:
//
//   1. OBSERVOGRAM_BUILD        — baked into hosted images (Dockerfile
//                                 ARG/ENV), e.g. a CI run number or tag.
//   2. git metadata             — dev checkouts: `<commit-count>.<short-sha>`
//                                 (monotonic build number + exact commit),
//                                 with a `+dirty` suffix when the working
//                                 tree has uncommitted changes.
//   3. 'untracked'              — no env, no .git (e.g. a bare tarball).
//
// Reading the sha is file-first (.git/HEAD → ref → packed-refs); only the
// commit COUNT spawns git, once, best-effort — a missing git binary just
// drops the count, never fails the boot.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandEnv } from '../tools/lib/brand-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function pkgVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch (_) { return '0.0.0'; }
}

function gitSha() {
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: (.+)$/.exec(head);
    if (!m) return head.slice(0, 7);                       // detached HEAD
    const refPath = join(ROOT, '.git', ...m[1].split('/'));
    if (existsSync(refPath)) return readFileSync(refPath, 'utf8').trim().slice(0, 7);
    const packed = readFileSync(join(ROOT, '.git', 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (line.endsWith(` ${m[1]}`)) return line.slice(0, 7);
    }
  } catch (_) { /* no .git */ }
  return null;
}

function gitCount() {
  try {
    return execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString().trim();
  } catch (_) { return null; }
}

function gitDirty() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString().trim().length > 0;
  } catch (_) { return false; }
}

function resolveBuild() {
  const fromEnv = brandEnv('BUILD');
  if (fromEnv) return fromEnv;
  const sha = gitSha();
  if (!sha) return 'untracked';
  const count = gitCount();
  const dirty = gitDirty() ? '+dirty' : '';
  return `${count ? `${count}.` : ''}${sha}${dirty}`;
}

const INFO = Object.freeze({
  version: pkgVersion(),
  build: resolveBuild(),
  node: process.version,
});

export function versionInfo() { return INFO; }

// The display form: `v0.4.0 · build 371.8068e8d`
export function versionLabel() { return `v${INFO.version} · build ${INFO.build}`; }
