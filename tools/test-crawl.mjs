#!/usr/bin/env node
// ============================================================
// test-crawl.mjs — fixture-driven crawler test.
//
// Builds a synthetic file map representing a service repo, runs
// the crawler, then validates the resulting canonical pack
// against the spec v1.2 schema. Asserts the end-to-end loop
// works: crawler output is a valid pack.
// ============================================================

import { crawlFiles, detectArtefactKind, crawlToYaml } from './lib/crawler.mjs';
import { validateCanonical } from './lib/validator.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { readFileSync } from 'node:fs';
import { adapt } from './lib/adapter.mjs';
import { evaluateConformance } from './lib/conformance.mjs';
import { diffPacks } from './lib/diff.mjs';

const SCHEMA_PATH = new URL('../vendor/observability-pack-spec/v1.2/observability-pack.schema.json', import.meta.url);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

import { createHarness } from './lib/harness.mjs';
const { assert, failures, report } = createHarness();

// ---------- synthetic fixture ----------
const FIXTURE = {
  'docker-compose.yml': `version: '3.8'
services:
  prometheus:
    image: prom/prometheus:v2.51.0
    ports: ["9090:9090"]
  init-helper:
    image: busybox:1.36
    command: >
      echo preparing observability stack
      && echo ready
  grafana:
    image: grafana/grafana:12.0.0
    ports: ["3000:3000"]
  loki:
    image: grafana/loki:3.0.0
    ports: ["3100:3100"]
  tempo:
    image: grafana/tempo:2.4.0
    ports: ["3200:3200"]
  alertmanager:
    image: prom/alertmanager:v0.27.0
    ports: ["9093:9093"]
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.96.0
    ports: ["4318:4318"]
  pyroscope:
    image: grafana/pyroscope:1.7.0
    ports: ["4040:4040"]
  cilium:
    image: quay.io/cilium/cilium:v1.15.0
  opa:
    image: openpolicyagent/opa:0.63.0
    ports: ["8181:8181"]
  envoy:
    image: envoyproxy/envoy:v1.31.0
    ports: ["9901:9901"]
  kong:
    image: kong:3.6
    ports: ["8001:8001"]
  vector:
    image: timberio/vector:0.36.0
    ports: ["8686:8686"]
`,
  'prometheus/rules/sli.yml': `groups:
  - name: payments_slis
    interval: 30s
    rules:
      - record: payments:api_availability:ratio_5m
        expr: sum(rate(http_requests_total{status_code!~"5..",service="payments"}[5m])) / sum(rate(http_requests_total{service="payments"}[5m]))
      - record: payments:api_latency_p95:ms
        expr: histogram_quantile(0.95, rate(http_request_duration_ms_bucket{service="payments"}[5m]))
`,
  'prometheus/rules/alerts.yml': `groups:
  - name: payments_burn
    rules:
      - alert: payments_api_availability_99_burn
        expr: payments:api_availability:ratio_5m < 0.99
        for: 5m
        labels:
          severity: SEV1
      - alert: payments_api_availability_99_slow_burn
        expr: payments:api_availability:ratio_5m < 0.999
        for: 30m
        labels:
          severity: SEV2
`,
  // Note: leading scalar key in each compact sequence item — mini-yaml
  // requires that, so we put `receiver:` first.
  'alertmanager.yml': `route:
  receiver: oncall
  routes:
    - receiver: pager
      match:
        severity: SEV1
    - receiver: teams
      match:
        severity: SEV2
receivers:
  - name: oncall
    msteams_configs:
      - channel_url: '#payments-oncall'
  - name: pager
    pagerduty_configs:
      - service_key: REDACTED
  - name: teams
    msteams_configs:
      - channel_url: '#payments-channel'
`,
  'config/otel-collector.yaml': `receivers:
  otlp:
    protocols:
      http: {}
      grpc: {}
processors:
  batch: {}
  memory_limiter: {}
exporters:
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch, memory_limiter]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [loki]
`,
  'dashboards/payments-overview.json': JSON.stringify({
    title: 'Payments Overview',
    uid: 'payments-overview',
    schemaVersion: 41,
    version: 3,
    tags: ['payments'],
    panels: [
      { title: 'Availability', type: 'stat', targets: [{ expr: 'payments:api_availability:ratio_5m' }] },
      { title: 'p95 latency', type: 'timeseries' },
    ],
  }),
  'README.md': '# payments service — should be ignored',
  'src/index.go': '// should be ignored',
};

const METRIC_SOURCE = `import { Counter, Histogram } from 'prom-client';
export const checkoutLatency = new Histogram({
  name: 'checkout_latency_seconds',
  help: 'Checkout latency',
  labelNames: ['route'],
});
export const checkoutErrors = new Counter({
  name: 'checkout_errors_total',
  help: 'Checkout errors',
});
`;

const SCRAPE_CONFIG = `global:
  scrape_interval: 15s
scrape_configs:
  - job_name: checkout-api
    static_configs:
      - targets: ['checkout-api:8080']
    metrics_path: /metrics
    scrape_interval: 10s
`;

const ACTUATOR_CONFIG = `spring:
  application:
    name: settlement-service
management:
  endpoints:
    web:
      exposure:
        include: health,prometheus
  endpoint:
    prometheus:
      enabled: true
`;

const JAVA_MICROMETER_SOURCE = `import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;

class SettlementMetrics {
  SettlementMetrics(MeterRegistry meterRegistry) {
    Counter.builder("settlement.latency.violations")
      .description("Settlement latency violations")
      .tag("flow", "settlement")
      .register(meterRegistry);
    meterRegistry.counter("settlement.executions.total");
  }
}
`;

const JAVA_STATIC_EXPORTER_SOURCE = `class SolaceExporter {
  void register(java.util.Map<String, String> map) {
    map.put("java_exported_metric_total", "used by a rule");
    map.put("unused_exporter_metric_total", "candidate only");
  }
}
`;

const TS_OTEL_SOURCE = `import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('checkout');
export const checkoutOtelLatency = meter.createHistogram('checkout.otel.latency.seconds', {
  description: 'Checkout latency reported through OTel JS',
});

const METRIC_NAMES = [
  'ts_exported_metric_total',
  'unused_ts_metric_total',
];
const metricName = 'ts_single_metric_total';
`;

const GO_PROM_SOURCE = `package exporter

import (
  "github.com/prometheus/client_golang/prometheus"
  "github.com/prometheus/client_golang/prometheus/promauto"
)

var jobs = promauto.NewCounterVec(prometheus.CounterOpts{
  Namespace: "checkout",
  Subsystem: "worker",
  Name: "jobs_total",
  Help: "Worker jobs processed",
}, []string{"status"})

var retries = promauto.With(prometheus.DefaultRegisterer).NewCounter(prometheus.CounterOpts{
  Namespace: "checkout",
  Subsystem: "worker",
  Name: "retries_total",
  Help: "Worker retries",
})
`;

const GO_OTEL_SOURCE = `package exporter

import "go.opentelemetry.io/otel/metric"

func register(meter metric.Meter) {
  _, _ = meter.Int64Counter("worker.jobs.total", metric.WithDescription("Worker jobs processed through OTel Go"))
}
`;

// ---------- detection ----------
process.stdout.write('\n--- detection ---\n');
assert(detectArtefactKind('docker-compose.yml',         FIXTURE['docker-compose.yml'])         === 'docker-compose',    'docker-compose detected');
assert(detectArtefactKind('prometheus/rules/sli.yml',   FIXTURE['prometheus/rules/sli.yml'])   === 'prometheus-rules',  'prometheus rules detected');
assert(detectArtefactKind('prometheus/rules/alerts.yml',FIXTURE['prometheus/rules/alerts.yml'])=== 'prometheus-rules',  'prometheus alerts detected');
assert(detectArtefactKind('alertmanager.yml',           FIXTURE['alertmanager.yml'])           === 'alertmanager',      'alertmanager detected');
assert(detectArtefactKind('config/otel-collector.yaml', FIXTURE['config/otel-collector.yaml']) === 'otel-collector',    'otel-collector detected');
assert(detectArtefactKind('dashboards/payments-overview.json', FIXTURE['dashboards/payments-overview.json']) === 'grafana-dashboard', 'grafana-dashboard detected');
assert(detectArtefactKind('src/metrics.ts', METRIC_SOURCE) === 'metric-source-code', 'metric source code detected');
assert(detectArtefactKind('src/otel-metrics.ts', TS_OTEL_SOURCE) === 'metric-source-code', 'TypeScript OTel metric source detected');
assert(detectArtefactKind('cmd/exporter/prometheus.go', GO_PROM_SOURCE) === 'metric-source-code', 'Go Prometheus metric source detected');
assert(detectArtefactKind('cmd/exporter/otel.go', GO_OTEL_SOURCE) === 'metric-source-code', 'Go OTel metric source detected');
assert(detectArtefactKind('src/main/java/SettlementMetrics.java', JAVA_MICROMETER_SOURCE) === 'metric-source-code', 'Micrometer source code detected');
assert(detectArtefactKind('metrics-exporter/src/main/java/SolaceExporter.java', JAVA_STATIC_EXPORTER_SOURCE) === 'metric-source-code', 'Java static exporter metric fragments detected');
assert(detectArtefactKind('prometheus/scrape.yml', SCRAPE_CONFIG) === 'prometheus-scrape-config', 'Prometheus scrape config detected');
assert(detectArtefactKind('src/main/resources/application.yml', ACTUATOR_CONFIG) === 'actuator-metrics-config', 'Spring actuator metrics config detected');
assert(detectArtefactKind('README.md',                  FIXTURE['README.md'])                  === 'unknown',           'markdown not classified');
assert(detectArtefactKind('src/index.go',               FIXTURE['src/index.go'])               === 'unknown',           'source code not classified');

// ---------- crawl ----------
process.stdout.write('\n--- crawl ---\n');
const { canonical, summary, evidence } = crawlFiles(FIXTURE, {
  repoName: 'payments',
  environment: 'prod',
  now: '2026-06-05T00:00:00.000Z',
});

assert(canonical.apiVersion === 'observability.platform/v1', 'apiVersion is v1');
assert(canonical.kind === 'ObservabilityPack',                 'kind is ObservabilityPack');
assert(canonical.metadata.name === 'payments',                 'metadata.name = repo name');
assert(canonical.metadata.annotations['observogram.diff.scopeMode'] === 'service',
       'crawler annotates default live-drift scope mode');
assert(canonical.metadata.bindings.criticality === 'tier-2',
  `tier-2 inferred from rules+dashboards+alerting (got ${canonical.metadata.bindings.criticality}; discovered ${JSON.stringify(summary.discovered)})`);
assert(summary.comparison?.diffScopeMode === 'service',
       'crawler summary reports default live-drift scope mode');
assert(summary.warnings.every(w => !/Failed to parse docker-compose\.yml/.test(w)),
       'docker-compose folded command block does not abort backend extraction');

const backends = canonical.spec.telemetry?.backends || [];
assert(backends.length >= 5, `discovered ≥5 backends (got ${backends.length})`);
assert(backends.some(b => b.product === 'prometheus'),  'prometheus backend discovered');
assert(backends.some(b => b.product === 'grafana'),     'grafana backend discovered');
assert(backends.some(b => b.product === 'loki'),        'loki backend discovered');
assert(backends.some(b => b.product === 'tempo'),       'tempo backend discovered');
assert(backends.some(b => b.product === 'alertmanager'),'alertmanager backend discovered');
assert(backends.some(b => b.product === 'pyroscope'),   'pyroscope backend discovered');
assert(backends.some(b => b.product === 'cilium'),      'cilium backend discovered');
assert(backends.some(b => b.product === 'opa'),         'opa backend discovered');
assert(backends.some(b => b.product === 'envoy'),       'envoy backend discovered');
assert(backends.some(b => b.product === 'kong'),        'kong backend discovered');
assert(backends.some(b => b.product === 'vector'),      'vector backend discovered');
assert(summary.discovered.extendedSurfaces >= 6,
       `L2X extended surfaces materialised (got ${summary.discovered.extendedSurfaces})`);

assert(canonical.spec.profiling?.backend === 'profiles-pyroscope', 'profiling surface references pyroscope backend');
assert(canonical.spec.network?.backend === 'network-cilium',       'network surface references cilium backend');
assert(canonical.spec.policy_engine?.backend === 'policy-opa',     'policy engine surface references opa backend');
assert(canonical.spec.mesh?.some(m => m.product === 'envoy' && m.role === 'proxy'),
       'mesh surface materialises envoy proxy');
assert(canonical.spec.mesh?.some(m => m.product === 'kong' && m.role === 'gateway'),
       'mesh surface materialises kong gateway');
assert(canonical.spec.collection?.some(c => c.product === 'vector' && c.role === 'aggregator'),
       'collection surface materialises vector aggregator');

const rules = canonical.spec.queries.recording_rules;
assert(rules.length >= 2, `recording rules discovered (got ${rules.length})`);
assert(rules.some(r => r.name === 'payments:api_availability:ratio_5m'),  'availability ratio rule preserved');
assert(rules.some(r => r.name === 'payments:api_latency_p95:ms'),         'p95 latency rule preserved');
assert(!rules.some(r => String(r.expr || '').startsWith('ref:slis.')),
       'source-less synthetic recording rules are not emitted');
assert((summary.omitted?.syntheticRecordingRules || []).length >= 1,
       'source-less synthetic recording rule candidates are reported as omitted');

const alerts = canonical.spec.policy.burn_rate_alerts;
assert(alerts.length >= 1,                       'burn-rate alerts emitted');
assert(alerts.every(a => a.windows.length >= 2), 'each alert has ≥2 windows (spec minItems)');

const routes = canonical.spec.alerting.routes;
assert(routes.length >= 1,                              'alerting routes emitted');
assert(routes.some(r => r.severity === 'SEV1'),         'SEV1 route lifted from alertmanager');

const dashboards = canonical.spec.dashboards;
assert(dashboards.length >= 1, 'dashboards emitted');
assert(dashboards.some(d => d.id === 'payments-overview'), 'payments-overview dashboard discovered');
assert(dashboards.every(d => d.provider.kind === 'grafana'), 'all dashboards have grafana provider');
const paymentsDash = dashboards.find(d => d.id === 'payments-overview');
assert(paymentsDash?.params?.panels?.some(p => p.expr === 'payments:api_availability:ratio_5m'),
  'dashboard panel PromQL uses are preserved in params.panels');
assert(paymentsDash?.panel_bindings?.some(b => b.panel === 'Availability' && b.binds_to === 'slis.payments_api_availability'),
  'dashboard panel binding inferred from recording-rule query');

assert(canonical.spec.slis.length >= 1, 'SLIs emitted');
assert(canonical.spec.slos.length >= 1, 'SLOs emitted');
assert(canonical.spec.baselines.mttd_target_p50, 'baselines emitted');
assert(canonical.spec.validation.synthetic_checks.length >= 1, 'synthetic checks emitted');
assert((summary.scaffold || []).includes('baselines'), 'schema-required baselines marked as scaffold');
assert((summary.scaffold || []).some(s => s.startsWith('validation.synthetic_checks.')),
       'schema-required synthetic check marked as scaffold');

assert(Object.keys(evidence).length >= 5, `evidence map populated (${Object.keys(evidence).length} entries)`);

const familyScope = crawlFiles(FIXTURE, {
  repoName: 'payments',
  environment: 'prod',
  diffScopeMode: 'family',
  now: '2026-06-05T00:00:00.000Z',
});
assert(familyScope.canonical.metadata.annotations['observogram.diff.scopeMode'] === 'family',
       'crawler honors live-drift scope override');

// ---------- validate against spec v1.2 ----------
process.stdout.write('\n--- validate ---\n');
const validationErrors = validateCanonical(canonical, SCHEMA);
if (validationErrors.length) {
  process.stdout.write(`✗ canonical pack passes v1.2 schema — got ${validationErrors.length} errors:\n`);
  for (const e of validationErrors.slice(0, 8)) process.stdout.write(`    · ${e}\n`);
  failures.push('canonical pack passes v1.2 schema');
} else {
  process.stdout.write(`✓ canonical pack passes v1.2 schema\n`);
}

// ---------- adapt + conformance ----------
process.stdout.write('\n--- downstream ---\n');
try {
  const adapted = adapt(canonical);
  assert(adapted.layers.L1.length > 0, 'adapter populates L1 from SLIs/SLOs');
  assert(adapted.layers.L2.length > 0, 'adapter populates L2 from backends + pipelines');
  assert(adapted.layers.L2X.length >= 6, `adapter populates L2X from extended surfaces (got ${adapted.layers.L2X.length})`);
  assert(adapted.layers.L3.length > 0, 'adapter populates L3 from queries + dashboards');
  assert(adapted.layers.L5.some(a => a.source === 'Scaffold' && /^SYN-/.test(a.id)),
         'adapter surfaces scaffold source for schema-required synthetic checks');

  const conf = evaluateConformance(canonical);
  assert(typeof conf?.declaredTier === 'string',   'conformance scored (declared tier present)');
  assert(Array.isArray(conf?.clauses),             'conformance returns clauses array');
  assert(conf.clauses.some(c => c.id === 'L2X.MUST.extended_backend_refs_resolve' && c.pass === true),
         'conformance checks L2X backend references');

  const sameLive = structuredClone(canonical);
  const aligned = diffPacks(adapted, adapt(sameLive));
  assert(aligned.layers.L2X.inBoth.length >= 6 && aligned.layers.L2X.onlyInA.length === 0,
         'repo-vs-live L2X diff aligns when surfaces match');

  const missingLive = structuredClone(canonical);
  delete missingLive.spec.network;
  const drift = diffPacks(adapted, adapt(missingLive));
  assert(drift.layers.L2X.onlyInA.some(x => x.key.startsWith('network::')),
         'repo-vs-live L2X diff reports missing live network surface');
} catch (e) {
  process.stdout.write(`✗ downstream failed: ${e.message}\n`);
  failures.push(`downstream failed: ${e.message}`);
}

// ---------- yaml emission round-trip ----------
process.stdout.write('\n--- yaml ---\n');
const { yaml } = crawlToYaml(FIXTURE, { repoName: 'payments', now: '2026-06-05T00:00:00.000Z' });
assert(yaml.startsWith('# ='), 'yaml output starts with banner');
assert(/^apiVersion: observability\.platform\/v1$/m.test(yaml), 'yaml contains apiVersion');
assert(/payments-overview/.test(yaml), 'yaml contains discovered dashboard id');

const largeMetricSource = [
  "import { Counter } from 'prom-client';",
  ...Array.from({ length: 260 }, (_, i) => {
    const n = String(i).padStart(3, '0');
    return `new Counter({ name: 'large_metric_${n}_total', help: 'large metric ${n}', labelNames: ['service', 'route'] });`;
  }),
].join('\n');
const { yaml: largeYaml } = crawlToYaml(
  { 'src/metrics.ts': largeMetricSource },
  { repoName: 'large', now: '2026-06-05T00:00:00.000Z' },
);
const largeLongestLine = Math.max(...largeYaml.split(/\r?\n/).map(l => l.length));
assert(/crawler\.discovered\.metric_origins: \|/.test(largeYaml),
       'large metric-origin annotation emits as a block scalar');
assert(largeLongestLine < 65535,
       `large generated YAML avoids PowerShell 65535-char line split (longest ${largeLongestLine})`);
const largeParsed = parseYaml(largeYaml);
const largeParsedMetrics = JSON.parse(largeParsed.metadata.annotations['crawler.discovered.metric_names']);
assert(largeParsedMetrics.includes('large_metric_259_total'),
       'large metric inventory round-trips through YAML parser');

// ---------- real-world YAML shapes the parser used to choke on ----------
// These mirror what `crawl-repo` hits on production repos: multi-document
// Prometheus rule files, Alertmanager routes whose first key is a block
// (`- match:`), and Grafana unified-alerting provisioned rules.
process.stdout.write('\n--- real-world shapes ---\n');
const REAL = {
  // Multi-document Prometheus rules (note the leading `---` and `---` between docs).
  'rules/multidoc.rules.yaml': `---
groups:
  - name: latency_recording
    interval: 30s
    rules:
      - record: api:request_latency_p99:ms
        expr: histogram_quantile(0.99, sum by (le) (rate(http_request_duration_ms_bucket[5m])))
      - record: api:java_exported:rate_5m
        expr: sum(rate(java_exported_metric_total[5m]))
      - record: api:typescript_exported:rate_5m
        expr: sum(rate(ts_exported_metric_total[5m])) + sum(rate(ts_single_metric_total[5m]))
      - record: api:worker_jobs:rate_5m
        expr: sum(rate(checkout_worker_jobs_total{status="ok"}[5m])) + sum(rate(checkout_worker_retries_total[5m])) + sum(rate(worker_jobs_total[5m]))
---
groups:
  - name: availability_alerts
    rules:
      - alert: api_availability_burnrate
        expr: slo:error_ratio:5m > 0.01
        for: 5m
        labels:
          severity: critical
`,
  // Alertmanager whose route children lead with a block key (`- match:`).
  'alertmanager.config.yaml': `route:
  receiver: default
  routes:
    - match:
        severity: critical
      receiver: pagerduty
    - match:
        severity: warning
      receiver: slack
receivers:
  - name: default
  - name: pagerduty
    pagerduty_configs:
      - service_key: REDACTED
  - name: slack
    slack_configs:
      - channel: '#alerts'
`,
  'dashboards/extra.json': JSON.stringify({
    title: 'Extra Metrics',
    uid: 'extra-metrics',
    schemaVersion: 41,
    panels: [
      { id: 1, title: 'Dashboard-only metric', targets: [{ expr: 'sum(rate(dashboard_only_metric_total[5m]))' }] },
    ],
  }),
  // Grafana unified-alerting provisioned rules (no record/alert keys; uses title).
  'grafana/alerts.yaml': `apiVersion: 1
groups:
  - orgId: 1
    name: checkout_alerts
    folder: SLO
    interval: 1m
    rules:
      - uid: ce-001
        title: checkout_latency_burnrate
        condition: A
        for: 5m
        labels:
          severity: warning
`,
  'src/metrics.ts': METRIC_SOURCE,
  'src/otel-metrics.ts': TS_OTEL_SOURCE,
  'cmd/exporter/prometheus.go': GO_PROM_SOURCE,
  'cmd/exporter/otel.go': GO_OTEL_SOURCE,
  'src/main/java/SettlementMetrics.java': JAVA_MICROMETER_SOURCE,
  'metrics-exporter/src/main/java/SolaceExporter.java': JAVA_STATIC_EXPORTER_SOURCE,
  'src/main/resources/application.yml': ACTUATOR_CONFIG,
  'prometheus/scrape.yml': SCRAPE_CONFIG,
};
assert(detectArtefactKind('rules/multidoc.rules.yaml', REAL['rules/multidoc.rules.yaml']) === 'prometheus-rules', 'multi-doc rules detected');
assert(detectArtefactKind('alertmanager.config.yaml', REAL['alertmanager.config.yaml']) === 'alertmanager', 'block-first-key alertmanager detected');
const real = crawlFiles(REAL, { repoName: 'checkout', now: '2026-06-05T00:00:00.000Z' });
assert(real.summary.warnings.every(w => !/Failed to parse/.test(w)),
  `no parse failures on real-world shapes (warnings: ${JSON.stringify(real.summary.warnings.filter(w => /Failed to parse/.test(w)))})`);
assert(real.canonical.spec.queries.recording_rules.some(r => r.name === 'api:request_latency_p99:ms'),
  'recording rule lifted from multi-doc file');
assert(real.summary.discovered.burnRateAlerts >= 2,
  `burn-rate alerts lifted from both prometheus + grafana forms (got ${real.summary.discovered.burnRateAlerts})`);
assert(real.summary.discovered.alertingRoutes >= 1,
  `routes lifted past the block-first-key shape (got ${real.summary.discovered.alertingRoutes})`);
assert(real.summary.discovered.metricDefinitions >= 2,
  `source metric definitions lifted from code (got ${real.summary.discovered.metricDefinitions})`);
assert(real.summary.discovered.scrapeJobs >= 2,
  `scrape jobs lifted from Prometheus scrape config (got ${real.summary.discovered.scrapeJobs})`);
const realMetricNames = JSON.parse(real.canonical.metadata.annotations['crawler.discovered.metric_names'] || '[]');
assert(realMetricNames.includes('checkout_latency_seconds'),
  'crawler writes declared metric inventory annotation');
assert(realMetricNames.includes('checkout_otel_latency_seconds'),
  'crawler writes TypeScript OTel metric inventory annotation');
assert(realMetricNames.includes('checkout_worker_jobs_total'),
  'crawler writes Go Prometheus namespace/subsystem/name metric annotation');
assert(realMetricNames.includes('checkout_worker_retries_total'),
  'crawler writes Go promauto.With namespace/subsystem/name metric annotation');
assert(realMetricNames.includes('worker_jobs_total'),
  'crawler writes Go OTel metric inventory annotation');
assert(realMetricNames.includes('http_request_duration_ms_bucket'),
  'crawler infers source metric dependency from recording-rule PromQL');
assert(!realMetricNames.includes('le'),
  'crawler does not treat PromQL grouping labels as metric dependencies');
assert(realMetricNames.includes('dashboard_only_metric_total'),
  'crawler infers source metric dependency from dashboard PromQL');
assert(realMetricNames.includes('java_exported_metric_total'),
  'crawler keeps Java static exporter metric when PromQL references it');
assert(realMetricNames.includes('unused_exporter_metric_total'),
  'crawler preserves unreferenced Java static exporter candidates as low-confidence metrics');
assert(realMetricNames.includes('ts_exported_metric_total'),
  'crawler keeps TypeScript static exporter metric when PromQL references it');
assert(realMetricNames.includes('ts_single_metric_total'),
  'crawler keeps TypeScript metricName constant when PromQL references it');
assert(realMetricNames.includes('unused_ts_metric_total'),
  'crawler preserves unreferenced TypeScript static exporter candidates as low-confidence metrics');
assert(realMetricNames.includes('settlement_latency_violations'),
  'crawler writes normalized Micrometer metric inventory annotation');
const realMetricOrigins = JSON.parse(real.canonical.metadata.annotations['crawler.discovered.metric_origins'] || '{}');
assert(realMetricOrigins.unused_exporter_metric_total?.candidate === true,
  'unreferenced Java static exporter metric is marked candidate');
assert(realMetricOrigins.unused_ts_metric_total?.confidence === 'candidate',
  'unreferenced TypeScript static metric carries candidate confidence');
assert(real.canonical.metadata.annotations['crawler.discovered.scrape_jobs']?.includes('checkout-api'),
  'crawler writes declared scrape job annotation');
assert(real.canonical.metadata.annotations['crawler.discovered.scrape_jobs']?.includes('settlement-service'),
  'crawler writes actuator TelemetrySource scrape job annotation');
const realAdapted = adapt(real.canonical);
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'checkout_latency_seconds'),
  'adapter projects source metric definition as first-class L2 metric');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'checkout_otel_latency_seconds' && a.spec.source_name === 'checkout.otel.latency.seconds'),
  'adapter projects TypeScript OTel metric with normalized source name');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'checkout_worker_jobs_total' && a.spec.metric_type === 'go-prometheus-counter-vec'),
  'adapter projects Go Prometheus metric with namespace/subsystem/name');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'worker_jobs_total' && a.spec.source_name === 'worker.jobs.total'),
  'adapter projects Go OTel metric with normalized source name');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'dashboard_only_metric_total' && a.spec.origin_kind === 'promql-reference'),
  'adapter projects PromQL-inferred metric with reference provenance');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'java_exported_metric_total' && a.spec.origin_kind === 'source-code-fragment'),
  'adapter projects curated Java static exporter metric with source-fragment provenance');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'unused_exporter_metric_total' && a.spec.candidate === true),
  'adapter projects unreferenced Java static exporter candidate metric');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'settlement_latency_violations' && a.spec.source_name === 'settlement.latency.violations'),
  'adapter preserves source name for normalized Micrometer metrics');
assert(real.canonical.spec.dashboards.find(d => d.id === 'extra-metrics')?.params?.panels?.some(p => p.expr?.includes('dashboard_only_metric_total')),
  'crawler preserves dashboard panel query uses');
assert(realAdapted.layers.L3.some(a => a.id.startsWith('PANEL-') && a.spec.expr?.includes('dashboard_only_metric_total')),
  'adapter projects dashboard query uses as L3 panel artefacts');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('SCRAPE-SRC-') && a.spec.job === 'checkout-api'),
  'adapter projects source scrape job as first-class L2 scrape node');
assert(realAdapted.layers.L2.some(a => a.id.startsWith('SCRAPE-SRC-') && a.spec.job === 'settlement-service' && a.spec.scrape_query === '/actuator/prometheus'),
  'adapter projects Spring actuator config as TelemetrySource');
assert(validateCanonical(real.canonical, SCHEMA).length === 0, 'real-world crawl still validates against v1.2 schema');

// ---------- helm chart introspection ----------
process.stdout.write('\n--- helm chart introspection ---\n');
// A Helm template embeds Prometheus rules + a Grafana dashboard inside a
// rendered ConfigMap, wrapped in Go-template scaffolding (control flow,
// .Values injections, include calls, and the {{ "{{" }} literal-brace escape
// in an annotation). The crawler must look through the scaffolding and lift
// the embedded observability contracts exactly as if they were standalone.
const HELM = {
  'charts/checkout/Chart.yaml': [
    'apiVersion: v2',
    'name: checkout',
    'version: 1.4.2',
    '',
  ].join('\n'),
  'charts/checkout/templates/configmaps.yaml': [
    '{{- if .Values.prometheus.enabled }}',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: {{ include "checkout.fullname" . }}-rules',
    '  namespace: {{ .Release.Namespace }}',
    'data:',
    '  recording-rules.yml: |',
    '    groups:',
    '      - name: slo:checkout',
    '        interval: 30s',
    '        rules:',
    '          - record: slo:http_requests:good_5m',
    '            expr: sum(rate(http_requests_total{code!~"5.."}[5m]))',
    '          - record: slo:http_requests:total_5m',
    '            expr: sum(rate(http_requests_total[5m]))',
    '  alerting-rules.yml: |',
    '    groups:',
    '      - name: checkout.alerts',
    '        rules:',
    '          - alert: HighErrorRate',
    '            expr: slo:http_requests:good_5m / slo:http_requests:total_5m < 0.99',
    '            for: 2m',
    '            labels:',
    '              severity: critical',
    '            annotations:',
    '              summary: "error rate is {{ "{{" }} $value | humanizePercentage {{ "}}" }}"',
    '  overview.json: |',
    '    {"uid":"checkout-overview","title":"Checkout Overview","schemaVersion":39,"version":3,"panels":[]}',
    '{{- end }}',
  ].join('\n'),
};
assert(detectArtefactKind('charts/checkout/templates/configmaps.yaml', HELM['charts/checkout/templates/configmaps.yaml']) === 'helm-template',
  'helm template detected via Go-template scaffolding');
assert(detectArtefactKind('charts/checkout/Chart.yaml', HELM['charts/checkout/Chart.yaml']) === 'helm-chart',
  'Chart.yaml detected as helm-chart');
const helm = crawlFiles(HELM, { repoName: 'checkout-helm', now: '2026-06-05T00:00:00.000Z' });
assert(helm.summary.warnings.every(w => !/Failed to parse/.test(w)),
  `no parse failures on helm chart (warnings: ${JSON.stringify(helm.summary.warnings.filter(w => /Failed to parse/.test(w)))})`);
assert(helm.canonical.spec.queries.recording_rules.some(r => r.name === 'slo:http_requests:good_5m'),
  'recording rule lifted from embedded ConfigMap');
assert(helm.canonical.spec.slis.some(s => s.id === 'slo_http_requests'),
  'SLI inferred from embedded recording rules');
assert(helm.canonical.spec.dashboards.some(d => d.id === 'checkout-overview'),
  'grafana dashboard lifted from embedded ConfigMap JSON');
assert(validateCanonical(helm.canonical, SCHEMA).length === 0, 'helm chart crawl validates against v1.2 schema');

// ---------- environment-scoped extraction ----------
process.stdout.write('\n--- environment scoped extraction ---\n');
const ENV_MIXED = {
  'docker-compose.yml': `services:
  prometheus:
    image: prom/prometheus:v2.51.0
`,
  'k8s/charts/checkout/values.yaml': `grafana:
  image:
    repository: grafana/grafana
    tag: 12.0.0
`,
  'k8s/charts/checkout/values-local.yaml': `loki:
  image:
    repository: grafana/loki
    tag: 3.0.0
`,
  'k8s/charts/checkout/values-eks.yaml': `victoriametrics:
  image:
    repository: victoriametrics/victoria-metrics
    tag: v1.101.0
`,
  'k8s/manifests/kube-state-metrics.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
spec:
  template:
    spec:
      containers:
        - name: kube-state-metrics
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0
`,
};
assert(detectArtefactKind('k8s/charts/checkout/values-eks.yaml', ENV_MIXED['k8s/charts/checkout/values-eks.yaml']) === 'helm-values',
  'Helm values detected as backend source');
assert(detectArtefactKind('k8s/manifests/kube-state-metrics.yaml', ENV_MIXED['k8s/manifests/kube-state-metrics.yaml']) === 'k8s-workload',
  'plain K8s workload detected as backend source');

const products = (result) => new Set((result.canonical.spec.telemetry?.backends || []).map(b => b.product));
const prod = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'prod', now: '2026-06-05T00:00:00.000Z' });
const prodProducts = products(prod);
assert(prod.summary.environment.profile === 'prod' && prod.summary.environment.scoped === true,
  `prod environment maps to production Kubernetes extraction (${JSON.stringify(prod.summary.environment)})`);
assert(prod.summary.files.excludedByEnvironment >= 2,
  `prod scope excludes docker/local files when an explicit production overlay exists (got ${prod.summary.files.excludedByEnvironment})`);
assert(prodProducts.has('grafana'), 'production Helm values backend discovered');
assert(prodProducts.has('kube-state-metrics'), 'production K8s workload backend discovered');
assert(prod.canonical.spec.pipelines.exporters.metrics?.kind === 'prometheusremotewrite',
  'production metrics exporter inferred from source-backed metrics workload');
assert(!prod.canonical.metadata.annotations['crawler.scaffold.pipelines.exporters.metrics'],
  'production metrics exporter is source-backed, not scaffolded');
assert(prod.evidence['pipelines.exporters.metrics'] === 'k8s/manifests/kube-state-metrics.yaml',
  'metrics exporter evidence points at the K8s metrics workload',
  prod.evidence['pipelines.exporters.metrics'], 'k8s/manifests/kube-state-metrics.yaml');
assert(!prodProducts.has('prometheus'), 'prod scan does not mix in docker-compose Prometheus');
assert(!prodProducts.has('loki'), 'prod scan does not mix in local-k8s Loki');
assert(!prodProducts.has('victoriametrics'), 'prod scan does not mix in explicit EKS values');

const eks = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'eks', now: '2026-06-05T00:00:00.000Z' });
const eksProducts = products(eks);
assert(eks.summary.environment.profile === 'eks' && eks.summary.environment.scoped === true,
  `explicit eks environment keeps EKS profile (${JSON.stringify(eks.summary.environment)})`);
assert(eksProducts.has('victoriametrics'), 'explicit EKS values backend discovered');
assert(!eksProducts.has('loki'), 'explicit EKS scan excludes local-k8s Loki');

const localDocker = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'local-docker', now: '2026-06-05T00:00:00.000Z' });
const dockerProducts = products(localDocker);
assert(dockerProducts.has('prometheus'), 'local-docker scan keeps docker-compose backend');
assert(!dockerProducts.has('victoriametrics'), 'local-docker scan excludes EKS values');

const localK8s = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'local-k8s', now: '2026-06-05T00:00:00.000Z' });
const localK8sProducts = products(localK8s);
assert(localK8sProducts.has('grafana') && localK8sProducts.has('loki'),
  'local-k8s scan reads base + local Helm values');
assert(!localK8sProducts.has('prometheus'), 'local-k8s scan excludes docker-compose backend');
assert(!localK8sProducts.has('victoriametrics'), 'local-k8s scan excludes EKS values');

// ---------- Helm `enabled: false` toggles honored per environment ----------
// A component an environment disables (e.g. prometheus on EKS, which runs
// victoriametrics) must NOT be declared as a backend. The toggle lives in the
// env overlay (values-eks) while the image lives in base values.yaml, so the
// crawler must merge `enabled` across the in-scope values files (overlays win).
process.stdout.write('\n--- Helm enabled:false toggle ---\n');
const ENV_TOGGLE = {
  'k8s/charts/app/Chart.yaml': `name: app
version: 0.1.0
`,
  'k8s/charts/app/values.yaml': `prometheus:
  enabled: true
  image:
    repository: prom/prometheus
    tag: v2.53.0
victoriametrics:
  image:
    repository: victoriametrics/victoria-metrics
    tag: v1.103.0
`,
  'k8s/charts/app/values-eks.yaml': `prometheus:
  enabled: false
`,
};

const togEks = crawlFiles(ENV_TOGGLE, { repoName: 'app', environment: 'eks', now: '2026-06-05T00:00:00.000Z' });
const togEksProducts = products(togEks);
assert((togEks.summary.discovered.disabledComponents || []).includes('prometheus'),
  `eks merges values-eks enabled:false → prometheus marked disabled (got ${JSON.stringify(togEks.summary.discovered.disabledComponents)})`);
assert(!togEksProducts.has('prometheus'),
  'eks scan drops Prometheus because values-eks.yaml sets enabled:false');
assert(togEksProducts.has('victoriametrics'),
  'eks scan keeps VictoriaMetrics (the metrics backend EKS actually runs)');

const togProd = crawlFiles(ENV_TOGGLE, { repoName: 'app', environment: 'prod', now: '2026-06-05T00:00:00.000Z' });
const togProdProducts = products(togProd);
assert(togProdProducts.has('prometheus'),
  'prod scan (EKS overlay out of scope) keeps Prometheus — the toggle is environment-specific');
assert(togProdProducts.has('victoriametrics'),
  'prod scan still reads base-values backends');

// ---------- unresolved ${VAR} placeholders in alerting channels ----------
//
// Regression for the 2026-06-10 finding: a webhook whose entire value is a
// deploy-time placeholder (`${AUTO_REMEDIATION_WEBHOOK_URL}`) produced a
// pack that failed the crawler's own schema (`format: uri`). Contract:
// pure-placeholder channels are excluded from the declared spec and
// recorded as evidence; placeholders EMBEDDED in a URI-shaped value
// (https://ntfy.sh/${TOPIC}) stay declared; the output always validates.
const PLACEHOLDER_FIXTURE = {
  'alertmanager.yml': `route:
  receiver: oncall
  routes:
    - match: { severity: critical }
      receiver: oncall
    - match: { severity: warning }
      receiver: auto-remediation
    - match: { severity: info }
      receiver: ntfy
receivers:
  - name: oncall
    msteams_configs:
      - channel_url: '#oncall'
  - name: auto-remediation
    webhook_configs:
      - url: '\${AUTO_REMEDIATION_WEBHOOK_URL}'
  - name: ntfy
    webhook_configs:
      - url: 'https://ntfy.sh/\${NTFY_TOPIC}?priority=urgent'
`,
  'rules.yml': `groups:
  - name: g
    rules:
      - record: app:availability:ratio
        expr: sum(rate(ok_total[5m]))
`,
};
const ph = crawlFiles(PLACEHOLDER_FIXTURE, { repoName: 'placeholder-app', now: '2026-06-10T00:00:00.000Z' });
assert(validateCanonical(ph.canonical, SCHEMA).length === 0,
  'pack with placeholder channels passes the schema — the crawler never emits output that fails its own validation',
  validateCanonical(ph.canonical, SCHEMA).slice(0, 2));
const phRoutes = ph.canonical.spec.alerting.routes;
const allChannelValues = phRoutes.flatMap(r => r.channels.map(c => c.webhook || c.msteams || c.email || c.voice || ''));
assert(!allChannelValues.some(v => v === '${AUTO_REMEDIATION_WEBHOOK_URL}'),
  'pure-placeholder webhook is NOT declared as a route channel', allChannelValues);
assert(allChannelValues.some(v => v.startsWith('https://ntfy.sh/')),
  'URI-shaped value with an embedded placeholder stays declared');
assert(ph.summary.omitted.unresolvedChannels.length === 1,
  'the excluded channel is recorded in summary.omitted.unresolvedChannels',
  ph.summary.omitted.unresolvedChannels);
assert(ph.summary.warnings.some(w => /unresolved \$\{VAR\} placeholder/.test(w)),
  'the crawl summary warns about the exclusion');
assert(ph.canonical.metadata.annotations['crawler.unresolvedChannelCount'] === '1',
  'annotation carries the unresolved-channel count');
assert(/AUTO_REMEDIATION_WEBHOOK_URL/.test(ph.canonical.metadata.annotations['crawler.unresolved.alerting'] || ''),
  'annotation preserves the placeholder as evidence');

report('crawler');
