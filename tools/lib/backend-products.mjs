// tools/lib/backend-products.mjs
//
// The observability products a pack can name as telemetry backends, and the
// evidence each way of reading a system has that one of them is there:
//   - a repository scan sees a container IMAGE (tools/lib/crawler.mjs);
//   - a live fetch sees a SCRAPE JOB with targets up, or a version the
//     product itself reports (tools/fetch-live-pack.mjs).
// Both resolve to the same { product, signal }, because the diff pairs
// backends on exactly that (artefact-model.mjs): a product read from an
// image and the same product read from its scrape job must be one backend.
//
// Pure ESM, data + lookups only.

// An image is a product's when its NAME — the last segment of its path,
// before a tag or a digest — is the product's: under any registry or
// namespace (`prom/prometheus`, `quay.io/prometheus/prometheus`,
// `bitnami/prometheus`, `localhost:5000/prometheus:v3`), and after a
// mirror's own prefix (`rancher/mirrored-prometheus-prometheus`). A name
// that only ends in the product's or holds it is another image's — an
// exporter's (`mq_prometheus`), a plugin's (`fluent-plugin-loki`). `vendor`
// is a prefix a distribution gives the name (Bitnami's `grafana-loki`).
const named = (name, vendor = '') =>
  String.raw`(?:^|\/)(?:mirrored-[a-z0-9-]+-)?${vendor ? `(?:${vendor})?` : ''}${name}(?:[:@][^\/]*)?$`;
const image = (...alternatives) => new RegExp(alternatives.join('|'), 'i');

// Known backend images → spec.telemetry.backends.product enum, matched
// against a compose service's image, a workload container's, or a Helm
// values `image.repository` (with its tag). The first row that matches
// names the product: order matters — most-specific first.
// Signal enum per schema: metrics, logs, traces, profiles, network,
// policy, mesh, gateway, collection, alerting, dashboards. No "all" —
// products that handle multiple signals (Grafana, OTel Collector,
// Alertmanager) get their primary classification.
export const BACKEND_PATTERNS = [
  { match: /opentelemetry[/-]?collector|otel\/opentelemetry-collector/i, product: 'opentelemetry-collector', signal: 'collection' },
  { match: image(String.raw`^prom\/prometheus`, named('prometheus')),    product: 'prometheus',              signal: 'metrics' },
  { match: image(String.raw`^grafana\/loki`, String.raw`grafana\/loki-docker`, named('loki', 'grafana-')), product: 'loki', signal: 'logs' },
  { match: image(String.raw`^grafana\/tempo`, named('tempo', 'grafana-')), product: 'tempo',                 signal: 'traces' },
  { match: image(String.raw`^grafana\/mimir`, String.raw`grafana\/mimirtool`, named('mimir', 'grafana-')), product: 'mimir', signal: 'metrics' },
  { match: image(String.raw`^grafana\/grafana`, String.raw`grafana\/grafana-`, named('grafana')), product: 'grafana', signal: 'dashboards' },
  { match: image(String.raw`^elastic\/`, 'opensearch', named('elasticsearch')), product: 'elasticsearch',  signal: 'logs' },
  { match: image(String.raw`^jaegertracing\/`, String.raw`jaegertracing\/all-in-one`, named('jaeger')), product: 'jaeger', signal: 'traces' },
  { match: image(String.raw`^thanos\/`, String.raw`quay\.io\/thanos`, named('thanos')), product: 'thanos',   signal: 'metrics' },
  { match: image(String.raw`^prom\/alertmanager`, named('alertmanager')), product: 'alertmanager',          signal: 'alerting' },
  { match: /^pyroscope|grafana\/pyroscope/i,                              product: 'pyroscope',               signal: 'profiles' },
  { match: image(String.raw`^cilium\/cilium`, String.raw`quay\.io\/cilium\/cilium`, named('cilium')), product: 'cilium', signal: 'network' },
  { match: /^openpolicyagent\/opa|^opa:/i,                                  product: 'opa',                     signal: 'policy' },
  { match: /^envoyproxy\/envoy|^envoy:/i,                                   product: 'envoy',                   signal: 'mesh' },
  { match: /^consul:|^hashicorp\/consul/i,                                  product: 'consul',                  signal: 'mesh' },
  { match: /^kong:|^kong\/kong/i,                                           product: 'kong',                    signal: 'gateway' },
  { match: /^traefik:|^traefik\/traefik/i,                                  product: 'traefik',                 signal: 'gateway' },
  { match: /fluent[-/]?bit|fluent-bit/i,                                  product: 'fluent-bit',              signal: 'logs' },
  { match: /^grafana\/alloy|^alloy:/i,                                      product: 'alloy',                   signal: 'collection' },
  { match: /^elastic\/beats|^beats:/i,                                      product: 'beats',                   signal: 'collection' },
  { match: image(String.raw`timberio\/vector`, named('vector')),         product: 'vector',                  signal: 'collection' },
  // Additional common production stacks
  { match: /victoriametrics\/victoria-metrics|victoriametrics\/vmselect|victoriametrics\/vminsert|victoriametrics\/vmstorage|victoriametrics\/vmagent/i,
                                                                          product: 'victoriametrics',         signal: 'metrics' },
  { match: /victoriametrics\/vmalert/i,                                   product: 'vmalert',                 signal: 'alerting' },
  { match: /kube-state-metrics/i,                                          product: 'kube-state-metrics',      signal: 'metrics' },
  { match: /prom\/node-exporter|node_exporter/i,                          product: 'node-exporter',           signal: 'metrics' },
  { match: image(String.raw`grafana\/promtail`, named('promtail')),      product: 'promtail',                signal: 'logs' },
  { match: /grafana\/k6|loadimpact\/k6/i,                                 product: 'k6',                      signal: 'metrics' },
  { match: /^otel\/opentelemetry-collector-contrib/i,                     product: 'opentelemetry-collector', signal: 'collection' },
  { match: image(String.raw`opensearchproject\/opensearch`, named('opensearch')), product: 'opensearch',   signal: 'logs' },
  { match: /datadog\/agent|datadoghq\/agent/i,                            product: 'datadog-agent',           signal: 'collection' },
];

// The signal each product is classified under — first row wins, as it does
// for an image.
const SIGNAL_BY_PRODUCT = new Map();
for (const row of BACKEND_PATTERNS) {
  if (!SIGNAL_BY_PRODUCT.has(row.product)) SIGNAL_BY_PRODUCT.set(row.product, row.signal);
}

const compact = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const PRODUCT_BY_COMPACT = new Map([...SIGNAL_BY_PRODUCT.keys()].map(p => [compact(p), p]));

/**
 * The table's spelling and signal for a product named some other way
 * (`fluentbit` for `fluent-bit`, a display name). Null when the table does
 * not know the product.
 */
export function knownBackendProduct(name) {
  const product = PRODUCT_BY_COMPACT.get(compact(name));
  return product ? { product, signal: SIGNAL_BY_PRODUCT.get(product) } : null;
}

// Scrape job names under which a product's OWN metrics endpoint is
// conventionally scraped. Exact names only (after lowercasing and `_` → `-`):
// `otel-mcp-server` is not the collector and `grafana-agent` is not Grafana,
// so a prefix or substring match would attest products that are not there. A
// job that is missing here costs a backend its live evidence, never invents one.
const SCRAPE_JOBS_BY_PRODUCT = {
  'opentelemetry-collector': ['otel-collector', 'otelcol', 'opentelemetry-collector', 'otel-collector-contrib', 'otelcol-contrib'],
  prometheus:           ['prometheus', 'prometheus-server'],
  loki:                 ['loki'],
  tempo:                ['tempo'],
  mimir:                ['mimir'],
  grafana:              ['grafana'],
  elasticsearch:        ['elasticsearch', 'elasticsearch-exporter'],
  opensearch:           ['opensearch'],
  jaeger:               ['jaeger', 'jaeger-all-in-one', 'jaeger-collector', 'jaeger-query'],
  thanos:               ['thanos', 'thanos-query', 'thanos-sidecar', 'thanos-store'],
  alertmanager:         ['alertmanager'],
  pyroscope:            ['pyroscope'],
  cilium:               ['cilium', 'cilium-agent'],
  opa:                  ['opa', 'open-policy-agent'],
  envoy:                ['envoy'],
  consul:               ['consul'],
  kong:                 ['kong'],
  traefik:              ['traefik'],
  'fluent-bit':         ['fluent-bit', 'fluentbit'],
  alloy:                ['alloy'],
  vector:               ['vector'],
  victoriametrics:      ['victoriametrics', 'victoria-metrics', 'vmsingle', 'vmselect', 'vminsert', 'vmstorage', 'vmagent'],
  vmalert:              ['vmalert'],
  'kube-state-metrics': ['kube-state-metrics'],
  'node-exporter':      ['node-exporter', 'node'],
  promtail:             ['promtail'],
};
const PRODUCT_BY_SCRAPE_JOB = new Map();
for (const [product, jobs] of Object.entries(SCRAPE_JOBS_BY_PRODUCT)) {
  for (const job of jobs) PRODUCT_BY_SCRAPE_JOB.set(job, product);
}

/**
 * The backend a scrape job is evidence of: { product, signal }, or null
 * when the job scrapes something that is not an observability backend
 * (an application, a database exporter).
 */
export function backendForScrapeJob(job) {
  const product = PRODUCT_BY_SCRAPE_JOB.get(String(job || '').trim().toLowerCase().replace(/_/g, '-'));
  return product ? { product, signal: SIGNAL_BY_PRODUCT.get(product) } : null;
}
