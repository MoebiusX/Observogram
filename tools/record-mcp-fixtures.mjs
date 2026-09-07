#!/usr/bin/env node
/**
 * tools/record-mcp-fixtures.mjs
 *
 * Record the step-2 MCP surfaces from a LIVE server so a maintainer can
 * verify the stack self-metric alias table and replace the hand-written
 * fixtures in tools/fixtures/mcp/synthetic/ with real recordings.
 *
 * Nothing in the alias table (tools/lib/contracts/stack-self-metrics.mjs)
 * was recorded against a live stack when it was written: every metric
 * name follows upstream documentation. This script is the verification
 * path — it calls EVERY alias of EVERY row (no inventory gating, no call
 * budget) and writes the raw responses beside the tool answers for the
 * Alertmanager / Grafana status surfaces.
 *
 * Usage:
 *   MCP_URL=https://your-mcp/path [MCP_AUTH=token] npm run record-fixtures
 *   OUTPUT_DIR=somewhere/else npm run record-fixtures
 *
 * Output (OUTPUT_DIR, default tools/fixtures/mcp/recordings/<date>/):
 *   stack_self_metrics.json     one entry per alias: { id, product, expr,
 *                               response | error } plus the tools/list
 *                               inventory and the metric-name inventory
 *   <tool>.json                 raw parsed payload of each status tool
 *                               (alertmanager_status, alertmanager_silences,
 *                               grafana_datasources, grafana_contact_points,
 *                               grafana_datasource_health.<uid>)
 *
 * The files are NOT fixtures yet: trim them the way tools/fixtures/mcp/
 * README.md describes, drop the `_synthetic` marker of the file you
 * replace, and move its case from SYNTHETIC_CASES into CASES in
 * tools/test-contract-shapes.mjs (then `--update` for the adapted/ pin).
 *
 * Requires Node 18+. Read-only: only tools/list and tools/call.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMcpClient } from './fetch-live-pack.mjs';
import { capabilityTool, probeCandidates } from './lib/contracts/mcp-capabilities.mjs';
import { STACK_SELF_METRIC_PROBES } from './lib/contracts/stack-self-metrics.mjs';

const MCP_URL = process.env.MCP_URL;
const MCP_AUTH = process.env.MCP_AUTH || null;
const OUTPUT_DIR = process.env.OUTPUT_DIR
  || resolve('tools', 'fixtures', 'mcp', 'recordings', new Date().toISOString().slice(0, 10));
const HEALTH_LIMIT = 10;

if (!MCP_URL) {
  process.stderr.write('[record-mcp-fixtures] MCP_URL is required\n');
  process.exit(1);
}

const { rpc, notify, callTool } = createMcpClient({ mcpUrl: MCP_URL, mcpAuth: MCP_AUTH });
const log = (line) => process.stderr.write(`[record-mcp-fixtures] ${line}\n`);
const write = (name, value) => {
  const path = resolve(OUTPUT_DIR, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  log(`wrote ${path}`);
};
const attempt = async (fn) => {
  try { return { response: await fn() }; }
  catch (e) { return { error: e.message }; }
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const recordedAt = new Date().toISOString();

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'observogram-recorder', version: '0.4.0' },
}).catch(() => null);
await notify('notifications/initialized').catch(() => {});

const toolsList = await rpc('tools/list').catch(() => null);
const exposed = Array.isArray(toolsList?.tools) ? toolsList.tools.map(t => t.name) : [];
const hasToolsList = exposed.length > 0;
const advertised = (name) => !hasToolsList || exposed.includes(name);
log(`tools/list: ${hasToolsList ? `${exposed.length} tools` : 'not answered (older server)'}`);

// ---- metric-name inventory (first advertised candidate) ----
let inventory = null;
for (const cand of probeCandidates('metric_names')) {
  const name = typeof cand === 'string' ? cand : cand.name;
  const args = typeof cand === 'string' ? {} : cand.args;
  if (!advertised(name)) continue;
  const r = await attempt(() => callTool(name, args));
  if (r.response) { inventory = { tool: name, response: r.response }; break; }
}

// ---- stack self-metrics: every alias of every row ----
const metricsQuery = capabilityTool('stack_self_metrics');
const aliases = [];
if (advertised(metricsQuery)) {
  for (const row of STACK_SELF_METRIC_PROBES) {
    for (const alias of row.aliases) {
      const r = await attempt(() => callTool(metricsQuery, { query: alias.expr }));
      aliases.push({ id: row.id, family: row.family, product: alias.product, expr: alias.expr, requires: alias.requires, ...r });
      log(`${row.id} [${alias.product}] → ${r.error ? `error: ${r.error}` : 'answered'}`);
    }
  }
} else {
  log(`${metricsQuery} not advertised — alias table not recorded`);
}
write('stack_self_metrics.json', {
  recordedAt, mcpUrl: MCP_URL, tool: metricsQuery, toolsExposed: exposed, inventory, aliases,
});

// ---- status surfaces ----
for (const cap of ['alertmanager_status', 'alertmanager_silences', 'grafana_datasources', 'grafana_contact_points']) {
  const tool = capabilityTool(cap);
  if (!advertised(tool)) { log(`${tool} not advertised — skipped`); continue; }
  const r = await attempt(() => callTool(tool));
  write(`${tool}.json`, { recordedAt, tool, ...r });
  if (cap === 'grafana_datasources' && r.response) {
    const healthTool = capabilityTool('grafana_datasource_health');
    if (!advertised(healthTool)) continue;
    const list = r.response.datasources || r.response.data || (Array.isArray(r.response) ? r.response : []);
    for (const ds of list.filter(d => d?.uid).slice(0, HEALTH_LIMIT)) {
      const h = await attempt(() => callTool(healthTool, { uid: ds.uid }));
      write(`${healthTool}.${ds.uid}.json`, { recordedAt, tool: healthTool, uid: ds.uid, ...h });
    }
  }
}

log(`done — review ${OUTPUT_DIR}, trim, and move recordings into tools/fixtures/mcp/ per its README`);
