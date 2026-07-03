#!/usr/bin/env node
/**
 * tools/test-adapt.mjs
 *
 * Adapter regression test. Loads the vendored canonical example, runs the
 * adapter for each declared environment, and asserts layer counts, key
 * artefacts, source-tag derivation, environment overlay, and cross-reference
 * resolution.
 *
 * Exit 0 = all assertions pass. Exit 1 = at least one assertion failed.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt, listEnvironments } from './lib/adapter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(
  __dirname, '..',
  'vendor', 'observability-pack-spec', 'v1.2',
  'examples', 'payment-service.pack.yaml',
);

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const text = readFileSync(FIXTURE, 'utf8');
const canonical = parseYaml(text);
const envs = listEnvironments(canonical);

assert(envs.length === 2, 'lists both environments', envs.length, 2);
assert(envs[0] === 'prod', 'prod is first env (default)', envs[0], 'prod');

// ---------- default-environment adapter pass ----------

const prod = adapt(canonical);

assert(prod.meta.apiVersion === 'observability.platform/v1', 'meta.apiVersion');
assert(prod.meta.kind === 'ObservabilityPack',               'meta.kind');
assert(prod.meta.binding === 'otel-elastic-prometheus-grafana', 'meta.binding');
assert(prod.meta.version === '1.5.0',                        'meta.version');
assert(prod.meta.environment === 'prod',                     'default env = prod');
assert(prod.meta.target === 'ske',                           'prod target');
assert(prod.meta.criticality === 'tier-1',                   'prod criticality');
assert(prod.badge === 'TIER-1',                              'badge derived from criticality');

// Layer counts (each section of the canonical example contributes a known number)
assert(prod.layers.L1.length === 10,           'L1 = 5 SLIs + 5 SLOs', prod.layers.L1.length, 10);
assert(prod.layers.L2.length === 24,           'L2 = 1 otel + 9 backends + 8 pipelines + 3 exporters + 3 storage', prod.layers.L2.length, 24);
assert(prod.layers.L2X.length === 7,           'L2X = profiling + network + policy_engine + 2 mesh + 2 collection', prod.layers.L2X.length, 7);
assert(prod.layers.L3.length === 14,           'L3 = 4 recording + 2 derived + 4 dashboards + 4 panels (expand)', prod.layers.L3.length, 14);
assert(prod.layers.L4.policy.length === 6,    'L4.policy = 4 burn-rate + 2 forecasts', prod.layers.L4.policy.length, 6);
assert(prod.layers.L4.alerting.length === 3,  'L4.alerting = SEV1/SEV2/SEV3 routes', prod.layers.L4.alerting.length, 3);
assert(prod.layers.L4.healing.length === 3,   'L4.healing = 3 remediations', prod.layers.L4.healing.length, 3);
assert(prod.layers.L5.length === 6,           'L5 = 1 baseline + 3 chaos + 2 synthetic', prod.layers.L5.length, 6);
assert(prod.layers.GOV.length === 3,          'GOV = 3 imports', prod.layers.GOV.length, 3);

// SLI/SLO shape
const sli = prod.layers.L1.find(a => a.title === 'api_availability');
assert(sli && sli.defines === 'slis.api_availability', 'SLI defines slis.<id>', sli && sli.defines, 'slis.api_availability');
assert(sli && sli.id === 'SLI-01',                     'SLI id pattern',         sli && sli.id, 'SLI-01');
assert(sli && sli.source === 'Declared',               'SLI source = Declared',  sli && sli.source, 'Declared');

const slo = prod.layers.L1.find(a => a.title === 'api_availability_99_9');
assert(slo && slo.defines === 'slos.api_availability_99_9',
       'SLO defines slos.<id>', slo && slo.defines, 'slos.api_availability_99_9');
assert(slo && slo.refs?.[0] === 'slis.api_availability',
       'SLO refs the SLI', slo && slo.refs?.[0], 'slis.api_availability');

// Backend shape — gating tags + defines
const bak = prod.layers.L2.find(a => a.title === 'metrics-prom');
assert(bak?.defines === 'telemetry.backends.metrics-prom', 'backend defines',  bak?.defines, 'telemetry.backends.metrics-prom');
assert(bak?.tags.includes('metrics'),                      'backend signal tag');
assert(bak?.tags.includes('gating-warn'),                  'backend gating tag from VersionSpec');
assert(bak?.tags.includes('default'),                      'default backend tag');

// L2X — extended surfaces present
const prof = prod.layers.L2X.find(a => a.id === 'PROF-01');
assert(prof?.refs?.[0] === 'telemetry.backends.profiles-pyroscope', 'profiling refs its backend');
const meshKong = prod.layers.L2X.find(a => a.title === 'gateway: kong');
assert(!!meshKong, 'kong mesh artefact present');

// Dashboard cross-refs
const dash = prod.layers.L3.find(a => a.title === 'payment-overview');
assert(dash?.refs?.includes('slis.api_availability'),    'dashboard panel binding ref to SLI');
assert(dash?.refs?.includes('slos.api_availability_99_9'),'dashboard panel binding ref to SLO');

// Chaos cross-refs
const chaos = prod.layers.L5.find(a => a.title === 'api-pod-kill');
assert(chaos?.refs?.includes('ref:slos.api_availability_99_9'), 'chaos steady-state-hypothesis ref kept verbatim');
assert(chaos?.refs?.includes('alert:payment-api-pod-down'),     'chaos expected_alerts ref normalized');

// Remediation refs (trigger preserved)
const heal = prod.layers.L4.healing.find(a => a.title === 'alert:payment-api-pod-oom');
assert(!!heal, 'remediation HEAL artefact present');

// ---------- staging-environment adapter pass: overlay verification ----------

const stg = adapt(canonical, { environment: 'staging' });
assert(stg.meta.environment === 'staging',   'env=staging selected');
assert(stg.meta.target === 'bare-k8s',       'staging target overridden');
assert(stg.meta.criticality === 'tier-2',    'staging criticality overridden');

const stgOtel = stg.layers.L2.find(a => a.id === 'OTEL-01').spec;
const prodOtel = prod.layers.L2.find(a => a.id === 'OTEL-01').spec;
assert(prodOtel.sdk.sampling.ratio === 0.1,  'prod sampling.ratio 0.1');
assert(stgOtel.sdk.sampling.ratio === 1,     'staging sampling.ratio overridden to 1.0');

// Override should NOT bleed across env passes (adapter does deep-clone per call)
const prod2 = adapt(canonical);
assert(prod2.layers.L2.find(a => a.id === 'OTEL-01').spec.sdk.sampling.ratio === 0.1,
       'prod sampling unchanged after a staging call (no shared mutable spec)');

// ---------- requirement traceability pass ----------

const traceFixture = {
  apiVersion: 'observability.platform/v1',
  kind: 'ObservabilityPack',
  metadata: {
    name: 'trace-fixture',
    version: '0.1.0',
    binding: 'otel-prometheus-grafana',
    annotations: {
      'crawler.discovered.metric_names': '["checkout_latency_seconds_bucket","checkout_latency_seconds_count"]',
      'crawler.discovered.metric_names_count': '2',
      'crawler.discovered.metric_origins': '{"checkout_latency_seconds_bucket":{"file":"src/metrics.ts","service":"checkout-api","type":"histogram","help":"checkout latency","labels":["route"]},"checkout_latency_seconds_count":{"file":"src/metrics.ts","service":"checkout-api","type":"histogram","help":"checkout latency","labels":["route"]}}',
      'crawler.discovered.scrape_jobs': '["checkout-api"]',
      'crawler.discovered.scrape_jobs_count': '1',
      'crawler.discovered.scrape_job_origins': '{"checkout-api":{"file":"prometheus/scrape.yml","metrics_path":"/metrics","interval":"10s","targets":["checkout-api:8080"]}}',
      'mcp.discovered.scrape_jobs': 'checkout-api,node-exporter',
      'mcp.discovered.metric_names': '2712',
      'mcp.discovered.metric_names_count': '2712',
      'mcp.discovered.metric_names_sample': 'checkout_latency_seconds_bucket,checkout_latency_seconds_count,process_cpu_seconds_total',
      'mcp.discovered.alert_rule_names': 'CheckoutLatencyBudgetBurn,NodeDown',
      'mcp.refreshedAt': '2026-06-09T00:00:00.000Z',
    },
  },
  spec: {
    slis: [{
      id: 'slo_checkout_latency',
      type: 'ratio',
      good: 'sum(rate(checkout_latency_seconds_bucket{le="2"}[5m]))',
      total: 'sum(rate(checkout_latency_seconds_count[5m]))',
    }],
    slos: [{
      id: 'slo_checkout_latency_99',
      sli: 'slo_checkout_latency',
      objective: 0.99,
      window: '30d',
    }],
    pipelines: {
      exporters: {
        metrics: { kind: 'prometheusremotewrite' },
      },
    },
    queries: {
      recording_rules: [{
        name: 'slo:checkout_latency:ratio_below_2s_5m',
        expr: 'sum(rate(checkout_latency_seconds_bucket{le="2"}[5m])) / sum(rate(checkout_latency_seconds_count[5m]))',
      }],
    },
    dashboards: [{
      id: 'checkout-slo',
      provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 },
      params: {
        panels: [{
          title: 'Checkout latency SLO',
          targets: [{ expr: 'slo:checkout_latency:ratio_below_2s_5m' }],
        }],
      },
      panel_bindings: [{
        panel: 'Checkout latency SLO',
        binds_to: 'slis.slo_checkout_latency',
      }],
    }],
    policy: {
      burn_rate_alerts: [{
        slo: 'slo_checkout_latency_99',
        windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }],
      }],
    },
  },
};

const traced = adapt(traceFixture);
const sourceMetric = traced.layers.L2.find(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'checkout_latency_seconds_bucket');
const sourceScrape = traced.layers.L2.find(a => a.id.startsWith('SCRAPE-SRC-') && a.spec.job === 'checkout-api');
const scrape = traced.layers.L2.find(a => a.id === 'SCRAPE-01');
const metricInventory = traced.layers.L2.filter(a => (a.id || '').startsWith('METRIC-') && !(a.id || '').startsWith('METRIC-SRC-'));
assert(sourceMetric?.spec?.origin_file === 'src/metrics.ts',
       'L2 projects source metric origin from crawler annotations',
       sourceMetric?.spec?.origin_file, 'src/metrics.ts');
assert(sourceScrape?.spec?.origin_file === 'prometheus/scrape.yml',
       'L2 projects source scrape origin from crawler annotations',
       sourceScrape?.spec?.origin_file, 'prometheus/scrape.yml');
assert(sourceScrape?.spec?.exports?.includes('checkout_latency_seconds_bucket'),
       'source telemetry source lists exported metric series',
       sourceScrape?.spec?.exports, ['checkout_latency_seconds_bucket']);
assert(scrape?.spec?.job === 'checkout-api', 'L2 projects live scrape jobs from annotations', scrape?.spec?.job, 'checkout-api');
assert(metricInventory.length === 3,
       'legacy count-shaped metric_names falls back to metric_names_sample',
       metricInventory.length, 3);
assert(metricInventory[0]?._meta?.totalCount === 2712,
       'metric inventory preserves discovered total count',
       metricInventory[0]?._meta?.totalCount, 2712);
assert(traced.traceability?.summary?.requirements === 1, 'traceability summary counts one requirement',
       traced.traceability?.summary?.requirements, 1);
const chain = traced.traceability?.chains?.[0];
assert(chain?.slo?.id === 'slo_checkout_latency_99', 'traceability chain binds SLO',
       chain?.slo?.id, 'slo_checkout_latency_99');
assert(chain?.sli?.id === 'slo_checkout_latency', 'traceability chain binds SLI',
       chain?.sli?.id, 'slo_checkout_latency');
assert(chain?.metrics?.some(m => m.name === 'checkout_latency_seconds_bucket' && m.verified),
       'traceability extracts and verifies SLI metric');
assert(chain?.metrics?.some(m => m.name === 'checkout_latency_seconds_bucket' && m.declared && m.origin?.file === 'src/metrics.ts'),
       'traceability preserves declared metric origin separately from live verification');
assert(chain?.recordingRules?.some(r => r.name === 'slo:checkout_latency:ratio_below_2s_5m'),
       'traceability links recording rule');
assert(chain?.exporters?.some(e => e.id === 'PIP-EXP-MET'),
       'traceability links metrics exporter');
assert(chain?.scrapeJobs?.items?.some(j => j.name === 'checkout-api'),
       'traceability links matching scrape job');
assert(chain?.dashboards?.some(d => d.id === 'checkout-slo' && d.panels?.some(p => p.title === 'Checkout latency SLO')),
       'traceability links dashboard panel by binding/query');
assert(chain?.alerts?.some(a => a.name === 'CheckoutLatencyBudgetBurn'),
       'traceability links live alert rule by requirement tokens');
assert(chain?.gaps?.length === 0, 'traceability chain is complete', chain?.gaps, []);

const fullMetricFixture = clone(traceFixture);
fullMetricFixture.metadata.annotations['mcp.discovered.metric_names'] =
  '["checkout_latency_seconds_bucket","checkout_latency_seconds_count","process_cpu_seconds_total"]';
fullMetricFixture.metadata.annotations['mcp.discovered.metric_names_count'] = '3';
fullMetricFixture.metadata.annotations['mcp.discovered.metric_names_sample'] = '';
const fullMetricTraced = adapt(fullMetricFixture);
assert(fullMetricTraced.layers.L2.filter(a => (a.id || '').startsWith('METRIC-') && !(a.id || '').startsWith('METRIC-SRC-')).length === 3,
       'metric_names JSON array projects full metric inventory');
assert(fullMetricTraced.traceability?.chains?.[0]?.metrics?.some(m => m.name === 'checkout_latency_seconds_bucket' && m.verified),
       'traceability verifies metrics from full metric_names annotation');

const declaredOnlyMetricFixture = clone(traceFixture);
delete declaredOnlyMetricFixture.metadata.annotations['mcp.discovered.metric_names'];
delete declaredOnlyMetricFixture.metadata.annotations['mcp.discovered.metric_names_count'];
delete declaredOnlyMetricFixture.metadata.annotations['mcp.discovered.metric_names_sample'];
const declaredOnlyMetricTraced = adapt(declaredOnlyMetricFixture);
const declaredOnlyMetric = declaredOnlyMetricTraced.traceability?.chains?.[0]?.metrics?.find(m => m.name === 'checkout_latency_seconds_bucket');
assert(declaredOnlyMetric?.declared === true && declaredOnlyMetric?.verified === false,
       'crawler-declared metric does not count as live-verified without MCP inventory',
       { declared: declaredOnlyMetric?.declared, verified: declaredOnlyMetric?.verified },
       { declared: true, verified: false });

// ---------- rebrand shim: legacy annotation namespace ----------
// Packs crawled before the Observogram rename carry tomograph.* annotation
// keys; the adapter must keep honoring them (new key wins when both exist).
const legacyScopeFixture = clone(canonical);
legacyScopeFixture.metadata.annotations = {
  ...(legacyScopeFixture.metadata.annotations || {}),
  'tomograph.diff.scopeMode': 'family',
};
assert(adapt(legacyScopeFixture).meta.diffScopeMode === 'family',
       'legacy tomograph.diff.scopeMode annotation still resolves', adapt(legacyScopeFixture).meta.diffScopeMode, 'family');
legacyScopeFixture.metadata.annotations['observogram.diff.scopeMode'] = 'service';
assert(adapt(legacyScopeFixture).meta.diffScopeMode === 'service',
       'observogram.diff.scopeMode wins over the legacy key when both exist', adapt(legacyScopeFixture).meta.diffScopeMode, 'service');

// ---------- summary ----------

report('adapter');
