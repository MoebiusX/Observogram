#!/usr/bin/env node
/**
 * tools/record-mcp-fixtures.mjs
 *
 * Verify the stack self-metric alias table against a LIVE MCP, and record
 * the fixtures tools/fixtures/mcp/ is built from.
 *
 * Nothing in the alias table (tools/lib/contracts/stack-self-metrics.mjs)
 * was recorded against a live stack when it was written: every metric name
 * follows upstream documentation. This script is the verification path.
 *
 * Usage:
 *   MCP_URL=https://your-mcp/path [MCP_AUTH=token] npm run record-fixtures
 *   MCP_URL=… npm run record-fixtures -- --write [--out <dir>]
 *
 * Default mode prints a REPORT and writes nothing:
 *   - the tools/list surface, with drift against the contract registry
 *     (advertised tools the registry does not know; step-2 tools the
 *     server does not advertise);
 *   - the metric-name inventory (which candidate answered, how many names);
 *   - for every alias of every row: whether all of its `requires` are in
 *     the inventory, and — for the eligible ones — the sampled value read
 *     exactly the way the fetcher reads it (sampleFromInstantVector);
 *   - the Alertmanager / Grafana status tools, when advertised.
 *
 * `--write` records fixtures the way tools/fixtures/mcp/README.md
 * prescribes (field structure preserved verbatim, lists trimmed):
 *   .tmp-mcp-metric-names.json         the FULL metric-name list (repo
 *                                      root, git-ignored — the review copy)
 *   <fixtures>/<metric_names tool>.json the trimmed inventory: every name
 *                                      any alias requires (+ the build_info
 *                                      metrics) and the first 25 others
 *   <fixtures>/<tool>.json             scrape targets, the winning rule
 *                                      tool, dashboard search, and the
 *                                      status tools that were advertised
 *   <fixtures>/recorded-stack/<row>.json one metrics_query instant vector
 *                                      per family (first row with data,
 *                                      else the first honest empty)
 * `--out <dir>` redirects everything (the inventory file included) — the
 * recorder suite uses it; the default is tools/fixtures/mcp/.
 *
 * Afterwards: node tools/test-contract-shapes.mjs --update, then npm test
 * (the fixtures README lists the steps).
 *
 * Every tool name resolves through the contract registry — never a
 * literal (tools/test-contract-guard.mjs scans this file too). Read-only
 * against the MCP: initialize, tools/list, tools/call. The bearer token is
 * never printed and never written: every string that leaves this process
 * passes through redact().
 *
 * Requires Node 18+.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpClient, PROBES, sampleFromInstantVector, stackInventoryTrust } from './fetch-live-pack.mjs';
import { capabilityTool, allKnownToolNames, capability, BUILD_INFO_PROBES } from './lib/contracts/mcp-capabilities.mjs';
import { STACK_SELF_METRIC_PROBES, STACK_FAMILIES } from './lib/contracts/stack-self-metrics.mjs';
import { validateResponseShape } from './lib/contracts/response-shapes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_FIXTURE_DIR = resolve(ROOT, 'tools', 'fixtures', 'mcp');
const INVENTORY_FILE_NAME = '.tmp-mcp-metric-names.json';
const RECORDED_STACK_DIR = 'recorded-stack';

// Trimming policy — the README's "fewer rules / targets / dashboards /
// metric names, field structure preserved verbatim".
const FIXTURE_LIST_CAP = 6;      // longest list kept in any recorded payload
const INVENTORY_KEEP_OTHERS = 25; // names kept beyond the ones an alias requires
const HEALTH_LIMIT = 10;          // grafana_datasource_health calls (same cap as the fetcher)
const ERROR_LENGTH = 200;

// ---- arguments + environment ------------------------------------------

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const outIdx = argv.indexOf('--out');
const OUT_DIR = outIdx >= 0 && argv[outIdx + 1] ? resolve(argv[outIdx + 1]) : DEFAULT_FIXTURE_DIR;
// The full inventory is a review copy, not a fixture: it goes to the repo
// root (git-ignored) unless --out relocates the whole recording.
const INVENTORY_FILE = outIdx >= 0 ? resolve(OUT_DIR, INVENTORY_FILE_NAME) : resolve(ROOT, INVENTORY_FILE_NAME);

const MCP_URL = process.env.MCP_URL;
const MCP_AUTH = process.env.MCP_AUTH || null;
if (!MCP_URL) {
  process.stderr.write('[record-mcp-fixtures] MCP_URL is required (MCP_AUTH optional). Add --write to record fixtures.\n');
  process.exit(1);
}

// Never let the token out: not in the report, not in a file, not via an
// upstream error message that happens to echo a header — or the request
// URL. A credential may ride in MCP_URL's query string instead of
// MCP_AUTH (`?token=…`), so every query-string value of MCP_URL is
// redacted alongside MCP_AUTH.
const SECRETS = (() => {
  const s = new Set();
  if (MCP_AUTH) s.add(MCP_AUTH);
  try { for (const v of new URL(MCP_URL).searchParams.values()) if (v.length >= 6) s.add(v); } catch { /* unparseable */ }
  return [...s].sort((a, b) => b.length - a.length);
})();
const redact = (s) => (typeof s === 'string' ? SECRETS.reduce((acc, secret) => acc.split(secret).join('<redacted>'), s) : s);
const safeUrl = (u) => {
  try { const x = new URL(u); return `${x.origin}${x.pathname}`; }
  catch { return '<unparseable MCP_URL>'; }
};
const trimError = (v) => (v == null || v === '' ? null : redact(String(v)).slice(0, ERROR_LENGTH));
const out = (line = '') => process.stdout.write(redact(line) + '\n');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- MCP client (the fetcher's own) ------------------------------------

const { rpc, notify, callTool } = createMcpClient({ mcpUrl: MCP_URL, mcpAuth: MCP_AUTH });
const attempt = async (fn) => {
  try { return { response: await fn(), error: null }; }
  catch (e) { return { response: null, error: trimError(e?.message || String(e)) }; }
};
const recordedAt = new Date().toISOString();

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'observogram-recorder', version: '0.4.0' },
}).catch(() => null);
await notify('notifications/initialized').catch(() => {});

// ---- tools/list surface + registry drift -------------------------------

const toolsList = await attempt(() => rpc('tools/list'));
const exposed = Array.isArray(toolsList.response?.tools)
  ? toolsList.response.tools.map(t => t?.name).filter(n => typeof n === 'string')
  : [];
const hasToolsList = exposed.length > 0;
const advertised = (name) => !hasToolsList || exposed.includes(name);
const known = allKnownToolNames();
const unmatched = exposed.filter(n => !known.has(n));
const matched = exposed.filter(n => known.has(n));

const STEP2_CAPABILITIES = ['stack_self_metrics', 'alertmanager_status', 'alertmanager_silences',
  'grafana_datasources', 'grafana_datasource_health', 'grafana_contact_points'];
const step2Tools = STEP2_CAPABILITIES.map(id => ({ id, tool: capabilityTool(id), advertised: advertised(capabilityTool(id)) }));

// ---- probe cascades (the fetcher's candidate order + adapters) ---------

const isEmptyAdapted = (v) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && Object.keys(v).length === 0);
const candName = (c) => (typeof c === 'string' ? c : c.name);
const candArgs = (c) => (typeof c === 'string' ? {} : (c.args || {}));

// First advertised candidate that answers non-empty wins (the fetcher's
// rule); an honest empty answer is kept when nothing answers with data.
async function cascade(family) {
  const probe = PROBES.find(p => p.name === family);
  const attempted = [];
  let empty = null;
  let lastError = null;
  for (const cand of probe.candidates) {
    const name = candName(cand);
    if (!advertised(name)) continue;
    attempted.push(name);
    const r = await attempt(() => callTool(name, candArgs(cand)));
    if (r.error) { lastError = r.error; continue; }
    const adapted = probe.adapt(clone(r.response));
    if (!isEmptyAdapted(adapted)) return { family, tool: name, response: r.response, adapted, attempted, outcome: 'data', error: null };
    if (!empty) empty = { family, tool: name, response: r.response, adapted, attempted, outcome: 'empty', error: null };
  }
  if (empty) return { ...empty, attempted };
  return {
    family, tool: null, response: null, adapted: null, attempted,
    outcome: attempted.length === 0 ? 'unsupported' : 'failed', error: lastError,
  };
}

const inventoryProbe = await cascade('metric_names');
const inventoryNames = inventoryProbe.outcome === 'data' && Array.isArray(inventoryProbe.adapted) ? inventoryProbe.adapted : null;
const inventorySet = inventoryNames ? new Set(inventoryNames) : null;

// ---- alias table: every alias of every row -----------------------------

const metricsQueryTool = capabilityTool('stack_self_metrics');
const queryAdvertised = advertised(metricsQueryTool);
const aliasReport = [];
for (const row of STACK_SELF_METRIC_PROBES) {
  const entries = [];
  for (const alias of row.aliases) {
    const missing = inventorySet ? alias.requires.filter(n => !inventorySet.has(n)) : [];
    const entry = {
      id: row.id, family: row.family, unit: row.unit, product: alias.product, expr: alias.expr,
      requires: [...alias.requires], missing, eligible: missing.length === 0,
      inventoryKnown: inventorySet !== null,
      outcome: null, value: null, reason: null, response: null,
    };
    if (!entry.eligible) {
      entry.outcome = 'not-in-inventory';
      entry.reason = `missing ${missing.join(', ')}`;
    } else if (!queryAdvertised) {
      entry.outcome = 'not-attempted';
      entry.reason = `${metricsQueryTool} not exposed by this MCP (restricted tier)`;
    } else {
      const r = await attempt(() => callTool(metricsQueryTool, { query: alias.expr }));
      if (r.error) {
        entry.outcome = 'failed';
        entry.reason = r.error;
      } else {
        const sample = sampleFromInstantVector(row, r.response);
        entry.outcome = sample.outcome;
        entry.value = sample.value;
        entry.reason = sample.reason;
        entry.response = r.response;
      }
    }
    entries.push(entry);
  }
  aliasReport.push({ row, entries });
}

// ---- status surfaces ----------------------------------------------------

async function statusTool(id) {
  const tool = capabilityTool(id);
  if (!advertised(tool)) return { id, tool, advertised: false, response: null, error: null };
  const r = await attempt(() => callTool(tool));
  return { id, tool, advertised: true, ...r };
}
const alertmanagerStatus = await statusTool('alertmanager_status');
const alertmanagerSilences = await statusTool('alertmanager_silences');
const grafanaDatasources = await statusTool('grafana_datasources');
const grafanaContactPoints = await statusTool('grafana_contact_points');

// One datasource-health answer is enough for a fixture; the report lists
// every uid it asked about (capped like the fetcher).
const datasourceHealth = { id: 'grafana_datasource_health', tool: capabilityTool('grafana_datasource_health'), advertised: false, asked: [], response: null, uid: null, error: null };
if (grafanaDatasources.response && advertised(datasourceHealth.tool)) {
  datasourceHealth.advertised = true;
  const raw = grafanaDatasources.response;
  const list = Array.isArray(raw) ? raw : (raw?.datasources || raw?.data || []);
  for (const ds of (Array.isArray(list) ? list : []).filter(d => d?.uid).slice(0, HEALTH_LIMIT)) {
    const r = await attempt(() => callTool(datasourceHealth.tool, { uid: ds.uid }));
    datasourceHealth.asked.push({ uid: ds.uid, name: ds.name ?? null, error: r.error, status: r.response?.status ?? r.response?.data?.status ?? null });
    if (!datasourceHealth.response && r.response) { datasourceHealth.response = r.response; datasourceHealth.uid = ds.uid; }
  }
}

// ---- the other recorded probe families ---------------------------------

const scrape = await cascade('scrape_configs');
const recordingRules = await cascade('recording_rules');
const alertRules = await cascade('alert_rules');
const dashboards = await cascade('dashboards');

// ---- report --------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const fmtValue = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toPrecision(4)) : '—');
const shapeVerdict = (capId, payload) => {
  const shapeId = capability(capId).responseShape;
  if (!shapeId || payload == null) return null;
  const v = validateResponseShape(shapeId, payload);
  return v.ok ? `shape ${shapeId} ok (${v.items} items)` : `SHAPE ${shapeId} FAILS: ${v.reason || 'critical field missing'}`;
};

out(`record-mcp-fixtures — ${WRITE ? 'RECORDING' : 'report only (add --write to record)'}`);
out(`server: ${safeUrl(MCP_URL)}   at: ${recordedAt}   auth: ${MCP_AUTH ? 'bearer (redacted)' : 'none'}`);
out();
if (hasToolsList) {
  out(`tools/list: ${exposed.length} tools advertised — ${matched.length} known to the registry, ${unmatched.length} unmatched`);
  if (unmatched.length) out(`  unmatched (no registry row yet): ${unmatched.join(', ')}`);
} else {
  out(`tools/list: not answered${toolsList.error ? ` (${toolsList.error})` : ''} — older server, every candidate is tried`);
}
out(`  step-2 surface: ${step2Tools.map(t => `${t.tool} ${t.advertised ? '✓' : '✗'}`).join(' · ')}`);
out();
out(`metric inventory (${inventoryProbe.attempted.join(' → ') || 'no candidate advertised'}): ${
  inventoryNames ? `${inventoryProbe.tool} answered ${inventoryNames.length} names` : `${inventoryProbe.outcome}${inventoryProbe.error ? ` — ${inventoryProbe.error}` : ''} — aliases cannot be inventory-gated, every one is tried`}`);
// The fetcher's trust verdict on the same inventory: an inventory is
// evidence of presence, never of absence, and one without `up` gates
// nothing in the fetcher (rows are queried anyway). Printed here so a
// capped inventory is visible on the first live run.
const inventoryTrust = stackInventoryTrust(inventoryNames);
if (inventoryNames) {
  out(`  fetcher inventory trust: ${inventoryTrust.trusted ? `trusted (${inventoryTrust.size} names, carries up) — rows with no eligible alias read not-in-inventory in the fetcher` : `UNTRUSTED — ${inventoryTrust.reason}; the fetcher queries rows with no eligible alias anyway (bounded cascade)`}`);
}
out();
out(`alias table (${STACK_SELF_METRIC_PROBES.length} rows, ${aliasReport.reduce((n, r) => n + r.entries.length, 0)} aliases; ${metricsQueryTool} ${queryAdvertised ? 'advertised' : 'NOT advertised'}):`);
for (const { row, entries } of aliasReport) {
  entries.forEach((e, i) => {
    const head = i === 0 ? pad(`${row.family}/${row.id}`, 42) : pad('', 42);
    const state = e.outcome === 'not-in-inventory' ? `not-in-inventory (${e.reason})`
      : e.outcome === 'data' ? `data ${fmtValue(e.value)} ${row.unit}`
      : e.outcome === 'empty' ? `empty${e.reason ? ` (${e.reason})` : ''}`
      : e.outcome === 'failed' ? `FAILED ${e.reason}`
      : `not-attempted (${e.reason})`;
    out(`  ${head} ${pad(e.product, 16)} ${pad(state, 44)} ${e.expr}`);
  });
}
const outcomes = aliasReport.flatMap(r => r.entries.map(e => e.outcome));
const countOf = (o) => outcomes.filter(x => x === o).length;
const rowsWithData = aliasReport.filter(r => r.entries.some(e => e.outcome === 'data')).length;
out(`  aliases: ${countOf('data')} data · ${countOf('empty')} empty · ${countOf('failed')} failed · ${countOf('not-in-inventory')} not-in-inventory${inventoryNames ? ` (of a ${inventoryNames.length}-name inventory${inventoryTrust.trusted ? '' : ', untrusted'})` : ''} · ${countOf('not-attempted')} not-attempted; rows with data: ${rowsWithData}/${STACK_SELF_METRIC_PROBES.length}`);
out();
out('status tools:');
const describeStatus = (s, summary) => {
  if (!s.advertised) return `${s.tool}: not advertised`;
  if (s.error) return `${s.tool}: FAILED ${s.error}`;
  return `${s.tool}: ${summary(s.response)} — ${shapeVerdict(s.id, s.response)}`;
};
const asList = (raw, keys) => (Array.isArray(raw) ? raw : (keys.map(k => raw?.[k]).find(Array.isArray) || []));
out(`  ${describeStatus(alertmanagerStatus, (r) => `version ${r?.versionInfo?.version ?? r?.version ?? '?'}, cluster ${r?.cluster?.status ?? r?.status ?? '?'}`)}`);
out(`  ${describeStatus(alertmanagerSilences, (r) => `${asList(r, ['silences', 'data']).length} silences`)}`);
out(`  ${describeStatus(grafanaDatasources, (r) => `${asList(r, ['datasources', 'data']).length} datasources`)}`);
if (datasourceHealth.advertised) {
  out(`  ${datasourceHealth.tool}: ${datasourceHealth.asked.map(a => `${a.name || a.uid} ${a.error ? 'FAILED' : (a.status ?? 'answered')}`).join(', ') || 'no uid to ask about'}${datasourceHealth.response ? ` — ${shapeVerdict('grafana_datasource_health', datasourceHealth.response)}` : ''}`);
} else {
  out(`  ${datasourceHealth.tool}: ${grafanaDatasources.response ? 'not advertised' : 'skipped (no datasource list)'}`);
}
out(`  ${describeStatus(grafanaContactPoints, (r) => `${asList(r, ['contactPoints', 'contact_points', 'data']).length} contact points`)}`);
out();
out('probe families:');
for (const p of [scrape, recordingRules, alertRules, dashboards]) {
  const detail = p.outcome === 'data' ? `${p.tool} answered (${Array.isArray(p.adapted) ? p.adapted.length : 1} adapted)`
    : p.outcome === 'empty' ? `${p.tool} answered empty`
    : p.outcome === 'unsupported' ? 'no candidate advertised'
    : `every advertised candidate failed (${p.attempted.join(', ')})${p.error ? ` — ${p.error}` : ''}`;
  out(`  ${pad(p.family, 16)} ${detail}${p.response ? ` — ${shapeVerdict(p.family, p.response)}` : ''}`);
}

// ---- --write ------------------------------------------------------------

if (!WRITE) {
  out();
  out('no files written. Add --write to record fixtures (see tools/fixtures/mcp/README.md).');
  process.exit(0);
}

// Lists longer than the cap are sliced; every object key stays where it
// was, scalars untouched (a `count` may then disagree with its list —
// that is the recorded fixtures' existing convention).
function trimLists(value, cap = FIXTURE_LIST_CAP) {
  if (Array.isArray(value)) return value.slice(0, cap).map(v => trimLists(v, cap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimLists(v, cap)]));
  }
  return value;
}

// The inventory keeps every name an alias (or a build_info probe) can
// require, plus the first N others, in the server's order — so the
// fixture stays honest about what the alias table needs while staying
// small. The list is replaced where the adapter found it.
const requiredNames = new Set([
  ...STACK_SELF_METRIC_PROBES.flatMap(r => r.aliases.flatMap(a => a.requires)),
  ...BUILD_INFO_PROBES.map(p => p.metric),
]);
function keepNames(list) {
  let others = 0;
  return list.filter((n) => {
    if (typeof n !== 'string') return false;
    if (requiredNames.has(n)) return true;
    return others++ < INVENTORY_KEEP_OTHERS;
  });
}
function trimInventory(response) {
  if (Array.isArray(response)) return keepNames(response);
  if (Array.isArray(response?.values)) return { ...response, values: keepNames(response.values) };
  if (Array.isArray(response?.data)) return { ...response, data: keepNames(response.data) };
  if (response?.data && typeof response.data === 'object') {
    const kept = new Set(keepNames(Object.keys(response.data)));
    return { ...response, data: Object.fromEntries(Object.entries(response.data).filter(([k]) => kept.has(k))) };
  }
  for (const key of ['metrics', 'names']) {
    if (Array.isArray(response?.[key])) return { ...response, [key]: keepNames(response[key]) };
  }
  return response;
}

const written = [];
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, redact(JSON.stringify(value, null, 2)) + '\n');
  written.push(path);
};
// Committed fixtures carry tool + timestamp (+ query) only: the
// maintainer's MCP hostname is private and stays out of git. The full
// URL (token stripped) goes into the git-ignored review copy alone.
const provenance = (extra) => ({ recordedAt, ...extra });

out();
out(`writing into ${OUT_DIR}`);

if (inventoryNames) {
  writeJson(INVENTORY_FILE, { ...provenance({ tool: inventoryProbe.tool, count: inventoryNames.length, names: inventoryNames }), server: safeUrl(MCP_URL) });
  writeJson(resolve(OUT_DIR, `${inventoryProbe.tool}.json`), trimInventory(inventoryProbe.response));
} else {
  out(`  metric inventory not recorded (${inventoryProbe.outcome})`);
}

// Winning rule tool: vmalert_rules serves both rule probes on VM stacks
// (one file); when the two cascades won on different tools both are kept.
const probeFiles = new Map();
for (const p of [scrape, recordingRules, alertRules, dashboards]) {
  if (!p.response || !p.tool) { out(`  ${p.family} not recorded (${p.outcome})`); continue; }
  probeFiles.set(p.tool, p.response);
}
for (const [tool, response] of probeFiles) writeJson(resolve(OUT_DIR, `${tool}.json`), trimLists(response));

// One instant vector per family: the first row with data, else the first
// honest empty. Provenance rides in `_recorded` (an extra the shape
// tolerates, like the synthetic files' `_synthetic`).
for (const family of STACK_FAMILIES) {
  const entries = aliasReport.filter(r => r.row.family === family).flatMap(r => r.entries);
  const pick = entries.find(e => e.outcome === 'data') || entries.find(e => e.outcome === 'empty');
  if (!pick || !pick.response) { out(`  ${family}: no instant vector to record`); continue; }
  writeJson(resolve(OUT_DIR, RECORDED_STACK_DIR, `${pick.id}.json`), {
    _recorded: provenance({ tool: metricsQueryTool, family, row: pick.id, product: pick.product, query: pick.expr, outcome: pick.outcome, value: pick.value }),
    ...trimLists(pick.response),
  });
}

for (const s of [alertmanagerStatus, alertmanagerSilences, grafanaDatasources, grafanaContactPoints]) {
  if (!s.advertised) continue;
  if (!s.response) { out(`  ${s.tool} not recorded (${s.error || 'no answer'})`); continue; }
  const payload = trimLists(s.response);
  writeJson(resolve(OUT_DIR, `${s.tool}.json`), Array.isArray(payload) ? payload : { _recorded: provenance({ tool: s.tool }), ...payload });
}
if (datasourceHealth.response) {
  writeJson(resolve(OUT_DIR, `${datasourceHealth.tool}.json`), {
    _recorded: provenance({ tool: datasourceHealth.tool, uid: datasourceHealth.uid }),
    ...trimLists(datasourceHealth.response),
  });
}

out();
for (const path of written) out(`  wrote ${relative(ROOT, path) || path}`);
out();
out('next: review the diff, then `node tools/test-contract-shapes.mjs --update` and `npm test` (tools/fixtures/mcp/README.md).');
if (existsSync(resolve(OUT_DIR, 'synthetic'))) {
  out('a recorded <tool>.json at the fixtures top level now takes precedence over synthetic/<tool>.json in the shapes suite.');
}
