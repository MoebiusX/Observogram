#!/usr/bin/env node
// tools/demo-studio.mjs
//
// One command for the demo: start the studio in the open posture on its own
// workspace, then seed that workspace once with the maintainer's real
// service — the repository pack (the crawl under examples/) as Pack A, a
// live draft from the public MCP as Pack B, and a saved journey between the
// two whose runs are what Overview reads as "last checked". A second start
// finds everything in place and seeds nothing.
//
//   npm run demo                      # http://127.0.0.1:8010
//   PORT=8000 npm run demo
//   OBSERVOGRAM_DEMO_SKIP_LIVE=1 …    # seed the repository pack only (no MCP)
//
// The server is a child process with the environment this file sets; the
// seed is a client of its HTTP API (the same calls the studio makes), so
// nothing here reaches into the store. Secrets: none — the public MCP needs
// no token; a private one takes OBSERVOGRAM_DEMO_MCP_URL plus the endpoint's
// readTokenEnv the way Settings → MCP endpoints does.

import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8010);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WORKSPACE = resolve(ROOT, process.env.OBSERVOGRAM_WORKSPACE || '.observogram-demo');

const DEMO = {
  service: 'krystaline',
  repoPack: resolve(ROOT, 'examples/krystaline-repo-carlos.pack.yaml'),
  repoLabel: 'krystaline-repo',
  liveLabel: 'krystaline-live',
  mcpName: 'krystaline-public',
  mcpUrl: process.env.OBSERVOGRAM_DEMO_MCP_URL || 'https://www.krystaline.io/mcp/public',
  journey: 'krystaline',
  env: 'prod',
};

const log = (m) => process.stdout.write(`[demo] ${m}\n`);

// ---------- the server ----------

mkdirSync(WORKSPACE, { recursive: true });
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST,
  OBSERVOGRAM_AUTH: process.env.OBSERVOGRAM_AUTH || 'off',
  OBSERVOGRAM_WORKSPACE: WORKSPACE,
  // The public MCP's origin must be listed for the open posture to draft
  // from it (server/mcp-target-policy.mjs); a loopback MCP needs nothing.
  OBSERVOGRAM_MCP_ORIGINS: [process.env.OBSERVOGRAM_MCP_ORIGINS, new URL(DEMO.mcpUrl).origin].filter(Boolean).join(','),
};
const server = spawn(process.execPath, [resolve(ROOT, 'server/index.mjs')], { env, stdio: 'inherit', cwd: ROOT });
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.kill(sig); });

// ---------- the seed ----------

const headers = (extra = {}) => ({ 'X-Observogram-CSRF': '1', Accept: 'application/json', ...extra });

async function json(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers(init.headers) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, error: text.slice(0, 300) }; }
  if (!res.ok || body?.ok === false) {
    const e = new Error(`${init.method || 'GET'} ${path} → ${res.status}: ${body?.error || text.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

async function waitForServer(deadlineMs = 30000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try { const r = await fetch(`${BASE}/healthz`); if (r.ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the studio did not answer on ${BASE} within ${deadlineMs / 1000}s`);
}

async function registeredPacks() {
  const r = await json('/api/packs');
  return Array.isArray(r.packs) ? r.packs : [];
}

async function seed() {
  await waitForServer();
  const before = await registeredPacks();
  const bySource = (label) => before.find((p) => p.label === label || p.source === label || p.id === label || String(p.id).includes(label));

  // 1. The repository pack (Pack A).
  let repo = bySource(DEMO.repoLabel);
  if (!repo) {
    const body = readFileSync(DEMO.repoPack, 'utf8');
    const r = await json(`/api/validate?source=${encodeURIComponent(DEMO.repoLabel)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-yaml' }, body,
    });
    repo = r.registered || null;
    if (!repo?.id) throw new Error(`the repository pack did not register: ${JSON.stringify(r).slice(0, 300)}`);
    log(`registered the repository pack as ${repo.id}`);
  } else log(`repository pack already registered (${repo.id})`);

  if (process.env.OBSERVOGRAM_DEMO_SKIP_LIVE) { log('live side skipped (OBSERVOGRAM_DEMO_SKIP_LIVE)'); return; }

  // 2. The MCP endpoint, registered under the org (the open posture refuses
  //    a typed URL; a registered endpoint on a listed origin is accepted).
  const eps = (await json('/api/mcp-endpoints')).endpoints || [];
  let ep = eps.find((e) => e.name === DEMO.mcpName || e.url === DEMO.mcpUrl);
  if (!ep) {
    ep = (await json('/api/mcp-endpoints', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DEMO.mcpName, url: DEMO.mcpUrl }),
    })).endpoint;
    log(`registered the MCP endpoint ${ep.name} (#${ep.id})`);
  } else log(`MCP endpoint already registered (${ep.name} #${ep.id})`);

  // 3. The live draft (Pack B). A cold public endpoint answers its first
  //    probes slowly and several families time out ("fetch failed"), which
  //    would make the registered live pack a poorer picture than the journey's
  //    own draft seconds later: draft again, once, when more than one probe
  //    family failed — the second draft replaces the first under the same label.
  let live = bySource(DEMO.liveLabel);
  if (!live || process.env.OBSERVOGRAM_DEMO_REDRAFT) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      log(`drafting the live pack from ${ep.name}${attempt > 1 ? ' again (the first draft lost probe families on a cold endpoint)' : ''}…`);
      const r = await json('/api/draft-from-mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mcpEndpointId: ep.id, label: DEMO.liveLabel, packName: DEMO.service }),
      });
      live = r.registered || null;
      if (!live?.id) throw new Error(`the live draft did not register: ${JSON.stringify(r).slice(0, 300)}`);
      const ann = r.canonical?.metadata?.annotations || {};
      const failed = String(ann['mcp.probesFailed'] || '').split(',').filter(Boolean);
      log(`registered the live draft as ${live.id} (refreshed ${ann['mcp.refreshedAt'] || '?'}, ${r.tookMs ?? '?'} ms${failed.length ? `, probe families failed: ${failed.join(', ')}` : ''})`);
      if (failed.length <= 1) break;
    }
  } else log(`live draft already registered (${live.id})`);

  // 4. The journey between the two, and its first run.
  const journeys = (await json('/api/journeys')).journeys || [];
  let j = journeys.find((x) => x.name === DEMO.journey);
  if (!j) {
    await json('/api/journeys/capture', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: DEMO.journey, packAId: repo.id, packBId: live.id }),
    });
    log(`captured the journey ${DEMO.journey} (A ${repo.id} · B ${live.id})`);
    j = { name: DEMO.journey, lastRun: null };
  }
  if (!j.lastRun) {
    const r = await json(`/api/journeys/${encodeURIComponent(DEMO.journey)}/run`, { method: 'POST' });
    const rec = r.record || {};
    log(`ran the journey: ${rec.outcome || '?'} · grade ${rec.grade?.letter || '?'} (${rec.grade?.score ?? '?'}%) · alignment ${rec.drift?.alignmentPct ?? '?'}%`);
  } else log(`journey ${DEMO.journey} last ran ${j.lastRun.startedAt} (${j.lastRun.outcome})`);
}

seed().then(() => log(`ready — open ${BASE}`)).catch((e) => {
  process.stderr.write(`[demo] seed failed: ${e.message}\n[demo] the studio keeps running on ${BASE}; fix the cause and start again.\n`);
});
