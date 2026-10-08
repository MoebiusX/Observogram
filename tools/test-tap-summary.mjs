// tools/test-tap-summary.mjs — the end of a CI log (tools/tap-summary.mjs):
// the TAP parse and its escapes, the SKIP win32: count, the failures and
// their places, the annotations, the verdict, README's count, the byte
// decoding, the CLI, the workflow that runs it, the skip grouping, the
// timing bounds, the run's shape and the cross-leg comparison.
//
// The fixtures are TAP as Node 22 prints it (4 spaces per depth, the YAML
// block at depth×4+2, a harness suite's output as `# ` diagnostics before
// its point) and, where a Windows run differs, in the forms it takes there:
// TAP escapes `\` and `#` (`C:\\x \# y`), util.inspect doubles a quoted
// path's backslashes, a harness suite is named `tools\\test-x.mjs`. This
// suite spells the skip marker only inside longer strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_SKIPS, README_WIN32_LINES_RE, annotation, compareShapes, decodeTap, isExpectedSkip, logLines, parseTap,
  readmeWin32Lines, reportCommand, runShape, skipGroup, summarize, unescapeTap, whereOf,
} from './tap-summary.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'tools', 'tap-summary.mjs');
const LROOT = '/home/runner/work/Observogram/Observogram';
const WROOT = String.raw`D:\a\Observogram\Observogram`;
const HEAD = '==================== npm test summary ====================';
const SIGNALS = 'signal semantics: process.kill(pid, "SIGTERM"|"SIGINT") ends a Windows process outright — no handler runs, the store cannot close itself';
const SYMLINKS = 'symlinks: creating one needs a privilege (Developer Mode or an elevated shell) on Windows';
const MODES = 'POSIX mode bits: Windows reports 0666/0444 and chmod cannot make a file unreadable';
const BROWSER_SUITES = ['server/test-brand-shell.mjs', 'server/test-glossary-shell.mjs', 'server/test-settings-studio.mjs', 'server/test-live-studio.mjs', 'server/test-services-studio.mjs', 'server/test-mcp-settings-studio.mjs', 'tools/test-studio-bundle.mjs'];
const pwReason = (importer) => `cannot import playwright: Cannot find package 'playwright' imported from ${importer}`;
const TOTALS = (t) => `1..${t.points ?? 1}\n# tests ${t.tests}\n# suites 0\n# pass ${t.pass}\n# fail ${t.fail ?? 0}\n# cancelled ${t.cancelled ?? 0}\n# skipped ${t.skipped ?? 0}\n# todo ${t.todo ?? 0}\n# duration_ms ${t.ms ?? 26000.1}\n`;
const okPoint = (n, name, { depth = 0, directive = '', ms = 1.5 } = {}) => {
  const i = ' '.repeat(depth * 4);
  return `${i}# Subtest: ${name}\n${i}ok ${n} - ${name}${directive}\n${i}  ---\n${i}  duration_ms: ${ms}\n${i}  type: 'test'\n${i}  ...\n`;
};
const harnessFailure = (n, file, root = LROOT) => `# Subtest: ${file}\nnot ok ${n} - ${file}\n  ---\n  duration_ms: 900.1\n  type: 'test'\n  location: '${root}/${file}:1:1'\n  failureType: 'testCodeFailure'\n  exitCode: 1\n  signal: ~\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'\n  ...\n`;

// A green Linux run on the floor, as CI prints it: npm's header, a store
// test with its bound after its point, the PID 1 skip, a browser skip, and a
// harness suite whose output (✓ lines, an indented one, a bound) precedes it.
const GREEN = `
> observogram@0.5.0 test
> node --test server/test-store.mjs server/test-brand-shell.mjs tools/test-journey.mjs

TAP version 13
${okPoint(1, 'Concurrency: a write waits out a child holding the write lock for less than busy_timeout, then succeeds', { ms: 812.5 })}# bound: the parent waited on the lock: 612 ms >= 300 ms of a 700 ms hold
${okPoint(2, 'SIGTERM to node running as PID 1: the store closes and the process exits 143', { directive: ' # SKIP unshare --pid is unavailable here' })}${okPoint(3, 'BROWSER: the studio header reads the brand', { directive: ` # SKIP ${pwReason(`${LROOT}/server/test-brand-shell.mjs`)}` })}# ✓ listJourneys: the two definitions
# ✓ the cron line sets the workspace the CLI was run with
#   ✓ an indented assertion
# bound: a hung receiver times out per attempt (1000 ms × 2): 2050 ms < 3500 ms
# all journey assertions pass.
${okPoint(4, 'tools/test-journey.mjs', { ms: 24012.3 })}${TOTALS({ points: 4, tests: 4, pass: 2, skipped: 2 })}`;

// The same suites on Windows: TAP-escaped paths and names, a win32 skip at
// depth 0, one at depth 1, and a harness suite's `- SKIP win32:` line.
const GREEN_WIN = String.raw`TAP version 13
# Subtest: Concurrency: a write waits out a child holding the write lock for less than busy_timeout, then succeeds
ok 1 - Concurrency: a write waits out a child holding the write lock for less than busy_timeout, then succeeds
  ---
  duration_ms: 1203.1
  type: 'test'
  ...
# bound: the parent waited on the lock: 655 ms >= 300 ms of a 700 ms hold
# Subtest: SIGTERM to node running as PID 1: the store closes and the process exits 143
ok 2 - SIGTERM to node running as PID 1: the store closes and the process exits 143 # SKIP unshare --pid is unavailable here
  ---
  duration_ms: 0.3
  type: 'test'
  ...
# Subtest: SIGTERM: the store closes itself
ok 3 - SIGTERM: the store closes itself # SKIP win32: ${SIGNALS}
  ---
  duration_ms: 0.2
  type: 'test'
  ...
# Subtest: backup
    # Subtest: a symlinked directory is refused
    ok 1 - a symlinked directory is refused # SKIP win32: ${SYMLINKS}
      ---
      duration_ms: 0.2
      type: 'test'
      ...
    1..1
ok 4 - backup
  ---
  duration_ms: 1.5
  type: 'test'
  ...
# Subtest: BROWSER: the studio header reads the brand
ok 5 - BROWSER: the studio header reads the brand # SKIP cannot import playwright: Cannot find package 'playwright' imported from D:\\a\\Observogram\\Observogram\\server\\test-brand-shell.mjs
  ---
  duration_ms: 3.2
  type: 'test'
  ...
# ✓ listJourneys: the two definitions
# - SKIP win32: ${SYMLINKS}
#   ✓ an indented assertion
# bound: a hung receiver times out per attempt (1000 ms × 2): 2950 ms < 3500 ms
# all journey assertions pass.
# Subtest: tools\\test-journey.mjs
ok 6 - tools\\test-journey.mjs
  ---
  duration_ms: 41012.3
  type: 'test'
  ...
1..6
# tests 7
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 5
# todo 0
# duration_ms 52000.4
`;

// Failures: a harness file failing, then another right after it (its causes
// must not reach back into the first's), then a nested leaf under a parent
// that fails only because of it, its stack starting in another file.
const RED = `TAP version 13
# ✗ a cause in the previous file
#     got:  "x"
#     want: "y"
# 1 crawl assertion(s) failed.
${harnessFailure(1, 'tools/test-crawl.mjs')}# ✓ listJourneys: the two definitions
# ✗ the cron line sets the workspace the CLI was run with
#     got:  "OBSERVOGRAM_WORKSPACE='/tmp/RUNNER~1 tmp/x'"
#     want: "OBSERVOGRAM_WORKSPACE=<the run's workspace>"
# ✓ after the failure
# 1 journey assertion(s) failed.
${harnessFailure(2, 'tools/test-journey.mjs')}# Subtest: Stale import: orgs create acme on a pre-store build
    # Subtest: the tenancy line
    not ok 1 - the tenancy line
      ---
      duration_ms: 5.1
      type: 'test'
      location: '${LROOT}/server/test-store-ops.mjs:1660:3'
      failureType: 'testCodeFailure'
      error: |-
        packs moved
        [tenancy] moved /tmp/x/packs to orgs/default/packs
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: true
      actual: false
      operator: '=='
      stack: |-
        Socket.<anonymous> (file://${LROOT}/server/fixtures/serve-child.mjs:116:110)
        TestContext.<anonymous> (file://${LROOT}/server/test-store-ops.mjs:1677:5)
        Test.runInAsyncScope (node:async_hooks:214:14)
      ...
    1..1
not ok 3 - Stale import: orgs create acme on a pre-store build
  ---
  duration_ms: 6
  type: 'test'
  location: '${LROOT}/server/test-store-ops.mjs:1659:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
${TOTALS({ points: 3, tests: 4, pass: 0, fail: 4 })}`;

const nodeFailure = (n, name, errorLines, file = 'server/test-x.mjs') => `# Subtest: ${name}\nnot ok ${n} - ${name}\n  ---\n  duration_ms: 1\n  type: 'test'\n  location: '${LROOT}/${file}:${n}:1'\n  failureType: 'testCodeFailure'\n  error: |-\n${errorLines.map((l) => `    ${l}`).join('\n')}\n  code: 'ERR_ASSERTION'\n  stack: |-\n    TestContext.<anonymous> (file://${LROOT}/${file}:${n + 1}:7)\n  ...\n`;
const failingRun = (k, { lines = 2 } = {}) => `TAP version 13\n${Array.from({ length: k }, (_, i) => nodeFailure(i + 1, `failure ${i + 1}`, Array.from({ length: i === 0 ? lines : 2 }, (__, j) => `line ${j + 1} of failure ${i + 1}`))).join('')}${TOTALS({ points: k, tests: k, pass: 0, fail: k })}`;

test('S1 parse: totals, completeness, depth, directives and reasons, the YAML block, top-level diagnostics; names, directives and reasons unescaped', () => {
  const tap = String.raw`TAP version 13
# Subtest: b \# c
ok 1 - b \# c # SKIP C:\\x\\y \# z
  ---
  duration_ms: 0.7
  type: 'test'
  ...
# Subtest: parent
    # Subtest: first child
    not ok 1 - first child
      ---
      duration_ms: 1.1
      type: 'test'
      location: 'D:\\a\\Observogram\\Observogram\\server\\test-a.mjs:7:11'
      failureType: 'testCodeFailure'
      error: |-
        one is
        two
        ...
        1 !== 2
      code: 'ERR_ASSERTION'
      expected:
        a: 2
      stack: |-
        TestContext.<anonymous> (file:///D:/a/Observogram/Observogram/server/test-a.mjs:7:45)
      ...
    # Subtest: second child
    ok 2 - second child
      ---
      duration_ms: 0.2
      type: 'test'
      ...
    1..2
not ok 2 - parent
  ---
  duration_ms: 8.1
  type: 'test'
  location: 'D:\\a\\Observogram\\Observogram\\server\\test-a.mjs:5:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: later
ok 3 - later # TODO not yet
  ---
  duration_ms: 0.1
  type: 'test'
  ...
# ✓ C:\\x \# y
# Subtest: tools\\test-h.mjs
ok 4 - tools\\test-h.mjs
  ---
  duration_ms: 136.5
  type: 'test'
  ...
1..4
# tests 6
# suites 0
# pass 2
# fail 2
# cancelled 0
# skipped 1
# todo 1
# duration_ms 389.99
`;
  const p = parseTap(tap);
  assert.equal(p.complete, true);
  assert.deepEqual(p.totals, { tests: 6, suites: 0, pass: 2, fail: 2, cancelled: 0, skipped: 1, todo: 1, duration_ms: 389.99 });
  assert.deepEqual(p.points.map((x) => [x.depth, x.ok, x.n, x.name, x.directive, x.reason]), [
    [0, true, 1, 'b # c', 'SKIP', String.raw`C:\x\y # z`],
    [1, false, 1, 'first child', null, null],
    [1, true, 2, 'second child', null, null],
    [0, false, 2, 'parent', null, null],
    [0, true, 3, 'later', 'TODO', 'not yet'],
    [0, true, 4, String.raw`tools\test-h.mjs`, null, null],
  ], 'every point, the nested block not swallowing the next one');
  const child = p.points[1];
  assert.equal(child.yaml.error, 'one is\ntwo\n...\n1 !== 2', 'a block scalar keeps its lines, an inner "..." included');
  assert.equal(child.yaml.location, String.raw`D:\a\Observogram\Observogram\server\test-a.mjs:7:11`, 'a quoted scalar is decoded: doubled backslashes become one');
  assert.equal(child.yaml.failureType, 'testCodeFailure');
  assert.equal(child.yaml.expected, 'a: 2', 'a nested map is kept as its text');
  assert.match(child.yaml.stack, /^TestContext\.<anonymous> \(file:\/\/\/D:\/a\//);
  assert.equal(p.points[3].yaml.failureType, 'subtestsFailed');
  assert.equal(p.points[3].yaml.error, '1 subtest failed');
  assert.equal(p.points[1].diag, undefined, 'only a top-level point carries diagnostics');
  assert.deepEqual(p.points[5].diag, [String.raw`✓ C:\x # y`], 'a diagnostic is unescaped');
  assert.equal(unescapeTap(String.raw`a\\b \# c`), String.raw`a\b # c`);

  const cut = parseTap(tap.slice(0, tap.indexOf('1..4')));
  assert.equal(cut.complete, false, 'no totals, not complete');
  assert.deepEqual(cut.totals, {});
  assert.equal(parseTap(`${tap}\n# ✓ tests 3\n`).complete, true, 'a later diagnostic does not undo the totals');
  assert.equal(parseTap(tap.replace('ok 4 - tools', '# tests 9\nok 4 - tools')).totals.tests, 6, 'a total-shaped line before the last point is not the totals');
});

test('S2 the SKIP win32: count: TAP points at any depth, the harness form, an escaped Windows reason — never a YAML block, a ✗ line, P3\'s strings or a spec-reporter line quoting it', () => {
  assert.equal(parseTap(GREEN_WIN).win32, 3, 'depth 0, depth 1 and the harness line');
  assert.equal(parseTap(GREEN).win32, 0);
  const tap = String.raw`TAP version 13
# Subtest: a reason holding a path
ok 1 - a reason holding a path # SKIP win32: the file C:\\x \# y is held
  ---
  duration_ms: 0.1
  type: 'test'
  ...
# Subtest: P3 the fixture: win32 skips with the reason, linux runs
not ok 2 - P3 the fixture: win32 skips with the reason, linux runs
  ---
  duration_ms: 1
  type: 'test'
  location: '/r/tools/test-platform.mjs:136:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly deep-equal:
    ok 1 - x # SKIP win32: quoted in an error
    # - SKIP win32: x y z reason
  code: 'ERR_ASSERTION'
  ...
# ✗ the fixture prints - SKIP win32: x y z reason
# ﹣ a spec line (0.1ms) # SKIP win32: not TAP
# Subtest: tools/test-platform-harness.mjs
not ok 3 - tools/test-platform-harness.mjs
  ---
  duration_ms: 1
  type: 'test'
  error: 'test failed'
  ...
# Subtest: b \# SKIP win32: only a name
ok 4 - b \# SKIP win32: only a name
  ---
  duration_ms: 0.1
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 2
# fail 2
# cancelled 0
# skipped 1
# todo 0
# duration_ms 5
`;
  const p = parseTap(tap);
  assert.equal(p.win32, 1, 'one directive; the error text, the ✗ line, the spec line and an escaped name are not skips');
  assert.equal(p.points[0].reason, String.raw`win32: the file C:\x # y is held`);
  assert.equal(p.points[3].directive, null, 'an escaped # is part of the name');
  assert.equal(p.points[3].name, 'b # SKIP win32: only a name');
});

test('S3 failures: leaves only; a harness failure shows its ✗ lines with got/want and nothing of the previous file; a crash and a mangled capture show the last 12 diagnostics; 40 failures × 25 lines', () => {
  const r = summarize(RED, { root: LROOT, pathApi: posix });
  assert.deepEqual(r.failures.map((f) => f.name), ['tools/test-crawl.mjs', 'tools/test-journey.mjs', 'the tenancy line'], 'the subtestsFailed parent adds nothing');
  assert.deepEqual(r.failures[1].body, [
    '✗ the cron line sets the workspace the CLI was run with',
    `    got:  "OBSERVOGRAM_WORKSPACE='/tmp/RUNNER~1 tmp/x'"`,
    '    want: "OBSERVOGRAM_WORKSPACE=<the run\'s workspace>"',
  ], 'its own ✗ line and the got/want under it — not the previous file\'s cause, not a later ✓');
  assert.deepEqual(r.failures[0].body, ['✗ a cause in the previous file', '    got:  "x"', '    want: "y"']);
  assert.deepEqual(r.failures[2].body, ['packs moved', '[tenancy] moved /tmp/x/packs to orgs/default/packs']);
  assert.ok(r.text.includes('--- not ok 2 - tools/test-journey.mjs\n    at tools/test-journey.mjs:1\n    ✗ the cron line'), r.text);
  assert.ok(!r.text.includes('not ok 3 - Stale import'), 'the parent is not listed');

  const stderr = Array.from({ length: 15 }, (_, i) => `#     at frame ${i + 1} (file:///x.mjs:${i + 1}:1)`).join('\n');
  const crash = `TAP version 13\n# ✓ one\n# Error: boom\n${stderr}\n${harnessFailure(1, 'tools/test-crash.mjs')}${TOTALS({ tests: 1, pass: 0, fail: 1 })}`;
  const c = summarize(crash, { root: LROOT, pathApi: posix });
  assert.equal(c.failures[0].body.length, 12);
  assert.equal(c.failures[0].body[11], '    at frame 15 (file:///x.mjs:15:1)', 'the last diagnostics');
  const mangled = RED.replace(/✗/g, 'Γ£ù').replace(/✓/g, 'Γ£ô');
  const m = summarize(mangled, { root: LROOT, pathApi: posix });
  assert.deepEqual(m.failures[1].body.slice(0, 2), ['Γ£ô listJourneys: the two definitions', 'Γ£ù the cron line sets the workspace the CLI was run with'], 'a mangled marker: the last lines, cause included');

  const many = summarize(failingRun(41, { lines: 30 }), { root: LROOT, pathApi: posix });
  assert.equal(many.failures.length, 41);
  assert.ok(many.text.includes('failures (41, the first 40 shown):'));
  assert.equal((many.text.match(/^--- not ok /gm) || []).length, 40);
  assert.ok(many.text.includes('    line 25 of failure 1\n    … 5 more line(s)'), 'at most 25 lines each');
  assert.ok(!many.text.includes('line 26 of failure 1'));
  assert.equal(summarize(failingRun(41), { maxFailures: 3 }).text.match(/^--- not ok /gm).length, 3, '--max-failures');
});

test('S4 a failure\'s place: the first frame in the test\'s own file, else its location — POSIX, an escaped Windows location, a file: URL, another drive-letter case', () => {
  const posixPoint = parseTap(RED).points.find((p) => p.name === 'the tenancy line');
  assert.deepEqual(whereOf(posixPoint, { root: LROOT, pathApi: posix }), { file: 'server/test-store-ops.mjs', line: 1677 }, 'the serve-child frame is skipped for the test\'s own');
  const winTap = String.raw`TAP version 13
# Subtest: the tenancy line
not ok 1 - the tenancy line
  ---
  duration_ms: 5.1
  type: 'test'
  location: 'D:\\a\\Observogram\\Observogram\\server\\test-store-ops.mjs:1660:3'
  failureType: 'testCodeFailure'
  error: 'packs moved'
  stack: |-
    Socket.<anonymous> (file:///D:/a/Observogram/Observogram/server/fixtures/serve-child.mjs:116:110)
    TestContext.<anonymous> (file:///D:/a/Observogram/Observogram/server/test-store-ops.mjs:1677:5)
  ...
`;
  const winPoint = parseTap(winTap).points[0];
  assert.deepEqual(whereOf(winPoint, { root: WROOT, pathApi: win32 }), { file: 'server/test-store-ops.mjs', line: 1677 });
  assert.deepEqual(whereOf(winPoint, { root: String.raw`d:\a\Observogram\Observogram`, pathApi: win32 }), { file: 'server/test-store-ops.mjs', line: 1677 }, 'a root with another drive-letter case');
  const located = { yaml: { location: String.raw`D:\a\Observogram\Observogram\tools\test-journey.mjs:1:1` } };
  assert.deepEqual(whereOf(located, { root: WROOT, pathApi: win32 }), { file: 'tools/test-journey.mjs', line: 1 }, 'no frame: the location');
  const elsewhere = { yaml: { location: `${LROOT}/server/test-a.mjs:12:3`, stack: `Socket.<anonymous> (file://${LROOT}/server/fixtures/serve-child.mjs:116:110)\nprocessTicksAndRejections (node:internal/process/task_queues:105:5)` } };
  assert.deepEqual(whereOf(elsewhere, { root: LROOT, pathApi: posix }), { file: 'server/test-a.mjs', line: 12 }, 'no frame in the test\'s own file: its location, never another file\'s line');
  const url = { yaml: { location: `file://${LROOT}/tools/test-b.mjs:4:1`, stack: `async Promise.all (index 0)\nfile://${LROOT}/tools/test-b.mjs:9:7` } };
  assert.deepEqual(whereOf(url, { root: LROOT, pathApi: posix }), { file: 'tools/test-b.mjs', line: 9 }, 'a file: URL location and an anonymous frame');
  assert.deepEqual(whereOf({ yaml: {} }, { root: LROOT, pathApi: posix }), { file: null, line: null });
});

test('S5 annotations: escaping, the run-level errors first, failures up to the cap of 10, the notice naming the block\'s length and the tail to read', () => {
  assert.equal(annotation('error', { title: 'a:b,c' }, '100%\nnext\r'), '::error title=a%3Ab%2Cc::100%25%0Anext%0D');
  assert.equal(annotation('notice', {}, 'x'), '::notice::x');
  assert.equal(annotation('error', { file: 'server/test-a.mjs', line: 7, title: 't' }, 'm'), '::error file=server/test-a.mjs,line=7,title=t::m');

  const r = summarize(failingRun(12), { root: LROOT, pathApi: posix, expectWin32: 19, countSource: 'README' });
  const out = r.text.split('\n');
  const errors = out.filter((l) => l.startsWith('::error'));
  assert.equal(errors.length, 10, 'the per-step cap');
  assert.equal(errors[0], '::error title=SKIP win32 count::the run printed 0 SKIP win32: lines, README "Platforms" states 19', 'the count error comes first');
  assert.deepEqual(errors.slice(1).map((l) => /title=([^:]*)::/.exec(l)[1]), Array.from({ length: 9 }, (_, i) => `failure ${i + 1}`), 'then 9 failures, in order');
  assert.equal(errors[1], '::error file=server/test-x.mjs,line=2,title=failure 1::line 1 of failure 1%0Aline 2 of failure 1');
  // The runner writes an annotation's %0A as a line break, and the log API's tail counts it:
  // nine failure annotations of two lines each take nine log lines more than the text has.
  assert.equal(r.lines, out.length + 9, 'the block counts the log lines its annotations take');
  assert.equal(r.lines, out.reduce((n, l) => n + logLines(l), 0));
  assert.equal(logLines('::error title=t::a%0Ab%0Ac'), 3);
  assert.equal(logLines('    100%0A in a failure body is text'), 1, 'only a workflow command is rendered');
  assert.ok(out.includes(`block: ${r.lines} lines`), 'the block states every log line it takes');
  assert.equal(out[out.length - 1], `::notice title=npm test::tests 12 pass 0 fail 12 skipped 0 (win32 0/19) — the summary block is ${r.lines} lines; read it with tail_lines ${r.lines + 150}`);
  assert.equal(out[0], HEAD);
  assert.equal(out.indexOf('=========================================================='), out.indexOf(`block: ${r.lines} lines`) + 1, 'the rule closes the block, the annotations follow it');
});

test('S6 the verdict: ok only when complete, fail 0, cancelled 0, todo 0, no failing leaf, every skip reason known and the count equal; an unfinished run shows its last 40 lines; an unknown reason is named', () => {
  assert.equal(summarize(GREEN, { expectWin32: 0 }).ok, true);
  assert.equal(summarize(GREEN_WIN, { expectWin32: 3 }).ok, true);
  assert.equal(summarize(GREEN_WIN, { expectWin32: 2 }).ok, false, 'the count differs');
  assert.equal(summarize(RED).ok, false);
  assert.equal(summarize(GREEN.replace('# cancelled 0', '# cancelled 1')).ok, false, 'cancelled');
  assert.equal(summarize(GREEN.replace('# fail 0', '# fail 1')).ok, false, 'the totals say a test failed');
  const todo = GREEN.replace('ok 4 - tools/test-journey.mjs', 'ok 4 - tools/test-journey.mjs # TODO later').replace('# todo 0', '# todo 1');
  const t = summarize(todo);
  assert.equal(t.ok, false, 'a todo is not a pass');
  assert.ok(t.text.includes('::error title=todo::1 todo test(s)'));

  const lines = GREEN_WIN.split('\n');
  const truncated = lines.slice(0, lines.indexOf('1..6')).join('\n');
  assert.ok(truncated.split('\n').length > 40);
  const u = summarize(truncated);
  assert.equal(u.ok, false, 'no totals, never ok');
  assert.ok(u.text.includes('the run did not finish (a step timeout, a crash or a cancel)'));
  assert.ok(u.text.includes('the last test reported before the run stopped'));
  assert.ok(u.text.includes('::error title=npm test did not finish::'));
  const shown = u.text.split('\n').filter((l) => l.startsWith('  | ')).map((l) => l.slice(4));
  assert.equal(shown.length, 40);
  assert.deepEqual(shown, truncated.split('\n').slice(-40), 'its last 40 lines');

  const strange = GREEN.replace('# SKIP unshare --pid is unavailable here', '# SKIP flaky on this box');
  const s = summarize(strange);
  assert.equal(s.ok, false, 'a reason no run expects');
  assert.ok(s.text.includes("a skip reason no run expects: 'flaky on this box' (SIGTERM to node running as PID 1: the store closes and the process exits 143) — if this environment cannot run it by design, add its pattern and probe to KNOWN_SKIPS in tools/tap-summary.mjs; otherwise make the test run"), s.text);
  assert.ok(s.text.includes('::error title=unknown skip reason::'));
  assert.equal(summarize(GREEN.replace('# SKIP unshare --pid is unavailable here', '# SKIP')).ok, false, 'a skip without a reason is not a known one');
  const harnessSkip = GREEN.replace('# all journey assertions pass.', '# - SKIP no backend here');
  assert.equal(summarize(harnessSkip).ok, false, 'a harness skip line is held too');

  for (const reason of [pwReason('/x/server/test-a.mjs'), 'chromium.launch failed: Executable doesn\'t exist', 'unshare --pid is unavailable here', 'cannot run /usr/bin/node as an unprivileged user on this checkout: EACCES', `win32: ${MODES}`]) {
    assert.equal(isExpectedSkip(reason), true, reason);
  }
  assert.equal(isExpectedSkip('unshare --pid is unavailable here, mostly'), false, 'a string entry matches exactly');
  for (const k of KNOWN_SKIPS) assert.ok(typeof k.probe === 'string' && k.probe.length > 10, 'every known reason names its probe');
});

test('S7 README "Platforms" states the count the Windows leg holds a run to, before its first fence', () => {
  const n = readmeWin32Lines(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  assert.ok(Number.isInteger(n) && n > 0, `the real README states a number (${n})`);
  assert.equal(readmeWin32Lines('### Platforms\n\nA run prints 19 `SKIP win32:` lines.\n\n```bash\nnpm test\n```\n'), 19);
  assert.equal(readmeWin32Lines('### Platforms\n\nNo count here.\n\n```bash\nnpm test\n```\n\nA run prints 19 `SKIP win32:` lines.\n'), null, 'after the fence is not the section');
  assert.equal(readmeWin32Lines('## Quickstart\n\n19 `SKIP win32:` lines\n'), null, 'no Platforms section');
  assert.equal(README_WIN32_LINES_RE.exec('prints 7 `SKIP win32:` lines')[1], '7');
});

test('S8 the bytes: UTF-16LE with its mark, a UTF-8 mark and CRLF parse alike; a console code page\'s mojibake and U+FFFD are flagged with the platform\'s capture command, and the count survives', () => {
  const plain = parseTap(GREEN_WIN);
  const forms = [
    Buffer.from(GREEN_WIN, 'utf8'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(GREEN_WIN, 'utf8')]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(GREEN_WIN, 'utf16le')]),
    Buffer.from(GREEN_WIN.replace(/\n/g, '\r\n'), 'utf8'),
  ];
  for (const [i, bytes] of forms.entries()) {
    const d = decodeTap(bytes);
    assert.equal(d.mangled, false, `form ${i}: ✓, — and · are not mojibake`);
    const p = parseTap(d.text);
    assert.deepEqual([p.totals, p.win32, p.points.map((x) => x.name)], [plain.totals, plain.win32, plain.points.map((x) => x.name)], `form ${i}`);
  }
  // Windows PowerShell 5.1: the console's code page decodes the UTF-8, then `>` writes UTF-16LE.
  const cp437 = GREEN_WIN.replace(/✓/g, 'Γ£ô').replace(/✗/g, 'Γ£ù').replace(/—/g, 'ΓÇö');
  const cp1252 = GREEN_WIN.replace(/✓/g, 'âœ“').replace(/✗/g, 'âœ—').replace(/—/g, 'â€”');
  for (const text of [cp437, cp1252, GREEN_WIN.replace('listJourneys', 'list\uFFFDJourneys')]) {
    const d = decodeTap(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    assert.equal(d.mangled, true);
    assert.equal(parseTap(d.text).win32, plain.win32, 'the count is ASCII and survives');
    const onWindows = summarize(d.text, { windows: true, file: 'test.tap' }).text;
    assert.ok(onWindows.includes('warning: test.tap went through a console code page (✗ arrives as Γ£ù) — the failure causes may be cut; capture it with: cmd /c "set NODE_OPTIONS=--test-reporter=tap&& npm test > test.tap 2>&1"'), onWindows);
    assert.ok(summarize(d.text, { windows: false, file: 'run.tap' }).text.includes('capture it with: NODE_OPTIONS=--test-reporter=tap npm test > run.tap 2>&1'));
  }
  assert.ok(!summarize(GREEN_WIN).text.includes('warning:'), 'a clean capture is not warned about');
});

test('S9 the CLI: the block on stdout, exit 0 and 1; usage, a README without the sentence and non-TAP input exit 2 naming the way out; --shape and --compare', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tap-summary-'));
  try {
    const run = (args, cwd = ROOT) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
    const f = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p; };
    const green = f('green.tap', GREEN);
    const ok = run([green, '--win32-skips', '0', '--shape', join(dir, 'shape.json')]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.startsWith(`${HEAD}\nhost: `), ok.stdout);
    assert.match(ok.stdout, /^host: \S+ \S+ \S+ · node v\d+\.\d+\.\d+ · \d+ cpus · cwd .+ · tmpdir .+ · symlink: \S+$/m);
    assert.match(ok.stdout, /::notice title=npm test::tests 4 pass 2 fail 0 skipped 2 \(win32 0\/0\)/);
    const shape = JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf8'));
    assert.equal(shape.tests, 4);
    assert.equal(shape.node, process.version);
    assert.deepEqual(shape.harness, { 'tools/test-journey.mjs': { asserts: 3, win32: 0 } });

    // The failures' locations under this checkout, quoted as util.inspect quotes them (a Windows path's backslashes doubled).
    const red = run([f('red.tap', RED.replaceAll(`location: '${LROOT}/`, `location: '${(ROOT + sep).replace(/\\/g, '\\\\')}`)), '--shape', join(dir, 'red-shape.json')]);
    assert.equal(red.status, 1);
    assert.ok(red.stdout.includes('::error file=tools/test-journey.mjs,line=1,title=tools/test-journey.mjs::'), red.stdout);
    assert.equal(JSON.parse(readFileSync(join(dir, 'red-shape.json'), 'utf8')).fail, 4, 'the shape is written whatever the exit');
    const readme = run([green, '--win32-skips', 'readme']);
    assert.equal(readme.status, 1, 'README states a count; this run printed none');
    assert.match(readme.stdout, /SKIP win32: lines: 0, README states \d+ — NOT the stated number/);

    const usage = (args, text, cwd) => {
      const r = run(args, cwd);
      assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stderr.includes(text), `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, '', 'nothing on stdout');
    };
    usage([join(dir, 'missing.tap')], `no such file: ${join(dir, 'missing.tap')}`);
    usage([green, '--win32-skips'], '--win32-skips needs readme or a number');
    usage([green, '--win32-skips', 'many'], '--win32-skips needs readme or a number');
    usage([green, '--shape'], '--shape needs a file');
    usage([green, '--bogus'], 'unknown flag: --bogus');
    usage([], 'name the TAP file');
    f('README.md', '# A fork\n\n### Platforms\n\nWindows is untested.\n');
    usage([green, '--win32-skips', 'readme'], 'README.md "Platforms" states no "<N> `SKIP win32:` lines" — the count this check holds the run to', dir);
    usage(['--compare', join(dir, 'shape.json')], '--compare needs the reference shape and at least one run');
    usage(['--compare', join(dir, 'shape.json'), join(dir, 'nope.json')], `no such file: ${join(dir, 'nope.json')}`);
    const spec = f('spec.tap', '✔ a (1.2ms)\n﹣ b (0.1ms) # a reason\nℹ tests 2\nℹ pass 1\n');
    // The way out is this platform's capture command; either form names the reporter and the file.
    const named = (r, file) => [reportCommand(file, false), reportCommand(file, true)].some((c) => r.stderr.trimEnd().endsWith(c));
    usage([spec], "holds the spec reporter's output, not TAP (Node 23 and later print spec even into a file) — capture it again with the reporter named: ");
    assert.ok(named(run([spec]), spec), 'the spec refusal ends with the capture command');
    const npmLog = f('npm.log', 'npm error Missing script: "test"\n');
    usage([npmLog], 'is not TAP (no "TAP version" line) — capture the run with the reporter named: ');
    assert.ok(named(run([npmLog]), npmLog));
    assert.ok(run([spec]).stderr.includes('NODE_OPTIONS=--test-reporter=tap') && run([spec]).stderr.includes(`npm test > ${spec} 2>&1`));

    assert.equal(reportCommand('test.tap', false), 'NODE_OPTIONS=--test-reporter=tap npm test > test.tap 2>&1');
    assert.equal(reportCommand('test.tap', true), 'cmd /c "set NODE_OPTIONS=--test-reporter=tap&& npm test > test.tap 2>&1"');

    const same = run(['--compare', join(dir, 'shape.json'), join(dir, 'shape.json')]);
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /tests 4 = 4 · harness assertions 3 vs 3 in 1 files · other skips equal \(PID 1: 1 vs 1\) — it ran what the reference ran/);
    assert.match(same.stdout, /^::notice title=windows-vs-linux::/m);
    const differs = run(['--compare', join(dir, 'shape.json'), join(dir, 'red-shape.json')]);
    assert.equal(differs.status, 1);
    assert.match(differs.stdout, /^::error title=\S+ \(node [\d.]+\) vs \S+ \(node [\d.]+\)::tools\/test-journey\.mjs: 2 harness assertions on the run, 3 on the reference, and no SKIP win32: line in the file — an early exit$/m);
    assert.ok(!/::notice/.test(differs.stdout), 'no notice when a run differs');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The workflow's jobs as their text, and a job's steps as theirs (the
// shapes this file pins are written one key per line).
function workflowJobs(text) {
  const jobs = {};
  let name = null;
  for (const line of text.slice(text.indexOf('\njobs:\n') + 7).split('\n')) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; jobs[name] = []; } else if (name) jobs[name].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}
const stepsOf = (job) => job.split(/\n(?= {6}- )/).slice(1);
const stepNamed = (job, re) => stepsOf(job).filter((st) => re.test(st));
const minutes = (text) => Number(/timeout-minutes: (\d+)/.exec(text)?.[1]);
const jobMinutes = (job) => Number(/^ {4}timeout-minutes: (\d+)/m.exec(job)?.[1]);
const SUMMARY_IF = "if: ${{ !cancelled() && (steps.test.outcome == 'success' || steps.test.outcome == 'failure') }}";

test('S10 the workflow wires it: a Windows matrix on the floor and the latest 22 that runs the documented report command, npm test through tee under pipefail with a step timeout, and the summary held to README; node-floor and validate end with the summary; windows-vs-linux compares the shapes', () => {
  const text = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = workflowJobs(text);
  assert.ok(text.includes('# Validates every push to develop/main and every PR into develop or main.'));
  assert.ok(!/continue-on-error/.test(text), 'no step or job is allowed to fail');

  const w = jobs.windows;
  assert.ok(w, 'a windows job');
  assert.match(w, /^ {4}runs-on: windows-latest$/m);
  assert.match(w, /^ {6}fail-fast: false$/m);
  assert.match(w, /^ {8}node: \['22\.16\.0', '22'\]$/m, 'the floor and the latest 22, as on Linux');
  assert.match(w, /^ {4}defaults:\n {6}run:\n {8}shell: bash$/m, 'every run step under bash -eo pipefail');
  assert.match(jobs['node-floor'], /node-version: '22\.16\.0'/);
  assert.match(jobs.validate, /node-version: '22'/);
  const report = stepNamed(w, /The documented report command captures TAP/);
  assert.equal(report.length, 1, 'the report-command step');
  assert.match(report[0], /^ {8}shell: powershell$/m, 'run from Windows PowerShell, the hardest shell for it');
  assert.ok(report[0].includes(reportCommand('test.tap', true).replace('npm test', 'npm run test:platform')), 'the documented command, on one suite');
  assert.ok(report[0].includes('if ($LASTEXITCODE)') && report[0].includes('node tools/tap-summary.mjs test.tap --win32-skips 0') && report[0].includes('exit $code'), 'each native exit checked by hand');
  const wTest = stepNamed(w, /id: test\n/);
  assert.equal(wTest.length, 1);
  assert.ok(wTest[0].includes('run: npm test 2>&1 | tee "$RUNNER_TEMP/test.tap"'));
  assert.ok(stepsOf(w).indexOf(report[0]) < stepsOf(w).indexOf(wTest[0]), 'the report command runs first');
  assert.ok(minutes(wTest[0]) < jobMinutes(w), `the step timeout (${minutes(wTest[0])}) under the job's (${jobMinutes(w)}), so the summary runs on a hang`);
  const wSum = stepNamed(w, /id: summary\n/);
  assert.equal(wSum.length, 1);
  assert.ok(wSum[0].includes(SUMMARY_IF));
  assert.ok(wSum[0].includes('run: node tools/tap-summary.mjs "$RUNNER_TEMP/test.tap" --win32-skips readme --shape "$RUNNER_TEMP/run-shape.json"'));
  const wUp = stepNamed(w, /upload-artifact/);
  assert.equal(wUp.length, 1);
  assert.ok(wUp[0].includes('name: run-shape-windows-${{ matrix.node }}') && /overwrite: true/.test(wUp[0]) && wUp[0].includes("if: ${{ !cancelled() && steps.summary.outcome == 'success' }}"));

  const f = jobs['node-floor'];
  const fTest = stepNamed(f, /id: test\n/);
  assert.equal(fTest.length, 1);
  assert.match(fTest[0], /^ {8}shell: bash$/m, 'pipefail: GitHub\'s implicit Linux shell has none');
  assert.ok(fTest[0].includes('run: npm test 2>&1 | tee "$RUNNER_TEMP/test.tap"'));
  assert.ok(minutes(fTest[0]) < jobMinutes(f), 'the step timeout under the job\'s');
  const fSum = stepNamed(f, /id: summary\n/);
  assert.ok(fSum[0].includes(SUMMARY_IF) && fSum[0].includes('--win32-skips 0 --shape "$RUNNER_TEMP/run-shape.json"'));
  assert.ok(stepNamed(f, /upload-artifact/)[0].includes('name: run-shape-node-floor') && /overwrite: true/.test(stepNamed(f, /upload-artifact/)[0]));

  const v = jobs.validate;
  const vTest = stepNamed(v, /id: test\n/);
  assert.equal(vTest.length, 1);
  assert.match(vTest[0], /^ {8}shell: bash$/m);
  assert.ok(vTest[0].includes('run: npm run coverage 2>&1 | tee "$RUNNER_TEMP/test.tap"'));
  assert.ok(minutes(vTest[0]) < jobMinutes(v), 'the step timeout under the job\'s');
  const vSteps = stepsOf(v);
  assert.ok(vSteps[vSteps.length - 1].includes(SUMMARY_IF) && vSteps[vSteps.length - 1].includes('run: node tools/tap-summary.mjs "$RUNNER_TEMP/test.tap" --win32-skips 0'), 'validate ends with the summary');

  const c = jobs['windows-vs-linux'];
  assert.match(c, /^ {4}needs: \[node-floor, windows\]$/m);
  assert.ok(c.includes('uses: actions/download-artifact@v8') && c.includes('pattern: run-shape-*'));
  assert.ok(c.includes('node tools/tap-summary.mjs --compare'));
  for (const node of ['node-floor', 'windows-22.16.0', 'windows-22']) assert.ok(c.includes(`"$RUNNER_TEMP/shapes/run-shape-${node}/run-shape.json"`), node);

  // Every piped run is under pipefail; no suites step names the reporter (Node 22 prints TAP into a pipe).
  for (const [name, job] of Object.entries(jobs)) {
    for (const st of stepsOf(job)) {
      if (/\| tee /.test(st)) assert.ok(/shell: bash/.test(st) || /^ {4}defaults:\n {6}run:\n {8}shell: bash$/m.test(job), `${name}: a piped step runs under bash -eo pipefail`);
      if (/NODE_OPTIONS/.test(st)) assert.ok(st === report[0], `${name}: NODE_OPTIONS only in the report-command step`);
    }
  }
});

test('S11 grouping: the seven browser suites\' importer-specific reasons, POSIX and Windows, are one line; the PID 1 reason and a win32 reason stay apart', () => {
  const reasons = [
    ...BROWSER_SUITES.map((s) => pwReason(`${LROOT}/${s}`)),
    ...BROWSER_SUITES.map((s) => pwReason(`${WROOT}\\${s.replace(/\//g, '\\')}`)),
  ];
  assert.equal(new Set(reasons.map(skipGroup)).size, 1);
  assert.equal(skipGroup(reasons[0]), "cannot import <playwright>: Cannot find package 'playwright' imported from <a suite>");
  assert.equal(skipGroup('cannot import /opt/pw/index.mjs: Cannot find module \'/opt/pw/index.mjs\' imported from /r/server/test-a.mjs'), "cannot import <playwright>: Cannot find module '/opt/pw/index.mjs' imported from <a suite>", 'a knob set to a path');
  const tap = `TAP version 13\n${reasons.map((r, i) => okPoint(i + 1, `BROWSER ${i}`, { directive: ` # SKIP ${r.replace(/\\/g, '\\\\')}` })).join('')}${okPoint(15, 'PID 1', { directive: ' # SKIP unshare --pid is unavailable here' })}${okPoint(16, 'modes', { directive: ` # SKIP win32: ${MODES}` })}${TOTALS({ tests: 16, pass: 0, skipped: 16 })}`;
  const text = summarize(tap).text;
  assert.ok(text.includes("skip lines by reason (16):\n    14 × cannot import <playwright>: Cannot find package 'playwright' imported from <a suite>\n     1 × unshare --pid is unavailable here\n     1 × win32: POSIX mode bits"), text);
});

test('S12 timing bounds: node:test diagnostics at depth 0 and 1 and a harness line; upper and lower grammar; nearest its limit first; past half flagged per form; an unparsable line listed', () => {
  const tap = `TAP version 13
${okPoint(1, 'the submit answers within 2 s')}# bound: the submit answers within 2 s: 1640 ms < 2000 ms
# Subtest: lock waits
${okPoint(1, 'a write waits', { depth: 1 })}    # bound: a write waited on the lock: 450 ms >= 300 ms of a 700 ms hold
${okPoint(2, 'a migration waits', { depth: 1 })}    # bound: a migration waited on the lock: 612 ms >= 300 ms of a 700 ms hold
    1..2
ok 2 - lock waits
  ---
  duration_ms: 2
  type: 'test'
  ...
# ✓ the abort ends the request
# bound: the caller's abort ends a request in flight: 400 ms < 2000 ms
# bound: the compile took a while
${okPoint(3, 'tools/test-mcp-transport.mjs')}${TOTALS({ tests: 5, pass: 5 })}`;
  const p = parseTap(tap);
  assert.equal(p.bounds.length, 5);
  assert.deepEqual(p.bounds.filter((b) => !b.unreadable).map((b) => [b.measured, b.op, b.limit, b.hold, b.pastHalf]), [
    [1640, '<', 2000, null, true],
    [450, '>=', 300, 700, true],
    [612, '>=', 300, 700, false],
    [400, '<', 2000, null, false],
  ], 'upper: over half the limit; with a hold: over half its slack consumed');
  const text = summarize(tap).text;
  const block = text.slice(text.indexOf('timing bounds'), text.indexOf('slowest'));
  assert.ok(block.startsWith('timing bounds (4, nearest its limit first; 1 unreadable):'), block);
  const order = ['the submit answers within 2 s', 'a write waited on the lock', 'a migration waited on the lock', 'the caller\'s abort ends'].map((s) => block.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'nearest its limit first');
  assert.ok(order.every((i) => i > 0));
  assert.ok(block.includes('  1640 ms of < 2000 ms   82%  the submit answers within 2 s  ← past half'), block);
  assert.ok(block.includes('   450 ms of >= 300 ms (700 ms hold)   63%  a write waited on the lock  ← past half'), block);
  assert.ok(block.includes('   612 ms of >= 300 ms (700 ms hold)   22%  a migration waited on the lock\n'), block);
  assert.ok(block.includes('   400 ms of < 2000 ms   20%  the caller\'s abort ends a request in flight\n'), block);
  assert.ok(block.includes('  unreadable: bound: the compile took a while'), block);
  const exact = parseTap(`TAP version 13\n# bound: half: 1000 ms < 2000 ms\n# bound: held half: 500 ms >= 300 ms of a 700 ms hold\n`).bounds;
  assert.deepEqual(exact.map((b) => b.pastHalf), [false, false], 'exactly half is not past it');
  assert.ok(summarize(GREEN).text.includes('timing bounds (2, nearest its limit first):'), 'a bound after a point and one in a harness suite');
});

test('S13 the run\'s shape: totals, skips by grouped reason, per harness suite its ✓ assertions and win32 lines — only a harness point\'s own diagnostics, its name with /', () => {
  const tap = `TAP version 13
# ✓ one
# - SKIP win32: ${SYMLINKS}
#   ✓ an indented one
# ✓ three
# Subtest: tools\\\\test-journey.mjs
ok 1 - tools\\\\test-journey.mjs
  ---
  duration_ms: 20
  type: 'test'
  ...
# ✓ printed by a node:test file before its tests
${okPoint(2, 'a node:test test')}# bound: the node:test bound: 12 ms < 2000 ms
${okPoint(3, 'BROWSER', { directive: ` # SKIP ${pwReason('/r/server/test-brand-shell.mjs')}` })}${okPoint(4, 'symlinks', { directive: ` # SKIP win32: ${SYMLINKS}` })}# ✓ a
# ✓ b
# ✓ c
${okPoint(5, 'tools/test-crawl.mjs')}${TOTALS({ points: 5, tests: 5, pass: 3, skipped: 2 })}`;
  const shape = runShape(parseTap(tap), { node: 'v22.16.0' });
  assert.deepEqual(shape, {
    node: 'v22.16.0',
    tests: 5, pass: 3, fail: 0, skipped: 2, todo: 0, cancelled: 0,
    win32: 2,
    skips: {
      "cannot import <playwright>: Cannot find package 'playwright' imported from <a suite>": 1,
      [`win32: ${SYMLINKS}`]: 1,
      [`win32: ${SYMLINKS} (harness)`]: 1,
    },
    harness: {
      'tools/test-crawl.mjs': { asserts: 3, win32: 0 },
      'tools/test-journey.mjs': { asserts: 3, win32: 1 },
    },
  });
  assert.deepEqual(Object.keys(runShape(parseTap(GREEN)).harness), ['tools/test-journey.mjs']);
  assert.deepEqual(Object.keys(runShape(parseTap(GREEN_WIN)).harness), ['tools/test-journey.mjs'], 'a Windows harness name, unescaped, with /');
});

test('S14 the cross-leg check: the same tests, todo 0, the same harness suites and assertions (fewer only under a win32 skip), the same non-win32 skips (the PID 1 one may be 1 against 0)', () => {
  const pw = "cannot import <playwright>: Cannot find package 'playwright' imported from <a suite>";
  const ref = { node: 'v22.16.0', tests: 1354, todo: 0, skips: { [pw]: 22, 'unshare --pid is unavailable here': 1 }, harness: { 'tools/test-journey.mjs': { asserts: 900, win32: 0 }, 'tools/test-crawl.mjs': { asserts: 50, win32: 0 } } };
  const run = (over = {}) => ({ ...structuredClone(ref), ...over });
  const ok = compareShapes(ref, run());
  assert.equal(ok.ok, true, ok.differences.join('\n'));
  assert.match(ok.line, /tests 1354 = 1354 · harness assertions 950 vs 950 in 2 files · other skips equal \(PID 1: 1 vs 1\) — it ran what the reference ran$/);
  const named = (shape, re, reference = ref) => {
    const c = compareShapes(reference, shape);
    assert.equal(c.ok, false, `${re}`);
    assert.ok(c.differences.some((d) => re.test(d)), `${re}: ${c.differences.join(' | ')}`);
  };
  named(run({ tests: 1353 }), /^tests 1353 on the run, 1354 on the reference/);
  named(run({ harness: { 'tools/test-journey.mjs': { asserts: 900, win32: 0 } } }), /^tools\/test-crawl\.mjs: a harness suite the reference ran and the run did not report/);
  named(run({ harness: { ...ref.harness, 'tools/test-new.mjs': { asserts: 1, win32: 0 } } }), /^tools\/test-new\.mjs: a harness suite only the run reported/);
  named(run({ harness: { ...ref.harness, 'tools/test-crawl.mjs': { asserts: 40, win32: 0 } } }), /^tools\/test-crawl\.mjs: 40 harness assertions on the run, 50 on the reference, and no SKIP win32: line in the file/);
  named(run({ harness: { ...ref.harness, 'tools/test-crawl.mjs': { asserts: 51, win32: 1 } } }), /51 harness assertions on the run, 50 on the reference — more/);
  named(run({ skips: { ...ref.skips, [pw]: 21 } }), /^skip 'cannot import <playwright>.*': 21 on the run, 22 on the reference/);
  named(run({ skips: { ...ref.skips, 'cannot run /usr/bin/node as an unprivileged user on this checkout: x': 1 } }), /^skip 'cannot run .*': 1 on the run, 0 on the reference/);
  named(run({ todo: 1 }), /^todo 1 on the run/);
  named(run(), /^todo 2 on the reference/, { ...ref, todo: 2 });
  named(run({ skips: { [pw]: 22 } }), /^skip 'unshare --pid is unavailable here': 0 on the run, 1 on the reference/);

  const fewer = compareShapes(ref, run({ harness: { ...ref.harness, 'tools/test-journey.mjs': { asserts: 893, win32: 1 } }, skips: { ...ref.skips, [`win32: ${SYMLINKS}`]: 4, [`win32: ${SYMLINKS} (harness)`]: 1 } }));
  assert.equal(fewer.ok, true, 'fewer under a win32 skip; win32 reasons are the count\'s, not this check\'s');
  assert.match(fewer.line, /harness assertions 943 vs 950 in 2 files \(tools\/test-journey\.mjs −7 under 1 win32 skip\)/);
  const pid1 = compareShapes({ ...ref, skips: { [pw]: 22 } }, run());
  assert.equal(pid1.ok, true, 'the PID 1 test may run on the reference and skip on the run');
  assert.match(pid1.line, /PID 1: 1 vs 0/);
});
