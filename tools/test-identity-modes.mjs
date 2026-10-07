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
