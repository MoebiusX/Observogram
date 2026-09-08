#!/usr/bin/env node
/**
 * tools/test-fetch-live.mjs
 *
 * Offline test for the fetcher's pack builder. Feeds synthetic MCP
 * responses to `buildCanonicalPack`, then asserts:
 *   1. The produced pack validates against the vendored canonical schema.
 *   2. It round-trips through emit() / parse() byte-equivalent.
 *   3. Annotations carry the MCP context and per-symbol verification
 *      markers in the flat key form `mcp.verified.<symbol>`.
 *   4. The pack adapts cleanly via the layered adapter (Verified source
 *      tags surface where the fetcher attested them).
 */

import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import {
  buildCanonicalPack, fetchMcp, mapDiscoveredBurnAlerts, PROBES,
  sampleStackSelfMetrics, sampleFromInstantVector, observeAlertmanager, observeGrafana,
} from './fetch-live-pack.mjs';
import { STACK_SELF_METRIC_PROBES } from './lib/contracts/stack-self-metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(
  resolve(__dirname, '..', 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'),
  'utf8'
));

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness();

const refreshedAt = '2026-06-06T00:00:00Z';

// ---------- case 1: rich MCP response ----------

const rich = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: {
    services: [
      { name: 'svc-checkout', status: 'healthy', avgDuration: 84, spanCount: 1200 },
      { name: 'svc-settler',  status: 'healthy', avgDuration: 22, spanCount: 800 },
      { name: 'svc-fraud',    status: 'degraded', avgDuration: 311, spanCount: 60 },
    ],
  },
  topology: {
    dependencies: [
      { parent: 'svc-checkout', child: 'svc-settler', callCount: 12 },
      { parent: 'svc-checkout', child: 'jaeger-all-in-one', callCount: 4200 },
    ],
  },
  anomaliesActive: { traceAnomalies: { active: [{ id: 'a1' }], recentCount: 4 }, amountAnomalies: { enabled: true } },
  baselinesData: { baselines: [
    { service: 'svc-checkout', sampleCount: 5000, thresholdMs: 200 },
    { service: 'svc-settler',  sampleCount: 2000, thresholdMs: 90  },
  ]},
  errors: {},
  packName: 'production-live',
});

// schema
{
  const errors = validateCanonical(rich, SCHEMA);
  assert(errors.length === 0, 'rich pack validates against canonical schema', errors, []);
}

// metadata
assert(rich.metadata.name === 'production-live', 'metadata.name = production-live');
assert(rich.metadata.bindings.criticality === 'tier-2', 'criticality tier-2 when services discovered');
assert(rich.metadata.owners.includes('mcp-fetcher'), 'owners includes mcp-fetcher');

// annotations
const a = rich.metadata.annotations;
assert(a['mcp.refreshedAt'] === refreshedAt, 'annotations carry refreshedAt');
assert(a['mcp.toolsCalled'].split(',').length === 4, 'all four MCP tools listed as called');
assert(a['mcp.servicesDiscovered'] === 'svc-checkout,svc-settler,svc-fraud', 'discovered services flattened');
assert(a['mcp.baselinesComputed'] === '2', 'baselinesComputed reflects MCP data');
assert(a['mcp.activeAnomalies'] === '1', 'activeAnomalies reflects MCP data');

// verified markers (flat keys) — only for what a tool actually attested.
assert(typeof a['mcp.verified.telemetry.backends.traces-jaeger'] === 'string', 'jaeger backend verified (topology shows it)');

// Schema-forced placeholders are stamped mcp.scaffold.<symbol> and NEVER
// mcp.verified.<symbol>. system_health answering used to verify the
// hard-coded otel block, the per-service availability guesses, the
// metrics-prom backend and the baselines — all false assurance.
const SCAFFOLD_SYMBOLS = [
  'otel',
  'slis.svc_checkout_availability', 'slos.svc_checkout_availability_99',
  'telemetry.backends.metrics-prom', 'telemetry.backends.logs-elastic',
  'pipelines.receivers[0]', 'pipelines.processors[0]', 'pipelines.processors[1]',
  'pipelines.exporters.metrics', 'pipelines.exporters.logs', 'pipelines.exporters.traces',
  'dashboards.platform-overview',
  'alerting.routes[0]',
  'baselines',
];
for (const sym of SCAFFOLD_SYMBOLS) {
  assert(typeof a[`mcp.scaffold.${sym}`] === 'string' && a[`mcp.verified.${sym}`] === undefined,
         `placeholder ${sym} is stamped mcp.scaffold.* and not mcp.verified.*`,
         { scaffold: a[`mcp.scaffold.${sym}`], verified: a[`mcp.verified.${sym}`] });
}
assert(a['mcp.verified.otel'] === undefined, 'system_health answering does NOT verify the hard-coded otel block');
assert(a['mcp.verified.slis.svc_checkout_availability'] === undefined, 'per-service SLI guess is NOT verified');
assert(a['mcp.verified.baselines'] === undefined, 'baselines are NOT verified on the strength of anomalies_baselines answering');
assert(a['mcp.scaffold.telemetry.backends.traces-jaeger'] === undefined, 'a topology-attested backend carries no scaffold marker');

// slis/slos
assert(rich.spec.slis.length === 3, 'one SLI per service', rich.spec.slis.length, 3);
assert(rich.spec.slos.length === 3, 'one SLO per service');
assert(rich.spec.slis.every(s => s.type === 'ratio'), 'all SLIs are ratio type');
assert(rich.spec.slos.every(s => s.window === '30d'), 'SLOs target 30d window');

// pipelines (must satisfy minItems for receivers/processors and required exporters)
assert(rich.spec.pipelines.receivers.length >= 1, 'pipelines.receivers >= 1');
assert(rich.spec.pipelines.processors.length >= 1, 'pipelines.processors >= 1');
assert(!!rich.spec.pipelines.exporters.metrics && !!rich.spec.pipelines.exporters.logs && !!rich.spec.pipelines.exporters.traces,
       'pipelines.exporters has metrics + logs + traces');

// burn rate alerts: NOT synthesised per SLO any more. No alert probe
// answered, so the only entry is the schema-forced placeholder, stamped
// as an mcp.scaffold — never Verified.
assert(rich.spec.policy.burn_rate_alerts.length === 1,
       'no alert probe → single schema-forced burn-rate placeholder (no per-SLO synthesis)',
       rich.spec.policy.burn_rate_alerts.length, 1);
assert(rich.spec.policy.burn_rate_alerts[0].windows.length >= 2, 'placeholder burn-rate alert has >=2 windows');
assert(rich.spec.policy.burn_rate_alerts[0].slo === rich.spec.slos[0].id, 'placeholder binds to the first SLO');
assert(typeof a['mcp.scaffold.policy.burn_rate_alerts[0]'] === 'string',
       'placeholder burn-rate alert is stamped mcp.scaffold.policy.burn_rate_alerts[0]');
assert(!Object.keys(a).some(k => k.startsWith('mcp.verified.policy.')),
       'no mcp.verified.policy.* key when no alerting rule was discovered',
       Object.keys(a).filter(k => k.startsWith('mcp.verified.policy.')), []);

// baselines are tier defaults, never derived from anomaly thresholds: a
// 90ms latency-anomaly threshold is not a time-to-detect target.
assert(rich.spec.baselines.mttd_target_p50 === '5m', 'mttd_target_p50 is the tier-2 platform default (no thresholdMs derivation)',
       rich.spec.baselines.mttd_target_p50, '5m');
assert(rich.spec.baselines.mttr_target_p50 === '2h', 'mttr_target_p50 is the tier-2 platform default');
assert(rich.spec.baselines.measurement_source === 'platform-default', 'baselines.measurement_source says platform-default',
       rich.spec.baselines.measurement_source, 'platform-default');

// adapter: attested entries project Verified, placeholders Scaffold.
const layered = adapt(rich);
const guessedSli = layered.layers.L1.find(x => x.id === 'SLI-01');
assert(guessedSli?.source === 'Scaffold', 'adapter projects the per-service SLI guess as Scaffold',
       guessedSli?.source, 'Scaffold');
const guessedSlo = layered.layers.L1.find(x => x.id === 'SLO-01');
assert(guessedSlo?.source === 'Scaffold', 'adapter projects the per-service SLO guess as Scaffold',
       guessedSlo?.source, 'Scaffold');
const jaegerBackend = layered.layers.L2.find(x => x.title === 'traces-jaeger');
assert(jaegerBackend?.source === 'Verified', 'adapter surfaces Verified source for the topology-attested backend',
       jaegerBackend?.source, 'Verified');
const sourceOfL2 = (id) => layered.layers.L2.find(x => x.id === id)?.source;
assert(layered.layers.L2.find(x => x.title === 'metrics-prom')?.source === 'Scaffold', 'metrics-prom fallback is Scaffold without a build_info capture');
assert(layered.layers.L2.find(x => x.title === 'logs-elastic')?.source === 'Scaffold', 'logs-elastic fallback is Scaffold');
assert(sourceOfL2('OTEL-01') === 'Scaffold', 'hard-coded otel block is Scaffold', sourceOfL2('OTEL-01'), 'Scaffold');
assert(sourceOfL2('PIP-EXP-LOG') === 'Scaffold', 'logs exporter is Scaffold', sourceOfL2('PIP-EXP-LOG'), 'Scaffold');
assert(sourceOfL2('PIP-EXP-TRC') === 'Scaffold', 'traces exporter is Scaffold', sourceOfL2('PIP-EXP-TRC'), 'Scaffold');
assert(sourceOfL2('PIP-EXP-MET') === 'Scaffold', 'metrics exporter is Scaffold without scrape/metric evidence', sourceOfL2('PIP-EXP-MET'), 'Scaffold');
assert(sourceOfL2('PIP-RCV-01') === 'Scaffold' && sourceOfL2('PIP-PRC-01') === 'Scaffold', 'receiver/processor stages are Scaffold');
const stubDash = layered.layers.L3.find(x => x.id === 'DASH-01');
assert(stubDash?.source === 'Scaffold', 'dashboard stub platform-overview is Scaffold', stubDash?.source, 'Scaffold');
const stubRoute = layered.layers.L4.alerting.find(x => x.id === 'ALR-01');
assert(stubRoute?.source === 'Scaffold', 'hard-coded SEV1 msteams route is Scaffold', stubRoute?.source, 'Scaffold');
const stubBaselines = layered.layers.L5.find(x => x.id === 'BASE-01');
assert(stubBaselines?.source === 'Scaffold', 'baselines are Scaffold', stubBaselines?.source, 'Scaffold');
const scaffoldBurn = layered.layers.L4.policy.find(x => x.id === 'POL-01');
assert(scaffoldBurn?.source === 'Scaffold', 'adapter projects the mcp.scaffold burn-rate placeholder as Scaffold',
       scaffoldBurn?.source, 'Scaffold');

// ---------- case 1b: a build_info capture attests the metrics fallback backend ----------
{
  const attested = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout' }] },
    topology: { dependencies: [] },
    anomaliesActive: {},
    baselinesData: { baselines: [] },
    liveVersions: { victoriametrics: { declared: 'v1.113.0', source: 'metrics_query/vm_app_version' } },
    errors: {},
  });
  const ann = attested.metadata.annotations;
  assert(typeof ann['mcp.verified.telemetry.backends.metrics-prom'] === 'string'
         && ann['mcp.scaffold.telemetry.backends.metrics-prom'] === undefined,
         'metrics-prom fallback is Verified (not Scaffold) when a metrics build_info capture exists');
  assert(typeof ann['mcp.scaffold.telemetry.backends.traces-jaeger'] === 'string'
         && ann['mcp.verified.telemetry.backends.traces-jaeger'] === undefined,
         'traces-jaeger fallback is Scaffold when neither topology nor traces_services attested it');
  const l = adapt(attested);
  assert(l.layers.L2.find(x => x.title === 'metrics-prom')?.source === 'Verified', 'adapter projects the attested metrics-prom as Verified');
  assert(l.layers.L2.find(x => x.title === 'traces-jaeger')?.source === 'Scaffold', 'adapter projects the unattested traces-jaeger as Scaffold');
}

// YAML round-trip
const text = emitYaml(rich);
const reparsed = parseYaml(text);
const rValidate = validateCanonical(reparsed, SCHEMA);
assert(rValidate.length === 0, 'YAML round-trip still validates', rValidate, []);
assert(reparsed.metadata.annotations['mcp.refreshedAt'] === refreshedAt, 'YAML round-trip preserves annotations');
assert(reparsed.spec.slis.length === 3, 'YAML round-trip preserves slis');

// ---------- case 2: empty MCP — no services, partial tool failures ----------

const empty = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [] },
  topology: { dependencies: [] },
  anomaliesActive: {},
  baselinesData: { baselines: [] },
  errors: { anomalies_baselines: 'HTTP 500' },
});
{
  const errors = validateCanonical(empty, SCHEMA);
  assert(errors.length === 0, 'empty-services pack still validates', errors, []);
}
assert(empty.metadata.bindings.criticality === 'tier-3', 'empty-services pack lands tier-3');
assert(empty.spec.slis.length === 1 && empty.spec.slis[0].id === 'platform_availability',
       'empty pack has stub platform_availability SLI');
assert(empty.spec.slos.length === 1, 'empty pack has matching stub SLO');
assert(empty.metadata.annotations['mcp.toolsFailed'].includes('anomalies_baselines'),
       'failed tool surfaced in mcp.toolsFailed');
assert(empty.metadata.annotations['mcp.verified.baselines'] === undefined,
       'baselines NOT marked verified when anomalies_baselines failed');
assert(typeof empty.metadata.annotations['mcp.scaffold.baselines'] === 'string',
       'baselines stamped scaffold in the empty pack too');
assert(typeof empty.metadata.annotations['mcp.scaffold.slis.platform_availability'] === 'string'
       && typeof empty.metadata.annotations['mcp.scaffold.slos.platform_availability_99'] === 'string'
       && empty.metadata.annotations['mcp.verified.slis.platform_availability'] === undefined,
       'platform_availability SLI/SLO stubs are scaffold, not verified');
assert(empty.spec.baselines.mttd_target_p50 === '15m' && empty.spec.baselines.mttr_target_p50 === '1d',
       'empty pack baselines are the tier-3 platform defaults');

// ---------- case 2b: tool responded with a null payload ----------
// The MCP probe helper returns `null` when a tool answers with an
// empty/null body (an honest zero, not a failure). Those nulls are
// spread straight into buildCanonicalPack, bypassing the `= {}`
// destructuring defaults (which only fire for `undefined`). Guard
// against the regression where `baselinesData.baselines` threw
// "Cannot read properties of null (reading 'baselines')".
{
  let nullPayload;
  try {
    nullPayload = buildCanonicalPack({
      refreshedAt,
      mcpUrl: 'https://fake-mcp.test/observability',
      health: { services: [] },
      topology: null,
      anomaliesActive: null,
      baselinesData: null,
    });
  } catch (e) {
    nullPayload = e;
  }
  assert(!(nullPayload instanceof Error),
         'null tool payloads do not crash buildCanonicalPack',
         nullPayload instanceof Error ? nullPayload.message : 'ok', 'ok');
  const nErrors = validateCanonical(nullPayload, SCHEMA);
  assert(nErrors.length === 0, 'null-payload pack still validates', nErrors, []);
}

// ---------- case 3: probes return real data — recording rules, dashboards, scrape jobs, metrics ----------
//
// This is the case the user pushed back on: "metrics we're exporting or
// scraping MUST be declared there when present." Verifies the fetcher
// uses probe-discovered data instead of stubbing.

const probed = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
  topology: { dependencies: [{ child: 'svc-jaeger-agent' }] },
  anomaliesActive: {},
  baselinesData: { baselines: [{ service: 'svc-checkout', sampleCount: 1000, thresholdMs: 90 }] },
  probeResults: {
    recording_rules: {
      tool: 'list_recording_rules',
      adapted: [
        { name: 'svc_checkout:availability:good_5m',  expr: 'sum(rate(http_requests_total{status_code!~"5.."}[5m]))', interval: '30s' },
        { name: 'svc_checkout:availability:total_5m', expr: 'sum(rate(http_requests_total[5m]))',                       interval: '30s' },
        { name: 'svc_checkout:availability:ratio_5m', expr: 'svc_checkout:availability:good_5m / svc_checkout:availability:total_5m', interval: '30s',
          health: 'ok', lastEvaluation: '2026-06-06T00:00:00Z', evaluationTime: 0.001 },
        // On-wire: the ruler reports this rule FAILING to evaluate. It
        // exists (definition lands in spec.queries) but is not producing
        // its series — it must not read Verified.
        { name: 'svc_checkout:latency_p95:value_5m',  expr: 'histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))', interval: '30s',
          health: 'err', lastError: 'vector contains metrics with the same labelset', lastEvaluation: '2026-06-06T00:00:00Z', evaluationTime: 0.002 },
      ],
    },
    alert_rules: {
      tool: 'list_alert_rules',
      adapted: [{ name: 'CheckoutHighErrorRate', expr: 'svc_checkout:availability:ratio_5m < 0.99', for: '5m', labels: {}, annotations: {},
                  state: 'firing', health: 'ok', lastEvaluation: '2026-06-06T00:00:00Z', activeAt: '2026-06-05T23:50:00Z' }],
    },
    dashboards: {
      tool: 'grafana_search',
      adapted: [
        { id: 'checkout-overview', provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 }, folder: 'checkout', source: 'grafana://uid/checkout-overview' },
        { id: 'platform-health',   provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 }, folder: 'platform', source: 'grafana://uid/platform-health' },
      ],
    },
    // Fixture-shaped targets (metrics_targets): per-job target health.
    // `alertmanager` has ONE target and it is down — a job name that is
    // scraping nothing must not evidence telemetry.scrape.
    scrape_configs: { tool: 'metrics_targets', adapted: [
      { job: 'checkout',  targets: [{ instance: 'checkout:8080', health: 'up', lastScrape: '2026-06-06T00:00:00Z', lastError: null }] },
      { job: 'platform',  targets: [
        { instance: 'platform-1:9100', health: 'up',   lastScrape: '2026-06-06T00:00:00Z', lastError: null },
        { instance: 'platform-2:9100', health: 'down', lastScrape: '2026-06-06T00:00:00Z', lastError: 'connection refused' },
      ] },
      { job: 'collector', targets: [{ instance: 'collector:8888', health: null, lastScrape: null, lastError: null }] },
      { job: 'alertmanager', targets: [{ instance: 'am:9093', health: 'down', lastScrape: '2026-06-06T00:00:00Z', lastError: 'dial tcp4 10.96.4.190:9093: connect: connection refused; ' + 'x'.repeat(300) }] },
    ] },
    metric_names:   { tool: 'list_metrics',         adapted: ['http_requests_total', 'http_request_duration_ms_bucket', 'queue_depth'] },
  },
  errors: {},
});

{
  const errors = validateCanonical(probed, SCHEMA);
  assert(errors.length === 0, 'probed pack validates against canonical schema', errors, []);
}
const pAnn = probed.metadata.annotations;

// SLIs INFERRED from recording rules (not service-derived stubs).
assert(probed.spec.slis.some(s => s.id === 'svc_checkout_availability'),
       'SLI inferred from recording rules (svc_checkout_availability)');
assert(probed.spec.slis.some(s => s.id === 'svc_checkout_latency_p95'),
       'threshold SLI inferred from latency_p95 rule (svc_checkout_latency_p95)');
assert(probed.spec.slis.find(s => s.id === 'svc_checkout_availability')?.type === 'ratio',
       'ratio SLI inferred when good + total rules present');
assert(probed.spec.slis.find(s => s.id === 'svc_checkout_latency_p95')?.type === 'threshold',
       'threshold SLI inferred from single-value rule');

// queries.recording_rules carries the DISCOVERED rules, not the
// synthesised stubs.
const ruleNames = probed.spec.queries.recording_rules.map(r => r.name);
assert(ruleNames.includes('svc_checkout:availability:ratio_5m'),
       'queries.recording_rules carries discovered rules verbatim');
assert(!ruleNames.includes('platform:platform_availability:ratio_5m'),
       'queries.recording_rules does NOT include the synth stub when probe responded');
// Observation fields never enter the spec (the schema forbids them).
assert(probed.spec.queries.recording_rules.every(r =>
         ['health', 'lastError', 'lastEvaluation', 'evaluationTime', 'state', 'activeAt'].every(k => !(k in r))),
       'on-wire rule health/evaluation fields are stripped before spec.queries.recording_rules');
// ...but they are kept, verbatim, in mcp.observed.recording_rules.
{
  const observed = JSON.parse(pAnn['mcp.observed.recording_rules'] || 'null');
  assert(Array.isArray(observed) && observed.length === 4, 'mcp.observed.recording_rules is a JSON array with one entry per discovered rule', observed?.length, 4);
  const bad = observed?.find(r => r.name === 'svc_checkout:latency_p95:value_5m');
  assert(bad?.health === 'err' && bad?.lastError === 'vector contains metrics with the same labelset'
         && bad?.lastEvaluation === '2026-06-06T00:00:00Z' && bad?.evaluationTime === 0.002,
         'observed recording rule carries health, lastError, lastEvaluation, evaluationTime', bad);
  const unknown = observed?.find(r => r.name === 'svc_checkout:availability:good_5m');
  assert(unknown && unknown.health === null && unknown.lastError === null,
         'a rule the ruler reported no health for reads null (absent ≠ unhealthy)', unknown);
}
assert(pAnn['mcp.discovered.recording_rules_unhealthy'] === 'svc_checkout:latency_p95:value_5m',
       'mcp.discovered.recording_rules_unhealthy lists the rule with health !== ok',
       pAnn['mcp.discovered.recording_rules_unhealthy'], 'svc_checkout:latency_p95:value_5m');
// Per-index stamps (the adapter reads queries.recording_rules[<i>]):
// healthy and health-less rules are Verified; the failing one is not.
{
  const badIdx = ruleNames.indexOf('svc_checkout:latency_p95:value_5m');
  assert(badIdx >= 0, 'failing rule still lands in spec.queries (it exists)');
  ruleNames.forEach((n, i) => {
    const stamped = typeof pAnn[`mcp.verified.queries.recording_rules[${i}]`] === 'string';
    assert(stamped === (i !== badIdx), `queries.recording_rules[${i}] (${n}) ${i === badIdx ? 'NOT ' : ''}stamped verified`, stamped, i !== badIdx);
  });
  const l = adapt(probed);
  const qry = l.layers.L3.filter(x => x.id.startsWith('QRY-'));
  assert(qry[0]?.source === 'Verified' && qry[badIdx]?.source === 'Declared',
         'adapter projects healthy rules as Verified and the failing rule as Declared',
         qry.map(q => `${q.title}:${q.source}`));
}
// Alerting rule on-wire state is observed too.
{
  const observed = JSON.parse(pAnn['mcp.observed.alert_rules'] || 'null');
  assert(Array.isArray(observed) && observed.length === 1
         && observed[0].name === 'CheckoutHighErrorRate' && observed[0].state === 'firing'
         && observed[0].health === 'ok' && observed[0].activeAt === '2026-06-05T23:50:00Z' && observed[0].lastError === null,
         'mcp.observed.alert_rules carries state/health/lastError/lastEvaluation/activeAt', observed);
  assert(Object.keys(observed[0]).join() === 'name,health,lastError,lastEvaluation,state,activeAt,interval' && observed[0].interval === null,
         'an alert observation entry carries interval (null when the adapter kept no group interval) and no labels key when the rule has no linkage labels',
         Object.keys(observed[0]).join());
  assert(pAnn['mcp.discovered.alert_rules_unhealthy'] === undefined, 'no alert_rules_unhealthy list when every alert rule is healthy');
}

// dashboards: discovered ones replace the platform-overview stub.
const dashIds = probed.spec.dashboards.map(d => d.id);
assert(dashIds.includes('checkout-overview') && dashIds.includes('platform-health'),
       'dashboards section carries discovered dashboards');
assert(!dashIds.includes('platform-overview'),
       'dashboards section does NOT include the stub when probe responded');

// alert rule names surface as annotation (we can't reshape multi-window from a flat alert).
assert(probed.metadata.annotations['mcp.discovered.alert_rule_names']?.includes('CheckoutHighErrorRate'),
       'discovered alert rule names annotated');

// scrape jobs + metric inventory surfaced as annotations. Only jobs with
// a target that is up (or of unknown health) count as scrape evidence;
// the all-down job is listed separately and every target's on-wire
// health is kept.
assert(pAnn['mcp.discovered.scrape_jobs'] === 'checkout,platform,collector',
       'scrape jobs annotated — the all-down job is excluded',
       pAnn['mcp.discovered.scrape_jobs'], 'checkout,platform,collector');
assert(pAnn['mcp.discovered.scrape_jobs_down'] === 'alertmanager',
       'mcp.discovered.scrape_jobs_down lists the job whose every target is down',
       pAnn['mcp.discovered.scrape_jobs_down'], 'alertmanager');
{
  const targets = JSON.parse(pAnn['mcp.observed.scrape_targets'] || 'null');
  assert(Array.isArray(targets) && targets.length === 5, 'mcp.observed.scrape_targets is a JSON array with one entry per target', targets?.length, 5);
  const am = targets?.find(t => t.job === 'alertmanager');
  assert(am?.instance === 'am:9093' && am?.health === 'down' && am?.lastScrape === '2026-06-06T00:00:00Z',
         'observed target carries job/instance/health/lastScrape', am);
  assert(typeof am?.lastError === 'string' && am.lastError.startsWith('dial tcp4') && am.lastError.length === 200,
         'observed target lastError is carried, trimmed to 200 chars', am?.lastError?.length, 200);
  const unknown = targets?.find(t => t.job === 'collector');
  assert(unknown && unknown.health === null, 'unknown target health reads null', unknown);
  const l = adapt(probed);
  const live = l.layers.L2.filter(x => x.id.startsWith('SCRAPE-') && !x.id.startsWith('SCRAPE-SRC-'));
  assert(live.length === 3 && live.every(x => x.source === 'Verified') && !live.some(x => x.spec?.job === 'alertmanager'),
         'adapter projects only the up jobs as Verified scrape evidence', live.map(x => x.spec?.job));
}
assert(probed.metadata.annotations['mcp.discovered.metric_names_count'] === '3',
       'metric inventory count annotated');
assert(probed.metadata.annotations['mcp.discovered.metric_names']?.includes('http_requests_total'),
       'full metric inventory annotated');
assert(probed.metadata.annotations['mcp.discovered.metric_names_sample']?.includes('http_requests_total'),
       'metric inventory sample annotated');

// probesAttempted + probesSucceeded reflect what we asked vs what answered.
assert(probed.metadata.annotations['mcp.probesAttempted']?.includes('recording_rules'),
       'probesAttempted lists recording_rules');
assert(probed.metadata.annotations['mcp.probesSucceeded']?.includes('dashboards'),
       'probesSucceeded lists dashboards');

// verified.* tags for the discovered surfaces.
assert(typeof probed.metadata.annotations['mcp.verified.queries.recording_rules'] === 'string',
       'recording rules verified by MCP');
assert(typeof probed.metadata.annotations['mcp.verified.dashboards'] === 'string',
       'dashboards verified by MCP');
assert(typeof probed.metadata.annotations['mcp.verified.telemetry.scrape'] === 'string',
       'scrape evidence verified by MCP');
assert(typeof probed.metadata.annotations['mcp.verified.otel.metrics'] === 'string',
       'metric inventory verified by MCP');
assert(typeof probed.metadata.annotations['mcp.verified.pipelines.exporters.metrics'] === 'string',
       'metrics exporter path verified when scrape/metric inventory is observed');
assert(probed.metadata.annotations['mcp.scaffold.pipelines.exporters.metrics'] === undefined,
       'metrics exporter carries no scaffold marker once evidence stamped it');
assert(typeof probed.metadata.annotations['mcp.scaffold.pipelines.exporters.logs'] === 'string',
       'logs exporter stays scaffold (nothing attests it)');
assert(typeof probed.metadata.annotations['mcp.verified.slis.svc_checkout_availability'] === 'string'
       && probed.metadata.annotations['mcp.scaffold.slis.svc_checkout_availability'] === undefined,
       'SLI inferred from real recorded rules keeps its verified stamp (no scaffold)');
assert(probed.metadata.annotations['mcp.scaffold.dashboards.platform-overview'] === undefined,
       'no dashboard scaffold marker when dashboards were discovered');
{
  const l = adapt(probed);
  assert(l.layers.L2.find(x => x.id === 'PIP-EXP-MET')?.source === 'Verified', 'adapter projects the evidenced metrics exporter as Verified');
  assert(l.layers.L1.find(x => x.id === 'SLI-01')?.source === 'Verified', 'adapter projects the rule-inferred SLI as Verified');
}

// A plain threshold alert is NOT a burn-rate alert: nothing maps, the
// schema-forced placeholder stands in and is stamped scaffold, and no
// mcp.verified.policy.* key is written on the strength of a NAME.
assert(probed.spec.policy.burn_rate_alerts.length === 1
       && typeof probed.metadata.annotations['mcp.scaffold.policy.burn_rate_alerts[0]'] === 'string',
       'threshold alert alone → scaffold placeholder, not a Verified burn-rate alert');
assert(probed.metadata.annotations['mcp.verified.policy.burn_rate_alerts'] === undefined
       && probed.metadata.annotations['mcp.verified.policy.burn_rate_alerts[0]'] === undefined,
       'no burn-rate verification stamp on the strength of a discovered alert NAME');

// An SLI inferred from a rule the ruler reports FAILING to evaluate is not
// measuring anything: the latency_p95 rule above carries health 'err', so
// the threshold SLI built on it stays Declared and is named.
assert(pAnn['mcp.verified.slis.svc_checkout_latency_p95'] === undefined,
       'SLI inferred from an unhealthy recorded rule is NOT stamped verified');
assert(pAnn['mcp.discovered.slis_unhealthy'] === 'svc_checkout_latency_p95',
       'mcp.discovered.slis_unhealthy names the SLI whose feeding rule is unhealthy',
       pAnn['mcp.discovered.slis_unhealthy'], 'svc_checkout_latency_p95');
{
  const l = adapt(probed);
  const sli = l.layers.L1.find(x => x.spec?.id === 'svc_checkout_latency_p95');
  assert(sli?.source === 'Declared', 'adapter projects the SLI fed by an unhealthy rule as Declared', sli?.source, 'Declared');
}
// Discovered dashboards are stamped per id — the symbol the adapter reads
// (`dashboards.<id>`) — beside the aggregate key.
assert(typeof pAnn['mcp.verified.dashboards.checkout-overview'] === 'string'
       && typeof pAnn['mcp.verified.dashboards.platform-health'] === 'string',
       'each discovered dashboard is stamped mcp.verified.dashboards.<id>');
{
  const dash = adapt(probed).layers.L3.filter(x => x.id.startsWith('DASH-'));
  assert(dash.length === 2 && dash.every(d => d.source === 'Verified'),
         'adapter projects discovered dashboards as Verified', dash.map(d => `${d.title}:${d.source}`));
}

// Rule health is any-unhealthy-wins per NAME: the same rule reported by
// two groups (one failing, one ok) must not stamp both entries Verified
// while mcp.discovered.recording_rules_unhealthy names it.
{
  const dup = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: {
      recording_rules: { tool: 'vmalert_rules', adapted: [
        { name: 'svc_checkout:availability:ratio_5m', expr: 'a/b', health: 'err', lastError: 'boom' },
        { name: 'svc_checkout:availability:ratio_5m', expr: 'a/b', health: 'ok' },
      ] },
    },
    errors: {},
  });
  const dAnn = dup.metadata.annotations;
  assert(dAnn['mcp.verified.queries.recording_rules[0]'] === undefined && dAnn['mcp.verified.queries.recording_rules[1]'] === undefined
         && dAnn['mcp.verified.queries.recording_rules'] === undefined,
         'a rule name reported unhealthy by any group earns no indexed (or group) stamp',
         Object.keys(dAnn).filter(k => k.startsWith('mcp.verified.queries')), []);
  assert(dAnn['mcp.discovered.recording_rules_unhealthy'] === 'svc_checkout:availability:ratio_5m',
         'the duplicated rule is named unhealthy once', dAnn['mcp.discovered.recording_rules_unhealthy']);
  assert(dAnn['mcp.verified.slis.svc_checkout_availability'] === undefined
         && dAnn['mcp.discovered.slis_unhealthy'] === 'svc_checkout_availability',
         'the SLI inferred from the duplicated unhealthy rule is not verified and is named');
}

// ---------- case 3a: on-wire scrape liveness — all targets down, legacy job names ----------
//
// A job name is not evidence. When every target the MCP reports is
// down, nothing is being scraped: no mcp.discovered.scrape_jobs, no
// mcp.verified.telemetry.scrape, and the metrics exporter falls back to
// its scaffold marker (no metric inventory arrived either).
{
  const allDown = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: {
      scrape_configs: { tool: 'metrics_targets', adapted: [
        { job: 'checkout', targets: [
          { instance: 'checkout-1:8080', health: 'down', lastScrape: '2026-06-06T00:00:00Z', lastError: 'connection refused' },
          { instance: 'checkout-2:8080', health: 'down', lastScrape: '2026-06-06T00:00:00Z', lastError: 'context deadline exceeded' },
        ] },
        { job: 'alertmanager', targets: [{ instance: 'am:9093', health: 'down', lastScrape: null, lastError: 'connection refused' }] },
      ] },
    },
    errors: {},
  });
  const ann = allDown.metadata.annotations;
  assert(validateCanonical(allDown, SCHEMA).length === 0, 'all-down pack validates');
  assert(ann['mcp.discovered.scrape_jobs'] === undefined, 'no mcp.discovered.scrape_jobs when every target is down');
  assert(ann['mcp.discovered.scrape_jobs_down'] === 'checkout,alertmanager',
         'every all-down job listed in mcp.discovered.scrape_jobs_down', ann['mcp.discovered.scrape_jobs_down'], 'checkout,alertmanager');
  assert(ann['mcp.verified.telemetry.scrape'] === undefined, 'telemetry.scrape NOT verified on the strength of down targets');
  assert(ann['mcp.verified.pipelines.exporters.metrics'] === undefined
         && typeof ann['mcp.scaffold.pipelines.exporters.metrics'] === 'string',
         'metrics exporter stays scaffold when the only scrape evidence is down targets');
  assert(JSON.parse(ann['mcp.observed.scrape_targets']).length === 3, 'all three down targets observed');
  assert(ann['mcp.discovered.scrape_configs'] === '2', 'probe count annotation still counts jobs (2)', ann['mcp.discovered.scrape_configs'], '2');
  const l = adapt(allDown);
  assert(!l.layers.L2.some(x => x.id.startsWith('SCRAPE-')), 'adapter projects no live scrape rows for down-only jobs');
  assert(l.layers.L2.find(x => x.id === 'PIP-EXP-MET')?.source === 'Scaffold', 'adapter projects the metrics exporter as Scaffold');

  // Legacy probe results (job-name string[]) still count as evidence —
  // a name carries no target health, so it is not evidence of being down.
  const legacy = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: { scrape_configs: { tool: 'list_scrape_configs', adapted: ['checkout', 'platform'] } },
    errors: {},
  });
  const lAnn = legacy.metadata.annotations;
  assert(lAnn['mcp.discovered.scrape_jobs'] === 'checkout,platform' && typeof lAnn['mcp.verified.telemetry.scrape'] === 'string',
         'legacy string[] scrape results still surface as (health-less) scrape evidence');
  assert(lAnn['mcp.discovered.scrape_jobs_down'] === undefined && lAnn['mcp.observed.scrape_targets'] === undefined,
         'legacy string[] scrape results carry no down list and no observed targets');

  // The metrics_targets adapter itself: fixture shape → per-job targets,
  // deduped, unknown health → null, Prometheus /api/v1/targets tolerated.
  const scrapeProbe = PROBES.find(p => p.name === 'scrape_configs');
  const adapted = scrapeProbe.adapt({ activeTargets: 3, targets: [
    { job: 'a', instance: 'a-1', health: 'up', lastScrape: 't1', lastError: null },
    { job: 'a', instance: 'a-1', health: 'up', lastScrape: 't1', lastError: null },   // duplicate
    { job: 'a', instance: 'a-2', health: 'unknown', lastScrape: null, lastError: '' },
    { job: 'b', instance: 'b-1', health: 'DOWN', lastScrape: 't2', lastError: 'boom' },
  ] });
  assert(adapted.length === 2 && adapted[0].job === 'a' && adapted[0].targets.length === 2,
         'scrape_configs adapt groups targets per job and dedupes identical targets', adapted);
  assert(adapted[0].targets[1].health === null && adapted[0].targets[1].lastError === null,
         'unknown health → null; empty lastError → null', adapted[0].targets[1]);
  assert(adapted[1].targets[0].health === 'down' && adapted[1].targets[0].lastError === 'boom',
         'health is case-normalised; lastError carried', adapted[1].targets[0]);
  const prom = scrapeProbe.adapt({ status: 'success', data: { activeTargets: [
    { labels: { job: 'node', instance: 'n1:9100' }, health: 'up', lastScrape: 't', lastError: '' },
  ] } });
  assert(prom.length === 1 && prom[0].job === 'node' && prom[0].targets[0].instance === 'n1:9100' && prom[0].targets[0].health === 'up',
         'Prometheus /api/v1/targets shape (labels.job / labels.instance) tolerated', prom);
}

// ---------- case 3b: discovered burn-rate alerting rules map onto policy.burn_rate_alerts ----------
//
// The fetcher used to synthesise a two-window burn alert per SLO and
// stamp it Verified whenever ANY alert name came back — false assurance.
// Now compiler-labelled rules ({slo, burn_rate, window_short, window_long,
// severity}) and name-pattern rules (`<slo>_burn_<N>x_<short>_<long>`)
// are grouped per SLO, an inferred placeholder SLO sharing the SLI base
// is re-identified to the discovered id (objective/window taken from the
// rule annotations), forecast rules are skipped, and groups that name an
// SLO nobody inferred land in mcp.discovered.alert_rules_unmapped.

const DISCOVERED_SLO = 'svc_checkout_availability_99_9';
const UNKNOWN_SLO = 'svc_payments_latency_99';
const compilerLabels = (slo, factor, short, long, severity) => ({
  severity, slo, sli: 'svc_checkout_availability', service: 'checkout',
  burn_rate: String(factor), window_short: short, window_long: long,
});
const compilerAnnotations = { summary: 'x', description: 'y', slo_objective: '99.900%', slo_window: '30d', runbook: '(supply runbook URL)' };
const burnProbed = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
  topology: { dependencies: [] },
  anomaliesActive: {},
  baselinesData: { baselines: [] },
  probeResults: {
    recording_rules: {
      tool: 'list_recording_rules',
      adapted: [
        { name: 'svc_checkout:availability:good_5m',  expr: 'sum(rate(http_requests_total{status_code!~"5.."}[5m]))', interval: '30s' },
        { name: 'svc_checkout:availability:total_5m', expr: 'sum(rate(http_requests_total[5m]))',                       interval: '30s' },
      ],
    },
    alert_rules: {
      tool: 'list_alert_rules',
      adapted: [
        // long window listed FIRST — the mapper must order short-window-first.
        { name: `${DISCOVERED_SLO}_burn_6x_30m_6h`, expr: 'e1', for: '15m',
          labels: compilerLabels(DISCOVERED_SLO, 6, '30m', '6h', 'SEV2'), annotations: compilerAnnotations },
        { name: `${DISCOVERED_SLO}_burn_14x_5m_1h`, expr: 'e2', for: '2m',
          labels: compilerLabels(DISCOVERED_SLO, 14, '5m', '1h', 'SEV1'), annotations: compilerAnnotations },
        // duplicate of the 14x window (e.g. the same rule in two groups) — deduped.
        { name: `${DISCOVERED_SLO}_burn_14x_5m_1h_copy`, expr: 'e2', for: '2m',
          labels: compilerLabels(DISCOVERED_SLO, 14, '5m', '1h', 'SEV1'), annotations: compilerAnnotations },
        // unlabelled rule recognised by the compiler NAME pattern; no
        // severity label → inferred from the factor (recorded as such).
        { name: `${DISCOVERED_SLO}_burn_2x_6h_3d`, expr: 'e3', for: '1h', labels: {}, annotations: {} },
        // forecast rule — skipped by the burn mapper, name still surfaced.
        { name: `${DISCOVERED_SLO}_forecast_linear_7d`, expr: 'predict_linear(...)', for: '5m',
          labels: { kind: 'forecast', slo: DISCOVERED_SLO }, annotations: {} },
        // burn-rate rules for an SLO nobody inferred → unmapped (not representable).
        { name: `${UNKNOWN_SLO}_burn_14x_5m_1h`, expr: 'e4', for: '2m',
          labels: compilerLabels(UNKNOWN_SLO, 14, '5m', '1h', 'SEV1'), annotations: {} },
        { name: `${UNKNOWN_SLO}_burn_6x_30m_6h`, expr: 'e5', for: '15m',
          labels: compilerLabels(UNKNOWN_SLO, 6, '30m', '6h', 'SEV2'), annotations: {} },
        // plain threshold alert — not a burn-rate alert, ignored by the mapper.
        { name: 'CheckoutHighErrorRate', expr: 'svc_checkout:availability:ratio_5m < 0.99', for: '5m', labels: {}, annotations: {} },
      ],
    },
  },
  errors: {},
});
{
  const errors = validateCanonical(burnProbed, SCHEMA);
  assert(errors.length === 0, 'burn-mapped pack validates against canonical schema', errors, []);
}
const bAnn = burnProbed.metadata.annotations;
const burnAlerts = burnProbed.spec.policy.burn_rate_alerts;
assert(burnAlerts.length === 1, 'exactly one burn-rate entry (the checkout SLO group)', burnAlerts.length, 1);
assert(burnAlerts[0]?.slo === DISCOVERED_SLO, 'burn-rate entry binds to the DISCOVERED slo id', burnAlerts[0]?.slo, DISCOVERED_SLO);
assert(JSON.stringify(burnAlerts[0]?.windows) === JSON.stringify([
  { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
  { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
  { short: '6h',  long: '3d', factor: 2,  severity: 'SEV3' },
]), 'windows: deduped, short-window-first, name-pattern rule merged, factor a Number',
   burnAlerts[0]?.windows);

// The observation entries carry the compiler's linkage labels — those four
// keys and nothing else of the label set — so the graph ladder can link a
// live rule to its declared window without the name convention.
{
  const observed = JSON.parse(bAnn['mcp.observed.alert_rules']);
  const fast = observed.find(r => r.name === `${DISCOVERED_SLO}_burn_14x_5m_1h`);
  assert(JSON.stringify(fast?.labels) === JSON.stringify({ slo: DISCOVERED_SLO, burn_rate: '14', window_short: '5m', window_long: '1h' }),
         'mcp.observed.alert_rules entry carries labels { slo, burn_rate, window_short, window_long } only (severity/sli/service dropped)', fast?.labels);
  const bare = observed.find(r => r.name === `${DISCOVERED_SLO}_burn_2x_6h_3d`);
  assert(bare && !('labels' in bare), 'an entry whose rule has no linkage labels carries no labels key at all', Object.keys(bare || {}));
  const forecast = observed.find(r => r.name === `${DISCOVERED_SLO}_forecast_linear_7d`);
  assert(JSON.stringify(forecast?.labels) === JSON.stringify({ slo: DISCOVERED_SLO }),
         'only the linkage keys present are carried (a forecast rule keeps just slo)', forecast?.labels);
}

// re-id of the inferred placeholder SLO + objective/window replacement.
assert(burnProbed.spec.slos.some(s => s.id === DISCOVERED_SLO), 'inferred SLO re-identified to the discovered id');
assert(!burnProbed.spec.slos.some(s => s.id === 'svc_checkout_availability_99'), 'placeholder SLO id no longer present');
const reidSlo = burnProbed.spec.slos.find(s => s.id === DISCOVERED_SLO);
assert(reidSlo?.objective === 0.999, 'placeholder objective replaced from slo_objective annotation (99.900% → 0.999)',
       reidSlo?.objective, 0.999);
assert(reidSlo?.window === '30d', 'window taken from slo_window annotation');
assert(reidSlo?.sli === 'svc_checkout_availability', 're-identified SLO still references its SLI');

// stamps: indexed Verified for the mapped entry, no unindexed key, no scaffold.
assert(typeof bAnn['mcp.verified.policy.burn_rate_alerts[0]'] === 'string', 'mapped burn-rate alert stamped mcp.verified.policy.burn_rate_alerts[0]');
assert(bAnn['mcp.verified.policy.burn_rate_alerts'] === undefined, 'no unindexed mcp.verified.policy.burn_rate_alerts stamp');
assert(bAnn['mcp.verified.policy.burn_rate_alerts[1]'] === undefined, 'no stamp beyond the mapped entries');
assert(bAnn['mcp.scaffold.policy.burn_rate_alerts[0]'] === undefined, 'no scaffold placeholder when a real burn alert mapped');
assert(typeof bAnn[`mcp.verified.slos.${DISCOVERED_SLO}`] === 'string'
       && bAnn['mcp.scaffold.slos.svc_checkout_availability_99'] === undefined
       && bAnn[`mcp.scaffold.slos.${DISCOVERED_SLO}`] === undefined,
       're-identified SLO is verified from the live rule annotations; no stale scaffold under the old id');

// annotations: names (incl. forecast + threshold), unmapped, inferred severity.
assert(bAnn['mcp.discovered.alert_rule_names']?.includes(`${DISCOVERED_SLO}_forecast_linear_7d`), 'forecast rule name still surfaced in alert_rule_names');
assert(bAnn['mcp.discovered.alert_rule_names']?.includes('CheckoutHighErrorRate'), 'threshold rule name still surfaced in alert_rule_names');
assert(bAnn['mcp.discovered.alert_rules_unmapped'] === UNKNOWN_SLO,
       'burn group for an SLO nobody inferred lands in mcp.discovered.alert_rules_unmapped',
       bAnn['mcp.discovered.alert_rules_unmapped'], UNKNOWN_SLO);
assert(bAnn['mcp.discovered.alert_rules_severity_inferred'] === `${DISCOVERED_SLO}_burn_2x_6h_3d`,
       'rules whose severity was inferred from the factor are listed',
       bAnn['mcp.discovered.alert_rules_severity_inferred'], `${DISCOVERED_SLO}_burn_2x_6h_3d`);

// adapter: mapped entry projects as Verified and references the re-id'd SLO.
{
  const l = adapt(burnProbed);
  const pol = l.layers.L4.policy.filter(x => x.id.startsWith('POL-'));
  assert(pol.length === 1 && pol[0].source === 'Verified', 'adapter projects the mapped burn-rate alert as Verified', pol.map(p => p.source), ['Verified']);
  assert(pol[0]?.refs?.includes(`slos.${DISCOVERED_SLO}`), 'adapter burn-rate alert refs the discovered SLO id', pol[0]?.refs, [`slos.${DISCOVERED_SLO}`]);
  const slo = l.layers.L1.find(x => x.spec?.id === DISCOVERED_SLO);
  assert(!!slo, 'adapter L1 carries the re-identified SLO');
}

// A single-window burn group is a real alert the schema cannot hold
// (windows minItems 2): reported as unmapped, never padded.
{
  const single = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: {
      alert_rules: { tool: 'list_alert_rules', adapted: [
        { name: 'svc_checkout_availability_99_burn_14x_5m_1h', expr: 'e', for: '2m', labels: { severity: 'critical' }, annotations: {} },
      ] },
    },
    errors: {},
  });
  assert(validateCanonical(single, SCHEMA).length === 0, 'single-window pack still validates (scaffold placeholder)');
  assert(single.metadata.annotations['mcp.discovered.alert_rules_unmapped'] === 'svc_checkout_availability_99',
         'single-window group reported unmapped rather than padded',
         single.metadata.annotations['mcp.discovered.alert_rules_unmapped'], 'svc_checkout_availability_99');
  assert(typeof single.metadata.annotations['mcp.scaffold.policy.burn_rate_alerts[0]'] === 'string',
         'single-window group → schema placeholder stamped scaffold');
  assert(single.metadata.annotations['mcp.verified.policy.burn_rate_alerts[0]'] === undefined,
         'single-window group → no Verified stamp');
}

// A burn-rate group fed by a rule the ruler reports UNHEALTHY still maps
// (the rule exists, the entry is real) but earns no indexed verified
// stamp: a rule that fails to evaluate is not paging anyone.
{
  const unhealthy = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: {
      alert_rules: { tool: 'vmalert_rules', adapted: [
        { name: 'svc_checkout_availability_99_burn_14x_5m_1h', expr: 'e', for: '2m', labels: { severity: 'critical' }, annotations: {},
          health: 'err', lastError: 'unknown function', state: 'inactive', lastEvaluation: '2026-06-06T00:00:00Z' },
        { name: 'svc_checkout_availability_99_burn_6x_30m_6h', expr: 'e', for: '15m', labels: { severity: 'warning' }, annotations: {},
          health: 'ok', state: 'inactive', lastEvaluation: '2026-06-06T00:00:00Z' },
      ] },
    },
    errors: {},
  });
  const uAnn = unhealthy.metadata.annotations;
  assert(validateCanonical(unhealthy, SCHEMA).length === 0, 'unhealthy-rule pack validates');
  assert(unhealthy.spec.policy.burn_rate_alerts.length === 1 && unhealthy.spec.policy.burn_rate_alerts[0].windows.length === 2,
         'unhealthy burn rule still maps into its group (it exists)');
  assert(uAnn['mcp.verified.policy.burn_rate_alerts[0]'] === undefined && uAnn['mcp.scaffold.policy.burn_rate_alerts[0]'] === undefined,
         'group fed by an unhealthy rule earns no verified stamp (and is no scaffold either)');
  assert(uAnn['mcp.discovered.alert_rules_unhealthy'] === 'svc_checkout_availability_99_burn_14x_5m_1h',
         'mcp.discovered.alert_rules_unhealthy names the failing rule',
         uAnn['mcp.discovered.alert_rules_unhealthy'], 'svc_checkout_availability_99_burn_14x_5m_1h');
  const observed = JSON.parse(uAnn['mcp.observed.alert_rules']);
  assert(observed.length === 2 && observed[0].health === 'err' && observed[0].lastError === 'unknown function' && observed[1].health === 'ok',
         'mcp.observed.alert_rules carries per-rule health', observed);
  const pol = adapt(unhealthy).layers.L4.policy.filter(x => x.id.startsWith('POL-'));
  assert(pol.length === 1 && pol[0].source === 'Declared', 'adapter projects the unhealthy-fed burn alert as Declared (present, not attested)', pol.map(p => p.source), ['Declared']);
}

// Fractional burn factors: the compiler names a 14.4x rule `_burn_14_4x_`
// (the `.` squashed to `_`), so the name pattern reads it back as 14.4;
// and an adapted rule's group interval rides into the observation entry.
{
  const frac = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: {
      alert_rules: { tool: 'vmalert_rules', adapted: [
        { name: 'svc_checkout_availability_99_burn_14_4x_5m_1h', expr: 'e', for: '2m', labels: { severity: 'critical' }, annotations: {},
          interval: '15s', health: 'ok', state: 'inactive', lastEvaluation: '2026-06-06T00:00:00Z' },
        { name: 'svc_checkout_availability_99_burn_6x_30m_6h', expr: 'e', for: '15m', labels: { severity: 'warning' }, annotations: {},
          interval: '15s', health: 'ok', state: 'inactive', lastEvaluation: '2026-06-06T00:00:00Z' },
      ] },
    },
    errors: {},
  });
  assert(validateCanonical(frac, SCHEMA).length === 0, 'fractional-factor pack validates (factor is a number > 1)');
  const windows = frac.spec.policy.burn_rate_alerts[0]?.windows || [];
  assert(windows.length === 2 && windows[0].factor === 14.4 && windows[0].short === '5m' && windows[1].factor === 6,
         'a `_burn_14_4x_` rule maps by name to a 14.4 factor window', windows);
  const observed = JSON.parse(frac.metadata.annotations['mcp.observed.alert_rules']);
  assert(observed.every(r => r.interval === '15s') && observed.every(r => !('labels' in r)),
         'the alert group interval rides into mcp.observed.alert_rules; severity alone yields no labels key', observed);
}

// Tiered SLOs on one SLI (99 and 99.9 — a realistic setup): the group
// whose id EXACTLY matches the inferred placeholder binds it, and the
// group that only shares the SLI base must not re-identify the SAME
// SLO out from under it. Every burn entry's `slo` must resolve to a
// spec.slos id, whatever order the ruler lists the groups in.
for (const order of ['exact-first', 'base-first']) {
  const exact = 'svc_checkout_availability_99';
  const tiered = 'svc_checkout_availability_99_9';
  const evidence = { summary: 'x', description: 'y', slo_objective: '99.500%', slo_window: '7d', runbook: 'r' };
  const groupA = [
    { name: `${exact}_burn_14x_5m_1h`, expr: 'e', for: '2m', labels: compilerLabels(exact, 14, '5m', '1h', 'SEV1'), annotations: evidence },
    { name: `${exact}_burn_6x_30m_6h`, expr: 'e', for: '15m', labels: compilerLabels(exact, 6, '30m', '6h', 'SEV2'), annotations: evidence },
  ];
  const groupB = [
    { name: `${tiered}_burn_14x_5m_1h`, expr: 'e', for: '2m', labels: compilerLabels(tiered, 14, '5m', '1h', 'SEV1'), annotations: {} },
    { name: `${tiered}_burn_6x_30m_6h`, expr: 'e', for: '15m', labels: compilerLabels(tiered, 6, '30m', '6h', 'SEV2'), annotations: {} },
  ];
  const tieredPack = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    // No recorded rules → the per-service availability GUESS is the only
    // SLO: `svc_checkout_availability_99`, stamped scaffold.
    health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: {
      alert_rules: { tool: 'list_alert_rules', adapted: order === 'exact-first' ? [...groupA, ...groupB] : [...groupB, ...groupA] },
    },
    errors: {},
  });
  const tAnn = tieredPack.metadata.annotations;
  const sloIds = tieredPack.spec.slos.map(s => s.id);
  const burnRefs = tieredPack.spec.policy.burn_rate_alerts.map(b => b.slo);
  assert(validateCanonical(tieredPack, SCHEMA).length === 0, `[${order}] tiered-SLO pack validates`);
  assert(sloIds.join() === exact, `[${order}] the exactly-matched placeholder keeps its id (never re-identified to the tiered id)`, sloIds, [exact]);
  assert(burnRefs.every(id => sloIds.includes(id)),
         `[${order}] every burn_rate_alerts[].slo resolves to a spec.slos id (no dangling ref)`, burnRefs, sloIds);
  assert(burnRefs.join() === exact && tAnn['mcp.discovered.alert_rules_unmapped'] === tiered,
         `[${order}] the tiered group cannot bind (its SLO is already claimed) and is reported unmapped`,
         { burnRefs, unmapped: tAnn['mcp.discovered.alert_rules_unmapped'] }, { burnRefs: [exact], unmapped: tiered });
  const slo = tieredPack.spec.slos[0];
  assert(slo.objective === 0.995 && slo.window === '7d',
         `[${order}] an exact match applies the rule's slo_objective / slo_window evidence like a re-id does`,
         { objective: slo.objective, window: slo.window }, { objective: 0.995, window: '7d' });
  assert(tAnn[`mcp.scaffold.slos.${exact}`] === undefined && typeof tAnn[`mcp.verified.slos.${exact}`] === 'string',
         `[${order}] an exactly-matched SLO drops its scaffold marker and is attested`,
         { scaffold: tAnn[`mcp.scaffold.slos.${exact}`], verified: tAnn[`mcp.verified.slos.${exact}`] });
  assert(typeof tAnn[`mcp.scaffold.slis.${exact.replace(/_99$/, '')}`] === 'string',
         `[${order}] the guessed SLI under it stays scaffold (a burn rule attests the SLO, not the measurement)`);
  const pol = adapt(tieredPack).layers.L4.policy;
  assert(pol.length === 1 && pol[0].source === 'Verified' && pol[0].refs[0] === `slos.${exact}`,
         `[${order}] adapter: one Verified burn alert whose ref exists`, pol.map(p => `${p.source}:${p.refs[0]}`));
}

// An SLO re-identified from a burn group fed by an UNHEALTHY rule takes
// the evidence (objective/window) but must not read Verified — the burn
// entry itself is withheld for the same reason.
{
  const tiered = 'svc_checkout_availability_99_9';
  const unhealthyReid = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
    topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] },
    probeResults: {
      recording_rules: { tool: 'list_recording_rules', adapted: [
        { name: 'svc_checkout:availability:good_5m',  expr: 'g', interval: '30s' },
        { name: 'svc_checkout:availability:total_5m', expr: 't', interval: '30s' },
      ] },
      alert_rules: { tool: 'vmalert_rules', adapted: [
        { name: `${tiered}_burn_14x_5m_1h`, expr: 'e', for: '2m', labels: compilerLabels(tiered, 14, '5m', '1h', 'SEV1'), annotations: compilerAnnotations,
          health: 'err', lastError: 'unknown function', state: 'inactive' },
        { name: `${tiered}_burn_6x_30m_6h`, expr: 'e', for: '15m', labels: compilerLabels(tiered, 6, '30m', '6h', 'SEV2'), annotations: compilerAnnotations,
          health: 'ok', state: 'inactive' },
      ] },
    },
    errors: {},
  });
  const rAnn = unhealthyReid.metadata.annotations;
  assert(unhealthyReid.spec.slos[0].id === tiered && unhealthyReid.spec.slos[0].objective === 0.999,
         'the placeholder is still re-identified and takes the objective evidence', unhealthyReid.spec.slos[0]);
  assert(rAnn[`mcp.verified.slos.${tiered}`] === undefined && rAnn[`mcp.scaffold.slos.${tiered}`] === undefined
         && rAnn['mcp.verified.policy.burn_rate_alerts[0]'] === undefined,
         'an SLO re-identified from an unhealthy burn group is NOT stamped verified (nor scaffold); the burn entry is not either',
         Object.keys(rAnn).filter(k => /verified\.(slos|policy)/.test(k)), []);
  const l = adapt(unhealthyReid);
  assert(l.layers.L1.find(x => x.spec?.id === tiered)?.source === 'Declared', 'adapter projects that SLO as Declared');
}

// A re-id must yield a valid schema Slug: when `<base>_<objective>` would
// exceed 64 chars the group stays unmapped and the placeholder keeps its id.
{
  const base = `svc_${'a'.repeat(50)}_availability`;   // 58 chars; `${base}_99` = 61 fits, `${base}_99_9` = 63 fits, `${base}_99_99_9` = 66 does not
  const slos = [{ id: `${base}_99`, sli: base, objective: 0.99, window: '30d' }];
  const tooLong = `${base}_99_99_9`;
  const r = mapDiscoveredBurnAlerts([
    { name: `${tooLong}_burn_14x_5m_1h`, labels: compilerLabels(tooLong, 14, '5m', '1h', 'SEV1'), annotations: {} },
    { name: `${tooLong}_burn_6x_30m_6h`, labels: compilerLabels(tooLong, 6, '30m', '6h', 'SEV2'), annotations: {} },
  ], slos);
  assert(tooLong.length > 64 && r.alerts.length === 0 && r.unmapped.join() === tooLong && slos[0].id === `${base}_99`,
         'a discovered id longer than the schema Slug allows is refused as a re-id (unmapped, placeholder untouched)',
         { alerts: r.alerts, unmapped: r.unmapped, slo: slos[0].id });
}

// ---------- case 4: probes attempted but came back empty — honest gap ----------
//
// Confirms the "what to refine" narrative. probesAttempted records the
// kind, but no `tool` field means nothing answered. The fetcher must
// fall back to stubs without claiming verification.

const probedEmpty = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout', criticality: 'tier-2' }] },
  topology: { dependencies: [] },
  anomaliesActive: {},
  baselinesData: { baselines: [] },
  probeResults: {
    recording_rules: { tool: null, attempted: ['list_recording_rules', 'prometheus_recording_rules'], adapted: null },
    dashboards:      { tool: null, attempted: ['grafana_search'], adapted: null },
  },
  errors: {},
});
assert(probedEmpty.metadata.annotations['mcp.probesAttempted']?.includes('recording_rules'),
       'probesAttempted lists recording_rules even when none answered');
assert(!probedEmpty.metadata.annotations['mcp.probesSucceeded']?.includes('recording_rules'),
       'probesSucceeded does NOT list recording_rules when none answered');
assert(probedEmpty.metadata.annotations['mcp.verified.queries.recording_rules'] === undefined,
       'recording rules NOT marked verified when probes returned empty');

// ---------- case 4a: probe-outcome honesty — unsupported vs failed ----------
//
// tools/list answered and exposes NO candidate for a family: the probe
// loop records outcome 'unsupported' (a restricted MCP tier). A family
// whose every exposed candidate errored records 'failed', and fetchMcp's
// probeFailures map (keyed by candidate tool NAME) carries the reason.
// The pack must keep the two apart — "not exposed" is never "no answer"
// — and surface WHY a probe failed, trimmed like every observed error.

{
  const longError = 'HTTP 503 Service Unavailable: ' + 'x'.repeat(300);
  const outcomes = buildCanonicalPack({
    refreshedAt,
    mcpUrl: 'https://fake-mcp.test/observability',
    health: { services: [{ name: 'svc-checkout', criticality: 'tier-2' }] },
    topology: { dependencies: [] },
    anomaliesActive: {},
    baselinesData: { baselines: [] },
    probeResults: {
      // Two-candidate cascade: the first candidate errored, the second
      // answered — the family SUCCEEDED and must carry no probe error.
      recording_rules: { tool: 'prometheus_rules', attempted: ['vmalert_rules', 'prometheus_rules'], adapted: [{ name: 'job:up:ratio', expr: 'avg(up)' }], outcome: 'data' },
      dashboards:      { tool: null, attempted: ['grafana_dashboards_search', 'grafana_search'], adapted: null, outcome: 'failed' },
      scrape_configs:  { tool: null, attempted: ['metrics_targets', 'prometheus_targets'], adapted: null,
                         skippedReason: 'no candidate matched tools/list inventory', outcome: 'unsupported' },
      metric_names:    { tool: null, attempted: ['metrics_label_values'], adapted: null,
                         skippedReason: 'no candidate matched tools/list inventory', outcome: 'unsupported' },
    },
    probeFailures: {
      vmalert_rules: 'HTTP 503',                     // erroring FIRST candidate of a family that then answered
      grafana_dashboards_search: 'HTTP 502 Bad Gateway',
      grafana_search: longError,
      'metrics_query.ALERTS': 'HTTP 503',            // fallback key — no family's candidate list names it
      metrics_targets: 'never tried (unsupported)',  // an unsupported family must not gain an error entry from a stale key
    },
    errors: {},
  });
  const oAnn = outcomes.metadata.annotations;
  assert(validateCanonical(outcomes, SCHEMA).length === 0, 'probe-outcome pack validates against canonical schema');
  assert(oAnn['mcp.probesUnsupported'] === 'scrape_configs,metric_names',
         'mcp.probesUnsupported lists the families with outcome unsupported, in probe order', oAnn['mcp.probesUnsupported']);
  assert(oAnn['mcp.probesFailed'] === 'dashboards',
         'mcp.probesFailed lists ONLY the failed family — unsupported families are not failures', oAnn['mcp.probesFailed']);
  assert(oAnn['mcp.probesSucceeded'] === 'recording_rules',
         'mcp.probesSucceeded is unaffected', oAnn['mcp.probesSucceeded']);
  assert(oAnn['mcp.probesAttempted'] === 'recording_rules,dashboards,scrape_configs,metric_names',
         'mcp.probesAttempted still lists every family (unsupported included) — existing key unchanged', oAnn['mcp.probesAttempted']);
  assert(typeof oAnn['mcp.probeErrors.dashboards'] === 'string' && oAnn['mcp.probeErrors.dashboards'].startsWith('HTTP 503 Service Unavailable: '),
         'mcp.probeErrors.<family> carries the LAST erroring candidate of the family', oAnn['mcp.probeErrors.dashboards']);
  assert(oAnn['mcp.probeErrors.dashboards'].length === 200,
         'probe errors are trimmed to 200 chars', oAnn['mcp.probeErrors.dashboards'].length, 200);
  assert(oAnn['mcp.probeErrors.recording_rules'] === undefined,
         'a family whose later candidate answered carries no error, even though its first candidate errored (it is in probesSucceeded)');
  assert(oAnn['mcp.probeErrors.scrape_configs'] === undefined && oAnn['mcp.probeErrors.metric_names'] === undefined,
         'unsupported families carry no probe error even when a stale probeFailures key names a candidate',
         [oAnn['mcp.probeErrors.scrape_configs'], oAnn['mcp.probeErrors.metric_names']]);
  assert(!Object.keys(oAnn).some(k => k.startsWith('mcp.probeErrors.') && !['dashboards'].includes(k.slice('mcp.probeErrors.'.length))),
         'probeFailures keys that match no family candidate (e.g. metrics_query.ALERTS) never become annotations',
         Object.keys(oAnn).filter(k => k.startsWith('mcp.probeErrors.')));
  assert(oAnn['mcp.verified.telemetry.scrape'] === undefined && oAnn['mcp.discovered.scrape_jobs'] === undefined,
         'an unsupported scrape_configs family attests nothing');

  // Nothing unsupported, nothing failed → the keys exist but are empty /
  // absent, so older readers keep parsing ''.
  const cleanAnn = probedEmpty.metadata.annotations;
  assert(cleanAnn['mcp.probesUnsupported'] === '', 'mcp.probesUnsupported is an empty string when every family is exposed', cleanAnn['mcp.probesUnsupported']);
  assert(!Object.keys(cleanAnn).some(k => k.startsWith('mcp.probeErrors.')), 'no mcp.probeErrors.* without probeFailures');
}

// ---------- case 5: VMAlert probe adapters recover REAL exprs ----------
//
// Regression guard for the name-only-stub bug: on VictoriaMetrics stacks
// the Prometheus ruler (metrics_alerts) returns {groups:[]} empty, so the
// fetcher used to fall back to a name-only inventory grep that stubbed
// each expr as the bare series name. `vmalert_rules` carries the full
// PromQL `query` body + group `interval` (seconds) + alert `severity`.

const recProbe = PROBES.find(p => p.name === 'recording_rules');
const altProbe = PROBES.find(p => p.name === 'alert_rules');

assert(recProbe.candidates[0] === 'vmalert_rules',
       'recording_rules tries vmalert_rules first (VM ruler returns empty)');
assert(altProbe.candidates[0] === 'vmalert_rules',
       'alert_rules tries vmalert_rules first');

// Real vmalert_rules response shape (recording + alerting in one payload,
// interval expressed in integer SECONDS on the group).
const vmalertResponse = {
  count: 2,
  groups: [
    {
      name: 'finops:capacity',
      file: '/etc/vmalert/recording-rules.yml',
      interval: 300,
      rules: [
        { name: 'finops:cpu:usage_per_pod_5m', type: 'recording', query: 'sum(rate(container_cpu_usage_seconds_total[5m])) by (pod) * 3600' },
      ],
    },
    {
      name: 'krystalinex.container_health',
      file: '/etc/vmalert/alerting-rules.yml',
      interval: 15,
      rules: [
        { name: 'ContainerOOMKilled', type: 'alerting', severity: 'warning', duration: 120, query: 'kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1', annotations: { summary: 'Container was OOM killed' } },
      ],
    },
  ],
};

const recAdapted = recProbe.adapt(vmalertResponse);
assert(recAdapted.length === 1 && recAdapted[0].name === 'finops:cpu:usage_per_pod_5m',
       'vmalert recording rule recovered (alerting rule excluded)');
assert(!('health' in recAdapted[0]) && !('lastEvaluation' in recAdapted[0]),
       'observation fields absent from the adapted rule when the ruler did not report them');
{
  const withState = recProbe.adapt({ groups: [{ name: 'g', interval: 60, rules: [
    { name: 'a:b:c', type: 'recording', query: 'up', health: 'err', lastError: 'boom', lastEvaluation: 't', evaluationTime: 0.5, state: '', activeAt: null },
  ] }] });
  assert(withState[0].health === 'err' && withState[0].lastError === 'boom' && withState[0].lastEvaluation === 't' && withState[0].evaluationTime === 0.5
         && !('state' in withState[0]) && !('activeAt' in withState[0]),
         'recording adapter carries health/lastError/lastEvaluation/evaluationTime (not state/activeAt)', withState[0]);
  const alertState = altProbe.adapt({ groups: [{ name: 'g', rules: [
    { name: 'A', type: 'alerting', query: 'up == 0', health: 'ok', state: 'firing', lastEvaluation: 't', activeAt: 'a0', lastError: null },
    { alert: 'B', expr: 'up == 0', health: 'ok', state: 'firing', alerts: [{ activeAt: 'a1', state: 'firing' }] },
  ] }] });
  assert(alertState[0].state === 'firing' && alertState[0].activeAt === 'a0' && alertState[0].health === 'ok' && !('lastError' in alertState[0]),
         'alert adapter carries state/health/activeAt; null lastError omitted', alertState[0]);
  assert(alertState[1].activeAt === 'a1', 'Prometheus per-instance alerts[].activeAt tolerated', alertState[1]);
}
assert(recAdapted[0].expr.includes('container_cpu_usage_seconds_total') && recAdapted[0].expr !== recAdapted[0].name,
       'vmalert recording rule carries REAL PromQL expr, not the name stub');
assert(recAdapted[0].interval === '5m',
       'group interval seconds (300) normalised to prom duration (5m)', recAdapted[0].interval, '5m');

const altAdapted = altProbe.adapt(vmalertResponse);
assert(altAdapted.length === 1 && altAdapted[0].name === 'ContainerOOMKilled',
       'vmalert alerting rule recovered (recording rule excluded)');
assert(altAdapted[0].expr.includes('OOMKilled') && altAdapted[0].labels?.severity === 'warning',
       'vmalert alert carries real expr + severity label');
assert(altAdapted[0].for === '2m',
       'alert duration seconds (120) normalised to prom duration (2m)', altAdapted[0].for, '2m');

// metrics_alerts empty ruler payload yields no rules (the trigger for fallback).
assert(recProbe.adapt({ groups: [] }).length === 0,
       'empty Prometheus ruler payload adapts to zero recording rules');

// ---------- case 6: dashboard search is enriched with dashboard bodies ----------

const FAKE_MCP_TOOLS = [
  'system_health',
  'system_topology',
  'anomalies_active',
  'anomalies_baselines',
  'grafana_dashboards_search',
  'grafana_dashboard_get',
];

async function withFakeMcp(handler, tools = FAKE_MCP_TOOLS) {
  const srv = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch (_) {}
    const send = (result) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': 'fetch-test-session',
      });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }));
    };
    if (msg.method === 'initialize') {
      send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp' } });
      return;
    }
    if (msg.method === 'notifications/initialized') { send({}); return; }
    if (msg.method === 'tools/list') {
      send({ tools: tools.map(name => ({ name })) });
      return;
    }
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const result = handler(name, msg.params?.arguments || {});
      send({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      return;
    }
    send({});
  });
  await new Promise(resolveListen => srv.listen(0, '127.0.0.1', resolveListen));
  const addr = srv.address();
  return {
    url: `http://${addr.address}:${addr.port}/mcp`,
    close: () => new Promise(resolveClose => srv.close(resolveClose)),
  };
}

{
  const fake = await withFakeMcp((name, args) => {
    if (name === 'system_health') return { services: [] };
    if (name === 'system_topology') return { dependencies: [] };
    if (name === 'anomalies_active') return {};
    if (name === 'anomalies_baselines') return { baselines: [] };
    if (name === 'grafana_dashboards_search') {
      return {
        count: 1,
        results: [{
          uid: '123abc',
          title: 'Checkout Live',
          type: 'dash-db',
          url: '/d/123abc/checkout-live',
          folderTitle: 'Checkout',
        }],
      };
    }
    if (name === 'grafana_dashboard_get') {
      assert(args.uid === '123abc', 'dashboard get called with UID from search', args.uid, '123abc');
      return {
        meta: { folderTitle: 'Checkout', url: '/d/123abc/checkout-live' },
        dashboard: {
          uid: '123abc',
          title: 'Checkout Live',
          schemaVersion: 42,
          version: 7,
          panelCount: 2,
          returnedPanels: 2,
          panels: [
            { id: 1, title: 'HTTP Success', targets: [{ refId: 'A', expr: 'sum(rate(http_requests_total[5m]))' }] },
            { id: 2, title: 'Latency P99', targets: [{ refId: 'A', expr: 'slo:http_request_duration:p99_5m' }] },
          ],
        },
        raw: {
          uid: '123abc',
          title: 'Checkout Live',
          schemaVersion: 42,
          panels: [{ id: 1, title: 'HTTP Success' }, { id: 2, title: 'Latency P99' }],
        },
      };
    }
    return {};
  });
  try {
    const fetched = await fetchMcp({ mcpUrl: fake.url });
    const dash = fetched.probeResults.dashboards.adapted[0];
    assert(dash.id === 'dash-123abc', 'numeric dashboard UID is schema-safe slugged', dash.id, 'dash-123abc');
    assert(dash.panel_bindings.length === 2, 'dashboard_get panels become panel_bindings', dash.panel_bindings.length, 2);
    assert(dash.params.raw.uid === '123abc', 'dashboard raw JSON preserved in params.raw', dash.params.raw.uid, '123abc');
    const enriched = buildCanonicalPack({ refreshedAt, mcpUrl: fake.url, ...fetched });
    assert(enriched.metadata.annotations['mcp.discovered.dashboard_panels'] === '2',
           'dashboard panel count annotated', enriched.metadata.annotations['mcp.discovered.dashboard_panels'], '2');
    assert(enriched.metadata.annotations['mcp.discovered.dashboard_raw_json'] === '1',
           'dashboard raw-json count annotated', enriched.metadata.annotations['mcp.discovered.dashboard_raw_json'], '1');
  } finally {
    await fake.close();
  }
}

// ---------- case 7: backend_capabilities materialises L2X extended surfaces ----------

const l2xLive = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout' }] },
  topology: { dependencies: [] },
  anomaliesActive: {},
  baselinesData: { baselines: [] },
  capabilities: {
    gatingMode: 'warn',
    protocolModel: 'otel-mcp',
    skills: [
      { skill: 'metrics', backends: [{ backend: 'Prometheus', productVersions: { must: ['2.51.0'] }, baselineFeatures: ['query'] }] },
      { skill: 'logs', backends: [{ backend: 'Grafana Loki', productVersions: { must: ['3.0.0'] }, baselineFeatures: ['query'] }] },
      { skill: 'traces', backends: [{ backend: 'Jaeger', productVersions: { must: ['1.56.0'] }, baselineFeatures: ['search'] }] },
      { skill: 'pyroscope', backends: [{ backend: 'Grafana Pyroscope', productVersions: { must: ['1.7.0'] }, baselineFeatures: ['cpu'] }] },
      { skill: 'cilium', backends: [{ backend: 'Cilium', productVersions: { must: ['1.15.0'] }, baselineFeatures: ['flows'] }] },
      { skill: 'opa', backends: [{ backend: 'Open Policy Agent', productVersions: { must: ['0.63.0'] }, baselineFeatures: ['decisions'] }] },
      { skill: 'envoy', backends: [{ backend: 'Envoy', productVersions: { must: ['1.31.0'] }, baselineFeatures: ['stats'] }] },
      { skill: 'kong', backends: [{ backend: 'Kong', productVersions: { must: ['3.6.0'] }, baselineFeatures: ['admin_api'] }] },
      { skill: 'pipeline', backends: [{ backend: 'Vector', productVersions: { must: ['0.36.0'] }, baselineFeatures: ['remap'] }] },
    ],
  },
  errors: {},
});
{
  const errors = validateCanonical(l2xLive, SCHEMA);
  assert(errors.length === 0, 'L2X live pack validates against canonical schema', errors, []);
}
assert(l2xLive.spec.profiling?.backend === 'profiles-pyroscope',
       'live profiling surface materialised from backend_capabilities');
assert(l2xLive.spec.network?.backend === 'network-cilium',
       'live network surface materialised from backend_capabilities');
assert(l2xLive.spec.policy_engine?.backend === 'policy-opa',
       'live policy engine surface materialised from backend_capabilities');
assert(l2xLive.spec.mesh?.some(m => m.product === 'envoy' && m.role === 'proxy'),
       'live envoy mesh surface materialised');
assert(l2xLive.spec.mesh?.some(m => m.product === 'kong' && m.role === 'gateway'),
       'live kong gateway surface materialised');
assert(l2xLive.spec.collection?.some(c => c.product === 'vector' && c.role === 'aggregator'),
       'live vector collection surface materialised');
assert(l2xLive.metadata.annotations['mcp.discovered.extended_surfaces'] === '6',
       'extended surface count annotated');
assert(typeof l2xLive.metadata.annotations['mcp.verified.profiling'] === 'string',
       'profiling surface marked verified');
assert(typeof l2xLive.metadata.annotations['mcp.verified.network'] === 'string',
       'network surface marked verified');
assert(typeof l2xLive.metadata.annotations['mcp.verified.policy_engine'] === 'string',
       'policy engine surface marked verified');
const l2xLayered = adapt(l2xLive);
assert(l2xLayered.layers.L2X.length === 6,
       'adapter renders all live L2X surfaces', l2xLayered.layers.L2X.length, 6);
assert(l2xLayered.layers.L2X.every(x => x.source === 'Verified'),
       'adapter surfaces Verified source for live L2X surfaces');

// ---------- case 8: step 2 — stack self-metrics sampler (signals, never verdicts) ----------

// A stub metrics_query: `answers` maps an expr to a response (or a thrown
// error via { throw: msg }); anything else answers an empty vector. Every
// call is logged so the tests can pin the call budget and the alias order.
function stubMetricsQuery(answers) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, query: args.query });
    const a = answers[args.query];
    if (a && a.throw) throw new Error(a.throw);
    return a === undefined ? { result: [] } : a;
  };
  return { calls, callTool };
}
const vec = (v) => ({ result: [{ metric: {}, value: [1757203200, String(v)] }] });
const quietStub = async (_name, fn) => { try { return await fn(); } catch { return null; } };
const rowById = (rows, id) => rows.find(r => r.id === id);
const pick = (...ids) => STACK_SELF_METRIC_PROBES.filter(r => ids.includes(r.id));

// (a) with an inventory: eligibility via requires, product preference, outcomes
{
  const rows = pick('scrape_success_ratio', 'scrape_targets_down', 'rule_evaluation_failures',
                    'tsdb_active_series', 'wal_corruptions', 'query_latency_p99');
  const inventory = [
    'up', 'vm_promscrape_targets',
    'vmalert_recording_rules_errors_total', 'vmalert_alerting_rules_errors_total',
    'prometheus_rule_evaluation_failures_total',
    'vm_cache_entries', 'prometheus_tsdb_head_series',
    'prometheus_engine_query_duration_seconds',
    // wal_corruptions' metric deliberately absent
  ];
  const { calls, callTool } = stubMetricsQuery({
    'sum(up) / count(up)': vec('0.98'),
    'count(up == 0) or (count(up) * 0)': { result: [] },                                   // empty on the generic alias …
    'sum(vm_promscrape_targets{status="down"})': vec('1'),             // … the VM alias answers
    'sum(rate(vmalert_recording_rules_errors_total[5m])) + sum(rate(vmalert_alerting_rules_errors_total[5m]))': vec('0'),
    'sum(vm_cache_entries{type="storage/hour_metric_ids"})': vec('NaN'),
    'sum(prometheus_tsdb_head_series)': vec('12345'),
    'max(prometheus_engine_query_duration_seconds{slice="inner_eval",quantile="0.99"})': { throw: 'metrics_query: HTTP 500 boom' },
  });
  const s = await sampleStackSelfMetrics({
    callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory,
    seenProducts: ['victoriametrics'], discoveredToolNames: new Set(['metrics_query']), hasToolsList: true,
    refreshedAt, rows,
  });
  assert(s.status === 'sampled', 'sampler status is sampled when metrics_query is advertised', s.status, 'sampled');
  const ratio = rowById(s.rows, 'scrape_success_ratio');
  assert(ratio.outcome === 'data' && ratio.value === 0.98 && ratio.product === 'generic',
         'generic alias samples data', ratio, 'data/0.98/generic');
  assert(ratio.at === refreshedAt && ratio.unit === 'ratio' && ratio.direction === 'higher',
         'row record carries at/unit/direction', ratio);
  const down = rowById(s.rows, 'scrape_targets_down');
  assert(down.outcome === 'data' && down.product === 'victoriametrics' && down.value === 1,
         'generic empty → cascades to the next eligible alias (VM) which answers', down);
  const rule = rowById(s.rows, 'rule_evaluation_failures');
  assert(rule.product === 'victoriametrics' && rule.outcome === 'data' && rule.value === 0,
         'product preference: victoriametrics seen → its alias is tried before prometheus', rule);
  assert(calls.filter(c => c.query.includes('prometheus_rule_evaluation_failures_total')).length === 0,
         'the preferred alias answering with data stops the row cascade (no prometheus call)', calls.map(c => c.query));
  assert(calls.filter(c => c.query.includes('grafana_alerting_rule_evaluation_failures_total')).length === 0,
         'an alias whose required metric is missing from the inventory is never called');
  const series = rowById(s.rows, 'tsdb_active_series');
  assert(series.outcome === 'data' && series.product === 'prometheus' && series.value === 12345,
         'NaN from the preferred alias is empty → the next eligible alias is tried', series);
  const wal = rowById(s.rows, 'wal_corruptions');
  assert(wal.outcome === 'not-in-inventory' && wal.product === null && wal.expr === null && /prometheus_tsdb_wal_corruptions_total/.test(wal.reason),
         'a row with no eligible alias is not-in-inventory with the required names in the reason', wal);
  assert(calls.every(c => !c.query.includes('wal_corruptions')), 'not-in-inventory rows make no call');
  const q = rowById(s.rows, 'query_latency_p99');
  assert(q.outcome === 'failed' && /HTTP 500/.test(q.reason), 'a thrown call is failed with the trimmed error as reason', q);
  assert(s.callsMade === calls.length && s.callsMade === 7, 'callsMade counts every metrics_query call', [s.callsMade, calls.length], 7);
  assert(s.rows.every(r => r.outcome !== 'ok'), 'rows are never ok — only data|empty|failed|not-in-inventory|not-attempted');
}

// (a2) NaN / ±Inf / missing value / Prometheus-API envelope
{
  const rows = pick('scrape_success_ratio');
  for (const [raw, label] of [['NaN', 'NaN'], ['+Inf', '+Inf'], ['-Inf', '-Inf']]) {
    const { callTool } = stubMetricsQuery({ 'sum(up) / count(up)': vec(raw) });
    const s = await sampleStackSelfMetrics({ callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: ['up'], refreshedAt, rows });
    assert(s.rows[0].outcome === 'empty' && s.rows[0].value === null, `${label} sample → outcome empty, value null`, s.rows[0]);
  }
  const { callTool: promApi } = stubMetricsQuery({
    'sum(up) / count(up)': { status: 'success', data: { resultType: 'vector', result: [{ metric: {}, value: [1, '1'] }] } },
  });
  const s2 = await sampleStackSelfMetrics({ callTool: promApi, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: ['up'], refreshedAt, rows });
  assert(s2.rows[0].outcome === 'data' && s2.rows[0].value === 1, 'Prometheus-API envelope { data: { result } } is parsed', s2.rows[0]);
  const { callTool: noValue } = stubMetricsQuery({ 'sum(up) / count(up)': { result: [{ metric: { job: 'x' } }] } });
  const s3 = await sampleStackSelfMetrics({ callTool: noValue, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: ['up'], refreshedAt, rows });
  assert(s3.rows[0].outcome === 'empty', 'a series with no sample value is empty (not data)', s3.rows[0]);
  // A COUNT row is an aggregation returning one series: a series-only
  // answer must never be counted as "1 target down" — it is empty, for
  // every unit.
  for (const id of ['scrape_targets_down', 'active_silences', 'synthetic_probe_failures']) {
    const [countRow] = pick(id);
    const seriesOnly = sampleFromInstantVector(countRow, { result: [{ metric: { __name__: 'x' } }] });
    assert(seriesOnly.outcome === 'empty' && seriesOnly.value === null && /no sample value/.test(seriesOnly.reason),
           `${id} (count): a series without a sample value is empty, never value=1`, seriesOnly);
    const twoSeries = sampleFromInstantVector(countRow, { result: [{ metric: { a: '1' } }, { metric: { a: '2' } }] });
    assert(twoSeries.outcome === 'empty' && twoSeries.value === null, `${id} (count): two value-less series are still empty, not 2`, twoSeries);
  }
  const zero = sampleFromInstantVector(pick('scrape_targets_down')[0], vec('0'));
  assert(zero.outcome === 'data' && zero.value === 0, 'a count row answering 0 (the guarded zero) is data 0, not empty', zero);
  const { callTool: badShape } = stubMetricsQuery({ 'sum(up) / count(up)': { rows: 3 } });
  const s4 = await sampleStackSelfMetrics({ callTool: badShape, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: ['up'], refreshedAt, rows });
  assert(s4.rows[0].outcome === 'failed' && /payload/.test(s4.rows[0].reason), 'a non-instant-vector answer is failed with the shape reason', s4.rows[0]);
}

// (b) without an inventory: bounded alias cascade, 2 calls per row
{
  const rows = pick('rule_evaluation_failures');   // three aliases: prometheus, victoriametrics, grafana
  const { calls, callTool } = stubMetricsQuery({});  // everything empty
  const s = await sampleStackSelfMetrics({ callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: null, refreshedAt, rows });
  assert(calls.length === 2, 'without an inventory a row tries at most 2 aliases', calls.map(c => c.query), 2);
  assert(s.rows[0].outcome === 'empty' && s.rows[0].product === 'victoriametrics',
         'the last tried alias is recorded when all come back empty', s.rows[0]);
  const { calls: c2, callTool: t2 } = stubMetricsQuery({
    'sum(rate(grafana_alerting_rule_evaluation_failures_total[5m]))': vec('2'),
  });
  const s2 = await sampleStackSelfMetrics({ callTool: t2, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: null, seenProducts: ['grafana'], refreshedAt, rows });
  assert(c2.length === 1 && s2.rows[0].product === 'grafana' && s2.rows[0].value === 2,
         'a seen product jumps ahead of the declared order and data stops the cascade', s2.rows[0]);
}

// (b2) with a TRUSTED inventory every eligible alias may be tried (no per-row cap)
{
  const rows = pick('rule_evaluation_failures');
  const inventory = ['up', 'prometheus_rule_evaluation_failures_total', 'vmalert_recording_rules_errors_total', 'vmalert_alerting_rules_errors_total', 'grafana_alerting_rule_evaluation_failures_total'];
  const { calls, callTool } = stubMetricsQuery({});  // everything empty
  const s = await sampleStackSelfMetrics({ callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory, refreshedAt, rows });
  assert(calls.length === 3 && s.rows[0].product === 'grafana' && s.rows[0].outcome === 'empty',
         'with an inventory all three eligible aliases are tried (evidence-backed, no 2-per-row cap)', calls.map(c => c.query));
  assert(s.inventory && s.inventory.trusted === true && s.inventory.size === inventory.length,
         'the sampler reports the inventory as trusted (carries up) with its size', s.inventory);
}

// (b3) an inventory WITHOUT `up` is evidence of presence, never of absence:
// rows with no eligible alias are queried anyway (bounded cascade) and read
// empty / failed / data honestly, never not-in-inventory.
{
  const trimmed = ['bayesian_forecast_total', 'ALERTS', 'ALERTS_FOR_STATE'];   // the recorded reference fixture's flavour
  const { calls, callTool } = stubMetricsQuery({
    'sum(up) / count(up)': vec('0.83'),
    'count(up == 0) or (count(up) * 0)': vec('1'),
  });
  const s = await sampleStackSelfMetrics({ callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: trimmed, refreshedAt });
  assert(s.inventory.trusted === false && /lacks `up`/.test(s.inventory.reason) && s.inventory.size === 3,
         'an inventory without up is untrusted, with the reason', s.inventory);
  assert(s.rows.every(r => r.outcome !== 'not-in-inventory'), 'an untrusted inventory gates nothing — no row reads not-in-inventory', s.rows.filter(r => r.outcome === 'not-in-inventory').map(r => r.id));
  const ratio = rowById(s.rows, 'scrape_success_ratio');
  assert(ratio.outcome === 'data' && ratio.value === 0.83, 'rows the trimmed inventory would have gated are sampled through the wire', ratio);
  const down = rowById(s.rows, 'scrape_targets_down');
  assert(down.outcome === 'data' && down.value === 1, 'a count row beyond the trimmed inventory samples its value', down);
  const wal = rowById(s.rows, 'wal_corruptions');
  assert(wal.outcome === 'empty' && /queried anyway/.test(wal.reason) && /3-name inventory/.test(wal.reason),
         'an empty answer beyond an untrusted inventory says so in the reason (queried anyway)', wal);
  assert(calls.length > 0 && calls.length <= 48 && s.callsMade === calls.length, 'the cascade stays within the global budget', calls.length);
  const rule = rowById(s.rows, 'rule_evaluation_failures');
  assert(calls.filter(c => /rule_evaluation_failures_total|vmalert_.*rules_errors_total|grafana_alerting_rule/.test(c.query)).length === 2,
         'the fallback cascade is bounded to 2 calls per row', rule);
  // An EMPTY inventory (the tool answered a list with nothing in it) is
  // likewise untrusted — not 24 × not-in-inventory with zero calls.
  const { calls: c0, callTool: t0 } = stubMetricsQuery({ 'sum(up) / count(up)': vec('1') });
  const s0 = await sampleStackSelfMetrics({ callTool: t0, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: [], refreshedAt, rows: pick('scrape_success_ratio') });
  assert(c0.length === 1 && s0.rows[0].outcome === 'data', 'an empty inventory never asserts absence: the row is queried', [c0.length, s0.rows[0].outcome]);
}

// (b4) a TRUSTED inventory names its size in the not-in-inventory reason
{
  const { calls, callTool } = stubMetricsQuery({});
  const s = await sampleStackSelfMetrics({ callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: ['up', 'other_metric'], refreshedAt, rows: pick('wal_corruptions') });
  assert(calls.length === 0 && s.rows[0].outcome === 'not-in-inventory' && /2-name inventory/.test(s.rows[0].reason) && /prometheus_tsdb_wal_corruptions_total/.test(s.rows[0].reason),
         'a trusted inventory gates with the inventory size and the required names in the reason', s.rows[0]);
}

// (c) global cap → not-attempted with reason
{
  const { calls, callTool } = stubMetricsQuery({});
  const s = await sampleStackSelfMetrics({ callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: null, refreshedAt, maxCalls: 5 });
  assert(calls.length === 5 && s.callsMade === 5, 'the global cap bounds the metrics_query calls', [calls.length, s.callsMade], 5);
  const notAttempted = s.rows.filter(r => r.outcome === 'not-attempted');
  assert(notAttempted.length > 0 && notAttempted.every(r => r.reason === 'call budget exhausted'),
         'rows beyond the cap are not-attempted with reason "call budget exhausted"', notAttempted[0]);
  assert(s.rows.length === STACK_SELF_METRIC_PROBES.length, 'every row of the table gets a record', s.rows.length, STACK_SELF_METRIC_PROBES.length);
  const sDefault = await sampleStackSelfMetrics({ callTool: stubMetricsQuery({}).callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: null, refreshedAt });
  assert(sDefault.callsMade <= 48, 'default budget is 48 calls', sDefault.callsMade);
}

// (d) tools/list present but metrics_query not advertised → not-attempted, zero calls
{
  const { calls, callTool } = stubMetricsQuery({ 'sum(up) / count(up)': vec('1') });
  const s = await sampleStackSelfMetrics({
    callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: ['up'],
    discoveredToolNames: new Set(['system_health']), hasToolsList: true, refreshedAt,
  });
  assert(s.status === 'not-attempted' && s.reason === 'metrics_query not exposed by this MCP (restricted tier)',
         'restricted tier → status not-attempted with the reason', [s.status, s.reason]);
  assert(calls.length === 0 && s.callsMade === 0, 'restricted tier makes zero calls', calls.length, 0);
  assert(s.rows.every(r => r.outcome === 'not-attempted' && r.reason === s.reason),
         'every row is not-attempted with the tier reason (never absent)', s.rows[0]);
}

// (e) no tools/list at all (older server) → attempted
{
  const { calls, callTool } = stubMetricsQuery({ 'sum(up) / count(up)': vec('1') });
  const s = await sampleStackSelfMetrics({
    callTool, quiet: quietStub, metricsQueryTool: 'metrics_query', inventory: ['up'],
    discoveredToolNames: new Set(), hasToolsList: false, refreshedAt, rows: pick('scrape_success_ratio'),
  });
  assert(s.status === 'sampled' && calls.length === 1 && s.rows[0].value === 1,
         'no tools/list → the sampler still attempts', [s.status, calls.length]);
}

// (f) quiet() integration: errors land in probeFailures under 'stack_self_metrics'
{
  const probeFailures = {};
  const quietReal = async (name, fn) => { try { return await fn(); } catch (e) { if (!probeFailures[name]) probeFailures[name] = e.message; return null; } };
  const { callTool } = stubMetricsQuery({ 'sum(up) / count(up)': { throw: 'metrics_query: bad request' } });
  const s = await sampleStackSelfMetrics({ callTool, quiet: quietReal, metricsQueryTool: 'metrics_query', inventory: ['up'], refreshedAt, rows: pick('scrape_success_ratio') });
  assert(probeFailures.stack_self_metrics === 'metrics_query: bad request', 'failures are collected under the family name stack_self_metrics', probeFailures);
  assert(s.rows[0].outcome === 'failed' && s.rows[0].reason === 'metrics_query: bad request', 'the row keeps its own error as reason', s.rows[0]);
}

// ---------- case 8b: Alertmanager / Grafana status observers ----------

// A recording at the fixtures top level takes precedence over the synthetic
// copy (tools/fixtures/mcp/README.md, "Provenance"): once a status payload
// has been recorded the synthetic file is deleted, so replay the recording.
// The authoring metadata (_synthetic / _recorded) is not something a server
// would send — strip it either way.
const SYN = (f) => {
  const recorded = resolve(__dirname, 'fixtures', 'mcp', f);
  const path = existsSync(recorded) ? recorded : resolve(__dirname, 'fixtures', 'mcp', 'synthetic', f);
  const j = JSON.parse(readFileSync(path, 'utf8'));
  delete j._synthetic; delete j._recorded;
  return j;
};
{
  const calls = [];
  const callTool = async (name, args = {}) => {
    calls.push({ name, args });
    if (name === 'alertmanager_status') return SYN('alertmanager_status.json');
    if (name === 'alertmanager_silences') return SYN('alertmanager_silences.json');
    if (name === 'grafana_datasources') return SYN('grafana_datasources.json');
    if (name === 'grafana_datasource_health') {
      if (args.uid === 'synthetic-loki') return { status: 'ERROR', message: 'x'.repeat(400) };
      if (args.uid === 'synthetic-jaeger') throw new Error('grafana_datasource_health: 502');
      return SYN('grafana_datasource_health.json');
    }
    if (name === 'grafana_contact_points') return SYN('grafana_contact_points.json');
    throw new Error(`unexpected tool ${name}`);
  };
  const names = new Set(['alertmanager_status', 'alertmanager_silences', 'grafana_datasources', 'grafana_datasource_health', 'grafana_contact_points']);
  const am = await observeAlertmanager({ callTool, quiet: quietStub, discoveredToolNames: names, hasToolsList: true, statusTool: 'alertmanager_status', silencesTool: 'alertmanager_silences' });
  const amFixture = SYN('alertmanager_status.json');
  assert(am.version === amFixture.version && am.clusterStatus === 'ready' && typeof am.uptime === 'string',
         'alertmanager_status → version / uptime / clusterStatus (values read from the fixture that was replayed)', am);
  assert(am.silences.active === 1 && am.silences.total === 2, 'alertmanager_silences → active count (expired excluded)', am.silences);
  assert(am.toolsAnswered.join(',') === 'alertmanager_status,alertmanager_silences', 'alertmanager toolsAnswered lists both', am.toolsAnswered);

  const gf = await observeGrafana({ callTool, quiet: quietStub, discoveredToolNames: names, hasToolsList: true,
    datasourcesTool: 'grafana_datasources', datasourceHealthTool: 'grafana_datasource_health', contactPointsTool: 'grafana_contact_points' });
  assert(gf.datasources.length === 3 && gf.datasources[0].uid === 'synthetic-prom' && gf.datasources[0].type === 'prometheus',
         'grafana_datasources → [{uid,name,type}]', gf.datasources[0]);
  assert(gf.datasources[0].health === 'ok' && gf.datasources[1].health === 'error' && gf.datasources[2].health === 'unknown',
         'datasource health ok / error / unknown (tool errored)', gf.datasources.map(d => d.health));
  assert(gf.datasources[1].message.length === 200, 'health message trimmed to 200 chars', gf.datasources[1].message.length, 200);
  assert(gf.contactPoints.count === 2 && gf.contactPoints.names.join(',') === 'teams-sev1,email-oncall', 'grafana_contact_points → count + names', gf.contactPoints);
  assert(calls.filter(c => c.name === 'grafana_datasource_health').length === 3, 'one health call per datasource uid', calls.filter(c => c.name === 'grafana_datasource_health').length, 3);

  // Health cap: 12 datasources → only 10 health calls.
  const many = { datasources: Array.from({ length: 12 }, (_, i) => ({ uid: `ds-${i}`, name: `ds ${i}`, type: 'prometheus' })) };
  const calls2 = [];
  const t2 = async (name) => { calls2.push(name); return name === 'grafana_datasources' ? many : { status: 'OK', message: 'fine' }; };
  const gf2 = await observeGrafana({ callTool: t2, quiet: quietStub, discoveredToolNames: names, hasToolsList: true,
    datasourcesTool: 'grafana_datasources', datasourceHealthTool: 'grafana_datasource_health', contactPointsTool: null });
  assert(calls2.filter(n => n === 'grafana_datasource_health').length === 10, 'datasource health calls capped at 10', calls2.length);
  assert(gf2.datasources.filter(d => d.health === 'unknown').length === 2, 'datasources beyond the cap stay unknown', gf2.datasources.map(d => d.health));

  // Restricted tier: tools/list without the status tools → no call, null result.
  const calls3 = [];
  const t3 = async (name) => { calls3.push(name); return {}; };
  const amNone = await observeAlertmanager({ callTool: t3, quiet: quietStub, discoveredToolNames: new Set(['system_health']), hasToolsList: true, statusTool: 'alertmanager_status', silencesTool: 'alertmanager_silences' });
  const gfNone = await observeGrafana({ callTool: t3, quiet: quietStub, discoveredToolNames: new Set(['system_health']), hasToolsList: true,
    datasourcesTool: 'grafana_datasources', datasourceHealthTool: 'grafana_datasource_health', contactPointsTool: 'grafana_contact_points' });
  assert(amNone === null && gfNone === null && calls3.length === 0, 'status tools not advertised → null, zero calls', [amNone, gfNone, calls3.length]);

  // Advertised but FAILING (HTTP 403): a failure is not a tier limit — the
  // observer answers non-null with `error`, never null ("not exposed").
  const t4 = async (name) => { throw new Error(`${name}: HTTP 403 forbidden`); };
  const amFail = await observeAlertmanager({ callTool: t4, quiet: quietStub, discoveredToolNames: names, hasToolsList: true, statusTool: 'alertmanager_status', silencesTool: 'alertmanager_silences' });
  assert(amFail !== null && amFail.version === null && amFail.silences === null && amFail.toolsAnswered.length === 0,
         'advertised-but-failing Alertmanager tools → non-null, nothing answered', amFail);
  assert(/alertmanager_status: HTTP 403/.test(amFail.error) && /alertmanager_silences: HTTP 403/.test(amFail.error),
         'the Alertmanager observer carries the tools\' own errors', amFail.error);
  const gfFail = await observeGrafana({ callTool: t4, quiet: quietStub, discoveredToolNames: names, hasToolsList: true,
    datasourcesTool: 'grafana_datasources', datasourceHealthTool: 'grafana_datasource_health', contactPointsTool: 'grafana_contact_points' });
  assert(gfFail !== null && gfFail.datasources === null && gfFail.contactPoints === null && /grafana_datasources: HTTP 403/.test(gfFail.error),
         'advertised-but-failing Grafana tools → non-null with the error', gfFail);
  const t5 = async (name) => (name === 'alertmanager_status' ? { rows: 3 } : SYN('alertmanager_silences.json'));
  const amShape = await observeAlertmanager({ callTool: t5, quiet: quietStub, discoveredToolNames: names, hasToolsList: true, statusTool: 'alertmanager_status', silencesTool: 'alertmanager_silences' });
  assert(amShape.silences.active === 1 && /unexpected shape/.test(amShape.error) && amShape.toolsAnswered.join(',') === 'alertmanager_silences',
         'a shape failure on one tool is an error beside the other tool\'s answer', amShape);

  // ENVELOPE: a Prometheus-API-style { status: 'success', data: {...} }
  // wrapper must be read from the INNER document — never version null /
  // clusterStatus 'success', never a wrapped ERROR read as healthy.
  const t6 = async (name, args = {}) => {
    if (name === 'alertmanager_status') return { status: 'success', data: { versionInfo: { version: '0.27.0' }, uptime: '2026-09-06T21:15:00Z', cluster: { status: 'ready' } } };
    if (name === 'alertmanager_silences') return SYN('alertmanager_silences.json');
    if (name === 'grafana_datasources') return { status: 'success', data: [{ uid: 'loki', name: 'Loki', type: 'loki' }] };
    if (name === 'grafana_datasource_health') return { status: 'success', data: { status: 'ERROR', message: `connection refused (${args.uid})` } };
    if (name === 'grafana_contact_points') return SYN('grafana_contact_points.json');
    throw new Error(`unexpected tool ${name}`);
  };
  const amEnv = await observeAlertmanager({ callTool: t6, quiet: quietStub, discoveredToolNames: names, hasToolsList: true, statusTool: 'alertmanager_status', silencesTool: 'alertmanager_silences' });
  assert(amEnv.version === '0.27.0' && amEnv.clusterStatus === 'ready' && amEnv.error === null,
         'a { status: success, data: {...} } Alertmanager envelope reads version 0.27.0 / cluster ready from the inner document', amEnv);
  const gfEnv = await observeGrafana({ callTool: t6, quiet: quietStub, discoveredToolNames: names, hasToolsList: true,
    datasourcesTool: 'grafana_datasources', datasourceHealthTool: 'grafana_datasource_health', contactPointsTool: 'grafana_contact_points' });
  assert(gfEnv.datasources.length === 1 && gfEnv.datasources[0].health === 'error' && /connection refused/.test(gfEnv.datasources[0].message),
         'a wrapped { data: { status: ERROR } } health verdict reads error with its message — never ok', gfEnv.datasources[0]);

  // Health tool not advertised: every datasource is `unknown` (not
  // checked) — never `ok`, so no surface can print "0 unhealthy".
  const t7 = async (name) => (name === 'grafana_datasources' ? SYN('grafana_datasources.json') : SYN('grafana_contact_points.json'));
  const gfNoHealth = await observeGrafana({ callTool: t7, quiet: quietStub, discoveredToolNames: new Set(['grafana_datasources', 'grafana_contact_points']), hasToolsList: true,
    datasourcesTool: 'grafana_datasources', datasourceHealthTool: 'grafana_datasource_health', contactPointsTool: 'grafana_contact_points' });
  assert(gfNoHealth.datasources.length === 3 && gfNoHealth.datasources.every(d => d.health === 'unknown') && gfNoHealth.error === null,
         'without the health tool every datasource stays unknown (unchecked), with no error (a tier fact)', gfNoHealth.datasources.map(d => d.health));
}

// ---------- case 8c: buildCanonicalPack writes the step-2 annotation contract, never a Verified stamp ----------

{
  const stackSamples = {
    status: 'sampled', reason: null, callsMade: 6,
    rows: [
      { id: 'scrape_success_ratio', family: 'scrape', product: 'generic', expr: 'sum(up) / count(up)', value: 0.98, unit: 'ratio', direction: 'higher', at: refreshedAt, outcome: 'data' },
      { id: 'scrape_targets_down', family: 'scrape', product: 'generic', expr: 'count(up == 0) or (count(up) * 0)', value: null, unit: 'count', direction: 'lower', at: refreshedAt, outcome: 'empty' },
      { id: 'rule_evaluation_failures', family: 'ruler', product: 'prometheus', expr: 'x', value: null, unit: 'per-second', direction: 'lower', at: refreshedAt, outcome: 'failed', reason: 'HTTP 500' },
      { id: 'wal_corruptions', family: 'tsdb', product: null, expr: null, value: null, unit: 'per-hour', direction: 'lower', at: refreshedAt, outcome: 'not-in-inventory', reason: 'no alias …' },
      { id: 'log_shipper_drops', family: 'logs', product: null, expr: null, value: null, unit: 'per-second', direction: 'lower', at: refreshedAt, outcome: 'not-attempted', reason: 'call budget exhausted' },
    ],
  };
  const alertmanagerObserved = { version: '0.27.0', uptime: '2026-09-06T21:15:00Z', clusterStatus: 'ready', silences: { active: 1, total: 2 }, toolsAnswered: ['alertmanager_status', 'alertmanager_silences'] };
  const grafanaObserved = {
    datasources: [{ uid: 'p', name: 'Prom', type: 'prometheus', health: 'ok', message: null }],
    contactPoints: { count: 1, names: ['teams-sev1'] },
    toolsAnswered: ['grafana_datasources', 'grafana_datasource_health', 'grafana_contact_points'],
  };
  const base = { refreshedAt, mcpUrl: 'https://fake-mcp.test/observability', health: { services: [] }, topology: { dependencies: [] }, packName: 'stack-live' };
  const without = buildCanonicalPack(base);
  const withStack = buildCanonicalPack({ ...base, stackSamples, alertmanagerObserved, grafanaObserved });
  const w = withStack.metadata.annotations;
  assert(Object.keys(without.metadata.annotations).every(k => !k.startsWith('mcp.stack.') && !k.startsWith('mcp.observed.stack') && !k.startsWith('mcp.observed.alertmanager') && !k.startsWith('mcp.observed.grafana')),
         'a caller that predates step 2 (null inputs) gets no stack/alertmanager/grafana keys');
  assert(w['mcp.stack.status'] === 'sampled' && w['mcp.stack.reason'] === undefined, 'mcp.stack.status sampled, no reason key', [w['mcp.stack.status'], w['mcp.stack.reason']]);
  assert(w['mcp.stack.sampled'] === '1' && w['mcp.stack.empty'] === '1' && w['mcp.stack.failed'] === '1' && w['mcp.stack.notInInventory'] === '1' && w['mcp.stack.notAttempted'] === '1',
         'mcp.stack.* counts are strings per outcome', [w['mcp.stack.sampled'], w['mcp.stack.empty'], w['mcp.stack.failed'], w['mcp.stack.notInInventory'], w['mcp.stack.notAttempted']]);
  assert(w['mcp.stack.families'] === 'scrape:data,ruler:failed,tsdb:not-in-inventory,logs:not-attempted',
         'mcp.stack.families is family:best-outcome in table order', w['mcp.stack.families']);
  const observed = JSON.parse(w['mcp.observed.stack_metrics']);
  assert(observed.length === 4 && observed.every(r => r.outcome !== 'not-attempted'),
         'mcp.observed.stack_metrics carries attempted + not-in-inventory rows only', observed.map(r => `${r.id}:${r.outcome}`));
  assert(observed[0].value === 0.98 && observed[0].at === refreshedAt && observed[2].reason === 'HTTP 500' && observed[1].reason === undefined,
         'observed rows keep value / at / reason (reason only when present)', observed);
  assert(observed.every(r => !('hint' in r) && !('verdict' in r)), 'observed rows carry no hint/verdict — signals, not verdicts');
  const amAnn = JSON.parse(w['mcp.observed.alertmanager']);
  assert(amAnn.version === '0.27.0' && amAnn.silences.active === 1 && !('error' in amAnn), 'mcp.observed.alertmanager carries the observation and no error key when nothing failed', amAnn);
  assert(w['mcp.observed.grafana.error'] === undefined, 'no mcp.observed.grafana.error when the Grafana tools answered');

  // Advertised-but-failing observers annotate the failure (never silent,
  // never "not exposed").
  const failing = buildCanonicalPack({
    ...base,
    alertmanagerObserved: { version: null, uptime: null, clusterStatus: null, silences: null, toolsAnswered: [], error: 'alertmanager_status: HTTP 403 forbidden' },
    grafanaObserved: { datasources: null, contactPoints: null, toolsAnswered: [], error: 'grafana_datasources: HTTP 403 forbidden' },
  }).metadata.annotations;
  assert(JSON.parse(failing['mcp.observed.alertmanager']).error === 'alertmanager_status: HTTP 403 forbidden', 'mcp.observed.alertmanager carries the probe error', failing['mcp.observed.alertmanager']);
  assert(failing['mcp.observed.grafana.error'] === 'grafana_datasources: HTTP 403 forbidden' && failing['mcp.observed.grafana.datasources'] === undefined,
         'mcp.observed.grafana.error carries the probe error; no datasources key is fabricated', [failing['mcp.observed.grafana.error'], failing['mcp.observed.grafana.datasources']]);
  assert(!failing['mcp.toolsCalled'].split(',').some(t => /alertmanager|grafana_datasources|grafana_contact/.test(t)), 'failing status tools are not listed as called');
  const am = JSON.parse(w['mcp.observed.alertmanager']);
  assert(am.version === '0.27.0' && am.clusterStatus === 'ready' && am.silences.active === 1 && am.toolsAnswered === undefined,
         'mcp.observed.alertmanager = {version, uptime, clusterStatus, silences}', am);
  assert(JSON.parse(w['mcp.observed.grafana.datasources'])[0].health === 'ok', 'mcp.observed.grafana.datasources written', w['mcp.observed.grafana.datasources']);
  assert(JSON.parse(w['mcp.observed.grafana.contact_points']).names[0] === 'teams-sev1', 'mcp.observed.grafana.contact_points written', w['mcp.observed.grafana.contact_points']);
  const called = w['mcp.toolsCalled'].split(',');
  for (const t of ['metrics_query', 'alertmanager_status', 'alertmanager_silences', 'grafana_datasources', 'grafana_datasource_health', 'grafana_contact_points']) {
    assert(called.includes(t), `mcp.toolsCalled includes ${t}`, called);
  }
  const verifiedWithout = Object.keys(without.metadata.annotations).filter(k => k.startsWith('mcp.verified.')).sort();
  const verifiedWith = Object.keys(w).filter(k => k.startsWith('mcp.verified.')).sort();
  assert(JSON.stringify(verifiedWith) === JSON.stringify(verifiedWithout), 'no mcp.verified.* key is added by stack / Alertmanager / Grafana input', verifiedWith, verifiedWithout);
  const scaffoldWithout = Object.keys(without.metadata.annotations).filter(k => k.startsWith('mcp.scaffold.')).sort();
  const scaffoldWith = Object.keys(w).filter(k => k.startsWith('mcp.scaffold.')).sort();
  assert(JSON.stringify(scaffoldWith) === JSON.stringify(scaffoldWithout), 'no mcp.scaffold.* key changes either');
  assert(validateCanonical(withStack, SCHEMA).length === 0, 'pack with step-2 annotations validates against the schema', validateCanonical(withStack, SCHEMA));
  assert(JSON.stringify(adapt(withStack).layers.L1) === JSON.stringify(adapt(without).layers.L1), 'the adapted layers are unchanged by stack input (no grade effect)');

  // Not-attempted panel: status + reason, zero sampled, observed key absent.
  const restricted = buildCanonicalPack({ ...base, stackSamples: {
    status: 'not-attempted', reason: 'metrics_query not exposed by this MCP (restricted tier)', callsMade: 0,
    rows: STACK_SELF_METRIC_PROBES.map(r => ({ id: r.id, family: r.family, product: null, expr: null, value: null, unit: r.unit, direction: r.direction, at: refreshedAt, outcome: 'not-attempted', reason: 'metrics_query not exposed by this MCP (restricted tier)' })),
  } });
  const r = restricted.metadata.annotations;
  assert(r['mcp.stack.status'] === 'not-attempted' && r['mcp.stack.reason'] === 'metrics_query not exposed by this MCP (restricted tier)',
         'restricted tier → mcp.stack.status not-attempted + mcp.stack.reason', [r['mcp.stack.status'], r['mcp.stack.reason']]);
  assert(r['mcp.stack.notAttempted'] === String(STACK_SELF_METRIC_PROBES.length) && r['mcp.observed.stack_metrics'] === undefined,
         'restricted tier → every row counted not-attempted, no observed rows', [r['mcp.stack.notAttempted'], r['mcp.observed.stack_metrics']]);
  assert(!r['mcp.toolsCalled'].split(',').includes('metrics_query'), 'metrics_query is not listed as called when nothing answered');
  assert(r['mcp.stack.families'].split(',').every(f => f.endsWith(':not-attempted')), 'every family reads not-attempted', r['mcp.stack.families']);
}

// ---------- case 8d: fetchMcp end-to-end against the fake JSON-RPC server ----------

{
  const stackTools = [
    'system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines',
    'metrics_query', 'metrics_label_values', 'alertmanager_status', 'alertmanager_silences',
    'grafana_datasources', 'grafana_datasource_health', 'grafana_contact_points',
  ];
  const queries = [];
  const fake = await withFakeMcp((name, args) => {
    if (name === 'system_health') return { services: [] };
    if (name === 'system_topology') return { dependencies: [] };
    if (name === 'anomalies_active') return {};
    if (name === 'anomalies_baselines') return { baselines: [] };
    if (name === 'metrics_label_values') return { values: ['up', 'vm_app_version', 'vm_promscrape_targets', 'vmalert_alerts_send_errors_total', 'prometheus_notifications_errors_total'] };
    if (name === 'metrics_query') {
      queries.push(args.query);
      if (args.query === 'vm_app_version') return { result: [{ metric: { short_version: 'v1.113.0', version: 'victoria-metrics-v1.113.0' }, value: [1, '1'] }] };
      if (args.query === 'sum(up) / count(up)') return { result: [{ metric: {}, value: [1, '0.9'] }] };
      if (args.query === 'sum(rate(vmalert_alerts_send_errors_total[5m]))') return { result: [{ metric: {}, value: [1, '0'] }] };
      return { result: [] };
    }
    if (name === 'alertmanager_status') return SYN('alertmanager_status.json');
    if (name === 'alertmanager_silences') return SYN('alertmanager_silences.json');
    if (name === 'grafana_datasources') return SYN('grafana_datasources.json');
    if (name === 'grafana_datasource_health') return SYN('grafana_datasource_health.json');
    if (name === 'grafana_contact_points') return SYN('grafana_contact_points.json');
    return {};
  }, stackTools);
  try {
    const fetched = await fetchMcp({ mcpUrl: fake.url, refreshedAt });
    assert(fetched.stackSamples.status === 'sampled', 'fetchMcp samples the stack panel when metrics_query is advertised', fetched.stackSamples.status);
    const ratio = rowById(fetched.stackSamples.rows, 'scrape_success_ratio');
    assert(ratio.outcome === 'data' && ratio.value === 0.9 && ratio.at === refreshedAt, 'end-to-end: scrape_success_ratio sampled through the wire', ratio);
    const notify = rowById(fetched.stackSamples.rows, 'notification_errors');
    assert(notify.product === 'victoriametrics' && notify.value === 0,
           'end-to-end: victoriametrics seen via vm_app_version → its notification alias is preferred', notify);
    assert(rowById(fetched.stackSamples.rows, 'wal_corruptions').outcome === 'not-in-inventory',
           'end-to-end: the metric_names inventory gates eligibility', rowById(fetched.stackSamples.rows, 'wal_corruptions'));
    assert(fetched.alertmanagerObserved.version === SYN('alertmanager_status.json').version && fetched.grafanaObserved.datasources.length === 3,
           'end-to-end: Alertmanager and Grafana status surfaces observed', [fetched.alertmanagerObserved?.version, fetched.grafanaObserved?.datasources?.length]);
    const unmatched = fetched.unmatchedTools.map(t => t.name);
    assert(!unmatched.includes('metrics_query') && !unmatched.includes('alertmanager_status') && !unmatched.includes('grafana_contact_points'),
           'answered step-2 tools are wired (not in unmatchedTools)', unmatched);
    // The fetcher's own clock: when the fetch began and when each answering
    // family was observed — independent of the caller's refreshedAt (here a
    // fixed date years back), so a slow fetch never ages the observations.
    const started = Date.parse(fetched.fetchStartedAt);
    assert(Number.isFinite(started) && started > Date.parse(refreshedAt) && started <= Date.now(),
           'fetchMcp returns fetchStartedAt as an ISO instant from its own clock, not the caller\'s refreshedAt', fetched.fetchStartedAt);
    assert(Object.keys(fetched.observedAt).join() === 'metric_names' && Date.parse(fetched.observedAt.metric_names) >= started,
           'observedAt carries one instant per family that answered (metric_names here; the unsupported families none), at or after fetchStartedAt', fetched.observedAt);
    const pack = buildCanonicalPack({ refreshedAt, mcpUrl: fake.url, ...fetched });
    const ann = pack.metadata.annotations;
    assert(ann['mcp.fetchStartedAt'] === fetched.fetchStartedAt && ann['mcp.observedAt.metric_names'] === fetched.observedAt.metric_names
             && ann['mcp.refreshedAt'] === refreshedAt && !Object.keys(ann).some(k => k.startsWith('mcp.observedAt.') && k !== 'mcp.observedAt.metric_names'),
           'buildCanonicalPack writes mcp.fetchStartedAt and mcp.observedAt.<family> for answered families only, beside the caller\'s mcp.refreshedAt',
           Object.keys(ann).filter(k => /fetchStartedAt|observedAt|refreshedAt/.test(k)));
    assert(ann['mcp.stack.status'] === 'sampled' && Number(ann['mcp.stack.sampled']) >= 2, 'end-to-end: mcp.stack.* written from the wire', [ann['mcp.stack.status'], ann['mcp.stack.sampled']]);
    assert(validateCanonical(pack, SCHEMA).length === 0, 'end-to-end pack validates');
    assert(Object.keys(ann).every(k => !k.startsWith('mcp.verified.') || !/stack|alertmanager|grafana\.(datasources|contact)/.test(k)),
           'no Verified stamp names a stack / Alertmanager / Grafana surface');
  } finally {
    await fake.close();
  }

  // Restricted tier on the wire: tools/list without metrics_query.
  const fakeR = await withFakeMcp((name) => {
    if (name === 'system_health') return { services: [] };
    if (name === 'system_topology') return { dependencies: [] };
    return {};
  }, ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines']);
  try {
    const fetched = await fetchMcp({ mcpUrl: fakeR.url, refreshedAt });
    assert(fetched.stackSamples.status === 'not-attempted' && fetched.stackSamples.callsMade === 0,
           'restricted tier on the wire → not-attempted, zero calls', fetched.stackSamples);
    assert(fetched.alertmanagerObserved === null && fetched.grafanaObserved === null, 'restricted tier → status surfaces null');
    const ann = buildCanonicalPack({ refreshedAt, mcpUrl: fakeR.url, ...fetched }).metadata.annotations;
    assert(ann['mcp.stack.reason'] === 'metrics_query not exposed by this MCP (restricted tier)', 'restricted tier reason annotated', ann['mcp.stack.reason']);
    assert(typeof ann['mcp.fetchStartedAt'] === 'string' && !Object.keys(ann).some(k => k.startsWith('mcp.observedAt.')),
           'a tier where no probe family answers still stamps mcp.fetchStartedAt and no mcp.observedAt.* at all', Object.keys(ann).filter(k => /StartedAt|observedAt/.test(k)));
    // A caller that predates the fetcher clock (nothing passed) writes neither key.
    const legacy = buildCanonicalPack({ refreshedAt, mcpUrl: fakeR.url, health: { services: [] }, topology: { dependencies: [] } }).metadata.annotations;
    assert(legacy['mcp.fetchStartedAt'] === undefined && !Object.keys(legacy).some(k => k.startsWith('mcp.observedAt.')),
           'without fetchStartedAt / observedAt inputs neither annotation is fabricated');
  } finally {
    await fakeR.close();
  }
}

// ---------- summary ----------

report('fetcher');
