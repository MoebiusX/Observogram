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
//   npm run demo -- --port 8020 --workspace .observogram-demo-board
//                                     # a second demo beside the first (its own workspace)
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
// --port N / --workspace DIR on the command line win over the environment,
// so a second demo can run beside the first on its own workspace.
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
};
const PORT = Number(argOf('--port') || process.env.PORT || 8010);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  process.stderr.write(`[demo] --port / PORT must be a port number, not ${JSON.stringify(argOf('--port') || process.env.PORT)}\n`);
  process.exit(2);
}
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const WORKSPACE = resolve(ROOT, argOf('--workspace') || process.env.OBSERVOGRAM_WORKSPACE || '.observogram-demo');
// The address to open: it forces the Overview face, the board layout and the
// dark theme, and the browser remembers all three — a profile that last saw
// Expert, or the simple layout, opens here too.
const DEMO_URL = `${BASE}/?mode=overview&theme=dark&layout=board`;
const SIMPLE_URL = `${BASE}/?mode=overview&theme=dark&layout=simple`;
// A check older than this at start is run again, so the page opens on
// "Checked a few minutes ago" and the first Check in the room meets a warm
// endpoint (a cold one answers its first probes in 20–30 s and loses families).
const WARM_AFTER_MS = Number(process.env.OBSERVOGRAM_DEMO_WARM_AFTER_MIN || 10) * 60_000;

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
  const bySource = (label) => before.find((p) => p.label === label || p.source === label || p.id === label);

  // 1. The repository pack (Pack A). The catalogue names it by the pack's
  //    own name, not by the upload's source label, so a second start finds
  //    it as the service's non-live pack.
  let repo = bySource(DEMO.repoLabel) || before.find((p) => !p.live && p.service === DEMO.service && p.name === DEMO.service);
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
    await runJourney('first check');
    return;
  }
  log(`journey ${DEMO.journey} last ran ${j.lastRun.startedAt} (${j.lastRun.outcome})`);

  // 5. Warm the live side and refresh "last checked" when the newest run is
  //    older than WARM_AFTER_MS; once more when that run lost more than one
  //    probe family (a cold endpoint). A 502 means the live side did not
  //    answer at all: the server kept a vantage-lost record, Overview reads
  //    Unreachable, and the morning pre-flight decides which beat it is.
  if (process.env.OBSERVOGRAM_DEMO_NO_WARM) { log('warm check skipped (OBSERVOGRAM_DEMO_NO_WARM)'); return; }
  const age = Date.now() - Date.parse(j.lastRun.startedAt);
  if (!(age > WARM_AFTER_MS)) { log(`last check is ${Math.round(age / 60000)} min old — fresh enough, no warm check`); return; }
  // Once more when the run lost more than one probe family, or saw less of
  // the live side than the check before (Overview then reads "showed less
  // than the check before" and asks for another check — better done here).
  const rec = await runJourney('warm check');
  if (rec && ((rec.probes?.failed?.length || 0) > 1 || newlyFailed(rec).length)) await runJourney('warm check again (the first saw less of the live side than the check before)');
}

// The probe families this run lost that the check before could read — the
// record's causes.vantage, as Overview reads it (studio/overview-model.mjs
// vantageShrank); none when the check before saw nothing at all.
function newlyFailed(rec) {
  const v = rec?.causes?.vantage;
  if (!v?.changed || v.from?.vantage === 'lost') return [];
  const before = Array.isArray(v.from?.failed) ? v.from.failed : [];
  return (Array.isArray(v.to?.failed) ? v.to.failed : []).filter((f) => !before.includes(f));
}

// POST the journey's run; log the record's headline; null when the live
// side did not answer (the route answers 502 after keeping the record).
async function runJourney(why) {
  log(`${why}: running the journey ${DEMO.journey}…`);
  try {
    const r = await json(`/api/journeys/${encodeURIComponent(DEMO.journey)}/run`, { method: 'POST' });
    const rec = r.record || {};
    const failed = rec.probes?.failed || [];
    log(`${why}: ${rec.outcome || '?'} · grade ${rec.grade?.letter || '?'} (${rec.grade?.score ?? '?'}%) · alignment ${rec.drift?.alignmentPct ?? '?'}% · ${rec.tookMs ?? '?'} ms${failed.length ? ` · probe families failed: ${failed.join(', ')}` : ''}`);
    return rec;
  } catch (e) {
    if (e.status === 502) { log(`${why}: the live side did not answer (${e.message.slice(0, 300)}) — Overview reads Unreachable until a check succeeds; press Check again on the page in a minute, or start again`); return null; }
    throw e;
  }
}

seed().then(() => {
  log(`ready — open ${DEMO_URL}`);
  log(`the three sentences alone (the fallback layout): ${SIMPLE_URL}`);
}).catch((e) => {
  process.stderr.write(`[demo] seed failed: ${e.message}\n[demo] the studio keeps running on ${DEMO_URL}; fix the cause and start again.\n`);
});
