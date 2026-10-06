#!/usr/bin/env node
/**
 * server/test-settings-studio.mjs — the Settings journey in headless
 * Chromium (docs/STORE_PLAN.md slice 6b): the real studio against a child
 * identity server, driven as the people the fixture names.
 *
 * As oscar (operator): Advanced → Settings — the scope names his role, the
 * nav lists the org's four sections, Members and Audit and New MCP endpoint
 * aria-disabled with the admin reason, the SERVICE chip and the context bar
 * hidden; the environment editor opened from the service page in a fresh
 * browser waits for the org's endpoint list before it draws; add an
 * environment, set a tier, bind an endpoint, and a tier-only save that
 * neither resends nor clears the binding. The MCP pickers, in one browser:
 * the home, the refresh panel, the draft panel and the deploy modal send
 * `mcpEndpointId` (never with `mcpUrl`) and show the server's sentence as
 * served; rollback and verify follow; an endpoint moved or deleted while
 * the modal is open sends nothing. As ada (admin): register an endpoint, the
 * server's refusals as served (a credential in the URL, another org's
 * variable); members — an upsert, a demotion, the last-admin rule drawn
 * before the server says it, the org renamed, no email in a row; the audit —
 * a kind filter, a same-day range, a range refused, older pages; leaving the
 * org reloads this browser into the next, where nothing is writable. As
 * olive (owner), in one browser: a profile remembers its endpoint per org.
 * As vera (viewer): no Edit, no URL. As nora (no org): the boot's refusal.
 * The token posture (with and without OBSERVOGRAM_AUTH=off) and an open
 * server bound off the loopback: the banner is the server's text, the
 * writes carry their reasons, the pickers offer no Settings button.
 *
 * Its own fixture (design §12.4 B1): ada is acme's only enabled admin (olive
 * is an owner and an operator there), and ada is a viewer of bravo — she has
 * somewhere to land after leaving acme. No page error and no console.error
 * anywhere; nothing leaves the loopback. Skipped unless Playwright imports
 * (OBSERVOGRAM_PLAYWRIGHT, else the bare 'playwright') and Chromium
 * launches; OBSERVOGRAM_SETTINGS_SMOKE=require fails instead.
 */
/* global document, getComputedStyle */

// The two knobs are read before the strip (STRIP carries both so no child
// sees them); the rest of the shell never reaches this process's imports.
const PLAYWRIGHT = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
const REQUIRED = process.env.OBSERVOGRAM_SETTINGS_SMOKE === 'require';
const { STRIP, serve, signIn } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');

const PAYMENT = parseYaml(readFileSync(join(ROOT, 'vendor', 'observability-pack-spec', 'v1.4', 'examples', 'payment-service.pack.yaml'), 'utf8'));
const TOKEN = 'settings-studio-token-secret';
const NO_ORG = '403: no org membership — ask an admin to add you';
const TOKEN_REASON = 'needs the operator role — this server takes mutations with its API token only, not from a browser';
const CLOSED_REASON = 'closed on this server without sign-in — the banner above names the way in';
const ADMIN_REASON = (org, role) => `needs the admin role in ${org} — yours is ${role}; ask an admin of ${org}`;
const LOCK = 'ada is the last admin of Acme: only an owner can demote or remove them — make another member an admin first';
const UNSET = /^MCP endpoint "gw" reads its token from OBSERVOGRAM_ORG_ACME_MCP_TOKEN, which is not set in the server's environment/;
const GW = { name: 'gw', url: 'https://mcp.acme.test/obs', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' };

// Design §12.4 B1: ada is acme's only enabled admin; olive (an owner) is an
// operator there; ada is a viewer of bravo; nora is in no org. `default` is
// listed first with olive as its admin: the legacy import makes the first
// org's admins the deployment's owners. Every user has an email, so a row
// that rendered one would show it.
const password = (login) => `${login}-passw0rd-settings`;
const email = (login) => `${login}@mail.test`;
const LOGINS = ['olive', 'ada', 'oscar', 'vera', 'bob', 'nora'];
function fixture(ws) {
  writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(password(l)), email: email(l) }])) }, join(ws, 'users.json'));
  writeOrgsFile({
    default: { name: 'Default', members: { olive: 'admin' } },
    acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer', olive: 'operator' } },
    bravo: { name: 'Bravo', members: { bob: 'admin', olive: 'admin', ada: 'viewer' } },
  }, join(ws, 'orgs.json'));
}

async function loadPlaywright() {
  try { return { pw: await import(PLAYWRIGHT) }; }
  catch (e) { return { error: `cannot import ${PLAYWRIGHT}: ${e.message.split('\n')[0]}` }; }
}

const LAPTOP = { width: 1366, height: 800 };
const PHONE = { width: 390, height: 844 };
const T = 15_000;

test('BROWSER: the Settings journey — environments, endpoints and the pickers, members, the audit, a viewer, a user with no org, the token and open-exposed postures', async (t) => {
  const skip = (why) => { if (REQUIRED) assert.fail(`OBSERVOGRAM_SETTINGS_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());

  const dirs = [];
  const children = [];
  const workspace = (tag) => { const d = mkdtempSync(join(tmpdir(), `observogram-settings-studio-${tag}-`)); dirs.push(d); return d; };
  t.after(async () => {
    for (const c of children) await c.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const ws = workspace('id');
  fixture(ws);
  const child = await serve(ws);
  children.push(child);
  const tokenChild = await serve(workspace('token'), { env: { OBSERVOGRAM_API_TOKEN: TOKEN } });
  children.push(tokenChild);
  const tokenOffChild = await serve(workspace('token-off'), { env: { OBSERVOGRAM_API_TOKEN: TOKEN, OBSERVOGRAM_AUTH: 'off' } });
  children.push(tokenOffChild);
  const openChild = await serve(workspace('open-exposed'), { host: '0.0.0.0', env: { OBSERVOGRAM_INSECURE_NO_AUTH: '1', OBSERVOGRAM_AUTH: 'off' } });
  children.push(openChild);

  // ---------- HTTP as a signed-in person ----------
  const cookies = {};
  async function cookieFor(login) {
    if (!cookies[login]) {
      const s = await signIn(child.base, login, password(login));
      assert.equal(s.status, 200, `${login} signs in: ${JSON.stringify(s.json)}`);
      assert.ok(s.session, `${login} gets a session`);
      cookies[login] = s.session;
    }
    return cookies[login];
  }
  // The cookie, Accept, the CSRF header and the org (olive names acme — an owner's choice, not a membership's default).
  async function call(who, method, path, body, { base = child.base, org = who === 'olive' ? 'acme' : null, bearer = null } = {}) {
    const headers = { Accept: 'application/json', 'X-Observogram-CSRF': '1' };
    if (who) headers.Cookie = await cookieFor(who);
    if (org) headers['X-Observogram-Org'] = org;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${base}${path}`, { method, headers, body: payload, redirect: 'manual' });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  }
  // The studio's `<status>: <sentence>` rule, from the server's own answer.
  const served = (r) => `${r.status}: ${r.json.error}`;

  // ---------- the browser ----------
  const problems = [];   // every pageerror and console.error, tagged by who was driving
  async function open(base, login, { viewport = LAPTOP, ctx = null, before = null } = {}) {
    const c = ctx || await browser.newContext({ viewport });
    if (login && !ctx) await c.addCookies([{ name: 'observogram_session', value: (await cookieFor(login)).split('=')[1], url: base }]);
    const page = await c.newPage();
    const tag = `${login || 'anonymous'}@${viewport.width}`;
    page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
    // "Failed to load resource: …" is Chromium's own line for a request that did not get a 2xx — the aborted
    // off-loopback font links, the deliberate 4xx and the token posture's 404 on /auth/me are the server's
    // answers by design, not a console.error the studio wrote.
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource: /.test(m.text())) problems.push(`${tag} console.error: ${m.text()}`); });
    // fallback, not continue: a context's own routes (the deploy fakes) still answer.
    await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.fallback() : route.abort()));
    before?.(page);
    await page.goto(`${base}/`);
    await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
    return { page, ctx: c };
  }
  const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.replace(/\s+/g, ' ').trim() ?? null, sel);
  const attr = (page, sel, name) => page.evaluate(([s, n]) => document.querySelector(s)?.getAttribute(n) ?? null, [sel, name]);
  const settled = (page) => page.waitForFunction(() => { const s = document.querySelector('#set-section-status'); return document.body.dataset.mode === 'settings' && s && !/^Reading /.test(s.textContent); }, null, { timeout: T });
  const toSettings = async (page) => { await page.click('.observa-adv-toggle'); await page.click('.observa-adv-item[data-action="settings"]'); await settled(page); };
  const toSection = async (page, id) => {
    await page.click(`.set-nav-item[data-section="${id}"]`);
    await page.waitForFunction((s) => document.querySelector('#set-section')?.dataset.section === s, id, { timeout: T });
    await settled(page);
  };
  // The reason line (.svc-why) inside an unavailable button that wears the mcp-refresh-btn idiom — the section's
  // primary and the editor's Save (a probe drawn the way paintEditorButtons leaves it) — measured on the button's
  // own computed background under the shipped stylesheets, in both themes: WCAG AA for its 12.5 px text, and no
  // opacity on the button (an unavailable button is not a pending one).
  const whyOnButton = (page) => page.evaluate(() => {
    const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const probe = document.createElement('div');
    probe.innerHTML = '<button type="button" class="mcp-refresh-btn set-editor-save is-unavailable" aria-disabled="true">Save<span class="svc-why">needs the admin role</span></button>';
    document.body.append(probe);
    const root = document.documentElement;
    const before = root.getAttribute('data-theme');
    const out = [];
    for (const theme of ['light', 'dark']) {
      root.setAttribute('data-theme', theme);
      for (const btn of [document.querySelector('#set-primary'), probe.querySelector('button')]) {
        const id = btn.id || 'set-editor-save (probe)';
        const why = btn.querySelector('.svc-why');
        if (!why) { out.push(`${id}: no reason line`); continue; }
        const cs = getComputedStyle(btn);
        const ratio = contrast(getComputedStyle(why).color, cs.backgroundColor);
        if (ratio < 4.5) out.push(`${id} (${theme}): ${getComputedStyle(why).color} on ${cs.backgroundColor} ${ratio.toFixed(2)}:1`);
        if (cs.opacity !== '1') out.push(`${id} (${theme}): opacity ${cs.opacity}`);
      }
    }
    if (before === null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', before);
    probe.remove();
    return out;
  });
  const editorStatus = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('set-editor-status')?.textContent || ''), re.source, { timeout: T });
  const editorError = async (page) => {
    await page.waitForFunction(() => document.querySelector('#set-editor-status')?.classList.contains('is-error'), null, { timeout: T });
    return text(page, '#set-editor-status');
  };
  const closeEditor = async (page) => {
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#set-editor-host .set-editor'), null, { timeout: T });
  };
  const openService = async (page, slug) => {
    await page.waitForSelector(`.svc-card[data-service="${slug}"]`, { timeout: T });
    await page.click(`.svc-card[data-service="${slug}"]`);
    await page.waitForFunction(() => document.body.dataset.mode === 'service' && document.querySelector('.svc-page-name'), null, { timeout: T });
  };
  const envOptions = (page) => page.evaluate(() => [...document.querySelectorAll('#set-edit-mcpEndpointId option')].map((o) => [o.value, o.textContent, o.selected]));
  const pickerOptions = (page, id) => page.evaluate((i) => [...document.querySelectorAll(`[data-mcp-target="${i}"] select.set-mcp-target option`)].map((o) => [o.value, o.textContent, o.selected]), id);
  const posts = (page, re) => { const list = []; page.on('request', (r) => { if (re.test(r.url()) && r.method() === 'POST') list.push(JSON.parse(r.postData() || 'null')); }); return list; };
  // The Settings zone's elements past the viewport's right edge, the nav's own scroller aside.
  const overflow = (page) => page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    return [...document.querySelectorAll('.set-page, .set-page *, .set-editor, .set-editor *')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > cw + 1 && !el.closest('.set-nav'); }).slice(0, 8).map((el) => `${el.tagName}.${el.className}#${el.id}:${Math.round(el.getBoundingClientRect().right)}`);
  });

  // ---------- the records ----------
  const reg = await call('oscar', 'POST', '/api/validate', PAYMENT);
  assert.equal(reg.status, 200, reg.text);
  const packId = reg.json.registered.id;
  const svc = (await call('oscar', 'GET', '/api/services')).json.services.find((s) => s.slug === 'payment-service');
  assert.ok(svc, 'the register wrote the payment-service row');
  const prodId = svc.environments.find((e) => e.name === 'prod').id;
  const members = (await call('ada', 'GET', '/api/org/members')).json.members;
  const idOf = (login) => members.find((m) => m.login === login).userId;
  const noEmail = async (page, who) => {
    const html = await page.evaluate(() => (document.querySelector('.set-page')?.outerHTML || '') + (document.getElementById('set-editor-host')?.innerHTML || ''));
    for (const l of LOGINS) assert.ok(!html.includes(email(l)), `${who}: an email in the page: ${email(l)}`);
  };
  let gwId = null;

  await t.test('oscar (operator): Settings from Advanced — his role, the org\'s four sections, the admin ones and New MCP endpoint aria-disabled with the reason; the SERVICE chip and the context bar hidden', async () => {
    const { page, ctx } = await open(child.base, 'oscar');
    try {
      await toSettings(page);
      assert.equal(await text(page, '.set-scope'), 'Settings · Acme (acme) · you are operator');
      const nav = await page.evaluate(() => [...document.querySelectorAll('.set-nav-item')].map((b) => [b.dataset.section, b.getAttribute('aria-disabled')]));
      assert.deepEqual(nav, [['environments', null], ['endpoints', null], ['members', 'true'], ['audit', 'true']], 'no deployment group');
      for (const id of ['members', 'audit']) assert.equal(await text(page, `.set-nav-item[data-section="${id}"] .svc-why`), ADMIN_REASON('Acme', 'operator'));
      assert.equal(await page.evaluate(() => document.getElementById('observa-service').hidden), true, 'the SERVICE chip is hidden');
      assert.equal(await page.evaluate(() => { const h = document.querySelector('.hdr'); return !h || getComputedStyle(h).display === 'none' || h.getClientRects().length === 0; }), true, '.hdr is not visible');
      await toSection(page, 'endpoints');
      assert.equal(await attr(page, '#set-primary', 'aria-disabled'), 'true');
      assert.equal(await text(page, '#set-primary .svc-why'), ADMIN_REASON('Acme', 'operator'));
      assert.deepEqual(await whyOnButton(page), [], 'the reason line inside an unavailable primary and Save reads at AA on the button, in both themes');
      await page.click('#set-primary', { force: true });
      await page.waitForTimeout(200);
      assert.equal(await page.$('#set-editor-host .set-editor'), null, 'its click explains, opens nothing');
    } finally { await ctx.close(); }
  });

  await t.test('oscar, a fresh browser, the service page first: Edit environment waits for the org\'s endpoint list before it draws; Escape returns the focus', async () => {
    let reads = 0;
    // Every read of the list answered late: the editor must wait for one, not draw before it settles.
    const slow = (p) => p.route('**/api/mcp-endpoints', async (route) => { reads++; await new Promise((r) => setTimeout(r, 800)); await route.fallback(); });
    const { page, ctx } = await open(child.base, 'oscar', { before: slow });
    try {
      await openService(page, 'payment-service');
      await page.click('.svc-tab[data-env="prod"]');
      await page.focus('#svc-edit-env');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#set-editor-host .set-editor', { timeout: T });
      assert.ok(reads >= 1, 'the editor read the list before it drew');
      assert.equal(await page.evaluate(() => document.body.dataset.mode), 'service', 'no mode change');
      assert.equal(await text(page, '#set-editor-title'), 'Edit prod');
      assert.deepEqual(await envOptions(page), [['', 'none', true]]);
      assert.equal(await text(page, '#set-edit-mcpEndpointId-help'), 'No MCP endpoint is registered in Acme yet — an admin registers one in Settings → MCP endpoints.');
      await closeEditor(page);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'svc-edit-env', 'Escape returns the focus to Edit environment');
    } finally { await ctx.close(); }
  });

  await t.test('ada (admin): New MCP endpoint gw — created; a credential in the URL and another org\'s variable are the server\'s sentences as served', async () => {
    const { page, ctx } = await open(child.base, 'ada');
    try {
      await toSettings(page);
      await toSection(page, 'endpoints');
      // A URL that carries a credential: refused by the server, its sentence as served.
      await page.click('#set-primary');
      await page.waitForSelector('#set-editor-host .set-editor', { timeout: T });
      await page.fill('#set-edit-name', 'gw');
      await page.fill('#set-edit-url', 'https://mcp.acme.test/obs?token=x');
      await page.fill('#set-edit-readTokenEnv', GW.readTokenEnv);
      await page.click('#set-editor-save');
      const credential = await editorError(page);
      assert.equal(credential, served(await call('ada', 'POST', '/api/mcp-endpoints', { ...GW, url: 'https://mcp.acme.test/obs?token=x' })));
      assert.match(credential, /^400: observogram store: .*the parameter\(s\) "token" look like credentials; /);
      assert.ok(!credential.includes('{'), credential);
      // The endpoint itself.
      await page.fill('#set-edit-url', GW.url);
      await page.click('#set-editor-save');
      await editorStatus(page, /^Created /);
      assert.equal(await text(page, '#set-editor-status'), 'Created gw (https://mcp.acme.test).');
      gwId = (await call('ada', 'GET', '/api/mcp-endpoints')).json.endpoints.find((e) => e.name === 'gw').id;
      // Another org's variable: the server's sentence as served.
      await page.fill('#set-edit-readTokenEnv', 'OBSERVOGRAM_ORG_BRAVO_X');
      await page.click('#set-editor-save');
      const foreign = await editorError(page);
      assert.equal(foreign, served(await call('ada', 'PATCH', `/api/mcp-endpoints/${gwId}`, { readTokenEnv: 'OBSERVOGRAM_ORG_BRAVO_X' })));
      assert.match(foreign, /^400: /);
      assert.ok(!foreign.includes('{'), foreign);
      await closeEditor(page);
      const row = await text(page, `.set-row[data-endpoint-id="${gwId}"]`);
      assert.match(row, /token: OBSERVOGRAM_ORG_ACME_MCP_TOKEN/, 'the refused variable was not kept');
    } finally { await ctx.close(); }
  });

  await t.test('oscar (operator): add an environment, a tier, bind gw to prod; a tier-only save neither resends nor clears the binding; the service page follows', async () => {
    const { page, ctx } = await open(child.base, 'oscar');
    try {
      const patches = [];
      page.on('request', (r) => { if (/\/api\/environments\/\d+$/.test(r.url()) && r.method() === 'PATCH') patches.push(JSON.parse(r.postData())); });
      await toSettings(page);
      await page.click('#set-primary');
      await page.waitForSelector('#set-editor-host .set-editor', { timeout: T });
      await page.selectOption('#set-edit-serviceId', String(svc.id));
      // staging-eu: the pack already declares prod and staging.
      await page.fill('#set-edit-name', 'staging-eu');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Created /);
      assert.equal(await text(page, '#set-editor-status'), `Created staging-eu on ${svc.name}.`);
      await page.click('.set-editor-seg-btn[data-value="tier-1"]');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Saved: tier$/);
      await closeEditor(page);
      // Bind gw to prod.
      await page.click(`[data-edit-env="${prodId}"]`);
      await page.waitForSelector('#set-editor-host .set-editor', { timeout: T });
      assert.deepEqual(await envOptions(page), [['', 'none', true], [String(gwId), 'gw — https://mcp.acme.test', false]]);
      await page.selectOption('#set-edit-mcpEndpointId', String(gwId));
      await page.click('#set-editor-save');
      await editorStatus(page, /^Saved: MCP endpoint$/);
      assert.deepEqual(patches.at(-1), { mcpEndpointId: gwId });
      // The tier only: the PATCH has the tier and no mcpEndpointId.
      await page.click('.set-editor-seg-btn[data-value="tier-2"]');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Saved: tier$/);
      assert.deepEqual(patches.at(-1), { tier: 'tier-2' }, 'the binding is not resent nor nulled');
      await closeEditor(page);
      const prod = (await call('oscar', 'GET', '/api/services')).json.services.find((s) => s.id === svc.id).environments.find((e) => e.id === prodId);
      assert.equal(prod.mcpEndpoint?.id ?? prod.mcpEndpointId, gwId, 'still bound over HTTP');
      // The service page: the new tab and the binding.
      await page.click(`[data-open-service="${svc.id}"]`);
      await page.waitForFunction(() => document.body.dataset.mode === 'service', null, { timeout: T });
      await page.waitForSelector('.svc-tab[data-env="staging-eu"]', { timeout: T });
      await page.click('.svc-tab[data-env="prod"]');
      await page.waitForFunction(() => /^gw · https:\/\/mcp\.acme\.test$/.test(document.querySelector('.svc-env-mcp')?.textContent.replace(/\s+/g, ' ').trim() || ''), null, { timeout: T });
    } finally { await ctx.close(); }
  });

  await t.test('oscar, one browser — the pickers send mcpEndpointId: the home, the refresh panel, the draft panel, the deploy modal; verify and rollback follow; a moved or deleted endpoint sends nothing', async () => {
    const ctx = await browser.newContext({ viewport: LAPTOP });
    await ctx.addCookies([{ name: 'observogram_session', value: (await cookieFor('oscar')).split('=')[1], url: child.base }]);
    const deploys = [];
    const rollbacks = [];
    await ctx.route('**/api/packs/*/deploy-bulk*', async (route) => {
      deploys.push(JSON.parse(route.request().postData()));
      const item = { type: 'dashboard', id: 'x', group: 'dashboards', artifact: 'x' };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, deployId: 'dep_settings', dryRun: false, tookMs: 3, results: [{ ok: true, item, artifact: 'x', group: 'dashboards' }], summary: { total: 1, ok: 1, failed: 0 } }) });
    });
    await ctx.route('**/api/deploys?pack=*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deploys: [{ deployId: 'dep_old', at: '2026-10-06T10:00:00Z', target: { product: 'grafana', version: '12' }, summary: { total: 1, ok: 1, failed: 0 }, snapshot: { status: 'captured' } }] }) }));
    await ctx.route('**/api/deploys/*/rollback', async (route) => {
      rollbacks.push(JSON.parse(route.request().postData()));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, summary: { total: 1, ok: 1, failed: 0 }, results: [], manual: [] }) });
    });
    try {
      const { page } = await open(child.base, 'oscar', { ctx });
      page.on('dialog', (d) => d.accept());
      const anyAuth = [];
      page.on('request', (r) => { if (r.method() === 'POST' && /mcpAuth/.test(r.postData() || '')) anyAuth.push(r.url()); });
      const drafts = posts(page, /\/api\/draft-from-mcp$/);
      const refreshes = posts(page, /\/api\/refresh-live$/);
      const GW_OPTIONS = [[String(gwId), 'gw — https://mcp.acme.test', true], ['', 'Type a URL…', false]];

      // The home's source card (D-J): the select, its label, the URL label.
      await page.waitForSelector('[data-mcp-target="home"] select.set-mcp-target', { state: 'attached', timeout: T });
      assert.deepEqual(await pickerOptions(page, 'home'), GW_OPTIONS);
      assert.equal(await attr(page, '[data-mcp-target="home"] select', 'aria-label'), 'Registered MCP endpoint');
      assert.equal(await text(page, 'label.home-mcp-url-row .home-mcp-url-label'), 'MCP URL');

      // The refresh panel.
      await page.evaluate(() => document.getElementById('mcp-btn').click());
      await page.waitForSelector('#mcp-panel:not([hidden]) [data-mcp-target="refresh"] select', { timeout: T });
      assert.deepEqual(await pickerOptions(page, 'refresh'), GW_OPTIONS);
      await page.click('#mcp-refresh-btn');
      await page.waitForFunction(() => /^error: /.test(document.getElementById('mcp-refresh-status')?.textContent || ''), null, { timeout: T });
      assert.deepEqual(refreshes.at(-1), { mcpEndpointId: gwId }, 'the id, no mcpUrl');
      assert.match((await text(page, '#mcp-refresh-status')).replace(/^error: /, ''), UNSET);
      await page.evaluate(() => document.getElementById('mcp-panel-close').click());

      // The draft panel (A6: no "URL required" guard with an endpoint chosen).
      await page.evaluate(() => document.getElementById('draft-mcp-btn').click());
      await page.waitForSelector('#draft-mcp-panel:not([hidden]) [data-mcp-target="draft"] select', { timeout: T });
      assert.deepEqual(await pickerOptions(page, 'draft'), GW_OPTIONS);
      await page.fill('#draft-mcp-name', 'nightly');
      await page.click('#draft-mcp-go-btn');
      await page.waitForFunction(() => /^error: /.test(document.getElementById('draft-mcp-status')?.textContent || ''), null, { timeout: T });
      assert.deepEqual(drafts.at(-1), { mcpEndpointId: gwId, packName: 'nightly' });
      assert.match((await text(page, '#draft-mcp-status')).replace(/^error: /, ''), UNSET);
      await page.evaluate(() => document.getElementById('draft-mcp-panel-close').click());

      // The deploy modal: deploy, then the verify reads the server's refusal as a sentence (C-1).
      const openModal = () => page.evaluate(async (id) => { const { host } = await import('/host.mjs'); host.openDeployModal({ packId: id }); }, packId);
      await openModal();
      await page.waitForSelector('#deploy-modal:not([hidden]) [data-mcp-target="deploy"] select', { timeout: T });
      assert.deepEqual(await pickerOptions(page, 'deploy'), GW_OPTIONS);
      await page.waitForSelector('#deploy-manifest-tbody tr[data-key]', { timeout: T });
      await page.click('#deploy-modal-go');
      await page.waitForFunction(() => /deployed/.test(document.getElementById('deploy-modal-status')?.textContent || ''), null, { timeout: T });
      assert.equal(deploys.at(-1).mcpEndpointId, gwId);
      assert.ok(!('mcpUrl' in deploys.at(-1)), 'never both');
      await page.waitForFunction(() => /400: MCP endpoint "gw" reads its token from OBSERVOGRAM_ORG_ACME_MCP_TOKEN/.test(document.getElementById('deploy-modal-verify')?.textContent || ''), null, { timeout: 20_000 });
      assert.deepEqual(drafts.at(-1), { mcpEndpointId: gwId }, 'the verify drafts through gw');
      const verify = await text(page, '#deploy-modal-verify');
      assert.ok(!verify.includes('{'), `no raw JSON in the verify line: ${verify}`);

      // Rollback with gw: the id, no "Enter the MCP URL" toast.
      await page.waitForSelector('.deploy-hist-rollback', { timeout: T });
      await page.click('.deploy-hist-rollback');
      await page.waitForFunction(() => /Rolled back/.test(document.body.textContent), null, { timeout: T });
      assert.deepEqual(rollbacks.at(-1), { mcpEndpointId: gwId });

      // Drift (C-3): ada moves gw while the modal is open → Deploy sends nothing.
      const deploysBefore = deploys.length;
      const authBefore = anyAuth.length;
      assert.equal((await call('ada', 'PATCH', `/api/mcp-endpoints/${gwId}`, { url: 'https://mcp2.acme.test/obs' })).status, 200);
      await page.fill('#deploy-target-auth', 'write-key-2');
      await page.click('#deploy-modal-go');
      await page.waitForFunction(() => /now points at/.test(document.getElementById('deploy-modal-status')?.textContent || ''), null, { timeout: T });
      assert.equal(await text(page, '#deploy-modal-status'), 'gw now points at https://mcp2.acme.test (it showed https://mcp.acme.test) — check the target and send again.');
      assert.equal(deploys.length, deploysBefore, 'nothing deployed');
      assert.equal(anyAuth.length, authBefore, 'no request carried mcpAuth');
      assert.deepEqual(await pickerOptions(page, 'deploy'), [[String(gwId), 'gw — https://mcp2.acme.test', true], ['', 'Type a URL…', false]], 'the option names the new origin');
      assert.equal((await call('ada', 'PATCH', `/api/mcp-endpoints/${gwId}`, { url: GW.url })).status, 200);
      await page.fill('#deploy-target-auth', '');

      // Rollback with gw deleted between the open and the click → the gone sentence, nothing sent.
      await page.evaluate(() => document.getElementById('deploy-modal-close').click());
      await openModal();
      await page.waitForSelector('.deploy-hist-rollback', { timeout: T });
      await page.waitForFunction((id) => [...document.querySelectorAll('[data-mcp-target="deploy"] option')].some((o) => o.value === String(id) && /mcp\.acme/.test(o.textContent)), gwId, { timeout: T });
      assert.equal((await call('ada', 'DELETE', `/api/mcp-endpoints/${gwId}`)).status, 200);
      const rollbacksBefore = rollbacks.length;
      await page.click('.deploy-hist-rollback');
      await page.waitForFunction(() => /is no longer one of/.test(document.body.textContent), null, { timeout: T });
      assert.match(await page.evaluate(() => document.body.textContent), /gw is no longer one of Acme's MCP endpoints — choose another or type a URL\./);
      assert.equal(rollbacks.length, rollbacksBefore, 'no rollback sent');
      await page.evaluate(() => document.getElementById('deploy-modal-close').click());
    } finally {
      await ctx.close();
      // gw again, for the steps that follow (a new id; prod is unbound by the delete).
      const again = await call('ada', 'POST', '/api/mcp-endpoints', GW);
      assert.equal(again.status, 201, again.text);
      gwId = again.json.endpoint.id;
    }
  });

  await t.test('olive, one browser: a profile remembers its endpoint per org — in bravo, acme\'s gw is a note and a typed, empty URL', async () => {
    const ctx = await browser.newContext({ viewport: LAPTOP });
    await ctx.addCookies([{ name: 'observogram_session', value: (await cookieFor('olive')).split('=')[1], url: child.base }]);
    try {
      const { page } = await open(child.base, 'olive', { ctx });
      page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('p1') : d.accept()));
      await page.waitForSelector('.observa-org-select', { timeout: T });
      if (await page.evaluate(() => document.querySelector('.observa-org-select').value) !== 'acme') {
        await Promise.all([page.waitForNavigation(), page.selectOption('.observa-org-select', 'acme')]);
        await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
      }
      const openModal = () => page.evaluate(async (id) => { const { host } = await import('/host.mjs'); host.openDeployModal({ packId: id }); }, packId);
      await openModal();
      await page.waitForSelector('#deploy-modal:not([hidden]) [data-mcp-target="deploy"] select', { timeout: T });
      await page.selectOption('[data-mcp-target="deploy"] select', String(gwId));
      await page.click('#deploy-profile-save');
      await page.waitForFunction(() => [...document.querySelectorAll('#deploy-target-profile option')].some((o) => o.value === 'p1'), null, { timeout: T });
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('deployProfiles.v2:olive')).p1);
      assert.deepEqual(stored.mcpEndpoint, { orgId: 'acme', id: gwId, name: 'gw' });
      assert.equal(stored.mcpUrl, '', 'the pinned mcpUrl line');
      await page.evaluate(() => document.getElementById('deploy-modal-close').click());
      // The ORG chip, the same browser.
      await Promise.all([page.waitForNavigation(), page.selectOption('.observa-org-select', 'bravo')]);
      await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
      await openModal();
      await page.waitForSelector('#deploy-modal:not([hidden])', { timeout: T });
      await page.waitForFunction(() => [...document.querySelectorAll('#deploy-target-profile option')].some((o) => o.value === 'p1'), null, { timeout: T });
      await page.selectOption('#deploy-target-profile', 'p1');
      await page.waitForFunction(() => /^Profile "p1"/.test(document.getElementById('deploy-modal-status')?.textContent || ''), null, { timeout: T });
      assert.equal(await text(page, '#deploy-modal-status'), 'Profile "p1" names MCP endpoint "gw" of acme — choose one of Bravo\'s, or type a URL.');
      assert.equal(await page.evaluate(() => document.getElementById('deploy-target-mcp').value), '');
      assert.equal(await page.evaluate(() => document.getElementById('deploy-target-mcp').closest('label').getClientRects().length > 0), true, 'typed mode');
    } finally { await ctx.close(); }
  });

  await t.test('ada (admin) — members: an upsert, a demotion, the last-admin rule drawn first, the org renamed, no email in a row', async () => {
    const { page, ctx } = await open(child.base, 'ada');
    try {
      await toSettings(page);
      await toSection(page, 'members');
      await noEmail(page, 'ada');
      // Add oscar again as admin: an upsert.
      await page.click('#set-primary');
      await page.waitForSelector('.set-editor[data-kind="member-add"]', { timeout: T });
      await page.fill('#set-edit-value', 'oscar');
      await page.click('[data-seg="role"][data-value="admin"]');
      await page.click('#set-editor-save');
      await editorStatus(page, /^oscar was already a member: operator → admin\.$/);
      await closeEditor(page);
      // The list is re-read after a write: wait for it rather than for the dialog.
      const removeState = (want) => page.waitForFunction(([sel, w]) => document.querySelector(sel)?.getAttribute('aria-disabled') === w, [`[data-member-remove="${idOf('ada')}"]`, want], { timeout: T });
      await removeState(null);   // two admins: hers is usable
      // Demote oscar back.
      await page.click(`[data-member-role="${idOf('oscar')}"]`);
      await page.waitForSelector('.set-editor[data-kind="member"]', { timeout: T });
      await noEmail(page, 'ada (the member dialog)');
      await page.click('[data-seg="role"][data-value="operator"]');
      await page.click('#set-editor-save');
      await editorStatus(page, /^oscar: admin → operator\.$/);
      await closeEditor(page);
      // ada is acme's last enabled admin again: drawn before the server says it.
      await removeState('true');
      assert.equal(await text(page, `[data-member-remove="${idOf('ada')}"] .svc-why`), LOCK);
      await page.click(`[data-member-role="${idOf('ada')}"]`);
      await page.waitForSelector('.set-editor[data-kind="member"]', { timeout: T });
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('[data-seg="role"]')].map((b) => [b.dataset.value, b.getAttribute('aria-disabled')])), [['viewer', 'true'], ['operator', 'true'], ['admin', null]]);
      assert.equal(await text(page, '#set-edit-role-help'), LOCK);
      await closeEditor(page);
      // Rename: the head and the ORG chip follow.
      await page.click('#set-rename');
      await page.waitForSelector('.set-editor[data-kind="org-name"]', { timeout: T });
      await page.fill('#set-edit-name', 'Acme Corp');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Renamed: Acme → Acme Corp\.$/);
      await closeEditor(page);
      await page.waitForFunction(() => document.querySelector('.set-scope')?.textContent.replace(/\s+/g, ' ').trim() === 'Settings · Acme Corp (acme) · you are admin', null, { timeout: T });
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('.observa-org-select option')].find((o) => o.value === 'acme')?.textContent), 'Acme Corp', 'the ORG chip follows');
      assert.deepEqual((await page.evaluate(() => [...document.querySelectorAll('#set-section [data-member-id] .set-row-name')].map((n) => n.textContent))).sort(), ['ada', 'olive', 'oscar', 'vera']);
      await noEmail(page, 'ada (after)');
    } finally { await ctx.close(); }
  });

  await t.test('ada (admin) — the audit: her rows, a kind filter, a same-day range, a range refused as served, older pages', async () => {
    // More than one page of 100: role changes over HTTP.
    for (let i = 0; i < 55; i++) {
      for (const role of ['admin', 'operator']) assert.equal((await call('ada', 'PATCH', `/api/org/members/${idOf('oscar')}`, { role })).status, 200);
    }
    const { page, ctx } = await open(child.base, 'ada');
    try {
      const audits = [];
      page.on('request', (r) => { const m = /\/api\/audit(\?[^#]*)?$/.exec(r.url()); if (m) audits.push(m[1] ?? ''); });
      await toSettings(page);
      await toSection(page, 'audit');
      assert.equal(audits.at(-1), '?limit=100');
      assert.equal(await text(page, '.set-audit caption'), '100 rows, newest first · scope org · org acme');
      const first = await page.evaluate(() => [...document.querySelector('.set-audit tbody tr').querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
      assert.equal(first[1], 'ada', 'the actor as the server writes it');
      assert.equal(first[2], 'membership.role');
      // Older rows: before=<next>.
      await page.click('#set-audit-more');
      await page.waitForFunction(() => /^1\d\d rows/.test(document.querySelector('.set-audit caption')?.textContent || ''), null, { timeout: T });
      assert.match(audits.at(-1), /^\?limit=100&before=\d+$/);
      // kind=membership, from = through = today (whole UTC days).
      const today = new Date().toISOString().slice(0, 10);
      const next = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      await page.fill('#set-audit-kind', 'membership');
      await page.fill('#set-audit-from', today);
      await page.fill('#set-audit-through', today);
      await page.click('#set-audit-apply');
      await page.waitForFunction(() => /^100 rows/.test(document.querySelector('.set-audit caption')?.textContent || '') && !document.querySelector('#set-section[aria-busy]'), null, { timeout: T });
      assert.equal(audits.at(-1), `?kind=membership&since=${today}&until=${next}&limit=100`);
      assert.deepEqual(await page.evaluate(() => [...new Set([...document.querySelectorAll('.set-audit tbody tr td:nth-child(3)')].map((td) => td.textContent.trim()))]), ['membership.role'], 'the kind narrows');
      // from after through: the server's sentence as served.
      await page.fill('#set-audit-from', next);
      await page.click('#set-audit-apply');
      await page.waitForFunction(() => /^400: /.test(document.getElementById('set-section-status')?.textContent || ''), null, { timeout: T });
      assert.equal(await text(page, '#set-section-status'), '400: since must be before until');
      assert.equal(await page.$('.set-audit'), null, 'no table');
      await noEmail(page, 'ada (audit)');
    } finally { await ctx.close(); }
  });

  await t.test('ada (admin) — leaving: she removes herself once oscar is an admin; the page reloads into bravo, where she is a viewer and nothing is writable', async () => {
    const { page, ctx } = await open(child.base, 'ada');
    try {
      await toSettings(page);
      await toSection(page, 'members');
      await page.click(`[data-member-role="${idOf('oscar')}"]`);
      await page.waitForSelector('.set-editor[data-kind="member"]', { timeout: T });
      await page.click('[data-seg="role"][data-value="admin"]');
      await page.click('#set-editor-save');
      await editorStatus(page, /^oscar: operator → admin\.$/);
      await closeEditor(page);
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-disabled') === null, `[data-member-remove="${idOf('ada')}"]`, { timeout: T });
      await page.click(`[data-member-remove="${idOf('ada')}"]`);
      await page.waitForSelector('#set-editor-confirm', { timeout: T });
      assert.match(await text(page, '#set-editor-confirm-text'), / This is you: you lose access to Acme Corp at once\.$/);
      await Promise.all([page.waitForEvent('load', { timeout: T }), page.click('#set-editor-confirm')]);
      await page.waitForFunction(() => document.body.dataset.mode && document.querySelector('#observa-org'), null, { timeout: 30_000 });
      await page.waitForFunction(() => /bravo/.test(document.querySelector('#observa-org')?.title || ''), null, { timeout: T });
      assert.equal(await page.evaluate(() => localStorage.getItem('studioOrg.v1')), 'bravo', 'reloaded into bravo');
      const html = await page.evaluate(() => document.body.innerHTML);
      for (const l of ['oscar', 'vera']) assert.ok(!html.includes(`<span class="set-row-name">${l}</span>`), `no acme member row: ${l}`);
      const usable = await page.evaluate(() => [...document.querySelectorAll('#layer-view button, #layer-view [role="button"]')]
        .filter((b) => /^(set-primary|svc-add-env|svc-edit-env|home-choice-build|set-rename)$/.test(b.id) || b.matches('[data-edit-env], [data-edit-endpoint], [data-member-role], [data-member-remove]'))
        .filter((b) => b.getAttribute('aria-disabled') !== 'true' && b.getClientRects().length).map((b) => b.id || b.textContent));
      assert.deepEqual(usable, [], 'a viewer in bravo: no usable write control');
    } finally { await ctx.close(); }
  });

  await t.test('vera (viewer), at the phone width: no Edit, Add environment aria-disabled with its reason, the endpoint rows without a URL', async () => {
    const { page, ctx } = await open(child.base, 'vera', { viewport: PHONE });
    try {
      await toSettings(page);
      assert.equal(await page.evaluate(() => document.querySelectorAll('[data-edit-env]').length), 0);
      assert.equal(await attr(page, '#set-primary', 'aria-disabled'), 'true');
      assert.equal(await text(page, '#set-primary .svc-why'), 'needs the operator role in Acme Corp — yours is viewer');
      await toSection(page, 'endpoints');
      assert.match(await text(page, '.set-list'), /gw/);
      const body = await page.evaluate(() => document.body.innerHTML);
      assert.ok(!body.includes('mcp.acme.test/obs'), 'the URL is absent from the DOM');
      assert.ok(!body.includes('ACME_MCP_TOKEN'), 'the variable is absent from the DOM');
      assert.deepEqual(await overflow(page), [], 'the Settings zone fits 390 px');
    } finally { await ctx.close(); }
  });

  await t.test('nora (no org): Advanced → Settings toasts the boot\'s refusal; no mode change', async () => {
    const { page, ctx } = await open(child.base, 'nora');
    try {
      await page.waitForSelector('.svc-noorg', { timeout: T });
      await page.click('.observa-adv-toggle');
      await page.click('.observa-adv-item[data-action="settings"]');
      await page.waitForFunction(() => document.querySelector('#toast')?.hidden === false, null, { timeout: T });
      assert.equal(await text(page, '#toast'), NO_ORG);
      assert.notEqual(await page.evaluate(() => document.body.dataset.mode), 'settings');
    } finally { await ctx.close(); }
  });

  await t.test('the token posture: the banner is the probe\'s text as served, every write aria-disabled with the token reason, no endpoint read from the home; under OBSERVOGRAM_AUTH=off the banner says to restart without it', async () => {
    for (const srv of [tokenChild, tokenOffChild]) {
      const r = await call(null, 'POST', '/api/validate', PAYMENT, { base: srv.base, bearer: TOKEN });
      assert.equal(r.status, 200, r.text);
      const probe = await call(null, 'GET', '/api/org/members', undefined, { base: srv.base });
      assert.equal(probe.status, 403, probe.text);
      const { page, ctx } = await open(srv.base, null);
      try {
        let reads = 0;
        page.on('request', (q) => { if (/\/api\/mcp-endpoints(\?|$)/.test(q.url())) reads++; });
        await page.waitForSelector('.svc-card[data-service="payment-service"]', { timeout: T });
        await page.waitForTimeout(500);
        assert.equal(reads, 0, 'the home reads no endpoint list');
        await page.click('.observa-adv-toggle');
        await page.click('.observa-adv-item[data-action="settings"]');
        await page.waitForSelector('.set-banner.is-token', { timeout: T });
        await settled(page);
        assert.equal(await text(page, '.set-banner'), served(probe));
        if (srv === tokenOffChild) assert.match(await text(page, '.set-banner'), /restart it without OBSERVOGRAM_AUTH=off/);
        else assert.match(await text(page, '.set-banner'), /^403: anonymous callers are viewers here; /);
        for (const section of ['environments', 'endpoints']) {
          if (section !== 'environments') await toSection(page, section);
          assert.equal(await attr(page, '#set-primary', 'aria-disabled'), 'true', section);
          assert.equal(await text(page, '#set-primary .svc-why'), TOKEN_REASON, section);
        }
      } finally { await ctx.close(); }
    }
  });

  await t.test('an open server bound off the loopback: the banner is the server\'s posture text; environments writable; New MCP endpoint closed with its reason; the picker hint has no Settings button', async () => {
    const r = await call(null, 'POST', '/api/validate', PAYMENT, { base: openChild.base });
    assert.equal(r.status, 200, r.text);
    const probe = await call(null, 'GET', '/api/org/members', undefined, { base: openChild.base });
    assert.equal(probe.status, 403, probe.text);
    const { page, ctx } = await open(openChild.base, null);
    try {
      await page.waitForSelector('.svc-card[data-service="payment-service"]', { timeout: T });
      await page.click('.observa-adv-toggle');
      await page.click('.observa-adv-item[data-action="settings"]');
      await page.waitForSelector('.set-banner.is-closed', { timeout: T });
      await settled(page);
      assert.equal(await text(page, '.set-banner'), served(probe));
      assert.equal(await attr(page, '#set-primary', 'aria-disabled'), null, 'Add environment usable');
      assert.ok(await page.evaluate(() => document.querySelectorAll('[data-edit-env]').length) > 0, 'Edit… on every environment');
      await toSection(page, 'endpoints');
      assert.equal(await attr(page, '#set-primary', 'aria-disabled'), 'true');
      assert.equal(await text(page, '#set-primary .svc-why'), CLOSED_REASON);
      await page.click('#set-back');
      await page.waitForFunction(() => document.body.dataset.mode !== 'settings', null, { timeout: T });
      await page.evaluate(() => document.getElementById('mcp-btn').click());
      await page.waitForSelector('#mcp-panel:not([hidden])', { timeout: T });
      await page.waitForTimeout(500);
      assert.equal(await page.$('#mcp-panel [data-mcp-target-settings]'), null, 'no Settings button in a closed posture');
    } finally { await ctx.close(); }
  });

  assert.deepEqual(problems, [], 'no page error and no console.error anywhere in the journey');
});
