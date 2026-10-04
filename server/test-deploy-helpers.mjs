#!/usr/bin/env node
/**
 * server/test-deploy-helpers.mjs
 *
 * Unit tests for the deploy-path transforms (server/deploy-helpers.mjs).
 * These functions build the calls that MUTATE a live Grafana — per-rule
 * provisioning payloads, dashboard upserts, deploy-time scope filtering —
 * and had no direct tests while they lived inline in index.mjs. The
 * snapshot capture's write path stays covered by the smoke/live suites;
 * this file pins the pure shaping logic.
 */

import { parse as parseYaml } from '../tools/lib/mini-yaml.mjs';
import { createHarness } from '../tools/lib/harness.mjs';

// Hermetic (§0): the children's STRIP list, both spellings, before any server
// module loads (serve-child.mjs imports no server code; the import below is
// dynamic so it runs after). server/test-hermetic-suites.mjs guards the shape.
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
const {
  DEPLOY_PRODUCTS, DEPLOY_VERSIONS, RULES_SCOPES,
  GRAFANA_ALERT_RULE_TOOL, GRAFANA_DASHBOARD_TOOL, GRAFANA_FOLDER_DEFAULT,
  defaultDeployTool, deployToolMissingError, targetIsDeployable,
  filterPromRulesScope, scopeMatchesGrafanaRule, normalizeGrafanaProvisioningRule,
  grafanaRulesFromProvisioningYaml, dashboardFromCompiledJson,
  buildNativeDeployCalls, newDeployId, captureDeploySnapshot, deployAuditRow,
} = await import('./deploy-helpers.mjs');

const { assert, report } = createHarness({ indent: '  ', truncate: 160 });

// ---------- dispatch ----------
assert(defaultDeployTool({ product: 'grafana', target: 'prometheus-rules' }) === GRAFANA_ALERT_RULE_TOOL,
  'grafana + prometheus-rules dispatches to the alert-rule tool');
assert(defaultDeployTool({ product: 'grafana', target: 'grafana-dashboard' }) === GRAFANA_DASHBOARD_TOOL,
  'grafana + grafana-dashboard dispatches to the dashboard tool');
assert(defaultDeployTool({ product: 'grafana', target: 'otel-collector' }) === null,
  'non-deployable target dispatches to null');
assert(defaultDeployTool({ product: 'prometheus', target: 'prometheus-rules' }) === null,
  'unknown product dispatches to null');
assert(targetIsDeployable('prometheus-rules') && targetIsDeployable('grafana-dashboard')
  && !targetIsDeployable('otel-collector') && !targetIsDeployable('alertmanager'),
  'targetIsDeployable matches the deploy matrix');
assert(DEPLOY_PRODUCTS.includes('grafana') && DEPLOY_VERSIONS.grafana.length === 2 && RULES_SCOPES.length === 3,
  'deploy constants exported intact');

// ---------- operator-facing missing-tool error ----------
const missing = deployToolMissingError(GRAFANA_ALERT_RULE_TOOL, ['grafana_dashboards_search', 'metrics_query', 'grafana_create_dashboard']);
assert(missing.includes(GRAFANA_ALERT_RULE_TOOL), 'missing-tool error names the tool');
assert(missing.includes('grafana_create_dashboard') && !missing.includes('metrics_query'),
  'missing-tool error lists only write-related advertised tools');
assert(missing.includes('MCP_ENABLE_WRITES'), 'missing-tool error carries the otel-mcp-server hint');
assert(deployToolMissingError('some_tool', []).includes('No related write-capable tools'),
  'missing-tool error says so when nothing related is advertised');

// ---------- deploy ids ----------
const id1 = newDeployId(), id2 = newDeployId();
assert(/^dep_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[a-z0-9]{4}$/.test(id1), 'deploy id is sortable dep_<ts>_<rand>', id1);
assert(id1 !== id2, 'deploy ids are unique across calls');

// ---------- prometheus-rules scope filtering ----------
const PROM_RULES = `# Pack: payments · version 1.0.0
# target prometheus-rules
groups:
  - name: slo
    rules:
      - record: payments:availability:good
        expr: sum(rate(http_requests_total{code!~"5.."}[5m]))
      - alert: PaymentsBurnFast
        expr: payments:availability:good < 0.99
        for: 5m
`;
assert(filterPromRulesScope(PROM_RULES, 'both') === PROM_RULES, "scope 'both' returns the payload untouched");
const recOnly = filterPromRulesScope(PROM_RULES, 'recording');
assert(recOnly.startsWith('# Pack: payments'), 'compiler banner survives scope filtering');
const recObj = parseYaml(recOnly.replace(/^(\s*#[^\n]*\n)+/, ''));
assert(recObj.groups.length === 1 && recObj.groups[0].rules.length === 1 && recObj.groups[0].rules[0].record,
  "scope 'recording' keeps only record rules");
const altObj = parseYaml(filterPromRulesScope(PROM_RULES, 'alerting').replace(/^(\s*#[^\n]*\n)+/, ''));
assert(altObj.groups[0].rules.length === 1 && altObj.groups[0].rules[0].alert,
  "scope 'alerting' keeps only alert rules");
assert(filterPromRulesScope('key: value\n', 'recording') === 'key: value\n',
  'payload without groups passes through unchanged');

// ---------- Grafana provisioning normalisation ----------
assert(scopeMatchesGrafanaRule({ record: { metric: 'x' } }, 'recording') &&
  !scopeMatchesGrafanaRule({ record: { metric: 'x' } }, 'alerting') &&
  scopeMatchesGrafanaRule({ title: 'A' }, 'alerting'),
  'scopeMatchesGrafanaRule keys on the record field');

const norm = normalizeGrafanaProvisioningRule(
  { title: 'Burn', no_data_state: 'OK', exec_err_state: 'Error', is_paused: false },
  { name: 'slo-group' }, '');
assert(norm.noDataState === 'OK' && norm.no_data_state === undefined, 'no_data_state → noDataState');
assert(norm.execErrState === 'Error' && norm.exec_err_state === undefined, 'exec_err_state → execErrState');
assert(norm.isPaused === false && norm.is_paused === undefined, 'is_paused → isPaused');
assert(norm.folderUID === GRAFANA_FOLDER_DEFAULT, 'folderUID defaults to the pack folder');
assert(norm.ruleGroup === 'slo-group', 'ruleGroup defaults to the group name');
assert(normalizeGrafanaProvisioningRule({}, { folderUid: 'g-folder' }, 'explicit').folderUID === 'explicit',
  'explicit folder wins over the group folder');
assert(normalizeGrafanaProvisioningRule({ noDataState: 'Alerting', no_data_state: 'OK' }, {}, '').noDataState === 'Alerting',
  'camelCase value already present is never overwritten');

const GMA_YAML = `# banner
groups:
  - name: payments-slo
    folderUid: payments
    rules:
      - title: PaymentsBurnFast
        uid: pburn
        no_data_state: OK
      - record:
          metric: payments_availability_good
        title: rec-rule
`;
const allRules = grafanaRulesFromProvisioningYaml(GMA_YAML);
assert(allRules.length === 2, 'provisioning YAML yields every rule for scope both');
assert(allRules[0].folderUID === 'payments' && allRules[0].ruleGroup === 'payments-slo',
  'group folder + name flow into each rule');
assert(grafanaRulesFromProvisioningYaml(GMA_YAML, { scope: 'alerting' }).length === 1 &&
  grafanaRulesFromProvisioningYaml(GMA_YAML, { scope: 'recording' }).length === 1,
  'scope filtering splits recording vs alerting');
assert(grafanaRulesFromProvisioningYaml('').length === 0, 'empty payload yields no rules');

// ---------- dashboard JSON gate ----------
assert(dashboardFromCompiledJson('{"title":"Ops","uid":"ops"}').title === 'Ops', 'valid dashboard JSON parses');
for (const bad of ['[1,2]', '"str"', '42']) {
  let threw = false;
  try { dashboardFromCompiledJson(bad); } catch { threw = true; }
  assert(threw, `non-object dashboard JSON throws: ${bad}`);
}

// ---------- native deploy call building ----------
const ruleCalls = buildNativeDeployCalls({
  target: 'prometheus-rules', compiled: { content: GMA_YAML, filename: 'x.yaml' },
  scope: 'both', folder: '', tool: GRAFANA_ALERT_RULE_TOOL, dryRun: true,
});
assert(ruleCalls.length === 2, 'alert-rule tool gets one call per rule');
assert(ruleCalls.every(c => c.tool === GRAFANA_ALERT_RULE_TOOL && c.args.dry_run === true && c.args.mode === 'upsert' && c.bytes > 0),
  'rule calls carry tool, mode, dry_run and a byte count');
assert(ruleCalls[0].kind === 'alerting' && ruleCalls[1].kind === 'recording',
  'rule calls are tagged recording/alerting by the record field');
assert(ruleCalls[0].name === 'PaymentsBurnFast', 'rule call name prefers the title');

let emptyThrew = false;
try {
  buildNativeDeployCalls({ target: 'prometheus-rules', compiled: { content: 'groups: []\n' }, scope: 'recording', tool: GRAFANA_ALERT_RULE_TOOL });
} catch (e) { emptyThrew = /no Grafana-managed recording rules/.test(e.message); }
assert(emptyThrew, 'zero rules after scope filtering throws with the scope named');

const dashCalls = buildNativeDeployCalls({
  target: 'grafana-dashboard', compiled: { content: '{"title":"Ops","uid":"ops"}', filename: 'ops.json' },
  folder: 'payments', tool: GRAFANA_DASHBOARD_TOOL, message: 'deploy ops',
});
assert(dashCalls.length === 1 && dashCalls[0].kind === 'dashboard', 'dashboard tool gets exactly one call');
assert(dashCalls[0].args.folder_uid === 'payments' && dashCalls[0].args.message === 'deploy ops' && dashCalls[0].args.dry_run === false,
  'dashboard call carries folder_uid, message and dry_run default');
assert(buildNativeDeployCalls({ target: 'x', compiled: { content: '' }, tool: 'unknown_tool' }) === null,
  'unknown tool yields null (caller falls back to generic deploy)');

// ---------- snapshot: the only behaviour safe to pin without a workspace ----------
const snap = await captureDeploySnapshot({ deployId: 'dep_test', callTool: null, availableTools: null, items: [], dryRun: true });
assert(snap.status === 'skipped' && snap.itemCount === 0, 'dry-run deploys skip snapshot capture');

// ---------- the audit row of a deploys.jsonl record (STORE_PLAN slice 5) ----------
// Counts and the MCP origin, never the URL, an item's error or a tool name;
// the action is the caller's; every request text is bounded; fileError and
// manual only when given.
const bulkRecord = {
  deployId: 'dep_2026-10-04T09-12-33_k2x9', at: '2026-10-04T09:12:33.000Z', actor: 'ada',
  pack: { id: 'payment-service', version: '1.5.0', contentHash: 'abcdef12' },
  env: 'prod', mcpUrl: 'https://user:pw@mcp.acme.test:8443/mcp/x?token=sekrit',
  target: { product: 'grafana', version: '12', folder: 'observability-pack' },
  mode: 'upsert', dryRun: false, snapshot: { status: 'captured', items: 2 },
  items: [
    { group: 'rules', ok: true, tool: 'grafana_create_alert_rule', operations: 2, bytes: 100, tookMs: 10 },
    { group: 'dashboards', ok: false, tool: 'grafana_create_dashboard', error: 'dashboard write refused: /mcp/x said no', tookMs: 5 },
  ],
  summary: { total: 2, ok: 1, failed: 1 }, tookMs: 1830,
};
const bulkRow = deployAuditRow(bulkRecord, { action: 'deploy.bulk', mcpEndpoint: { id: 3, name: 'prod-grafana' } });
assert(JSON.stringify(bulkRow) === JSON.stringify({
  action: 'deploy.bulk', targetKind: 'deploy', targetId: 'dep_2026-10-04T09-12-33_k2x9',
  detail: {
    pack: { id: 'payment-service', version: '1.5.0' }, env: 'prod',
    target: { product: 'grafana', version: '12', folder: 'observability-pack' }, mode: 'upsert', dryRun: false,
    origin: 'https://mcp.acme.test:8443', mcpEndpoint: { id: 3, name: 'prod-grafana' }, snapshot: 'captured',
    items: 2, ok: 1, failed: 1, tookMs: 1830,
  },
}), 'deploy.bulk row: the exact shape — counts, the snapshot status, the origin, the endpoint record', bulkRow);
const bulkText = JSON.stringify(bulkRow.detail);
assert(!/\/mcp\//.test(bulkText) && !bulkText.includes('sekrit') && !bulkText.includes('user:pw'), 'the row never carries the URL\'s path, query or userinfo', bulkText);
assert(!bulkText.includes('said no') && !bulkText.includes('contentHash') && !('items' in bulkRow.detail && Array.isArray(bulkRow.detail.items)),
  'the row never carries an item\'s error text, the content hash or the items array', bulkText);
assert(!bulkText.includes('grafana_create'), 'the row never carries a tool name', bulkText);
assert(!('fileError' in bulkRow.detail) && !('manual' in bulkRow.detail), 'fileError and manual are absent keys on a normal deploy row');

const singleRow = deployAuditRow({ ...bulkRecord, snapshot: undefined, items: [bulkRecord.items[1]], mcpUrl: null }, { action: 'deploy.run' });
assert(singleRow.action === 'deploy.run' && !('snapshot' in singleRow.detail) && singleRow.detail.origin === null && singleRow.detail.mcpEndpoint === null,
  'deploy.run row: the action as passed, no snapshot key, origin null for a null mcpUrl, mcpEndpoint null by default', singleRow);
assert(singleRow.detail.items === 1 && singleRow.detail.ok === 0 && singleRow.detail.failed === 1, 'deploy.run row counts the one failed item', singleRow.detail);
assert(deployAuditRow({ ...bulkRecord, items: [bulkRecord.items[0]] }, { action: 'deploy.bulk' }).action === 'deploy.bulk',
  'a one-item bulk deploy is a deploy.bulk: the shape never decides the action');

const rollbackRow = deployAuditRow({
  deployId: 'dep_2026-10-04T09-20-09_q7mm', rollbackOf: 'dep_2026-10-04T09-12-33_k2x9', pack: { id: 'payment-service', version: '1.5.0' },
  env: 'prod', mcpUrl: 'https://mcp.acme.test/mcp', target: bulkRecord.target, mode: 'rollback', dryRun: false,
  items: [{ artifact: 'payment-overview', group: 'restore', ok: true, tookMs: 600 }], summary: { total: 1, ok: 1, failed: 0 }, tookMs: 640,
}, { action: 'deploy.rollback', manual: 1 });
assert(JSON.stringify(rollbackRow) === JSON.stringify({
  action: 'deploy.rollback', targetKind: 'deploy', targetId: 'dep_2026-10-04T09-20-09_q7mm',
  detail: {
    rollbackOf: 'dep_2026-10-04T09-12-33_k2x9', pack: { id: 'payment-service', version: '1.5.0' }, env: 'prod', dryRun: false,
    origin: 'https://mcp.acme.test', mcpEndpoint: null, items: 1, ok: 1, failed: 0, manual: 1, tookMs: 640,
  },
}), 'deploy.rollback row: rollbackOf, the pack, the counts and the manual steps; its own deployId as the target', rollbackRow);
assert(deployAuditRow({ deployId: 'dep_x', rollbackOf: 'dep_y', pack: null, items: [], tookMs: 0 }, { action: 'deploy.rollback' }).detail.pack === null,
  'a rollback of a record without a pack: pack null');

const flagged = deployAuditRow(bulkRecord, { action: 'deploy.bulk', fileError: true });
assert(flagged.detail.fileError === true, 'fileError: true only when the caller says the line is missing');
assert(!('fileError' in deployAuditRow(bulkRecord, { action: 'deploy.bulk', fileError: false }).detail), 'fileError: false is an absent key');

const huge = 'x'.repeat(1024 * 1024);
const boundedRow = deployAuditRow({ ...bulkRecord, env: huge, target: { ...bulkRecord.target, folder: huge } }, { action: 'deploy.bulk' });
assert(boundedRow.detail.env.length === 200 && boundedRow.detail.target.folder.length === 200 && JSON.stringify(boundedRow.detail).length < 8192,
  'a 1 MB env and folder are cut to 200 characters; the detail stays under the repository\'s 8 KB bound', JSON.stringify(boundedRow.detail).length);

let badAction = false;
try { deployAuditRow(bulkRecord, { action: 'deploy.nope' }); } catch (e) { badAction = /deploy\.run, deploy\.bulk or deploy\.rollback/.test(e.message); }
assert(badAction, 'an action the table does not name throws');

report('deploy-helpers', 'the write-path transforms shape rules, dashboards and scopes exactly as deployed.');
