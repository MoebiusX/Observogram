#!/usr/bin/env node
/**
 * server/test-mcp-settings-studio.mjs — the MCP panel's Server settings
 * modal in headless Chromium (rebadge batch 4, D1/D2): the real studio
 * against a child identity server and fake MCP servers with their settings
 * surface (server/fixtures/fake-mcp.mjs `admin`), on loopback, driven as ada
 * (an admin) and oscar (an operator).
 *
 *   1. Discovery → configure → outcome → the connection test: every input
 *      empty at open, nothing asked at boot or when the panel opens; the
 *      secrets emptied once sent, the checks listed, the read answered; the
 *      fake saw a descriptor GET with no credential and a configure from the
 *      studio's origin with no cookie, no X-Observogram-* and the API key as
 *      the descriptor's Bearer.
 *   2. No description (404) and a JSON-RPC 200: the generic form, named, its
 *      path and names editable, the API key in the body.
 *   3. Failure: a 401 shown verbatim; a secret the server echoes (raw,
 *      JSON-escaped, Basic) shown as <redacted> and counted; nothing left in
 *      the DOM, storage or the studio's log.
 *   4. The disable action, the SPEC's descriptor as written: what it sends,
 *      the key typed, the connection test then reading "the read failed";
 *      a confirm text asks for a second click.
 *   5. A served settings policy refuses the send until this build applies it.
 *   6. Target refusals: a typed ftp:// URL, an unlisted remote origin, plain
 *      http, the studio's own origin — no request to anyone.
 *   7. The gate: oscar's button is aria-disabled with the reason and opens
 *      nothing; ada with no target, then enabled when an endpoint is picked.
 *   8. CORS and redirects: no CORS → unreachable naming this page's origin;
 *      a redirected description; a 401 without CORS and a held answer →
 *      unknown and "Test the connection"; a 307 configure → the redirect line,
 *      and the redirect's target received nothing.
 *   9. Keyboard and nesting: Esc, the scrim, esc, Try again and Use the
 *      generic form close or repaint the modal and leave the panel open; Tab
 *      stays inside; the focus returns; Escape on <body> after a repaint
 *      closes only the modal.
 *  10. Markup is text: every descriptor slot, a refused endpoint, the
 *      outcome's message and checks and the raw body carry markup; no
 *      element is made and nothing runs.
 *
 * Every test asserts no page error, no console.error beyond a failed load
 * (and, where CORS is the point, the browser's CORS message), no popup, and
 * that the page asked nothing of any origin but the studio's and the fakes'.
 *
 * Skipped unless Playwright imports (OBSERVOGRAM_PLAYWRIGHT, else the bare
 * 'playwright') and Chromium launches; OBSERVOGRAM_MCP_SETTINGS_SMOKE=require
 * fails instead.
 */
/* global document, window */

// The two knobs are read before the strip (STRIP carries both so no child sees them).
const PLAYWRIGHT = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
const REQUIRED = process.env.OBSERVOGRAM_MCP_SETTINGS_SMOKE === 'require';
const { STRIP, serve, signIn } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];

const { test, before, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { startFakeMcp, endpointIdFor, EXAMPLE_SETTINGS_DESCRIPTOR, ADMIN_MARKUP } = await import('./fixtures/fake-mcp.mjs');
const { capabilityTool } = await import('../tools/lib/contracts/mcp-capabilities.mjs');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = join(ROOT, 'tools', 'fixtures', 'mcp-settings', 'policy.json');
const password = (login) => `${login}-passw0rd-mss`;
const LOGINS = ['ada', 'oscar'];
const READ_TOOL = capabilityTool('grafana_version');
const T = 20_000;
const BEARER = Object.freeze({ ...EXAMPLE_SETTINGS_DESCRIPTOR, auth: { field: 'apiKey', scheme: 'bearer' } });
const SECRET = `S3cr3t-${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 10)}`;
const API_KEY = `k3y-${Math.random().toString(36).slice(2, 12)}`;

async function loadPlaywright() {
  try { return { pw: await import(PLAYWRIGHT) }; }
  catch (e) { return { error: `cannot import ${PLAYWRIGHT}: ${e.message.split('\n')[0]}` }; }
}

// ---------- the shared studio: one child, one browser ----------

const env = { browser: null, why: null, ws: null, child: null, cookies: {}, fakes: [] };

async function startChild(extraEnv = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-mss-'));
  writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(password(l)) }])) }, join(ws, 'users.json'));
  writeOrgsFile({ default: { name: 'Default', members: { ada: 'admin', oscar: 'operator' } } }, join(ws, 'orgs.json'));
  const child = await serve(ws, { env: extraEnv });
  const cookies = {};
  for (const l of LOGINS) {
    const s = await signIn(child.base, l, password(l));
    assert.equal(s.status, 200, `${l} signs in`);
    cookies[l] = s.session;
  }
  return { ws, child, cookies, stop: async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); } };
}

before(async () => {
  const { pw, error } = await loadPlaywright();
  if (!pw) { env.why = error; return; }
  try { env.browser = await pw.chromium.launch(); }
  catch (e) { env.why = `chromium.launch failed: ${e.message.split('\n')[0]}`; return; }
  env.studio = await startChild();
});

after(async () => {
  for (const f of env.fakes) await f.close();
  await env.studio?.stop();
  await env.browser?.close();
});

function skipUnlessBrowser(t) {
  if (env.browser) return false;
  if (REQUIRED) assert.fail(`OBSERVOGRAM_MCP_SETTINGS_SMOKE=require: ${env.why}`);
  t.skip(env.why);
  return true;
}

async function fake(admin, tools = [READ_TOOL]) {
  const f = await startFakeMcp(tools, () => ({ version: '12.4.4' }), { admin });
  env.fakes.push(f);
  return f;
}

// A signed-in page with its watchers: problems (page errors, console errors
// beyond a failed load, popups), requests (every one, with headers and body),
// and anything asked of an origin that is not the studio's or a fake's.
async function openPage(studio, login, { cors = false } = {}) {
  const ctx = await env.browser.newContext({ viewport: { width: 1366, height: 860 } });
  await ctx.addCookies([{ name: 'observogram_session', value: studio.cookies[login].split('=')[1], url: studio.child.base }]);
  const page = await ctx.newPage();
  page.setDefaultTimeout(T);
  const w = { ctx, page, problems: [], requests: [], elsewhere: [] };
  page.on('pageerror', (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on('popup', (p) => w.problems.push(`popup: ${p.url()}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/^Failed to load resource: /.test(text)) return;
    if (cors && /has been blocked by CORS policy/.test(text)) return;
    w.problems.push(`console.error: ${text}`);
  });
  // Watched, not routed: a routed page has its CORS preflights answered by the driver, and the fake must see them.
  page.on('request', (r) => {
    const url = r.url();
    w.requests.push({ url, method: r.method(), headers: r.headers(), postData: r.postData() });
    const allowed = [studio.child.base, ...env.fakes.flatMap((f) => [f.origin, f.sink?.origin].filter(Boolean))];
    if (!allowed.some((o) => url.startsWith(o)) && !url.startsWith('data:')) w.elsewhere.push(url);
  });
  await page.goto(`${studio.child.base}/`);
  await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
  w.text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel);
  w.status = () => w.text('#mss-status');
  w.waitStatus = (re, timeout = T) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('mss-status')?.textContent || ''), re.source, { timeout });
  w.done = async () => {
    assert.equal(new URL(page.url()).origin, studio.child.base, 'never navigated away from the studio');
    await ctx.close();
    assert.deepEqual(w.problems, [], 'no page error, no console.error, no popup');
    assert.deepEqual(w.elsewhere.filter((u) => !/fonts\.(googleapis|gstatic)\.com/.test(u)), [], 'nothing asked of another origin but the stylesheet\'s fonts');
  };
  return w;
}

async function openPanel(w) {
  // The chrome's button may be off screen on the home: clicked as a script would.
  if (await w.page.evaluate(() => document.getElementById('mcp-panel').hidden)) await w.page.evaluate(() => document.getElementById('mcp-btn').click());
  await w.page.waitForSelector('#mcp-panel:not([hidden])', { timeout: T });
}

// Aim the panel at a typed URL (an admin may type one), or at endpoint `id`.
async function aim(w, { url = null, id = null }) {
  await openPanel(w);
  const select = '#mcp-panel [data-mcp-target="refresh"] select';
  // The picker is drawn once the org's endpoints are read (none: the URL row alone).
  await w.page.waitForFunction(() => document.getElementById('mcp-settings-btn')?.dataset.why !== 'Checking whether you may configure the MCP server…', null, { timeout: T });
  if (id !== null) await w.page.selectOption(select, String(id));
  else {
    if (await w.page.isVisible(select)) await w.page.selectOption(select, '');
    await w.page.fill('#mcp-url', url);
  }
  await w.page.waitForFunction(() => document.getElementById('mcp-settings-btn')?.getAttribute('aria-disabled') !== 'true', null, { timeout: T });
}

async function openSettings(w) {
  await w.page.click('#mcp-settings-btn');
  await w.page.waitForSelector('#mss-host .mss', { timeout: T });
}

async function closeSettings(w) {
  await w.page.click('#mss-host .mss-close');
  await w.page.waitForFunction(() => !document.querySelector('#mss-host .mss'), null, { timeout: T });
}

const fill = async (w, name, value) => w.page.fill(`#mss-host input[data-field="${name}"]`, value);
const values = (w) => w.page.evaluate(() => [...document.querySelectorAll('#mss-host input')].map((i) => (i.type === 'checkbox' || i.type === 'radio' ? null : i.value)).filter((v) => v !== null && v !== ''));
const hostHtml = (w) => w.page.evaluate(() => document.getElementById('mss-host')?.outerHTML ?? '');

// ---------- 1 ----------

test('BROWSER 1: discovery → configure → the outcome → the connection test; nothing at boot, empty inputs, secrets emptied once sent, only the studio\'s origin and no session sent to the MCP', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const f = await fake({ descriptor: BEARER, cors: studio.child.base, requireKey: { key: API_KEY, in: 'header' } });
  const gwId = await endpointIdFor(studio.child.base, f.url, { name: 'gw-1', headers: { Cookie: studio.cookies.ada } });
  const w = await openPage(studio, 'ada');
  await openPanel(w);
  await w.page.waitForSelector('#mcp-panel [data-mcp-target="refresh"] select', { timeout: T });
  await w.page.selectOption('#mcp-panel [data-mcp-target="refresh"] select', String(gwId));
  assert.deepEqual(await w.page.evaluate(() => ['aria-haspopup', 'aria-disabled'].map((a) => document.getElementById('mcp-settings-btn').getAttribute(a))), ['dialog', null]);
  assert.equal(await w.text('#mcp-settings-btn'), 'Server settings…');
  // Nothing asked at boot or when the panel opened.
  assert.deepEqual(w.requests.filter((r) => /\/api\/mcp-settings/.test(r.url) || r.url.startsWith(f.origin)), [], 'no settings request before the click');
  assert.equal(f.adminRequests.length, 0);

  await openSettings(w);
  await w.waitStatus(/^The server describes its settings \(version 1\)\.$/);
  assert.equal(await w.text('.mss-eyebrow'), `MCP server · ${f.origin}`);
  assert.equal(await w.text('.mss-lede'), `These settings go to the MCP server itself — your browser sends them directly to ${f.origin}. The studio keeps none of them.`);
  assert.deepEqual(await w.page.evaluate(() => { const d = document.querySelector('#mss-host .mss'); return [d.getAttribute('role'), d.getAttribute('aria-modal'), d.getAttribute('aria-labelledby'), document.getElementById('mss-host') === document.body.lastElementChild]; }), ['dialog', 'true', 'mss-title', true]);
  assert.deepEqual(await values(w), [], 'every input is empty at open');
  assert.deepEqual(await w.page.evaluate(() => [...document.querySelectorAll('#mss-host input[data-field]')].map((i) => [i.dataset.field, i.type, i.getAttribute('autocomplete'), i.hasAttribute('name'), i.hasAttribute('data-1p-ignore')])), [
    ['grafanaUrl', 'url', 'off', false, true], ['user', 'text', 'off', false, true], ['secret', 'password', 'new-password', false, true], ['apiKey', 'password', 'new-password', false, true],
  ]);
  assert.equal(await w.page.evaluate(() => document.querySelectorAll('#mss-host form').length), 0, 'no <form>');
  assert.equal(await w.page.evaluate(() => document.activeElement?.dataset?.field), 'grafanaUrl', 'the focus is on the first field');
  // The required field blocks the send, and says so.
  assert.equal(await w.page.getAttribute('.mss-primary', 'aria-disabled'), 'true');
  await w.page.click('.mss-primary', { force: true });
  assert.equal(await w.status(), 'Fill in Backend base URL — the server requires it.');

  await fill(w, 'grafanaUrl', 'HTTPS://Backend.EXAMPLE/grafana');
  await fill(w, 'user', 'svc-observogram');
  await fill(w, 'secret', SECRET);
  await fill(w, 'apiKey', API_KEY);
  assert.equal(await w.page.getAttribute('.mss-primary', 'aria-disabled'), null);
  await w.page.click('.mss-primary', { force: true });
  await w.waitStatus(/Connection test:/);
  assert.equal(await w.status(), `The server reports the settings verified (HTTP 200). Connection test: connected, and the read ${READ_TOOL} answered: ${(await w.status()).split(`${READ_TOOL} answered: `)[1]}`);
  assert.match(await w.status(), new RegExp(`connected, and the read ${READ_TOOL} answered: `));
  assert.match(await w.text('#mcp-ping-status'), /^connected · \d+ ms$/);
  // While the modal is still open: the secrets are gone from the inputs and the DOM.
  assert.deepEqual(await w.page.evaluate(() => [...document.querySelectorAll('#mss-host input[type="password"]')].map((i) => i.value)), ['', '']);
  const html = await hostHtml(w);
  assert.ok(!html.includes(SECRET) && !html.includes(API_KEY), 'no secret in the modal\'s DOM');
  assert.equal(await w.page.inputValue('#mss-host input[data-field="user"]'), 'svc-observogram', 'a non-secret input keeps its value');
  assert.equal(await w.text('.mss-outcome-message'), 'Settings applied.');
  assert.deepEqual(await w.page.evaluate(() => [...document.querySelectorAll('.mss-check')].map((li) => [li.querySelector('.mss-check-label').textContent, li.querySelector('.mss-check-status').textContent])), [['Identity', 'pass'], ['Toolset', 'pass']]);
  assert.equal(await w.page.isVisible('.mss-more-btn[data-mss="openLive"]'), true, 'Open the live panel is offered');

  // What the fake saw.
  const [schema, ...rest] = f.adminRequests;
  assert.equal(`${schema.method} ${schema.path}`, 'GET /admin/schema');
  assert.equal(schema.headers.authorization, undefined, 'the descriptor GET carries no credential');
  assert.equal(schema.headers.cookie, undefined);
  assert.deepEqual(rest.map((r) => `${r.method} ${r.path}`), ['OPTIONS /configure', 'POST /configure']);
  const post = rest[1];
  assert.equal(post.origin, studio.child.base, 'sent from the studio\'s page');
  assert.equal(post.headers.cookie, undefined, 'no cookie');
  assert.deepEqual(Object.keys(post.headers).filter((h) => /^x-observogram/i.test(h)), [], 'no X-Observogram-* header');
  assert.equal(post.headers.authorization, `Bearer ${API_KEY}`, 'the API key as the descriptor\'s Bearer');
  assert.deepEqual(post.body, { grafanaUrl: 'https://backend.example/grafana', user: 'svc-observogram', secret: SECRET }, 'the URL normalised, the key out of the body');
  // The studio was asked only GET /api/mcp-settings and the ping; neither carried a value.
  const toStudio = w.requests.filter((r) => r.url.startsWith(studio.child.base) && /\/api\/(mcp-settings|mcp\/ping)/.test(r.url));
  assert.deepEqual(toStudio.map((r) => `${r.method} ${r.url.slice(studio.child.base.length)}`), ['GET /api/mcp-settings', 'POST /api/mcp/ping']);
  for (const r of w.requests.filter((x) => x.url.startsWith(studio.child.base))) {
    assert.ok(!JSON.stringify(r).includes(SECRET) && !JSON.stringify(r).includes(API_KEY), `no secret in ${r.method} ${r.url}`);
  }

  // Close: the focus returns to the button, the panel stays open, the inputs are gone.
  await closeSettings(w);
  assert.equal(await w.page.evaluate(() => document.activeElement?.id), 'mcp-settings-btn');
  assert.equal(await w.page.isVisible('#mcp-panel'), true);
  const kept = await w.page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie, document.documentElement.outerHTML]));
  assert.ok(!kept.includes(SECRET) && !kept.includes(API_KEY), 'nothing kept in storage, cookies or the page');
  await w.done();
});

// ---------- 2 ----------

test('BROWSER 2: no description (404) and a JSON-RPC answer give the generic form, named; its path and names are editable and the API key goes in the body', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const f = await fake({ descriptor: null, cors: studio.child.base, requireKey: { key: API_KEY, in: 'body', field: 'apiKey' } });
  const w = await openPage(studio, 'ada');
  await aim(w, { url: f.url });
  await openSettings(w);
  await w.waitStatus(/^This server publishes no settings description/);
  assert.equal(await w.status(), "This server publishes no settings description (GET /admin/schema answered 404). This is a generic form: check the field names and the path against the server's documentation.");
  assert.deepEqual(await w.page.evaluate(() => [...document.querySelectorAll('#mss-host input[data-field]')].map((i) => i.dataset.field)), ['url', 'user', 'secret', 'apiKey']);
  assert.equal(await w.text('.mss-generic-summary'), 'What the server expects');
  await w.page.click('.mss-generic-summary');
  assert.equal(await w.page.inputValue('input[data-generic="path"]'), '/configure');
  // A bad name is named and blocks the send; fixing it rebinds the field.
  await w.page.fill('input[data-generic="url"]', 'user');
  assert.match(await w.text('.mss-generic-why'), /the field name "user" is used twice/);
  assert.equal(await w.page.getAttribute('.mss-primary', 'aria-disabled'), 'true');
  await w.page.fill('input[data-generic="url"]', 'grafanaUrl');
  assert.equal(await w.text('.mss-generic-why'), '');
  assert.deepEqual(await w.page.evaluate(() => [...document.querySelectorAll('#mss-host input[data-field]')].map((i) => i.dataset.field)), ['grafanaUrl', 'user', 'secret', 'apiKey']);
  await fill(w, 'grafanaUrl', 'https://backend.example/');
  await fill(w, 'secret', SECRET);
  await fill(w, 'apiKey', API_KEY);
  await w.page.click('.mss-primary', { force: true });
  await w.waitStatus(/Connection test:/);
  const post = f.adminRequests.find((r) => r.method === 'POST');
  assert.equal(post.path, '/configure');
  assert.deepEqual(post.body, { grafanaUrl: 'https://backend.example/', secret: SECRET, apiKey: API_KEY }, 'every field in the body, by the names typed');
  assert.equal(post.headers.authorization, undefined);
  await closeSettings(w);

  const rpc = await fake({ descriptor: 'jsonrpc', cors: studio.child.base });
  await aim(w, { url: rpc.url });
  await openSettings(w);
  await w.waitStatus(/^This server publishes no settings description/);
  assert.match(await w.status(), /\(what it answered is not a settings description: a JSON-RPC message\)/);
  await closeSettings(w);
  await w.done();
});

// ---------- 3 ----------

test('BROWSER 3: a refusal is shown verbatim; a secret the server echoes back — raw, JSON-escaped, as Basic credentials — is hidden and counted; nothing stays in the DOM, storage or the log', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const w = await openPage(studio, 'ada');
  const wrong = await fake({ descriptor: BEARER, cors: studio.child.base, requireKey: { key: API_KEY, in: 'header' } });
  await aim(w, { url: wrong.url });
  await openSettings(w);
  await w.waitStatus(/describes its settings/);
  await fill(w, 'grafanaUrl', 'https://backend.example/');
  await fill(w, 'secret', SECRET);
  await fill(w, 'apiKey', 'not-the-key');
  await w.page.click('.mss-primary', { force: true });
  await w.waitStatus(/^The server refused the settings: HTTP 401\.$/);
  assert.equal(await w.text('.mss-outcome-message'), 'the server API key is missing or wrong');
  assert.equal(await w.page.evaluate(() => document.querySelector('.mss-raw').open), true, 'the body is open on a refusal');
  assert.equal(await w.text('.mss-raw-body'), JSON.stringify({ ok: false, message: 'the server API key is missing or wrong' }, null, 2).replace(/\s+/g, ' '));
  assert.equal(await w.page.isVisible('.mss-more-btn[data-mss="openLive"]'), false, 'no connection test after a refusal');
  await closeSettings(w);

  for (const mode of ['raw', 'json-escaped', 'base64-basic']) {
    const echo = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base, echoSecret: mode });
    await aim(w, { url: echo.url });
    await openSettings(w);
    await w.waitStatus(/describes its settings/);
    await fill(w, 'grafanaUrl', 'https://backend.example/');
    await fill(w, 'user', 'svc');
    await fill(w, 'secret', `${SECRET}/é"`);
    await w.page.click('.mss-primary', { force: true });
    await w.waitStatus(/^The server refused the settings: HTTP 40[01]\.$/);
    const shown = await w.text('.mss-outcome');
    assert.ok(shown.includes('<redacted>'), `${mode}: the echo is hidden`);
    assert.ok(!shown.includes(SECRET), `${mode}: the secret is not shown`);
    assert.equal(await w.text('.mss-outcome-note'), '1 value the server echoed back was hidden.', mode);
    assert.ok(!(await hostHtml(w)).includes(SECRET), `${mode}: not in the DOM`);
    await closeSettings(w);
  }
  const kept = await w.page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie, document.documentElement.outerHTML]));
  assert.ok(!kept.includes(SECRET), 'nothing kept in storage, cookies or the page');
  const { stdout, stderr } = studio.child.logs();
  assert.ok(!(stdout + stderr).includes(SECRET), 'the studio server printed no secret');
  await w.done();
});

// ---------- 4 ----------

test('BROWSER 4: the disable action, the SPEC descriptor as written — what it sends, the key typed, then the connection test reads "the read failed"; a confirm asks for a second click', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const f = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base, requireKey: { key: API_KEY, in: 'body', field: 'apiKey' } });
  const w = await openPage(studio, 'ada');
  await aim(w, { url: f.url });
  await openSettings(w);
  await w.waitStatus(/describes its settings/);
  assert.equal(await w.text('.mss-action'), 'Clear server credential');
  assert.equal(await w.text('.mss-action-note'), 'Sends: nothing but the action — Password / token and Server API key are empty, so a server that needs them will refuse; type them above.');
  // Configure first: the read answers.
  await fill(w, 'grafanaUrl', 'https://backend.example/');
  await fill(w, 'secret', SECRET);
  await fill(w, 'apiKey', API_KEY);
  assert.equal(await w.text('.mss-action-note'), 'Sends: Password / token and Server API key.');
  await w.page.click('.mss-primary', { force: true });
  await w.waitStatus(/connected, and the read .* answered/);
  assert.equal(f.adminConfigured(), true);
  // The key again (the send emptied it), then the action.
  await fill(w, 'apiKey', API_KEY);
  assert.equal(await w.text('.mss-action-note'), 'Sends: Server API key. Password / token is empty, so a server that needs it will refuse; type it above.');
  await w.page.click('.mss-action[data-action="disable"]');
  await w.waitStatus(/^The server reports the settings verified \(HTTP 200\)\.$/);
  assert.deepEqual(f.adminRequests.filter((r) => r.method === 'POST').at(-1).body, { action: 'disable', apiKey: API_KEY });
  assert.equal(f.adminConfigured(), false);
  assert.equal(await w.text('.mss-outcome-message'), 'The server forgot the backend credential.');
  assert.equal(await w.page.inputValue('#mss-host input[data-field="apiKey"]'), '', 'emptied once sent');
  await w.page.click('.mss-more-btn[data-mss="test"]');
  await w.waitStatus(/Connection test:/);
  assert.match(await w.status(), /^The server reports the settings verified \(HTTP 200\)\. Connection test: connected, but the read failed: \S+ answered with an error\.$/);
  await closeSettings(w);

  const confirm = await fake({ descriptor: { ...EXAMPLE_SETTINGS_DESCRIPTOR, actions: [{ name: 'disable', label: 'Clear server credential', confirm: 'The server forgets the backend credential.' }] }, cors: studio.child.base });
  await aim(w, { url: confirm.url });
  await openSettings(w);
  await w.waitStatus(/describes its settings/);
  await w.page.click('.mss-action');
  assert.equal(await w.text('.mss-action'), 'Confirm: Clear server credential');
  assert.equal(await w.text('.mss-action-confirm'), 'The server forgets the backend credential.');
  assert.equal(confirm.adminRequests.filter((r) => r.method === 'POST').length, 0, 'the first click sends nothing');
  await w.page.click('.mss-action');
  await w.waitStatus(/^The server reports the settings verified/);
  assert.deepEqual(confirm.adminRequests.filter((r) => r.method === 'POST').map((r) => r.body), [{ action: 'disable' }]);
  await closeSettings(w);
  await w.done();
});

// ---------- 5 ----------

test('BROWSER 5: while a settings policy is served, the send is refused with the reason — this build does not apply it yet; nothing is posted', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = await startChild({ OBSERVOGRAM_MCP_SETTINGS_POLICY: POLICY_FILE });
  t.after(() => studio.stop());
  const f = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base });
  const w = await openPage(studio, 'ada');
  await aim(w, { url: f.url });
  await openSettings(w);
  await w.waitStatus(/describes its settings/);
  await fill(w, 'grafanaUrl', 'https://elsewhere.example/');
  assert.equal(await w.page.getAttribute('.mss-primary', 'aria-disabled'), 'true');
  await w.page.click('.mss-primary', { force: true });
  assert.equal(await w.status(), 'This deployment has a settings policy, which this studio build does not apply yet — send nothing until it does.');
  await w.page.press('#mss-host input[data-field="grafanaUrl"]', 'Enter');
  assert.equal(f.adminRequests.filter((r) => r.method !== 'GET').length, 0, 'nothing posted');
  await closeSettings(w);
  await w.done();
});

// ---------- 6 ----------

test('BROWSER 6: target refusals — a typed ftp:// URL, an unlisted remote origin, plain http, the studio\'s own origin — each named, and no request to anyone', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const f = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base });
  const w = await openPage(studio, 'ada');
  const cases = [
    ['ftp://127.0.0.1/mcp', /^MCP URL must be http or https|scheme/i],
    ['https://mcp.example/mcp', /^Https:\/\/mcp\.example is not a listed MCP origin, and settings carry a credential, which goes only to a listed origin or this machine — the server's operator adds https:\/\/mcp\.example to OBSERVOGRAM_MCP_ORIGINS/],
    ['http://mcp.example/mcp', /^Http:\/\/mcp\.example is plain http, and settings carry a credential across the network — serve the MCP server over https, or run it on this machine\.$/],
    [`${studio.child.base}/mcp`, /^The MCP server shares the studio's origin \(http:\/\/127\.0\.0\.1:\d+\), so its settings would go to the studio server — give the MCP server its own origin \(another port or host\)\.$/],
  ];
  for (const [url, re] of cases) {
    await aim(w, { url });
    await openSettings(w);
    await w.page.waitForFunction(() => document.getElementById('mss-status')?.classList.contains('is-error'), null, { timeout: T });
    assert.match(await w.status(), re, url);
    assert.equal(await w.page.evaluate(() => document.querySelectorAll('#mss-host input').length), 0, `${url}: no form`);
    await closeSettings(w);
  }
  assert.equal(f.adminRequests.length, 0, 'the fake was asked nothing');
  assert.deepEqual(w.requests.filter((r) => /mcp\.example|\/admin\/schema|\/configure/.test(r.url)), [], 'no settings request left the page');
  await w.done();
});

// ---------- 7 ----------

test('BROWSER 7: the gate — oscar\'s button is drawn, aria-disabled with the reason, and opens nothing; ada with no target, then enabled when an endpoint is picked', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const f = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base });
  const id = await endpointIdFor(studio.child.base, f.url, { name: 'gw-7', headers: { Cookie: studio.cookies.ada } });
  const o = await openPage(studio, 'oscar');
  await openPanel(o);
  await o.page.waitForFunction(() => /admin role/.test(document.getElementById('mcp-settings-btn')?.textContent || ''), null, { timeout: T });
  assert.equal(await o.page.getAttribute('#mcp-settings-btn', 'aria-disabled'), 'true');
  const reason = "Configuring the MCP server is endpoint configuration: it needs the admin role in org 'Default' (you are operator) — ask an admin of Default.";
  assert.equal(await o.text('#mcp-settings-btn .svc-why'), reason);
  await o.page.click('#mcp-settings-btn', { force: true });
  await o.page.waitForFunction((r) => document.getElementById('toast')?.textContent === r, reason, { timeout: T });
  assert.equal(await o.page.evaluate(() => document.querySelectorAll('#mss-host .mss').length), 0, 'no dialog');
  assert.equal(f.adminRequests.length, 0);
  await o.done();

  const a = await openPage(studio, 'ada');
  await openPanel(a);
  await a.page.waitForSelector('#mcp-panel [data-mcp-target="refresh"] select', { timeout: T });
  await a.page.selectOption('#mcp-panel [data-mcp-target="refresh"] select', '');
  await a.page.fill('#mcp-url', '');
  assert.equal(await a.page.getAttribute('#mcp-settings-btn', 'aria-disabled'), 'true');
  assert.equal(await a.text('#mcp-settings-btn .svc-why'), 'Choose an MCP endpoint or type a URL.');
  await a.page.click('#mcp-settings-btn', { force: true });
  assert.equal(await a.page.evaluate(() => document.querySelectorAll('#mss-host .mss').length), 0);
  await a.page.selectOption('#mcp-panel [data-mcp-target="refresh"] select', String(id));
  assert.equal(await a.page.getAttribute('#mcp-settings-btn', 'aria-disabled'), null, 'repainted when an endpoint is picked');
  assert.equal(await a.page.evaluate(() => document.querySelectorAll('#mcp-settings-btn .svc-why').length), 0);
  await a.done();
});

// ---------- 8 ----------

test('BROWSER 8: CORS and redirects — unreachable names this page\'s origin; a redirected description; an answer without CORS and a held one are "unknown"; a 307 configure reaches no one', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const w = await openPage(studio, 'ada', { cors: true });
  const noCors = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: false });
  await aim(w, { url: noCors.url });
  await openSettings(w);
  await w.waitStatus(/^Your browser could not read/);
  assert.equal(await w.status(), `Your browser could not read ${noCors.origin}/admin/schema. The server may be down, or it does not answer this page's origin (${studio.child.base}) with CORS headers — its operator adds that origin to the MCP server's allowed origins (MCP_INTEGRATION "Server settings").`);
  assert.deepEqual(await w.page.evaluate(() => [...document.querySelectorAll('.mss-more-btn')].map((b) => b.textContent)), ['Try again', 'Use the generic form']);
  await closeSettings(w);

  const redirected = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, descriptorStatus: 302, cors: studio.child.base });
  await aim(w, { url: redirected.url });
  await openSettings(w);
  await w.waitStatus(/redirect/);
  assert.equal(await w.status(), "The server answered with a redirect, which the studio never follows — configure the MCP endpoint's final URL.");
  assert.equal(redirected.sink.requests.length, 0, 'the redirect was not followed');
  await closeSettings(w);

  for (const admin of [{ corsOnErrors: false, requireKey: { key: API_KEY, in: 'body', field: 'apiKey' } }, { holdAnswer: true }]) {
    const f = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base, ...admin });
    await aim(w, { url: f.url });
    await openSettings(w);
    await w.waitStatus(/describes its settings/);
    await fill(w, 'grafanaUrl', 'https://backend.example/');
    await fill(w, 'secret', SECRET);
    await w.page.click('.mss-primary', { force: true });
    await w.waitStatus(/^The request was sent, but its answer could not be read/, 30_000);
    assert.equal(await w.page.inputValue('#mss-host input[data-field="secret"]'), '', 'the secret was emptied when it was sent');
    assert.deepEqual(await w.page.evaluate(() => [...document.querySelectorAll('.mss-more-btn')].map((b) => b.textContent)), ['Test the connection', 'Try again']);
    assert.equal(f.adminRequests.filter((r) => r.method === 'POST').length, 1, 'it was sent');
    await w.page.click('.mss-more-btn[data-mss="test"]');
    await w.waitStatus(/^Connection test: /);
    await closeSettings(w);
  }

  const moved = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base, configureStatus: 307 });
  await aim(w, { url: moved.url });
  await openSettings(w);
  await w.waitStatus(/describes its settings/);
  await fill(w, 'grafanaUrl', 'https://backend.example/');
  await fill(w, 'secret', SECRET);
  await w.page.click('.mss-primary', { force: true });
  await w.waitStatus(/^The server answered with a redirect, which the studio never follows\. It may have applied the settings — test the connection\.$/);
  assert.equal(moved.sink.requests.length, 0, 'the redirect\'s target received nothing');
  assert.equal(await w.page.isVisible('.mss-more-btn[data-mss="test"]'), true);
  await closeSettings(w);
  await w.done();
});

// ---------- 9 ----------

test('BROWSER 9: keyboard and nesting — Esc, the scrim, esc, Try again and Use the generic form leave the panel open; Tab stays inside; the focus returns; Escape on <body> after a repaint closes only the modal', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  const w = await openPage(studio, 'ada', { cors: true });
  const f = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: studio.child.base });
  const noCors = await fake({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR, cors: false });
  const panelOpen = () => w.page.evaluate(() => !document.getElementById('mcp-panel').hidden);
  const modalOpen = () => w.page.evaluate(() => !!document.querySelector('#mss-host .mss'));

  await aim(w, { url: f.url });
  await openSettings(w);
  await w.waitStatus(/describes its settings/);
  // Tab cycles inside the dialog.
  for (let i = 0; i < 14; i++) {
    await w.page.keyboard.press('Tab');
    assert.equal(await w.page.evaluate(() => !!document.activeElement?.closest('#mss-host .mss')), true, `Tab ${i + 1} stays in the dialog`);
  }
  await w.page.keyboard.press('Escape');
  assert.equal(await modalOpen(), false, 'Esc closes the modal');
  assert.equal(await panelOpen(), true, 'the panel stays open');
  assert.equal(await w.page.evaluate(() => document.activeElement?.id), 'mcp-settings-btn', 'the focus returns');

  await openSettings(w);
  await w.page.mouse.click(10, 10);   // the scrim
  assert.equal(await modalOpen(), false, 'the scrim closes the modal');
  assert.equal(await panelOpen(), true);

  await openSettings(w);
  await w.page.click('#mss-host .mss-close');
  assert.equal(await modalOpen(), false);
  assert.equal(await panelOpen(), true);

  await aim(w, { url: noCors.url });
  await openSettings(w);
  await w.waitStatus(/^Your browser could not read/);
  await w.page.click('.mss-more-btn[data-mss="retry"]');   // repaints: the clicked node is removed
  await w.waitStatus(/^Your browser could not read/);
  assert.equal(await panelOpen(), true, 'Try again leaves the panel open');
  assert.equal(await modalOpen(), true);
  await w.page.click('.mss-more-btn[data-mss="generic"]');
  await w.waitStatus(/^This server publishes no settings description \(your browser could not read one\)/);
  assert.equal(await panelOpen(), true, 'Use the generic form leaves the panel open');
  // A repaint removed the focused node: the focus is on <body>; Escape closes only the modal.
  await w.page.evaluate(() => document.activeElement?.blur());
  assert.equal(await w.page.evaluate(() => document.activeElement === document.body), true);
  await w.page.keyboard.press('Escape');
  assert.equal(await modalOpen(), false, 'Escape on <body> closes the modal');
  assert.equal(await panelOpen(), true, 'and only the modal');
  await w.done();
});

// ---------- 10 ----------

test('BROWSER 10: markup is text — every descriptor slot, a refused endpoint, the outcome\'s message, checks and raw body carry markup; no element is made and nothing runs', async (t) => {
  if (skipUnlessBrowser(t)) return;
  const studio = env.studio;
  // Short labels: a label is at most 80 characters, and the payloads take 75 of them.
  const descriptor = {
    version: 1,
    endpoint: '/configure',
    fields: [
      { name: 'grafanaUrl', label: 'URL', type: 'url', required: true, help: 'the base URL', placeholder: 'https://grafana' },
      { name: 'secret', label: 'Key', type: 'secret', help: 'the secret' },
    ],
    actions: [{ name: 'disable', label: 'Clear', confirm: 'The server forgets it.' }],
  };
  const f = await fake({ descriptor, cors: studio.child.base, markup: true });
  const w = await openPage(studio, 'ada');
  await aim(w, { url: f.url });
  await openSettings(w);
  await w.waitStatus(/describes its settings/);
  const noElements = async (where) => {
    assert.equal(await w.page.evaluate(() => document.querySelectorAll('#mss-host img, #mss-host svg, #mss-host b').length), 0, `${where}: no element from a server string`);
    assert.equal(await w.page.evaluate(() => window.__pwn ?? null), null, `${where}: nothing ran`);
  };
  assert.ok((await w.text('#mss-host .mss-form')).includes(ADMIN_MARKUP.trim().split(' ')[0]), 'the label shows the markup as text');
  assert.ok((await w.page.getAttribute('#mss-host input[data-field="grafanaUrl"]', 'placeholder')).includes('<img'), 'the placeholder holds it as text');
  await w.page.click('.mss-action');
  assert.ok((await w.text('.mss-action-confirm')).includes('<svg onload'), 'the confirm shows it as text');
  await noElements('the description');
  await fill(w, 'grafanaUrl', 'https://backend.example/');
  await fill(w, 'secret', SECRET);
  await w.page.click('.mss-primary', { force: true });
  await w.waitStatus(/Connection test:/);
  assert.ok((await w.text('.mss-outcome-message')).includes('<img src=x onerror=window.__pwn=1>'));
  assert.ok((await w.text('.mss-checks')).includes('<b>bold</b>'));
  assert.ok((await w.text('.mss-raw-body')).includes('<svg onload=window.__pwn=1>'));
  await noElements('the outcome');
  await closeSettings(w);

  const refused = await fake({ descriptor: { ...EXAMPLE_SETTINGS_DESCRIPTOR, endpoint: '<img src=x onerror=window.__pwn=1>' }, cors: studio.child.base });
  await aim(w, { url: refused.url });
  await openSettings(w);
  await w.page.waitForFunction(() => document.getElementById('mss-status')?.classList.contains('is-error'), null, { timeout: T });
  assert.match(await w.status(), /^The server's settings endpoint "<img src=x onerror=window\.__pwn=1>" is not a plain path/);
  await noElements('a refused endpoint');
  await closeSettings(w);
  await w.done();
});
