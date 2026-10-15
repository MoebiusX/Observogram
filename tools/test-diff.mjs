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

report('diff');
