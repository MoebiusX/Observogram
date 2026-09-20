#!/usr/bin/env node
/**
 * tools/test-golden-crawl.mjs
 *
 * Golden-output regression gate for the crawler. The property suites
 * (test-crawl.mjs) assert that specific behaviours hold; this test asserts
 * that the crawler's FULL output is byte-stable: a fixed fixture repo must
 * produce a canonical pack identical to the committed golden file.
 *
 * Why: a crawler change can be locally correct and still shift output
 * everywhere downstream (routes, conformance counts, drift buckets, grades).
 * Property tests won't notice unrelated drift — this does. ANY output
 * change, intended or not, fails CI and forces an explicit golden update in
 * the same commit, where the diff of the golden file documents exactly what
 * changed.
 *
 * To update after an INTENDED output change:
 *   node tools/test-golden-crawl.mjs --update
 * then review `git diff tools/fixtures/golden-crawl.pack.json` — that diff
 * is the output-space changelog of your commit. Exit 0 = pass.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { crawlFiles } from './lib/crawler.mjs';
import { validateCanonical } from './lib/validator.mjs';
import { createHarness } from './lib/harness.mjs';

const SCHEMA = JSON.parse(readFileSync(
  new URL('../vendor/observability-pack-spec/v1.2/observability-pack.schema.json', import.meta.url), 'utf8'));
const GOLDEN_URL = new URL('./fixtures/golden-crawl.pack.json', import.meta.url);

const { assert, report } = createHarness();

// A compact but representative fixture: compose backends, Prometheus rules
// (recording + burn-rate-shaped alerts), a Grafana dashboard, Alertmanager
// routes (mapped receiver + pure-placeholder webhook + embedded-placeholder
// webhook), an OTel collector, Helm values, and instrumented source. Keep
// this STABLE — extending it is an intentional golden change.
const FIXTURE = {
  'docker-compose.yml': `version: '3.8'
services:
  prometheus:
    image: prom/prometheus:v2.51.0
    ports: ["9090:9090"]
  grafana:
    image: grafana/grafana:12.0.0
    ports: ["3000:3000"]
  loki:
    image: grafana/loki:3.0.0
    ports: ["3100:3100"]
`,
  'prometheus/rules.yml': `groups:
  - name: slo
    rules:
      - record: golden:availability:good
        expr: sum(rate(http_requests_total{code!~"5.."}[5m]))
      - record: golden:availability:total
        expr: sum(rate(http_requests_total[5m]))
      - alert: GoldenAvailabilityBurnFast
        expr: golden:availability:good / golden:availability:total < 0.99
        for: 5m
        labels: { severity: critical }
`,
  'dashboards/golden.json': JSON.stringify({
    title: 'Golden Overview', uid: 'golden-overview', schemaVersion: 41, version: 1,
    panels: [{ title: 'Availability', type: 'stat', targets: [{ expr: 'golden:availability:good / golden:availability:total' }] }],
  }),
  'alertmanager.yml': `route:
  receiver: oncall
  routes:
    - match: { severity: critical }
      receiver: oncall
    - match: { severity: warning }
      receiver: hook-placeholder
    - match: { severity: info }
      receiver: hook-embedded
receivers:
  - name: oncall
    msteams_configs:
      - channel_url: '#golden-oncall'
  - name: hook-placeholder
    webhook_configs:
      - url: '\${GOLDEN_HOOK_URL}'
  - name: hook-embedded
    webhook_configs:
      - url: 'https://ntfy.sh/\${GOLDEN_TOPIC}?priority=high'
`,
  'otel-collector.yaml': `receivers:
  otlp:
    protocols: { http: {}, grpc: {} }
processors:
  batch: {}
exporters:
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
service:
  pipelines:
    metrics: { receivers: [otlp], processors: [batch], exporters: [prometheusremotewrite] }
`,
  'src/metrics.ts': `import { Counter } from 'prom-client';
export const requests = new Counter({ name: 'http_requests_total', help: 'requests', labelNames: ['code'] });
`,
};

const { canonical, summary } = crawlFiles(FIXTURE, { repoName: 'golden', now: '2026-01-01T00:00:00.000Z' });

// Sanity before comparing: the golden itself must always be schema-valid.
assert(validateCanonical(canonical, SCHEMA).length === 0,
  'golden fixture crawl validates against the schema',
  validateCanonical(canonical, SCHEMA).slice(0, 3));

const actual = JSON.stringify(canonical, null, 2) + '\n';

if (process.argv.includes('--update')) {
  writeFileSync(GOLDEN_URL, actual);
  process.stdout.write(`golden updated (${actual.length} bytes) — review git diff tools/fixtures/golden-crawl.pack.json\n`);
  process.exit(0);
}

let golden = null;
try { golden = readFileSync(GOLDEN_URL, 'utf8'); } catch (_) {}
assert(golden !== null,
  'golden file exists (run `node tools/test-golden-crawl.mjs --update` to create it)');

if (golden !== null) {
  if (actual === golden) {
    assert(true, 'crawler output is byte-identical to the committed golden');
  } else {
    // Locate the first divergence so the failure is actionable without a diff tool.
    const a = actual.split('\n'), g = golden.split('\n');
    let line = 0;
    while (line < Math.min(a.length, g.length) && a[line] === g[line]) line++;
    assert(false,
      'crawler output drifted from the golden — if intended, regenerate with --update and review the golden diff in the same commit',
      { firstDivergenceAtLine: line + 1, expected: g[line], actual: a[line] });
  }
  assert(summary.warnings.some(w => /unresolved \$\{VAR\}/.test(w)),
    'fixture exercises the placeholder-exclusion path (guards the guard)');
}

report('golden-crawl', 'crawler output matches the golden byte-for-byte.');
