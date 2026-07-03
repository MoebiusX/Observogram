#!/usr/bin/env node
/**
 * tools/fetch-live-pack.mjs
 *
 * Build a canonical ObservabilityPack v1.2 manifest from a live MCP
 * server's responses, validate it against the vendored schema, and write
 * it as a local generated YAML file.
 *
 * Phase 4 rewrite: emits canonical v1.2 only. No EMIT_FORMAT flag, no
 * studio-shape output. Sections MCP cannot directly verify (SLIs, SLOs,
 * dashboards, alerting, …) are populated with minimal stubs derived from
 * MCP context (discovered services, baseline thresholds) — the canonical
 * schema requires them. Items MCP could verify carry their evidence in
 * flat annotation keys (`mcp.verified.<symbol>`).
 *
 * Usage:
 *   node tools/fetch-live-pack.mjs
 *   MCP_URL=https://your-mcp/path node tools/fetch-live-pack.mjs
 *   OUTPUT=somewhere/else.pack.yaml node tools/fetch-live-pack.mjs
 *
 * Env:
 *   MCP_URL   — MCP server endpoint. Default: https://mcp.example.com/observability
 *   OUTPUT    — Output path. Default: examples/production-live.pack.yaml
 *               (generated locally; ignored by git)
 *   MCP_AUTH  — Optional bearer token if your MCP requires auth.
 *   PACK_NAME — Pack metadata.name.  Default: production-live
 *
 * Exit codes:
 *   0  success
 *   1  hard failure (no file written; previous file is kept)
 *
 * Requires Node 18+.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { inferSlisFromRecordingRules } from './lib/sli-inference.mjs';
import { materializeL2XFromBackends } from './lib/l2x.mjs';
import { serviceSlug as slug } from './lib/slug.mjs';
import { probeCandidates, capabilityTool, candidateTool, BUILD_INFO_PROBES } from './lib/contracts/mcp-capabilities.mjs';
import { brandEnv } from './lib/brand-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '..', 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json');
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const MCP_URL_DEFAULT  = process.env.MCP_URL  || 'https://mcp.example.com/observability';
const OUTPUT           = process.env.OUTPUT   || 'examples/production-live.pack.yaml';
const MCP_AUTH_DEFAULT = process.env.MCP_AUTH || null;
const PACK_NAME        = (process.env.PACK_NAME || 'production-live').toLowerCase();
const GRAFANA_DASHBOARD_SEARCH_LIMIT = Math.min(Number(brandEnv('GRAFANA_DASHBOARD_LIMIT') || 100) || 100, 500);
const GRAFANA_DASHBOARD_PANEL_LIMIT  = Math.min(Number(brandEnv('GRAFANA_PANEL_LIMIT') || 500) || 500, 500);
const GRAFANA_DASHBOARD_INCLUDE_JSON = !/^(0|false|no|off)$/i.test(brandEnv('GRAFANA_INCLUDE_JSON') || 'true');
const JSON_ANNOTATION_BLOCK_LENGTH = 4096;
// Per-request MCP timeout. Without it a hung endpoint stalls the fetch (and
// the server's /api/refresh-live caller) forever. Capped at 5 minutes.
const MCP_TIMEOUT_MS = Math.min(Number(brandEnv('MCP_TIMEOUT_MS') || 30_000) || 30_000, 300_000);

// Single-tool capability names resolved ONCE from the contract registry
// (tools/lib/contracts/mcp-capabilities.mjs). The registry owns every MCP
// tool name; this file never hardcodes one — tools/test-contract-guard.mjs
// enforces that. Rename a tool upstream → edit the registry row, not this file.
const TOOL = {
  backendCapabilities: capabilityTool('backend_capabilities'),
  systemHealth:        capabilityTool('system_health'),
  systemTopology:      capabilityTool('system_topology'),
  anomaliesActive:     capabilityTool('anomalies_active'),
  anomaliesBaselines:  capabilityTool('anomalies_baselines'),
  dashboardSearch:     candidateTool('dashboards', 'search'),
  dashboardDetail:     capabilityTool('dashboard_detail'),
  grafanaHealth:       capabilityTool('grafana_version'),
  metricsQuery:        capabilityTool('build_info_versions'),
  tracesServices:      capabilityTool('traces_alive'),
};

function annotationJson(value) {
  const compact = JSON.stringify(value);
  return compact.length > JSON_ANNOTATION_BLOCK_LENGTH
    ? JSON.stringify(value, null, 2)
    : compact;
}

// ============================================================
// MCP client — same wire protocol as before. Parameterised by
// (mcpUrl, mcpAuth) so the server's POST /api/refresh-live endpoint
// can drive it from the request body without spawning a subprocess.
// ============================================================

// createMcpClient is exported so the server can drive ad-hoc MCP
// interactions (deploy, refresh) without spawning a subprocess.
export function createMcpClient({ mcpUrl, mcpAuth = null } = {}) {
  if (!mcpUrl) throw new Error('createMcpClient: mcpUrl required');
  let session = null;
  let nextId = 1;

  async function rpc(method, params = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    };
    if (mcpAuth) headers['Authorization'] = `Bearer ${mcpAuth}`;
    if (session) headers['Mcp-Session-Id'] = session;

    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} on ${method}: ${await res.text().catch(() => '')}`);
    if (res.headers.get('mcp-session-id')) session = res.headers.get('mcp-session-id');

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        const frameEnd = buf.indexOf('\n\n');
        if (frameEnd !== -1) {
          const frame = buf.slice(0, frameEnd);
          const text = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.replace(/^data:\s?/, '')).join('\n');
          if (text) {
            const obj = JSON.parse(text);
            if (obj.error) throw new Error(`${method}: ${obj.error.message}`);
            return obj.result;
          }
          buf = buf.slice(frameEnd + 2);
        }
        if (done) break;
      }
      throw new Error(`MCP ${method}: SSE stream ended with no complete frame`);
    }
    const data = await res.json();
    if (data.error) throw new Error(`${method}: ${data.error.message}`);
    return data.result;
  }

  async function notify(method, params = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    };
    if (mcpAuth) headers['Authorization'] = `Bearer ${mcpAuth}`;
    if (session) headers['Mcp-Session-Id'] = session;

    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status} on ${method}: ${await res.text().catch(() => '')}`);
    if (res.headers.get('mcp-session-id')) session = res.headers.get('mcp-session-id');
  }

  async function callTool(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result?.isError) {
      const txt = result?.content?.map(c => c.text).filter(Boolean).join(' ') || 'tool returned isError';
      throw new Error(`${name}: ${txt}`);
    }
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return result;
    try { return JSON.parse(text); }
    catch { return text; }
  }

  return { rpc, notify, callTool };
}

// ============================================================
// Pack builder — pure, takes stubbed MCP responses, returns a canonical
// v1.2 manifest. Exported for offline tests.
// ============================================================

function pickCriticality(services) {
  // Heuristic: the cron treats prod observability as tier-2 by default.
  // Real callers can override via metadata.bindings later, but the live
  // snapshot should not claim tier-1 conformance bands it can't audit.
  if (!services.length) return 'tier-3';
  return 'tier-2';
}

function defaultBaselines(criticality) {
  if (criticality === 'tier-1') return { mttd_target_p50: '2m', mttr_target_p50: '30m' };
  if (criticality === 'tier-2') return { mttd_target_p50: '5m', mttr_target_p50: '2h' };
  return { mttd_target_p50: '15m', mttr_target_p50: '1d' };
}

function durationFromMs(ms, fallback) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return fallback;
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

// ============================================================
// Capability inventory — otel-mcp-server's `backend_capabilities`
// tool exposes the full skill → backend → product → version
// matrix the server can speak to. Spec v1.2 §VersionSpec was
// designed around this. We parse it into a normalised structure
// the pack builder can drive telemetry.backends[] from.
// ============================================================

// Map MCP-reported backend display names to the spec's Product slug
// registry. Anything not on this list still passes the lint as an
// "unknown product" — but the registered names get clean signals.
const BACKEND_TO_PRODUCT = {
  'Prometheus':                 'prometheus',
  'Grafana Mimir':              'mimir',
  'Thanos':                     'thanos',
  'VictoriaMetrics':            'victoriametrics',
  'Cortex':                     'cortex',
  'Grafana Loki':               'loki',
  'Grafana Tempo':              'tempo',
  'Tempo':                      'tempo',
  'Grafana Pyroscope':          'pyroscope',
  'Grafana':                    'grafana',
  'Grafana Alloy':              'alloy',
  'Alertmanager':               'alertmanager',
  'Elasticsearch':              'elasticsearch',
  'OpenSearch':                 'opensearch',
  'ClickHouse':                 'clickhouse',
  'Graylog':                    'graylog',
  'InfluxDB 1.x':               'influxdb',
  'InfluxDB 2.x':               'influxdb',
  'InfluxDB 3.x':               'influxdb',
  'OpenTSDB':                   'opentsdb',
  'Jaeger':                     'jaeger',
  'Zipkin':                     'zipkin',
  'SkyWalking':                 'skywalking',
  'Pinpoint':                   'pinpoint',
  'Open Policy Agent':          'opa',
  'Cilium':                     'cilium',
  'Kubernetes':                 'kubernetes',
  'Envoy':                      'envoy',
  'Consul':                     'consul',
  'Kong':                       'kong',
  'Traefik':                    'traefik',
  'Fluent Bit':                 'fluentbit',
  'Beats':                      'beats',
  'Vector':                     'vector',
};

// Map skill id to the spec's Signal enum
// (metrics|logs|traces|profiles|network|policy|mesh|gateway|collection|alerting|dashboards).
// Skills the spec doesn't model as a telemetry signal (zk-proofs,
// agentrelay, public-exchange, system, kubernetes) get null and
// flow into annotations only.
const SKILL_TO_SIGNAL = {
  metrics:      'metrics',
  logs:         'logs',
  traces:       'traces',
  pyroscope:    'profiles',
  grafana:      'dashboards',
  alertmanager: 'alerting',
  cilium:       'network',
  consul:       'mesh',
  envoy:        'mesh',
  kong:         'gateway',
  traefik:      'gateway',
  opa:          'policy',
  pipeline:     'collection',
  elasticsearch: 'logs',
  clickhouse:   'logs',
  graylog:      'logs',
  influx:       'metrics',
  opentsdb:     'metrics',
  // Skills below have no direct Signal mapping; they remain in the
  // annotation inventory but do not become telemetry.backends[].
  kubernetes:    null,
  pinpoint:      null,
  agentrelay:    null,
  'public-exchange': null,
  system:        null,
  'zk-proofs':   null,
};

function parseBackendCapabilities(response) {
  // backend_capabilities returns its body as a JSON-stringified
  // text content; both the raw object and the wrapped form are
  // supported here so this stays robust to wire changes.
  let inner = response;
  if (response?.content?.[0]?.text) {
    try { inner = JSON.parse(response.content[0].text); } catch { inner = null; }
  }
  if (!inner || !Array.isArray(inner.skills)) return null;
  return {
    gatingMode:    inner.gatingMode || 'warn',
    protocolModel: inner.protocolModel || null,
    skills:        inner.skills,
  };
}

function specSlug(s, fallback = 'item') {
  let out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!/^[a-z]/.test(out)) out = `${fallback}-${out}`.replace(/-+$/g, '');
  if (!/[a-z0-9]$/.test(out)) out = `${out}x`;
  return out.length >= 2 ? out : fallback;
}

function dashboardIdFrom(item, fallback = 'dashboard') {
  // Dashboards deployed by Observogram self-identify via the obs-pack-id
  // tag (uids are capped + fingerprinted, so they can't carry the
  // declared id). Honouring the tag closes the deploy→fetch→diff round
  // trip with the SAME canonical id the source pack declares; dashboards
  // without the tag keep the existing uid-first derivation.
  const tags = item?.tags || item?.dashboard?.tags || [];
  const idTag = (Array.isArray(tags) ? tags : []).find(t => String(t).startsWith('obs-pack-id:'));
  if (idTag) return specSlug(String(idTag).slice('obs-pack-id:'.length), 'dash');
  const source = item?.dashboard?.uid || item?.uid || item?.id || item?.dashboard?.title || item?.title || fallback;
  return specSlug(source, 'dash');
}

function panelIdFrom(panel, fallback = 'panel') {
  return specSlug(panel?.title || panel?.id || panel?.refId || fallback, 'panel');
}

function grafanaDashboardSearchItems(response) {
  const list = Array.isArray(response) ? response
    : (response?.results || response?.dashboards || response?.items || []);
  return Array.isArray(list)
    ? list.filter(d => (d.type ? d.type === 'dash-db' : true))
    : [];
}

function dashboardFromSearchItem(d) {
  const id = dashboardIdFrom(d);
  const uid = d.uid || d.id || null;
  const params = {
    ...(uid ? { uid: String(uid) } : {}),
    ...(d.title ? { title: d.title } : {}),
    ...(d.url ? { url: d.url } : {}),
    ...(d.uri ? { uri: d.uri } : {}),
    ...(Array.isArray(d.tags) && d.tags.length ? { tags: d.tags } : {}),
    ...(d.folderUid ? { folderUid: d.folderUid } : {}),
    ...(d.type ? { type: d.type } : {}),
  };
  return {
    id,
    provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 },
    folder: d.folderTitle || d.folder || 'mcp-discovered',
    source: d.url ? `grafana://${d.url}` : `grafana://uid/${uid || d.id || id}`,
    ...(Object.keys(params).length ? { params } : {}),
  };
}

function flattenGrafanaPanels(panels, out = []) {
  for (const panel of (Array.isArray(panels) ? panels : [])) {
    if (!panel || typeof panel !== 'object') continue;
    out.push(panel);
    if (Array.isArray(panel.panels)) flattenGrafanaPanels(panel.panels, out);
  }
  return out;
}

function dashboardFromGrafanaDetail(detail, searchItem = {}) {
  const dash = detail?.dashboard || {};
  const raw = detail?.raw && typeof detail.raw === 'object' ? detail.raw : null;
  const id = dashboardIdFrom({ ...searchItem, dashboard: dash });
  const schemaVersion = Number(dash.schemaVersion || raw?.schemaVersion);
  const panelSummaries = Array.isArray(dash.panels) ? dash.panels : [];
  const rawPanels = raw ? flattenGrafanaPanels(raw.panels || []) : [];
  const panelSource = panelSummaries.length ? panelSummaries : rawPanels;
  const panelBindings = panelSource
    .map((p, i) => ({
      panel: String(p.title || p.id || `panel-${i + 1}`),
      binds_to: `ref:grafana/${id}/panels/${panelIdFrom(p, `panel-${i + 1}`)}`,
    }))
    .filter(p => p.panel && p.binds_to);

  const params = {
    ...(dash.uid ? { uid: dash.uid } : (searchItem.uid ? { uid: searchItem.uid } : {})),
    ...(dash.title ? { title: dash.title } : (searchItem.title ? { title: searchItem.title } : {})),
    ...(Array.isArray(dash.tags) && dash.tags.length ? { tags: dash.tags } : {}),
    ...(dash.timezone ? { timezone: dash.timezone } : {}),
    ...(dash.refresh ? { refresh: dash.refresh } : {}),
    ...(dash.time ? { time: dash.time } : {}),
    ...(dash.version != null ? { dashboardVersion: dash.version } : {}),
    ...(Array.isArray(dash.variables) && dash.variables.length ? { variables: dash.variables } : {}),
    ...(dash.panelCount != null ? { panelCount: dash.panelCount } : { panelCount: panelSource.length }),
    ...(dash.returnedPanels != null ? { returnedPanels: dash.returnedPanels } : { returnedPanels: panelSource.length }),
    ...(panelSummaries.length ? { panels: panelSummaries } : {}),
    ...(raw ? { raw } : {}),
  };

  return {
    id,
    provider: {
      kind: 'grafana',
      version: '12.0',
      ...(Number.isFinite(schemaVersion) ? { schemaVersion } : { schemaVersion: 41 }),
    },
    folder: detail?.meta?.folderTitle || searchItem.folderTitle || searchItem.folder || 'mcp-discovered',
    source: detail?.meta?.url ? `grafana://${detail.meta.url}`
      : (searchItem.url ? `grafana://${searchItem.url}` : `grafana://uid/${dash.uid || searchItem.uid || id}`),
    ...(Object.keys(params).length ? { params } : {}),
    ...(panelBindings.length ? { panel_bindings: panelBindings } : {}),
  };
}

export function buildCanonicalPack({
  refreshedAt,
  mcpUrl,
  health = {},
  topology = {},
  anomaliesActive = {},
  baselinesData = {},
  probeResults = {},
  errors = {},
  discoveredTools = [],
  unmatchedTools = [],
  capabilities = null,
  liveVersions = {},
  ruleEvidence = { firingAlerts: [], recordingRuleNames: [] },
  packName = PACK_NAME,
} = {}) {
  // Destructuring defaults only fire for `undefined`. The MCP probe
  // helper returns `null` when a tool responds with an empty/null
  // payload (an honest zero, not a failure), and those nulls are
  // spread straight in — so coalesce the object params to safe shapes
  // before anything dereferences them (e.g. baselinesData.baselines).
  health          = health          || {};
  topology        = topology        || {};
  anomaliesActive = anomaliesActive || {};
  baselinesData   = baselinesData   || {};
  probeResults    = probeResults    || {};
  errors          = errors          || {};

  const services = Array.isArray(health.services) ? health.services : [];
  const serviceNames = services.map(s => s?.name).filter(Boolean);
  const serviceSlugs = serviceNames.map(n => slug(n));
  const criticality = pickCriticality(services);

  // ---- metadata ----
  // Core tools that were called regardless of probes.
  const coreCalled = [TOOL.systemHealth, TOOL.systemTopology, TOOL.anomaliesActive, TOOL.anomaliesBaselines].filter(n => !errors[n]);
  // Probe tool that actually responded (per probe).
  const probeAnswered = Object.entries(probeResults)
    .filter(([_, v]) => v?.tool)
    .flatMap(([_, v]) => String(v.tool).split('+').filter(Boolean));
  // Classify each probe by outcome:
  //   data    — MCP responded with non-empty content (a real answer)
  //   empty   — MCP responded but the payload was empty (an honest zero)
  //   failed  — every candidate errored / 503'd (no response at all)
  // The probe loop now stamps `outcome` directly. For callers that
  // pre-populate probeResults (the offline fetcher tests do), classify
  // from the legacy fields: `tool` set means SOMETHING answered, and
  // a non-empty `adapted` array means it answered with data.
  const probesAttempted = Object.keys(probeResults || {});
  const classify = (v) => {
    if (!v) return 'failed';
    if (v.outcome) return v.outcome;
    if (v.tool && Array.isArray(v.adapted) && v.adapted.length > 0) return 'data';
    if (v.tool && Array.isArray(v.adapted)) return 'empty';
    if (v.tool) return 'data';  // non-array adapted shape; preserve legacy behaviour
    return 'failed';
  };
  const probesByOutcome = (target) =>
    Object.entries(probeResults || {})
      .filter(([_, v]) => classify(v) === target)
      .map(([k]) => k);
  const probesSucceeded = probesByOutcome('data');
  const probesEmpty     = probesByOutcome('empty');
  const probesFailed    = probesByOutcome('failed');

  const annotations = {
    'mcp.refreshedAt':         refreshedAt,
    'mcp.url':                 mcpUrl,
    'mcp.toolsCalled':         [...coreCalled, ...probeAnswered].join(','),
    'mcp.toolsFailed':         Object.keys(errors).join(',') || '',
    'mcp.probesAttempted':     probesAttempted.join(','),
    'mcp.probesSucceeded':     probesSucceeded.join(','),
    // Honest accounting of probes that ran but came back empty vs probes
    // that failed outright. The studio's summary reads these to render
    // "0 found" (empty) distinctly from "probe failed" (failed) — both
    // distinct from "— not attempted".
    'mcp.probesEmpty':         probesEmpty.join(','),
    'mcp.probesFailed':        probesFailed.join(','),
    'mcp.servicesDiscovered':  serviceNames.join(','),
    'mcp.baselinesComputed':   String((baselinesData.baselines || []).length),
    'mcp.activeAnomalies':     String(anomaliesActive?.traceAnomalies?.active?.length || 0),
    // tools/list inventory — the honest record of what the MCP advertised.
    'mcp.toolsExposed':        discoveredTools.map(t => t.name).join(','),
    'mcp.toolsExposedCount':   String(discoveredTools.length),
    // Tools the MCP advertises that we DON'T currently have a probe pattern
    // for. Every entry here is a candidate enhancement — surface them so
    // the user can name what to wire next.
    'mcp.toolsUnmatched':      unmatchedTools.map(t => t.name).join(','),
  };
  // Per-probe count annotations — ANY probe with an array result, whether
  // empty or populated, lands here so the studio can read "0" honestly.
  for (const [k, v] of Object.entries(probeResults || {})) {
    if (Array.isArray(v?.adapted)) {
      annotations[`mcp.discovered.${k}`] = String(v.adapted.length);
    }
  }

  // Per-artefact verification markers (only for items derived from a tool that
  // actually responded).
  const markVerified = (sym) => { annotations[`mcp.verified.${sym}`] = refreshedAt; };

  // ---- spec.otel ----
  const otelSection = {
    semconv: '1.27.0',
    resource_attributes: { required: ['service.name'] },
    sdk: {
      languages: ['go'],
      sampling: { policy: 'parentbased_traceidratio', ratio: 0.1 },
      propagators: ['tracecontext'],
    },
  };
  if (!errors[TOOL.systemHealth]) markVerified('otel');

  // ---- spec.telemetry.backends ----
  // When the MCP exposes backend_capabilities, drive backends from the
  // canonical skill→backend→product→version inventory. Each entry gets
  // a real version block (declared from must[0], gating from the
  // server's own gatingMode, capabilities from baselineFeatures). When
  // capabilities are absent, fall back to the legacy hardcoded set so
  // older MCPs still produce a valid pack.
  const backends = [];
  const seenIds = new Set();
  const pushBackend = (b, verifiedBy) => {
    if (seenIds.has(b.id)) return;
    seenIds.add(b.id);
    backends.push(b);
    if (verifiedBy && !errors[verifiedBy]) markVerified(`telemetry.backends.${b.id}`);
  };

  // Capability-derived inventory annotations (one row per skill+backend)
  // get stamped regardless of whether the entry becomes a telemetry
  // backend — the studio's connect screen reads these to render the
  // full version-gating story.
  const capabilityRows = [];
  if (capabilities && Array.isArray(capabilities.skills)) {
    for (const s of capabilities.skills) {
      const signal = SKILL_TO_SIGNAL[s.skill] ?? null;
      for (const b of s.backends || []) {
        const fallbackSlug = (slug(b.backend, '') || '').replace(/_/g, '-');
        const productSlug = BACKEND_TO_PRODUCT[b.backend] ?? (fallbackSlug || null);
        const pv = b.productVersions || {};
        const must = pv.must || [];
        const should = pv.should || [];
        const optional = pv.optional || [];
        const row = {
          skill: s.skill,
          backend: b.backend,
          product: productSlug,
          protocol: b.protocol || null,
          queryLanguage: b.queryLanguage || null,
          products: b.products || [],
          versions: { must, should, optional },
          baselineFeatures: b.baselineFeatures || [],
          versionedFeatures: (b.versionedFeatures || []).map(v => v.feature),
          signal,
        };
        capabilityRows.push(row);

        // Only mint a telemetry.backends[] entry when the skill maps
        // to one of the spec's Signal values AND the product slug
        // matches the Product pattern (`^[a-z][a-z0-9_-]*$`).
        if (!signal || !productSlug || !/^[a-z][a-z0-9_-]*$/.test(productSlug)) continue;
        const id = slug(`${signal}-${productSlug}`);
        if (!/^[a-z][a-z0-9_-]*[a-z0-9]$/.test(id)) continue;

        // Build the version block. `declared` is the LIVE, authoritative
        // version from a version-revealing probe when available (e.g.
        // grafana_health returns "12.4.0"; metrics_query vm_app_version
        // returns "v1.113.0"). When the live version is missing, fall
        // back to the backend_capabilities policy must[0]. `min` always
        // carries the policy floor so the user can see both the live
        // version AND the supported range.
        const live = liveVersions[productSlug]?.declared || null;
        const declared = live || must[0] || should[0] || optional[0] || null;
        const version = {};
        if (declared) version.declared = declared;
        if (must.length) version.min = must[must.length - 1];
        const gating = capabilities.gatingMode;
        if (gating === 'off' || gating === 'warn' || gating === 'enforce') {
          version.gating = gating;
        }
        // baselineFeatures already match the Product capability pattern
        // (lowercase, underscore-separated). Cap to 32 so a pack with
        // a chatty skill (e.g. elasticsearch with 60 features) stays
        // readable.
        const caps = (b.baselineFeatures || [])
          .filter(c => /^[a-z][a-z0-9_-]*$/.test(c))
          .slice(0, 32);
        if (caps.length) version.capabilities = caps;

        pushBackend({
          id,
          signal,
          product: productSlug,
          ...(Object.keys(version).length ? { version } : {}),
        }, TOOL.backendCapabilities);
      }
    }
  }

  // Fallback / floor: ensure the headline platform backends are
  // always present even when backend_capabilities was unavailable.
  // (Schema requires at least one telemetry backend.)
  if (backends.length === 0) {
    pushBackend({ id: 'metrics-prom', signal: 'metrics', product: 'prometheus' }, TOOL.systemHealth);
    pushBackend({ id: 'logs-elastic', signal: 'logs',    product: 'elasticsearch' }, null);
    pushBackend({ id: 'traces-jaeger', signal: 'traces', product: 'jaeger' },
                (topology?.dependencies || []).some(d => (d.child || '').includes('jaeger')) ? TOOL.systemTopology : null);
  }

  // Capability inventory annotations — the studio renders these on
  // connect so users can see exactly what the MCP can speak to.
  if (capabilities) {
    annotations['mcp.capabilities.gatingMode'] = capabilities.gatingMode;
    annotations['mcp.capabilities.protocolModel'] = capabilities.protocolModel || '';
    annotations['mcp.capabilities.skillCount'] = String(capabilities.skills.length);
    annotations['mcp.capabilities.backendCount'] = String(capabilityRows.length);
    annotations['mcp.capabilities.skills'] =
      [...new Set(capabilityRows.map(r => r.skill))].join(',');
    // Per-skill enumeration so the studio can render the inventory
    // without re-parsing. Format: `<skill>:<backend>:<product>:<must-csv>`
    // joined by '|'. Compact enough to keep total annotation size sane.
    annotations['mcp.capabilities.inventory'] = capabilityRows
      .map(r => `${r.skill}:${r.backend}:${r.product || '-'}:${(r.versions.must || []).join(';')}`)
      .join('|');
  }

  // Live-version annotations — the authoritative truth we pulled from
  // grafana_health, metrics_query vm_app_version, etc. Surfaced both
  // per-product (mcp.versions.grafana) AND with provenance
  // (mcp.versions.grafana.source) so an SRE can see exactly which
  // endpoint attested each number.
  //
  // A capture can come in two shapes:
  //   1. {declared, source, ...}  — a real version string was extracted
  //      (Grafana 12.4.0, VM v1.113.0, Loki 3.2.1, etc.)
  //   2. {alive: true, source, ...} — the backend responded to a probe
  //      (e.g. Jaeger via traces_services) but doesn't expose a
  //      version-readable endpoint we know about. The studio still
  //      gets to mark it ● LIVE; just without a number.
  for (const [product, info] of Object.entries(liveVersions || {})) {
    if (!info) continue;
    if (info.declared) {
      annotations[`mcp.versions.${product}`] = info.declared;
    } else if (info.alive) {
      annotations[`mcp.versions.${product}`] = 'live';
    } else {
      continue;
    }
    if (info.source) annotations[`mcp.versions.${product}.source`] = info.source;
    if (info.commit) annotations[`mcp.versions.${product}.commit`] = info.commit;
    if (info.fullTag && info.fullTag !== info.declared) {
      annotations[`mcp.versions.${product}.fullTag`] = info.fullTag;
    }
    if (info.revision) annotations[`mcp.versions.${product}.revision`] = info.revision;
    if (info.branch) annotations[`mcp.versions.${product}.branch`] = info.branch;
    if (info.edition) annotations[`mcp.versions.${product}.edition`] = info.edition;
    if (info.serviceCount != null) annotations[`mcp.versions.${product}.serviceCount`] = String(info.serviceCount);
    // Per-artefact verification marker pointing at the backend whose
    // version we just attested. The id pattern matches the convention
    // used in pushBackend below (e.g. metrics-victoriametrics).
    markVerified(`telemetry.backends.versions.${product}`);
  }

  const l2x = materializeL2XFromBackends(backends, { markVerified });
  annotations['mcp.discovered.extended_surfaces'] = String(l2x.evidence.length);
  if (l2x.evidence.length) {
    annotations['mcp.discovered.extended_surface_refs'] =
      l2x.evidence.map((e) => `${e.artifactId}:${e.backendId}`).join(',');
  }

  // Probes drive multiple downstream sections — hoist their results.
  const discoveredRules = probeResults?.recording_rules?.adapted || [];

  // Second, independent source of the platform's recorded SLO series: the
  // metric-inventory grep (metrics_label_values/__name__ filtered to the
  // `ns:metric:op` convention, surfaced on ruleEvidence.recordingRuleNames).
  // When the rules API comes back empty — as it does on MCP endpoints that
  // don't surface /api/v1/rules — the recorded series are STILL in the
  // metric inventory and ARE the live evidence of which SLIs the platform
  // runs. This is what makes the live reconstruction the true inverse of
  // the compiler: a pack compiled and deployed exposes `<svc>:<sli>:<op>`
  // recorded series, and reading those names back — from a repo crawl OR
  // from this live inventory — reconstructs the SAME SLI identities, so
  // diff.mjs can match them instead of reporting false drift. We only have
  // NAMES here (no exprs), so each pseudo-rule's expr is the recorded
  // series itself (a bare series selector is valid PromQL).
  const RULE_NAME_RE = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:[a-z0-9_]+$/;
  const inventoryRules = (ruleEvidence?.recordingRuleNames || [])
    .filter(n => typeof n === 'string' && RULE_NAME_RE.test(n))
    .map(n => ({ name: n, expr: n }));

  // Real recorded rules, preferring the rules API (carries exprs) and
  // falling back to the inventory-discovered series (names only). Both
  // feed the SAME inference the crawler uses — the symmetry contract.
  const recordedRules = (Array.isArray(discoveredRules) && discoveredRules.length > 0)
    ? discoveredRules
    : inventoryRules;

  // ---- spec.slis + spec.slos ----
  // We first infer SLIs from the platform's recorded SLO series (their
  // `ns:metric:op` names are the SLO evidence — exactly the inverse of how
  // the compiler materialises each SLI as recording rules). Service-derived
  // availability SLIs are a LAST resort, only when no recorded SLO series
  // exist at all — they're guesses, not evidence, so we never let them
  // mask the real recorded contracts.
  const slis = [];
  const slos = [];
  const inferredFromRules = inferSlisFromRecordingRules(recordedRules);
  if (inferredFromRules.length) {
    for (const { sli, slo } of inferredFromRules) {
      slis.push(sli);
      slos.push(slo);
      markVerified(`slis.${sli.id}`);
    }
  } else if (serviceSlugs.length === 0) {
    // Pack must have >= 1 SLI / SLO; stub a generic platform availability target.
    slis.push({
      id: 'platform_availability',
      description: 'Platform availability — no services discovered by MCP.',
      type: 'ratio',
      good: 'sum(rate(http_requests_total{status_code!~"5.."}[5m]))',
      total: 'sum(rate(http_requests_total[5m]))',
    });
    slos.push({
      id: 'platform_availability_99',
      sli: 'platform_availability',
      objective: 0.99,
      window: '30d',
      error_budget_policy: 'ref:platform/default-budget',
    });
  } else {
    for (const name of serviceSlugs) {
      const sliId = `${name.replace(/-/g, '_')}_availability`;
      const sloId = `${sliId}_99`;
      slis.push({
        id: sliId,
        description: `Availability SLI for ${name} (synthesised from MCP system_health).`,
        type: 'ratio',
        semconv_metric: 'http.server.request.duration',
        good:  `sum(rate(http_server_request_duration_seconds_count{service_name="${name}",http_response_status_code!~"5.."}[5m]))`,
        total: `sum(rate(http_server_request_duration_seconds_count{service_name="${name}"}[5m]))`,
      });
      slos.push({
        id: sloId,
        sli: sliId,
        objective: 0.99,
        window: '30d',
        error_budget_policy: 'ref:platform/default-budget',
      });
      markVerified(`slis.${sliId}`);
    }
  }

  // ---- spec.pipelines ----
  const pipelines = {
    receivers:  [{ name: 'otlp' }],
    processors: [{ name: 'memory_limiter' }, { name: 'batch' }],
    exporters: {
      metrics: { kind: 'prometheusremotewrite' },
      logs:    { kind: 'elasticsearch' },
      traces:  { kind: 'jaeger' },
    },
  };

  // ---- spec.queries.recording_rules ----
  // PREFER the platform's real recorded series (rules API or inventory
  // grep). Only fall back to the synthesised per-SLO stub when the
  // platform exposed no recorded series at all.
  let recordingRules;
  if (recordedRules.length > 0) {
    // Schema requires the rule NAME to match the prometheus convention
    // ns:metric:op. Anything that doesn't can't go in spec.queries —
    // skip those (and they'll surface in the warnings).
    recordingRules = recordedRules.filter(r => RULE_NAME_RE.test(r.name));
    markVerified('queries.recording_rules');
  } else {
    recordingRules = slos.map(s => ({
      name: `platform:${s.sli}:ratio_5m`,
      expr: `ref:slis.${s.sli}`,
      interval: '30s',
    }));
  }
  const queries = {};
  if (recordingRules.length > 0) queries.recording_rules = recordingRules;

  // ---- spec.dashboards ----
  // PREFER what came back from the dashboards probe.
  const discoveredDashboards = probeResults?.dashboards?.adapted;
  let dashboards;
  if (Array.isArray(discoveredDashboards) && discoveredDashboards.length > 0) {
    dashboards = discoveredDashboards;
    const dashboardPanelTotal = dashboards.reduce((sum, d) =>
      sum + (Array.isArray(d.panel_bindings) ? d.panel_bindings.length : 0), 0);
    const dashboardRawTotal = dashboards.filter(d => d.params?.raw).length;
    annotations['mcp.discovered.dashboard_panels'] = String(dashboardPanelTotal);
    annotations['mcp.discovered.dashboard_raw_json'] = String(dashboardRawTotal);
    if (Array.isArray(probeResults?.dashboards?.detailErrors) && probeResults.dashboards.detailErrors.length) {
      annotations['mcp.discovered.dashboard_detail_errors'] = probeResults.dashboards.detailErrors.slice(0, 64).join(',');
    }
    markVerified('dashboards');
  } else {
    dashboards = [{
      id: 'platform-overview',
      provider: { kind: 'grafana' },
      folder: 'platform',
      source: 'file://dashboards/platform-overview.json',
    }];
  }

  // ---- spec.policy.burn_rate_alerts ----
  // Per-SLO multi-window pattern is always synthesized — even when the
  // MCP exposes flat alert rules, those rarely encode the short/long
  // window decomposition the spec requires. We DO surface the
  // discovered alert NAMES in metadata.annotations.mcp.discovered.alert_rules
  // so the SRE can see what currently fires.
  const burnRateAlerts = slos.map(s => ({
    slo: s.id,
    windows: [
      { short: '5m',  long: '1h', factor: 14, severity: 'SEV1' },
      { short: '30m', long: '6h', factor: 6,  severity: 'SEV2' },
    ],
  }));
  const discoveredAlertNames = (probeResults?.alert_rules?.adapted || []).map(a => a.name).filter(Boolean);
  if (discoveredAlertNames.length) {
    annotations['mcp.discovered.alert_rule_names'] = discoveredAlertNames.slice(0, 64).join(',');
    markVerified('policy.burn_rate_alerts');
  }

  // Rule-evidence fallback annotations — what we found when the standard
  // rule-discovery endpoints came back empty but evidence existed
  // elsewhere. Kept under separate annotation keys so the studio can
  // surface "0 rule definitions visible · N firing alerts via ALERTS
  // metric" honestly, without conflating the two sources.
  if (Array.isArray(ruleEvidence?.firingAlerts) && ruleEvidence.firingAlerts.length) {
    const names = ruleEvidence.firingAlerts.map(a => a.name).filter(Boolean);
    const totalFirings = ruleEvidence.firingAlerts.reduce((acc, a) => acc + (a.count || 0), 0);
    annotations['mcp.discovered.alerts_firing.count'] = String(names.length);
    annotations['mcp.discovered.alerts_firing.total_firings'] = String(totalFirings);
    annotations['mcp.discovered.alerts_firing.names'] = names.slice(0, 64).join(',');
    annotations['mcp.discovered.alerts_firing.source'] = `${TOOL.metricsQuery}/ALERTS`;
    markVerified('policy.alerts_firing');
  }
  if (Array.isArray(ruleEvidence?.recordingRuleNames) && ruleEvidence.recordingRuleNames.length) {
    annotations['mcp.discovered.recording_rules_via_inventory.count'] =
      String(ruleEvidence.recordingRuleNames.length);
    annotations['mcp.discovered.recording_rules_via_inventory.names'] =
      ruleEvidence.recordingRuleNames.slice(0, 64).join(',');
    annotations['mcp.discovered.recording_rules_via_inventory.source'] =
      'metrics_label_values/__name__ (colon-pattern grep)';
    markVerified('queries.recording_rules_via_inventory');
  }

  // ---- scrape evidence + metric inventory ----
  // Both go into annotations (no schema field) so the SRE can see WHAT
  // the MCP confirmed is currently exported / scraped. This is exactly
  // what the user pushed back on: metrics being exported are observable
  // and must be surfaced.
  const scrapeJobs = probeResults?.scrape_configs?.adapted;
  if (Array.isArray(scrapeJobs) && scrapeJobs.length) {
    annotations['mcp.discovered.scrape_jobs'] = scrapeJobs.slice(0, 64).join(',');
    markVerified('telemetry.scrape');
    markVerified('pipelines.exporters.metrics');
  }
  const metricNames = probeResults?.metric_names?.adapted;
  if (Array.isArray(metricNames) && metricNames.length) {
    // Keep the full metric inventory for diagnostic-grade branch matching.
    // The sample remains for compact UI/log previews.
    annotations['mcp.discovered.metric_names'] = annotationJson(metricNames);
    annotations['mcp.discovered.metric_names_count'] = String(metricNames.length);
    annotations['mcp.discovered.metric_names_sample'] = metricNames.slice(0, 200).join(',');
    markVerified('otel.metrics');
    markVerified('pipelines.exporters.metrics');
  }

  // ---- spec.alerting ----
  const alerting = {
    routes: [{
      severity: 'SEV1',
      channels: [{ msteams: '#platform-oncall' }],
    }],
  };

  // ---- spec.baselines ----
  // Prefer MCP-supplied data; fall back to platform defaults for the
  // declared criticality.
  const fallback = defaultBaselines(criticality);
  const baselinesNormal = (baselinesData.baselines || [])
    .map(b => b.thresholdMs).filter(n => typeof n === 'number');
  const mttdFromData = baselinesNormal.length
    ? durationFromMs(Math.min(...baselinesNormal), fallback.mttd_target_p50)
    : fallback.mttd_target_p50;
  const baselines = {
    mttd_target_p50: mttdFromData,
    mttr_target_p50: fallback.mttr_target_p50,
    measurement_source: 'mcp.anomalies_baselines',
    review_cadence: 'weekly',
  };
  if (!errors[TOOL.anomaliesBaselines]) markVerified('baselines');

  // ---- spec.validation ----
  // Empty — MCP can't directly attest chaos / synthetics.
  const validation = {};

  // ---- assemble ----
  const pack = {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: {
      name: slug(packName, 'production-live'),
      version: `0.${Math.floor(Date.parse(refreshedAt) / 60000) || 1}.0`,
      owners: ['mcp-fetcher'],
      bindings: {
        service: slug(packName, 'production-live'),
        environments: ['prod'],
        criticality,
      },
      annotations,
    },
    spec: {
      otel: otelSection,
      telemetry: { backends },
      ...l2x.sections,
      slis,
      slos,
      pipelines,
      queries,
      dashboards,
      policy: { burn_rate_alerts: burnRateAlerts },
      alerting,
      baselines,
      validation,
    },
  };
  return pack;
}

// ============================================================
// Entrypoint
// ============================================================

// ============================================================
// Discovery probes — narrow the gap between "MCP can attest" and
// what the spec asks for. Each probe declares a CANDIDATE LIST of
// tool names (MCPs in the wild use different conventions) and an
// adapter that maps whatever shape comes back to the spec field.
//
// The fetcher tries the candidates in order; the first that responds
// wins. If none respond, the probe is recorded as "attempted but
// unanswered" so the draft can be honest about what was actually
// missing vs what we never asked for.
// ============================================================

// Prometheus/VMAlert express rule-group evaluation intervals and alert
// `for` windows as integer SECONDS (e.g. interval: 300). The pack schema —
// and the crawled declared side — use Prometheus duration strings
// ("5m", "30s", "1h"). Normalise so live and declared compare apples to
// apples instead of reporting "300" vs "5m" as drift.
function secondsToPromDuration(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n % 3600 === 0) return `${n / 3600}h`;
  if (n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}
function normInterval(v) {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return secondsToPromDuration(v) || undefined;
  if (typeof v === 'string' && /^\d+$/.test(v)) return secondsToPromDuration(Number(v)) || undefined;
  return v; // already a duration string ("5m", "30s", ...)
}

export const PROBES = [
  {
    name: 'recording_rules',
    // Candidate list + fallback-order rationale live in the contract
    // registry (tools/lib/contracts/mcp-capabilities.mjs).
    candidates: probeCandidates('recording_rules'),
    target: 'spec.queries.recording_rules',
    adapt: (response) => {
      // Common shapes:
      //   { groups: [{ name, interval, rules: [{ record|name, expr|query, type?, interval? }] }] }
      //   { rules: [{ record/name, expr/query, interval? }] }
      //   { data: { groups: [...] } }   (Prometheus /api/v1/rules)
      const groups = response?.groups || response?.data?.groups || [];
      const flat = response?.rules || groups.flatMap(g => (g.rules || []).map(r => ({ ...r, _group: g.name, _interval: g.interval })));
      return flat
        // Recording rules only: exclude anything VMAlert/Prometheus marks as
        // an alert (type==='alerting' on VMAlert, or a bare `alert` field).
        .filter(r => (r.record || r.name) && r.type !== 'alerting' && !r.alert)
        .map(r => {
          const interval = normInterval(r.interval ?? r._interval);
          return {
            name: r.record || r.name,
            expr: r.expr || r.query || '',
            ...(interval ? { interval } : {}),
            ...(r.labels ? { labels: r.labels } : {}),
          };
        })
        .filter(r => r.expr);
    },
  },
  {
    name: 'alert_rules',
    // Candidate list + fallback-order rationale live in the contract
    // registry (tools/lib/contracts/mcp-capabilities.mjs).
    candidates: probeCandidates('alert_rules'),
    target: 'spec.policy.burn_rate_alerts',
    adapt: (response) => {
      const groups = response?.groups || response?.data?.groups || [];
      const flat = response?.rules || groups.flatMap(g => (g.rules || []).map(r => ({ ...r, _group: g.name })));
      // We can't fully reconstruct multi-window burn-rate semantics
      // from a flat rule, but we CAN capture the alert as a forecast
      // signal — the user can re-shape via the studio later.
      return flat
        // Alerting rules only: VMAlert marks them type==='alerting'; generic
        // Prometheus uses an `alert` field; the `!== 'recording'` guard keeps
        // VMAlert recording rules (name set, no `record`) out of this bucket.
        .filter(r => r.type === 'alerting' || r.alert || (r.name && !r.record && r.type !== 'recording'))
        .map(r => ({
          name: r.alert || r.name,
          expr: r.expr || r.query || '',
          for: r.for || (r.duration ? secondsToPromDuration(r.duration) : null) || '5m',
          labels: r.labels || (r.severity ? { severity: r.severity } : {}),
          annotations: r.annotations || {},
        }));
    },
  },
  {
    name: 'dashboards',
    // Candidate list + fallback-order rationale live in the contract
    // registry; the env-tunable search limit is injected here because the
    // data-only contracts layer doesn't read process.env.
    candidates: probeCandidates('dashboards', { grafanaDashboardSearchLimit: GRAFANA_DASHBOARD_SEARCH_LIMIT }),
    target: 'spec.dashboards',
    adapt: (response) => {
      // otel-mcp-server's grafana_dashboards_search returns:
      //   { count: <n>, results: [{ id, uid, title, type:'dash-db'|'dash-folder', url, uri, tags, folderUid?, folderTitle? }] }
      // Generic shapes also supported: bare array, {dashboards}, {items}.
      return grafanaDashboardSearchItems(response).map(dashboardFromSearchItem);
    },
  },
  {
    name: 'scrape_configs',
    // Candidate list + fallback-order rationale live in the contract
    // registry (tools/lib/contracts/mcp-capabilities.mjs).
    candidates: probeCandidates('scrape_configs'),
    target: 'spec.telemetry.scrape_evidence',   // annotation-only; no schema field
    adapt: (response) => {
      // otel-mcp-server's metrics_targets returns:
      //   { activeTargets: <number>, targets: [{ job, instance, health, lastScrape, lastError }] }
      // Prometheus /api/v1/targets returns:
      //   { data: { activeTargets: [{ labels: { job, instance } }] } }
      // Generic: bare array of targets, or { targets: [...] }.
      const candidateArrays = [
        Array.isArray(response?.targets) && response.targets,
        Array.isArray(response?.activeTargets) && response.activeTargets,
        Array.isArray(response?.data?.activeTargets) && response.data.activeTargets,
        Array.isArray(response) && response,
      ];
      const targets = candidateArrays.find(Boolean) || [];
      const jobs = new Set();
      for (const t of targets) {
        const j = t.labels?.job || t.job;
        if (j) jobs.add(j);
      }
      return [...jobs];
    },
  },
  {
    name: 'metric_names',
    // Candidate list + fallback-order rationale live in the contract
    // registry. Candidates are either a bare tool name (no args) or
    // `{ name, args }` when the tool needs arguments to enumerate names.
    candidates: probeCandidates('metric_names'),
    target: 'spec.otel.metric_inventory',
    adapt: (response) => {
      // otel-mcp-server metrics_label_values shape:
      //   { label: "__name__", values: [<name>, ...] }
      if (Array.isArray(response?.values)) {
        return response.values.filter(s => typeof s === 'string');
      }
      // Prometheus /api/v1/label/<name>/values raw shape:
      //   { status: "success", data: [<name>, ...] }
      if (Array.isArray(response?.data)) {
        return response.data.filter(s => typeof s === 'string');
      }
      // metrics_metadata shape: { data: { <metric>: [{ type, help, unit }] } }
      if (response?.data && typeof response.data === 'object' && !Array.isArray(response.data)) {
        return Object.keys(response.data);
      }
      // Bare array
      const names = Array.isArray(response) ? response
        : (response?.metrics || response?.names || []);
      return Array.isArray(names) ? names.filter(s => typeof s === 'string') : [];
    },
  },
];

export async function fetchMcp({ mcpUrl, mcpAuth = null } = {}) {
  if (!mcpUrl) throw new Error('fetchMcp: mcpUrl required');
  const { rpc, notify, callTool } = createMcpClient({ mcpUrl, mcpAuth });
  const errors = {};
  const safe = async (name, fn) => {
    try { return await fn(); } catch (e) { errors[name] = e.message; return null; }
  };
  // Per-probe failures recorded so the user can see WHY a probe didn't
  // succeed (input validation, network, etc.) — distinct from the
  // top-level `errors` map which is for the core tools.
  const probeFailures = {};

  // Single retry on transient 5xx — upstream observability backends
  // (VictoriaMetrics, Grafana, Jaeger, …) occasionally drop a request
  // when they're under load. The first retry usually succeeds.
  const isTransient = (msg) =>
    typeof msg === 'string' && /HTTP 50[0-9]|temporarily unavailable|timeout|ETIMEDOUT|ECONN/i.test(msg);

  const quiet = async (name, fn) => {
    // Like `safe`, but doesn't pollute `errors` — used for probes
    // because trying a candidate tool that doesn't exist isn't a
    // failure, it's an expected miss. Captures into probeFailures
    // for diagnostics, and retries once on transient 5xx.
    try { return await fn(); }
    catch (e) {
      if (isTransient(e.message)) {
        try { return await fn(); }
        catch (e2) {
          if (!probeFailures[name]) probeFailures[name] = e2.message;
          if (brandEnv('DEBUG')) {
            process.stderr.write(`[fetch-live-pack] probe ${name} failed twice: ${e2.message}\n`);
          }
          return null;
        }
      }
      if (!probeFailures[name]) probeFailures[name] = e.message;
      if (brandEnv('DEBUG')) {
        process.stderr.write(`[fetch-live-pack] probe ${name} failed: ${e.message}\n`);
      }
      return null;
    }
  };

  const initialized = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'observogram-fetcher', version: '0.4.0' },
  }).then(() => true).catch(() => false);
  if (initialized) await notify('notifications/initialized').catch(() => {});

  // Discover what the MCP actually exposes via tools/list. This is the
  // foundation for honest probing — instead of guessing candidate tool
  // names blindly, we intersect with what the server actually
  // advertises. tools/list is part of the MCP spec since 2025-03-26;
  // we tolerate its absence (older servers) by falling back to the
  // candidate-guessing behaviour for compatibility.
  const toolsList = await safe('tools/list', () => rpc('tools/list'));
  const discoveredTools = Array.isArray(toolsList?.tools)
    ? toolsList.tools.map(t => ({ name: t.name, description: t.description || '' }))
    : [];
  const discoveredToolNames = new Set(discoveredTools.map(t => t.name));

  // otel-mcp-server 1.6+ exposes `backend_capabilities` — the canonical
  // skill → backend → product → version inventory the spec's
  // VersionSpec was designed around. Call it up-front; downstream
  // builders use it to (a) declare telemetry.backends[] with real
  // version blocks and (b) surface the full inventory to the studio.
  const capabilitiesRaw = discoveredToolNames.has(TOOL.backendCapabilities)
    ? await safe(TOOL.backendCapabilities, () => callTool(TOOL.backendCapabilities))
    : null;
  const capabilities = capabilitiesRaw ? parseBackendCapabilities(capabilitiesRaw) : null;

  const [health, topology, anomaliesActive, baselinesData] = await Promise.all([
    safe(TOOL.systemHealth,       () => callTool(TOOL.systemHealth)),
    safe(TOOL.systemTopology,     () => callTool(TOOL.systemTopology)),
    safe(TOOL.anomaliesActive,    () => callTool(TOOL.anomaliesActive)),
    safe(TOOL.anomaliesBaselines, () => callTool(TOOL.anomaliesBaselines)),
  ]);

  if (!health || !topology) {
    throw new Error(`core MCP tools unavailable. errors: ${JSON.stringify(errors)}`);
  }

  // Run discovery probes in parallel. If we got a tools/list response,
  // reorder candidates so the ACTUALLY EXPOSED names get tried first,
  // and skip the rest — no point hammering the server with names it
  // can't recognise. If tools/list returned nothing (old server), fall
  // back to the original candidate-cascade behaviour.
  // Probe candidates may be either a bare tool name OR a `{name, args}`
  // object when the tool requires arguments to do anything useful (e.g.
  // metrics_label_values needs {label: '__name__'} to enumerate metric
  // names). Normalise into a [{name, args}] list here.
  const candName = (c) => (typeof c === 'string' ? c : c.name);
  const candArgs = (c) => (typeof c === 'string' ? {} : (c.args || {}));

  // Tool-call cache (per fetchMcp run). Keyed by name + JSON-stringified
  // args. Several probes converge on the same MCP tool — recording_rules
  // and alert_rules both call `metrics_alerts`; if we let them race in
  // parallel, one call can 503 while the other gets through, leaving
  // the studio with a confusing partial picture. Sharing the response
  // (a) eliminates the race, (b) halves the wire traffic, (c) keeps
  // the parallel speed-up because the second caller just awaits the
  // first call's pending promise.
  const toolCallCache = new Map();
  const cachedCall = (name, args) => {
    const key = `${name}::${JSON.stringify(args || {})}`;
    if (toolCallCache.has(key)) return toolCallCache.get(key);
    const p = quiet(name, () => callTool(name, args || {}));
    toolCallCache.set(key, p);
    return p;
  };

  // Treat the probe's adapt() output as empty when there's nothing
  // actionable in it — an empty array, an empty object, or null. An
  // empty response on the first candidate doesn't mean the whole probe
  // is unanswerable; the cascade should fall through to the next source.
  // (Krystaline metrics_alerts returns {groups: []} — genuinely zero
  // Prometheus rules — but the rules might live in Grafana Unified
  // Alerting at grafana_alert_rules, so we keep trying.)
  const isEmptyAdapted = (v) => {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  };

  const probeResults = {};
  await Promise.all(PROBES.map(async (probe) => {
    let candidates;
    if (discoveredToolNames.size > 0) {
      // Trust the server's advertisement: only try names it actually exposes.
      candidates = probe.candidates.filter(c => discoveredToolNames.has(candName(c)));
      if (candidates.length === 0) {
        probeResults[probe.name] = {
          tool: null,
          attempted: probe.candidates.map(candName),
          adapted: null,
          skippedReason: 'no candidate matched tools/list inventory',
          outcome: 'unsupported',
        };
        return;
      }
    } else {
      candidates = probe.candidates.slice();
    }
    const attempted = [];
    // Remember the first candidate that responded with a non-null
    // result, even if that result was empty. If all candidates either
    // fail outright OR return empty, we fall back to reporting the
    // FIRST empty-but-successful result so the studio can distinguish
    // "MCP says: 0 rules" from "MCP didn't respond at all".
    let firstEmpty = null;
    for (const candidate of candidates) {
      const name = candName(candidate);
      const args = candArgs(candidate);
      attempted.push(name);
      const response = await cachedCall(name, args);
      if (response == null) continue;          // tool errored or returned nothing
      let adapted;
      try { adapted = probe.adapt(response); }
      catch (_) { adapted = null; }
      if (!isEmptyAdapted(adapted)) {
        // Real data — cache this candidate as the winner and stop.
        probeResults[probe.name] = {
          tool: name,
          attempted: attempted.slice(),
          adapted,
          rawSize: JSON.stringify(response).length,
          outcome: 'data',
        };
        return;
      }
      // Empty result. Remember it but keep looking — another candidate
      // might carry the data.
      if (!firstEmpty) {
        firstEmpty = { tool: name, adapted, rawSize: JSON.stringify(response).length };
      }
    }
    if (firstEmpty) {
      probeResults[probe.name] = {
        tool: firstEmpty.tool,
        attempted,
        adapted: firstEmpty.adapted,
        rawSize: firstEmpty.rawSize,
        outcome: 'empty',
      };
      return;
    }
    probeResults[probe.name] = {
      tool: null, attempted, adapted: null,
      outcome: 'failed',
    };
  }));

  // Dashboard search only returns the catalogue row. For diagnostic-grade
  // drift we need the artifact body too: variables, panels, targets, and the
  // raw sanitized Grafana JSON when the MCP exposes it. Enrich the winning
  // dashboard probe with one grafana_dashboard_get call per UID.
  if (
    probeResults.dashboards?.tool === TOOL.dashboardSearch &&
    discoveredToolNames.has(TOOL.dashboardDetail)
  ) {
    const searchResponse = await cachedCall(TOOL.dashboardSearch, {
      type: 'dash-db',
      limit: GRAFANA_DASHBOARD_SEARCH_LIMIT,
    });
    const searchItems = grafanaDashboardSearchItems(searchResponse);
    const detailed = [];
    const detailErrors = [];
    for (const item of searchItems) {
      const uid = item.uid || item.id;
      if (!uid) {
        detailed.push(dashboardFromSearchItem(item));
        continue;
      }
      const detail = await cachedCall(TOOL.dashboardDetail, {
        uid,
        include_json: GRAFANA_DASHBOARD_INCLUDE_JSON,
        panel_limit: GRAFANA_DASHBOARD_PANEL_LIMIT,
      });
      if (detail) {
        detailed.push(dashboardFromGrafanaDetail(detail, item));
      } else {
        detailErrors.push(String(uid));
        detailed.push(dashboardFromSearchItem(item));
      }
    }
    if (detailed.length) {
      probeResults.dashboards = {
        ...probeResults.dashboards,
        tool: `${TOOL.dashboardSearch}+${TOOL.dashboardDetail}`,
        attempted: [
          ...(probeResults.dashboards.attempted || []),
          TOOL.dashboardDetail,
        ].filter((v, i, a) => a.indexOf(v) === i),
        adapted: detailed,
        rawSize: JSON.stringify(detailed).length,
        outcome: 'data',
        detailErrors,
      };
    }
  }

  // ----------------------------------------------------------------
  // Version probes — authoritative live version capture.
  //
  // backend_capabilities tells us what the MCP SUPPORTS (e.g. "metrics
  // skill, VictoriaMetrics, must=1.x"). That's a policy range, not a
  // live truth. These probes call canonical version-revealing endpoints
  // on the actual backends so the resulting telemetry.backends[] entry
  // carries `version.declared = <live>` — the real string the cluster
  // is running.
  //
  // Each probe maps to (product, value-extractor). Spec v1.2 §VersionSpec
  // pinned `declared` as the live value with `min` carrying the policy
  // floor — so we slot the live version into `declared` and let the
  // backend_capabilities policy live alongside.
  // ----------------------------------------------------------------
  const liveVersions = {};

  // Grafana — grafana_health returns {version, commit, database, orgId}.
  if (discoveredToolNames.has(TOOL.grafanaHealth)) {
    const r = await quiet(TOOL.grafanaHealth, () => callTool(TOOL.grafanaHealth));
    if (r && typeof r.version === 'string') {
      liveVersions.grafana = { declared: r.version, commit: r.commit || null, source: TOOL.grafanaHealth };
    }
  }

  // Metrics-query-based version probes — each backend that publishes a
  // `*_build_info` metric (Prometheus convention) gets a row in
  // BUILD_INFO_PROBES (contract registry); the per-product metric and
  // version-label facts live there. We run them in parallel since each is
  // independent. For each, the same shape: query the metric, take the
  // first result's labels, capture { declared, source } plus any
  // provenance labels (revision, edition, branch). When the result is
  // empty, the backend either isn't scraped or doesn't publish that
  // metric — both are legitimate negatives that the studio chip should
  // NOT mark as live.
  if (discoveredToolNames.has(TOOL.metricsQuery)) {
    await Promise.all(BUILD_INFO_PROBES.map(async (probe) => {
      // Skip if a richer source (e.g. grafana_health) already populated this product.
      if (liveVersions[probe.product]) return;
      const resp = await quiet(`${TOOL.metricsQuery}.${probe.metric}`,
        () => callTool(TOOL.metricsQuery, { query: probe.metric }));
      const series = resp?.result?.[0]?.metric;
      if (!series) return;
      let declared = null;
      for (const labelKey of probe.versionLabels) {
        if (typeof series[labelKey] === 'string' && series[labelKey].length) {
          declared = series[labelKey];
          break;
        }
      }
      if (!declared) return;
      const info = { declared, source: `${TOOL.metricsQuery}/${probe.metric}` };
      for (const x of (probe.extra || [])) {
        if (typeof series[x] === 'string' && series[x] !== declared) info[x] = series[x];
      }
      // For VM, also keep the full goversion-style tag separately so the
      // chip can still show the clean "v1.113.0" while annotations carry
      // the long "victoria-metrics-20250307-…-v1.113.0-…" form.
      if (probe.product === 'victoriametrics' && series.version && series.version !== declared) {
        info.fullTag = series.version;
      }
      liveVersions[probe.product] = info;
    }));
  }

  // Traces-availability probe — Jaeger (and others) don't always expose
  // a server build_info metric. But calling traces_services returns the
  // service list, which is positive proof the trace backend is
  // responding live. Mark the corresponding product as alive: true
  // without a specific version; the studio chip shows ● LIVE without
  // a number.
  //
  // Disambiguation: the capabilities inventory lists every TRACE backend
  // the MCP CAN speak to (Jaeger, Tempo, Zipkin, SkyWalking) — but the
  // deployment uses ONE. The services list usually contains the trace
  // backend's own service name ("jaeger" → it's Jaeger). When the
  // service list doesn't disambiguate, fall back to the FIRST trace
  // backend in the capability inventory (typically Jaeger) — never
  // light up all of them, which would falsely claim Tempo/Zipkin/etc.
  // are running.
  if (discoveredToolNames.has(TOOL.tracesServices)) {
    const tr = await quiet(TOOL.tracesServices, () => callTool(TOOL.tracesServices));
    if (tr && Array.isArray(tr.services) && tr.services.length) {
      const services = tr.services.map(s => String(s).toLowerCase());
      const tracesBackends = (capabilities?.skills || [])
        .find(s => s.skill === 'traces')?.backends || [];
      const productsInScope = tracesBackends
        .map(b => BACKEND_TO_PRODUCT[b.backend])
        .filter(Boolean);
      // Look for a match in the services list — the trace backend
      // typically reports its own service name as a self-instrumented
      // span emitter.
      const matched = productsInScope.find(p => services.includes(p));
      const winner = matched || productsInScope[0] || null;
      if (winner && !liveVersions[winner]) {
        liveVersions[winner] = {
          alive: true,
          source: TOOL.tracesServices,
          serviceCount: tr.services.length,
          disambiguatedBy: matched ? 'service-name-match' : 'capability-inventory-first',
        };
      }
    }
  }

  // ----------------------------------------------------------------
  // Rule-evidence fallback (Phase 6) — capture rule existence even when
  // the standard rule-discovery endpoints come back empty.
  //
  // The contract gap: a platform can have alerts actively firing AND
  // recording rules running, yet have ZERO rule definitions visible
  // via metrics_alerts (VM /api/v1/rules), grafana_alert_rules, or
  // alertmanager_alerts. Reasons:
  //   1. Rules evaluated by VMAlert/Mimir-ruler/custom evaluator that
  //      doesn't surface a discoverable /api/v1/rules endpoint
  //   2. Custom services writing ALERTS series directly (Krystaline's
  //      bayesian-service emits ErrorBudgetExhaustionForecast etc.)
  //   3. Recording rules running in a different deployment, with only
  //      their outputs landing in the central VM
  //
  // We can still attest the EVIDENCE of rules from data we already have:
  //   • alerts:    query ALERTS{alertstate="firing"} → firing alertnames
  //   • recording: grep the metric inventory for the colon convention
  //                <namespace>:<metric>:<op_window> — Prometheus's
  //                canonical recording-rule output naming
  //
  // We can't capture the rule's expression (it lives wherever it's
  // evaluated), but we capture identity + observed state, which is
  // honest evidence. Studio summary distinguishes "0 rule definitions
  // visible" from "0 — none configured" using these annotations.
  // ----------------------------------------------------------------
  const ruleEvidence = { firingAlerts: [], recordingRuleNames: [] };

  // Fallback for alert_rules: only run when the primary probe returned
  // an empty array AND the MCP exposes metrics_query.
  const alertProbe = probeResults?.alert_rules;
  const alertPrimaryEmpty = alertProbe &&
    (alertProbe.outcome === 'empty' || (Array.isArray(alertProbe.adapted) && alertProbe.adapted.length === 0));
  if (alertPrimaryEmpty && discoveredToolNames.has(TOOL.metricsQuery)) {
    const r = await quiet(`${TOOL.metricsQuery}.ALERTS`,
      () => callTool(TOOL.metricsQuery, { query: 'count by (alertname, severity, team, alertgroup) (ALERTS{alertstate="firing"})' }));
    const series = Array.isArray(r?.result) ? r.result : [];
    for (const s of series) {
      const m = s?.metric || {};
      if (!m.alertname) continue;
      const count = Number(s.value?.[1] ?? 0);
      ruleEvidence.firingAlerts.push({
        name: m.alertname,
        severity: m.severity || null,
        team: m.team || null,
        group: m.alertgroup || null,
        count: Number.isFinite(count) ? count : null,
      });
    }
  }

  // Fallback for recording_rules: grep the metric inventory captured by
  // the metric_names probe. Recording rules in Prometheus follow the
  // <ns>:<metric>:<op>[_<window>] convention — namespace:metric:op,
  // typically three colon-segments. We accept 2-or-more so platform
  // shorthand (e.g. `up:rate1m`) is captured too.
  const recordingProbe = probeResults?.recording_rules;
  const recordingPrimaryEmpty = recordingProbe &&
    (recordingProbe.outcome === 'empty' || (Array.isArray(recordingProbe.adapted) && recordingProbe.adapted.length === 0));
  const metricNames = probeResults?.metric_names?.adapted;
  if (recordingPrimaryEmpty && Array.isArray(metricNames) && metricNames.length) {
    const RECORDING_PATTERN = /^[a-z][a-z0-9_-]*(:[a-z][a-z0-9_-]*){1,}$/i;
    const NOISE_PREFIXES = /^(ALERTS|UP|process_|go_|http_|prometheus_|alertmanager_|grafana_|loki_|vmalert_|jvm_)/i;
    ruleEvidence.recordingRuleNames = metricNames
      .filter(n => typeof n === 'string')
      .filter(n => RECORDING_PATTERN.test(n))
      .filter(n => !NOISE_PREFIXES.test(n))
      .slice(0, 200);
  }

  // Compute unmatched tool names — tools the MCP advertises that we
  // DON'T have a probe pattern for. These are the leading edge: every
  // unmatched name is a potential probe candidate to add. Surface them
  // so engineers can see what's reachable but not yet wired into the
  // canonical pack.
  const allMatchedNames = new Set(
    Object.values(probeResults)
      .flatMap(r => String(r?.tool || '').split('+'))
      .filter(Boolean)
      .concat([TOOL.systemHealth, TOOL.systemTopology, TOOL.anomaliesActive, TOOL.anomaliesBaselines])
  );
  // Version probes count as "wired" too — surface them so they don't
  // show up as "not yet probed" in the unmatched panel.
  if (liveVersions.grafana?.source === TOOL.grafanaHealth) allMatchedNames.add(TOOL.grafanaHealth);
  // metrics_query gets used for build_info probes across many products
  // (vm_app_version, loki_build_info, alertmanager_build_info, …).
  // If ANY of them landed, the tool is "wired."
  const metricBuiltSourced = Object.values(liveVersions).some(v =>
    typeof v?.source === 'string' && v.source.startsWith(`${TOOL.metricsQuery}/`));
  if (metricBuiltSourced) allMatchedNames.add(TOOL.metricsQuery);
  // traces_services availability probe — wired when any trace product
  // captured an `alive: true` entry via it.
  const tracesAlive = Object.values(liveVersions).some(v => v?.source === TOOL.tracesServices);
  if (tracesAlive) allMatchedNames.add(TOOL.tracesServices);
  const unmatchedTools = discoveredTools.filter(t => !allMatchedNames.has(t.name));

  return {
    health, topology, anomaliesActive, baselinesData,
    probeResults, errors,
    discoveredTools,            // full list from tools/list (or empty if unsupported)
    unmatchedTools,             // tools the MCP exposes that we don't probe yet
    capabilities,               // parsed backend_capabilities inventory (or null)
    liveVersions,               // { <product>: { declared, ...meta } } from authoritative endpoints
    ruleEvidence,               // { firingAlerts, recordingRuleNames } — fallback evidence
  };
}

// Convenience entrypoint used by the CLI + the server: end-to-end build,
// validate, and (optionally) write to disk. Returns the canonical pack.
export async function buildAndValidate({ mcpUrl, mcpAuth, packName, refreshedAt }) {
  const fetched = await fetchMcp({ mcpUrl, mcpAuth });
  const at = refreshedAt || new Date().toISOString();
  const pack = buildCanonicalPack({ refreshedAt: at, mcpUrl, packName, ...fetched });
  const errors = validateCanonical(pack, SCHEMA);
  if (errors.length) {
    const err = new Error(`built pack failed schema validation (${errors.length} error${errors.length === 1 ? '' : 's'})`);
    err.details = errors;
    throw err;
  }
  return { pack, refreshedAt: at };
}

async function main() {
  process.stderr.write(`[fetch-live-pack] talking to ${MCP_URL_DEFAULT}\n`);
  const fetched = await fetchMcp({ mcpUrl: MCP_URL_DEFAULT, mcpAuth: MCP_AUTH_DEFAULT });
  const refreshedAt = new Date().toISOString();
  const pack = buildCanonicalPack({ refreshedAt, mcpUrl: MCP_URL_DEFAULT, ...fetched });

  const errs = validateCanonical(pack, SCHEMA);
  if (errs.length) {
    process.stderr.write(`[fetch-live-pack] built pack failed validation:\n`);
    for (const e of errs) process.stderr.write(`    ${e}\n`);
    throw new Error(`built pack failed schema validation (${errs.length} error${errs.length === 1 ? '' : 's'})`);
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, emitYaml(pack));

  process.stderr.write(
    `[fetch-live-pack] wrote ${OUTPUT}\n` +
    `  refreshedAt:        ${refreshedAt}\n` +
    `  services:           ${pack.metadata.annotations['mcp.servicesDiscovered'] || '(none)'}\n` +
    `  baselines computed: ${pack.metadata.annotations['mcp.baselinesComputed']}\n` +
    `  active anomalies:   ${pack.metadata.annotations['mcp.activeAnomalies']}\n` +
    `  tools failed:       ${pack.metadata.annotations['mcp.toolsFailed'] || 'none'}\n`
  );
}

const invokedDirectly = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch(e => { process.stderr.write(`[fetch-live-pack] FATAL: ${e.message}\n`); process.exit(1); });
}
