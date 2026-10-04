#!/usr/bin/env node
/**
 * server/test-transport-hook.mjs
 *
 * The MCP transport hook on the studio server (docs/MCP_INTEGRATION.md
 * "Transport hook"): OBSERVOGRAM_TRANSPORT_HOOK loads once at start(), a hook
 * that cannot load refuses the boot, a header hook reaches every MCP call the
 * routes make (refresh-live, draft-from-mcp, deploy-bulk), a hook that breaks
 * its contract is one 502 with nothing written (no live pack, no deploy or
 * rollback record), and a child started without the variable never inherits the
 * parent's (serve-child STRIP). Every server is a child with an explicit env.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boot, serve } from './fixtures/serve-child.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'observogram-transport-hook-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const workspace = () => { const ws = join(TMP, `ws-${++n}`); return ws; };
const hookFile = (name, source) => { const p = join(TMP, name); writeFileSync(p, source); return p; };

const TOKEN = { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' };
const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer tok-0123456789' };
const post = (base, path, body) => fetch(`${base}${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });

// A fake MCP in this process that records every request's headers.
async function startFakeMcp(toolNames) {
  const requests = [];
  const srv = createServer(async (req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    for await (const chunk of req) raw += chunk;
    let msg = {};
    try { msg = JSON.parse(raw || '{}'); } catch { /* not JSON */ }
    requests.push({ path: req.url, headers: { ...req.headers }, method: msg.method, name: msg.params?.name });
    const send = (result) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'hook-test-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }));
    };
    if (msg.method === 'initialize') return send({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-mcp' } });
    if (msg.method === 'tools/list') return send({ tools: toolNames.map(name => ({ name })) });
    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const answer = name === 'system_health' ? { services: [] } : name === 'system_topology' ? { dependencies: [] } : { ok: true, name };
      return send({ content: [{ type: 'text', text: JSON.stringify(answer) }] });
    }
    send({});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  return { url: `http://${addr.address}:${addr.port}/mcp`, requests, close: () => new Promise(r => srv.close(r)) };
}
const TOOLS = ['system_health', 'system_topology', 'anomalies_active', 'anomalies_baselines',
  'grafana_create_alert_rule', 'grafana_create_dashboard', 'grafana_alert_rules', 'grafana_dashboard_get'];
const BULK_BODY = (mcpUrl) => ({
  mcpUrl, targetProduct: 'grafana', targetVersion: '12', targetFolder: 'observability-pack',
  items: [
    { group: 'rules', flavor: 'prometheus', artifact: 'declared:0', scope: 'recording' },
    { group: 'dashboards', flavor: 'grafana', dashboardId: 'payment-overview' },
  ],
});
const deployRecords = (ws) => (existsSync(join(ws, 'deploys.jsonl')) ? readFileSync(join(ws, 'deploys.jsonl'), 'utf8').split('\n').filter(Boolean) : []);

test('a hook that cannot load refuses the start, naming the variable and the path only', () => {
  const ws = workspace();
  const r = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TRANSPORT_HOOK: '/nonexistent/hook.mjs' } });
  assert.equal(r.listening, false, 'the boot is refused');
  assert.match(r.message, /^OBSERVOGRAM_TRANSPORT_HOOK: cannot load \/nonexistent\/hook\.mjs: /);
  assert.ok(!/authorization|bearer/i.test(r.message + r.stderr), 'no header is mentioned');
  assert.ok(!existsSync(join(ws, 'live')), 'nothing was written');
  const legacy = boot(ws, { env: { ...TOKEN, TOMOGRAPH_TRANSPORT_HOOK: '/nonexistent/hook.mjs' } });
  assert.equal(legacy.listening, false, 'the legacy spelling is read too');
  assert.match(legacy.message, /^OBSERVOGRAM_TRANSPORT_HOOK: cannot load/);
  const noExports = hookFile('no-exports.mjs', 'export const x = 1;\n');
  const empty = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TRANSPORT_HOOK: noExports } });
  assert.equal(empty.message, `OBSERVOGRAM_TRANSPORT_HOOK: ${noExports} exports neither prepareRequest nor fetchImpl`);
});

test('a loaded hook is logged once at start (path only) and a silent boot prints nothing', () => {
  const ws = workspace();
  const identity = hookFile('identity.mjs', 'export const prepareRequest = (r) => r;\n');
  const loud = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TRANSPORT_HOOK: identity }, silent: false });
  assert.equal(loud.listening, true);
  const lines = loud.stdout.split('\n').filter(l => l.includes('transport hook'));
  assert.deepEqual(lines, [`[studio] MCP transport hook: OBSERVOGRAM_TRANSPORT_HOOK=${identity} (prepareRequest: yes, fetchImpl: no)`]);
  assert.ok(!loud.stderr.includes('transport hook'), 'the loader itself writes nothing to stderr');
  const quiet = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TRANSPORT_HOOK: identity } });
  assert.equal(quiet.listening, true);
  assert.ok(!quiet.stdout.includes('transport hook') && !quiet.stderr.includes('transport hook'), 'silent: true prints no hook line');
});

test('a header hook reaches every MCP call of refresh-live, draft-from-mcp and deploy-bulk', async () => {
  const ws = workspace();
  const gateway = hookFile('gateway.mjs', 'export function prepareRequest({ url, headers }) { return { url, headers: { ...headers, "X-Gateway": "studio" } }; }\n');
  const fake = await startFakeMcp(TOOLS);
  const s = await serve(ws, { env: { ...TOKEN, OBSERVOGRAM_TRANSPORT_HOOK: gateway } });
  try {
    const refresh = await post(s.base, '/api/refresh-live', { mcpUrl: fake.url });
    assert.equal(refresh.status, 200, `refresh-live: ${await refresh.text()}`);
    assert.ok(fake.requests.length > 0 && fake.requests.every(r => r.headers['x-gateway'] === 'studio'), 'refresh-live: every request carries X-Gateway');
    assert.ok(existsSync(join(ws, 'live', 'production-live.pack.yaml')), 'the live pack was written');
    fake.requests.length = 0;
    const draft = await post(s.base, '/api/draft-from-mcp', { mcpUrl: fake.url, mcpAuth: 'draft-tok' });
    assert.equal(draft.status, 200);
    assert.ok(fake.requests.length > 0 && fake.requests.every(r => r.headers['x-gateway'] === 'studio' && r.headers.authorization === 'Bearer draft-tok'),
      'draft-from-mcp: every request carries X-Gateway and the caller\'s bearer');
    fake.requests.length = 0;
    const bulk = await post(s.base, '/api/packs/payment-service/deploy-bulk', BULK_BODY(fake.url));
    const bulkText = await bulk.text();
    assert.equal(bulk.status, 200, `deploy-bulk: ${bulkText}`);
    const body = JSON.parse(bulkText);
    assert.equal(body.summary?.ok, 2, 'both artefacts deployed');
    assert.ok(fake.requests.length > 0 && fake.requests.every(r => r.headers['x-gateway'] === 'studio'), 'deploy-bulk: every request (snapshot reads and writes) carries X-Gateway');
    assert.equal(deployRecords(ws).length, 1, 'one deploy record');
  } finally {
    await s.stop();
    await fake.close();
  }
});

test('a hook that breaks its contract at call time: one 502 naming the hook, no live pack, no deploy record', async () => {
  const ws = workspace();
  const throwing = hookFile('throwing.mjs', 'export function prepareRequest({ headers }) { throw new Error(`gateway refused ${headers.Authorization}`); }\n');
  const fake = await startFakeMcp(TOOLS);
  // One real deploy first (an identity hook), so the rollback route has a
  // record and a snapshot to work from; the throwing child must add nothing.
  const identity = hookFile('identity-seed.mjs', 'export const prepareRequest = (r) => r;\n');
  let seeded;
  let before;
  let s;
  try {
    const seed = await serve(ws, { env: { ...TOKEN, OBSERVOGRAM_TRANSPORT_HOOK: identity } });
    try {
      const r = await post(seed.base, '/api/packs/payment-service/deploy-bulk', BULK_BODY(fake.url));
      const text = await r.text();
      assert.equal(r.status, 200, `seed deploy: ${text}`);
      seeded = JSON.parse(text).deployId;
    } finally { await seed.stop(); }
    before = deployRecords(ws);
    assert.equal(before.length, 1, 'one seeded deploy record');
    fake.requests.length = 0;
    s = await serve(ws, { env: { ...TOKEN, OBSERVOGRAM_TRANSPORT_HOOK: throwing } });
    const refresh = await post(s.base, '/api/refresh-live', { mcpUrl: fake.url, mcpAuth: 'secret-bearer-1' });
    assert.equal(refresh.status, 502);
    const rj = await refresh.json();
    assert.equal(rj.error, `transport hook ${throwing}: prepareRequest threw: gateway refused Bearer <redacted>`);
    assert.ok(!JSON.stringify(rj).includes('secret-bearer-1'), 'the bearer is redacted');
    assert.ok(!existsSync(join(ws, 'live', 'production-live.pack.yaml')), 'no live pack written');

    const draft = await post(s.base, '/api/draft-from-mcp', { mcpUrl: fake.url });
    assert.equal(draft.status, 502);
    assert.match((await draft.json()).error, /transport hook .*prepareRequest threw/);

    const bulk = await post(s.base, '/api/packs/payment-service/deploy-bulk', BULK_BODY(fake.url));
    assert.equal(bulk.status, 502, 'deploy-bulk: one 502, not N item failures');
    const bj = await bulk.json();
    assert.equal(bj.ok, false);
    assert.match(bj.error, /transport hook .*prepareRequest threw/);
    assert.equal(bj.results, undefined, 'no per-item results');
    assert.deepEqual(deployRecords(ws), before, 'no deploy record for a deploy that never reached the wire');

    const single = await post(s.base, '/api/packs/payment-service/deploy/grafana-dashboard', { mcpUrl: fake.url, dashboardId: 'payment-overview' });
    assert.equal(single.status, 502);
    assert.match((await single.json()).error, /transport hook .*prepareRequest threw/);
    assert.deepEqual(deployRecords(ws), before, 'the single deploy route audits nothing either');

    const rollback = await post(s.base, `/api/deploys/${seeded}/rollback`, { mcpUrl: fake.url });
    assert.equal(rollback.status, 502, 'rollback: one 502');
    const rbj = await rollback.json();
    assert.equal(rbj.ok, false);
    assert.match(rbj.error, /transport hook .*prepareRequest threw/);
    assert.equal(rbj.results, undefined, 'rollback: no per-item results');
    assert.deepEqual(deployRecords(ws), before, 'rollback: no audit record for a rollback that never reached the wire');
    assert.equal(fake.requests.length, 0, 'nothing reached the fake');
  } finally {
    if (s) await s.stop();
    await fake.close();
  }
});

test('a child started without the variable never inherits the parent\'s hook (serve-child STRIP)', async () => {
  const ws = workspace();
  const gateway = hookFile('leak.mjs', 'export function prepareRequest({ url, headers }) { return { url, headers: { ...headers, "X-Gateway": "leaked" } }; }\n');
  process.env.OBSERVOGRAM_TRANSPORT_HOOK = gateway;
  process.env.TOMOGRAPH_TRANSPORT_HOOK = gateway;
  const fake = await startFakeMcp(TOOLS);
  let s;
  try {
    s = await serve(ws, { env: TOKEN });
    const refresh = await post(s.base, '/api/refresh-live', { mcpUrl: fake.url });
    assert.equal(refresh.status, 200);
    assert.ok(fake.requests.length > 0 && fake.requests.every(r => r.headers['x-gateway'] === undefined), 'no request carries the parent\'s header');
  } finally {
    delete process.env.OBSERVOGRAM_TRANSPORT_HOOK;
    delete process.env.TOMOGRAPH_TRANSPORT_HOOK;
    if (s) await s.stop();
    await fake.close();
  }
});
