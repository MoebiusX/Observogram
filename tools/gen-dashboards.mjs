#!/usr/bin/env node
/**
 * tools/gen-dashboards.mjs
 *
 * Generate Grafana dashboards for an ObservabilityPack: one JSON per `spec.dashboards[]`
 * entry, in the pack's own section order, with every declared `panel_bindings[].binds_to`
 * bound by a panel (checked before writing). The visual system and the pack-derived blocks
 * are tools/lib/dashboards/lib.mjs; the per-board assembly is tools/lib/dashboards/generic.mjs.
 *
 * Usage:
 *   node tools/gen-dashboards.mjs --pack reference-packs/grafana.pack.yaml [--out-dir <dir>]
 *                                 [--module <pack-module.mjs>] [--repo-url <url>] [--dry-run]
 *
 *   --out-dir   where the JSON files go (default: <pack directory>/dashboards); a `source:`
 *               dashboard keeps the basename of its source, a template one is <id>.json
 *   --module    an ESM module for pack-specific content: `configure(pack)` (displayName,
 *               sloLabel map, certSel, repoUrl), `sliTiles(pack, ids)` and `signals[boardId]`
 *               (extra panels), or `boards(api)` to take over the whole build
 *   --repo-url  base URL for runbook links in the remediation table
 *   PACK        environment variable, same as --pack
 *
 * Exit codes: 0 written, 1 a declared binding has no panel (nothing written), 2 usage.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { genericBoards, checkBindings } from './lib/dashboards/generic.mjs';
import * as lib from './lib/dashboards/lib.mjs';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const packPath = opt('--pack') || process.env.PACK;
if (!packPath) { console.error('usage: gen-dashboards.mjs --pack <pack.yaml> [--out-dir <dir>] [--module <file>] [--repo-url <url>] [--dry-run]'); process.exit(2); }
const pack = parseYaml(readFileSync(resolve(packPath), 'utf8'));
const outDir = resolve(opt('--out-dir') || resolve(dirname(resolve(packPath)), 'dashboards'));
const modulePath = opt('--module');
const module = modulePath ? await import(pathToFileURL(resolve(modulePath)).href) : null;

let boards;
if (module?.boards) {
  boards = module.boards({ pack, lib, repoUrl: opt('--repo-url') });
} else {
  boards = genericBoards(pack, { module, repoUrl: opt('--repo-url') });
}
const problems = checkBindings(pack, boards);
if (problems.length) { for (const p of problems) console.error(`✗ ${p}`); process.exit(1); }
if (!argv.includes('--dry-run')) {
  mkdirSync(outDir, { recursive: true });
  for (const b of boards) writeFileSync(resolve(outDir, b.file), JSON.stringify(b.dashboard, null, 2) + '\n');
}
const panels = boards.reduce((n, b) => n + (b.dashboard.panels || []).filter(p => p.type !== 'row').length, 0);
console.log(`${pack.metadata.name}@${pack.metadata.version}: ${boards.length} dashboards, ${panels} panels → ${basename(outDir)}/ (${boards.map(b => b.file).join(', ')})${boards.some(b => b.skipped) ? `; unrendered templates: ${boards.filter(b => b.skipped).map(b => b.skipped).join(', ')}` : ''}`);
