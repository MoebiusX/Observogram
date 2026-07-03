// tools/lib/contracts/mcp-capabilities.mjs
//
// MCP CAPABILITY REGISTRY — the single place where external MCP tool names
// live. Every tool the fetcher calls is declared here as a row; code looks
// names up by CAPABILITY id and never hardcodes a tool string
// (tools/test-contract-guard.mjs enforces this).
//
// A *capability* is what Observogram wants ("the recording rules", "the live
// Grafana version"); a *tool* is whatever name the connected MCP server
// happens to expose for it. When an upstream renames a tool, the change
// lands HERE: add the new name as the first candidate, mark the old row
// deprecated, and nothing else moves.
//
// Candidate rows:
//   tool         the MCP tool name on the wire
//   args         static call arguments (omit when none)
//   runtimeArgs  { argName: runtimeSlot } — arguments the CALLER supplies at
//                resolve time (env-tunable limits stay out of this data-only
//                layer; see probeCandidates(id, runtime))
//   id           optional stable handle for callers that need to reference
//                one candidate (e.g. the dashboards search/detail pair)
//   deprecated   { since, removeAfter, aliasOf } — the alias keeps working
//                until `removeAfter` (an Observogram version); CI fails a
//                release past `removeAfter` while the row still exists
//                (docs/ARCHITECTURE_EVOLUTION.md §6).
//
// Candidate ORDER is the fallback order and is part of the contract — the
// fetcher tries advertised candidates first-to-last and the first that
// answers wins. Reorder only with the same care as a behaviour change.
//
// Pure ESM, data + lookup resolvers only. No control flow beyond mapping,
// no Node APIs — browser-safe by construction.

export const CAPABILITIES = Object.freeze({
  // ---- core: called up front on every fetch ------------------------------
  // `required: true` capabilities abort the fetch when unavailable; the
  // rest degrade to an honest "not answered" annotation.
  backend_capabilities: {
    kind: 'core', required: false,
    candidates: [{ tool: 'backend_capabilities' }],
  },
  system_health: {
    kind: 'core', required: true,
    candidates: [{ tool: 'system_health' }],
  },
  system_topology: {
    kind: 'core', required: true,
    candidates: [{ tool: 'system_topology' }],
  },
  anomalies_active: {
    kind: 'core', required: false,
    candidates: [{ tool: 'anomalies_active' }],
  },
  anomalies_baselines: {
    kind: 'core', required: false,
    candidates: [{ tool: 'anomalies_baselines' }],
  },

  // ---- discovery probes: candidate cascade, first responder wins ---------
  recording_rules: {
    kind: 'probe',
    responseShape: 'rule-groups',
    // VictoriaMetrics stacks expose recorded series + their PromQL via
    // `vmalert_rules` (type=recording carries the real `query` body and the
    // group `interval`). It is tried FIRST because on VM-backed clusters the
    // Prometheus ruler endpoint (`metrics_alerts` / /api/v1/rules) returns
    // EMPTY — which previously forced a name-only inventory fallback that
    // stubbed each expr as the bare series name. Prometheus /api/v1/rules
    // returns BOTH recording and alert rules in one payload; the probe's
    // adapt filters to record-only rules.
    candidates: [
      { tool: 'vmalert_rules' },
      { tool: 'metrics_alerts' },
      { tool: 'list_recording_rules' },
      { tool: 'prometheus_recording_rules' },
      { tool: 'metrics_recording_rules' },
      { tool: 'mimir_recording_rules' },
      { tool: 'rules_list_recording' },
      { tool: 'prometheus_rules' },
      { tool: 'rules_list' },
    ],
  },
  alert_rules: {
    kind: 'probe',
    responseShape: 'rule-groups',
    // VMAlert (`vmalert_rules` type=alerting) carries the real alert `query`,
    // `severity`, and `for`/`duration`; tried FIRST for the same reason as
    // recording_rules (the Prometheus ruler comes back empty on VM stacks).
    // metrics_alerts (Prometheus /api/v1/rules) and grafana_alert_rules
    // (Grafana unified alerting) are the next canonical names;
    // alertmanager_alerts surfaces FIRING alerts (not declarations) but
    // counts as evidence the alerting stack works.
    candidates: [
      { tool: 'vmalert_rules' },
      { tool: 'metrics_alerts' },
      { tool: 'grafana_alert_rules' },
      { tool: 'alertmanager_alerts' },
      { tool: 'list_alert_rules' },
      { tool: 'prometheus_alert_rules' },
      { tool: 'metrics_alert_rules' },
      { tool: 'mimir_alert_rules' },
      { tool: 'rules_list_alerting' },
      { tool: 'prometheus_alerts' },
    ],
  },
  dashboards: {
    kind: 'probe',
    responseShape: 'dashboard-search',
    // grafana_dashboards_search is the canonical otel-mcp-server tool
    // (Grafana skill). The others are legacy / community-MCP names. The
    // search limit is env-tunable, so the caller injects it at resolve time
    // (runtimeArgs) rather than this layer reading process.env.
    candidates: [
      { id: 'search', tool: 'grafana_dashboards_search', args: { type: 'dash-db' }, runtimeArgs: { limit: 'grafanaDashboardSearchLimit' } },
      { tool: 'grafana_dashboard_get' },
      { tool: 'list_dashboards' },
      { tool: 'grafana_dashboards' },
      { tool: 'grafana_list_dashboards' },
      { tool: 'grafana_search_dashboards' },
      { tool: 'dashboards_list' },
      { tool: 'grafana_search' },
    ],
  },
  scrape_configs: {
    kind: 'probe',
    responseShape: 'scrape-targets',
    // metrics_targets is the canonical otel-mcp-server tool (metrics skill);
    // returns the Prometheus /api/v1/targets shape. The rest are legacy.
    candidates: [
      { tool: 'metrics_targets' },
      { tool: 'list_scrape_configs' },
      { tool: 'prometheus_scrape_configs' },
      { tool: 'prometheus_targets' },
      { tool: 'metrics_scrape_jobs' },
      { tool: 'list_metric_jobs' },
    ],
  },
  metric_names: {
    kind: 'probe',
    responseShape: 'name-values',
    // Candidates ordered by likelihood:
    //   metrics_label_values — canonical otel-mcp-server name; needs
    //     { label: '__name__' } to enumerate metric names
    //   metrics_metadata     — requires { metric: '<name>' } per metric,
    //     so it's the FALLBACK only (chicken-and-egg)
    //   the rest are legacy / community-MCP names
    candidates: [
      { tool: 'metrics_label_values', args: { label: '__name__' } },
      { tool: 'list_metrics' },
      { tool: 'prometheus_metric_names' },
      { tool: 'metrics_inventory' },
      { tool: 'mimir_metric_names' },
      { tool: 'metrics_metadata' },
    ],
  },

  // ---- enrichment: follow-up calls on a winning probe ---------------------
  dashboard_detail: {
    kind: 'enrich',
    // One call per dashboard UID after grafana_dashboards_search wins;
    // args (uid / include_json / panel_limit) are built at the call site.
    candidates: [{ tool: 'grafana_dashboard_get' }],
  },

  // ---- version / liveness probes ------------------------------------------
  grafana_version: {
    kind: 'version',
    // grafana_health returns { version, commit, database, orgId }.
    candidates: [{ tool: 'grafana_health' }],
  },
  build_info_versions: {
    kind: 'version',
    // Carrier for the BUILD_INFO_PROBES table below: one metrics_query per
    // `*_build_info` metric, version read from the first series' labels.
    candidates: [{ tool: 'metrics_query' }],
  },
  traces_alive: {
    kind: 'version',
    // traces_services answering at all is positive proof the trace backend
    // is live (Jaeger and friends don't always publish build_info metrics).
    candidates: [{ tool: 'traces_services' }],
  },
  firing_alerts_evidence: {
    kind: 'evidence',
    // Rule-evidence fallback: when the rule-discovery probes come back
    // empty, ALERTS{alertstate="firing"} still attests alerting is real.
    candidates: [{ tool: 'metrics_query' }],
  },
});

// Metrics-query-based version probes — each backend that publishes a
// `*_build_info` metric (Prometheus convention) gets a row. The label that
// carries the version differs by product; `extra` labels are captured as
// provenance when present. Order is not significant (probes run in
// parallel); a richer source (e.g. grafana_health) wins over a row here.
export const BUILD_INFO_PROBES = Object.freeze([
  { product: 'victoriametrics', metric: 'vm_app_version',          versionLabels: Object.freeze(['short_version', 'version']), extra: Object.freeze(['version']) },
  { product: 'prometheus',      metric: 'prometheus_build_info',   versionLabels: Object.freeze(['version']),                  extra: Object.freeze(['revision', 'branch']) },
  { product: 'loki',            metric: 'loki_build_info',         versionLabels: Object.freeze(['version']),                  extra: Object.freeze(['revision', 'branch']) },
  { product: 'alertmanager',    metric: 'alertmanager_build_info', versionLabels: Object.freeze(['version']),                  extra: Object.freeze(['revision', 'branch']) },
  { product: 'tempo',           metric: 'tempo_build_info',        versionLabels: Object.freeze(['version']),                  extra: Object.freeze(['revision', 'branch']) },
  { product: 'mimir',           metric: 'cortex_build_info',       versionLabels: Object.freeze(['version']),                  extra: Object.freeze(['revision', 'branch']) },
  // grafana_build_info is a metric fallback for the rare case where
  // grafana_health isn't exposed; harmless if it duplicates because
  // grafana_health stamps first and version capture never overwrites.
  { product: 'grafana',         metric: 'grafana_build_info',      versionLabels: Object.freeze(['version']),                  extra: Object.freeze(['edition', 'branch']) },
].map(Object.freeze));

// ---------------------------------------------------------------------------
// Resolvers — lookup only, no control flow beyond mapping.
// ---------------------------------------------------------------------------

export function capability(id) {
  const cap = CAPABILITIES[id];
  if (!cap) throw new Error(`unknown MCP capability: ${id}. Known: ${Object.keys(CAPABILITIES).join(', ')}`);
  return cap;
}

// Candidates for a probe-style capability in the legacy shape the fetcher's
// cascade consumes: a bare tool-name string when the call takes no args,
// `{ name, args }` when it does. `runtime` fills the declared runtimeArgs
// slots (e.g. { grafanaDashboardSearchLimit: 100 }); args key order is
// static-args-first so call-cache keys stay stable across call sites.
export function probeCandidates(id, runtime = {}) {
  return capability(id).candidates.map((c) => {
    const runtimeEntries = Object.entries(c.runtimeArgs || {})
      .map(([arg, slot]) => [arg, runtime[slot]])
      .filter(([, v]) => v !== undefined);
    if (!c.args && runtimeEntries.length === 0) return c.tool;
    return { name: c.tool, args: { ...(c.args || {}), ...Object.fromEntries(runtimeEntries) } };
  });
}

// The single tool name behind a one-candidate capability (core, version,
// enrichment). Throws on multi-candidate capabilities — those go through
// the cascade, not a point lookup.
export function capabilityTool(id) {
  const cap = capability(id);
  if (cap.candidates.length !== 1) {
    throw new Error(`capability ${id} has ${cap.candidates.length} candidates — use probeCandidates()`);
  }
  return cap.candidates[0].tool;
}

// A specific candidate of a multi-candidate capability, by its stable id
// (e.g. candidateTool('dashboards', 'search')).
export function candidateTool(capId, candidateId) {
  const found = capability(capId).candidates.find((c) => c.id === candidateId);
  if (!found) throw new Error(`capability ${capId} has no candidate with id "${candidateId}"`);
  return found.tool;
}

// Every tool name any capability may call — for the guard test and drift
// tooling (detect-drift compares this surface against mcp.toolsExposed).
export function allKnownToolNames() {
  const names = new Set();
  for (const cap of Object.values(CAPABILITIES)) {
    for (const c of cap.candidates) names.add(c.tool);
  }
  return names;
}

// Rows carrying deprecation metadata, flattened for the CI window check.
export function deprecatedAliases() {
  const rows = [];
  for (const [id, cap] of Object.entries(CAPABILITIES)) {
    for (const c of cap.candidates) {
      if (c.deprecated) rows.push({ capability: id, tool: c.tool, ...c.deprecated });
    }
  }
  return rows;
}
