#!/usr/bin/env node
/**
 * tools/test-profiles.mjs
 *
 * Tests the version-aware compiler: the profile registry, the semver-range
 * resolver, and that the compiler actually shapes artefacts differently
 * across declared product versions (the whole point — a compiler that
 * ignores the version is a heuristic, not a compiler).
 */

import {
  resolveProfile, listProfiles, listProtocols, satisfies, parseVersion,
} from './lib/profiles.mjs';
import {
  resolveProtocolVersion, compareVersions, rangeFloor, PROTOCOLS,
} from './lib/protocols.mjs';
import {
  compileGrafanaDashboard, compilePrometheusRules, compileOtelCollector,
  compileAlertmanager,
} from './lib/compile.mjs';

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness({ indent: '  ', truncate: 160 });

// ---------------------------------------------------------------------------
process.stdout.write('\n[semver] range matcher\n');
assert(parseVersion('v2.55.1')?.join('.') === '2.55.1', 'parses v-prefixed versions', parseVersion('v2.55.1'), [2, 55, 1]);
assert(parseVersion('12')?.join('.') === '12.0.0', 'parses bare major', parseVersion('12'), [12, 0, 0]);
assert(satisfies('2.55', '>=2.42 <3'), '2.55 satisfies >=2.42 <3');
assert(!satisfies('2.40', '>=2.42 <3'), '2.40 does not satisfy >=2.42 <3');
assert(satisfies('12.3', '>=12 <13'), '12.3 satisfies >=12 <13');
assert(!satisfies('13.0', '>=12 <13'), '13.0 does not satisfy >=12 <13');
assert(satisfies('0.96.0', '>=0.96'), '0.96.0 satisfies >=0.96');
assert(!satisfies('0.85.0', '>=0.86 <0.96'), '0.85.0 below >=0.86 <0.96');

// ---------------------------------------------------------------------------
process.stdout.write('\n[registry] profile resolution\n');
const g12 = resolveProfile('grafana', '12.3');
assert(g12.band === 'grafana-12', 'grafana 12.3 -> grafana-12 band', g12.band, 'grafana-12');
assert(g12.knobs.schemaVersion === 41, 'grafana 12 schemaVersion 41', g12.knobs.schemaVersion, 41);
assert(g12.matched === true, 'grafana 12.3 matched a band');

const g9 = resolveProfile('grafana', '9.5');
assert(g9.knobs.datasourceForm === 'string', 'grafana 9 uses bare-uid datasource form', g9.knobs.datasourceForm, 'string');

const gUnknown = resolveProfile('grafana', '999');
assert(gUnknown.matched === false, 'grafana 999 did not match a known band');
assert(gUnknown.extrapolated === true, 'grafana 999 is flagged extrapolated (future version)');
assert(gUnknown.band === 'grafana-13', 'grafana 999 extrapolates to the newest known band', gUnknown.band, 'grafana-13');

const gOld = resolveProfile('grafana', '7');
assert(gOld.matched === false && gOld.extrapolated === false, 'grafana 7 (below all bands) falls back, not extrapolated');
assert(gOld.band === 'grafana-12', 'grafana 7 falls back to the default band', gOld.band, 'grafana-12');

const prom = resolveProfile('prometheus', '2.40');
assert(prom.knobs.keepFiringFor === false, 'prometheus <2.42 has no keep_firing_for', prom.knobs.keepFiringFor, false);
const prom3 = resolveProfile('prometheus', '3.1');
assert(prom3.knobs.keepFiringFor === true, 'prometheus 3.x supports keep_firing_for');
const vm = resolveProfile('victoriametrics', '1.99');
assert(vm.knobs.keepFiringFor === false, 'vmalert never emits keep_firing_for');

const otelNew = resolveProfile('otel-collector', '0.96.0');
assert(otelNew.knobs.debugExporter === true, 'otelcol 0.96 uses debug exporter');
assert(otelNew.knobs.telemetryMetricsReaders === true, 'otelcol 0.96 uses telemetry readers');
const otelOld = resolveProfile('otel-collector', '0.80.0');
assert(otelOld.knobs.debugExporter === false, 'otelcol <0.86 still uses logging exporter');

const am28 = resolveProfile('alertmanager', '0.28.0');
assert(am28.knobs.msteamsV2 === true, 'alertmanager 0.28 has msteamsv2_configs');
const am26 = resolveProfile('alertmanager', '0.26.0');
assert(am26.knobs.msteamsV2 === false && am26.knobs.msteams === true, 'alertmanager 0.26 has msteams but not v2');

assert(listProfiles().length >= 6, 'registry lists all products', listProfiles().length, '>=6');

// ---------------------------------------------------------------------------
// Protocol layer: the facts live once, products bind to them, and several
// products converge on the same protocol version (the whole point).
// ---------------------------------------------------------------------------
process.stdout.write('\n[protocols] versioned canon + cross-product binding\n');

assert(listProtocols().length >= 5, 'protocol registry lists the protocols', listProtocols().length, '>=5');

// keep_firing_for is a fact of the rule FORMAT at 2.42, not of any product.
const prf242 = resolveProtocolVersion('prometheus-rule-format', '2.42');
assert(prf242?.features.keepFiringFor === true, 'rule-format 2.42 has keep_firing_for');
const prf2 = resolveProtocolVersion('prometheus-rule-format', '2.0');
assert(prf2?.features.keepFiringFor === false, 'rule-format <2.42 lacks keep_firing_for');

// Prometheus 2.45, Thanos, and Mimir all SPEAK the rule format — they converge
// on the same capability without the fact being duplicated per product.
const p245 = resolveProfile('prometheus', '2.45');
const thanos = resolveProfile('thanos', '0.37');
const mimir = resolveProfile('mimir', '2.15');
assert(p245.protocols.some(x => x.protocol === 'prometheus-rule-format'),
  'prometheus binds the rule-format protocol');
assert(thanos.knobs.keepFiringFor === p245.knobs.keepFiringFor,
  'Thanos and Prometheus 2.45 converge on the same keep_firing_for', thanos.knobs.keepFiringFor, p245.knobs.keepFiringFor);
assert(mimir.knobs.keepFiringFor === true, 'Mimir (rule-format 3) supports keep_firing_for');

// VictoriaMetrics consumes the SAME protocol but the MetricsQL dialect override
// wins — same protocol binding, divergent capability.
const vmProf = resolveProfile('victoriametrics', '1.99');
assert(vmProf.protocols.some(x => x.protocol === 'prometheus-rule-format'),
  'VictoriaMetrics binds the rule-format protocol');
assert(vmProf.knobs.keepFiringFor === false,
  'VictoriaMetrics dialect overrides keep_firing_for to false despite binding rule-format 2.42');
assert(vmProf.knobs.queryLanguage === 'metricsql', 'VictoriaMetrics dialect marks MetricsQL');

// PromQL is its own protocol, associated with several products.
const promqlModern = resolveProtocolVersion('promql', '2.49');
assert(promqlModern?.features.atModifier === true, 'PromQL 2.49 has the @ modifier');
assert(p245.protocols.some(x => x.protocol === 'promql'), 'Prometheus also binds the PromQL protocol');

// Per-protocol tractability rides on the resolved profile.
const gProf = resolveProfile('grafana', '12.3');
const gds = gProf.protocols.find(x => x.protocol === 'grafana-dashboard-schema');
assert(gds?.tractability === 'native', 'grafana-dashboard-schema is native-tractable');
assert(p245.protocols.find(x => x.protocol === 'prometheus-rule-format')?.tractability === 'vendored-go-needed',
  'prometheus-rule-format needs vendored Go for faithful validation');

// Evidence provenance: every feature carries since/evidence.
const rawFeat = PROTOCOLS['prometheus-rule-format'].versions[0].features.keepFiringFor;
assert(rawFeat.since === '2.42' && typeof rawFeat.evidence === 'string',
  'rule-format features carry since + evidence provenance');

// rangeFloor / compareVersions primitives
assert(compareVersions('2.45', '2.42') > 0, 'compareVersions 2.45 > 2.42');
assert(rangeFloor('>=12 <13').join('.') === '12.0.0', 'rangeFloor extracts the lower bound', rangeFloor('>=12 <13'), [12,0,0]);

// ---------------------------------------------------------------------------
// The real test: the compiler emits DIFFERENT artefacts per version.
// ---------------------------------------------------------------------------
process.stdout.write('\n[compiler] version-faithful emission\n');

const baseDash = {
  metadata: { name: 'checkout', version: '1.0.0' },
  spec: {
    slis: [{ id: 'SLI-1', type: 'ratio', good: 'good_total', total: 'req_total', unit: 'ratio' }],
    slos: [{ id: 'SLO-1', sli: 'SLI-1', objective: 0.99, window: '30d' }],
    dashboards: [{
      id: 'DASH-1',
      provider: { kind: 'grafana', version: '12.3' },
      panel_bindings: [{ binds_to: 'slis.SLI-1', panel: 'Availability' }],
    }],
  },
};

const dash12 = JSON.parse(compileGrafanaDashboard(baseDash, 'DASH-1'));
assert(dash12.schemaVersion === 41, 'dashboard compiled for Grafana 12 -> schemaVersion 41', dash12.schemaVersion, 41);
assert(typeof dash12.panels[0].datasource === 'object', 'Grafana 12 emits object datasource');

const dash9 = JSON.parse(compileGrafanaDashboard(baseDash, 'DASH-1', { version: '9.5' }));
assert(dash9.schemaVersion === 37, 'override to Grafana 9 -> schemaVersion 37', dash9.schemaVersion, 37);
assert(typeof dash9.panels[0].datasource === 'string', 'Grafana 9 emits bare-uid datasource', typeof dash9.panels[0].datasource, 'string');
assert(dash9.schemaVersion !== dash12.schemaVersion, 'same pack compiles differently across Grafana versions');

// Prometheus keep_firing_for gating
const basePromAlert = {
  metadata: { name: 'checkout', version: '1.0.0' },
  spec: {
    slis: [{ id: 'SLI-1', type: 'ratio', good: 'good_total', total: 'req_total' }],
    slos: [{ id: 'SLO-1', sli: 'SLI-1', objective: 0.99, window: '30d' }],
    policy: {
      burn_rate_alerts: [{
        slo: 'SLO-1',
        windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }],
      }],
    },
    telemetry: { backends: [{ name: 'prom', signal: 'metrics', product: 'prometheus', version: { declared: '3.1' } }] },
  },
};
const rules3 = compilePrometheusRules(basePromAlert);
assert(/keep_firing_for/.test(rules3), 'Prometheus 3.x burn alerts include keep_firing_for');
assert(/>= 2\n\s*\)/.test(rules3), 'burn alerts carry the min-bad-samples floor on the short window');

const basePromAlertOld = JSON.parse(JSON.stringify(basePromAlert));
basePromAlertOld.spec.telemetry.backends[0].version.declared = '2.40';
const rules2 = compilePrometheusRules(basePromAlertOld);
assert(!/keep_firing_for/.test(rules2), 'Prometheus 2.40 burn alerts omit keep_firing_for');

// VictoriaMetrics target via override
const rulesVm = compilePrometheusRules(basePromAlert, { product: 'victoriametrics', version: '1.99' });
assert(!/keep_firing_for/.test(rulesVm), 'vmalert target omits keep_firing_for');

// OTel exporter rename
const baseOtel = {
  metadata: { name: 'checkout', version: '1.0.0' },
  spec: {
    pipelines: {
      receivers: [{ name: 'otlp' }],
      exporters: { metrics: { kind: 'logging' } },
    },
  },
};
const otelNewCfg = compileOtelCollector(baseOtel, { version: '0.96.0' });
assert(/\bdebug:/.test(otelNewCfg) && !/\blogging:/.test(otelNewCfg), 'otelcol 0.96 renames logging -> debug');
const otelOldCfg = compileOtelCollector(baseOtel, { version: '0.80.0' });
assert(/\blogging:/.test(otelOldCfg), 'otelcol <0.86 keeps logging exporter');
assert(/readers:/.test(otelNewCfg), 'otelcol 0.96 telemetry uses readers form');
assert(/address:/.test(otelOldCfg), 'otelcol <0.86 telemetry uses address form');

// Alertmanager msteams routing
const baseAm = {
  metadata: { name: 'checkout', version: '1.0.0' },
  spec: {
    alerting: { routes: [{ severity: 'SEV1', channels: [{ msteams: 'oncall-room' }] }] },
  },
};
const am28cfg = compileAlertmanager(baseAm, { version: '0.28.0' });
assert(/msteamsv2_configs/.test(am28cfg), 'Alertmanager 0.28 routes msteams to msteamsv2_configs');
const am26cfg = compileAlertmanager(baseAm, { version: '0.26.0' });
assert(/msteams_configs/.test(am26cfg) && !/msteamsv2_configs/.test(am26cfg), 'Alertmanager 0.26 routes to msteams_configs');

// ---------------------------------------------------------------------------
report('profile');
