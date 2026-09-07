#!/usr/bin/env node
/**
 * tools/test-record-fixtures.mjs
 *
 * The recorder (tools/record-mcp-fixtures.mjs) against a fake JSON-RPC MCP
 * that replays the recorded and synthetic fixtures. Nothing here talks to
 * a real server — this pins the recorder's CONTRACT so a maintainer can
 * trust its first live run:
 *
 *   1. report mode writes nothing and names the surface honestly: the
 *      tools/list drift (unmatched tool), the inventory size, which
 *      aliases are eligible / not-in-inventory / sampled, the status tools;
 *   2. --write records the fixtures the README prescribes into --out: the
 *      full inventory review copy, the trimmed inventory (every required
 *      name kept, first 25 others), the probe payloads with lists capped
 *      and field structure verbatim, one instant vector per family, the
 *      status tools — each satisfying its capability's response shape;
 *   3. the bearer token never appears in stdout, stderr or any file;
 *   4. a restricted tier (no metrics_query) reads not-attempted, exit 0.
 */

import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHarness } from './lib/harness.mjs';
import { capability } from './lib/contracts/mcp-capabilities.mjs';
import { validateResponseShape } from './lib/contracts/response-shapes.mjs';
import { STACK_SELF_METRIC_PROBES, STACK_FAMILIES } from './lib/contracts/stack-self-metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FIXTURES = resolve(ROOT, 'tools', 'fixtures', 'mcp');
const RECORDER = resolve(ROOT, 'tools', 'record-mcp-fixtures.mjs');
const { assert, report } = createHarness({ indent: '  ', truncate: 200 });

const fx = (name) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
// Synthetic fixtures replayed as if a server answered: the markers are
// authoring metadata, a server would not send them.
const synthetic = (name) => {
  const j = fx(join('synthetic', name));
  delete j._synthetic; delete j._shape; delete j._query;
  return j;
};

const TOKEN = 'SECRET-TOKEN-sentinel-8675309';

// Inventory: the recorded 24 names, 40 fillers, then the names the alias
// table requires AT THE END — so the trimmed fixture proves it keeps
// required names beyond the first-25 window.
const REQUIRED_PRESENT = ['up', 'scrape_duration_seconds', 'prometheus_tsdb_head_series', 'prometheus_build_info'];
const inventory = [
  ...fx('metrics_label_values.json').values,
  ...Array.from({ length: 40 }, (_, i) => `filler_metric_${String(i).padStart(2, '0')}`),
  ...REQUIRED_PRESENT,
];

const tenDashboards = (() => {
  const d = fx('grafana_dashboards_search.json');
  const results = Array.from({ length: 10 }, (_, i) => ({ ...d.results[i % d.results.length], uid: `uid-${i}` }));
  return { ...d, results };
})();

// Handler returns { result } or { isError: true, text }.
function answer(name, args) {
  switch (name) {
    case 'metrics_label_values': return { label: '__name__', values: inventory };
    case 'metrics_targets': return fx('metrics_targets.json');
    case 'vmalert_rules': return fx('vmalert_rules.json');
    case 'grafana_dashboards_search': return tenDashboards;
    case 'metrics_query': {
      const q = String(args?.query || '');
      if (q.includes('scrape_duration_seconds')) return { isError: true, text: 'query timed out' };
      if (q.includes('prometheus_tsdb_head_series')) return { result: [{ metric: {}, value: [1757203200, '123456'] }] };
      if (q === 'count(up == 0)') return { result: [] };   // nothing down → PromQL answers no series
      if (q.includes('up')) return synthetic('metrics_query.instant-vector.json');
      return { result: [] };
    }
    case 'alertmanager_status': return synthetic('alertmanager_status.json');
    case 'alertmanager_silences': return synthetic('alertmanager_silences.json');
    case 'grafana_datasources': return synthetic('grafana_datasources.json');
    case 'grafana_datasource_health': return synthetic('grafana_datasource_health.json');
    case 'grafana_contact_points': return synthetic('grafana_contact_points.json');
    case 'custom_tool_x': return { ok: true };
    default: return { isError: true, text: `unknown tool ${name}` };
  }
}

async function startFakeMcp(toolNames) {
  const calls = [];
  const srv = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'recorder-test' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }));
    };
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp' } });
    if (msg.method === 'tools/list') return send({ tools: toolNames.map(name => ({ name })) });
    if (msg.method === 'tools/call') {
      calls.push(msg.params);
      const a = answer(msg.params?.name, msg.params?.arguments || {});
      if (a?.isError) return send({ isError: true, content: [{ type: 'text', text: a.text }] });
      return send({ content: [{ type: 'text', text: JSON.stringify(a) }] });
    }
    send({});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  return { url: `http://${addr.address}:${addr.port}/mcp?token=${TOKEN}`, calls, close: () => new Promise(r => srv.close(r)) };
}

// Async on purpose: the fake MCP lives in THIS process, so a spawnSync
// would block the event loop that has to answer the recorder.
function runRecorder(url, extraArgs = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [RECORDER, ...extraArgs], {
      cwd: ROOT,
      env: { ...process.env, MCP_URL: url, MCP_AUTH: TOKEN, OBSERVOGRAM_DEBUG: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (status) => { clearTimeout(timer); done({ status, stdout, stderr }); });
  });
}

const FULL_TOOLS = ['metrics_label_values', 'metrics_targets', 'vmalert_rules', 'grafana_dashboards_search', 'metrics_query',
  'alertmanager_status', 'alertmanager_silences', 'grafana_datasources', 'grafana_datasource_health', 'grafana_contact_points',
  'custom_tool_x'];

const tmp = mkdtempSync(join(tmpdir(), 'observogram-recorder-'));
const fake = await startFakeMcp(FULL_TOOLS);
try {
  // ---- 1. report mode ----
  const reportDir = join(tmp, 'report');
  const rep = await runRecorder(fake.url, ['--out', reportDir]);
  assert(rep.status === 0, 'report mode exits 0', { status: rep.status, stderr: rep.stderr.slice(0, 300) });
  assert(!existsSync(reportDir), 'report mode writes nothing (the --out dir is never created)');
  assert(/tools\/list: 11 tools advertised — 10 known to the registry, 1 unmatched/.test(rep.stdout), 'report names the tools/list surface and the registry drift', rep.stdout.split('\n').find(l => l.startsWith('tools/list')));
  assert(/unmatched \(no registry row yet\): custom_tool_x/.test(rep.stdout), 'report lists the unmatched tool by name');
  assert(/metrics_query ✓ · alertmanager_status ✓/.test(rep.stdout), 'report shows the step-2 surface as advertised');
  assert(new RegExp(`metrics_label_values answered ${inventory.length} names`).test(rep.stdout), 'report states the inventory size from the adapted list');
  assert(/scrape\/scrape_success_ratio\s+generic\s+data 0\.98(00)? ratio/.test(rep.stdout), 'an eligible alias is sampled the way the fetcher reads it (0.98 ratio)', rep.stdout.split('\n').find(l => l.includes('scrape_success_ratio')));
  assert(/scrape\/scrape_targets_down\s+generic\s+empty/.test(rep.stdout), 'an empty instant vector reads as empty, not as a value');
  assert(/victoriametrics\s+not-in-inventory \(missing vm_promscrape_targets\)/.test(rep.stdout), 'an alias whose requires are absent is not-in-inventory and names the missing metric (no call)');
  assert(/scrape\/scrape_duration_max\s+generic\s+FAILED metrics_query: query timed out/.test(rep.stdout), 'a tool error reads as FAILED with the upstream message');
  assert(/tsdb\/tsdb_active_series\s+prometheus\s+data 123456 count/.test(rep.stdout), 'a count row reads its integer value');
  assert(/rows with data: 2\/24/.test(rep.stdout), 'the summary counts rows with data (2 of 24 on this fake)', rep.stdout.split('\n').find(l => l.includes('rows with data')));
  assert(/alertmanager_status: version .* — shape status-object ok/.test(rep.stdout), 'the Alertmanager status tool is summarised with its shape verdict');
  assert(/grafana_datasource_health: .* (OK|answered)/.test(rep.stdout), 'datasource health is asked per uid');
  assert(/scrape_configs\s+metrics_targets answered/.test(rep.stdout) && /recording_rules\s+vmalert_rules answered/.test(rep.stdout), 'probe families report their winning tool');
  const vmCalls = fake.calls.filter(c => c.name === 'metrics_query' && String(c.arguments?.query).includes('vm_promscrape_targets'));
  assert(vmCalls.length === 0, 'not-in-inventory aliases are never called');
  assert(!rep.stdout.includes(TOKEN) && !rep.stderr.includes(TOKEN), 'the bearer token never reaches stdout/stderr (URL query included)');
  assert(rep.stdout.includes('auth: bearer (redacted)'), 'the report says auth was used without showing it');

  // ---- 2. --write ----
  fake.calls.length = 0;
  const outDir = join(tmp, 'write');
  const wr = await runRecorder(fake.url, ['--write', '--out', outDir]);
  assert(wr.status === 0, '--write exits 0', { status: wr.status, stderr: wr.stderr.slice(0, 300) });
  const read = (rel) => JSON.parse(readFileSync(join(outDir, rel), 'utf8'));

  const full = read('.tmp-mcp-metric-names.json');
  assert(full.count === inventory.length && full.names.length === inventory.length, 'the full inventory review copy carries every name', { count: full.count });
  assert(typeof full.server === 'string' && !full.server.includes('token='), 'the review copy names the server without its query string');

  const trimmed = read('metrics_label_values.json');
  assert(trimmed.label === '__name__' && Array.isArray(trimmed.values), 'the trimmed inventory keeps the payload structure (label + values)');
  assert(REQUIRED_PRESENT.every(n => trimmed.values.includes(n)), 'every required name present in the inventory survives trimming, even beyond the first 25', trimmed.values);
  const others = trimmed.values.filter(n => !REQUIRED_PRESENT.includes(n));
  assert(others.length === 25, 'exactly 25 non-required names are kept', others.length);
  assert(JSON.stringify(others) === JSON.stringify(inventory.filter(n => !REQUIRED_PRESENT.includes(n)).slice(0, 25)), 'the kept names are the first 25 in the server\'s order');
  assert(!trimmed.values.includes('filler_metric_39'), 'later fillers are dropped');

  const targets = read('metrics_targets.json');
  assert(JSON.stringify(targets) === JSON.stringify(fx('metrics_targets.json')), 'a payload under the cap is recorded verbatim (metrics_targets)');
  const dash = read('grafana_dashboards_search.json');
  assert(dash.results.length === 6 && dash.count === tenDashboards.count, 'long lists are capped at 6 with scalars untouched (dashboards: 10 → 6, count kept)');
  assert(existsSync(join(outDir, 'vmalert_rules.json')), 'the winning rule tool payload is recorded under the tool name');
  const rules = read('vmalert_rules.json');
  assert(Array.isArray(rules.groups) && rules.groups[0].rules[0].query, 'rule payload keeps its group/rule structure');

  const stackDir = join(outDir, 'recorded-stack');
  const stackFiles = existsSync(stackDir) ? readdirSync(stackDir).sort() : [];
  // Eligible on this inventory: scrape_success_ratio (data), scrape_targets_down
  // (empty), scrape_duration_max (failed), tsdb_active_series (data) — so
  // exactly one file for scrape (the data row wins over the empty one) and
  // one for tsdb; every other family had no eligible alias to record.
  assert(JSON.stringify(stackFiles) === JSON.stringify(['scrape_success_ratio.json', 'tsdb_active_series.json']),
    'one instant vector per family that answered (scrape, tsdb); nothing for families with no eligible alias', stackFiles);
  const perFamily = new Map();
  for (const f of stackFiles) {
    const j = read(join('recorded-stack', f));
    assert(j._recorded?.tool === 'metrics_query' && typeof j._recorded.query === 'string' && j._recorded.row === f.replace(/\.json$/, ''),
      `${f}: carries _recorded provenance (tool, query, row)`, j._recorded);
    const v = validateResponseShape(capability('stack_self_metrics').responseShape, j);
    assert(v.ok, `${f}: satisfies the instant-vector shape`, v);
    perFamily.set(j._recorded.family, (perFamily.get(j._recorded.family) || 0) + 1);
  }
  assert([...perFamily.values()].every(n => n === 1), 'at most one recorded vector per family', Object.fromEntries(perFamily));
  assert(perFamily.get('scrape') === 1 && read('recorded-stack/scrape_success_ratio.json')._recorded.outcome === 'data',
    'a family with data records its data row, not a later empty one');
  assert(STACK_FAMILIES.length === 9 && STACK_SELF_METRIC_PROBES.length === 24, 'the table the recorder walks is the contract table (9 families, 24 rows)');

  for (const [id, file] of [['alertmanager_status', 'alertmanager_status.json'], ['alertmanager_silences', 'alertmanager_silences.json'],
    ['grafana_datasources', 'grafana_datasources.json'], ['grafana_datasource_health', 'grafana_datasource_health.json'],
    ['grafana_contact_points', 'grafana_contact_points.json']]) {
    assert(existsSync(join(outDir, file)), `${file} recorded (tool advertised)`);
    if (!existsSync(join(outDir, file))) continue;
    const j = read(file);
    assert(j._synthetic === undefined, `${file}: carries no _synthetic marker`);
    const v = validateResponseShape(capability(id).responseShape, j);
    assert(v.ok, `${file}: satisfies shape ${capability(id).responseShape}`, v);
  }
  assert(read('grafana_datasource_health.json')._recorded?.uid, 'datasource health names the uid it was asked for');

  const walk = (dir) => readdirSync(dir, { withFileTypes: true })
    .flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  const everything = [wr.stdout, wr.stderr, ...walk(outDir).map(p => readFileSync(p, 'utf8'))].join('\n');
  assert(!everything.includes(TOKEN), 'the bearer token is in no file and no output of --write');
  assert(/wrote .*recorded-stack/.test(wr.stdout) && /test-contract-shapes\.mjs --update/.test(wr.stdout), '--write lists what it wrote and names the follow-up commands');
} finally {
  await fake.close();
}

// ---- 3. restricted tier: no metrics_query, no status tools ----
const restricted = await startFakeMcp(['metrics_label_values', 'metrics_targets', 'vmalert_rules']);
try {
  const rep = await runRecorder(restricted.url);
  assert(rep.status === 0, 'restricted tier: report exits 0', { status: rep.status, stderr: rep.stderr.slice(0, 300) });
  assert(/metrics_query ✗/.test(rep.stdout), 'restricted tier: the step-2 surface shows metrics_query as not advertised');
  assert(/not-attempted \(metrics_query not exposed by this MCP \(restricted tier\)\)/.test(rep.stdout), 'restricted tier: eligible aliases read not-attempted with the tier reason, never absent');
  assert(/alertmanager_status: not advertised/.test(rep.stdout), 'restricted tier: status tools read not advertised');
  assert(restricted.calls.every(c => c.name !== 'metrics_query'), 'restricted tier: metrics_query is never called');
} finally {
  await restricted.close();
}

// ---- 4. no MCP_URL ----
const noUrl = spawnSync(process.execPath, [RECORDER], { cwd: ROOT, env: { ...process.env, MCP_URL: '' }, encoding: 'utf8' });
assert(noUrl.status === 1 && /MCP_URL is required/.test(noUrl.stderr), 'without MCP_URL the recorder exits 1 with usage');

rmSync(tmp, { recursive: true, force: true });
report('record-fixtures', 'the recorder reports honestly, records the README\'s fixtures, and never leaks the token.');
