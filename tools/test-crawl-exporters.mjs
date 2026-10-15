#!/usr/bin/env node
/**
 * tools/test-crawl-exporters.mjs
 *
 * The crawler learns metrics from prebuilt exporters and from an OTel
 * collector's scrape jobs (tools/lib/exporter-metrics.mjs, the exporter
 * kinds and the collector walker in tools/lib/crawler.mjs):
 *   A. the fixture repository (tools/fixtures/crawl/exporters/) — an
 *      mq-metric-samples config, its metrics manifest and a collector config
 *      under a chart's files/ — crawls into a valid pack holding the
 *      manifest's metrics, the collector's `qmgrs` job and the kafka
 *      exporter, and says which files the prod scope left out;
 *   B. a manifest's metric outranks the same name inferred from the config;
 *   C. the config's gates, scopes and namespace decide the families;
 *   D. a saved exposition (.prom / .metrics) is read, never from a test path;
 *   E. a downstream catalogue replaces and extends the built-in one;
 *   F. a collector with pipelines: the scrape job's exporters are the
 *      metrics pipelines' that list the receiver, endpoints without secrets;
 *   G. a malformed manifest is warned about, not dropped silently;
 *   H. a crawl with no exporter evidence carries none of the new keys;
 *   I. `packc emit --exporter` writes a manifest the crawler reads, and
 *      refuses what it cannot honestly record.
 * Exit 0 = pass.
 */

import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { crawlFiles, detectArtefactKind, scanReadsPath } from './lib/crawler.mjs';
import {
  parseExposition, manifestFromExposition, readMetricsManifest, safeSourceUrl, resolveExporterCatalogue,
} from './lib/exporter-metrics.mjs';
import { EXPORTER_CATALOGUE as BUILTIN } from './lib/exporter-catalogue.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness({ truncate: 600 });
const SCHEMA = JSON.parse(readFileSync(new URL(`../${SPEC_SCHEMA_PATH}`, import.meta.url), 'utf8'));
const NOW = '2026-10-15T00:00:00.000Z';
const EMIT = fileURLToPath(new URL('./emit-manifest.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));

const ROOT = fileURLToPath(new URL('./fixtures/crawl/exporters/', import.meta.url));
const FILES = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (scanReadsPath(name)) FILES[relative(ROOT, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
  }
})(ROOT);

const ann = (r) => r.canonical.metadata.annotations;
const json = (r, key) => JSON.parse(ann(r)[key] ?? 'null');

// ---------- A. the acceptance fixture, the default (prod) scope ----------
{
  assert(!('mq-exporter/Dockerfile' in FILES) && 'mq-exporter/config.yaml' in FILES && 'mq-exporter/metrics-manifest.json' in FILES
    && 'charts/otel-collector/files/collector.yaml' in FILES,
  'the fixture: the exporter config and manifest, the chart\'s collector config; the Dockerfile is not scanned', Object.keys(FILES));
  assert(detectArtefactKind('mq-exporter/config.yaml', FILES['mq-exporter/config.yaml']) === 'exporter-config', 'an mq-metric-samples config is an exporter config');
  assert(detectArtefactKind('mq-exporter/metrics-manifest.json', FILES['mq-exporter/metrics-manifest.json']) === 'metrics-manifest', 'metrics-manifest.json is a metrics manifest');
  assert(detectArtefactKind('x/ibm-mq.metrics-manifest.json', '{}') === 'metrics-manifest', '*.metrics-manifest.json is a metrics manifest');
  assert(detectArtefactKind('charts/otel-collector/files/collector.yaml', FILES['charts/otel-collector/files/collector.yaml']) === 'otel-collector',
    'a collector config with no service block is an OTel collector');

  const r = crawlFiles(FILES, { repoName: 'mq-platform', now: NOW });
  assert(validateCanonical(r.canonical, SCHEMA).length === 0, 'the crawl validates against the vendored schema', validateCanonical(r.canonical, SCHEMA).slice(0, 3));
  const names = json(r, 'crawler.discovered.metric_names');
  const manifest = JSON.parse(FILES['mq-exporter/metrics-manifest.json']);
  assert(manifest.metrics.every(m => names.includes(m.name)), 'every manifest metric is in crawler.discovered.metric_names', names);
  const origins = json(r, 'crawler.discovered.metric_origins');
  assert(manifest.metrics.every(m => origins[m.name].origin_kind === 'exporter-manifest' && origins[m.name].confidence === 'declared'
      && origins[m.name].candidate === false && origins[m.name].service === 'ibm-mq' && origins[m.name].file === 'mq-exporter/metrics-manifest.json'),
  'each is declared by the manifest, service ibm-mq', origins.ibmmq_queue_depth);
  assert(JSON.stringify(origins.ibmmq_queue_depth.labels) === '["qmgr","queue","usage","description"]' && origins.ibmmq_queue_depth.type === 'gauge',
    'with the manifest\'s type and labels', origins.ibmmq_queue_depth);

  const jobs = json(r, 'crawler.discovered.scrape_job_origins');
  assert(JSON.stringify(json(r, 'crawler.discovered.scrape_jobs')) === '["qmgrs"]', 'the collector\'s qmgrs job is a discovered scrape job', json(r, 'crawler.discovered.scrape_jobs'));
  assert(JSON.stringify(jobs.qmgrs) === JSON.stringify({
    file: 'charts/otel-collector/files/collector.yaml', metrics_path: '/metrics', interval: '30s',
    targets: ['mq-exp-qm1:9157', 'mq-exp-qm2:9157', 'mq-exp-qm3:9157'],
    via: 'otel-collector', receiver: 'prometheus/mq', target_count: 3,
    exporters: [{ name: 'kafka', kind: 'kafka', topic: 'mq-metrics' }],
  }), 'its interval, path, target count, receiver and the kafka topic it leaves by', jobs.qmgrs);
  assert(r.canonical.spec.pipelines.exporters.metrics.kind === 'kafka' && JSON.stringify(r.canonical.spec.pipelines.exporters.metrics) === '{"kind":"kafka"}',
    'pipelines.exporters.metrics is the kafka exporter, in the shape every exporter has', r.canonical.spec.pipelines.exporters.metrics);
  assert(!('crawler.scaffold.pipelines.exporters.metrics' in ann(r)), 'and is no longer the prometheusremotewrite scaffold');
  assert(r.evidence['pipelines.exporters.metrics'] === 'charts/otel-collector/files/collector.yaml', 'its evidence is the collector config');
  assert(JSON.stringify(r.canonical.spec.pipelines.receivers) === '[{"name":"prometheus"}]' && !('crawler.scaffold.pipelines.receivers[0]' in ann(r)),
    'the prometheus receiver is the pipeline\'s receiver', r.canonical.spec.pipelines.receivers);
  assert(!r.summary.warnings.some(w => /metrics-capable/.test(w)), 'debug is not a metrics exporter: one candidate, no ambiguity warning');

  const exporters = json(r, 'crawler.discovered.exporters');
  assert(JSON.stringify(exporters) === JSON.stringify({ 'ibm-mq': { sources: [{
    origin_kind: 'exporter-manifest', file: 'mq-exporter/metrics-manifest.json', metrics: 6, version: '5.6.0',
    source: 'http://mq-exporter:9157/metrics', generated_at: '2026-10-01T00:00:00.000Z' }] } })
    && ann(r)['crawler.discovered.exporters_count'] === '1',
  'crawler.discovered.exporters names ibm-mq and its manifest', exporters);

  const scoped = r.summary.warnings.find(w => /carry scrape jobs or exporter evidence/.test(w));
  assert(scoped === 'Environment scope "prod" excluded 2 file(s) that carry scrape jobs or exporter evidence: mq-exporter/config.yaml (exporter config: ibm-mq); preprod/otel-collector.yaml (collector scrape jobs: qmgrs-preprod). An environment that names no deployment profile (e.g. `all`) reads every file.',
    'the prod scope says which collection evidence it left out, and how to read it', scoped);
  assert(r.summary.environment.excluded.includes('mq-exporter/config.yaml') && !r.summary.environment.excluded.includes('mq-exporter/metrics-manifest.json'),
    'the manifest is read in every environment; the exporter config is scoped like any config', r.summary.environment.excluded);

  // The way out, followed literally.
  const all = crawlFiles(FILES, { repoName: 'mq-platform', environment: 'all', now: NOW });
  assert(!all.summary.warnings.some(w => /Environment scope/.test(w)) && all.summary.files.excludedByEnvironment === 0,
    '`all` reads every file: no scope, no warning');
  assert(JSON.stringify(json(all, 'crawler.discovered.scrape_jobs')) === '["qmgrs","qmgrs-preprod"]', 'and the preprod job is read', json(all, 'crawler.discovered.scrape_jobs'));
  assert(validateCanonical(all.canonical, SCHEMA).length === 0, 'that crawl validates too');

  // ---------- B. the manifest outranks the config ----------
  const o = json(all, 'crawler.discovered.metric_origins');
  assert(o.ibmmq_queue_depth.origin_kind === 'exporter-manifest' && o.ibmmq_queue_depth.confidence === 'declared' && o.ibmmq_queue_depth.candidate === false
    && o.ibmmq_queue_depth.help === 'Current depth of the queue',
  'a name both the manifest and the config give reads as the manifest\'s', o.ibmmq_queue_depth);
  assert(o.ibmmq_channel_bytes_sent.origin_kind === 'exporter-config' && o.ibmmq_channel_bytes_sent.confidence === 'inferred'
    && o.ibmmq_channel_bytes_sent.candidate === true && o.ibmmq_channel_bytes_sent.file === 'mq-exporter/config.yaml',
  'a name only the config gives is an inferred candidate', o.ibmmq_channel_bytes_sent);
  assert(all.summary.discovered.metricCandidatesUnreferenced > 0, 'curation counts the inferred names among the unreferenced candidates', all.summary.discovered.metricCandidatesUnreferenced);
  const sources = json(all, 'crawler.discovered.exporters')['ibm-mq'].sources;
  assert(sources.length === 2 && sources[0].origin_kind === 'exporter-config' && sources[0].metrics === BUILTIN.exporters[0].families.length
    && JSON.stringify(sources[0].gates) === '{"objectStatus":true,"publications":true}' && sources[0].namespace === 'ibmmq',
  'ibm-mq lists its config (every built-in family on) beside its manifest', sources);
}

// A config-inferred name a dashboard reads stays an inferred candidate (the
// config says the exporter runs, not that the name is right).
{
  const dash = JSON.stringify({ uid: 'mq', title: 'MQ', schemaVersion: 39, panels: [{ type: 'timeseries', title: 'depth', targets: [{ expr: 'max(ibmmq_queue_time_since_get)' }] }] });
  const r = crawlFiles({ 'config.yaml': FILES['mq-exporter/config.yaml'], 'grafana/mq.json': dash }, { repoName: 'mq', now: NOW });
  const o = json(r, 'crawler.discovered.metric_origins').ibmmq_queue_time_since_get;
  assert(o.origin_kind === 'promql-reference' && o.used_by.includes('dashboard:mq/depth'), 'a name the dashboard reads is primarily the reference', o);
}

// ---------- C. gates, scopes, namespace ----------
{
  const cfg = (g, objects, ns) => `global:\n${g}\nconnection:\n  queueManager: QM1\nobjects:\n${objects}\nprometheus:\n  port: 9157\n${ns}`;
  const fams = (text) => Object.keys(json(crawlFiles({ 'config.yaml': text }, { repoName: 'mq', now: NOW }), 'crawler.discovered.metric_origins') || {}).sort();
  const noStatus = fams(cfg('  useObjectStatus: false', '  queues: ["APP.*"]\n  channels: ["TO.*"]', ''));
  assert(noStatus.length && noStatus.every(n => !/status|uptime|connection_count|oldest|uncommitted|time_since|channel_/.test(n)),
    'useObjectStatus: false drops the status families', noStatus);
  const noPubs = fams(cfg('  usePublications: "false"', '  queues: ["APP.*"]\n  channels: ["TO.*"]', ''));
  assert(noPubs.length && !noPubs.some(n => /cpu|log_|mqconn|queue_depth|mqput|mqget/.test(n)), 'usePublications: "false" drops the published families', noPubs);
  const noObjects = fams(cfg('  logLevel: INFO', '  queues:\n  channels: []', ''));
  assert(noObjects.length && noObjects.every(n => /^ibmmq_qmgr_/.test(n)), 'with no queues or channels selected only the queue manager families remain', noObjects);
  const ns = fams(cfg('  logLevel: INFO', '  queues: APP.*', '  namespace: mqprod'));
  assert(ns.includes('mqprod_queue_depth') && ns.every(n => n.startsWith('mqprod_')) && !ns.some(n => /^mqprod_channel_/.test(n)),
    'prometheus.namespace prefixes every family; a string selection counts', ns);
  const bothOff = crawlFiles({ 'config.yaml': cfg('  useObjectStatus: off\n  usePublications: no', '  queues: ["A"]', '') }, { repoName: 'mq', now: NOW });
  assert(!('crawler.discovered.metric_origins' in ann(bothOff)) && json(bothOff, 'crawler.discovered.exporters')['ibm-mq'].sources[0].metrics === 0,
    'both switches off: no family, the exporter still recorded with 0', ann(bothOff)['crawler.discovered.exporters']);
  assert(detectArtefactKind('mq-collector.yaml', FILES['mq-exporter/config.yaml']) === 'exporter-config',
    'a config named like a collector is read by its shape first');
}

// ---------- D. exposition snapshots ----------
{
  const PROM = [
    '# HELP ibmmq_queue_depth Current depth',
    '# TYPE ibmmq_queue_depth gauge',
    'ibmmq_queue_depth{qmgr="QM1",queue="APP.IN",description="a, \\"quoted\\" } value"} 4',
    'ibmmq_queue_depth{qmgr="QM1",queue="APP.OUT"} 0',
    '# HELP http_request_duration_seconds Latency\\nsecond line',
    '# TYPE http_request_duration_seconds histogram',
    'http_request_duration_seconds_bucket{le="0.1",route="/a"} 1',
    'http_request_duration_seconds_sum{route="/a"} 0.2',
    'http_request_duration_seconds_count{route="/a"} 2',
    '# TYPE rpc_latency summary',
    'rpc_latency{quantile="0.5",method="get"} 1',
    'rpc_latency_count{method="get"} 3',
    '# TYPE jobs counter',
    'jobs_total{kind="x"} 7',
    'process_up 1',
    '# EOF',
  ].join('\n');
  const { families, samples } = parseExposition(PROM);
  const by = Object.fromEntries(families.map(f => [f.name, f]));
  assert(samples === 9 && families.map(f => f.name).join() === 'http_request_duration_seconds,ibmmq_queue_depth,jobs,process_up,rpc_latency',
    'families by name; suffixed samples fold into their family; an undeclared sample is its own', families.map(f => f.name));
  assert(JSON.stringify(by.ibmmq_queue_depth.labels) === '["qmgr","queue","description"]', 'label names only, a quoted value with `,` `}` and `\\"` parsed past', by.ibmmq_queue_depth);
  assert(JSON.stringify(by.http_request_duration_seconds.labels) === '["route"]' && by.http_request_duration_seconds.help === 'Latency\nsecond line',
    'a histogram family drops `le`; HELP unescaped', by.http_request_duration_seconds);
  assert(JSON.stringify(by.rpc_latency.labels) === '["method"]' && by.jobs.type === 'counter' && JSON.stringify(by.jobs.labels) === '["kind"]'
    && by.process_up.type === 'untyped', 'a summary drops `quantile`; `_total` folds into an OpenMetrics counter; no TYPE is untyped', [by.rpc_latency, by.jobs, by.process_up]);
  assert(!JSON.stringify(families).includes('APP.IN'), 'no label value is kept');

  assert(scanReadsPath('exporter/ibm-mq.prom') && scanReadsPath('snapshots/node.metrics'), 'a scan reads .prom and .metrics files');
  assert(detectArtefactKind('snapshots/ibm-mq.prom', PROM) === 'exposition-snapshot', 'a .prom file with families is an exposition snapshot');
  assert(detectArtefactKind('test/fixtures/ibm-mq.prom', PROM) === 'unknown' && detectArtefactKind('src/x.test.metrics', PROM) === 'unknown'
    && detectArtefactKind('testdata/a.prom', PROM) === 'unknown', 'never from a test or fixture path');
  assert(detectArtefactKind('notes.metrics', 'nothing to see here\n') === 'unknown', 'a .metrics file with no family is not a snapshot');

  const r = crawlFiles({ 'snapshots/ibm-mq.prom': PROM, 'test/ibm-mq.prom': '# TYPE test_only gauge\ntest_only 1\n' }, { repoName: 'snap', now: NOW });
  const o = json(r, 'crawler.discovered.metric_origins');
  assert(o.ibmmq_queue_depth.origin_kind === 'exporter-snapshot' && o.ibmmq_queue_depth.confidence === 'declared' && o.ibmmq_queue_depth.service === 'ibm-mq'
    && !('test_only' in o), 'a crawl declares the snapshot\'s families, named by the file; the test path is not read', o.ibmmq_queue_depth);
  assert(JSON.stringify(json(r, 'crawler.discovered.exporters')) === '{"ibm-mq":{"sources":[{"origin_kind":"exporter-snapshot","file":"snapshots/ibm-mq.prom","metrics":5}]}}',
    'the snapshot is a source of the exporter', ann(r)['crawler.discovered.exporters']);
  // Rank: manifest > snapshot > source code.
  const ranked = crawlFiles({
    'snapshots/ibm-mq.prom': PROM,
    'metrics-manifest.json': JSON.stringify({ exporter: 'ibm-mq', metrics: [{ name: 'ibmmq_queue_depth', type: 'gauge', help: 'from the manifest' }] }),
    'src/metrics.ts': "import { Gauge } from 'prom-client';\nexport const j = new Gauge({ name: 'jobs', help: 'from code' });\n",
  }, { repoName: 'snap', now: NOW });
  const ro = json(ranked, 'crawler.discovered.metric_origins');
  assert(ro.ibmmq_queue_depth.help === 'from the manifest' && ro.ibmmq_queue_depth.origin_kind === 'exporter-manifest'
    && ro.jobs.origin_kind === 'exporter-snapshot', 'the manifest outranks the snapshot, the snapshot outranks source code', [ro.ibmmq_queue_depth, ro.jobs]);
}

// ---------- E. a downstream catalogue ----------
{
  const custom = {
    exporters: [
      { id: 'ibm-mq', match: { keys: ['global', 'connection', 'objects', 'prometheus'] }, namespace: { path: 'prometheus.namespace', default: 'ibmmq' },
        families: [{ name: 'qmgr_custom_only', type: 'gauge', labels: ['qmgr'] }] },
      { id: 'acme-gw', match: { keys: ['acme', 'listen'] }, namespace: { default: 'acme' },
        gates: { tls: { path: 'acme.tls', default: false } },
        families: [{ name: 'requests_total', type: 'counter' }, { name: 'tls_handshakes_total', type: 'counter', gate: 'tls' }] },
      { id: 'Bad Id', match: { keys: ['x'] }, families: [{ name: 'a', type: 'gauge' }] },
      { id: 'nofam', match: { keys: ['x'] }, families: [] },
      { id: 'badgate', match: { keys: ['x'] }, families: [{ name: 'a', type: 'gauge', gate: 'nope' }] },
    ],
  };
  const read = resolveExporterCatalogue(custom);
  assert(read.exporters.map(e => e.id).join() === 'ibm-mq,acme-gw' && read.warnings.length === 3
    && read.warnings.every(w => /; dropped\.$/.test(w)), 'an entry replaces the built-in one with its id, a new one is added, malformed ones dropped with a warning', read.warnings);
  assert(BUILTIN.exporters[0].families.length > 1 && resolveExporterCatalogue().exporters[0].families.length === BUILTIN.exporters[0].families.length,
    'the built-in catalogue is untouched by a resolution');
  const r = crawlFiles({
    'mq/config.yaml': FILES['mq-exporter/config.yaml'],
    'gw/acme.yaml': 'acme:\n  tls: true\nlisten: ":8080"\n',
  }, { repoName: 'cat', now: NOW, exporterCatalogue: custom });
  const o = json(r, 'crawler.discovered.metric_origins');
  assert(Object.keys(o).sort().join() === 'acme_requests_total,acme_tls_handshakes_total,ibmmq_qmgr_custom_only',
    'the crawl reads both configs with the downstream catalogue', Object.keys(o));
  assert(r.summary.warnings.filter(w => /exporter catalogue entry/.test(w)).length === 3, 'the dropped entries are crawl warnings');
  assert(detectArtefactKind('gw/acme.yaml', 'acme:\n  tls: true\nlisten: ":8080"\n') === 'unknown', 'without the catalogue the gateway config is nothing');
  const junk = crawlFiles({ 'a.yaml': 'a: 1\n' }, { repoName: 'cat', now: NOW, exporterCatalogue: 'not a catalogue' });
  assert(junk.summary.warnings.some(w => /neither `\{ exporters: \[\.\.\.\] \}` nor an array/.test(w)), 'a catalogue of the wrong shape is warned about');
}

// ---------- F. a collector with pipelines ----------
{
  const COL = `receivers:
  otlp:
    protocols: { grpc: {} }
  prometheus:
    config:
      scrape_configs:
        - job_name: node
          kubernetes_sd_configs: [{ role: pod }]
        - job_name: qmgrs
          scrape_interval: 15s
          static_configs:
            - targets: ["a:9157", "b:9157"]
            - targets: ["c:9157"]
exporters:
  prometheusremotewrite:
    endpoint: https://writer:s3cret@mimir.example:443/api/v1/push?token=abc#frag
  otlphttp/tempo:
    endpoint: http://tempo:4318
  kafka/metrics:
    topic: legacy-topic
service:
  pipelines:
    metrics:
      receivers: [otlp, prometheus]
      exporters: [prometheusremotewrite]
    metrics/archive:
      receivers: [prometheus]
      exporters: [kafka/metrics]
    traces:
      receivers: [otlp]
      exporters: [otlphttp/tempo]
`;
  const r = crawlFiles({ 'deploy/otel-collector.yaml': COL }, { repoName: 'col', now: NOW });
  const jobs = json(r, 'crawler.discovered.scrape_job_origins');
  const leave = [{ name: 'prometheusremotewrite', kind: 'prometheusremotewrite', endpoint: 'https://mimir.example:443/api/v1/push' }, { name: 'kafka/metrics', kind: 'kafka', topic: 'legacy-topic' }];
  assert(JSON.stringify(jobs.qmgrs.exporters) === JSON.stringify(leave) && jobs.qmgrs.target_count === 3 && jobs.qmgrs.interval === '15s',
    'the job leaves by every metrics pipeline that lists its receiver; the endpoint loses userinfo, query and fragment', jobs.qmgrs);
  assert(jobs.node.target_count === 0 && JSON.stringify(jobs.node.targets) === '["kubernetes:pod"]', 'a discovered-target job counts no static target', jobs.node);
  assert(!ann(r)['crawler.discovered.scrape_job_origins'].includes('s3cret') && !ann(r)['crawler.discovered.scrape_job_origins'].includes('token'),
    'no credential reaches an annotation');
  const pe = r.canonical.spec.pipelines.exporters;
  assert(JSON.stringify([pe.metrics, pe.traces, pe.logs]) === '[{"kind":"prometheusremotewrite"},{"kind":"otlp"},{"kind":"elasticsearch"}]',
    'the pipelines read as before', r.canonical.spec.pipelines.exporters);
  // Every spelling of a credential: a password holding `@`, `/` or `?`, no
  // scheme, a scheme-relative URL, one a URL parser reads as host:port/path.
  const SECRETS = [
    ['user:p@ss@otel:4317', 'otel:4317'],
    ['user:pa/ss@otel:4317', 'otel:4317'],
    ['https://user:pa/ss@otel:4317/v1', 'https://otel:4317/v1'],
    ['https://user:12/ss@otel/v1', 'https://otel/v1'],
    ['https://u:pa?ss@h/x', 'https://h/x'],
    ['//u:p@h/metrics', '//h/metrics'],
    ['HTTPS://U:P@H:1/m?t=1#f', 'HTTPS://H:1/m'],
    ['svc:Zx9/Qk+SECRET==@otel-gw:4317', 'otel-gw:4317'],
  ];
  assert(SECRETS.every(([raw, want]) => safeSourceUrl(raw) === want), 'safeSourceUrl drops everything before the last @ and from the first ? or #',
    SECRETS.map(([raw]) => safeSourceUrl(raw)), SECRETS.map(([, want]) => want));
  const leak = crawlFiles({ 'otel/collector.yaml': `receivers:\n  prometheus:\n    config:\n      scrape_configs:\n        - job_name: mq\n          static_configs: [{ targets: ["a:1"] }]\nexporters:\n  otlp:\n    endpoint: "svc:Zx9/Qk+SECRETPW@otel-gw:4317"\n` }, { repoName: 'col', now: NOW });
  assert(!JSON.stringify(leak.canonical).includes('SECRET') && json(leak, 'crawler.discovered.scrape_job_origins').mq.exporters[0].endpoint === 'otel-gw:4317',
    'a collector endpoint whose password holds `/` reaches the pack without it', json(leak, 'crawler.discovered.scrape_job_origins').mq);
  assert(safeSourceUrl('prometheus:9090') === 'prometheus:9090' && safeSourceUrl('${env:ENDPOINT}') === '${env:ENDPOINT}'
    && safeSourceUrl('u:p@host:4317?x=1') === 'host:4317' && safeSourceUrl('http://h:9157') === 'http://h:9157' && safeSourceUrl('http://h:9157/') === 'http://h:9157/',
  'safeSourceUrl: a non-URL keeps its spelling less userinfo and query');

  // Two metrics-capable exporters and no pipelines: the first, with a warning.
  const two = crawlFiles({ 'files/collector.yaml': 'receivers:\n  otlp: {}\nexporters:\n  otlp:\n    endpoint: http://gw:4317\n  kafka:\n    topic: t\n' }, { repoName: 'col', now: NOW });
  assert(two.canonical.spec.pipelines.exporters.metrics.kind === 'otlp'
    && two.summary.warnings.includes("files/collector.yaml has no service pipelines and 2 metrics-capable exporters (otlp, kafka); the metrics exporter is taken to be the first, 'otlp'."),
  'two candidates: the first is taken and the warning says so', two.summary.warnings);
  // An Alertmanager config (receivers is a list) is still Alertmanager.
  assert(detectArtefactKind('am.yaml', 'route:\n  receiver: x\nreceivers:\n  - name: x\n') === 'alertmanager', 'Alertmanager receivers are not a collector\'s');

  // A collector embedded in a Helm ConfigMap with no service block.
  const TPL = `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "c.fullname" . }}
data:
  relay.yaml: |
    receivers:
      prometheus:
        config:
          scrape_configs:
            - job_name: qmgrs
              static_configs:
                - targets: ["q:9157"]
    exporters:
      kafka:
        topic: mq
`;
  const h = crawlFiles({ 'charts/c/templates/cm.yaml': TPL, 'charts/c/Chart.yaml': 'apiVersion: v2\nname: c\nversion: 0.1.0\n' }, { repoName: 'col', now: NOW });
  assert(JSON.stringify(json(h, 'crawler.discovered.scrape_jobs')) === '["qmgrs"]' && h.canonical.spec.pipelines.exporters.metrics.kind === 'kafka',
    'a Helm ConfigMap\'s collector with no service block: its job and its kafka exporter', ann(h)['crawler.discovered.scrape_jobs']);
}

// ---------- G. a malformed manifest ----------
{
  const r = crawlFiles({
    'a/metrics-manifest.json': '{ "metrics": [] }',
    'b/metrics-manifest.json': JSON.stringify({ exporter: 'x', metrics: [{ name: 'ok_metric', type: 'Gauge' }, { name: '9bad', type: 'gauge' }, { name: 'ok_metric', type: 'counter' }, { name: 'no_type' }] }),
    'c/metrics-manifest.json': 'not json',
  }, { repoName: 'bad', now: NOW });
  const w = r.summary.warnings;
  assert(w.includes('a/metrics-manifest.json is not a metrics manifest (no `exporter` name); it is not read.')
    && w.some(x => x.startsWith('c/metrics-manifest.json is not a metrics manifest (not JSON')),
  'a manifest that is not one is named in a warning', w);
  assert(w.some(x => x.startsWith('b/metrics-manifest.json: 3 metric entries are not read')), 'skipped entries are counted', w);
  assert(JSON.stringify(json(r, 'crawler.discovered.metric_names')) === '["ok_metric"]', 'the valid entry is read (the type case-insensitive)');
  const m = readMetricsManifest(JSON.stringify({ exporter: 'x', source: 'https://u:p@h/metrics?t=1', metrics: [] }));
  assert(m.ok && m.manifest.source === 'https://h/metrics', 'a manifest\'s source is recorded without userinfo or query', m.manifest);
}

// ---------- H. no exporter evidence: none of the new keys ----------
{
  const r = crawlFiles({
    'otel-collector.yaml': 'receivers:\n  otlp: {}\nexporters:\n  otlp:\n    endpoint: http://x:4317\nservice:\n  pipelines:\n    metrics: { receivers: [otlp], exporters: [otlp] }\n',
    'src/metrics.ts': "import { Counter } from 'prom-client';\nexport const c = new Counter({ name: 'reqs_total', help: 'r' });\n",
  }, { repoName: 'plain', now: NOW });
  const keys = Object.keys(ann(r));
  assert(!keys.some(k => /^crawler\.discovered\.(exporters|scrape_job)/.test(k)) && !('exporters' in r.summary.discovered)
    && JSON.stringify(r.canonical.spec.pipelines.exporters.metrics) === '{"kind":"otlp"}',
  'a crawl with no exporter or collector scrape evidence carries no new key', keys.filter(k => /discovered/.test(k)));
}

// ---------- I. packc emit --exporter ----------
const EXPOSITION = '# HELP ibmmq_qmgr_status Status\n# TYPE ibmmq_qmgr_status gauge\nibmmq_qmgr_status{qmgr="QM1",platform="UNIX"} 1\n'
  + '# TYPE ibmmq_queue_depth gauge\nibmmq_queue_depth{qmgr="QM1",queue="APP.IN"} 3\n';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/metrics') { res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }); res.end(EXPOSITION); return; }
  if (path === '/moved') { res.writeHead(302, { location: '/metrics?token=abc' }); res.end(); return; }
  if (path === '/empty') { res.writeHead(200); res.end('\n'); return; }
  if (path === '/badloc') { res.writeHead(302, { location: 'http://[oops/metrics' }); res.end(); return; }
  res.writeHead(500); res.end('boom');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
// The child must not block the event loop the server answers on.
const run = (args, script = EMIT) => new Promise((resolveRun) => {
  const child = spawn(process.execPath, [script, ...args], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  child.on('close', status => resolveRun({ status, stdout, stderr }));
});
const tmp = mkdtempSync(join(tmpdir(), 'emit-manifest-'));
try {
  const ok = await run(['--exporter', `${base}/metrics?token=abc`, '--name', 'ibm-mq', '--version', '5.6.0', '--generated-at', NOW]);
  assert(ok.status === 0 && ok.stdout === 'wrote metrics-manifest.json: 2 metric families of ibm-mq\n', 'emit writes metrics-manifest.json', ok);
  const written = JSON.parse(readFileSync(join(tmp, 'metrics-manifest.json'), 'utf8'));
  assert(JSON.stringify(written) === JSON.stringify({
    exporter: 'ibm-mq', version: '5.6.0', source: `${base}/metrics`, generatedAt: NOW,
    metrics: [
      { name: 'ibmmq_qmgr_status', type: 'gauge', help: 'Status', labels: ['qmgr', 'platform'] },
      { name: 'ibmmq_queue_depth', type: 'gauge', labels: ['qmgr', 'queue'] },
    ],
  }), 'the manifest: names, types, help, label names; the source without its query', written);
  assert(!readFileSync(join(tmp, 'metrics-manifest.json'), 'utf8').includes('APP.IN'), 'no label value is written');
  const crawled = crawlFiles({ 'metrics-manifest.json': readFileSync(join(tmp, 'metrics-manifest.json'), 'utf8') }, { repoName: 'emitted', now: NOW });
  assert(JSON.stringify(json(crawled, 'crawler.discovered.metric_names')) === '["ibmmq_qmgr_status","ibmmq_queue_depth"]', 'the crawler reads what emit writes');
  assert(JSON.stringify(manifestFromExposition(EXPOSITION, { exporter: 'ibm-mq', version: '5.6.0', source: `${base}/metrics`, generatedAt: NOW })) === JSON.stringify(written),
    'the CLI writes exactly manifestFromExposition\'s manifest');

  const viaPackc = await run(['emit', '--exporter', `${base}/metrics`, '--out', '-', '--no-timestamp'], CLI);
  const piped = JSON.parse(viaPackc.stdout);
  assert(viaPackc.status === 0 && piped.exporter === '127.0.0.1' && !('generatedAt' in piped) && piped.metrics.length === 2,
    '`packc emit` dispatches; --out - writes to stdout; the host names the exporter; --no-timestamp leaves the stamp out', viaPackc);

  writeFileSync(join(tmp, 'qm1.prom'), EXPOSITION);
  const from = await run(['--from', 'qm1.prom', '--out', '-', '--no-timestamp']);
  assert(from.status === 0 && JSON.parse(from.stdout).exporter === 'qm1' && !('source' in JSON.parse(from.stdout)), '--from reads a saved exposition, named by the file', from);

  const refusals = [
    [['--exporter', `${base}/moved`], 1, `packc emit: ${base}/moved answered 302, a redirect to ${base}/metrics?token=… (query values not shown); it is not followed — pass the URL the exporter serves its metrics at, with the query values it expects\n`],
    [['--exporter', `${base}/badloc?token=SECRET3`], 1, `packc emit: ${base}/badloc answered 302, a redirect to a location that is not a URL; it is not followed — pass the URL the exporter serves its metrics at\n`],
    [['--exporter', '//admin:SECRET1@127.0.0.1:1/metrics'], 2, "packc emit: --exporter '//127.0.0.1:1/metrics' is not a URL (e.g. http://mq-exporter:9157/metrics); shown without anything before an @ or after a ? or #\n"],
    [['--exporter', `${base}/broken`], 1, `packc emit: ${base}/broken answered 500; a metrics endpoint answers 200\n`],
    [['--exporter', `${base}/empty`], 1, `packc emit: ${base}/empty holds no metric family (no # TYPE, # HELP or sample line)\n`],
    [['--exporter', 'http://u:p@127.0.0.1:1/metrics'], 2, 'packc emit: the --exporter URL carries credentials, which are neither sent nor recorded; save the exposition with your own client and pass it with --from\n'],
    [['--exporter', 'file:///etc/passwd'], 2, 'packc emit: --exporter must be an http or https URL, not file:\n'],
    [['--exporter', `${base}/metrics`, '--from', 'qm1.prom'], 2, 'packc emit: pass --exporter or --from, not both\n'],
    [['--exporter', `${base}/metrics`, '--bogus'], 2, null],
    [[], 2, null],
  ];
  for (const [args, code, message] of refusals) {
    const out = await run(args);
    assert(out.status === code && out.stdout === '' && (message === null || out.stderr === message),
      `emit ${args.join(' ') || '(no args)'} → exit ${code}${message ? ', the reason named' : ''}`, out, { status: code, message });
  }
  // The refusals' ways out work: save it yourself and pass --from (above);
  // the redirect's target with the query values it expects (the first run).
  assert(from.status === 0 && ok.status === 0, 'the credentials refusal\'s --from and the redirect refusal\'s URL with its query values are the runs that worked above');
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

// The crawl CLI reads a downstream catalogue file; an unreadable one is a usage error.
{
  const dir = mkdtempSync(join(tmpdir(), 'crawl-cat-'));
  try {
    writeFileSync(join(dir, 'acme.yaml'), 'acme:\n  tls: true\nlisten: ":8080"\n');
    writeFileSync(join(dir, 'cat.json'), JSON.stringify({ exporters: [{ id: 'acme-gw', match: { keys: ['acme', 'listen'] }, namespace: { default: 'acme' }, families: [{ name: 'up', type: 'gauge' }] }] }));
    const crawl = fileURLToPath(new URL('./crawl-repo.mjs', import.meta.url));
    const okRun = spawnSync(process.execPath, [crawl, dir, '--name', 'gw', '--exporter-catalogue', join(dir, 'cat.json')], { encoding: 'utf8' });
    assert(okRun.status === 0 && okRun.stdout.includes('acme_up') && okRun.stderr.includes('#   exporters        : 1'), 'x-ray --exporter-catalogue reads the file', okRun.stderr.slice(-400));
    const bad = spawnSync(process.execPath, [crawl, dir, '--name', 'gw', '--exporter-catalogue', join(dir, 'missing.json')], { encoding: 'utf8' });
    assert(bad.status === 2 && bad.stdout === '' && /--exporter-catalogue .*missing\.json.*ENOENT/.test(bad.stderr), 'a missing catalogue file is a usage error', bad.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

report('crawl-exporters');
