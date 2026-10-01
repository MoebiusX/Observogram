#!/usr/bin/env node
// tools/gen-design-tokens.mjs — studio/design-tokens.css as JSON.
//
// The CSS file is the source of truth for the design tokens; a downstream app
// in another stack (a TypeScript theme object, a chart palette, a canvas)
// cannot read custom properties, so the same values are published as
// studio/design-tokens.json. tools/test-design-system.mjs fails when the two
// differ; this regenerates the JSON.
//
//   node tools/gen-design-tokens.mjs            print the JSON
//   node tools/gen-design-tokens.mjs --write    rewrite studio/design-tokens.json

import fs from 'node:fs';

export const TOKEN_PREFIX = '--og-';

/** { light: { name: value }, dark: { name: value } } — the declarations as written, names without the prefix. */
export function parseDesignTokens(css) {
  const plain = String(css).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = { light: {}, dark: {} };
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const theme = selector === ':root' ? 'light' : /^\[data-theme="dark"\]$/.test(selector) ? 'dark' : null;
    if (!theme) continue;
    for (const d of m[2].matchAll(/(--og-[\w-]+)\s*:\s*([^;]+);/g)) out[theme][d[1].slice(TOKEN_PREFIX.length)] = d[2].trim().replace(/\s+/g, ' ');
  }
  return out;
}

/** The published document: every token resolved per theme (dark = light with its overrides). */
export function designTokensDocument(css) {
  const { light, dark } = parseDesignTokens(css);
  return {
    $comment: 'Generated from studio/design-tokens.css by tools/gen-design-tokens.mjs. Do not edit: change the CSS and regenerate.',
    version: 1,
    prefix: TOKEN_PREFIX,
    themes: { light, dark: { ...light, ...dark } },
  };
}

export const designTokensJson = (css) => `${JSON.stringify(designTokensDocument(css), null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gen-design-tokens.mjs')) {
  const cssUrl = new URL('../studio/design-tokens.css', import.meta.url);
  const json = designTokensJson(fs.readFileSync(cssUrl, 'utf8'));
  if (process.argv.includes('--write')) {
    fs.writeFileSync(new URL('../studio/design-tokens.json', import.meta.url), json);
    process.stdout.write('wrote studio/design-tokens.json\n');
  } else {
    process.stdout.write(json);
  }
}
