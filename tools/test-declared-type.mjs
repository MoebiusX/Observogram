// tools/test-declared-type.mjs
//
// The declared per-artefact type passthrough: a layered item that carries a
// `type` keeps it through the legacy upconvert as the annotation
// `observogram.artefact.type.<symbol>` (tools/lib/legacy.mjs), and adapt()
// carries that annotation through as the artefact's top-level `type`
// (tools/lib/adapter.mjs DECLARED_TYPE_PREFIX) for the taxonomy to read
// first. Inert when absent: no catalogue pack, no legacy example and no
// upconvert of one produces a `type` — the guard the classifier's
// inert-by-default argument rests on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from './lib/mini-yaml.mjs';
import { adapt, DECLARED_TYPE_PREFIX } from './lib/adapter.mjs';
import { upconvertLegacyPack } from './lib/legacy.mjs';
import { validateCanonical, SPEC_DIR, SPEC_VERSION } from './lib/validator.mjs';
import { classifyArtefact, compileTaxonomy } from './lib/artefact-classify.mjs';

const ROOT = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const listDir = (dir, ext) => readdirSync(new URL(dir, ROOT)).filter(f => f.endsWith(ext)).sort().map(f => `${dir}/${f}`);
const allArtefacts = (pack) => Object.values(pack.layers).flatMap(v => (Array.isArray(v) ? v : Object.values(v).flat()));
const SCHEMA = JSON.parse(read(`${SPEC_DIR}/observability-pack.schema.json`));
const TAXONOMY = compileTaxonomy(JSON.parse(read('tools/fixtures/taxonomy/taxonomy.json')));

const CATALOGUE = [`${SPEC_DIR}/examples/payment-service.pack.yaml`, ...listDir('examples', '.pack.yaml'), ...listDir('reference-packs', '.pack.yaml')];
const LEGACY = listDir('examples/legacy', '.json');

test('adapt() over every catalogue pack emits no artefact with a top-level `type`', () => {
  assert.equal(DECLARED_TYPE_PREFIX, 'observogram.artefact.type.');
  let n = 0;
  for (const path of CATALOGUE) {
    const canonical = parse(read(path));
    assert.ok(!Object.keys(canonical.metadata?.annotations || {}).some(k => k.startsWith(DECLARED_TYPE_PREFIX)), `${path} declares no type`);
    for (const a of allArtefacts(adapt(canonical))) {
      n++;
      assert.ok(!Object.hasOwn(a, 'type'), `${path}: ${a.id} carries a top-level type`);
    }
  }
  assert.ok(n > 1000, `${n} artefacts checked`);
});

test('the legacy examples carry no item type: the upconvert writes no type annotation and adapt() emits no `type`', () => {
  assert.ok(LEGACY.length >= 4);
  for (const path of LEGACY) {
    const legacy = JSON.parse(read(path));
    const { canonical } = upconvertLegacyPack(legacy, { now: '2026-01-01T00:00:00.000Z' });
    assert.deepEqual(Object.keys(canonical.metadata.annotations).filter(k => k.startsWith(DECLARED_TYPE_PREFIX)), [], path);
    for (const a of allArtefacts(adapt(canonical))) assert.ok(!Object.hasOwn(a, 'type'), `${path}: ${a.id}`);
  }
});

// A layered pack from another toolchain: every item typed, foreign ids.
const TYPED_LEGACY = {
  id: 'checkout', name: 'Checkout (typed)',
  layers: {
    L1: [
      { id: 'svc-checkout-availability', type: 'PackSLI', source: 'BAU', title: 'Availability', desc: 'Good requests over all requests', tool: 'Prometheus', tags: [] },
      { id: 'svc-checkout-slo-availability', type: 'PackSLO', source: 'BAU', title: 'Availability SLO', desc: '99.9% over 30d', tool: 'Sloth', tags: ['slo'] },
      { id: 'svc-checkout-latency', type: 'sli', source: 'BAU', title: 'Latency', desc: 'p99 under 300 ms', tool: 'Prometheus', tags: [] },
    ],
    L2: [
      { id: 'tsdb-main', type: 'MetricsStore', source: 'BAU', title: 'Mimir', desc: 'metrics storage, 13 months', tool: 'mimir', tags: ['storage'] },
      { id: 'tempo-main', type: 'TracingBackend', source: 'BAU', title: 'Tempo', desc: 'traces', tool: 'tempo', tags: [] },
    ],
    L3: [
      { id: 'grafana-uid-9f2', type: 'GrafanaDashboard', source: 'BAU', title: 'Checkout overview', desc: 'dashboard', tool: 'Grafana', tags: [] },
      { id: 'rr-checkout-error-ratio', type: 'RecordingRule', source: 'BAU', title: 'checkout:error_ratio:5m', desc: 'recording rule', tool: 'Prometheus', tags: [] },
    ],
    L4: {
      policy: [{ id: 'burn-checkout-fast', type: 'BurnRatePolicy', source: 'BAU', title: 'Fast burn', desc: '14x over 1h', tool: 'Sloth', tags: [] }],
      alerting: [{ id: 'route-sev1-pager', type: 'AlertRoute', source: 'BAU', title: 'SEV1 to pager', desc: 'pagerduty', tool: 'Alertmanager', tags: [] }],
      healing: [{ id: 'heal-restart-pods', type: 'Runbook', source: 'GAP', title: 'Restart pods', desc: 'rollout restart', tool: 'Argo', tags: [] }],
    },
    L5: [{ id: 'probe-checkout-health', type: 'SyntheticProbe', source: 'BAU', title: 'Health probe', desc: 'blackbox', tool: 'blackbox-exporter', tags: [] }],
    GOV: [{ id: 'gov-platform-baseline', type: 'PlatformImport', source: 'BAU', title: 'Platform baseline', desc: 'shared definitions', tool: 'pack', tags: [] }],
  },
};

test('a layered item with a `type` keeps it as `observogram.artefact.type.<symbol>`, the manifest still validates, and adapt() carries it through', () => {
  const { canonical, report } = upconvertLegacyPack(TYPED_LEGACY, { now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(validateCanonical(canonical, SCHEMA), [], `valid against spec ${SPEC_VERSION}`);
  const declared = Object.fromEntries(Object.entries(canonical.metadata.annotations).filter(([k]) => k.startsWith(DECLARED_TYPE_PREFIX)).map(([k, v]) => [k.slice(DECLARED_TYPE_PREFIX.length), v]));
  assert.deepEqual(declared, {
    'slis.availability': 'PackSLI',
    'slis.latency': 'sli',
    'slos.availability-slo': 'PackSLO',
    'storage.metrics': 'MetricsStore',
    'telemetry.backends.tempo': 'TracingBackend',
    'dashboards.checkout-overview': 'GrafanaDashboard',
    'queries.recording_rules[0]': 'RecordingRule',
    'policy.burn_rate_alerts[0]': 'BurnRatePolicy',
    'alerting.routes[0]': 'AlertRoute',
    'remediation[0]': 'Runbook',
    'validation.synthetic_checks.health-probe': 'SyntheticProbe',
    'imports[0]': 'PlatformImport',
  });
  assert.equal(report.mapped, 12, 'every item is still kept verbatim');
  const adapted = adapt(canonical);
  const typed = Object.fromEntries(allArtefacts(adapted).filter(a => Object.hasOwn(a, 'type')).map(a => [a.id, a.type]));
  assert.deepEqual(typed, {
    'SLI-01': 'PackSLI', 'SLI-02': 'sli', 'SLO-01': 'PackSLO',
    'BAK-01': 'TracingBackend', 'STO-MET-01': 'MetricsStore',
    'QRY-01': 'RecordingRule', 'DASH-01': 'GrafanaDashboard',
    'POL-01': 'BurnRatePolicy', 'ALR-01': 'AlertRoute', 'HEAL-01': 'Runbook',
    'SYN-01': 'SyntheticProbe', 'IMP-01': 'PlatformImport',
  });
  // The key sits beside `source`, and every other artefact of the pack is untouched.
  const sli = adapted.layers.L1.find(a => a.id === 'SLI-01');
  assert.deepEqual(Object.keys(sli).slice(0, 6), ['id', 'title', 'desc', 'tool', 'tags', 'source'].slice(0, 6));
  assert.ok(Object.keys(sli).indexOf('type') === Object.keys(sli).indexOf('source') + 1);
  for (const a of allArtefacts(adapted)) if (!(a.id in typed)) assert.ok(!Object.hasOwn(a, 'type'), a.id);
  // With no override the family name in `type` is read and a foreign name is not: the adapted ids still classify by defines/id.
  assert.deepEqual(pick(classifyArtefact(adapted.layers.L1.find(a => a.id === 'SLI-02')), 'family', 'via'), { family: 'sli', via: 'type' });
  assert.deepEqual(pick(classifyArtefact(sli), 'family', 'via'), { family: 'sli', via: 'defines' }, 'PackSLI is not a family: the canonical defines decides');
  // With the override, the foreign names are read first.
  assert.deepEqual(pick(classifyArtefact(sli, TAXONOMY), 'family', 'via'), { family: 'sli', via: 'type' });
  assert.deepEqual(pick(classifyArtefact(adapted.layers.L3.find(a => a.id === 'DASH-01'), TAXONOMY), 'family', 'via', 'label'), { family: 'dashboard', via: 'type', label: 'Grafana dashboard' });
  assert.deepEqual(pick(classifyArtefact(adapted.layers.L4.alerting.find(a => a.id === 'ALR-01'), TAXONOMY), 'family', 'via'), { family: 'alert_route', via: 'type' });
  assert.deepEqual(pick(classifyArtefact(adapted.layers.L2.find(a => a.id === 'STO-MET-01'), TAXONOMY), 'family', 'via'), { family: 'storage_metrics', via: 'id' }, 'a name the override does not map falls through');
});

test('a blank or non-string item type writes nothing; a declared type on a canonical pack reaches exactly its artefact', () => {
  const blank = upconvertLegacyPack({ id: 'x', layers: { L1: [{ id: 'SLI-01', type: '  ', title: 'a' }, { id: 'SLI-02', type: 7, title: 'b' }] } }).canonical;
  assert.deepEqual(Object.keys(blank.metadata.annotations).filter(k => k.startsWith(DECLARED_TYPE_PREFIX)), []);
  const payment = parse(read(`${SPEC_DIR}/examples/payment-service.pack.yaml`));
  const before = JSON.stringify(adapt(payment));
  const firstSli = payment.spec.slis[0].id;
  const withType = JSON.parse(JSON.stringify(payment));
  withType.metadata.annotations = { ...(withType.metadata.annotations || {}), [`${DECLARED_TYPE_PREFIX}slis.${firstSli}`]: 'PackSLI', [`${DECLARED_TYPE_PREFIX}slis.nope`]: 'Ghost', [`${DECLARED_TYPE_PREFIX}imports[0]`]: 'PlatformImport' };
  const adapted = adapt(withType);
  const typed = allArtefacts(adapted).filter(a => Object.hasOwn(a, 'type')).map(a => [a.id, a.type]);
  assert.deepEqual(typed, [['SLI-01', 'PackSLI'], ['IMP-01', 'PlatformImport']], 'a symbol no artefact projects to declares nothing');
  // Dropping the annotations gives the untyped projection back, byte for byte (the annotations themselves ride in meta).
  delete withType.metadata.annotations[`${DECLARED_TYPE_PREFIX}slis.${firstSli}`];
  delete withType.metadata.annotations[`${DECLARED_TYPE_PREFIX}slis.nope`];
  delete withType.metadata.annotations[`${DECLARED_TYPE_PREFIX}imports[0]`];
  assert.equal(JSON.stringify(adapt(withType)), before);
});

function pick(o, ...keys) { return Object.fromEntries(keys.map(k => [k, o[k]])); }
