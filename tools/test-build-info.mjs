#!/usr/bin/env node
/**
 * tools/test-build-info.mjs — which build is this? (server/build-info.mjs,
 * tools/stamp-build.mjs, studio/build-label.mjs)
 *
 * A throwaway git repository with three commits must read build 3 with
 * git's own short sha and branch; a fourth, uncommitted file flips dirty; a
 * copy of that tree without .git but with the stamp reads source 'file'; a
 * tree with neither reads source 'package' with build null; a git-less copy
 * nested INSIDE a repository must not borrow that repository's commits.
 * buildLabel formats all three sources, buildInfo memoises per root and
 * refresh re-reads. The studio's footer fallback in index.html must equal
 * package.json's version so the two cannot drift. Exit 0 = pass.
 */

import { mkdtempSync, rmSync, writeFileSync, cpSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildInfo, buildLabel, buildShortLabel, readBuildInfo, BUILD_FILE } from '../server/build-info.mjs';
import { buildLabelModel, renderBuildLabel } from '../studio/build-label.mjs';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = join(ROOT, 'tools', 'stamp-build.mjs');

const git = (cwd, ...args) => execFileSync('git', [
  '-c', 'user.email=test@example.test', '-c', 'user.name=build-info test',
  '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args,
], { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true }).trim();

let haveGit = true;
try { git(tmpdir(), '--version'); } catch { haveGit = false; }

const SCRATCH = mkdtempSync(join(tmpdir(), 'observogram-build-info-'));
try {
  const PKG = { name: 'build-info-fixture', version: '9.9.9' };

  // ---- a tree with neither git nor a stamp: package.json alone ----
  const bare = join(SCRATCH, 'bare');
  mkdirSync(bare);
  writeFileSync(join(bare, 'package.json'), JSON.stringify(PKG));
  const bareInfo = readBuildInfo(bare);
  assert(bareInfo.source === 'package', 'no git, no stamp → source package', bareInfo.source, 'package');
  assert(bareInfo.version === '9.9.9', 'package source still carries package.json version', bareInfo.version, '9.9.9');
  assert(bareInfo.build === null && bareInfo.commit === null && bareInfo.branch === null && bareInfo.date === null && bareInfo.dirty === false,
    'package source: build/commit/branch/date null, dirty false', bareInfo);
  assert(buildLabel(bareInfo) === 'v9.9.9 · build unknown', 'buildLabel without a build number', buildLabel(bareInfo), 'v9.9.9 · build unknown');
  assert(buildShortLabel(bareInfo) === 'v9.9.9 · build unknown', 'buildShortLabel without a build number', buildShortLabel(bareInfo));

  // stamp-build refuses to invent a stamp there (exit 2, no file)
  let stampStatus = null;
  try { execFileSync(process.execPath, [STAMP, '--root', bare], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); stampStatus = 0; }
  catch (e) { stampStatus = e.status; }
  assert(stampStatus === 2 && !existsSync(join(bare, BUILD_FILE)), 'stamp-build on a git-less tree exits 2 and writes nothing', { stampStatus, exists: existsSync(join(bare, BUILD_FILE)) });
  // …and removes a stale one rather than leave a lie behind
  writeFileSync(join(bare, BUILD_FILE), JSON.stringify({ build: 1, commit: 'stale00' }));
  try { execFileSync(process.execPath, [STAMP, '--root', bare], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch { /* exit 2 is the point */ }
  assert(!existsSync(join(bare, BUILD_FILE)), 'stamp-build removes a stale build.json from a git-less tree');

  // ---- the stamp file read on its own ----
  const stampedOnly = join(SCRATCH, 'stamped-only');
  mkdirSync(stampedOnly);
  writeFileSync(join(stampedOnly, 'package.json'), JSON.stringify(PKG));
  writeFileSync(join(stampedOnly, BUILD_FILE), JSON.stringify({ version: '1.0.0', build: 42, commit: 'abcdef0', branch: 'release', dirty: false, date: '2026-09-22T10:00:00+02:00' }));
  const stampedInfo = readBuildInfo(stampedOnly);
  assert(stampedInfo.source === 'file' && stampedInfo.build === 42 && stampedInfo.commit === 'abcdef0' && stampedInfo.branch === 'release' && stampedInfo.dirty === false && stampedInfo.date === '2026-09-22T10:00:00+02:00',
    'build.json → source file with its fields', stampedInfo);
  assert(stampedInfo.version === '9.9.9', 'package.json version wins over the stamp\'s', stampedInfo.version, '9.9.9');
  assert(buildLabel(stampedInfo) === 'v9.9.9 · build 42 · abcdef0 · release', 'buildLabel from a stamp', buildLabel(stampedInfo));
  writeFileSync(join(stampedOnly, BUILD_FILE), '{ not json');
  assert(readBuildInfo(stampedOnly).source === 'package', 'a corrupt build.json falls through to package', readBuildInfo(stampedOnly).source, 'package');

  // ---- label formatting on hand-made info ----
  const develop = { version: '0.4.0', build: 975, commit: '9c4f827', branch: 'develop', dirty: false, date: null, source: 'git' };
  assert(buildLabel(develop) === 'v0.4.0 · build 975 · 9c4f827 · develop', 'buildLabel: clean git', buildLabel(develop));
  assert(buildLabel({ ...develop, dirty: true }) === 'v0.4.0 · build 975 · 9c4f827 · develop · dirty', 'buildLabel: dirty appends', buildLabel({ ...develop, dirty: true }));
  assert(buildLabel({ ...develop, build: null }) === 'v0.4.0 · build unknown', 'buildLabel: null build says unknown, nothing else', buildLabel({ ...develop, build: null }));
  assert(buildLabel({ ...develop, branch: null }) === 'v0.4.0 · build 975 · 9c4f827', 'buildLabel: no branch, no trailing separator', buildLabel({ ...develop, branch: null }));
  assert(buildShortLabel(develop) === 'v0.4.0 · build 975', 'buildShortLabel: version + build only', buildShortLabel(develop));
  assert(/^v0\.4\.0\b/.test(buildLabel(develop)), 'the version is the first token of the label');

  // ---- the studio model + renderer (headless) ----
  assert(buildLabelModel(null) === null && buildLabelModel('nope') === null, 'buildLabelModel: nothing → null (the fallback stays)');
  const model = buildLabelModel({ ...develop, label: buildLabel(develop), date: '2026-09-22T10:00:00+02:00' });
  assert(model.label === 'v0.4.0 · build 975 · 9c4f827 · develop' && model.shortLabel === 'v0.4.0 · build 975', 'buildLabelModel: label + short label', model);
  assert(model.title === '2026-09-22T10:00:00+02:00 · source: git', 'buildLabelModel: title is the ISO date + source', model.title);
  assert(model.commit === '9c4f827' && model.branch === 'develop' && model.dirty === false && model.build === 975, 'buildLabelModel: structured fields ride along', model);
  const noLabel = buildLabelModel({ version: '0.4.0', build: null, source: 'package' });
  assert(noLabel.label === 'v0.4.0 · build unknown' && noLabel.title === 'commit date unknown · source: package', 'buildLabelModel: composes when the server sent no label', noLabel);
  const span = { textContent: 'v0.4.0', title: 'fallback' };
  renderBuildLabel(span, null);
  assert(span.textContent === 'v0.4.0' && span.title === 'fallback', 'renderBuildLabel: null model leaves the fallback');
  renderBuildLabel(span, model);
  assert(span.textContent === model.label && span.title === model.title, 'renderBuildLabel: paints label + title', span);

  // ---- a real repository ----
  if (!haveGit) {
    process.stdout.write('  (git not available: the repository cases are skipped)\n');
  } else {
    const repo = join(SCRATCH, 'repo');
    mkdirSync(repo);
    writeFileSync(join(repo, 'package.json'), JSON.stringify(PKG));
    git(repo, 'init', '-q');
    for (const n of [1, 2, 3]) {
      writeFileSync(join(repo, `f${n}.txt`), `${n}\n`);
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', `commit ${n}`);
    }
    const sha = git(repo, 'rev-parse', '--short', 'HEAD');
    const branch = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD');
    const first = buildInfo({ root: repo });
    assert(first.source === 'git', 'git repo → source git', first.source, 'git');
    assert(first.build === 3, 'three commits → build 3', first.build, 3);
    assert(first.commit === sha, 'commit is git\'s short sha', first.commit, sha);
    assert(first.branch === branch, 'branch is git\'s abbrev-ref', first.branch, branch);
    assert(first.dirty === false, 'a clean tree is not dirty', first.dirty, false);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(first.date || ''), 'date is the ISO commit date', first.date);
    assert(first.version === '9.9.9', 'version is package.json\'s', first.version, '9.9.9');
    assert(buildLabel(first) === `v9.9.9 · build 3 · ${sha} · ${branch}`, 'buildLabel from git', buildLabel(first));
    assert(Object.isFrozen(first), 'the info object is frozen');

    // caching: same object until refresh
    writeFileSync(join(repo, 'f4.txt'), 'uncommitted\n');
    assert(buildInfo({ root: repo }) === first, 'buildInfo memoises per root (git ran once)');
    assert(buildInfo({ root: repo }).dirty === false, 'the memo does not see the new file');
    const refreshed = buildInfo({ root: repo, refresh: true });
    assert(refreshed !== first && refreshed.dirty === true, 'refresh re-reads: a fourth uncommitted file flips dirty', refreshed.dirty, true);
    assert(refreshed.build === 3 && refreshed.commit === sha, 'dirty does not change build or commit', { build: refreshed.build, commit: refreshed.commit });
    assert(buildInfo({ root: repo }) === refreshed, 'the refreshed answer is the new memo');
    assert(buildLabel(refreshed) === `v9.9.9 · build 3 · ${sha} · ${branch} · dirty`, 'buildLabel: dirty from git', buildLabel(refreshed));

    // a git-less copy nested inside the repository borrows nothing
    const nested = join(repo, 'nested-copy');
    mkdirSync(nested);
    writeFileSync(join(nested, 'package.json'), JSON.stringify(PKG));
    assert(readBuildInfo(nested).source === 'package', 'a git-less tree inside another repo does not report that repo\'s commits', readBuildInfo(nested).source, 'package');

    // stamp, then copy without .git
    const stampOut = execFileSync(process.execPath, [STAMP, '--root', repo], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
    assert(/^stamped build\.json: v9\.9\.9 · build 3 · /.test(stampOut), 'stamp-build prints the label it wrote', stampOut.trim());
    const stamped = JSON.parse(readFileSync(join(repo, BUILD_FILE), 'utf8'));
    assert(stamped.build === 3 && stamped.commit === sha && stamped.branch === branch && stamped.dirty === true && stamped.version === '9.9.9' && typeof stamped.date === 'string' && typeof stamped.stampedAt === 'string',
      'build.json carries build/commit/branch/dirty/date/version', stamped);
    const copy = join(SCRATCH, 'copy');
    cpSync(repo, copy, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) });
    assert(!existsSync(join(copy, '.git')), 'the copy has no .git');
    const copied = readBuildInfo(copy);
    assert(copied.source === 'file', 'copied tree + build.json → source file', copied.source, 'file');
    assert(copied.build === 3 && copied.commit === sha && copied.branch === branch && copied.dirty === true && copied.date === stamped.date,
      'the copy reads the stamped fields', copied);
    assert(buildLabel(copied) === `v9.9.9 · build 3 · ${sha} · ${branch} · dirty`, 'buildLabel from the stamp equals the git label', buildLabel(copied));
    // the stamp is a JSON side file, never an executable
    const stampJson = execFileSync(process.execPath, [STAMP, '--root', repo, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
    assert(JSON.parse(stampJson).build === 3, 'stamp-build --json echoes the stamp', stampJson.trim());
  }

  // ---- this repository ----
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const here = buildInfo();
  assert(here.version === pkg.version, 'the default root is this repo: version is package.json\'s', here.version, pkg.version);
  assert(['git', 'file', 'package'].includes(here.source), 'source is one of git | file | package', here.source);
  if (here.source === 'git') {
    assert(Number.isInteger(here.build) && here.build > 0, 'this checkout: build is a positive integer', here.build);
    assert(/^[0-9a-f]{7,}$/.test(here.commit || ''), 'this checkout: commit is a short sha', here.commit);
  }
  assert(buildInfo() === here, 'the default root is memoised too');

  // ---- the footer fallback cannot drift from package.json ----
  const html = readFileSync(join(ROOT, 'studio', 'index.html'), 'utf8');
  const m = /<span id="build-label"[^>]*>v([^<]+)<\/span>/.exec(html);
  assert(!!m, 'studio/index.html carries the <span id="build-label"> fallback');
  assert(m && m[1] === pkg.version, 'the footer fallback equals package.json version', m && m[1], pkg.version);
  assert(!/Observogram v\d/.test(readFileSync(join(ROOT, 'studio', 'app.css'), 'utf8').split('\n').slice(0, 3).join('\n')), 'app.css header carries no stale version number');
} finally {
  rmSync(SCRATCH, { recursive: true, force: true });
}

report('build-info');
