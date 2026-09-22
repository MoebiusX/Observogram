#!/usr/bin/env node
// tools/stamp-build.mjs — `npm run build:stamp`
//
// Writes build.json (git-ignored) at the repo root with the same fields
// tools/lib/build-info.mjs reads from git — build, commit, branch, dirty,
// date, version — for a checkout that will be copied somewhere without
// .git: a tarball, a container image. buildInfo() finds no git there and
// reads the file instead (source 'file'), so the studio footer, packc
// --version and GET /api/version still name the commit the copy came from.
//
// Run it on the host, in the checkout, before the copy — the Dockerfile
// copies build.json* next to package.json (there is no .git inside the
// image and .dockerignore excludes it). Exit 2 when there is nothing to
// stamp (no git, not a repo): the honest answer is then package.json's
// "build unknown", never a stale file — so a stale build.json is removed.
//
//   node tools/stamp-build.mjs [--root <dir>] [--json]

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBuildInfo, buildLabel, BUILD_FILE } from './lib/build-info.mjs';

const args = process.argv.slice(2);
const rootArg = args.includes('--root') ? args[args.indexOf('--root') + 1] : null;
const ROOT = rootArg ? resolve(process.cwd(), rootArg) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const asJson = args.includes('--json');

const info = readBuildInfo(ROOT);
const target = join(ROOT, BUILD_FILE);

if (info.source !== 'git') {
  if (existsSync(target)) {
    unlinkSync(target);
    process.stderr.write(`stamp-build: removed a stale ${BUILD_FILE} — this tree has no git metadata to stamp (${info.source}).\n`);
  } else {
    process.stderr.write(`stamp-build: nothing to stamp — no git metadata under ${ROOT} (${info.source}).\n`);
  }
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
