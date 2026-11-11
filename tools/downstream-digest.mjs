#!/usr/bin/env node
// tools/downstream-digest.mjs — what one refresh of a downstream copy has to
// act on (docs/DOWNSTREAM_REFRESH.md, step 1).
//
//   node tools/downstream-digest.mjs --since <commit> [--to <ref>] [--json] [--repo <dir>]
//
// Runs in upstream's checkout: the one this file is in, or the one --repo
// names (its top level). Between <since>, the commit the copy holds, and
// <to> (default HEAD) it prints:
//   - the commits in the range;
//   - the `- **Downstream:** <kinds> — <sentence>` bullet of every
//     docs/CHANGELOG.md entry added in the range, grouped by kind, and, under
//     "unclassified", the headings of the entries that carry none (written
//     before the convention, CONVENTION_FROM) or one it cannot read;
//   - the export diff of VENDOR-MANIFEST.json between the two commits;
//   - the settings that appear or disappear in server/, tools/ and studio/
//     (test files and fixtures left out), compared by the part after
//     `OBSERVOGRAM_` (or the legacy `TOMOGRAPH_`) as step 5 of the runbook
//     compares them, a per-org name by the part after its key;
//   - the golden files that moved under tools/fixtures/golden/.
// --json prints the same as one object. Exit 0, or 2 with a sentence on
// stderr for a usage or git error.
//
// The convention the digest reads, and tools/test-changelog-downstream.mjs
// enforces: every `###` entry under `## Unreleased`, and under every release
// from CONVENTION_FROM on, ends with one bullet
//   - **Downstream:** <kinds> — <one sentence>.
// where <kinds> is `none`, or one or more of `config`, `api`, `behaviour`,
// `one-way`, separated by commas (DOWNSTREAM_KINDS says what each means).
// An entry moved verbatim from `## Unreleased` into a release section is the
// same entry: one already in <since>'s Unreleased is not "added".

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The kinds a `Downstream:` bullet names, and what each means for a copy. */
export const DOWNSTREAM_KINDS = Object.freeze({
  'none': 'nothing for a downstream to do',
  'config': 'a setting added, renamed or removed',
  'api': "a listed module's exports, a route or a response shape",
  'behaviour': 'what a comparison, grade or screen shows',
  'one-way': 'an upgrade with no way back, such as a store schema move',
});
/** The order a digest prints the kinds in: the hardest to undo first. */
export const KIND_ORDER = Object.freeze(['one-way', 'config', 'api', 'behaviour', 'none']);
/** The first release whose entries carry the bullet; the ones below it are left as they were written. */
export const CONVENTION_FROM = '0.8.28';

const BULLET_START = /^\s*- \*\*Downstream:\*\*/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)\b/;

/** -1, 0 or 1 for two `x.y.z` versions. */
export function compareVersions(a, b) {
  const pa = VERSION.exec(a).slice(1).map(Number);
  const pb = VERSION.exec(b).slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * docs/CHANGELOG.md as sections (`## …`) of entries (`### …`):
 * [{ title, version (null for Unreleased), line, entries: [{ heading, line, body: [line] }] }].
 * The lines between a section's title and its first entry (its summary) are
 * not an entry. Lines are 1-based.
 */
export function parseChangelog(text) {
  const sections = [];
  let section = null;
  let entry = null;
  let fence = false;
  String(text ?? '').replace(/\r\n/g, '\n').split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) fence = !fence;
    const h2 = !fence && /^## (.*)$/.exec(raw);
    const h3 = !fence && /^### (.*)$/.exec(raw);
    if (h2) {
      const title = h2[1].trim();
      const v = VERSION.exec(title);
      section = { title, version: v ? v[0] : null, line: i + 1, entries: [] };
      sections.push(section);
      entry = null;
    } else if (h3 && section) {
      entry = { heading: h3[1].trim(), line: i + 1, body: [] };
      section.entries.push(entry);
    } else if (entry) {
      entry.body.push(raw);
    }
  });
  for (const s of sections) for (const e of s.entries) while (e.body.length && e.body[e.body.length - 1].trim() === '') e.body.pop();
  return { sections };
}

/**
 * One `- **Downstream:** <kinds> — <sentence>` bullet read: { kinds, sentence, problems }.
 * `text` is the bullet with its continuation lines joined by spaces.
 */
export function parseDownstreamBullet(text) {
  const problems = [];
  const rest = String(text).replace(BULLET_START, '').trim();
  const dash = rest.indexOf(' — ');
  if (dash < 0) {
    problems.push('has no ` — ` between its kinds and its sentence');
    return { kinds: [], sentence: '', problems };
  }
  const kinds = rest.slice(0, dash).split(',').map((k) => k.trim()).filter(Boolean);
  const sentence = rest.slice(dash + 3).trim();
  if (kinds.length === 0) problems.push('names no kind');
  for (const k of kinds) if (!Object.hasOwn(DOWNSTREAM_KINDS, k)) problems.push(`names \`${k}\`, not one of ${Object.keys(DOWNSTREAM_KINDS).join(', ')}`);
  const seen = new Set();
  for (const k of kinds) { if (seen.has(k)) problems.push(`names \`${k}\` twice`); seen.add(k); }
  if (kinds.includes('none') && kinds.length > 1) problems.push('names `none` with another kind');
  if (!sentence) problems.push('has no sentence after its kinds');
  else if (!/\.$/.test(sentence)) problems.push('has a sentence that does not end with a full stop');
  return { kinds, sentence, problems };
}

/**
 * The `Downstream:` bullet of one entry: { status: 'ok' | 'missing' | 'invalid', kinds, sentence, problems }.
 * The entry must end with exactly one such bullet, at the top level, with
 * nothing after it but its own indented continuation lines.
 */
export function entryDownstream(entry) {
  const at = [];
  entry.body.forEach((l, i) => { if (BULLET_START.test(l)) at.push(i); });
  if (at.length === 0) return { status: 'missing', kinds: [], sentence: '', problems: ['has no `- **Downstream:**` bullet'] };
  const problems = [];
  if (at.length > 1) problems.push(`has ${at.length} \`Downstream:\` bullets`);
  const i = at[at.length - 1];
  if (/^\s/.test(entry.body[i])) problems.push('has its `Downstream:` bullet indented under another');
  const after = entry.body.slice(i + 1);
  if (after.some((l) => l.trim() !== '' && !/^\s/.test(l))) problems.push('does not end with its `Downstream:` bullet');
  const text = [entry.body[i], ...after.filter((l) => /^\s+\S/.test(l) && !/^\s+- /.test(l))].map((l) => l.trim()).join(' ');
  const read = parseDownstreamBullet(text);
  problems.push(...read.problems);
  return { status: problems.length ? 'invalid' : 'ok', kinds: read.kinds, sentence: read.sentence, problems };
}

/** The sections the convention covers: `## Unreleased` and every release from `from` on. */
export function conventionSections(parsed, from = CONVENTION_FROM) {
  return parsed.sections.filter((s) => s.version === null || compareVersions(s.version, from) >= 0);
}

/** Every entry the convention covers that breaks it, as `docs/CHANGELOG.md:<line> …` sentences; and how many it read. */
export function conventionProblems(text, { from = CONVENTION_FROM, file = 'docs/CHANGELOG.md' } = {}) {
  const problems = [];
  let checked = 0;
  for (const s of conventionSections(parseChangelog(text), from)) {
    for (const e of s.entries) {
      checked++;
      const d = entryDownstream(e);
      for (const p of d.problems) problems.push(`${file}:${e.line} (${s.title}, ### ${e.heading}) ${p}`);
    }
  }
  return { checked, problems };
}

const BARE = /^(added|changed|fixed|removed|deprecated|security|docs|tests|version|not here|known limits?|not in this release)$/i;

/** A line that names an entry: `<version> · <heading>`, a bare category followed by its first bold phrase. */
export function entryLabel(section, entry) {
  let heading = entry.heading;
  if (BARE.test(heading)) {
    const first = entry.body.find((l) => l.trim() !== '') ?? '';
    const lead = /^\s*- \*\*(.+?)\*\*/.exec(first);
    if (lead) heading = `${heading}: ${lead[1].replace(/[.:,;]+$/, '')}`;
  }
  return `${section.version ?? section.title} · ${heading}`;
}

// An entry is known by its heading; one under a bare category heading
// (`### Added`) by the heading and its first line, which a release cut leaves
// as it was.
const entryKey = (e) => (BARE.test(e.heading) ? `${e.heading}\n${(e.body.find((l) => l.trim() !== '') ?? '').trim()}` : e.heading);

/**
 * The CHANGELOG entries `toText` adds to `sinceText`: every entry of a
 * section <since> did not have (a release it did not have, or Unreleased),
 * less the ones <since>'s Unreleased already held. Classified by their
 * `Downstream:` bullet.
 */
export function changelogDigest(sinceText, toText) {
  const before = parseChangelog(sinceText);
  const after = parseChangelog(toText);
  const releases = new Set(before.sections.filter((s) => s.version).map((s) => s.version));
  const held = new Set(before.sections.filter((s) => !s.version).flatMap((s) => s.entries.map(entryKey)));
  const entries = [];
  const unclassified = [];
  for (const s of after.sections) {
    if (s.version && releases.has(s.version)) continue;
    for (const e of s.entries) {
      if (held.has(entryKey(e))) continue;
      const d = entryDownstream(e);
      const base = { section: s.version ?? s.title, heading: e.heading, label: entryLabel(s, e) };
      if (d.status === 'ok') entries.push({ ...base, kinds: d.kinds, sentence: d.sentence });
      else unclassified.push({ ...base, reason: d.status === 'missing' ? null : d.problems.join('; ') });
    }
  }
  const byKind = Object.fromEntries(KIND_ORDER.map((k) => [k, entries.filter((e) => e.kinds.includes(k))]));
  return { added: entries.length + unclassified.length, entries, byKind, unclassified };
}

/** The export diff of two VENDOR-MANIFEST.json objects (null when a commit has none). */
export function exportDiff(before, after) {
  const mods = (m) => (m && m.modules) || {};
  const a = mods(before);
  const b = mods(after);
  const exportsOf = (m) => [...(m.exports || [])].sort();
  const added = Object.keys(b).filter((k) => !Object.hasOwn(a, k)).sort().map((module) => ({ module, exports: exportsOf(b[module]) }));
  const removed = Object.keys(a).filter((k) => !Object.hasOwn(b, k)).sort().map((module) => ({ module, exports: exportsOf(a[module]) }));
  const changed = [];
  for (const module of Object.keys(b).filter((k) => Object.hasOwn(a, k)).sort()) {
    const ea = new Set(exportsOf(a[module]));
    const eb = new Set(exportsOf(b[module]));
    const plus = [...eb].filter((x) => !ea.has(x));
    const minus = [...ea].filter((x) => !eb.has(x));
    if (plus.length || minus.length) changed.push({ module, added: plus, removed: minus });
  }
  return {
    since: before ? before.version ?? null : null,
    to: after ? after.version ?? null : null,
    sinceHasManifest: !!before,
    toHasManifest: !!after,
    added,
    removed,
    changed,
  };
}

// A setting is a literal `OBSERVOGRAM_<NAME>` / `TOMOGRAPH_<NAME>`, or a name
// read through tools/lib/brand-env.mjs (`brandEnv('<NAME>')`,
// `brandEnvFrom(env, '<NAME>')`). Written with `<NAME>` here so that this
// comment is not read as one.
const SETTING_GREP = "(OBSERVOGRAM|TOMOGRAPH)_[A-Z0-9_]*[A-Z0-9]|brandEnv(From)?\\([^)']*'[A-Z0-9_]+'";
const SETTING_PATHS = ['server', 'tools', 'studio', ':(exclude,glob)**/test-*.mjs', ':(exclude,glob)**/fixtures/**'];

/** The name a setting is compared by: the part after the prefix, a per-org name's key as `<KEY>`. */
export function settingName(match) {
  const literal = /^(?:OBSERVOGRAM|TOMOGRAPH)_([A-Z0-9_]+)$/.exec(match);
  const read = /'([A-Z0-9_]+)'$/.exec(match);
  const name = literal ? literal[1] : read ? read[1] : null;
  return name && name.replace(/^ORG_[A-Z0-9]+_(?=[A-Z0-9])/, 'ORG_<KEY>_');
}

/** Two { name → [file] } maps compared: the names only one side has, with the files that name them there. */
export function settingsDiff(before, after) {
  const side = (from, other) => [...from.keys()].filter((k) => !other.has(k)).sort().map((name) => ({ name: `OBSERVOGRAM_${name}`, files: [...from.get(name)].sort() }));
  return { added: side(after, before), removed: side(before, after) };
}

/** `git diff --name-status -z` output read: [{ status, path, from? }]. */
export function parseNameStatus(out) {
  const parts = out.split('\0');
  const rows = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) { rows.push({ status: status[0], from: parts[i], path: parts[i + 1] }); i += 2; } else { rows.push({ status: status[0], path: parts[i] }); i += 1; }
  }
  return rows;
}

export const GOLDEN_DIR = 'tools/fixtures/golden/';

function gitIn(repo) {
  return (args, { allow = [0] } = {}) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.error) throw new Error(`git could not run: ${r.error.message}`);
    if (!allow.includes(r.status)) throw new Error(`git ${args.join(' ')}: ${String(r.stderr).trim() || `exit ${r.status}`}`);
    return { status: r.status, out: r.stdout };
  };
}

/**
 * The digest of one refresh, as an object (the `--json` form). `repo` must
 * be the top level of a git checkout: an export copy has no `.git`, and git
 * would answer for the downstream's repository around it.
 */
export function digest({ since, to = 'HEAD', repo = REPO } = {}) {
  if (!since) throw new Error('--since <commit> is required: the upstream commit the copy holds (vendor/UPSTREAM, second line)');
  const git = gitIn(repo);
  const top = git(['rev-parse', '--show-prefix'], { allow: [0, 128] });
  if (top.status !== 0 || top.out.trim() !== '') {
    throw new Error(`${repo} is not the top of a git checkout (an export copy has no .git): run the digest in upstream's clone, or pass --repo <its folder>`);
  }
  const commitOf = (ref) => {
    const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allow: [0, 1, 128] });
    if (r.status !== 0) throw new Error(`${ref} is not a commit in ${repo} (fetch it first?)`);
    return r.out.trim();
  };
  const sinceCommit = commitOf(since);
  const toCommit = commitOf(to);
  const show = (commit, path) => {
    const r = git(['show', `${commit}:${path}`], { allow: [0, 128] });
    return r.status === 0 ? r.out : null;
  };
  const json = (commit, path) => {
    const text = show(commit, path);
    if (text === null) return null;
    try { return JSON.parse(text); } catch { throw new Error(`${path} at ${commit.slice(0, 12)} is not JSON`); }
  };
  const settingsAt = (commit) => {
    const { out } = git(['grep', '-I', '-o', '-E', SETTING_GREP, commit, '--', ...SETTING_PATHS], { allow: [0, 1] });
    const found = new Map();
    for (const line of out.split('\n')) {
      if (!line.startsWith(`${commit}:`)) continue;
      const rest = line.slice(commit.length + 1);
      const colon = rest.indexOf(':');
      const name = settingName(rest.slice(colon + 1));
      if (!name) continue;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name).add(rest.slice(0, colon));
    }
    return found;
  };
  const count = (...extra) => Number(git(['rev-list', '--count', ...extra, `${sinceCommit}..${toCommit}`]).out.trim());
  const ancestor = git(['merge-base', '--is-ancestor', sinceCommit, toCommit], { allow: [0, 1] }).status === 0;
  const goldens = { added: [], changed: [], removed: [], renamed: [] };
  for (const row of parseNameStatus(git(['diff', '--name-status', '-z', '-M', sinceCommit, toCommit, '--', GOLDEN_DIR]).out)) {
    if (row.status === 'A' || row.status === 'C') goldens.added.push(row.path);
    else if (row.status === 'D') goldens.removed.push(row.path);
    else if (row.status === 'R') goldens.renamed.push({ from: row.from, path: row.path });
    else goldens.changed.push(row.path);
  }
  const versionOf = (commit) => (json(commit, 'package.json') || {}).version ?? null;
  return {
    format: 1,
    since: { ref: since, commit: sinceCommit, version: versionOf(sinceCommit) },
    to: { ref: to, commit: toCommit, version: versionOf(toCommit) },
    sinceIsAncestor: ancestor,
    commits: count(),
    commitsWithoutMerges: count('--no-merges'),
    changelog: changelogDigest(show(sinceCommit, 'docs/CHANGELOG.md'), show(toCommit, 'docs/CHANGELOG.md')),
    exports: exportDiff(json(sinceCommit, 'VENDOR-MANIFEST.json'), json(toCommit, 'VENDOR-MANIFEST.json')),
    settings: settingsDiff(settingsAt(sinceCommit), settingsAt(toCommit)),
    goldens,
  };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The digest as the text the command prints. */
export function renderDigest(d) {
  const out = [];
  const at = (side) => `${side.ref}${side.ref.startsWith(side.commit.slice(0, 7)) ? '' : ` ${side.commit.slice(0, 8)}`}${side.version ? ` (${side.version})` : ''}`;
  out.push(`Downstream digest: ${at(d.since)} → ${at(d.to)}`);
  out.push(`${plural(d.commits, 'commit')} (${d.commitsWithoutMerges} without merges)${d.sinceIsAncestor ? '' : `; ${d.since.ref} is not an ancestor of ${d.to.ref}, so these are the commits ${d.to.ref} has and it does not`}`);

  const c = d.changelog;
  out.push('', `CHANGELOG entries added: ${c.added} (${c.entries.length} classified, ${c.unclassified.length} unclassified)`);
  for (const kind of KIND_ORDER) {
    const list = c.byKind[kind];
    if (!list.length) continue;
    out.push(`  ${kind} (${list.length}) — ${DOWNSTREAM_KINDS[kind]}`);
    for (const e of list) out.push(`    ${e.label}${e.kinds.length > 1 ? ` [${e.kinds.join(', ')}]` : ''}`, `      ${e.sentence}`);
  }
  if (c.unclassified.length) {
    out.push(`  unclassified (${c.unclassified.length}) — no Downstream bullet; read the entry`);
    for (const e of c.unclassified) out.push(`    ${e.label}${e.reason ? `  (bullet not read: ${e.reason})` : ''}`);
  }

  const x = d.exports;
  out.push('', `VENDOR-MANIFEST.json exports (${x.since ?? 'none'} → ${x.to ?? 'none'})`);
  if (!x.sinceHasManifest) out.push(`  ${d.since.ref} has no VENDOR-MANIFEST.json: every listed module counts as new`);
  if (!x.toHasManifest) out.push(`  ${d.to.ref} has no VENDOR-MANIFEST.json`);
  for (const m of x.added) out.push(`  + ${m.module} (new module)${m.exports.length ? `: ${m.exports.join(', ')}` : ''}`);
  for (const m of x.removed) out.push(`  - ${m.module} (no longer listed)${m.exports.length ? `: ${m.exports.join(', ')}` : ''}`);
  for (const m of x.changed) {
    const parts = [];
    if (m.added.length) parts.push(`+ ${m.added.join(', ')}`);
    if (m.removed.length) parts.push(`- ${m.removed.join(', ')}`);
    out.push(`  ~ ${m.module}: ${parts.join('; ')}`);
  }
  if (!x.added.length && !x.removed.length && !x.changed.length) out.push('  no export added or removed');

  const s = d.settings;
  out.push('', `Settings in server/, tools/, studio/ (tests and fixtures left out): ${s.added.length} appear, ${s.removed.length} disappear`);
  const firstFiles = (f) => (f.length > 2 ? `${f.slice(0, 2).join(', ')}, +${f.length - 2}` : f.join(', '));
  for (const v of s.added) out.push(`  + ${v.name}  (${firstFiles(v.files)})`);
  for (const v of s.removed) out.push(`  - ${v.name}  (was in ${firstFiles(v.files)})`);

  const g = d.goldens;
  const moved = g.added.length + g.changed.length + g.removed.length + g.renamed.length;
  out.push('', `Goldens under ${GOLDEN_DIR}: ${moved} moved (${g.changed.length} changed, ${g.added.length} added, ${g.removed.length} removed, ${g.renamed.length} renamed)`);
  const short = (p) => (p.startsWith(GOLDEN_DIR) ? p.slice(GOLDEN_DIR.length) : p);
  for (const p of g.changed) out.push(`  ~ ${short(p)}`);
  for (const p of g.added) out.push(`  + ${short(p)}`);
  for (const p of g.removed) out.push(`  - ${short(p)}`);
  for (const r of g.renamed) out.push(`  > ${short(r.from)} → ${short(r.path)}`);
  return `${out.join('\n')}\n`;
}

function main(argv) {
  const args = [...argv];
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return undefined; const v = args[i + 1]; if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`); args.splice(i, 2); return v; };
  const has = (flag) => { const i = args.indexOf(flag); if (i < 0) return false; args.splice(i, 1); return true; };
  if (has('--help') || has('-h')) {
    process.stdout.write('node tools/downstream-digest.mjs --since <commit> [--to <ref>] [--json] [--repo <dir>]\n');
    return 0;
  }
  const since = take('--since');
  const to = take('--to');
  const repo = take('--repo');
  const json = has('--json');
  if (args.length) throw new Error(`unknown argument ${args[0]}`);
  const d = digest({ since, to: to ?? 'HEAD', repo: repo ? resolve(repo) : REPO });
  process.stdout.write(json ? `${JSON.stringify(d, null, 2)}\n` : renderDigest(d));
  return 0;
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`downstream-digest: ${e.message}\n`); process.exitCode = 2; }
}
