#!/usr/bin/env node
/**
 * tools/test-legacy-pack.mjs
 *
 * Previous-format support suite. The four original layered JSON packs
 * (the studio-shape format that predates canonical v1.2 — restored to
 * examples/legacy/ from git history) must upconvert into valid canonical
 * manifests that adapt and score conformance without throwing, with the
 * conversion honest (placeholder machine detail = Scaffold, never
 * Declared) and lossless (every legacy artefact preserved verbatim in
 * annotations).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { evaluateConformance } from './lib/conformance.mjs';
import { isLegacyLayeredPack, upconvertLegacyPack } from './lib/legacy.mjs';

import { createHarness } from './lib/harness.mjs';
const { assert, failures, report } = createHarness();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const LEGACY_DIR = resolve(ROOT, 'examples', 'legacy');
const SCHEMA = JSON.parse(readFileSync(
  resolve(ROOT, 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'),
  'utf8'
));

const files = readdirSync(LEGACY_DIR).filter(f => f.endsWith('.json')).sort();
assert(files.length >= 4, 'the four original legacy JSON packs ship as examples', files.length, '>= 4');

// ---- detection guards: canonical manifests must NOT be detected ----
const canonicalProbe = { apiVersion: 'observability.platform/v1', kind: 'ObservabilityPack', metadata: {}, spec: {} };
assert(!isLegacyLayeredPack(canonicalProbe), 'canonical manifest is not detected as legacy');
assert(!isLegacyLayeredPack({ layers: {} }), 'layers without id/name is not detected as legacy');
assert(!isLegacyLayeredPack({ id: 'x' }), 'id without layers is not detected as legacy');

const countItems = (L) => {
  let n = 0;
  for (const v of Object.values(L || {})) {
    if (Array.isArray(v)) n += v.length;
    else if (v && typeof v === 'object') n += (v.policy || []).length + (v.alerting || []).length + (v.healing || []).length;
  }
  return n;
};

for (const file of files) {
  process.stdout.write(`\n${file}\n`);
  const legacy = JSON.parse(readFileSync(join(LEGACY_DIR, file), 'utf8'));

  assert(isLegacyLayeredPack(legacy), 'detected as legacy layered pack');

  const { canonical, report: conv } = upconvertLegacyPack(legacy, { now: '2026-01-01T00:00:00.000Z' });

  // 1. The upconvert must produce a schema-valid canonical manifest.
  const errors = validateCanonical(canonical, SCHEMA);
  assert(errors.length === 0, 'upconverted manifest passes v1.2 schema', errors.slice(0, 3).join(' | ') || 'valid', 'no errors');

  // 2. Losslessness: every legacy artefact is preserved verbatim in
  //    legacy.artefact.<LAYER>.<ID> annotations, and the report counts it.
  const total = countItems(legacy.layers);
  const kept = Object.keys(canonical.metadata.annotations).filter(k => k.startsWith('legacy.artefact.')).length;
  assert(kept === total, 'every legacy artefact preserved in annotations', kept, total);
  assert(conv.mapped === total, 'conversion report counts every artefact', conv.mapped, total);

  // 3. The adapter + conformance run on the result without throwing.
  const adapted = adapt(canonical);
  const layerCount = Object.values(adapted.layers)
    .flatMap(v => Array.isArray(v) ? v : [...v.policy, ...v.alerting, ...v.healing]).length;
  assert(layerCount > 0, 'adapts into a non-empty layered pack', layerCount, '> 0');
  const conf = evaluateConformance(canonical);
  assert(typeof conf.mustPercent === 'number', 'conformance scores the import', typeof conf.mustPercent, 'number');

  // 4. Honesty: invented machine detail is Scaffold, never Declared.
  //    SLIs carry placeholder exprs, so every SLI artefact must be Scaffold.
  const sliCards = adapted.layers.L1.filter(a => a.id.startsWith('SLI-'));
  assert(sliCards.length > 0 && sliCards.every(a => a.source === 'Scaffold'),
    'placeholder-expr SLIs project as Scaffold', sliCards.map(a => a.source).join(','), 'all Scaffold');

  // 5. Honesty: dashboards need a source/template the legacy format never
  //    carried, so the invented file:// pointer makes them Scaffold too —
  //    and every legacy dashboard must survive into the canonical list.
  const legacyDash = (legacy.layers.L3 || []).filter(i => /^DASH/i.test(i.id || '')).length;
  if (legacyDash) {
    const dashCards = adapted.layers.L3.filter(a => a.id.startsWith('DASH-'));
    assert(dashCards.length >= legacyDash, 'every legacy dashboard survives', dashCards.length, `>= ${legacyDash}`);
    assert(dashCards.every(a => a.source === 'Scaffold'),
      'invented-source dashboards project as Scaffold', dashCards.map(a => a.source).join(','), 'all Scaffold');
  }

  // 6. GOV items survive as imports.
  const govCount = (legacy.layers.GOV || []).length;
  if (govCount) {
    assert(adapted.layers.GOV.length === govCount, 'GOV items survive as imports', adapted.layers.GOV.length, govCount);
  }

  process.stdout.write(`  · ${conv.mapped} artefacts mapped, ${conv.scaffolded} scaffolds, MUST ${conf.mustPercent}%\n`);
}

// ---- determinism: same input, same output ----
const probe = JSON.parse(readFileSync(join(LEGACY_DIR, files[0]), 'utf8'));
const a = JSON.stringify(upconvertLegacyPack(probe, { now: 'X' }).canonical);
const b = JSON.stringify(upconvertLegacyPack(probe, { now: 'X' }).canonical);
assert(a === b, 'upconvert is deterministic');

report('legacy-pack', `all ${files.length} legacy pack(s) upconvert cleanly.`);
