#!/usr/bin/env node
/**
 * tools/upconvert-legacy.mjs — convert a previous-format (layered JSON)
 * pack into a canonical ObservabilityPack manifest (the vendored spec, tools/lib/validator.mjs SPEC_VERSION).
 *
 *   node tools/upconvert-legacy.mjs examples/legacy/production-curated.json
 *   node tools/upconvert-legacy.mjs old-pack.json -o new-pack.pack.json
 *   node tools/upconvert-legacy.mjs old-pack.json -o new-pack.pack.json          # again: MERGES into the existing output
 *   node tools/upconvert-legacy.mjs old-pack.json --merge edited.pack.yaml        # merge base named explicitly
 *   node tools/upconvert-legacy.mjs old-pack.json -o new-pack.pack.json --overwrite
 *
 * Idempotent and merge-safe (tools/lib/legacy.mjs):
 *   - a CANONICAL input (apiVersion/kind) is never converted: it is validated and passed through unchanged;
 *   - a LEGACY input whose `-o` target already holds a canonical pack MERGES into it — the existing pack wins
 *     for every artefact it has, the upconvert only adds artefacts whose legacy item it has never seen — so no
 *     real value an operator typed can regress to a scaffold; `--overwrite` restores the plain write.
 *
 * Output is canonical JSON (the spec accepts JSON or YAML manifests); the input and the merge base may be
 * JSON or YAML. The conversion report goes to stderr so stdout stays pipeable.
 *
 *   exit 0  converted · merged · already canonical (passed through)
 *   exit 1  input neither legacy nor canonical · merge base refused · result invalid
 *   exit 2  usage
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { isLegacyLayeredPack, upconvertLegacyPack, mergeUpconvert } from './lib/legacy.mjs';
import { validateCanonical, SPEC_VERSION, SPEC_SCHEMA_PATH } from './lib/validator.mjs';

const USAGE = `usage: node tools/upconvert-legacy.mjs <legacy-pack.json | pack.json|yaml> [-o out.pack.json] [--merge <existing.pack.json|yaml>] [--overwrite]
  -o <file>        write the result there; an existing canonical file is MERGED into (the existing pack wins)
  --merge <file>   merge into this canonical pack instead of the -o file
  --overwrite      replace an existing -o file instead of merging into it
exit 0  converted · merged · already canonical (passed through)
exit 1  input neither legacy nor canonical · merge base refused · result invalid
exit 2  usage`;

const args = process.argv.slice(2);
let input = null; let output = null; let mergeBase = null; let overwrite = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-o') output = args[++i] ?? null;
  else if (a === '--merge') mergeBase = args[++i] ?? null;
  else if (a === '--overwrite') overwrite = true;
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else if (a.startsWith('-')) { console.error(`unknown flag: ${a}\n${USAGE}`); process.exit(2); }
  else if (input === null) input = a;
  else { console.error(`unexpected argument: ${a}\n${USAGE}`); process.exit(2); }
}
if (!input || (args.includes('-o') && !output) || (args.includes('--merge') && !mergeBase)) {
  console.error(USAGE);
  process.exit(2);
}

// validate-pack.mjs's loader, copied (JSON by extension, YAML otherwise, try both).
function loadPack(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  try { return parseYaml(text); } catch { return JSON.parse(text); }
}
const isCanonical = (x) => !!x && typeof x === 'object' && !Array.isArray(x)
  && x.apiVersion === 'observability.platform/v1' && x.kind === 'ObservabilityPack';

const SCHEMA = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', SPEC_SCHEMA_PATH), 'utf8'));
const firstErrors = (errors, n) => errors.slice(0, n).map(e => `  ${e}`).join('\n');
const write = (obj) => {
  const json = JSON.stringify(obj, null, 2) + '\n';
  if (output) { writeFileSync(output, json); console.error(`wrote ${output}`); } else process.stdout.write(json);
};
const markerCount = (pack) => Object.keys(pack.metadata?.annotations || {}).filter(k => /^(crawler\.scaffold|mcp\.scaffold|library\.todo)\./.test(k)).length;

let raw;
try { raw = loadPack(input); } catch (e) { console.error(`${input}: ${e.message}`); process.exit(1); }

// ----- canonical input: pass through unchanged -----
if (isCanonical(raw)) {
  const errors = validateCanonical(raw, SCHEMA);
  if (errors.length) {
    console.error(`${input}: already a canonical ObservabilityPack but not valid against spec v${SPEC_VERSION}:\n${firstErrors(errors, 3)}`);
    process.exit(1);
  }
  if (output && existsSync(output) && !overwrite) {
    console.error(`${output} exists; nothing to merge (both are canonical) — pass --overwrite to replace it`);
    process.exit(1);
  }
  write(raw);
  console.error(`${input}: already a canonical ObservabilityPack (spec v${SPEC_VERSION}) — nothing to convert; ${markerCount(raw)} scaffold marker(s) remain (node tools/pack-conformance.mjs ${input} lists them)`);
  process.exit(0);
}
if (!isLegacyLayeredPack(raw)) {
  console.error(`${input}: not a legacy layered pack and not a canonical ObservabilityPack — nothing to convert`);
  process.exit(1);
}

// ----- legacy input: convert, then merge when a canonical base exists -----
const fresh = upconvertLegacyPack(raw, { now: new Date().toISOString() });
const basePath = mergeBase ?? (output && existsSync(output) && !overwrite ? output : null);

if (basePath) {
  let base;
  try { base = loadPack(basePath); } catch { base = null; }
  if (!isCanonical(base)) {
    console.error(`${basePath}: not a canonical ObservabilityPack — refusing to merge; pass --overwrite to replace it`);
    process.exit(1);
  }
  const baseErrors = validateCanonical(base, SCHEMA);
  if (baseErrors.length) {
    console.error(`${basePath}: not valid against spec v${SPEC_VERSION} — fix it or pass --overwrite:\n${firstErrors(baseErrors, 3)}`);
    process.exit(1);
  }
  const { canonical, report } = mergeUpconvert(fresh, base);
  const errors = validateCanonical(canonical, SCHEMA);
  if (errors.length) {
    console.error(`merge produced an invalid manifest (bug — please report):\n  ${errors.join('\n  ')}`);
    process.exit(1);
  }
  write(canonical);
  console.error(`merged ${input} into ${basePath}: kept ${report.kept} artefact(s) from ${basePath}, added ${report.added} new, skipped ${report.skipped} (removed before, or schema-required stubs); ${report.scaffoldCount} scaffold marker(s) remain${report.danglingRefs ? `; ${report.danglingRefs} added item(s) reference an SLI/SLO the base no longer has` : ''}`);
  process.exit(0);
}

const { canonical, report } = fresh;
const errors = validateCanonical(canonical, SCHEMA);
if (errors.length) {
  console.error(`upconvert produced an invalid manifest (bug — please report):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
write(canonical);
console.error(`upconverted ${input}: ${report.mapped} legacy artefacts mapped, ${report.scaffolded} scaffold placeholders (node tools/pack-conformance.mjs ${output ?? '-'} lists what needs real values)`);
for (const n of report.notes) console.error(`  - ${n}`);
