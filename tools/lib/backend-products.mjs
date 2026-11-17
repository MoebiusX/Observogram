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

// A row built with `named` takes an image as a product's when its NAME — the
// last segment of its path, before a tag or a digest — is the product's
// (the collector, agent and VictoriaMetrics rows below keep patterns of their
// own, and a row's namespace alternative, `^grafana\/grafana`, takes that
// namespace's companion images too): under any registry or
// namespace (`prom/prometheus`, `quay.io/prometheus/prometheus`,
// `bitnami/prometheus`, `localhost:5000/prometheus:v3`), or alone with a tag
// or a digest (`prometheus:v3.0.0`) — a bare word (a values file's `name:
// Loki`) is no image reference, nor is a URL (`repo:
// https://github.com/grafana/loki`) or an address (`grafana@alerts.example`,
// `git@github.com:grafana/loki`): an image's one `@` starts its digest,
// `@<algorithm>:<hex>`, at its end. A field that holds only an image reads
// a bare name as the image it is (`<name>:latest`, the crawler's
// registerBackendFromImage). A distribution's build keeps the product's name
// after its prefix: a mirror's `mirrored-<org>-` (Rancher), OpenShift's
// `origin-` and `ose-`, Rancher monitoring v1's `prom-`, Docker Hardened
// Images' `dhi-`, and `vendor` — the product's own organisation where a
// mirror flattens its path into the name (`prometheus-prometheus`,
// `thanos-thanos`, `timberio-vector`), or a distribution names it so
// (Bitnami's `grafana-loki`, the `prometheus-alertmanager` of Debian-based
// builds). A name that only ends in the product's or holds it is another
// image's — an exporter's (`mq_prometheus`), a plugin's
// (`fluent-plugin-loki`), a project's own build (`shop-prometheus`).
const DISTRIBUTION = String.raw`(?:mirrored-[a-z0-9]+-|origin-|ose-|prom-|dhi-)?`;
const TAG = String.raw`:[\w][\w.-]{0,127}`;
const DIGEST_BODY = String.raw`[a-z][a-z0-9]*(?:[-_+.][a-z][a-z0-9]*)*:[0-9a-f]{32,}`;
const DIGEST = `@${DIGEST_BODY}`;
const named = (name, vendor = '') => {
  const n = `${DISTRIBUTION}${vendor ? `(?:${vendor})?` : ''}${name}`;
  return String.raw`(?:\/${n}(?:${TAG})?(?:${DIGEST})?$|^${n}(?:${TAG}(?:${DIGEST})?|${DIGEST})$)`;
};
const image = (...alternatives) => new RegExp(String.raw`^(?![\s\S]*:\/\/)(?![^@]*@(?!${DIGEST_BODY}$))[\s\S]*?(?:${alternatives.join('|')})`, 'i');

// Whether a string can be an image reference at all: no URL, and no `@` but
// the one that starts its digest at its end. A reader asks it before any row
// of BACKEND_PATTERNS — the rows built with `image` above ask it themselves.
const NOT_AN_IMAGE_RE = new RegExp(String.raw`:\/\/|@(?!${DIGEST_BODY}$)`, 'i');
export const isImageReference = (ref) => typeof ref === 'string' && ref.trim() !== '' && !NOT_AN_IMAGE_RE.test(ref.trim());

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
  { match: image(String.raw`^prom\/prometheus`, named('prometheus', 'prometheus-')),    product: 'prometheus',              signal: 'metrics' },
  { match: image(String.raw`^grafana\/loki`, String.raw`grafana\/loki-docker`, named('loki', 'grafana-')), product: 'loki', signal: 'logs' },
  { match: image(String.raw`^grafana\/tempo`, named('tempo', 'grafana-')), product: 'tempo',                 signal: 'traces' },
  { match: image(String.raw`^grafana\/mimir`, String.raw`grafana\/mimirtool`, named('mimir', 'grafana-')), product: 'mimir', signal: 'metrics' },
  { match: image(String.raw`^grafana\/grafana`, String.raw`grafana\/grafana-`, named('grafana', 'grafana-')), product: 'grafana', signal: 'dashboards' },
  { match: image(String.raw`^elastic\/`, named('elasticsearch', 'elasticsearch-')), product: 'elasticsearch',  signal: 'logs' },
  { match: image(String.raw`^jaegertracing\/`, String.raw`jaegertracing\/all-in-one`, named('jaeger', 'jaegertracing-')), product: 'jaeger', signal: 'traces' },
  { match: image(String.raw`^thanos\/`, String.raw`quay\.io\/thanos`, named('thanos', 'thanos-')), product: 'thanos',   signal: 'metrics' },
  { match: image(String.raw`^prom\/alertmanager`, named('alertmanager', 'prometheus-')), product: 'alertmanager', signal: 'alerting' },
  { match: /^pyroscope|grafana\/pyroscope/i,                              product: 'pyroscope',               signal: 'profiles' },
  { match: image(String.raw`^cilium\/cilium`, String.raw`quay\.io\/cilium\/cilium`, named('cilium', 'cilium-')), product: 'cilium', signal: 'network' },
  { match: image(String.raw`^openpolicyagent\/opa`, named('opa', 'openpolicyagent-')), product: 'opa',      signal: 'policy' },
  // The vendors' own product images by name, under any registry — Envoy's
  // contrib, distroless, alpine, debug, Windows and VRP builds and each one's
  // dev build, Consul Enterprise and its FIPS build, Kong Gateway and the
  // nightlies (kong-dev, kong-gateway-dev), Alloy's pre-release alloy-dev —
  // and none of their companions (consul-k8s-control-plane, consul-dataplane,
  // envoy-tools, envoy-build-ubuntu; alloy-operator below).
  { match: image(named(String.raw`envoy(?:-contrib)?(?:-(?:distroless|alpine|debug|windows(?:-ltsc\d{4})?|google-vrp))?(?:-dev)?`, 'envoyproxy-')), product: 'envoy', signal: 'mesh' },
  { match: image(named(String.raw`consul(?:-enterprise)?(?:-fips)?`, 'hashicorp-')), product: 'consul',         signal: 'mesh' },
  { match: image(named(String.raw`kong(?:-gateway)?(?:-dev)?`, 'kong-')),                product: 'kong',           signal: 'gateway' },
  { match: image(String.raw`^traefik\/traefik`, named('traefik', 'library-')),     product: 'traefik',        signal: 'gateway' },
  { match: /fluent[-/]?bit|fluent-bit/i,                                  product: 'fluent-bit',              signal: 'logs' },
  { match: image(named(String.raw`alloy(?:-dev)?`, 'grafana-')),                   product: 'alloy',          signal: 'collection' },
  { match: /^elastic\/beats|^beats:/i,                                      product: 'beats',                   signal: 'collection' },
  { match: image(String.raw`timberio\/vector`, named('vector', 'timberio-')),         product: 'vector',                  signal: 'collection' },
  // Additional common production stacks
  { match: /victoriametrics\/victoria-metrics|victoriametrics\/vmselect|victoriametrics\/vminsert|victoriametrics\/vmstorage|victoriametrics\/vmagent/i,
                                                                          product: 'victoriametrics',         signal: 'metrics' },
  { match: /victoriametrics\/vmalert/i,                                   product: 'vmalert',                 signal: 'alerting' },
  { match: /kube-state-metrics/i,                                          product: 'kube-state-metrics',      signal: 'metrics' },
  { match: image(String.raw`prom\/node-exporter`, 'node_exporter', named('node-exporter', 'prometheus-')), product: 'node-exporter', signal: 'metrics' },
  { match: image(String.raw`grafana\/promtail`, named('promtail', 'grafana-')),      product: 'promtail',                signal: 'logs' },
  { match: /grafana\/k6|loadimpact\/k6/i,                                 product: 'k6',                      signal: 'metrics' },
  { match: /^otel\/opentelemetry-collector-contrib/i,                     product: 'opentelemetry-collector', signal: 'collection' },
  { match: image(named('opensearch', 'opensearchproject-')), product: 'opensearch',   signal: 'logs' },
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

// The products a scrape job named for an exporter that reads more than one of
// them is evidence of, alike: the elasticsearch_exporter reads Elasticsearch
// and OpenSearch, so its job cannot tell which of them runs (the comparison
// leaves such a pair uncompared, tools/lib/diff.mjs). [] for any other job.
const PRODUCTS_BY_SHARED_EXPORTER_JOB = { 'elasticsearch-exporter': ['elasticsearch', 'opensearch'] };
export function productsAScrapeJobServes(job) {
  return PRODUCTS_BY_SHARED_EXPORTER_JOB[String(job || '').trim().toLowerCase().replace(/_/g, '-')] || [];
}
