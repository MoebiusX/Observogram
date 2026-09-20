#!/usr/bin/env node
/**
 * tools/upconvert-legacy.mjs — convert a previous-format (layered JSON)
 * pack into a canonical ObservabilityPack v1.2 manifest.
 *
 *   node tools/upconvert-legacy.mjs examples/legacy/production-curated.json
 *   node tools/upconvert-legacy.mjs old-pack.json -o new-pack.pack.json
 *
 * Output is canonical JSON (the spec accepts JSON or YAML manifests).
 * The conversion report goes to stderr so stdout stays pipeable.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isLegacyLayeredPack, upconvertLegacyPack } from './lib/legacy.mjs';
import { validateCanonical } from './lib/validator.mjs';

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('-'));
const oIdx = args.indexOf('-o');
const output = oIdx !== -1 ? args[oIdx + 1] : null;

if (!input) {
  console.error('usage: node tools/upconvert-legacy.mjs <legacy-pack.json> [-o out.pack.json]');
  process.exit(2);
}

const raw = JSON.parse(readFileSync(input, 'utf8'));
if (!isLegacyLayeredPack(raw)) {
  console.error(`${input}: not a legacy layered pack (has apiVersion/kind, or no layers) — nothing to convert`);
  process.exit(1);
}

const { canonical, report } = upconvertLegacyPack(raw, { now: new Date().toISOString() });

const SCHEMA = JSON.parse(readFileSync(new URL('../vendor/observability-pack-spec/v1.2/observability-pack.schema.json', import.meta.url), 'utf8'));
const errors = validateCanonical(canonical, SCHEMA);
if (errors.length) {
  console.error(`upconvert produced an invalid manifest (bug — please report):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

const json = JSON.stringify(canonical, null, 2) + '\n';
if (output) {
  writeFileSync(output, json);
  console.error(`wrote ${output}`);
} else {
  process.stdout.write(json);
}
console.error(`upconverted ${input}: ${report.mapped} legacy artefacts mapped, ${report.scaffolded} scaffold placeholders (run conformance to see what needs real values)`);
for (const n of report.notes) console.error(`  - ${n}`);
