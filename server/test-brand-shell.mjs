#!/usr/bin/env node
// server/test-brand-shell.mjs — the branding seam at the server: the shell
// routes (GET /, GET /index.html, the SPA fallback) and the auth pages.
//
// Children only (server/fixtures/serve-child.mjs): the brand is read in
// start() from the child's env, so each posture is its own process.
//   DEFAULT  — no brand: every shell path answers studio/index.html byte for
//              byte with the static file headers; GET /index (the old
//              `extensions: ['html']` path) answers the same shell, not a
//              static file; /lib/brand.mjs is served.
//   BRANDED  — OBSERVOGRAM_BRAND_FILE=tools/fixtures/brand/acme.json: every
//              shell path and every auth page (sign-in, change password, the
//              reverse-proxy explainer) names the brand and carries no
//              "Observogram"; the config JSON and the tokens are injected.
//   NAME     — OBSERVOGRAM_BRAND_NAME alone rebrands the whole shell.
//   REFUSED  — a brand file that is not there refuses the start, naming the
//              path (under both spellings).
//   BROWSER  — the branded studio in headless Chromium (skipped without
//              Playwright — OBSERVOGRAM_PLAYWRIGHT names its index.mjs, else the
//              bare 'playwright'; OBSERVOGRAM_BRAND_SMOKE=require fails instead):
//              header, About, footer and the page title read the brand; the
//              rendered text carries no "Observogram".
//
// Run: node --test server/test-brand-shell.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { get as httpGet } from 'node:http';
import { boot, serve, signIn } from './fixtures/serve-child.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHELL = readFileSync(join(ROOT, 'studio/index.html'), 'utf8');
const ACME_FILE = join(ROOT, 'tools/fixtures/brand/acme.json');
const LEAK = /observogram/i;
const SHELL_PATHS = ['/', '/index.html', '/index', '/some/spa/path', '/discover?pack=x'];

const workspace = () => mkdtempSync(join(tmpdir(), 'observogram-brand-shell-'));
const get = async (base, path, headers = {}) => {
  const r = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  return { status: r.status, headers: r.headers, body: await r.text() };
};

test('DEFAULT: every shell path answers studio/index.html byte for byte with the static file headers; /index too; /lib/brand.mjs is served', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } });
  try {
    for (const p of SHELL_PATHS) {
      const r = await get(s.base, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.body, SHELL, `${p}: the shell as on disk`);
      assert.match(r.headers.get('content-type'), /^text\/html; charset=utf-8/i, p);
      assert.ok(r.headers.get('etag'), `${p}: ETag (res.sendFile — the pipeline the static mount used)`);
      assert.ok(r.headers.get('last-modified'), `${p}: Last-Modified`);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=0', p);
      assert.equal(r.headers.get('accept-ranges'), 'bytes', p);
    }
    const root = await get(s.base, '/');
    const named = await get(s.base, '/index.html');
    assert.equal(root.headers.get('etag'), named.headers.get('etag'), 'one file, one ETag');
    // A static asset still comes from the mount, and a conditional GET of the shell still 304s.
    const css = await get(s.base, '/app.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /^text\/css/);
    // (node:http, not fetch: undici adds `cache-control: no-cache` to a conditional request, which `fresh` honours.)
    const cond = await new Promise((res, rej) => httpGet(`${s.base}/`, { headers: { 'If-None-Match': root.headers.get('etag') } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); }).on('error', rej));
    assert.equal(cond, 304, 'a conditional GET of the shell still 304s');
    const lib = await get(s.base, '/lib/brand.mjs');
    assert.equal(lib.status, 200);
    assert.match(lib.headers.get('content-type'), /javascript/);
    assert.ok(lib.body.includes('export function normalizeBrand'));
    // The branded-only head additions are absent.
    assert.ok(!root.body.includes('id="brand-config"') && !root.body.includes('id="brand-tokens"'));
    // The shell's own default strings.
    assert.ok(root.body.includes('<title>Observogram — the Observability Compiler</title>'));
  } finally {
    await s.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('BRANDED (acme file): every shell path and every auth page names the brand and carries no Observogram', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: { OBSERVOGRAM_BRAND_FILE: ACME_FILE } });
  try {
    for (const p of SHELL_PATHS) {
      const r = await get(s.base, p);
      assert.equal(r.status, 200, p);
      assert.doesNotMatch(r.body, LEAK, `${p}: no Observogram in the branded shell`);
      assert.ok(r.body.includes('<title>Acme Watch — the Reliability Console</title>'), p);
      assert.ok(r.body.includes('<h1>Acme<span class="ital">Watch</span></h1>'), p);
      assert.ok(r.body.includes('id="brand-config"') && r.body.includes('id="brand-tokens"') && r.body.includes('<link rel="icon" href="/assets/acme.ico">'), p);
      assert.ok(/<span id="build-label" title="[^"]*">v\d/.test(r.body), `${p}: #build-label kept with its version`);
      assert.equal(r.headers.get('cache-control'), 'no-cache', p);
      assert.match(r.headers.get('content-type'), /^text\/html; charset=utf-8/i, p);
      assert.ok(!r.headers.get('last-modified'), `${p}: a rendering, not a file`);
    }
    const root = await get(s.base, '/');
    const config = JSON.parse(/id="brand-config">([^]*?)<\/script>/.exec(root.body)[1]);
    assert.equal(config.name, 'Acme Watch');
    assert.equal(config.configured, true);
    assert.ok(!JSON.stringify(config).includes(ACME_FILE), 'the config never carries the file path');
    assert.ok(root.body.includes(':root{--og-accent:#b3261e;--og-accent-solid:#f28b82;}'));
    // The sign-in page (local users posture).
    const login = await get(s.base, '/auth/login');
    assert.equal(login.status, 200);
    assert.doesNotMatch(login.body, LEAK);
    assert.ok(login.body.includes('<title>Acme Watch — sign in</title>'));
    assert.ok(login.body.includes('<h1>Acme<i>Watch</i></h1><p>reliability, watched · sign in</p>'));
    assert.ok(login.body.includes('<form method="post" action="/auth/login">'), 'the form is the same form');
    // A failed sign-in re-renders the page with the error — still branded.
    const failed = await fetch(`${s.base}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=wrong',
    });
    const failedBody = await failed.text();
    assert.equal(failed.status, 401);
    assert.doesNotMatch(failedBody, LEAK);
    assert.ok(failedBody.includes('<div class="err">'));
    // The forced password change after the seeded admin/admin sign-in.
    const r = await signIn(s.base, 'admin', 'admin');
    assert.ok(r.status === 200 && r.pwflow, 'admin/admin signs in into the forced change');
    const change = await get(s.base, '/auth/change-password', { Cookie: r.pwflow });
    assert.equal(change.status, 200);
    assert.doesNotMatch(change.body, LEAK);
    assert.ok(change.body.includes('<title>Acme Watch — set a new password</title>'));
    assert.ok(change.body.includes('<h1>Acme<i>Watch</i></h1><p>choose a new password to finish signing in</p>'));
    // The JSON surfaces stay the server's: /healthz and /api/version carry no brand.
    const health = await get(s.base, '/healthz');
    assert.equal(health.status, 200);
    assert.ok(!health.body.includes('Acme'));
  } finally {
    await s.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('BRANDED (proxy mode): the no-sign-in explainer names the brand', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: {
    OBSERVOGRAM_BRAND_FILE: ACME_FILE, OBSERVOGRAM_TRUST_PROXY_AUTH: '1', OBSERVOGRAM_TRUST_PROXY_AUTH_ACK: 'only-the-proxy-reaches-this-port',
  } });
  try {
    const r = await get(s.base, '/auth/login');
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.body, LEAK);
    assert.ok(r.body.includes('<title>Acme Watch — no sign-in page</title>'));
    assert.ok(r.body.includes('<h1>Acme<i>Watch</i></h1><p>reliability, watched · identity from the reverse proxy</p>'));
    assert.ok(r.body.includes('no sign-in page: this server takes identity from its reverse proxy'));
    const shell = await get(s.base, '/', { 'X-Forwarded-User': 'ada' });
    assert.equal(shell.status, 200);
    assert.doesNotMatch(shell.body, LEAK);
  } finally {
    await s.stop();
    rmSync(ws, { recursive: true, force: true });
  }
});

test('NAME: OBSERVOGRAM_BRAND_NAME alone rebrands the whole shell and the sign-in page', async () => {
  const ws = workspace();
  const s = await serve(ws, { env: { OBSERVOGRAM_BRAND_NAME: 'Acme Watch' } });
  try {
    for (const p of ['/', '/index', '/x/y']) {
      const r = await get(s.base, p);
      assert.equal(r.status, 200, p);
      assert.doesNotMatch(r.body, LEAK, `${p}: a one-field brand leaves no Observogram`);
      assert.ok(r.body.includes('<title>Acme Watch — the Observability Compiler</title>'), p);
      assert.ok(r.body.includes('<h1>Acme Watch</h1>'), `${p}: a name without a wordmark split is one word`);
      assert.ok(r.body.includes('<div>Acme Watch · the Observability Compiler · <span id="build-label"'), p);
      assert.ok(!r.body.includes('id="brand-tokens"'), `${p}: no tokens ⇒ no style`);
      assert.ok(!r.body.includes('<link rel="icon"'), `${p}: no favicon ⇒ no link`);
    }
    const login = await get(s.base, '/auth/login');
    assert.doesNotMatch(login.body, LEAK);
    assert.ok(login.body.includes('<h1>Acme Watch</h1><p>the observability compiler · sign in</p>'));
    // The legacy spelling is honoured too.
    const legacy = (await get(s.base, '/')).body;
    assert.ok(legacy.includes('Acme Watch'));
  } finally {
    await s.stop();
    rmSync(ws, { recursive: true, force: true });
  }
  const t = await serve(ws, { env: { TOMOGRAPH_BRAND_NAME: 'Legacy Name' } });
  try {
    assert.ok((await get(t.base, '/')).body.includes('<title>Legacy Name — the Observability Compiler</title>'));
  } finally {
    await t.stop();
  }
});

test('REFUSED: a brand file that is not there refuses the start, naming the path and nothing else', () => {
  const ws = workspace();
  try {
    const missing = join(ws, 'brand.json');
    const r = boot(ws, { env: { OBSERVOGRAM_BRAND_FILE: missing } });
    assert.equal(r.listening, false);
    assert.equal(r.message, `brand file ${missing}: not found`);
    const legacy = boot(ws, { env: { TOMOGRAPH_BRAND_FILE: missing } });
    assert.equal(legacy.listening, false);
    assert.equal(legacy.message, `brand file ${missing}: not found`);
    // A bad token name in the file is refused with the brand's own text.
    const badFile = join(ws, 'bad.json');
    writeFileSync(badFile, JSON.stringify({ tokens: { light: { 'Bad Name': '#fff' } } }));
    const bad = boot(ws, { env: { OBSERVOGRAM_BRAND_FILE: badFile } });
    assert.equal(bad.listening, false);
    assert.equal(bad.message, 'brand: tokens.light.Bad Name is not a design token name');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});


// ---------- BROWSER: the studio chrome in headless Chromium ----------

async function loadPlaywright() {
  const spec = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
  // An absolute path, a Windows one too, is imported as its file URL (import() takes a URL or a package name).
  try { return { pw: await import(isAbsolute(spec) ? pathToFileURL(spec).href : spec) }; }
  catch (e) { return { error: `cannot import ${spec}: ${e.message.split('\n')[0]}` }; }
}

test('BROWSER: the studio header, About card, footer and title read the brand (default and acme), at laptop and phone widths', async (t) => {
  const required = process.env.OBSERVOGRAM_BRAND_SMOKE === 'require';
  const skip = (why) => { if (required) assert.fail(`OBSERVOGRAM_BRAND_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());
  const sizes = [{ width: 1366, height: 800 }, { width: 390, height: 844 }];
  const cases = [
    { label: 'default', env: {}, title: 'Observogram — the Observability Compiler', wordmark: 'OBSERVOGRAM', tagline: 'the observability compiler', aria: 'Observogram home', aboutAria: 'About Observogram', footer: /^Observogram · the Observability Compiler · v/, leak: true, changelog: 'https://github.com/MoebiusX/Observogram/blob/develop/docs/CHANGELOG.md' },
    { label: 'acme', env: { OBSERVOGRAM_BRAND_FILE: ACME_FILE }, title: 'Acme Watch — the Reliability Console', wordmark: 'ACMEWATCH', tagline: 'reliability, watched', aria: 'Acme Watch home', aboutAria: 'About Acme Watch', footer: /^Acme Watch · a product of Acme Corp · v/, leak: false, changelog: 'https://docs.example.com/acme-watch/releases' },
  ];
  for (const c of cases) {
    const ws = workspace();
    const s = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', ...c.env } });
    try {
      for (const viewport of sizes) {
        const where = `${c.label} @${viewport.width}`;
        const page = await browser.newPage({ viewport });
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        // Nothing leaves the loopback (the shell's font links are aborted, not fetched).
        await page.route('**/*', (route) => (route.request().url().startsWith(s.base) ? route.continue() : route.abort()));
        await page.goto(`${s.base}/`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.observa-wordmark', { state: 'attached' });
        assert.equal(await page.title(), c.title, where);
        assert.equal(await page.textContent('.observa-wordmark'), c.wordmark, where);
        assert.equal(await page.textContent('.observa-tagline-home'), c.tagline, where);
        assert.equal(await page.getAttribute('.observa-brand', 'aria-label'), c.aria, where);
        assert.match(await page.getAttribute('.observa-brand', 'title'), new RegExp(`^${c.aria.replace(' home', '')} v`), `${where}: the version tooltip names the brand`);
        assert.match((await page.textContent('footer.ftr')).replace(/\s+/g, ' ').trim(), c.footer, where);
        assert.equal(/observogram/i.test(await page.evaluate('document.body.innerText')), c.leak, `${where}: rendered text`);
        await page.click('.observa-adv-toggle');
        await page.click('button.observa-adv-item:has(#observa-about-sub)');
        await page.waitForSelector('.about-card', { state: 'attached' });
        assert.equal(await page.getAttribute('.about-card', 'aria-label'), c.aboutAria, where);
        assert.equal(await page.textContent('.about-tagline'), c.tagline, where);
        assert.equal(await page.getAttribute('.about-link', 'href'), c.changelog, where);
        assert.equal(/observogram/i.test(await page.textContent('.about-card')), c.leak, `${where}: About`);
        assert.deepEqual(pageErrors, [], where);
        await page.close();
      }
    } finally {
      await s.stop();
      rmSync(ws, { recursive: true, force: true });
    }
  }
});
