#!/usr/bin/env node
/**
 * server/test-services-studio.mjs — the services journey in headless
 * Chromium (docs/STORE_PLAN.md slice 6a, design §12.5): the real studio
 * against a child identity server, driven as the people the fixture names.
 *
 * As oscar (operator): the Services home draws one card per record from
 * the table ("graded by the pack", the pack count); a card opens the
 * service page — the environments as tabs, the verdict pill at prod; the
 * four actions open the workspace bound to the service and the environment
 * (Discover's pack and env selects, the SERVICE chip a button back to the
 * page); the editor's tier save re-reads the verdict (the head, the pill and
 * `GET /api/packs/:id/conformance` all say the record's tier); a second
 * primary of the same service wins everywhere (the card's "2 packs", the
 * page's "current", Discover's pack); DEFINE's slug note offers the origin's
 * name while it still yields the slug, and not after a rename; a Build
 * hand-off survives a table that 500s once (the toast names the unchecked
 * row and blames the table, never the catalogue, Discover still opens the
 * pack); a Build whose name lands under
 * another slug registers a new service and never writes the origin; leaving
 * a Build whose service row was deleted meanwhile lands home with the
 * reason, never stuck in Build. As
 * vera (viewer): the Build card and the three source buttons are
 * aria-disabled with the reason naming the org, the page has no Edit, the
 * empty Discover sentence names an operator. As olive (owner in acme and
 * bravo): the one `.observa-org-select` switcher; a service opened in acme
 * is recorded under acme's recents key alone; a draft started from an acme
 * service page is gone in bravo and back in acme. As nora (no org):
 * the server's refusal and the account menu. The token-only posture (a
 * second child with OBSERVOGRAM_API_TOKEN and no identity): the home's
 * Build card is disabled with the token reason. The phone width (390 px)
 * draws the home, the page and the editor inside the viewport.
 *
 * No page error and no console.error anywhere (tools/test-studio-bundle.mjs
 * T7's rule); nothing leaves the loopback. Skipped unless Playwright imports
 * (OBSERVOGRAM_PLAYWRIGHT, else the bare 'playwright') and Chromium
 * launches; OBSERVOGRAM_SERVICES_SMOKE=require fails instead
 * (server/test-brand-shell.mjs's pattern).
 */
/* global document, window, innerWidth, MutationObserver */

// The two knobs are read before the strip (STRIP carries both so no child
// sees them); the rest of the shell never reaches this process's imports.
const PLAYWRIGHT = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
const REQUIRED = process.env.OBSERVOGRAM_SERVICES_SMOKE === 'require';
const { STRIP, serve, signIn, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();

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
const PAYMENT_V2 = { ...PAYMENT, metadata: { ...PAYMENT.metadata, version: '1.5.1' } };
const TOKEN = 'services-studio-token-secret';
const UNCHECKED = 'The service row was not checked (the table did not refresh).';
const NO_ORG = '403: no org membership — ask an admin to add you';
const TOKEN_REASON = 'needs the operator role — this server takes mutations with its API token only, not from a browser';

// test-services-api's fixture, extended (design §12.5): olive is a member of
// acme and bravo too (the switcher appears) and nora has no org. `default`
// is listed first with olive as its admin: the legacy import makes the
// first org's admins the deployment's owners.
const password = (login) => `${login}-passw0rd-studio`;
const LOGINS = ['olive', 'ada', 'oscar', 'vera', 'bob', 'nora'];
function fixture(ws) {
  writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(password(l)) }])) }, join(ws, 'users.json'));
  writeOrgsFile({
    default: { name: 'Default', members: { olive: 'admin' } },
    acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer', olive: 'admin' } },
    bravo: { name: 'Bravo', members: { bob: 'admin', olive: 'admin' } },
  }, join(ws, 'orgs.json'));
}

async function loadPlaywright() {
  try { return { pw: await import(PLAYWRIGHT) }; }
  catch (e) { return { error: `cannot import ${PLAYWRIGHT}: ${e.message.split('\n')[0]}` }; }
}

const LAPTOP = { width: 1366, height: 800 };
const PHONE = { width: 390, height: 844 };
const T = 15_000;

test('BROWSER: the services journey — the home, the page, the bound workspace, a second primary, the editor, a viewer, the switcher and the scoped draft, a user with no org, the token posture', async (t) => {
  const skip = (why) => { if (REQUIRED) assert.fail(`OBSERVOGRAM_SERVICES_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());

  const ws = mkdtempSync(join(tmpdir(), 'observogram-services-studio-'));
  const wsToken = mkdtempSync(join(tmpdir(), 'observogram-services-studio-token-'));
  fixture(ws);
  const child = await serve(ws);
  const tokenChild = await serve(wsToken, { env: { OBSERVOGRAM_API_TOKEN: TOKEN } });
  t.after(async () => {
    await child.stop();
    await tokenChild.stop();
    rmSync(ws, { recursive: true, force: true });
    rmSync(wsToken, { recursive: true, force: true });
  });

  // ---------- HTTP as a signed-in person (test-services-api's `call`) ----------
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
  async function call(who, method, path, body) {
    const headers = { Accept: 'application/json', 'X-Observogram-CSRF': '1', Cookie: await cookieFor(who), ...(who === 'olive' ? { 'X-Observogram-Org': 'acme' } : {}) };
    let payload;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(`${child.base}${path}`, { method, headers, body: payload, redirect: 'manual' });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  }
  const serviceBySlug = async (slug) => (await call('oscar', 'GET', '/api/services')).json.services.find((s) => s.slug === slug) ?? null;

  // ---------- the browser ----------
  const problems = [];   // every pageerror and console.error, tagged by who was driving
  async function open(base, login, { viewport = LAPTOP } = {}) {
    const ctx = await browser.newContext({ viewport });
    if (login) await ctx.addCookies([{ name: 'observogram_session', value: (await cookieFor(login)).split('=')[1], url: base }]);
    const page = await ctx.newPage();
    const tag = `${login || 'anonymous'}@${viewport.width}`;
    page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
    // "Failed to load resource: …" is Chromium's own line for a request that did not get a 2xx — the aborted
    // off-loopback font links, nora's 403s and the token posture's 404 on /auth/me are the server's answers
    // by design, not a console.error the studio wrote (none of the studio's messages starts so).
    page.on('console', (m) => { if (m.type() === 'error' && !/^Failed to load resource: /.test(m.text())) problems.push(`${tag} console.error: ${m.text()}`); });
    await page.route('**/*', (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
    await page.goto(`${base}/`);
    return { page, ctx };
  }
  const $text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? null, sel);
  const $attr = (page, sel, name) => page.evaluate(([s, n]) => document.querySelector(s)?.getAttribute(n) ?? null, [sel, name]);
  const $value = (page, sel) => page.evaluate((s) => document.querySelector(s)?.value ?? null, sel);
  const $count = (page, sel) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
  const mode = (page) => page.evaluate(() => document.body.dataset.mode);
  const toast = (page) => page.evaluate(() => (document.querySelector('#toast')?.hidden === false ? document.querySelector('#toast').textContent : null));
  // The services zone's elements past the viewport's right edge ([] when every one fits). The zone, not the
  // document: the OBSERVA bar's advanced toggle sits 12 px past a 390 px viewport whenever an org chip is
  // drawn — the chrome's, the same at this branch's base, outside the `.svc-*` zone (reported, not pinned here).
  const ZONE = '#home-services, #home-services *, .svc-page, .svc-page *, .svc-editor, .svc-editor *';
  const overflow = (page) => page.evaluate((zone) => {
    const cw = document.documentElement.clientWidth;
    return [...document.querySelectorAll(zone)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > cw + 1; }).slice(0, 8).map((el) => `${el.tagName}.${el.className}#${el.id}:${Math.round(el.getBoundingClientRect().right)}`);
  }, ZONE);
  const waitPill = (page) => page.waitForFunction(() => { const p = document.querySelector('.svc-panel-verdict .svc-verdict'); return p && !p.classList.contains('is-loading'); }, null, { timeout: T });
  const pill = (page) => $text(page, '.svc-panel-verdict .svc-verdict');
  async function goHome(page) {
    await page.evaluate(() => document.querySelector('.observa-brand').click());
    await page.waitForSelector('#home-services', { state: 'attached', timeout: T });
  }
  async function openPage(page, slug) {
    await page.waitForSelector(`.svc-card[data-service="${slug}"]`, { timeout: T });
    await page.click(`.svc-card[data-service="${slug}"]`);
    await page.waitForSelector('.svc-page', { timeout: T });
  }
  // The switcher: the choice persists, the page reloads, the chip's title names the org and the effective role.
  async function switchOrg(page, org) {
    await page.selectOption('.observa-org-select', org);
    await page.waitForLoadState('load');
    await page.waitForFunction((id) => document.querySelector('#observa-org')?.title === `organisation: ${id} (role: admin)` && document.body.dataset.mode, org, { timeout: T });
  }
  // DEFINE from the service page, on its Service substep.
  async function openBuildFromPage(page) {
    await page.click('#svc-action-build');
    await page.waitForSelector('.build-shell.build-step-define', { timeout: T });
    await page.click('[data-define-sub="service"]');
    await page.waitForSelector('#build-name', { timeout: T });
  }
  // DEFINE → COMPILE → VERIFY → Open pack in Discover, over the http-service entry; resolves once Discover shows with a toast.
  async function handoff(page) {
    await page.click('[data-define-sub="technology"]');
    await page.waitForSelector('.build-chip[data-entry="http-service"]', { timeout: T });
    if (!(await page.$('.build-chip[data-entry="http-service"][aria-pressed="true"]'))) await page.click('.build-chip[data-entry="http-service"]');
    await page.waitForFunction(() => !document.querySelector('#build-next')?.disabled, null, { timeout: T });
    await page.click('#build-next');
    await page.waitForFunction(() => document.querySelector('.build-shell')?.classList.contains('build-step-compile') && !document.querySelector('#build-next')?.disabled, null, { timeout: 30_000 });
    await page.click('#build-next');
    await page.waitForFunction(() => document.querySelector('.build-shell')?.classList.contains('build-step-verify') && document.querySelector('#build-open') && !document.querySelector('#build-open').disabled, null, { timeout: 30_000 });
    await page.click('#build-open');
    await page.waitForFunction(() => document.body.dataset.mode === 'single' && document.querySelector('#toast')?.hidden === false, null, { timeout: 30_000 });
    return toast(page);
  }

  // ---------- the records ----------
  const reg = await call('oscar', 'POST', '/api/validate', PAYMENT);
  assert.equal(reg.status, 200, reg.text);
  const packId = reg.json.registered.id;
  const ledger = await call('oscar', 'POST', '/api/services', { name: 'Ledger' });
  assert.equal(ledger.status, 201, ledger.text);
  const origin = await serviceBySlug('payment-service');
  assert.ok(origin, 'the register wrote the payment-service row');
  assert.equal(origin.tier, null, 'the register sets no tier');

  await t.test('oscar: the home, the page, the bound workspace and the editor', async () => {
    const { page, ctx } = await open(child.base, 'oscar');
    try {
      await page.waitForSelector('.svc-card[data-service="payment-service"]', { timeout: T });
      const meta = await $text(page, '.svc-card[data-service="payment-service"] .svc-gate-meta');
      assert.match(meta, /graded by the pack/, 'a record without a tier is graded by the pack');
      assert.match(meta, /\b1 pack\b/);
      // The card opens the page: the environments as tabs, the verdict at prod.
      await openPage(page, 'payment-service');
      assert.equal(await $text(page, '.svc-page-name'), 'payment-service');
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.svc-tab')].map((x) => x.dataset.env)), ['prod', 'staging'], 'the tablist has the pack\'s environments');
      await page.click('.svc-tab[data-env="prod"]');
      await waitPill(page);
      assert.match(await pill(page), /^(Conformant|Not conformant) · \d+%/);
      // Discover opens bound to the service and the environment; the chip is a button back to the page.
      await page.click('#svc-action-discover');
      await page.waitForFunction((id) => document.querySelector('#pack-select')?.value === id && document.querySelector('#env-select')?.value === 'prod', packId, { timeout: T });
      assert.equal(await page.evaluate(() => document.querySelector('#observa-service')?.tagName), 'BUTTON');
      assert.match(await $text(page, '#observa-service-name'), /payment.service/i);
      await page.click('#observa-service');
      await page.waitForSelector('.svc-page', { timeout: T });
      assert.equal(await mode(page), 'service');
      // The editor: tier-2 saved, the verdict re-read at the record's tier.
      await page.click('#svc-edit');
      await page.waitForSelector('.svc-editor', { timeout: T });
      await page.click('.svc-editor-seg-btn[data-tier="tier-2"]');
      await page.click('#svc-editor-save');
      await page.waitForFunction(() => document.querySelector('#svc-editor-status')?.textContent === 'Saved: tier', null, { timeout: T });
      await page.waitForFunction(() => /tier-2 \(service\)/.test(document.querySelector('.svc-panel-verdict .svc-verdict')?.textContent || ''), null, { timeout: T });
      assert.match(await $text(page, '.svc-page-facts'), /^tier-2 \(service\)/);
      const conf = await call('oscar', 'GET', `/api/packs/${encodeURIComponent(packId)}/conformance?env=prod`);
      assert.equal(conf.status, 200, conf.text);
      assert.equal(conf.json.tier.from, 'service', 'the pack is graded at the record\'s tier');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.svc-editor'), null, { timeout: T });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'svc-edit', 'Escape returns the focus to Edit');
      // A second primary of the same service: the newest wins everywhere.
      const reg2 = await call('oscar', 'POST', '/api/validate', PAYMENT_V2);
      assert.equal(reg2.status, 200, reg2.text);
      const packId2 = reg2.json.registered.id;
      assert.notEqual(packId2, packId);
      // The register came over the API, outside the studio: a reload re-reads the table (the Build hand-off refreshes it itself, below); the reload rehydrates the page, the brand goes home.
      await page.reload();
      await page.waitForSelector('.svc-page', { timeout: T });
      await goHome(page);
      await page.waitForFunction(() => /\b2 packs\b/.test(document.querySelector('.svc-card[data-service="payment-service"] .svc-gate-meta')?.textContent || ''), null, { timeout: T });
      await openPage(page, 'payment-service');
      assert.equal(await $count(page, '.svc-pack-row'), 2);
      assert.equal(await $attr(page, '.svc-pack-row.is-current', 'data-pack-id'), packId2, 'the newest primary is current');
      assert.equal(await $count(page, '.svc-pack-current'), 1);
      await page.click('#svc-action-discover');
      await page.waitForFunction((id) => document.querySelector('#pack-select')?.value === id, packId2, { timeout: T });
      await page.click('#observa-service');
      await page.waitForSelector('.svc-page', { timeout: T });
      // DEFINE's slug note while the origin's name still yields its slug: the sentence and the one-click fix.
      await openBuildFromPage(page);
      assert.equal(await $value(page, '#build-name'), 'payment-service', 'DEFINE is prefilled from the record');
      assert.equal(await $count(page, '#build-origin-note'), 0);
      await page.fill('#build-name', 'Payments Platform');
      await page.waitForSelector('#build-origin-note', { timeout: T });
      assert.match(await $text(page, '#build-origin-note'), /new service "payments-platform", not payment-service/);
      assert.equal(await $text(page, '#build-use-origin-name'), 'use payment-service');
      await page.click('#build-use-origin-name');
      await page.waitForFunction(() => document.querySelector('#build-name')?.value === 'payment-service', null, { timeout: T });
      assert.equal(await $count(page, '#build-origin-note'), 0, 'the note goes once the name yields the slug again');
      // The hand-off over a table that 500s once: the toast says the row was not checked, Discover still opens the pack (A-M8).
      let failed = 0;
      const servicesTable = (u) => /\/api\/services(\?|$)/.test(String(u));   // the loader's path, with or without a query (a URL predicate: no .pathname, tools/test-platform.mjs P4)
      await page.route(servicesTable, (route) => { if (route.request().method() === 'GET' && failed === 0) { failed++; route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"boom"}' }); } else route.continue(); });
      const toasts = [];
      await page.exposeFunction('__servicesToast', (x) => toasts.push(x));
      // Every message toast() set, in order — read off the mutation records (each toast replaces the text node), not the
      // element after the fact: two toasts set in one synchronous run would collapse into the last one.
      await page.evaluate(() => { const el = document.querySelector('#toast'); new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 3 && n.data) window.__servicesToast(n.data); }).observe(el, { childList: true }); });
      await handoff(page);
      assert.equal(failed, 1, 'the table was asked once and refused once');
      assert.ok(toasts.some((x) => x.includes(UNCHECKED)), `the toast names the unchecked row: ${JSON.stringify(toasts)}`);
      // The table's failure stays inside refreshServices(): it must never surface as the catalogue's failure (openInDiscover's
      // older catch would swallow a throw and blame the catalogue — design §7.4 mutation check 9, A-M8).
      const didNotRefresh = toasts.filter((x) => x.includes('Registered, but'));
      assert.ok(didNotRefresh.length > 0, `a toast says what did not refresh: ${JSON.stringify(toasts)}`);
      assert.ok(didNotRefresh.every((x) => x.includes('the services table did not refresh')), `every refresh toast blames the table, never the catalogue: ${JSON.stringify(didNotRefresh)}`);
      assert.equal(await mode(page), 'single');
      assert.ok(await $value(page, '#pack-select'), 'Discover opened the pack');
      await page.unroute(servicesTable);
      const row = await serviceBySlug('payment-service');
      assert.equal(row.packs.filter((p) => p.role === 'primary').length, 3, 'the Build registered a third primary');
      assert.equal(row.tier, 'tier-2', 'the record\'s tier was never overwritten');
      // The table failed its read: the chip is no record button, the home says so and offers a retry that works.
      assert.notEqual(await page.evaluate(() => document.querySelector('#observa-service')?.tagName), 'BUTTON', 'no record to return to while the table is unread');
      await goHome(page);
      assert.match(await $text(page, '#home-services-status'), /The services table could not be read — .*Showing the services the loaded packs name\./);
      await page.click('#home-services-retry');
      await openPage(page, 'payment-service');
      assert.equal(await $count(page, '.svc-pack-row'), 3, 'the page lists the third primary once the table is read again');
      // The rename, with owners: the record keeps its slug.
      await page.click('#svc-edit');
      await page.waitForSelector('.svc-editor', { timeout: T });
      await page.fill('#svc-edit-name', 'Payments Platform');
      await page.fill('#svc-edit-owners', 'team-pay');
      await page.click('#svc-editor-save');
      await page.waitForFunction(() => /^Saved: /.test(document.querySelector('#svc-editor-status')?.textContent || ''), null, { timeout: T });
      const saved = await $text(page, '#svc-editor-status');
      assert.ok(saved.includes('name') && saved.includes('owners'), saved);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.svc-editor'), null, { timeout: T });
      assert.equal(await $text(page, '.svc-page-name'), 'Payments Platform');
      assert.equal(await $text(page, '.svc-page-slug'), 'payment-service');
    } finally {
      await ctx.close();
    }
  });

  await t.test('oscar: a Build whose name lands under another slug registers a new service and never writes the origin', async () => {
    // A fresh context: no kept draft, so DEFINE is prefilled from the renamed record.
    const { page, ctx } = await open(child.base, 'oscar');
    try {
      const before = (await call('oscar', 'GET', `/api/services/${origin.id}`)).json.service;
      assert.deepEqual([before.name, before.owners, before.tier], ['Payments Platform', ['team-pay'], 'tier-2']);
      await openPage(page, 'payment-service');
      await openBuildFromPage(page);
      assert.equal(await $value(page, '#build-name'), 'Payments Platform');
      // The binding survives a reload inside Build: the exit bar still names the page, and leaving lands on it, not home.
      assert.equal(await $text(page, '.build-exit-btn'), '← Back to Payments Platform');
      await page.waitForTimeout(300);   // the persistence debounce (state.mjs schedule, 250 ms)
      await page.reload();
      await page.waitForSelector('.build-shell.build-step-define', { timeout: T });
      assert.equal(await $text(page, '.build-exit-btn'), '← Back to Payments Platform', 'the exit bar names the page after a reload');
      await page.click('.build-exit-btn');
      await page.waitForSelector('.svc-page', { timeout: T });
      assert.equal(await $text(page, '.svc-page-slug'), 'payment-service', 'leaving Build lands on the page it was opened from');
      await openBuildFromPage(page);
      assert.equal(await $value(page, '#build-name'), 'Payments Platform', 'the draft was kept');
      await page.waitForSelector('#build-origin-note', { timeout: T });
      assert.match(await $text(page, '#build-origin-note'), /new service "payments-platform", not payment-service/);
      assert.equal(await $count(page, '#build-use-origin-name'), 0, 'no name of the renamed record yields its slug — no one-click fix');
      await page.fill('#build-owners', 'team-new');
      const said = await handoff(page);
      assert.match(said, /Registered under a new service payments-platform — Payments Platform \(payment-service\) was not linked/);
      const after = (await call('oscar', 'GET', `/api/services/${origin.id}`)).json.service;
      assert.deepEqual([after.name, after.owners, after.tier], ['Payments Platform', ['team-pay'], 'tier-2'], 'the origin is untouched');
      const landed = await serviceBySlug('payments-platform');
      assert.ok(landed, 'the pack registered a new service');
      assert.deepEqual(landed.owners, [], 'nothing was written to the new row either (the plan is empty for another service)');
      assert.equal(landed.packs.filter((p) => p.role === 'primary').length, 1);
      // The chip resolves the open pack's service key against the table (services-model.mjs serviceChipModel):
      // a button to the record the pack landed under — the toast's "Open Payments Platform to compare" is the origin's door.
      assert.match(said, /Open Payments Platform to compare\./);
      await page.click('#observa-service');
      await page.waitForSelector('.svc-page', { timeout: T });
      assert.equal(await $text(page, '.svc-page-slug'), 'payments-platform');
    } finally {
      await ctx.close();
    }
  });

  await t.test('oscar: leaving a Build whose service row was deleted meanwhile lands home and says why', async () => {
    // The honesty rule: a refusal names a way out that works. With the row gone, "← Back to <service>" cannot
    // land on the page (404) — the exit falls back to home and the toast says so, instead of leaving the
    // user in Build with the server's bare `no service <id>`.
    const made = await call('oscar', 'POST', '/api/services', { name: 'Ephemeral' });
    assert.equal(made.status, 201, made.text);
    const { page, ctx } = await open(child.base, 'oscar');
    try {
      await openPage(page, 'ephemeral');
      await openBuildFromPage(page);
      assert.equal(await $text(page, '.build-exit-btn'), '← Back to Ephemeral');
      const gone = await call('oscar', 'DELETE', `/api/services/${made.json.service.id}`);
      assert.equal(gone.status, 200, gone.text);
      await page.click('.build-exit-btn');
      await page.waitForFunction(() => document.body.dataset.mode === 'home', null, { timeout: T });
      assert.match(await toast(page), /^Ephemeral is gone \(404: no service \d+\) — back to home instead\.$/);
      await page.waitForSelector('#home-services', { state: 'attached', timeout: T });
      // The stale binding is dropped with it: a reload lands home, not back in a Build bound to a ghost.
      await page.waitForTimeout(300);   // the persistence debounce (state.mjs schedule, 250 ms)
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.mode === 'home', null, { timeout: T });
    } finally {
      await ctx.close();
    }
  });

  await t.test('oscar at 390 px: the home, the page and the editor inside the viewport', async () => {
    const { page, ctx } = await open(child.base, 'oscar', { viewport: PHONE });
    try {
      await page.waitForSelector('.svc-card[data-service="payment-service"]', { timeout: T });
      await page.waitForTimeout(400);   // the entrance motion settles (200 ms under the kit's rule)
      assert.deepEqual(await overflow(page), [], 'the home');
      await openPage(page, 'payment-service');
      await waitPill(page);
      await page.waitForTimeout(400);
      assert.deepEqual(await overflow(page), [], 'the page');
      await page.click('#svc-edit');
      await page.waitForSelector('.svc-editor', { timeout: T });
      await page.waitForTimeout(400);   // the entry animation's keyframes carry the desktop transform; measure once it settled
      const box = await page.evaluate(() => { const r = document.querySelector('.svc-editor').getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth }; });
      assert.ok(box.left >= 0 && box.right <= box.width, `the dialog sits inside the viewport: ${JSON.stringify(box)}`);
      assert.deepEqual(await overflow(page), [], 'the editor');
    } finally {
      await ctx.close();
    }
  });

  await t.test('vera: the write affordances are disabled with the reason, no Edit, the empty Discover sentence names an operator', async () => {
    const { page, ctx } = await open(child.base, 'vera');
    try {
      await page.waitForSelector('.svc-card[data-service="payment-service"]', { timeout: T });
      for (const sel of ['#home-choice-build', '#home-mcp-connect', '#home-shortcut-upload', '#home-shortcut-crawl']) {
        assert.equal(await $attr(page, sel, 'aria-disabled'), 'true', sel);
      }
      const why = await $text(page, '#home-choice-build .svc-why');
      assert.match(why, /needs the operator role in Acme — yours is viewer/);
      await openPage(page, 'payment-service');
      assert.equal(await $count(page, '.svc-edit'), 0, 'a viewer\'s page has no Edit');
      assert.equal(await $attr(page, '#svc-action-build', 'aria-disabled'), 'true');
      await goHome(page);
      await openPage(page, 'ledger');
      await page.click('#svc-action-discover');
      await page.waitForSelector('.discover-empty', { timeout: T });
      assert.match(await $text(page, '#discover-empty-service'), /an operator scans, drafts, uploads or builds one/);
      assert.equal(await $count(page, '#discover-empty-build'), 0, 'no Build button for a viewer');
    } finally {
      await ctx.close();
    }
  });

  await t.test('olive: one switcher; a draft from an acme service page is gone in bravo and back in acme', async () => {
    const { page, ctx } = await open(child.base, 'olive');
    try {
      // A fresh browser lands in the first membership (default); the switcher is the one in the OBSERVA bar.
      await page.waitForSelector('.home-check-empty', { state: 'attached', timeout: T });   // inside the Check card, collapsed on an empty home
      assert.match(await $text(page, '.home-check-empty'), /^No services in Default yet\./);
      assert.equal(await $count(page, '.observa-org-select'), 1);
      assert.equal(await $count(page, 'select[aria-label="Active organisation"]'), 1, 'the one switcher');
      assert.equal(await $count(page, '#hdr-org, .hdr-org'), 0, 'the context bar\'s copy is gone');
      assert.deepEqual(await page.evaluate(() => [...document.querySelector('.observa-org-select').options].map((o) => o.value)), ['default', 'acme', 'bravo']);
      assert.equal(await $value(page, '.observa-org-select'), 'default');
      assert.equal(await $attr(page, '#observa-org', 'title'), 'organisation: default (role: admin)');
      await switchOrg(page, 'acme');
      await page.waitForSelector('.svc-card[data-service="payment-service"]', { timeout: T });
      assert.equal(await $value(page, '.observa-org-select'), 'acme');
      assert.equal(await $attr(page, '#observa-org', 'title'), 'organisation: acme (role: admin)');
      await openPage(page, 'payment-service');
      // Opening the page records the service under acme's recents key alone (§6.6, A-m2): the default
      // org's key — the legacy key's heir — holds nothing, and bravo's never learns of it.
      const recentsOf = (org) => page.evaluate((k) => Object.keys(JSON.parse(localStorage.getItem(k) || '{}')), `studioRecentServices:${org}`);
      assert.deepEqual(await recentsOf('acme'), ['payment-service'], 'the recents are keyed by the active org');
      assert.deepEqual(await recentsOf('default'), [], 'the default org\'s key is not every org\'s');
      await openBuildFromPage(page);
      assert.equal(await $value(page, '#build-name'), 'Payments Platform', 'DEFINE prefilled from the acme record');
      await page.waitForFunction(() => /Payments Platform/.test(localStorage.getItem('studioState.v2:olive:acme') || ''), null, { timeout: T });
      // bravo: the reload lands on its empty home; DEFINE is empty.
      await switchOrg(page, 'bravo');
      await page.waitForSelector('.home-check-empty', { state: 'attached', timeout: T });   // inside the Check card, collapsed on an empty home
      assert.match(await $text(page, '.home-check-empty'), /^No services in Bravo yet\./);
      assert.equal(await $attr(page, '#observa-org', 'title'), 'organisation: bravo (role: admin)');
      assert.deepEqual(await recentsOf('bravo'), [], 'acme\'s opened service is not a bravo recent');
      await page.click('#home-choice-build');
      await page.waitForSelector('#build-name', { timeout: T });
      assert.equal(await $value(page, '#build-name'), '', 'DEFINE is empty in bravo');
      // back to acme: the draft is where it was left.
      await switchOrg(page, 'acme');
      await page.waitForFunction(() => document.body.dataset.mode === 'build', null, { timeout: T });
      await page.waitForSelector('#build-name', { state: 'attached', timeout: T });
      assert.equal(await $value(page, '#build-name'), 'Payments Platform', 'the acme draft is back');
    } finally {
      await ctx.close();
    }
  });

  await t.test('nora: a signed-in user with no org sees the server\'s refusal and the account menu', async () => {
    const { page, ctx } = await open(child.base, 'nora');
    try {
      await page.waitForSelector('.svc-noorg', { timeout: T });
      assert.ok((await $text(page, '.svc-noorg')).includes(NO_ORG));
      assert.equal(await $count(page, '#hdr-user .hdr-user-btn'), 1, 'the account menu');
      assert.equal(await $count(page, 'pre.json'), 0, 'not the API-unreachable screen');
    } finally {
      await ctx.close();
    }
  });

  await t.test('the token-only posture: the home reads, the Build card is disabled with the token reason', async () => {
    const r = await fetch(`${tokenChild.base}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(PAYMENT) });
    assert.equal(r.status, 200);
    const { page, ctx } = await open(tokenChild.base, null);
    try {
      await page.waitForSelector('.svc-card[data-service="payment-service"]', { timeout: T });
      assert.equal(await $attr(page, '#home-choice-build', 'aria-disabled'), 'true');
      assert.equal(await $text(page, '#home-choice-build .svc-why'), TOKEN_REASON);
      await openPage(page, 'payment-service');
      assert.equal(await $attr(page, '#svc-action-build', 'aria-disabled'), 'true');
      assert.equal(await $count(page, '.svc-edit'), 0);
    } finally {
      await ctx.close();
    }
  });

  assert.deepEqual(problems, [], 'no page error and no console.error anywhere in the journey');
});
