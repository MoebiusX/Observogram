#!/usr/bin/env node
// tools/test-design-system.mjs — the design system stays portable.
//
// Observogram is upstream of other apps (docs/VENDORING.md). Its look is three
// files a downstream copies verbatim — design-tokens.css, design-kit.css,
// design-bridge.css — plus reskin.css, this studio's own adapter, which is
// not portable and must not become the place where the look is decided.
// These tests hold each file to its role, so the portable ones cannot grow a
// dependency on this studio and the adapter cannot grow a value of its own.
//
// Run: node --test tools/test-design-system.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDesignTokens, designTokensJson, TOKEN_PREFIX } from './gen-design-tokens.mjs';

const dir = new URL('../studio/', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, dir), 'utf8');
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = (css) => [...strip(css).matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
const declarations = (body) => [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(m => ({ prop: m[1], value: m[2].trim() }));
const tokenRefs = (css) => [...new Set([...strip(css).matchAll(/var\((--[\w-]+)/g)].map(m => m[1]))];

const tokensCss = read('design-tokens.css');
const tokens = parseDesignTokens(tokensCss);
const defined = new Set(Object.keys(tokens.light).map(n => TOKEN_PREFIX + n));

test('design-tokens.css is tokens and nothing else: two selectors, custom properties only', () => {
  for (const r of rules(tokensCss)) {
    assert.ok([':root', '[data-theme="dark"]'].includes(r.selector), `only :root and the dark theme, not "${r.selector}"`);
    for (const d of declarations(r.body)) {
      assert.ok(d.prop.startsWith(TOKEN_PREFIX) || d.prop === 'color-scheme', `${d.prop} is not a token`);
    }
  }
  assert.ok(defined.size >= 40, 'the palette, the type and the measures are all here');
});

test('every token has a value in both themes; the dark theme names nothing the light one lacks', () => {
  for (const name of Object.keys(tokens.dark)) assert.ok(name in tokens.light, `--og-${name} is dark-only`);
  // Every colour (a literal in the light theme) is restated for the dark one.
  const colour = (v) => /^#|^rgba?\(/.test(v);
  for (const [name, value] of Object.entries(tokens.light)) {
    if (colour(value) || name === 'shadow') assert.ok(name in tokens.dark, `--og-${name} has no dark value`);
  }
  // Names are semantic, so a host can change a hue without renaming anything.
  for (const name of defined) assert.ok(!/lime|purple|amber|rose|blue|green|red/.test(name), `${name} names a colour, not a role`);
});

test('design-tokens.json is the same values, for code that cannot read CSS', () => {
  assert.equal(read('design-tokens.json').replace(/\r\n/g, '\n'), designTokensJson(tokensCss),
    'studio/design-tokens.json is stale: run `node tools/gen-design-tokens.mjs --write`');
  const doc = JSON.parse(read('design-tokens.json'));
  assert.equal(doc.prefix, TOKEN_PREFIX);
  assert.deepEqual(Object.keys(doc.themes.dark).sort(), Object.keys(doc.themes.light).sort(), 'both themes carry every token');
  assert.equal(doc.themes.dark.bg, tokens.dark.bg);
  assert.equal(doc.themes.dark.font, tokens.light.font, 'a token the dark theme does not restate keeps the light value');
});

test('design-kit.css reads the tokens only: .og- classes, no studio class, no element, no positioning', () => {
  const css = read('design-kit.css');
  for (const r of rules(css)) {
    for (const part of r.selector.split(',')) {
      for (const compound of part.trim().split(/\s+|>|\+|~/).filter(Boolean)) {
        assert.ok(/^(\.og-[\w-]+|::?[\w-]+(\([^)]*\))?|\[[^\]]+\])+$/.test(compound) && compound.includes('.og-') || /^::selection$/.test(compound),
          `"${r.selector}": every part is an .og- class (with states), found "${compound}"`);
      }
    }
    assert.ok(!/position:\s*(fixed|sticky|absolute)/.test(r.body), `"${r.selector}" positions itself`);
    for (const d of declarations(r.body)) {
      assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(d.value), `"${r.selector}" sets a colour of its own: ${d.prop}: ${d.value}`);
    }
  }
  for (const ref of tokenRefs(css)) assert.ok(defined.has(ref), `design-kit.css reads ${ref}, which design-tokens.css does not define`);
});

test('design-bridge.css only names theme properties, each from a token', () => {
  const css = read('design-bridge.css');
  const all = rules(css);
  assert.ok(all.length >= 1);
  for (const r of all) {
    for (const part of r.selector.split(',')) assert.ok(/^(:root|\[data-theme="(dark|light)"\])$/.test(part.trim()), `"${part.trim()}" is not :root or a theme`);
    for (const d of declarations(r.body)) {
      assert.ok(d.prop.startsWith('--') && !d.prop.startsWith(TOKEN_PREFIX), `${d.prop}: the bridge defines host theme properties, never tokens`);
      assert.ok(/^var\(--og-[\w-]+\)$/.test(d.value) || ['transparent', '7px'].includes(d.value), `${d.prop}: ${d.value} is not a token`);
    }
  }
  for (const ref of tokenRefs(css)) assert.ok(defined.has(ref), `design-bridge.css reads ${ref}, which is not a token`);
  // The properties the vendored view styles document as "expected from the host" are all here.
  const names = new Set(all.flatMap(r => declarations(r.body).map(d => d.prop)));
  for (const need of ['--mono', '--card', '--line', '--line-2', '--ink', '--ink-2', '--ink-3', '--ink-4', '--r-sm', '--r-md', '--r-lg',
    '--CMP', '--BLD', '--BLD-bg', '--pr-blue', '--pr-green', '--pr-amber', '--pr-red', '--pr-cyan', '--pr-purple', '--pr-gray']) {
    assert.ok(names.has(need), `${need} (read by verdict-ui.css) is bridged`);
  }
  assert.equal([...css.matchAll(/--serif:\s*var\(--og-font\)/g)].length, 1, 'one typeface: the serif is the sans');
  assert.equal([...css.matchAll(/--mono:\s*var\(--og-font\)/g)].length, 1, 'one typeface: the label monospace is the sans');
});

test('reskin.css, the studio adapter, decides no colour and reads no token that does not exist', () => {
  const css = strip(read('reskin.css'));
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css) && !/rgba?\(/.test(css), 'no colour literal: colours are tokens');
  for (const ref of tokenRefs(css).filter(r => r.startsWith(TOKEN_PREFIX))) assert.ok(defined.has(ref), `reskin.css reads ${ref}, which is not a token`);
  assert.ok(!/--og-[\w-]+\s*:/.test(css), 'the adapter never defines or overrides a token');
  assert.ok(/font-family:\s*var\(--og-font-code\)/.test(css), 'code keeps a monospace of its own');
  assert.ok(!/position:\s*(fixed|sticky|absolute)/.test(css), 'it restyles; it moves nothing');
});

test('no stylesheet reads a token that is not defined, and the page loads the four files in order', () => {
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.css'))) {
    for (const ref of tokenRefs(read(file)).filter(r => r.startsWith(TOKEN_PREFIX))) assert.ok(defined.has(ref), `${file} reads ${ref}, which design-tokens.css does not define`);
  }
  const sheets = [...read('index.html').matchAll(/<link rel="stylesheet" href="\/([\w.-]+\.css)">/g)].map(m => m[1]);
  assert.equal(sheets[0], 'design-tokens.css', 'the tokens load first');
  assert.deepEqual(sheets.slice(-3), ['design-kit.css', 'design-bridge.css', 'reskin.css'], 'kit, bridge, then the adapter, last');
});
