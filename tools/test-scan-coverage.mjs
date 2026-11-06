#!/usr/bin/env node
/**
 * tools/test-scan-coverage.mjs — a scan never leaves a file out in silence,
 * and never reads a secrets file or one git ignores.
 *
 *   1. the .gitignore matcher (tools/lib/gitignore.mjs): git's patterns —
 *      anchoring, `**`, folders only, negation, a deeper file after its
 *      parents', a file under an ignored folder staying ignored;
 *   2. the crawler's rule (tools/lib/crawler.mjs): a secrets file is never
 *      read (scanReadsPath) and is named (scanRefusal, SCAN_WHY); the
 *      handle walker honours .gitignore; the crawl summary names the files it
 *      recognised as nothing; scanReport bounds what a run record keeps;
 *   3. the host read (server/github-crawl.mjs planCrawlerFetch,
 *      settleFetched, fetchGithubFiles): the crawler's rule decides what is
 *      read, the keywords only order it under the 200-file cap, the cap's
 *      loss is counted, the files reach crawlFiles in path order whatever
 *      order they downloaded in, GitHub's truncation is returned;
 *   4. the folder read (tools/lib/repo-folder.mjs readRepoFolder, journey's
 *      scanRepoFolder): .cjs/.jsx and .observability read, .gitignore and
 *      secrets honoured, the caps deterministic and named;
 *   5. the record: runJourney keeps packA.scan, and a run told nothing (Check
 *      now on the last scan) keeps the scan of the newest record of the same
 *      Pack A file;
 *   6. the board and the toast words (studio/overview-model.mjs scanModel,
 *      scanLossText).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRATCH = mkdtempSync(join(tmpdir(), 'observogram-scan-coverage-'));
process.env.OBSERVOGRAM_WORKSPACE = join(SCRATCH, 'ws');
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const { createGitignore, parseGitignore } = await import('./lib/gitignore.mjs');
const {
  crawlFiles, scanReadsPath, scanRefusal, scanRefusesName, SCAN_WHY, SCAN_MAX_FILE_BYTES,
  walkScanFolder, gitignoreOf, scanHonoursGitignore, scanReport, SCAN_REPORT_SHOWN,
} = await import('./lib/crawler.mjs');
const { planCrawlerFetch, selectCrawlerFiles, settleFetched, fetchGithubFiles, HOST_READ_CAPS } = await import('../server/github-crawl.mjs');
const { readRepoFolder } = await import('./lib/repo-folder.mjs');
const { scanRepoFolder, walkRepoFiles, runJourney, readJourneyRuns } = await import('./lib/journey.mjs');
const { scanModel, scanLossText } = await import('../studio/overview-model.mjs');

const write = (root, files) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
};

// ---------- 1. the .gitignore matcher ----------

test('gitignore: a name at any depth, an anchored path, a folder only, `**`, negation, a deeper file after its parents\'', () => {
  const g = createGitignore();
  g.add('', [
    '# a comment', '', 'values-secrets.yaml', '/local.yaml', 'tmp/', '*.log', 'build/**/out.json',
    '**/generated/*.json', 'keep/*.yaml', '!keep/this.yaml', 'docs/[a-c].yaml', '\\#hash.yaml', 'trail.yaml   ',
  ].join('\n'));
  g.add('k8s', 'overlay.yaml\n!values-secrets.yaml\n');
  const ig = (p, dir = false) => g.ignores(p, { dir });
  assert.ok(ig('values-secrets.yaml') && ig('charts/x/values-secrets.yaml'), 'a pattern with no slash matches the name at any depth');
  assert.ok(ig('local.yaml') && !ig('sub/local.yaml'), 'a leading slash anchors it to its .gitignore\'s folder');
  assert.ok(ig('tmp', true) && ig('a/tmp', true) && !ig('tmp'), 'a trailing slash: a folder only');
  assert.ok(ig('x.log') && ig('a/b/x.log'));
  assert.ok(ig('build/out.json') && ig('build/a/b/out.json') && !ig('other/out.json'), '`/**/` is zero or more folders');
  assert.ok(ig('generated/a.json') && ig('x/y/generated/a.json') && !ig('generated/sub/a.json'), '`**/` leads anywhere; `*` never crosses a slash');
  assert.ok(ig('keep/that.yaml') && !ig('keep/this.yaml'), '`!` re-includes; the last match decides');
  assert.ok(ig('docs/b.yaml') && !ig('docs/d.yaml'), 'a character class');
  assert.ok(ig('#hash.yaml') && ig('trail.yaml'), 'an escaped #, trailing blanks dropped');
  assert.ok(ig('k8s/overlay.yaml') && !ig('overlay.yaml'), 'a deeper .gitignore covers its own folder only');
  assert.ok(!ig('k8s/values-secrets.yaml') && ig('k8s/sub/values-secrets.yaml') === false, 'a deeper file\'s negation comes after its parents\' pattern');
  assert.equal(g.ignoredAt('tmp/rules/a.yaml'), 'tmp', 'ignoredAt: the folder git ignores on the way');
  assert.equal(g.ignoredAt('keep/that.yaml'), 'keep/that.yaml');
  assert.equal(g.ignoredAt('src/a.yaml'), null);
  const tmpOnly = createGitignore();
  tmpOnly.add('', 'tmp/\n!tmp/rules.yaml\n');
  assert.equal(tmpOnly.ignoredAt('tmp/rules.yaml'), 'tmp', 'a file under an ignored folder stays ignored, whatever a later pattern says');
  assert.deepEqual(parseGitignore('# only\n\n').length, 0);
});

// ---------- 2. the crawler's rule ----------

test('a secrets file is never read and is named; a source file named for secrets is read', () => {
  for (const p of ['values-secrets.yaml', 'k8s/charts/krystalinex/values-secrets.yaml', 'secret.yaml', 'db-Secrets.json', 'templates/sealed-secret.yml']) {
    assert.equal(scanReadsPath(p), false, p);
    assert.equal(scanRefusal(p), SCAN_WHY.secret, p);
    assert.ok(scanRefusesName(p.split('/').pop()), p);
  }
  assert.ok(scanReadsPath('src/secretsManager.ts') && scanRefusal('src/secretsManager.ts') === null, 'only YAML and JSON: a source file is code, not a values file');
  assert.equal(scanRefusal('node_modules/x/secret.yaml'), null, 'what the rule never looks at is named nowhere');
  assert.ok(scanReadsPath('a/b.cjs') && scanReadsPath('a/b.jsx') && scanReadsPath('.observability/slo.yaml'));
  const g = gitignoreOf([{ path: 'repo/.gitignore', text: 'local/\n' }, { path: 'repo/node_modules/x/.gitignore', text: '*\n' }], { skipRoot: true });
  assert.equal(scanRefusal('repo/local/rules.yaml', { skipRoot: true, gitignore: g }), 'git ignores the folder local/ (.gitignore)');
  assert.equal(scanRefusal('repo/rules.yaml', { skipRoot: true, gitignore: g }), null);
  assert.ok(scanHonoursGitignore('repo/a/.gitignore', { skipRoot: true }) && !scanHonoursGitignore('repo/node_modules/x/.gitignore', { skipRoot: true }), 'a .gitignore under a folder the scan never enters is not read');
});

test('walkScanFolder honours the folder\'s .gitignore files and hands every file it leaves out to onSkip', async () => {
  const file = (name, text = '') => ({ kind: 'file', name, getFile: async () => ({ text: async () => text }) });
  const dir = (name, children) => ({ kind: 'directory', name, async *entries() { for (const c of children) yield [c.name, c]; } });
  const root = dir('repo', [
    file('.gitignore', 'local.yaml\ncache/\n'),
    file('local.yaml'), file('rules.yaml'), file('values-secrets.yaml'),
    dir('cache', [file('a.yaml')]),
    dir('k8s', [file('.gitignore', 'overlay.yaml\n'), file('overlay.yaml'), file('deploy.yaml')]),
    dir('node_modules', [file('x.yaml')]),
  ]);
  const read = [];
  const skipped = [];
  const notEntered = await walkScanFolder(root, async (rel) => { read.push(rel); }, undefined, { onSkip: (rel, why) => skipped.push([rel, why]) });
  assert.deepEqual(read, ['repo/k8s/deploy.yaml', 'repo/rules.yaml']);
  assert.deepEqual(skipped, [
    ['repo/cache/', SCAN_WHY.gitignoredFolder],
    ['repo/k8s/overlay.yaml', SCAN_WHY.gitignored],
    ['repo/local.yaml', SCAN_WHY.gitignored],
    ['repo/values-secrets.yaml', SCAN_WHY.secret],
  ]);
  assert.equal(notEntered, 1, 'node_modules: not entered, not listed');
});

test('crawlFiles names the files it read and recognised as nothing; scanReport keeps the read, the summary and bounded lists', () => {
  const files = {
    'prometheus/rules.yml': 'groups:\n  - name: g\n    rules:\n      - alert: Down\n        expr: up == 0\n',
    'notes/config-of-nothing.json': '{"a": 1}',
    'scripts/chaos-scenarios.js': 'console.log("hi")\n',
  };
  const { summary } = crawlFiles(files, { repoName: 'svc' });
  assert.deepEqual([summary.files.unclassified, summary.files.unknown.sort()], [2, ['notes/config-of-nothing.json', 'scripts/chaos-scenarios.js']]);
  const many = Array.from({ length: SCAN_REPORT_SHOWN + 7 }, (_, i) => ({ path: `x/${String(i).padStart(3, '0')}.yaml`, why: SCAN_WHY.gitignored }));
  const report = scanReport({ source: 'the folder /r', ref: null, files, candidates: 9, capped: 2, truncated: true, skipped: many }, summary);
  assert.deepEqual(
    [report.source, report.files, report.candidates, report.capped, report.truncated, report.skipped, report.skippedFiles.length, report.unclassified, report.unknownFiles.length],
    ['the folder /r', 3, 9, 2, true, SCAN_REPORT_SHOWN + 7, SCAN_REPORT_SHOWN, 2, 2],
  );
  assert.ok(report.byKind['prometheus-rules'] === 1 && report.classified === 1 && Array.isArray(report.warnings));
  assert.deepEqual(scanReport({ files: {}, skipped: [] }).files, 0, 'no summary: the read alone');
});

test('the environment scope\'s exclusions reach the report: the files another deployment profile owns', () => {
  const files = {
    'k8s/prod/values.yaml': 'replicaCount: 2\n',
    'docker-compose.yml': 'services:\n  prometheus:\n    image: prom/prometheus:v2.51.0\n',
    'monitoring/alertmanager.yml': 'route:\n  receiver: r\nreceivers:\n  - name: r\n',
  };
  const { summary } = crawlFiles(files, { repoName: 'svc', environment: 'prod' });
  const report = scanReport({ files }, summary);
  assert.equal(report.environment.excluded, summary.files.excludedByEnvironment);
  assert.deepEqual(report.environment.excludedFiles, summary.environment.excluded.slice(0, SCAN_REPORT_SHOWN));
  assert.equal(report.environment.profile, summary.environment.profile);
});

// ---------- 3. the host read ----------

// A tree shaped like the audit's: the keyword files, a monorepo's many plain
// sources, the chaos files the keyword list never named, tests and a lock file.
const TREE = [
  { type: 'tree', path: 'server' },
  ...Array.from({ length: 250 }, (_, i) => ({ type: 'blob', path: `apps/svc-${String(i).padStart(3, '0')}/index.ts`, size: 100 })),
  { type: 'blob', path: 'server/middleware/chaos.ts', size: 100 },
  { type: 'blob', path: 'scripts/chaos-scenarios.js', size: 100 },
  { type: 'blob', path: 'server/metrics.ts', size: 100 },
  { type: 'blob', path: 'monitoring/alertmanager.yml', size: 100 },
  { type: 'blob', path: 'config.yaml', size: 100 },
  { type: 'blob', path: 'test/fixtures/a.json', size: 100 },
  { type: 'blob', path: 'package-lock.json', size: 100 },
  { type: 'blob', path: 'k8s/charts/x/values-secrets.yaml', size: 100 },
  { type: 'blob', path: 'dashboards/huge.json', size: SCAN_MAX_FILE_BYTES + 1 },
  { type: 'blob', path: 'README.md', size: 100 },
  { type: 'blob', path: '.github/workflows/ci.yml', size: 100 },
];

test('planCrawlerFetch: the crawler\'s rule decides what is read; the keywords only order it under the cap, whose loss is counted', () => {
  const plan = planCrawlerFetch(TREE, HOST_READ_CAPS);
  // 250 + chaos.ts + chaos-scenarios.js + metrics.ts + alertmanager + config + fixture + lock + huge
  assert.equal(plan.candidates, 258, 'every blob the rule reads counts, the secrets file and the dot-folder never');
  assert.equal(plan.selected.length, HOST_READ_CAPS.maxFiles);
  assert.equal(plan.capped, 258 - HOST_READ_CAPS.maxFiles - 1, 'the cap\'s loss is counted (the oversized file is named instead)');
  assert.deepEqual(plan.selected.slice(0, 5).map((n) => n.path), ['server/middleware/chaos.ts', 'scripts/chaos-scenarios.js', 'server/metrics.ts', 'monitoring/alertmanager.yml', 'config.yaml'],
    'the keyword names first — a chaos source among them, so the cap never reaches it — then the exporter candidates');
  assert.deepEqual(plan.skipped, [
    { path: 'k8s/charts/x/values-secrets.yaml', why: SCAN_WHY.secret },
    { path: 'dashboards/huge.json', why: SCAN_WHY.tooLarge(SCAN_MAX_FILE_BYTES) },
  ]);
  const all = planCrawlerFetch(TREE, { ...HOST_READ_CAPS, maxFiles: 1000 }).selected.map((n) => n.path);
  assert.ok(all.includes('server/middleware/chaos.ts') && all.includes('scripts/chaos-scenarios.js'), 'with room, a file no keyword names is read — the audit\'s chaos files');
  assert.deepEqual(all.slice(-2), ['test/fixtures/a.json', 'package-lock.json'], 'tests, fixtures and lock files last');
  assert.ok(!all.includes('README.md') && !all.includes('.github/workflows/ci.yml'));
  assert.deepEqual(selectCrawlerFiles(TREE, HOST_READ_CAPS), plan.selected, 'selectCrawlerFiles is the plan\'s blobs');
  const budget = planCrawlerFetch([{ type: 'blob', path: 'a.rules.yaml', size: 60 }, { type: 'blob', path: 'b.rules.yaml', size: 60 }, { type: 'blob', path: 'c.rules.yaml', size: 30 }], { totalCapBytes: 100 });
  assert.deepEqual([budget.selected.map((n) => n.path), budget.skipped], [['a.rules.yaml', 'c.rules.yaml'], [{ path: 'b.rules.yaml', why: SCAN_WHY.totalCap(100) }]], 'the total cap by the tree\'s sizes, in plan order, named');
});

test('settleFetched: files in path order whatever order they arrived in; the caps in plan order; a failed download named', () => {
  const selected = ['z.rules.yaml', 'a.rules.yaml', 'm.rules.yaml', 'bad.rules.yaml'].map((path) => ({ path }));
  const texts = new Map([['m.rules.yaml', { text: 'mm' }], ['bad.rules.yaml', { error: 'GitHub 500' }], ['a.rules.yaml', { text: 'aaaa' }], ['z.rules.yaml', { text: 'zzzz' }]]);
  const out = settleFetched(selected, texts, { totalCapBytes: 9, planned: [{ path: 'c.yaml', why: 'x' }] });
  assert.deepEqual(Object.keys(out.files), ['a.rules.yaml', 'z.rules.yaml'], 'path order; m is past the total in plan order (z, a, m)');
  assert.deepEqual(out.skipped, [
    { path: 'bad.rules.yaml', why: 'it could not be downloaded (GitHub 500)' },
    { path: 'c.yaml', why: 'x' },
    { path: 'm.rules.yaml', why: SCAN_WHY.totalCap(9) },
  ]);
});

test('fetchGithubFiles: the downloads finish in any order and reach the crawler in path order; capped, candidates and GitHub\'s truncation are returned', async () => {
  const tree = [{ type: 'blob', path: 'z/metrics.ts' }, { type: 'blob', path: 'a/alerts.rules.yaml' }, { type: 'blob', path: 'm/dashboards/x.json' }];
  const delay = { 'z/metrics.ts': 1, 'a/alerts.rules.yaml': 30, 'm/dashboards/x.json': 15 };
  const arrived = [];
  const fetchFn = async (path) => (path.includes('/git/trees/') ? new Response(JSON.stringify({ tree, truncated: true })) : null);
  const rawFn = async (_o, _r, _ref, path) => {
    await new Promise((r) => setTimeout(r, delay[path]));
    arrived.push(path);
    return new Response(`# ${path}`);
  };
  const out = await fetchGithubFiles({ owner: 'acme', repo: 'shop', ref: 'main' }, { fetchFn, rawFn });
  assert.notDeepEqual(arrived, Object.keys(out.files), 'the downloads arrived out of path order');
  assert.deepEqual(Object.keys(out.files), ['a/alerts.rules.yaml', 'm/dashboards/x.json', 'z/metrics.ts']);
  assert.deepEqual([out.candidates, out.capped, out.truncated, out.skipped], [3, 0, true, []]);
});

// ---------- 4. the folder read ----------

test('readRepoFolder: the crawler\'s rule (.cjs, .jsx, .observability, no 1 MiB cap), .gitignore and secrets honoured, every file left out named', () => {
  const root = write(join(SCRATCH, 'repo'), {
    '.gitignore': 'values-local.yaml\ntmp/\n',
    'values-local.yaml': 'secret: hunter2\n',
    'tmp/rules.yaml': 'groups: []\n',
    'k8s/charts/x/values-secrets.yaml': 'password: hunter2\n',
    'k8s/charts/x/values.yaml': 'replicaCount: 1\n',
    'k8s/.gitignore': 'overlay.yaml\n',
    'k8s/overlay.yaml': 'x: 1\n',
    'src/metrics.cjs': 'module.exports = 1\n',
    'src/panel.jsx': 'export default 1\n',
    '.observability/slo.yaml': 'slos: []\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'node_modules/x/index.js': '',
    'big/huge.json': 'x'.repeat(2 * 1024 * 1024),
    'README.md': '# readme\n',
  });
  const read = readRepoFolder(root);
  assert.deepEqual(Object.keys(read.files), ['.observability/slo.yaml', 'big/huge.json', 'k8s/charts/x/values.yaml', 'src/metrics.cjs', 'src/panel.jsx'], 'in path order; a 2 MiB file is read (the scan\'s cap is 5 MiB)');
  assert.deepEqual(read.skipped, [
    { path: 'k8s/charts/x/values-secrets.yaml', why: SCAN_WHY.secret },
    { path: 'k8s/overlay.yaml', why: SCAN_WHY.gitignored },
    { path: 'tmp/', why: SCAN_WHY.gitignoredFolder },
    { path: 'values-local.yaml', why: SCAN_WHY.gitignored },
  ]);
  assert.ok(!JSON.stringify(read.files).includes('hunter2'), 'no secret was read');
  assert.equal(read.notEntered, 2, '.github and node_modules: not entered, not listed');
  const capped = readRepoFolder(root, { maxTotalBytes: 2 * 1024 * 1024 });
  assert.deepEqual(capped.skipped.filter((s) => /in all/.test(s.why)), [{ path: 'big/huge.json', why: SCAN_WHY.totalCap(2 * 1024 * 1024) }], 'the file that does not fit under the total, in path order, named');
  assert.deepEqual(Object.keys(capped.files), ['.observability/slo.yaml', 'k8s/charts/x/values.yaml', 'src/metrics.cjs', 'src/panel.jsx'], 'the files after it that fit are still read');
  const tooBig = write(join(SCRATCH, 'repo-big'), { 'a.json': 'x'.repeat(SCAN_MAX_FILE_BYTES + 1) });
  assert.deepEqual(readRepoFolder(tooBig).skipped, [{ path: 'a.json', why: SCAN_WHY.tooLarge() }]);
  assert.deepEqual(walkRepoFiles(root), read.files, 'walkRepoFiles is the same read');
  assert.deepEqual(scanRepoFolder(root).skipped, read.skipped);
});

test('scanRepoFolder: a path outside the org\'s part is named, never read (the crawl scope)', () => {
  const base = join(SCRATCH, 'scope');
  const own = join(base, 'orgs', 'beta');
  write(join(base, 'orgs', 'alpha', 'repo'), { 'rules.yaml': 'groups: []\n' });
  write(join(own, 'repo'), { 'rules.yaml': 'groups: []\n' });
  assert.throws(() => scanRepoFolder(join(base, 'orgs', 'alpha', 'repo'), { scope: { base, ownRoot: own } }), /another org's part/);
  assert.deepEqual(Object.keys(scanRepoFolder(join(own, 'repo'), { scope: { base, ownRoot: own } }).files), ['rules.yaml']);
});

// ---------- 5. the record ----------

test('runJourney keeps the scan as packA.scan; a run told nothing keeps the scan of the newest record of the same Pack A file', async () => {
  const { canonical } = crawlFiles({ 'prometheus/rules.yml': 'groups:\n  - name: g\n    rules:\n      - alert: Down\n        expr: up == 0\n' }, { repoName: 'svc' });
  const dir = join(SCRATCH, 'packs');
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'a.pack.json');
  writeFileSync(a, JSON.stringify(canonical));
  writeFileSync(join(dir, 'b.pack.json'), JSON.stringify(canonical));
  const def = { name: 'scan-carry', packA: { file: a }, packB: { file: join(dir, 'b.pack.json') }, gate: {} };
  const scan = scanReport({ source: 'the folder /r', files: { 'x.yaml': '' }, skipped: [{ path: 'values-secrets.yaml', why: SCAN_WHY.secret }] }, null);
  const first = await runJourney({ ...def }, { scan });
  assert.deepEqual(first.packA.scan, scan, 'the Run\'s scan is on the record');
  assert.deepEqual(readJourneyRuns('scan-carry', { limit: 1 })[0].packA.scan, scan, 'and on disk');
  const again = await runJourney({ ...def });
  assert.deepEqual(again.packA.scan, scan, 'Check now on the same Pack A file keeps the scan that made it');
  const other = join(dir, 'c.pack.json');
  writeFileSync(other, readFileSync(a, 'utf8'));
  const moved = await runJourney({ ...def, packA: { file: other } });
  assert.equal(moved.packA.scan, undefined, 'another Pack A file: no scan is claimed');
});

// ---------- 6. the board and the toast ----------

test('scanModel and scanLossText: the board\'s line and its groups, the toast\'s words; nothing for a record without a scan', () => {
  const run = { packA: { scan: {
    source: 'MoebiusX/KrystalineX on GitHub', files: 200, candidates: 396, capped: 196, truncated: false,
    skipped: 1, skippedFiles: [{ path: 'k8s/values-secrets.yaml', why: SCAN_WHY.secret }],
    unclassified: 62, unknownFiles: ['scripts/chaos-scenarios.js'],
    environment: { profile: 'prod', excluded: 14, excludedFiles: ['monitoring/alertmanager.yml'] },
    warnings: ['Environment scope "prod" excluded 14 file(s) from other deployment surfaces.'],
  } } };
  const m = scanModel({ run });
  assert.equal(m.sentence, 'Read 200 of 396 files from MoebiusX/KrystalineX on GitHub — 196 past the file cap, 1 not read, 14 left out by the prod scope, 62 recognised as nothing.');
  assert.equal(m.tone, 'warn');
  assert.deepEqual(m.groups.map((g) => [g.key, g.count, g.rows.length, g.more]), [['skipped', 1, 1, 0], ['capped', 196, 0, 196], ['excluded', 14, 1, 13], ['unknown', 62, 1, 61]]);
  assert.deepEqual(m.groups[0].rows[0], { path: 'k8s/values-secrets.yaml', why: SCAN_WHY.secret });
  assert.equal(m.warnings.length, 1);
  assert.equal(scanLossText({ files: 3, candidates: 3, skipped: 0, capped: 0 }), '', 'a scan that read all it takes says nothing more');
  assert.equal(scanModel({ run: { packA: {} } }), null);
  assert.equal(scanModel({ run: null }), null);
  assert.equal(scanModel({ run: { packA: { scan: { files: 3, candidates: 3, source: 'the folder /r' } } } }).tone, 'neutral');
});
