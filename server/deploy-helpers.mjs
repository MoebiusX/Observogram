// server/deploy-helpers.mjs — pure(ish) transforms behind the deploy path.
//
// Everything here is the WRITE path's shaping logic: which MCP tool a
// (product, target) deploys through, how compiled artefacts become native
// per-rule / per-dashboard tool calls, deploy-time scope filtering, and the
// pre-deploy snapshot capture. Extracted from index.mjs verbatim so the
// transforms are unit-testable (server/test-deploy-helpers.mjs) — they
// build the calls that MUTATE a live Grafana, and had no direct tests
// while they lived inline.
//
// Deploy targets are Grafana-only for now: spec §9's reference table lists
// more, but Grafana 12/13 is the version floor the spec requires and the
// only platform where rules + dashboards land through a single unified
// API. OTel Collector + standalone Alertmanager remain download-only.
//
// NOTE: the MCP tool-name literals in here ('grafana_alert_rules',
// 'grafana_dashboard_get', the GRAFANA_*_TOOL constants) are a documented
// exemption in tools/test-contract-guard.mjs — they migrate to the
// contracts registry with the resolveCapability() facade slice
// (docs/ARCHITECTURE_EVOLUTION.md §3.2).

import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { redactCredentials } from './mcp-url.mjs';
import { saveDeploySnapshot } from './workspace.mjs';

export const DEPLOY_PRODUCTS = ['grafana'];
export const DEPLOY_VERSIONS = {
  grafana: ['12', '13'],
};
export const RULES_SCOPES = ['both', 'recording', 'alerting'];
export const GRAFANA_ALERT_RULE_TOOL = 'grafana_create_alert_rule';
export const GRAFANA_DASHBOARD_TOOL = 'grafana_create_dashboard';
export const GRAFANA_FOLDER_DEFAULT = 'observability-pack';

// (product, target) → default MCP tool name. The server lets the client
// override via body.mcpTool; this dispatch supplies the convention.
export function defaultDeployTool({ product, target, scope }) {
  if (product === 'grafana') {
    if (target === 'prometheus-rules') {
      return GRAFANA_ALERT_RULE_TOOL;
    }
    if (target === 'grafana-dashboard') return GRAFANA_DASHBOARD_TOOL;
  }
  return null;   // not deployable
}

export async function discoverMcpToolNames(rpc) {
  try {
    const out = await rpc('tools/list');
    return (out?.tools || []).map(t => t?.name).filter(Boolean).sort();
  } catch (_) {
    return null;
  }
}

export function deployToolMissingError(tool, availableTools) {
  const related = (availableTools || [])
    .filter(t => /apply|deploy|create|upsert|write|provision|grafana|rule|dashboard/i.test(t))
    .slice(0, 18);
  let hint = 'Configure a Grafana write-capable MCP gateway, or add a compatible deploy adapter before retrying.';
  if (tool === GRAFANA_ALERT_RULE_TOOL) {
    hint = 'For otel-mcp-server, set MCP_ENABLE_WRITES=true, configure GRAFANA_URL and GRAFANA_AUTH_TOKEN with alert.provisioning:write on the MCP server, and pass a valid MCP client key in Observogram when MCP_AUTH_KEYS is configured.';
  } else if (tool === GRAFANA_DASHBOARD_TOOL) {
    hint = 'For otel-mcp-server, set MCP_ENABLE_WRITES=true, configure GRAFANA_URL and GRAFANA_AUTH_TOKEN with dashboards:write on the MCP server, and pass a valid MCP client key in Observogram when MCP_AUTH_KEYS is configured.';
  }
  const suffix = related.length
    ? ` Advertised related tools: ${related.join(', ')}.`
    : ' No related write-capable tools were advertised.';
  return `MCP endpoint does not expose required deploy tool '${tool}'.${suffix} ${hint}`;
}

export function targetIsDeployable(target) {
  return target === 'prometheus-rules' || target === 'grafana-dashboard';
}

// Filter a prometheus-rules YAML payload down to recording rules only or
// alerting rules only. This lives in the deploy path (not in compile)
// because the compiled output remains canonical; scope is a deploy-time
// concern.
export function filterPromRulesScope(yamlText, scope) {
  if (!scope || scope === 'both') return yamlText;
  // Parse with our mini YAML, drop rules of the other kind, re-emit.
  // We keep the comment banner the compiler put at the top.
  const headerMatch = yamlText.match(/^(\s*#[^\n]*\n)+/);
  const header = headerMatch ? headerMatch[0] : '';
  const obj = parseYaml(yamlText.replace(/^(\s*#[^\n]*\n)+/, ''));
  if (!obj?.groups) return yamlText;
  const wantKey = scope === 'recording' ? 'record' : 'alert';
  obj.groups = obj.groups
    .map(g => ({ ...g, rules: (g.rules || []).filter(r => wantKey in r) }))
    .filter(g => (g.rules || []).length > 0);
  return header + emitYaml(obj);
}

export function scopeMatchesGrafanaRule(rule, scope) {
  if (!scope || scope === 'both') return true;
  const isRecording = !!rule?.record;
  return scope === 'recording' ? isRecording : !isRecording;
}

export function normalizeGrafanaProvisioningRule(rule, group = {}, folder = '') {
  const out = { ...(rule || {}) };
  if (out.noDataState === undefined && out.no_data_state !== undefined) {
    out.noDataState = out.no_data_state;
    delete out.no_data_state;
  }
  if (out.execErrState === undefined && out.exec_err_state !== undefined) {
    out.execErrState = out.exec_err_state;
    delete out.exec_err_state;
  }
  if (out.isPaused === undefined && out.is_paused !== undefined) {
    out.isPaused = out.is_paused;
    delete out.is_paused;
  }
  if (out.folderUID === undefined) {
    out.folderUID = folder || group.folderUID || group.folderUid || group.folder || GRAFANA_FOLDER_DEFAULT;
  }
  if (out.ruleGroup === undefined) {
    out.ruleGroup = group.name || 'observability-pack';
  }
  return out;
}

export function grafanaRulesFromProvisioningYaml(yamlText, { scope = 'both', folder = '' } = {}) {
  const obj = parseYaml(String(yamlText || '').replace(/^(\s*#[^\n]*\n)+/, ''));
  const groups = Array.isArray(obj?.groups) ? obj.groups : [];
  const rules = [];
  for (const group of groups) {
    for (const rule of (Array.isArray(group?.rules) ? group.rules : [])) {
      if (!scopeMatchesGrafanaRule(rule, scope)) continue;
      rules.push(normalizeGrafanaProvisioningRule(rule, group, folder));
    }
  }
  return rules;
}

export function dashboardFromCompiledJson(jsonText) {
  const dashboard = JSON.parse(jsonText);
  if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) {
    throw new Error('compiled dashboard did not produce a Grafana dashboard object');
  }
  return dashboard;
}

export function buildNativeDeployCalls({ target, compiled, scope, folder, tool, mode = 'upsert', dryRun = false, message }) {
  if (tool === GRAFANA_ALERT_RULE_TOOL) {
    const rules = grafanaRulesFromProvisioningYaml(compiled.content, { scope, folder });
    if (!rules.length) {
      throw new Error(`no Grafana-managed ${scope && scope !== 'both' ? scope + ' ' : ''}rules found in compiled artefact`);
    }
    return rules.map(rule => ({
      tool,
      args: { rule, mode, dry_run: dryRun },
      bytes: JSON.stringify(rule).length,
      name: rule.title || rule.uid || rule.record?.metric || 'rule',
      kind: rule.record ? 'recording' : 'alerting',
    }));
  }
  if (tool === GRAFANA_DASHBOARD_TOOL) {
    const dashboard = dashboardFromCompiledJson(compiled.content);
    return [{
      tool,
      args: {
        dashboard,
        folder_uid: folder || undefined,
        message: message || undefined,
        mode,
        dry_run: dryRun,
      },
      bytes: JSON.stringify(dashboard).length,
      name: dashboard.title || dashboard.uid || compiled.filename,
      kind: 'dashboard',
    }];
  }
  return null;
}

// Deploy ids — sortable, unique-enough handles for the audit log and the
// post-deploy verify write-back. Not a secret, not a content hash.
export function newDeployId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `dep_${ts}_${Math.random().toString(36).slice(2, 6)}`;
}

// Pre-deploy snapshot capture (10D). Reads the live state of everything the
// deploy is about to touch, through the SAME MCP session that will write:
//   - dashboards: grafana_dashboard_get per uid — fully restorable later
//     (restore = upsert the captured JSON back). A read error most likely
//     means the dashboard doesn't exist yet (this deploy CREATES it), whose
//     rollback is a delete — recorded honestly, never guessed.
//   - rules: one grafana_alert_rules listing as evidence. Per-rule restore
//     is not yet automated (the listing shape isn't contractual across
//     backends), so rules roll back manually WITH receipts.
// Snapshot problems never block the deploy unless strictSnapshot is on.
export async function captureDeploySnapshot({ deployId, callTool, availableTools, items, dryRun, folder, safeMcpUrl }) {
  if (dryRun) return { status: 'skipped', itemCount: 0 };
  const meta = { deployId, at: new Date().toISOString(), mcpUrl: safeMcpUrl, folder: folder || null, items: [] };
  const files = {};
  let captured = 0, problems = 0;

  if (items.some(i => i.group === 'rules')) {
    if (availableTools && availableTools.includes('grafana_alert_rules')) {
      try {
        files['alert-rules'] = await callTool('grafana_alert_rules', {});
        meta.items.push({ ref: 'rules', kind: 'rules-listing', preState: 'captured', file: 'alert-rules', restore: 'manual' });
        captured++;
      } catch (e) {
        meta.items.push({ ref: 'rules', kind: 'rules-listing', preState: 'error', error: redactCredentials(String(e.message)), restore: 'manual' });
        problems++;
      }
    } else {
      meta.items.push({ ref: 'rules', kind: 'rules-listing', preState: 'unavailable', restore: 'manual' });
      problems++;
    }
  }

  for (const item of items.filter(i => i.group === 'dashboards' && i.dashboardId)) {
    const uid = String(item.dashboardId);
    if (!(availableTools && availableTools.includes('grafana_dashboard_get'))) {
      meta.items.push({ ref: uid, kind: 'dashboard', preState: 'unavailable', restore: 'manual' });
      problems++;
      continue;
    }
    try {
      files[`dashboard-${uid}`] = await callTool('grafana_dashboard_get', { uid, include_json: true });
      meta.items.push({ ref: uid, kind: 'dashboard', preState: 'captured', file: `dashboard-${uid}`, restore: 'redeploy' });
      captured++;
    } catch (e) {
      // A create, not a capture failure: rollback of a create is a delete.
      meta.items.push({ ref: uid, kind: 'dashboard', preState: 'absent', error: redactCredentials(String(e.message)), restore: 'delete' });
    }
  }

  meta.status = meta.items.length === 0 ? 'empty'
    : problems === 0 ? 'captured'
    : captured > 0 ? 'partial'
    : 'unavailable';
  try { saveDeploySnapshot(deployId, meta, files); }
  catch (e) {
    meta.status = 'failed';
    process.stderr.write(`[deploy-bulk]   snapshot write failed: ${e.message}\n`);
  }
  return { status: meta.status, itemCount: meta.items.length };
}
