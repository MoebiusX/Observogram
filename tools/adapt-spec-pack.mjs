#!/usr/bin/env node
/**
 * tools/adapt-spec-pack.mjs
 *
 * CLI wrapper for tools/lib/adapter.mjs. Reads a canonical pack
 * (.yaml/.yml/.json), projects it into the studio's layered display object,
 * and writes the result as JSON to stdout.
 *
 * Usage:
 *   node tools/adapt-spec-pack.mjs <pack.yaml> [--env <name>] [--pretty]
 *
 * Flags:
 *   --env <name>   Select an environment from spec.environments. Default:
 *                  first environment in the manifest, or none if absent.
 *   --pretty       Indent the JSON output with 2 spaces.
 *
 * Exit codes:
 *   0  ok
 *   1  load / parse / adapt failure
 *   2  invocation error
 *
 * The same tools/lib/adapter.mjs module is imported by the studio HTML via
 * `<script type="module">`. Keep the module browser-friendly.
 */

import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';

const argv = process.argv.slice(2);
const files = [];
let envName = null;
let pretty = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--env') { envName = argv[++i] ?? null; }
  else if (a === '--pretty') { pretty = true; }
  else if (a.startsWith('-')) {
    process.stderr.write(`unknown flag: ${a}\n`);
    process.exit(2);
  } else {
    files.push(a);
  }
}

if (files.length !== 1) {
  process.stderr.write('Usage: node tools/adapt-spec-pack.mjs <pack.yaml> [--env <name>] [--pretty]\n');
  process.exit(2);
}

const path = files[0];
if (!existsSync(path)) {
  process.stderr.write(`file not found: ${path}\n`);
  process.exit(1);
}

let canonical;
try {
  const text = readFileSync(path, 'utf8');
  const ext = extname(path).toLowerCase();
  canonical = ext === '.json' ? JSON.parse(text) : parseYaml(text);
} catch (e) {
  process.stderr.write(`parse failed: ${e.message}\n`);
  process.exit(1);
}

let layered;
try {
  layered = adapt(canonical, { environment: envName });
} catch (e) {
  process.stderr.write(`adapt failed: ${e.message}\n`);
  process.exit(1);
}

process.stdout.write(JSON.stringify(layered, null, pretty ? 2 : 0));
process.stdout.write('\n');
