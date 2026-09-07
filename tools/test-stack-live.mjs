#!/usr/bin/env node
/**
 * tools/test-stack-live.mjs
 *
 * Live validation tier for the stack self-metric alias table
 * (tools/lib/contracts/stack-self-metrics.mjs) against the REAL products at
 * pinned versions — docker/stack.compose.yaml (`observogram-stack`).
 *
 * The table was documentation-grounded; the public MCP tier gave it its
 * first live evidence but only for what that stack happens to scrape. This
 * suite closes the loop for every row on every product:
 *
 *   (a) EXPOSITION — every `requires` name of every alias is present as a
 *       metric family on the product's own exposition (`/metrics`; the
 *       Prometheus TSDB name inventory for the scrape-synthesised `up` /
 *       `scrape_*` series; the blackbox `/probe` output for `probe_*`).
 *       Names the `expr` reads but `requires` does not demand are the
 *       table's lazily-registered counters (policy: require the sibling
 *       that registers with the counter, guard the zero on the sibling's
 *       presence) — they must be present AFTER the stimulus of (c), which
 *       is what proves the counter's name. The alias's `verified` stamp
 *       must name the compose image of the product it was checked on.
 *   (b) QUERY — every `expr` evaluates on a real Prometheus with status
 *       `success` and resultType `vector`; the sample is read through the
 *       fetcher's own `sampleFromInstantVector`, so the ledger says exactly
 *       what the sampler would say (data / empty), and a PromQL error is a
 *       FAIL that names the error.
 *   (c) LAZY-REGISTRATION probe (otelcol) — the collector's name set at
 *       startup, then one OTLP request per signal kind into the collector
 *       (whose second exporter targets a dead endpoint), then the name set
 *       again: before/after presence of `otelcol_exporter_send_failed_*`
 *       and `otelcol_processor_dropped_*` is recorded for the next slice.
 *
 * The suite reports; it never edits the table. The LEDGER (alias | product@
 * version | exposition | query) is printed and written to
 * `.tmp-stack-live-ledger.json` (git-ignored). Exit is non-zero on any
 * exposition ✗ or query ERROR, so it is a real gate — but it is NOT part of
 * `npm test`: it needs Docker. Without Docker it SKIPS loudly; --strict
 * turns the skip into a failure (CI). The stack is left running.
 *
 *   npm run test:stack:live            # skip loudly without Docker
 *   npm run test:stack:live:strict     # --strict
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STACK_SELF_METRIC_PROBES } from './lib/contracts/stack-self-metrics.mjs';
import { sampleFromInstantVector } from './fetch-live-pack.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');
const COMPOSE_FILE = join(ROOT, 'docker', 'stack.compose.yaml');
const PROM_CONFIG = join(ROOT, 'docker', 'stack', 'prometheus.yml');
const LEDGER_FILE = join(ROOT, '.tmp-stack-live-ledger.json');
const GRAFANA_AUTH = 'Basic ' + Buffer.from('admin:admin').toString('base64');

// Loopback ports from docker/stack.compose.yaml.
const PROM = 'http://127.0.0.1:19090';
const URL = Object.freeze({
  prometheus: 'http://127.0.0.1:19090/metrics',
  victoriametrics: 'http://127.0.0.1:18428/metrics',
  vmalert: 'http://127.0.0.1:18880/metrics',
  alertmanager: 'http://127.0.0.1:19093/metrics',
  otelcol: 'http://127.0.0.1:18888/metrics',
  otelcolHttp: 'http://127.0.0.1:14318',
  grafana: 'http://127.0.0.1:13030',
  blackbox: 'http://127.0.0.1:19115/metrics',
  // probe_* series exist only on the exporter's /probe output (the scrape
  // job's view), never on its own /metrics.
  blackboxProbe: 'http://127.0.0.1:19115/probe?module=http_2xx&target=http%3A%2F%2Fgrafana%3A3000%2Fapi%2Fhealth',
  promtail: 'http://127.0.0.1:19080/metrics',
  jaeger: 'http://127.0.0.1:14269/metrics',
});

// Alias product → compose service (for product@version) and exposition
// source. `generic` rows read Prometheus' scrape-synthesised series (`up`,
// `scrape_duration_seconds`…), which live in the TSDB, not on /metrics.
// `victoriametrics` covers two services: vm_* on victoriametrics, vmalert_*
// on vmalert — resolved per required name.
const PRODUCT_SERVICE = Object.freeze({
  generic: 'prometheus', prometheus: 'prometheus', victoriametrics: 'victoriametrics',
  alertmanager: 'alertmanager', otelcol: 'otel-collector', grafana: 'grafana',
  blackbox: 'blackbox-exporter', promtail: 'promtail', jaeger: 'jaeger',
});

const { assert, failures, report } = createHarness({ indent: '  ', truncate: 300 });
const say = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function skip(reason) {
  if (STRICT) {
    assert(false, `stack-live preconditions (--strict): ${reason}`);
    report('stack-live');
    return;
  }
  say(`stack-live: SKIPPED — ${reason}`);
  say('  (start it with: docker compose -f docker/stack.compose.yaml up -d --wait)');
  process.exit(0);
}

// ---------- preflight: docker + compose up --wait ----------
function ensureStack() {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (probe.status !== 0) return { ok: false, reason: 'docker is not available (daemon not running or CLI missing)' };
  say(`stack-live: docker ${probe.stdout.trim()} — compose up -d --wait via ${COMPOSE_FILE}`);
  const up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], { encoding: 'utf8', timeout: 300_000 });
  if (up.status !== 0) {
    return { ok: false, reason: `docker compose up failed: ${(up.stderr || up.stdout || '').trim().slice(0, 400)}` };
  }
  // The lazy-registration probe compares a product's name set at STARTUP
  // with the set after a stimulus; a collector / Grafana that already took
  // a previous run's stimulus would make "at startup" a lie, so the two
  // are recreated fresh on every run (the rest of the stack is reused).
  const fresh = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--force-recreate', '--wait', 'otel-collector', 'grafana'], { encoding: 'utf8', timeout: 300_000 });
  if (fresh.status !== 0) {
    return { ok: false, reason: `docker compose recreate (otel-collector, grafana) failed: ${(fresh.stderr || fresh.stdout || '').trim().slice(0, 400)}` };
  }
  return { ok: true };
}

function serviceVersions() {
  const compose = parseYaml(readFileSync(COMPOSE_FILE, 'utf8'));
  const out = {};
  for (const [name, svc] of Object.entries(compose.services || {})) {
    const image = String(svc?.image || '');
    out[name] = { image, version: image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'unknown' };
  }
  return out;
}

function expectedJobs() {
  const cfg = parseYaml(readFileSync(PROM_CONFIG, 'utf8'));
  return (cfg.scrape_configs || []).map((j) => String(j.job_name));
}

// ---------- HTTP helpers ----------
async function getText(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}
async function getJson(url, opts = {}) {
  return JSON.parse(await getText(url, opts));
}

// Metric family names of a Prometheus text exposition: the identifier
// that opens every sample line (labels and values stripped).
function familyNames(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)/.exec(line);
    if (m) names.add(m[1]);
  }
  return names;
}
async function exposition(url) {
  return familyNames(await getText(url));
}
async function tsdbNames() {
  const j = await getJson(`${PROM}/api/v1/label/__name__/values`);
  return new Set(Array.isArray(j?.data) ? j.data : []);
}

async function promQuery(expr) {
  const res = await fetch(`${PROM}/api/v1/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ query: expr }).toString(),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (_) { return { status: 'error', errorType: 'non-json', error: text.slice(0, 200) }; }
}

// ---------- readiness ----------
async function waitForTargets(jobs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = new Map();
  for (;;) {
    try {
      const j = await getJson(`${PROM}/api/v1/targets?state=any`);
      lastState = new Map();
      for (const t of j?.data?.activeTargets || []) {
        const job = t?.labels?.job;
        if (!job) continue;
        const prev = lastState.get(job) || { up: 0, total: 0, lastError: '' };
        prev.total += 1;
        if (t.health === 'up') prev.up += 1; else prev.lastError = String(t.lastError || t.health || '').slice(0, 160);
        lastState.set(job, prev);
      }
      const allUp = jobs.every((job) => { const s = lastState.get(job); return s && s.total > 0 && s.up === s.total; });
      if (allUp) return { allUp: true, state: lastState };
    } catch (_) { /* Prometheus not answering yet */ }
    if (Date.now() > deadline) return { allUp: false, state: lastState };
    await sleep(2000);
  }
}

// rate() needs two samples in its window: wait until every `up` series has
// at least two points in the last 5m (5s scrape → ~10s on a fresh stack).
async function waitForRateWindows(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const j = await promQuery('min(count_over_time(up[5m]))');
    const v = Number(j?.data?.result?.[0]?.value?.[1]);
    if (Number.isFinite(v) && v >= 2) return true;
    if (Date.now() > deadline) return false;
    await sleep(2000);
  }
}

// ---------- stimulus ----------
// One OTLP/HTTP request per signal kind. The collector's `otlp/dead`
// exporter cannot deliver them, so send_failed_* has its first failure.
const OTLP_RESOURCE = { attributes: [{ key: 'service.name', value: { stringValue: 'observogram-stack-live' } }] };
const nowNs = () => String(BigInt(Date.now()) * 1_000_000n);
function otlpPayloads() {
  const t = nowNs();
  return {
    traces: { resourceSpans: [{ resource: OTLP_RESOURCE, scopeSpans: [{ spans: [{ traceId: '5b8efff798038103d269b633813fc60c', spanId: 'eee19b7ec3c1b174', name: 'stack-live-probe', kind: 1, startTimeUnixNano: t, endTimeUnixNano: t }] }] }] },
    metrics: { resourceMetrics: [{ resource: OTLP_RESOURCE, scopeMetrics: [{ metrics: [{ name: 'stack_live_probe', gauge: { dataPoints: [{ asInt: '1', timeUnixNano: t }] } }] }] }] },
    logs: { resourceLogs: [{ resource: OTLP_RESOURCE, scopeLogs: [{ logRecords: [{ timeUnixNano: t, severityText: 'INFO', body: { stringValue: 'stack-live probe' } }] }] }] },
  };
}
async function sendOtlp() {
  const sent = {};
  for (const [kind, body] of Object.entries(otlpPayloads())) {
    try {
      const res = await fetch(`${URL.otelcolHttp}/v1/${kind}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      sent[kind] = `HTTP ${res.status}`;
    } catch (e) { sent[kind] = `error: ${String(e?.message || e).slice(0, 120)}`; }
  }
  return sent;
}

// One query through Grafana's datasource proxy and one through /api/ds/query
// so the datasource / proxy counters (label-vectored, hence lazy) have a
// request to count. Failures are recorded, never asserted.
async function stimulateGrafana() {
  const out = {};
  const auth = { authorization: GRAFANA_AUTH, 'content-type': 'application/json' };
  try {
    const res = await fetch(`${URL.grafana}/api/datasources/proxy/uid/stack-prom/api/v1/query?query=up`, { headers: auth });
    out.proxy = `HTTP ${res.status}`;
  } catch (e) { out.proxy = `error: ${String(e?.message || e).slice(0, 120)}`; }
  try {
    const body = { from: 'now-5m', to: 'now', queries: [{ refId: 'A', datasource: { uid: 'stack-prom' }, expr: 'up', instant: true }] };
    const res = await fetch(`${URL.grafana}/api/ds/query`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    out.dsQuery = `HTTP ${res.status}`;
  } catch (e) { out.dsQuery = `error: ${String(e?.message || e).slice(0, 120)}`; }
  return out;
}

async function waitForNames(url, names, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const have = await exposition(url);
    if (names.every((n) => have.has(n))) return have;
    if (Date.now() > deadline) return have;
    await sleep(2000);
  }
}

// ---------- the checks ----------
const TOKEN_RE = /[A-Za-z_:][A-Za-z0-9_:]*/g;
// Identifiers that are PromQL, not metric names, in the table's expressions.
const PROMQL_WORDS = new Set(['sum', 'count', 'max', 'min', 'avg', 'rate', 'increase', 'time', 'vector', 'or', 'and', 'unless', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right', 'm', 'h', 's', 'd']);
// Label matchers `{…}`, range selectors `[5m]` and grouping clauses
// (`by (…)`, `ignoring (…)`) are stripped first so label names never read
// as metric names.
const metricNamesIn = (expr) => [...new Set((expr
  .replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '')
  .replace(/\b(by|without|on|ignoring)\s*\([^)]*\)/g, '')
  .match(TOKEN_RE) || []).filter((t) => !PROMQL_WORDS.has(t) && !/^\d/.test(t)))];

// Where a required name is looked up: the product's exposition, with the
// documented exceptions (TSDB-synthesised series, blackbox probe output,
// vmalert_* on the vmalert service).
function sourceFor(product, name) {
  if (product === 'generic') return 'prometheus-tsdb';
  if (product === 'blackbox' && name.startsWith('probe_')) return 'blackbox-probe';
  if (product === 'victoriametrics' && name.startsWith('vmalert_')) return 'vmalert';
  return product;
}
function serviceFor(product, requires) {
  if (product === 'victoriametrics' && requires.every((n) => n.startsWith('vmalert_'))) return 'vmalert';
  return PRODUCT_SERVICE[product] || product;
}

async function main() {
  const pre = ensureStack();
  if (!pre.ok) { skip(pre.reason); return; }

  const versions = serviceVersions();
  const jobs = expectedJobs();
  say(`stack-live: waiting for ${jobs.length} scrape jobs to be up (120s)…`);
  const targets = await waitForTargets(jobs, 120_000);
  const never = jobs.filter((job) => { const s = targets.state.get(job); return !(s && s.total > 0 && s.up === s.total); });
  assert(targets.allUp, `every scrape job is up (${jobs.length} jobs)`, never.map((j) => `${j}: ${targets.state.get(j)?.lastError || 'no target'}`), []);
  if (!targets.allUp) { report('stack-live'); return; }
  say(`stack-live: all targets up; waiting for rate() windows (≥2 samples)…`);
  assert(await waitForRateWindows(60_000), 'every up series has ≥2 samples in the 5m window');

  // (c) lazy-registration probe — startup name sets FIRST, then stimulus.
  // Grafana rides along: its datasource / proxy counters are label-vectored
  // too, so they are recorded before and after the one query fired below.
  const otelBefore = await exposition(URL.otelcol);
  const grafanaBefore = await exposition(`${URL.grafana}/metrics`);
  const sent = await sendOtlp();
  say(`stack-live: OTLP stimulus sent → ${JSON.stringify(sent)}`);
  const grafanaStimulus = await stimulateGrafana();
  say(`stack-live: Grafana stimulus → ${JSON.stringify(grafanaStimulus)}`);
  say('stack-live: waiting for the dead exporter to give up (send_failed_* to register)…');
  const otelAfter = await waitForNames(URL.otelcol, ['otelcol_exporter_send_failed_spans', 'otelcol_exporter_send_failed_metric_points', 'otelcol_exporter_send_failed_log_records'], 45_000);
  const LAZY_WATCH = [
    'otelcol_exporter_send_failed_spans', 'otelcol_exporter_send_failed_spans_total',
    'otelcol_exporter_send_failed_metric_points', 'otelcol_exporter_send_failed_metric_points_total',
    'otelcol_exporter_send_failed_log_records', 'otelcol_exporter_send_failed_log_records_total',
    'otelcol_processor_dropped_spans', 'otelcol_processor_dropped_spans_total',
    'otelcol_processor_dropped_metric_points', 'otelcol_processor_dropped_metric_points_total',
    'otelcol_processor_dropped_log_records', 'otelcol_processor_dropped_log_records_total',
    'otelcol_exporter_sent_spans', 'otelcol_exporter_sent_metric_points', 'otelcol_exporter_sent_log_records',
    'otelcol_receiver_accepted_spans', 'otelcol_receiver_refused_spans',
    'otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity', 'otelcol_process_uptime',
  ];
  const lazy = {
    product: `otelcol@${versions['otel-collector']?.version}`,
    stimulus: sent,
    namesAtStartup: [...otelBefore].sort(),
    namesAfterStimulus: [...otelAfter].sort(),
    appearedAfterStimulus: [...otelAfter].filter((n) => !otelBefore.has(n)).sort(),
    watch: Object.fromEntries(LAZY_WATCH.map((n) => [n, { before: otelBefore.has(n), after: otelAfter.has(n) }])),
  };
  say('  lazy-registration (otelcol): name | at startup | after stimulus');
  for (const n of LAZY_WATCH) say(`    ${n.padEnd(52)} ${lazy.watch[n].before ? 'present' : 'absent '}  ${lazy.watch[n].after ? 'present' : 'absent '}`);
  say(`    startup names: ${otelBefore.size}; after stimulus: ${otelAfter.size}; appeared: ${lazy.appearedAfterStimulus.length}`);
  // Let Prometheus scrape the post-stimulus state before the query checks.
  await sleep(7000);
  const grafanaAfter = await exposition(`${URL.grafana}/metrics`);
  const GRAFANA_WATCH = ['grafana_datasource_request_total', 'grafana_proxy_response_status_total', 'grafana_alerting_rule_evaluation_failures_total', 'grafana_http_request_duration_seconds_count'];
  const grafanaLazy = {
    product: `grafana@${versions.grafana?.version}`,
    stimulus: grafanaStimulus,
    note: 'grafana_alerting_rule_evaluation_* register per org on the first rule evaluation (absent on a Grafana with no rules) — the stack provisions one always-firing rule (docker/stack/grafana-provisioning/alerting/rules.yaml, 10s interval) so they exist within one evaluation of startup; grafana_datasource_request_total registers on the first proxied datasource request',
    watch: Object.fromEntries(GRAFANA_WATCH.map((n) => [n, { before: grafanaBefore.has(n), after: grafanaAfter.has(n) }])),
    appearedAfterStimulus: [...grafanaAfter].filter((n) => !grafanaBefore.has(n)).sort(),
  };
  say('  lazy-registration (grafana): name | at startup | after stimulus');
  for (const n of GRAFANA_WATCH) say(`    ${n.padEnd(52)} ${grafanaLazy.watch[n].before ? 'present' : 'absent '}  ${grafanaLazy.watch[n].after ? 'present' : 'absent '}`);

  // Every exposition once, then the alias checks read from the cache.
  const expo = {
    'prometheus-tsdb': await tsdbNames(),
    prometheus: await exposition(URL.prometheus),
    victoriametrics: await exposition(URL.victoriametrics),
    vmalert: await exposition(URL.vmalert),
    alertmanager: await exposition(URL.alertmanager),
    otelcol: otelAfter,
    grafana: grafanaAfter,
    blackbox: await exposition(URL.blackbox),
    'blackbox-probe': await exposition(URL.blackboxProbe),
    promtail: await exposition(URL.promtail),
    jaeger: await exposition(URL.jaeger),
  };

  const ledger = [];
  say('\n  LEDGER — alias | product@version | exposition | query');
  for (const row of STACK_SELF_METRIC_PROBES) {
    for (const [i, a] of row.aliases.entries()) {
      const service = serviceFor(a.product, a.requires);
      const productVersion = `${a.product}@${versions[service]?.version || 'unknown'}`;
      // (a) exposition
      const missing = a.requires.filter((n) => !expo[sourceFor(a.product, n)]?.has(n));
      const sources = [...new Set(a.requires.map((n) => sourceFor(a.product, n)))];
      // Names the expr reads that `requires` does not demand — the table's
      // lazily-registered counters: absent at startup by nature, so they
      // are asserted against the POST-stimulus exposition (that is what the
      // stimulus is for); a lazy name still absent then is a wrong name.
      const lazyNames = metricNamesIn(a.expr).filter((n) => !a.requires.includes(n));
      const lazyPresence = Object.fromEntries(lazyNames.map((n) => [n, Boolean(expo[sourceFor(a.product, n)]?.has(n))]));
      const lazyMissing = lazyNames.filter((n) => !lazyPresence[n]);
      // The verified stamp must name the image this alias is checked on.
      const image = versions[service]?.image || '';
      const stampOk = typeof a.verified === 'string' && a.verified.startsWith(`${image} `);
      // (b) query
      const q = await promQuery(a.expr);
      let query;
      if (q?.status !== 'success') {
        query = { outcome: 'ERROR', value: null, error: `${q?.errorType || 'error'}: ${String(q?.error || '').slice(0, 200)}` };
      } else if (q?.data?.resultType !== 'vector') {
        query = { outcome: 'ERROR', value: null, error: `resultType ${q?.data?.resultType} (want vector)` };
      } else {
        const s = sampleFromInstantVector(row, q);
        query = { outcome: s.outcome, value: s.value, error: null, reason: s.reason || null };
      }
      const entry = {
        id: row.id, family: row.family, aliasIndex: i, product: a.product, service, productVersion,
        expr: a.expr, requires: [...a.requires], expositionSources: sources,
        exposition: missing.length || lazyMissing.length ? 'missing' : 'present', missing, lazyCounters: lazyPresence,
        verified: a.verified ?? null, verifiedMatchesImage: stampOk,
        query,
      };
      ledger.push(entry);
      const expoMark = missing.length ? `✗ (missing ${missing.join(', ')})` : '✓';
      const lazyMark = lazyNames.length ? ` lazy:{${lazyNames.map((n) => `${n}=${lazyPresence[n] ? 'present' : 'absent'}`).join(', ')}}` : '';
      const stampMark = stampOk ? '' : ` verified✗(${a.verified ?? 'missing'} ≠ ${image})`;
      const queryMark = query.outcome === 'ERROR' ? `ERROR ${query.error}` : `${query.outcome}${query.value === null ? '' : ` ${query.value}`}`;
      const label = `${row.id}[${i}] | ${productVersion} | exposition ${expoMark}${lazyMark}${stampMark} | query ${queryMark}`;
      assert(!missing.length && !lazyMissing.length && stampOk && query.outcome !== 'ERROR', label);
    }
  }

  const summary = {
    aliases: ledger.length,
    expositionPresent: ledger.filter((e) => e.exposition === 'present').length,
    expositionMissing: ledger.filter((e) => e.exposition === 'missing').length,
    verifiedStampMismatch: ledger.filter((e) => !e.verifiedMatchesImage).length,
    queryData: ledger.filter((e) => e.query.outcome === 'data').length,
    queryEmpty: ledger.filter((e) => e.query.outcome === 'empty').length,
    queryError: ledger.filter((e) => e.query.outcome === 'ERROR').length,
  };
  const out = {
    recordedAt: new Date().toISOString(),
    compose: 'docker/stack.compose.yaml',
    versions,
    targets: Object.fromEntries([...targets.state].map(([job, s]) => [job, { up: s.up, total: s.total }])),
    lazyRegistration: { otelcol: lazy, grafana: grafanaLazy },
    summary,
    ledger,
  };
  writeFileSync(LEDGER_FILE, JSON.stringify(out, null, 2) + '\n');
  say(`\n  ledger: ${summary.aliases} aliases — exposition ${summary.expositionPresent} ✓ / ${summary.expositionMissing} ✗ (lazy counters included); verified stamps ${summary.aliases - summary.verifiedStampMismatch}/${summary.aliases} match the compose images; query ${summary.queryData} data / ${summary.queryEmpty} empty / ${summary.queryError} ERROR`);
  say(`  written to ${LEDGER_FILE}`);
  say('  (the stack is left running: docker compose -f docker/stack.compose.yaml down -v to remove it)');
  report('stack-live', `all ${failures.length === 0 ? ledger.length : 0} alias checks pass against the live stack.`);
}

main().catch((e) => {
  process.stderr.write(`stack-live: crashed — ${e?.stack || e}\n`);
  process.exit(1);
});
