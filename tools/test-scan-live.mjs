#!/usr/bin/env node
/**
 * tools/test-scan-live.mjs
 *
 * The use case the product stands on, as one offline test: scan a
 * repository, draft a pack from the live system that repository deploys,
 * compare the two — THEY MATCH.
 *
 * The repository below and the "live" answers below describe the same
 * system, each in its own form: rule files and the ruler's API (which
 * lists groups in another order, spells `for: 2m` as `duration: 120` and
 * calls the expression `query`), an Alertmanager config file and the
 * configuration the running Alertmanager reports (secrets redacted),
 * container images and scrape targets, a histogram declared in source and
 * the `_bucket` / `_count` / `_sum` series a metrics store lists for it.
 *
 * What is asserted:
 *   1. nothing reads "only in the repo" or "only live", and nothing reads
 *      drifted — every difference between the two forms is one a reader
 *      must see through;
 *   2. what the live side has no way to look at (the collector's
 *      configuration, dashboards behind a refused login) is reported as
 *      NOT OBSERVED, never as missing;
 *   3. real drift still shows: take one rule, one route, one metric away
 *      from the live side and each surfaces, and only it.
 */

import { readFileSync } from 'node:fs';
import { crawlFiles } from './lib/crawler.mjs';
import { buildCanonicalPack, PROBES } from './fetch-live-pack.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { createHarness } from './lib/harness.mjs';

const SCHEMA = JSON.parse(readFileSync(SPEC_SCHEMA_PATH, 'utf8'));
const { assert, report } = createHarness();

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

const REPO = {
  'docker-compose.yml': `version: '3.8'
services:
  victoriametrics:
    image: victoriametrics/victoria-metrics:v1.113.0
  vmalert:
    image: victoriametrics/vmalert:v1.113.0
  alertmanager:
    image: prom/alertmanager:v0.27.0
  grafana:
    image: grafana/grafana:12.4.0
  promtail:
    image: grafana/promtail:3.0.0
  node-exporter:
    image: prom/node-exporter:v1.8.0
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.96.0
`,
  'observability/recording-rules.yml': `groups:
  - name: shop.slo
    interval: 30s
    rules:
      - record: shop:availability:good_5m
        expr: sum(rate(shop_requests_total{code!~"5.."}[5m]))
      - record: shop:availability:total_5m
        expr: sum(rate(shop_requests_total[5m]))
      - record: shop:availability:ratio_5m
        expr: shop:availability:good_5m / shop:availability:total_5m
  - name: shop.latency
    interval: 1m
    rules:
      - record: shop:latency:p99_5m
        expr: histogram_quantile(0.99, sum(rate(shop_request_duration_seconds_bucket[5m])) by (le))
      - record: shop:latency:p95_5m
        expr: histogram_quantile(0.95, sum(rate(shop_request_duration_seconds_bucket[5m])) by (le))
`,
  'observability/alerting-rules.yml': `groups:
  - name: shop.alerts
    rules:
      - alert: ShopAvailabilityLow
        expr: shop:availability:ratio_5m < 0.99
        for: 2m
        labels:
          severity: critical
      - alert: ShopAvailabilityVeryLow
        expr: shop:availability:ratio_5m < 0.95
        for: 600s
        labels:
          severity: critical
      - alert: ShopLatencyHigh
        expr: shop:latency:p95_5m > 0.5
        for: 15m
        labels:
          severity: warning
      - alert: DiskAlmostFull
        expr: node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1
        labels:
          severity: warning
`,
  'observability/alertmanager.yml': `route:
  receiver: oncall
  routes:
    - receiver: pager
      match:
        severity: critical
    - receiver: remediation
      match:
        alertname: DiskAlmostFull
    - receiver: oncall
      match:
        severity: warning
receivers:
  - name: oncall
    webhook_configs:
      - url: 'http://goalert:8081/api/v2/incoming?token=\${GOALERT_TOKEN}'
  - name: pager
    email_configs:
      - to: oncall@shop.example
    webhook_configs:
      - url: 'https://ntfy.sh/\${NTFY_TOPIC}?priority=urgent'
  - name: remediation
    webhook_configs:
      - url: '\${REMEDIATION_WEBHOOK_URL}'
`,
  'observability/scrape.yml': `global:
  scrape_interval: 15s
scrape_configs:
  - job_name: shop-api
    static_configs:
      - targets: ['shop-api:8080']
  - job_name: node-exporter
    static_configs:
      - targets: ['node-exporter:9100']
  - job_name: otel-collector
    static_configs:
      - targets: ['otel-collector:8888']
`,
  // Promtail says which LOG FILES to tail with the same keys a metrics
  // store uses for scrape jobs. It is not one.
  'observability/promtail.yml': `clients:
  - url: http://loki:3100/loki/api/v1/push
positions:
  filename: /tmp/positions.yaml
scrape_configs:
  - job_name: kubernetes-pods
    kubernetes_sd_configs:
      - role: pod
    pipeline_stages:
      - json:
          expressions:
            level: level
`,
  'observability/otel-collector.yaml': `receivers:
  otlp:
    protocols:
      grpc: {}
processors:
  batch: {}
  memory_limiter: {}
exporters:
  prometheusremotewrite:
    endpoint: http://victoriametrics:8428/api/v1/write
  otlp/jaeger:
    endpoint: jaeger:4317
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheusremotewrite]
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [otlp/jaeger]
`,
  'dashboards/shop-overview.json': JSON.stringify({
    uid: 'shop-overview', title: 'Shop overview', schemaVersion: 39,
    panels: [{ id: 1, title: 'Availability', type: 'timeseries', targets: [{ expr: 'shop:availability:ratio_5m' }] }],
  }),
  'src/metrics.ts': `import { Counter, Histogram } from 'prom-client';
export const requests = new Counter({ name: 'shop_requests_total', help: 'requests', labelNames: ['code'] });
export const duration = new Histogram({ name: 'shop_request_duration_seconds', help: 'latency', labelNames: ['route'] });
`,
  // The Python client exposes Counter('shop_jobs') as shop_jobs_total (and shop_jobs_created).
  'worker/app.py': `from prometheus_client import Counter, Histogram
JOBS = Counter('shop_jobs', 'jobs processed')
JOB_SECONDS = Histogram('shop_job_duration_seconds', 'job latency')
`,
  // A script that writes the exposition format by hand and pushes it.
  'scripts/integrity-monitor.js': `const body = [
  '# HELP shop_dashboard_integrity_score Composite integrity score',
  '# TYPE shop_dashboard_integrity_score gauge',
  \`shop_dashboard_integrity_score \${score}\`,
].join('\\n');
`,
};

// ---------------------------------------------------------------------------
// The live system — the answers an MCP gives for that same deployment
// ---------------------------------------------------------------------------

const probe = (name) => PROBES.find(p => p.name === name);

// vmalert: groups in ANOTHER order, `query` for expr, `duration` seconds
// for `for`, `severity` at the top level, on-wire evaluation state.
const ruler = () => ({
  groups: [
    { name: 'shop.alerts', interval: 15, rules: [
      { name: 'DiskAlmostFull', type: 'alerting', severity: 'warning', duration: 0, health: 'ok', state: 'inactive',
        query: 'node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1\n' },
      { name: 'ShopLatencyHigh', type: 'alerting', severity: 'warning', duration: 900, health: 'ok', state: 'inactive',
        query: 'shop:latency:p95_5m > 0.5\n' },
      { name: 'ShopAvailabilityVeryLow', type: 'alerting', severity: 'critical', duration: 600, health: 'ok', state: 'inactive',
        query: 'shop:availability:ratio_5m < 0.95\n' },
      { name: 'ShopAvailabilityLow', type: 'alerting', severity: 'critical', duration: 120, health: 'ok', state: 'firing',
        query: 'shop:availability:ratio_5m < 0.99\n' },
    ] },
    { name: 'shop.latency', interval: 60, rules: [
      { name: 'shop:latency:p95_5m', type: 'recording', health: 'ok',
        query: 'histogram_quantile(0.95, sum(rate(shop_request_duration_seconds_bucket[5m])) by (le))\n' },
      { name: 'shop:latency:p99_5m', type: 'recording', health: 'ok',
        query: 'histogram_quantile(0.99, sum(rate(shop_request_duration_seconds_bucket[5m])) by (le))\n' },
    ] },
    { name: 'shop.slo', interval: 30, rules: [
      { name: 'shop:availability:ratio_5m', type: 'recording', health: 'ok',
        query: 'shop:availability:good_5m / shop:availability:total_5m\n' },
      { name: 'shop:availability:total_5m', type: 'recording', health: 'ok',
        query: 'sum(rate(shop_requests_total[5m]))\n' },
      { name: 'shop:availability:good_5m', type: 'recording', health: 'ok',
        query: 'sum(rate(shop_requests_total{code!~"5.."}[5m]))\n' },
    ] },
  ],
});

// The configuration the running Alertmanager reports: rendered (defaults
// filled in) and with every secret address replaced.
const AM_CONFIG = `global:
  resolve_timeout: 5m
route:
  receiver: oncall
  continue: false
  routes:
  - receiver: pager
    match:
      severity: critical
    continue: false
  - receiver: remediation
    match:
      alertname: DiskAlmostFull
    continue: false
  - receiver: oncall
    match:
      severity: warning
    continue: false
receivers:
- name: oncall
  webhook_configs:
  - send_resolved: true
    url: <secret>
- name: pager
  email_configs:
  - send_resolved: false
    to: oncall@shop.example
  webhook_configs:
  - send_resolved: true
    url: <secret>
- name: remediation
  webhook_configs:
  - send_resolved: true
    url: <secret>
templates: []
`;

const TARGETS = {
  targets: ['shop-api', 'node-exporter', 'otel-collector', 'promtail', 'alertmanager', 'victoriametrics']
    .map(job => ({ job, instance: `${job}:9000`, health: 'up', lastScrape: '2026-10-01T00:00:00Z', lastError: '' })),
};

const METRIC_NAMES = [
  'up',
  'shop_requests_total',
  // the histogram declared in src/metrics.ts
  'shop_request_duration_seconds_bucket', 'shop_request_duration_seconds_count', 'shop_request_duration_seconds_sum',
  // the Python client's counter and histogram
  'shop_jobs_total', 'shop_jobs_created',
  'shop_job_duration_seconds_bucket', 'shop_job_duration_seconds_count', 'shop_job_duration_seconds_sum', 'shop_job_duration_seconds_created',
  // pushed by the script
  'shop_dashboard_integrity_score',
  // the recorded series
  'shop:availability:good_5m', 'shop:availability:total_5m', 'shop:availability:ratio_5m',
  'shop:latency:p95_5m', 'shop:latency:p99_5m',
  // what the operational alert reads
  'node_filesystem_avail_bytes', 'node_filesystem_size_bytes',
  // the rest of the platform: out of this service's scope
  'go_goroutines', 'process_cpu_seconds_total', 'vm_rows',
];

// The catalogue of everything the MCP server can speak to. Not a deployment.
const CAPABILITIES = {
  gatingMode: 'warn',
  skills: [
    { skill: 'metrics', backends: [
      { backend: 'Prometheus', productVersions: { must: ['3.0'] } },
      { backend: 'VictoriaMetrics', productVersions: { must: ['1.113'] } },
      { backend: 'Grafana Mimir', productVersions: { must: ['2.15'] } },
    ] },
    { skill: 'grafana', backends: [{ backend: 'Grafana', productVersions: { must: ['12.0'] } }] },
    { skill: 'alertmanager', backends: [{ backend: 'Alertmanager', productVersions: { must: ['0.27'] } }] },
    { skill: 'cilium', backends: [{ backend: 'Cilium', productVersions: { must: ['1.16'] } }] },
    { skill: 'consul', backends: [{ backend: 'Consul', productVersions: { must: ['1.20'] } }] },
    { skill: 'traces', backends: [{ backend: 'Jaeger', productVersions: { must: ['1.56'] } }, { backend: 'Tempo', productVersions: { must: ['2.4'] } }] },
  ],
};

function liveInputs({ rules = ruler(), amConfig = AM_CONFIG, metricNames = METRIC_NAMES } = {}) {
  const status = { version: '0.27.0', uptime: '2026-09-01T00:00:00Z', cluster: { status: 'ready' }, config: amConfig };
  return {
    refreshedAt: '2026-10-01T00:00:00Z',
    mcpUrl: 'https://mcp.shop.example/mcp',
    packName: 'production-live',
    health: { services: [{ name: 'shop-api' }] },
    topology: { dependencies: [] },
    capabilities: CAPABILITIES,
    liveVersions: {
      grafana: { declared: '12.4.0', source: 'grafana_health' },
      victoriametrics: { declared: 'v1.113.0', source: 'metrics_query/vm_app_version' },
    },
    probeResults: {
      recording_rules: { tool: 'vmalert_rules', outcome: 'data', adapted: probe('recording_rules').adapt(rules) },
      alert_rules:     { tool: 'vmalert_rules', outcome: 'data', adapted: probe('alert_rules').adapt(rules) },
      scrape_configs:  { tool: 'metrics_targets', outcome: 'data', adapted: probe('scrape_configs').adapt(TARGETS) },
      metric_names:    { tool: 'metrics_label_values', outcome: 'data', adapted: probe('metric_names').adapt({ values: metricNames }) },
      alerting_routes: { tool: 'alertmanager_status', outcome: 'data', adapted: probe('alerting_routes').adapt(status) },
      // Grafana refuses the fetcher's login: the dashboards were not looked at.
      dashboards:      { tool: null, attempted: ['grafana_dashboards_search'], adapted: null, outcome: 'failed' },
    },
    probeFailures: { grafana_dashboards_search: 'grafana_dashboards_search: Error: HTTP 401: Unauthorized' },
  };
}

function compare(live) {
  const { canonical: repoPack } = crawlFiles(REPO, { repoName: 'shop', now: '2026-10-01T00:00:00.000Z' });
  const livePack = buildCanonicalPack(live);
  return {
    repoPack,
    livePack,
    diff: diffPacks(adapt(repoPack), adapt(livePack), { scopeMode: repoPack.metadata.annotations['observogram.diff.scopeMode'] }),
  };
}

const keysOf = (diff, bucket) => Object.values(diff.layers).flatMap(l => l[bucket].map(e => e.key));
const kindsOf = (diff, bucket) => [...new Set(keysOf(diff, bucket).map(k => k.slice(0, k.indexOf('::'))))].sort();

// ---------------------------------------------------------------------------
// 1. The same system, scanned and live, matches
// ---------------------------------------------------------------------------

const { repoPack, livePack, diff } = compare(liveInputs());

assert(validateCanonical(repoPack, SCHEMA).length === 0, 'the scanned pack validates', validateCanonical(repoPack, SCHEMA).slice(0, 3));
assert(validateCanonical(livePack, SCHEMA).length === 0, 'the live pack validates', validateCanonical(livePack, SCHEMA).slice(0, 3));

assert(diff.summary.onlyInA === 0, 'nothing reads "declared in the repo, not live"', keysOf(diff, 'onlyInA'));
assert(diff.summary.onlyInB === 0, 'nothing reads "live, not declared in the repo"', keysOf(diff, 'onlyInB'));
assert(diff.summary.drifted === 0, 'nothing reads drifted',
  Object.values(diff.layers).flatMap(l => l.inBoth.filter(e => e.match === 'drifted').map(e => [e.key, e.deltas])));
assert(diff.summary.jaccard === 1 && diff.summary.alignment === 1,
  'the two packs are the same set, fully aligned', [diff.summary.jaccard, diff.summary.alignment]);

const both = (layer) => kindCounts(diff.layers[layer].inBoth);
function kindCounts(entries) {
  const out = {};
  for (const e of entries) { const k = e.key.slice(0, e.key.indexOf('::')); out[k] = (out[k] || 0) + 1; }
  return out;
}
assert(both('L1').sli === 2 && both('L1').slo === 2,
  'L1: both SLIs and both SLOs pair — the ruler listing its groups in another order changes nothing', both('L1'));
assert(both('L3').recording_rule === 5, 'L3: all five recording rules pair, `query` against `expr`', both('L3'));
assert(both('L4').burn_rate === 2,
  'L4: the alerts that guard a recorded SLO pair as burn-rate entries on both sides', both('L4'));
assert(both('L4').alert_route === 4,
  'L4: all four routes pair — including the one whose address the repository takes from a deploy-time variable', both('L4'));
assert(both('L2').backend === 7,
  'L2: the seven products the repository deploys are the seven the live side found evidence of', both('L2'));
assert(both('L2').scrape_job === 3, 'L2: the three metrics scrape jobs pair', both('L2'));
assert(both('L2').metric >= 11, 'L2: declared metrics pair with the series the store lists', both('L2'));

// What each reader had to see through.
{
  const live = (path) => path.reduce((o, k) => o?.[k], livePack.spec);
  const repo = (path) => path.reduce((o, k) => o?.[k], repoPack.spec);
  const policyOf = (pack) => Object.fromEntries(pack.spec.policy.burn_rate_alerts
    .map(a => [a.slo, a.windows.map(w => `${w.short}/${w.long}`).sort().join(' ')])
    .sort(([x], [y]) => x.localeCompare(y)));
  assert(JSON.stringify(policyOf(livePack)) === JSON.stringify(policyOf(repoPack))
    && policyOf(repoPack).shop_availability_99 === '10m/6h 2m/6h',
  'one rule set, one policy: `for: 600s` in a file and `duration: 600` from the ruler are the same 10m window', [policyOf(repoPack), policyOf(livePack)]);
  assert(!livePack.spec.policy.burn_rate_alerts.some(a => /disk/i.test(a.slo)) && !repoPack.spec.policy.burn_rate_alerts.some(a => /disk/i.test(a.slo)),
    'an operational alert (no recorded series in its expression) is an SLO contract on neither side');
  assert(live(['slis']).find(s => s.id === 'shop_latency').query.includes('0.95')
    && repo(['slis']).find(s => s.id === 'shop_latency').query.includes('0.95'),
  'an SLI with several recorded series takes the same one on both sides (by name, not by arrival)',
  [repo(['slis']).find(s => s.id === 'shop_latency').query, live(['slis']).find(s => s.id === 'shop_latency').query]);
  const remediation = repoPack.spec.alerting.routes.find(r => r.channels.some(c => c.webhook === 'unresolved:REMEDIATION_WEBHOOK_URL'));
  assert(!!remediation, 'the repo route whose URL is only ${REMEDIATION_WEBHOOK_URL} is declared, its address as unresolved:<VAR>', repoPack.spec.alerting.routes);
  assert(livePack.spec.alerting.routes.every(r => r.channels.every(c => !c.webhook || c.webhook === 'redacted:secret')),
    'every live webhook address is the redaction marker — what Alertmanager would not say is not invented');
  assert(!repoPack.metadata.annotations['crawler.discovered.scrape_jobs'].includes('kubernetes-pods'),
    'the Promtail log-tailing config is not declared as a metrics scrape job', repoPack.metadata.annotations['crawler.discovered.scrape_jobs']);
  assert(livePack.spec.telemetry.backends.map(b => b.product).sort().join() ===
    'alertmanager,grafana,node-exporter,opentelemetry-collector,promtail,victoriametrics,vmalert',
  'live backends are the products with evidence — not the catalogue (no Prometheus, Mimir, Cilium, Consul, Jaeger, Tempo)',
  livePack.spec.telemetry.backends.map(b => b.product));
}

// Metric families.
{
  const metric = (name) => diff.layers.L2.inBoth.find(e => e.key === `metric::{"name":"${name}"}`);
  const hist = metric('shop_request_duration_seconds');
  assert(hist && hist.match === 'aligned' && JSON.stringify(hist.b.series) ===
    JSON.stringify(['shop_request_duration_seconds_bucket', 'shop_request_duration_seconds_count', 'shop_request_duration_seconds_sum']),
  'a histogram declared in source pairs with its _bucket / _count / _sum series as ONE metric', hist && [hist.match, hist.b.series]);
  const pyHist = metric('shop_job_duration_seconds');
  assert(pyHist && pyHist.b.series.length === 4, 'the Python client\'s _created series folds into the same histogram', pyHist?.b.series);
  const counter = metric('shop_jobs');
  assert(counter && JSON.stringify(counter.b.series) === JSON.stringify(['shop_jobs_created', 'shop_jobs_total']),
    'Counter(\'shop_jobs\') pairs with the shop_jobs_total / shop_jobs_created it is exposed as', counter?.b.series);
  assert(!!metric('shop_dashboard_integrity_score'),
    'a metric a script writes in the exposition format (# TYPE …) is a declaration like any other');
  assert(!keysOf(diff, 'outOfScope').some(k => /shop/.test(k)) && keysOf(diff, 'outOfScope').some(k => /go_goroutines/.test(k)),
    'the rest of the platform\'s metrics stay out of this service\'s scope', keysOf(diff, 'outOfScope'));
}

// ---------------------------------------------------------------------------
// 2. What the live side could not look at is "not observed", never "missing"
// ---------------------------------------------------------------------------
{
  const unseen = Object.values(diff.layers).flatMap(l => l.notObserved);
  assert(diff.summary.notObserved === unseen.length && unseen.length > 0 && unseen.every(e => e.side === 'a' && e.reason),
    'every unobserved artefact names the side that holds it and the other side\'s reason', diff.summary.notObserved);
  assert(JSON.stringify(kindsOf(diff, 'notObserved')) === JSON.stringify(
    ['dashboard', 'otel', 'pipeline_exporter_traces', 'pipeline_processor', 'pipeline_receiver']),
  'the families the live side had no way to observe: the SDK and collector configuration, and the dashboards', kindsOf(diff, 'notObserved'));
  const dash = unseen.find(e => e.key.startsWith('dashboard::'));
  assert(/HTTP 401/.test(dash.reason), 'a dashboard behind a refused login carries the probe\'s own error as the reason', dash.reason);
  assert(/collector configuration/.test(unseen.find(e => e.key.startsWith('pipeline_receiver::')).reason),
    'the collector pipeline says no tool exposes the collector configuration');
  assert(diff.summary.union === diff.summary.inBoth,
    'unobserved artefacts are outside the union: they do not lower the match', [diff.summary.union, diff.summary.inBoth]);
}

// ---------------------------------------------------------------------------
// 3. Real drift still shows, and only it
// ---------------------------------------------------------------------------
{
  // The latency rules are not deployed.
  const rules = ruler();
  rules.groups = rules.groups.filter(g => g.name !== 'shop.latency');
  const names = METRIC_NAMES.filter(n => !n.startsWith('shop:latency:'));
  const d = compare(liveInputs({ rules, metricNames: names })).diff;
  const missing = keysOf(d, 'onlyInA');
  assert(missing.includes('recording_rule::{"record":"shop:latency:p95_5m"}') && missing.includes('recording_rule::{"record":"shop:latency:p99_5m"}')
    && missing.includes('sli::{"id":"shop_latency"}') && missing.includes('slo::{"id":"shop_latency_99"}')
    && missing.includes('burn_rate::{"slo":"shop_latency_99"}'),
  'rules that are not deployed: the rules, the SLI / SLO they carry and the alert that guards it read "not live"', missing);
  assert(missing.every(k => /latency/.test(k)) && d.summary.onlyInB === 0, 'and nothing else does', [missing, keysOf(d, 'onlyInB')]);
}
{
  // The live Alertmanager has no route for DiskAlmostFull.
  const amConfig = AM_CONFIG.replace(/ {2}- receiver: remediation\n {4}match:\n {6}alertname: DiskAlmostFull\n {4}continue: false\n/, '');
  const d = compare(liveInputs({ amConfig })).diff;
  assert(d.summary.onlyInA === 1 && /^alert_route::/.test(keysOf(d, 'onlyInA')[0]) && d.summary.onlyInB === 0 && d.summary.drifted === 0,
    'a route the live Alertmanager does not have reads "not live" — one route, nothing else', [keysOf(d, 'onlyInA'), keysOf(d, 'onlyInB')]);
}
{
  // The job histogram has no series in production; an undeclared metric does.
  const names = METRIC_NAMES.filter(n => !n.startsWith('shop_job_duration_seconds')).concat('shop_refunds_total');
  const d = compare(liveInputs({ metricNames: names })).diff;
  assert(JSON.stringify(keysOf(d, 'onlyInA')) === JSON.stringify(['metric::{"name":"shop_job_duration_seconds"}']),
    'a declared histogram with no series live reads "not live" — once, as a family', keysOf(d, 'onlyInA'));
  assert(JSON.stringify(keysOf(d, 'onlyInB')) === JSON.stringify(['metric::{"name":"shop_refunds_total"}']),
    'a series the repository never declares reads "live, not declared"', keysOf(d, 'onlyInB'));
}
{
  // A different address the live side CAN state is still a difference.
  const amConfig = AM_CONFIG.replace('to: oncall@shop.example', 'to: someone-else@shop.example');
  const d = compare(liveInputs({ amConfig })).diff;
  const drifted = Object.values(d.layers).flatMap(l => l.inBoth.filter(e => e.match === 'drifted'));
  assert(drifted.length === 1 && drifted[0].key.startsWith('alert_route::') && drifted[0].deltas[0].field === 'channels',
    'redaction hides only what was redacted: a changed e-mail address on the same route is drift', drifted.map(e => [e.key, e.deltas]));
}

report('scan-vs-live', 'a repository scan and the live draft of the same system match.');
