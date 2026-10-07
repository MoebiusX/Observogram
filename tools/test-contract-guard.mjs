#!/usr/bin/env node
/**
 * tools/test-contract-guard.mjs
 *
 * Contract-registry guard. Three jobs:
 *
 * 1. NO TOOL-NAME LITERALS AT CALL SITES — tools/fetch-live-pack.mjs (and
 *    the recorder tools/record-mcp-fixtures.mjs) must resolve every MCP
 *    tool name through the contract registry
 *    (tools/lib/contracts/mcp-capabilities.mjs), never hardcode one. This
 *    scans the source for string literals in callTool / cachedCall /
 *    discoveredToolNames.has positions and fails on any hit, so a future
 *    "quick fix" can't quietly reintroduce a second source of truth.
 *
 *    Known exemptions (each is a tracked decomposition target, not a
 *    licence): server/index.mjs (the deploy path migrates to the
 *    resolveCapability facade in Sprint 2 — docs/ARCHITECTURE_EVOLUTION.md
 *    §4) and tools/lib/grafana-mcp-bridge.mjs (a separate bridge component,
 *    registered when the facade lands).
 *
 * 2. TOOL-SURFACE SNAPSHOT — the full set of tool names the registry may
 *    call is pinned here, sorted. Adding/removing/renaming a tool fails
 *    this test until the snapshot is updated in the same commit; the diff
 *    of this file is then the wire-surface changelog of that commit.
 *
 * 3. DEPRECATION WINDOWS — a release whose version is at/past an alias's
 *    `removeAfter` fails until the alias row is deleted (a major) or the
 *    window is deliberately extended (docs/ARCHITECTURE_EVOLUTION.md §6).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITIES, BUILD_INFO_PROBES, probeCandidates, capabilityTool,
  candidateTool, allKnownToolNames, deprecatedAliases, capabilityInventory,
} from './lib/contracts/mcp-capabilities.mjs';
import { parseVersion, compareVersions } from './lib/protocols.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const { assert, report } = createHarness({ indent: '  ', truncate: 160 });

// ---------- 1. no tool-name literals at call sites ----------

// The recorder verifies the registry against a live server, so it must
// not carry a second copy of any name either.
const GUARDED_FILES = ['tools/fetch-live-pack.mjs', 'tools/record-mcp-fixtures.mjs', 'tools/lib/mcp-client.mjs', 'server/routes/live.mjs', 'server/live-jobs.mjs', 'tools/lib/live-fetch.mjs'];
// The live MCP API's own files (rebadge batch 3) spell no tool name at all:
// not at a call site, not anywhere — every name they report comes from the
// MCP's answer through the registry's mapping (capabilityInventory).
const SPELLS_NO_TOOL_NAME = ['server/routes/live.mjs', 'server/live-jobs.mjs'];
// tools/lib/live-fetch.mjs names the CAPABILITY ids each stage reads, and five
// capability ids are also the name of their one candidate (system_health …):
// there a literal may equal a capability id, and nothing else a tool is called.
const SPELLS_ONLY_CAPABILITY_IDS = ['tools/lib/live-fetch.mjs'];
// String literal directly inside a tool-call position. `rpc('tools/list')`
// and safe/quiet LABELS are out of scope: rpc takes protocol methods, and
// labels are diagnostics (kept aligned by sharing the TOOL constants).
const CALL_SITE_LITERAL = /(?:callTool|cachedCall|discoveredToolNames\.has)\(\s*['"]([a-z][a-z0-9_]*)['"]/g;

for (const file of GUARDED_FILES) {
  const src = readFileSync(resolve(ROOT, file), 'utf8');
  const hits = [...src.matchAll(CALL_SITE_LITERAL)].map((m) => m[1]);
  assert(hits.length === 0,
    `${file}: no hardcoded tool names at call sites (all resolve via the contract registry)`,
    hits.slice(0, 10));
}

{
  const known = allKnownToolNames();
  for (const file of SPELLS_NO_TOOL_NAME) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    const literals = [...src.matchAll(/(['"`])([a-z][a-z0-9_]*)\1/g)].map((m) => m[2]).filter((s) => known.has(s));
    assert(literals.length === 0, `${file}: no string literal equal to a known MCP tool name anywhere`, literals.slice(0, 10));
  }
  const capabilityIds = new Set(Object.keys(CAPABILITIES));
  for (const file of SPELLS_ONLY_CAPABILITY_IDS) {
    const src = readFileSync(resolve(ROOT, file), 'utf8');
    const literals = [...src.matchAll(/(['"`])([a-z][a-z0-9_]*)\1/g)].map((m) => m[2]).filter((s) => known.has(s) && !capabilityIds.has(s));
    assert(literals.length === 0, `${file}: no string literal equal to a known MCP tool name that is not also a capability id`, literals.slice(0, 10));
  }
}

// ---------- 2. registry integrity + tool-surface snapshot ----------

const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
for (const [id, cap] of Object.entries(CAPABILITIES)) {
  assert(Array.isArray(cap.candidates) && cap.candidates.length > 0,
    `capability ${id} declares at least one candidate`);
  for (const c of cap.candidates) {
    assert(typeof c.tool === 'string' && TOOL_NAME_RE.test(c.tool),
      `capability ${id}: candidate tool "${c.tool}" is a well-formed tool name`);
  }
}

// Resolver contract: single-tool lookup, by-id lookup, cascade shape.
assert(capabilityTool('system_health') === 'system_health',
  'capabilityTool resolves a single-candidate capability');
let multiThrew = false;
try { capabilityTool('recording_rules'); } catch { multiThrew = true; }
assert(multiThrew, 'capabilityTool refuses multi-candidate capabilities (use probeCandidates)');
assert(candidateTool('dashboards', 'search') === 'grafana_dashboards_search',
  'candidateTool finds a candidate by stable id');

// Legacy cascade shape: bare string when argless, {name,args} when not —
// and runtime slots merge AFTER static args so call-cache keys stay stable.
const rec = probeCandidates('recording_rules');
assert(typeof rec[0] === 'string' && rec[0] === 'vmalert_rules',
  'argless candidates resolve to bare tool-name strings');
const dash = probeCandidates('dashboards', { grafanaDashboardSearchLimit: 42 });
assert(JSON.stringify(dash[0]) === '{"name":"grafana_dashboards_search","args":{"type":"dash-db","limit":42}}',
  'runtime args fill declared slots, static-args-first (stable cache-key order)', JSON.stringify(dash[0]));

// BUILD_INFO_PROBES rows are complete.
for (const p of BUILD_INFO_PROBES) {
  assert(p.product && p.metric && Array.isArray(p.versionLabels) && p.versionLabels.length > 0,
    `build-info probe ${p.product || '?'} carries product, metric and versionLabels`);
}

// The pinned wire surface. Update this list ONLY together with the registry
// change that motivates it — the diff is the surface changelog.
const EXPECTED_TOOL_SURFACE = [
  'alertmanager_alerts',
  'alertmanager_silences',
  'alertmanager_status',
  'anomalies_active',
  'anomalies_baselines',
  'backend_capabilities',
  'dashboards_list',
  'grafana_alert_rules',
  'grafana_contact_points',
  'grafana_dashboard_get',
  'grafana_dashboards',
  'grafana_dashboards_search',
  'grafana_datasource_health',
  'grafana_datasources',
  'grafana_health',
  'grafana_list_dashboards',
  'grafana_search',
  'grafana_search_dashboards',
  'list_alert_rules',
  'list_dashboards',
  'list_metric_jobs',
  'list_metrics',
  'list_recording_rules',
  'list_scrape_configs',
  'metrics_alert_rules',
  'metrics_alerts',
  'metrics_inventory',
  'metrics_label_values',
  'metrics_metadata',
  'metrics_query',
  'metrics_recording_rules',
  'metrics_scrape_jobs',
  'metrics_targets',
  'mimir_alert_rules',
  'mimir_metric_names',
  'mimir_recording_rules',
  'prometheus_alert_rules',
  'prometheus_alerts',
  'prometheus_metric_names',
  'prometheus_recording_rules',
  'prometheus_rules',
  'prometheus_scrape_configs',
  'prometheus_targets',
  'rules_list',
  'rules_list_alerting',
  'rules_list_recording',
  'system_health',
  'system_topology',
  'traces_services',
  'vmalert_rules',
];
const actualSurface = [...allKnownToolNames()].sort();
const surfaceMatches = JSON.stringify(actualSurface) === JSON.stringify(EXPECTED_TOOL_SURFACE);
if (surfaceMatches) {
  assert(true, `tool surface matches the pinned snapshot (${actualSurface.length} names)`);
} else {
  const added = actualSurface.filter((n) => !EXPECTED_TOOL_SURFACE.includes(n));
  const removed = EXPECTED_TOOL_SURFACE.filter((n) => !actualSurface.includes(n));
  assert(false,
    'tool surface drifted from the pinned snapshot — if intended, update EXPECTED_TOOL_SURFACE in the same commit',
    { added, removed });
}

// capabilityInventory: every name the registry may call maps back to each
// capability that lists it, and nothing else does.
{
  const all = [...allKnownToolNames()];
  const inv = capabilityInventory(all);
  const misses = [];
  for (const [id, cap] of Object.entries(CAPABILITIES)) {
    const want = [...new Set(cap.candidates.map((c) => c.tool))];
    if (JSON.stringify(inv.capabilities[id]) !== JSON.stringify(want)) misses.push(id);
  }
  assert(misses.length === 0 && inv.unmatched === 0
    && Object.keys(inv.capabilities).length === Object.keys(CAPABILITIES).length,
    'capabilityInventory maps every known tool name back to its capability id(s), in candidate order', { misses, unmatched: inv.unmatched });
}
// An advertised list: unknown names are a count, duplicates count once, a
// capability with no advertised candidate is left out.
{
  const known = candidateTool('dashboards', 'search');
  const inv = capabilityInventory([known, known, 'zz_not_a_capability_tool', 'zz_other', '', null]);
  assert(JSON.stringify(inv) === JSON.stringify({ capabilities: { dashboards: [known] }, unmatched: 2 }),
    'capabilityInventory counts unmatched names (never lists them), once each', JSON.stringify(inv));
}

// ---------- 3. deprecation windows ----------

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
const overdue = deprecatedAliases().filter((row) =>
  row.removeAfter && compareVersions(parseVersion(pkg.version), parseVersion(row.removeAfter)) >= 0);
assert(overdue.length === 0,
  `no deprecated alias is past its removeAfter window at v${pkg.version} — delete the row (major) or extend the window`,
  overdue);

report('contract-guard', 'every MCP tool name resolves through the contract registry.');
