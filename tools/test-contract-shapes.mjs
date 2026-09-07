#!/usr/bin/env node
/**
 * tools/test-contract-shapes.mjs
 *
 * Tolerant response-shape contract tests for the five discovery probes,
 * against RECORDED fixtures (tools/fixtures/mcp/ — see the README there
 * for provenance and the re-record procedure).
 *
 * Four assertions per (capability × fixture):
 *   1. SHAPE   — the fixture satisfies the capability's declared shape
 *                (critical fields present; structure recognisable).
 *   2. ADAPT   — adapt(fixture) equals the committed adapted golden
 *                (tools/fixtures/mcp/adapted/). --update regenerates.
 *   3. TOLERANT— a clone of the fixture with unknown EXTRA fields injected
 *                (top-level + per-item) still passes the shape check AND
 *                adapts to the identical output. Additive upstream changes
 *                must never break a fetch.
 *   4. CRITICAL— a clone with the critical fields REMOVED fails the shape
 *                check. The gate guards removals/renames, nothing else.
 *
 * Plus the legitimate-empty case: metrics_alerts returning {groups: []}
 * (the real VM-ruler response that motivated the candidate cascade) must
 * PASS the shape check and adapt to [] — "the backend says zero" is a
 * meaningful answer, not a contract break.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBES } from './fetch-live-pack.mjs';
import { capability } from './lib/contracts/mcp-capabilities.mjs';
import { validateResponseShape, locateObjectPayload } from './lib/contracts/response-shapes.mjs';
import { STACK_SELF_METRIC_PROBES } from './lib/contracts/stack-self-metrics.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(__dirname, 'fixtures/mcp');
const ADAPTED_DIR = resolve(FIXTURE_DIR, 'adapted');
const UPDATE = process.argv.includes('--update');

const { assert, report } = createHarness({ indent: '  ', truncate: 160 });

// capability → recorded fixture(s). vmalert_rules serves BOTH rule probes
// (one payload, two adapters) — exactly how the live cascade consumes it.
const CASES = [
  { capability: 'recording_rules', fixture: 'vmalert_rules.json',
    breakCriticals: (f) => f.groups.forEach(g => g.rules.forEach(r => { delete r.expr; delete r.query; })) },
  { capability: 'alert_rules', fixture: 'vmalert_rules.json',
    breakCriticals: (f) => f.groups.forEach(g => g.rules.forEach(r => { delete r.name; delete r.record; delete r.alert; })) },
  { capability: 'dashboards', fixture: 'grafana_dashboards_search.json',
    breakCriticals: (f) => f.results.forEach(r => { delete r.uid; delete r.id; }) },
  { capability: 'scrape_configs', fixture: 'metrics_targets.json',
    breakCriticals: (f) => f.targets.forEach(t => { delete t.job; delete t.labels; }) },
  { capability: 'metric_names', fixture: 'metrics_label_values.json',
    breakCriticals: (f) => { delete f.values; delete f.data; delete f.metrics; delete f.names; } },
];

const clone = (v) => JSON.parse(JSON.stringify(v));
// Free-form maps the adapters pass through VERBATIM by design (Prometheus
// labels/annotations are arbitrary user key-values). Extras inside them are
// payload, not envelope — they SHOULD flow into the adapted output, so the
// tolerance test must not inject there.
const PASSTHROUGH_MAPS = new Set(['labels', 'annotations']);
const injectExtras = (obj) => {
  // Unknown additive fields a future upstream might ship: top-level and on
  // every envelope object, including nested rule arrays.
  const visit = (o) => {
    if (Array.isArray(o)) { o.forEach(visit); return; }
    if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {     // children first, then tag —
        if (!PASSTHROUGH_MAPS.has(k)) visit(v);     // so the tag itself isn't re-visited
      }
      o.__vendor_extra = { added: 'in-some-future-release', n: 1 };
    }
  };
  visit(obj);
  return obj;
};

if (UPDATE) mkdirSync(ADAPTED_DIR, { recursive: true });

for (const c of CASES) {
  const probe = PROBES.find(p => p.name === c.capability);
  const shapeId = capability(c.capability).responseShape;
  assert(!!probe && !!shapeId, `${c.capability}: probe adapter and declared responseShape exist`, { probe: !!probe, shapeId });
  if (!probe || !shapeId) continue;

  const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, c.fixture), 'utf8'));

  // 1. SHAPE — the recorded payload satisfies the contract.
  const v = validateResponseShape(shapeId, fixture);
  assert(v.ok && v.items > 0, `${c.capability}: recorded ${c.fixture} satisfies shape ${shapeId} (${v.items} items)`, v);

  // 2. ADAPT — pinned canonical fragment.
  const adapted = probe.adapt(clone(fixture));
  const goldenFile = resolve(ADAPTED_DIR, `${c.capability}.json`);
  const actual = JSON.stringify(adapted, null, 2) + '\n';
  if (UPDATE) {
    writeFileSync(goldenFile, actual);
  } else {
    let golden = null;
    try { golden = readFileSync(goldenFile, 'utf8'); } catch { /* missing */ }
    assert(golden !== null, `${c.capability}: adapted golden exists (run \`node tools/test-contract-shapes.mjs --update\`)`);
    if (golden !== null) {
      assert(actual === golden,
        `${c.capability}: adapt(fixture) matches the committed adapted golden`,
        actual === golden ? undefined : { expected: golden.slice(0, 200), actual: actual.slice(0, 200) });
    }
  }

  // 3. TOLERANT — unknown extras change nothing.
  const extended = injectExtras(clone(fixture));
  const vExt = validateResponseShape(shapeId, extended);
  assert(vExt.ok, `${c.capability}: shape check ignores unknown extra fields`, vExt);
  assert(JSON.stringify(probe.adapt(extended)) === JSON.stringify(adapted),
    `${c.capability}: adapt() output identical with vendor extras present`);

  // 4. CRITICAL — removing what adapt() consumes fails the gate.
  const broken = clone(fixture);
  c.breakCriticals(broken);
  const vBroken = validateResponseShape(shapeId, broken);
  assert(!vBroken.ok, `${c.capability}: shape check FAILS when critical fields are removed`, vBroken);
}

// ---------- SYNTHETIC fixtures (step 2 surfaces) ----------
//
// tools/fixtures/mcp/synthetic/ holds HAND-WRITTEN samples (each carries a
// top-level `_synthetic` marker) for shapes no recording exists for yet —
// see the fixtures README, "Provenance". Only the shape contract
// is pinned here (SHAPE / TOLERANT / CRITICAL); there are no adapted
// goldens because these capabilities have no PROBES adapter (the fetcher's
// observeAlertmanager / observeGrafana parse them directly).
//
// A RECORDING takes precedence: when `npm run record-fixtures -- --write`
// has put <fixture> at the fixtures top level (the tool's own name), that
// file is tested instead — same three assertions, plus "carries no
// `_synthetic` marker" — and the synthetic copy is ignored. The stack
// instant vectors it records land in recorded-stack/ (checked below).
const SYNTHETIC_DIR = resolve(FIXTURE_DIR, 'synthetic');
// Status payloads may be a bare list (Alertmanager /api/v2/silences) or an
// envelope; the breakers reach the list either way.
const listIn = (f, ...keys) => (Array.isArray(f) ? f : (keys.map(k => f[k]).find(Array.isArray) || []));
const SYNTHETIC_CASES = [
  { capability: 'stack_self_metrics', fixture: 'metrics_query.instant-vector.json',
    breakCriticals: (f) => f.result.forEach(r => { delete r.metric; delete r.value; delete r.values; }) },
  { capability: 'stack_self_metrics', fixture: 'metrics_query.instant-vector.prometheus-api.json',
    breakCriticals: (f) => f.data.result.forEach(r => { delete r.metric; delete r.value; delete r.values; }) },
  { capability: 'build_info_versions', fixture: 'metrics_query.instant-vector.prometheus-api.json',
    breakCriticals: (f) => { delete f.result; delete f.data; } },
  { capability: 'alertmanager_status', fixture: 'alertmanager_status.json',
    breakCriticals: (f) => { delete f.versionInfo; delete f.version; delete f.uptime; delete f.cluster; delete f.status; } },
  { capability: 'alertmanager_silences', fixture: 'alertmanager_silences.json',
    breakCriticals: (f) => listIn(f, 'silences', 'data').forEach(s => { delete s.id; delete s.status; delete s.matchers; }) },
  { capability: 'grafana_datasources', fixture: 'grafana_datasources.json',
    breakCriticals: (f) => listIn(f, 'datasources', 'data').forEach(d => { delete d.uid; delete d.id; delete d.name; }) },
  { capability: 'grafana_datasource_health', fixture: 'grafana_datasource_health.json',
    breakCriticals: (f) => { delete f.status; delete f.message; delete f.ok; if (f.data && typeof f.data === 'object') { delete f.data.status; delete f.data.message; delete f.data.ok; } } },
  { capability: 'grafana_contact_points', fixture: 'grafana_contact_points.json',
    breakCriticals: (f) => listIn(f, 'contactPoints', 'contact_points', 'data').forEach(c => { delete c.name; delete c.uid; }) },
];

for (const c of SYNTHETIC_CASES) {
  const shapeId = capability(c.capability).responseShape;
  assert(!!shapeId, `${c.capability}: declared responseShape exists`, shapeId);
  if (!shapeId) continue;
  const recordedPath = resolve(FIXTURE_DIR, c.fixture);
  const recorded = existsSync(recordedPath);
  const tag = recorded ? 'recorded' : 'synthetic';
  const fixture = JSON.parse(readFileSync(recorded ? recordedPath : resolve(SYNTHETIC_DIR, c.fixture), 'utf8'));
  if (recorded) {
    assert(fixture._synthetic === undefined,
      `${c.capability} (recorded): ${c.fixture} carries no _synthetic marker (a recording replaced the hand-written sample)`, fixture._synthetic);
  } else {
    assert(typeof fixture._synthetic === 'string' && fixture._synthetic.startsWith('hand-written'),
      `${c.capability} (synthetic): ${c.fixture} is marked _synthetic`, fixture._synthetic);
  }

  // 1. SHAPE — the marker / `_recorded` provenance is an "extra" the shape must tolerate.
  const v = validateResponseShape(shapeId, fixture);
  assert(v.ok && v.items > 0, `${c.capability} (${tag}): ${c.fixture} satisfies shape ${shapeId} (${v.items} items)`, v);

  // 3. TOLERANT — unknown extras change nothing.
  const vExt = validateResponseShape(shapeId, injectExtras(clone(fixture)));
  assert(vExt.ok, `${c.capability} (${tag}): shape check ignores unknown extra fields`, vExt);

  // 4. CRITICAL — removing what the parser consumes fails the gate.
  const broken = clone(fixture);
  c.breakCriticals(broken);
  const vBroken = validateResponseShape(shapeId, broken);
  assert(!vBroken.ok, `${c.capability} (${tag}): shape check FAILS when critical fields are removed`, vBroken);
}

// ---------- RECORDED stack instant vectors (recorder --write) ----------
//
// tools/fixtures/mcp/recorded-stack/<row id>.json — one metrics_query
// payload per family, written by the recorder with `_recorded` provenance
// (tool, family, row, product, query, outcome). Absent until a maintainer
// records against a live server; every file present must be a valid
// instant vector for a row the alias table still declares.
const RECORDED_STACK_DIR = resolve(FIXTURE_DIR, 'recorded-stack');
if (existsSync(RECORDED_STACK_DIR)) {
  const stackShape = capability('stack_self_metrics').responseShape;
  const files = readdirSync(RECORDED_STACK_DIR).filter(f => f.endsWith('.json')).sort();
  assert(files.length > 0, 'recorded-stack/: holds at least one recorded instant vector');
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(resolve(RECORDED_STACK_DIR, file), 'utf8'));
    const rowId = file.replace(/\.json$/, '');
    assert(STACK_SELF_METRIC_PROBES.some(r => r.id === rowId), `recorded-stack/${file}: names a row the alias table declares`);
    assert(fixture._recorded && typeof fixture._recorded.query === 'string' && fixture._recorded.row === rowId,
      `recorded-stack/${file}: carries _recorded provenance (query, row)`, fixture._recorded);
    const v = validateResponseShape(stackShape, fixture);
    assert(v.ok, `recorded-stack/${file}: satisfies shape ${stackShape} (${v.items} items)`, v);
  }
} else {
  assert(true, 'recorded-stack/: absent — no live recording yet (synthetic instant vectors pin the shape)');
}

// Instant-vector edge cases the sampler relies on: an empty result is a
// legitimate answer (outcome 'empty'); a non-object is not a payload.
const vNoSeries = validateResponseShape('instant-vector', { result: [] });
assert(vNoSeries.ok && vNoSeries.items === 0, 'metrics_query { result: [] }: empty instant vector PASSES (zero series is an answer)', vNoSeries);
const vBadEnvelope = validateResponseShape('instant-vector', { status: 'success', data: { resultType: 'vector' } });
assert(!vBadEnvelope.ok, 'metrics_query envelope without a result list FAILS the shape check', vBadEnvelope);
const vObjAsList = validateResponseShape('status-object', { silences: [] });
assert(!vObjAsList.ok, 'status-object: a response without any status key FAILS', vObjAsList);
const vWrapped = validateResponseShape('health-object', { data: { status: 'ERROR', message: 'synthetic' } });
assert(vWrapped.ok, 'health-object: a { data: {...} } envelope is located', vWrapped);
// Envelope-first: a Prometheus-API-style wrapper carries the generic key
// `status` at its root — the located payload must be the INNER document,
// so a wrapped error never reads as a healthy status.
const envHealth = { status: 'success', data: { status: 'ERROR', message: 'connection refused' } };
assert(validateResponseShape('health-object', envHealth).ok, 'health-object: { status: success, data: {...} } envelope passes');
assert(locateObjectPayload('health-object', envHealth) === envHealth.data,
  'health-object: the located payload is the inner data document, not the success wrapper', locateObjectPayload('health-object', envHealth));
const envStatus = { status: 'success', data: { versionInfo: { version: '0.27.0' }, cluster: { status: 'ready' } } };
assert(locateObjectPayload('status-object', envStatus) === envStatus.data,
  'status-object: the located payload is the inner data document, not the success wrapper', locateObjectPayload('status-object', envStatus));
const bareStatus = { versionInfo: { version: '0.27.0' }, cluster: { status: 'ready' }, data: { unrelated: true } };
assert(locateObjectPayload('status-object', bareStatus) === bareStatus,
  'status-object: a bare document whose `data` carries no status key still locates at the root');
assert(locateObjectPayload('health-object', { silences: [] }) === null, 'locateObjectPayload is null when no candidate carries the key group');
assert(locateObjectPayload('silences', { silences: [] }) === null, 'locateObjectPayload is null for list shapes');
const vArray = validateResponseShape('health-object', [{ status: 'OK' }]);
assert(!vArray.ok, 'health-object: a list is not an object payload', vArray);

// Legitimate-empty: the real Krystaline metrics_alerts response.
const empty = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'metrics_alerts.empty.json'), 'utf8'));
const vEmpty = validateResponseShape('rule-groups', empty);
assert(vEmpty.ok && vEmpty.items === 0,
  'metrics_alerts {groups: []}: empty payload PASSES the shape check (zero is an answer)', vEmpty);
const recProbe = PROBES.find(p => p.name === 'recording_rules');
assert(Array.isArray(recProbe.adapt(empty)) && recProbe.adapt(empty).length === 0,
  'metrics_alerts {groups: []}: adapts to [] so the cascade falls through to the next candidate');

if (UPDATE) {
  process.stdout.write('adapted goldens updated — review git diff tools/fixtures/mcp/adapted/\n');
  process.exit(0);
}

report('contract-shapes', 'recorded MCP payloads satisfy their declared shapes; extras tolerated, criticals enforced.');
