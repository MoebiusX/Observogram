#!/usr/bin/env node
/**
 * tools/test-traceability-graph.mjs
 *
 * Regression tests for requirement-rooted graph comparison. These fixtures are
 * intentionally small: the point is to prove branch semantics, not pack volume.
 */

import { adapt } from './lib/adapter.mjs';
import {
  buildBranch,
  buildDependencyGraph,
  comparePackBranches,
  requirementRoots,
} from './lib/traceability-graph.mjs';

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness();

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function completePack() {
  return {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: {
      name: 'trace-graph-fixture',
      version: '0.1.0',
      bindings: {
        service: 'checkout',
        environments: ['prod'],
        criticality: 'tier-1',
      },
      annotations: {
        'crawler.discovered.metric_names': '["checkout_latency_seconds_bucket","checkout_latency_seconds_count"]',
        'crawler.discovered.metric_names_count': '2',
        'crawler.discovered.metric_origins': '{"checkout_latency_seconds_bucket":{"file":"src/metrics.ts","service":"checkout-api","type":"histogram"},"checkout_latency_seconds_count":{"file":"src/metrics.ts","service":"checkout-api","type":"histogram"}}',
        'crawler.discovered.scrape_jobs': '["checkout-api"]',
        'crawler.discovered.scrape_jobs_count': '1',
        'crawler.discovered.scrape_job_origins': '{"checkout-api":{"file":"prometheus/scrape.yml","metrics_path":"/metrics","interval":"10s","targets":["checkout-api:8080"]}}',
      },
    },
    spec: {
      telemetry: {
        backends: [{
          id: 'metrics-prom',
          signal: 'metrics',
          product: 'prometheus',
          default: true,
        }],
      },
      pipelines: {
        receivers: [{ name: 'otlp' }],
        processors: [{ name: 'batch' }],
        exporters: {
          metrics: { kind: 'prometheusremotewrite' },
        },
      },
      slis: [{
        id: 'checkout_latency',
        type: 'ratio',
        good: 'sum(rate(checkout_latency_seconds_bucket{le="2"}[5m]))',
        total: 'sum(rate(checkout_latency_seconds_count[5m]))',
      }],
      slos: [{
        id: 'checkout_latency_99',
        sli: 'checkout_latency',
        objective: 0.99,
        window: '30d',
      }],
      queries: {
        recording_rules: [{
          name: 'checkout:latency:ratio_5m',
          expr: 'ref:slis.checkout_latency',
          interval: '30s',
        }],
      },
      dashboards: [{
        id: 'checkout-slo',
        provider: { kind: 'grafana' },
        panel_bindings: [{
          panel: 'Checkout latency',
          binds_to: 'slis.checkout_latency',
        }],
      }],
      policy: {
        burn_rate_alerts: [{
          slo: 'checkout_latency_99',
          windows: [
            { short: '5m', long: '1h', factor: 14, severity: 'SEV1' },
            { short: '30m', long: '6h', factor: 6, severity: 'SEV2' },
          ],
        }],
      },
      alerting: {
        routes: [
          { severity: 'SEV1', channels: [{ email: 'oncall@example.com' }] },
          { severity: 'SEV2', channels: [{ email: 'team@example.com' }] },
        ],
      },
    },
  };
}

process.stdout.write('\n--- graph edge resolution ---\n');
const pack = completePack();
const adapted = adapt(pack);
const graph = buildDependencyGraph(adapted);
const roots = requirementRoots(graph);
assert(roots.length === 1, 'one SLO root discovered', roots.length, 1);

const edges = graph.edges.map((edge) => `${edge.type}:${edge.provenance}`);
assert(edges.includes('sli_of:declared'), 'SLO -> SLI edge is declared');
assert(edges.includes('protects:declared'), 'burn-rate -> SLO edge is declared');
assert(edges.includes('visualises:declared'), 'panel -> SLI edge is declared');
assert(edges.includes('sources:derived-promql'), 'PromQL source dependencies are derived, not fuzzy inferred');
assert(graph.edges.some((edge) => edge.type === 'exported_by'), 'metric -> metrics exporter edge exists');

const branch = buildBranch(graph, roots[0]);
const branchKinds = new Set(branch.nodes.map((node) => node.kind));
assert(branchKinds.has('recording_rule'), 'branch contains recording rule');
assert(branchKinds.has('metric'), 'branch contains metric series dependency');
assert(branchKinds.has('pipeline_exporter_metrics'), 'branch contains metrics exporter');
assert(branchKinds.has('scrape_job'), 'branch contains telemetry source / scrape job');
assert(branchKinds.has('backend'), 'branch contains metrics backend');
assert(branchKinds.has('burn_rate'), 'branch contains action limb');

process.stdout.write('\n--- self comparison ---\n');
const self = comparePackBranches(adapted, adapt(clone(pack)));
assert(self.rollup.declaredTotal === 1, 'self compare declares one requirement', self.rollup.declaredTotal, 1);
assert(self.rollup.intact === 1, 'complete self compare is intact', self.rollup.intact, 1);
assert(self.rollup.integrityMean === 1, 'complete self compare integrity is 1.0', self.rollup.integrityMean, 1);

process.stdout.write('\n--- live verifiability ---\n');
const liveWithoutDashboards = clone(pack);
liveWithoutDashboards.metadata.annotations = {
  'mcp.refreshedAt': '2026-06-09T00:00:00.000Z',
  'mcp.discovered.metric_names_count': '3',
  'mcp.discovered.metric_names_sample': 'checkout_latency_seconds_bucket,checkout_latency_seconds_count,checkout:latency:ratio_5m',
  'mcp.verified.pipelines.exporters.metrics': '2026-06-09T00:00:00.000Z',
};
liveWithoutDashboards.spec.dashboards = [];
const noDash = comparePackBranches(adapted, adapt(liveWithoutDashboards));
const noDashBranch = noDash.branches[0];
assert(noDashBranch.nodes.some((node) => node.kind === 'panel' && node.status === 'unverifiable'),
       'missing live panel is unverifiable, not declared-only');
assert(noDashBranch.verdict === 'intact',
       'dashboard-only blind spot does not break load-bearing branch',
       noDashBranch.verdict, 'intact');

process.stdout.write('\n--- metric inventory is required for live metric proof ---\n');
const liveNoMetricInventory = clone(pack);
liveNoMetricInventory.metadata.annotations = {
  'mcp.refreshedAt': '2026-06-09T00:00:00.000Z',
  'mcp.verified.pipelines.exporters.metrics': '2026-06-09T00:00:00.000Z',
};
const noMetric = comparePackBranches(adapted, adapt(liveNoMetricInventory));
assert(noMetric.branches[0].nodes.some((node) => node.kind === 'metric' && node.status === 'declared_only'),
       'PromQL-parsed live metric does not prove live metric existence when MCP inventory is absent');

const liveWithMetricInventory = clone(liveNoMetricInventory);
liveWithMetricInventory.metadata.annotations['mcp.discovered.metric_names_count'] = '3';
liveWithMetricInventory.metadata.annotations['mcp.discovered.metric_names'] =
  '["checkout_latency_seconds_bucket","checkout_latency_seconds_count","checkout:latency:ratio_5m"]';
const withMetric = comparePackBranches(adapted, adapt(liveWithMetricInventory));
assert(withMetric.branches[0].nodes.some((node) => node.kind === 'metric' && node.status === 'aligned'),
       'MCP metric inventory satisfies metric node in live branch');

const liveWithLegacyCountMetricNames = clone(liveNoMetricInventory);
liveWithLegacyCountMetricNames.metadata.annotations['mcp.discovered.metric_names_count'] = '2712';
liveWithLegacyCountMetricNames.metadata.annotations['mcp.discovered.metric_names'] = '2712';
liveWithLegacyCountMetricNames.metadata.annotations['mcp.discovered.metric_names_sample'] =
  'checkout_latency_seconds_bucket,checkout_latency_seconds_count,checkout:latency:ratio_5m';
const withLegacyMetricInventory = comparePackBranches(adapted, adapt(liveWithLegacyCountMetricNames));
assert(withLegacyMetricInventory.branches[0].nodes.some((node) => node.kind === 'metric' && node.status === 'aligned'),
       'legacy count-shaped metric_names falls back to sample for metric proof');

process.stdout.write('\n--- duplicate identity keys ---\n');
const dupPack = completePack();
// Mirror real crawler output: a second bare `otlp` receiver (collector
// `otlp/2`) and a second SEV2 email route — both collide on identity.
dupPack.spec.pipelines.receivers.push({ name: 'otlp' });
dupPack.spec.alerting.routes.push({ severity: 'SEV2', channels: [{ email: 'team@example.com' }] });
const dupAdapted = adapt(dupPack);
const dupGraph = buildDependencyGraph(dupAdapted);

assert((dupGraph.byKind.get('pipeline_receiver')?.size || 0) === 2,
       'both same-named receivers survive as graph nodes',
       dupGraph.byKind.get('pipeline_receiver')?.size, 2);
assert((dupGraph.byKind.get('alert_route')?.size || 0) === 3,
       'all three alert routes survive as graph nodes',
       dupGraph.byKind.get('alert_route')?.size, 3);
assert([...dupGraph.nodes.keys()].some((key) => /#02$/.test(key)),
       'colliding nodes carry occurrence-suffixed keys');
assert(dupGraph.collisions.length === 2
         && dupGraph.collisions.every((c) => c.count === 2)
         && dupGraph.collisions.map((c) => c.kind).sort().join(',') === 'alert_route,pipeline_receiver',
       'graph reports both identity collisions with kind and group size',
       JSON.stringify(dupGraph.collisions.map((c) => `${c.kind}:${c.count}`)), 'alert_route:2 + pipeline_receiver:2');
assert(dupGraph.collisions.every((c) => c.key.startsWith(`${c.kind}::`) && !/#\d+$/.test(c.key)),
       'graph collision keys are base identity keys, without occurrence suffixes');

const dupSelf = comparePackBranches(dupAdapted, adapt(clone(dupPack)));
assert(dupSelf.rollup.intact === 1 && dupSelf.rollup.integrityMean === 1,
       'self compare stays intact with duplicate identity keys',
       `${dupSelf.rollup.intact}/${dupSelf.rollup.integrityMean}`, '1/1');

process.stdout.write('\n--- broken action limb ---\n');
const noAlertPack = clone(pack);
noAlertPack.spec.policy.burn_rate_alerts = [];
const broken = comparePackBranches(adapt(noAlertPack), adapt(clone(noAlertPack)));
assert(broken.branches[0].verdict === 'broken',
       'SLO without burn-rate alert is a broken branch even when both sides agree',
       broken.branches[0].verdict, 'broken');
assert(broken.branches[0].missingRoles.some((role) => role.role === 'action'),
       'broken branch reports missing action limb');

report('traceability graph');
