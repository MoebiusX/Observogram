#!/usr/bin/env node
/**
 * tools/gen-site.mjs
 *
 * Render a fleet (one or more environments) from a reference pack and site inventories: per
 * environment a derived site pack, the compiled burn-rate rules, the module's templates and
 * dashboards, and a site.json manifest, under <out>/<env>/. The generic core is
 * tools/lib/site/ (run.mjs documents the module contract); everything pack-specific comes
 * from --module, exactly like tools/gen-dashboards.mjs.
 *
 * Usage:
 *   node tools/gen-site.mjs --inventory <file> [--inventory <file>…] [--env <name|all>]
 *        [--pack <pack.yaml>] [--module <esm>] [--out sites] [--registry <file> --adapter <esm>]
 *        [--check] [--dry-run] [--strict] [--repo-url <url>] [--schema <pack schema.json>]
 *
 *   --inventory  repeatable; the files are merged (tools/lib/site/inventory.mjs)
 *   --env        the environment to render, or `all` (one partition per environment); may be
 *                omitted only when the merged inventory contains exactly one environment
 *   --pack       the reference pack; default: the unique `pack:` of the inventories, resolved
 *                relative to the inventory file that declares it
 *   --module     ESM module with the pack-specific hooks (paramsSchema, packSubstitutions,
 *                templates, perQmgr, boards, …); without it only the site pack, the burn rules
 *                and site.json are emitted
 *   --registry   a raw registry (JSON or YAML) turned into an inventory by the --adapter module's
 *                toInventory(raw); it goes through the same schema and semantic checks
 *   --out        output directory (default sites); files land under <out>/<env>/
 *   --check      validate, derive and self-check; write nothing
 *   --dry-run    like --check, and list the files that would be written
 *   --strict     warnings are errors (compileBurnRules warnings, a pack without
 *                spec.environments.<env>, module warnings)
 *   --repo-url   base URL for runbook links (default: the environment's repo_url)
 *   --schema     the ObservabilityPack JSON schema (default: the vendored schema — tools/lib/validator.mjs SPEC_VERSION)
 *
 * Exit codes: 0 ok, 1 validation or self-check failed (nothing written), 2 usage.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { run } from './lib/site/run.mjs';
import * as lib from './lib/dashboards/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const FLAGS = new Set(['--inventory', '--env', '--pack', '--module', '--out', '--registry', '--adapter', '--repo-url', '--schema']);
const SWITCHES = new Set(['--check', '--dry-run', '--strict', '--help', '-h']);
const usage = 'usage: gen-site.mjs --inventory <file> [--inventory <file>…] [--env <name|all>] [--pack <pack.yaml>] [--module <esm>] [--out <dir>] [--registry <file> --adapter <esm>] [--check] [--dry-run] [--strict] [--repo-url <url>] [--schema <file>]';
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const opts = { inventory: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help' || a === '-h') { console.log(usage); process.exit(0); }
  if (SWITCHES.has(a)) { opts[a.slice(2)] = true; continue; }
  if (!FLAGS.has(a)) die(`unknown argument ${a}\n${usage}`);
  const v = argv[++i];
  if (v === undefined || v.startsWith('--')) die(`${a} needs a value\n${usage}`);
  if (a === '--inventory') opts.inventory.push(v); else opts[a.slice(2)] = v;
}
if (!opts.inventory.length && !opts.registry) die(`at least one --inventory (or --registry with --adapter) is required\n${usage}`);
if (Boolean(opts.registry) !== Boolean(opts.adapter)) die(`--registry and --adapter go together\n${usage}`);

const read = (p, what) => { try { return readFileSync(p, 'utf8'); } catch (e) { return die(`cannot read ${what} ${p}: ${e.message}`); } };
const inventories = opts.inventory.map(p => ({ name: p, text: read(resolve(p), 'inventory') }));

// the pack: --pack, else the unique `pack:` of the inventories (relative to the file that declares it)
let packPath = opts.pack ? resolve(opts.pack) : null;
if (!packPath) {
  const declared = [];
  for (const inv of inventories) {
    let doc; try { doc = parseYaml(inv.text); } catch { continue; }
    if (doc?.pack) declared.push(resolve(dirname(resolve(inv.name)), doc.pack));
  }
  const unique = [...new Set(declared)];
  if (unique.length !== 1) die(unique.length ? `the inventories name different packs (${unique.join(', ')}): pass --pack` : `no --pack and no inventory declares one\n${usage}`);
  packPath = unique[0];
}
const packText = read(packPath, 'pack');
let pack; try { pack = parseYaml(packText); } catch (e) { die(`${packPath}: ${e.message}`, 1); }
const schema = JSON.parse(read(opts.schema ? resolve(opts.schema) : resolve(HERE, '..', SPEC_SCHEMA_PATH), 'pack schema'));
const packErrors = validateCanonical(pack, schema);
if (packErrors.length) { for (const e of packErrors) console.error(`✗ ${packPath}: ${e}`); process.exit(1); }
const inventorySchema = JSON.parse(read(resolve(HERE, 'lib', 'site', 'inventory.schema.json'), 'inventory schema'));

const load = async (p, what) => { try { return await import(pathToFileURL(resolve(p)).href); } catch (e) { return die(`cannot load ${what} ${p}: ${e.message}`); } };
const module = opts.module ? await load(opts.module, 'module') : null;
const adapter = opts.adapter ? await load(opts.adapter, 'adapter') : null;
const registry = opts.registry ? read(resolve(opts.registry), 'registry') : undefined;

// packChosen: the pack is settled above (--pack, or the unique declared path), so inventories that
// spell the same pack differently (one file per directory) are not a merge error
const r = run({ pack, packText, schema, inventorySchema, inventories, env: opts.env ?? null, module, adapter, registry, repoUrl: opts['repo-url'] ?? null, strict: Boolean(opts.strict), lib, packChosen: true });
for (const w of r.warnings) console.error(`warning: ${w}`);
if (r.errors.length) { for (const e of r.errors) console.error(`✗ ${e}`); process.exit(r.usage ? 2 : 1); }

const out = resolve(opts.out || 'sites');
const write = !(opts.check || opts['dry-run']);
for (const [env, p] of Object.entries(r.partitions)) {
  const m = p.manifest;
  console.log(`${env}: ${m.instances.length} ${m.instance_kind.title}${m.instances.length === 1 ? '' : 's'}, ${m.hosts.length} host${m.hosts.length === 1 ? '' : 's'}, ${p.files.length} files → ${write ? resolve(out, env) : '(not written)'} (step ${m.timing.step}s, vantage ${m.vantage}, profile ${m.profile}, burn ${m.burn.alerts} alerts/${m.burn.recording} recording${m.removed.length ? `, removed ${m.removed.join('; ')}` : ''})`);
  if (opts['dry-run']) for (const f of p.files) console.log(`  ${env}/${f.path}`);
  if (write) for (const f of p.files) { const target = resolve(out, env, f.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, f.content); }
}
if (r.fleet) {
  for (const f of r.fleet.files) {
    if (opts['dry-run']) console.log(`  ${f.path}`);
    if (write) { const target = resolve(out, f.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, f.content); }
  }
  console.log(`fleet: ${r.fleet.files.length} file${r.fleet.files.length === 1 ? '' : 's'}${write ? ` → ${out}` : ' (not written)'}`);
}
if (!write) console.log(`${opts.check ? 'check' : 'dry run'} ok: ${r.selected.join(', ')}`);
