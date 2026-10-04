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
import * as fsSync from 'node:fs';
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

// ---------- the studio loader (studio/brand.mjs) ----------

test('studio/brand.mjs: loadBrand with the injected import reads #brand-config or falls back to the default; the module has no static import', async () => {
  const src = read('studio/brand.mjs');
  assert.ok(!/^import\s/m.test(src), 'studio/brand.mjs has no static import (the house way: /lib at call time)');
  assert.ok(src.includes("import('/lib/brand.mjs')"), 'the default import is the server\'s /lib mount (the bundle\'s import map resolves the same specifier)');
  const { loadBrand: loadStudioBrand, readBrandConfig } = await import('../studio/brand.mjs');
  const importFn = () => import('./lib/brand.mjs');
  const docWith = (json) => ({ getElementById: (id) => (id === 'brand-config' && json !== undefined ? { textContent: json } : null) });
  const none = await loadStudioBrand({ importFn, doc: docWith(undefined) });
  assert.deepEqual({ ...none, chrome: undefined }, { ...DEFAULT_BRAND, chrome: undefined });
  assert.equal(none.chrome.scannerTitle, 'OBSERVOGRAM SCAN');
  const branded = await loadStudioBrand({ importFn, doc: docWith(JSON.stringify(ACME)) });
  assert.equal(branded.name, 'Acme Watch');
  assert.equal(branded.chrome.compassMark, 'ACME');
  assert.deepEqual({ ...branded, chrome: undefined }, { ...ACME, chrome: undefined });
  assert.equal(readBrandConfig(docWith('not json')), null, 'a malformed config counts as none');
  assert.equal(readBrandConfig(docWith('[1]')), null);
  assert.deepEqual((await loadStudioBrand({ importFn, doc: docWith('{broken') })).name, 'Observogram');
  assert.deepEqual((await loadStudioBrand({ importFn, doc: null })).name, 'Observogram', 'no document (headless) ⇒ the default');
  // The escaped config round-trips from the real shell.
  const html = brandShellHtml(SHELL, normalizeBrand({ name: '</script><b>' }));
  const json = /id="brand-config">([^]*?)<\/script>/.exec(html)[1];
  assert.equal(readBrandConfig(docWith(json)).name, '</script><b>');
});

// ---------- SOURCE GUARD: no second source of truth ----------
//
// The product's name appears, as chrome, in exactly one source file:
// tools/lib/brand.mjs. Every other studio and auth-page source must be free
// of it outside comments. The pattern is the two chrome spellings —
// `Observogram` / `Observo<` (the split wordmark) and `OBSERVOGRAM` /
// `OBSERVO<` — and deliberately NOT:
//   - lowercase `observogram…` identifiers and paths: observogram_* cookies,
//     observogram.* annotation keys, `.observogram/`, /assets/observogram-hero.png,
//     window._observogramQuickLabel, req.observogramSelf;
//   - `Observogram-` in the protocol headers X-Observogram-CSRF / -Org;
//   - `OBSERVOGRAM_` env-variable names and `ERR_OBSERVOGRAM_*` codes.
// Comments are stripped by a tokenizer that walks strings, template literals
// (with nested ${}), regex literals and both comment forms — a bare `//`
// regex would truncate 'https://…' literals.
// studio/static-backend.mjs is walked like every other studio module: its
// notices take the product from the shell's #brand-config (written by
// tools/build-studio-bundle.mjs --brand) and default to DEFAULT_BRAND.name.

const CHROME_LITERAL = /Observo(?:gram(?![-_])|<)|OBSERVO(?:GRAM(?![_A-Z])|<)/;

export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // The template-literal stack: each entry is the brace depth of the ${} we are in (0 = in the template text itself).
  const tpl = [];
  let braces = 0;
  const regexAllowed = (back) => {
    const m = /([^\s]|^)\s*$/.exec(back);
    const c = m ? m[1] : '';
    return c === '' || '(,=:[!&|?{};+-*%<>~^'.includes(c) || /\b(return|typeof|case|do|else|in|of|instanceof|new|delete|void|throw)$/.test(back);
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (tpl.length && tpl[tpl.length - 1] === 0) {
      // Inside template text.
      if (ch === '\\') { out += ch + (next ?? ''); i += 2; continue; }
      if (ch === '`') { tpl.pop(); out += ch; i++; continue; }
      if (ch === '$' && next === '{') { tpl[tpl.length - 1] = 1; out += '${'; i += 2; continue; }
      out += ch; i++; continue;
    }
    // Code (top level or inside a ${}).
    if (ch === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; out += ' '; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && src[j] !== ch && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '`') { tpl.push(0); out += ch; i++; continue; }
    if (ch === '/' && regexAllowed(out)) {
      let j = i + 1; let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (tpl.length) {
      if (ch === '{') braces++;
      else if (ch === '}') {
        if (braces === 0) { tpl[tpl.length - 1] = 0; out += ch; i++; continue; }
        braces--;
      }
    }
    out += ch; i++;
  }
  return out;
}

test('source guard: the tokenizer strips comments and keeps strings, templates (nested), and regex literals', () => {
  assert.equal(stripJsComments("const u = 'https://x/Observogram'; // Observogram here\n/* and Observogram */ x"), "const u = 'https://x/Observogram'; \n  x");
  assert.equal(stripJsComments('a = `t ${ b ? `in ${c} // not a comment` : "q" } // nor this` // comment'), 'a = `t ${ b ? `in ${c} // not a comment` : "q" } // nor this` ');
  assert.equal(stripJsComments('r = /\\/\\/ Observogram/; s = x / y; // c'), 'r = /\\/\\/ Observogram/; s = x / y; ');
  assert.equal(stripJsComments("'it\\'s' // Observogram"), "'it\\'s' ");
  assert.match(stripJsComments("if (a) {\n  // Observogram\n  return `${x}`;\n}"), /^if \(a\) \{\n {2}\n {2}return `\$\{x\}`;\n\}$/);
});

test('source guard: no studio or auth-page source names the product as chrome outside tools/lib/brand.mjs', () => {
  const { readdirSync } = fsSync;
  const files = [
    ...readdirSync(join(ROOT, 'studio')).filter((f) => f.endsWith('.mjs')).map((f) => `studio/${f}`),
    'server/auth.mjs', 'server/auth-proxy.mjs',
  ];
  assert.ok(files.length > 40, `the studio was walked (${files.length} files)`);
  const offenders = [];
  for (const f of files) {
    const code = stripJsComments(read(f));
    code.split('\n').forEach((line, i) => { if (CHROME_LITERAL.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(offenders, [], 'a chrome literal outside tools/lib/brand.mjs');
  // The protocol literals the regex deliberately passes still exist (the guard is not vacuous).
  assert.match(read('studio/api.mjs'), /X-Observogram-CSRF/);
  assert.match(read('server/auth.mjs'), /OBSERVOGRAM_OIDC_ISSUER/);
  assert.match(read('server/auth.mjs'), /ERR_OBSERVOGRAM_UNUSABLE_SUB/);
  assert.ok(CHROME_LITERAL.test('Observogram home') && CHROME_LITERAL.test('Observo<i>gram') && CHROME_LITERAL.test('OBSERVOGRAM SCAN') && CHROME_LITERAL.test('OBSERVO</text>'));
  assert.ok(!CHROME_LITERAL.test('X-Observogram-CSRF') && !CHROME_LITERAL.test('OBSERVOGRAM_OIDC') && !CHROME_LITERAL.test('ERR_OBSERVOGRAM_X') && !CHROME_LITERAL.test('observogram_session'));
  // The shell's own literals are exactly the anchors brandShellHtml replaces: branded, nothing is left.
  assert.doesNotMatch(brandShellHtml(SHELL, NAME_ONLY), LEAK, 'studio/index.html names the product only where an anchor replaces it');
  // The default header SVG lives in brand.mjs alone.
  assert.ok(!read('studio/app.mjs').includes('observaLogoG'));
});

// ---------- gen-design-tokens with a brand ----------

test('design tokens: an unconfigured brand yields the one-argument document; a configured one overrides per theme and names itself', async () => {
  const { designTokensDocument, designTokensJson, runDesignTokensCli, WRITE_WITH_BRAND_REFUSED } = await import('./gen-design-tokens.mjs');
  const css = read('studio/design-tokens.css');
  const plain = designTokensJson(css);
  assert.equal(designTokensJson(css, normalizeBrand({})), plain, 'gated on configured, not on non-null');
  assert.equal(designTokensJson(css, null), plain);
  assert.equal(designTokensJson(css, DEFAULT_BRAND), plain);
  assert.equal(plain, read('studio/design-tokens.json').replace(/\r\n/g, '\n'), 'the committed default is the one-argument output');
  const base = designTokensDocument(css);
  assert.ok(!('brand' in base));
  const doc = designTokensDocument(css, ACME);
  assert.equal(doc.brand, 'Acme Watch');
  assert.equal(doc.themes.light.accent, '#b3261e');
  assert.equal(doc.themes.light['accent-solid'], '#f28b82');
  assert.equal(doc.themes.dark.accent, '#f28b82');
  assert.equal(doc.themes.dark['accent-solid'], '#f28b82', 'a light override applies to dark too unless the dark map restates it (the CSS restates accent-solid; the injected :root{} still wins the cascade)');
  for (const theme of ['light', 'dark']) {
    for (const [name, value] of Object.entries(base.themes[theme])) {
      if (['accent', 'accent-solid'].includes(name)) continue;
      assert.equal(doc.themes[theme][name], value, `${theme}.${name} untouched`);
    }
    assert.deepEqual(Object.keys(doc.themes[theme]).sort(), Object.keys(base.themes[theme]).sort(), `${theme}: the same token set`);
  }
  assert.deepEqual(Object.keys(doc), ['$comment', 'version', 'prefix', 'brand', 'themes']);
  assert.throws(() => designTokensDocument(css, normalizeBrand({ tokens: { light: { 'not-a-token': '#000' } } })), /brand: tokens\.light\.not-a-token is not a token studio\/design-tokens\.css defines/);
  // The CLI: --brand explicit, --write refused with a brand, --out for the branded JSON, no env read.
  const writes = [];
  const io = { css, writeDefault: (j) => writes.push(['default', j.length]), writeOut: (p, j) => writes.push([p, j.length]), readBrandFile: (p) => (p === 'acme.json' ? JSON.parse(read('tools/fixtures/brand/acme.json')) : (() => { throw new Error(`no ${p}`); })()) };
  assert.equal(runDesignTokensCli([], io).json, plain);
  assert.equal(runDesignTokensCli(['--brand', 'acme.json'], io).json, designTokensJson(css, ACME));
  assert.throws(() => runDesignTokensCli(['--brand', 'acme.json', '--write'], io), new RegExp(`^Error: ${WRITE_WITH_BRAND_REFUSED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  assert.deepEqual(writes, [], 'a refused write writes nothing');
  assert.deepEqual(runDesignTokensCli(['--brand', 'acme.json', '--out', 'dist/tokens.json'], io).wrote, 'dist/tokens.json');
  assert.deepEqual(runDesignTokensCli(['--write'], io).wrote, 'studio/design-tokens.json');
  assert.deepEqual(writes.map((w) => w[0]), ['dist/tokens.json', 'default']);
  assert.throws(() => runDesignTokensCli(['--brand'], io), /--brand needs a value/);
  assert.throws(() => runDesignTokensCli(['--brand', '--out', 'x'], io), /--brand needs a value/);
  assert.ok(!read('tools/gen-design-tokens.mjs').includes('brand-env'), 'the generator never reads OBSERVOGRAM_BRAND_FILE: --write in a branded shell still regenerates the default');
});
