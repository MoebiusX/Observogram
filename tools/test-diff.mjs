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

report('diff');
