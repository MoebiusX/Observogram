#!/usr/bin/env node
/**
 * tools/pack-conformance.mjs — the placeholders a pack still carries.
 *
 * Thin Node CLI over tools/lib/pack-conformance.mjs (the engine; browser-safe,
 * vendorable), the way tools/validate-pack.mjs wraps tools/lib/validator.mjs.
 * The schema check runs first — a placeholder report over an invalid pack is
 * meaningless — so for one pack this tool is a superset of validate-pack. The
 * maturity rubric (tools/lib/conformance.mjs, the Diagnose view) is bridged,
 * not hidden: one rubric line per pack, a `rubric` object in --json. The rubric
 * grades what is declared, placeholders included; these rows are what still
 * has to become real.
 *
 *   node tools/pack-conformance.mjs <pack.yaml|pack.json> [...] [--json] [--strict] [--quiet] [--waivers <file>]
 *     --json     one JSON document on stdout (shape below) instead of the summary
 *     --strict   exit 1 when any pack still carries a placeholder row that no waiver covers (default: exit 0, rows are informational)
 *     --quiet    the headline and the counts line only (no rows, no rubric line)
 *     --waivers  a waiver file (tools/lib/waivers.mjs readWaiverFile: { version: 1, waivers: [...] }, the objects the
 *                API serves) applied to every pack: a covered placeholder row is `waived`, a covered rubric clause is
 *                met in the rubric's `effective` numbers — the engine's own numbers are never rewritten
 *
 *   exit 0  every pack read, canonical and schema-valid (placeholders may remain)
 *   exit 1  a pack is unreadable, not canonical, previous-format, or schema-invalid; or --strict and any pack has unwaived rows
 *   exit 2  usage (no file, unknown flag, a --waivers file that cannot be read)
 *
 * --json: { tool, specVersion, strict, packs: [{ path, valid, errors, rubric, ...packConformance(report) }],
 *           totals: { packs, valid, conformant, rows, symbols, byState, bySource }, exitCode }
 *         — with --waivers also `waivers: { file, counts }`, `rubric.waivers` (the overlay's block) where a waiver
 *         applied, the report's `waived` partition and `totals.byState.waived`; without it, byte-identical to before.
 * An invalid pack's entry is { path, valid: false, errors, rows: [], conformant: false } (no rubric).
 *
 * Output is UTF-8 like validate-pack's (✓/✗, —, ·). The tool is read-only by
 * design: it never clears a marker.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { isLegacyLayeredPack } from './lib/legacy.mjs';
import { RUBRIC, evaluateConformance } from './lib/conformance.mjs';
import { packConformance, SOURCES, STATES } from './lib/pack-conformance.mjs';
import { applyWaiversToConformance, readWaiverFile } from './lib/waivers.mjs';

const SCHEMA = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', SPEC_SCHEMA_PATH), 'utf8'));
const RULE_IDS = new Set(RUBRIC.map(c => c.id));

const USAGE = `usage: node tools/pack-conformance.mjs <pack.yaml|pack.json> [...] [--json] [--strict] [--quiet] [--waivers <file>]
  --json            one JSON document on stdout instead of the summary
  --strict          exit 1 when any pack still carries a placeholder row no waiver covers (default: exit 0, rows are informational)
  --quiet           the headline and the counts line only (no rows, no rubric line)
  --waivers <file>  a waiver file ({ version: 1, waivers: [{ ruleId, artefactId?, reason, expiresAt, author }] }) applied to every pack
exit 0  every pack read, canonical and schema-valid (placeholders may remain)
exit 1  a pack is unreadable, not canonical, previous-format, or schema-invalid; or --strict and any pack has unwaived rows
exit 2  usage (no file, unknown flag, an unreadable --waivers file)
`;

// validate-pack.mjs's loader, copied (eight lines; the two CLIs stay independent).
function loadPack(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  try { return parseYaml(text); } catch { return JSON.parse(text); }
}

const TAIL = {
  placeholder: (m) => `-> then delete metadata.annotations[${JSON.stringify(m)}]`,
  'marker-only': (m) => `-> the value no longer matches an upstream stub: if it is real, delete metadata.annotations[${JSON.stringify(m)}]`,
  unmarked: () => '-> no marker: the value is an upstream stub literal',
  dangling: (m) => `-> delete metadata.annotations[${JSON.stringify(m)}] — it names no artefact`,
};

/**
 * One pack's entry: { path, valid, errors, canonical?, report?, rubric? } — never throws. With `waivers` (normalized,
 * readWaiverFile's) the report carries its waived partition and `rubric.waivers` the overlay's block when one applied.
 */
export function analysePack(path, { schema = SCHEMA, waivers = null, now = new Date().toISOString() } = {}) {
  let pack;
  try { pack = loadPack(path); }
  catch (e) { return { path, valid: false, errors: [e.message], kind: /file not found/.test(e.message) ? 'missing' : 'unreadable' }; }
  if (isLegacyLayeredPack(pack)) return { path, valid: false, errors: ['previous-format (layered JSON) pack'], kind: 'legacy' };
  const errors = validateCanonical(pack, schema);
  if (errors.length) return { path, valid: false, errors, kind: 'invalid' };
  const rubric = evaluateConformance(pack);
  // Each engine sees the waivers of its own vocabulary: a rubric clause's go to the rubric overlay, every other
  // rule's (placeholder.<family>.<field>, marker.dangling) to the placeholder rows.
  const rubricWaivers = waivers ? waivers.filter(w => RULE_IDS.has(w.ruleId)) : [];
  const rowWaivers = waivers ? waivers.filter(w => !RULE_IDS.has(w.ruleId)) : [];
  const applied = rubricWaivers.length ? applyWaiversToConformance(rubric, rubricWaivers, { now, canonical: pack }) : rubric;
  return {
    path, valid: true, errors: [], kind: 'ok', canonical: pack, report: packConformance(pack, rowWaivers.length ? { waivers: rowWaivers, now } : {}),
    rubric: {
      declaredTier: rubric.declaredTier, mustPassed: rubric.must.passed, mustTotal: rubric.must.total, mustPercent: rubric.mustPercent, scorePercent: rubric.scorePercent, conformant: rubric.conformant,
      ...(applied !== rubric ? { waivers: applied.waivers } : {}),
    },
  };
}

/** The ✗ line(s) for a pack that could not be analysed. */
export function refusalText(entry) {
  const { path, kind, errors } = entry;
  if (kind === 'missing') return `✗ ${path}: file not found\n`;
  if (kind === 'unreadable') return `✗ ${path}: unreadable — ${errors[0]}\n`;
  if (kind === 'legacy') return `✗ ${path}: previous-format (layered JSON) pack — upconvert it first: npm run upconvert-legacy -- ${path} -o ${path}.pack.json\n`;
  return `✗ ${path}: not a valid spec v${SPEC_VERSION} manifest (${errors.length} error(s)) — npm run validate-pack -- ${path}\n${errors.slice(0, 10).map(e => `    ${e}\n`).join('')}`;
}

/** The human summary of one analysed pack (stdout). */
export function summaryText(entry, { quiet = false } = {}) {
  const { path, report, rubric } = entry;
  const writers = Object.entries(report.writers).filter(([, v]) => v).map(([k]) => k);
  const tag = `[spec v${SPEC_VERSION}${writers.length ? ` · ${writers.join(' · ')}` : ''}${report.markers ? ` · ${report.markers} marker(s)` : ''}]`;
  const lines = [];
  if (report.conformant) {
    lines.push(`✓ ${path} — conformant: no placeholders  ${tag}`);
    // Only with a rubric overlay (--waivers): the line a conformant pack otherwise has no need of.
    if (!quiet && rubric.waivers) lines.push(rubricLine(rubric));
    return lines.join('\n') + '\n';
  }
  lines.push(`✗ ${path} — ${report.counts.symbols} placeholder artefact(s), ${report.counts.rows} field(s) need real values  ${tag}`);
  if (!quiet) {
    // Group consecutive rows by (symbol, marker, state): one header, the fields, one tail.
    const groups = [];
    for (const row of report.rows) {
      const last = groups[groups.length - 1];
      if (last && last.symbol === row.symbol && last.marker === row.marker && last.state === row.state) last.rows.push(row);
      else groups.push({ symbol: row.symbol, marker: row.marker, state: row.state, path: row.path, rows: [row] });
    }
    for (const g of groups) {
      const origin = g.state === 'unmarked' ? 'unmarked' : g.state === 'dangling' ? 'dangling' : g.marker.slice(0, g.marker.indexOf('.', g.marker.indexOf('.') + 1));
      lines.push(`  ${g.path}  ${g.symbol}  (${origin})`);
      const width = Math.max(...g.rows.map(r => String(r.field ?? '-').length));
      for (const r of g.rows) {
        const needs = r.field === null ? r.needs : `${r.needs}${r.hint ? ` -- ${r.hint}` : ''}`;
        const waiver = r.waived ? `  [waived until ${r.waived.expiresAt.slice(0, 10)} by ${r.waived.author}: ${r.waived.reason}]` : r.lapsed ? `  [waiver lapsed ${r.lapsed.expiresAt.slice(0, 10)}: ${r.lapsed.reason}]` : '';
        lines.push(`    ${String(r.field ?? '-').padEnd(width)}  ${r.source.padEnd(9)}  ${needs}${waiver}`);
      }
      lines.push(`    ${TAIL[g.state](g.marker)}`);
    }
  }
  const waived = report.waived ? ` · waived ${report.waived.length}` : '';
  lines.push(`  by source: ${SOURCES.map(s => `${s} ${report.counts.bySource[s]}`).join(' · ')}    by state: ${STATES.map(s => `${s} ${report.counts.byState[s]}`).join(' · ')}${waived}`);
  if (!quiet) lines.push(rubricLine(rubric));
  return lines.join('\n') + '\n';
}

const rubricLine = (rubric) => `  rubric @ ${rubric.declaredTier}: MUST ${rubric.mustPassed}/${rubric.mustTotal}${rubricWaived(rubric)} · score ${rubric.scorePercent}%${rubricScore(rubric)} — the rubric grades what is declared, placeholders included; the rows above are what still has to become real`;

// The rubric line's waiver notes — only with an overlay (rubric.waivers), and each only when it says something:
// `(+w waived)` for the MUST clauses the waivers meet, `(m% with waivers)` when the effective score differs, and the
// waivers that match no failing clause of this pack.
const rubricWaived = (rubric) => {
  if (!rubric.waivers) return '';
  const w = rubric.waivers.effective.must.passed - rubric.mustPassed;
  return w > 0 ? ` (+${w} waived)` : '';
};
const rubricScore = (rubric) => {
  if (!rubric.waivers) return '';
  const parts = [];
  if (rubric.waivers.effective.scorePercent !== rubric.scorePercent) parts.push(` (${rubric.waivers.effective.scorePercent}% with waivers)`);
  const n = rubric.waivers.unused.length;
  if (n) parts.push(` · ${n} waiver${n === 1 ? ' matches' : 's match'} no failing clause`);
  return parts.join('');
};

// The rows --strict fails on: every row, or, with waivers, every row no active waiver covers.
const unwaived = (report) => report.rows.filter(r => !r.waived);

// The --waivers file, read before any pack: { waivers, counts } or { error }.
function loadWaivers(path, now) {
  try {
    const { waivers, counts } = readWaiverFile(JSON.parse(readFileSync(path, 'utf8')), { now });
    return { waivers, counts };
  } catch (e) {
    return { error: `--waivers ${path}: ${e.code === 'ENOENT' ? 'file not found' : e.message}` };
  }
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, now = new Date().toISOString() } = {}) {
  const flags = { json: false, strict: false, quiet: false, waivers: null };
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--strict') flags.strict = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--waivers') {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) { stderr.write(`--waivers needs a file\n${USAGE}`); return 2; }
      flags.waivers = argv[++i];
    } else if (a === '-h' || a === '--help') { stdout.write(USAGE); return 0; }
    else if (a.startsWith('-')) { stderr.write(`unknown flag: ${a}\n${USAGE}`); return 2; }
    else files.push(a);
  }
  if (!files.length) { stderr.write(USAGE); return 2; }
  let waivers = null;
  if (flags.waivers !== null) {
    const loaded = loadWaivers(flags.waivers, now);
    if (loaded.error) { stderr.write(`${loaded.error}\n`); return 2; }
    waivers = loaded;
  }

  const entries = files.map(f => analysePack(f, { waivers: waivers?.waivers ?? null, now }));
  let bad = entries.some(e => !e.valid);
  if (flags.strict && entries.some(e => e.valid && unwaived(e.report).length > 0)) bad = true;
  const exitCode = bad ? 1 : 0;

  if (flags.json) {
    const zero = (keys) => Object.fromEntries(keys.map(k => [k, 0]));
    const states = waivers ? [...STATES, 'waived'] : STATES;
    const totals = { packs: entries.length, valid: 0, conformant: 0, rows: 0, symbols: 0, byState: zero(states), bySource: zero(SOURCES) };
    const packs = entries.map((e) => {
      if (!e.valid) return { path: e.path, valid: false, errors: e.errors, rows: [], conformant: false };
      totals.valid++;
      if (e.report.conformant) totals.conformant++;
      totals.rows += e.report.counts.rows;
      totals.symbols += e.report.counts.symbols;
      for (const s of states) totals.byState[s] += e.report.counts.byState[s] ?? 0;
      for (const s of SOURCES) totals.bySource[s] += e.report.counts.bySource[s];
      return { path: e.path, valid: true, errors: [], rubric: e.rubric, ...e.report };
    });
    for (const e of entries) if (!e.valid) stderr.write(refusalText(e));
    const doc = { tool: 'pack-conformance', specVersion: SPEC_VERSION, strict: flags.strict, ...(waivers ? { waivers: { file: flags.waivers, counts: waivers.counts } } : {}), packs, totals, exitCode };
    stdout.write(JSON.stringify(doc, null, 2) + '\n');
    return exitCode;
  }

  for (const e of entries) {
    if (!e.valid) stderr.write(refusalText(e));
    else stdout.write(summaryText(e, { quiet: flags.quiet }));
  }
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
