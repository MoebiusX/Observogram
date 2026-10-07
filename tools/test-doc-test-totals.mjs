// tools/test-doc-test-totals.mjs — the suite totals the docs quote chain.
//
// docs/UPDATE_JOURNEY.md closes each decision with `Tests: a → b`, the
// `npm test` total before and after the change, and a reader takes the run of
// them as the real total over time. The invariant that makes that reading
// true: within one heading-bounded section the entries chain — sorted by
// start, every start is the previous entry's end — so two entries never claim
// the same starting total and no entry starts from a total nothing reached. A
// new section may open from a later baseline (totals between sections moved
// in work the journey does not narrate). The CHANGELOG's `## Unreleased`
// entries quote the same kind of pair (`a → b tests`, `Suite total a → b`):
// no two may start from the same total, and one that starts where a journey
// entry starts must end where it ends, so the two documents cannot disagree.
// A batch's delivery report (`docs/DELIVERY-*.md`, the batch acceptance's
// "short delivery report" — one per PR of rebadge batch 2) quotes the same
// pairs per work item: it must exist and every pair it states must be one
// the journey states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const journey = readFileSync(resolve(ROOT, 'docs/UPDATE_JOURNEY.md'), 'utf8');
const changelog = readFileSync(resolve(ROOT, 'docs/CHANGELOG.md'), 'utf8');
const DELIVERY_REPORTS = ['docs/DELIVERY-REBADGE-BATCH2.md', 'docs/DELIVERY-GAP-BATCH2.md', 'docs/DELIVERY-REBADGE-BATCH3.md'];

const PAIR = /Tests: (\d+) → (\d+)/g;

/** `Tests: a → b` entries of the journey grouped by the heading above them. */
function journeySections(text) {
  const sections = [];
  let current = { heading: '(preamble)', entries: [] };
  text.split('\n').forEach((line, i) => {
    if (/^#{1,6} /.test(line)) {
      sections.push(current);
      current = { heading: line.trim(), entries: [] };
      return;
    }
    for (const m of line.matchAll(PAIR)) current.entries.push({ line: i + 1, start: Number(m[1]), end: Number(m[2]) });
  });
  sections.push(current);
  return sections.filter((s) => s.entries.length > 0);
}

const SECTIONS = journeySections(journey);
const JOURNEY_BY_START = new Map(SECTIONS.flatMap((s) => s.entries.map((e) => [e.start, e])));

test('every journey entry that counts tests states the total as `Tests: a → b`', () => {
  const loose = [];
  journey.split('\n').forEach((line, i) => {
    if (/Tests: (?!\d+ → \d+)/.test(line)) loose.push(`docs/UPDATE_JOURNEY.md:${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(loose, [], 'a `Tests:` note that is not `Tests: <before> → <after>` cannot be chained');
});

test('within a section the journey\'s test totals chain start-to-end', () => {
  assert.ok(SECTIONS.length > 0, 'the journey states at least one `Tests: a → b`');
  const problems = [];
  for (const { heading, entries } of SECTIONS) {
    const sorted = [...entries].sort((a, b) => a.start - b.start || a.line - b.line);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.start !== prev.end) {
        problems.push(`${heading}: docs/UPDATE_JOURNEY.md:${cur.line} starts at ${cur.start} but the entry before it (line ${prev.line}) ends at ${prev.end}`);
      }
    }
    for (const e of entries) {
      if (e.end <= e.start) problems.push(`${heading}: docs/UPDATE_JOURNEY.md:${e.line} \`Tests: ${e.start} → ${e.end}\` does not grow the suite`);
    }
  }
  assert.deepEqual(problems, [], 'restate the entries as one chain of measured totals');
});

test('the CHANGELOG\'s Unreleased test totals agree with each other and with the journey', () => {
  const unreleased = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
  assert.ok(unreleased, 'docs/CHANGELOG.md has a `## Unreleased` section');
  const firstLine = changelog.slice(0, unreleased.index).split('\n').length + 1;
  const quoted = [];
  unreleased[1].split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/Suite total (\d+) → (\d+)|(\d+) → (\d+) tests\b/g)) {
      quoted.push({ start: Number(m[1] ?? m[3]), end: Number(m[2] ?? m[4]), line: firstLine + i });
    }
  });
  assert.ok(quoted.length > 0, 'the Unreleased entries quote at least one suite total');
  const problems = [];
  const byStart = new Map();
  for (const q of quoted) {
    const seen = byStart.get(q.start);
    if (seen) problems.push(`docs/CHANGELOG.md:${seen.line} and :${q.line} both start from ${q.start} (→ ${seen.end} and → ${q.end}) — one branch has one total at a time`);
    else byStart.set(q.start, q);
    const stated = JOURNEY_BY_START.get(q.start);
    if (stated && stated.end !== q.end) problems.push(`docs/CHANGELOG.md:${q.line} says ${q.start} → ${q.end}; docs/UPDATE_JOURNEY.md:${stated.line} says ${q.start} → ${stated.end}`);
  }
  assert.deepEqual(problems, [], 'docs/CHANGELOG.md and docs/UPDATE_JOURNEY.md quote the same measured totals');
});

test('each batch delivery report exists and quotes the journey\'s measured totals', () => {
  const problems = [];
  for (const file of DELIVERY_REPORTS) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      problems.push(`${file}: missing — the batch acceptance asks for a short delivery report (per work item: what shipped, test counts, anything deferred and why)`);
      continue;
    }
    const quoted = [];
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(PAIR)) quoted.push({ line: i + 1, start: Number(m[1]), end: Number(m[2]) });
    });
    if (quoted.length === 0) problems.push(`${file}: quotes no \`Tests: a → b\` total`);
    // The total a report states for the head of its branch is the last one
    // its own pairs reach: a review fix's pair grows the chain, and the
    // opening sentence must follow it.
    const head = /\b(\d+) at the head of this branch\b/.exec(text.replace(/\s+/g, ' '));
    const reached = Math.max(...quoted.map((q) => q.end));
    if (head && quoted.length > 0 && Number(head[1]) !== reached) problems.push(`${file}: says ${head[1]} at the head of this branch; its last \`Tests:\` pair reaches ${reached}`);
    for (const q of quoted) {
      const stated = JOURNEY_BY_START.get(q.start);
      if (!stated) problems.push(`${file}:${q.line} says ${q.start} → ${q.end}; docs/UPDATE_JOURNEY.md has no entry starting at ${q.start}`);
      else if (stated.end !== q.end) problems.push(`${file}:${q.line} says ${q.start} → ${q.end}; docs/UPDATE_JOURNEY.md:${stated.line} says ${q.start} → ${stated.end}`);
    }
  }
  assert.deepEqual(problems, [], 'the delivery report states the totals the journey measured');
});

// The suites batch 2 and rebadge batch 3 added (the two MCP ping suites, which
// review fixes grew), each a flat file of top-level `test(` calls
// (no subtests, no loops), so the number of tests it holds is the number of
// lines that start with `test(`. The journey narrates how many tests each
// `Tests: a → b` note put into such a suite — `` `file` 9 `` on its creation,
// `two in `file``, `one more test in `file`` as it grows — and those
// narrations must sum to what the file holds: a test added without its note
// leaves the chain's last total short of `npm test`, which no total-only
// check can see.
const LEDGER = [
  'tools/test-pack-conformance.mjs',
  'tools/test-upconvert-merge.mjs',
  'tools/test-platform.mjs',
  'tools/test-doc-test-totals.mjs',
  'tools/test-waivers.mjs',
  'tools/test-remediation-flow.mjs',
  'tools/test-remediation-flow-view.mjs',
  'tools/test-glossary.mjs',
  'server/test-glossary-shell.mjs',
  'tools/test-audit-report.mjs',
  'server/test-audit-report-api.mjs',
  'tools/test-mcp-ping.mjs',
  'server/test-mcp-ping.mjs',
];
const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const count = (w) => (/^\d+$/.test(w) ? Number(w) : WORDS[w.toLowerCase()]);

/** Every test count the journey narrates for `file`, in order of appearance. */
function narratedCounts(text, file) {
  const flat = text.replace(/\s+/g, ' ');
  const f = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:\`${f}\` (\\d+)\\b|\\b(\\d+|${Object.keys(WORDS).join('|')})(?: more)?(?: tests?)? in \`${f}\`)`, 'gi');
  return [...flat.matchAll(re)].map((m) => count(m[1] ?? m[2]));
}

test('the counts the journey narrates for each flat suite this batch added sum to the tests the file holds', () => {
  const problems = [];
  for (const file of LEDGER) {
    const lines = readFileSync(resolve(ROOT, file), 'utf8').split('\n');
    const nested = lines.filter((l) => /^\s+(test|it|describe)\(/.test(l) || /\bt\.test\(/.test(l));
    if (nested.length > 0) {
      problems.push(`${file}: has nested or indented tests (${nested.length}); a flat count no longer measures it — take it off LEDGER and state its total another way`);
      continue;
    }
    const held = lines.filter((l) => /^test\(/.test(l)).length;
    const narrated = narratedCounts(journey, file);
    const sum = narrated.reduce((a, b) => a + b, 0);
    if (sum !== held) problems.push(`${file} holds ${held} tests; docs/UPDATE_JOURNEY.md narrates ${narrated.join(' + ') || 'none'} = ${sum} — a test landed without its \`Tests: a → b\` note (or a note without its test)`);
  }
  assert.deepEqual(problems, [], 'every test in a batch-added suite is counted by one journey note');
});

// A document may also state, next to a suite's creation count, how many tests
// the file holds now — `` `file` (9 tests at this entry's commit, 11 at the
// head of the branch …) `` in the CHANGELOG, `` `file` (9 then; 12 at the head
// of this PR …) `` in the delivery report. That phrase is a claim about the
// file as it is, so it must equal the `test(` calls the file holds: it is not
// a `Tests: a → b` pair and no chain check reads it, which is how one grew
// stale while the pair beside it was kept current.
const HEAD_COUNT = /`([^`]+\.mjs)` \((\d+)(?: tests)?[^()]*?[;,] (\d+) at the head of (?:the branch|this PR)\b/g;

test('every "N at the head of the branch / this PR" count a document states for a ledger suite is the tests the file holds', () => {
  const docs = ['docs/CHANGELOG.md', ...DELIVERY_REPORTS];
  const problems = [];
  let stated = 0;
  for (const file of docs) {
    const flat = readFileSync(resolve(ROOT, file), 'utf8').replace(/\s+/g, ' ');
    for (const m of flat.matchAll(HEAD_COUNT)) {
      const suite = m[1];
      if (!LEDGER.includes(suite)) continue;
      stated++;
      const held = readFileSync(resolve(ROOT, suite), 'utf8').split('\n').filter((l) => /^test\(/.test(l)).length;
      if (Number(m[3]) !== held) problems.push(`${file}: says \`${suite}\` holds ${m[3]} at the head of the branch; the file holds ${held}`);
    }
  }
  assert.ok(stated > 0, 'at least one document states a head-of-branch count for a ledger suite');
  assert.deepEqual(problems, [], 'a head-of-branch count is a claim about the file as it is — restate it with the test that grew the suite');
});
