#!/usr/bin/env node
// server/test-glossary-shell.mjs — the glossary marks (GAP batch 2, B3.4)
// in the real studio, headless Chromium against child servers
// (server/fixtures/serve-child.mjs; modelled on server/test-brand-shell.mjs,
// so no strip loop wipes OBSERVOGRAM_PLAYWRIGHT or OBSERVOGRAM_GLOSSARY_SMOKE).
//
//   V2           — OBSERVOGRAM_TAXONOMY=tools/fixtures/taxonomy/taxonomy.v2.json:
//                  the Discover board's group titles and head facts carry the
//                  marks; the keyboard opens one (Enter), Escape closes it and
//                  hands the focus back; hover previews the definition; in the
//                  drawer the kind row carries one and Escape closes the mark
//                  first and the drawer only on the second press; at 1366×800
//                  and 390×844; no page error, nothing off the loopback.
//   V1           — the v1 fixture: a configured taxonomy, zero marks.
//   UNCONFIGURED — no taxonomy: zero marks.
//
// Skipped without Playwright (OBSERVOGRAM_PLAYWRIGHT names its index.mjs,
// else the bare 'playwright'); OBSERVOGRAM_GLOSSARY_SMOKE=require fails instead.
//
// Run: node --test server/test-glossary-shell.mjs

/* global document */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../tools/lib/mini-yaml.mjs';
import { SPEC_DIR } from '../tools/lib/validator.mjs';
import { serve } from './fixtures/serve-child.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const V1 = join(ROOT, 'tools/fixtures/taxonomy/taxonomy.json');
const V2 = join(ROOT, 'tools/fixtures/taxonomy/taxonomy.v2.json');
const PAYMENT = parseYaml(readFileSync(join(ROOT, SPEC_DIR, 'examples/payment-service.pack.yaml'), 'utf8'));
const SIZES = [{ width: 1366, height: 800 }, { width: 390, height: 844 }];

const workspace = () => mkdtempSync(join(tmpdir(), 'observogram-glossary-shell-'));

async function loadPlaywright() {
  const spec = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
  try { return { pw: await import(spec) }; }
  catch (e) { return { error: `cannot import ${spec}: ${e.message.split('\n')[0]}` }; }
}

// Register the vendored example on the child and open it the way a user does:
// Check → the service card → the service page → Discover (bound to the service and its first environment).
async function openPayment(page, base) {
  const r = await fetch(`${base}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(PAYMENT) });
  const j = await r.json();
  assert.equal(j.ok, true, JSON.stringify(j.errors));
  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.svc-gate-card[data-service="payment-service"]', { state: 'attached', timeout: 30_000 });
  // The gate opens on the service records in every posture (STORE_PLAN slice 6a): the Check branch is already
  // open when the table has the row — the card toggles it, so only open it when it is still closed.
  if (await page.getAttribute('#home-choice-check', 'aria-expanded') !== 'true') await page.click('#home-choice-check');
  await page.click('.svc-gate-card[data-service="payment-service"]');
  // The card opens the service page (STORE_PLAN slice 6a); Discover is its first action.
  await page.waitForSelector('.svc-page .svc-action[data-view="layers"]', { state: 'attached', timeout: 30_000 });
  await page.click('.svc-page .svc-action[data-view="layers"]');
  await page.waitForSelector('#layer-view .dv-layer[data-layer="L1"] .dvb-group', { state: 'attached', timeout: 30_000 });
}

// Nothing leaves the loopback: the shell's Google Fonts links are aborted,
// not fetched (and the one console line that abort prints is not a problem).
function watch(page, base) {
  const problems = [];
  const offLoopback = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: net::ERR_FAILED/.test(m.text())) problems.push(`console.error: ${m.text()}`); });
  return {
    problems,
    offLoopback,
    route: (route) => (route.request().url().startsWith(base) ? route.continue() : (offLoopback.push(route.request().url()), route.abort())),
    aborted: () => offLoopback.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)),
  };
}

test('BROWSER: a v2 taxonomy draws the marks on Discover and in the drawer — keyboard toggle, Escape precedence over the drawer, hover preview; a v1 or unconfigured server draws none', async (t) => {
  const required = process.env.OBSERVOGRAM_GLOSSARY_SMOKE === 'require';
  const skip = (why) => { if (required) assert.fail(`OBSERVOGRAM_GLOSSARY_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());

  // ---- V2: the marks, at both widths ----
  {
    const ws = workspace();
    const s = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_TAXONOMY: V2 } });
    try {
      for (const viewport of SIZES) {
        const where = `v2 @${viewport.width}`;
        const page = await browser.newPage({ viewport });
        const w = watch(page, s.base);
        await page.route('**/*', w.route);
        await openPayment(page, s.base);
        // The board: the SLIs and SLOs · targets titles and the head's Criticality fact carry a mark; the definitions are hidden.
        const titles = await page.evaluate(() => [...document.querySelectorAll('#layer-view .dvb-group-title')].filter((h) => h.querySelector('.ux-gloss')).map((h) => h.firstChild.textContent));
        assert.ok(titles.includes('SLIs') && titles.includes('SLOs · targets') && titles.includes('Exporters & storage') && titles.includes('Operational alert rules'), `${where}: group titles with a mark: ${titles.join(', ')}`);
        assert.ok(await page.$('#layer-view .dvb-fact dt .ux-gloss'), `${where}: a head fact carries a mark`);
        const sliBtn = page.locator('#layer-view .dv-layer[data-layer="L1"] .dvb-group[data-group="sli"] .dvb-group-title .ux-gloss-btn');
        assert.equal(await sliBtn.getAttribute('aria-label'), 'What is SLIs?', where);
        assert.equal(await sliBtn.getAttribute('aria-expanded'), 'false', where);
        const defId = await sliBtn.getAttribute('aria-controls');
        assert.equal(await sliBtn.getAttribute('aria-describedby'), defId, where);
        const def = page.locator(`#${defId}`);
        assert.equal(await def.getAttribute('role'), 'note', where);
        assert.equal(await def.isVisible(), false, `${where}: hidden until opened`);
        assert.equal(await page.evaluate(() => document.querySelectorAll('#layer-view .ux-gloss-btn[title]').length), 0, `${where}: no mark is a tooltip`);
        // Keyboard: focus the button, Enter opens, the definition is visible and read; Escape closes it and the focus is back on the button.
        await sliBtn.focus();
        await page.keyboard.press('Enter');
        assert.equal(await sliBtn.getAttribute('aria-expanded'), 'true', `${where}: Enter opens`);
        assert.equal(await def.isVisible(), true, where);
        assert.match(await def.textContent(), /^Service level indicator A measurement of how the service behaves/, where);
        await page.keyboard.press('Escape');
        assert.equal(await sliBtn.getAttribute('aria-expanded'), 'false', `${where}: Escape closes`);
        assert.notEqual(await def.getAttribute('hidden'), null, `${where}: the definition is hidden again`);
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'What is SLIs?', `${where}: the focus is back on the mark`);
        assert.equal(await def.isVisible(), true, `${where}: still previewed while the mark keeps the keyboard focus`);
        await page.evaluate(() => document.activeElement?.blur());
        assert.equal(await def.isVisible(), false, `${where}: gone once the focus leaves`);
        // Hover previews the definition without opening it.
        await page.mouse.move(0, 0);
        await sliBtn.hover();
        assert.equal(await def.isVisible(), true, `${where}: hover previews`);
        assert.equal(await sliBtn.getAttribute('aria-expanded'), 'false', `${where}: a preview is not an open mark`);
        await page.mouse.move(0, 0);
        // A click opens; a click elsewhere closes.
        await sliBtn.click();
        assert.equal(await sliBtn.getAttribute('aria-expanded'), 'true', where);
        await page.click('#layer-view .dvb-lede');
        assert.equal(await sliBtn.getAttribute('aria-expanded'), 'false', `${where}: an outside click closes`);
        // The drawer: open an SLI tile; the kind row carries the mark; Escape closes the mark first, the drawer second.
        await page.click('#layer-view .dv-layer[data-layer="L1"] .dvb-group[data-group="sli"] .dvb-item');
        await page.waitForSelector('#drawer[aria-hidden="false"]', { state: 'attached', timeout: 10_000 });
        const kind = page.locator('#drawer-meta dd .ux-gloss-btn').first();
        assert.equal(await kind.getAttribute('aria-label'), 'What is Service level indicator?', where);
        assert.equal(await page.evaluate(() => [...document.querySelectorAll('#drawer-meta dt')].map((d) => d.textContent)[0]), 'kind', `${where}: the kind row leads the strip`);
        await kind.click();
        assert.equal(await kind.getAttribute('aria-expanded'), 'true', where);
        const kindDef = page.locator(`#${await kind.getAttribute('aria-controls')}`);
        assert.equal(await kindDef.isVisible(), true, where);
        await page.keyboard.press('Escape');
        assert.equal(await kind.getAttribute('aria-expanded'), 'false', `${where}: Escape closes the mark`);
        assert.notEqual(await kindDef.getAttribute('hidden'), null, where);
        assert.equal(await page.getAttribute('#drawer', 'aria-hidden'), 'false', `${where}: the drawer stays open`);
        await page.keyboard.press('Escape');
        assert.equal(await page.getAttribute('#drawer', 'aria-hidden'), 'true', `${where}: the second Escape closes the drawer`);
        assert.deepEqual(w.problems, [], where);
        assert.deepEqual(w.aborted(), [], `${where}: nothing but the shell's font links tried to leave the loopback`);
        await page.close();
      }
    } finally {
      await s.stop();
      rmSync(ws, { recursive: true, force: true });
    }
  }

  // ---- V1 and UNCONFIGURED: not one mark ----
  for (const c of [{ label: 'v1', env: { OBSERVOGRAM_TAXONOMY: V1 } }, { label: 'unconfigured', env: {} }]) {
    const ws = workspace();
    const s = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', ...c.env } });
    try {
      const page = await browser.newPage({ viewport: SIZES[0] });
      const w = watch(page, s.base);
      await page.route('**/*', w.route);
      await openPayment(page, s.base);
      const tax = await page.evaluate(async () => (await fetch('/api/taxonomy')).json());
      assert.equal(tax.configured, c.label === 'v1', c.label);
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ux-gloss').length), 0, `${c.label}: zero marks on Discover`);
      await page.click('#layer-view .dv-layer[data-layer="L1"] .dvb-group[data-group="sli"] .dvb-item');
      await page.waitForSelector('#drawer[aria-hidden="false"]', { state: 'attached', timeout: 10_000 });
      assert.equal(await page.evaluate(() => document.querySelectorAll('.ux-gloss').length), 0, `${c.label}: zero marks in the drawer`);
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('#drawer-meta dt')].map((d) => d.textContent).includes('kind')), false, `${c.label}: no kind row`);
      await page.keyboard.press('Escape');
      assert.equal(await page.getAttribute('#drawer', 'aria-hidden'), 'true', `${c.label}: Escape closes the drawer at once`);
      assert.deepEqual(w.problems, [], c.label);
      assert.deepEqual(w.aborted(), [], c.label);
      await page.close();
    } finally {
      await s.stop();
      rmSync(ws, { recursive: true, force: true });
    }
  }
});
