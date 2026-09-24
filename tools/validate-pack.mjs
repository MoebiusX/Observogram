#!/usr/bin/env node
/**
 * tools/validate-pack.mjs
 *
 * Validate ObservabilityPack manifests against the vendored canonical
 * spec schema (SPEC_VERSION). Thin CLI wrapper over tools/lib/validator.mjs.
 *
 * The studio supports the canonical manifest shape only:
 *   apiVersion: observability.platform/v1
 *   kind: ObservabilityPack
 *
 * Usage:
 *   node tools/validate-pack.mjs <pack.yaml|pack.json> [...]
 *
 * Exit codes:
 *   0  all valid
 *   1  one or more invalid (errors to stderr)
 *   2  invocation error
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(
  __dirname, '..',
  'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`,
  'observability-pack.schema.json',
);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

function loadPack(path) {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.yaml' || ext === '.yml') return parseYaml(text);
  try { return parseYaml(text); } catch (_) { return JSON.parse(text); }
}

function validateOne(path) {
  const out = { path, errors: [] };
  let pack;
  try { pack = loadPack(path); }
  catch (e) { out.errors.push(e.message); return out; }
  out.errors = validateCanonical(pack, SCHEMA);
  return out;
}

const files = process.argv.slice(2);
if (!files.length) {
  process.stderr.write('Usage: node tools/validate-pack.mjs <pack.yaml|pack.json> [...]\n');
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  const { path, errors } = validateOne(f);
  if (errors.length) {
    bad++;
    process.stderr.write(`✗ ${path}\n`);
    errors.forEach(e => process.stderr.write(`    ${e}\n`));
  } else {
    process.stdout.write(`✓ ${path}  [spec v${SPEC_VERSION}]\n`);
  }
}
process.exit(bad ? 1 : 0);
