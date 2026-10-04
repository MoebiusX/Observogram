// tools/test-platform.mjs — the Linux-runnable proofs behind the Windows
// support statement (README "Platforms"). No Windows box runs here, so the
// suite proves the IDIOMS the portable code relies on and guards the sources:
//
//   P1  a module-relative directory is resolved with fileURLToPath, never
//       URL.pathname (the drive-letter and percent-encoding facts, fed a
//       file:///C:/… URL; the three repaired resolvers on this host);
//   P2  the studio-bundle T1 missing-module assertion normalises the host
//       separator (and the site still does);
//   P3  server/fixtures/platform.mjs: win32 skips with the reason, linux runs;
//   P4  no URL.pathname is used as a filesystem path anywhere under server/,
//       tools/ or studio/;
//   P5  every platform branch of a suite goes through the fixture — no other
//       suite or fixture spells 'win32';
//   P6  every win32 skip states its reason, and README's count of the skip
//       sites is the count in the sources.
//
// A predicted-portable test that fails on a downstream's Windows run is fixed
// by a new reasoned skip site AND a README count bump — P6 forces both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, win32, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenize } from './gen-vendor-manifest.mjs';
import { WIN32, platformHelpers, isWin32 } from '../server/fixtures/platform.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).split(sep).join('/');
const FIXTURE = 'server/fixtures/platform.mjs';
const BUNDLE_SUITE = 'tools/test-studio-bundle.mjs';

// Every .mjs/.js under server/, tools/ and studio/, skipping node_modules,
// vendor and dot-directories (the sourceFiles idiom of test-store-guards).
function sourceFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'vendor' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.isFile() && /\.(mjs|js)$/.test(e.name)) out.push(relative(ROOT, p).split(sep).join('/'));
  }
  return out;
}
const ALL_SOURCES = ['server', 'tools', 'studio'].flatMap((d) => sourceFiles(join(ROOT, d))).sort();
// The suites and fixtures the skip rules govern.
const SUITES = ALL_SOURCES.filter((f) => /^(?:server|tools)\/test-[^/]+\.mjs$/.test(f) || /^server\/fixtures\/[^/]+\.mjs$/.test(f));
const read = (rel) => readFileSync(join(ROOT, ...rel.split('/')), 'utf8');

// Comments may explain the rules; only code must follow them.
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// P4: `new URL(…, import.meta.url).pathname` is `/C:/repo/…` on win32 and
// percent-encoded everywhere — over tokenizer-blanked code (strings, comments,
// templates and regex literals blanked, so a mention is not a use).
const PATHNAME_RE = /import\.meta\.url[^;\n]*\.pathname\b/;
// A hand-rolled drive strip of a pathname (the regex must survive, so this
// one runs over comment-stripped source, not the tokenizer's blanked code).
const DRIVE_STRIP_RE = /\.pathname\s*\.replace\(\s*\/\^\\\/\(\[A-Za-z\]:\)\//;
// P6: the fixture's two call forms and what a well-formed argument is.
const SKIP_CALL_RE = /\b(win32Skip|skipOnWin32)\(([^)]*)\)/g;
const REASON = "(?:'[^']{8,}'|WIN32\\.(?:modes|signals|symlinks))";
const WIN32_SKIP_ARG_RE = new RegExp(`^\\s*${REASON}\\s*$`);
const SKIP_ON_WIN32_ARG_RE = new RegExp(`^\\s*(?:t|null)\\s*,\\s*${REASON}\\s*$`);
const README_COUNT_RE = /(\d+) win32-skip sites/;

function pathnameUses(src) {
  const out = [];
  const { code } = tokenize(src);
  for (const [i, line] of code.split('\n').entries()) if (PATHNAME_RE.test(line)) out.push({ line: i + 1, rule: 'URL.pathname as a filesystem path' });
  const stripped = withoutComments(src);
  for (const [i, line] of stripped.split('\n').entries()) if (DRIVE_STRIP_RE.test(line)) out.push({ line: i + 1, rule: 'a hand-rolled drive strip of URL.pathname' });
  return out;
}

function win32Literals(src) {
  return tokenize(src).strings.filter((s) => s.value === 'win32').map((s) => lineOf(src, s.start));
}

function skipCalls(src) {
  const out = [];
  for (const m of src.matchAll(SKIP_CALL_RE)) {
    const [, fn, arg] = m;
    const ok = (fn === 'win32Skip' ? WIN32_SKIP_ARG_RE : SKIP_ON_WIN32_ARG_RE).test(arg);
    out.push({ fn, arg, ok, line: lineOf(src, m.index) });
  }
  return out;
}

test('P1 a module-relative directory is resolved with fileURLToPath, never URL.pathname: drive letter, percent-encoding', () => {
  const here = 'file:///C:/Users/Jane%20Doe/repo/tools/test-brand.mjs';
  const parent = new URL('..', here);
  // The bug: a leading slash before the drive and the space still encoded…
  assert.equal(parent.pathname, '/C:/Users/Jane%20Doe/repo/');
  // …so path.win32 treats it as drive-relative — `<cwd drive>:\C:\…` on a real Windows.
  assert.equal(win32.join(parent.pathname, 'studio', 'index.html'), '\\C:\\Users\\Jane%20Doe\\repo\\studio\\index.html');
  // fileURLToPath: the drive, the separators and the decoded space.
  assert.equal(fileURLToPath(parent, { windows: true }), 'C:\\Users\\Jane Doe\\repo\\');
  assert.equal(fileURLToPath(new URL('..', 'file:///home/jane%20doe/repo/tools/t.mjs'), { windows: false }), '/home/jane doe/repo/');
  assert.equal(new URL('..', 'file:///home/jane%20doe/repo/tools/t.mjs').pathname, '/home/jane%20doe/repo/', 'percent-encoded on every platform');

  // The three repaired resolvers, as written, on this host.
  const href = (...p) => pathToFileURL(join(ROOT, ...p)).href;
  assert.equal(resolve(fileURLToPath(new URL('..', href('tools', 'test-brand.mjs')))), ROOT, 'test-brand: ROOT (resolve drops the trailing separator)');
  assert.equal(fileURLToPath(new URL('./fixtures/crawl/operational-alerts/', href('tools', 'test-crawl-alerting-rules.mjs'))), join(ROOT, 'tools', 'fixtures', 'crawl', 'operational-alerts') + sep, 'test-crawl-alerting-rules: the fixture directory, trailing separator kept');
  assert.equal(join(fileURLToPath(new URL('../', href('tools', 'test-deploy-manifests.mjs'))), 'deploy', 'k8s'), join(ROOT, 'deploy', 'k8s'), 'test-deploy-manifests: K8S');
});

test('P2 the T1 missing-module assertion normalises the host separator', () => {
  const wanted = /tools\/lib\/does-not-exist\.mjs/;
  const winText = "ENOENT: no such file or directory, open 'C:\\r\\tools\\lib\\does-not-exist.mjs'";
  const posixText = "ENOENT: no such file or directory, open '/r/tools/lib/does-not-exist.mjs'";
  assert.equal(wanted.test(winText), false, 'the bare regex fails on the win32 text');
  assert.ok(wanted.test(winText.split(win32.sep).join('/')), 'normalised, it matches');
  assert.ok(wanted.test(posixText.split(posix.sep).join('/')), 'the posix text matches unchanged');
  assert.equal(posixText.split(posix.sep).join('/'), posixText);

  // The site itself still normalises: the T1 line that reads the host file for
  // the probe's target (the ENOENT text names the host path).
  const sites = read(BUNDLE_SUITE).split('\n').filter((l) => l.includes('does-not-exist') && l.includes('readFileSync(join(ROOT'));
  assert.equal(sites.length, 1, 'T1 reads the host file for exactly one missing-module probe');
  assert.ok(sites[0].includes(".split(sep).join('/')"), `T1 normalises the host separator before matching: ${sites[0].trim()}`);
});

test('P3 the fixture: win32 skips with the reason, linux runs', () => {
  const lines = [];
  const calls = [];
  const w = platformHelpers('win32', (s) => lines.push(s));
  assert.equal(w.isWin32, true);
  assert.equal(w.win32Skip(WIN32.modes), `win32: ${WIN32.modes}`);
  assert.equal(w.skipOnWin32({ skip: (m) => calls.push(m) }, WIN32.symlinks), true);
  assert.deepEqual(calls, [`win32: ${WIN32.symlinks}`]);
  assert.equal(w.skipOnWin32(null, 'x y z reason'), true);
  assert.deepEqual(lines, ['- SKIP win32: x y z reason\n']);

  const linuxLines = [];
  const linuxCalls = [];
  const l = platformHelpers('linux', (s) => linuxLines.push(s));
  assert.equal(l.isWin32, false);
  assert.equal(l.win32Skip('anything'), false);
  assert.equal(l.skipOnWin32({ skip: (m) => linuxCalls.push(m) }, 'anything'), false);
  assert.equal(l.skipOnWin32(null, 'anything'), false);
  assert.deepEqual(linuxCalls, []);
  assert.deepEqual(linuxLines, []);

  assert.equal(isWin32, process.platform === 'win32', 'the default export is this host');
  assert.deepEqual(Object.keys(WIN32).sort(), ['modes', 'signals', 'symlinks']);
  for (const [k, v] of Object.entries(WIN32)) assert.ok(typeof v === 'string' && v.length >= 8, `WIN32.${k} is a reason`);
  assert.ok(Object.isFrozen(WIN32));
});

test('P4 no URL.pathname is used as a filesystem path', () => {
  const offenders = [];
  for (const f of ALL_SOURCES) for (const u of pathnameUses(read(f))) offenders.push(`${f}:${u.line} — ${u.rule}`);
  assert.deepEqual(offenders, [], `use fileURLToPath(new URL(…, import.meta.url)):\n${offenders.join('\n')}`);

  // Negative cases: the three lines this guard was written against…
  const bad = [
    "const ROOT = resolve(new URL('..', import.meta.url).pathname);",
    "const ROOT = new URL('./fixtures/crawl/operational-alerts/', import.meta.url).pathname;",
    "const K8S = join(ROOT.pathname.replace(/^\\/([A-Za-z]:)/, '$1'), 'deploy', 'k8s');",
  ];
  for (const line of bad) assert.equal(pathnameUses(line).length, 1, `reported: ${line}`);
  // …and what is not a filesystem path: an http URL's pathname, a comment, a string.
  const fine = [
    'const id = defaultPackId(new URL(href).pathname);',
    '// new URL(import.meta.url).pathname used to be the idiom',
    "const note = 'new URL(x, import.meta.url).pathname';",
    "u.pathname = u.pathname.replace(/\\/\\.well-known\\/openid-configuration\\/?$/, '');",
  ];
  for (const line of fine) assert.deepEqual(pathnameUses(line), [], `not reported: ${line}`);
});

test('P5 every platform branch of a suite goes through server/fixtures/platform.mjs', () => {
  const offenders = [];
  for (const f of SUITES) {
    if (f === FIXTURE || f === SELF) continue;
    for (const line of win32Literals(read(f))) offenders.push(`${f}:${line}`);
  }
  assert.deepEqual(offenders, [], `a suite spells 'win32': import isWin32 / win32Skip / skipOnWin32 from ${FIXTURE} instead:\n${offenders.join('\n')}`);
  assert.deepEqual(win32Literals(read(FIXTURE)), [32], 'the fixture is the one place');

  assert.deepEqual(win32Literals("if (process.platform === 'win32') return;"), [1], 'reported');
  assert.deepEqual(win32Literals('if (process.platform === "win32") return;'), [1], 'reported (double quotes)');
  assert.deepEqual(win32Literals("const p = 'darwin';\n// 'win32' in a comment is fine"), [], 'not reported');
});

test('P6 every win32 skip states its reason; README counts them', () => {
  const perFile = {};
  const malformed = [];
  for (const f of SUITES) {
    if (f === FIXTURE || f === SELF) continue;
    const calls = skipCalls(read(f));
    if (calls.length) perFile[f] = calls.length;
    for (const c of calls) if (!c.ok) malformed.push(`${f}:${c.line} ${c.fn}(${c.arg})`);
  }
  assert.deepEqual(malformed, [], `a skip without a reason (a literal of 8+ characters or WIN32.<fact>; skipOnWin32 takes t or null first):\n${malformed.join('\n')}`);
  const total = Object.values(perFile).reduce((a, b) => a + b, 0);
  assert.ok(total >= 15, `at least the 15 sites this batch added (${total})`);

  const readme = read('README.md');
  const at = readme.indexOf('### Platforms');
  assert.ok(at >= 0, 'README has a "### Platforms" subsection');
  const platforms = readme.slice(at, readme.indexOf('\n```', at));
  const m = README_COUNT_RE.exec(platforms);
  assert.ok(m, 'README states "N win32-skip sites"');
  assert.equal(Number(m[1]), total, `README says ${m[1]} win32-skip sites, the sources hold ${total}: ${JSON.stringify(perFile)}`);
  for (const [f, n] of Object.entries(perFile)) assert.ok(platforms.includes(`\`${f}\` (${n})`), `README names ${f} (${n})`);

  // Negative cases.
  for (const src of ['win32Skip()', "win32Skip('')", "win32Skip('short')", 'skipOnWin32(t)', 'skipOnWin32(t, reason)', 'win32Skip(WIN32.other)']) {
    const calls = skipCalls(src);
    assert.equal(calls.length, 1, src);
    assert.equal(calls[0].ok, false, `reported: ${src}`);
  }
  for (const src of ['win32Skip(WIN32.modes)', "win32Skip('a reason of some length')", 'skipOnWin32(t, WIN32.symlinks)', "skipOnWin32(null, 'a harness reason')"]) {
    assert.deepEqual(skipCalls(src).map((c) => c.ok), [true], `well-formed: ${src}`);
  }
});
