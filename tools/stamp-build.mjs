#!/usr/bin/env node
// tools/stamp-build.mjs — `npm run build:stamp`
//
// Writes build.json (git-ignored) at the repo root with the same fields
// server/build-info.mjs reads from git — build, commit, branch, dirty,
// date, version — for a checkout that will be copied somewhere without
// .git: a tarball, a container image. buildInfo() finds no git there and
// reads the file instead (source 'file'), so the studio footer, packc
// --version and GET /api/version still name the commit the copy came from.
//
// Run it on the host, in the checkout, before the copy — the Dockerfile
// copies build.json* next to package.json (there is no .git inside the
// image and .dockerignore excludes it). What happens depends on the tree:
//
//   a checkout with history     the stamp is written (exit 0)
//   a shallow clone             refused (exit 2): its commit count is the
//                               clone depth — actions/checkout's default
//                               fetch-depth: 1 would bake "build 1" into
//                               every image — so fetch the history first;
//                               a build.json lying there is removed
//   a git-less copy, stamped    kept as it is (exit 0): the file IS the
//                               copy's identity and nothing newer exists
//   a git-less copy, unstamped  nothing to stamp (exit 2); an unreadable
//                               build.json is removed rather than left to
//                               mislead the next reader
//
//   node tools/stamp-build.mjs [--root <dir>] [--json]

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfo, buildLabel, BUILD_FILE } from '../server/build-info.mjs';

const USAGE = 'usage: node tools/stamp-build.mjs [--root <dir>] [--json]';
const refuse = (why) => { process.stderr.write(`stamp-build: ${why}\n${USAGE}\n`); process.exit(3); };

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const rootAt = args.indexOf('--root');
let ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (rootAt !== -1) {
  const value = args[rootAt + 1];
  // A bare --root must never fall back to THIS checkout and stamp the wrong tree.
  if (!value || value.startsWith('--')) refuse('--root needs a directory');
  ROOT = resolve(process.cwd(), value);
}
const stray = args.filter((a, i) => a !== '--json' && a !== '--root' && !(rootAt !== -1 && i === rootAt + 1));
if (stray.length) refuse(`unknown argument ${stray[0]}`);
if (!existsSync(join(ROOT, 'package.json'))) refuse(`${ROOT} has no package.json — not a tree to stamp`);

const info = readBuildInfo(ROOT);
const target = join(ROOT, BUILD_FILE);

// A git-less copy that already carries a readable stamp: keep it — the
// file is the copy's identity and there is nothing newer to replace it.
if (info.source === 'file') {
  if (asJson) process.stdout.write(JSON.stringify({ file: target, kept: true, ...info }) + '\n');
  else process.stdout.write(`kept existing ${BUILD_FILE}: ${buildLabel(info)}\n`);
  process.exit(0);
}

if (info.source === 'package') {
  if (existsSync(target)) {
    unlinkSync(target);
    process.stderr.write(`stamp-build: removed an unreadable ${BUILD_FILE} — nothing under ${ROOT} says which commit this is (no git metadata).\n`);
  } else {
    process.stderr.write(`stamp-build: nothing to stamp — no git metadata under ${ROOT}.\n`);
  }
  process.exit(2);
}

if (info.shallow) {
  const lying = existsSync(target);
  if (lying) unlinkSync(target);
  process.stderr.write(`stamp-build: ${ROOT} is a shallow clone — its commit count is the clone depth, not a build number, so nothing was stamped${lying ? ` (the ${BUILD_FILE} lying there was removed)` : ''}. Fetch the history first (actions/checkout: fetch-depth: 0; locally: git fetch --unshallow) and stamp again.\n`);
  process.exit(2);
}

const stamped = {
  version: info.version,
  build: info.build,
  commit: info.commit,
  branch: info.branch,
  dirty: info.dirty,
  date: info.date,
  stampedAt: new Date().toISOString(),
};
writeFileSync(target, JSON.stringify(stamped, null, 2) + '\n');

if (asJson) process.stdout.write(JSON.stringify({ file: target, ...stamped }) + '\n');
else process.stdout.write(`stamped ${BUILD_FILE}: ${buildLabel(info)}\n`);
