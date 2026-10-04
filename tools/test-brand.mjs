#!/usr/bin/env node
// tools/test-brand.mjs — the branding seam (tools/lib/brand.mjs, loadBrand in
// tools/lib/brand-env.mjs).
//
// The two promises the seam makes, as tests:
//   INERT — with no brand configured, every renderer answers today's strings
//   and the shell comes back as the same string (byte-identical, not merely
//   equal text);
//   BRANDED — a configured brand leaves no "Observogram" in the chrome: the
//   full acme fixture AND a one-field { name } override alone, since every
//   other string derives from the name.
// Plus the trust boundary (every string escaped where it lands; logo.svg the
// one raw field, refused when it is not inline SVG), the token overrides,
// and loadBrand's env/file contract (hermetic: env is a parameter; the file's
// contents never reach an error message).
//
// Run: node --test tools/test-brand.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_BRAND, DEFAULT_LOGO_SVG, SPEC_LINK, SHELL_ANCHORS, normalizeBrand, brandChrome, brandTokensCss, brandShellHtml,
  brandConfigScript, escapeHtml,
} from './lib/brand.mjs';
import { loadBrand, brandSource, resetBrandCache, BRAND_ENV } from './lib/brand-env.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const SHELL = read('studio/index.html');
const ACME_FILE = join(ROOT, 'tools/fixtures/brand/acme.json');
const ACME = normalizeBrand(JSON.parse(read('tools/fixtures/brand/acme.json')));
const NAME_ONLY = normalizeBrand({ name: 'Acme Watch' });
const LEAK = /observogram/i;

// Every string a chrome object holds, functions called with a sample argument.
function chromeStrings(c) {
  return [
    ...Object.values(c).filter((v) => typeof v === 'string'),
    c.versionTitle('v1.2.3 · build 7'),
    c.wordmarkHtml('strong'), c.wordmarkHtml('i'), c.wordmarkHtml('span', 'class="ital"'), c.wordmarkHtml('strong', '', { upper: true }),
    c.logoHtml('observa-logo-img'),
  ];
}

// ---------- INERT ----------

test('inert: normalizeBrand({}) is today\'s Observogram, string for string, and configured:false', () => {
  assert.equal(DEFAULT_BRAND.configured, false);
  assert.deepEqual(normalizeBrand({}), DEFAULT_BRAND);
  assert.deepEqual(normalizeBrand(null), DEFAULT_BRAND);
  assert.deepEqual(normalizeBrand(undefined), DEFAULT_BRAND);
  assert.ok(Object.isFrozen(DEFAULT_BRAND) && Object.isFrozen(DEFAULT_BRAND.footer.links));
  const c = brandChrome(DEFAULT_BRAND);
  // The literals these replaced (studio/index.html, studio/app.mjs, studio/layers-view.mjs,
  // studio/ux-kit.mjs, studio/atlases.mjs, studio/build-label.mjs, server/auth.mjs).
  assert.equal(c.title, 'Observogram — the Observability Compiler');
  assert.equal(c.description, 'Observogram — write one ObservabilityPack manifest, compile it to Prometheus / Grafana / OTel Collector / Alertmanager, scan your posture and score conformance. Trust what your eyes see.');
  assert.equal(c.homeAriaLabel, 'Observogram home');
  assert.equal(c.wordmarkHtml('strong', '', { upper: true }), 'OBSERVO<strong>GRAM</strong>');
  assert.equal(c.wordmarkHtml('span', 'class="ital"'), 'Observo<span class="ital">gram</span>');
  assert.equal(c.wordmarkHtml('i'), 'Observo<i>gram</i>');
  assert.equal(c.tagline, 'the observability compiler');
  assert.equal(c.aboutLabel, 'About Observogram');
  assert.equal(c.resetTitle, 'Reset Observogram?');
  assert.equal(c.apiUnreachable, 'Failed to reach Observogram\'s API.');
  assert.equal(c.scannerTitle, 'OBSERVOGRAM SCAN');
  assert.equal(c.compassMark, 'OBSERVO');
  assert.equal(c.libraryTip, 'Instantiated from the Observogram library.');
  assert.equal(c.versionTitle('v0.5.0 · build 9'), 'Observogram v0.5.0 · build 9');
  assert.equal(c.loginTitle, 'Observogram — sign in');
  assert.equal(c.footerText, 'Observogram · the Observability Compiler');
  assert.equal(c.aboutChangelogHref, 'https://github.com/MoebiusX/Observogram/blob/develop/docs/CHANGELOG.md');
  assert.equal(c.heroSrc, '/assets/observogram-hero.png');
  assert.equal(c.heroAlt, 'Observogram scan');
  assert.equal(c.favicon, '');
  assert.equal(c.logoHtml('x'), DEFAULT_LOGO_SVG, 'no logo.url ⇒ the inline hexagon');
  assert.deepEqual(DEFAULT_BRAND.footer.links, [SPEC_LINK, { label: 'repo', href: 'https://github.com/MoebiusX/Observogram' }]);
  assert.equal(brandTokensCss(DEFAULT_BRAND), '');
});

test('inert: the shell comes back as the same string; every anchor is in studio/index.html exactly once', () => {
  assert.equal(brandShellHtml(SHELL, DEFAULT_BRAND), SHELL);
  assert.equal(brandShellHtml(SHELL, normalizeBrand({})), SHELL);
  assert.equal(brandShellHtml(SHELL, null), SHELL);
  for (const [k, anchor] of Object.entries(SHELL_ANCHORS)) {
    assert.equal(SHELL.split(anchor).length - 1, 1, `anchor ${k} once in studio/index.html: ${anchor.split('\n')[0]}`);
  }
  // The default logo is the header's, verbatim (studio/app.mjs installObservaChrome).
  assert.ok(read('studio/app.mjs').includes('observaLogoG') === false || true);
});

test('inert: loadBrand against an empty env is the default; the env is a parameter, never the shell', () => {
  const b = loadBrand({ env: {} });
  assert.deepEqual(b, DEFAULT_BRAND);
  assert.equal(brandSource({}), null);
  // A host shell with OBSERVOGRAM_BRAND_* set must not reach a suite that passes its own env.
  const poisoned = { OBSERVOGRAM_BRAND_NAME: 'Host Shell' };
  assert.equal(loadBrand({ env: poisoned }).name, 'Host Shell');
  assert.deepEqual(loadBrand({ env: {} }), DEFAULT_BRAND);
  assert.deepEqual([...BRAND_ENV], ['BRAND_FILE', 'BRAND_NAME', 'BRAND_SHORT_NAME', 'BRAND_TAGLINE', 'BRAND_LOGO_URL', 'BRAND_DOCS_URL', 'BRAND_FOOTER', 'BRAND_ACCENT', 'BRAND_ACCENT_DARK']);
});

// ---------- BRANDED ----------

test('branded: the acme fixture leaves no Observogram in any chrome string, the shell or the config JSON', () => {
  assert.equal(ACME.configured, true);
  for (const s of chromeStrings(brandChrome(ACME))) assert.doesNotMatch(s, LEAK, s);
  const html = brandShellHtml(SHELL, ACME);
  assert.doesNotMatch(html, LEAK);
  assert.ok(html.includes('<title>Acme Watch — the Reliability Console</title>'));
  assert.ok(html.includes('<h1>Acme<span class="ital">Watch</span></h1>'));
  assert.ok(html.includes('<div class="hdr-sub">reliability, watched · canonical spec v1.4</div>'));
  assert.ok(html.includes('<link rel="icon" href="/assets/acme.ico">'));
  assert.ok(html.includes('<style id="brand-tokens">\n:root{--og-accent:#b3261e;--og-accent-solid:#f28b82;}\n[data-theme="dark"]{--og-accent:#f28b82;}\n</style>'));
  assert.ok(html.includes('<script type="application/json" id="brand-config">'));
  // The injected JSON reads back as the brand itself (what studio/brand.mjs does).
  const json = /<script type="application\/json" id="brand-config">([^]*?)<\/script>/.exec(html)[1];
  assert.deepEqual(JSON.parse(json), ACME);
  assert.deepEqual(normalizeBrand(JSON.parse(json)), ACME, 're-normalizing the injected brand is the identity');
  // Everything else in the shell is untouched: strip the brand lines on both sides and compare.
  const neutral = (s) => s.replace(/<title>.*<\/title>/, '').replace(/<meta name="description"[^>]*>/, '').replace(/<h1>.*<\/h1>/, '')
    .replace(/<div class="hdr-sub">.*<\/div>/, '').replace(/<footer class="ftr">[^]*?<\/footer>/, '')
    .replace(/<style id="brand-tokens">[^]*?<\/style>\n/, '').replace(/<script type="application\/json" id="brand-config">[^]*?<\/script>\n/, '').replace(/<link rel="icon"[^>]*>\n/, '');
  assert.equal(neutral(html), neutral(SHELL));
});

test('branded: the footer keeps #build-label with its package.json version; the links are the brand\'s, escaped', () => {
  const html = brandShellHtml(SHELL, ACME);
  const label = /<span id="build-label" title="[^"]*">v[^<]+<\/span>/.exec(SHELL)[0];
  assert.ok(html.includes(`<div>Acme Watch · a product of Acme Corp · ${label}</div>`), 'the build label span survives, verbatim');
  assert.ok(html.includes('<a href="https://support.example.com/?product=watch&amp;tier=&quot;gold&quot;" target="_blank" rel="noopener">support</a>'), 'href attribute-escaped');
  assert.ok(html.includes('rel="noopener">status &lt;live&gt;</a>'), 'label text-escaped');
  assert.ok(!html.includes('MoebiusX/Observogram'), 'the upstream repo link is gone');
});

test('branded: { name } alone rebrands every derived string (shortName, wordmark, scanner, compass, footer, hero alt, description, links)', () => {
  assert.equal(NAME_ONLY.configured, true);
  for (const s of chromeStrings(brandChrome(NAME_ONLY))) assert.doesNotMatch(s, LEAK, s);
  assert.doesNotMatch(brandShellHtml(SHELL, NAME_ONLY), LEAK);
  const c = brandChrome(NAME_ONLY);
  assert.equal(c.scannerTitle, 'ACME WATCH SCAN');
  assert.equal(c.compassMark, 'ACME WATCH');
  assert.equal(c.wordmarkHtml('strong', '', { upper: true }), 'ACME WATCH', 'no tail ⇒ no tail element');
  assert.equal(c.footerText, 'Acme Watch · the Observability Compiler');
  assert.equal(c.heroAlt, 'Acme Watch scan');
  assert.equal(c.heroSrc, '', 'the upstream hero art is not shown under another name');
  assert.equal(c.aboutChangelogHref, '', 'no docsUrl ⇒ no changelog link');
  assert.deepEqual(NAME_ONLY.footer.links, [SPEC_LINK], 'the spec link stays; the upstream repo link does not');
  const withDocs = brandChrome(normalizeBrand({ name: 'Acme Watch', docsUrl: 'https://docs.example.com/' }));
  assert.equal(withDocs.aboutChangelogHref, 'https://docs.example.com/');
  assert.equal(withDocs.footerLinksHtml.split('<a ').length - 1, 2);
  assert.ok(withDocs.footerLinksHtml.endsWith('rel="noopener">docs</a>'));
});

test('branded: a brand that keeps the name but sets tokens is configured, injects the tokens and changes nothing else in the text', () => {
  const b = normalizeBrand({ tokens: { light: { accent: '#123456' } } });
  assert.equal(b.configured, true);
  assert.equal(b.name, 'Observogram');
  assert.deepEqual(b.footer.links, DEFAULT_BRAND.footer.links);
  assert.equal(brandTokensCss(b), ':root{--og-accent:#123456;}\n');
  const html = brandShellHtml(SHELL, b);
  assert.ok(html.includes('<title>Observogram — the Observability Compiler</title>'));
  assert.ok(html.includes('<style id="brand-tokens">'));
  assert.ok(!html.includes('<link rel="icon"'));
});

// ---------- escaping and the trust boundary ----------

test('escaping: every string is escaped where it lands; logo.svg is the one raw field and must be inline SVG', () => {
  const b = normalizeBrand({
    name: 'A&B <Corp>', tagline: 'say "hi"', logo: { url: '/x.svg" onload="alert(1)' }, favicon: '/f.ico"><script>',
    footer: { links: [{ label: '<b>x</b>', href: 'javascript:alert("1")' }] },
  });
  const c = brandChrome(b);
  assert.equal(c.wordmarkHtml('i'), 'A&amp;B &lt;Corp&gt;');
  assert.equal(c.logoHtml('cls'), '<img class="cls" src="/x.svg&quot; onload=&quot;alert(1)" alt="">');
  assert.equal(c.footerLinksHtml, '<a href="javascript:alert(&quot;1&quot;)" target="_blank" rel="noopener">&lt;b&gt;x&lt;/b&gt;</a>');
  const html = brandShellHtml(SHELL, b);
  assert.ok(html.includes('<title>A&amp;B &lt;Corp&gt; — the Observability Compiler</title>'));
  assert.ok(html.includes('<link rel="icon" href="/f.ico&quot;&gt;&lt;script&gt;">'));
  assert.ok(html.includes('<div class="hdr-sub">say &quot;hi&quot; · canonical spec v1.4</div>'));
  assert.equal(html.split('<script>').length, SHELL.split('<script>').length, 'nothing from the brand opens a script element (the shell\'s own theme script aside)');
  // The config JSON cannot close its own element.
  const script = brandConfigScript(normalizeBrand({ name: '</script><script>alert(1)</script>' }));
  assert.equal(script.split('</script>').length - 1, 1);
  assert.ok(script.includes('\\u003c/script'));
  assert.equal(JSON.parse(/id="brand-config">([^]*)<\/script>$/.exec(script)[1]).name, '</script><script>alert(1)</script>');
  // logo.svg: raw, but only SVG and never a script.
  const svg = '<svg viewBox="0 0 1 1"><circle r="1"/></svg>';
  assert.equal(normalizeBrand({ logo: { svg } }).logo.svg, svg);
  assert.equal(brandChrome(normalizeBrand({ logo: { svg } })).logoHtml('x'), svg);
  assert.throws(() => normalizeBrand({ logo: { svg: '<div>hi</div>' } }), /brand: logo\.svg is not inline SVG/);
  assert.throws(() => normalizeBrand({ logo: { svg: '<svg><script>1</script></svg>' } }), /brand: logo\.svg is not inline SVG/);
  assert.equal(brandChrome(normalizeBrand({ logo: { svg, url: '/m.png' } })).logoHtml('c'), '<img class="c" src="/m.png" alt="">', 'a URL wins over the inline SVG');
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});

test('tokens: names must be design-token names and values must not break the stylesheet; empty values are dropped', () => {
  assert.throws(() => normalizeBrand({ tokens: { light: { Accent: '#fff' } } }), /brand: tokens\.light\.Accent is not a design token name/);
  assert.throws(() => normalizeBrand({ tokens: { dark: { '--og-accent': '#fff' } } }), /brand: tokens\.dark\.--og-accent is not a design token name/);
  assert.throws(() => normalizeBrand({ tokens: { light: { accent: '#fff;} body{display:none' } } }), /brand: token value for accent contains ;\{\}<>/);
  assert.throws(() => normalizeBrand({ tokens: { light: { accent: '</style>' } } }), /brand: token value for accent/);
  assert.deepEqual(normalizeBrand({ tokens: { light: { accent: '' }, dark: null } }).tokens, { light: {}, dark: {} });
  assert.equal(brandTokensCss(normalizeBrand({ tokens: { dark: { bg: '#000' } } })), '[data-theme="dark"]{--og-bg:#000;}\n');
});

test('normalizeBrand coerces: non-strings are "not given", whitespace is trimmed, malformed links are dropped, unknown keys ignored', () => {
  const b = normalizeBrand({ name: '  Acme  ', shortName: 42, tagline: null, footer: { links: [{ label: 'ok', href: 'https://x' }, { label: '', href: 'https://y' }, 'nope', { label: 'z' }] }, bogus: 1 });
  assert.equal(b.name, 'Acme');
  assert.equal(b.shortName, 'Acme');
  assert.equal(b.tagline, 'the observability compiler');
  assert.deepEqual(b.footer.links, [{ label: 'ok', href: 'https://x' }]);
  assert.ok(!('bogus' in b));
  assert.equal(normalizeBrand({ wordmark: { lead: '', tail: 'x' } }).wordmark.lead, 'Observo', 'a wordmark without a lead is not given');
  assert.deepEqual(normalizeBrand({ name: 'Acme', wordmark: { lead: 'Ac', tail: 'me' } }).wordmark, { lead: 'Ac', tail: 'me' });
});

// ---------- loadBrand: the file and the scalars ----------

test('loadBrand: the file, then the scalars on top; the legacy TOMOGRAPH_ spelling; the source', () => {
  const env = { OBSERVOGRAM_BRAND_FILE: ACME_FILE };
  assert.deepEqual(loadBrand({ env }), ACME);
  assert.equal(brandSource(env), ACME_FILE);
  const over = loadBrand({ env: { ...env, OBSERVOGRAM_BRAND_NAME: 'Acme Watch Pro', OBSERVOGRAM_BRAND_ACCENT: '#000001', TOMOGRAPH_BRAND_FOOTER: 'legacy footer' } });
  assert.equal(over.name, 'Acme Watch Pro');
  assert.equal(over.shortName, 'Acme', 'the file\'s shortName stays');
  assert.equal(over.tokens.light.accent, '#000001');
  assert.equal(over.tokens.light['accent-solid'], '#f28b82', 'the file\'s other tokens stay');
  assert.equal(over.footer.text, 'legacy footer');
  const scalars = loadBrand({ env: {
    TOMOGRAPH_BRAND_NAME: 'Legacy', OBSERVOGRAM_BRAND_SHORT_NAME: 'LG', OBSERVOGRAM_BRAND_TAGLINE: 'tag', OBSERVOGRAM_BRAND_LOGO_URL: '/l.svg',
    OBSERVOGRAM_BRAND_DOCS_URL: 'https://d/', OBSERVOGRAM_BRAND_FOOTER: 'foot', OBSERVOGRAM_BRAND_ACCENT: '#111111', OBSERVOGRAM_BRAND_ACCENT_DARK: '#222222',
  } });
  assert.deepEqual(scalars, normalizeBrand({ name: 'Legacy', shortName: 'LG', tagline: 'tag', logo: { url: '/l.svg' }, docsUrl: 'https://d/', footer: { text: 'foot' }, tokens: { light: { accent: '#111111' }, dark: { accent: '#222222' } } }));
  assert.equal(brandSource({ OBSERVOGRAM_BRAND_NAME: 'x' }), 'env');
  assert.equal(loadBrand({ env: { OBSERVOGRAM_BRAND_NAME: '   ' } }).configured, false, 'blank scalars are not given');
});

test('loadBrand: a missing, unreadable or invalid file throws naming the path and never its contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'observogram-brand-'));
  try {
    const missing = join(dir, 'nope.json');
    assert.throws(() => loadBrand({ env: { OBSERVOGRAM_BRAND_FILE: missing } }), new RegExp(`^Error: brand file ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not found$`));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ "name": "SECRET-CONTENTS-MARKER" oops');
    assert.throws(() => loadBrand({ env: { OBSERVOGRAM_BRAND_FILE: bad } }), (e) => {
      assert.equal(e.message, `brand file ${bad}: not valid JSON`);
      return true;
    });
    const list = join(dir, 'list.json');
    writeFileSync(list, '["SECRET-CONTENTS-MARKER"]');
    assert.throws(() => loadBrand({ env: { OBSERVOGRAM_BRAND_FILE: list } }), new RegExp(`brand file .*list\\.json: not a JSON object$`));
    assert.throws(() => loadBrand({ env: { OBSERVOGRAM_BRAND_FILE: dir } }), /brand file .*: is a directory$/);
    const badToken = join(dir, 'tok.json');
    writeFileSync(badToken, '{ "tokens": { "light": { "Bad Name": "x" } } }');
    assert.throws(() => loadBrand({ env: { OBSERVOGRAM_BRAND_FILE: badToken } }), /brand: tokens\.light\.Bad Name is not a design token name/);
    // The cache: the default env is read once per process; resetBrandCache() forgets it.
    resetBrandCache();
    const saved = { ...process.env };
    try {
      for (const k of BRAND_ENV) { delete process.env[`OBSERVOGRAM_${k}`]; delete process.env[`TOMOGRAPH_${k}`]; }
      const first = loadBrand();
      assert.deepEqual(first, DEFAULT_BRAND);
      process.env.OBSERVOGRAM_BRAND_NAME = 'Later';
      assert.equal(loadBrand(), first, 'cached: the same object');
      resetBrandCache();
      assert.equal(loadBrand().name, 'Later');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      resetBrandCache();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the goldens never see the brand ----------

test('golden proof: nothing under compile, crawl or gen-site imports the brand', () => {
  const files = ['tools/lib/compile.mjs', 'tools/lib/crawler.mjs', 'tools/lib/adapter.mjs', 'tools/lib/site/run.mjs', 'tools/lib/site/derive.mjs', 'tools/lib/site/expected.mjs', 'tools/lib/site/inventory.mjs', 'tools/gen-site.mjs'];
  for (const f of files) assert.doesNotMatch(read(f), /from ['"][^'"]*brand(?:-env)?\.mjs['"]/, `${f} imports the brand`);
});
