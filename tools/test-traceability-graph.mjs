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
  graphShape,
  requirementRoots,
} from './lib/traceability-graph.mjs';
import { DEFAULT_WEIGHTS, blastRadiusOf } from './lib/blast-radius.mjs';

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

process.stdout.write('\n--- live scaffold placeholders are not live evidence ---\n');
{
  // Live pack = the same declaration, but its burn-rate entry is the
  // fetcher's schema-forced placeholder (no alerting rule exists) and its
  // SEV1 route is the hard-coded fallback. Both carry the compiler's
  // default shape, so behavioural pairing would read them aligned.
  const livePack = clone(pack);
  livePack.metadata.annotations = {
    ...livePack.metadata.annotations,
    'mcp.url': 'https://example.test/mcp',
    'mcp.refreshedAt': '2026-06-09T00:00:00.000Z',
    'mcp.scaffold.policy.burn_rate_alerts[0]': 'schema-required fallback; no burn-rate alerting rule discovered via MCP',
    'mcp.scaffold.alerting.routes[0]': 'schema-required fallback; not attested by any MCP tool',
  };
  const cmp = comparePackBranches(adapted, adapt(livePack));
  const br = cmp.branches[0];
  const burn = br.nodes.filter((n) => n.kind === 'burn_rate');
  assert(burn.length === 1 && burn[0].status === 'declared_only' && burn[0].bId === null,
         'declared burn-rate alert reads declared_only against the live Scaffold placeholder (never aligned/drifted)',
         burn.map((n) => `${n.status}:${n.aId}/${n.bId}`), ['declared_only:POL-01/null']);
  assert(!br.nodes.some((n) => n.status === 'live_only'),
         'no placeholder is reported as a live_only (undeclared) node',
         br.nodes.filter((n) => n.status === 'live_only').map((n) => `${n.kind}:${n.bId}`), []);
  assert(br.verdict === 'broken',
         'a branch whose only action limb is a live placeholder is broken, not intact', br.verdict, 'broken');
  const sev1 = br.nodes.find((n) => n.kind === 'alert_route' && n.aId === 'ALR-01');
  assert(sev1 && sev1.status === 'declared_only',
         'declared SEV1 route reads declared_only against the scaffold route (a real SEV2 route proves live can see routes)',
         sev1?.status, 'declared_only');

  // A live-only branch rooted on a placeholder SLO (the fetcher's
  // per-service availability guess) is not an undeclared commitment.
  const guessPack = clone(livePack);
  guessPack.spec.slis.push({ id: 'svc_guess_availability', type: 'ratio', good: 'sum(rate(g[5m]))', total: 'sum(rate(t[5m]))' });
  guessPack.spec.slos.push({ id: 'svc_guess_availability_99', sli: 'svc_guess_availability', objective: 0.99, window: '30d' });
  guessPack.metadata.annotations['mcp.scaffold.slis.svc_guess_availability'] = 'schema-required fallback; not attested by any MCP tool';
  guessPack.metadata.annotations['mcp.scaffold.slos.svc_guess_availability_99'] = 'schema-required fallback; not attested by any MCP tool';
  const cmp2 = comparePackBranches(adapted, adapt(guessPack));
  assert(cmp2.rollup.undeclared === 0 && cmp2.rollup.total === 1,
         'a branch rooted on a scaffold SLO is dropped instead of counted as undeclared',
         cmp2.rollup, { undeclared: 0, total: 1 });
  // ...while a real live-only SLO still is one.
  const realPack = clone(guessPack);
  delete realPack.metadata.annotations['mcp.scaffold.slis.svc_guess_availability'];
  delete realPack.metadata.annotations['mcp.scaffold.slos.svc_guess_availability_99'];
  const cmp3 = comparePackBranches(adapted, adapt(realPack));
  assert(cmp3.rollup.undeclared === 1 && cmp3.rollup.total === 2,
         'a real live-only SLO still counts as undeclared', cmp3.rollup, { undeclared: 1, total: 2 });
}

process.stdout.write('\n--- blast radius rides along, scoring untouched ---\n');
{
  // graphShape: the artefact-free projection the zero-import module reads.
  const shape = graphShape(graph);
  assert(shape.nodes.length === graph.nodes.size && shape.edges.length === graph.edges.length,
         'graphShape round-trips node and edge counts',
         [shape.nodes.length, shape.edges.length], [graph.nodes.size, graph.edges.length]);
  assert(shape.nodes.every((n) => Object.keys(n).join() === 'key,identityKey,kind,layer,label,virtual,scaffold'
           && typeof n.key === 'string' && typeof n.kind === 'string' && typeof n.label === 'string'
           && typeof n.virtual === 'boolean' && typeof n.scaffold === 'boolean' && !('artefact' in n)),
         'graphShape nodes carry key/identityKey/kind/layer/label/virtual/scaffold and no artefact');
  assert(shape.edges.every((e) => Object.keys(e).join() === 'key,from,to,type,provenance'), 'graphShape edges carry key/from/to/type/provenance');
  assert(shape.nodes.some((n) => n.kind === 'metric' && n.virtual === true), 'virtual metric nodes survive the projection as virtual');

  // The scrape job's structural exposure on the fixture graph itself.
  const scrapeKey = [...graph.byKind.get('scrape_job')][0];
  const direct = blastRadiusOf(shape, scrapeKey);
  assert(direct?.summary.slos === 1 && direct.summary.alerts === 1 && direct.blinded.nodes.some((n) => n.kind === 'recording_rule'),
         'on the fixture graph a dead scrape job blinds the SLO, its alert and the recording rule', direct?.summary);

  // Every node verdict carries `blastRadius: summary | null`, appended last;
  // in a self compare every node is non-scaffold, so every one has a summary.
  const again = comparePackBranches(adapted, adapt(clone(pack)));
  const nodesAll = again.branches.flatMap((b) => b.nodes);
  const SUMMARY_KEYS = 'slos,alerts,panels,dashboards,routes,remediations,total';
  const NODE_KEYS = 'status,key,kind,layer,label,weight,aId,bId,virtual,deltas,blastRadius,ladder';
  assert(nodesAll.length > 0 && nodesAll.every((n) => Object.keys(n).join() === NODE_KEYS),
         'blastRadius and ladder are the only new node-verdict fields, appended after deltas', nodesAll.map((n) => Object.keys(n).join())[0], NODE_KEYS);
  assert(nodesAll.every((n) => n.blastRadius === null || Object.keys(n.blastRadius).join() === SUMMARY_KEYS),
         'blastRadius is a summary object or null');
  assert(nodesAll.every((n) => n.blastRadius !== null && Object.values(n.blastRadius).every((v) => Number.isInteger(v) && v >= 0)),
         'in a self compare every node has a computed summary of non-negative integers');
  const scrape = nodesAll.find((n) => n.kind === 'scrape_job');
  assert(scrape?.blastRadius?.slos === 1 && scrape.blastRadius.alerts === 1 && scrape.blastRadius.routes === 2 && scrape.blastRadius.panels === 1 && scrape.blastRadius.dashboards === 1,
         'the scrape job node reports blinding 1 SLO, 1 alert, 2 routes, 1 panel, 1 dashboard', scrape?.blastRadius);
  const route = nodesAll.find((n) => n.kind === 'alert_route');
  assert(route?.blastRadius?.slos === 1 && route.blastRadius.alerts === 1 && route.blastRadius.total === 2,
         'a route node reports the alert it would leave undelivered and the SLO it would leave unprotected', route?.blastRadius);
  assert(nodesAll.every((n) => (DEFAULT_WEIGHTS[n.kind] ?? 0.5) === n.weight),
         'DEFAULT_WEIGHTS in blast-radius.mjs mirrors the graph limb weights on every node kind in the fixture');

  // The important pin: the scored quantities are byte-identical to what the
  // assertions above already hold, on the same inputs.
  assert(again.rollup.integrityMean === self.rollup.integrityMean && again.rollup.integrityMean === 1
           && again.rollup.intact === 1 && again.rollup.declaredTotal === 1 && again.rollup.total === 1,
         'rollup.integrityMean / intact / declaredTotal unchanged by the additive field', again.rollup);
  assert(again.branches.every((b) => b.verdict === 'intact' && b.integrity === 1 && b.integrityPct === 100),
         'branch verdict / integrity unchanged', again.branches.map((b) => [b.verdict, b.integrity]));
  assert(nodesAll.every((n) => n.status === 'aligned') && again.branches[0].counts.aligned === nodesAll.length
           && JSON.stringify(again.branches[0].counts) === JSON.stringify(self.branches[0].counts),
         'every node status in the self compare is aligned and the counts are unchanged', again.branches[0].counts);
  assert(noDashBranch.verdict === 'intact' && noDashBranch.nodes.some((n) => n.kind === 'panel' && n.status === 'unverifiable')
           && noMetric.branches[0].nodes.some((n) => n.kind === 'metric' && n.status === 'declared_only')
           && withMetric.branches[0].nodes.some((n) => n.kind === 'metric' && n.status === 'aligned')
           && broken.branches[0].verdict === 'broken' && dupSelf.rollup.integrityMean === 1,
         'the node statuses and verdicts pinned earlier in this suite still hold');
  const declaredOnlyMetric = noMetric.branches[0].nodes.find((n) => n.kind === 'metric' && n.status === 'declared_only');
  assert(declaredOnlyMetric?.blastRadius?.slos === 1, 'a declared_only metric carries the SLO it would blind (from the A-graph index)', declaredOnlyMetric?.blastRadius);
  const brokenAlertless = broken.branches[0].nodes.find((n) => n.kind === 'slo');
  assert(brokenAlertless?.blastRadius?.alerts === 0 && brokenAlertless.blastRadius.slos === 0, 'an SLO with no alert blinds no alert', brokenAlertless?.blastRadius);
}

process.stdout.write('\n--- per-node ladder rides along, scoring untouched ---\n');
{
  const REFRESHED_AT = '2026-09-07T10:00:00.000Z';
  const ago = (seconds) => new Date(Date.parse(REFRESHED_AT) - seconds * 1000).toISOString();
  const RULE = 'checkout:latency:ratio_5m';
  const ALERT_FAST = 'checkout_latency_99_burn_14x_5m_1h';
  const ALERT_SLOW = 'checkout_latency_99_burn_6x_30m_6h';
  const NODE_KEYS = 'status,key,kind,layer,label,weight,aId,bId,virtual,deltas,blastRadius,ladder';
  const LADDER_ROLLUP_KEYS = 'healthy,degraded,broken,unobserved,integrityMean,integrityPct';
  // A live Pack B the way the fetcher annotates one: every probe family
  // answered, the one target up, the rule and both burn alerts evaluating.
  const livePack = (overrides = {}, drop = []) => {
    const live = clone(pack);
    live.metadata.annotations = {
      ...live.metadata.annotations,
      'mcp.url': 'https://example.test/mcp',
      'mcp.refreshedAt': REFRESHED_AT,
      'mcp.probesAttempted': 'recording_rules,alert_rules,dashboards,scrape_configs,metric_names',
      'mcp.probesSucceeded': 'recording_rules,alert_rules,dashboards,scrape_configs,metric_names',
      'mcp.probesEmpty': '',
      'mcp.probesFailed': '',
      'mcp.probesUnsupported': '',
      'mcp.discovered.metric_names': '["checkout_latency_seconds_bucket","checkout_latency_seconds_count","checkout:latency:ratio_5m"]',
      'mcp.discovered.metric_names_count': '3',
      'mcp.observed.scrape_targets': JSON.stringify([
        { job: 'checkout-api', instance: 'checkout-api:8080', health: 'up', lastScrape: ago(4), lastError: null },
      ]),
      'mcp.observed.recording_rules': JSON.stringify([
        { name: RULE, health: 'ok', lastError: null, lastEvaluation: ago(12), evaluationTime: 0.004 },
      ]),
      'mcp.observed.alert_rules': JSON.stringify([
        { name: ALERT_FAST, health: 'ok', lastError: null, lastEvaluation: ago(20), state: 'inactive', activeAt: null },
        { name: ALERT_SLOW, health: 'ok', lastError: null, lastEvaluation: ago(20), state: 'inactive', activeAt: null },
      ]),
      'mcp.versions.prometheus': '2.53.0',
      ...overrides,
    };
    for (const key of drop) delete live.metadata.annotations[key];
    return live;
  };
  // The fetcher never projects a crawler scrape job: drop the fixture's so
  // the declared job has nothing to pair with in B.
  const withoutScrape = (live) => {
    for (const key of ['crawler.discovered.scrape_jobs', 'crawler.discovered.scrape_jobs_count', 'crawler.discovered.scrape_job_origins']) {
      delete live.metadata.annotations[key];
    }
    return live;
  };
  const compare = (live) => comparePackBranches(adapted, adapt(live));
  const nodeOf = (cmp, kind) => cmp.branches[0].nodes.find((n) => n.kind === kind);
  const ladderOf = (cmp, kind) => nodeOf(cmp, kind)?.ladder;
  const scored = (cmp) => JSON.stringify({
    rollup: { ...cmp.rollup, ladder: undefined },
    branches: cmp.branches.map((b) => [b.verdict, b.integrity, b.integrityPct, b.counts, b.nodes.map((n) => `${n.status}:${n.key}`).sort()]),
  });

  // Healthy: every rung reads from the wire.
  const healthy = compare(livePack());
  const hb = healthy.branches[0];
  assert(hb.nodes.every((n) => Object.keys(n).join() === NODE_KEYS && Object.keys(n.ladder).join() === 'rung,status,detail'),
         'ladder { rung, status, detail } is appended after blastRadius on every node verdict', hb.nodes.map((n) => Object.keys(n).join())[0], NODE_KEYS);
  assert(ladderOf(healthy, 'recording_rule')?.rung === 'healthy' && ladderOf(healthy, 'recording_rule').status === null
           && ladderOf(healthy, 'recording_rule').detail === 'health ok, lastEvaluation 12s ago ≤ 2× interval 30s',
         'a rule the ruler reports ok and fresh reads rung healthy', ladderOf(healthy, 'recording_rule'));
  assert(ladderOf(healthy, 'scrape_job')?.rung === 'healthy' && ladderOf(healthy, 'scrape_job').detail === 'health up on 1/1 target, lastScrape 4s ago ≤ 2× interval 10s',
         'a scrape job whose target is up and fresh reads rung healthy (interval from the declared side)', ladderOf(healthy, 'scrape_job'));
  assert(ladderOf(healthy, 'burn_rate')?.rung === 'healthy' && /^health ok on 2\/2 rules, lastEvaluation 20s ago; interval unknown, staleness not judged$/.test(ladderOf(healthy, 'burn_rate').detail),
         'a burn-rate alert links to both live rules by the <slo>_burn_<N>x_<short>_<long> convention and is never judged stale', ladderOf(healthy, 'burn_rate'));
  assert(ladderOf(healthy, 'sli')?.rung === 'exists' && /rides on its recording rules/.test(ladderOf(healthy, 'sli').detail)
           && ladderOf(healthy, 'slo')?.rung === 'exists' && /rides on its SLI and alerts/.test(ladderOf(healthy, 'slo').detail)
           && ladderOf(healthy, 'metric')?.rung === 'exists' && /no liveness field on the wire/.test(ladderOf(healthy, 'metric').detail),
         'sli / slo / metric read exists with a detail naming where their liveness rides');
  assert(ladderOf(healthy, 'backend')?.rung === 'alive' && /mcp\.versions\.prometheus = 2\.53\.0/.test(ladderOf(healthy, 'backend').detail),
         'a backend that answered its version probe reads alive', ladderOf(healthy, 'backend'));
  assert(hb.ladderVerdict === 'healthy' && hb.ladderIntegrity === 1 && hb.ladderIntegrityPct === 100,
         'self-compare of a healthy annotated pack: ladder healthy at integrity 1', [hb.ladderVerdict, hb.ladderIntegrity]);
  assert(Object.keys(healthy.rollup.ladder).join() === LADDER_ROLLUP_KEYS
           && JSON.stringify(healthy.rollup.ladder) === JSON.stringify({ healthy: 1, degraded: 0, broken: 0, unobserved: 0, integrityMean: 1, integrityPct: 100 }),
         'rollup.ladder counts the healthy branch and means 1', healthy.rollup.ladder);
  assert(Object.keys(healthy.rollup).join() === 'intact,partial,broken,undeclared,declaredTotal,total,integrityMean,integrityPct,ladder',
         'ladder is the only new rollup key, appended last', Object.keys(healthy.rollup).join());

  // Ladder credit arithmetic on the fixture branch: every node aligned, so
  // the denominator is the sum of the branch's limb weights.
  const possible = hb.nodes.reduce((sum, n) => sum + n.weight, 0);
  const credit = (...weights) => Math.round(((possible - 0.75 * weights.reduce((a, b) => a + b, 0)) / possible) * 1e4) / 1e4;

  // Unhealthy rule: on the wire, not evaluating — and the SLI it feeds with it.
  const badRule = compare(livePack({
    'mcp.observed.recording_rules': JSON.stringify([
      { name: RULE, health: 'err', lastError: 'many-to-many matching not allowed', lastEvaluation: ago(12), evaluationTime: 0 },
    ]),
    'mcp.discovered.recording_rules_unhealthy': RULE,
    'mcp.discovered.slis_unhealthy': 'checkout_latency',
  }));
  const badRuleNode = nodeOf(badRule, 'recording_rule');
  assert(badRuleNode.status === 'aligned' && badRuleNode.ladder.rung === 'exists' && badRuleNode.ladder.status === 'present_unhealthy'
           && badRuleNode.ladder.detail === 'health err, lastError "many-to-many matching not allowed"',
         'a rule in recording_rules_unhealthy with a lastError stays aligned (scored) and reads present_unhealthy (ladder)', badRuleNode.ladder);
  assert(ladderOf(badRule, 'sli')?.status === 'present_unhealthy' && /slis_unhealthy/.test(ladderOf(badRule, 'sli').detail),
         'an SLI in slis_unhealthy reads present_unhealthy', ladderOf(badRule, 'sli'));
  assert(badRule.branches[0].verdict === 'intact' && badRule.branches[0].integrity === 1 && badRule.branches[0].ladderVerdict === 'degraded'
           && badRule.branches[0].ladderIntegrity === credit(2, 3),
         'the scored verdict stays intact at integrity 1 while the ladder reads degraded with 0.25 credit on the rule and the SLI',
         [badRule.branches[0].verdict, badRule.branches[0].integrity, badRule.branches[0].ladderVerdict, badRule.branches[0].ladderIntegrity], ['intact', 1, 'degraded', credit(2, 3)]);
  assert(JSON.stringify(badRule.rollup.ladder) === JSON.stringify({ healthy: 0, degraded: 1, broken: 0, unobserved: 0, integrityMean: credit(2, 3), integrityPct: Math.round(credit(2, 3) * 100) }),
         'rollup.ladder counts the degraded branch and means its ladder integrity', badRule.rollup.ladder);

  // Stale rule: healthy, but last evaluated 20 minutes before refreshedAt at a 30s interval.
  const stale = compare(livePack({
    'mcp.observed.recording_rules': JSON.stringify([
      { name: RULE, health: 'ok', lastError: null, lastEvaluation: ago(20 * 60), evaluationTime: 0.004 },
    ]),
  }));
  assert(ladderOf(stale, 'recording_rule')?.rung === 'exists' && ladderOf(stale, 'recording_rule').status === 'present_stale'
           && ladderOf(stale, 'recording_rule').detail === 'lastEvaluation 20m ago > 2× interval 30s',
         'a rule last evaluated 20m ago at a 30s interval reads present_stale', ladderOf(stale, 'recording_rule'));
  assert(stale.branches[0].verdict === 'intact' && stale.branches[0].ladderVerdict === 'degraded' && stale.branches[0].ladderIntegrity === credit(2),
         'a stale load-bearing rule degrades the ladder verdict, not the scored one', [stale.branches[0].verdict, stale.branches[0].ladderVerdict, stale.branches[0].ladderIntegrity]);

  // Unhealthy burn alert: linked by the name convention through alert_rules_unhealthy.
  const badAlert = compare(livePack({
    'mcp.observed.alert_rules': JSON.stringify([
      { name: ALERT_FAST, health: 'err', lastError: 'vector contains metrics with the same labelset', lastEvaluation: ago(20), state: 'inactive', activeAt: null },
      { name: ALERT_SLOW, health: 'ok', lastError: null, lastEvaluation: ago(20), state: 'inactive', activeAt: null },
    ]),
    'mcp.discovered.alert_rules_unhealthy': ALERT_FAST,
  }));
  assert(ladderOf(badAlert, 'burn_rate')?.status === 'present_unhealthy'
           && ladderOf(badAlert, 'burn_rate').detail === 'health err on 1/2 rules, lastError "vector contains metrics with the same labelset"'
           && badAlert.branches[0].ladderVerdict === 'degraded',
         'a burn-rate alert with one unhealthy live rule reads present_unhealthy', ladderOf(badAlert, 'burn_rate'));

  // Down target: the job is on the wire, every target down.
  const down = compare(livePack({
    'mcp.observed.scrape_targets': JSON.stringify([
      { job: 'checkout-api', instance: 'checkout-api:8080', health: 'down', lastScrape: ago(4), lastError: 'connection refused' },
    ]),
    'mcp.discovered.scrape_jobs_down': 'checkout-api',
  }));
  assert(ladderOf(down, 'scrape_job')?.rung === 'exists' && ladderOf(down, 'scrape_job').status === 'present_unhealthy'
           && ladderOf(down, 'scrape_job').detail === 'health down on 1/1 target, lastError "connection refused"',
         'a scrape job with a down target reads present_unhealthy', ladderOf(down, 'scrape_job'));
  assert(down.branches[0].ladderVerdict === 'healthy' && down.branches[0].ladderIntegrity === credit(1),
         'a non-load-bearing unhealthy node costs ladder integrity without degrading the ladder verdict', [down.branches[0].ladderVerdict, down.branches[0].ladderIntegrity]);

  // Unobserved: the scrape job is absent from B because this MCP tier does not expose scrape_configs.
  const blind = compare(withoutScrape(livePack({
    'mcp.probesSucceeded': 'recording_rules,alert_rules,dashboards,metric_names',
    'mcp.probesUnsupported': 'scrape_configs',
  }, ['mcp.observed.scrape_targets'])));
  const blindScrape = nodeOf(blind, 'scrape_job');
  assert(blindScrape.status === 'declared_only' && blindScrape.ladder.rung === 'unobserved' && blindScrape.ladder.status === 'unobserved'
           && blindScrape.ladder.detail === 'probe family scrape_configs not exposed by this MCP tier',
         'a declared scrape job absent from B while scrape_configs is unsupported reads unobserved, never absent', blindScrape.ladder);
  assert(blind.branches[0].integrity === Math.round(((possible - 1) / possible) * 1e4) / 1e4 && blind.branches[0].integrity < 1
           && blind.branches[0].ladderIntegrity === 1 && blind.branches[0].ladderVerdict === 'healthy',
         'the scored integrity still penalises the declared_only node while the ladder leaves the unobserved one out of its denominator',
         [blind.branches[0].integrity, blind.branches[0].ladderIntegrity], [Math.round(((possible - 1) / possible) * 1e4) / 1e4, 1]);

  // Unobserved load-bearing: the rule is absent from B because the recording_rules probe failed.
  const blindRulePack = livePack({
    'mcp.probesSucceeded': 'alert_rules,dashboards,scrape_configs,metric_names',
    'mcp.probesFailed': 'recording_rules',
    'mcp.probeErrors.recording_rules': 'HTTP 502 Bad Gateway',
  }, ['mcp.observed.recording_rules']);
  blindRulePack.spec.queries.recording_rules = [];
  const blindRule = compare(blindRulePack);
  const blindRuleNode = nodeOf(blindRule, 'recording_rule');
  assert(blindRuleNode.status === 'declared_only' && blindRuleNode.ladder.rung === 'unobserved'
           && blindRuleNode.ladder.detail === 'probe family recording_rules failed (HTTP 502 Bad Gateway)',
         'a failed probe family names itself and its error in the unobserved detail', blindRuleNode.ladder);
  assert(blindRule.branches[0].verdict === 'broken' && blindRule.branches[0].ladderVerdict === 'unobserved'
           && JSON.stringify(blindRule.rollup.ladder) === JSON.stringify({ healthy: 0, degraded: 0, broken: 0, unobserved: 1, integrityMean: 1, integrityPct: 100 }),
         'a load-bearing unobserved node makes the ladder verdict unobserved while the scored verdict stays broken',
         [blindRule.branches[0].verdict, blindRule.branches[0].ladderVerdict, blindRule.rollup.ladder]);

  // Absent for real: the probe family answered and the rule is not there.
  const goneRulePack = livePack({}, ['mcp.observed.recording_rules']);
  goneRulePack.spec.queries.recording_rules = [];
  const goneRule = compare(goneRulePack);
  assert(nodeOf(goneRule, 'recording_rule').ladder.rung === 'absent' && nodeOf(goneRule, 'recording_rule').ladder.status === null
           && nodeOf(goneRule, 'recording_rule').ladder.detail === 'absent from Pack B; probe family recording_rules answered without it'
           && goneRule.branches[0].ladderVerdict === 'broken' && goneRule.rollup.ladder.broken === 1,
         'a declared rule the answering probe family did not return reads absent and breaks the ladder', nodeOf(goneRule, 'recording_rule').ladder);

  // On the wire but withheld from Pack B: a job whose every target is down
  // is not in mcp.discovered.scrape_jobs, only in scrape_jobs_down.
  const withheld = compare(withoutScrape(livePack({
    'mcp.observed.scrape_targets': JSON.stringify([
      { job: 'checkout-api', instance: 'checkout-api:8080', health: 'down', lastScrape: ago(4), lastError: 'connection refused' },
    ]),
    'mcp.discovered.scrape_jobs_down': 'checkout-api',
  })));
  const withheldScrape = nodeOf(withheld, 'scrape_job');
  assert(withheldScrape.status === 'declared_only' && withheldScrape.ladder.rung === 'exists' && withheldScrape.ladder.status === 'present_unhealthy'
           && withheldScrape.ladder.detail === 'on the wire but withheld from Pack B: health down on 1/1 target, lastError "connection refused"',
         'a declared_only scrape job the fetcher observed down reads present_unhealthy, not absent', withheldScrape.ladder);

  // File-sourced B: no on-wire liveness at all.
  const fileB = compare(clone(pack));
  assert(fileB.branches[0].nodes.every((n) => n.ladder.rung === 'exists' && n.ladder.status === null && n.ladder.detail === 'no on-wire liveness (Pack B is not a live draft)'),
         'against a file-sourced Pack B every present node reads exists with the no-on-wire detail');
  assert(fileB.branches[0].ladderVerdict === 'healthy' && fileB.rollup.ladder.integrityMean === 1,
         'a file-sourced self compare is ladder healthy at 1', [fileB.branches[0].ladderVerdict, fileB.rollup.ladder.integrityMean]);
  const fileNoAlert = clone(pack);
  fileNoAlert.spec.policy.burn_rate_alerts = [];
  const fileBroken = compare(fileNoAlert);
  const fileBurn = nodeOf(fileBroken, 'burn_rate');
  assert(fileBurn.status === 'declared_only' && fileBurn.ladder.rung === 'absent' && fileBurn.ladder.status === null
           && fileBurn.ladder.detail === 'absent from Pack B (file-sourced; no on-wire liveness to consult)'
           && fileBroken.branches[0].ladderVerdict === 'broken' && fileBroken.rollup.ladder.broken === 1,
         'a declared burn-rate alert missing from a file-sourced B reads absent and breaks the ladder', [fileBurn.ladder, fileBroken.branches[0].ladderVerdict]);
  const unverifiablePanel = noDashBranch.nodes.find((n) => n.kind === 'panel' && n.status === 'unverifiable');
  assert(unverifiablePanel?.ladder.rung === 'unobserved' && unverifiablePanel.ladder.status === null
           && unverifiablePanel.ladder.detail === 'not live-introspectable from any MCP vantage',
         'an unverifiable node reads rung unobserved with a null status', unverifiablePanel?.ladder);

  // The pin: every scored quantity is byte-identical with and without the
  // liveness annotations on the same declarations.
  assert(scored(healthy) === scored(self) && scored(badRule) === scored(self) && scored(stale) === scored(self)
           && scored(badAlert) === scored(self) && scored(down) === scored(self),
         'verdict / integrity / counts / node statuses / rollup.integrityMean are identical with and without the mcp.observed annotations',
         scored(badRule), scored(self));
  assert(healthy.rollup.integrityMean === self.rollup.integrityMean && badRule.rollup.integrityMean === 1 && stale.rollup.integrityMean === 1,
         'rollup.integrityMean is unchanged by unhealthy or stale observations', [healthy.rollup.integrityMean, badRule.rollup.integrityMean, stale.rollup.integrityMean]);
}

report('traceability graph');
