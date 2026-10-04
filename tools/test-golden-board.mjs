#!/usr/bin/env node
/**
 * tools/test-golden-board.mjs
 *
 * Golden-output regression gate for the Discover BOARD and the artefact
 * FAMILIES. For every catalogue pack (examples/*.pack.yaml,
 * reference-packs/*.pack.yaml and the vendored spec example) the adapted
 * pack is rendered the way studio/layers-view.mjs renders it — the board's
 * head (boardHeadHtml) and one band of groups per layer (boardGroupsHtml),
 * the entries built exactly as layerEntries()/discoverModel() build them —
 * and every artefact's family (tools/lib/artefact-model.mjs classify) is
 * written beside the rule that decided it. Both must be byte-identical to
 * the committed goldens:
 *
 *   tools/fixtures/golden/board/<pack>.board.html
 *   tools/fixtures/golden/board/<pack>.families.json
 *
 * Why: the board groups artefacts and the diff/traceability/blast-radius
 * engines key them by family. A change to the classification — a new
 * rule, a reordered one, a group that moves — must show up as a golden
 * diff reviewed in the same commit, never as a silent regrouping. The
 * families file keys entries `${layer}:${sub}:${id}` (the L4 subgroup in
 * the key, like layers-view's cardKey) and records `via` next to the
 * family, so a move from one rule to another is visible even when the
 * family it lands on is unchanged.
 *
 * To update after an INTENDED output change:
 *   node tools/test-golden-board.mjs --update
 * then review `git diff tools/fixtures/golden/board/`. Exit 0 = pass.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { classify } from './lib/artefact-model.mjs';
import { createHarness } from './lib/harness.mjs';
import { LAYER_DEFS, L4_SUBGROUPS } from '../studio/constants.mjs';
import { boardHeadHtml, boardGroupsHtml } from '../studio/discover-board.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GOLDEN_DIR = resolve(__dirname, 'fixtures/golden/board');

const { assert, report } = createHarness({ indent: '  ', truncate: 200 });
const UPDATE = process.argv.includes('--update');

// ---------------------------------------------------------------------------
// The packs: the whole catalogue the studio offers, so the proof covers every
// id family the adapter emits. Adding a pack adds a golden pair (--update).
// ---------------------------------------------------------------------------
const packFiles = (dir) => readdirSync(resolve(ROOT, dir)).filter(f => f.endsWith('.pack.yaml')).sort().map(f => `${dir}/${f}`);
const PACKS = [
  `${SPEC_DIR}/examples/payment-service.pack.yaml`,
  ...packFiles('examples'),
  ...packFiles('reference-packs'),
].map(path => ({ id: basename(path, '.pack.yaml'), path }));

// ---------------------------------------------------------------------------
// The render, mirroring studio/layers-view.mjs: layerEntries() (L4 split on
// its subgroups, `sub` null elsewhere), the entry key, the head's facts.
// ---------------------------------------------------------------------------
export function boardEntries(pack, layerId) {
  const layers = pack?.layers || {};
  const key = (sub, id) => (sub ? `${layerId}/${sub}/${id}` : `${layerId}/${id}`);
  if (layerId === 'L4') {
    const out = [];
    for (const sg of L4_SUBGROUPS) for (const a of (layers.L4?.[sg.key] || [])) out.push({ a, sub: sg.key, key: key(sg.key, a.id) });
    return out;
  }
  return (layers[layerId] || []).map(a => ({ a, sub: null, key: key(null, a.id) }));
}

export function renderBoard(pack, { env = '' } = {}) {
  const bands = LAYER_DEFS.map(def => ({ id: def.id, entries: boardEntries(pack, def.id) }));
  const artefacts = bands.flatMap(b => b.entries.map(e => e.a));
  const head = boardHeadHtml({
    meta: { ...(pack.meta || {}), service: pack.meta?.service || '' },
    env,
    total: artefacts.length,
    layers: bands.filter(b => b.entries.length > 0).length,
    artefacts,
  });
  const groups = bands
    .filter(b => !(b.id === 'L2X' && !b.entries.length))   // optional in the spec: no band when empty
    .map(b => `<!-- ${b.id} -->\n${boardGroupsHtml(b.id, b.entries)}`);
  return `${head}\n${groups.join('\n')}\n`;
}

// Which rule decided the family (tools/lib/artefact-model.mjs classify):
// the canonical `defines` symbol, else the id, else none.
const DEFINES_PREFIXES = ['slis.', 'slos.', 'telemetry.backends.', 'queries.derived_views.', 'dashboards.'];
function viaOf(a, family) {
  if (DEFINES_PREFIXES.some(p => String(a?.defines || '').startsWith(p))) return 'defines';
  return family === 'unknown' ? 'none' : 'id';
}

export function familiesOf(pack) {
  const out = {};
  for (const def of LAYER_DEFS) {
    for (const e of boardEntries(pack, def.id)) {
      const family = classify(e.a);
      out[`${def.id}:${e.sub ?? ''}:${e.a.id}`] = { family, via: viaOf(e.a, family) };
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
function checkGolden(file, actual, label) {
  const path = resolve(GOLDEN_DIR, file);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    assert(true, `${label}: golden written (${actual.length} bytes)`);
    return;
  }
  if (!existsSync(path)) { assert(false, `${label}: golden ${file} is missing (run with --update)`); return; }
  const expected = readFileSync(path, 'utf8');
  if (expected === actual) { assert(true, `${label}: byte-identical to ${file}`); return; }
  const a = expected.split('\n');
  const b = actual.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  assert(false, `${label}: differs from ${file} at line ${i + 1}`, b[i], a[i]);
}

const loadPack = (path) => adapt(parseYaml(readFileSync(resolve(ROOT, path), 'utf8')));

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const { id, path } of PACKS) {
    process.stdout.write(`\n${id}\n`);
    const pack = loadPack(path);
    checkGolden(`${id}.board.html`, renderBoard(pack), 'board');
    checkGolden(`${id}.families.json`, JSON.stringify(familiesOf(pack), null, 2) + '\n', 'families');
  }
  report('golden board', UPDATE ? 'board goldens updated — review git diff tools/fixtures/golden/board/' : 'all board goldens byte-identical.');
}
