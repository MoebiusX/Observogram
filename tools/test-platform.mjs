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
//   P4  every `.pathname` under server/ and tools/ is one of the known URL
//       paths — none is a filesystem path;
//   P5  every platform branch of a suite goes through the fixture — no other
//       suite or fixture reads process.platform or spells 'win32';
//   P6  every win32 skip states its reason, isWin32 is a data read in the two
//       allowed places only (never a silent branch), and README's count of
//       the skip sites is the count in the sources.
//
// A predicted-portable test that fails on a downstream's Windows run is fixed
// by a new reasoned skip site AND a README count bump — P6 forces both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep, win32, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tokenize } from './gen-vendor-manifest.mjs';
import { WIN32, platformHelpers, isWin32, isLinux, PLATFORM } from '../server/fixtures/platform.mjs';

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

const lineOf = (src, index) => src.slice(0, index).split('\n').length;

// P4: `.pathname` of a URL is a URL path. Used as a filesystem path it is
// `/C:/repo/…` on win32 and percent-encoded everywhere, so every `.pathname`
// under server/ and tools/ (tokenizer-blanked code: a comment or a string is
// not a use) must be one of these known URL paths, pinned per file. studio/
// is browser code (window.location, fetch URLs) and is not scanned.
const PATHNAME_ALLOWED = Object.freeze({
  'server/store/identity.mjs': 1,       // the OIDC issuer URL's well-known suffix
  'server/routes/mcp-settings.mjs': 2,  // an MCP server's settings URL path, for a refusal and the audit row
  'server/test-auth-oidc.mjs': 4,       // the fake IdP's HTTP request paths
  'tools/build-studio-bundle.mjs': 1,   // a --pack-url (http) path, for an id
  'tools/record-mcp-fixtures.mjs': 1,   // an MCP URL, printed without its query
});
// P6: the fixture's two call forms and what a well-formed argument is.
const SKIP_CALL_RE = /\b(win32Skip|skipOnWin32)\(([^)]*)\)/g;
const REASON = "(?:'[^']{8,}'|WIN32\\.(?:modes|signals|symlinks))";
const WIN32_SKIP_ARG_RE = new RegExp(`^\\s*${REASON}\\s*$`);
const SKIP_ON_WIN32_ARG_RE = new RegExp(`^\\s*(?:t|null)\\s*,\\s*${REASON}\\s*$`);
const README_COUNT_RE = /(\d+) win32-skip sites/;
// isWin32 is a data read (a ternary over an expected value), never a branch
// that silently skips: the two places, and the two shapes refused everywhere.
const ISWIN32_ALLOWED = Object.freeze({ 'server/test-store-ops.mjs': 1, 'tools/test-backend-validate.mjs': 2 });
const ISWIN32_IF_RE = /\bif\s*\([^)]*\bisWin32\b/;
const ISWIN32_SKIP_RE = /\bskip:\s*[^,}]*\bisWin32\b/;
const PROCESS_PLATFORM_RE = /\bprocess\s*\.\s*platform\b/;

function pathnameUses(src) {
  const out = [];
  for (const [i, line] of tokenize(src).code.split('\n').entries()) if (/\.pathname\b/.test(line)) out.push(i + 1);
  return out;
}

// The lines where a source reads process.platform or spells 'win32'.
function platformReads(src) {
  const { code, strings } = tokenize(src);
  const out = new Set(strings.filter((s) => s.value === 'win32').map((s) => lineOf(src, s.start)));
  for (const [i, line] of code.split('\n').entries()) if (PROCESS_PLATFORM_RE.test(line)) out.add(i + 1);
  return [...out].sort((a, b) => a - b);
}

// The lines where a source names isWin32 in code, and the silent-branch shapes among them.
function isWin32Uses(src) {
  const uses = [];
  const silent = [];
  for (const [i, line] of tokenize(src).code.split('\n').entries()) {
    if (!/\bisWin32\b/.test(line) || /\bimport\b/.test(line)) continue;   // the binding is not a read
    uses.push(i + 1);
    if (ISWIN32_IF_RE.test(line) || ISWIN32_SKIP_RE.test(line)) silent.push(i + 1);
  }
  return { uses, silent };
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

  assert.equal(w.isLinux, false);
  assert.equal(l.isLinux, true);
  assert.equal(isWin32, process.platform === 'win32', 'the default export is this host');
  assert.equal(isLinux, process.platform === 'linux');
  assert.equal(PLATFORM, process.platform, 'PLATFORM is for a printout naming the host');
  assert.deepEqual(Object.keys(WIN32).sort(), ['modes', 'signals', 'symlinks']);
  for (const [k, v] of Object.entries(WIN32)) assert.ok(typeof v === 'string' && v.length >= 8, `WIN32.${k} is a reason`);
  assert.ok(Object.isFrozen(WIN32));
});

test('P4 every .pathname under server/ and tools/ is a known URL path — none is a filesystem path', () => {
  const offenders = [];
  const counts = {};
  for (const f of ALL_SOURCES) {
    if (f.startsWith('studio/') || f === SELF) continue;
    const lines = pathnameUses(read(f));
    if (!lines.length) continue;
    counts[f] = lines.length;
    if (!(f in PATHNAME_ALLOWED)) for (const l of lines) offenders.push(`${f}:${l}`);
  }
  assert.deepEqual(offenders, [], `a .pathname outside the known URL paths — a filesystem path is fileURLToPath(new URL(…, import.meta.url)); a new URL path is added to PATHNAME_ALLOWED with its reason:\n${offenders.join('\n')}`);
  assert.deepEqual(counts, { ...PATHNAME_ALLOWED }, 'the known URL-path files hold exactly the pinned number of .pathname lines (a new one is reviewed and pinned)');

  // Negative cases: the three lines this guard was written against — the
  // two-step form included — are uses; a comment or a string is not.
  const bad = [
    "const ROOT = resolve(new URL('..', import.meta.url).pathname);",
    "const ROOT = new URL('./fixtures/crawl/operational-alerts/', import.meta.url).pathname;",
    "const ROOT = new URL('../', import.meta.url);\nconst K8S = join(ROOT.pathname.replace(/^\\/([A-Za-z]:)/, '$1'), 'deploy', 'k8s');",
    "const u = new URL('..', import.meta.url);\nconst ROOT = u.pathname;",
  ];
  for (const src of bad) assert.equal(pathnameUses(src).length, 1, `reported: ${src}`);
  const fine = [
    '// new URL(import.meta.url).pathname used to be the idiom',
    "const note = 'new URL(x, import.meta.url).pathname';",
    'const pathnames = [];',
  ];
  for (const src of fine) assert.deepEqual(pathnameUses(src), [], `not reported: ${src}`);
});

test('P5 every platform branch of a suite goes through server/fixtures/platform.mjs', () => {
  const offenders = [];
  for (const f of SUITES) {
    if (f === FIXTURE || f === SELF) continue;
    for (const line of platformReads(read(f))) offenders.push(`${f}:${line}`);
  }
  assert.deepEqual(offenders, [], `a suite reads process.platform or spells 'win32': import isWin32 / isLinux / PLATFORM / win32Skip / skipOnWin32 from ${FIXTURE} instead:\n${offenders.join('\n')}`);
  const fixture = read(FIXTURE);
  assert.deepEqual(platformReads(fixture), [31, 32, 46], 'the fixture is the one place: the default parameter, the isWin32 fact, PLATFORM');

  assert.deepEqual(platformReads("if (process.platform === 'win32') return;"), [1], 'reported');
  assert.deepEqual(platformReads('if (process.platform === "win32") return;'), [1], 'reported (double quotes)');
  assert.deepEqual(platformReads("if (process.platform !== 'linux') return null;"), [1], 'reported (a linux read is isLinux)');
  assert.deepEqual(platformReads('log(`no ${process.platform} build`);'), [1], 'reported (a printout is PLATFORM)');
  assert.deepEqual(platformReads("const p = 'darwin';\n// 'win32' in a comment is fine\n// process.platform too"), [], 'not reported');
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
  assert.deepEqual(malformed, [], `a skip without a reason — WIN32.<fact> or a single-quoted literal of 8+ characters; skipOnWin32 takes t or null first. This check fails closed: a reason containing ')' or not single-quoted is reported too (use WIN32.<fact>, or a paren-free literal):\n${malformed.join('\n')}`);
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

  // isWin32 is a data read in the two allowed places and never a silent branch.
  const isWin32Counts = {};
  const silent = [];
  for (const f of SUITES) {
    if (f === FIXTURE || f === SELF) continue;
    const { uses, silent: bad } = isWin32Uses(read(f));
    if (uses.length) isWin32Counts[f] = uses.length;
    for (const l of bad) silent.push(`${f}:${l}`);
  }
  assert.deepEqual(silent, [], `isWin32 inside an if(…) or a skip: option is a silent skip — use win32Skip(reason) / skipOnWin32(t, reason):\n${silent.join('\n')}`);
  assert.deepEqual(isWin32Counts, { ...ISWIN32_ALLOWED }, 'isWin32 is read as data in the allowed places only (the 0666 expectation, the .exe suffix and the mimirtool notice); a new read is a reviewed addition to ISWIN32_ALLOWED');
  for (const src of ['if (isWin32) return;', '{ skip: isWin32 }', "{ skip: isWin32 && 'x' }", "test('x', { skip: isWin32 }, () => {})"]) {
    assert.deepEqual(isWin32Uses(src).silent, [1], `reported: ${src}`);
  }
  assert.deepEqual(isWin32Uses("assert.equal(mode, isWin32 ? 0o666 : 0o644);").silent, [], 'a data read is not reported');

  // Negative cases.
  for (const src of ['win32Skip()', "win32Skip('')", "win32Skip('short')", 'skipOnWin32(t)', 'skipOnWin32(t, reason)', 'win32Skip(WIN32.other)', 'win32Skip("a double-quoted reason")', "win32Skip('a reason with (parens) inside')"]) {
    const calls = skipCalls(src);
    assert.equal(calls.length, 1, src);
    assert.equal(calls[0].ok, false, `reported: ${src}`);
  }
  for (const src of ['win32Skip(WIN32.modes)', "win32Skip('a reason of some length')", 'skipOnWin32(t, WIN32.symlinks)', "skipOnWin32(null, 'a harness reason')"]) {
    assert.deepEqual(skipCalls(src).map((c) => c.ok), [true], `well-formed: ${src}`);
  }
});
