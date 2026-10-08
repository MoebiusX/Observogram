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
 * olive (owner), in one browser: a profile remembers its endpoint per org;
 * leaving bravo, she goes on acting in it as an owner. The owner block (as
 * olive): a new local user's temporary password shown once — not in either
 * storage, a title, an aria-label, a live region or the console, gone at
 * pagehide, after a navigation away and back and after Close — and changed
 * at first sign-in, a reset ending the old flow; the last-owner rule drawn
 * before the server says it, an owner granted; an org with no enabled admin
 * rescued by Act in (D-M) and a removed acting org recovered once at boot;
 * an org created, switched to, and removed with its id typed; the join role,
 * confirm sent for admin only; signing herself out everywhere leaves none of
 * her keys. An open server on the loopback: the first user is the owner the
 * create armed, with no second call. A server behind a reverse proxy: a
 * local user's reset says they cannot sign in here, and what it still does;
 * Enable… and Sign out everywhere… say how each user signs in here (a local
 * one cannot, the proxy's through it — never with a password).
 * A confirm step whose rank went while it was open (an environment's, an
 * endpoint's, a member's, a user's): the 403 keeps the focus inside the
 * dialog and is announced.
 * As vera (viewer): no Edit, no URL; her one org renamed long, the OBSERVA
 * bar fits 320, 360, 390 and 720 px in both themes in every mode — the home,
 * a service page, a pack's views with the SERVICE chip (its name capped,
 * named in full by the button), Settings; Build as oscar. As nora (no org):
 * the boot's refusal.
 * The token posture (with and without OBSERVOGRAM_AUTH=off, and with OIDC
 * configured under it) and an open server bound off the loopback: the
 * banner is the server's text, the writes carry their reasons, the pickers
 * offer no Settings button, and the MCP panel's Server settings button (and
 * off the loopback the picker's hint and its nothing-to-send line) names
 * the server's own way in. An open server on the loopback: once its probe
 * answers 200, the pickers do.
 *
 * Its own fixture (design §12.4 B1): ada is acme's only enabled admin (olive
 * is an owner and an operator there), and ada is a viewer of bravo — she has
 * somewhere to land after leaving acme. No page error and no console.error
 * anywhere; nothing leaves the loopback. Skipped unless Playwright imports
 * (OBSERVOGRAM_PLAYWRIGHT, else the bare 'playwright') and Chromium
 * launches; OBSERVOGRAM_SETTINGS_SMOKE=require fails instead.
 */
/* global document, getComputedStyle, MutationObserver, PageTransitionEvent, window */

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
const TOKEN_READ_REASON = 'needs the admin role and a signed-in user — the banner above names the way in';
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

test('BROWSER: the Settings journey — environments, endpoints and the pickers, members, the audit, a viewer, a user with no org, the token and open-exposed postures; an owner\'s users, organisations and join role', async (t) => {
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
  // gw names a server-held token at a remote origin, and the drift case moves
  // it: both origins listed for the MCP origin rule (server/mcp-target-policy.mjs).
  const child = await serve(ws, { env: { OBSERVOGRAM_MCP_ORIGINS: 'https://mcp.acme.test,https://mcp2.acme.test' } });
  children.push(child);
  const tokenChild = await serve(workspace('token'), { env: { OBSERVOGRAM_API_TOKEN: TOKEN } });
  children.push(tokenChild);
  const tokenOffChild = await serve(workspace('token-off'), { env: { OBSERVOGRAM_API_TOKEN: TOKEN, OBSERVOGRAM_AUTH: 'off' } });
  children.push(tokenOffChild);
  // OBSERVOGRAM_AUTH=off beats OIDC: the token posture still, its way in a restart.
  const tokenOffOidcChild = await serve(workspace('token-off-oidc'), {
    env: { OBSERVOGRAM_API_TOKEN: TOKEN, OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_OIDC_ISSUER: 'https://idp.example.test', OBSERVOGRAM_OIDC_CLIENT_ID: 'studio', OBSERVOGRAM_OIDC_CLIENT_SECRET: 'settings-studio-oidc-secret' },
  });
  children.push(tokenOffOidcChild);
  const openChild = await serve(workspace('open-exposed'), { host: '0.0.0.0', env: { OBSERVOGRAM_INSECURE_NO_AUTH: '1', OBSERVOGRAM_AUTH: 'off' } });
  children.push(openChild);
  const loopChild = await serve(workspace('open-loopback'), { env: { OBSERVOGRAM_AUTH: 'off' } });
  children.push(loopChild);

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
      assert.deepEqual(nav, [['environments', null], ['endpoints', null], ['members', 'true'], ['audit', 'true']], 'the deployment\'s sections are not listed to a non-owner');
      assert.equal(await text(page, '#set-nav-deployment'), 'The deployment');
      assert.equal(await text(page, '#set-nav-no-owner'), "Users, organisations and the join role are an owner's — ask one. (A deployment with no owner gets one from the server's shell: npm run users -- owner <login>.)", 'the no-owner line (D-H)');
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
      // R4 (rebadge batch 3, C0): the server refuses oscar, an operator, a
      // typed URL — GET /api/mcp-endpoints says so — so every picker is
      // list-only: no "Type a URL…", no URL row.
      const GW_OPTIONS = [[String(gwId), 'gw — https://mcp.acme.test', true]];

      // The home's source card (D-J): the select, its label, the URL label.
      await page.waitForSelector('[data-mcp-target="home"] select.set-mcp-target', { state: 'attached', timeout: T });
      assert.deepEqual(await pickerOptions(page, 'home'), GW_OPTIONS);
      assert.equal(await attr(page, '[data-mcp-target="home"] select', 'aria-label'), 'Registered MCP endpoint');
      assert.equal(await page.evaluate(() => document.getElementById('home-mcp-url').closest('label').hidden), true, 'no URL row for a reader who may not type one');
      // D8: the home's Connect tests gw in the live panel and drafts nothing; the unset variable is the server's refusal.
      const pings = posts(page, /\/api\/mcp\/ping$/);
      await page.evaluate(() => document.getElementById('home-mcp-connect').click());
      await page.waitForFunction(() => /^the connection test failed/.test(document.getElementById('home-mcp-status')?.textContent || ''), null, { timeout: T });
      assert.equal(await text(page, '#home-mcp-status'), 'the connection test failed — the live panel says why');
      assert.deepEqual(pings, [{ mcpEndpointId: gwId }], 'the home pings with the id, no mcpUrl');
      assert.match((await text(page, '#live-ping-status')).replace(/^error: 400: /, ''), UNSET);
      assert.equal(await page.isHidden('#live-step-choose'), true, 'no choice without a connected test');
      assert.equal(drafts.length, 0, 'the home posts no draft');
      await page.evaluate(() => document.getElementById('draft-mcp-panel-close').click());

      // The refresh panel.
      await page.evaluate(() => document.getElementById('mcp-btn').click());
      await page.waitForSelector('#mcp-panel:not([hidden]) [data-mcp-target="refresh"] select', { timeout: T });
      assert.deepEqual(await pickerOptions(page, 'refresh'), GW_OPTIONS);
      // test connection (rebadge batch 3, C2) pings with the id; rebuilding production-live is its own button.
      await page.click('#mcp-refresh-btn');
      await page.waitForFunction(() => /^error: /.test(document.getElementById('mcp-ping-status')?.textContent || ''), null, { timeout: T });
      assert.deepEqual(pings.at(-1), { mcpEndpointId: gwId }, 'the ping: the id, no mcpUrl');
      assert.match((await text(page, '#mcp-ping-status')).replace(/^error: 400: /, ''), UNSET);
      await page.click('#mcp-rebuild-btn');
      await page.waitForFunction(() => /^error: /.test(document.getElementById('mcp-rebuild-status')?.textContent || ''), null, { timeout: T });
      assert.deepEqual(refreshes.at(-1), { mcpEndpointId: gwId }, 'the id, no mcpUrl');
      assert.match((await text(page, '#mcp-rebuild-status')).replace(/^error: /, ''), UNSET);
      await page.evaluate(() => document.getElementById('mcp-panel-close').click());

      // The live panel (A6: no "URL required" guard with an endpoint chosen):
      // step 1 tests the connection with the id (rebadge batch 3, C1) — the
      // endpoint's unset variable is the server's refusal, and step 2 stays
      // hidden; the panel never posts a draft itself.
      await page.evaluate(() => document.getElementById('draft-mcp-btn').click());
      await page.waitForSelector('#draft-mcp-panel:not([hidden]) [data-mcp-target="draft"] select', { timeout: T });
      assert.deepEqual(await pickerOptions(page, 'draft'), GW_OPTIONS);
      await page.click('#live-test-btn');
      await page.waitForFunction(() => /^error: /.test(document.getElementById('live-ping-status')?.textContent || ''), null, { timeout: T });
      assert.deepEqual(pings.at(-1), { mcpEndpointId: gwId }, 'the live panel\'s test: the id, no mcpUrl');
      assert.match((await text(page, '#live-ping-status')).replace(/^error: 400: /, ''), UNSET);
      assert.equal(await page.isHidden('#live-step-choose'), true, 'no choice without a connected test');
      assert.equal(drafts.length, 0, 'the panel posts no draft of its own');
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
      // The typed write key is "sent with this request only, never stored" (§0).
      const kept = await page.evaluate((key) => {
        const hits = [];
        for (const [name, store] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
          for (let i = 0; i < store.length; i++) {
            const k = store.key(i);
            if (`${k}\n${store.getItem(k)}`.includes(key)) hits.push(`${name}:${k}`);
          }
        }
        if (document.cookie.includes(key)) hits.push('cookie');
        return hits;
      }, 'write-key-2');
      assert.deepEqual(kept, [], 'the typed MCP write key is never stored');
      assert.deepEqual(await pickerOptions(page, 'deploy'), [[String(gwId), 'gw — https://mcp2.acme.test', true]], 'the option names the new origin');
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
      assert.match(await page.evaluate(() => document.body.textContent), /gw is no longer one of Acme's MCP endpoints — choose another of Acme's MCP endpoints\./);
      assert.ok(!/type a URL/.test(await page.evaluate(() => document.body.textContent)), 'no sentence offers oscar a typed URL');
      assert.equal(rollbacks.length, rollbacksBefore, 'no rollback sent');
      // The list is empty now: the picker names the way in for an operator, and nothing typed is sent.
      await page.waitForFunction(() => /No MCP endpoint is registered in Acme yet — an admin registers them in Settings → MCP endpoints\./.test(document.querySelector('[data-mcp-target="deploy"]')?.textContent || ''), null, { timeout: T });
      assert.equal(await page.evaluate(() => document.getElementById('deploy-target-mcp').closest('label').hidden), true, 'still no URL row');
      await page.evaluate(() => document.getElementById('deploy-modal-close').click());
    } finally {
      await ctx.close();
      // gw again, for the steps that follow (a new id; prod is unbound by the delete). Idempotent: when the body
      // failed before its DELETE ran, gw is still there — kept (its URL put back), so the body's own failure is the
      // one reported, never a 409 from here.
      const kept = (await call('ada', 'GET', '/api/mcp-endpoints')).json?.endpoints?.find((e) => e.name === GW.name);
      if (kept) {
        gwId = kept.id;
        await call('ada', 'PATCH', `/api/mcp-endpoints/${gwId}`, { url: GW.url });
      } else {
        const again = await call('ada', 'POST', '/api/mcp-endpoints', GW);
        assert.equal(again.status, 201, again.text);
        gwId = again.json.endpoint.id;
      }
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
      assert.equal(await text(page, '#deploy-modal-status'), 'Profile "p1" names MCP endpoint "gw" of acme — choose one of Bravo\'s, or type a URL.', 'olive is an owner: she may type a URL (R4)');
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
      // Older rows: before=<next>. The read is held while a kind is typed:
      // its answer repaints the section, and what was typed (not yet
      // applied) stays in its field.
      let release;
      const held = new Promise((r) => { release = r; });
      const hold = async (route) => { await held; await route.fallback(); };
      await page.route(/\/api\/audit\?/, hold);
      await page.click('#set-audit-more');
      await page.waitForSelector('#set-section[aria-busy="true"]', { timeout: T });
      await page.fill('#set-audit-kind', 'membership');
      release();
      await page.waitForFunction(() => /^1\d\d rows/.test(document.querySelector('.set-audit caption')?.textContent || '') && !document.querySelector('#set-section[aria-busy]'), null, { timeout: T });
      await page.unroute(/\/api\/audit\?/, hold);
      assert.match(audits.at(-1), /^\?limit=100&before=\d+$/);
      assert.equal(await page.inputValue('#set-audit-kind'), 'membership', 'a kind typed during a read survives its repaint');
      // kind=membership, from = through = today (whole UTC days).
      const today = new Date().toISOString().slice(0, 10);
      const next = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
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

  await t.test('vera, a one-org member, her org renamed long: the ORG label (no select) carries the whole name, and the OBSERVA bar fits 320, 360, 390 and 720 px in both themes in every mode — the home, a service page, a pack\'s views with the SERVICE chip (Discover, Diagnose, Remediate, every Advanced view), Settings and (oscar) Build', async () => {
    const LONG = 'Acme Corporation Holdings';
    const WIDTHS = [320, 360, PHONE.width, 720];
    // The OBSERVA bar as app.css's comment on the chips' phone cap states it: the bar's own scroll width is the
    // viewport's; every control in it (the brand, the ORG chip, the SERVICE chip where a pack's view shows it, each
    // tab, Advanced, the account menu) inside the viewport, none on top of another, each tab 40 px wide or more; read
    // in the markup's order — the Tab key's, no control in the bar taking a positive tabindex — each control right of
    // the one before on its row or on a row below it, the eye's order (WCAG 1.3.2, 2.4.3); and, on the screens the
    // studio lays out itself (the home, a service page, Settings, Build), no horizontal page scroll. A pack's view
    // draws its own content (a table, a facts list), which the bar never adds to.
    const bar = (page, whole) => page.evaluate((whole) => {
      const cw = document.documentElement.clientWidth;
      const shown = (e) => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const controls = [...document.querySelectorAll('.observa-hdr :is(.observa-brand, #observa-org, #observa-service, .observa-tab, .observa-adv-toggle, .hdr-user-btn)')]
        .filter(shown).map((e) => [e.classList.contains('observa-tab') ? `tab ${e.dataset.view}` : (e.id || e.classList[0]), e.getBoundingClientRect()]);
      const misfits = [];
      for (const [n, r] of controls) {
        if (r.left < 0 || r.right > cw) misfits.push(`${n} outside the viewport: ${Math.round(r.left)}–${Math.round(r.right)}`);
        if (n.startsWith('tab ') && r.width < 40) misfits.push(`${n} ${Math.round(r.width)} px wide`);
      }
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const [[na, a], [nb, b]] = [controls[i], controls[j]];
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) misfits.push(`${na} on top of ${nb}`);
        }
      }
      for (let i = 1; i < controls.length; i++) {
        const [[na, a], [nb, b]] = [controls[i - 1], controls[i]];
        const sameRow = a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
        if (sameRow ? b.left < a.right - 0.5 : b.top < a.bottom - 0.5) misfits.push(`${nb} tabbed to after ${na}, drawn before it`);
      }
      for (const e of document.querySelectorAll('.observa-hdr [tabindex]')) if (e.tabIndex > 0) misfits.push(`${e.id || e.classList[0]} tabindex ${e.tabIndex}`);
      const out = { serviceChip: shown(document.getElementById('observa-service')), bar: document.querySelector('.observa-hdr').scrollWidth, misfits };
      if (whole) out.scroll = document.documentElement.scrollWidth;
      return out;
    }, whole);
    const sweep = async (page, label, { serviceChip, whole }) => {
      const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
      for (const theme of ['light', 'dark']) {
        await page.evaluate((th) => document.documentElement.setAttribute('data-theme', th), theme);
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: PHONE.height });
          assert.deepEqual(await bar(page, whole), { serviceChip, bar: width, misfits: [], ...(whole ? { scroll: width } : {}) }, `${label} at ${width} px, ${theme}`);
        }
      }
      await page.evaluate((th) => { if (th === null) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', th); }, before);
      await page.setViewportSize(PHONE);
    };
    const toView = async (page, id, opener) => {
      await opener();
      await page.waitForFunction((v) => document.body.dataset.view === v && document.body.dataset.mode === 'single', id, { timeout: T });
    };
    assert.equal((await call('olive', 'PATCH', '/api/org', { name: LONG })).status, 200);
    try {
      const { page, ctx } = await open(child.base, 'vera', { viewport: PHONE });
      try {
        await page.waitForFunction(() => document.getElementById('observa-org')?.hidden === false, null, { timeout: T });
        assert.equal(await page.$('.observa-org-select'), null, 'a label, not a switcher');
        assert.equal(await text(page, '#observa-org-name'), LONG, 'the label carries the whole name (assistive technology reads it)');
        await sweep(page, 'the home with a long one-org label', { serviceChip: false, whole: true });
        await openService(page, 'payment-service');
        await sweep(page, 'a service page', { serviceChip: false, whole: true });
        // A pack's views: the SERVICE chip joins the bar, its name capped at the phone width — the button names the
        // service in full, and the context bar's SERVICE select shows it.
        await toView(page, 'layers', () => page.click('#svc-action-discover'));
        await page.waitForFunction(() => document.getElementById('observa-service')?.hidden === false, null, { timeout: T });
        assert.equal(await attr(page, '#observa-service', 'aria-label'), 'Service payment-service — back to its page');
        assert.equal(await text(page, '#observa-service-name'), 'payment-service', 'the chip\'s text is the whole name');
        assert.ok(await page.evaluate(() => { const n = document.getElementById('observa-service-name'); return n.scrollWidth > n.clientWidth; }), 'at the phone width the name is capped (ellipsized)');
        assert.match(await page.evaluate(() => document.querySelector('#service-select option:checked')?.textContent || ''), /payment-service/, 'the context bar\'s SERVICE select shows it in full');
        await sweep(page, 'Discover', { serviceChip: true, whole: false });
        for (const id of ['compare', 'compile']) {
          await toView(page, id, () => page.click(`.observa-tab[data-view="${id}"]`));
          await sweep(page, `the ${id} tab`, { serviceChip: true, whole: false });
        }
        for (const id of ['neuron', 'references', 'conformance', 'schema', 'otlp', 'traceability', 'atlas']) {
          await toView(page, id, async () => { await page.click('.observa-adv-toggle'); await page.click(`.observa-adv-item[data-view="${id}"]`); });
          await sweep(page, `Advanced → ${id}`, { serviceChip: true, whole: false });
        }
        await toSettings(page);
        await sweep(page, 'Settings', { serviceChip: false, whole: true });
      } finally { await ctx.close(); }
      const { page: build, ctx: buildCtx } = await open(child.base, 'oscar', { viewport: PHONE });
      try {
        await build.click('#home-choice-build');
        await build.waitForFunction(() => document.body.dataset.mode === 'build', null, { timeout: T });
        await sweep(build, 'Build', { serviceChip: false, whole: true });
      } finally { await buildCtx.close(); }
    } finally {
      assert.equal((await call('olive', 'PATCH', '/api/org', { name: 'Acme Corp' })).status, 200);
    }
  });

  await t.test('nora (no org): Advanced → Settings toasts the boot\'s refusal; no mode change', async () => {
    const { page, ctx } = await open(child.base, 'nora');
    try {
      await page.waitForSelector('.svc-noorg', { timeout: T });
      await page.click('.observa-adv-toggle');
      assert.equal(await text(page, '.observa-adv-item[data-action="settings"] .observa-adv-item-sub'), 'environments, MCP endpoints, members, the audit, users, organisations, the join role…', 'the menu names every built section');
      await page.click('.observa-adv-item[data-action="settings"]');
      await page.waitForFunction(() => document.querySelector('#toast')?.hidden === false, null, { timeout: T });
      assert.equal(await text(page, '#toast'), NO_ORG);
      assert.notEqual(await page.evaluate(() => document.body.dataset.mode), 'settings');
    } finally { await ctx.close(); }
  });

  await t.test('the token posture: the banner is the probe\'s text as served, every write aria-disabled with the token reason, no endpoint read from the home; the MCP panel\'s Server settings button names the server\'s own way in, read when the panel opens (a failed read names none, and the next opening reads again); under OBSERVOGRAM_AUTH=off, OIDC configured or not, the banner and the button say to restart without it', async () => {
    const AUTH_OFF_WAY = /this server has no sign-in \(OBSERVOGRAM_AUTH=off\): restart it without OBSERVOGRAM_AUTH=off, once a user exists \(npm run users -- add <login>\) or with OIDC configured$/;
    const why = (page) => page.evaluate(() => document.getElementById('mcp-settings-btn')?.dataset.why ?? null);
    const openPanel = async (page) => {
      await page.evaluate(() => document.getElementById('mcp-btn').click());
      await page.waitForSelector('#mcp-panel:not([hidden])', { timeout: T });
      await page.waitForFunction(() => document.getElementById('mcp-settings-btn')?.dataset.why !== 'Checking whether you may configure the MCP server…', null, { timeout: T });
    };
    const closePanel = (page) => page.evaluate(() => document.getElementById('mcp-panel-close').click());
    for (const srv of [tokenChild, tokenOffChild, tokenOffOidcChild]) {
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
        // The Server settings button: GET /api/mcp-endpoints' own sentence
        // (policy.register.why), as the anonymous browser is told it.
        const listed = await call(null, 'GET', '/api/mcp-endpoints', undefined, { base: srv.base });
        assert.equal(listed.status, 200, listed.text);
        const serverWhy = listed.json.policy.register.why;
        if (srv === tokenChild) assert.match(serverWhy, /; this server has no sign-in: add the first user with npm run users -- add <login>, or configure OIDC$/);
        else assert.match(serverWhy, AUTH_OFF_WAY);
        if (srv === tokenOffChild) {
          // A failed read names no way in; the next opening reads again.
          await page.route('**/api/mcp-endpoints', (route) => route.abort());
          await openPanel(page);
          assert.equal(await why(page), 'Could not check whether you may configure the MCP server — close and reopen the panel to try again.');
          await closePanel(page);
          await page.unroute('**/api/mcp-endpoints');
        }
        await openPanel(page);
        assert.equal(await attr(page, '#mcp-settings-btn', 'aria-disabled'), 'true');
        assert.equal(await text(page, '#mcp-settings-btn .svc-why'), `Configuring the MCP server is endpoint configuration: ${serverWhy}.`);
        if (srv !== tokenChild) assert.doesNotMatch(await why(page), /add the first user|, or configure OIDC/, 'never a way OBSERVOGRAM_AUTH=off defeats');
        assert.equal(await page.$('#mcp-panel .set-mcp-target-hint'), null, 'the token posture\'s pickers draw no list, so no hint');
        await closePanel(page);
        await openPanel(page);
        assert.equal(reads, srv === tokenOffChild ? 2 : 1, 'the panel reads the policy once it has answered');
        await closePanel(page);
        await page.click('.observa-adv-toggle');
        await page.click('.observa-adv-item[data-action="settings"]');
        await page.waitForSelector('.set-banner.is-token', { timeout: T });
        await settled(page);
        assert.equal(await text(page, '.set-banner'), served(probe));
        if (srv !== tokenChild) assert.match(await text(page, '.set-banner'), AUTH_OFF_WAY);
        else assert.match(await text(page, '.set-banner'), /^403: anonymous callers are viewers here; /);
        for (const id of ['members', 'audit']) assert.equal(await text(page, `.set-nav-item[data-section="${id}"] .svc-why`), TOKEN_READ_REASON, id);
        for (const section of ['environments', 'endpoints']) {
          if (section !== 'environments') await toSection(page, section);
          assert.equal(await attr(page, '#set-primary', 'aria-disabled'), 'true', section);
          assert.equal(await text(page, '#set-primary .svc-why'), TOKEN_REASON, section);
        }
      } finally { await ctx.close(); }
    }
  });

  await t.test('an open server bound off the loopback: the banner is the server\'s posture text; environments writable; New MCP endpoint closed with its reason; the picker hint has no Settings button — it, the Server settings button and the nothing-to-send line name the server\'s own way in', async () => {
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
      // Nothing registers here while it is exposed: the hint, the button and
      // the line say GET /api/mcp-endpoints' own sentence — never "an admin
      // registers them in Settings → MCP endpoints", which is closed here.
      // This server runs with OBSERVOGRAM_AUTH=off: adding a user arms
      // nothing, so the way in is a restart without it, or loopback.
      const serverWhy = (await call(null, 'GET', '/api/mcp-endpoints', undefined, { base: openChild.base })).json.policy.register.why;
      assert.equal(serverWhy, 'MCP endpoints cannot be registered on a server without sign-in while it is exposed — restart it without OBSERVOGRAM_AUTH=off, once a user exists (npm run users -- add <login>) or with OIDC configured, and sign in as an admin; or bind the server to loopback');
      await page.waitForSelector('#mcp-panel .set-mcp-target-hint', { timeout: T });
      assert.equal(await text(page, '#mcp-panel .set-mcp-target-hint'), `No MCP endpoint is registered in Default yet — ${serverWhy}.`);
      assert.equal(await text(page, '#mcp-settings-btn .svc-why'), `Configuring the MCP server is endpoint configuration: ${serverWhy}.`);
      await page.click('#mcp-refresh-btn');
      await page.waitForFunction(() => /^no MCP endpoint/.test(document.getElementById('mcp-ping-status')?.textContent || ''), null, { timeout: T });
      assert.equal(await text(page, '#mcp-ping-status'), `no MCP endpoint is registered in Default yet — ${serverWhy}`);
    } finally { await ctx.close(); }
  });

  await t.test('an open server on the loopback: the server says local may register (GET /api/mcp-endpoints policy.register), so the picker hint offers Settings → MCP endpoints, and it lands there', async () => {
    const probe = await call(null, 'GET', '/api/org/members', undefined, { base: loopChild.base });
    assert.equal(probe.status, 200, probe.text);
    const { page, ctx } = await open(loopChild.base, null);
    try {
      await page.click('.observa-adv-toggle');
      await page.click('.observa-adv-item[data-action="settings"]');
      await page.waitForSelector('.set-banner', { timeout: T });
      await settled(page);
      assert.match(await text(page, '.set-banner'), /^This server runs without sign-in: you act as local, an owner/);
      await page.click('#set-back');
      await page.waitForFunction(() => document.body.dataset.mode !== 'settings', null, { timeout: T });
      await page.evaluate(() => document.getElementById('mcp-btn').click());
      await page.waitForSelector('#mcp-panel:not([hidden]) [data-mcp-target-settings]', { timeout: T });
      assert.match(await text(page, '#mcp-panel .set-mcp-target-hint'), /^No MCP endpoint is registered in .+ yet\. Settings → MCP endpoints$/);
      await page.click('#mcp-panel [data-mcp-target-settings]');
      await page.waitForFunction(() => document.querySelector('#set-section')?.dataset.section === 'endpoints', null, { timeout: T });
      await settled(page);
      assert.equal(await attr(page, '#set-primary', 'aria-disabled'), null, 'New MCP endpoint usable');
    } finally { await ctx.close(); }
  });

  // R4 + D4 (rebadge batch 3, C0): without sign-in the home never sends a
  // typed URL; with no endpoint its Connect is Register and connect, offered
  // only for an origin the server would accept (loopback, or listed) — the
  // demo URL is refused beside the button, nothing sent; a loopback MCP is
  // registered, then tested by its id in the live panel, which offers Draft or
  // Snapshot (D8).
  await t.test('an open server on the loopback, the home: Register and connect — a remote origin refused beside the button with nothing sent, a loopback MCP registered and tested by mcpEndpointId, then Draft or Snapshot offered (D8)', async () => {
    const { startFakeMcp } = await import('./fixtures/fake-mcp.mjs');
    const fake = await startFakeMcp(['system_health', 'system_topology'], (name) => (name === 'system_health' ? { services: [] } : { dependencies: [] }));
    const { page, ctx } = await open(loopChild.base, null);
    try {
      const registers = posts(page, /\/api\/mcp-endpoints$/);
      const drafts = posts(page, /\/api\/draft-from-mcp$/);
      await page.waitForSelector('#home-choice-check', { timeout: T });
      if (await page.evaluate(() => document.getElementById('home-check')?.hidden)) await page.click('#home-choice-check');
      await page.waitForFunction(() => document.querySelector('#home-mcp-connect .home-mcp-connect-label')?.textContent === 'Register and connect', null, { timeout: T });
      assert.equal(await text(page, 'label.home-mcp-url-row .home-mcp-url-label'), 'MCP URL to register');
      const demo = await page.evaluate(() => document.getElementById('home-mcp-url').value);
      const demoOrigin = new URL(demo).origin;
      assert.equal(await text(page, '#home-mcp-status'), `${demoOrigin} cannot be registered on a server without sign-in — only a loopback MCP or an origin listed in OBSERVOGRAM_MCP_ORIGINS; the server's operator lists it there, or a first user arms sign-in (npm run users -- add <login>)`);
      assert.equal(await attr(page, '#home-mcp-connect', 'aria-disabled'), 'true');
      await page.evaluate(() => document.getElementById('home-mcp-connect').click());   // a click anyway (Playwright will not click aria-disabled)
      await page.waitForTimeout(300);
      assert.deepEqual([registers.length, drafts.length], [0, 0], 'nothing sent for the refused origin');
      await page.fill('#home-mcp-url', fake.url);
      await page.waitForFunction(() => document.getElementById('home-mcp-connect').getAttribute('aria-disabled') === null, null, { timeout: T });
      assert.equal(await text(page, '#home-mcp-status'), '', 'a loopback MCP: the sentence goes');
      const pings = posts(page, /\/api\/mcp\/ping$/);
      await page.click('#home-mcp-connect');
      // D8: Connect tests the connection, then the live panel offers Draft or Snapshot — nothing drafted yet.
      await page.waitForFunction(() => /^connected — /.test(document.getElementById('home-mcp-status')?.textContent || ''), null, { timeout: 30_000 });
      assert.equal(await text(page, '#home-mcp-status'), 'connected — choose Draft or Snapshot in the live panel');
      assert.deepEqual(registers, [{ name: new URL(fake.url).host, url: fake.url }], 'registered once, named by its host');
      const listed = (await call(null, 'GET', '/api/mcp-endpoints', undefined, { base: loopChild.base })).json.endpoints;
      assert.deepEqual(listed.map((e) => e.url), [fake.url]);
      assert.deepEqual(pings, [{ mcpEndpointId: listed[0].id }], 'pinged by its id, never the typed URL');
      assert.equal(drafts.length, 0, 'Connect drafts nothing: the reader chooses');
      assert.equal(await page.isVisible('#draft-mcp-panel'), true, 'the live panel is open');
      assert.equal(await page.isVisible('#live-step-choose'), true, 'step 2 drawn after the connected test');
      assert.equal(await page.isVisible('#live-kind-snapshot'), true, 'Snapshot is offered');
      assert.equal(await page.evaluate(() => document.querySelector('[data-mcp-target="draft"] select')?.value), String(listed[0].id), 'the panel tests the endpoint Connect registered');
      await page.evaluate(() => document.getElementById('draft-mcp-panel-close').click());
      assert.deepEqual(await pickerOptions(page, 'home'), [[String(listed[0].id), `${new URL(fake.url).host} — ${new URL(fake.url).origin}`, true]], 'the home now lists it, list-only');
    } finally {
      await ctx.close();
      await fake.close();
    }
  });

  await t.test('olive (an owner) — leaving bravo: the status says she goes on acting in it, and the reload lands in bravo\'s members, acted in from outside (D-M)', async () => {
    const ctx = await browser.newContext({ viewport: LAPTOP });
    await ctx.addCookies([{ name: 'observogram_session', value: (await cookieFor('olive')).split('=')[1], url: child.base }]);
    try {
      const { page } = await open(child.base, 'olive', { ctx });
      await page.waitForSelector('.observa-org-select', { timeout: T });
      if (await page.evaluate(() => document.querySelector('.observa-org-select').value) !== 'bravo') {
        await Promise.all([page.waitForNavigation(), page.selectOption('.observa-org-select', 'bravo')]);
        await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
      }
      await toSettings(page);
      await toSection(page, 'members');
      await page.click(`[data-member-remove="${idOf('olive')}"]`);
      await page.waitForSelector('#set-editor-confirm', { timeout: T });
      // The status line is drawn just before the reload: kept in sessionStorage as it appears.
      await page.evaluate(() => {
        new MutationObserver(() => {
          const s = document.getElementById('set-editor-status')?.textContent?.trim() || '';
          if (/^You left /.test(s)) sessionStorage.setItem('test.leftOrgText', s);
        }).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await Promise.all([page.waitForEvent('load', { timeout: T }), page.click('#set-editor-confirm')]);
      await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
      assert.equal(await page.evaluate(() => sessionStorage.getItem('test.leftOrgText')),
        'You left Bravo; as an owner you go on acting in it — this browser reloads.');
      await page.waitForSelector('.set-scope', { timeout: T });
      assert.equal(await text(page, '.set-scope'), 'Settings · Bravo (bravo) · you are an owner acting in bravo — not a member');
      assert.equal(await page.evaluate(() => document.querySelector('.observa-org-select option:checked')?.textContent), 'Bravo — acting as owner');
    } finally { await ctx.close(); }
  });

  // ---------- 6b-ii: the owner (design §12.4, C13b) ----------
  // olive is the deployment's only owner (the legacy import made default's
  // admins its owners). Each case opens its own browser unless it says so.
  const usersById = async () => (await call('olive', 'GET', '/api/admin/users')).json.users;
  const userId = async (login) => (await usersById()).find((u) => u.login === login).id;
  const manage = async (page, id) => {
    await page.click(`[data-user-manage="${id}"]`);
    await page.waitForSelector('.set-editor[data-kind="user"] [data-user-action]', { timeout: T });
  };
  const userAct = async (page, action, re) => {
    await page.click(`[data-user-action="${action}"]`);
    await page.waitForSelector('#set-editor-confirm', { timeout: T });
    await page.click('#set-editor-confirm');
    await editorStatus(page, re);
  };
  const closeButton = async (page) => {
    await page.click('#set-editor-host .set-editor-cancel');
    await page.waitForFunction(() => !document.querySelector('#set-editor-host .set-editor'), null, { timeout: T });
  };
  // Every place a password must never be: both storages, every title and
  // aria-label, the toast and every live region, the status line — and the
  // page itself holds it exactly `times` (the dialog's one code element).
  const traces = (page, secret, times) => page.evaluate(([p, n]) => {
    const out = [];
    for (const [name, s] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
      for (let i = 0; i < s.length; i++) if (`${s.key(i)}=${s.getItem(s.key(i))}`.includes(p)) out.push(`${name} ${s.key(i)}`);
    }
    for (const el of document.querySelectorAll('[title], [aria-label]')) {
      if ((el.getAttribute('title') || '').includes(p) || (el.getAttribute('aria-label') || '').includes(p)) out.push(`attribute on ${el.tagName}#${el.id}`);
    }
    for (const el of document.querySelectorAll('#toast, [aria-live], [role="status"], #set-editor-status, #set-section-status')) {
      if (el.textContent.includes(p)) out.push(`text of ${el.tagName}#${el.id}.${el.className}`);
    }
    if (document.title.includes(p) || window.location.href.includes(p)) out.push('the title or the URL');
    const count = document.documentElement.outerHTML.split(p).length - 1;
    if (count !== n) out.push(`${count} copies in the page (want ${n})`);
    return out;
  }, [secret, times]);
  const PASSWORD = /^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){4}$/;
  const LAST_OWNER = 'olive is the last enabled owner — make another user an owner first';

  await t.test('olive (owner) — users: six without an email; New local user nina gets a temporary password shown once and nowhere else, gone after a navigation away and back and after Close; nina must change it; a reset ends her flow', async () => {
    const { page, ctx } = await open(child.base, 'olive');
    const ninaCtx = await browser.newContext({ viewport: LAPTOP });
    try {
      const said = [];   // every console line of this browser, whatever its level
      page.on('console', (m) => said.push(m.text()));
      const writes = [];
      page.on('request', (r) => { if (/\/api\/admin\/users/.test(r.url()) && r.method() !== 'GET') writes.push(r.url().slice(child.base.length).replace(/\/\d+\//, '/:id/')); });
      await toSettings(page);
      await toSection(page, 'users');
      assert.deepEqual((await page.evaluate(() => [...document.querySelectorAll('#set-section [data-user-id] .set-row-name')].map((n) => n.textContent))).sort(), [...LOGINS].sort());
      await noEmail(page, 'olive (users)');
      // New local user nina, viewer in acme.
      await page.click('#set-primary');
      await page.waitForSelector('.set-editor[data-kind="user-create"]', { timeout: T });
      assert.equal(await page.$$eval('#set-editor-host input[type="password"]', (l) => l.length), 0, 'the owner types no password');
      await page.fill('#set-edit-login', 'nina');
      await page.click('[data-seg="role"][data-value="viewer"]');
      await page.selectOption('#set-edit-orgId', 'acme');
      await page.click('#set-editor-save');
      await editorStatus(page, /Copy the temporary password before closing\.$/);
      assert.equal(await text(page, '#set-editor-status'), 'Created nina (viewer in Acme Corp). Copy the temporary password before closing.');
      const first = await text(page, '#set-secret-value');
      assert.equal(first.length, 24);
      assert.match(first, PASSWORD);
      assert.deepEqual(writes, ['/api/admin/users', '/api/admin/users/:id/password'], 'the create, then the reset that makes it temporary');
      assert.deepEqual(await traces(page, first, 1), [], 'shown once and nowhere else');
      assert.deepEqual(said.filter((s) => s.includes(first)), [], 'nothing in the console');
      // Over HTTP: nina must change it, and nothing answers with it.
      const users = await call('olive', 'GET', '/api/admin/users');
      const nina = users.json.users.find((u) => u.login === 'nina');
      assert.equal(nina.mustChange, true);
      assert.ok(!users.text.includes(first));
      // nina signs in with it: the change-password page, forced (no current password asked).
      const ninaPage = await ninaCtx.newPage();
      await ninaPage.route('**/*', (route) => (route.request().url().startsWith(child.base) ? route.fallback() : route.abort()));
      await ninaPage.goto(`${child.base}/auth/login`);
      await ninaPage.fill('#u', 'nina');
      await ninaPage.fill('#p', first);
      await Promise.all([ninaPage.waitForURL(/\/auth\/change-password$/, { timeout: T }), ninaPage.click('button[type="submit"]')]);
      assert.equal(await ninaPage.$$eval('#c', (l) => l.length), 0, 'a forced change: no current password asked');
      // C-4: the pagehide a browser fires before it keeps a page in its
      // back-forward cache empties the dialog. (Playwright's Chromium runs
      // with that cache off, so the event is dispatched here as the browser
      // would; the navigation away and back follows.)
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      assert.equal(await page.$$eval('#set-editor-host .set-editor', (l) => l.length), 0, 'pagehide closed the dialog');
      assert.equal(await page.evaluate((p) => document.documentElement.outerHTML.includes(p), first), false, 'gone at pagehide');
      await page.goto(`${child.base}/api/packs`);
      await page.goBack();
      await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
      assert.equal(await page.evaluate((p) => document.documentElement.outerHTML.includes(p), first), false, 'gone after a navigation away and back');
      assert.equal(await page.$$eval('#set-editor-host .set-editor', (l) => l.length), 0);
      // Reset nina: a new password; Close lets go of it.
      if (await page.evaluate(() => document.body.dataset.mode) !== 'settings') await toSettings(page);
      if (await page.evaluate(() => document.querySelector('#set-section')?.dataset.section) !== 'users') await toSection(page, 'users');
      await manage(page, nina.id);
      await page.click('[data-user-action="reset"]');
      await page.waitForSelector('#set-editor-confirm', { timeout: T });
      assert.equal(await text(page, '#set-editor-confirm-text'), "Reset nina's password? Every session of nina ends; a new temporary password is shown once, and nina sets their own at their next sign-in.");
      await page.click('#set-editor-confirm');
      await editorStatus(page, /^Every session of nina ended; they set a new password at their next sign-in\.$/);
      const second = await text(page, '#set-secret-value');
      assert.match(second, PASSWORD);
      assert.notEqual(second, first);
      assert.deepEqual(await traces(page, second, 1), []);
      await closeButton(page);
      assert.equal(await page.evaluate((p) => document.documentElement.outerHTML.includes(p), second), false, 'gone after Close');
      assert.deepEqual(said.filter((s) => s.includes(first) || s.includes(second)), [], 'nothing in the console');
      // nina's flow cookie from the first password is refused now: back to the sign-in.
      await Promise.all([ninaPage.waitForURL(/\/auth\/login/, { timeout: T }), ninaPage.goto(`${child.base}/auth/change-password`)]);
      const again = await signIn(child.base, 'nina', second);
      assert.deepEqual([again.status, again.json?.mustChange, again.session], [200, true, null], 'the new one is temporary too');
      assert.equal((await signIn(child.base, 'nina', first)).status, 401, 'the first no longer signs in');
    } finally { await ninaCtx.close(); await ctx.close(); }
  });

  await t.test('olive (owner) — the last-owner rule drawn first: her own Disable and Revoke owner aria-disabled with its sentence, her own Reset with its way; Make ada owner, then her Disable is usable', async () => {
    const { page, ctx } = await open(child.base, 'olive', { viewport: PHONE });
    try {
      await toSettings(page);
      await toSection(page, 'users');
      const olive = await userId('olive');
      await manage(page, olive);
      assert.deepEqual(await overflow(page), [], 'the dialog fits the phone');
      for (const a of ['disable', 'owner-revoke']) {
        assert.equal(await attr(page, `[data-user-action="${a}"]`, 'aria-disabled'), 'true', a);
        assert.equal(await text(page, `[data-user-action="${a}"] .svc-why`), LAST_OWNER, a);
      }
      assert.equal(await attr(page, '[data-user-action="reset"]', 'aria-disabled'), 'true');
      assert.equal(await text(page, '[data-user-action="reset"] .svc-why'), 'this is your own account — change your password at /auth/change-password');
      await page.click('[data-user-action="disable"]', { force: true });
      await page.waitForTimeout(200);
      assert.equal(await page.$$eval('#set-editor-confirm', (l) => l.length), 0, 'its click explains, confirms nothing');
      await closeEditor(page);
      await manage(page, await userId('ada'));
      await userAct(page, 'owner-grant', /^ada is an owner/);
      assert.equal(await text(page, '#set-editor-status'), 'ada is an owner (and an admin of default).');
      await closeEditor(page);
      await page.waitForFunction(() => document.querySelectorAll('#set-section .set-badge.is-owner').length === 2, null, { timeout: T });
      await manage(page, olive);
      assert.equal(await attr(page, '[data-user-action="disable"]', 'aria-disabled'), null, 'two owners: hers is usable');
      await closeEditor(page);
    } finally { await ctx.close(); }
  });

  await t.test('olive (owner) — the rescue (D-M): delta has no enabled admin and she is not a member; Act in delta reloads into its members, the head and the ORG chip say she acts as an owner, she adds an admin; the chip back to acme leaves it; a removed acting org recovers once', async () => {
    // The set-up over HTTP: olive creates delta (its first admin), adds bob as
    // admin, leaves it (an owner passes the last-admin rule), disables bob.
    assert.equal((await call('olive', 'POST', '/api/admin/orgs', { id: 'delta', name: 'Delta' })).status, 201);
    assert.equal((await call('olive', 'POST', '/api/org/members', { login: 'bob', role: 'admin' }, { org: 'delta' })).status, 201);
    const deltaMembers = (await call('olive', 'GET', '/api/org/members', undefined, { org: 'delta' })).json.members;
    const inDelta = (login) => deltaMembers.find((m) => m.login === login).userId;
    assert.equal((await call('olive', 'DELETE', `/api/org/members/${inDelta('olive')}`, undefined, { org: 'delta' })).status, 200);
    assert.equal((await call('olive', 'POST', `/api/admin/users/${inDelta('bob')}/disable`, {})).status, 200);
    const { page, ctx } = await open(child.base, 'olive');
    try {
      await toSettings(page);
      await toSection(page, 'orgs');
      assert.equal(await text(page, '[data-org-act="delta"]'), 'Act in delta');
      await Promise.all([page.waitForNavigation({ timeout: T }), page.click('[data-org-act="delta"]')]);
      await page.waitForFunction(() => document.body.dataset.mode === 'settings' && document.querySelector('#set-section')?.dataset.section === 'members', null, { timeout: 30_000 });
      await settled(page);
      assert.equal(await text(page, '.set-scope'), 'Settings · Delta (delta) · you are an owner acting in delta — not a member');
      assert.equal(await page.evaluate(() => document.querySelector('.observa-org-select option:checked')?.textContent), 'Delta — acting as owner');
      // The acting entry is the chip's longest label: at the phone width the OBSERVA bar still scrolls nothing sideways.
      await page.setViewportSize(PHONE);
      assert.deepEqual(await page.evaluate(() => {
        const cw = document.documentElement.clientWidth;
        return { scroll: document.documentElement.scrollWidth, advanced: document.querySelector('.observa-adv-toggle').getBoundingClientRect().right <= cw };
      }), { scroll: PHONE.width, advanced: true }, 'the acting entry at the phone width: no horizontal page scroll, Advanced inside the viewport');
      await page.setViewportSize(LAPTOP);
      await page.click('#set-primary');
      await page.waitForSelector('.set-editor[data-kind="member-add"]', { timeout: T });
      await page.fill('#set-edit-value', 'oscar');
      await page.click('[data-seg="role"][data-value="admin"]');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Added oscar as admin\.$/);
      await closeEditor(page);
      const delta = (await call('oscar', 'GET', '/api/org/members', undefined, { org: 'delta' })).json.members;
      assert.equal(delta.find((m) => m.login === 'oscar')?.role, 'admin', 'delta has an enabled admin again');
      // The chip back to acme leaves the acting org; a reload keeps acme.
      await Promise.all([page.waitForNavigation({ timeout: T }), page.selectOption('.observa-org-select', 'acme')]);
      await page.waitForFunction(() => document.body.dataset.mode === 'settings', null, { timeout: 30_000 });
      await settled(page);
      assert.match(await text(page, '.set-scope'), /^Settings · Acme Corp \(acme\) · /);
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
      assert.equal(await page.evaluate(() => localStorage.getItem('studioOrg.v1')), 'acme');
      assert.equal(await page.evaluate(() => document.querySelector('.observa-org-select')?.value), 'acme');
      // Acting in delta again; then delta is removed elsewhere: the boot recovers once, into a membership.
      await page.evaluate(() => { localStorage.setItem('studioOrg.v1', 'delta'); localStorage.setItem('studioOrgBy.v1', 'olive'); });
      await page.reload();
      await page.waitForFunction(() => document.querySelector('.observa-org-select')?.value === 'delta', null, { timeout: 30_000 });
      assert.equal((await call('olive', 'DELETE', '/api/admin/orgs/delta')).status, 200);
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.mode && localStorage.getItem('studioOrg.v1') && localStorage.getItem('studioOrg.v1') !== 'delta', null, { timeout: 30_000 });
      await page.waitForFunction(() => sessionStorage.getItem('studioActingRecovery.v1') === null, null, { timeout: 30_000 });
      assert.ok(['default', 'acme'].includes(await page.evaluate(() => localStorage.getItem('studioOrg.v1'))), 'one of her memberships');
    } finally { await ctx.close(); }
  });

  await t.test('a shared browser: olive (an owner, not in bravo) signing in after ada (who chose bravo) lands in one of her own memberships, not acting in bravo; her sign-out leaves her login nowhere in the browser', async () => {
    const { page, ctx } = await open(child.base, 'ada');
    try {
      await page.waitForFunction(() => localStorage.getItem('studioOrg.v1') === 'bravo', null, { timeout: T });
      await ctx.clearCookies();
      await ctx.addCookies([{ name: 'observogram_session', value: (await cookieFor('olive')).split('=')[1], url: child.base }]);
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.mode && document.querySelector('.observa-org-select'), null, { timeout: 30_000 });
      const org = await page.evaluate(() => localStorage.getItem('studioOrg.v1'));
      assert.ok(['default', 'acme'].includes(org), `one of her memberships, not ada's bravo: ${org}`);
      assert.equal(await page.evaluate(() => localStorage.getItem('studioOrgBy.v1')), 'olive');
      assert.ok(!(await text(page, '.observa-org-select')).includes('acting as owner'), 'no acting org she never chose');
      // The account menu's sign out: the login beside the saved org goes with her other keys; the org stays, a browser's choice.
      await page.click('.hdr-user-btn');
      await Promise.all([page.waitForURL(/\/auth\/login/, { timeout: T }), page.click('.hdr-user-out')]);
      assert.deepEqual(await page.evaluate(() => [localStorage.getItem('studioOrg.v1'), localStorage.getItem('studioOrgBy.v1')]), [org, null],
        'after sign-out the browser keeps no trace of who signed out (studioOrgBy.v1)');
    } finally { await ctx.close(); }
  });

  await t.test('olive (owner) — organisations: New charlie, Switch to it reloads into its Settings; removed from acme with its id typed and what cannot be undone said, the server\'s note as served; the default org\'s Remove aria-disabled', async () => {
    const { page, ctx } = await open(child.base, 'olive');
    try {
      await page.waitForSelector('.observa-org-select', { timeout: T });
      if (await page.evaluate(() => document.querySelector('.observa-org-select').value) !== 'acme') {
        await Promise.all([page.waitForNavigation({ timeout: T }), page.selectOption('.observa-org-select', 'acme')]);
        await page.waitForFunction(() => document.body.dataset.mode, null, { timeout: 30_000 });
      }
      await toSettings(page);
      await toSection(page, 'orgs');
      assert.equal(await attr(page, '[data-org-remove="default"]', 'aria-disabled'), 'true');
      assert.equal(await text(page, '[data-org-remove="default"] .svc-why'), 'default is the default org and cannot be removed');
      await page.click('#set-primary');
      await page.waitForSelector('.set-editor[data-kind="org-create"]', { timeout: T });
      await page.fill('#set-edit-id', 'charlie');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Created charlie \(charlie\) — you are its first admin; its files live in /);
      // Switch to it (A10): this browser reloads into charlie's Settings.
      await Promise.all([page.waitForNavigation({ timeout: T }), page.click('#set-editor-switch')]);
      await page.waitForFunction(() => document.body.dataset.mode === 'settings' && document.querySelector('#set-section')?.dataset.section === 'members', null, { timeout: 30_000 });
      await settled(page);
      assert.equal(await text(page, '.set-scope'), 'Settings · charlie (charlie) · you are admin, an owner');
      await Promise.all([page.waitForNavigation({ timeout: T }), page.selectOption('.observa-org-select', 'acme')]);
      await page.waitForFunction(() => document.body.dataset.mode === 'settings', null, { timeout: 30_000 });
      await settled(page);
      await toSection(page, 'orgs');
      // Remove charlie (A2): the step says what cannot be undone; the danger button waits for the id.
      await page.click('[data-org-remove="charlie"]');
      await page.waitForSelector('#set-editor-typed', { timeout: T });
      assert.match(await text(page, '#set-editor-confirm-text'), /^Remove charlie \(charlie\)\? This cannot be undone here: no route restores an organisation, and charlie is never used again\. Its 1 member loses access, and its services, environments and MCP endpoints can no longer be reached from the studio\. The files stay under .+\.$/);
      assert.equal(await attr(page, '#set-editor-confirm', 'aria-disabled'), 'true');
      await page.fill('#set-editor-typed', 'charli');
      assert.equal(await attr(page, '#set-editor-confirm', 'aria-disabled'), 'true');
      await page.fill('#set-editor-typed', 'charlie');
      assert.equal(await attr(page, '#set-editor-confirm', 'aria-disabled'), 'false');
      const answer = page.waitForResponse((r) => /\/api\/admin\/orgs\/charlie$/.test(r.url()) && r.request().method() === 'DELETE', { timeout: T });
      await page.click('#set-editor-confirm');
      const note = (await (await answer).json()).note;
      await page.waitForFunction(() => /^Removed charlie/.test(document.getElementById('set-section-status')?.textContent || ''), null, { timeout: T });
      assert.equal(await text(page, '#set-section-status'), `Removed charlie (charlie)${note ? ` — ${note}` : ''}.`);
      await page.waitForSelector('[data-org-id="charlie"].is-removed', { timeout: T });
      assert.equal(await page.$$eval('[data-org-remove="charlie"]', (l) => l.length), 0);
    } finally { await ctx.close(); }
  });

  await t.test('olive (owner) — the join role: the sign-in mode it applies to first; admin needs the box ticked; the PUT bodies carry confirm only for admin', async () => {
    const { page, ctx } = await open(child.base, 'olive');
    try {
      const puts = [];
      page.on('request', (r) => { if (/\/api\/admin\/join-role$/.test(r.url()) && r.method() === 'PUT') puts.push(JSON.parse(r.postData())); });
      await toSettings(page);
      await toSection(page, 'join-role');
      assert.equal(await text(page, '.set-section-scope'), 'Sign-in: local users. The join role applies to IdP users once OIDC is configured: none.');
      await page.click('#set-primary');
      await page.waitForSelector('.set-editor[data-kind="join-role"]', { timeout: T });
      await page.click('[data-seg="role"][data-value="admin"]');
      assert.equal(await attr(page, '#set-editor-save', 'aria-disabled'), 'true');
      assert.equal(await text(page, '#set-editor-save .svc-why'), 'tick the box first');
      await page.click('#set-editor-save', { force: true });
      await page.waitForTimeout(200);
      assert.deepEqual(puts, [], 'nothing sent unticked');
      await page.check('#set-edit-confirm');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Join role: none → admin\.$/);
      await page.click('[data-seg="role"][data-value="operator"]');
      await page.click('#set-editor-save');
      await editorStatus(page, /^Join role: admin → operator\.$/);
      assert.deepEqual(puts, [{ role: 'admin', confirm: true }, { role: 'operator' }], 'confirm rides the admin body only (B14)');
      await closeEditor(page);
      await page.waitForFunction(() => document.getElementById('set-join-role')?.textContent === 'Recorded join role: operator', null, { timeout: T });
    } finally { await ctx.close(); }
  });

  await t.test('olive (owner) — signing herself out everywhere from Users leaves none of her keys in this browser, then offers the sign-in', async () => {
    const { page, ctx } = await open(child.base, 'olive');
    try {
      await toSettings(page);
      await toSection(page, 'users');
      // Her traces as the studio writes them, in two orgs.
      await page.evaluate(() => {
        for (const [k, v] of [['mcpUrl.v2:olive:acme', 'https://mcp.acme.test/obs'], ['mcpEndpoint.v1:olive:acme', '1'], ['deployProfiles.v2:olive', '{}'], ['studioState.v2:olive:acme', '{}'], ['studioState.v2:olive:default', '{}']]) localStorage.setItem(k, v);
      });
      assert.equal(await page.evaluate(() => localStorage.getItem('studioOrgBy.v1')), 'olive', 'the saved org names who chose it');
      await manage(page, await userId('olive'));
      await userAct(page, 'signout', /^You signed out everywhere/);
      assert.equal(await text(page, '#set-editor-status'), 'You signed out everywhere — this browser is signed out at its next request.');
      const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => /^(mcpUrl\.v2:olive:|mcpEndpoint\.v1:olive:|deployProfiles\.v2:olive|studioState\.v2:olive:)/.test(k) || (k === 'studioOrgBy.v1' && localStorage.getItem(k) === 'olive')));
      assert.deepEqual(left, []);
      await Promise.all([page.waitForURL(/\/auth\/login/, { timeout: T }), page.click('#set-editor-signin')]);
    } finally {
      await ctx.close();
      delete cookies.olive;   // every session of olive ended: the next call signs in again
    }
  });

  await t.test('an open server on the loopback — the first user: New local user first is the owner the create armed, no second call, the AUTH=off sentence; New organisation aria-disabled with its reason', async () => {
    const { page, ctx } = await open(loopChild.base, null);
    try {
      const writes = [];
      page.on('request', (r) => { if (/\/api\/admin\/users/.test(r.url()) && r.method() !== 'GET') writes.push(r.url().slice(loopChild.base.length)); });
      await toSettings(page);
      await toSection(page, 'orgs');
      assert.equal(await attr(page, '#set-primary', 'aria-disabled'), 'true');
      assert.match(await text(page, '#set-primary .svc-why'), /^a second organisation needs sign-in, and this server runs without it — /);
      await toSection(page, 'join-role');
      assert.equal(await text(page, '.set-section-scope'), 'This server runs without sign-in (OBSERVOGRAM_AUTH=off). The join role applies to IdP users once it restarts without OBSERVOGRAM_AUTH=off, with OIDC configured: none.');
      await toSection(page, 'users');
      await page.click('#set-primary');
      await page.waitForSelector('.set-editor[data-kind="user-create"]', { timeout: T });
      await page.fill('#set-edit-login', 'first');
      const created = page.waitForResponse((r) => /\/api\/admin\/users$/.test(r.url()) && r.request().method() === 'POST', { timeout: T });
      await page.click('#set-editor-save');
      const answer = await (await created).json();
      assert.deepEqual([answer.owner, answer.armed], [true, true], 'the first local user is the owner, and the create armed sign-in');
      await editorStatus(page, /^first is created/);
      assert.equal(await text(page, '#set-editor-status'), `first is created (an owner: the first local user). This server runs without sign-in (OBSERVOGRAM_AUTH=off): first signs in once it starts without it, with the password below. It is not forced to change — change it at /auth/change-password after signing in.${answer.note ? ` ${answer.note}` : ''}`);
      assert.deepEqual(writes, ['/api/admin/users'], 'no second call');
      const secret = await text(page, '#set-secret-value');
      assert.match(secret, PASSWORD);
      assert.deepEqual(await traces(page, secret, 1), []);
      await closeButton(page);
      assert.equal(await page.evaluate((p) => document.documentElement.outerHTML.includes(p), secret), false);
      // Reset first: nobody signs in here, so the dialog never says "at their next sign-in".
      await page.waitForSelector(`[data-user-manage="${answer.user.id}"]`, { timeout: T });
      await manage(page, answer.user.id);
      await page.click('[data-user-action="reset"]');
      await page.waitForSelector('#set-editor-confirm', { timeout: T });
      assert.equal(await text(page, '#set-editor-confirm-text'), "Reset first's password? Every session of first ends; a new temporary password is shown once. This server runs without sign-in (OBSERVOGRAM_AUTH=off): first signs in once it starts without it, and sets their own then.");
      await page.click('#set-editor-confirm');
      await editorStatus(page, /^Every session of first ended\. /);
      assert.equal(await text(page, '#set-editor-status'), 'Every session of first ended. This server runs without sign-in (OBSERVOGRAM_AUTH=off): first signs in once it starts without it, with the password below, and sets a new one then.');
      assert.equal(await text(page, '.set-secret-text'), 'Temporary password for first — shown once. It is not stored in this browser and cannot be shown again. Reset it to get a new one.');
      const reset = await text(page, '#set-secret-value');
      assert.match(reset, PASSWORD);
      assert.deepEqual(await traces(page, reset, 1), []);
      assert.deepEqual(writes, ['/api/admin/users', `/api/admin/users/${answer.user.id}/password`]);
      await closeButton(page);
    } finally { await ctx.close(); }
  });

  await t.test('a server behind a reverse proxy — pat (an owner by the proxy) resets local lou\'s password: the confirm, the status and the secret say a local user cannot sign in here and what the reset still does, never "at their next sign-in"', async () => {
    const proxyChild = await serve(workspace('proxy'), { env: { OBSERVOGRAM_TRUST_PROXY_AUTH: '1', OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: 'only-the-proxy-reaches-this-port', OBSERVOGRAM_PROXY_AUTH_OWNERS: 'pat' } });
    children.push(proxyChild);
    const PROXY = { 'X-Forwarded-User': 'pat' };
    const made = await fetch(`${proxyChild.base}/api/admin/users`, { method: 'POST', headers: { ...PROXY, Accept: 'application/json', 'X-Observogram-CSRF': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'lou', password: 'abcd-efgh-ijkm-npqr-stuv-wxyz', role: 'operator' }) });
    assert.equal(made.status, 201);
    const lou = (await made.json()).user.id;
    const { page, ctx } = await open(proxyChild.base, 'pat', { ctx: await browser.newContext({ viewport: LAPTOP, extraHTTPHeaders: PROXY }) });
    try {
      const writes = [];
      page.on('request', (r) => { if (/\/api\/admin\/users/.test(r.url()) && r.method() !== 'GET') writes.push(r.url().slice(proxyChild.base.length)); });
      await toSettings(page);
      await toSection(page, 'users');
      await manage(page, lou);
      await page.click('[data-user-action="reset"]');
      await page.waitForSelector('#set-editor-confirm', { timeout: T });
      const line = 'This server signs in through its reverse proxy: a local user cannot sign in here until it runs local sign-in.';
      assert.equal(await text(page, '#set-editor-confirm-text'), `Reset lou's password? ${line} The reset still ends every session of lou, and a new temporary password is shown once — lou signs in with it then, and sets their own.`);
      await page.click('#set-editor-confirm');
      await editorStatus(page, /^Every session of lou ended\. /);
      assert.equal(await text(page, '#set-editor-status'), `Every session of lou ended. ${line} Then lou signs in with the password below, and sets a new one.`);
      assert.equal(await text(page, '.set-secret-text'), 'Temporary password for lou — shown once. It is not stored in this browser and cannot be shown again. Reset it to get a new one.');
      const reset = await text(page, '#set-secret-value');
      assert.match(reset, PASSWORD);
      assert.deepEqual(await traces(page, reset, 1), []);
      assert.deepEqual(writes, [`/api/admin/users/${lou}/password`]);
      // What the sentence says: no local sign-in is served here.
      assert.equal((await fetch(`${proxyChild.base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'u=lou&p=x' })).status, 404);
      await closeButton(page);
    } finally { await ctx.close(); }
  });

  await t.test('a server behind a reverse proxy — Enable… and Sign out everywhere… say how each user signs in here: local lou cannot (no local sign-in is served), quin through the reverse proxy, never with a password; the confirm and the status agree', async () => {
    const pc = await serve(workspace('proxy-users'), { env: { OBSERVOGRAM_TRUST_PROXY_AUTH: '1', OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: 'only-the-proxy-reaches-this-port', OBSERVOGRAM_PROXY_AUTH_OWNERS: 'pat' } });
    children.push(pc);
    const PAT = { 'X-Forwarded-User': 'pat' };
    const api = async (method, path, body, who = PAT) => {
      const r = await fetch(`${pc.base}${path}`, { method, headers: { ...who, Accept: 'application/json', 'X-Observogram-CSRF': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    assert.equal((await api('GET', '/auth/me', undefined, { 'X-Forwarded-User': 'quin' })).json?.authenticated, true, "quin's row, made at first sight");
    const lou = (await api('POST', '/api/admin/users', { login: 'lou', password: 'abcd-efgh-ijkm-npqr-stuv-wxyz', role: 'operator' })).json.user.id;
    const quin = (await api('GET', '/api/admin/users')).json.users.find((u) => u.login === 'proxy://proxy#quin');
    assert.equal(quin?.kind, 'oidc', "a reverse proxy's user is an IdP user");
    for (const id of [lou, quin.id]) assert.equal((await api('POST', `/api/admin/users/${id}/disable`)).status, 200);
    const { page, ctx } = await open(pc.base, 'pat', { ctx: await browser.newContext({ viewport: LAPTOP, extraHTTPHeaders: PAT }) });
    try {
      await toSettings(page);
      await toSection(page, 'users');
      const confirmed = async (id, action, re) => {
        await manage(page, id);
        await page.click(`[data-user-action="${action}"]`);
        await page.waitForSelector('#set-editor-confirm', { timeout: T });
        const confirm = await text(page, '#set-editor-confirm-text');
        await page.click('#set-editor-confirm');
        await editorStatus(page, re);
        const status = await text(page, '#set-editor-status');
        await closeButton(page);
        return [confirm, status];
      };
      const louWhy = 'This server signs in through its reverse proxy: a local user cannot sign in here until it runs local sign-in. Then lou signs in with their password.';
      assert.deepEqual(await confirmed(lou, 'enable', / enabled\./), [`Enable lou? ${louWhy}`, `lou enabled. ${louWhy}`]);
      assert.deepEqual(await confirmed(quin.id, 'enable', / enabled\./), ['Enable proxy://proxy#quin? They can sign in again through the reverse proxy.', 'proxy://proxy#quin enabled.']);
      // Sign out everywhere: "they can sign in again" only for quin, who can.
      assert.deepEqual(await confirmed(lou, 'signout', /^Every session of lou ended/),
        [`Sign lou out everywhere? Every session of lou ends at its next request. ${louWhy}`, `Every session of lou ended. ${louWhy}`]);
      assert.deepEqual(await confirmed(quin.id, 'signout', /^Every session of proxy:\/\/proxy#quin ended/),
        ['Sign proxy://proxy#quin out everywhere? Every session of proxy://proxy#quin ends at its next request; they can sign in again.', 'Every session of proxy://proxy#quin ended.']);
      // What the sentences say: quin is let in by the proxy again; no local sign-in is served for lou.
      assert.equal((await api('GET', '/auth/me', undefined, { 'X-Forwarded-User': 'quin' })).json?.authenticated, true);
      assert.equal((await fetch(`${pc.base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'u=lou&p=x' })).status, 404);
    } finally { await ctx.close(); }
  });

  await t.test('a confirm step whose rank went while it was open — an environment\'s Delete, an endpoint\'s Delete, a member\'s Remove, a user\'s Disable: the 403 redraws the dialog without its danger button, the focus stays inside the dialog and the refusal is announced', async () => {
    // A server of its own: each case demotes the reader over HTTP while the confirm step is open, then restores them.
    const rws = workspace('rank');
    fixture(rws);
    const rank = await serve(rws, { env: { OBSERVOGRAM_MCP_ORIGINS: 'https://mcp.acme.test' } });
    children.push(rank);
    const jar = {};
    const as = async (login) => (jar[login] ||= (await signIn(rank.base, login, password(login))).session);
    const api = async (who, method, path, body) => {
      const headers = { Accept: 'application/json', 'X-Observogram-CSRF': '1', 'X-Observogram-Org': 'acme', Cookie: await as(who) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(`${rank.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    assert.equal((await api('oscar', 'POST', '/api/validate', PAYMENT)).status, 200);
    const env = (await api('oscar', 'GET', '/api/services')).json.services.find((s) => s.slug === 'payment-service').environments.find((e) => e.name === 'prod').id;
    const ep = (await api('ada', 'POST', '/api/mcp-endpoints', { name: 'gw', url: 'https://mcp.acme.test/obs' })).json.endpoint.id;
    const user = Object.fromEntries((await api('olive', 'GET', '/api/admin/users')).json.users.map((u) => [u.login, u.id]));
    const role = async (login, to) => assert.equal((await api('olive', 'PATCH', `/api/org/members/${user[login]}`, { role: to })).status, 200);
    const owner = async (by, login, flag) => assert.equal((await api(by, 'PUT', `/api/admin/users/${user[login]}/owner`, { owner: flag })).status, 200);
    const refused = async (login, section, opening, demote, restore) => {
      const ctx = await browser.newContext({ viewport: LAPTOP });
      await ctx.addCookies([{ name: 'observogram_session', value: (await as(login)).split('=')[1], url: rank.base }]);
      const { page } = await open(rank.base, login, { ctx });
      try {
        await toSettings(page);
        await toSection(page, section);
        await opening(page);
        await page.waitForSelector('#set-editor-confirm', { timeout: T });
        await page.focus('#set-editor-confirm');
        await page.evaluate(() => { document.getElementById('ux-status').textContent = ''; });
        await demote();
        await page.keyboard.press('Enter');
        const refusal = await editorError(page);
        assert.match(refusal, /^403: /, `${login} (${section})`);
        const after = await page.evaluate(() => ({
          confirm: Boolean(document.querySelector('#set-editor-confirm')),
          body: document.activeElement === document.body,
          inside: Boolean(document.activeElement?.closest('#set-editor-host .set-editor[role="dialog"][aria-modal="true"]')),
        }));
        assert.deepEqual(after, { confirm: false, body: false, inside: true }, `${login} (${section}): after the 403 the focus is inside the dialog, never on <body>`);
        await page.waitForFunction((r) => document.getElementById('ux-status')?.textContent === r, refusal, { timeout: T });
      } finally { await ctx.close(); await restore(); }
    };
    await refused('oscar', 'environments', async (page) => {
      await page.click(`[data-edit-env="${env}"]`);
      await page.waitForSelector('.set-editor[data-kind="environment"]', { timeout: T });
      await page.click('#set-editor-delete');
    }, () => role('oscar', 'viewer'), () => role('oscar', 'operator'));
    await refused('ada', 'endpoints', async (page) => {
      await page.click(`[data-edit-endpoint="${ep}"]`);
      await page.waitForSelector('.set-editor[data-kind="endpoint"]', { timeout: T });
      await page.click('#set-editor-delete');
    }, () => role('ada', 'operator'), () => role('ada', 'admin'));
    await refused('ada', 'members', (page) => page.click(`[data-member-remove="${user.vera}"]`), () => role('ada', 'operator'), () => role('ada', 'admin'));
    await owner('olive', 'ada', true);
    await refused('olive', 'users', async (page) => {
      await manage(page, user.bob);
      await page.click('[data-user-action="disable"]');
    }, () => owner('ada', 'olive', false), () => owner('ada', 'olive', true));
  });

  assert.deepEqual(problems, [], 'no page error and no console.error anywhere in the journey');
});
