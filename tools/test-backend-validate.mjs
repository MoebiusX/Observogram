#!/usr/bin/env node
/**
 * tools/test-backend-validate.mjs
 *
 * T1 of docs/TEST_PLAN_COMPILER_VALIDITY.md — every artifact the
 * compiler emits is validated by ITS OWN BACKEND'S validator, not by
 * shape assertions:
 *
 *   rules / prometheus      → promtool check rules
 *   alertmanager            → amtool check-config
 *   pipelines               → otelcol-contrib validate --config
 *
 * (rules/grafana-managed and dashboards need a live Grafana — T2,
 * separate suite. mimirtool and dashboard-linter arrive with P3.)
 *
 * Validators come from .tools/bin (run `npm run fetch-validators`),
 * with PATH as a fallback. A missing validator SKIPS its checks with
 * one loud line per tool — except under --strict (CI), where missing
 * tooling is a failure. Compiled artifacts are written to
 * .tools/tmp/backend-validate/ and kept after the run for debugging.
 *
 * Fixture matrix: the canonical spec example, every examples/*.pack.yaml,
 * adversarial micro-packs under tools/fixtures/compile/, plus an
 * in-memory 60-SLO scale pack. Rule: any pack the studio can load is a
 * pack the compiler must emit valid artifacts for.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SPEC_DIR } from './lib/validator.mjs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { compileCatalog, compileArtifact } from './lib/compile.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BIN_DIR = join(ROOT, '.tools', 'bin');
const OUT_DIR = join(ROOT, '.tools', 'tmp', 'backend-validate');
const EXE = process.platform === 'win32' ? '.exe' : '';
const STRICT = process.argv.includes('--strict');

const { assert, failures, report } = createHarness({ indent: '  ', truncate: 400 });

// ---------- locate validators ----------

function resolveBin(name) {
  const pinned = join(BIN_DIR, name + EXE);
  if (existsSync(pinned)) return pinned;
  // PATH fallback — useful when a dev already has the tool installed.
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (!probe.error) return name;
  return null;
}

const VALIDATORS = {
  promtool: resolveBin('promtool'),
  amtool: resolveBin('amtool'),
  'otelcol-contrib': resolveBin('otelcol-contrib'),
  mimirtool: resolveBin('mimirtool'),
  'dashboard-linter': resolveBin('dashboard-linter'),
};

// Tools with no published build for this platform are a skip even under
// --strict (mimirtool ships linux/darwin only); CI runs on linux where
// every validator exists.
const NO_BUILD_HERE = new Set(process.platform === 'win32' ? ['mimirtool'] : []);

for (const [name, path] of Object.entries(VALIDATORS)) {
  if (path) {
    let v = '';
    try { v = execFileSync(path, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0]; }
    catch (e) { v = (e.stdout || e.stderr || '').split('\n')[0]; } // amtool prints version to stderr
    process.stdout.write(`validator: ${name} → ${path} (${String(v).trim()})\n`);
  } else if (NO_BUILD_HERE.has(name)) {
    process.stdout.write(`validator: ${name} → SKIPPED (no ${process.platform} build published — runs in CI on linux)\n`);
  } else if (STRICT) {
    assert(false, `${name} available (--strict requires every validator; run npm run fetch-validators)`);
  } else {
    process.stdout.write(`validator: ${name} → SKIPPED (missing — run \`npm run fetch-validators\`; checks depending on it will not run)\n`);
  }
}

// ---------- fixture matrix ----------

const fixtureFiles = [
  { id: 'payment-service', path: `${SPEC_DIR}/examples/payment-service.pack.yaml` },
  ...readdirSync(join(ROOT, 'examples')).filter(f => f.endsWith('.pack.yaml'))
    .map(f => ({ id: f.replace(/\.pack\.yaml$/, ''), path: `examples/${f}` })),
  ...(existsSync(join(ROOT, 'tools', 'fixtures', 'compile'))
    ? readdirSync(join(ROOT, 'tools', 'fixtures', 'compile')).filter(f => f.endsWith('.pack.yaml'))
      .map(f => ({ id: `edge:${f.replace(/\.pack\.yaml$/, '')}`, path: `tools/fixtures/compile/${f}` }))
    : []),
];

// In-memory scale pack: 60 SLOs cloned from the skeleton — exercises
// large rule files and many per-SLO items without a bulky fixture file.
function makeScalePack() {
  const base = parseYaml(readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8'));
  const pack = JSON.parse(JSON.stringify(base));
  pack.metadata.name = 'edge-scale-60';
  pack.metadata.bindings.service = 'edge-scale-60';
  const sli = pack.spec.slis[0];
  const slo = pack.spec.slos[0];
  pack.spec.slis = [];
  pack.spec.slos = [];
  for (let i = 0; i < 60; i++) {
    pack.spec.slis.push({ ...sli, id: `${sli.id}_${i}` });
    pack.spec.slos.push({ ...slo, id: `${slo.id}_${i}`, sli: `${sli.id}_${i}` });
  }
  // The skeleton's declared recording rule refs the original SLI id,
  // which no longer exists after the clone — repoint it at clone #0 so
  // the ref resolves (a dangling ref is a fixture bug, not a finding).
  for (const rr of pack.spec.queries?.recording_rules || []) {
    rr.expr = String(rr.expr).replace(`ref:slis.${sli.id}`, `ref:slis.${sli.id}_0`);
  }
  return pack;
}

// ---------- runners ----------

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// Advisory findings (mimirtool best practices, dashboard-linter
// opinions) — reported, never failing. Promote rules we agree with to
// failing assertions deliberately, one by one.
const advisories = [];

let written = 0;
function emit(packId, art) {
  const dir = join(OUT_DIR, packId.replace(/[^a-z0-9_.-]/gi, '_'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, art.filename);
  writeFileSync(file, art.content);
  written++;
  return file;
}

function run(bin, args, { configFile } = {}) {
  // Packs legitimately declare deploy-time `${VAR}` / `${env:VAR}`
  // substitutions (the collector's confmap expands them at load). An
  // unset var expands to an empty value and fails validation for the
  // wrong reason — supply a dummy value per placeholder so we validate
  // STRUCTURE while keeping the emission faithful to the pack.
  const env = { ...process.env };
  if (configFile) {
    const text = readFileSync(configFile, 'utf8');
    for (const m of text.matchAll(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      if (env[m[1]] === undefined) env[m[1]] = 'validation-placeholder';
    }
  }
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, env });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { ok: r.status === 0, out, status: r.status };
}

function validatePack(fixture, canonical) {
  process.stdout.write(`\n[${fixture.id}]${fixture.path ? ` ${fixture.path}` : ' (generated in-memory)'}\n`);
  let catalog;
  try { catalog = compileCatalog(canonical); }
  catch (e) {
    assert(false, `compileCatalog does not throw`, e.message);
    return;
  }

  for (const group of catalog.groups || []) {
    // ---- rules / prometheus → promtool check rules (every item),
    //      plus mimirtool for the flavor's "Mimir-compatible" claim ----
    if (group.id === 'rules' && group.flavors.some(f => f.id === 'prometheus')) {
      for (const item of group.items) {
        const art = compileArtifact(canonical, { group: 'rules', flavor: 'prometheus', artifact: item.id });
        const file = emit(fixture.id, art);
        if (VALIDATORS.promtool) {
          const r = run(VALIDATORS.promtool, ['check', 'rules', file]);
          assert(r.ok, `promtool check rules · ${item.id} (${art.filename})`, r.out, 'exit 0');
          // A fixture may ship promtool unit tests for its full rules file
          // (`<fixture>.test.yml` next to `<fixture>.pack.yaml`): the policy
          // PromQL's behaviour, not only its syntax (a healthy service must not
          // page, a 100 % outage must). `rule_files` is resolved next to the
          // test file, so it is copied beside the emitted rules.
          const unit = fixture.path && item.id === 'all' ? join(ROOT, fixture.path.replace(/\.pack\.yaml$/, '.test.yml')) : null;
          if (unit && existsSync(unit)) {
            const testFile = join(dirname(file), 'unit.test.yml');
            writeFileSync(testFile, readFileSync(unit, 'utf8').replace(/^(rule_files:\n\s+- ).*$/m, `$1${art.filename}`));
            const t = run(VALIDATORS.promtool, ['test', 'rules', testFile]);
            assert(t.ok, `promtool test rules · ${fixture.id} (${art.filename})`, t.out, 'SUCCESS');
          }
        }
        if (VALIDATORS.mimirtool) {
          // `rules lint` rewrites the file in place — give it a copy.
          const copy = file.replace(/\.yaml$/, '.mimir.yaml');
          writeFileSync(copy, art.content);
          const lint = run(VALIDATORS.mimirtool, ['rules', 'lint', copy]);
          assert(lint.ok, `mimirtool rules lint · ${item.id} (${art.filename})`, lint.out, 'exit 0');
          // `rules check` flags best-practice findings — advisory only.
          const chk = run(VALIDATORS.mimirtool, ['rules', 'check', copy]);
          if (!chk.ok) advisories.push(`mimirtool check · ${fixture.id}/${item.id}: ${chk.out.split('\n')[0].slice(0, 140)}`);
        }
      }
    }
    // ---- dashboards → emit + dashboard-linter (advisory) ----
    if (group.id === 'dashboards') {
      for (const item of group.items.filter(i => i.id.startsWith('dash:'))) {
        const art = compileArtifact(canonical, { group: 'dashboards', flavor: 'grafana', artifact: item.id });
        const file = emit(fixture.id, art);
        if (VALIDATORS['dashboard-linter']) {
          const r = run(VALIDATORS['dashboard-linter'], ['lint', file]);
          if (!r.ok) advisories.push(`dashboard-linter · ${fixture.id}/${item.id}: ${r.out.split('\n').filter(Boolean).length} finding(s)`);
        }
      }
    }
    // ---- alertmanager → amtool check-config ----
    if (group.id === 'alertmanager') {
      const art = compileArtifact(canonical, { group: 'alertmanager', flavor: 'alertmanager-yaml', artifact: 'all' });
      const file = emit(fixture.id, art);
      if (VALIDATORS.amtool) {
        const r = run(VALIDATORS.amtool, ['check-config', file]);
        assert(r.ok, `amtool check-config (${art.filename})`, r.out, 'exit 0');
      }
    }
    // ---- pipelines → otelcol-contrib validate ----
    if (group.id === 'pipelines') {
      const art = compileArtifact(canonical, { group: 'pipelines', flavor: 'collector-yaml', artifact: 'all' });
      const file = emit(fixture.id, art);
      if (VALIDATORS['otelcol-contrib']) {
        const r = run(VALIDATORS['otelcol-contrib'], ['validate', `--config=${file}`], { configFile: file });
        assert(r.ok, `otelcol-contrib validate (${art.filename})`, r.out, 'exit 0');
      }
    }
  }
}

// ---------- main ----------

for (const fixture of fixtureFiles) {
  let canonical;
  try { canonical = parseYaml(readFileSync(join(ROOT, fixture.path), 'utf8')); }
  catch (e) {
    assert(false, `${fixture.id}: fixture parses`, e.message);
    continue;
  }
  try { validatePack(fixture, canonical); }
  catch (e) {
    failures.push(`${fixture.id}: threw ${e.message}`);
    process.stdout.write(`  ✗ ${fixture.id}: threw ${e.message}\n`);
  }
}
try { validatePack({ id: 'edge:scale-60' }, makeScalePack()); }
catch (e) {
  failures.push(`edge:scale-60: threw ${e.message}`);
  process.stdout.write(`  ✗ edge:scale-60: threw ${e.message}\n`);
}

if (advisories.length) {
  process.stdout.write(`\nADVISORY (${advisories.length}) — opinions, not validity; never failing:\n`);
  for (const a of advisories.slice(0, 20)) process.stdout.write(`  ⚠ ${a}\n`);
  if (advisories.length > 20) process.stdout.write(`  … +${advisories.length - 20} more\n`);
}
process.stdout.write(`\n${written} artifact(s) emitted under ${OUT_DIR} (kept for debugging)\n`);
report('backend-validate');
