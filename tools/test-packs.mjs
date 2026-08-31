#!/usr/bin/env node
/**
 * tools/test-packs.mjs
 *
 * Round-trip + conformance suite for every archived canonical pack
 * (examples/*.pack.yaml). For each pack:
 *   1. Parse the YAML.
 *   2. Validate against the vendored v1.2 schema.
 *   3. Adapt via the layered adapter.
 *   4. Assert the self-diff invariant: diffPacks(pack, pack) preserves every
 *      flat-comparable artefact with alignment/jaccard 1.0 — identity-key
 *      collisions must surface as occurrence ordinals and `collisions`
 *      entries, never as silent drops.
 *   5. Compute conformance scoring.
 *   6. Assert per-pack expected ranges (where declared).
 *
 * Pack-specific expectations live in PACK_EXPECTATIONS below. Packs not
 * listed there only need to pass schema validation, adapt without throwing,
 * and hold the self-diff invariant.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { classify } from './lib/artefact-model.mjs';
import { diffPacks } from './lib/diff.mjs';
import { evaluateConformance } from './lib/conformance.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PACKS_DIR = resolve(ROOT, 'examples');
// Catalogue reference packs were moved out of examples/ into reference-packs/
// (surfaced via the studio's Advanced → References view). Validate both
// directories so the shipped reference packs stay schema-conformant.
const REFERENCE_DIR = resolve(ROOT, 'reference-packs');
const SCHEMA = JSON.parse(readFileSync(
  resolve(ROOT, 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'),
  'utf8'
));

// Hand-curated assertion bands for the bundled packs we ship.
const PACK_EXPECTATIONS = {
  'demo-skeleton.pack.yaml': {
    tier: 'tier-3',
    conformant: true,
    mustMin: 100,
    description: 'Smallest valid pack — all tier-3 MUSTs must pass.',
  },
  'production-curated.pack.yaml': {
    tier: 'tier-2',
    conformant: false,
    mustMin: 70,
    mustMax: 95,
    description: 'Partial BAU baseline — must pass most but not all tier-2 MUSTs.',
  },
  'target-advanced.pack.yaml': {
    tier: 'tier-1',
    conformant: true,
    mustMin: 100,
    shouldMin: 80,
    description: 'Aspirational tier-1 reference — 100% MUST conformance.',
  },
  'krystaline-repo-carlos.pack.yaml': {
    // The crawled real-world pack is in the suite precisely because it holds
    // genuine identity collisions (same-severity routes, collector `otlp/2`
    // style duplicate stages). Pin the collided families so a fixture refresh
    // or identity change can't silently de-collide it.
    collidedKinds: ['alert_route', 'pipeline_processor', 'pipeline_receiver'],
    description: 'Crawled fixture — must keep exercising real identity collisions.',
  },
};

import { createHarness } from './lib/harness.mjs';
const { assert, failures, report } = createHarness();

// Panels are excluded from flat drift arithmetic (see layerArtefacts in
// tools/lib/diff.mjs); mirror that here so inBoth can be compared exactly.
function flatComparableCount(layered) {
  const l = layered.layers || {};
  return [
    ...(l.L1 || []), ...(l.L2 || []), ...(l.L2X || []), ...(l.L3 || []),
    ...(l.L4?.policy || []), ...(l.L4?.alerting || []), ...(l.L4?.healing || []),
    ...(l.L5 || []), ...(l.GOV || []),
  ].filter(a => classify(a) !== 'panel').length;
}

if (!existsSync(PACKS_DIR)) {
  process.stderr.write(`examples directory missing: ${PACKS_DIR}\n`);
  process.exit(1);
}

const collectPacks = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
  .filter(f => f.endsWith('.pack.yaml') || f.endsWith('.pack.yml'))
  .sort()
  .map(file => ({ dir, file }));

const packFiles = [...collectPacks(PACKS_DIR), ...collectPacks(REFERENCE_DIR)];

if (!packFiles.length) {
  process.stderr.write('no examples/*.pack.yaml or reference-packs/*.pack.yaml files found\n');
  process.exit(1);
}

process.stdout.write(`Found ${packFiles.length} pack(s):\n`);

for (const { dir, file } of packFiles) {
  process.stdout.write(`\n[${file}]\n`);
  const path = join(dir, file);
  let canonical;
  try {
    canonical = parseYaml(readFileSync(path, 'utf8'));
  } catch (e) {
    failures.push(`${file}: YAML parse failed: ${e.message}`);
    process.stdout.write(`  ✗ YAML parse failed: ${e.message}\n`);
    continue;
  }

  // schema
  const errs = validateCanonical(canonical, SCHEMA);
  assert(errs.length === 0, 'schema validates', errs, []);
  if (errs.length) continue;

  // adapter
  let layered;
  try {
    layered = adapt(canonical);
  } catch (e) {
    failures.push(`${file}: adapter threw: ${e.message}`);
    process.stdout.write(`  ✗ adapter threw: ${e.message}\n`);
    continue;
  }
  assert(!!layered.layers?.L1, 'adapter produced L1');
  assert(!!layered.layers?.L2, 'adapter produced L2');

  // self-diff invariant
  const flat = flatComparableCount(layered);
  const self = diffPacks(layered, adapt(JSON.parse(JSON.stringify(canonical))));
  assert(self.summary.inBoth === flat,
         'self-diff preserves every flat-comparable artefact',
         self.summary.inBoth, flat);
  assert(self.summary.onlyInA === 0 && self.summary.onlyInB === 0,
         'self-diff has no missing artefacts');
  assert(self.summary.alignment === 1 && self.summary.jaccard === 1,
         'self-diff alignment and jaccard are 1.0',
         `${self.summary.alignment}/${self.summary.jaccard}`, '1/1');
  assert(self.collisions.every(c => c.aCount > 1 || c.bCount > 1),
         'reported collisions are real identity groups');
  if (self.collisions.length) {
    process.stdout.write(`  · ${self.collisions.length} identity collision(s): ` +
      `${[...new Set(self.collisions.map(c => c.kind))].sort().join(', ')}\n`);
  }

  // conformance
  const report = evaluateConformance(canonical);
  process.stdout.write(`  tier=${report.declaredTier} · ` +
    `must=${report.must.passed}/${report.must.total} (${report.mustPercent}%) · ` +
    `should=${report.should.passed}/${report.should.total} · ` +
    `combined=${report.scorePercent}%\n`);

  const exp = PACK_EXPECTATIONS[file];
  if (!exp) {
    process.stdout.write(`  · no pack-specific expectations declared\n`);
    continue;
  }

  if (exp.collidedKinds) {
    const kinds = [...new Set(self.collisions.map(c => c.kind))].sort();
    assert(kinds.join(',') === [...exp.collidedKinds].sort().join(','),
           `identity collisions cover: ${exp.collidedKinds.join(', ')}`,
           kinds.join(','), [...exp.collidedKinds].sort().join(','));
  }
  if (exp.tier)         assert(report.declaredTier === exp.tier, `tier = ${exp.tier}`, report.declaredTier, exp.tier);
  if ('conformant' in exp) assert(report.conformant === exp.conformant, `conformant = ${exp.conformant}`, report.conformant, exp.conformant);
  if (exp.mustMin != null) assert(report.mustPercent >= exp.mustMin, `MUST% >= ${exp.mustMin}`, report.mustPercent, `>= ${exp.mustMin}`);
  if (exp.mustMax != null) assert(report.mustPercent <= exp.mustMax, `MUST% <= ${exp.mustMax}`, report.mustPercent, `<= ${exp.mustMax}`);
  if (exp.shouldMin != null) assert(
    report.should.total === 0 || (report.should.passed / report.should.total) * 100 >= exp.shouldMin,
    `SHOULD% >= ${exp.shouldMin}`,
    report.should.total === 0 ? 'no SHOULDs' : Math.round((report.should.passed / report.should.total) * 100),
    `>= ${exp.shouldMin}`,
  );
}

report('pack', `all ${packFiles.length} pack(s) pass.`);
