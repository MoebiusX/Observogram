// tools/lib/grafana-mcp-bridge.mjs
//
// A minimal MCP server backed by a REAL Grafana HTTP API — test
// scaffolding for the T4 round trip (docs/TEST_PLAN_COMPILER_VALIDITY.md
// §6). Observogram's deploy and fetch-live paths speak MCP (in production
// to otel-mcp-server or another gateway); this bridge plays that
// gateway's role against the disposable validation Grafana so the WHOLE
// ratified chain — deploy-bulk → MCP tools → Grafana → fetch-live →
// adapter → diff — runs against a real backend in CI.
//
// The bridge deliberately mirrors otel-mcp-server's documented
// behaviour, including the one piece of config-mapping that gateway
// performs: rewriting the compiler's ${DS_PROMETHEUS} datasource
// placeholder to the gateway's configured datasource uid. Everything
// else is a thin translation to the Grafana HTTP API.
//
// Exposed tools:
//   grafana_create_dashboard   { dashboard, folder_uid?, mode, dry_run }
//   grafana_create_alert_rule  { rule, mode, dry_run }
//   grafana_alert_rules        {}                  (provisioned rules listing)
//   grafana_dashboards_search  { type?, limit? }
//   grafana_dashboard_get      { uid }

import { createServer } from 'node:http';

export async function startGrafanaMcpBridge({
  grafanaUrl,
  auth = 'admin:admin',                 // basic auth user:pass
  datasourceUid = 'obs-pack-prom',      // the provisioned datasource the gateway maps to
} = {}) {
  const base = String(grafanaUrl).replace(/\/+$/, '');
  const authHeader = `Basic ${Buffer.from(auth).toString('base64')}`;
  const ensuredFolders = new Set();
  const log = [];

  async function gf(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Without this header Grafana marks provisioned resources
        // immutable (provenance=api) and upserts via PUT are refused.
        'X-Disable-Provenance': 'true',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  }

  async function ensureFolder(uid) {
    if (!uid || ensuredFolders.has(uid)) return;
    const existing = await gf('GET', `/api/folders/${encodeURIComponent(uid)}`);
    if (!existing.ok) {
      const made = await gf('POST', '/api/folders', { uid, title: uid });
      if (!made.ok && made.status !== 409 && made.status !== 412) {
        throw new Error(`folder create '${uid}' failed: HTTP ${made.status} ${made.text.slice(0, 200)}`);
      }
    }
    ensuredFolders.add(uid);
  }

  // The gateway's datasource mapping: the compiler emits the
  // ${DS_PROMETHEUS} placeholder; the gateway substitutes its configured
  // datasource. Applied to alert-rule query nodes (never __expr__).
  function mapDatasources(rule) {
    const out = JSON.parse(JSON.stringify(rule));
    for (const q of out.data || []) {
      if (q.datasourceUid && q.datasourceUid !== '__expr__' && /^\$\{.*\}$/.test(q.datasourceUid)) {
        q.datasourceUid = datasourceUid;
      }
      if (q.model && q.model.datasource === undefined && q.datasourceUid !== '__expr__') {
        q.model.datasource = { type: 'prometheus', uid: q.datasourceUid };
      }
    }
    return out;
  }

  const TOOLS = {
    // The fetch-live builder requires the gateway's four core tools.
    // This Grafana has no service-topology or anomaly engine behind it,
    // so they answer honestly empty (same shapes the otel-mcp-server
    // returns when those subsystems have no data).
    async system_health() { return { services: [] }; },
    async system_topology() { return { dependencies: [] }; },
    async anomalies_active() { return {}; },
    async anomalies_baselines() { return { baselines: [] }; },

    async grafana_create_dashboard({ dashboard, folder_uid, message, mode = 'upsert', dry_run = false }) {
      if (dry_run) return { ok: true, dryRun: true };
      if (folder_uid) await ensureFolder(folder_uid);
      const r = await gf('POST', '/api/dashboards/db', {
        dashboard,
        folderUid: folder_uid || undefined,
        overwrite: mode !== 'create',
        message: message || 'observogram t4 round trip',
      });
      if (!r.ok) throw new Error(`grafana /api/dashboards/db HTTP ${r.status}: ${r.text.slice(0, 300)}`);
      return r.json;
    },

    async grafana_create_alert_rule({ rule, mode = 'upsert', dry_run = false }) {
      if (dry_run) return { ok: true, dryRun: true };
      const mapped = mapDatasources(rule);
      if (mapped.orgID === undefined) mapped.orgID = 1;
      await ensureFolder(mapped.folderUID);
      let r = await gf('POST', '/api/v1/provisioning/alert-rules', mapped);
      if (!r.ok && mode !== 'create' && (r.status === 409 || /uid already exists|conflict/i.test(r.text))) {
        r = await gf('PUT', `/api/v1/provisioning/alert-rules/${encodeURIComponent(mapped.uid)}`, mapped);
      }
      if (!r.ok) throw new Error(`grafana provisioning alert-rule '${mapped.title}' HTTP ${r.status}: ${r.text.slice(0, 300)}`);
      return r.json;
    },

    // Grafana-managed RECORDING rules live in the same provisioning
    // store; the fetch-live recording probe never tries
    // grafana_alert_rules (vmalert-first design), so the gateway exposes
    // the listing under the probe's canonical fallback name.
    async list_recording_rules() {
      const all = await TOOLS.grafana_alert_rules();
      return { rules: all.rules.filter(r => r.type === 'recording') };
    },

    async grafana_alert_rules() {
      const r = await gf('GET', '/api/v1/provisioning/alert-rules');
      if (!r.ok) throw new Error(`grafana provisioning listing HTTP ${r.status}`);
      // Flatten ProvisionedAlertRule[] into the rules shape the
      // fetch-live alert probe understands (name/expr/for/labels).
      const rules = (Array.isArray(r.json) ? r.json : []).map(pr => {
        const promQ = (pr.data || []).find(d => d.datasourceUid !== '__expr__');
        return {
          name: pr.title,
          type: pr.record ? 'recording' : 'alerting',
          ...(pr.record ? { record: pr.record.metric } : {}),
          expr: promQ?.model?.expr || '',
          for: pr.for || '5m',
          labels: pr.labels || {},
          annotations: pr.annotations || {},
        };
      });
      return { rules };
    },

    async grafana_dashboards_search({ type = 'dash-db', limit = 100 } = {}) {
      const r = await gf('GET', `/api/search?type=${encodeURIComponent(type)}&limit=${encodeURIComponent(limit)}`);
      if (!r.ok) throw new Error(`grafana /api/search HTTP ${r.status}`);
      const results = (Array.isArray(r.json) ? r.json : []).map(it => ({
        id: it.id, uid: it.uid, title: it.title, type: it.type,
        url: it.url, uri: it.uri, tags: it.tags || [],
        folderUid: it.folderUid, folderTitle: it.folderTitle,
      }));
      return { count: results.length, results };
    },

    async grafana_dashboard_get({ uid } = {}) {
      const r = await gf('GET', `/api/dashboards/uid/${encodeURIComponent(uid)}`);
      if (!r.ok) throw new Error(`grafana /api/dashboards/uid/${uid} HTTP ${r.status}`);
      return r.json;   // { meta, dashboard } — the shape the fetcher expects
    },
  };

  const srv = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch (_) { /* empty */ }
    const send = (payload, isError = false) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 't4-bridge' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: msg.id ?? 1,
        ...(isError ? { error: { code: -32000, message: payload } } : { result: payload }),
      }));
    };
    try {
      if (msg.method === 'initialize') {
        return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'observogram-t4-grafana-bridge', version: '0.1.0' } });
      }
      if (msg.method === 'notifications/initialized') return send({});
      if (msg.method === 'tools/list') {
        return send({ tools: Object.keys(TOOLS).map(name => ({ name })) });
      }
      if (msg.method === 'tools/call') {
        const name = msg.params?.name;
        const fn = TOOLS[name];
        if (!fn) return send(`unknown tool: ${name}`, true);
        const result = await fn(msg.params?.arguments || {});
        log.push({ tool: name, at: Date.now() });
        return send({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      }
      return send({});
    } catch (e) {
      return send(String(e.message || e), true);
    }
  });

  await new Promise(resolveListen => srv.listen(0, '127.0.0.1', resolveListen));
  const addr = srv.address();
  return {
    url: `http://${addr.address}:${addr.port}/mcp`,
    log,
    close: () => new Promise(resolveClose => srv.close(resolveClose)),
  };
}
