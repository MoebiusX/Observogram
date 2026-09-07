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

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { buildCanonicalPack, fetchMcp, PROBES } from './fetch-live-pack.mjs';

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

// verified markers (flat keys)
assert(typeof a['mcp.verified.otel'] === 'string', 'otel verified');
assert(typeof a['mcp.verified.slis.svc_checkout_availability'] === 'string', 'per-service SLI verified');
assert(typeof a['mcp.verified.telemetry.backends.metrics-prom'] === 'string', 'metrics-prom backend verified');
assert(typeof a['mcp.verified.telemetry.backends.traces-jaeger'] === 'string', 'jaeger backend verified (topology shows it)');
assert(typeof a['mcp.verified.baselines'] === 'string', 'baselines verified');

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

// baselines reflect MCP minimum-threshold
assert(rich.spec.baselines.mttd_target_p50 === '90ms', 'mttd_target_p50 derived from smallest baseline threshold',
       rich.spec.baselines.mttd_target_p50, '90ms');
assert(rich.spec.baselines.measurement_source === 'mcp.anomalies_baselines', 'baselines.measurement_source');

// adapter sees the Verified tags
const layered = adapt(rich);
const verifiedSli = layered.layers.L1.find(x => x.id === 'SLI-01');
assert(verifiedSli?.source === 'Verified', 'adapter surfaces Verified source for fetched SLI',
       verifiedSli?.source, 'Verified');
const verifiedBackend = layered.layers.L2.find(x => x.title === 'metrics-prom');
assert(verifiedBackend?.source === 'Verified', 'adapter surfaces Verified source for fetched backend');
const scaffoldBurn = layered.layers.L4.policy.find(x => x.id === 'POL-01');
assert(scaffoldBurn?.source === 'Scaffold', 'adapter projects the mcp.scaffold burn-rate placeholder as Scaffold',
       scaffoldBurn?.source, 'Scaffold');

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
        { name: 'svc_checkout:availability:ratio_5m', expr: 'svc_checkout:availability:good_5m / svc_checkout:availability:total_5m', interval: '30s' },
        { name: 'svc_checkout:latency_p95:value_5m',  expr: 'histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))', interval: '30s' },
      ],
    },
    alert_rules: {
      tool: 'list_alert_rules',
      adapted: [{ name: 'CheckoutHighErrorRate', expr: 'svc_checkout:availability:ratio_5m < 0.99', for: '5m', labels: {}, annotations: {} }],
    },
    dashboards: {
      tool: 'grafana_search',
      adapted: [
        { id: 'checkout-overview', provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 }, folder: 'checkout', source: 'grafana://uid/checkout-overview' },
        { id: 'platform-health',   provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 }, folder: 'platform', source: 'grafana://uid/platform-health' },
      ],
    },
    scrape_configs: { tool: 'list_scrape_configs', adapted: ['checkout', 'platform', 'collector'] },
    metric_names:   { tool: 'list_metrics',         adapted: ['http_requests_total', 'http_request_duration_ms_bucket', 'queue_depth'] },
  },
  errors: {},
});

{
  const errors = validateCanonical(probed, SCHEMA);
  assert(errors.length === 0, 'probed pack validates against canonical schema', errors, []);
}

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

// dashboards: discovered ones replace the platform-overview stub.
const dashIds = probed.spec.dashboards.map(d => d.id);
assert(dashIds.includes('checkout-overview') && dashIds.includes('platform-health'),
       'dashboards section carries discovered dashboards');
assert(!dashIds.includes('platform-overview'),
       'dashboards section does NOT include the stub when probe responded');

// alert rule names surface as annotation (we can't reshape multi-window from a flat alert).
assert(probed.metadata.annotations['mcp.discovered.alert_rule_names']?.includes('CheckoutHighErrorRate'),
       'discovered alert rule names annotated');

// scrape jobs + metric inventory surfaced as annotations.
assert(probed.metadata.annotations['mcp.discovered.scrape_jobs'] === 'checkout,platform,collector',
       'scrape jobs annotated');
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

// A plain threshold alert is NOT a burn-rate alert: nothing maps, the
// schema-forced placeholder stands in and is stamped scaffold, and no
// mcp.verified.policy.* key is written on the strength of a NAME.
assert(probed.spec.policy.burn_rate_alerts.length === 1
       && typeof probed.metadata.annotations['mcp.scaffold.policy.burn_rate_alerts[0]'] === 'string',
       'threshold alert alone → scaffold placeholder, not a Verified burn-rate alert');
assert(probed.metadata.annotations['mcp.verified.policy.burn_rate_alerts'] === undefined
       && probed.metadata.annotations['mcp.verified.policy.burn_rate_alerts[0]'] === undefined,
       'no burn-rate verification stamp on the strength of a discovered alert NAME');

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

async function withFakeMcp(handler) {
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
      send({
        tools: [
          'system_health',
          'system_topology',
          'anomalies_active',
          'anomalies_baselines',
          'grafana_dashboards_search',
          'grafana_dashboard_get',
        ].map(name => ({ name })),
      });
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

// ---------- summary ----------

report('fetcher');
