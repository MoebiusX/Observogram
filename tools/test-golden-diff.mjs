#!/usr/bin/env node
/**
 * tools/test-golden-diff.mjs
 *
 * Golden-output regression gate for the DIFF ENGINE (tools/lib/diff.mjs
 * diffPacks). Every case below runs diffPacks over a fixed pair of adapted
 * packs with fixed options and must reproduce the committed golden:
 *
 *   tools/fixtures/golden/diff/<case>.diff.json
 *
 * A golden holds two things:
 *   - `sha256` and `bytes` of JSON.stringify(diffPacks(a, b, opts)) — the
 *     WHOLE answer, every bucket entry with both artefacts, so a byte that
 *     moves anywhere fails the case;
 *   - a readable projection of the same answer (pack metadata, scope,
 *     collisions, summary, and per layer every entry's key, ids, match,
 *     deltas, side and reason), so an intended change reviews as a diff of
 *     keys and buckets rather than as a new hash.
 *
 * Why: the goldens were written from the engine as it stood before rebadge
 * batch 3 touched diff.mjs (a snapshot's scope parking, identity modes).
 * Those changes must leave the default answer byte-identical: no later
 * commit regenerates these files. The cases cover the catalogue's self-diffs
 * (the pairs the board suite renders, the typed fixture with and without its
 * taxonomy override), payment-service and krystaline-repo-carlos against
 * production-curated in every scope mode and with a service override, the
 * remediation-flow pairs (a drifted and a removed alert rule, a removed burn
 * alert) and a pack whose producer could not observe some families (the
 * notObserved bucket on either side, and scaffold parking).
 *
 * To update after an INTENDED output change (never for rebadge batch 3):
 *   node tools/test-golden-diff.mjs --update
 * then review `git diff tools/fixtures/golden/diff/`. Exit 0 = pass.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import * as artefactClassify from './lib/artefact-classify.mjs';
import { bindTaxonomy } from '../studio/taxonomy.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GOLDEN_DIR = resolve(__dirname, 'fixtures/golden/diff');

const { assert, report } = createHarness({ indent: '  ', truncate: 200 });
const UPDATE = process.argv.includes('--update');

// The default families, as the board suite binds them.
bindTaxonomy(artefactClassify, null);

// ---------------------------------------------------------------------------
// The packs
// ---------------------------------------------------------------------------
const PAYMENT_PATH = `${SPEC_DIR}/examples/payment-service.pack.yaml`;
const CURATED_PATH = 'examples/production-curated.pack.yaml';
const KRYSTALINE_PATH = 'examples/krystaline-repo-carlos.pack.yaml';
const packFiles = (dir) => readdirSync(resolve(ROOT, dir)).filter(f => f.endsWith('.pack.yaml')).sort().map(f => `${dir}/${f}`);
const CATALOGUE = [PAYMENT_PATH, ...packFiles('examples'), ...packFiles('reference-packs')];

const readText = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const canonicalOf = (path) => (path.endsWith('.json') ? JSON.parse(readText(path)) : parseYaml(readText(path)));

/** payment-service with its three remediation triggers replaced (tools/test-remediation-flow.mjs paymentWith). */
function paymentWith(triggers, edit = () => {}) {
  const c = canonicalOf(PAYMENT_PATH);
  c.spec.remediation.forEach((r, i) => { if (triggers[i] !== undefined) r.trigger = triggers[i]; });
  edit(c);
  return c;
}

/** production-curated as a live side that could not look at dashboards nor the collector's receivers. */
function blindLive() {
  const c = canonicalOf(CURATED_PATH);
  const dash = c.spec.dashboards[0];
  c.metadata.annotations = {
    ...(c.metadata.annotations || {}),
    [`mcp.scaffold.dashboards.${dash.id}`]: 'schema-required fallback; not attested by any MCP tool',
    'observogram.unobserved.dashboard': 'the dashboards probe got no answer: HTTP 401',
    'observogram.unobserved.pipeline_receiver': 'no MCP tool exposes the collector configuration',
    'observogram.unobserved.alert_route': 'not looked at',
  };
  return c;
}

// ---------------------------------------------------------------------------
// The cases: [name, () => [aLayered, bLayered], opts]
// ---------------------------------------------------------------------------
const loadPack = (path) => adapt(canonicalOf(path));
const CASES = [];
for (const path of CATALOGUE) {
  const id = basename(path, '.pack.yaml');
  CASES.push({ name: `${id}.self`, pair: () => [loadPack(path), loadPack(path)] });
}
const TYPED = 'tools/fixtures/taxonomy/typed.pack.json';
const OVERRIDE = JSON.parse(readText('tools/fixtures/taxonomy/taxonomy.json'));
CASES.push({ name: 'typed.unmapped.self', pair: () => [canonicalOf(TYPED), canonicalOf(TYPED)] });
CASES.push({ name: 'typed.mapped.self', pair: () => [canonicalOf(TYPED), canonicalOf(TYPED)], taxonomy: OVERRIDE });
CASES.push({ name: 'typed-canonical.mapped.self', pair: () => [loadPack('tools/fixtures/taxonomy/typed-canonical.pack.json'), loadPack('tools/fixtures/taxonomy/typed-canonical.pack.json')], taxonomy: OVERRIDE });
for (const [id, path, service] of [['payment-service', PAYMENT_PATH, 'payments'], ['krystaline-repo-carlos', KRYSTALINE_PATH, 'krystalinex-server']]) {
  CASES.push({ name: `${id}.vs.production-curated`, pair: () => [loadPack(path), loadPack(CURATED_PATH)] });
  for (const scopeMode of ['service', 'family', 'all']) {
    CASES.push({ name: `${id}.vs.production-curated.${scopeMode}`, pair: () => [loadPack(path), loadPack(CURATED_PATH)], opts: { scopeMode } });
  }
  CASES.push({ name: `${id}.vs.production-curated.service-${service}`, pair: () => [loadPack(path), loadPack(CURATED_PATH)], opts: { service } });
}
// The remediation-flow pairs (tools/test-remediation-flow.mjs, "states from a real diff" and "a missing burn alert").
CASES.push({
  name: 'remediation-flow.drift',
  pair: () => {
    const b = canonicalOf(PAYMENT_PATH);
    b.spec.alerting.rules[0].for = '30m';
    b.spec.alerting.rules.splice(1, 1);
    return [adapt(paymentWith(['alert:api_availability_99_9_burn_14x_5m_1h', 'alert:PaymentServicePodRestarting', 'alert:PaymentDbConnectionPoolSaturated'])), adapt(b)];
  },
});
CASES.push({
  name: 'remediation-flow.missing-burn',
  pair: () => {
    const b = canonicalOf(PAYMENT_PATH);
    b.spec.policy.burn_rate_alerts.splice(0, 1);
    return [adapt(paymentWith(['alert:api_availability_99_9_burn_14x_5m_1h', 'alert:PaymentServicePodRestarting', 'alert:checkout_latency_99_5_p99_300ms'])), adapt(b)];
  },
});
// notObserved on either side, scaffold parked.
CASES.push({ name: 'production-curated.vs.blind-live', pair: () => [loadPack(CURATED_PATH), adapt(blindLive())] });
CASES.push({ name: 'production-curated.vs.blind-live.all', pair: () => [loadPack(CURATED_PATH), adapt(blindLive())], opts: { scopeMode: 'all' } });
CASES.push({ name: 'blind-live.vs.production-curated', pair: () => [adapt(blindLive()), loadPack(CURATED_PATH)] });
CASES.push({ name: 'krystaline-repo-carlos.vs.blind-live', pair: () => [loadPack(KRYSTALINE_PATH), adapt(blindLive())] });

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------
const idOf = (artefact) => (artefact && typeof artefact === 'object' ? artefact.id ?? null : null);
function projectEntry(e) {
  const out = { key: e.key };
  if ('side' in e) out.side = e.side;
  if ('artefact' in e) out.id = idOf(e.artefact);
  if ('a' in e) out.a = idOf(e.a);
  if ('b' in e) out.b = idOf(e.b);
  if ('match' in e) out.match = e.match;
  if ('deltas' in e) out.deltas = e.deltas;
  if ('reason' in e) out.reason = e.reason;
  return out;
}
function project(diff) {
  const layers = {};
  for (const [layerId, bucket] of Object.entries(diff.layers)) {
    const out = {};
    for (const [name, value] of Object.entries(bucket)) out[name] = Array.isArray(value) ? value.map(projectEntry) : value;
    layers[layerId] = out;
  }
  return { keys: Object.keys(diff), a: diff.a, b: diff.b, scope: diff.scope, collisions: diff.collisions, summary: diff.summary, layers };
}

function goldenOf(c) {
  const [a, b] = c.pair();
  if (c.taxonomy) bindTaxonomy(artefactClassify, c.taxonomy);
  let diff;
  try { diff = c.opts ? diffPacks(a, b, c.opts) : diffPacks(a, b); } finally { bindTaxonomy(artefactClassify, null); }
  const whole = JSON.stringify(diff);
  return {
    diff,
    text: JSON.stringify({
      case: c.name,
      opts: c.opts || null,
      taxonomy: c.taxonomy ? 'tools/fixtures/taxonomy/taxonomy.json' : null,
      sha256: createHash('sha256').update(whole).digest('hex'),
      bytes: Buffer.byteLength(whole),
      ...project(diff),
    }, null, 2) + '\n',
  };
}

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
  const x = expected.split('\n');
  const y = actual.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  assert(false, `${label}: differs from ${file} at line ${i + 1}`, y[i], x[i]);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
const files = new Set();
for (const c of CASES) {
  const file = `${c.name}.diff.json`;
  files.add(file);
  const { diff, text } = goldenOf(c);
  checkGolden(file, text, c.name);
  assert(!('identity' in diff), `${c.name}: the default answer carries no identity key`, Object.keys(diff));
  assert(goldenOf(c).text === text, `${c.name}: two runs give the same answer`);
}

process.stdout.write('\nthe cases cover every bucket\n');
const all = CASES.map(c => goldenOf(c).diff);
for (const bucket of ['onlyInA', 'onlyInB', 'inBoth', 'outOfScope', 'scaffold', 'notObserved']) {
  assert(all.some(d => d.summary[bucket] > 0), `some case fills ${bucket}`);
}
assert(all.some(d => d.summary.notObserved > 0 && Object.values(d.layers).some(l => l.notObserved.some(e => e.side === 'a')))
  && all.some(d => Object.values(d.layers).some(l => l.notObserved.some(e => e.side === 'b'))), 'notObserved is pinned on side a and on side b');
assert(all.some(d => d.collisions.length > 0), 'some case reports collisions');

if (!UPDATE && existsSync(GOLDEN_DIR)) {
  const stray = readdirSync(GOLDEN_DIR).filter(f => !files.has(f));
  assert(stray.length === 0, 'no golden without its case', stray, []);
}

report('golden diff', UPDATE ? 'diff goldens updated — review git diff tools/fixtures/golden/diff/' : 'all diff goldens byte-identical.');
