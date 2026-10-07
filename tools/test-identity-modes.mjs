#!/usr/bin/env node
/**
 * tools/test-identity-modes.mjs — comparison identity modes (rebadge batch 3,
 * C3; RULINGS R3): tools/lib/identity-modes.mjs, the vendorable registry the
 * diff engine, the studio's Compare and a downstream share.
 *
 * Every family of the vocabulary (artefact-classify FAMILIES, iterated — a
 * family added later fails here until it has a row) has its name and id
 * material; a key always keeps the `<kind>::` prefix; names are normalised
 * (trim, collapsed spaces, lower case) and uids are not lower-cased; an
 * artefact with no name or no stable id is keyed with its side and its own
 * id, so two of them never pair; positional ids and the adapter's prose
 * titles are never material; behaviour is identityKeyOf itself; pairingOf
 * says why an artefact pairs or never pairs; an unknown mode is a TypeError
 * naming the three.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_IDENTITY_MODE, IDENTITY_MODES, identityMode, nameOf, idOf, nameKeyOf, idKeyOf, pairingOf, identityFamilies,
} from './lib/identity-modes.mjs';
import { FAMILIES } from './lib/artefact-classify.mjs';
import { identityKeyOf, classify } from './lib/artefact-model.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';

const art = (type, spec = {}, extra = {}) => ({ type, id: `${type.toUpperCase()}-01`, spec, ...extra });

// One artefact per family with every field the material tables read.
const SAMPLE = {
  dashboard: art('dashboard', { id: 'orders', params: { title: 'Orders', uid: 'ord-1' } }, { defines: 'dashboards.orders' }),
  sli: art('sli', { id: 'api_availability' }, { defines: 'slis.api_availability' }),
  slo: art('slo', { id: 'api_99' }, { defines: 'slos.api_99' }),
  derived_view: art('derived_view', { id: 'top' }, { defines: 'queries.derived_views.top' }),
  backend: art('backend', { id: 'prom-main', product: 'prometheus', signal: 'metrics' }),
  pipeline_receiver: art('pipeline_receiver', { name: 'otlp' }),
  pipeline_processor: art('pipeline_processor', { name: 'batch' }),
  pipeline_exporter_metrics: art('pipeline_exporter_metrics', { kind: 'prometheusremotewrite' }),
  pipeline_exporter_logs: art('pipeline_exporter_logs', { name: 'es-main', kind: 'elasticsearch' }),
  pipeline_exporter_traces: art('pipeline_exporter_traces', { kind: 'jaeger' }),
  storage_metrics: art('storage_metrics', { backend: 'mimir' }),
  storage_logs: art('storage_logs', { backend: 'loki' }),
  storage_traces: art('storage_traces', { backend: 'tempo' }),
  scrape_job: art('scrape_job', { job: 'orders-api' }),
  metric: art('metric', { name: 'http_requests_total' }),
  profiling: art('profiling', { product: 'pyroscope' }),
  network: art('network', { product: 'cilium' }),
  policy_engine: art('policy_engine', { product: 'opa' }),
  mesh: art('mesh', { product: 'istio', role: 'control-plane' }),
  collection: art('collection', { product: 'alloy', role: 'agent' }),
  recording_rule: art('recording_rule', { name: 'orders:rate5m' }),
  panel: art('panel', { panel: 'Error rate', binds_to: 'ref:slis.api_availability' }, { parent: 'dashboards.orders' }),
  burn_rate: art('burn_rate', { slo: 'ref:slos.api_99' }),
  forecast: art('forecast', { slo: 'api_99' }),
  alert_route: art('alert_route', { severity: 'SEV1' }),
  alert_rule: art('alert_rule', { name: 'HighLatency', expr: 'x > 1' }),
  remediation: art('remediation', { trigger: 'ref:slos.api_99' }),
  baselines: art('baselines', { mttd_target_p50: '15m' }),
  chaos: art('chaos', { id: 'kill-pod' }),
  synthetic: art('synthetic', { id: 'health-canary' }),
  imports: art('imports', { ref: 'ref:platform/base' }),
  otel: art('otel', { semconv: '1.26.0' }),
  unknown: { id: 'X-01', title: 'Some prose', spec: {} },
};

test('every family of the vocabulary has a name and an id row (iterated over FAMILIES)', () => {
  assert.deepEqual(identityFamilies(), [...FAMILIES]);
  for (const family of FAMILIES) {
    assert.ok(SAMPLE[family], `the test has a sample for ${family}`);
    assert.equal(classify(SAMPLE[family]), family);
    // A family with material yields it; only `unknown` without `defines` has none.
    const expectsMaterial = family !== 'unknown';
    assert.equal(nameOf(SAMPLE[family]) != null, expectsMaterial, `${family} name`);
    assert.equal(idOf(SAMPLE[family]) != null, expectsMaterial, `${family} id`);
  }
});

test('a key always keeps the <kind>:: prefix, in every mode and with or without material', () => {
  for (const family of FAMILIES) {
    for (const a of [SAMPLE[family], { ...SAMPLE[family], spec: {}, defines: undefined }]) {
      for (const mode of IDENTITY_MODES) {
        const key = mode.keyOf(a, { side: 'a' });
        assert.ok(key.startsWith(`${family}::`), `${mode.id} ${family}: ${key}`);
      }
    }
  }
});

test('the registry: three modes in order, behaviour the default and identityKeyOf itself', () => {
  assert.deepEqual(IDENTITY_MODES.map((m) => m.id), ['behaviour', 'name', 'id']);
  assert.equal(DEFAULT_IDENTITY_MODE, 'behaviour');
  assert.equal(identityMode('behaviour').keyOf, identityKeyOf);
  assert.equal(identityMode('name').keyOf, nameKeyOf);
  assert.equal(identityMode('id').keyOf, idKeyOf);
  for (const m of IDENTITY_MODES) {
    assert.ok(Object.isFrozen(m));
    assert.equal(typeof m.hint, 'string');
    assert.equal(m.matchedBy, m.id);
  }
  assert.ok(Object.isFrozen(IDENTITY_MODES));
});

test('an unknown mode is a TypeError naming the three', () => {
  assert.throws(() => identityMode('title'), (e) => e instanceof TypeError && /"title"/.test(e.message) && /behaviour, name, id/.test(e.message));
  assert.throws(() => pairingOf(SAMPLE.metric, 'uid'), TypeError);
  assert.throws(() => identityMode(undefined), TypeError);
});

test('a dashboard: the title by name, the uid by id; the spec id when either is missing', () => {
  const d = SAMPLE.dashboard;
  assert.equal(nameKeyOf(d), 'dashboard::{"name":"orders"}');
  assert.equal(idKeyOf(d), 'dashboard::{"id":"ord-1"}');
  const bare = { ...d, spec: { id: 'orders' } };
  assert.equal(nameOf(bare), 'orders');
  assert.equal(idOf(bare), 'orders');
  // the positional id is never read
  assert.equal(idOf({ type: 'dashboard', id: 'DASH-07', spec: {} }), null);
});

test('names are normalised (trim, collapsed white space, lower case); a uid keeps its case', () => {
  const a = art('dashboard', { params: { title: '  Error   Rates\n', uid: ' Err-1 ' } }, { defines: 'dashboards.e' });
  assert.equal(nameOf(a), 'error rates');
  assert.equal(idOf(a), 'Err-1');
  assert.notEqual(idKeyOf(a), idKeyOf({ ...a, spec: { params: { uid: 'err-1' } } }));
  assert.equal(nameKeyOf(a), nameKeyOf({ ...a, spec: { params: { title: 'error rates' } } }));
});

test('a family whose name is its id: a metric, a rule, a scrape job read the name in both modes', () => {
  for (const f of ['metric', 'alert_rule', 'recording_rule', 'scrape_job']) {
    assert.equal(nameOf(SAMPLE[f]), idOf(SAMPLE[f]), f);
  }
  assert.equal(idKeyOf(SAMPLE.alert_rule), 'alert_rule::{"id":"highlatency"}');
  assert.equal(pairingOf(SAMPLE.alert_rule, 'id'), 'rule name "highlatency" (the name is the id)');
  assert.equal(pairingOf(SAMPLE.alert_rule, 'name'), 'rule name "highlatency"');
});

test('no name or no stable id never pairs: the key carries the side and the artefact\'s own id', () => {
  const a = { type: 'dashboard', id: 'DASH-01', spec: {} };
  const b = { type: 'dashboard', id: 'DASH-01', spec: {} };
  assert.equal(nameOf(a), null);
  assert.notEqual(nameKeyOf(a, { side: 'a' }), nameKeyOf(b, { side: 'b' }));
  assert.equal(nameKeyOf(a, { side: 'a' }), 'dashboard::{"unnamed":"a:DASH-01"}');
  assert.equal(idKeyOf(b, { side: 'b' }), 'dashboard::{"unidentified":"b:DASH-01"}');
  assert.equal(pairingOf(a, 'name'), 'no name — never paired by name');
  assert.equal(pairingOf(a, 'id'), 'no stable id — never paired by id');
});

test('the adapter\'s prose title is never a name: an unknown artefact pairs by its spec path only', () => {
  assert.equal(nameOf(SAMPLE.unknown), null);
  assert.equal(nameOf({ ...SAMPLE.unknown, defines: 'spec.custom.thing' }), 'spec.custom.thing');
  // a metric without spec.name does not fall back to the artefact title
  assert.equal(nameOf({ type: 'metric', id: 'METRIC-01', title: 'http_requests_total', spec: {} }), null);
});

test('singletons (otel, baselines) pair with each other in every mode', () => {
  for (const f of ['otel', 'baselines']) {
    const other = { ...SAMPLE[f], id: 'OTHER-02', spec: { different: true } };
    assert.equal(nameKeyOf(SAMPLE[f], { side: 'a' }), nameKeyOf(other, { side: 'b' }));
    assert.equal(idKeyOf(SAMPLE[f], { side: 'a' }), idKeyOf(other, { side: 'b' }));
    assert.equal(pairingOf(SAMPLE[f], 'name'), `the pack's one ${f} entry`);
  }
});

test('composite and fallback material: exporters, mesh, panels, burn rates, remediation, imports', () => {
  assert.equal(nameOf(SAMPLE.pipeline_exporter_metrics), 'prometheusremotewrite');
  assert.equal(nameOf(SAMPLE.pipeline_exporter_logs), 'es-main');
  assert.equal(nameOf(SAMPLE.mesh), 'istio / control-plane');
  assert.equal(nameOf(SAMPLE.panel), 'dashboards.orders / error rate');
  assert.equal(idOf(SAMPLE.panel), 'dashboards.orders / api_availability');
  assert.equal(idOf({ ...SAMPLE.panel, spec: { panel: 'Error rate' } }), 'dashboards.orders / error rate');
  assert.equal(nameOf(SAMPLE.burn_rate), 'api_99');
  assert.equal(nameOf(SAMPLE.forecast), 'api_99');
  assert.equal(nameOf(SAMPLE.remediation), 'api_99');
  assert.equal(nameOf({ ...SAMPLE.remediation, spec: { id: 'Restart-Pod', trigger: 'x' } }), 'restart-pod');
  assert.equal(nameOf(SAMPLE.imports), 'platform/base');
  assert.equal(nameOf(SAMPLE.alert_route), 'sev1');
});

test('pairingOf names the key in words, per family', () => {
  assert.equal(pairingOf(SAMPLE.dashboard, 'id'), 'dashboard uid "ord-1"');
  assert.equal(pairingOf(SAMPLE.dashboard, 'name'), 'dashboard title "orders"');
  assert.equal(pairingOf({ ...SAMPLE.dashboard, spec: {} }, 'id'), 'dashboard id "orders"');
  assert.equal(pairingOf(SAMPLE.backend, 'name'), 'backend id "prom-main"');
  assert.equal(pairingOf(SAMPLE.sli, 'id'), 'spec id "api_availability"');
  assert.equal(pairingOf(SAMPLE.backend), 'behaviour (product "prometheus", signal "metrics")');
  assert.equal(pairingOf(SAMPLE.otel, 'behaviour'), 'behaviour (one per pack)');
  for (const family of FAMILIES) {
    for (const mode of IDENTITY_MODES) assert.equal(typeof pairingOf(SAMPLE[family], mode.id), 'string');
  }
});

test('over the adapted catalogue packs: every non-unknown artefact has a name and an id; keys are deterministic', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const file of ['examples/production-curated.pack.yaml', 'examples/target-advanced.pack.yaml', 'examples/demo-skeleton.pack.yaml']) {
    const adapted = adapt(parseYaml(readFileSync(root + file, 'utf8')));
    const all = Object.values(adapted.layers).flatMap((l) => (Array.isArray(l) ? l : [...(l.policy || []), ...(l.alerting || []), ...(l.healing || [])]));
    assert.ok(all.length > 10, file);
    for (const a of all) {
      if (classify(a) === 'unknown') continue;
      assert.notEqual(nameOf(a), null, `${file} ${a.id} (${classify(a)}) has a name`);
      assert.notEqual(idOf(a), null, `${file} ${a.id} (${classify(a)}) has an id`);
      assert.equal(nameKeyOf(a, { side: 'a' }), nameKeyOf(JSON.parse(JSON.stringify(a)), { side: 'a' }));
    }
  }
});

test('pure: no artefact is mutated, and the module imports no node: built-in', () => {
  const a = JSON.parse(JSON.stringify(SAMPLE.dashboard));
  const before = JSON.stringify(a);
  for (const m of IDENTITY_MODES) { m.keyOf(a, { side: 'a' }); pairingOf(a, m.id); }
  assert.equal(JSON.stringify(a), before);
  const src = readFileSync(new URL('./lib/identity-modes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]node:/);
  assert.doesNotMatch(src, /process\.env/);
});

// ---------- the diff engine takes the identity (tools/lib/diff.mjs) ----------

const FIXTURE = (side) => parseYaml(readFileSync(new URL(`./fixtures/compare-modes/${side}.pack.yaml`, import.meta.url), 'utf8'));
const counts = (d) => ({ inBoth: d.summary.inBoth, onlyInA: d.summary.onlyInA, onlyInB: d.summary.onlyInB, aligned: d.summary.aligned, drifted: d.summary.drifted });
const entries = (d, bucket) => Object.values(d.layers).flatMap((l) => l[bucket]);
const K = 13; // the sections A and B share verbatim

test('the compare-modes fixture: three modes, three distinct count sets (behaviour still decides drift)', () => {
  const a = adapt(FIXTURE('a'));
  const b = adapt(FIXTURE('b'));
  assert.deepEqual(counts(diffPacks(a, b)), { inBoth: K + 2, onlyInA: 5, onlyInB: 5, aligned: 13, drifted: 2 });
  assert.deepEqual(counts(diffPacks(a, b, { identity: 'name' })), { inBoth: K + 3, onlyInA: 4, onlyInB: 4, aligned: 13, drifted: 3 });
  assert.deepEqual(counts(diffPacks(a, b, { identity: 'id' })), { inBoth: K + 4, onlyInA: 3, onlyInB: 3, aligned: 13, drifted: 4 });
  for (const mode of ['behaviour', 'name', 'id']) {
    const d = diffPacks(a, b, { identity: mode });
    assert.equal(d.summary.outOfScope + d.summary.scaffold + d.summary.notObserved, 0, `${mode}: every artefact is in a counted bucket`);
  }
});

test('renamed with the same uid pairs by id, not by name; same name with another expression pairs by name and drifts', () => {
  const a = adapt(FIXTURE('a'));
  const b = adapt(FIXTURE('b'));
  const pairOf = (d, aDefines) => entries(d, 'inBoth').find((e) => e.a.defines === aDefines);
  assert.equal(pairOf(diffPacks(a, b, { identity: 'id' }), 'dashboards.orders')?.b.defines, 'dashboards.orders-v2');
  assert.equal(pairOf(diffPacks(a, b, { identity: 'name' }), 'dashboards.orders'), undefined);
  assert.equal(pairOf(diffPacks(a, b, { identity: 'name' }), 'dashboards.payments')?.b.defines, 'dashboards.payments-new');
  for (const mode of ['behaviour', 'name', 'id']) {
    const rule = entries(diffPacks(a, b, { identity: mode }), 'inBoth').find((e) => e.a.spec?.name === 'HighLatency');
    assert.equal(rule?.match, 'drifted', mode);
    assert.deepEqual(rule.deltas.map((x) => x.field), ['expr'], `${mode}: the expression is the delta`);
  }
  const backend = (d) => entries(d, 'inBoth').find((e) => e.a.spec?.id === 'prom-main');
  assert.ok(backend(diffPacks(a, b)), 'the backend pairs by behaviour');
  assert.equal(backend(diffPacks(a, b, { identity: 'name' })), undefined, 'not by name');
});

test('the default path is byte-identical: omitted, "behaviour" and identityKeyOf give the same answer, with no identity key', () => {
  const pairs = [
    [adapt(FIXTURE('a')), adapt(FIXTURE('b'))],
    [adapt(parseYaml(readFileSync(new URL('../examples/production-curated.pack.yaml', import.meta.url), 'utf8'))),
      adapt(parseYaml(readFileSync(new URL('../examples/krystaline-repo-carlos.pack.yaml', import.meta.url), 'utf8')))],
  ];
  for (const [a, b] of pairs) {
    const base = JSON.stringify(diffPacks(a, b));
    assert.ok(!('identity' in diffPacks(a, b)));
    assert.equal(JSON.stringify(diffPacks(a, b, { identity: 'behaviour' })), base);
    assert.equal(JSON.stringify(diffPacks(a, b, { identity: identityKeyOf })), base);
    assert.equal(JSON.stringify(diffPacks(a, b, { identity: undefined, scopeMode: undefined })), base);
  }
  const named = diffPacks(pairs[0][0], pairs[0][1], { identity: 'name' });
  assert.deepEqual(named.identity, { mode: 'name' });
  assert.deepEqual(Object.keys(named).slice(0, 4), ['a', 'b', 'scope', 'identity']);
});

test('a custom key function: called with the side, keyed as custom; one without the <kind>:: prefix is a TypeError', () => {
  const a = adapt(FIXTURE('a'));
  const b = adapt(FIXTURE('b'));
  const sides = new Set();
  const custom = (artefact, { side }) => { sides.add(side); return nameKeyOf(artefact, { side }); };
  const d = diffPacks(a, b, { identity: custom });
  assert.deepEqual([...sides].sort(), ['a', 'b']);
  assert.deepEqual(d.identity, { mode: 'custom' });
  assert.deepEqual(counts(d), counts(diffPacks(a, b, { identity: 'name' })));
  assert.throws(() => diffPacks(a, b, { identity: (x) => `name::${x.id}` }),
    (e) => e instanceof TypeError && /^diffPacks: an identity function must return "\w+::…" for each artefact \(got "name::[^"]+" for a \w+\)$/.test(e.message));
  assert.throws(() => diffPacks(a, b, { identity: () => null }), TypeError);
  assert.throws(() => diffPacks(a, b, { identity: 'uid' }), (e) => e instanceof TypeError && /behaviour, name, id/.test(e.message));
  assert.throws(() => diffPacks(a, b, { identity: 42 }), TypeError);
});

test('in the diff, two artefacts without a name never pair (the side is in the key), and a placeholder is keyed by the mode', () => {
  const pack = (artefacts) => ({ id: 'p', meta: { service: 'svc' }, layers: { L3: artefacts } });
  const unnamed = () => ({ type: 'dashboard', id: 'DASH-01', spec: {} });
  const byName = diffPacks(pack([unnamed()]), pack([unnamed()]), { identity: 'name', scopeMode: 'all' });
  assert.equal(byName.summary.inBoth, 0);
  assert.equal(byName.summary.onlyInA, 1);
  assert.equal(byName.summary.onlyInB, 1);
  assert.equal(entries(byName, 'onlyInA')[0].key, 'dashboard::{"unnamed":"a:DASH-01"}');
  assert.equal(diffPacks(pack([unnamed()]), pack([unnamed()]), { scopeMode: 'all' }).summary.inBoth, 1, 'behaviour pairs them by the positional fallback, as today');
  const placeholder = { type: 'dashboard', id: 'DASH-02', source: 'Scaffold', spec: { params: { title: 'Fallback Board' } } };
  const parked = diffPacks(pack([placeholder]), pack([]), { identity: 'name' });
  assert.equal(entries(parked, 'scaffold')[0].key, 'dashboard::{"name":"fallback board"}@a#01');
});

test('parity: diffPacks over the JSON the server answers for two packs equals GET /api/diff without traceabilityGraph', async (t) => {
  const { serve } = await import('../server/fixtures/serve-child.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const ws = mkdtempSync(join(tmpdir(), 'observogram-identity-parity-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const register = async (side) => {
    const r = await fetch(`${child.base}/api/validate?source=compare-modes-${side}.pack.yaml`, {
      method: 'POST', headers: { 'Content-Type': 'text/yaml' },
      body: readFileSync(new URL(`./fixtures/compare-modes/${side}.pack.yaml`, import.meta.url), 'utf8'),
    });
    const json = await r.json();
    assert.equal(json.ok, true, JSON.stringify(json.errors));
    return json.registered.id;
  };
  const pairs = [[await register('a'), await register('b')], ['payment-service', 'production-curated']];
  for (const [aId, bId] of pairs) {
    const get = async (path) => (await fetch(`${child.base}${path}`)).json();
    const server = await get(`/api/diff?a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`);
    assert.ok(server.traceabilityGraph, `${aId} vs ${bId}: the server answers a graph`);
    delete server.traceabilityGraph;
    const aPack = await get(`/api/packs/${encodeURIComponent(aId)}`);
    const bPack = await get(`/api/packs/${encodeURIComponent(bId)}`);
    const client = JSON.parse(JSON.stringify(diffPacks(aPack, bPack, { scopeMode: server.scope.mode })));
    assert.deepEqual(client, server, `${aId} vs ${bId}`);
    assert.ok(server.summary.inBoth > 0);
  }
});

// ---------- the studio's Pair by (studio/compare-identity.mjs) ----------

test('studio: the switch\'s modes are the registry\'s; behaviour shows the server\'s diff itself, name and id re-key the packs on screen', async () => {
  const studio = await import('../studio/compare-identity.mjs');
  const lib = await import('./lib/identity-modes.mjs');
  assert.deepEqual(studio.PAIRING_MODES.map(({ id, label, matchedBy, hint }) => ({ id, label, matchedBy, hint })),
    lib.IDENTITY_MODES.map(({ id, label, matchedBy, hint }) => ({ id, label, matchedBy, hint })));
  const diffLib = await import('./lib/diff.mjs');
  const engine = { identity: lib, diff: diffLib };
  const a = JSON.parse(JSON.stringify(adapt(FIXTURE('a'))));
  const b = JSON.parse(JSON.stringify(adapt(FIXTURE('b'))));
  const server = { ...JSON.parse(JSON.stringify(diffPacks(a, b, { scopeMode: 'service' }))), traceabilityGraph: { rollup: {} }, __for: { a: 'x', b: 'y', scopeMode: 'service', service: null } };
  const behaviour = studio.viewDiffFor({ engine, diff: server, pack: a, packB: b, mode: 'behaviour' });
  assert.equal(behaviour.diff, server, 'behaviour is the server answer, the same object');
  const byId = studio.viewDiffFor({ engine, diff: server, pack: a, packB: b, mode: 'id' });
  assert.equal(byId.mode, 'id');
  assert.equal(byId.unavailable, '');
  assert.deepEqual([byId.diff.summary.inBoth, byId.diff.summary.onlyInA, byId.diff.summary.onlyInB], [K + 4, 3, 3]);
  assert.equal(byId.diff.traceabilityGraph, server.traceabilityGraph, 'the graph and __for ride along');
  assert.equal(byId.diff.__for, server.__for);
  assert.equal(studio.viewDiffFor({ engine, diff: server, pack: a, packB: b, mode: 'id' }), byId, 'memoised on (diff, mode, packs)');
  const byName = studio.viewDiffFor({ engine, diff: server, pack: a, packB: b, mode: 'name' });
  assert.deepEqual([byName.diff.summary.inBoth, byName.diff.summary.onlyInA, byName.diff.summary.onlyInB], [K + 3, 4, 4]);
});

test('studio: behaviour is shown, with a sentence, when the packs are not the compared ones, the engine failed, or the taxonomy did not bind', async () => {
  const studio = await import('../studio/compare-identity.mjs');
  const lib = await import('./lib/identity-modes.mjs');
  const diffLib = await import('./lib/diff.mjs');
  const engine = { identity: lib, diff: diffLib };
  const a = adapt(FIXTURE('a'));
  const b = adapt(FIXTURE('b'));
  const server = { ...diffPacks(a, b), __for: { scopeMode: 'service' } };
  const other = adapt(parseYaml(readFileSync(new URL('../examples/demo-skeleton.pack.yaml', import.meta.url), 'utf8')));
  const stale = studio.viewDiffFor({ engine, diff: server, pack: other, packB: b, mode: 'name' });
  assert.equal(stale.diff, server);
  assert.equal(stale.mode, 'behaviour');
  assert.match(stale.unavailable, /not the ones the server compared/);
  assert.match(studio.viewDiffFor({ engine: null, diff: server, pack: a, packB: b, mode: 'id' }).unavailable, /did not load/);
  assert.match(studio.viewDiffFor({ engine, diff: server, pack: a, packB: b, mode: 'id', taxonomyError: 'GET /api/taxonomy failed' }).unavailable, /taxonomy/);
  assert.equal(studio.viewDiffFor({ engine: undefined, diff: server, pack: a, packB: b, mode: 'id' }).unavailable, 'still loading');
  const failed = studio.identitySwitchModel({ chosen: 'id', shown: 'behaviour', engineState: 'failed', unavailable: 'x' });
  assert.deepEqual(failed.radios.map((r) => r.disabled), [false, true, true]);
  assert.equal(failed.sentence, 'Name and id pairing could not load in this browser (x) — behaviour pairing is shown.');
  const loadingNow = studio.identitySwitchModel({ chosen: 'behaviour', shown: 'behaviour', engineState: 'loading', unavailable: '' });
  assert.equal(loadingNow.sentence, '');
  assert.deepEqual(loadingNow.radios.map((r) => r.disabled), [false, true, true]);
  const ready = studio.identitySwitchModel({ chosen: 'name', shown: 'name', engineState: 'ready', unavailable: '' });
  assert.equal(ready.checked, 'name');
  assert.ok(ready.radios.every((r) => !r.disabled));
  assert.match(ready.note, /^Paired by name in this browser over the two packs on screen; behaviour still decides aligned vs drifted\. Chains, Diagnose and every action pair by behaviour\.$/);
  assert.equal(studio.identitySwitchModel({ chosen: 'behaviour', shown: 'behaviour', engineState: 'ready', unavailable: '' }).note, '');
});

test('studio: the announcement, the pill titles and the unpaired hints', async () => {
  const studio = await import('../studio/compare-identity.mjs');
  const lib = await import('./lib/identity-modes.mjs');
  const engine = { identity: lib, diff: null };
  assert.equal(studio.identityAnnouncement('name', { shared: 12, onlyInA: 9, onlyInB: 7 }), 'Pairing by name: 12 in both, 9 only in A, 7 only in B.');
  const dash = { type: 'dashboard', id: 'DASH-01', defines: 'dashboards.orders', spec: { params: { title: 'Orders', uid: 'ord-1' } } };
  assert.equal(studio.pairingTitle(engine, dash, 'id'), 'Paired by id: dashboard uid "ord-1"');
  assert.equal(studio.pairingTitle(engine, dash, 'behaviour'), '');
  assert.equal(studio.pairingTitle(null, dash, 'id'), '');
  const bare = { type: 'dashboard', id: 'DASH-02', spec: {} };
  assert.equal(studio.unpairedHint(engine, bare, 'name'), 'has no name');
  assert.equal(studio.unpairedHint(engine, bare, 'id'), 'has no stable id');
  assert.equal(studio.unpairedHint(engine, dash, 'id'), '');
  assert.equal(studio.unpairedHint(engine, bare, 'behaviour'), '');
  assert.equal(studio.pairingModeOf('nope').id, 'behaviour');
});
