#!/usr/bin/env node
// ============================================================
// test-crawl.mjs — fixture-driven crawler test.
//
// Builds a synthetic file map representing a service repo, runs
// the crawler, then validates the resulting canonical pack
// against the vendored spec schema. Asserts the end-to-end loop
// works: crawler output is a valid pack.
// ============================================================

import { crawlFiles, dashboardSpecId, detectArtefactKind, crawlToYaml, scanReadsPath, scanSkipsName, walkScanFolder, SCAN_EXT, SCAN_IGNORE_DIRS } from './lib/crawler.mjs';
import { inferSlisFromRecordingRules, canonicalRuleDuration, burnAlertsFromAlertRules } from './lib/sli-inference.mjs';
import { compileAlertmanager } from './lib/compile.mjs';
import { backendForScrapeJob, knownBackendProduct, BACKEND_PATTERNS } from './lib/backend-products.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { readFileSync } from 'node:fs';
import { adapt } from './lib/adapter.mjs';
import { evaluateConformance } from './lib/conformance.mjs';
import { diffPacks } from './lib/diff.mjs';

const SCHEMA_PATH = new URL(`../${SPEC_SCHEMA_PATH}`, import.meta.url);
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
assert(!(summary.scaffold || []).some(s => /^telemetry\.backends\.[^.]+$/.test(s)),
       'a real backend is never parked as a scaffold: an assumed port marks the endpoints FIELD only');
assert((summary.scaffold || []).includes('otel.semconv') && !(summary.scaffold || []).includes('otel'),
       'the invented otel block is marked field by field, never as the otel artefact (Compare keeps it not-observed)');

assert(Object.keys(evidence).length >= 5, `evidence map populated (${Object.keys(evidence).length} entries)`);

const familyScope = crawlFiles(FIXTURE, {
  repoName: 'payments',
  environment: 'prod',
  diffScopeMode: 'family',
  now: '2026-06-05T00:00:00.000Z',
});
assert(familyScope.canonical.metadata.annotations['observogram.diff.scopeMode'] === 'family',
       'crawler honors live-drift scope override');

// ---------- validate against the vendored schema ----------
process.stdout.write('\n--- validate ---\n');
const validationErrors = validateCanonical(canonical, SCHEMA);
if (validationErrors.length) {
  process.stdout.write(`✗ canonical pack passes the vendored schema — got ${validationErrors.length} errors:\n`);
  for (const e of validationErrors.slice(0, 8)) process.stdout.write(`    · ${e}\n`);
  failures.push('canonical pack passes the vendored schema');
} else {
  process.stdout.write(`✓ canonical pack passes the vendored schema\n`);
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

  // The krystaline audit (2026-11-06): L5.MUST.synthetic_probe passed on the
  // health canary the crawler invents (https://<repo>.example.com/health,
  // marked crawler.scaffold.validation.synthetic_checks.<id>). A value a
  // scanner invented satisfies no clause; the same probe declared by
  // someone does, and a library placeholder still does (onPlaceholder).
  const probeClause = (pack) => evaluateConformance(pack).clauses.find(c => c.id === 'L5.MUST.synthetic_probe');
  const [canary] = canonical.spec.validation.synthetic_checks;
  const canaryMark = `crawler.scaffold.validation.synthetic_checks.${canary.id}`;
  assert(/\.example\.com\/health$/.test(canary.target) && canonical.metadata.annotations[canaryMark],
         'the crawler still writes its schema-forced canary, marked a scaffold');
  assert(probeClause(canonical).pass === false, 'the invented canary is no synthetic probe (L5.MUST.synthetic_probe fails)');
  const declaredProbe = structuredClone(canonical);
  delete declaredProbe.metadata.annotations[canaryMark];
  assert(probeClause(declaredProbe).pass === true, 'the same probe, declared by someone, passes');
  const fetchedProbe = structuredClone(declaredProbe);
  fetchedProbe.metadata.annotations[`mcp.scaffold.validation.synthetic_checks.${canary.id}`] = 'schema-forced';
  assert(probeClause(fetchedProbe).pass === false, 'the live fetcher\'s placeholders are scanner-invented too');
  const libraryProbe = structuredClone(declaredProbe);
  libraryProbe.metadata.annotations[`library.todo.validation.synthetic_checks.${canary.id}`] = 'point it at the endpoint';
  assert(probeClause(libraryProbe).pass === true, 'a library placeholder still represents the requirement');
  assert(!('crawler.unobserved.chaos' in canonical.metadata.annotations),
         'the scan detects chaos experiments now (tools/lib/chaos-detect.mjs): it no longer says it cannot look');

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
assert(validateCanonical(real.canonical, SCHEMA).length === 0, 'real-world crawl still validates against the vendored schema');

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
assert(validateCanonical(helm.canonical, SCHEMA).length === 0, 'helm chart crawl validates against the vendored schema');

// A string-literal action prints its string: {{ "{{" }} … {{ "}}" }} (and the
// backtick form) is how a chart writes an alert's own {{ $value }}, and Helm
// renders the two braces — the text live serves. One brace would read as
// drift against live.
{
  const chart = {
    'charts/checkout/Chart.yaml': 'apiVersion: v2\nname: checkout\nversion: 0.1.0\n',
    'charts/checkout/templates/configmaps.yaml': [
      '{{- if .Values.prometheus.enabled }}',
      'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: {{ include "checkout.fullname" . }}-rules', 'data:',
      '  recording-rules.yml: |', '    groups:', '      - name: checkout.slo', '        rules:',
      '          - record: slo:http_requests:good_5m', '            expr: sum(rate(http_requests_total{code!~"5.."}[5m]))',
      '          - record: slo:http_requests:total_5m', '            expr: sum(rate(http_requests_total[5m]))',
      '  alerting-rules.yml: |', '    groups:', '      - name: checkout.alerts', '        rules:',
      '          - alert: CheckoutDown', '            expr: up{job="checkout"} == 0', '            for: 2m',
      '            labels:', '              severity: critical', '            annotations:',
      '              summary: "down for {{ "{{" }} $value {{ "}}" }} checks"',
      '              description: "{{ `{{ $labels.instance }}` }} is down"',
      '{{- end }}',
    ].join('\n'),
  };
  const rule = crawlFiles(chart, { repoName: 'checkout-helm', now: '2026-06-05T00:00:00.000Z' }).canonical.spec.alerting?.rules?.find((r) => r.name === 'CheckoutDown');
  assert(rule?.annotations?.summary === 'down for {{ $value }} checks', 'a Helm literal-brace escape keeps both braces, as Helm renders it', rule?.annotations);
  assert(rule?.annotations?.description === '{{ $labels.instance }} is down', 'so does a backtick string literal', rule?.annotations);
}

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
assert(!allChannelValues.some(v => v.includes('${AUTO_REMEDIATION_WEBHOOK_URL}')),
  'a pure placeholder is never written into the pack as an address', allChannelValues);
assert(phRoutes.length === 4 && phRoutes.some(r => r.severity === 'SEV2'
    && JSON.stringify(r.channels) === JSON.stringify([{ webhook: 'unresolved:AUTO_REMEDIATION_WEBHOOK_URL' }])),
  'its route stays declared: the channel exists, with unresolved:<VAR> in place of the address it takes at deploy time', phRoutes);
assert(allChannelValues.some(v => v.startsWith('https://ntfy.sh/')),
  'URI-shaped value with an embedded placeholder stays declared');
assert(ph.summary.omitted.unresolvedChannels.length === 1,
  'the placeholder is recorded in summary.omitted.unresolvedChannels',
  ph.summary.omitted.unresolvedChannels);
assert(ph.summary.warnings.some(w => /unresolved \$\{VAR\} placeholder/.test(w) && /unresolved:<VAR>/.test(w)),
  'the crawl summary says the address is a deploy-time placeholder and how it is declared');
assert(ph.canonical.metadata.annotations['crawler.unresolvedChannelCount'] === '1',
  'annotation carries the unresolved-channel count');
assert(/AUTO_REMEDIATION_WEBHOOK_URL/.test(ph.canonical.metadata.annotations['crawler.unresolved.alerting'] || ''),
  'annotation preserves the placeholder as evidence');

// The compiler sends such an address back out as the repository had it,
// and references a redacted one by file like any other secret.
{
  const am = compileAlertmanager(ph.canonical);
  assert(/url: "?\$\{AUTO_REMEDIATION_WEBHOOK_URL\}"?/.test(am) && !/unresolved:/.test(am),
    'compiling the scanned pack emits ${AUTO_REMEDIATION_WEBHOOK_URL} again — never the marker', am.split('\n').filter(l => /url/.test(l)));
  const redacted = JSON.parse(JSON.stringify(ph.canonical));
  redacted.spec.alerting.routes = [{ severity: 'SEV1', channels: [{ webhook: 'redacted:secret' }] }];
  const am2 = compileAlertmanager(redacted);
  assert(/url_file: "?\/etc\/alertmanager\/secrets\/webhook_/.test(am2) && !/redacted:/.test(am2),
    'a redacted webhook compiles to a url_file secret reference — never the marker as a URL', am2.split('\n').filter(l => /url/.test(l)));
}

// ---------- one reading for both sides: SLIs, alert windows, products ----------
{
  // The same rules in two arrival orders infer the same SLI.
  const rules = [
    { name: 'svc:latency:p99_5m', expr: 'histogram_quantile(0.99, x)' },
    { name: 'svc:latency:p95_5m', expr: 'histogram_quantile(0.95, x)' },
    { name: 'svc:latency:p50_5m', expr: 'histogram_quantile(0.50, x)' },
  ];
  const forward = inferSlisFromRecordingRules(rules);
  const backward = inferSlisFromRecordingRules(rules.slice().reverse());
  assert(JSON.stringify(forward) === JSON.stringify(backward) && forward[0].sli.query === 'histogram_quantile(0.50, x)',
    'SLI inference picks by rule NAME, not arrival order: file order and a ruler\'s group order agree', [forward[0].sli.query, backward[0].sli.query]);

  assert(canonicalRuleDuration('120s') === '2m' && canonicalRuleDuration(120) === '2m' && canonicalRuleDuration('2m') === '2m'
    && canonicalRuleDuration('1h30m') === '90m' && canonicalRuleDuration('90s') === '90s' && canonicalRuleDuration('3600') === '1h',
    'a rule\'s `for` has one spelling: 120s, 120 (the ruler\'s seconds) and 2m are the same wait');
  assert(canonicalRuleDuration(0) === null && canonicalRuleDuration('') === null && canonicalRuleDuration(undefined) === null
    && canonicalRuleDuration('0s') === null,
    'no wait is no window — never a default');

  const slos = new Set(['svc_latency_99']);
  const fromFile = burnAlertsFromAlertRules([
    { alert: 'LatencyHigh', expr: 'svc:latency:p95_5m > 0.5', for: '5m', labels: { severity: 'warning' } },
    { alert: 'LatencyVeryHigh', expr: 'svc:latency:p99_5m > 2', for: '900s', labels: { severity: 'critical' } },
    { alert: 'DiskFull', expr: 'node_filesystem_avail_bytes < 1', for: '5m' },
  ], (id) => slos.has(id));
  const fromRuler = burnAlertsFromAlertRules([
    { name: 'DiskFull', expr: 'node_filesystem_avail_bytes < 1\n', for: '5m', labels: {} },
    { name: 'LatencyVeryHigh', expr: 'svc:latency:p99_5m > 2\n', for: '15m', labels: { severity: 'critical' } },
    { name: 'LatencyHigh', expr: 'svc:latency:p95_5m > 0.5\n', for: '5m', labels: { severity: 'warning' } },
  ], (id) => slos.has(id));
  const windows = (r) => r.alerts.map(a => [a.slo, a.windows.map(w => w.short).sort()]);
  assert(JSON.stringify(windows(fromFile)) === JSON.stringify(windows(fromRuler))
    && JSON.stringify(windows(fromFile)) === JSON.stringify([['svc_latency_99', ['15m', '5m']]]),
    'one rule set read from a file or from a ruler yields one burn-rate policy', [windows(fromFile), windows(fromRuler)]);
  assert(JSON.stringify(fromFile.unlinked) === JSON.stringify(['DiskFull']) && fromFile.alerts[0].alertNames.length === 2,
    'an alert that reads no recorded series is named unlinked; an entry names the rules it was read from', fromFile);

  assert(JSON.stringify(backendForScrapeJob('otel-collector')) === JSON.stringify({ product: 'opentelemetry-collector', signal: 'collection' })
    && JSON.stringify(backendForScrapeJob('node_exporter')) === JSON.stringify({ product: 'node-exporter', signal: 'metrics' }),
    'a scrape job names the product whose endpoint it scrapes, with the signal an image of that product gets');
  assert(backendForScrapeJob('otel-mcp-server') === null && backendForScrapeJob('grafana-agent') === null
    && backendForScrapeJob('postgres-exporter') === null && backendForScrapeJob('') === null,
    'a job that only resembles a product name, or scrapes something that is no backend, attests nothing');
  assert(knownBackendProduct('fluentbit')?.product === 'fluent-bit' && knownBackendProduct('VictoriaMetrics')?.signal === 'metrics'
    && knownBackendProduct('graylog') === null,
    'a product named another way resolves to the table\'s spelling and signal; an unknown one to null');
  for (const row of BACKEND_PATTERNS) {
    const viaName = knownBackendProduct(row.product);
    assert(viaName && viaName.product === row.product, `product table: ${row.product} resolves to itself`, viaName);
  }
}

// ---------- a log-tailing config is not a metrics scrape job; exposition text declares metrics ----------
{
  const scan = crawlFiles({
    'prometheus/scrape.yml': `scrape_configs:
  - job_name: api
    static_configs:
      - targets: ['api:8080']
`,
    'promtail/config.yml': `clients:
  - url: http://loki:3100/loki/api/v1/push
positions:
  filename: /tmp/positions.yaml
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
`,
    'alloy/logs.yml': `scrape_configs:
  - job_name: varlogs
    static_configs:
      - targets: [localhost]
        labels:
          __path__: /var/log/*.log
  - job_name: journal
    pipeline_stages:
      - json: {}
`,
    'scripts/push-metrics.js': `const lines = [
  '# HELP batch_last_success_timestamp_seconds Last successful run',
  '# TYPE batch_last_success_timestamp_seconds gauge',
  '# TYPE batch_rows_processed_total counter',
];`,
    'tests/exposition.test.js': `const sample = '# TYPE only_in_a_test_total counter';`,
    'rules.yml': `groups:
  - name: g
    rules:
      - record: app:availability:ratio
        expr: sum(rate(ok_total[5m]))
`,
  }, { repoName: 'logs-app', now: '2026-10-01T00:00:00.000Z' });
  const jobs = JSON.parse(scan.canonical.metadata.annotations['crawler.discovered.scrape_jobs']);
  assert(JSON.stringify(jobs) === JSON.stringify(['api']),
    'a Promtail / Alloy scrape_configs entry (clients + positions, __path__, pipeline_stages) is not a metrics scrape job', jobs);
  assert(scan.summary.discovered.logScrapeConfigs === 3, 'the log configs are counted, not dropped silently', scan.summary.discovered.logScrapeConfigs);
  const names = JSON.parse(scan.canonical.metadata.annotations['crawler.discovered.metric_names']);
  const origins = JSON.parse(scan.canonical.metadata.annotations['crawler.discovered.metric_origins']);
  assert(names.includes('batch_last_success_timestamp_seconds') && names.includes('batch_rows_processed_total')
    && origins.batch_last_success_timestamp_seconds.type === 'gauge'
    && origins.batch_last_success_timestamp_seconds.help === 'Last successful run'
    && origins.batch_last_success_timestamp_seconds.file === 'scripts/push-metrics.js',
    'metrics written out in the exposition format (# TYPE / # HELP) are declared, with type, help and origin', names);
  assert(!names.includes('only_in_a_test_total'), 'an exposition sample in a test file declares nothing', names);
}

// ---------- which files a scan reads: one rule for the picker, the drop zone and the CLI ----------
// The folder picker lists everything under the folder; on a real repository
// that was 75,000 files (430 MB), 73,900 of them under node_modules.
assert(scanReadsPath('repo/k8s/prometheus/rules.yaml', { skipRoot: true }), 'a rule file under the picked folder is read');
assert(scanReadsPath('docker-compose.yml'), 'a top-level file with no folder is read');
assert(!scanReadsPath('repo/node_modules/pkg/dashboards/overview.json', { skipRoot: true }), 'nothing under node_modules is read');
assert(!scanReadsPath('repo/packages/api/node_modules/x/rules.yml', { skipRoot: true }), 'a nested node_modules neither');
assert(!scanReadsPath('repo/dist/server/metrics.js', { skipRoot: true }), 'build output is not read');
assert(!scanReadsPath('repo/.git/config.yaml', { skipRoot: true }) && !scanReadsPath('repo/.github/workflows/ci.yml', { skipRoot: true }),
  'version control and CI folders are not read');
assert(!scanReadsPath('repo/.claude/worktrees/w1/k8s/prometheus/rules.yaml', { skipRoot: true }),
  'an agent worktree is a second copy of the repository: reading it would declare every artefact twice');
assert(scanReadsPath('repo/.observability/pack.yaml', { skipRoot: true }), '.observability is the one dot-folder a scan enters');
assert(!scanReadsPath('repo/.env.yaml', { skipRoot: true }), 'a dot-file is not read');
assert(!scanReadsPath('repo/docs/README.md', { skipRoot: true }) && !scanReadsPath('repo/assets/logo.png', { skipRoot: true }),
  'an extension the scanner does not parse is not read');
assert(scanReadsPath('dist/k8s/rules.yaml', { skipRoot: true }) && scanReadsPath('.work/k8s/rules.yaml', { skipRoot: true }),
  'the picked folder itself is the user\'s choice, whatever it is called');
assert(!scanReadsPath('dist/k8s/rules.yaml'), 'without a picked root the first segment is a folder like any other');
assert(scanSkipsName('node_modules', { dir: true }) && !scanSkipsName('node_modules'), 'the ignore list names folders, not files');
assert(!scanReadsPath('') && !scanReadsPath(null), 'no path, nothing read');
assert(['yaml', 'yml', 'json', 'ts', 'py', 'go', 'java'].every(e => SCAN_EXT.test(`x.${e}`)) && SCAN_IGNORE_DIRS.has('coverage'),
  'the extensions and the ignore list are the library\'s, shared');
// The three ways in all use it: the CLI walker and both studio paths.
const cliSrc = readFileSync(new URL('./crawl-repo.mjs', import.meta.url), 'utf8');
assert(/readRepoFolder\(opts\.repoPath\)/.test(cliSrc) && !/IGNORE_DIRS = new Set|SCAN_EXT\.test/.test(cliSrc),
  'the CLI walker is the shared folder read (tools/lib/repo-folder.mjs) and keeps no list of its own');
const folderSrc = readFileSync(new URL('./lib/repo-folder.mjs', import.meta.url), 'utf8');
assert(/scanSkipsName\(e\.name, \{ dir: true \}\)/.test(folderSrc) && /SCAN_EXT\.test\(e\.name\)/.test(folderSrc) && !/new Set\(\[/.test(folderSrc),
  'and the shared folder read applies the crawler\'s rule');
const studioSrc = readFileSync(new URL('../studio/app.mjs', import.meta.url), 'utf8');
const stage = studioSrc.slice(studioSrc.indexOf('async function stageFileList'), studioSrc.indexOf('async function finalizeStaging'));
assert(/lib\.scanReadsPath\(rel, \{ skipRoot: !!f\.webkitRelativePath \}\)/.test(stage),
  'the folder picker applies the rule to each path');
assert(stage.indexOf('scanReadsPath') < stage.indexOf('f.text()'), 'and before it reads the file, not after');
const drop = studioSrc.slice(studioSrc.indexOf('async function readEntry'), studioSrc.indexOf('async function stageFileList'));
const filesSrc = readFileSync(new URL('../studio/repository-files.mjs', import.meta.url), 'utf8');
const dropped = filesSrc.slice(filesSrc.indexOf('export async function walkDropped'), filesSrc.indexOf('export async function filesFromEntries'));
assert(/await walkDropped\(entry, lib,/.test(drop) && /lib\.scanSkipsName\(entry\.name, \{ dir: true \}\)/.test(dropped),
  'the drop zone walks with the shared drop walker, which applies the same rule to each folder');
assert(!/CRAWL_IGNORE_DIRS|CRAWL_SCAN_EXT/.test(studioSrc), 'the studio keeps no list of its own');

// ---------- the folder handed over as a handle: skipped folders are never listed ----------
// A stand-in for FileSystemDirectoryHandle / FileSystemFileHandle. `listed`
// records every folder whose entries were asked for: the point of the walk
// is that node_modules is not among them.
{
  const listed = [];
  const fileHandle = (name) => ({ kind: 'file', name });
  const dirHandle = (name, children) => ({
    kind: 'directory',
    name,
    async *entries() {
      listed.push(name);
      // Out of name order on purpose: a platform lists in its own order.
      for (const c of [...children].reverse()) yield [c.name, c];
    },
  });
  const repo = dirHandle('dist', [                       // the picked folder: named like a skipped one
    fileHandle('docker-compose.yml'),
    fileHandle('README.md'),
    fileHandle('.env.yaml'),
    dirHandle('k8s', [dirHandle('prometheus', [fileHandle('rules.yaml'), fileHandle('alerts.yml')])]),
    dirHandle('node_modules', [dirHandle('pkg', [fileHandle('index.js'), fileHandle('dash.json')])]),
    dirHandle('packages', [dirHandle('api', [
      dirHandle('node_modules', [fileHandle('x.yml')]),
      dirHandle('src', [fileHandle('metrics.ts')]),
    ])]),
    dirHandle('.git', [fileHandle('config.yaml')]),
    dirHandle('.claude', [dirHandle('worktrees', [dirHandle('w1', [fileHandle('rules.yaml')])])]),
    dirHandle('.observability', [fileHandle('pack.yaml')]),
    dirHandle('build', [fileHandle('out.json')]),
  ]);
  const read = [];
  const notEntered = await walkScanFolder(repo, async (rel, handle) => { read.push(rel); assert(handle.kind === 'file', 'onFile gets the file handle'); });
  assert(JSON.stringify(read) === JSON.stringify([
    'dist/.observability/pack.yaml',
    'dist/docker-compose.yml',
    'dist/k8s/prometheus/alerts.yml',
    'dist/k8s/prometheus/rules.yaml',
    'dist/packages/api/src/metrics.ts',
  ]), 'the walk reads what the rule reads, rooted at the picked folder, in name order', read);
  assert(read.every(r => scanReadsPath(r, { skipRoot: true })), 'every path it reads is one the folder input would have read');
  assert(notEntered === 5, 'node_modules (twice), .git, .claude and build are counted as not entered', notEntered);
  assert(!listed.includes('node_modules') && !listed.includes('.git') && !listed.includes('worktrees') && !listed.includes('pkg'),
    'and their entries are never asked for — the dependencies are not listed, not merely filtered', listed);
  assert(listed.includes('dist') && listed.includes('.observability'), 'the picked folder is entered whatever its name; .observability too');

  const empty = await walkScanFolder(dirHandle('nothing', []), async () => { throw new Error('no file to read'); });
  assert(empty === 0, 'an empty folder reads nothing and skips nothing');

  // The studio's "pick a folder" goes through the handle where the browser
  // has one, and keeps the folder input as the fallback.
  const pick = studioSrc.slice(studioSrc.indexOf('async function pickScanFolder'), studioSrc.indexOf('async function stageFileList'));
  assert(/pickFolderBtn\.onclick = \(\) => pickScanFolder\(folderInput\)/.test(studioSrc), 'pick a folder calls the picker, not the input');
  assert(/typeof window\.showDirectoryPicker !== 'function'\) \{ folderInput\.click\(\); return; \}/.test(pick),
    'a browser without showDirectoryPicker falls back to the folder input');
  assert(/e\?\.name !== 'AbortError'\) folderInput\.click\(\)/.test(pick), 'a refusal falls back too; a closed dialog does nothing');
  assert(/lib\.walkScanFolder\(dir,/.test(pick) && !/scanSkipsName|SCAN_EXT/.test(pick), 'and the walk is the library\'s — the studio keeps no rule of its own');
  assert(pick.indexOf('SCAN_MAX_FILE_BYTES') < pick.indexOf('file.text()'), 'the size cap applies before the file is read');
}

// ---------- Grafana unified-alerting provisioning ----------
process.stdout.write('\n--- grafana alert provisioning ---\n');
{
  // A provisioning export as other tooling writes it back: query models as
  // JSON strings, non-ASCII annotations as YAML \xHH escapes (PyYAML's
  // default), and one rule whose model JSON is broken. See the fixture README.
  const PROV_PATH = 'grafana/provisioning/alerting/alert-rules.yaml';
  const PROV = readFileSync(new URL('./fixtures/crawl/grafana-provisioning/alert-rules.yaml', import.meta.url), 'utf8');
  const RULES = [
    'groups:',
    '  - name: slo',
    '    rules:',
    '      - record: checkout:availability:good',
    '        expr: sum(rate(http_requests_total{code!~"5.."}[5m]))',
    '      - record: checkout:availability:total',
    '        expr: sum(rate(http_requests_total[5m]))',
    '',
  ].join('\n');
  assert(detectArtefactKind(PROV_PATH, PROV) === 'prometheus-rules', 'provisioned alert rules detected as a rule file');

  const prov = crawlFiles({ [PROV_PATH]: PROV, 'prometheus/rules.yml': RULES }, { repoName: 'checkout', now: '2026-06-05T00:00:00.000Z' });
  const provWarnings = prov.summary.warnings;
  assert(!provWarnings.some(w => /Failed to parse/.test(w)),
    'YAML \\xHH escapes in an annotation do not fail the file', provWarnings.filter(w => /Failed to parse/.test(w)));
  assert(Object.values(prov.evidence).some(v => v === `${PROV_PATH}#checkout-slo/CheckoutAvailabilityBurnRate`),
    'the rule with a mapping model survives');
  assert(Object.values(prov.evidence).some(v => v === `${PROV_PATH}#checkout-slo/CheckoutLatencyBurnRate`),
    'the rule with a well-formed JSON-string model survives');
  assert(!Object.values(prov.evidence).some(v => /CheckoutQueueDepthBurnRate/.test(v)),
    'the rule whose model JSON does not parse is skipped, not declared');
  assert(prov.summary.discovered.burnRateAlerts === 2,
    'two of three alert rules discovered', prov.summary.discovered.burnRateAlerts, 2);
  const skipped = provWarnings.filter(w => /^Skipped .* alert rule\(s\)/.test(w));
  assert(skipped.length === 1, 'exactly one skip warning for the file', skipped);
  assert(skipped[0] === `Skipped 1 of 3 alert rule(s) in ${PROV_PATH}: model JSON could not be parsed`,
    'the warning names the file, the count lost and the cause', skipped[0],
    `Skipped 1 of 3 alert rule(s) in ${PROV_PATH}: model JSON could not be parsed`);

  // The expr read from data[].model is the one the SLO binding and the metric
  // inventory use, for a mapping model and for a JSON-string model alike.
  assert(prov.canonical.spec.policy.burn_rate_alerts.some(a => a.slo === 'checkout_availability_99'),
    'the mapping model\'s expr binds the alert to the recorded SLO', prov.canonical.spec.policy.burn_rate_alerts);
  assert(prov.evidence['metrics.checkout:latency_p99:ms'] !== undefined,
    'the JSON-string model\'s expr feeds the metric inventory', Object.keys(prov.evidence).filter(k => /^metrics\./.test(k)));
  assert(validateCanonical(prov.canonical, SCHEMA).length === 0, 'provisioning crawl validates against the vendored schema');

  // A clean file keeps no skip warning.
  const clean = crawlFiles({ 'prometheus/rules.yml': RULES }, { repoName: 'checkout', now: '2026-06-05T00:00:00.000Z' });
  assert(!clean.summary.warnings.some(w => /^Skipped .* alert rule/.test(w)), 'no skip warning when every rule reads');
}

// ---------- dashboardSpecId: the crawler's dashboard id rule as one export ----------
// The one rule a crawled pack and a live snapshot share. The seven uid shapes
// the fetcher's own slug mapped differently (`_` kept, `--` collapsed, 64 vs
// 60 characters, `dash-` vs `d-`): the export gives exactly the ids a crawl
// writes for them.
{
  const UIDS = [
    ['node_exporter_full', 'Node Exporter Full'], ['9xyz_abc', 'Nine'], ['a--b', 'A B'],
    ['3f1e9c0d2b8a4f6e9d7c5b3a1e0f2d4c', 'Hashed'], ['orders-main', 'Orders'], ['--', 'Fallback Title'],
    ['Payments_API_Overview_With_A_Very_Long_Uid_That_Runs_Past_Sixty_Chars', 'Long'],
  ];
  const files = Object.fromEntries(UIDS.map(([uid, title], i) => [`grafana/dashboards/d${i}.json`,
    JSON.stringify({ uid, title, schemaVersion: 39, panels: [{ type: 'timeseries', title: 'p', targets: [{ expr: 'up' }] }] })]));
  const crawled = crawlFiles(files, { repoName: 'ids', now: '2026-06-05T00:00:00.000Z' }).canonical.spec.dashboards;
  const byUid = Object.fromEntries(crawled.map(d => [d.params.uid, d.id]));
  const exported = UIDS.map(([uid, title]) => dashboardSpecId({ uid, title }));
  assert(JSON.stringify(exported) === JSON.stringify(UIDS.map(([uid]) => byUid[uid])),
    'dashboardSpecId gives the id the crawl writes for each of the seven uid shapes', exported, UIDS.map(([uid]) => byUid[uid]));
  assert(JSON.stringify(exported) === JSON.stringify(['node-exporter-full', 'd-9xyz-abc', 'a--b', 'd-3f1e9c0d2b8a4f6e9d7c5b3a1e0f2d4c', 'orders-main', 'fallback-title', 'payments-api-overview-with-a-very-long-uid-that-runs-past-si'])
    && dashboardSpecId({ uid: '', title: '' }) === null && dashboardSpecId(null) === null && dashboardSpecId({ uid: '%%' }) === null,
    'the rule pinned: `_` mapped, `--` kept, cut at 60, `d-` before a digit, the title when the uid yields nothing, null when neither does', exported);
}

// A compose file as people write them: a port bound to a host address is the
// container's, a value may stand on the line below its key, anchors and merge
// keys share settings between services.
{
  const compose = [
    'x-common: &common',
    '  restart: unless-stopped',
    'services:',
    '  grafana:',
    '    <<: *common',
    '    image: grafana/grafana:12.4.4',
    '    ports:',
    '      - "127.0.0.1:13000:3000"',
    '    environment: &env',
    '      GF_ADMIN:',
    '        ${CRED:-admin}',
    '  grafana-next:',
    '    <<: *common',
    '    image: grafana/grafana:13.0.2',
    '    ports: ["[::1]:13013:3000/tcp"]',
    '    environment: *env',
    '  prometheus:',
    '    image: prom/prometheus:v2.55.1',
    '    ports:',
    '      - target: 9090',
    '        published: 19090',
  ].join('\n') + '\n';
  const out = crawlFiles({ 'docker-compose.yml': compose }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  const backends = Object.values(out.canonical.spec.telemetry?.backends || {}).map((b) => `${b.product} ${b.version?.declared ?? ''} ${(b.endpoints || []).join(' ')}`).sort();
  assert(JSON.stringify(backends) === JSON.stringify(['grafana 12.4.4 http://grafana:3000', 'grafana 13.0.2 http://grafana:3000', 'prometheus 2.55.1 http://prometheus:9090']),
    'a compose file with anchors, merge keys and a value below its key is read whole, each backend at its container port', backends);
}

// A Helm template in the `helm create` layout — a helper's include alone
// under a key — is read as it always was: a component its environment's values
// switch off declares nothing from its template either.
{
  const files = {
    ...ENV_TOGGLE,
    'k8s/charts/app/templates/prometheus.yaml': [
      '{{- if .Values.prometheus.enabled }}',
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: {{ include "app.fullname" . }}-prometheus',
      '  labels:',
      '    {{- include "app.labels" . | nindent 4 }}',
      'spec:',
      '  selector:',
      '    matchLabels:',
      '      {{- include "app.selectorLabels" . | nindent 6 }}',
      '  template:',
      '    spec:',
      '      containers:',
      '        - name: prometheus',
      '          image: "prom/prometheus:{{ .Values.prometheus.image.tag }}"',
      '{{- end }}',
    ].join('\n') + '\n',
  };
  const eks = crawlFiles(files, { repoName: 'app', environment: 'eks', now: '2026-06-05T00:00:00.000Z' });
  assert(!products(eks).has('prometheus'), 'a template in the helm-create layout declares no backend its environment switches off', [...products(eks)]);
}
// A compose port given through a variable with a default drafts that default.
{
  const compose = 'services:\n  grafana:\n    image: grafana/grafana:12.4.4\n    ports:\n      - "${GRAFANA_PORT:-3000}:${GRAFANA_PORT:-3000}"\n  prometheus:\n    image: prom/prometheus:v2.55.1\n    ports: ["127.0.0.1:${PROM_PORT-19090}:9090"]\n';
  const out = crawlFiles({ 'docker-compose.yml': compose }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  const endpoints = Object.values(out.canonical.spec.telemetry?.backends || {}).map((b) => (b.endpoints || []).join(' ')).sort();
  assert(JSON.stringify(endpoints) === JSON.stringify(['http://grafana:3000', 'http://prometheus:9090']), 'a port written through a variable with a default drafts the container port', endpoints);
}
// One alias budget for a whole scan: each rule file fits it alone; past it the
// scan warns about each file it cannot read and carries on.
{
  const chain = ['          a0: &a0 [{a: 1, b: 2}]', ...Array.from({ length: 12 }, (_, k) => `          a${k + 1}: &a${k + 1} [*a${k}, *a${k}]`)].join('\n');
  const ruleFile = (i) => `groups:\n  - name: g${i}\n    rules:\n      - alert: Down${i}\n        expr: up{job="j${i}"} == 0\n        annotations:\n${chain}\n`;
  const t0 = Date.now();
  const out = crawlFiles(Object.fromEntries([0, 1, 2].map((i) => [`rules/r${i}.rules.yml`, ruleFile(i)])), { repoName: 'x', environment: 'prod', now: '2026-11-16T00:00:00.000Z' });
  const refused = out.summary.warnings.filter((w) => /aliases copy more than 1000000/.test(w));
  assert(refused.length === 2 && Date.now() - t0 < 3000, 'one alias budget for a scan: the files past it are reported, the scan goes on', out.summary.warnings);
}
// The other readers of repository files read a value below its key too: a
// team's .observability pack, a Chaos Mesh resource.
{
  const pack = [
    'apiVersion: observability.platform/v1', 'kind: ObservabilityPack', 'metadata: { name: shop-api, version: 0.1.0 }', 'spec:',
    '  baselines:', '    mttd_target_p50: 5m', '    mttr_target_p50: 45m', '    measurement_source:', '      grafana chaos game days, last run on 2026-11-01',
  ].join('\n') + '\n';
  const mesh = [
    'apiVersion: chaos-mesh.org/v1alpha1', 'kind: PodChaos', 'metadata:', '  name: api-pod-kill', '  annotations:', '    description:',
    '      Kill half the API pods for a minute', 'spec:', '  action: pod-kill', '  mode: fixed-percent', '  value: "50"', '  duration: 60s',
    '  selector: { labelSelectors: { app: shop-api } }',
  ].join('\n') + '\n';
  const out = crawlFiles({ '.observability/pack.yaml': pack, 'k8s/chaos/mesh.yaml': mesh }, { repoName: 'shop', environment: 'prod', now: '2026-11-16T00:00:00.000Z' });
  assert(out.canonical.spec.baselines?.mttd_target_p50 === '5m' && out.summary.inferred?.baselines !== true, 'a repository pack with a value below its key gives its baselines', out.canonical.spec.baselines);
  assert((out.canonical.spec.validation?.chaos_experiments || []).length > 0, 'a Chaos Mesh resource with a value below its key is read', out.canonical.spec.validation?.chaos_experiments);
}

// The alias budget is the walk's: alias-heavy files the scan only sniffs (a
// locale, a CI template) do not starve the files it reads.
{
  const locale = (lang) => [`${lang}: &${lang}`, ...Array.from({ length: 2400 }, (_, i) => `  message_${i}: "Text of message ${i} in ${lang}"`),
    `${lang}-GB: *${lang}`, `${lang}-AU: *${lang}`, `${lang}-CA: *${lang}`].join('\n') + '\n';
  const files = {
    'config/locales/web.yml': locale('en'),
    'config/locales/mail.yml': locale('fr'),
    'docker-compose.yml': 'x-logging: &logging\n  driver: json-file\nservices:\n  prometheus:\n    image: prom/prometheus:v2.55.1\n    logging: *logging\n    ports: ["9090:9090"]\n',
  };
  const out = crawlFiles(files, { repoName: 'shop', environment: 'prod', now: '2026-11-16T00:00:00.000Z' });
  assert(products(out).has('prometheus') && !out.summary.warnings.some((w) => /aliases copy more than/.test(w)),
    'alias-heavy files the scan only sniffs leave the budget to the files it reads', out.summary.warnings);
}
// Compose interpolation, nested and in the long form's target.
{
  const compose = 'services:\n  grafana:\n    image: grafana/grafana:12.4.4\n    ports: ["${CP:-${DEFAULT_PORT:-3000}}"]\n  prometheus:\n    image: prom/prometheus:v2.55.1\n    ports:\n      - target: ${PROM_TARGET:-9090}\n        published: 19090\n';
  const out = crawlFiles({ 'docker-compose.yml': compose }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  const endpoints = Object.values(out.canonical.spec.telemetry?.backends || {}).map((b) => (b.endpoints || []).join(' ')).sort();
  assert(JSON.stringify(endpoints) === JSON.stringify(['http://grafana:3000', 'http://prometheus:9090']), 'a nested default and a long-form target from a variable draft their ports', endpoints);
}

// ---------- a backend's image is named by the last segment of its path ----------
{
  const productOf = (ref) => BACKEND_PATTERNS.find((p) => p.match.test(ref))?.product ?? null;
  const sha = `sha256:${'0123456789abcdef'.repeat(4)}`;
  const cases = {
    // Under any registry or namespace, tagged, untagged or by digest, and behind a mirror's prefix.
    'prom/prometheus': 'prometheus', 'prom/prometheus:v2.55.1': 'prometheus', 'quay.io/prometheus/prometheus:v2.53.0': 'prometheus',
    'quay.io/prometheus/prometheus': 'prometheus', 'docker.io/bitnami/prometheus:2.53.0-debian-12-r0': 'prometheus',
    [`prom/prometheus@${sha}`]: 'prometheus', [`quay.io/prometheus/prometheus@${sha}`]: 'prometheus', [`prometheus@${sha}`]: 'prometheus',
    [`grafana/loki:3.0.0@${sha}`]: 'loki', 'localhost:5000/prometheus:v3': 'prometheus',
    // Docker Hardened Images, and a mirror that flattens the product's own organisation into the name.
    'acme/dhi-prometheus:3.5.0': 'prometheus', 'acme/dhi-alertmanager:0.28.1': 'alertmanager', 'acme/dhi-grafana:12.1.0': 'grafana', 'acme/dhi-loki:3.5.0': 'loki',
    'quay.io/acme/prometheus-prometheus:v2.53.0': 'prometheus', 'quay.io/acme/thanos-thanos:v0.35.1': 'thanos',
    'quay.io/acme/elasticsearch-elasticsearch:8.15.0': 'elasticsearch', 'quay.io/acme/timberio-vector:0.40.0-alpine': 'vector',
    'quay.io/acme/cilium-cilium:v1.15.0': 'cilium', 'acme/jaegertracing-jaeger:2.0.0': 'jaeger', 'acme/grafana-promtail:3.0.0': 'promtail',
    // No URL, address or short digest is an image: an `@` starts a digest, `@<algorithm>:<hex>`, at the end.
    'https://github.com/grafana/loki': null, 'grafana@alerts.example.com': null, 'git@github.com:grafana/loki': null,
    'prom/prometheus@sha256:0123456789abcdef': null, 'oci://registry.example/charts/prometheus:25.0.0': null,
    // A project's own build named for the product it builds on is the project's image, and an organisation's
    // prefix that is not the product's own is another image's — an exporter, a gateway, a controller.
    'shop-prometheus:latest': null, 'krystaline-grafana:dev': null, 'acme/ibmmq-prometheus:1.0': null, 'acme/flask-prometheus:1.0': null,
    'acme/prometheus-prometheus-exporter:1.0': null, 'acme/dhi-prometheus-pushgateway:1.10.0': null, 'acme/elasticsearch-exporter:1.7.0': null,
    'acme/thanos-receive-controller:0.1.0': null, 'acme/grafana-image-renderer-proxy:1.0': null,
    '${REGISTRY:-docker.io}/prom/prometheus:v2.53.0': 'prometheus', 'rancher/mirrored-prometheus-prometheus:v2.42.0': 'prometheus',
    'grafana/loki:3.0.0': 'loki', 'bitnami/grafana-loki:3.0.0': 'loki', 'grafana/tempo:2.4.0': 'tempo', 'bitnami/grafana-tempo:2.5.0': 'tempo',
    'grafana/mimir:2.13.0': 'mimir', 'bitnami/grafana-mimir:2.13.0': 'mimir', 'grafana/grafana:12.0.0': 'grafana',
    'bitnami/grafana:11.2.0': 'grafana', 'rancher/mirrored-grafana-grafana:9.1.5': 'grafana',
    'docker.elastic.co/elasticsearch/elasticsearch:8.15.0': 'elasticsearch', 'jaegertracing/jaeger:2.0.0': 'jaeger', 'bitnami/jaeger:1.62.0': 'jaeger',
    'quay.io/thanos/thanos:v0.35.1': 'thanos', 'thanosio/thanos:v0.35.1': 'thanos', 'prom/alertmanager:v0.27.0': 'alertmanager',
    'quay.io/prometheus/alertmanager:v0.27.0': 'alertmanager', 'rancher/mirrored-prometheus-alertmanager:v0.25.0': 'alertmanager',
    'quay.io/cilium/cilium:v1.15.0': 'cilium', 'timberio/vector:0.36.0-debian': 'vector', 'grafana/promtail:3.0.0': 'promtail',
    // A name that only holds the product's is another image: an exporter's, a plugin's, a look-alike's, a registry's host.
    'registry.example/mq/mq_prometheus:v6.0.0': null, 'ghcr.io/prometheus-community/windows-exporter:0.25.1': null,
    'grafana/fluent-plugin-loki:main': null, 'acme/team-grafana:1.4.0': null, 'acme/contempo:2.0': null, 'acme/otel-to-jaeger:1.0': null,
    'acme/kube-thanos:0.1.0': null, 'acme/sms-alertmanager:1.0': null, 'acme/kube-mimir:1.0': null, 'acme/app-elasticsearch:1.0': null,
    'acme/my-cilium:1.0': null, 'acme/log-vector:1.0': null, 'acme/k8s-promtail:1.0': null, 'prometheus:5000/app:1.0': null,
    'prom/blackbox-exporter:v0.25.0': null, 'quay.io/prometheuscommunity/postgres-exporter:v0.15.0': null,
    // A distribution's build keeps the product's name after its prefix.
    'quay.io/openshift/origin-prometheus:4.14': 'prometheus', 'registry.redhat.io/openshift4/ose-prometheus:v4.12': 'prometheus',
    'rancher/prom-prometheus:v2.18.2': 'prometheus', 'quay.io/openshift/origin-prometheus-alertmanager:4.14': 'alertmanager',
    'registry.redhat.io/openshift4/ose-prometheus-alertmanager:v4.12': 'alertmanager', 'rancher/prom-alertmanager:v0.21.0': 'alertmanager',
    'cgr.dev/chainguard/prometheus-alertmanager:latest': 'alertmanager', 'ubuntu/prometheus-alertmanager:0.25-22.04_stable': 'alertmanager',
    'rancher/grafana-grafana:7.1.5': 'grafana', 'quay.io/openshift/origin-grafana:4.10': 'grafana', 'quay.io/openshift/origin-thanos:4.14': 'thanos',
    // A bare word is no image reference: a values file's datasource, plugin or service name.
    Loki: null, prometheus: null, alertmanager: null, Tempo: null, mimir: null,
  };
  for (const [ref, want] of Object.entries(cases)) assert(productOf(ref) === want, `image ${ref}: ${want ?? 'no backend'}`, productOf(ref), want);
  const out = crawlFiles({ 'docker-compose.yml': 'services:\n  prometheus:\n    image: prom/prometheus:v2.55.1\n  mq-exporter:\n    image: registry.example/mq/mq_prometheus:v6.0.0\n' },
    { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  const drafted = (out.canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.id}`);
  assert(JSON.stringify(drafted) === JSON.stringify(['prometheus:metrics-prometheus']), 'an exporter beside Prometheus in a compose file is not drafted as a second Prometheus', drafted);
  // A values file's names (Grafana datasources, a Kong plugin, an ingress service, a remote-write target) draft nothing.
  const values = [
    'grafana:', '  image:', '    repository: grafana/grafana', '    tag: 11.2.0', '  datasources:', '    - name: Loki', '      url: https://logs.example', '    - name: Tempo',
    'kong:', '  plugins:', '    - name: prometheus', 'ingress:', '  backend:', '    service:', '      name: alertmanager', 'remoteWrite:', '  - name: mimir', '    url: https://mimir.example',
  ].join('\n') + '\n';
  const valuesScan = crawlFiles({ 'charts/obs/Chart.yaml': 'name: obs\nversion: 0.1.0\n', 'charts/obs/values.yaml': values }, { repoName: 'obs', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  const fromValues = (valuesScan.canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`);
  assert(JSON.stringify(fromValues) === JSON.stringify(['grafana:11.2.0']), 'names in a values file draft no backend; the image does, with its tag', fromValues);
  // A compose image as `docker compose config` resolves it with no variable set, and a tag read after the last `:`
  // no `/` follows. A version a variable's default gives is what runs where nothing sets it: declared, and said,
  // since a `.env` (no scan reads one) or the environment may set another.
  const compose = [
    'services:', '  prometheus:', '    image: ${REGISTRY}prometheus:v2.53.0', '  grafana:', '    image: ${GRAFANA_IMAGE:-grafana/grafana}:${GRAFANA_TAG:-11.2.0}',
    '  alertmanager:', '    image: registry.example:5000/prom/alertmanager', '  tempo:', `    image: grafana/tempo:2.4.0@${sha}`,
    '  loki:', '    image: grafana/loki:${LOKI_TAG:-3.0.0}', '  vector:', '    image: ${VECTOR_IMAGE:-timberio/vector:0.40.0-alpine}',
  ].join('\n') + '\n';
  const composeScan = crawlFiles({ 'docker-compose.yml': compose }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  const resolved = (composeScan.canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`).sort();
  assert(JSON.stringify(resolved) === JSON.stringify(['alertmanager:-', 'grafana:11.2.0', 'loki:3.0.0', 'prometheus:2.53.0', 'tempo:2.4.0', 'vector:0.40.0-alpine']),
    'compose images resolved as compose resolves them; a registry port or a digest is no version', resolved);
  const defaulted = composeScan.summary.warnings.filter((w) => /is the default its image names/.test(w));
  assert(JSON.stringify(defaulted) === JSON.stringify([
    'docker-compose.yml: the version 11.2.0 of grafana is the default its image names (${GRAFANA_IMAGE:-grafana/grafana}:${GRAFANA_TAG:-11.2.0}); a .env or the environment may set another, which the scan does not read.',
    'docker-compose.yml: the version 3.0.0 of loki is the default its image names (grafana/loki:${LOKI_TAG:-3.0.0}); a .env or the environment may set another, which the scan does not read.',
    'docker-compose.yml: the version 0.40.0-alpine of vector is the default its image names (${VECTOR_IMAGE:-timberio/vector:0.40.0-alpine}); a .env or the environment may set another, which the scan does not read.',
  ]), 'a version a variable\'s default gives is said; one the file writes out is not', defaulted);
  // A field that holds only an image reads a bare name as that image: a compose service's, a container's, a
  // values file's `image:` or image object; a values file's `name:` keeps it a word.
  const bare = crawlFiles({
    'docker-compose.yml': 'services:\n  prometheus:\n    build: ./prometheus\n    image: prometheus\n  dashboards:\n    image: grafana\n',
  }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  assert(JSON.stringify((bare.canonical.spec.telemetry?.backends || []).map((b) => b.product).sort()) === JSON.stringify(['grafana', 'prometheus']),
    'a compose service\'s bare image name is that image', (bare.canonical.spec.telemetry?.backends || []).map((b) => b.product));
  const workload = (img) => ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: obs', 'spec:', '  template:', '    spec:', '      containers:', '        - name: c', `          image: ${img}`].join('\n') + '\n';
  for (const [img, want, said] of [['grafana', 'grafana:-', false], ['${REGISTRY}prometheus:v2.53.0', 'prometheus:2.53.0', false], ['${REGISTRY:-harbor.example}/library/prometheus:${TAG:-v2.53.0}', 'prometheus:2.53.0', true]]) {
    const out = crawlFiles({ 'k8s/obs.yaml': workload(img) }, { repoName: 'obs', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
    const got = (out.canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`);
    assert(JSON.stringify(got) === JSON.stringify([want]) && out.summary.warnings.some((w) => /is the default its image names/.test(w)) === said,
      `a container image ${img}: ${want}${said ? ', the default said' : ''}`, [got, out.summary.warnings]);
  }
  const valuesImages = (doc) => (crawlFiles({ 'charts/obs/Chart.yaml': 'name: obs\nversion: 0.1.0\n', 'charts/obs/values.yaml': doc }, { repoName: 'obs', environment: 'all', now: '2026-11-16T00:00:00.000Z' })
    .canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`).sort();
  for (const [doc, want] of [
    ['search:\n  image: elasticsearch\n  imageTag: 8.15.0\n', ['elasticsearch:-']],
    ['prometheus:\n  image:\n    registry: harbor.corp.example\n    repository: prometheus\n    tag: ""\n', ['prometheus:-']],
    [`prometheus:\n  image:\n    repository: prometheus\n    digest: ${sha}\n`, ['prometheus:-']],
    ['loki:\n  image:\n    registry: docker.io\n    repository: grafana/loki\n    tag: 3.0.0\n', ['loki:3.0.0']],
    ['sources:\n  - repo: https://github.com/grafana/loki\n  - repo: git@github.com:grafana/tempo\nalerting:\n  contact:\n    name: grafana@alerts.example.com\n', []],
    ['datasources:\n  - name: Loki\n  - name: prometheus\n', []],
    // A registry joined to a row anchored at its namespace, and a digest given as its hex alone, keep the version.
    ['alloy:\n  image:\n    registry: docker.io\n    repository: grafana/alloy\n    tag: v1.4.2\n', ['alloy:1.4.2']],
    [`grafana:\n  image:\n    repository: grafana/grafana\n    tag: 11.2.0\n    digest: ${'0123456789abcdef'.repeat(4)}\n`, ['grafana:11.2.0']],
  ]) assert(JSON.stringify(valuesImages(doc)) === JSON.stringify(want), `values ${JSON.stringify(doc.split('\n')[1].trim())}: ${JSON.stringify(want)}`, valuesImages(doc));
  // A tag or a digest a deploy step fills in leaves the name the image's, with no version: compose's `$VAR`, an
  // Azure DevOps `#{Token}#`, a variable before a fixed suffix, a digest from a variable.
  const filled = crawlFiles({ 'docker-compose.yml': [
    'services:', '  prometheus:', '    image: quay.io/prometheus/prometheus:$PROMETHEUS_VERSION', '  alertmanager:', '    image: quay.io/prometheus/alertmanager:#{AlertmanagerVersion}#',
    '  loki:', '    image: docker.io/bitnami/grafana-loki:${LOKI_VERSION}-debian-12-r3', '  grafana:', '    image: grafana/grafana@sha256:${GRAFANA_DIGEST}',
    '  dashboards:', '    image: ${GRAFANA_IMAGE}',
  ].join('\n') + '\n' }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  assert(JSON.stringify((filled.canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`).sort()) === JSON.stringify(['alertmanager:-', 'grafana:-', 'loki:-', 'prometheus:-'])
    && filled.summary.warnings.includes('docker-compose.yml: the image of dashboards is a variable (${GRAFANA_IMAGE}) a .env or the environment sets, which the scan does not read; no backend is drafted from it.'),
  'a tag or a digest a deploy step fills in drafts the product with no version; an image that is wholly a variable is said', [(filled.canonical.spec.telemetry?.backends || []).map((b) => b.product), filled.summary.warnings]);
  // A version whose numbers the file writes out is not called a default; an OpenShift build's tag is the
  // platform's release; a tag the chart fills in after its numbers gives those numbers.
  const variants = crawlFiles({ 'docker-compose.yml': 'services:\n  grafana:\n    image: grafana/grafana:11.2.0${GRAFANA_VARIANT}\n  prometheus:\n    image: registry.redhat.io/openshift4/ose-prometheus:v4.12\n' },
    { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  assert(JSON.stringify((variants.canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`).sort()) === JSON.stringify(['grafana:11.2.0', 'prometheus:-'])
    && !variants.summary.warnings.some((w) => /is the default its image names/.test(w))
    && variants.summary.warnings.includes('docker-compose.yml: registry.redhat.io/openshift4/ose-prometheus:v4.12 is an OpenShift build of prometheus: its tag v4.12 is the platform\'s release, not prometheus\'s, so no version is declared.'),
  'a version written out before a variable suffix is the file\'s; an OpenShift build declares no version, and says why', variants.summary.warnings);
  const chartDigest = crawlFiles({ 'charts/obs/Chart.yaml': 'name: obs\nversion: 0.1.0\n', 'charts/obs/templates/deploy.yaml': workload('"quay.io/prometheus/prometheus@sha256:{{ .Values.prometheus.digest }}"') },
    { repoName: 'obs', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  assert(JSON.stringify((chartDigest.canonical.spec.telemetry?.backends || []).map((b) => b.product)) === JSON.stringify(['prometheus']), 'a digest the chart fills in leaves the image its product', chartDigest.summary.warnings);
  const chartTag = crawlFiles({ 'charts/obs/Chart.yaml': 'name: obs\nversion: 0.1.0\n', 'charts/obs/templates/deploy.yaml': workload('"grafana/grafana:11.2.0-{{ .Values.grafana.variant }}"') },
    { repoName: 'obs', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  assert(JSON.stringify((chartTag.canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`)) === JSON.stringify(['grafana:11.2.0']),
    'a tag the chart fills in after its numbers gives those numbers', (chartTag.canonical.spec.telemetry?.backends || []).map((b) => b.version));
  // OpenSearch is its own product, and the official images of the rows anchored at a namespace are named under a registry.
  const scannedProduct = (ref) => { const out = crawlFiles({ 'docker-compose.yml': `services:\n  x:\n    image: "${ref}"\n` }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' }); return (out.canonical.spec.telemetry?.backends || []).map((b) => b.product).join(',') || null; };
  for (const [ref, want] of [
    ['opensearchproject/opensearch:2.16.0', 'opensearch'], ['opensearchproject/opensearch-dashboards:2.16.0', null], ['opensearchproject/data-prepper:2.8.0', null],
    ['quay.io/prometheus/node-exporter:v1.8.2', 'node-exporter'], ['docker.io/grafana/alloy:v1.4.2', 'alloy'], ['docker.io/library/traefik:v3.1.2', 'traefik'],
    ['rancher/mirrored-library-traefik:2.10.7', 'traefik'], ['docker.io/envoyproxy/envoy:distroless-v1.31.0', 'envoy'], ['docker.io/hashicorp/consul:1.19.0', 'consul'],
    ['docker.io/openpolicyagent/opa:0.67.1', 'opa'], ['rancher/mirrored-cilium-cilium-envoy:v1.29.7', null],
    // The vendors' own product images by name under a registry or a pull-through cache, and none of their companions.
    ['docker.io/kong/kong-gateway:3.9.0.1', 'kong'], ['123456789012.dkr.ecr.eu-west-1.amazonaws.com/docker-hub/kong/kong-gateway:3.9.0.1', 'kong'],
    ['docker.io/hashicorp/consul-enterprise:1.19.2-ent', 'consul'], ['docker.io/envoyproxy/envoy-contrib:v1.31.0', 'envoy'],
    ['harbor.corp.example/dockerhub/envoyproxy/envoy-distroless:v1.24.0', 'envoy'], ['kong/kong:3.9', 'kong'],
    ['hashicorp/consul-k8s-control-plane:1.5.0', null], ['hashicorp/consul-dataplane:1.5.0', null], ['envoyproxy/envoy-build-ubuntu:f94a38f62220a2b017878b790b6ea98a0f6c5f9c', null],
    ['grafana/alloy-operator:0.3.0', null], ['kong/kubernetes-ingress-controller:3.3', null],
    // Their variants stack — a dev build of each, Windows, FIPS, the nightlies, a pre-release — and the companions' own
    // variants stay companions.
    ['envoyproxy/envoy-distroless-dev:3b5ab3fd', 'envoy'], ['envoyproxy/envoy-contrib-debug-dev:3b5ab3fd', 'envoy'], ['envoyproxy/envoy-windows:v1.25.3', 'envoy'],
    ['envoyproxy/envoy-windows-ltsc2022-dev:3b5ab3fd', 'envoy'], ['docker.io/hashicorp/consul-enterprise-fips:1.19.2-ent', 'consul'],
    ['kong/kong-gateway-dev:3.8.0.0', 'kong'], ['kong/kong-dev:3.8.0', 'kong'], ['grafana/alloy-dev:v1.14.0-devel-ca637d8', 'alloy'],
    ['envoyproxy/envoy-tools-dev:3b5ab3fd', null], ['hashicorp/consul-dataplane-fips:1.5.3', null], ['hashicorp/consul-k8s-control-plane-fips:1.5.3', null],
    ['kong/kong-gateway-operator:1.3', null],
  ]) assert(scannedProduct(ref) === want, `scanned image ${ref}: ${want ?? 'no backend'}`, scannedProduct(ref));
  // A tag a chart or a deploy step fills in after its numbers gives those numbers; one that continues them, none.
  const chartVersion = (tag) => (crawlFiles({ 'charts/obs/Chart.yaml': 'name: obs\nversion: 0.1.0\n', 'charts/obs/templates/deploy.yaml': workload(`"quay.io/prometheus/prometheus:${tag}"`) },
    { repoName: 'obs', environment: 'all', now: '2026-11-16T00:00:00.000Z' }).canonical.spec.telemetry?.backends || []).map((b) => `${b.product}:${b.version?.declared ?? '-'}`).join(',');
  for (const [tag, want] of [['v2.39.1{{ .Values.suffix }}', 'prometheus:2.39.1'], ['v2.39.1-#{Distro}#', 'prometheus:2.39.1'], ['v2.{{ .Values.minor }}', 'prometheus:-'], ['{{ .Values.image.tag }}', 'prometheus:-']]) {
    assert(chartVersion(tag) === want, `a chart's tag ${tag}: ${want}`, chartVersion(tag));
  }
  // An OpenShift build under a registry the chart fills in is said with the chart's value as `…`.
  const openshift = crawlFiles({ 'charts/obs/Chart.yaml': 'name: obs\nversion: 0.1.0\n', 'charts/obs/templates/deploy.yaml': workload('"{{ .Values.global.imageRegistry }}/openshift4/ose-prometheus:v4.12"') },
    { repoName: 'obs', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  assert(openshift.summary.warnings.includes('charts/obs/templates/deploy.yaml: …/openshift4/ose-prometheus:v4.12 is an OpenShift build of prometheus: its tag v4.12 is the platform\'s release, not prometheus\'s, so no version is declared.')
    && !JSON.stringify(openshift.summary.warnings).includes('helmvalue'), 'an OpenShift build is said with the value the chart fills in shown as …', openshift.summary.warnings);
  // An image whose variables leave it no name is said like a wholly variable one; a service compose builds is not.
  const nameless = crawlFiles({ 'docker-compose.yml': [
    'services:', '  a:', '    image: ${REGISTRY}/${GRAFANA_IMAGE}:${GRAFANA_TAG}', '  b:', '    image: ${GRAFANA_REPO}:${GRAFANA_TAG:-11.2.0}', '  c:', '    image: $REGISTRY/$IMAGE:$TAG',
    '  app:', '    build: ./app', '    image: ${IMAGE_NAME}:${DEMO_VERSION}-frontend', '  built:', '    build: .', '    image: ${APP_IMAGE}',
    '  web:', '    extends: built', '    image: ${WEB_IMAGE}', '  api:', '    extends:', '      service: web', '    image: ${REGISTRY}/${API_IMAGE}:${TAG}',
    '  shared:', '    extends:', '      file: common.yml', '      service: app', '    image: ${SHARED_IMAGE}', '  loop:', '    extends: loop', '    image: ${LOOP_IMAGE}',
  ].join('\n') + '\n' }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  const saidOf = (out) => out.summary.warnings.filter((w) => /is a variable \(/.test(w)).map((w) => /the image of (\S+) is/.exec(w)[1]);
  assert(JSON.stringify(saidOf(nameless)) === JSON.stringify(['a', 'b', 'c', 'shared', 'loop']), 'an image the variables leave no name is said; a service compose builds, or one that extends it in this file, is not', nameless.summary.warnings);
  // Image reading stays linear in a value's length.
  const t0 = Date.now();
  crawlFiles({ 'docker-compose.yml': `services:\n  x:\n    image: "${':'.repeat(200000)}x"\n  y:\n    image: "\${${'A'.repeat(200000)}"\n` }, { repoName: 'lab', environment: 'dev', now: '2026-11-16T00:00:00.000Z' });
  assert(Date.now() - t0 < 2000, `image values of 200,000 characters read in ${Date.now() - t0} ms`, Date.now() - t0);
}

// ---------- a Prometheus Operator PrometheusRule is read as a rule file is ----------
{
  const groups = [
    'groups:', '  - name: checkout', '    rules:',
    '      - record: checkout:errors:ratio_5m', '        expr: sum(rate(errors_total[5m])) / sum(rate(requests_total[5m]))',
    '      - alert: CheckoutErrorsHigh', '        expr: checkout:errors:ratio_5m > 0.01', '        for: 5m', '        labels:', '          severity: critical',
    '      - alert: CheckoutPodRestarting', '        expr: rate(kube_pod_container_status_restarts_total{container="checkout"}[15m]) > 0',
    '        labels:', '          severity: warning',
  ].map((l) => `  ${l}`);
  const resource = (head = ['  labels:', '    release: kube-prometheus-stack']) => ['apiVersion: monitoring.coreos.com/v1', 'kind: PrometheusRule', 'metadata:', '  name: checkout', ...head, 'spec:', ...groups].join('\n') + '\n';
  const deployment = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata:', '  name: grafana', 'spec:', '  template:', '    spec:', '      containers:',
    '        - name: grafana', '          image: grafana/grafana:11.2.0'].join('\n') + '\n';
  const chart = { 'charts/checkout/Chart.yaml': 'name: checkout\nversion: 0.1.0\n' };
  const read = (files) => crawlFiles(files, { repoName: 'checkout', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  const rulesOf = (out) => [
    ...(out.canonical.spec.alerting?.rules || []).map((r) => `${r.name}@${r.engine}`),
    ...(out.canonical.spec.policy?.burn_rate_alerts || []).map((e) => `policy:${e.slo}`),
    ...(out.canonical.spec.queries?.recording_rules || []).map((r) => `record:${r.name}`),
  ].sort();
  const want = ['CheckoutPodRestarting@prometheus', 'policy:checkout_errors_99', 'record:checkout:errors:ratio_5m'];
  const stated = (out) => Object.keys(out.canonical.metadata.annotations).filter((k) => k.startsWith('observogram.source_rules.'));
  for (const [what, files, kind, backends] of [
    ['in a file named for its rules', { 'k8s/prometheusrule.yaml': resource() }, 'prometheus-rules', []],
    ['in a file named for nothing', { 'deploy/monitoring.yaml': resource() }, 'prometheus-rules', []],
    ['after a Namespace in one manifest', { 'deploy/app.yaml': `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: shop\n---\n${resource()}` }, 'prometheus-rules', []],
    ['after a Deployment in one manifest', { 'deploy/app.yaml': `${deployment}---\n${resource()}` }, 'k8s-workload', ['grafana']],
    ['before a Deployment in one manifest', { 'deploy/app.yaml': `${resource()}---\n${deployment}` }, 'prometheus-rules', ['grafana']],
    ['under a path that names Loki: still a Prometheus rule', { 'monitoring/loki/prometheusrule.yaml': resource() }, 'prometheus-rules', []],
    ['in a Helm template, its values inline', { ...chart, 'charts/checkout/templates/prometheusrule.yaml': `{{- if .Values.rules.enabled }}\n${resource(['  labels:', '    release: {{ .Release.Name }}'])}{{- end }}\n` }, 'helm-template', []],
    ['in a Helm template whose labels are an include', { ...chart, 'charts/checkout/templates/prometheusrule.yaml': resource(['  labels:', '    {{- include "checkout.labels" . | nindent 4 }}']) }, 'helm-template', []],
    ['in a Helm template whose labels end in an include at the margin', { ...chart, 'charts/checkout/templates/prometheusrule.yaml': resource(['  labels:', '    app: {{ template "checkout.name" . }}', '{{ include "checkout.labels" . | indent 4 }}']) }, 'helm-template', []],
  ]) {
    const out = read(files);
    const path = Object.keys(files).find((p) => !p.endsWith('Chart.yaml'));
    assert(detectArtefactKind(path, files[path]) === kind, `PrometheusRule ${what}: the file is ${kind}`, detectArtefactKind(path, files[path]), kind);
    assert(JSON.stringify(rulesOf(out)) === JSON.stringify(want), `PrometheusRule ${what}: its rules are read`, rulesOf(out), want);
    assert(JSON.stringify(stated(out)) === JSON.stringify(['observogram.source_rules.policy.burn_rate_alerts.checkout_errors_99']), `PrometheusRule ${what}: the SLO states its rule`, stated(out));
    assert(JSON.stringify([...products(out)]) === JSON.stringify(backends), `PrometheusRule ${what}: backends ${JSON.stringify(backends)}`, [...products(out)], backends);
    assert(!out.summary.warnings.some((w) => /stopped reading|Failed to parse|not declared/.test(w)), `PrometheusRule ${what}: nothing to warn about`, out.summary.warnings);
  }
  // A template holding a dashboard ConfigMap and a PrometheusRule: both are read.
  const both = read({ ...chart, 'charts/checkout/templates/monitoring.yaml': [
    'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: {{ include "checkout.fullname" . }}-dashboards', 'data:', '  checkout.json: |',
    '    {"title": "Checkout", "uid": "checkout", "schemaVersion": 39, "panels": [{"type": "timeseries", "title": "Errors", "targets": [{"expr": "checkout:errors:ratio_5m"}]}]}',
    '---', resource(),
  ].join('\n') });
  assert(JSON.stringify(rulesOf(both)) === JSON.stringify(want) && (both.canonical.spec.dashboards || []).length === 1,
    'a template holding a dashboard ConfigMap and a PrometheusRule gives both', [rulesOf(both), both.canonical.spec.dashboards]);
  // Another kind, or another group's resource of that name, is not one.
  for (const [what, text] of [
    ['a PrometheusRule of another API group', resource().replace('monitoring.coreos.com/v1', 'monitoring.example.com/v1')],
    ['a resource of another kind with spec.groups', resource().replace('kind: PrometheusRule', 'kind: RuleSet')],
  ]) {
    const out = read({ 'deploy/monitoring.yaml': text });
    assert(detectArtefactKind('deploy/monitoring.yaml', text) === 'unknown' && out.summary.discovered.recordingRules === 0 && out.summary.discovered.burnRateAlerts === 0,
      `not a PrometheusRule: ${what}`, out.summary.discovered);
  }
  // A resource's rule in LogQL is a Loki ruler's (Grafana Alloy loads PrometheusRule resources into one).
  const logql = read({ 'k8s/prometheusrule.yaml': resource().replace('rate(kube_pod_container_status_restarts_total{container="checkout"}[15m]) > 0', 'sum(rate({app="checkout"} |= "error" [5m])) > 10') });
  assert(JSON.stringify(rulesOf(logql)) === JSON.stringify(['CheckoutPodRestarting@loki', 'policy:checkout_errors_99', 'record:checkout:errors:ratio_5m']), 'a resource\'s LogQL rule is the loki engine\'s', rulesOf(logql));
  // Whatever the file is called: named for a collector or an Alertmanager, a resource is read beside what the file is read as.
  for (const path of ['k8s/otel-collector.yaml', 'k8s/collector-rules.yaml', 'k8s/alertmanager.yaml']) {
    assert(JSON.stringify(rulesOf(read({ [path]: `${deployment}---\n${resource()}` }))) === JSON.stringify(want), `a resource in ${path} is read`, rulesOf(read({ [path]: `${deployment}---\n${resource()}` })));
  }
  // A template with a byte-order mark, and one whose apiVersion the chart fills in.
  const bom = read({ ...chart, 'charts/checkout/templates/prometheusrule.yaml': `${String.fromCharCode(0xFEFF)}${resource()}` });
  assert(JSON.stringify(rulesOf(bom)) === JSON.stringify(want), 'a template with a byte-order mark is read', rulesOf(bom));
  const templatedApi = read({ ...chart, 'charts/checkout/templates/prometheusrule.yaml': resource().replace('apiVersion: monitoring.coreos.com/v1', 'apiVersion: {{ include "checkout.prometheusRule.apiVersion" . }}') });
  assert(JSON.stringify(rulesOf(templatedApi)) === JSON.stringify(want), 'a template whose apiVersion the chart fills in is read', rulesOf(templatedApi));
  // A rule a chart's include gives more labels (an include alone on a line): the include is not read, the rule is,
  // held to the labels it writes — `observogram.partial` on the operational rule, `partial` on the SLO's rule.
  const template = (text) => read({ ...chart, 'charts/checkout/templates/prometheusrule.yaml': text });
  const partialOf = (out) => [
    out.canonical.metadata.annotations['observogram.partial.alerting.rules[0]'] ?? null,
    JSON.parse(out.canonical.metadata.annotations['observogram.source_rules.policy.burn_rate_alerts.checkout_errors_99'] ?? '[]').map((r) => r.partial ?? null),
  ];
  const quiet = (out) => !out.summary.warnings.some((w) => /stopped reading|Failed to parse|not declared/.test(w));
  const withLabels = (burn, operational) => resource()
    .replace('          labels:\n            severity: critical', `          labels:\n            severity: critical\n${burn}`)
    .replace('            severity: warning', `            severity: warning\n${operational}`);
  for (const [what, text] of [
    // kube-prometheus-stack's way: at the margin, behind a switch, its column its `indent` argument.
    ['at the margin, its column its indent', withLabels('{{- if .Values.extraLabels }}\n{{ toYaml .Values.extraLabels | indent 12 }}\n{{- end }}',
      '{{- if .Values.extraLabels }}\n{{ toYaml .Values.extraLabels | indent 12 }}\n{{- end }}')],
    // The `nindent` way, before the labels it writes, or on one line with its switch.
    ['indented, before the labels written', resource()
      .replace('          labels:\n            severity: critical', '          labels:\n            {{- toYaml .Values.extraLabels | nindent 12 }}\n            severity: critical')
      .replace('          labels:\n            severity: warning', '          labels:\n            {{- toYaml .Values.extraLabels | nindent 12 }}\n            severity: warning')],
    ['on one line with its switch', withLabels('            {{- with .Values.extraLabels }}{{ toYaml . | nindent 12 }}{{- end }}', '            {{- with .Values.extraLabels }}{{ toYaml . | nindent 12 }}{{- end }}')],
  ]) {
    const out = template(text);
    assert(JSON.stringify(rulesOf(out)) === JSON.stringify(want) && quiet(out)
      && JSON.stringify(partialOf(out)) === JSON.stringify(['labels=severity', [{ labels: ['severity'] }]]),
    `a PrometheusRule template whose rules' labels an include extends (${what}): every rule read, held to the labels it writes`, [rulesOf(out), partialOf(out), out.summary.warnings]);
  }
  // An include in a rule's own keys, or deeper than the scalar above it: its labels are not known at all, its wait is.
  const ruleKeys = template(resource().replace('          labels:\n            severity: warning', '          {{- include "checkout.ruleLabels" . | nindent 10 }}'));
  assert(JSON.stringify(rulesOf(ruleKeys)) === JSON.stringify(want) && quiet(ruleKeys) && partialOf(ruleKeys)[0] === 'labels=',
    'an include among a rule\'s keys: the rule read, held to no labels', [rulesOf(ruleKeys), partialOf(ruleKeys), ruleKeys.summary.warnings]);
  const deeper = template(resource().replace('        for: 5m', '        for: 5m\n              {{- include "checkout.ruleExtras" . | nindent 14 }}'));
  const burnRule = JSON.parse(deeper.canonical.metadata.annotations['observogram.source_rules.policy.burn_rate_alerts.checkout_errors_99'] ?? '[]')[0];
  // (beside the rule's keys, where it cannot add to the labels map the rule writes: the rule is whole)
  assert(quiet(deeper) && burnRule?.for === '5m' && burnRule?.severity === 'SEV1' && burnRule?.partial === undefined,
    'an include deeper than the scalar above it: that scalar as written, the rule\'s own labels whole', [burnRule, deeper.summary.warnings]);
  // An include that renders more rules (a list's items) or more groups: the rules written around it are whole.
  const moreRules = template(resource().replace('            severity: warning', '            severity: warning\n        {{- with .Values.additionalRules }}{{ toYaml . | nindent 8 }}{{- end }}\n{{ toYaml .Values.additionalGroups | indent 4 }}'));
  assert(JSON.stringify(rulesOf(moreRules)) === JSON.stringify(want) && quiet(moreRules) && JSON.stringify(partialOf(moreRules)) === JSON.stringify([null, [null]]),
    'an include that renders more rules or groups: the rules written are read whole', [rulesOf(moreRules), partialOf(moreRules), moreRules.summary.warnings]);
  // A rule the chart names from its values is not declared: which rules it renders is not known; the scan says so.
  const named = template(resource().replace('- alert: CheckoutPodRestarting', '- alert: {{ .Values.prefix }}PodRestarting'));
  assert(JSON.stringify(rulesOf(named)) === JSON.stringify(['policy:checkout_errors_99', 'record:checkout:errors:ratio_5m'])
    && named.summary.warnings.includes('1 rule(s) are not declared: each takes its name from a value filled in at deploy time (a chart\'s values, a deploy step\'s variable), so which rules it renders is not known here — …PodRestarting (charts/checkout/templates/prometheusrule.yaml).'),
    'a rule the chart names from its values is not declared, and said', [rulesOf(named), named.summary.warnings]);
  // ...and the metrics its expression reads stay in the inventory.
  assert(JSON.stringify(named.canonical).includes('kube_pod_container_status_restarts_total'), 'a chart-named rule\'s metrics stay in the inventory');
  // Where every recording rule is named so, the repository records series all the same: its alerts stay operational rules.
  const recordNamed = template(resource().replace('- record: checkout:errors:ratio_5m', '- record: {{ .Values.prefix }}:errors:ratio_5m'));
  assert(JSON.stringify((recordNamed.canonical.spec.alerting?.rules || []).map((r) => r.name).sort()) === JSON.stringify(['CheckoutErrorsHigh', 'CheckoutPodRestarting'])
    && !(recordNamed.canonical.spec.policy?.burn_rate_alerts || []).some((e) => /checkout/.test(e.slo)),
  'where every recording rule is named at deploy time, the alerts stay operational, no SLO read from their names', [rulesOf(recordNamed), recordNamed.summary.warnings]);
  // ...and a lifecycle block over them covers those operational rules, never SLOs read from their names.
  const recordNamedPlanned = read({ 'deploy/app.yaml': `# observogram-lifecycle:\n#   deployment:\n#     prod: planned\n${deployment}---\n${resource().replace('- record: checkout:errors:ratio_5m', '- record: ${PREFIX}:errors:ratio_5m')}` });
  const recordNamedSymbols = JSON.parse(recordNamedPlanned.canonical.metadata.annotations['observogram.lifecycle'] ?? '[]')[0]?.symbols ?? [];
  assert(['alerting.rules.CheckoutErrorsHigh', 'alerting.rules.CheckoutPodRestarting'].every((s) => recordNamedSymbols.includes(s)) && !recordNamedSymbols.some((s) => /^(?:slis|slos|policy)\./.test(s)),
    'a lifecycle block over rules whose recording rules are all named at deploy time covers the operational rules', recordNamedSymbols);
  // A template action that prints a scalar is the placeholder, never a key: the rest of a plain scalar (a threshold on
  // the line below), or a key's value below it.
  const threshold = template(resource().replace('          expr: checkout:errors:ratio_5m > 0.01', '          expr: checkout:errors:ratio_5m >\n            {{ .Values.slo.threshold }}'));
  assert(JSON.stringify(rulesOf(threshold)) === JSON.stringify(want) && quiet(threshold) && stated(threshold).length === 0,
    'a threshold on the line below its expression continues it: the SLO\'s rule holds the chart\'s value, and states no rules', [rulesOf(threshold), stated(threshold)]);
  const below = template(resource().replace('            severity: warning', '            severity:\n              {{ .Values.alerts.severity }}'));
  assert(!JSON.stringify(below.canonical).includes('observogram.include') && JSON.stringify(rulesOf(below)) === JSON.stringify(want)
    && below.canonical.spec.alerting.rules[0].severity === undefined && below.canonical.metadata.annotations['observogram.partial.alerting.rules[0]'] === 'labels.filled=severity;labels=',
  'a value printed below its key is the chart\'s: no severity invented, no mark in the pack', [below.canonical.spec.alerting.rules, below.canonical.metadata.annotations['observogram.partial.alerting.rules[0]']]);
  // An include right after a block scalar, at the rule's keys, ends the scalar.
  const afterScalar = template(resource().replace('          expr: rate(kube_pod_container_status_restarts_total{container="checkout"}[15m]) > 0',
    '          expr: |\n            rate(kube_pod_container_status_restarts_total{container="checkout"}[15m]) > 0\n          {{- include "checkout.ruleExtras" . | nindent 10 }}'));
  assert(JSON.stringify(rulesOf(afterScalar)) === JSON.stringify(want) && quiet(afterScalar), 'an include after a block scalar ends it: every rule read', [rulesOf(afterScalar), afterScalar.summary.warnings]);
  // An indentless list (`rules:` and its items in one column) with a hook before its first item.
  const indentless = template(['apiVersion: monitoring.coreos.com/v1', 'kind: PrometheusRule', 'metadata:', '  name: checkout', 'spec:', '  groups:', '  - name: checkout', '    rules:',
    '    {{- with .Values.additionalRules }}{{ toYaml . | nindent 4 }}{{- end }}', '    - alert: CheckoutDown', '      expr: up{job="checkout"} == 0', '    - alert: CheckoutSlow', '      expr: checkout_latency_seconds > 1'].join('\n') + '\n');
  assert(JSON.stringify(rulesOf(indentless)) === JSON.stringify(['policy:checkoutdown', 'policy:checkoutslow']) && quiet(indentless), 'an indentless list with a hook first: every rule read', [rulesOf(indentless), indentless.summary.warnings]);
  // A bare rules template (no ConfigMap, no resource) whose include sits in a rule's labels.
  const bare = read({ ...chart, 'charts/checkout/templates/rules.yaml': ['groups:', '  - name: checkout', '    rules:', '      - alert: CheckoutDown', '        expr: up{job="checkout"} == 0', '        labels:', '          severity: critical', '          {{- include "checkout.labels" . | nindent 10 }}'].join('\n') + '\n' });
  assert(JSON.stringify(rulesOf(bare)) === JSON.stringify(['policy:checkoutdown']), 'a bare rules template with an include in its labels is read', [rulesOf(bare), bare.summary.warnings]);
  // An indent the chart computes renders beside the line above it; an indent past any line of the text is bounded.
  const computed = template(resource().replace('            severity: warning', '            severity: warning\n{{ toYaml .Values.extraLabels | indent (int .Values.labelIndent) }}'));
  assert(partialOf(computed)[0] === 'labels=severity', 'an include with a computed indent extends the labels above it', partialOf(computed));
  const t0 = Date.now();
  const huge = template(resource().replace('            severity: warning', '            severity: warning\n            {{- toYaml .Values.extraLabels | nindent 107000000 }}'));
  assert(Date.now() - t0 < 2000 && partialOf(huge)[0] === 'labels=severity', `an indent of a hundred million columns reads in ${Date.now() - t0} ms`, partialOf(huge));
  // A lifecycle block at the top of a manifest covers the rules of its resource, the manifest's first document a workload.
  const planned = read({ 'deploy/app.yaml': `# observogram-lifecycle:\n#   deployment:\n#     prod: planned\n${deployment}---\n${resource()}` });
  const lifecycle = JSON.parse(planned.canonical.metadata.annotations['observogram.lifecycle'] ?? '[]');
  assert(lifecycle.length === 1 && lifecycle[0].source === 'deploy/app.yaml'
    && ['alerting.rules.CheckoutPodRestarting', 'policy.burn_rate_alerts.checkout_errors_99', 'queries.recording_rules.checkout:errors:ratio_5m'].every((s) => lifecycle[0].symbols.includes(s)),
    'a lifecycle block atop a manifest covers its PrometheusRule\'s rules', lifecycle);
  // Only the documents a manifest holds that are workloads give backends; a Service first no longer hides them.
  const service = read({ 'deploy/app.yaml': `apiVersion: v1\nkind: Service\nmetadata:\n  name: grafana\nspec:\n  ports: [{ port: 3000 }]\n---\n${deployment}` });
  assert(products(service).has('grafana') && detectArtefactKind('deploy/app.yaml', `apiVersion: v1\nkind: Service\nmetadata:\n  name: grafana\n---\n${deployment}`) === 'k8s-workload',
    'a workload after a Service in one manifest gives its image', [...products(service)]);
}

// ---------- one name, two engines: a Grafana-managed rule and a Prometheus rule are two rules, not two forms of one ----------
{
  const out = crawlFiles({
    'prometheus/recording.yml': 'groups:\n  - name: rec\n    rules:\n      - record: shop:checkout:error_ratio_5m\n        expr: sum(rate(e[5m])) / sum(rate(t[5m]))\n',
    'prometheus/alerts.rules.yml': 'groups:\n  - name: stack\n    rules:\n      - alert: StackDown\n        expr: up{job="stack"} == 0\n        for: 5m\n',
    'grafana/provisioning/alerting/stack.yaml': [
      'apiVersion: 1', 'groups:', '  - orgId: 1', '    name: stack', '    folder: stack', '    interval: 1m', '    rules:', '      - uid: stack-down', '        title: StackDown', '        condition: A',
      '        data:', '          - refId: A', '            datasourceUid: prom', '            model:', '              expr: up{job="stack"} == 0', '        for: 5m',
    ].join('\n') + '\n',
  }, { repoName: 'stack', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  const declared = (out.canonical.spec.alerting?.rules || []).map((r) => `${r.name}@${r.engine}`).sort();
  assert(JSON.stringify(declared) === JSON.stringify(['StackDown@grafana', 'StackDown@prometheus']) && !out.summary.warnings.some((w) => /written differently|written the same/.test(w)),
    'a Grafana-managed rule and a Prometheus rule of one name are both declared, neither a copy of the other', [declared, out.summary.warnings]);
}

// ---------- copies the comparison reads the same are one rule; resources that write a rule differently are said ----------
{
  const scanOf = (files) => crawlFiles(files, { repoName: 'shop', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  const ruleFile = (alert, interval = '') => ['groups:', '  - name: shop', ...(interval ? [`    interval: ${interval}`] : []), '    rules:',
    '      - record: shop:checkout:error_ratio_5m', '        expr: sum(rate(e[5m])) / sum(rate(t[5m]))', ...alert].join('\n') + '\n';
  const wrap = (text) => ['apiVersion: monitoring.coreos.com/v1', 'kind: PrometheusRule', 'metadata:', '  name: shop', 'spec:', ...text.trimEnd().split('\n').map((l) => `  ${l}`)].join('\n') + '\n';
  const disk = ['      - alert: DiskAlmostFull', '        expr: node_filesystem_avail_bytes < 1', '        labels:', '          severity: warning'];
  for (const [what, other] of [
    ['a zero wait', ruleFile([...disk.slice(0, 2), '        for: 0s', ...disk.slice(2)])],
    ['an empty label', ruleFile([...disk, '          team: ""'])],
    ['a group interval', ruleFile(disk, '1m')],
  ]) {
    const out = scanOf({ 'prometheus/shop.rules.yml': ruleFile(disk), 'k8s/prometheusrule.yaml': wrap(other) });
    assert(JSON.stringify((out.canonical.spec.alerting?.rules || []).map((r) => r.name)) === JSON.stringify(['DiskAlmostFull'])
      && JSON.stringify(out.canonical.spec.queries.recording_rules.map((r) => r.name)) === JSON.stringify(['shop:checkout:error_ratio_5m']),
    `a copy differing only in ${what} is one rule`, [(out.canonical.spec.alerting?.rules || []).map((r) => r.name), out.summary.warnings]);
  }
  // A kustomize overlay that rewrites a recording rule is said, as one that rewrites an alert is.
  const overlay = scanOf({ 'k8s/base/prometheusrule.yaml': wrap(ruleFile(disk)), 'k8s/overlays/prod/prometheusrule.yaml': wrap(ruleFile(disk).replace('sum(rate(t[5m]))', 'sum(rate(t{env="prod"}[5m]))')) });
  assert(overlay.summary.warnings.some((w) => /^1 PrometheusRule resource\(s\) named alike in more than one file hold rules written differently .*: shop \(k8s\/base\/prometheusrule\.yaml, k8s\/overlays\/prod\/prometheusrule\.yaml: shop:checkout:error_ratio_5m\)\.$/.test(w)),
    'resources that write a recording rule differently are said', overlay.summary.warnings);
}

// ---------- not covered: a chart's rule holding a value the chart fills in is declared with the placeholder ----------
{
  const template = (inConfigMap) => (inConfigMap ? [
    'apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: {{ include "shop.fullname" . }}-rules', 'data:', '  alerts.rules.yaml: |',
    '    groups:', '      - name: shop', '        rules:',
    '          - alert: ShopDown', '            expr: up{job="{{ include "shop.fullname" . }}"} == 0', '            labels:', '              severity: critical',
    '          - alert: ShopDiskFull', '            expr: node_filesystem_avail_bytes < 1', '            labels:', '              severity: warning',
  ] : [
    'apiVersion: monitoring.coreos.com/v1', 'kind: PrometheusRule', 'metadata:', '  name: {{ include "shop.fullname" . }}', 'spec:', '  groups:', '    - name: shop', '      rules:',
    '        - alert: ShopDown', '          expr: up{job="{{ include "shop.fullname" . }}"} == 0', '          labels:', '            severity: critical',
    '        - alert: ShopDiskFull', '          expr: node_filesystem_avail_bytes < 1', '          labels:', '            severity: warning',
  ]).join('\n') + '\n';
  for (const inConfigMap of [true, false]) {
    const out = crawlFiles({
      'rules/recording.yml': 'groups:\n  - name: rec\n    rules:\n      - record: shop:checkout:error_ratio_5m\n        expr: sum(rate(e[5m])) / sum(rate(t[5m]))\n',
      'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n',
      'charts/shop/templates/rules.yaml': template(inConfigMap),
    }, { repoName: 'shop', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
    const where = inConfigMap ? 'in a ConfigMap' : 'in a PrometheusRule';
    // Both rules are declared, as a chart's ConfigMap rules always were; the filled-in selector keeps its placeholder.
    const declared = (out.canonical.spec.alerting?.rules || []).map((r) => `${r.name}: ${r.expr}`);
    assert(JSON.stringify(declared) === JSON.stringify(['ShopDown: up{job="helmvalue"} == 0', 'ShopDiskFull: node_filesystem_avail_bytes < 1']),
      `${where}: a rule whose expression the chart fills in is declared with the placeholder, the rest as written`, declared);
  }
}

// ---------- what a deploy step fills in, what PromQL writes itself, where an include renders ----------
{
  const scan = (files) => crawlFiles(files, { repoName: 'shop', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  const recording = ['groups:', '  - name: rec', '    rules:', '      - record: shop:checkout:error_ratio_5m', '        expr: sum(rate(e[5m])) / sum(rate(t[5m]))'].join('\n') + '\n';
  const chart = { 'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n', 'prometheus/rules/recording.yml': recording };
  const partialOf = (out) => Object.fromEntries((out.canonical.spec.alerting?.rules || []).map((r, i) => [r.name, out.canonical.metadata.annotations[`observogram.partial.alerting.rules[${i}]`] ?? null]));
  const alert = (name, expr, labels = ['severity: warning']) => [`      - alert: ${name}`, `        expr: ${expr}`, '        labels:', ...labels.map((l) => `          ${l}`)];
  // PromQL's own `$` — a named group's reference in label_replace, a literal route or class name, a comment — is
  // compared, as the ruler's templating in a label is; a deploy step's variable (`${NAMESPACE}`, `$NAMESPACE`,
  // Flux's `${namespace:=apps}`) is not, and a rule named with one is not declared.
  const dollars = scan({ 'prometheus/rules/recording.yml': recording, 'prometheus/rules/shop.rules.yml': ['groups:', '  - name: shop', '    rules:',
    ...alert('HostDown', 'label_replace(up{job="node"}, "host", "$host", "instance", "(?P<host>[^:]+):.*") == 0'),
    ...alert('HostDownBraced', 'label_replace(up{job="node"}, "host", "${host}", "instance", "(?P<host>[^:]+):.*") == 0'),
    ...alert('ODataErrors', 'rate(http_requests_total{route="/odata/$metadata",code=~"5.."}[5m]) > 1'),
    ...alert('RetryErrors', 'rate(errors_total{class="PaymentClient$Retry"}[5m]) > 0'),
    '      - alert: Commented', '        expr: |', '          # paged by $TEAM', '          up{job="api"} == 0', '        labels:', '          severity: warning',
    ...alert('NodeNamed', 'up{job="node"} == 0', ['severity: warning', 'node_name: \'{{ reReplaceAll ":[0-9]{2,5}" "" $labels.instance }}\'']),
    ...alert('NamespaceDown', 'up{namespace="${NAMESPACE}"} == 0'),
    ...alert('NamespaceEnvDown', 'up{namespace="$NAMESPACE"} == 0'),
    ...alert('FluxDown', 'up{namespace="${namespace:=apps}"} == 0', ['severity: warning', 'cluster: ${cluster_name:-dev}']),
    ...alert('${app_name:=api}Down', 'up == 0'),
    // A pipeline's tokens are a deploy step's too: Azure DevOps Replace Tokens, Octopus Deploy, an Azure Pipelines
    // macro — in an expression (outside a string, where '#' would start a comment), a label value, a rule's name.
    ...alert('TokenWindow', 'rate(errors_total[#{AlertWindow}#]) > 0.05'),
    ...alert('OctopusEnv', 'up{env="#{Octopus.Environment.Name}"} == 0', ['severity: \'#{Severity}#\'']),
    ...alert('MacroEnv', 'up{env="$(Env)"} == 0'),
    ...alert("'#{App}#Down'", 'up == 0'),
    // A label key a deploy step names is no key written: the rule is held to the labels it writes.
    ...alert('KeyFilled', 'up{job="api"} == 0', ['severity: warning', '${TEAM_KEY}: payments']),
  ].join('\n') + '\n' });
  assert(JSON.stringify(partialOf(dollars)) === JSON.stringify({
    HostDown: null, HostDownBraced: null, ODataErrors: null, RetryErrors: null, Commented: null, NodeNamed: null,
    NamespaceDown: 'expr=', NamespaceEnvDown: 'expr=', FluxDown: 'expr=;labels.filled=cluster;labels=severity',
    TokenWindow: 'expr=', OctopusEnv: 'expr=;labels.filled=severity;labels=', MacroEnv: 'expr=', KeyFilled: 'labels=severity',
  }) && (dollars.canonical.spec.alerting.rules.find((r) => r.name === 'NodeNamed')?.labels?.node_name ?? '').includes('reReplaceAll')
    && !JSON.stringify(dollars.canonical.spec.alerting.rules.find((r) => r.name === 'KeyFilled')).includes('TEAM_KEY')
    && dollars.canonical.spec.alerting.rules.find((r) => r.name === 'TokenWindow')?.expr === 'rate(errors_total[#{AlertWindow}#]) > 0.05'
    && dollars.summary.warnings.some((w) => /rule\(s\) are not declared: each takes its name from a value filled in at deploy time .*\$\{app_name:=api\}Down.*#\{App\}#Down/.test(w)),
  'PromQL\'s own $ is compared; a deploy step\'s variable, Flux\'s default form and a pipeline\'s token too, is not, and names no rule', [partialOf(dollars), dollars.summary.warnings]);
  // An SLO's rule whose comment names a variable states its rules: the comment is no part of what the ruler runs.
  const commentedSlo = scan({ 'prometheus/rules/recording.yml': recording, 'prometheus/rules/slo.rules.yml': ['groups:', '  - name: shop-slo', '    rules:',
    '      - alert: ShopBudgetBurn', '        expr: |', '          # runbook: ${RUNBOOK_BASE}/budget', '          shop:checkout:error_ratio_5m > 0.0144', '        for: 2m', '        labels:', '          severity: critical'].join('\n') + '\n' });
  assert(Object.keys(commentedSlo.canonical.metadata.annotations).some((k) => k.startsWith('observogram.source_rules.')),
    'an SLO rule whose comment names a variable still states its rules', Object.keys(commentedSlo.canonical.metadata.annotations));
  // An SLO's page rule whose wait a deploy step or the chart fills in, beside a ticket rule writing its own: no
  // window from it, said (the chart's value as …), and the pack stays valid.
  const sloRules = (pageFor) => ['groups:', '  - name: shop-slo', '    rules:',
    '      - alert: ShopBudgetBurnPage', '        expr: shop:checkout:error_ratio_5m > 0.0144', `        for: ${pageFor}`, '        labels:', '          severity: critical',
    '      - alert: ShopBudgetBurnTicket', '        expr: shop:checkout:error_ratio_5m > 0.006', '        for: 1h', '        labels:', '          severity: warning'];
  const prometheusRule = (lines) => ['apiVersion: monitoring.coreos.com/v1', 'kind: PrometheusRule', 'metadata:', '  name: shop', 'spec:', ...lines.map((l) => `  ${l}`)].join('\n') + '\n';
  for (const [where, files, shown] of [
    ['a deploy step', { 'prometheus/rules/recording.yml': recording, 'prometheus/rules/slo.rules.yml': sloRules('${SLO_PAGE_FOR}').join('\n') + '\n' }, '${SLO_PAGE_FOR}'],
    ['the chart', { ...chart, 'charts/shop/templates/slo.yaml': prometheusRule(sloRules('{{ .Values.slo.pageFor | default "2m" }}')) }, '…'],
  ]) {
    const out = scan(files);
    const errors = validateCanonical(out.canonical, SCHEMA);
    assert(errors.length === 0 && !/\$|helmvalue/.test(JSON.stringify(out.canonical.spec.policy?.burn_rate_alerts ?? []))
      && JSON.stringify(out.summary.omitted.ruleWaits.map((o) => [o.rule, o.value])) === JSON.stringify([['ShopBudgetBurnPage', shown]])
      && out.summary.warnings.some((w) => w.includes(`ShopBudgetBurnPage=${shown} (`) && /states none of its rules, so none is compared/.test(w) && !/held to the rest/.test(w)),
    `an SLO rule's wait ${where} fills in gives no window, is said, and the pack stays valid`, [errors.slice(0, 2), out.canonical.spec.policy?.burn_rate_alerts, out.summary.omitted.ruleWaits]);
  }
  // A page and a ticket rule of one name (the fold keeps the first): the ticket's wait a deploy step fills in is said too.
  const oneName = scan({ 'prometheus/rules/recording.yml': recording, 'prometheus/rules/slo.rules.yml': ['groups:', '  - name: shop-slo', '    rules:',
    '      - alert: ShopBudgetBurn', '        expr: shop:checkout:error_ratio_5m > 0.0144', '        for: 2m', '        labels:', '          severity: critical',
    '      - alert: ShopBudgetBurn', '        expr: shop:checkout:error_ratio_5m > 0.006', '        for: ${SLO_TICKET_FOR}', '        labels:', '          severity: warning'].join('\n') + '\n' });
  assert(JSON.stringify(oneName.summary.omitted.ruleWaits.map((o) => [o.rule, o.value])) === JSON.stringify([['ShopBudgetBurn', '${SLO_TICKET_FOR}']]),
    'the wait of an SLO\'s second rule of one name, filled in, is said', oneName.summary.omitted.ruleWaits);
  // An SLO id a long recorded name derives is cut to a spec Slug (kube-prometheus-stack's container CPU rules).
  const longNames = scan({ 'prometheus/rules/k8s.rules.yml': ['groups:', '  - name: k8s.rules.container_cpu_usage_seconds_total', '    rules:',
    '      - record: node_namespace_pod_container:container_cpu_usage_seconds_total:sum_irate', '        expr: sum by (namespace, pod, container) (irate(container_cpu_usage_seconds_total{job="kubelet"}[5m]))',
    '      - record: node_namespace_pod_container:container_cpu_usage_seconds_total:sum_rate5m', '        expr: sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{job="kubelet"}[5m]))'].join('\n') + '\n' });
  assert(validateCanonical(longNames.canonical, SCHEMA).length === 0 && (longNames.canonical.spec.slos || []).length > 0
    && longNames.canonical.spec.slos.every((s) => s.id.length <= 64 && s.id === `${String(s.sli).replace(/^ref:slis\./, '')}_99`),
    'an SLO id a long recorded name derives is cut to a spec Slug, and stays its SLI id and _99', [(longNames.canonical.spec.slos || []).map((s) => s.id), validateCanonical(longNames.canonical, SCHEMA).slice(0, 2)]);
  // The mixins' histogram idiom (`<labels>:<metric>:99quantile`, `<labels>:<metric>_bucket|_sum|_count:sum_rate`):
  // four recorded bases that agree on their first 64 characters keep four SLIs and four SLOs, each its own id.
  const histogram = scan({ 'operations/mimir-mixin-compiled/rules.yaml': ['groups:', '  - name: mimir_querier_api', '    rules:',
    ...[':99quantile', ':50quantile', ':avg', '_bucket:sum_rate', '_sum:sum_rate', '_count:sum_rate'].flatMap((op) => [
      `      - record: cluster_namespace_job_route:cortex_querier_request_duration_seconds${op}`, '        expr: sum(rate(cortex_querier_request_duration_seconds_count[1m])) by (cluster, namespace, job, route)'])].join('\n') + '\n' });
  const histogramIds = (k) => (histogram.canonical.spec[k] || []).map((x) => x.id);
  assert(validateCanonical(histogram.canonical, SCHEMA).length === 0 && histogram.summary.inferred.slis === 4
    && new Set(histogramIds('slis')).size === 4 && new Set(histogramIds('slos')).size === 4 && histogramIds('slos').every((id) => id.length <= 64 && id.endsWith('_99')),
  'recorded bases that agree on their first 64 characters keep an SLI and an SLO each, each a Slug of its own', [histogramIds('slis'), histogramIds('slos'), histogram.summary.inferred]);
  // The chart's values in a group's name, its interval and a recording rule's name never reach the pack or the summary
  // as the placeholder.
  const groupValues = scan({ ...chart, 'charts/shop/templates/rules.yaml': prometheusRule(['groups:', '  - name: {{ .Values.prefix }}.rules', '    interval: {{ .Values.interval }}', '    rules:',
    '      - record: {{ .Values.prefix }}:queue:depth', '        expr: sum(rabbitmq_queue_messages_ready)', '      - record: shop:queue:unacked', '        expr: sum(rabbitmq_queue_messages_unacked)', ...alert('QueueStuck', 'rabbitmq_queue_messages_ready > 1000')]) });
  assert(!JSON.stringify(groupValues.canonical).includes('helmvalue') && !JSON.stringify(groupValues.summary).includes('helmvalue')
    && groupValues.summary.omitted.ruleIntervals.some((o) => o.value === '…') && JSON.stringify(groupValues.canonical).includes('rabbitmq_queue_messages_ready'),
  'a value the chart fills in shows as … in the sources, the intervals left out and the inventory', [groupValues.summary.omitted, groupValues.summary.warnings]);
  // An include whose indent the chart computes renders at the column of the map's own keys (a chart written four
  // columns deep), and inside a ConfigMap's block where it stands there; one after an indented rules list renders
  // the group's keys: each rule held to the labels it writes.
  const computedFour = scan({ ...chart, 'charts/shop/templates/rules.yaml': ['apiVersion: monitoring.coreos.com/v1', 'kind: PrometheusRule', 'metadata:', '    name: shop', 'spec:',
    '    groups:', '        - name: shop', '          rules:', '              - alert: ApiPanics', '                expr: rate(panics_total[5m]) > 0', '                labels:',
    '                    {{- with .Values.extraLabels }}{{ toYaml . | nindent $labelIndent }}{{- end }}', '                    severity: critical'].join('\n') + '\n' });
  const computedLast = scan({ ...chart, 'charts/shop/templates/rules.yaml': ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: shop-rules', 'data:', '  alerts.rules.yaml: |',
    '    groups:', '      - name: shop', '        rules:', '          - alert: ApiPanics', '            expr: rate(panics_total[5m]) > 0', '            labels:', '              severity: critical',
    '              {{- with .Values.extraLabels }}{{ toYaml . | nindent (int .Values.labelIndent) }}{{- end }}'].join('\n') + '\n' });
  const afterRules = scan({ ...chart, 'charts/shop/templates/rules.yaml': prometheusRule(['groups:', '  - name: shop', '    rules:', ...alert('ApiDown', 'up{job="api"} == 0', ['severity: critical']).map((l) => `  ${l}`),
    '    {{- with .Values.prometheusRule.groupFields }}{{- toYaml . | nindent 6 }}{{- end }}']) });
  // A computed indent right after a list item's first line renders that item's keys (the group's, here); one at
  // the margin closing a ConfigMap's block is placed by the line above it.
  const afterItem = scan({ ...chart, 'charts/shop/templates/rules.yaml': ['apiVersion: monitoring.coreos.com/v1', 'kind: PrometheusRule', 'metadata:', '  name: shop', 'spec:',
    '  groups:', '    - name: shop', '      {{- with .Values.groupLabels }}{{ toYaml (dict "labels" .) | nindent (int .Values.groupIndent) }}{{- end }}', '      rules:',
    '        - alert: ApiPanics', '          expr: rate(panics_total[5m]) > 0', '          labels:', '            severity: critical'].join('\n') + '\n' });
  const marginLast = scan({ ...chart, 'charts/shop/templates/rules.yaml': ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: shop-rules', 'data:', '  alerts.rules.yaml: |',
    '    groups:', '      - name: shop', '        rules:', '          - alert: ApiPanics', '            expr: rate(panics_total[5m]) > 0', '            labels:', '              severity: critical',
    '{{- with .Values.extraLabels }}{{ toYaml . | nindent (int .Values.labelIndent) }}{{- end }}'].join('\n') + '\n' });
  for (const [what, out] of [['a computed indent four columns deep', computedFour], ['a computed indent closing a ConfigMap\'s block', computedLast], ['an include after an indented rules list', afterRules],
    ['a computed indent after a group\'s first line', afterItem], ['a computed indent at the margin closing a ConfigMap\'s block', marginLast]]) {
    const rules = out.canonical.spec.alerting?.rules || [];
    assert(rules.length === 1 && rules[0].severity === 'SEV1' && Object.values(partialOf(out))[0] === 'labels=severity' && !out.summary.warnings.some((w) => /stopped reading/.test(w)),
      `${what}: the rule is held to the labels it writes`, [rules, partialOf(out), out.summary.warnings]);
  }
}

// ---------- where the reader stops, the scan says: the file and its line ----------
{
  const read = (files) => crawlFiles(files, { repoName: 'shop', environment: 'all', now: '2026-11-16T00:00:00.000Z' });
  const stopsOf = (out) => out.summary.warnings.filter((w) => /stopped reading/.test(w));
  // A rule file: a tag on a block mapping stops the document at the line below it; the rules above it are read.
  const rules = ['groups:', '  - name: shop', '    rules:', '      - alert: First', '        expr: up == 0', '      - alert: Second', '        expr: up == 1',
    '        labels: !!map', '          severity: page', '      - alert: Third', '        expr: up == 2'].join('\n') + '\n';
  const ruleScan = read({ 'rules/alerts.yml': rules });
  assert(JSON.stringify(stopsOf(ruleScan)) === JSON.stringify(['rules/alerts.yml: the scan stopped reading at line 9, a line the YAML reader cannot place; the rest of that document was not read.']),
    'a rule file the reader stops in: the file and the line', ruleScan.summary.warnings);
  assert(JSON.stringify(ruleScan.canonical.spec.policy.burn_rate_alerts.map((e) => e.slo).sort()) === JSON.stringify(['first', 'second']), 'the rules above the line are read', ruleScan.canonical.spec.policy.burn_rate_alerts);
  // Read twice (its labels hold a bare number, read again as written): one warning still.
  const twice = read({ 'rules/alerts.yml': rules.replace('      - alert: First\n        expr: up == 0\n', '      - alert: First\n        expr: up == 0\n        labels:\n          priority: 2\n') });
  assert(stopsOf(twice).length === 1 && /at line 11,/.test(stopsOf(twice)[0]), 'a file read a second time is warned about once', twice.summary.warnings);
  // A manifest of two documents: the line is the file's.
  const manifest = ['apiVersion: apps/v1', 'kind: Deployment', 'metadata: { name: a }', 'spec: { template: { spec: { containers: [{ name: p, image: "prom/prometheus:v2.53.0" }] } } }',
    '---', 'apiVersion: apps/v1', 'kind: Deployment', 'metadata: !!map', '  name: b', 'spec: { template: { spec: { containers: [{ name: g, image: "grafana/grafana:11.2.0" }] } } }'].join('\n') + '\n';
  const k8s = read({ 'k8s/app.yaml': manifest });
  assert(JSON.stringify(stopsOf(k8s)) === JSON.stringify(['k8s/app.yaml: the scan stopped reading at line 9, a line the YAML reader cannot place; the rest of that document was not read.'])
    && products(k8s).has('prometheus') && !products(k8s).has('grafana'), 'a second document stopped in: the line counts from the top of the file', [k8s.summary.warnings, [...products(k8s)]]);
  // A Helm template: lines of its ConfigMap, through the template actions the scan sets aside, are the template's own.
  const template = ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: {{ include "shop.fullname" . }}-rules', 'data:', '  alerts.rules.yaml: |',
    '    groups:', '      - name: shop', '        rules:', '        {{- if .Values.extra }}', '          - alert: Extra', '            expr: up == 3', '        {{- end }}',
    '          - alert: Tagged', '            expr: up == 4', '            labels: !!map', '              severity: page'].join('\n') + '\n';
  const chart = read({ 'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n', 'charts/shop/templates/rules.yaml': template });
  assert(JSON.stringify(stopsOf(chart)) === JSON.stringify(['charts/shop/templates/rules.yaml: the scan stopped reading at line 17, a line the YAML reader cannot place; the rest of that document was not read.']),
    'a template\'s ConfigMap stopped in: the template\'s own line', chart.summary.warnings);
  // And an error in it names that line too.
  const broken = read({ 'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n', 'charts/shop/templates/rules.yaml': template.replace('          - alert: Tagged', '        not a rule\n          - alert: Tagged') });
  assert(broken.summary.warnings.some((w) => w.startsWith('Failed to parse charts/shop/templates/rules.yaml#alerts.rules.yaml: yaml line 14:')),
    'an error in a template\'s ConfigMap names the template\'s line', broken.summary.warnings);
  // A repository's own pack.
  const pack = read({ '.observability/pack.yaml': 'apiVersion: observability.platform/v1\nkind: ObservabilityPack\nmetadata: { name: shop }\nspec:\n  baselines: !!map\n    mttd_target_p50: 5m\n' });
  assert(stopsOf(pack).length === 1 && /^\.observability\/pack\.yaml: .* at line 6,/.test(stopsOf(pack)[0]), 'a repository pack stopped in', pack.summary.warnings);
  // Several documents stopped in, one warning; a file the scan does not read, none.
  const many = read({ 'k8s/app.yaml': `${manifest}---\n${manifest}`, 'docs/notes.yaml': 'a: 1\n  b: 2\n' });
  assert(JSON.stringify(stopsOf(many)) === JSON.stringify(['k8s/app.yaml: the scan stopped reading at lines 9 and 20, lines the YAML reader cannot place; the rest of each of those documents was not read.']),
    'one warning for a file stopped in twice; none for a file the scan does not read', many.summary.warnings);
  // A ConfigMap's block runs on over template lines at the margin: control flow is read through, and an include
  // alone on a line is not read — its column (its `indent` argument, the block's de-indent taken off) says where
  // it renders: into the rule above it, or the block's next rules.
  const cm = (inner, { head = [], tail = [] } = {}) => ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: shop-rules', 'data:', ...head, '  alerts.rules.yaml: |', '    groups:', '      - name: shop', '        rules:',
    '          - alert: ShopDown', '            expr: up{job="shop"} == 0', ...inner, '          - alert: ShopCertExpiry', '            expr: probe_ssl_earliest_cert_expiry - time() < 86400', ...tail].join('\n') + '\n';
  const chartOf = (template) => read({ 'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n', 'charts/shop/templates/rules.yaml': template });
  const policyOf = (out) => (out.canonical.spec.policy?.burn_rate_alerts || []).map((e) => e.slo).sort();
  const quiet = (out) => !out.summary.warnings.some((w) => /stopped reading|Failed to parse|not declared/.test(w));
  const gated = chartOf(cm(['{{- if .Values.alerts.disk }}', '          - alert: ShopDiskFull', '            expr: node_filesystem_avail_bytes < 1', '{{- end }}']));
  assert(JSON.stringify(policyOf(gated)) === JSON.stringify(['shopcertexpiry', 'shopdiskfull', 'shopdown']) && !stopsOf(gated).length,
    'control flow at the margin of a ConfigMap\'s block is read through', [policyOf(gated), gated.summary.warnings]);
  for (const [what, inner, tail] of [
    ['at the margin, into the rule above it', ['          - alert: ShopDiskFull', '            expr: node_filesystem_avail_bytes < 1', '{{ toYaml .Values.extraFields | indent 12 }}'], []],
    ['at the margin, its rules from values', ['          - alert: ShopDiskFull', '            expr: node_filesystem_avail_bytes < 1', '{{- with .Values.extraRules }}', '{{ toYaml . | indent 10 }}', '{{- end }}'], []],
    ['the block\'s last line, into its last rule', ['          - alert: ShopDiskFull', '            expr: node_filesystem_avail_bytes < 1'], ['            {{- include "shop.ruleLabels" . | nindent 12 }}', '{{- end }}']],
  ]) {
    const out = chartOf(cm(inner, { tail }));
    assert(JSON.stringify(policyOf(out)) === JSON.stringify(['shopcertexpiry', 'shopdiskfull', 'shopdown']) && quiet(out),
      `an include in a ConfigMap's block (${what}): every rule read`, [policyOf(out), out.summary.warnings]);
  }
  // A data key the chart fills in whole (`{{ .Files.Get … | indent 4 }}`) states nothing of its own: not read, as before.
  const filesGet = read({ 'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n', 'charts/shop/templates/dashboards.yaml': ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: shop-dashboards', 'data:',
    '  overview.json: |-', '{{ .Files.Get "dashboards/overview.json" | indent 4 }}', '  rules.yaml: |-', '{{ toYaml .Values.rules | indent 4 }}'].join('\n') + '\n' });
  assert(!filesGet.summary.warnings.some((w) => /Failed to parse|stopped reading/.test(w)), 'a data key the chart fills in whole is not read, and nothing is said of it', filesGet.summary.warnings);
  // A switch at the margin directly under `data:` keeps the data map open.
  const dataGate = chartOf(cm([], { head: ['{{- if .Values.alerts.enabled }}'], tail: ['{{- end }}'] }));
  assert(JSON.stringify(policyOf(dataGate)) === JSON.stringify(['shopcertexpiry', 'shopdown']) && quiet(dataGate),
    'a switch at the margin under data: does not end the data map', [policyOf(dataGate), dataGate.summary.warnings]);
  // A rule a `range` names from its values: not declared, said; the rules after it read.
  const ranged = chartOf(cm(['{{- range $name, $url := .Values.probes }}', '          - alert: ShopEndpointDown{{ $name | title }}', '            expr: probe_success{instance="{{ $url }}"} == 0', '{{- end }}']));
  assert(JSON.stringify(policyOf(ranged)) === JSON.stringify(['shopcertexpiry', 'shopdown'])
    && ranged.summary.warnings.includes('1 rule(s) are not declared: each takes its name from a value filled in at deploy time (a chart\'s values, a deploy step\'s variable), so which rules it renders is not known here — ShopEndpointDown… (charts/shop/templates/rules.yaml#alerts.rules.yaml).'),
    'a rule a range names from its values is not declared, and said', [policyOf(ranged), ranged.summary.warnings]);
  // A rule file a deploy step fills in (envsubst): a name holding its variable is not declared either.
  const substituted = read({ 'rules/alerts.yml': ['groups:', '  - name: shop', '    rules:', '      - alert: ${SERVICE}Down', '        expr: up{job="${SERVICE}"} == 0',
    '      - alert: ShopDiskFull', '        expr: node_filesystem_avail_bytes < 1'].join('\n') + '\n' });
  assert(JSON.stringify(policyOf(substituted)) === JSON.stringify(['shopdiskfull'])
    && substituted.summary.warnings.includes('1 rule(s) are not declared: each takes its name from a value filled in at deploy time (a chart\'s values, a deploy step\'s variable), so which rules it renders is not known here — ${SERVICE}Down (rules/alerts.yml).'),
    'a rule named by a deploy step\'s variable is not declared, and said', [policyOf(substituted), substituted.summary.warnings]);
  // Another config than rules keeps its include: the reader cannot place it, and the block is not read, as before.
  const routes = read({ 'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n', 'charts/shop/templates/alertmanager.yaml': ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: shop-am', 'data:', '  alertmanager.yml: |',
    '    route:', '      receiver: default', '{{ toYaml .Values.extraRoute | indent 6 }}', '    receivers:', '      - name: default', '        webhook_configs:', '          - url: https://hooks.example/a'].join('\n') + '\n' });
  assert(routes.summary.warnings.some((w) => /^Failed to parse charts\/shop\/templates\/alertmanager\.yaml#alertmanager\.yml: yaml line 9:/.test(w)),
    'an include in another config than rules: not read, said', routes.summary.warnings);
  // But a config that ends in the chart's extra-config hook is read whole, as it always was: the hook renders after it.
  const hooked = read({ 'charts/shop/Chart.yaml': 'name: shop\nversion: 0.1.0\n', 'charts/shop/templates/config.yaml': ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: shop-config', 'data:',
    '  prometheus.yml: |', '    scrape_configs:', '      - job_name: shop', '        static_configs:', '          - targets: ["shop:8080"]', '{{- with .Values.extraScrapeConfigs }}', '{{ toYaml . | indent 6 }}', '{{- end }}',
    '  alertmanager.yml: |', '    route:', '      receiver: default', '    receivers:', '      - name: default', '        webhook_configs:', '          - url: https://hooks.example/a', '{{- if .Values.extraReceivers }}', '{{ toYaml .Values.extraReceivers | indent 6 }}', '{{- end }}',
  ].join('\n') + '\n' });
  assert(hooked.summary.discovered.scrapeJobs === 1 && hooked.summary.discovered.alertingRoutes >= 1 && !hooked.summary.warnings.some((w) => /Failed to parse|stopped reading/.test(w)),
  'a config that ends in an extra-config hook is read whole', [hooked.summary.discovered, hooked.summary.warnings]);
  // A manifest the reader stops in before anything the scan reads: not read, and said.
  const early = read({ 'deploy/monitoring.yaml': 'apiVersion: monitoring.coreos.com/v1\nkind: PrometheusRule\nmetadata: !!map\n  name: shop\nspec:\n  groups: []\n' });
  assert(early.summary.warnings.includes('deploy/monitoring.yaml was not read: the YAML reader stopped at line 4, a line it cannot place, before anything the scan reads there.'),
    'a manifest stopped in before anything the scan reads is said', early.summary.warnings);
  // A file that throws after a stop was not read at all: only its error is said.
  const thrown = read({ 'rules/alerts.yml': `${rules}---\nnot a key\n` });
  assert(!stopsOf(thrown).length && thrown.summary.warnings.some((w) => w === 'Failed to parse rules/alerts.yml: yaml line 13: expected "key: value", got "not a key"'),
    'a stop in a file that then throws is not said as a partial read', thrown.summary.warnings);
}

report('crawler');
