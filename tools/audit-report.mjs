#!/usr/bin/env node
/**
 * tools/audit-report.mjs — a pack's service audit report as JSON or HTML.
 *
 * Thin Node CLI over tools/lib/audit-report.mjs (the model and the renderer;
 * browser-safe, vendorable), the way tools/pack-conformance.mjs wraps its
 * engine. The schema check runs first (a report over an invalid pack is
 * meaningless), the pack is graded as declared — or for one environment with
 * --env, the way GET /api/packs/:id/conformance?env= grades it — and every
 * section reads the engine it names: the rubric, pack-conformance, the
 * taxonomy, the blast radius over the traceability graph, the response path.
 *
 *   node tools/audit-report.mjs <pack.yaml|pack.json> [--env <name>] [--format json|html|both] [--out <path>]
 *       [--brand <file.json>] [--taxonomy <file.json>] [--top <n>] [--generated-at <iso> | --no-timestamp]
 *       [--verdicts <file.json>] [--waivers <file.json>] [--schema <file>]
 *     --env           grade for one declared environment (the overlay applied; the report names it)
 *     --format        json (default, stdout) · html (stdout) · both (needs --out, a directory)
 *     --out           write the file(s) there instead of stdout: a file path, or a directory that gets
 *                     <pack>.audit-report.{json,html}
 *     --brand         a brand file (tools/lib/brand.mjs normalizeBrand) for the HTML's chrome and tokens; the CLI
 *                     reads this flag only — never OBSERVOGRAM_BRAND_* — so a report is reproducible from its arguments
 *     --taxonomy      a taxonomy file (tools/lib/artefact-classify.mjs validateTaxonomy) bound for the coverage
 *                     section and the response path, as OBSERVOGRAM_TAXONOMY binds it on the server
 *     --top           the goes-blind listing size (1..100, default 10)
 *     --generated-at  the stamp, normalised to ISO; default the clock; --no-timestamp leaves it null (reproducible bytes)
 *     --verdicts      the verdicts document (GET /api/packs/:id/verdicts saved, or `{ verdicts: [...] }` / an array);
 *                     without it the section reads "not recorded by this build" — the CLI has no store
 *     --waivers       a waiver file (tools/lib/waivers.mjs readWaiverFile, the objects the API serves) — the rubric
 *                     overlay for section 1 and the rows of section 4
 *     --schema        another spec schema file (default: the vendored one)
 *
 *   exit 0  the report was written
 *   exit 1  the pack is unreadable, not canonical, previous-format or schema-invalid
 *   exit 2  usage (no file, unknown flag, a flag's file that cannot be read, an undeclared --env, an invalid stamp)
 *
 * Output is written in full before exit (UTF-8). Read-only: the tool changes nothing in the pack.
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, extname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { isLegacyLayeredPack } from './lib/legacy.mjs';
import { adapt, listEnvironments, overlaidCanonical } from './lib/adapter.mjs';
import { evaluateConformance, RUBRIC } from './lib/conformance.mjs';
import { buildDependencyGraph, graphShape } from './lib/traceability-graph.mjs';
import { compileTaxonomy, configureTaxonomy } from './lib/artefact-classify.mjs';
import { DEFAULT_BRAND, normalizeBrand } from './lib/brand.mjs';
import { applyWaiversToConformance, readWaiverFile, waiverView } from './lib/waivers.mjs';
import { DEFAULT_RISK_TOP, RISK_TOP_MAX, auditReportFilename, buildAuditReport, renderAuditReportHtml } from './lib/audit-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const RULE_IDS = new Set(RUBRIC.map((c) => c.id));
const FORMATS = ['json', 'html', 'both'];

const USAGE = `usage: node tools/audit-report.mjs <pack.yaml|pack.json> [--env <name>] [--format json|html|both] [--out <path>] [--brand <file.json>] [--taxonomy <file.json>] [--top <n>] [--generated-at <iso> | --no-timestamp] [--verdicts <file.json>] [--waivers <file.json>] [--schema <file>]
  --env <name>          grade for one declared environment (the overlay applied)
  --format <f>          json (default, stdout) · html (stdout) · both (needs --out, a directory)
  --out <path>          write there instead of stdout: a file, or a directory that gets <pack>.audit-report.{json,html}
  --brand <file.json>   the brand for the HTML's chrome and tokens (this flag only; never the environment)
  --taxonomy <file.json>  the taxonomy bound for the coverage section (as OBSERVOGRAM_TAXONOMY on the server)
  --top <n>             the goes-blind listing size (1..${RISK_TOP_MAX}, default ${DEFAULT_RISK_TOP})
  --generated-at <iso>  the stamp (default: now); --no-timestamp leaves it null for reproducible bytes
  --verdicts <file.json>  a saved GET /api/packs/:id/verdicts document (else "not recorded by this build")
  --waivers <file.json>   a waiver file ({ version: 1, waivers: [...] }) — the rubric overlay and the waivers section
  --schema <file>       another spec schema (default: the vendored one)
exit 0  written · 1  the pack is unreadable, not canonical, previous-format or schema-invalid · 2  usage
`;

// pack-conformance.mjs's loader, copied (the CLIs stay independent).
function loadPack(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  try { return parseYaml(text); } catch { return JSON.parse(text); }
}

const readJson = (path, what) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`${what} ${path}: ${e.code === 'ENOENT' ? 'file not found' : e.message}`, { cause: e }); }
};

// The rows a --verdicts file holds: the GET document, `{ verdicts }`, or an array.
function verdictsOf(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json?.verdicts) ? json.verdicts : null;
  if (!rows) throw new Error('expected the GET /api/packs/:id/verdicts document ({ verdicts: [...] }) or an array of verdict views');
  return rows;
}

/** The styles the HTML inlines: the design tokens and the kit, as the studio ships them. */
export function reportStyles() {
  return `${readFileSync(resolve(ROOT, 'studio/design-tokens.css'), 'utf8')}\n${readFileSync(resolve(ROOT, 'studio/design-kit.css'), 'utf8')}`;
}

export function parseArgs(argv) {
  const flags = { env: null, format: 'json', out: null, brand: null, taxonomy: null, top: DEFAULT_RISK_TOP, generatedAt: undefined, verdicts: null, waivers: null, schema: null, help: false };
  const files = [];
  const valued = { '--env': 'env', '--format': 'format', '--out': 'out', '--brand': 'brand', '--taxonomy': 'taxonomy', '--top': 'top', '--generated-at': 'generatedAt', '--verdicts': 'verdicts', '--waivers': 'waivers', '--schema': 'schema' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { flags.help = true; continue; }
    if (a === '--no-timestamp') { flags.generatedAt = null; continue; }
    if (a in valued) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) throw new Error(`${a} needs a value`);
      flags[valued[a]] = argv[++i];
      continue;
    }
    if (a.startsWith('-')) throw new Error(`unknown flag: ${a}`);
    files.push(a);
  }
  if (!FORMATS.includes(flags.format)) throw new Error(`--format must be one of ${FORMATS.join(', ')}`);
  if (flags.format === 'both' && !flags.out) throw new Error('--format both needs --out <directory>');
  if (flags.top !== DEFAULT_RISK_TOP) {
    const n = Number(flags.top);
    if (!Number.isInteger(n) || n < 1 || n > RISK_TOP_MAX) throw new Error(`--top must be an integer from 1 to ${RISK_TOP_MAX}`);
    flags.top = n;
  }
  if (typeof flags.generatedAt === 'string') {
    const t = new Date(flags.generatedAt);
    if (Number.isNaN(t.getTime())) throw new Error(`--generated-at is not a date: ${flags.generatedAt}`);
    flags.generatedAt = t.toISOString();
  }
  return { flags, files };
}

/**
 * The report over one pack file: { ok: true, report, html?, id } or
 * { ok: false, exitCode, error }. Pure over its arguments (the clock only
 * for the default stamp).
 */
export function auditPack(path, flags, { now = new Date().toISOString() } = {}) {
  const fail = (exitCode, error) => ({ ok: false, exitCode, error });
  let canonical;
  try { canonical = loadPack(path); }
  catch (e) { return fail(1, `✗ ${path}: ${/file not found/.test(e.message) ? 'file not found' : `unreadable — ${e.message}`}`); }
  if (isLegacyLayeredPack(canonical)) return fail(1, `✗ ${path}: previous-format (layered JSON) pack — upconvert it first: npm run upconvert-legacy -- ${path} -o ${path}.pack.json`);
  const schema = flags.schema ? readJson(flags.schema, '--schema') : JSON.parse(readFileSync(resolve(ROOT, SPEC_SCHEMA_PATH), 'utf8'));
  const errors = validateCanonical(canonical, schema);
  if (errors.length) return fail(1, `✗ ${path}: not a valid manifest (${errors.length} error(s)) — npm run validate-pack -- ${path}\n${errors.slice(0, 10).map((e) => `    ${e}\n`).join('')}`);
  const envs = listEnvironments(canonical);
  if (flags.env && !envs.includes(flags.env)) return fail(2, `--env ${flags.env}: the pack declares ${envs.length ? envs.join(', ') : 'no environment'}`);
  const { canonical: overlaid } = overlaidCanonical(canonical, flags.env);
  const adapted = adapt(overlaid);
  const engine = evaluateConformance(overlaid);
  const stamp = flags.generatedAt === undefined ? now : flags.generatedAt;
  const clock = stamp ?? now;
  let waiverRows = null;
  let report = engine;
  if (flags.waivers) {
    const { waivers } = readWaiverFile(readJson(flags.waivers, '--waivers'), { now: clock });
    waiverRows = waivers.map((w) => waiverView(w, clock));
    const rubricWaivers = waivers.filter((w) => RULE_IDS.has(w.ruleId));
    if (rubricWaivers.length) report = applyWaiversToConformance(engine, rubricWaivers, { now: clock, canonical: overlaid });
  }
  const verdicts = flags.verdicts ? verdictsOf(readJson(flags.verdicts, '--verdicts')) : null;
  const conformance = {
    environment: flags.env,
    ...report,
    tier: { graded: report.declaredTier, pack: overlaid.metadata?.bindings?.criticality ?? 'tier-3', from: 'pack', service: null, environment: null, mismatch: false },
  };
  const id = basename(path).replace(/\.pack\.(yaml|yml|json)$/i, '').replace(/\.(yaml|yml|json)$/i, '');
  const doc = buildAuditReport({
    pack: { id, label: null, source: 'file' },
    canonical: overlaid,
    adapted,
    conformance,
    graph: graphShape(buildDependencyGraph(adapted)),
    verdicts,
    waivers: waiverRows,
    environment: flags.env,
    generatedAt: stamp,
    generator: { name: 'packc audit-report', version: PKG.version },
    top: flags.top,
  });
  return { ok: true, id, report: doc };
}

export function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, now = new Date().toISOString() } = {}) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch (e) { stderr.write(`${e.message}\n${USAGE}`); return 2; }
  const { flags, files } = parsed;
  if (flags.help) { stdout.write(USAGE); return 0; }
  if (files.length !== 1) { stderr.write(`${files.length ? 'one pack at a time' : 'no pack given'}\n${USAGE}`); return 2; }
  let brand = DEFAULT_BRAND;
  try {
    if (flags.brand) brand = normalizeBrand(readJson(flags.brand, '--brand'));
    if (flags.taxonomy) configureTaxonomy(compileTaxonomy(readJson(flags.taxonomy, '--taxonomy')));
  } catch (e) {
    stderr.write(`${e.message}\n`);
    return 2;
  }
  let result;
  try { result = auditPack(files[0], flags, { now }); }
  catch (e) { stderr.write(`${e.message}\n`); return 2; }
  if (!result.ok) { stderr.write(`${result.error}${result.error.endsWith('\n') ? '' : '\n'}`); return result.exitCode; }
  const json = `${JSON.stringify(result.report, null, 2)}\n`;
  const html = () => renderAuditReportHtml(result.report, { brand, styles: reportStyles() });
  const outputs = flags.format === 'both' ? [['json', json], ['html', html()]] : [[flags.format, flags.format === 'html' ? html() : json]];
  if (!flags.out) { stdout.write(outputs[0][1]); return 0; }
  const isDir = existsSync(flags.out) && statSync(flags.out).isDirectory();
  if (flags.format === 'both' && !isDir) { stderr.write(`--out ${flags.out}: --format both needs an existing directory\n`); return 2; }
  for (const [format, text] of outputs) {
    const target = isDir ? join(flags.out, auditReportFilename(result.id, format)) : flags.out;
    writeFileSync(target, text);
    stderr.write(`wrote ${target}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
