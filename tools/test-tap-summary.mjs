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
import { tap } from 'node:test/reporters';
import strictAssert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_SKIPS, README_WIN32_LINES_RE, annotation, compareShapes, decodeTap, isExpectedSkip, logLines, parseTap,
  notStartedBlock, readmeWin32Lines, reportCommand, runShape, skipGroup, summarize, unescapeTap, whereOf,
} from './tap-summary.mjs';

// A failing assertion's message, actual and expected are printed into the
// TAP, and every suites step tees that TAP into its job's log, where the
// runner executes a line that starts with `::` once its leading whitespace is
// trimmed. The texts this suite asserts on end in such lines (a summary's
// annotations and notice): raw, a failure here would annotate the job with a
// fixture's errors and a second `npm test` notice. So every string a failing
// assertion carries shows such a line behind `| `, and its stack starts at
// the assertion, the frame the summary places a failure by.
const COMMAND_LINE_RE = /^([\s\u0085]*)::/gm;   // C#'s TrimStart also trims U+0085
const defuse = (v) => {
  if (typeof v === 'string') return v.replace(COMMAND_LINE_RE, '$1| ::');
  if (Array.isArray(v)) return v.map(defuse);
  if (typeof v === 'object' && v !== null && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, defuse(x)]));
  return v;
};
const assert = Object.fromEntries(['deepEqual', 'equal', 'match', 'ok'].map((k) => [k, function commandless(...args) {
  try {
    return strictAssert[k](...args);
  } catch (e) {
    if (!(e instanceof strictAssert.AssertionError)) throw e;
    for (const key of ['message', 'actual', 'expected']) e[key] = defuse(e[key]);
    Error.captureStackTrace(e, commandless);
    throw e;
  }
}]));

// The TAP node --test prints for a test that threw `error`: its own reporter,
// fed the failure as the runner reports it (wrapped as a test-code failure).
async function tapOf(error) {
  const failure = Object.assign(new Error('test failed'), { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: error });
  async function* events() { yield { type: 'test:fail', data: { name: 'a failing assertion', nesting: 0, testNumber: 1, details: { duration_ms: 1, type: 'test', error: failure } } }; }
  let text = '';
  for await (const chunk of tap(events())) text += chunk;
  return text;
}

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

  assert.deepEqual(p.missingTotals, []);
  const cut = parseTap(tap.slice(0, tap.indexOf('1..4')));
  assert.equal(cut.complete, false, 'no totals, not complete');
  assert.deepEqual(cut.totals, {});
  assert.deepEqual(cut.missingTotals, ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']);
  const partial = parseTap(tap.slice(0, tap.indexOf('# cancelled')));
  assert.equal(partial.complete, false, 'a cut inside the totals, not complete');
  assert.deepEqual(partial.totals, {}, 'a partial block is not the run\'s totals');
  assert.deepEqual(partial.missingTotals, ['cancelled', 'skipped', 'todo']);
  assert.equal(parseTap(tap.slice(0, tap.indexOf('# duration_ms'))).complete, true, 'every total the verdict reads, only the duration missing');
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
  assert.ok(r.text.includes('--- not ok 2 - tools/test-journey.mjs\n    at tools/test-journey.mjs:1\n    | ✗ the cron line'), r.text);
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
  assert.ok(many.text.includes('    | line 25 of failure 1\n    … 5 more line(s)'), 'at most 25 lines each');
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

test('S5 annotations: escaping, the run-level errors first, failures up to the cap of 10, the notice naming the block\'s length and the tail to read; the run\'s own text in the block never a workflow command; in a failing assertion here, each behind `| `', async () => {
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

  // A failure's annotation carries its error lines cut at 500 characters, as
  // the block does: a got: line can be one huge JSON dump, and the
  // annotations are the last lines of the log a tail read fetches. A harness
  // suite's ✗ line with a 5 MB got:, and a node:test error with a 5 MB line.
  // (Lengths only: a failure here must not print the huge line itself.)
  const big = 'r'.repeat(5e6);
  const hugeRun = `TAP version 13\n# ✗ the pack matches\n#     got:  {"rows":"${big}"}\n#     want: {}\n# 1 assertion(s) failed.\n${harnessFailure(1, 'tools/test-big.mjs')}${nodeFailure(2, 'a huge error', [`payload: ${big}`, 'after it'])}${TOTALS({ points: 2, tests: 2, pass: 0, fail: 2 })}`;
  const h = summarize(hugeRun, { root: LROOT, pathApi: posix });
  const hugeNotes = h.text.split('\n').filter((l) => l.startsWith('::error'));
  assert.equal(hugeNotes.length, 2, 'an annotation per failure');
  const parts = hugeNotes.map((l) => l.slice(l.indexOf('::', 2) + 2).split('%0A'));
  assert.deepEqual(parts.map((p) => p.length), [3, 2], 'each failure\'s lines, none dropped');
  const longestPart = Math.max(...parts.flat().map((p) => p.length));
  assert.ok(longestPart <= 500, `no annotation line past 500 characters: the longest is ${longestPart}`);
  const blockGot = h.text.split('\n').find((l) => l.startsWith('    |     got:  '));
  assert.equal(blockGot.length, 506, 'the block\'s got: line, cut at 500 behind its \'    | \'');
  assert.equal(parts[0][1], blockGot.slice(6), 'the annotation\'s got: line is the block\'s, cut alike');
  assert.equal(parts[0][1].slice(-3), 'rr…', 'and marked cut');
  assert.equal(parts[1][0].length, 500, 'the node:test error line cut at 500');
  assert.equal(parts[1][1], 'after it', 'the line after it whole');
  assert.ok(h.text.length < 16_000, `the summary is the block and its annotations, not the dump: ${h.text.length} characters`);

  // The run's own text is never a workflow command in the block: the runner
  // executes a line that starts with `::` once its leading whitespace is
  // trimmed (C#'s TrimStart, U+0085 included), and reads a lone CR as a line
  // break, so a failure's `::stop-commands::` would leave the block's own
  // annotations and notice unprocessed. A failure's error lines as node's
  // reporter prints them (a block scalar, a quoted one with a CR), a harness
  // suite's ✗ cause, an unreadable bound line, an unfinished run's tail and
  // a not-started capture: each such line behind `| `, a CR printed `\r`.
  const forged = ['::stop-commands::pause', '  ::error title=forged::not a failure of this run', 'x\r::add-mask::tests', '\u0085::warning::y'];
  const first = await tapOf(new Error(forged.join('\n')));
  const second = (await tapOf(new Error('first\r::stop-commands::x'))).replace('TAP version 13\n', '').replace('not ok 1 - ', 'not ok 2 - ');
  const forgedRun = `${first}${second}# bound: x\r::stop-commands::y\n# ✗ a check\n#     ::stop-commands::pause\n${harnessFailure(3, 'tools/test-forged.mjs')}${TOTALS({ points: 3, tests: 3, pass: 0, fail: 3 })}`;
  const runnerLines = (text) => text.split(/\r?\n|\r/);
  const RULE = '='.repeat(HEAD.length);
  const fr = summarize(forgedRun, { root: LROOT, pathApi: posix });
  const ur = summarize(first, { root: LROOT, pathApi: posix });
  const nr = notStartedBlock(`npm error ${forged.join('\n')}\nz\r::add-mask::tests\n`);
  assert.equal(fr.failures.length, 3, 'three failures');
  assert.equal(ur.parsed.complete, false, 'an unfinished run');
  for (const [name, block] of [['failures', fr], ['an unfinished run', ur], ['a not-started capture', nr]]) {
    const own = block.text.split('\n');
    const commands = own.slice(own.indexOf(RULE) + 1);
    assert.ok(commands.length >= 2 && commands.every((l) => /^::(error|notice) /.test(l)), `${name}: the block's own annotations and notice follow its rule`);
    assert.deepEqual(runnerLines(block.text).filter((l) => /^[\s\u0085]*::/.test(l)), commands, `${name}: they are its only lines the runner would execute`);
    assert.equal(runnerLines(block.text).reduce((n, l) => n + logLines(l), 0), block.lines, `${name}: the block counts the log lines the runner makes of it`);
  }
  for (const shown of ['\n    | ::stop-commands::pause\n    |   ::error title=forged::not a failure of this run\n    | x\\r::add-mask::tests\n    | \u0085::warning::y\n',
    '\n    | first\\r::stop-commands::x\n', '\n    | ✗ a check\n    |     ::stop-commands::pause\n', '\n  unreadable: bound: x\\r::stop-commands::y\n']) {
    assert.ok(fr.text.includes(shown), `the failures' block shows ${JSON.stringify(shown)}`);
  }
  assert.ok(ur.text.includes('\n  |     x\\r::add-mask::tests\n  |     \u0085::warning::y\n'), 'the unfinished run\'s tail shows it');
  assert.ok(nr.text.includes('\n  | npm error ::stop-commands::pause\n  |   ::error title=forged::not a failure of this run\n  | x\\r::add-mask::tests\n'), 'the not-started block shows it');

  // This suite's own failure, as node --test prints it into a job's log: the
  // text still shown, no line of it a workflow command.
  for (const fail of [() => assert.ok(false, r.text), () => assert.ok(undefined, r.text), () => assert.equal(1, 2, r.text), () => assert.match(r.text, /never printed/), () => assert.equal(r.text, ''), () => assert.deepEqual([r.text], [])]) {
    let error = null;
    try { fail(); } catch (e) { error = e; }
    assert.ok(error instanceof strictAssert.AssertionError, `${fail}`);
    const printed = await tapOf(error);
    assert.deepEqual(printed.split(/\r?\n|\r/).filter((l) => /^[\s\u0085]*::/.test(l)), [], `${fail}: a line the runner would execute`);
    assert.ok(printed.includes('| ::notice title=npm test::tests 12 pass 0 fail 12'), `${fail}: the text is still shown`);
    assert.ok(!error.stack.includes('commandless'), `${fail}: the stack starts at the assertion`);
  }
});

test('S6 the verdict: ok only when complete, fail 0, cancelled 0, todo 0, no failing leaf, every skip reason known and the count equal; an unfinished run shows its last 40 lines; an unknown reason is named', () => {
  assert.equal(summarize(GREEN, { expectWin32: 0 }).ok, true);
  assert.equal(summarize(GREEN_WIN, { expectWin32: 3 }).ok, true);
  assert.equal(summarize(GREEN_WIN, { expectWin32: 2 }).ok, false, 'the count differs');
  assert.equal(summarize(RED).ok, false);
  assert.equal(summarize(GREEN.replace('# cancelled 0', '# cancelled 1')).ok, false, 'cancelled');
  assert.equal(summarize(GREEN.replace('# fail 0', '# fail 1')).ok, false, 'the totals say a test failed');
  // A failing leaf decides on its own: totals that say fail 0 beside a
  // `not ok` leaf (a TAP stitched from two runs, or mangled) are never ok.
  const leaf = GREEN.replace(okPoint(4, 'tools/test-journey.mjs', { ms: 24012.3 }), harnessFailure(4, 'tools/test-journey.mjs'));
  assert.ok(leaf !== GREEN && leaf.includes('\n# fail 0\n'), 'the fixture holds a failing leaf and keeps fail 0 in its totals');
  const lf = summarize(leaf, { expectWin32: 0 });
  assert.equal(lf.ok, false, 'a failing leaf the totals do not count');
  assert.deepEqual(lf.failures.map((f) => f.name), ['tools/test-journey.mjs'], 'and the block lists it');
  const todo = GREEN.replace('ok 4 - tools/test-journey.mjs', 'ok 4 - tools/test-journey.mjs # TODO later').replace('# todo 0', '# todo 1');
  const t = summarize(todo);
  assert.equal(t.ok, false, 'a todo is not a pass');
  assert.ok(t.text.includes('::error title=todo::1 todo test(s)'));

  const lines = GREEN_WIN.split('\n');
  const truncated = lines.slice(0, lines.indexOf('1..6')).join('\n');
  assert.ok(truncated.split('\n').length > 40);
  const u = summarize(truncated);
  assert.equal(u.ok, false, 'no totals, never ok');
  assert.ok(u.text.includes('The TAP ends without its totals: the run did not finish (a step timeout, a crash or a cancel).'));
  assert.ok(u.text.includes('the last test reported before the run stopped'));
  assert.ok(u.text.includes('::error title=npm test did not finish::the TAP ends without its totals (a step timeout, a crash or a cancel)'));
  const shown = u.text.split('\n').filter((l) => l.startsWith('  | ')).map((l) => l.slice(4));
  assert.equal(shown.length, 40);
  assert.deepEqual(shown, truncated.split('\n').slice(-40), 'its last 40 lines');
  // A tail line is cut at 500 characters, as a failure's error lines are: a
  // crash's last diagnostic can be one huge line (a JSON dump, a minified
  // source line), and a reader fetches the block from the log's tail whole.
  // (Lengths only: a failure here must not print the huge line itself.)
  const huge = summarize(`${truncated}\n# ${'x'.repeat(5e6)}\n`);
  const hugeShown = huge.text.split('\n').filter((l) => l.startsWith('  | ')).map((l) => l.slice(4));
  assert.equal(hugeShown.length, 40);
  assert.deepEqual(hugeShown.slice(0, -1), truncated.split('\n').slice(-39), 'the lines before it whole');
  assert.equal(hugeShown[39].length, 500, 'the huge line cut at 500 characters');
  assert.equal(hugeShown[39].slice(-3), 'xx…', 'and marked cut');
  const longest = Math.max(...huge.text.split('\n').map((l) => l.length));
  assert.ok(longest <= 504, `no line of the block past 500 characters and its '  | ': the longest is ${longest}`);

  // A cut inside the totals — node prints them in one burst at the end, and a
  // step timeout or a kill can land in it, between lines or within one — is
  // an unfinished run too, and says which totals it lacks; only a missing
  // duration leaves every total the verdict reads.
  const at = (k) => lines.findIndex((l) => l.startsWith(`# ${k} `));
  for (const [kept, missing] of [
    [lines.slice(0, at('tests') + 1), '# pass, # fail, # cancelled, # skipped, # todo'],
    [lines.slice(0, at('suites') + 1), '# pass, # fail, # cancelled, # skipped, # todo'],
    [lines.slice(0, at('pass') + 1), '# fail, # cancelled, # skipped, # todo'],
    [lines.slice(0, at('fail') + 1), '# cancelled, # skipped, # todo'],
    [lines.slice(0, at('cancelled') + 1), '# skipped, # todo'],
    [lines.slice(0, at('skipped') + 1), '# todo'],
    [[...lines.slice(0, at('skipped') + 1), '# tod'], '# todo'],
  ]) {
    const partial = kept.join('\n');
    const pr = summarize(partial, { expectWin32: 3 });
    const last = kept[kept.length - 1];
    assert.equal(pr.ok, false, `cut after '${last}': never ok`);
    assert.ok(pr.text.includes(`The TAP ends inside its totals, without ${missing}: the run did not finish (a step timeout, a crash or a cancel).`), pr.text);
    assert.ok(pr.text.includes('the last test reported before the run stopped'), last);
    assert.ok(pr.text.includes(`::error title=npm test did not finish::the TAP ends inside its totals, without ${missing} (a step timeout, a crash or a cancel)`), pr.text);
    assert.ok(pr.text.includes('tests ? · pass ? · fail ? · skipped ? · todo ? · cancelled ? · ? s'), 'a partial block is not printed as the run\'s totals');
    assert.deepEqual(pr.text.split('\n').filter((l) => l.startsWith('  | ')).map((l) => l.slice(4)), kept.slice(-40), 'its last 40 lines');
  }
  const noDuration = summarize(lines.slice(0, at('todo') + 1).join('\n'), { expectWin32: 3 });
  assert.equal(noDuration.ok, true, 'a cut before # duration_ms alone: every total the verdict reads is there');
  assert.ok(!noDuration.text.includes('did not finish'));

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

test('S9 the CLI: the block on stdout, exit 0 and 1; usage, no README, a README without the sentence and non-TAP input exit 2 naming the way out; --shape, and --compare holding every run to the reference', () => {
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
    // Run away from any README: the refusal names the missing file and the way out, not a sentence README lacks.
    const away = join(dir, 'elsewhere');
    mkdirSync(away);
    const noReadme = run([green, '--win32-skips', 'readme'], away);
    usage([green, '--win32-skips', 'readme'], ` — --win32-skips readme reads the README in the working directory: run it from the checkout's root, or pass the number README "Platforms" states (--win32-skips <n>)`, away);
    assert.match(noReadme.stderr, /^tap-summary: no README\.md in .*elsewhere — /, noReadme.stderr);
    assert.ok(!noReadme.stderr.includes('states no'), noReadme.stderr);
    mkdirSync(join(away, 'README.md'));   // EISDIR: the read's own code, whatever the platform names it
    const unreadable = run([green, '--win32-skips', 'readme'], away);
    assert.equal(unreadable.status, 2, unreadable.stdout + unreadable.stderr);
    assert.match(unreadable.stderr, /^tap-summary: cannot read .*elsewhere.README\.md: E[A-Z]+ — pass the number README "Platforms" states \(--win32-skips <n>\)$/m, unreadable.stderr);
    // A README without the sentence: the refusal names the README it read and
    // a way out that works when followed literally — away from the checkout's
    // root, the root; from the root, the sentence its README lacks.
    const toRoot = ` — --win32-skips readme reads the README in the working directory: run it from the checkout's root, or pass the number README "Platforms" states (--win32-skips <n>)`;
    const statesNo = (readmePath) => `tap-summary: ${readmePath} "Platforms" states no "<N> \`SKIP win32:\` lines"`;
    f('README.md', '# A fork\n\n### Platforms\n\nWindows is untested.\n');
    usage([green, '--win32-skips', 'readme'], `${sep}${basename(dir)}${sep}README.md "Platforms" states no "<N> \`SKIP win32:\` lines"${toRoot}`, dir);
    // A checkout of its own (this CLI in its tools/), whose subdirectory has a
    // README.md of its own and whose root's README can lack the sentence; its
    // paths are the real ones, as node names the script it runs.
    const co = join(realpathSync.native(dir), 'co');
    mkdirSync(join(co, 'tools'), { recursive: true });
    mkdirSync(join(co, 'docs'));
    writeFileSync(join(co, 'tools', 'tap-summary.mjs'), readFileSync(CLI));
    writeFileSync(join(co, 'docs', 'README.md'), '# The docs\n\nAn index.\n');
    const win = f('green-win.tap', GREEN_WIN);
    const inCo = (cwd, count = 'readme') => spawnSync(process.execPath, [join(co, 'tools', 'tap-summary.mjs'), win, '--win32-skips', count], { cwd, encoding: 'utf8' });
    const platforms = (above, below = '') => writeFileSync(join(co, 'README.md'), `# Observogram\n\n### Platforms\n\n${above}\n\n\`\`\`bash\nnpm test\n\`\`\`\n${below}`);
    const lines3 = parseTap(GREEN_WIN).win32;
    const sentence = `A run prints ${lines3} \`SKIP win32:\` lines.`;
    platforms(sentence);
    const fromSub = inCo(join(co, 'docs'));
    assert.equal(fromSub.status, 2, fromSub.stdout + fromSub.stderr);
    assert.equal(fromSub.stderr, `${statesNo(join(co, 'docs', 'README.md'))}${toRoot}\n`, 'a subdirectory\'s README.md, named, and the way to the root');
    assert.equal(fromSub.stdout, '');
    // Followed literally, either way out holds the run to the root's count.
    for (const [r, held] of [[inCo(co), 'README states'], [inCo(join(co, 'docs'), String(lines3)), 'expected']]) {
      assert.equal(r.status, 0, `${held}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.includes(`\nSKIP win32: lines: ${lines3}, ${held} ${lines3} — as stated\n`), r.stdout);
    }
    platforms('Windows is untested.', `\n${sentence}\n`);   // after the fence: not the section
    const fromRoot = inCo(co);
    assert.equal(fromRoot.status, 2, fromRoot.stdout + fromRoot.stderr);
    assert.equal(fromRoot.stderr, `${statesNo(join(co, 'README.md'))} — the count this check holds the run to: state it in "Platforms" above its first code fence, or pass the number of \`SKIP win32:\` lines the run should print (--win32-skips <n>)\n`, 'from the root, the root is no way out');
    platforms(sentence);
    assert.equal(inCo(co).status, 0, 'the sentence above the fence is the way out');
    usage(['--compare', join(dir, 'shape.json')], '--compare needs the reference shape and at least one run');
    usage(['--compare', join(dir, 'shape.json'), join(dir, 'nope.json')], `no such file: ${join(dir, 'nope.json')}`);
    const spec = f('spec.tap', '✔ a (1.2ms)\n﹣ b (0.1ms) # a reason\nℹ tests 2\nℹ pass 1\n');
    // The way out is this platform's capture command; either form names the reporter and the file.
    const named = (r, file) => [reportCommand(file, false), reportCommand(file, true)].some((c) => r.stderr.trimEnd().endsWith(c));
    usage([spec], "holds the spec reporter's output, not TAP (Node 23 and later print spec even into a file) — capture it again with the reporter named: ");
    assert.ok(named(run([spec]), spec), 'the spec refusal ends with the capture command');
    // Another reporter's output (dot) keeps the reporter advice: naming it is the way out.
    const dots = f('dot.tap', '....\n..\n');
    usage([dots], 'is not TAP (no "TAP version" line) — capture the run with the reporter named: ');
    assert.ok(named(run([dots]), dots));
    assert.ok(run([spec]).stderr.includes('NODE_OPTIONS=--test-reporter=tap'));
    // A path with a space: the command never hands a shell the path cut at it.
    mkdirSync(join(dir, 'jo doe'));
    const spaced = f(join('jo doe', 'spec.tap'), '✔ a (1.2ms)\nℹ tests 1\n');
    const spacedRun = run([spaced]);
    assert.ok(named(spacedRun, spaced), spacedRun.stderr);
    assert.ok(!spacedRun.stderr.includes(`> ${spaced} `), spacedRun.stderr);

    // A capture in which npm test never started — npm's, node's or a shell's
    // refusal, or nothing at all — prints a block of its own on stdout: an
    // ::error says the tests never started, and the notice gives the block's
    // length for a tail read. A refusal names no reporter (naming one starts
    // nothing): the block shows what it holds, the cause. An empty capture
    // holds no cause: its way out is the capture command, named whole.
    const notStarted = (name, text, shown) => {
      const p = f(name, text);
      const r = run([p, '--win32-skips', '0']);
      assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stderr, '', `${name}: the block is on stdout`);
      const lines = r.stdout.trimEnd().split('\n');
      assert.equal(lines[0], HEAD, name);
      assert.match(lines[1], /^host: /, name);
      assert.deepEqual(lines.filter((l) => l.startsWith('  | ')).map((l) => l.slice(4)), shown, `${name}: what it holds, the cause`);
      const k = Number(/^block: (\d+) lines$/m.exec(r.stdout)?.[1]);
      assert.equal(k, lines.reduce((n, l) => n + logLines(l), 0), `${name}: the block counts every log line it prints`);
      assert.match(r.stdout, /^::error title=npm test printed no TAP::/m, name);
      assert.ok(lines.at(-1).startsWith('::notice title=npm test::no TAP — '), name);
      assert.ok(lines.at(-1).endsWith(`the summary block is ${k} lines; read it with tail_lines ${k + 150}`), name);
      return r.stdout;
    };
    const header = (cmd) => ['', '> observogram@0.0.0 test', `> ${cmd}`, ''];
    // node's own words, from this node: no test file it can find, an option it does not take.
    const nodeSays = (env) => {
      const c = spawnSync(process.execPath, ['--test', 'no-such-test-file.mjs'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
      return `${c.stdout}${c.stderr}`.trimEnd().split(/\r?\n/);
    };
    for (const [name, held] of [
      ['npm-error.tap', ['npm error Missing script: "test"', 'npm error', 'npm error To see a list of scripts, run:', 'npm error   npm run']],
      ['node-missing.tap', [...header('node --test no-such-test-file.mjs'), ...nodeSays({ NODE_OPTIONS: '' })]],
      ['node-option.tap', [...header('node --test no-such-test-file.mjs'), ...nodeSays({ NODE_OPTIONS: '--no-such-option' })]],
      ['sh.tap', [...header('c8 node --test'), 'sh: 1: c8: not found']],
      ['bash.tap', [...header('c8 node --test'), '/usr/bin/bash: line 1: c8: command not found']],
      ['cmd.tap', [...header('c8 node --test'), "'c8' is not recognized as an internal or external command,", 'operable program or batch file.']],
    ]) {
      const block = notStarted(name, `${held.join('\n')}\n`, held);
      assert.ok(block.includes(`${join(dir, name)} holds no TAP: npm test stopped before its tests ran — npm, node or a shell refused to start them.`), block);
      assert.ok(block.includes(`What it holds (${held.length} lines) names the cause: fix it, then run npm test again.`), block);
      assert.ok(!block.includes('--test-reporter'), `${name}: no reporter advice, naming one starts nothing`);
    }
    const one = notStarted('one.tap', 'npm error Missing script: "test"\n', ['npm error Missing script: "test"']);
    assert.ok(one.includes('What it holds (1 line) names the cause: fix it, then run npm test again.') && !one.includes('--test-reporter'), one);
    const empty = notStarted('empty.tap', '', []);
    const emptyLine = (file, cmd) => `${file} is empty: npm test printed nothing into it — capture the run again: ${cmd}`;
    assert.ok([false, true].some((w) => empty.split('\n').includes(emptyLine(join(dir, 'empty.tap'), reportCommand(join(dir, 'empty.tap'), w)))), empty);
    // docs/CHANGELOG.md quotes that line as the block prints it, in either form.
    const changelog = readFileSync(join(ROOT, 'docs', 'CHANGELOG.md'), 'utf8');
    const quoted = /`(<file> is empty: [^`]*<cmd>)`/.exec(changelog)?.[1];
    assert.ok(quoted, 'docs/CHANGELOG.md quotes the line an empty capture prints, `<file> is empty: … <cmd>`');
    for (const [file, w] of [['/home/jo/obs/e.tap', false], ['C:\\obs\\e.tap', true]]) {
      const said = quoted.replace('<file>', () => file).replace('<cmd>', () => reportCommand(file, w));
      assert.ok(notStartedBlock('', { file, windows: w }).text.split('\n').includes(said), `docs/CHANGELOG.md quotes the empty capture's line as the block prints it: ${said}`);
    }
    const many = Array.from({ length: 45 }, (_, i) => `npm error line ${i + 1}`);
    assert.ok(notStarted('long.tap', `${many.join('\n')}\n`, many.slice(-40)).includes('Its last 40 of 45 lines name the cause: fix it, then run npm test again.'), 'a long refusal: its last 40 lines');

    assert.equal(reportCommand('test.tap', false), 'NODE_OPTIONS=--test-reporter=tap npm test > test.tap 2>&1');
    assert.equal(reportCommand('test.tap', true), 'cmd /c "set NODE_OPTIONS=--test-reporter=tap&& npm test > test.tap 2>&1"');
    // The file is one word to the shell that runs the command: sh reads a
    // path it would split or expand single-quoted. No one quoting carries such
    // a path through both cmd and PowerShell (the quotes cmd needs inside its
    // own split PowerShell's argument), so the Windows form captures into
    // test.tap and says so; a drive, a short name and a dot pass as written.
    assert.equal(reportCommand('/home/jo doe/obs/test.tap', false), "NODE_OPTIONS=--test-reporter=tap npm test > '/home/jo doe/obs/test.tap' 2>&1");
    assert.equal(reportCommand("/tmp/it's $HOME;x/t.tap", false), "NODE_OPTIONS=--test-reporter=tap npm test > '/tmp/it'\\''s $HOME;x/t.tap' 2>&1");
    assert.equal(reportCommand('/tmp/tap-summary-Ab1/v1.2_x@y+z=w,q:r/t.tap', false), 'NODE_OPTIONS=--test-reporter=tap npm test > /tmp/tap-summary-Ab1/v1.2_x@y+z=w,q:r/t.tap 2>&1');
    assert.equal(reportCommand('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\tap-summary-Ab1\\t.tap', true), 'cmd /c "set NODE_OPTIONS=--test-reporter=tap&& npm test > C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\tap-summary-Ab1\\t.tap 2>&1"');
    for (const p of ['C:\\Users\\Jo Doe\\obs\\test.tap', 'C:\\obs\\a&b.tap', 'C:\\obs\\100%.tap', 'C:\\obs\\$x.tap', 'C:\\obs\\(1).tap']) {
      assert.equal(reportCommand(p, true), `cmd /c "set NODE_OPTIONS=--test-reporter=tap&& npm test > test.tap 2>&1", then run tap-summary on test.tap: no one quoting of ${p} holds in both cmd and PowerShell`);
    }

    const same = run(['--compare', join(dir, 'shape.json'), join(dir, 'shape.json')]);
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /tests 4 = 4 · harness assertions 3 vs 3 in 1 files · other skips equal \(PID 1: 1 vs 1\) — it ran what the reference ran/);
    assert.match(same.stdout, /^::notice title=windows-vs-linux::/m);
    const differs = run(['--compare', join(dir, 'shape.json'), join(dir, 'red-shape.json')]);
    assert.equal(differs.status, 1);
    assert.match(differs.stdout, /^::error title=\S+ \(node [\d.]+\) vs \S+ \(node [\d.]+\)::tools\/test-journey\.mjs: 2 harness assertions on the run, 3 on the reference, and no SKIP win32: line in the file — an early exit$/m);
    assert.ok(!/::notice/.test(differs.stdout), 'no notice when a run differs');
    // CI passes the floor's shape, then windows-22.16.0's, then windows-22's:
    // each run is held to the reference under its own label, the last too.
    // Here only the last lacks a harness suite the reference ran.
    const both = '"harness":{"tools/test-a.mjs":{"asserts":5,"win32":0},"tools/test-b.mjs":{"asserts":3,"win32":0}}';
    const floor = f('node-floor.json', `{"platform":"linux","node":"v22.16.0","tests":10,"todo":0,"skips":{},${both}}`);
    const win16 = f('windows-22.16.0.json', `{"platform":"win32","node":"v22.16.0","tests":10,"todo":0,"skips":{},${both}}`);
    const win22 = f('windows-22.json', '{"platform":"win32","node":"v22.23.3","tests":10,"todo":0,"skips":{},"harness":{"tools/test-a.mjs":{"asserts":5,"win32":0}}}');
    const last = run(['--compare', floor, win16, win22]);
    assert.equal(last.status, 1, last.stdout + last.stderr);
    const vanished = 'tools/test-b.mjs: a harness suite the reference ran and the run did not report (a file argument that matched nothing, or a suite that never ran)';
    assert.deepEqual(last.stdout.trimEnd().split('\n'), [
      'windows (node 22.16.0) vs linux (node 22.16.0): tests 10 = 10 · harness assertions 8 vs 8 in 2 files · other skips equal (PID 1: 0 vs 0) — it ran what the reference ran',
      'windows (node 22.23.3) vs linux (node 22.16.0): 1 difference — the run did not run what the reference ran',
      `  ${vanished}`,
      `::error title=windows (node 22.23.3) vs linux (node 22.16.0)::${vanished}`,
    ], 'every run held, the last one\'s difference named under its label, and no notice');
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
// What the comment right above a step says it was sized from, in seconds:
// "twice the slowest … measured on the runner (XmYs), <rounding>" and "twice
// the slowest steps before it (XmYs)" (NaN when it says none).
function measured(job, st) {
  const above = job.slice(0, job.indexOf(st)).replace(/\n$/, '').split('\n');
  let i = above.length;
  while (i > 0 && /^ {6}#/.test(above[i - 1])) i--;
  const comment = above.slice(i).map((l) => l.replace(/^ {6}# ?/, '')).join(' ');
  const secs = (re) => { const m = re.exec(comment); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
  const rounding = /twice the slowest [^()]*measured on the runner \(\d+m\d+s\), ([^;.]*)/.exec(comment)?.[1] ?? '';
  return { slowest: secs(/twice the slowest [^()]*measured on the runner \((\d+)m(\d+)s\)/), before: secs(/twice the slowest steps before it \((\d+)m(\d+)s\)/), rounding };
}
// The minutes a stated rounding gives from twice the slowest run (seconds):
// "rounded up" (to the minute), "rounded up to <k> minutes", either with
// "and at least <m>" or ", at least <m>" (NaN for a rounding it does not read).
function roundedUp(rounding, slowest) {
  const m = /^rounded up(?: to (\d+) minutes)?(?: and at least (\d+)|, at least (\d+))?$/.exec(rounding.trim());
  if (!m) return NaN;
  const step = Number(m[1] ?? 1);
  return Math.max(Number(m[2] ?? m[3] ?? 0), Math.ceil((2 * slowest) / (60 * step)) * step);
}
const SUMMARY_IF = "if: ${{ !cancelled() && (steps.test.outcome == 'success' || steps.test.outcome == 'failure') }}";
// A step's keys after its name, as lines (a blank line or a comment is none:
// the comment above the next step is split into this one). A step whose exit
// is its job's verdict is held to all of them, so no shell but the one pinned
// and nothing after its command (`|| true`, `; exit 0`) can drop that exit,
// and no if: but the one pinned can skip the step.
const keysOf = (st) => st.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l)).slice(1);
const keys = (...lines) => lines.map((l) => `        ${l}`);

test('S10 the workflow wires it: a Windows matrix on the floor and the latest 22 that runs the documented report command, npm test through tee under pipefail with a step timeout, and the summary held to README; windows and node-floor end with the summary and the shape upload, validate with the summary; windows-vs-linux compares the shapes', () => {
  const text = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = workflowJobs(text);
  assert.ok(text.includes('# Validates every push to develop/main and every PR into develop or main.'));
  const on = text.slice(text.indexOf('\non:\n') + 1, text.indexOf('\n\n', text.indexOf('\non:\n')));
  assert.equal(on, 'on:\n  push:\n    branches: [develop, main]\n  pull_request:\n    branches: [main, develop]\n  workflow_dispatch:', 'every PR and every push to develop/main, no path filter');
  for (const name of ['validate', 'node-floor', 'windows', 'windows-vs-linux']) assert.ok(jobs[name] && !/^ {4}if:/m.test(jobs[name]), `${name}: no job condition — it runs on every PR and push`);
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
  // Whole, as the suites step: the documented command on one suite, each
  // native exit checked by hand, the summary's exit the step's, and no if:
  // of its own, so the report command is checked on every PR and push.
  assert.deepEqual(keysOf(report[0]), keys('shell: powershell', 'run: |',
    `  ${reportCommand('test.tap', true).replace('npm test', 'npm run test:platform')}`,
    '  if ($LASTEXITCODE) { Get-Content test.tap -Tail 40; exit $LASTEXITCODE }',
    '  node tools/tap-summary.mjs test.tap --win32-skips 0',
    '  $code = $LASTEXITCODE; Remove-Item test.tap; exit $code'));
  // …documented as tap-summary names it: docs/DOWNSTREAM.md §13 from cmd or PowerShell, and from Git Bash.
  const downstream = readFileSync(join(ROOT, 'docs', 'DOWNSTREAM.md'), 'utf8');
  for (const [fence, onWindows] of [['```', true], ['```sh', false]]) {
    const block = `\n${fence}\n${reportCommand('test.tap', onWindows)}\nnode tools/tap-summary.mjs test.tap --win32-skips readme\n\`\`\`\n`;
    assert.ok(downstream.includes(block), `docs/DOWNSTREAM.md gives the report command tap-summary names:${block}`);
  }
  const wTest = stepNamed(w, /id: test\n/);
  assert.equal(wTest.length, 1);
  assert.deepEqual(keysOf(wTest[0]), keys('id: test', `timeout-minutes: ${minutes(wTest[0])}`, 'run: npm test 2>&1 | tee "$RUNNER_TEMP/test.tap"'));
  assert.ok(stepsOf(w).indexOf(report[0]) < stepsOf(w).indexOf(wTest[0]), 'the report command runs first');
  assert.ok(minutes(wTest[0]) < jobMinutes(w), `the step timeout (${minutes(wTest[0])}) under the job's (${jobMinutes(w)}), so the summary runs on a hang`);
  const wSum = stepNamed(w, /id: summary\n/);
  assert.equal(wSum.length, 1);
  assert.deepEqual(keysOf(wSum[0]), keys('id: summary', SUMMARY_IF, 'run: node tools/tap-summary.mjs "$RUNNER_TEMP/test.tap" --win32-skips readme --shape "$RUNNER_TEMP/run-shape.json"'));
  const wUp = stepNamed(w, /upload-artifact/);
  assert.equal(wUp.length, 1);
  assert.ok(wUp[0].includes('name: run-shape-windows-${{ matrix.node }}') && /overwrite: true/.test(wUp[0]) && wUp[0].includes("if: ${{ !cancelled() && steps.summary.outcome == 'success' }}"));

  const f = jobs['node-floor'];
  const fTest = stepNamed(f, /id: test\n/);
  assert.equal(fTest.length, 1);
  assert.match(fTest[0], /^ {8}shell: bash$/m, 'pipefail: GitHub\'s implicit Linux shell has none');
  assert.deepEqual(keysOf(fTest[0]), keys('id: test', 'shell: bash', `timeout-minutes: ${minutes(fTest[0])}`, 'run: npm test 2>&1 | tee "$RUNNER_TEMP/test.tap"'));
  assert.ok(minutes(fTest[0]) < jobMinutes(f), 'the step timeout under the job\'s');
  const fSum = stepNamed(f, /id: summary\n/);
  assert.deepEqual(keysOf(fSum[0]), keys('id: summary', SUMMARY_IF, 'run: node tools/tap-summary.mjs "$RUNNER_TEMP/test.tap" --win32-skips 0 --shape "$RUNNER_TEMP/run-shape.json"'));
  const fUp = stepNamed(f, /upload-artifact/);
  assert.equal(fUp.length, 1);
  assert.ok(fUp[0].includes('name: run-shape-node-floor') && /overwrite: true/.test(fUp[0]));
  // The summary, then the shape upload, end the job: a step after the
  // summary that prints on a red run pushes the block past the log's tail.
  for (const [name, job, sum, up] of [['windows', w, wSum[0], wUp[0]], ['node-floor', f, fSum[0], fUp[0]]]) {
    const s = stepsOf(job);
    assert.deepEqual([s.indexOf(sum), s.indexOf(up)], [s.length - 2, s.length - 1], `${name}: the summary, then the shape upload, are its last steps — nothing else prints after the summary`);
  }

  const v = jobs.validate;
  const vTest = stepNamed(v, /id: test\n/);
  assert.equal(vTest.length, 1);
  assert.match(vTest[0], /^ {8}shell: bash$/m);
  assert.deepEqual(keysOf(vTest[0]), keys('id: test', 'shell: bash', `timeout-minutes: ${minutes(vTest[0])}`, 'run: npm run coverage 2>&1 | tee "$RUNNER_TEMP/test.tap"'));
  assert.ok(minutes(vTest[0]) < jobMinutes(v), 'the step timeout under the job\'s');
  // A measured step timeout is at least twice the slowest run its comment
  // names, so a slow runner's green run never reads red; validate's job adds
  // twice the slowest steps before the suites, so the summary runs on a hang.
  for (const [name, job, st] of [['windows', w, wTest[0]], ['validate', v, vTest[0]]]) {
    const { slowest, rounding } = measured(job, st);
    assert.ok(slowest > 0, `${name}: the comment above the suites step names the slowest run it is sized from ("twice the slowest … measured on the runner (XmYs)")`);
    assert.ok(minutes(st) * 60 >= 2 * slowest, `${name}: the step timeout (${minutes(st)} min) is at least twice the slowest run measured on the runner (${slowest} s)`);
    assert.equal(roundedUp(rounding, slowest), minutes(st), `${name}: the step timeout (${minutes(st)} min) is what its comment's rounding ("${rounding}") gives from twice ${slowest} s`);
  }
  // …and a timeout docs/CHANGELOG.md derives from a measured run ("<N>
  // minutes: twice … measured on the runner, XmYs, <rounding>") is the N its
  // rounding gives: "rounded up" alone never turns twice 3m39s into 15.
  const changelog = readFileSync(join(ROOT, 'docs', 'CHANGELOG.md'), 'utf8');
  const derived = [...changelog.matchAll(/\((\d+) minutes: twice [^()]*?measured on the runner, (\d+)m(\d+)s, ([^;)]*)[;)]/g)];
  assert.ok(derived.length > 0, 'docs/CHANGELOG.md derives a step timeout from a run measured on the runner');
  for (const [said, n, mm, ss, rounding] of derived) {
    const slowest = Number(mm) * 60 + Number(ss);
    assert.equal(roundedUp(rounding, slowest), Number(n), `docs/CHANGELOG.md: "${said}" — twice ${mm}m${ss}s, ${rounding}, gives ${roundedUp(rounding, slowest)} minutes, not ${n}; state the rounding that gives ${n}`);
  }
  const { before } = measured(v, vTest[0]);
  assert.ok(before > 0, 'validate: the comment above the suites step names the slowest steps before it ("twice the slowest steps before it (XmYs)")');
  assert.ok(jobMinutes(v) * 60 >= minutes(vTest[0]) * 60 + 2 * before, `validate: the job's timeout (${jobMinutes(v)} min) is the step's (${minutes(vTest[0])}) plus at least twice the slowest steps before it (${before} s)`);
  const vSteps = stepsOf(v);
  assert.match(vSteps[vSteps.length - 1], /^ {6}- name: Test summary \(the end of this log\)$/m, 'validate ends with the summary');
  assert.deepEqual(keysOf(vSteps[vSteps.length - 1]), keys(SUMMARY_IF, 'run: node tools/tap-summary.mjs "$RUNNER_TEMP/test.tap" --win32-skips 0'));

  const c = jobs['windows-vs-linux'];
  assert.match(c, /^ {4}needs: \[node-floor, windows\]$/m);
  assert.ok(c.includes('uses: actions/download-artifact@v8') && c.includes('pattern: run-shape-*'));
  const cmp = stepNamed(c, /tap-summary\.mjs --compare/);
  assert.equal(cmp.length, 1);
  assert.deepEqual(keysOf(cmp[0]), keys('run: >-', '  node tools/tap-summary.mjs --compare', ...['node-floor', 'windows-22.16.0', 'windows-22'].map((n) => `  "$RUNNER_TEMP/shapes/run-shape-${n}/run-shape.json"`)));

  // Every piped run is under pipefail; no suites step names the reporter (Node 22 prints TAP into a pipe).
  for (const [name, job] of Object.entries(jobs)) {
    for (const st of stepsOf(job)) {
      // Its own `shell: bash`, or no shell of its own and the job's (`sh` or `bash -e {0}` has no pipefail).
      const own = /^ {8}shell: (.*)$/m.exec(st)?.[1];
      if (/\| tee /.test(st)) assert.ok(own === 'bash' || (own === undefined && /^ {4}defaults:\n {6}run:\n {8}shell: bash$/m.test(job)), `${name}: a piped step runs under bash -eo pipefail`);
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
