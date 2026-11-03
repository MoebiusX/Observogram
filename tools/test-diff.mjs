#!/usr/bin/env node
/**
 * tools/test-diff.mjs
 *
 * Regression tests for the behavioural matcher. The important case is a pack
 * containing multiple artefacts with the same behavioural identity key:
 * duplicate-severity alert routes, duplicate dashboard ids, same
 * product+signal backend instances, and same-named pipeline stages. These
 * must survive diffPacks instead of being collapsed by a Map, and must be
 * reported on the top-level `collisions` surface.
 */

import { adapt } from './lib/adapter.mjs';
import { diffPacks, deltasOf } from './lib/diff.mjs';
import { metricFamilyResolver, foldMetricFamilies, isWithheldValue, REDACTED_CHANNEL_VALUE } from './lib/artefact-model.mjs';

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness();

const collisionPack = {
  apiVersion: 'observability.platform/v1',
  kind: 'ObservabilityPack',
  metadata: {
    name: 'matcher-collision-demo',
    version: '0.1.0',
    owners: ['team-platform'],
    bindings: {
      service: 'matcher-collision-demo',
      environments: ['prod'],
      criticality: 'tier-2',
    },
  },
  spec: {
    otel: {
      semconv: '1.27.0',
      resource_attributes: { required: ['service.name'] },
      sdk: { languages: ['go'], sampling: { policy: 'always_on' } },
    },
    telemetry: {
      backends: [
        { id: 'metrics-primary', signal: 'metrics', product: 'prometheus', endpoints: ['http://prom-a:9090'] },
        { id: 'metrics-replica', signal: 'metrics', product: 'prometheus', endpoints: ['http://prom-b:9090'], tenant: 'replica' },
      ],
    },
    slis: [
      {
        id: 'api_availability',
        type: 'ratio',
        good: 'sum(rate(http_requests_total{code!~"5.."}[5m]))',
        total: 'sum(rate(http_requests_total[5m]))',
      },
    ],
    slos: [
      {
        id: 'api_availability_99',
        sli: 'api_availability',
        objective: 0.99,
        window: '30d',
        error_budget_policy: 'ref:platform/default-budget',
      },
    ],
    pipelines: {
      // Duplicate bare stages mirror real crawler output: the collector's
      // `otlp/2` / `batch/2` ids strip to the same name.
      receivers: [{ name: 'otlp' }, { name: 'otlp' }],
      processors: [{ name: 'batch' }, { name: 'batch' }],
      exporters: {
        metrics: { kind: 'prometheusremotewrite' },
        logs: { kind: 'loki' },
        traces: { kind: 'jaeger' },
      },
    },
    queries: {
      recording_rules: [
        { name: 'demo:api_availability:ratio_5m', expr: 'ref:slis.api_availability' },
      ],
    },
    dashboards: [
      {
        id: 'overview',
        provider: { kind: 'grafana' },
        folder: 'service',
        panel_bindings: [{ panel: 'Availability', binds_to: 'slis.api_availability' }],
      },
      {
        id: 'overview',
        provider: { kind: 'grafana' },
        folder: 'slo',
        panel_bindings: [{ panel: 'SLO', binds_to: 'slos.api_availability_99' }],
      },
    ],
    policy: {
      burn_rate_alerts: [
        {
          slo: 'api_availability_99',
          windows: [
            { short: '5m', long: '1h', factor: 14, severity: 'SEV1' },
            { short: '30m', long: '6h', factor: 6, severity: 'SEV2' },
          ],
        },
      ],
    },
    alerting: {
      routes: [
        { severity: 'SEV2', match: { team: 'payments' }, channels: [{ email: 'payments@example.com' }] },
        { severity: 'SEV2', match: { team: 'settlement' }, channels: [{ webhook: 'https://hooks.example/settlement' }] },
        { severity: 'SEV2', match: { team: 'platform' }, channels: [{ msteams: '#platform-alerts' }] },
        // A fourth SEV2 route — one identity class of four, all of which
        // must survive via occurrence ordinals.
        { severity: 'SEV2', match: { team: 'fraud' }, channels: [{ webhook: 'https://hooks.example/fraud' }] },
      ],
    },
    baselines: { mttd_target_p50: '5m', mttr_target_p50: '2h' },
    validation: {
      synthetic_checks: [
        { id: 'health', kind: 'blackbox-exporter', target: 'https://example.test/health', interval: '1m' },
      ],
    },
  },
};

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function artefactCount(layered) {
  const l = layered.layers;
  return l.L1.length
    + l.L2.length
    + l.L2X.length
    + l.L3.length
    + l.L4.policy.length
    + l.L4.alerting.length
    + l.L4.healing.length
    + l.L5.length
    + l.GOV.length;
}

function flatComparableCount(layered) {
  const l = layered.layers;
  return artefactCount(layered) - l.L3.filter(a => (a.id || '').startsWith('PANEL-')).length;
}

process.stdout.write('\n--- collision preservation ---\n');
const declared = adapt(collisionPack);
const total = flatComparableCount(declared);
const self = diffPacks(declared, adapt(clone(collisionPack)));

assert(self.summary.inBoth === total,
       'self-diff preserves every flat-comparable artefact, including duplicate identity keys',
       self.summary.inBoth, total);
assert(!self.layers.L3.inBoth.some(x => x.key.startsWith('panel::')),
       'dashboard panels stay out of flat drift arithmetic');
assert(self.summary.onlyInA === 0 && self.summary.onlyInB === 0,
       'self-diff has no missing artefacts');
assert(self.summary.alignment === 1,
       'self-diff alignment remains 1.0');
assert(self.layers.L4.inBoth.filter(x => x.key.startsWith('alert_route::')).length === 4,
       'duplicate SEV2 routes survive as separate matched controls');

const routeIdentities = new Set(
  self.layers.L4.inBoth
    .filter(x => x.key.startsWith('alert_route::'))
    .map(x => x.key.replace(/#\d+$/, ''))
);
assert(routeIdentities.size === 1,
       'same-severity routes share one identity class, preserved as ordinals',
       routeIdentities.size, 1);

process.stdout.write('\n--- collision reporting ---\n');
const collidedKinds = new Set(self.collisions.map(c => c.kind));
for (const kind of ['alert_route', 'backend', 'dashboard', 'pipeline_receiver', 'pipeline_processor']) {
  assert(collidedKinds.has(kind), `self-diff reports the ${kind} identity collision`);
}
assert(self.collisions.length === 5,
       'exactly one collision entry per duplicated identity key',
       self.collisions.length, 5);
assert(new Set(self.collisions.map(c => c.key)).size === self.collisions.length,
       'collision keys are unique across the result');
assert(self.collisions.every(c => c.aCount > 1 || c.bCount > 1),
       'every reported collision has more than one artefact on some side');
assert(self.collisions.every(c => c.key.startsWith(`${c.kind}::`) && !/#\d+$/.test(c.key)),
       'collision keys are base identity keys, without occurrence suffixes');
const collisionLayers = Object.fromEntries(self.collisions.map(c => [c.kind, c.layer]));
assert(collisionLayers.alert_route === 'L4' && collisionLayers.dashboard === 'L3'
         && collisionLayers.backend === 'L2' && collisionLayers.pipeline_receiver === 'L2'
         && collisionLayers.pipeline_processor === 'L2',
       'collision entries carry the layer their group lives in',
       JSON.stringify(collisionLayers), 'alert_route:L4, dashboard:L3, rest:L2');
const routeCollision = self.collisions.find(c => c.kind === 'alert_route');
assert(routeCollision && routeCollision.aCount === 4 && routeCollision.bCount === 4,
       'all four SEV2 routes are counted in the route collision group',
       JSON.stringify(routeCollision), '{aCount: 4, bCount: 4}');

process.stdout.write('\n--- surplus duplicate drift ---\n');
const thinPack = clone(collisionPack);
thinPack.spec.telemetry.backends = thinPack.spec.telemetry.backends.slice(0, 1);
thinPack.spec.dashboards = thinPack.spec.dashboards.slice(0, 1);
thinPack.spec.alerting.routes = thinPack.spec.alerting.routes.slice(0, 1);
const thin = diffPacks(declared, adapt(thinPack));

assert(thin.summary.aTotal === total,
       'declared-side total still counts every artefact when live is thinner',
       thin.summary.aTotal, total);
assert(thin.summary.onlyInA === 5,
       'surplus duplicate controls are reported as onlyInA, not dropped',
       thin.summary.onlyInA, 5);
assert(thin.layers.L4.onlyInA.filter(x => x.key.startsWith('alert_route::')).length === 3,
       'three missing SEV2 routes are visible as drift');
assert(thin.collisions.some(c => c.kind === 'alert_route' && c.aCount === 4 && c.bCount === 1),
       'a lopsided identity group is still reported as a collision');

process.stdout.write('\n--- live placeholder routes still pair ---\n');
// fetch-live-pack.mjs and the crawler fabricate a channel kind when live
// routing cannot be introspected (e.g. { severity: SEV1, channels:
// [{ msteams: '#platform-oncall' }] }). Identity must stay severity-keyed so
// a declared route PAIRS with that placeholder as channel drift — putting
// channel kinds into identity would report it falsely missing in live.
const declaredRoutePack = clone(collisionPack);
declaredRoutePack.spec.alerting.routes = [
  { severity: 'SEV1', channels: [{ webhook: 'https://hooks.example/oncall' }] },
];
const livePlaceholderPack = clone(collisionPack);
livePlaceholderPack.spec.alerting.routes = [
  { severity: 'SEV1', channels: [{ msteams: '#platform-oncall' }] },
];
const placeholderDiff = diffPacks(adapt(declaredRoutePack), adapt(livePlaceholderPack));
const routePairs = placeholderDiff.layers.L4.inBoth.filter(x => x.key.startsWith('alert_route::'));
assert(routePairs.length === 1 && routePairs[0].match === 'drifted',
       'a declared route pairs with the live placeholder as channel drift',
       `${routePairs.length}/${routePairs[0]?.match}`, '1/drifted');
assert(placeholderDiff.layers.L4.onlyInA.every(x => !x.key.startsWith('alert_route::')),
       'no declared route is falsely reported missing in live');

process.stdout.write('\n--- canonicalisation edge cases ---\n');
const emptyArray = {
  id: 'BAK-01',
  defines: 'telemetry.backends.metrics-primary',
  spec: { id: 'metrics-primary', signal: 'metrics', product: 'prometheus', labels: [] },
};
const absentArray = {
  id: 'BAK-01',
  defines: 'telemetry.backends.metrics-primary',
  spec: { id: 'metrics-primary', signal: 'metrics', product: 'prometheus' },
};
assert(deltasOf(emptyArray, absentArray).length === 0,
       'empty arrays normalise like absent fields');

const sourceMetric = {
  id: 'METRIC-SRC-01',
  spec: {
    name: 'checkout_requests_total',
    type: 'counter',
    origin_kind: 'source-code',
    query: 'checkout_requests_total',
    references: [{ kind: 'recording-rule', name: 'checkout:availability:ratio_5m' }],
    used_by: ['recording:checkout:availability:ratio_5m'],
  },
};
const liveMetricInventory = {
  id: 'METRIC-01',
  spec: { name: 'checkout_requests_total' },
};
assert(deltasOf(sourceMetric, liveMetricInventory).length === 0,
       'source metric provenance does not drift against live metric-name inventory');

const declaredRuleExpr = {
  id: 'QRY-01',
  spec: {
    name: 'checkout:availability:ratio_5m',
    expr: 'sum(rate(checkout_requests_total{code!~"5.."}[5m])) / sum(rate(checkout_requests_total[5m]))',
  },
};
const liveRuleNameStub = {
  id: 'QRY-02',
  spec: {
    name: 'checkout:availability:ratio_5m',
    expr: 'checkout:availability:ratio_5m',
  },
};
assert(deltasOf(declaredRuleExpr, liveRuleNameStub).length === 0,
       'recording-rule name stubs are treated as partial evidence, not expression drift');

const liveRuleDifferentExpr = {
  id: 'QRY-02',
  spec: {
    name: 'checkout:availability:ratio_5m',
    expr: 'sum(rate(checkout_errors_total[5m]))',
  },
};
assert(deltasOf(declaredRuleExpr, liveRuleDifferentExpr).some(d => d.field === 'expr'),
       'two executable recording-rule expressions still drift when they differ');

const declaredSliExpr = {
  id: 'SLI-01',
  defines: 'slis.checkout_availability',
  spec: {
    id: 'checkout_availability',
    type: 'ratio',
    good: 'sum(rate(checkout_requests_total{code!~"5.."}[5m]))',
    total: 'sum(rate(checkout_requests_total[5m]))',
  },
};
const liveSliRuleRef = {
  id: 'SLI-01',
  defines: 'slis.checkout_availability',
  spec: {
    id: 'checkout_availability',
    type: 'ratio',
    good: 'checkout:availability:ratio_5m',
    total: '1',
  },
};
assert(deltasOf(declaredSliExpr, liveSliRuleRef).length === 0,
       'SLI raw PromQL and live recording-rule references are equivalent evidence levels');

const liveSliDifferentThreshold = clone(liveSliRuleRef);
liveSliDifferentThreshold.spec.type = 'threshold';
assert(deltasOf(declaredSliExpr, liveSliDifferentThreshold).some(d => d.field === 'type'),
       'decision-bearing SLI fields still drift');

const repoDashboardShell = {
  id: 'DSH-01',
  defines: 'dashboards.checkout',
  spec: {
    id: 'checkout',
    provider: { kind: 'grafana', version: '7' },
    folder: 'repo',
    panel_bindings: [{ panel: 'Availability', binds_to: 'slis.checkout_availability' }],
  },
};
const liveDashboardDetails = {
  id: 'DSH-01',
  defines: 'dashboards.checkout',
  spec: {
    id: 'checkout',
    provider: { kind: 'grafana', version: '12' },
    folder: 'prod',
    panel_bindings: [{ panel: 'Availability', binds_to: 'slis.checkout_availability' }],
    params: { returnedPanels: 42, panels: [{ id: 1, type: 'timeseries' }] },
  },
};
assert(deltasOf(repoDashboardShell, liveDashboardDetails).length === 0,
       'dashboard fetch-detail params do not drift the dashboard shell');

const sourceScrape = {
  id: 'SCRAPE-SRC-01',
  spec: {
    type: 'TelemetrySource',
    job: 'checkout-api',
    metrics_path: '/metrics',
    interval: '10s',
    targets: ['checkout-api:8080'],
    exports: ['checkout_requests_total'],
  },
};
const liveScrape = {
  id: 'SCRAPE-01',
  spec: {
    job: 'checkout-api',
    source: 'mcp.discovered.scrape_jobs',
  },
};
assert(deltasOf(sourceScrape, liveScrape).length === 0,
       'scrape-job detail richness does not drift against live scrape-job evidence');

const otelRepo = {
  id: 'OTEL-01',
  spec: {
    semconv: '1.26.0',
    sdk: { sampling: { policy: 'parentbased_traceidratio', ratio: 0.1 } },
  },
};
const otelLiveSameBehavior = {
  id: 'OTEL-01',
  spec: {
    semconv: '1.27.0',
    sdk: { sampling: { policy: 'parentbased_traceidratio', ratio: 0.1 } },
  },
};
assert(deltasOf(otelRepo, otelLiveSameBehavior).length === 0,
       'SemConv version alone is compatibility metadata, not live drift');

const otelLiveDifferentSampling = clone(otelLiveSameBehavior);
otelLiveDifferentSampling.spec.sdk.sampling.ratio = 1;
assert(deltasOf(otelRepo, otelLiveDifferentSampling).some(d => d.field === 'sdk'),
       'OTel sampling behavior still drifts');

process.stdout.write('\n--- multitenant live scope ---\n');
const scopedRepoPack = {
  apiVersion: 'observability.platform/v1',
  kind: 'ObservabilityPack',
  metadata: {
    name: 'checkout',
    version: '0.1.0',
    owners: ['team-checkout'],
    bindings: { service: 'checkout', environments: ['prod'], criticality: 'tier-2' },
    annotations: {
      'crawler.discovered.metric_names': JSON.stringify(['checkout_requests_total', 'alerts']),
      'crawler.discovered.metric_names_count': '2',
      'crawler.discovered.metric_origins': JSON.stringify({
        checkout_requests_total: { file: 'src/metrics.ts', service: 'checkout-api', type: 'counter' },
        alerts: { file: 'src/alerts.ts', service: 'checkout-api', type: 'gauge' },
      }),
    },
  },
  spec: {
    telemetry: { backends: [{ id: 'metrics', signal: 'metrics', product: 'prometheus' }] },
    slis: [{
      id: 'checkout_availability',
      type: 'ratio',
      good: 'sum(rate(checkout_requests_total{code!~"5.."}[5m]))',
      total: 'sum(rate(checkout_requests_total[5m]))',
    }],
    slos: [{ id: 'checkout_availability_99', sli: 'checkout_availability', objective: 0.99, window: '30d' }],
    queries: { recording_rules: [{ name: 'checkout:availability:ratio_5m', expr: 'ref:slis.checkout_availability' }] },
    dashboards: [{
      id: 'checkout-overview',
      provider: { kind: 'grafana' },
      panel_bindings: [{ panel: 'Checkout availability', binds_to: 'slis.checkout_availability' }],
    }],
    policy: { burn_rate_alerts: [{ slo: 'checkout_availability_99', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] }] },
    baselines: { mttd_target_p50: '5m', mttr_target_p50: '30m' },
  },
};
const scopedLivePack = clone(scopedRepoPack);
scopedLivePack.metadata = {
  name: 'production-live',
  version: '0.1.0',
  owners: ['mcp-fetcher'],
  bindings: { service: 'production-live', environments: ['prod'], criticality: 'tier-2' },
  annotations: {
    'mcp.refreshedAt': '2026-06-09T00:00:00.000Z',
    'mcp.discovered.metric_names': JSON.stringify([
      'checkout_requests_total',
      'checkout_shadow_total',
      'alertmanager_alerts_total',
      'solace_messages_total',
      'node_cpu_seconds_total',
    ]),
    'mcp.discovered.metric_names_count': '5',
  },
};
scopedLivePack.spec.dashboards = [
  ...scopedLivePack.spec.dashboards,
  { id: 'checkout-debug', provider: { kind: 'grafana' }, panel_bindings: [{ panel: 'Checkout shadow', binds_to: 'slis.checkout_availability' }] },
  { id: 'solace-clients', provider: { kind: 'grafana' }, panel_bindings: [{ panel: 'Solace clients', binds_to: 'slis.solace_availability' }] },
];
const scopedDiff = diffPacks(adapt(scopedRepoPack), adapt(scopedLivePack));
const l2OnlyInBKeys = scopedDiff.layers.L2.onlyInB.map(x => x.key);
const l2OutOfScopeKeys = scopedDiff.layers.L2.outOfScope.map(x => x.key);
const l3OnlyInBKeys = scopedDiff.layers.L3.onlyInB.map(x => x.key);
const l3OutOfScopeKeys = scopedDiff.layers.L3.outOfScope.map(x => x.key);
assert(l2OnlyInBKeys.some(k => k.includes('checkout_shadow_total')),
       'service-scoped live metric remains live-not-declared');
assert(l2OutOfScopeKeys.some(k => k.includes('solace_messages_total')),
       'foreign tenant live metric is out-of-scope');
assert(l2OutOfScopeKeys.some(k => k.includes('node_cpu_seconds_total')),
       'shared platform live metric is out-of-scope');
assert(l2OutOfScopeKeys.some(k => k.includes('alertmanager_alerts_total')),
       'platform metric containing a declared short metric token is out-of-scope');
assert(l3OnlyInBKeys.some(k => k.includes('checkout-debug')),
       'service-scoped live dashboard remains live-not-declared');
assert(l3OutOfScopeKeys.some(k => k.includes('solace-clients')),
       'foreign tenant live dashboard is out-of-scope');
assert(scopedDiff.scope?.mode === 'service',
       'default diff scope mode is service');
assert(scopedDiff.scope?.service === 'checkout',
       'default service scope is derived from Pack A');

const overriddenServiceDiff = diffPacks(adapt(scopedRepoPack), adapt(scopedLivePack), { service: 'solace' });
assert(overriddenServiceDiff.scope?.service === 'solace',
       'selected service override is reported in diff scope');
assert(overriddenServiceDiff.layers.L2.onlyInB.some(x => x.key.includes('solace_messages_total')),
       'selected service override brings matching live metric into scope');

const familyDiff = diffPacks(adapt(scopedRepoPack), adapt(scopedLivePack), { scopeMode: 'family' });
const familyL2OnlyInBKeys = familyDiff.layers.L2.onlyInB.map(x => x.key);
const familyL3OnlyInBKeys = familyDiff.layers.L3.onlyInB.map(x => x.key);
assert(familyDiff.scope?.mode === 'family',
       'family-only scope mode is reported');
assert(familyL2OnlyInBKeys.some(k => k.includes('solace_messages_total')),
       'family-only mode counts foreign live metric in a declared family');
assert(familyL3OnlyInBKeys.some(k => k.includes('solace-clients')),
       'family-only mode counts foreign live dashboard in a declared family');

const allLiveDiff = diffPacks(adapt(scopedRepoPack), adapt(scopedLivePack), { scopeMode: 'all' });
assert(allLiveDiff.scope?.mode === 'all',
       'all-live scope mode is reported');
assert(allLiveDiff.summary.outOfScope === 0,
       'all-live mode counts every unmatched live artefact as live-not-declared',
       allLiveDiff.summary.outOfScope, 0);

// ---------- an exporter's name is not the service's ----------
// A metric read from an exporter manifest carries the exporter as its service
// (`event-exporter`). Its name counts for the scope; its service string must
// not, or every live artefact whose text says "event" is pulled into scope.
{
  const repo = clone(scopedRepoPack);
  const names = JSON.parse(repo.metadata.annotations['crawler.discovered.metric_names']);
  const origins = JSON.parse(repo.metadata.annotations['crawler.discovered.metric_origins']);
  names.push('event_published_total');
  origins.event_published_total = { file: 'exporter/metrics-manifest.json', service: 'event-exporter', type: 'counter', origin_kind: 'exporter-manifest' };
  repo.metadata.annotations['crawler.discovered.metric_names'] = JSON.stringify(names);
  repo.metadata.annotations['crawler.discovered.metric_names_count'] = String(names.length);
  repo.metadata.annotations['crawler.discovered.metric_origins'] = JSON.stringify(origins);
  // A declared scrape job, so the scrape-job kind is one the repo speaks of (else every live job is parked unseen).
  repo.metadata.annotations['crawler.discovered.scrape_jobs'] = JSON.stringify(['checkout-api']);
  repo.metadata.annotations['crawler.discovered.scrape_jobs_count'] = '1';
  const live = clone(scopedLivePack);
  const liveNames = [...JSON.parse(live.metadata.annotations['mcp.discovered.metric_names']), 'event_published_total'];
  live.metadata.annotations['mcp.discovered.metric_names'] = JSON.stringify(liveNames);
  live.metadata.annotations['mcp.discovered.metric_names_count'] = String(liveNames.length);
  live.spec.dashboards = [...live.spec.dashboards, { id: 'event-pipeline', provider: { kind: 'grafana' }, panel_bindings: [{ panel: 'Event lag', binds_to: 'slis.event_lag' }] }];
  live.metadata.annotations['mcp.discovered.scrape_jobs'] = JSON.stringify(['event-exporter', 'other-exporter']);

  // The two exporter origins whose service is always an emitter behave alike.
  for (const originKind of ['exporter-manifest', 'exporter-config']) {
    origins.event_published_total.origin_kind = originKind;
    repo.metadata.annotations['crawler.discovered.metric_origins'] = JSON.stringify(origins);
    const d = diffPacks(adapt(repo), adapt(live));
    assert(!d.scope.serviceTokens.includes('event') && !d.scope.serviceTokens.includes('eventexporter'),
           `a ${originKind} metric does not lend the exporter's name to the service scope`, d.scope.serviceTokens);
    assert(JSON.stringify(d.scope.exporterTokens) === JSON.stringify(['event', 'eventexporter']),
           `the exporter's name is kept apart as exporterTokens (${originKind})`, d.scope.exporterTokens);
    assert(d.layers.L2.inBoth.some(x => x.key.includes('event_published_total')),
           `the ${originKind} metric itself still pairs by name`);
    assert(d.layers.L3.outOfScope.some(x => x.key.includes('event-pipeline')),
           `a live dashboard that only shares the exporter's name stays out of scope (${originKind})`);
    assert(d.layers.L2.onlyInB.some(x => x.key.includes('event-exporter')),
           `the live job that scrapes the exporter is in scope (${originKind})`, d.layers.L2.onlyInB.map(x => x.key));
    assert(d.layers.L2.outOfScope.some(x => x.key.includes('other-exporter')),
           `a live job named for another exporter is not (${originKind})`);
  }

  // The same metric declared in source code, or read from a saved exposition
  // (named by its file, as often the service's own `checkout-api.prom` as a
  // third party's): that service string still widens the scope.
  for (const [originKind, file] of [['source-code', 'src/events.ts'], ['exporter-snapshot', 'docs/event-exporter.prom']]) {
    origins.event_published_total = { ...origins.event_published_total, file, origin_kind: originKind };
    repo.metadata.annotations['crawler.discovered.metric_origins'] = JSON.stringify(origins);
    const d2 = diffPacks(adapt(repo), adapt(live));
    assert(d2.scope.serviceTokens.includes('event') && !('exporterTokens' in d2.scope),
           `a ${originKind} metric's service still lends its tokens, and no exporterTokens key appears`, d2.scope);
    assert(d2.layers.L3.onlyInB.some(x => x.key.includes('event-pipeline')),
           `and the dashboard that shares them is then in scope (${originKind})`);
  }
  assert(!('exporterTokens' in scopedDiff.scope),
         'a pack without an exporter origin reports no exporterTokens key (goldens unchanged)');
}

// ---------- a dashboard reaches the scope through the metrics its panels query ----------
// A live dashboard's scope text used to be its id, folder and refs, so a
// dashboard in a foreign folder that charts a metric this pack declares was
// parked out of scope unless a name token happened to match. Its title, its
// panels' titles and its panel expressions now count, in both shapes the
// packs carry: the live one (`params.title`, panel summaries, the raw Grafana
// JSON's `panels[].targets[].expr`, rows nested) and the crawled one
// (`params.panels[].{title,expr}`).
{
  // The repo declares, besides its own `checkout_requests_total`, a specific
  // series with no service word in it and two platform series.
  const repo = clone(scopedRepoPack);
  const names = JSON.parse(repo.metadata.annotations['crawler.discovered.metric_names']);
  const origins = JSON.parse(repo.metadata.annotations['crawler.discovered.metric_origins']);
  for (const name of ['basket_depth_ratio', 'node_cpu_seconds_total', 'up']) {
    names.push(name);
    origins[name] = { file: 'src/metrics.ts', service: 'checkout-api', type: 'gauge' };
  }
  repo.metadata.annotations['crawler.discovered.metric_names'] = JSON.stringify(names);
  repo.metadata.annotations['crawler.discovered.metric_names_count'] = String(names.length);
  repo.metadata.annotations['crawler.discovered.metric_origins'] = JSON.stringify(origins);

  const liveDash = (id, folder, title, panels, raw) => ({
    id, provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 }, folder, source: `grafana:///d/${id}`,
    params: { uid: id, title, panelCount: panels.length, returnedPanels: panels.length, panels, ...(raw ? { raw } : {}) },
    panel_bindings: panels.map((p, i) => ({ panel: p.title, binds_to: `ref:grafana/${id}/panels/panel-${i + 1}` })),
  });
  const summaries = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, title: `Series ${i + 1}`, type: 'timeseries' }));
  const live = clone(scopedLivePack);
  live.spec.dashboards = [
    ...live.spec.dashboards,
    // A foreign folder, generic names; the only link to the pack is a target expression on the specific metric, inside a row.
    liveDash('mq-ops', 'Platform MQ', 'Queue depth', [{ id: 1, title: 'Depth', type: 'timeseries' }], {
      panels: [{ id: 10, type: 'row', title: 'Traffic', panels: [{ id: 1, title: 'Depth', type: 'timeseries', targets: [{ refId: 'A', expr: 'max(basket_depth_ratio) by (queue)' }] }] }],
    }),
    // An expression on a series that merely contains the declared name: not this pack's.
    liveDash('mq-ops-2', 'Platform MQ', 'Buckets', [{ id: 1, title: 'Buckets', type: 'timeseries' }], {
      panels: [{ id: 1, title: 'Buckets', type: 'timeseries', targets: [{ refId: 'A', expr: 'sum(rate(basket_depth_ratio_bucket[5m]))' }] }],
    }),
    // Summaries only (no JSON returned), nothing in the names: out of scope as before.
    liveDash('mq-ops-3', 'Platform MQ', 'Latency', [{ id: 1, title: 'Latency', type: 'timeseries' }], null),
    // A platform board charting the platform series the repo also declares: not carried in by `node_*` or `up`.
    liveDash('node-health', 'Platform', 'Node health', [{ id: 1, title: 'CPU', type: 'timeseries' }], {
      panels: [{ id: 1, title: 'CPU', type: 'timeseries', targets: [{ refId: 'A', expr: 'rate(node_cpu_seconds_total[5m])' }, { refId: 'B', expr: 'count(up == 1)' }] }],
    }),
    // The service's name in the board's title, nothing else: the token path, as for an id or a folder.
    liveDash('funnel-7', 'Product', 'Checkout funnel', [{ id: 1, title: 'Steps', type: 'timeseries' }], null),
    // A big board: 400 summaries, and the one target that names the specific metric at the end of the JSON.
    liveDash('mq-big', 'Platform MQ', 'Everything MQ', summaries(400), {
      panels: [...summaries(399).map((p) => ({ ...p, targets: [{ refId: 'A', expr: 'sum(rate(mq_other_total[5m]))' }] })), { id: 400, title: 'Series 400', type: 'timeseries', targets: [{ refId: 'A', expr: 'max(basket_depth_ratio)' }] }],
    }),
    // The crawled shape: params.panels carry the expression themselves.
    { id: 'mq-crawled', provider: { kind: 'grafana' }, folder: 'Platform MQ', params: { title: 'MQ crawled', panels: [{ panel: 'depth', title: 'Depth', expr: 'max(basket_depth_ratio)' }] } },
    // A service token inside an expression is not a match: expressions are read for whole metric names only.
    liveDash('steps-9', 'Product', 'Steps', [{ id: 1, title: 'Steps', type: 'timeseries' }], {
      panels: [{ id: 1, title: 'Steps', type: 'timeseries', targets: [{ refId: 'A', expr: 'sum(rate(precheckout_steps_total[5m]))' }] }],
    }),
    // The bounds: the 512th raw panel is read, the 513th is not; the 16th target is read, the 17th is not.
    liveDash('bound-in', 'Platform MQ', 'Bound in', [], { panels: [...summaries(511), { id: 512, title: 'Last', type: 'timeseries', targets: [{ refId: 'A', expr: 'max(basket_depth_ratio)' }] }] }),
    liveDash('bound-out', 'Platform MQ', 'Bound out', [], { panels: [...summaries(512), { id: 513, title: 'Last', type: 'timeseries', targets: [{ refId: 'A', expr: 'max(basket_depth_ratio)' }] }] }),
    liveDash('targets-in', 'Platform MQ', 'Targets in', [], { panels: [{ id: 1, title: 'Many', type: 'timeseries', targets: [...Array.from({ length: 15 }, (_, i) => ({ refId: `T${i}`, expr: 'up' })), { refId: 'Z', expr: 'max(basket_depth_ratio)' }] }] }),
    liveDash('targets-out', 'Platform MQ', 'Targets out', [], { panels: [{ id: 1, title: 'Many', type: 'timeseries', targets: [...Array.from({ length: 16 }, (_, i) => ({ refId: `T${i}`, expr: 'up' })), { refId: 'Z', expr: 'max(basket_depth_ratio)' }] }] }),
  ];
  const d = diffPacks(adapt(repo), adapt(live));
  const onlyInB = d.layers.L3.onlyInB.map(x => x.key);
  const outOfScope = d.layers.L3.outOfScope.map(x => x.key);
  const has = (list, id) => list.some(k => k.includes(`"id":"${id}"`));
  assert(has(onlyInB, 'mq-ops'), 'a live dashboard whose raw panel target queries a declared metric is in scope', onlyInB);
  assert(has(outOfScope, 'mq-ops-2'), 'an expression on a series that merely contains the declared name does not carry a dashboard in', outOfScope);
  assert(has(outOfScope, 'mq-ops-3'), 'a dashboard with summaries only and foreign names stays out of scope', outOfScope);
  assert(has(outOfScope, 'node-health'), 'a platform board on the generic series the repo declares (node_*, up) stays out of scope', outOfScope);
  assert(has(onlyInB, 'funnel-7'), 'the service\'s name in the board title carries it in, as an id or folder would', onlyInB);
  assert(has(onlyInB, 'mq-big'), 'a board with hundreds of summaries still has its last raw target read', onlyInB);
  assert(has(onlyInB, 'mq-crawled'), 'a crawled dashboard whose params.panels expression names a declared metric is in scope', onlyInB);
  assert(has(outOfScope, 'steps-9'), 'a service token inside an expression does not carry a dashboard in: expressions are read for whole metric names only', outOfScope);
  assert(has(onlyInB, 'bound-in') && has(outOfScope, 'bound-out'), 'the 512th raw panel is read and the 513th is not', [onlyInB, outOfScope]);
  assert(has(onlyInB, 'targets-in') && has(outOfScope, 'targets-out'), 'the 16th target is read and the 17th is not', [onlyInB, outOfScope]);
  assert(d.layers.L2.outOfScope.some(x => x.key.includes('alertmanager_alerts_total')) && d.layers.L2.inBoth.some(x => x.key.includes('node_cpu_seconds_total')),
         'the metric rule is untouched: an undeclared platform metric is still out of scope, a declared one still pairs');
}

// ---------- `ref:` prefix is authoring syntax, not behaviour ----------
// A burn alert declared as `slo: ref:x` and one discovered as `slo: x` bind
// to the same SLO. Identity already stripped the prefix (they paired); the
// behavioural model must strip it too, or the pair reads as drifted on its
// own binding — a false-drift for every repo pack that uses `ref:`.
{
  const refPack = clone(scopedRepoPack);
  refPack.spec.policy.burn_rate_alerts[0].slo = 'ref:checkout_availability_99';
  refPack.spec.slos[0].error_budget_policy = 'ref:platform/default-budget';
  const barePack = clone(scopedRepoPack);
  barePack.spec.slos[0].error_budget_policy = 'platform/default-budget';
  const refDiff = diffPacks(adapt(refPack), adapt(barePack), { scopeMode: 'off' });
  const burnPair = refDiff.layers.L3.inBoth.find(e => e.key.startsWith('burn_rate::'))
    || Object.values(refDiff.layers).flatMap(l => l.inBoth).find(e => e.key.startsWith('burn_rate::'));
  assert(burnPair && burnPair.match === 'aligned',
    'burn alert with slo ref:x ALIGNS with slo x (identity paired, behaviour now agrees)', burnPair);
  const sloPair = Object.values(refDiff.layers).flatMap(l => l.inBoth).find(e => e.key.startsWith('slo::'));
  assert(sloPair && sloPair.match === 'aligned',
    'slo with error_budget_policy ref:… aligns with the bare reference', sloPair);
  assert(refDiff.summary.drifted === 0,
    'ref:-only rewrites produce no drift anywhere in the pack', refDiff.summary);
  // The prefix is cosmetic; the TARGET is not.
  const otherPack = clone(scopedRepoPack);
  otherPack.spec.policy.burn_rate_alerts[0].slo = 'ref:checkout_latency_99';
  const otherDiff = diffPacks(adapt(refPack), adapt(otherPack), { scopeMode: 'off' });
  assert(otherDiff.summary.aligned < refDiff.summary.aligned,
    'NEGATIVE: a burn alert bound to a different SLO does not align', otherDiff.summary);
  // The recording rule declared as `expr: ref:slis.x` against a live rule
  // carrying the compiled expression is still partial evidence, not drift.
  const compiledPack = clone(scopedRepoPack);
  compiledPack.spec.queries.recording_rules[0].expr = 'sum(rate(checkout_requests_total{code!~"5.."}[5m])) / sum(rate(checkout_requests_total[5m]))';
  const compiledDiff = diffPacks(adapt(scopedRepoPack), adapt(compiledPack), { scopeMode: 'off' });
  const rulePair = Object.values(compiledDiff.layers).flatMap(l => l.inBoth).find(e => e.key.startsWith('recording_rule::'));
  assert(rulePair && rulePair.match === 'aligned',
    'expr ref:slis.x vs the compiled expression stays partial-evidence aligned after ref stripping', rulePair);
}

// ---------- client classification contract ----------
// The studio classifies compare cards and traceability rows by the artefact
// objects EMBEDDED in diff entries (studio/compare-view.mjs
// buildCompareKeySets / categorizeTrace): every bucket entry must carry its
// artefact(s) with a non-empty id, and within one layer no id may appear
// twice on the same pack side — otherwise the per-side id maps misclassify.
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const { parse } = await import('./lib/mini-yaml.mjs');
  const dir = new URL('../examples/', import.meta.url);
  const packs = [];
  for (const f of readdirSync(dir).filter(f => f.endsWith('.pack.yaml'))) {
    try { packs.push({ name: f, layered: adapt(parse(readFileSync(new URL(f, dir), 'utf8'))) }); }
    catch (_) { /* legacy/unadaptable packs are covered elsewhere */ }
  }
  assert(packs.length >= 3, 'client-contract check loads at least 3 bundled packs', packs.map(p => p.name));

  const checkDiff = (label, diff) => {
    const violations = [];
    for (const [L, bucket] of Object.entries(diff.layers)) {
      const sides = { a: new Set(), b: new Set() };
      const track = (side, art, where) => {
        if (!art?.id) { violations.push(`${L} ${where}: entry missing embedded artefact id`); return; }
        if (sides[side].has(art.id)) violations.push(`${L} ${where}: id ${art.id} repeats on side ${side}`);
        sides[side].add(art.id);
      };
      for (const e of bucket.inBoth) { track('a', e.a, 'inBoth.a'); track('b', e.b, 'inBoth.b'); }
      for (const e of bucket.onlyInA) track('a', e.artefact, 'onlyInA');
      for (const e of bucket.onlyInB) track('b', e.artefact, 'onlyInB');
      for (const e of bucket.outOfScope) track('b', e.artefact, 'outOfScope');
    }
    assert(violations.length === 0,
      `${label}: every diff entry embeds a unique-per-side artefact id`, violations.slice(0, 5));
  };

  for (const a of packs) for (const b of packs) {
    for (const scopeMode of ['service', 'all']) {
      checkDiff(`${a.name} vs ${b.name} (${scopeMode})`, diffPacks(a.layered, b.layered, { scopeMode }));
    }
  }
  checkDiff('collision-pack self-diff',
    diffPacks(adapt(clone(collisionPack)), adapt(clone(collisionPack)), { scopeMode: 'all' }));
}

process.stdout.write('\n--- scaffold placeholders never pair ---\n');
{
  // The live fetcher's schema-forced burn-rate placeholder carries the
  // compiler's default windows (5m/1h/14x + 30m/6h/6x) on the live pack's
  // first SLO — byte-identical to a declared default-window alert on the
  // same SLO. It is not an alerting rule; it must not read `aligned`.
  const live = clone(collisionPack);
  live.metadata.annotations = {
    'mcp.url': 'https://example.test/mcp',
    'mcp.refreshedAt': '2026-06-09T00:00:00.000Z',
    'mcp.scaffold.policy.burn_rate_alerts[0]': 'schema-required fallback; no burn-rate alerting rule discovered via MCP',
  };
  const d = diffPacks(adapt(clone(collisionPack)), adapt(live), { scopeMode: 'all' });
  const l4 = d.layers.L4;
  assert(!l4.inBoth.some(e => e.a?.id === 'POL-01' || e.b?.id === 'POL-01'),
         'declared burn-rate alert is not paired with the live Scaffold placeholder, even with identical windows',
         l4.inBoth.map(e => `${e.a?.id}/${e.b?.id}:${e.match}`));
  assert(l4.onlyInA.some(e => e.artefact?.id === 'POL-01'),
         'the declared burn-rate alert reads declared, not live (onlyInA)',
         l4.onlyInA.map(e => e.artefact?.id));
  assert(!l4.onlyInB.some(e => e.artefact?.id === 'POL-01'),
         'the placeholder never reads live, not declared (onlyInB)');
  assert(l4.scaffold.length === 1 && l4.scaffold[0].side === 'b' && l4.scaffold[0].artefact?.id === 'POL-01'
         && l4.scaffold[0].artefact?.source === 'Scaffold',
         'the placeholder is parked in the layer scaffold bucket with its side',
         l4.scaffold.map(e => `${e.side}:${e.artefact?.id}:${e.artefact?.source}`));
  assert(d.summary.scaffold === 1 && d.summary.onlyInA === 1 && d.summary.onlyInB === 0,
         'summary counts the parked placeholder separately and the declared alert as onlyInA',
         { scaffold: d.summary.scaffold, onlyInA: d.summary.onlyInA, onlyInB: d.summary.onlyInB });
  assert(d.summary.inBoth === self.summary.inBoth - 1 && d.summary.union === self.summary.union,
         'the parked placeholder leaves the in-scope union (declared alert moved from inBoth to onlyInA)',
         { inBoth: d.summary.inBoth, union: d.summary.union }, { inBoth: self.summary.inBoth - 1, union: self.summary.union });

  // Symmetric: a repo crawler's placeholder (crawler.scaffold.*) never
  // reads declared, not live — and never aligns with a real live route.
  const repo = clone(collisionPack);
  repo.metadata.annotations = { 'crawler.scaffold.alerting.routes[0]': 'schema-required fallback; no source evidence found in selected environment' };
  const d2 = diffPacks(adapt(repo), adapt(clone(collisionPack)), { scopeMode: 'all' });
  assert(!d2.layers.L4.onlyInA.some(e => e.artefact?.id === 'ALR-01')
         && !d2.layers.L4.inBoth.some(e => e.a?.id === 'ALR-01'),
         'a repo scaffold route is neither onlyInA nor paired');
  assert(d2.layers.L4.scaffold.some(e => e.side === 'a' && e.artefact?.id === 'ALR-01'),
         'the repo scaffold route is parked on side a');
  assert(d2.layers.L4.onlyInB.some(e => e.artefact?.id === 'ALR-01'),
         'the live route the repo only had a placeholder for reads live, not declared');
}

// ---------- metric families: a metric and the series it is exposed as ----------
{
  const fam = (names, types = {}) => metricFamilyResolver(names, (n) => types[n] || null);

  const hist = fam(['req_seconds', 'req_seconds_bucket', 'req_seconds_count', 'req_seconds_sum']);
  assert(['req_seconds_bucket', 'req_seconds_count', 'req_seconds_sum', 'req_seconds'].every(n => hist(n) === 'req_seconds'),
    'a histogram and its _bucket / _count / _sum series are one family');
  assert(fam(['x_bucket'])('x_bucket') === 'x', '_bucket alone is enough: the suffix is reserved for histograms');
  assert(fam(['queue_count'])('queue_count') === 'queue_count' && fam(['bytes_sum'])('bytes_sum') === 'bytes_sum',
    'a lone _count or _sum is its own metric — a gauge that happens to end that way is not folded');
  assert(fam(['gc_seconds_count', 'gc_seconds_sum'])('gc_seconds_count') === 'gc_seconds',
    '_count and _sum together are a summary');
  assert(fam(['lat', 'lat_count'], { lat: 'go-prometheus-histogram-vec' })('lat_count') === 'lat',
    'a declared distribution type claims its _count even when no _bucket is known');
  assert(fam(['jobs_total', 'jobs_created'])('jobs_created') === 'jobs_total',
    'a counter\'s _created series folds into the counter');
  assert(fam(['jobs', 'jobs_total', 'jobs_created'], { jobs: 'counter' })('jobs_total') === 'jobs'
    && fam(['jobs', 'jobs_total', 'jobs_created'], { jobs: 'counter' })('jobs_created') === 'jobs',
    'a counter declared without the suffix pairs with the _total (and _created) it is exposed as');
  assert(fam(['jobs', 'jobs_total'], { jobs: 'gauge' })('jobs_total') === 'jobs_total'
    && fam(['jobs', 'jobs_total'])('jobs_total') === 'jobs_total',
    '_total is only folded into a metric DECLARED a counter — two unrelated names stay two metrics');
  assert(fam(['orphan_created'])('orphan_created') === 'orphan_created', 'a _created with nothing to belong to stays itself');
  assert(fam(['Req_Seconds_Bucket'])('REQ_SECONDS_BUCKET') === 'req_seconds', 'names are compared lowercase');

  const metric = (name, extra = {}) => ({ id: `METRIC-${name}`, title: name, source: 'Verified', spec: { name, ...extra } });
  const other = { id: 'SCRAPE-01', title: 'scrape: api', spec: { job: 'api' } };
  const aItems = [metric('req_seconds', { metric_type: 'histogram' }), metric('up'), other];
  const bItems = [metric('req_seconds_sum'), metric('req_seconds_bucket'), metric('req_seconds_count'), metric('up'), other];
  const snapshot = JSON.stringify([aItems, bItems]);
  const folded = foldMetricFamilies(aItems, bItems);
  assert(JSON.stringify([aItems, bItems]) === snapshot, 'foldMetricFamilies never mutates its inputs');
  assert(folded.a.length === 3 && folded.a[0] === aItems[0] && folded.a[1] === aItems[1] && folded.a[2] === other,
    'a metric alone in its family, and every non-metric, is passed through untouched (same object)');
  const live = folded.b.find(x => x.spec?.name === 'req_seconds');
  assert(folded.b.length === 3 && live && live.title === 'req_seconds'
    && JSON.stringify(live.series) === JSON.stringify(['req_seconds_bucket', 'req_seconds_count', 'req_seconds_sum']),
    'three series fold into one artefact named like the family, carrying the series it stands for', folded.b.map(x => x.spec?.name || x.id));
  assert(folded.b.indexOf(live) === 0, 'the family takes the place of its first member — order is otherwise kept');
}

// ---------- notObserved: what the other pack had no way to look at ----------
{
  const declared = clone(collisionPack);
  const live = clone(collisionPack);
  // The live side saw no dashboards (its probe failed) and has no tool for
  // the collector configuration. What it holds of those families is a
  // schema-forced placeholder.
  live.spec.dashboards = [{ id: 'platform-overview', provider: { kind: 'grafana' }, folder: 'platform', source: 'file://dashboards/platform-overview.json' }];
  live.spec.pipelines.receivers = [{ name: 'otlp' }];
  live.metadata.annotations = {
    'mcp.scaffold.dashboards.platform-overview': 'schema-required fallback; not attested by any MCP tool',
    'mcp.scaffold.pipelines.receivers[0]': 'schema-required fallback; not attested by any MCP tool',
    'observogram.unobserved.dashboard': 'the dashboards probe got no answer: HTTP 401',
    'observogram.unobserved.pipeline_receiver': 'no MCP tool exposes the collector configuration',
    // A family named unobserved whose artefacts DO pair is simply compared.
    'observogram.unobserved.alert_route': 'not looked at',
  };
  const base = diffPacks(adapt(declared), adapt(clone(collisionPack)), { scopeMode: 'all' });
  const d = diffPacks(adapt(declared), adapt(live), { scopeMode: 'all' });
  const unseen = Object.values(d.layers).flatMap(l => l.notObserved);
  const declaredDashboards = adapt(declared).layers.L3.filter(x => x.id.startsWith('DASH-')).length;
  const declaredReceivers = adapt(declared).layers.L2.filter(x => x.id.startsWith('PIP-RCV-')).length;
  assert(unseen.filter(e => e.key.startsWith('dashboard::')).length === declaredDashboards
    && unseen.filter(e => e.key.startsWith('pipeline_receiver::')).length === declaredReceivers
    && unseen.length === declaredDashboards + declaredReceivers,
    'artefacts of a family the other pack could not observe are notObserved — every one, and nothing else',
    unseen.map(e => e.key));
  assert(unseen.every(e => e.side === 'a' && typeof e.artefact?.id === 'string')
    && unseen.find(e => e.key.startsWith('dashboard::')).reason === 'the dashboards probe got no answer: HTTP 401',
    'each entry carries the side that holds the artefact and the other side\'s reason');
  assert(!Object.values(d.layers).some(l => l.onlyInA.some(e => /^(dashboard|pipeline_receiver)::/.test(e.key))),
    'none of them reads "declared, not live"');
  assert(d.summary.notObserved === unseen.length && d.summary.onlyInA === 0 && d.summary.onlyInB === 0,
    'the summary counts them apart', d.summary);
  assert(d.summary.union === base.summary.union - unseen.length && d.summary.jaccard === 1,
    'they are outside the union: what could not be checked does not lower the match', [d.summary.union, base.summary.union, d.summary.jaccard]);
  assert(d.layers.L4.inBoth.filter(e => e.key.startsWith('alert_route::')).length
    === base.layers.L4.inBoth.filter(e => e.key.startsWith('alert_route::')).length,
    'a family named unobserved whose artefacts pair anyway is compared as usual');
  assert(Object.values(base.layers).every(l => Array.isArray(l.notObserved) && l.notObserved.length === 0) && base.summary.notObserved === 0,
    'without the annotation the bucket is present and empty on every layer');

  // Symmetric: the family is unobserved on side A; B's artefact is the unchecked one.
  const blindRepo = clone(collisionPack);
  blindRepo.spec.dashboards = [{ id: 'stub', provider: { kind: 'grafana' }, folder: 'x', source: 'file://stub.json' }];
  blindRepo.metadata.annotations = {
    'crawler.scaffold.dashboards.stub': 'schema-required fallback',
    'observogram.unobserved.dashboard': 'no dashboard files in the scanned folder',
  };
  const d2 = diffPacks(adapt(blindRepo), adapt(clone(collisionPack)), { scopeMode: 'all' });
  const unseenB = d2.layers.L3.notObserved;
  assert(unseenB.length === declaredDashboards && unseenB.every(e => e.side === 'b' && e.reason === 'no dashboard files in the scanned folder')
    && !d2.layers.L3.onlyInB.some(e => e.key.startsWith('dashboard::')),
    'symmetric: B\'s artefacts of a family A could not observe are notObserved on side b, not "live, not declared"');
}

// ---------- an address a source would not state is not a difference ----------
{
  assert(isWithheldValue(REDACTED_CHANNEL_VALUE) && isWithheldValue('unresolved:WEBHOOK_URL')
    && !isWithheldValue('https://hooks.example.com/x') && !isWithheldValue('${WEBHOOK_URL}') && !isWithheldValue(null),
    'redacted:secret and unresolved:<VAR> are withheld values; a URL, a raw placeholder and null are not');
  const route = (channels) => ({ id: 'ALR-01', title: 'SEV1 routes', spec: { severity: 'SEV1', channels } });
  const fields = (a, b) => deltasOf(route(a), route(b)).map(x => x.field);
  assert(fields([{ webhook: 'https://ntfy.sh/topic' }], [{ webhook: 'redacted:secret' }]).length === 0,
    'a webhook address one side redacted is not a delta against the address the other side states');
  assert(fields([{ webhook: 'unresolved:HOOK_URL' }], [{ webhook: 'redacted:secret' }]).length === 0,
    'a deploy-time variable on one side and a redaction on the other: the same channel');
  assert(fields([{ email: 'a@x.io' }, { webhook: 'https://h/1' }], [{ email: 'a@x.io' }, { webhook: 'redacted:secret' }]).length === 0,
    'the kinds neither side withholds must still agree — and here they do');
  assert(JSON.stringify(fields([{ email: 'a@x.io' }, { webhook: 'https://h/1' }], [{ email: 'b@x.io' }, { webhook: 'redacted:secret' }])) === '["channels"]',
    'a different e-mail address beside a redacted webhook is still a delta');
  assert(JSON.stringify(fields([{ webhook: 'https://h/1' }], [{ msteams: 'redacted:secret' }])) === '["channels"]',
    'a different channel KIND is a delta, redacted or not');
  assert(JSON.stringify(fields([{ webhook: 'https://h/1' }], [{ webhook: 'redacted:secret' }, { webhook: 'redacted:secret' }])) === '["channels"]',
    'a different NUMBER of channels is a delta');
  assert(JSON.stringify(fields([{ webhook: 'https://h/1' }], [{ webhook: 'https://h/2' }])) === '["channels"]',
    'two stated addresses that differ are a delta, as before');
}

// ---------- an SLI's good / total are expressions: whitespace is not drift ----------
{
  const sli = (good, total) => ({ id: 'SLI-01', defines: 'slis.availability', spec: { id: 'availability', type: 'ratio', good, total } });
  assert(deltasOf(sli('sum(rate(ok_total[5m]))', 'sum(rate(all_total[5m]))'), sli('sum(rate(ok_total[5m]))\n', 'sum( rate(all_total[5m]) )\n')).length === 0,
    'a rule body with a trailing newline or inner blanks is the same SLI');
  assert(deltasOf(sli('sum(rate(ok_total[5m]))', '1'), sli('sum(rate(ok_total[1m]))', '1')).map(x => x.field).join() === 'good',
    'a different window in `good` is still a delta');
}

// ---------- a snapshot's scope: what it did not read is "not checked", never "missing" ----------
{
  const metricA = (name) => ({ id: `METRIC-${name}`, title: name, tags: ['metric'], source: 'Declared', parent: 'telemetry.metric_inventory', spec: { name } });
  const dash = (id, folderUid) => ({ id: `DASH-${id}`, title: id, source: 'Declared', defines: `dashboards.${id}`, spec: { id, folder: 'f', params: { title: id, uid: id, ...(folderUid ? { folderUid } : {}) } } });
  const rec = (record) => ({ id: `QRY-${record}`, title: record, tags: ['recording'], tool: 'Prometheus recording rule', source: 'Declared', spec: { name: record, expr: 'sum(up)' } });
  const pack = (id, { L2 = [], L3 = [] }, annotations = {}) => ({ id, name: id, meta: { service: 'payments', annotations }, layers: { L1: [], L2, L2X: [], L3, L4: { policy: [], alerting: [], healing: [] }, L5: [], GOV: [] } });
  const SCOPE = {
    'observogram.scope.metric': '{"by":"prefix","values":["payments_"]}',
    'observogram.scope.dashboard': '{"by":"folder","values":[{"uid":"ab12","title":"Payments"}]}',
  };
  const repo = () => pack('repo', {
    L2: [metricA('payments_total'), metricA('orders_total')],
    L3: [dash('crawled', null), dash('elsewhere', 'cd34'), dash('payments-main', 'ab12'), rec('job:up:sum')],
  });
  const snapshot = (annotations = SCOPE) => pack('snapshot', { L2: [metricA('payments_total')], L3: [dash('payments-live', 'ab12')] }, annotations);
  const byKey = (d) => Object.fromEntries(Object.values(d.layers).flatMap(l => [
    ...l.notObserved.map(e => [e.artefact.id, `notObserved:${e.side}:${e.reason}`]),
    ...l.onlyInA.map(e => [e.artefact.id, 'onlyInA']), ...l.onlyInB.map(e => [e.artefact.id, 'onlyInB']),
    ...l.outOfScope.map(e => [e.artefact.id, 'outOfScope']), ...l.inBoth.map(e => [e.a.id, 'inBoth']),
  ]));

  const d = byKey(diffPacks(repo(), snapshot()));
  assert(d['METRIC-payments_total'] === 'inBoth' && d['METRIC-orders_total'] === "notObserved:a:outside the snapshot's metric scope (prefixes payments_)",
    'a metric outside the snapshot\'s prefixes is not checked, with the scope as its reason; one inside pairs', d);
  assert(d['DASH-elsewhere'] === "notObserved:a:outside the snapshot's dashboard folders (Payments)",
    'a dashboard whose folder uid is outside the snapshot\'s folders is "outside"', d['DASH-elsewhere']);
  assert(d['DASH-crawled'] === 'notObserved:a:the snapshot read only the folders Payments; Pack A does not say which folder this dashboard is in, so it was not checked',
    'a crawled dashboard (no folder uid) is never called outside: the reason says only what is known', d['DASH-crawled']);
  assert(d['DASH-payments-main'] === 'onlyInA' && d['QRY-job:up:sum'] === 'onlyInA' && d['DASH-payments-live'] === 'onlyInB',
    'inside the scope an absence is real (declared, not live); a family the snapshot did not scope is untouched', d);

  // Symmetric: the snapshot on side A, the repository on side B.
  const s = byKey(diffPacks(snapshot(), repo(), { scopeMode: 'all' }));
  assert(s['METRIC-orders_total'] === "notObserved:b:outside the snapshot's metric scope (prefixes payments_)"
    && s['DASH-crawled'] === 'notObserved:b:the snapshot read only the folders Payments; Pack B does not say which folder this dashboard is in, so it was not checked'
    && s['DASH-payments-main'] === 'onlyInB',
    'symmetric: the other side\'s out-of-scope artefacts are notObserved on side b, the reason naming Pack B', s);

  // Without the annotation — or with one that does not parse — the pair is compared as before.
  const plain = diffPacks(repo(), snapshot({}));
  const broken = diffPacks(repo(), snapshot({ 'observogram.scope.metric': '{nope', 'observogram.scope.dashboard': '{"by":"folder","values":[]}' }));
  assert(JSON.stringify(broken) === JSON.stringify({ ...plain, b: broken.b }) && plain.summary.notObserved === 0
    && byKey(plain)['METRIC-orders_total'] === 'onlyInA' && byKey(plain)['DASH-crawled'] === 'onlyInA',
    'without a scope annotation (or with one that does not parse) nothing is parked', plain.summary);
  const scoped = diffPacks(repo(), snapshot());
  assert(scoped.summary.notObserved === 3 && scoped.summary.onlyInA === plain.summary.onlyInA - 3 && scoped.summary.union === plain.summary.union - 3,
    'parked artefacts leave the union: what the snapshot did not read does not lower the match', [scoped.summary, plain.summary]);

  // A family the snapshot could not observe at all keeps that reason over its scope.
  const blind = byKey(diffPacks(repo(), snapshot({ ...SCOPE, 'observogram.unobserved.dashboard': 'this MCP offers no dashboards tool' })));
  assert(blind['DASH-crawled'] === 'notObserved:a:this MCP offers no dashboards tool' && blind['DASH-payments-main'] === 'notObserved:a:this MCP offers no dashboards tool',
    'an unobserved family keeps the unobserved reason, inside the scope or not', blind);
}

// ---------- dynamic metric families ----------
// An exporter that mints one counter per queue cannot list its names; its
// manifest declares a pattern (METRIC-FAM-NN), and a live name the pattern
// matches reads as declared. Everything here must leave a pack without a
// family byte for byte as it was.
{
  const declare = (pack, patterns, extra = {}) => {
    const out = clone(pack);
    out.metadata.annotations = {
      ...out.metadata.annotations,
      'crawler.discovered.metric_families': JSON.stringify(patterns.map(pattern => ({ pattern, exporter: 'acme-exporter', file: 'exporter/metrics-manifest.json', type: 'counter' }))),
      ...extra,
    };
    return out;
  };
  const listing = (names, extra = {}) => {
    const out = clone(scopedLivePack);
    const all = [...JSON.parse(out.metadata.annotations['mcp.discovered.metric_names']), ...names];
    out.metadata.annotations = {
      ...out.metadata.annotations,
      'mcp.discovered.metric_names': JSON.stringify(all),
      'mcp.discovered.metric_names_count': String(all.length),
      ...extra,
    };
    return out;
  };
  const claimed = (d, side = 'b') => d.layers.L2.inBoth.filter(x => x.matchedBy === 'declared-family').map(x => (side === 'b' ? x.b : x.a).title || (side === 'b' ? x.b : x.a).spec.name);
  const keys = (list) => list.map(x => x.key);
  const FAMILY = '^acme_queue_[a-z0-9_]+_total$';

  const artefact = adapt(declare(scopedRepoPack, [FAMILY])).layers.L2.find(x => x.id === 'METRIC-FAM-01');
  assert(artefact && artefact.spec.name_pattern === FAMILY && artefact.spec.origin_kind === 'exporter-family' && artefact.spec.origin_service === 'acme-exporter'
    && artefact.spec.origin_file === 'exporter/metrics-manifest.json' && artefact.source === 'Declared',
    'a declared family is a METRIC-FAM artefact naming its pattern, exporter and file', artefact);
  for (const raw of ['{nope', '{"pattern":"^acme_"}', '[{"type":"counter"},7]']) {
    const none = clone(scopedRepoPack);
    none.metadata.annotations['crawler.discovered.metric_families'] = raw;
    assert(!adapt(none).layers.L2.some(x => x.id?.startsWith('METRIC-FAM-')), 'an annotation that holds no family projects none', raw);
  }

  // Live names the pattern matches are inBoth, aligned, under the family.
  const members = ['acme_queue_orders_total', 'acme_queue_refunds_total'];
  const d = diffPacks(adapt(declare(scopedRepoPack, [FAMILY])), adapt(listing([...members, 'acme_other_total'])));
  const entry = d.layers.L2.inBoth.find(x => x.b.spec?.name === members[0]);
  assert(entry && entry.a.id === 'METRIC-FAM-01' && entry.match === 'aligned' && entry.matchedBy === 'declared-family' && entry.deltas.length === 0,
    'a live member pairs with the family: aligned, matchedBy declared-family, no deltas', entry);
  assert(JSON.stringify(claimed(d).sort()) === JSON.stringify(members), 'every live name the pattern matches is claimed, and only those', claimed(d));
  assert(!keys(d.layers.L2.onlyInB).some(k => k.includes('acme_queue')) && !keys(d.layers.L2.onlyInA).some(k => k.includes('acme_queue')),
    'a claimed member is not live-not-declared, and the family is never declared-not-live', [d.layers.L2.onlyInA, d.layers.L2.onlyInB]);
  assert(keys(d.layers.L2.onlyInB).some(k => k.includes('acme_other_total')) && d.scope.metricPrefixes.includes('acme'),
    "the pattern's prefix is in scope: the exporter's other metric is live, not declared, not parked", [keys(d.layers.L2.onlyInB), d.scope.metricPrefixes]);
  const sum = d.summary.dynamicFamilies;
  assert(sum.declared === 1 && sum.members === 2 && sum.unmatched.length === 0 && sum.refused.length === 0
    && sum.families.length === 1 && sum.families[0].pattern === FAMILY && sum.families[0].members === 2 && sum.families[0].side === 'a' && sum.families[0].exporter === 'acme-exporter',
    'summary.dynamicFamilies accounts for each family', sum);
  // A member is a pair like any other: it counts in the ratios.
  const without = diffPacks(adapt(scopedRepoPack), adapt(listing([])));
  const noMember = diffPacks(adapt(declare(scopedRepoPack, [FAMILY])), adapt(listing(['acme_other_total'])));
  assert(d.summary.aligned === noMember.summary.aligned + 2 && d.summary.aligned === without.summary.aligned + 2
    && d.summary.alignment === Math.round((d.summary.aligned / d.summary.union) * 100) / 100
    && d.summary.jaccard === Math.round((d.summary.inBoth / d.summary.union) * 100) / 100,
    'members count in aligned and in the ratios', [d.summary, noMember.summary]);
  const missing = clone(scopedRepoPack);
  missing.metadata.annotations['crawler.discovered.metric_names'] = JSON.stringify([...JSON.parse(missing.metadata.annotations['crawler.discovered.metric_names']), 'acme_gone_a', 'acme_gone_b', 'acme_gone_c', 'acme_gone_d', 'acme_gone_e']);
  const many = Array.from({ length: 200 }, (_, i) => `acme_queue_q${i}_total`);
  const swamp = diffPacks(adapt(declare(missing, [FAMILY])), adapt(listing(many)));
  const small = diffPacks(adapt(declare(missing, [FAMILY])), adapt(listing([])));
  assert(swamp.summary.aligned === small.summary.aligned + 200 && swamp.summary.alignment > small.summary.alignment && swamp.summary.jaccard > small.summary.jaccard,
    '200 members raise the ratios', [swamp.summary, small.summary]);
  assert(swamp.summary.onlyInA === small.summary.onlyInA && keys(swamp.layers.L2.onlyInA).filter(k => k.includes('acme_gone_')).length === 5 && swamp.summary.dynamicFamilies.members === 200,
    'five declared metrics that are gone stay named, and the summary says how much rests on a pattern', swamp.summary);
  assert(d.summary.inBoth === d.layers.L1.inBoth.length + d.layers.L2.inBoth.length + d.layers.L2X.inBoth.length + d.layers.L3.inBoth.length + d.layers.L4.inBoth.length + d.layers.L5.inBoth.length + d.layers.GOV.inBoth.length,
    'the members count as inBoth', d.summary);
  assert(!d.scope.serviceTokens.includes('acme') && !d.scope.serviceTokens.includes('acmeexporter') && JSON.stringify(d.scope.exporterTokens) === JSON.stringify(['acme', 'acmeexporter']),
    "a family does not lend its exporter's name to the service scope", d.scope);
  assert(d.scope.declaredMetricCount === diffPacks(adapt(scopedRepoPack), adapt(listing([]))).scope.declaredMetricCount,
    'a pattern is not counted as a declared metric', d.scope);

  // A pack with no family keeps its bytes: no key, nothing moved.
  const plain = diffPacks(adapt(scopedRepoPack), adapt(listing(members)));
  assert(!('dynamicFamilies' in plain.summary) && !JSON.stringify(plain).includes('declared-family'),
    'no family: the summary gains no key', plain.summary);
  assert(keys(plain.layers.L2.onlyInB).length + keys(plain.layers.L2.outOfScope).length >= 2, 'no family: the same names are not claimed', plain.layers.L2);

  // A literal pair wins over a family.
  const literal = clone(scopedRepoPack);
  literal.metadata.annotations['crawler.discovered.metric_names'] = JSON.stringify([...JSON.parse(literal.metadata.annotations['crawler.discovered.metric_names']), members[0]]);
  const lit = diffPacks(adapt(declare(literal, [FAMILY])), adapt(listing(members)));
  const byName = lit.layers.L2.inBoth.filter(x => x.b.spec?.name === members[0]);
  assert(byName.length === 1 && byName[0].a.id.startsWith('METRIC-SRC-') && !byName[0].matchedBy && lit.summary.dynamicFamilies.members === 1,
    'a name the pack declares literally pairs with the literal, not the family', byName);

  // A folded family is tested by its series; names are as listed.
  const series = ['acme_queue_wait_seconds_bucket', 'acme_queue_wait_seconds_count', 'acme_queue_wait_seconds_sum'];
  const folded = diffPacks(adapt(declare(scopedRepoPack, ['^acme_queue_wait_seconds_bucket$'])), adapt(listing(series)));
  const fam = folded.layers.L2.inBoth.filter(x => x.matchedBy === 'declared-family');
  assert(fam.length === 1 && fam[0].b.series.length === 3 && folded.summary.dynamicFamilies.members === 1,
    'a histogram the store lists as three series is one member, matched through any of them', fam);
  const cased = diffPacks(adapt(declare(scopedRepoPack, ['^acme_queue_'])), adapt(listing(['ACME_QUEUE_ORDERS_TOTAL'])));
  assert(cased.summary.dynamicFamilies.members === 0, 'a metric name is case-sensitive: a pattern matches it as listed', cased.summary.dynamicFamilies);
  const long = `acme_queue_${'x'.repeat(260)}`;
  const longD = diffPacks(adapt(declare(scopedRepoPack, ['^acme_queue_'])), adapt(listing([long])));
  assert(longD.summary.dynamicFamilies.members === 0, 'a name longer than a pattern was timed against is not tested', longD.summary.dynamicFamilies);

  // The first family that matches holds the member.
  const two = diffPacks(adapt(declare(scopedRepoPack, ['^acme_queue_', '^acme_queue_orders_'])), adapt(listing(['acme_queue_orders_total'])));
  const rows = two.summary.dynamicFamilies.families;
  assert(rows.find(r => r.pattern === '^acme_queue_').members === 1 && rows.find(r => r.pattern === '^acme_queue_orders_').members === 0
    && rows.find(r => r.pattern === '^acme_queue_orders_').covered === 1 && two.summary.dynamicFamilies.unmatched.length === 0,
    'the first family that matches wins; the other did match a name, so it is not "matched nothing"', two.summary.dynamicFamilies);

  // A family that matched nothing: unmatched where the other side read whole, not checked where it did not.
  const empty = diffPacks(adapt(declare(scopedRepoPack, [FAMILY])), adapt(listing([])));
  assert(JSON.stringify(empty.summary.dynamicFamilies.unmatched) === JSON.stringify([FAMILY]) && !JSON.stringify(empty.layers.L2.onlyInA).includes('METRIC-FAM'),
    'no member: named in unmatched, never declared-not-live', empty.summary.dynamicFamilies);
  const blindD = diffPacks(adapt(declare(scopedRepoPack, [FAMILY])), adapt(listing([], { 'observogram.unobserved.metric': 'this MCP offers no metric names tool' })));
  assert(blindD.summary.dynamicFamilies.unmatched.length === 0 && blindD.summary.dynamicFamilies.families[0].notObserved === 'this MCP offers no metric names tool',
    'the other side could not list metrics: not checked, with its reason, not unmatched', blindD.summary.dynamicFamilies);
  const within = (scope) => diffPacks(adapt(declare(scopedRepoPack, [FAMILY])), adapt(listing([], { 'observogram.scope.metric': JSON.stringify(scope) }))).summary.dynamicFamilies;
  const outside = within({ by: 'prefix', values: ['payments_'] });
  assert(outside.unmatched.length === 0 && /does not cover this family/.test(outside.families[0].notObserved),
    'the other side read metrics within a scope that misses the family: not checked, not unmatched', outside);
  const covering = within({ by: 'prefix', values: ['acme_'] });
  assert(JSON.stringify(covering.unmatched) === JSON.stringify([FAMILY]) && !covering.families[0].notObserved,
    'a scope that covers the family read everything it can name: nothing minted is unmatched', covering);
  const excluding = within({ by: 'prefix', values: ['acme_'], exclude: ['^acme_queue_'] });
  assert(excluding.unmatched.length === 0 && excluding.families[0].notObserved, 'a scope that also excludes by pattern may have dropped its names: not checked', excluding);

  // A family that matched only metrics the pack also lists by name did match.
  const listed = clone(scopedRepoPack);
  listed.metadata.annotations['crawler.discovered.metric_names'] = JSON.stringify([...JSON.parse(listed.metadata.annotations['crawler.discovered.metric_names']), ...members]);
  const emitted = diffPacks(adapt(declare(listed, [FAMILY])), adapt(listing(members))).summary.dynamicFamilies;
  assert(emitted.members === 0 && emitted.unmatched.length === 0 && emitted.families[0].covered === 2,
    'beside the names `packc emit` scraped, a family is not "matched nothing"', emitted);

  // A side that says it cannot observe metrics claims nothing through a family.
  const blindOwner = diffPacks(adapt(listing(['acme_queue_lost_total'])), adapt(declare(scopedRepoPack, [FAMILY], { 'observogram.unobserved.metric': 'no metric tool' })), { scopeMode: 'all' });
  assert(blindOwner.summary.dynamicFamilies.members === 0 && blindOwner.layers.L2.notObserved.some(x => x.key.includes('acme_queue_lost_total')) && blindOwner.summary.dynamicFamilies.families[0].notObserved === 'no metric tool',
    'a family on a side blind to metrics: the name stays not observed', blindOwner.summary.dynamicFamilies);

  // Past the limit is a refusal too, never a silent drop.
  const seventy = Array.from({ length: 70 }, (_, i) => `^acme_f${String(i).padStart(2, '0')}_`);
  const capped = diffPacks(adapt(declare(scopedRepoPack, seventy)), adapt(listing(['acme_f69_x']))).summary.dynamicFamilies;
  assert(capped.declared === 70 && capped.refused.length === 6 && capped.refused.every(r => /over the limit of 64/.test(r.reason)) && capped.members === 0,
    'families past the limit are listed as refused', capped.refused);

  // One pattern is one row, repeated in an annotation or across layers.
  const repeated = diffPacks(adapt(declare(scopedRepoPack, [FAMILY, FAMILY])), adapt(declare(scopedRepoPack, [FAMILY, FAMILY])));
  assert(repeated.layers.L2.inBoth.filter(x => x.key === `metric::family:${FAMILY}`).length === 1 && repeated.summary.dynamicFamilies.families.length === 2 && repeated.summary.dynamicFamilies.unmatched.length === 0,
    'a repeated pattern pairs once and is one row per side', repeated.summary.dynamicFamilies);
  const layered = adapt(declare(scopedRepoPack, [FAMILY]));
  layered.layers.L2X = [...(layered.layers.L2X || []), { ...layered.layers.L2.find(x => x.id === 'METRIC-FAM-01'), id: 'METRIC-FAM-02' }];
  const acrossLayers = diffPacks(layered, adapt(listing(members))).summary.dynamicFamilies;
  assert(acrossLayers.families.length === 1 && acrossLayers.members === 2 && acrossLayers.unmatched.length === 0, 'a pattern in two layers is one row, its members counted once', acrossLayers);

  // A pattern in an annotation is anyone's text: the manifest's rule again, and a refusal claims nothing.
  for (const [pattern, why] of [['^node_', /belongs to a platform/], ['^(?=acme_).*', /lookaround/], ['^.*$', /literal metric-name prefix/], ['^acme_queue|.*', /alternative outside a group/], ['^ac', /literal metric-name prefix/], ['acme_', /anchored/], ['^acme_(a+)+$', /nested quantifier/], ['^acme_(', /invalid regex/]]) {
    const bad = diffPacks(adapt(declare(scopedRepoPack, [pattern])), adapt(listing(members)));
    const refused = bad.summary.dynamicFamilies.refused;
    assert(refused.length === 1 && why.test(refused[0].reason) && claimed(bad).length === 0 && bad.summary.dynamicFamilies.members === 0 && bad.summary.dynamicFamilies.unmatched.length === 0,
      `the pattern ${pattern} is refused, says why, and claims nothing`, bad.summary.dynamicFamilies);
    assert(!JSON.stringify(bad.layers.L2.onlyInA).includes('METRIC-FAM') && !JSON.stringify(bad.layers.L2.inBoth).includes('METRIC-FAM'), 'a refused family is in no bucket', pattern);
  }

  // Either side may declare it: the snapshot on A, the repository on B.
  const swapped = diffPacks(adapt(listing(members)), adapt(declare(scopedRepoPack, [FAMILY])), { scopeMode: 'all' });
  const swap = swapped.layers.L2.inBoth.filter(x => x.matchedBy === 'declared-family');
  assert(swap.length === 2 && swap.every(x => x.b.id === 'METRIC-FAM-01' && x.a.spec.name.startsWith('acme_queue_')) && !keys(swapped.layers.L2.onlyInA).some(k => k.includes('acme_queue'))
    && swapped.summary.dynamicFamilies.families[0].side === 'b',
    'a family on side B claims the unmatched metrics of side A', swap);

  // One pattern on both sides is one declaration.
  const twice = adapt(declare(scopedRepoPack, [FAMILY]));
  const self = diffPacks(twice, adapt(declare(scopedRepoPack, [FAMILY])));
  const selfRows = self.summary.dynamicFamilies;
  assert(self.summary.onlyInA === 0 && self.summary.onlyInB === 0 && self.summary.drifted === 0 && self.summary.alignment === 1
    && self.layers.L2.inBoth.some(x => x.key === `metric::family:${FAMILY}` && x.match === 'aligned') && selfRows.declared === 1 && selfRows.unmatched.length === 0 && self.collisions.length === 0,
    'a self-diff with a family is fully aligned, the family paired with itself', self.summary);

  // Declaring a family speaks for the metric kind even with no literal metric.
  const bare = clone(scopedRepoPack);
  for (const k of ['crawler.discovered.metric_names', 'crawler.discovered.metric_names_count', 'crawler.discovered.metric_origins']) delete bare.metadata.annotations[k];
  const kindMode = diffPacks(adapt(declare(bare, [FAMILY])), adapt(listing([...members, 'unrelated_total'])), { scopeMode: 'family' });
  assert(keys(kindMode.layers.L2.onlyInB).some(k => k.includes('unrelated_total')) && kindMode.summary.dynamicFamilies.members === 2,
    'with only a family declared, the rest of the live metrics are in scope', kindMode.layers.L2.onlyInB);

  // The other pairing keys reach the claim too.
  const byNameMode = diffPacks(adapt(declare(scopedRepoPack, [FAMILY])), adapt(listing(members)), { identity: 'name' });
  assert(byNameMode.summary.dynamicFamilies.members === 2 && byNameMode.identity.mode === 'name', 'a family claims under the name identity too', byNameMode.summary.dynamicFamilies);
}

report('diff');
