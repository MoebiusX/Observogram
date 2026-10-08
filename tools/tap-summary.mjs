// tools/tap-summary.mjs — the end of a CI log for a `node --test` run.
//
// CI's log API returns only the last lines of a job's log, so a red run must
// say what failed at the END of it. This reads the TAP a `node --test` run
// printed (Node 22 prints TAP into a pipe or a file; Node 23 and later print
// the spec reporter there unless the reporter is named) and prints one
// bounded block: the host, the totals, the skip lines by reason, every
// failure with its place and error (a harness suite's ✗ lines), the timing
// bounds the suites print (`bound:` lines, nearest its limit first) and the
// slowest tests; then workflow-command annotations, the run-level errors
// first, and a notice naming the block's length so a reader asks for exactly
// enough of the log's tail. It holds the run to the number of `SKIP win32:`
// lines README "Platforms" states (--win32-skips readme), and it writes the
// run's shape (--shape), which --compare holds to a reference run's: the
// same tests, the same harness assertions per file (fewer only under a
// counted win32 skip), the same skip reasons.
//
//   node tools/tap-summary.mjs <tap-file> [--win32-skips readme|<n>] [--max-failures <n>] [--shape <out.json>]
//   node tools/tap-summary.mjs --compare <reference.json> <run.json>...
//
// Exit 0 when the totals are present, nothing failed, was cancelled or is a
// todo, every skip reason is a `win32: …` one or on KNOWN_SKIPS, and the
// count is the expected one; exit 1 otherwise; exit 2 for a usage error or a
// file that is not TAP. It reads the file and README.md and probes whether
// this host can create a symlink; it runs nothing.
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { arch, availableParallelism, release, tmpdir } from 'node:os';
import path, { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** README "Platforms" states the count as "<N> `SKIP win32:` lines". */
export const README_WIN32_LINES_RE = /(\d+) `SKIP win32:` lines/;

const HEAD = '==================== npm test summary ====================';
const RULE = '='.repeat(HEAD.length);
const TAIL_SLACK = 150;        // the log lines below the block: the shape upload and the post-job cleanup
const MAX_ANNOTATIONS = 10;    // GitHub keeps 10 error annotations per step
const MAX_ERROR_LINES = 25;
const MAX_ANNOTATION_LINES = 12;
const MAX_BOUNDS = 12;
const MAX_SLOWEST = 10;
const LAST_LINES = 40;         // an unfinished run's tail
const HARNESS_FALLBACK = 12;   // a harness failure without ✗ lines: its last diagnostics

/**
 * The skip reasons that are not `win32: …` and that some environment prints
 * by design, each with the probe that fires it. Any other reason fails the
 * run: a skip nobody expects is a test that silently stopped running.
 */
export const KNOWN_SKIPS = Object.freeze([
  Object.freeze({ pattern: /^cannot import .+?: /, probe: 'the seven browser suites without Playwright (server/test-brand-shell.mjs and six more; OBSERVOGRAM_PLAYWRIGHT unset, no playwright package)' }),
  Object.freeze({ pattern: /^chromium\.launch failed: /, probe: 'the same browser suites with Playwright but no browser' }),
  Object.freeze({ pattern: 'unshare --pid is unavailable here', probe: 'server/test-store.mjs, the PID 1 test: off Linux, or where user namespaces are refused' }),
  Object.freeze({ pattern: /^cannot run .+ as an unprivileged user on this checkout: /, probe: 'server/test-store-import.mjs, the unreadable-file case: Linux as root only' }),
]);
const PID1_REASON = 'unshare --pid is unavailable here';

/** Whether a (TAP-unescaped) skip reason is a win32 one or on KNOWN_SKIPS. */
export function isExpectedSkip(reason) {
  if (reason.startsWith('win32: ')) return true;
  return KNOWN_SKIPS.some(({ pattern }) => (typeof pattern === 'string' ? reason === pattern : pattern.test(reason)));
}

/**
 * The grouping key of a skip reason: the browser suites' importer-specific
 * reasons (`cannot import <spec>: Cannot find package 'playwright' imported
 * from <the suite's path>`) collapse to one line.
 */
export function skipGroup(reason) {
  return String(reason)
    .replace(/^cannot import .+?: /, 'cannot import <playwright>: ')
    .replace(/ imported from .*$/, ' imported from <a suite>');
}

/** TAP escapes `\` and `#` in names, directives, reasons and diagnostics. */
export function unescapeTap(s) {
  return String(s).replace(/\\([\\#])/g, '$1');
}

/** The capture command a report needs: the reporter named, so Node 23 and later print TAP too. */
export function reportCommand(file, windows) {
  return windows
    ? `cmd /c "set NODE_OPTIONS=--test-reporter=tap&& npm test > ${file} 2>&1"`
    : `NODE_OPTIONS=--test-reporter=tap npm test > ${file} 2>&1`;
}

// The mojibake a console code page makes of ✓, ✗ and — (CP437, then CP1252),
// and the replacement character.
const MANGLED_RE = /\uFFFD|Γ£ô|Γ£ù|ΓÇö|âœ“|âœ—|â€”/;

/**
 * The bytes of a captured run as text: a UTF-16LE byte-order mark (Windows
 * PowerShell 5.1's `>`) is decoded as UTF-16, a UTF-8 one is stripped, CRLF
 * becomes LF. `mangled` says the capture went through a console code page.
 */
export function decodeTap(bytes) {
  const b = Buffer.from(bytes);
  let text;
  if (b[0] === 0xff && b[1] === 0xfe) text = b.subarray(2).toString('utf16le');
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) text = b.subarray(3).toString('utf8');
  else text = b.toString('utf8');
  text = text.replace(/\r\n/g, '\n');
  return { text, mangled: MANGLED_RE.test(text) };
}

/** The count README "Platforms" states (P6's slice: up to the first fence), or null. */
export function readmeWin32Lines(readmeText) {
  const text = String(readmeText);
  const at = text.indexOf('### Platforms');
  if (at < 0) return null;
  const end = text.indexOf('\n```', at);
  const m = README_WIN32_LINES_RE.exec(text.slice(at, end < 0 ? text.length : end));
  return m ? Number(m[1]) : null;
}

// ---------- parsing ----------

const POINT_RE = /^( *)(ok|not ok) (\d+)(.*)$/;
const TOTAL_RE = /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) (\d+(?:\.\d+)?)$/;
const WIN32_POINT_RE = /^ *ok \d+ - .* # SKIP win32: /;
const WIN32_HARNESS_RE = /^ *# - SKIP win32: /;
const BOUND_LINE_RE = /^\s*# bound: /;
const BOUND_RE = /^\s*# bound: (.+): (\d+) ms (<|>=) (\d+) ms(?: of a (\d+) ms hold)?$/;
const HARNESS_NAME_RE = /^\S+\.[cm]?js$/;

// A YAML scalar as Node's TAP reporter prints it: util.inspect's quoting for
// a one-line string (so a Windows path arrives with doubled backslashes).
function yamlScalar(v) {
  const m = /^(['"`])([\s\S]*)\1$/.exec(v);
  if (!m) return v === '~' ? null : v;
  return m[2].replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|([\s\S]))/g, (_, x, u1, u2, c) => {
    if (x) return String.fromCharCode(parseInt(x, 16));
    if (u1 || u2) return String.fromCodePoint(parseInt(u1 || u2, 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[c] ?? c;
  });
}

// A point's text after the number: ` - <name>[ # SKIP|TODO <reason>]`. The
// directive's `#` is the one TAP leaves unescaped (a name's is `\#`), so it
// is found on the raw text before anything is unescaped.
function splitDirective(rest) {
  const body = rest.startsWith(' - ') ? rest.slice(3) : rest.replace(/^ /, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { i++; continue; }
    if (body[i] !== '#' || (i > 0 && body[i - 1] !== ' ')) continue;
    const m = /^# (SKIP|TODO)\b ?(.*)$/i.exec(body.slice(i));
    if (m) return { name: body.slice(0, Math.max(0, i - 1)), directive: m[1].toUpperCase(), reason: m[2] };
  }
  return { name: body, directive: null, reason: null };
}

function parseBound(raw) {
  const m = BOUND_RE.exec(raw);
  const text = unescapeTap(raw.replace(/^\s*# /, ''));
  if (!m) return { unreadable: true, text };
  const [, label, measured, op, limit, hold] = m;
  const b = { label: unescapeTap(label), measured: Number(measured), op, limit: Number(limit), hold: hold === undefined ? null : Number(hold), text };
  if (op === '<') {
    b.nearness = b.limit > 0 ? b.measured / b.limit : Infinity;
    b.pastHalf = b.measured > b.limit / 2;
  } else if (b.hold !== null) {
    // The slack is what the hold leaves above the floor; the bound is near its
    // limit when the run consumed much of it (hold − measured).
    const slack = b.hold - b.limit;
    const consumed = Math.max(0, b.hold - b.measured);
    b.nearness = slack > 0 ? consumed / slack : (b.measured >= b.limit ? 0 : Infinity);
    b.pastHalf = consumed > slack / 2;
  } else {
    b.nearness = b.measured > 0 ? b.limit / b.measured : Infinity;
    b.pastHalf = false;
  }
  return b;
}

/**
 * Parse a run's TAP. Returns { points, totals, win32, complete, bounds,
 * mangled, harnessSkips, lines }. Each point carries depth, ok, n, name,
 * directive and reason (all TAP-unescaped), its YAML block, and — at the top
 * level — `diag`, the diagnostics printed since the previous top-level point
 * (a harness suite's whole output, which precedes its point).
 */
export function parseTap(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const points = [];
  const bounds = [];
  const harnessSkips = [];
  let totals = {};
  let totalsOpen = false;
  let win32 = 0;
  let diag = [];
  const pendingSkips = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const total = TOTAL_RE.exec(l);
    if (total) {
      if (!totalsOpen) totals = {};
      totalsOpen = true;
      totals[total[1]] = Number(total[2]);
      continue;
    }
    totalsOpen = false;
    if (WIN32_POINT_RE.test(l) || WIN32_HARNESS_RE.test(l)) win32++;
    if (BOUND_LINE_RE.test(l)) bounds.push(parseBound(l));
    const m = POINT_RE.exec(l);
    if (!m) {
      if (l.startsWith('# ') && !l.startsWith('# Subtest: ')) {
        const d = unescapeTap(l.slice(2));
        diag.push(d);
        const skip = /^- SKIP (.*)$/.exec(d);
        if (skip) pendingSkips.push(skip[1]);
      }
      continue;
    }
    totals = {};
    const depth = Math.floor(m[1].length / 4);
    const { name, directive, reason } = splitDirective(m[4]);
    const p = { depth, ok: m[2] === 'ok', n: Number(m[3]), name: unescapeTap(name), directive, reason: reason === null ? null : unescapeTap(reason), yaml: {}, line: i + 1 };
    // The YAML block: `<indent>  ---` … `<indent>  ...`, keys at <indent>+2,
    // a block scalar's lines at <indent>+4. Consumed here, so nothing inside
    // it (an error quoting a TAP line) is read as TAP.
    const ind = `${m[1]}  `;
    if (lines[i + 1] === `${ind}---`) {
      let j = i + 2;
      let key = null;
      const raw = {};
      for (; j < lines.length && lines[j] !== `${ind}...`; j++) {
        const s = lines[j].startsWith(ind) ? lines[j].slice(ind.length) : lines[j].trimStart();
        const kv = /^([A-Za-z_][\w-]*):(?: (.*))?$/.exec(s);
        if (kv && !s.startsWith(' ')) { key = kv[1]; raw[key] = { head: kv[2] ?? '', body: [] }; }
        else if (key) raw[key].body.push(s.replace(/^ {2}/, ''));
      }
      for (const [k, { head, body }] of Object.entries(raw)) {
        p.yaml[k] = head === '|-' || head === '|' || head === '' ? body.join('\n') : yamlScalar(head);
      }
      i = j;
    }
    if (depth === 0) {
      p.diag = diag;
      for (const r of pendingSkips) harnessSkips.push({ reason: r, test: p.name });
      pendingSkips.length = 0;
      diag = [];
    }
    points.push(p);
  }
  for (const r of pendingSkips) harnessSkips.push({ reason: r, test: '(after the last test)' });
  const complete = 'tests' in totals;
  return { points, totals: complete ? totals : {}, win32, complete, bounds, mangled: MANGLED_RE.test(text), harnessSkips, lines };
}

// ---------- places ----------

function placeOf(spec, { root, pathApi }) {
  let p = String(spec).trim();
  if (!p || p.startsWith('node:')) return null;
  const windows = pathApi.sep === '\\';
  if (/^file:/i.test(p)) {
    try { p = fileURLToPath(p, { windows }); } catch { return null; }
  }
  if (!pathApi.isAbsolute(p)) return p.split(pathApi.sep).join('/');
  const r = pathApi.relative(root, p);
  if (r && !r.startsWith('..') && !pathApi.isAbsolute(r)) return r.split(pathApi.sep).join('/');
  return p.split(pathApi.sep).join('/');
}

/**
 * Where a failure is: the first stack frame inside the failing test's own
 * file, else its `location:` — repo-relative with `/`, from a POSIX path, a
 * Windows path, a file: URL, or a root spelled with another drive-letter
 * case. `pathApi` is node:path, path.posix or path.win32.
 */
export function whereOf(point, { root = process.cwd(), pathApi = path } = {}) {
  const yaml = point.yaml || {};
  const windows = pathApi.sep === '\\';
  const loc = /^(.*):(\d+):(\d+)$/.exec(yaml.location || '');
  const own = loc ? placeOf(loc[1], { root, pathApi }) : null;
  const same = (a, b) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (own) {
    for (const frame of String(yaml.stack || '').split('\n')) {
      const m = /\(([^()]*):(\d+):(\d+)\)\s*$/.exec(frame) || /^\s*(?:at\s+)?([^\s()][^()]*?):(\d+):(\d+)\s*$/.exec(frame);
      if (!m) continue;
      const f = placeOf(m[1], { root, pathApi });
      if (f && same(f, own)) return { file: own, line: Number(m[2]) };
    }
  }
  return { file: own, line: loc ? Number(loc[2]) : null };
}

// ---------- what the block reads ----------

const isHarnessPoint = (p) => p.depth === 0 && HARNESS_NAME_RE.test(p.name);
const isHarnessFailure = (p) => isHarnessPoint(p) && p.yaml.error === 'test failed';
const harnessName = (name) => name.split('\\').join('/');

/** The failing leaves: a parent failing because a subtest failed adds nothing. */
function failingLeaves(parsed) {
  return parsed.points.filter((p) => !p.ok && p.directive !== 'TODO' && p.yaml.failureType !== 'subtestsFailed');
}

/** Every skip line: TAP skip points at any depth and the harness `- SKIP …` lines. */
function skipLines(parsed) {
  const out = [];
  for (const p of parsed.points) if (p.directive === 'SKIP') out.push({ reason: p.reason ?? '', test: p.name, harness: false });
  for (const s of parsed.harnessSkips) out.push({ reason: s.reason, test: s.test, harness: true });
  return out;
}

const groupKey = (s) => `${skipGroup(s.reason)}${s.harness ? ' (harness)' : ''}`;

// A harness failure's causes: each ✗ line and the deeper-indented got/want
// lines under it, from the diagnostics since the previous top-level point;
// with no ✗ line (a crash, or a capture that mangled the marker), the last
// diagnostics.
function harnessCauses(p) {
  const d = p.diag || [];
  const keep = [];
  for (let i = 0; i < d.length; i++) {
    const m = /^(\s*)✗ /.exec(d[i]);
    if (!m) continue;
    keep.push(d[i]);
    for (let j = i + 1; j < d.length; j++) {
      const lead = /^(\s*)/.exec(d[j])[1].length;
      if (lead <= m[1].length || /^\s*[✓✗] /.test(d[j])) break;
      keep.push(d[j]);
    }
  }
  return keep.length ? keep : d.slice(-HARNESS_FALLBACK);
}

function failureBody(p) {
  if (isHarnessFailure(p)) return harnessCauses(p);
  const e = p.yaml.error ?? (p.yaml.failureType ? `(${p.yaml.failureType}, no error text)` : '(no error text)');
  const lines = String(e).split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/** One workflow command: `::kind k=v,…::message`, escaped as the runner reads it. */
export function annotation(kind, props, message) {
  const data = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  const p = Object.entries(props || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${prop(v)}`).join(',');
  return `::${kind}${p ? ` ${p}` : ''}::${data(message)}`;
}

/** The log lines a printed line takes: a workflow command's %0A is a line break in the log. */
export const logLines = (line) => 1 + (line.startsWith('::') ? (line.match(/%0A/g) || []).length : 0);

const fmtTotal = (v) => (v === undefined ? '?' : String(v));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The block, the annotations and the verdict. `expectWin32` is the number of
 * `SKIP win32:` lines the run must print (null: not held), `countSource`
 * names where it came from ('README' for README "Platforms"), `windows`
 * picks the capture command a warning names, `host` is the host line.
 * Returns { text, ok, failures, lines, parsed }; `lines` is the log lines
 * the text takes once the runner renders its annotations (logLines).
 */
export function summarize(text, { root = process.cwd(), expectWin32 = null, countSource = null, maxFailures = 40, pathApi = path, windows = false, host = null, file = 'test.tap' } = {}) {
  const parsed = parseTap(text);
  const t = parsed.totals;
  const out = [HEAD];
  if (host) out.push(host);
  if (parsed.mangled) out.push(`warning: ${file} went through a console code page (✗ arrives as Γ£ù) — the failure causes may be cut; capture it with: ${reportCommand(file, windows)}`);
  out.push(`tests ${fmtTotal(t.tests)} · pass ${fmtTotal(t.pass)} · fail ${fmtTotal(t.fail)} · skipped ${fmtTotal(t.skipped)} · todo ${fmtTotal(t.todo)} · cancelled ${fmtTotal(t.cancelled)} · ${t.duration_ms === undefined ? '?' : Math.round(t.duration_ms / 1000)} s`);
  if (!parsed.complete) {
    out.push('The TAP ends without its totals: the run did not finish (a step timeout, a crash or a cancel).');
    out.push(`Its last ${LAST_LINES} lines follow; the last test point in them is the last test reported before the run stopped`);
    out.push('(node --test reports a file\'s tests when the file ends, so the file still running may not be named).');
    let tail = parsed.lines;
    while (tail.length && tail[tail.length - 1] === '') tail = tail.slice(0, -1);
    for (const l of tail.slice(-LAST_LINES)) out.push(`  | ${l}`);
  }

  // Skips: grouped by reason, the count, the unknown reasons.
  const skips = skipLines(parsed);
  const groups = new Map();
  for (const s of skips) groups.set(groupKey(s), (groups.get(groupKey(s)) || 0) + 1);
  out.push(`skip lines by reason (${skips.length}):`);
  for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) out.push(`  ${String(n).padStart(4)} × ${cut(k, 240)}`);
  const countOk = expectWin32 === null || parsed.win32 === expectWin32;
  const stated = countSource ? `${countSource} states ${expectWin32}` : `expected ${expectWin32}`;
  if (expectWin32 === null) out.push(`SKIP win32: lines: ${parsed.win32} (no count held)`);
  else out.push(`SKIP win32: lines: ${parsed.win32}, ${stated} — ${countOk ? 'as stated' : 'NOT the stated number: a run prints exactly that many, every one with its reason'}`);
  const unknown = skips.filter((s) => !isExpectedSkip(s.reason));
  const todo = t.todo ?? parsed.points.filter((p) => p.directive === 'TODO').length;
  if (!unknown.length) out.push(`every other skip reason is a known one · todo ${todo}`);
  for (const s of unknown) out.push(`a skip reason no run expects: '${cut(s.reason, 300)}' (${cut(s.test, 200)}) — if this environment cannot run it by design, add its pattern and probe to KNOWN_SKIPS in tools/tap-summary.mjs; otherwise make the test run`);
  if (unknown.length && todo) out.push(`todo ${todo}`);
  for (const p of parsed.points.filter((x) => x.directive === 'TODO')) out.push(`a todo test: '${cut(p.name, 200)}'${p.reason ? ` (${cut(p.reason, 200)})` : ''} — a todo is not a pass: finish it or remove it`);

  // Failures.
  const fails = failingLeaves(parsed);
  const failures = fails.map((p) => ({ name: p.name, ...whereOf(p, { root, pathApi }), body: failureBody(p) }));
  if (!failures.length) out.push('failures: none');
  else out.push(`failures (${failures.length}${failures.length > maxFailures ? `, the first ${maxFailures} shown` : ''}):`);
  for (const f of failures.slice(0, maxFailures)) {
    const p = fails[failures.indexOf(f)];
    out.push(`--- not ok ${p.n} - ${cut(f.name, 300)}`);
    out.push(`    at ${f.file ?? '(no location)'}${f.line ? `:${f.line}` : ''}`);
    for (const l of f.body.slice(0, MAX_ERROR_LINES)) out.push(`    ${cut(l, 500)}`);
    if (f.body.length > MAX_ERROR_LINES) out.push(`    … ${f.body.length - MAX_ERROR_LINES} more line(s)`);
  }

  // Timing bounds, nearest its limit first.
  const readable = parsed.bounds.filter((b) => !b.unreadable).sort((a, b) => b.nearness - a.nearness);
  const unreadable = parsed.bounds.filter((b) => b.unreadable);
  if (!parsed.bounds.length) out.push('timing bounds: none printed');
  else out.push(`timing bounds (${readable.length}, nearest its limit first${readable.length > MAX_BOUNDS ? `, the first ${MAX_BOUNDS} shown` : ''}${unreadable.length ? `; ${unreadable.length} unreadable` : ''}):`);
  for (const b of readable.slice(0, MAX_BOUNDS)) {
    const pct = Number.isFinite(b.nearness) ? `${Math.round(b.nearness * 100)}%` : '∞';
    const limit = `${b.op} ${b.limit} ms${b.hold !== null ? ` (${b.hold} ms hold)` : ''}`;
    out.push(`  ${String(b.measured).padStart(6)} ms of ${limit}  ${pct.padStart(4)}  ${cut(b.label, 200)}${b.pastHalf ? '  ← past half' : ''}`);
  }
  for (const b of unreadable) out.push(`  unreadable: ${cut(b.text, 300)}`);

  // The slowest top-level points: a node:test file's tests are separate
  // points, a harness suite is one point named by its file.
  const timed = parsed.points.filter((p) => p.depth === 0 && p.yaml.duration_ms !== undefined).sort((a, b) => Number(b.yaml.duration_ms) - Number(a.yaml.duration_ms));
  if (timed.length) out.push('slowest top-level tests and harness suites:');
  for (const p of timed.slice(0, MAX_SLOWEST)) out.push(`  ${(Number(p.yaml.duration_ms) / 1000).toFixed(1).padStart(6)} s  ${cut(isHarnessPoint(p) ? harnessName(p.name) : p.name, 200)}`);

  // Annotations: the run-level errors first, then failures up to the cap.
  const runLevel = [];
  if (!countOk) runLevel.push(annotation('error', { title: 'SKIP win32 count' }, `the run printed ${parsed.win32} SKIP win32: lines, ${countSource ? `${countSource === 'README' ? 'README "Platforms"' : countSource} states` : 'expected'} ${expectWin32}`));
  if (!parsed.complete) runLevel.push(annotation('error', { title: 'npm test did not finish' }, `the TAP ends without its totals (a step timeout, a crash or a cancel) — the summary block shows its last ${LAST_LINES} lines`));
  if (unknown.length) runLevel.push(annotation('error', { title: 'unknown skip reason' }, `a skip reason no run expects: '${cut(unknown[0].reason, 300)}' (${cut(unknown[0].test, 200)})${unknown.length > 1 ? ` and ${unknown.length - 1} more` : ''} — add its pattern and probe to KNOWN_SKIPS in tools/tap-summary.mjs, or make the test run`));
  if (todo) runLevel.push(annotation('error', { title: 'todo' }, `${todo} todo test(s) — a todo is not a pass`));
  const failureNotes = failures.slice(0, Math.max(0, MAX_ANNOTATIONS - runLevel.length)).map((f) =>
    annotation('error', { file: f.file && !/^([A-Za-z]:)?\//.test(f.file) ? f.file : undefined, line: f.line, title: cut(f.name, 200) }, f.body.slice(0, MAX_ANNOTATION_LINES).join('\n')));
  const annotations = [...runLevel, ...failureNotes];

  // The block states its own length in log lines — every line printed, the
  // annotations and the notice included — so a reader of the log's tail asks
  // for enough. The runner writes an annotation's %0A as a line break inside
  // its log line, and the log API's tail counts those breaks as lines.
  const count = out.length + 2 + annotations.reduce((n, a) => n + logLines(a), 0) + 1;   // + "block:" + the rule, + the notice
  out.push(`block: ${count} lines`);
  out.push(RULE);
  out.push(...annotations);
  const win32Note = expectWin32 === null ? `win32 ${parsed.win32}` : `win32 ${parsed.win32}/${expectWin32}`;
  out.push(annotation('notice', { title: 'npm test' }, `tests ${fmtTotal(t.tests)} pass ${fmtTotal(t.pass)} fail ${fmtTotal(t.fail)} skipped ${fmtTotal(t.skipped)} (${win32Note}) — the summary block is ${count} lines; read it with tail_lines ${count + TAIL_SLACK}`));

  const ok = parsed.complete && t.fail === 0 && t.cancelled === 0 && t.todo === 0 && fails.length === 0 && unknown.length === 0 && countOk;
  return { text: out.join('\n'), ok, failures, lines: count, parsed };
}

// ---------- the run's shape and the cross-leg check ----------

/**
 * The run's shape: its totals, its skips by grouped reason, and per harness
 * suite the ✓ assertions it printed and its `- SKIP win32:` lines. `meta`
 * (node, platform) is merged in.
 */
export function runShape(parsed, meta = {}) {
  const t = parsed.totals;
  const skips = {};
  for (const s of skipLines(parsed)) skips[groupKey(s)] = (skips[groupKey(s)] || 0) + 1;
  const harness = {};
  for (const p of parsed.points) {
    if (!isHarnessPoint(p)) continue;
    const d = p.diag || [];
    harness[harnessName(p.name)] = { asserts: d.filter((l) => /^\s*✓ /.test(l)).length, win32: d.filter((l) => l.startsWith('- SKIP win32: ')).length };
  }
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return {
    ...meta,
    tests: t.tests ?? null, pass: t.pass ?? null, fail: t.fail ?? null, skipped: t.skipped ?? null, todo: t.todo ?? null, cancelled: t.cancelled ?? null,
    win32: parsed.win32, skips: sorted(skips), harness: sorted(harness),
  };
}

const shapeLabel = (s) => `${s.platform === 'win32' ? 'windows' : (s.platform ?? 'a run')} (node ${String(s.node ?? '?').replace(/^v/, '')})`;
const thousands = (n) => n.toLocaleString('en-US');

/**
 * Hold a run's shape to the reference's: the same tests; todo 0 on both; the
 * same harness suites, each with the reference's assertions (fewer only in a
 * file that printed a `- SKIP win32:` line, never more); every non-win32 skip
 * reason the same count (the PID 1 one may be 1 on the run and 0 on the
 * reference). Returns { ok, differences, line }.
 */
export function compareShapes(reference, run) {
  const diffs = [];
  const label = `${shapeLabel(run)} vs ${shapeLabel(reference)}`;
  if (run.tests !== reference.tests) diffs.push(`tests ${run.tests} on the run, ${reference.tests} on the reference — a test file or a test ran on one side only`);
  if (run.todo) diffs.push(`todo ${run.todo} on the run — a todo is not a pass`);
  if (reference.todo) diffs.push(`todo ${reference.todo} on the reference — a todo is not a pass`);
  const rh = reference.harness || {};
  const wh = run.harness || {};
  const files = [...new Set([...Object.keys(rh), ...Object.keys(wh)])].sort();
  let refAsserts = 0;
  let runAsserts = 0;
  const fewer = [];
  for (const f of files) {
    const r = rh[f];
    const w = wh[f];
    if (!w) { diffs.push(`${f}: a harness suite the reference ran and the run did not report (a file argument that matched nothing, or a suite that never ran)`); continue; }
    if (!r) { diffs.push(`${f}: a harness suite only the run reported`); continue; }
    refAsserts += r.asserts;
    runAsserts += w.asserts;
    if (w.asserts > r.asserts) diffs.push(`${f}: ${w.asserts} harness assertions on the run, ${r.asserts} on the reference — more`);
    else if (w.asserts < r.asserts) {
      if (w.win32 > 0) fewer.push(`${f} −${r.asserts - w.asserts} under ${w.win32} win32 skip${w.win32 === 1 ? '' : 's'}`);
      else diffs.push(`${f}: ${w.asserts} harness assertions on the run, ${r.asserts} on the reference, and no SKIP win32: line in the file — an early exit`);
    }
  }
  const rs = reference.skips || {};
  const ws = run.skips || {};
  for (const k of [...new Set([...Object.keys(rs), ...Object.keys(ws)])].sort()) {
    if (k.startsWith('win32: ')) continue;
    const a = ws[k] || 0;
    const b = rs[k] || 0;
    if (a === b) continue;
    if (k === PID1_REASON && a === 1 && b === 0) continue;
    diffs.push(`skip '${k}': ${a} on the run, ${b} on the reference`);
  }
  const pid1 = `PID 1: ${ws[PID1_REASON] || 0} vs ${rs[PID1_REASON] || 0}`;
  const line = diffs.length
    ? `${label}: ${diffs.length} difference${diffs.length === 1 ? '' : 's'} — the run did not run what the reference ran`
    : `${label}: tests ${run.tests} = ${reference.tests} · harness assertions ${thousands(runAsserts)} vs ${thousands(refAsserts)} in ${files.length} files${fewer.length ? ` (${fewer.join('; ')})` : ''} · other skips equal (${pid1}) — it ran what the reference ran`;
  return { ok: diffs.length === 0, differences: diffs, line };
}

// ---------- the CLI ----------

const USAGE = [
  'usage: node tools/tap-summary.mjs <tap-file> [--win32-skips readme|<n>] [--max-failures <n>] [--shape <out.json>]',
  '       node tools/tap-summary.mjs --compare <reference.json> <run.json>...',
].join('\n');

function symlinkProbe() {
  const dir = join(tmpdir(), `tap-summary-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 't'), '');
    symlinkSync(join(dir, 't'), join(dir, 'l'));
    return 'created';
  } catch (e) {
    return e.code || e.message;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the probe's own directory; nothing else is touched */ }
  }
}

function hostLine() {
  return `host: ${process.platform} ${release()} ${arch()} · node ${process.version} · ${availableParallelism()} cpus · cwd ${process.cwd()} · tmpdir ${tmpdir()} · symlink: ${symlinkProbe()}`;
}

function readInput(file) {
  try {
    return { bytes: readFileSync(file) };
  } catch (e) {
    return { error: e.code === 'ENOENT' ? `no such file: ${file}` : `cannot read ${file}: ${e.code || e.message}` };
  }
}

function compareMain(files, { out, err }) {
  if (files.some((f) => f.startsWith('--'))) { err(`tap-summary: unknown flag: ${files.find((f) => f.startsWith('--'))}\n${USAGE}`); return 2; }
  if (files.length < 2) { err(`tap-summary: --compare needs the reference shape and at least one run\n${USAGE}`); return 2; }
  const shapes = [];
  for (const f of files) {
    const r = readInput(f);
    if (r.error) { err(`tap-summary: ${r.error}`); return 2; }
    try { shapes.push(JSON.parse(r.bytes.toString('utf8'))); } catch (e) { err(`tap-summary: ${f} is not a run shape: ${e.message}`); return 2; }
  }
  const [reference, ...runs] = shapes;
  const lines = [];
  const errors = [];
  for (const run of runs) {
    const c = compareShapes(reference, run);
    lines.push(c.line);
    for (const d of c.differences) {
      lines.push(`  ${d}`);
      errors.push(annotation('error', { title: `${shapeLabel(run)} vs ${shapeLabel(reference)}` }, d));
    }
  }
  const ok = errors.length === 0;
  out([...lines, ...errors.slice(0, MAX_ANNOTATIONS), ...(ok ? [annotation('notice', { title: 'windows-vs-linux' }, lines.join('\n'))] : [])].join('\n'));
  return ok ? 0 : 1;
}

function main(argv, { out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (argv[0] === '--compare') return compareMain(argv.slice(1), { out, err });
  let file = null;
  let expect = null;
  let maxFailures = 40;
  let shape = null;
  const usage = (msg) => { err(`tap-summary: ${msg}\n${USAGE}`); return 2; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--win32-skips') {
      const v = argv[++i];
      if (v !== 'readme' && !/^\d+$/.test(v ?? '')) return usage('--win32-skips needs readme or a number');
      expect = v;
    } else if (a === '--max-failures') {
      const v = argv[++i];
      if (!/^[1-9]\d*$/.test(v ?? '')) return usage('--max-failures needs a number');
      maxFailures = Number(v);
    } else if (a === '--shape') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return usage('--shape needs a file');
      shape = v;
    } else if (a === '--compare') {
      return usage('--compare comes first: --compare <reference.json> <run.json>...');
    } else if (a.startsWith('--')) {
      return usage(`unknown flag: ${a}`);
    } else if (file === null) {
      file = a;
    } else {
      return usage(`one TAP file at a time (${file}, then ${a})`);
    }
  }
  if (file === null) return usage('name the TAP file');
  const windows = process.platform === 'win32';
  const input = readInput(file);
  if (input.error) { err(`tap-summary: ${input.error}`); return 2; }
  const { text } = decodeTap(input.bytes);
  if (!/^TAP version \d+$/m.test(text)) {
    const spec = /^\s*ℹ tests \d/m.test(text) || /^\s*[✔✖﹣] /m.test(text);
    err(spec
      ? `tap-summary: ${file} holds the spec reporter's output, not TAP (Node 23 and later print spec even into a file) — capture it again with the reporter named: ${reportCommand(file, windows)}`
      : `tap-summary: ${file} is not TAP (no "TAP version" line) — capture the run with the reporter named: ${reportCommand(file, windows)}`);
    return 2;
  }
  let expectWin32 = null;
  let countSource = null;
  if (expect === 'readme') {
    let readme = null;
    try { readme = readFileSync(resolve('README.md'), 'utf8'); } catch { /* reported below */ }
    const n = readme === null ? null : readmeWin32Lines(readme);
    if (n === null) { err('tap-summary: README.md "Platforms" states no "<N> `SKIP win32:` lines" — the count this check holds the run to'); return 2; }
    expectWin32 = n;
    countSource = 'README';
  } else if (expect !== null) {
    expectWin32 = Number(expect);
  }
  const r = summarize(text, { root: process.cwd(), expectWin32, countSource, maxFailures, windows, host: hostLine(), file });
  if (shape) writeFileSync(shape, `${JSON.stringify(runShape(r.parsed, { node: process.version, platform: process.platform }), null, 2)}\n`);
  out(r.text);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
