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
//
// A brand (tools/lib/brand.mjs) may override token values — `tokens.light` /
// `tokens.dark` in the brand file: designTokensDocument(css, brand) applies
// them per theme and names the brand. Only an explicit `--brand <file.json>`
// does so (the env OBSERVOGRAM_BRAND_FILE is deliberately not read here, so
// `--write` in a branded shell still regenerates the vendorable default);
// a branded document goes to `--out <path>`, never over the default:
//
//   node tools/gen-design-tokens.mjs --brand acme.json --out dist/design-tokens.json

import fs from 'node:fs';
import { normalizeBrand } from './lib/brand.mjs';

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

/**
 * The published document: every token resolved per theme (dark = light with
 * its overrides). With a configured brand (`brand.configured`, never merely
 * non-null — an unconfigured brand yields exactly the one-argument document)
 * the brand's `tokens.light` / `tokens.dark` override the values — the light
 * map applies to both themes and the dark map refines dark, which is what the
 * injected `<style id="brand-tokens">` does in the browser (its `:root{}` is
 * later in the cascade than the CSS's `[data-theme="dark"]{}` at the same
 * specificity) — and a `brand` key names it; a brand token the CSS does not
 * define throws.
 */
export function designTokensDocument(css, brand = null) {
  const { light, dark } = parseDesignTokens(css);
  const doc = {
    $comment: 'Generated from studio/design-tokens.css by tools/gen-design-tokens.mjs. Do not edit: change the CSS and regenerate.',
    version: 1,
    prefix: TOKEN_PREFIX,
    themes: { light, dark: { ...light, ...dark } },
  };
  if (!brand?.configured) return doc;
  for (const theme of ['light', 'dark']) {
    for (const name of Object.keys(brand.tokens[theme])) {
      if (!(name in light)) throw new Error(`brand: tokens.${theme}.${name} is not a token studio/design-tokens.css defines`);
    }
  }
  return {
    $comment: doc.$comment,
    version: doc.version,
    prefix: doc.prefix,
    brand: brand.name,
    themes: { light: { ...light, ...brand.tokens.light }, dark: { ...light, ...dark, ...brand.tokens.light, ...brand.tokens.dark } },
  };
}

export const designTokensJson = (css, brand = null) => `${JSON.stringify(designTokensDocument(css, brand), null, 2)}\n`;

export const WRITE_WITH_BRAND_REFUSED = 'design-tokens.json is the vendorable default; write branded JSON with --out <path>';

/** The CLI: { json, wrote } or throws with the message to print. */
export function runDesignTokensCli(argv, { css, writeDefault, writeOut, readBrandFile }) {
  const flagValue = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const brandFile = flagValue('--brand');
  const out = flagValue('--out');
  const write = argv.includes('--write');
  const brand = brandFile ? normalizeBrand(readBrandFile(brandFile)) : null;
  if (write && brand) throw new Error(WRITE_WITH_BRAND_REFUSED);
  const json = designTokensJson(css, brand);
  if (write) { writeDefault(json); return { json, wrote: 'studio/design-tokens.json' }; }
  if (out) { writeOut(out, json); return { json, wrote: out }; }
  return { json, wrote: null };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gen-design-tokens.mjs')) {
  const cssUrl = new URL('../studio/design-tokens.css', import.meta.url);
  try {
    const { json, wrote } = runDesignTokensCli(process.argv.slice(2), {
      css: fs.readFileSync(cssUrl, 'utf8'),
      writeDefault: (json) => fs.writeFileSync(new URL('../studio/design-tokens.json', import.meta.url), json),
      writeOut: (path, json) => fs.writeFileSync(path, json),
      readBrandFile: (path) => JSON.parse(fs.readFileSync(path, 'utf8')),
    });
    process.stdout.write(wrote ? `wrote ${wrote}\n` : json);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
