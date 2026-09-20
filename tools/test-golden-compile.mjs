#!/usr/bin/env node
/**
 * tools/test-golden-compile.mjs
 *
 * Golden-output regression gate for the COMPILERS, per target and per
 * version band. The property suite (test-compile.mjs) asserts that specific
 * behaviours hold; this test asserts that each compiler's FULL output is
 * byte-stable across every profile band that changes a knob: a fixed pack
 * compiled for a fixed product@version must produce an artefact identical
 * to the committed golden file, and must resolve the expected band.
 *
 * Why: compiled artefacts are what users deploy to production alerting.
 * A compiler change can be locally correct and still shift emission for
 * one version band only (keep_firing_for, msteamsv2_configs, schemaVersion,
 * debug exporter naming). Property tests won't notice band-local drift —
 * this does. ANY output change, intended or not, fails CI and forces an
 * explicit golden update in the same commit, where the diff of the golden
 * file documents exactly what moved and for which band.
 *
 * To update after an INTENDED output change:
 *   node tools/test-golden-compile.mjs --update
 * then review `git diff tools/fixtures/golden/compile/` — that diff is the
 * output-space changelog of your commit. Exit 0 = pass.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { compile, compileArtifact, TARGETS } from './lib/compile.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GOLDEN_DIR = resolve(__dirname, 'fixtures/golden/compile');

const { assert, report } = createHarness({ indent: '  ', truncate: 160 });
const UPDATE = process.argv.includes('--update');

// ---------------------------------------------------------------------------
// Fixture packs. Keep this list STABLE — extending it is an intentional
// golden change. payment-service is the vendored spec example (the canonical
// "well-formed" pack); edge-hostile-names exercises label/name escaping.
// ---------------------------------------------------------------------------
const PACKS = [
  { id: 'payment-service',    path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml' },
  { id: 'edge-hostile-names', path: 'tools/fixtures/compile/edge-hostile-names.pack.yaml' },
  // Two SLOs on one SLI: the per-artifact matrix only (Grafana-managed uid/title uniqueness).
  { id: 'shared-sli',         path: 'tools/fixtures/compile/shared-sli.pack.yaml', artifactsOnly: true },
];

// ---------------------------------------------------------------------------
// The band matrix. One row per (target, product@version) whose profile band
// changes at least one knob — each row pins WHICH band resolves (selection)
// and WHAT bytes it emits (output). Versions are representatives chosen
// inside each band's semver range in tools/lib/profiles.mjs; `band` /
// `matched` / `extrapolated` are the expected resolution.
//
// prometheus@9.9 deliberately sits ABOVE every known band: it pins the
// extrapolation contract (future versions shape as the newest band rather
// than silently falling to the default).
// ---------------------------------------------------------------------------
const MATRIX = [
  { target: 'prometheus-rules', product: 'prometheus',      version: '3.0',  band: 'prom-3' },
  { target: 'prometheus-rules', product: 'prometheus',      version: '2.50', band: 'prom-2.42' },
  { target: 'prometheus-rules', product: 'prometheus',      version: '2.30', band: 'prom-2' },
  { target: 'prometheus-rules', product: 'prometheus',      version: '9.9',  band: 'prom-3', matched: false, extrapolated: true },
  { target: 'prometheus-rules', product: 'victoriametrics', version: '1.99', band: 'vm' },
  { target: 'prometheus-rules', product: 'mimir',           version: '2.15', band: 'mimir' },

  { target: 'alertmanager',     product: 'alertmanager',    version: '0.28.0', band: 'am-0.28+' },
  { target: 'alertmanager',     product: 'alertmanager',    version: '0.27.0', band: 'am-0.26' },
  { target: 'alertmanager',     product: 'alertmanager',    version: '0.25.0', band: 'am-pre-0.26' },

  { target: 'otel-collector',   product: 'otel-collector',  version: '0.96.0', band: 'otelcol-0.96+' },
  { target: 'otel-collector',   product: 'otel-collector',  version: '0.90.0', band: 'otelcol-0.86' },
  { target: 'otel-collector',   product: 'otel-collector',  version: '0.80.0', band: 'otelcol-pre-0.86' },

  { target: 'grafana-dashboard', product: 'grafana',        version: '13.0', band: 'grafana-13' },
  { target: 'grafana-dashboard', product: 'grafana',        version: '12.0', band: 'grafana-12' },
  { target: 'grafana-dashboard', product: 'grafana',        version: '11.0', band: 'grafana-11' },
  { target: 'grafana-dashboard', product: 'grafana',        version: '10.0', band: 'grafana-10' },
  { target: 'grafana-dashboard', product: 'grafana',        version: '9.5',  band: 'grafana-9' },
];

// ---------------------------------------------------------------------------
// The per-artifact matrix: the studio's compileArtifact paths that no `compile()`
// TARGET covers — the Grafana-managed flavour and the per-SLO Prometheus files —
// pinned at the pack's own declared version (no product/version override). They
// share the PromQL builders with the full rules file, so a builder change moves
// their bytes too; without a golden that drift went unseen. `packs` limits a row
// to the packs whose SLO it names.
// ---------------------------------------------------------------------------
const ARTIFACTS = [
  { group: 'rules', flavor: 'grafana-managed', artifact: 'all' },
  { group: 'rules', flavor: 'prometheus', artifact: 'slo:api_availability_99_9', packs: ['payment-service'] },
  { group: 'rules', flavor: 'prometheus', artifact: 'slo:checkout_latency_99_5_p99_300ms', packs: ['payment-service'] },
  { group: 'rules', flavor: 'grafana-managed', artifact: 'slo:checkout_latency_99_5_p99_300ms', packs: ['payment-service'] },
  { group: 'rules', flavor: 'prometheus', artifact: 'slo:hostile_availability_99', packs: ['edge-hostile-names'] },
  // Step 5: the assurance group as its own file (the per-item file the studio deploys), both flavours.
  { group: 'rules', flavor: 'prometheus', artifact: 'assurance', packs: ['payment-service'] },
  { group: 'rules', flavor: 'grafana-managed', artifact: 'assurance', packs: ['payment-service'] },
];

const artifactGoldenName = (packId, row) => {
  // ':' is not a filename character on every platform; the artifact id keeps its shape otherwise.
  const artifact = row.artifact.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `${packId}__artifact__${row.group}-${row.flavor}-${artifact}.golden.yaml`;
};

const goldenName = (packId, row) => {
  const ext = TARGETS[row.target].extension;
  // '+' is awkward in shell globs and '.' fine in names; keep it simple/flat.
  const version = row.version.replace(/\+/g, '');
  return `${packId}__${row.target}__${row.product}-${version}.golden.${ext}`;
};

if (UPDATE) mkdirSync(GOLDEN_DIR, { recursive: true });

let written = 0;
for (const pack of PACKS) {
  if (pack.artifactsOnly) continue;
  const canonical = parseYaml(readFileSync(resolve(ROOT, pack.path), 'utf8'));

  for (const row of MATRIX) {
    const id = `${pack.id} · ${row.target} @ ${row.product} ${row.version}`;
    let result = null;
    try {
      result = compile(canonical, row.target, { product: row.product, version: row.version });
    } catch (err) {
      assert(false, `${id}: compiles without throwing`, String(err && err.message || err));
      continue;
    }

    // Band SELECTION is part of the contract: the override must land on the
    // declared band with the declared matched/extrapolated flags.
    assert(result.profile.band === row.band,
      `${id}: resolves band ${row.band}`, result.profile.band);
    assert(result.profile.matched === (row.matched ?? true),
      `${id}: matched=${row.matched ?? true}`, result.profile.matched);
    assert(result.profile.extrapolated === (row.extrapolated ?? false),
      `${id}: extrapolated=${row.extrapolated ?? false}`, result.profile.extrapolated);

    const actual = String(result.content);
    assert(actual.length > 0, `${id}: emits non-empty content`);

    const file = resolve(GOLDEN_DIR, goldenName(pack.id, row));
    if (UPDATE) {
      writeFileSync(file, actual);
      written++;
      continue;
    }

    let golden = null;
    try { golden = readFileSync(file, 'utf8'); } catch (_) {}
    if (golden === null) {
      assert(false, `${id}: golden file exists (run \`node tools/test-golden-compile.mjs --update\` to create it)`,
        goldenName(pack.id, row));
      continue;
    }
    if (actual === golden) {
      assert(true, `${id}: output is byte-identical to the committed golden`);
    } else {
      // Locate the first divergence so the failure is actionable without a diff tool.
      const a = actual.split('\n'), g = golden.split('\n');
      let line = 0;
      while (line < Math.min(a.length, g.length) && a[line] === g[line]) line++;
      assert(false,
        `${id}: output drifted from the golden — if intended, regenerate with --update and review the golden diff in the same commit`,
        { golden: goldenName(pack.id, row), firstDivergenceAtLine: line + 1, expected: g[line], actual: a[line] });
    }
  }
}

for (const pack of PACKS) {
  const canonical = parseYaml(readFileSync(resolve(ROOT, pack.path), 'utf8'));
  for (const row of ARTIFACTS) {
    if (row.packs && !row.packs.includes(pack.id)) continue;
    const id = `${pack.id} · artifact ${row.group}/${row.flavor}/${row.artifact}`;
    let result = null;
    try {
      result = compileArtifact(canonical, { group: row.group, flavor: row.flavor, artifact: row.artifact });
    } catch (err) {
      assert(false, `${id}: compiles without throwing`, String(err && err.message || err));
      continue;
    }
    const actual = String(result.content);
    assert(actual.length > 0, `${id}: emits non-empty content`);
    const file = resolve(GOLDEN_DIR, artifactGoldenName(pack.id, row));
    if (UPDATE) {
      writeFileSync(file, actual);
      written++;
      continue;
    }
    let golden = null;
    try { golden = readFileSync(file, 'utf8'); } catch (_) {}
    if (golden === null) {
      assert(false, `${id}: golden file exists (run \`node tools/test-golden-compile.mjs --update\` to create it)`, artifactGoldenName(pack.id, row));
      continue;
    }
    if (actual === golden) {
      assert(true, `${id}: output is byte-identical to the committed golden`);
    } else {
      const a = actual.split('\n'), g = golden.split('\n');
      let line = 0;
      while (line < Math.min(a.length, g.length) && a[line] === g[line]) line++;
      assert(false,
        `${id}: output drifted from the golden — if intended, regenerate with --update and review the golden diff in the same commit`,
        { golden: artifactGoldenName(pack.id, row), firstDivergenceAtLine: line + 1, expected: g[line], actual: a[line] });
    }
  }
}

if (UPDATE) {
  process.stdout.write(`goldens updated (${written} files) — review git diff tools/fixtures/golden/compile/\n`);
  process.exit(0);
}

report('golden-compile', 'every (pack × target × band) and (pack × artifact) artefact matches its golden byte-for-byte.');
