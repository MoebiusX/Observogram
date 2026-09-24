#!/usr/bin/env node
/**
 * tools/test-validator.mjs — the vendored spec through tools/lib/validator.mjs.
 *
 * Spec 1.3 (RFC-0002) adds `good_when: below | above` to threshold and distribution SLIs and forbids
 * it on ratio and custom ones with a `not` sub-schema, the form this walker enforces. This suite
 * pins: the version constants agree with the vendored manifest and the one directory on disk; the
 * 1.3 schema accepts good_when where the spec allows it and rejects it where it does not, naming
 * the error; a bad value is named; and every pack the repo ships or tests with — all 1.2-shaped,
 * none carries good_when — validates unchanged, so a 1.2 pack reaches the same verdict. Then the
 * drift guard: no code, studio text, workflow or current-version doc names another spec version.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION, SPEC_DIR, SPEC_SCHEMA_PATH } from './lib/validator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, SPEC_SCHEMA_PATH), 'utf8'));
const EXAMPLE = resolve(ROOT, SPEC_DIR, 'examples', 'payment-service.pack.yaml');
const clone = (v) => JSON.parse(JSON.stringify(v));
const example = () => parseYaml(readFileSync(EXAMPLE, 'utf8'));
const errorsOf = (pack) => validateCanonical(pack, SCHEMA);

test('the version constants, the vendored manifest and the one directory on disk agree (spec 1.3)', () => {
  assert.equal(SPEC_VERSION, '1.3');
  assert.equal(SPEC_DIR, 'vendor/observability-pack-spec/v1.3');
  assert.equal(SPEC_SCHEMA_PATH, 'vendor/observability-pack-spec/v1.3/observability-pack.schema.json');
  const manifest = JSON.parse(readFileSync(resolve(ROOT, 'vendor/observability-pack-spec/VERSIONS.json'), 'utf8'));
  assert.equal(manifest.schema, SPEC_VERSION, 'VERSIONS.json names the spec version the validator serves');
  assert.ok(Object.keys(manifest.files).every(f => f.startsWith(`v${SPEC_VERSION}/`)), 'every vendored file sits under the current version directory');
  const dirs = readdirSync(resolve(ROOT, 'vendor/observability-pack-spec')).filter(n => /^v\d+\.\d+$/.test(n) && statSync(join(ROOT, 'vendor/observability-pack-spec', n)).isDirectory());
  assert.deepEqual(dirs, [`v${SPEC_VERSION}`], 'one version directory: 1.3 validates every 1.2 pack, so 1.2 is history (git keeps it)');
  for (const f of ['observability-pack.schema.json', 'spec.md', 'examples/payment-service.pack.yaml', 'docs/maturity-model.md']) assert.ok(existsSync(resolve(ROOT, SPEC_DIR, f)), f);
  // The schema is the 1.3 one: good_when on the SLI, forbidden by `not` on ratio and custom.
  const sli = SCHEMA.$defs.SLI;
  assert.deepEqual(sli.properties.good_when.enum, ['below', 'above']);
  assert.equal(sli.properties.good_when.default, 'below');
  const branch = (type) => sli.allOf.find(b => b.if.properties.type.const === type).then;
  assert.deepEqual(branch('ratio').properties, { good_when: { not: {} } });
  assert.deepEqual(branch('custom').properties, { good_when: { not: {} } });
  assert.equal(branch('threshold').properties, undefined);
  assert.equal(branch('distribution').properties, undefined);
  assert.match(readFileSync(resolve(ROOT, SPEC_DIR, 'spec.md'), 'utf8'), /^\| Spec version \| 1\.3 \|/m);
  // package.json validates the vendored example through the same directory.
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.validate, `node tools/validate-pack.mjs ${SPEC_DIR}/examples/payment-service.pack.yaml`);
});

test('the vendored example validates and states both directions: a ceiling declared below, a floor declared above', () => {
  const pack = example();
  assert.deepEqual(errorsOf(pack), []);
  const by = Object.fromEntries(pack.spec.slis.map(s => [s.id, s]));
  assert.equal(by.consumer_freshness.good_when, 'below');
  assert.equal(by.settlement_consumers_active.good_when, 'above');
  assert.deepEqual([by.settlement_consumers_active.type, by.settlement_consumers_active.threshold, by.settlement_consumers_active.unit], ['threshold', 2, 'consumers']);
  assert.equal(by.api_latency_p99.good_when, undefined, 'the other thresholds say nothing: absent means below');
});

test('good_when is accepted on threshold and distribution SLIs, both values, and absent', () => {
  const pack = example();
  const lat = pack.spec.slis.find(s => s.id === 'api_latency_p99');
  for (const v of ['below', 'above']) { lat.good_when = v; assert.deepEqual(errorsOf(pack), [], `threshold good_when ${v}`); }
  delete lat.good_when;
  assert.deepEqual(errorsOf(pack), []);
  pack.spec.slis.push({ id: 'api_latency_dist', type: 'distribution', query: 'http_server_request_duration_seconds_bucket', threshold: 0.5, percentile: 0.99, unit: 'seconds' });
  assert.deepEqual(errorsOf(pack), [], 'a distribution SLI without a direction');
  for (const v of ['below', 'above']) { pack.spec.slis.at(-1).good_when = v; assert.deepEqual(errorsOf(pack), [], `distribution good_when ${v}`); }
});

test('good_when is refused on ratio and custom SLIs through the `not` sub-schema, the error naming the field; a bad value is named too', () => {
  const pack = example();
  const i = pack.spec.slis.findIndex(s => s.type === 'ratio');
  pack.spec.slis[i].good_when = 'below';
  assert.deepEqual(errorsOf(pack), [`$.spec.slis[${i}].good_when: matches forbidden 'not' schema`]);
  pack.spec.slis[i].good_when = 'above';
  assert.deepEqual(errorsOf(pack), [`$.spec.slis[${i}].good_when: matches forbidden 'not' schema`]);
  delete pack.spec.slis[i].good_when;
  pack.spec.slis.push({ id: 'composite', type: 'custom', expression: 'a * b', good_when: 'above' });
  const j = pack.spec.slis.length - 1;
  assert.deepEqual(errorsOf(pack), [`$.spec.slis[${j}].good_when: matches forbidden 'not' schema`]);
  pack.spec.slis.pop();
  const lat = pack.spec.slis.findIndex(s => s.id === 'api_latency_p99');
  pack.spec.slis[lat].good_when = 'sideways';
  assert.deepEqual(errorsOf(pack), [`$.spec.slis[${lat}].good_when: not in enum ["below","above"], got "sideways"`]);
  pack.spec.slis[lat].good_when = true;
  assert.deepEqual(errorsOf(pack), [`$.spec.slis[${lat}].good_when: expected string, got boolean`]);
});

// Every schema-valid pack the repo ships or tests with, 1.2-shaped (none carries good_when): the 1.3 schema accepts
// each unchanged. (tools/fixtures/compile/ holds the compiler's SHAPE fixtures — partial packs and hostile names,
// never schema-valid under any version — so they are not here.)
const yamlPacks = (dir) => (existsSync(resolve(ROOT, dir)) ? readdirSync(resolve(ROOT, dir)).filter(f => f.endsWith('.pack.yaml')).map(f => `${dir}/${f}`) : []);
const FIXTURES = [
  ...yamlPacks('examples'), ...yamlPacks('reference-packs'), ...yamlPacks('tools/fixtures/library'),
  'tools/fixtures/site/fixture.pack.yaml', 'tools/fixtures/golden-crawl.pack.json',
];
test('every 1.2-shaped pack of the repo validates unchanged against the 1.3 schema', () => {
  assert.ok(FIXTURES.length >= 12, `fixtures found: ${FIXTURES.length}`);
  for (const rel of FIXTURES) {
    const text = readFileSync(resolve(ROOT, rel), 'utf8');
    const pack = rel.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    assert.deepEqual(errorsOf(pack), [], rel);
    assert.ok((pack.spec.slis || []).every(s => !('good_when' in s)), `${rel} is 1.2-shaped: no SLI carries good_when`);
    // The meaning is unchanged too: with an explicit `below` on every threshold / distribution SLI the pack still validates.
    const stated = clone(pack);
    for (const s of stated.spec.slis || []) if (s.type === 'threshold' || s.type === 'distribution') s.good_when = 'below';
    assert.deepEqual(errorsOf(stated), [], `${rel} with the default stated`);
  }
});

// The drift guard: the current spec version is named once (validator.mjs) and every file below follows it. A file
// that names another spec version — in a path, a banner, a studio string, a workflow step or a doc that describes
// the CURRENT spec — fails here. Historical documents (docs/CHANGELOG.md, docs/SPEC_v1.2_GAP_ANALYSIS.md, the
// upconverter's "pre-canonical" notes) are not scanned.
const walk = (dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { if (!/node_modules|fixtures|assets/.test(n)) walk(p, out); } else out.push(p); } return out; };
const SCANNED = [
  ...walk(resolve(ROOT, 'tools')).filter(p => /\.mjs$/.test(p)),
  ...walk(resolve(ROOT, 'server')).filter(p => /\.mjs$/.test(p)),
  ...walk(resolve(ROOT, 'studio')).filter(p => /\.(mjs|html)$/.test(p)),
  ...['package.json', '.github/workflows/ci.yml', 'README.md', 'docs/MODEL.md', 'docs/CONFORMANCE.md', 'docs/gen-site.md', 'docs/MCP_INTEGRATION.md', 'docs/ADAPTER.md', 'vendor/observability-pack-spec/README.md'].map(f => resolve(ROOT, f)),
];
// Lines that name an older version on purpose: the spec's own lineage, RFC-0001 (a 1.2 sibling layer), the layered
// JSON that predates the canonical manifest, the VersionSpec history — and, until the library and the studio learn
// good_when in the commits that follow this one, the two strings that still say 1.2 had no direction field.
const HISTORY = /RFC-0001|pre-v1\.2|predates (the )?canonical|Spec v1\.2 §VersionSpec|SPEC_v1\.2_GAP|spec 1\.2 → 1\.3|spec 1\.2 -> 1\.3|1\.2 pack|1\.2 packs|1\.2 SLI|1\.2 reader|1\.2 meaning|1\.2 shaped|1\.2-shaped|1\.2 fixture|1\.2 board|1\.2 commit|stopped at 1\.2|every 1\.2|a 1\.2 |v1\.2\/ → v1\.3\/|remove v1\.2\/|v1\.2\/ stays|\(1\.2\)|1\.2 could express|spec v1\.2 has no direction|ObservabilityPack v1\.2 threshold is an upper bound/;
test('no scanned file names a spec version other than the current one', () => {
  const other = new RegExp(`\\b(?:spec|Spec|canonical|schema|pack|manifest|ObservabilityPack|valid|version)\\s+v?1\\.\\d(?![.\\d])|vendor/observability-pack-spec/v1\\.\\d(?![.\\d])|\\bv1\\.\\d(?![.\\d])\\b`, 'g');
  const offenders = [];
  for (const file of SCANNED) {
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    if (rel === 'tools/test-validator.mjs') continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (HISTORY.test(line)) return;
      for (const m of line.matchAll(other)) if (!m[0].includes(SPEC_VERSION)) offenders.push(`${rel}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(offenders, [], 'every current-version mention follows SPEC_VERSION (1.3)');
});
