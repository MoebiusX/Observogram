#!/usr/bin/env node
/**
 * server/test-live-studio.mjs — the MCP panel's "test connection" in
 * headless Chromium (rebadge batch 3, C2): the real studio against a child
 * identity server and a fake MCP on loopback, driven as oscar (an operator)
 * of acme.
 *
 * The panel is "Live MCP connection". Its #mcp-refresh-btn — the id a habit
 * or a script clicks as a connectivity check — now pings: one
 * POST /api/mcp/ping with the picker's endpoint id, NO POST
 * /api/refresh-live, and /api/live-status unchanged (no live pack appears).
 * The status line (role=status, aria-live) announces the verdict as a word,
 * the result block shows the server's sentence, the timings, the read's
 * outcome, what the MCP offers that a fetch reads and the families it does
 * not, and a "What this did not check" disclosure. The button works from
 * the keyboard. A change of the auth field clears the result. oscar sees no
 * URL row (C0: the server refuses him a typed URL). A tool name and a
 * read's answer carrying markup create no element (textContent only).
 * #mcp-rebuild-btn is the separate, explicit action: it issues the refresh,
 * and only then does the live pack exist. No page error and no
 * console.error; nothing leaves the loopback.
 *
 * Skipped unless Playwright imports (OBSERVOGRAM_PLAYWRIGHT, else the bare
 * 'playwright') and Chromium launches; OBSERVOGRAM_LIVE_SMOKE=require fails
 * instead.
 */
/* global document, window */

// The two knobs are read before the strip (STRIP carries both so no child
// sees them); the rest of the shell never reaches this process's imports.
const PLAYWRIGHT = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
const REQUIRED = process.env.OBSERVOGRAM_LIVE_SMOKE === 'require';
const { STRIP, serve, signIn } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { startFakeMcp, endpointIdFor } = await import('./fixtures/fake-mcp.mjs');
const { capabilityTool } = await import('../tools/lib/contracts/mcp-capabilities.mjs');

const password = (login) => `${login}-passw0rd-live`;
const LOGINS = ['ada', 'oscar'];
const SYSTEM = capabilityTool('system_health');
const TOPOLOGY = capabilityTool('system_topology');
const HEALTH = capabilityTool('grafana_version');
const HOSTILE_TOOL = '<img src=x onerror="window.__pwned=1">';
const HOSTILE_VERSION = '<img src=y onerror="window.__pwned=2">';
const T = 20_000;

async function loadPlaywright() {
  try { return { pw: await import(PLAYWRIGHT) }; }
  catch (e) { return { error: `cannot import ${PLAYWRIGHT}: ${e.message.split('\n')[0]}` }; }
}

test('BROWSER: the MCP panel tests the connection without rewriting production-live; rebuilding it is its own action', async (t) => {
  const skip = (why) => { if (REQUIRED) assert.fail(`OBSERVOGRAM_LIVE_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());

  const ws = mkdtempSync(join(tmpdir(), 'observogram-live-studio-'));
  writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(password(l)) }])) }, join(ws, 'users.json'));
  writeOrgsFile({
    default: { name: 'Default', members: { ada: 'admin' } },
    acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator' } },
  }, join(ws, 'orgs.json'));
  const fake = await startFakeMcp([SYSTEM, TOPOLOGY, HEALTH, HOSTILE_TOOL], (name) => (name === HEALTH ? { version: HOSTILE_VERSION } : { ok: true, name }));
  const child = await serve(ws);
  t.after(async () => { await child.stop(); await fake.close(); rmSync(ws, { recursive: true, force: true }); });

  const cookies = {};
  for (const l of LOGINS) {
    const s = await signIn(child.base, l, password(l));
    assert.equal(s.status, 200, `${l} signs in`);
    cookies[l] = s.session;
  }
  const acme = (login) => ({ Cookie: cookies[login], 'X-Observogram-Org': 'acme' });
  // ada registers the loopback fake (token-less) as acme's endpoint.
  const gwId = await endpointIdFor(child.base, fake.url, { name: 'gw', headers: acme('ada') });
  const liveStatus = async () => (await (await fetch(`${child.base}/api/live-status`, { headers: acme('oscar') })).json());

  const problems = [];
  const offLoopback = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
  await ctx.addCookies([{ name: 'observogram_session', value: cookies.oscar.split('=')[1], url: child.base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource: /.test(m.text())) problems.push(`console.error: ${m.text()}`); });
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith(child.base)) return route.fallback();
    offLoopback.push(route.request().url());
    return route.abort();
  });
  const posts = (re) => { const list = []; page.on('request', (r) => { if (re.test(r.url()) && r.method() === 'POST') list.push(JSON.parse(r.postData() || 'null')); }); return list; };
  const pings = posts(/\/api\/mcp\/ping$/);
  const refreshes = posts(/\/api\/refresh-live$/);
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel);

  await page.goto(`${child.base}/`);
  await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
  assert.equal((await liveStatus()).present, false, 'no live pack before');

  // The panel: its title, the picker list-only for an operator (C0), the two actions.
  await page.evaluate(() => document.getElementById('mcp-btn').click());
  await page.waitForSelector('#mcp-panel:not([hidden]) [data-mcp-target="refresh"] select', { timeout: T });
  assert.equal(await text('#mcp-panel-title'), 'Live MCP connection');
  assert.equal(await text('#mcp-refresh-btn'), 'test connection');
  assert.equal(await text('#mcp-rebuild-btn'), 'rebuild production-live');
  assert.equal(await text('#mcp-rebuild-note'), 'Rebuilds the live pack the LIVE badge reads — every inventory family is read again (usually about 1–1.5 minutes); it writes an audit row.');
  assert.equal(await page.evaluate(() => document.getElementById('mcp-url').closest('label').hidden), true, 'no URL row for an operator');
  assert.deepEqual(await page.evaluate(() => ['role', 'aria-live'].map((a) => document.getElementById('mcp-ping-status').getAttribute(a))), ['status', 'polite']);

  // test connection, from the keyboard: the ping, never the refresh.
  await page.focus('#mcp-refresh-btn');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /^connected · \d+ ms$/.test(document.getElementById('mcp-ping-status')?.textContent || ''), null, { timeout: T });
  assert.deepEqual(pings, [{ mcpEndpointId: gwId }], 'one ping, by the endpoint id');
  assert.deepEqual(refreshes, [], 'no refresh-live');
  assert.equal(await page.evaluate(() => document.getElementById('mcp-ping-status').classList.contains('is-ok')), true);
  assert.equal(await page.isVisible('#mcp-ping-result'), true);
  assert.equal(await text('#mcp-ping-result .mcpc-sentence'),
    `Connected to ${fake.origin} in ${(await text('#mcp-ping-status')).match(/(\d+) ms/)[1]} ms: the MCP answered initialize, listed 4 tools (3 that a fetch reads), and ${HEALTH} answered without a token — but ${HEALTH} answers without backend credentials, so whether the MCP's own credentials to its backend work was not checked.`);
  assert.match(await text('#mcp-ping-result'), /Not offered by this MCP: metric names, recording rules, alert rules, dashboards, scrape targets, alerting routes/);
  assert.equal(await text('#mcp-ping-result .mcpc-unchecked-summary'), 'What this did not check');
  // The read's answer and the unmatched tool name carried markup: neither became an element.
  assert.equal(await page.evaluate(() => document.querySelectorAll('#mcp-panel img').length), 0, 'no element from an MCP string');
  assert.equal(await page.evaluate(() => window.__pwned ?? null), null);
  assert.ok((await text('#mcp-ping-result')).includes(`${HEALTH}: version ${HOSTILE_VERSION}`), 'the read\'s outcome shown as text');
  assert.ok(!(await text('#mcp-ping-result')).includes('onerror="window.__pwned=1"'), 'an unmatched tool name never reaches the page');
  const after = await liveStatus();
  assert.equal(after.present, false, 'the ping wrote no live pack');

  // Any change to the auth field clears the result: a result never describes another target.
  await page.evaluate(() => { const a = document.getElementById('mcp-auth'); a.closest('label').hidden = false; });
  await page.fill('#mcp-auth', 'k');
  assert.equal(await page.isHidden('#mcp-ping-result'), true, 'the result is cleared');
  assert.equal(await text('#mcp-ping-status'), '');
  await page.fill('#mcp-auth', '');

  // rebuild production-live: the explicit action — the refresh, and the live pack.
  await page.click('#mcp-rebuild-btn');
  await page.waitForFunction(() => /^refreshed · /.test(document.getElementById('mcp-rebuild-status')?.textContent || ''), null, { timeout: 60_000 });
  assert.deepEqual(refreshes, [{ mcpEndpointId: gwId }], 'one refresh, by the endpoint id');
  assert.equal(pings.length, 1, 'the rebuild sent no ping');
  assert.equal((await liveStatus()).present, true, 'the rebuild wrote the live pack');

  await ctx.close();
  assert.deepEqual(problems, [], 'no page error and no console.error');
  assert.deepEqual(offLoopback.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u)), [], 'nothing but fonts was asked of another origin, and those were aborted');
});
