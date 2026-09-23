#!/usr/bin/env node
/**
 * tools/pack-init.mjs — `packc init`: build a pack from the library (docs/BUILD_JOURNEY.md).
 *
 *   packc init --list                       the entries (id, kind, evidence, SLIs per tier)
 *   packc init --show <entry>               params, SLIs per tier, per-tier objectives, evidence
 *   packc init --entry <id>[,<id>] --tier tier-1|tier-2|tier-3 --name <service>
 *              [--env <environment>] [--owner <team>]... [--param k=v]... [--slis a,b | --sli <id>]...
 *              [--override <sli>.<id|objective|window|threshold|semconv_metric>=<value>]...
 *              [--no-slos] [--no-policy] [--no-routes] [--no-dashboards] [--no-validation]
 *              [--out <file>] [--json] [--library <dir>]
 *
 * The tier is a seed, not a gate (docs/BUILD_JOURNEY.md "The seed and the copies"): --slis / --sli
 * takes any SLI of the chosen entries, above the tier too (it starts from its own tier's profile), and
 * --override edits a selected SLI's id (a rename: the SLO, the rule and the bindings follow; the SLI
 * is still addressed by its library id), objective, window, threshold or semconv_metric (the
 * copy-on-write the engine applies; a query, good or total is edited in the studio or in the pack
 * file — the CLI does not take PromQL on the command line, and it takes no custom SLI in this slice).
 * An override for an SLI not in the pack is a warning [override], not an error.
 *
 * The pack (YAML) goes to stdout or --out; the todo list and the validation summary go to
 * stderr, so `packc init … > pack.yaml` yields a clean file. Exit codes follow the repo's
 * tools (tools/validate-pack.mjs, packc journey): 0 ok · 1 the produced pack does not
 * validate against the v1.2 schema, fails a MUST clause of its tier (a section toggled off, a
 * --slis selection with no latency SLO: `packc journey`'s "gate failed", so a CI caller can tell
 * MUST 14/15 from 15/15), an SLI is not valid PromQL once the --param values are in (the Lezer
 * grammar, tools/lib/promql-lezer.mjs), or an entry fails validateLibraryEntry · 2 usage error
 * (a --param value carrying a quote, a backslash or a control character is one).
 *
 * Node-only: reads the library from disk through server/library.mjs; every decision is in
 * tools/lib/library.mjs (pure).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { instantiatePack, libraryIndex, validationSummary, TIERS, SECTION_TOGGLES, SCAFFOLD_PARAMS } from './lib/library.mjs';
import { loadLibrary, findEntry } from '../server/library.mjs';
import { parsePromqlDependencies as parsePromql } from './lib/promql-lezer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'), 'utf8'));

const USAGE = `usage: packc init --list [--library <dir>]
       packc init --show <entry>
       packc init --entry <id>[,<id>] --tier tier-1|tier-2|tier-3 --name <service> [--env <environment>]
                  [--owner <team>]... [--param k=v]... [--slis a,b | --sli <id>]...
                  [--override <sli>.<id|objective|window|threshold|semconv_metric>=<value>]...
                  [--no-slos] [--no-policy] [--no-routes] [--no-dashboards] [--no-validation]
                  [--out <file>] [--json]`;

/** What --override takes on the command line: the scalar fields. PromQL is edited in the studio or the pack file. */
const CLI_OVERRIDE_FIELDS = ['id', 'objective', 'window', 'threshold', 'semconv_metric'];
/** The scalar overrides that are numbers on the command line; the rest stay strings. */
const CLI_NUMERIC_OVERRIDES = ['objective', 'threshold'];
const VALUE_FLAGS = new Set(['--entry', '--tier', '--name', '--env', '--owner', '--param', '--slis', '--sli', '--override', '--out', '--library', '--show']);
const BOOL_FLAGS = new Set(['--list', '--json', '--help', '-h', ...SECTION_TOGGLES.map(s => `--no-${s}`)]);

function usageError(msg) {
  process.stderr.write(`packc init: ${msg}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  // A null-prototype map: `--override __proto__.objective=0.5` must reach the engine (which refuses the key), not
  // set the plain object's prototype and vanish (measured: exit 0, nothing customised, no warning).
  const o = { owners: [], params: {}, overrides: Object.create(null), off: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      if (a === '--list') o.list = true;
      else if (a === '--json') o.json = true;
      else if (a === '--help' || a === '-h') o.help = true;
      else o.off.add(a.slice('--no-'.length));
      continue;
    }
    if (!VALUE_FLAGS.has(a)) usageError(`unknown argument ${a}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) usageError(`${a} needs a value`);
    i++;
    switch (a) {
      case '--entry': o.entry = v; break;
      case '--tier': o.tier = v; break;
      case '--name': o.name = v; break;
      case '--env': o.env = v; break;
      case '--owner': o.owners.push(v); break;
      case '--slis': case '--sli': o.slis = [...(o.slis || []), ...v.split(',').map(s => s.trim()).filter(Boolean)]; break;
      case '--override': {
        // <sli>.<field>=<value>: the field is the last dot-separated segment before '=' (an SLI id carries no dot).
        const eq = v.indexOf('=');
        if (eq <= 0) usageError(`--override expects <sli>.<field>=<value>, got ${v}`);
        const lhs = v.slice(0, eq), raw = v.slice(eq + 1);
        const dot = lhs.lastIndexOf('.');
        if (dot <= 0 || dot === lhs.length - 1) usageError(`--override expects <sli>.<field>=<value>, got ${v}`);
        const sli = lhs.slice(0, dot), field = lhs.slice(dot + 1);
        if (!CLI_OVERRIDE_FIELDS.includes(field)) usageError(`--override takes id, objective, window, threshold or semconv_metric (got ${field}); a query, good or total is edited in the studio or in the pack file`);
        let value = raw;
        if (CLI_NUMERIC_OVERRIDES.includes(field)) { value = Number(raw); if (raw.trim() === '' || !Number.isFinite(value)) usageError(`--override ${sli}.${field}: a number is required, got ${JSON.stringify(raw)}`); }
        o.overrides[sli] = { ...(o.overrides[sli] || {}), [field]: value };
        break;
      }
      case '--out': o.out = v; break;
      case '--library': o.library = v; break;
      case '--show': o.show = v; break;
      case '--param': {
        const eq = v.indexOf('=');
        if (eq <= 0) usageError(`--param expects k=v, got ${v}`);
        o.params[v.slice(0, eq)] = v.slice(eq + 1);
        break;
      }
    }
  }
  return o;
}

const pad = (s, n) => String(s).padEnd(n);

function printList(library) {
  const rows = libraryIndex(library.entries);
  const w = { id: Math.max(5, ...rows.map(r => r.id.length)), kind: 9, ev: Math.max(8, ...rows.map(r => String(r.evidence.status).length)) };
  process.stdout.write(`${pad('entry', w.id)}  ${pad('kind', w.kind)}  ${pad('version', 7)}  ${pad('evidence', w.ev)}  ${pad('SLIs t3/t2/t1', 13)}  title\n`);
  for (const r of rows) {
    const c = r.sliCountByTier;
    process.stdout.write(`${pad(r.id, w.id)}  ${pad(r.kind, w.kind)}  ${pad(r.version, 7)}  ${pad(r.evidence.status, w.ev)}  ${pad(`${c['tier-3']}/${c['tier-2']}/${c['tier-1']}`, 13)}  ${r.title}\n`);
  }
  for (const err of library.errors) process.stderr.write(err.file === library.root ? `packc init: ${err.errors.join('; ')}\n` : `packc init: ${err.file} skipped: ${err.errors.join('; ')}\n`);
}

function printShow(entry) {
  const [row] = libraryIndex([entry]);
  const out = [];
  out.push(`${row.id}@${row.version} — ${row.title} (${row.kind}${row.product ? `, product ${row.product}` : ''})`);
  out.push(`  ${row.summary}`);
  out.push('');
  out.push(`evidence: ${row.evidence.status}${row.evidence.verifiedOn ? ` (verified ${row.evidence.verifiedOn})` : ''}`);
  for (const s of row.evidence.sources) out.push(`  - ${s}`);
  if (row.evidence.gaps.length) { out.push('  gaps:'); for (const g of row.evidence.gaps) out.push(`  - ${g}`); }
  out.push('');
  out.push('params (entry):');
  for (const p of row.params) out.push(`  ${pad(p.id, 20)} default ${JSON.stringify(p.default)}${p.placeholder ? '  [placeholder → todo]' : ''}  ${p.label}`);
  out.push('params (scaffold, every entry):');
  for (const p of SCAFFOLD_PARAMS) out.push(`  ${pad(p.id, 20)} default ${JSON.stringify(p.default)}${p.placeholder ? '  [placeholder → todo]' : ''}  ${p.label}`);
  out.push('');
  out.push('SLIs (objective per tier; "-" = not at that tier):');
  out.push(`  ${pad('id', 36)} ${pad('type', 10)} ${pad('minTier', 8)} ${pad('tier-3', 8)} ${pad('tier-2', 8)} ${pad('tier-1', 8)} evidence`);
  for (const s of row.slis) {
    const obj = (t) => (TIERS.indexOf(t) >= TIERS.indexOf(s.minTier) ? String(s.objectives[t]) : '-');
    out.push(`  ${pad(s.id, 36)} ${pad(s.type, 10)} ${pad(s.minTier, 8)} ${pad(obj('tier-3'), 8)} ${pad(obj('tier-2'), 8)} ${pad(obj('tier-1'), 8)} ${s.evidence}`);
    out.push(`  ${pad('', 36)} metrics: ${s.metrics.join(', ')}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(USAGE + '\n'); process.exit(0); }
  const library = loadLibrary(o.library ? { root: resolve(process.cwd(), o.library) } : {});
  const rootError = library.errors.find(e => e.file === library.root);

  if (o.list) { printList(library); process.exit(0); }
  if (o.show) {
    const entry = findEntry(library, o.show);
    if (!entry) {
      if (rootError) usageError(rootError.errors[0]);
      const bad = library.errors.find(e => e.file.includes(`/${o.show}.library.yaml`) || e.file.endsWith(`${o.show}.library.yaml`));
      if (bad) { process.stderr.write(`packc init: entry ${o.show} does not validate:\n  ${bad.errors.join('\n  ')}\n`); process.exit(1); }
      usageError(`unknown entry ${o.show} (packc init --list)`);
    }
    printShow(entry);
    process.exit(0);
  }

  if (!o.entry) usageError('--entry is required (or --list / --show)');
  if (!o.tier) usageError('--tier is required');
  if (!TIERS.includes(o.tier)) usageError(`--tier must be one of ${TIERS.join(' | ')}, got ${o.tier}`);
  if (!o.name) usageError('--name is required');
  const ids = o.entry.split(',').map(s => s.trim()).filter(Boolean);
  const entries = [];
  for (const id of ids) {
    const entry = findEntry(library, id);
    if (!entry) {
      if (rootError) usageError(rootError.errors[0]);
      const bad = library.errors.find(e => e.file.endsWith(`${id}.library.yaml`));
      if (bad) { process.stderr.write(`packc init: entry ${id} does not validate:\n  ${bad.errors.join('\n  ')}\n`); process.exit(1); }
      usageError(`unknown entry ${id} (packc init --list)`);
    }
    entries.push(entry);
  }

  const toggles = Object.fromEntries(SECTION_TOGGLES.map(s => [s, !o.off.has(s)]));
  if (o.slis) toggles.slis = o.slis;
  let result;
  try {
    result = instantiatePack(entries, { name: o.name, tier: o.tier, environment: o.env, owners: o.owners, params: o.params, toggles, overrides: o.overrides, promql: parsePromql });
  } catch (e) {
    usageError(e.message);
  }
  const { canonical, todos, provenance, warnings } = result;
  const schemaErrors = validateCanonical(canonical, SCHEMA);
  const summary = validationSummary(canonical, todos);

  if (o.json) {
    const payload = JSON.stringify({ canonical, todos, provenance, warnings, schemaErrors, summary }, null, 2) + '\n';
    if (o.out) writeFileSync(resolve(process.cwd(), o.out), payload); else process.stdout.write(payload);
  } else {
    const yaml = `# ObservabilityPack ${canonical.metadata.name} — built by packc init from ${provenance.source} at ${provenance.tier}\n# Todos: ${todos.length} (metadata.annotations library.todo.*). Spec v${SPEC_VERSION}.\n` + emitYaml(canonical);
    if (o.out) writeFileSync(resolve(process.cwd(), o.out), yaml); else process.stdout.write(yaml);
  }

  const err = (s) => process.stderr.write(s + '\n');
  const customised = Object.values(provenance.slis || {}).filter(p => p.customised.length).length;
  const aboveTier = Object.values(provenance.slis || {}).filter(p => p.aboveTier).length;
  err(`packc init: ${canonical.metadata.name}@${provenance.tier} from ${provenance.source} — ${canonical.spec.slis.length} SLI(s)${aboveTier ? ` (${aboveTier} from a higher tier's profile)` : ''}${customised ? ` (${customised} customised)` : ''}, sections ${SECTION_TOGGLES.map(s => `${s}:${toggles[s] ? 'on' : 'off'}`).join(' ')}${o.out ? ` → ${o.out}` : ''}`);
  for (const [id, p] of Object.entries(provenance.slis || {})) if (p.customised.length) err(`  customised ${id}: ${p.customised.join(', ')}${p.evidence.status === 'custom' ? ' — the library evidence no longer applies to its expression' : ''}`);
  err(`conformance @ ${summary.tier}: MUST ${summary.must.passed}/${summary.must.total}, SHOULD ${summary.should.passed}/${summary.should.total}${summary.onPlaceholder.length ? ` (${summary.onPlaceholder.length} clause(s) pass on a placeholder)` : ''}`);
  for (const f of summary.failing) err(`  ✗ ${f.id} — ${f.description}${f.todos.length ? ` [todo: ${f.todos.join(', ')}]` : ''}`);
  if (todos.length) {
    err(`todos (${todos.length}) — placeholders only the team can fill:`);
    for (const t of todos) err(`  - ${t.path}: ${t.what}${t.clauses.length ? `  [${t.clauses.join(', ')}]` : ''}`);
  }
  for (const w of warnings) err(`warning [${w.kind}]: ${w.message}`);
  const broken = warnings.filter(w => w.kind === 'promql');
  const mustFailing = summary.failing.filter(f => f.severity === 'MUST');
  if (schemaErrors.length) {
    err(`schema: the produced pack does not validate against spec v${SPEC_VERSION} (${schemaErrors.length}):`);
    for (const s of schemaErrors) err(`  ${s}`);
  } else err(`schema: valid (spec v${SPEC_VERSION})`);
  if (broken.length) err(`promql: ${broken.length} SLI expression(s) do not parse once the --param values are in (above)`);
  // A schema-valid pack that fails a MUST of its own tier is not a pack to ship: exit 1, like `packc journey` on a failed gate.
  if (mustFailing.length) err(`conformance: ${mustFailing.length} MUST clause(s) fail at ${summary.tier} (above) — the pack is not conformant at its tier`);
  process.exit(schemaErrors.length || broken.length || mustFailing.length ? 1 : 0);
}

main();
