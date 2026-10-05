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
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const journey = readFileSync(resolve(ROOT, 'docs/UPDATE_JOURNEY.md'), 'utf8');
const changelog = readFileSync(resolve(ROOT, 'docs/CHANGELOG.md'), 'utf8');

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
