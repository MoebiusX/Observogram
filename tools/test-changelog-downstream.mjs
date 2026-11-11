// tools/test-changelog-downstream.mjs — every new CHANGELOG entry says what
// it means for a downstream copy.
//
// A downstream that runs the whole repository refreshes across hundreds of
// commits at once (docs/DOWNSTREAM_REFRESH.md), and reads the CHANGELOG to
// learn what it has to act on. So every `###` entry under `## Unreleased`,
// and under every release from the convention's first (CONVENTION_FROM) on,
// ends with exactly one bullet
//   - **Downstream:** <kinds> — <one sentence>.
// whose kinds are `none`, or one or more of `config`, `api`, `behaviour`,
// `one-way` — the words tools/downstream-digest.mjs groups a refresh by. A
// release cut moves the entries verbatim under `## x.y.z — date` and leaves
// `## Unreleased` empty, which is why the rule reads the releases too: like
// the totals gate (tools/test-doc-test-totals.mjs), it never reads nothing.
// The releases below CONVENTION_FROM stay as they were written; the digest
// lists their entries as unclassified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONVENTION_FROM, DOWNSTREAM_KINDS, KIND_ORDER, compareVersions, conventionProblems, conventionSections, entryDownstream, parseChangelog, parseDownstreamBullet } from './downstream-digest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const changelog = readFileSync(resolve(ROOT, 'docs/CHANGELOG.md'), 'utf8');
const runbook = readFileSync(resolve(ROOT, 'docs/DOWNSTREAM_REFRESH.md'), 'utf8');

test('every CHANGELOG entry from the convention on ends with one `Downstream:` bullet of known kinds', () => {
  const { checked, problems } = conventionProblems(changelog);
  assert.ok(checked > 0, `docs/CHANGELOG.md has entries under Unreleased or a release from ${CONVENTION_FROM} on`);
  assert.deepEqual(problems, [], 'end each entry with `- **Downstream:** <kinds> — <one sentence>.` (docs/DOWNSTREAM_REFRESH.md, step 1)');
});

test('the convention starts at a release the CHANGELOG has, or the next one, and leaves the releases before it as written', () => {
  const parsed = parseChangelog(changelog);
  const releases = parsed.sections.filter((s) => s.version).map((s) => s.version);
  assert.ok(releases.includes(CONVENTION_FROM) || releases.every((v) => compareVersions(v, CONVENTION_FROM) < 0),
    `CONVENTION_FROM ${CONVENTION_FROM} is a release docs/CHANGELOG.md has, or newer than all of them (the next cut)`);
  const covered = conventionSections(parsed).map((s) => s.title);
  assert.equal(covered[0], 'Unreleased', 'the newest section is `## Unreleased`');
  const older = parsed.sections.find((s) => s.version === '0.8.27');
  assert.ok(older && !covered.includes(older.title), '0.8.27 and before are not read');
  assert.ok(older.entries.every((e) => entryDownstream(e).status === 'missing'), 'a release before the convention is left as it was written');
});

test('the rule bites on each way an entry can break it', () => {
  const text = [
    '# Changelog',
    '',
    '## Unreleased',
    '',
    '### Added: good',
    '- **The thing** does it.',
    '- **Downstream:** config, api — `OBSERVOGRAM_X` is new and `foo()` is exported.',
    '',
    '### Added: wraps',
    '- One.',
    '- **Downstream:** behaviour — the board now',
    '  counts it.',
    '',
    '### Added: missing',
    '- No bullet here.',
    '',
    '### Added: twice',
    '- **Downstream:** none — nothing.',
    '- **Downstream:** none — nothing again.',
    '',
    '### Added: not last',
    '- **Downstream:** none — nothing.',
    '- A bullet after it.',
    '',
    '### Added: unknown kind',
    '- **Downstream:** schema — moves the store.',
    '',
    '### Added: none and more',
    '- **Downstream:** none, api — both.',
    '',
    '### Added: no dash',
    '- **Downstream:** none: nothing.',
    '',
    '### Added: no stop',
    '- **Downstream:** one-way — no way back',
    '',
    '### Added: nested',
    '- A change.',
    '  - **Downstream:** none — nested under it.',
    '',
    '## 0.9.0 — 2026-12-01',
    '',
    '### Tests',
    '- `tools/test-x.mjs`.',
    '',
    '## 0.8.0 — 2026-11-01',
    '',
    '### Added: before the convention',
    '- Written before it.',
    '',
  ].join('\n');
  const { checked, problems } = conventionProblems(text, { from: '0.9.0' });
  assert.equal(checked, 11, 'Unreleased and 0.9.0 are read, 0.8.0 is not');
  const about = (heading) => problems.filter((p) => p.includes(`### ${heading})`));
  assert.deepEqual(about('Added: good'), []);
  assert.deepEqual(about('Added: wraps'), [], 'a sentence may wrap onto indented lines');
  assert.match(about('Added: missing').join(), /has no `- \*\*Downstream:\*\*` bullet/);
  assert.match(about('Added: twice').join(), /has 2 `Downstream:` bullets/);
  assert.match(about('Added: not last').join(), /does not end with its `Downstream:` bullet/);
  assert.match(about('Added: unknown kind').join(), /names `schema`, not one of none, config, api, behaviour, one-way/);
  assert.match(about('Added: none and more').join(), /names `none` with another kind/);
  assert.match(about('Added: no dash').join(), /has no ` — ` between its kinds and its sentence/);
  assert.match(about('Added: no stop').join(), /does not end with a full stop/);
  assert.match(about('Added: nested').join(), /indented under another/);
  assert.match(about('Tests').join(), /docs\/CHANGELOG\.md:\d+ \(0\.9\.0 — 2026-12-01, ### Tests\) has no/, 'a release from the convention on is read too');
  assert.deepEqual(about('Added: before the convention'), []);
  assert.deepEqual(parseDownstreamBullet('- **Downstream:** config, one-way — the store moves to schema v5.'), { kinds: ['config', 'one-way'], sentence: 'the store moves to schema v5.', problems: [] });
  assert.match(parseDownstreamBullet('- **Downstream:** api, api — twice.').problems.join(), /names `api` twice/);
});

test('the runbook\'s step 1 documents the convention and points to the digest', () => {
  const step1 = /### 1\. [\s\S]*?(?=\n### 2\. )/.exec(runbook)?.[0] ?? '';
  assert.ok(step1, 'docs/DOWNSTREAM_REFRESH.md has a step 1');
  assert.ok(step1.includes('- **Downstream:** <kinds> — <one sentence>'), 'step 1 shows the bullet');
  for (const kind of Object.keys(DOWNSTREAM_KINDS)) assert.ok(step1.includes(`\`${kind}\``), `step 1 names the kind \`${kind}\``);
  assert.ok(step1.includes('tools/downstream-digest.mjs'), 'step 1 points to the digest');
  assert.deepEqual([...KIND_ORDER].sort(), Object.keys(DOWNSTREAM_KINDS).sort(), 'the digest prints every kind');
});
