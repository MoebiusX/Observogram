#!/usr/bin/env node
// tools/test-downstream-digest.mjs — what tools/downstream-digest.mjs prints
// for one refresh, over a small repository built here with git: a "copy"
// commit and two upstream commits after it, which add CHANGELOG entries
// (classified, unclassified, one moved out of Unreleased), change exports,
// settings and goldens. It needs no history of this repository, so it runs
// in a shallow CI checkout and inside an export copy alike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogDigest, digest, exportDiff, parseNameStatus, renderDigest, settingName } from './downstream-digest.mjs';

const TOOL = resolve(dirname(fileURLToPath(import.meta.url)), 'downstream-digest.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'observogram-test-downstream-digest-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
const REPO = join(TMP, 'upstream');
mkdirSync(REPO);

const git = (...args) => {
  const r = spawnSync('git', ['-C', REPO, '-c', 'user.name=digest-test', '-c', 'user.email=digest-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${join(TMP, 'no-hooks')}`, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (path, text) => { mkdirSync(dirname(join(REPO, path)), { recursive: true }); writeFileSync(join(REPO, path), text); };
const manifest = (version, modules) => `${JSON.stringify({ manifestVersion: 1, version, modules: Object.fromEntries(Object.entries(modules).map(([k, exports]) => [k, { exports }])) }, null, 2)}\n`;
const cli = (...args) => {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

// The commit the copy holds: 0.1.0 and one entry still in Unreleased.
git('init', '-q');
put('package.json', '{ "version": "0.1.0" }\n');
put('docs/CHANGELOG.md', [
  '# Changelog', '',
  '## Unreleased', '',
  '### Added: the copy already has this', '- Moved verbatim into 0.2.0 later.', '',
  '## 0.1.0 — 2026-01-01', '',
  '### Added: the first release', '- Old.', '',
].join('\n'));
put('VENDOR-MANIFEST.json', manifest('0.1.0', { 'tools/lib/a.mjs': ['keep', 'dropped'], 'tools/lib/gone.mjs': ['z'] }));
put('server/conf.mjs', "const a = brandEnv('OLD_KNOB');\nconst b = process.env.OBSERVOGRAM_KEPT;\n");
put('server/test-conf.mjs', 'process.env.OBSERVOGRAM_TEST_ONLY_A = "1";\n');
put('tools/fixtures/golden/one.json', '{"v":1}\n');
put('tools/fixtures/golden/two.json', '{"renamed":"same bytes, a long enough body for git to see a rename"}\n');
put('tools/fixtures/golden/old.json', '{"old":true}\n');
git('add', '-A');
git('commit', '-q', '-m', 'the copy');
const SINCE = git('rev-parse', 'HEAD');

// Upstream after it: 0.1.1 (written before the convention), then 0.2.0.
put('docs/CHANGELOG.md', [
  '# Changelog', '',
  '## Unreleased', '',
  '### Changed: in Unreleased at the target', '- Something.', '- **Downstream:** behaviour — the grade reads it.', '',
  '## 0.2.0 — 2026-02-01', '',
  '**A summary line, not an entry.**', '',
  '### Added: the copy already has this', '- Moved verbatim into 0.2.0 later.', '',
  '### Added', '- **The knobs** are new.', '- **Downstream:** config, api — `OBSERVOGRAM_NEW_KNOB` is read and `fresh()` is exported.', '',
  '### Changed', '- **The store** moves to schema v9.', '- **Downstream:** one-way — 0.1.x refuses a store 0.2.0 opened; back it up first.', '',
  '### Fixed: a bullet the digest cannot read', '- **Downstream:** schema — moves.', '',
  '### Tests', '- `tools/test-x.mjs`.', '- **Downstream:** none — tests only.', '',
  '## 0.1.1 — 2026-01-15', '',
  '### Fixed: before the convention', '- No bullet.', '',
  '## 0.1.0 — 2026-01-01', '',
  '### Added: the first release', '- Old.', '',
].join('\n'));
git('add', '-A');
git('commit', '-q', '-m', 'the changelog');
put('package.json', '{ "version": "0.2.0" }\n');
put('VENDOR-MANIFEST.json', manifest('0.2.0', { 'tools/lib/a.mjs': ['keep', 'added'], 'tools/lib/new.mjs': ['fresh'] }));
put('server/conf.mjs', "const b = process.env.OBSERVOGRAM_KEPT;\nconst c = brandEnvFrom(env, 'NEW_KNOB');\nconst d = env.OBSERVOGRAM_ORG_ACME_HOOK_URL;\n");
put('studio/legacy.mjs', '// TOMOGRAPH_LEGACY_NAME is the old spelling\n');
put('server/test-conf.mjs', 'process.env.OBSERVOGRAM_TEST_ONLY_B = "1";\n');
put('tools/fixtures/other/settings.json', '{"OBSERVOGRAM_FIXTURE_ONLY":1}\n');
put('tools/fixtures/golden/one.json', '{"v":2}\n');
unlinkSync(join(REPO, 'tools/fixtures/golden/old.json'));
renameSync(join(REPO, 'tools/fixtures/golden/two.json'), join(REPO, 'tools/fixtures/golden/two-renamed.json'));
put('tools/fixtures/golden/new.json', '{"new":true}\n');
git('add', '-A');
git('commit', '-q', '-m', 'the code');
const TO = git('rev-parse', 'HEAD');

test('the digest counts the commits, groups the new entries by kind and lists the rest as unclassified', () => {
  const d = digest({ repo: REPO, since: SINCE, to: TO });
  assert.equal(d.since.commit, SINCE);
  assert.equal(d.to.commit, TO);
  assert.equal(d.since.version, '0.1.0');
  assert.equal(d.to.version, '0.2.0');
  assert.equal(d.commits, 2);
  assert.equal(d.sinceIsAncestor, true);
  const c = d.changelog;
  assert.equal(c.added, 6, 'the entry the copy already held is not added again');
  assert.deepEqual(c.entries.map((e) => e.label), ['Unreleased · Changed: in Unreleased at the target', '0.2.0 · Added: The knobs', '0.2.0 · Changed: The store', '0.2.0 · Tests']);
  assert.deepEqual(Object.fromEntries(Object.entries(c.byKind).map(([k, v]) => [k, v.map((e) => e.heading)])), {
    'one-way': ['Changed'],
    config: ['Added'],
    api: ['Added'],
    behaviour: ['Changed: in Unreleased at the target'],
    none: ['Tests'],
  });
  assert.equal(c.byKind.config[0].sentence, '`OBSERVOGRAM_NEW_KNOB` is read and `fresh()` is exported.');
  assert.deepEqual(c.unclassified, [
    { section: '0.2.0', heading: 'Fixed: a bullet the digest cannot read', label: '0.2.0 · Fixed: a bullet the digest cannot read', reason: 'names `schema`, not one of none, config, api, behaviour, one-way' },
    { section: '0.1.1', heading: 'Fixed: before the convention', label: '0.1.1 · Fixed: before the convention', reason: null },
  ]);
});

test('the digest diffs the manifest\'s exports, the settings and the goldens', () => {
  const d = digest({ repo: REPO, since: SINCE, to: TO });
  assert.deepEqual(d.exports, {
    since: '0.1.0', to: '0.2.0', sinceHasManifest: true, toHasManifest: true,
    added: [{ module: 'tools/lib/new.mjs', exports: ['fresh'] }],
    removed: [{ module: 'tools/lib/gone.mjs', exports: ['z'] }],
    changed: [{ module: 'tools/lib/a.mjs', added: ['added'], removed: ['dropped'] }],
  });
  assert.deepEqual(d.settings, {
    added: [
      { name: 'OBSERVOGRAM_LEGACY_NAME', files: ['studio/legacy.mjs'] },
      { name: 'OBSERVOGRAM_NEW_KNOB', files: ['server/conf.mjs'] },
      { name: 'OBSERVOGRAM_ORG_<KEY>_HOOK_URL', files: ['server/conf.mjs'] },
    ],
    removed: [{ name: 'OBSERVOGRAM_OLD_KNOB', files: ['server/conf.mjs'] }],
  }, 'test files and fixtures are left out; a per-org name is compared by the part after its key');
  assert.deepEqual(d.goldens, {
    added: ['tools/fixtures/golden/new.json'],
    changed: ['tools/fixtures/golden/one.json'],
    removed: ['tools/fixtures/golden/old.json'],
    renamed: [{ from: 'tools/fixtures/golden/two.json', path: 'tools/fixtures/golden/two-renamed.json' }],
  });
});

test('the command prints the digest, --json the same object, and --to defaults to HEAD', () => {
  const text = cli('--since', SINCE, '--repo', REPO);
  assert.equal(text.status, 0, text.stderr);
  const want = renderDigest(digest({ repo: REPO, since: SINCE, to: 'HEAD' }));
  assert.equal(text.stdout, want);
  for (const line of [
    /^Downstream digest: [0-9a-f]{40} \(0\.1\.0\) → HEAD [0-9a-f]{8} \(0\.2\.0\)$/m,
    /^2 commits \(2 without merges\)$/m,
    /^CHANGELOG entries added: 6 \(4 classified, 2 unclassified\)$/m,
    /^ {2}one-way \(1\) — an upgrade with no way back/m,
    /^ {4}0\.2\.0 · Added: The knobs \[config, api\]$/m,
    /^ {2}unclassified \(2\)/m,
    /^ {4}0\.1\.1 · Fixed: before the convention$/m,
    /^ {2}~ tools\/lib\/a\.mjs: \+ added; - dropped$/m,
    /^ {2}- OBSERVOGRAM_OLD_KNOB {2}\(was in server\/conf\.mjs\)$/m,
    /^Goldens under tools\/fixtures\/golden\/: 4 moved \(1 changed, 1 added, 1 removed, 1 renamed\)$/m,
    /^ {2}> two\.json → two-renamed\.json$/m,
  ]) assert.match(text.stdout, line);
  const json = cli('--since', SINCE, '--to', TO, '--repo', REPO, '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), JSON.parse(JSON.stringify(digest({ repo: REPO, since: SINCE, to: TO }))));
});

test('the command refuses what it cannot read, with a sentence and exit 2', () => {
  const none = cli('--repo', REPO);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /--since <commit> is required/);
  const unknown = cli('--since', 'no-such-ref', '--repo', REPO);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /no-such-ref is not a commit/);
  const inside = cli('--since', SINCE, '--repo', join(REPO, 'server'));
  assert.equal(inside.status, 2, 'a folder inside a checkout is what an export copy looks like to git');
  assert.match(inside.stderr, /is not the top of a git checkout/);
  const stray = cli('--since', SINCE, '--repo', REPO, '--frobnicate');
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /unknown argument --frobnicate/);
});

test('the pieces: names, rows, a missing manifest, an empty CHANGELOG', () => {
  assert.equal(settingName('OBSERVOGRAM_WORKSPACE'), 'WORKSPACE');
  assert.equal(settingName('TOMOGRAPH_WORKSPACE'), 'WORKSPACE');
  assert.equal(settingName("brandEnv('AUTH'"), 'AUTH');
  assert.equal(settingName("brandEnvFrom(env, 'OIDC_ISSUER'"), 'OIDC_ISSUER');
  assert.equal(settingName('OBSERVOGRAM_ORG_ACME_NOTIFY_PAGER_URL'), 'ORG_<KEY>_NOTIFY_PAGER_URL');
  assert.deepEqual(parseNameStatus('M\0a\0R087\0b\0c\0A\0d\0'), [{ status: 'M', path: 'a' }, { status: 'R', from: 'b', path: 'c' }, { status: 'A', path: 'd' }]);
  const first = exportDiff(null, { version: '0.2.0', modules: { 'tools/lib/x.mjs': { exports: ['b', 'a'] } } });
  assert.equal(first.sinceHasManifest, false);
  assert.deepEqual(first.added, [{ module: 'tools/lib/x.mjs', exports: ['a', 'b'] }]);
  const all = changelogDigest(null, '## Unreleased\n\n### Added: x\n- y\n');
  assert.equal(all.added, 1);
  assert.equal(all.unclassified[0].label, 'Unreleased · Added: x');
});
