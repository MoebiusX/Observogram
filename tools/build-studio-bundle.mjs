#!/usr/bin/env node
// tools/build-studio-bundle.mjs — the studio as ONE static HTML file
// (docs/DOWNSTREAM.md, "Embedding the studio"; README, "Serve The Studio
// Without The Server").
//
//   node tools/build-studio-bundle.mjs [--pack <file> [--id <id>] [--label <text>] [--description <text>]]…
//        [--pack-url <url> [--id <id>] [--label <text>] [--description <text>]]… [--taxonomy <file.json>]
//        [--brand <file.json>] [--mcp-settings-policy <file.json>] [--mcp-origins <origin>,…]
//        [--out dist/studio/index.html] [--no-remote-fonts] [--check] [--json]
//
// --pack is parsed (YAML or .json) and validated against the spec schema at
// build time; its canonical is inlined. --pack-url is fetched by the page at
// its first catalogue read (the host must answer CORS); a URL carrying
// userinfo or a credential query parameter is refused — the file is
// distributed, and --json prints URLs in their stripped form only.
// --check builds in memory and writes nothing. --no-remote-fonts drops the
// Google Fonts links (the fallback stacks apply). Without --pack the bundle
// boots with an empty catalogue and the notice.
//
// --taxonomy bakes the artefact-taxonomy override (the file OBSERVOGRAM_TAXONOMY
// names on a server; honoured here too when the flag is absent), validated
// with validateTaxonomy — the server's validator, the server's texts — and
// served by the bundle's GET /api/taxonomy in the server's shape. --brand
// bakes the brand (OBSERVOGRAM_BRAND_FILE and the OBSERVOGRAM_BRAND_* scalars
// honoured when the flag is absent — the server's loader, tools/lib/brand-env.mjs),
// validated with normalizeBrand and rendered into the shell by brandShellHtml,
// so the bundle's shell IS the server's branded shell, then transformed as
// before. A root-relative brand URL (favicon, logo.url, hero.src) is a
// server path and is refused: the bundle is served without the server.
// Without either, nothing is read: brandShellHtml is the identity for an
// unconfigured brand and the config gains no key, so the bytes are those of
// a build with no flags on the same tree, for the same builtAt. The summary
// and --json always say what was baked, never the files' contents, and no
// operator path lands in the bundle.
//
// --mcp-settings-policy bakes the MCP server-settings policy (the file
// OBSERVOGRAM_MCP_SETTINGS_POLICY names on a server; honoured here too when
// the flag is absent), compiled with compileSettingsPolicy — the server
// loader's texts, one leading BOM stripped the same way — and served by the
// bundle's GET /api/mcp-settings in the server's shape. --mcp-origins bakes
// the MCP origins the bundle's Server settings modal may send settings to
// (OBSERVOGRAM_MCP_ORIGINS honoured when the flag is absent): read by the
// server's list rule (tools/lib/mcp-url-safety.mjs parseOriginList; `*` any
// origin), an entry that is not an http(s) origin refused rather than
// dropped, and served beside the policy as `mcpOrigins: { listed, origins }`
// (origins null for `*`), the shape GET /api/mcp-endpoints gives a server's
// studio. Both config keys are appended after `taxonomy` and only when
// baked, so an unbaked build keeps its bytes. The summary names the policy's
// file and rule count (never its contents) and the origins (not secret).
//
// A downstream that serves the studio behind its own static host gets the
// whole studio — every module, every stylesheet, the packs it names — in one
// file that assumes no server: studio/static-backend.mjs answers the
// read-only pack routes in the browser and says "no backend" for the rest.
//
// How the modules are inlined: an inline `<script type="importmap">` whose
// keys are bare specifiers (`studio/<file>.mjs`, `lib/<path>.mjs` for
// tools/lib) and whose addresses are `data:text/javascript;base64,…` of each
// module, with ONLY the import-specifier strings rewritten to those keys.
// Native ESM semantics stay untouched — live bindings, cycles, `import()`
// with `.catch`, re-exports — because no module's syntax is transformed.
// (Nested data: URLs cannot resolve relative specifiers; blob: URLs need a
// runtime step before the import map; a concatenation registry means
// rewriting import/export syntax by hand.) Cost: base64 ×1.33, and stack
// traces name data: URLs. A page whose Content-Security-Policy forbids
// `data:` in script-src needs a directory form (`--split`), a follow-up.
//
// Zero dependencies beyond Node: fs, path, this repo's tools/lib and the
// tokenizer of tools/gen-vendor-manifest.mjs. No bundler.
// Exit 0 built · 1 a pack fails the schema, a specifier cannot be inlined, a
// file is missing · 2 usage.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, posix, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { stripMcpUrl, parseOriginList } from './lib/mcp-url-safety.mjs';
import { fileSlug } from './lib/slug.mjs';
import { validateTaxonomy, compileTaxonomy, describeTaxonomy } from './lib/artefact-classify.mjs';
import { brandShellHtml, normalizeBrand, DEFAULT_BRAND } from './lib/brand.mjs';
import { compileSettingsPolicy } from './lib/mcp-server-settings.mjs';
import { loadBrand as loadBrandFromEnv, brandEnvFrom } from './lib/brand-env.mjs';
import { importSpecifiers } from './gen-vendor-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(HERE, '..');
export const ENTRIES = ['studio/app.mjs', 'studio/static-backend.mjs'];
export const CONFIG_ID = 'observogram-static-config';
export const DEFAULT_OUT = 'dist/studio/index.html';
const NOTICE_CSS = 'static-backend.css';
const usage = `usage: build-studio-bundle.mjs [--pack <file> [--id <id>] [--label <text>] [--description <text>]]… [--pack-url <url> [--id <id>] [--label <text>] [--description <text>]]… [--taxonomy <file.json>] [--brand <file.json>] [--mcp-settings-policy <file.json>] [--mcp-origins <origin>,…] [--out ${DEFAULT_OUT}] [--no-remote-fonts] [--check] [--json]`;

// ---------- the module graph ----------

// Where the specifiers are: tools/gen-vendor-manifest.mjs's tokenizer, which
// walks the source once and knows strings, template literals, regex bodies
// and both comment forms — so a specifier in a comment is neither collected
// nor asserted against, and a `/*` inside a `//` comment (compile.mjs has
// one: `provisioning/alerting/*.yaml`) does not pair with a `*/` inside a
// template literal and swallow the code between them, as a regex strip
// would. importSpecifiers yields the four forms the bundle rewrites —
// import … from 'x' · export … from 'x' · import 'x' · import('x') — each
// with the index of its opening quote, so the rewrite splices exactly the
// specifier and keeps the quote.
const PATH_SPEC_RE = /^(?:\.{1,2}\/|\/lib\/)/;

// A root-relative path → its import-map key, or null outside the two trees.
export function keyOf(relPath) {
  if (relPath.startsWith('tools/lib/')) return `lib/${relPath.slice('tools/lib/'.length)}`;
  if (relPath.startsWith('studio/')) return relPath;
  return null;
}
// The reverse: a key → the root-relative path.
export function pathOf(key) {
  return key.startsWith('lib/') ? `tools/lib/${key.slice(4)}` : key;
}

// Where a specifier points, as a root-relative path: `/lib/x` is tools/lib/x
// (the server's /lib mount, server/index.mjs; `.mjs` added when the
// specifier has no extension, as that mount does), `./` and `../` are
// relative to the importing file. Anything else — a bare package, node:*,
// an http URL — is null: the bundle cannot inline it.
export function resolveSpecifier(spec, fromRelPath) {
  let rel;
  if (spec.startsWith('/lib/')) rel = `tools${spec}`;
  else if (spec.startsWith('./') || spec.startsWith('../')) rel = posix.normalize(posix.join(posix.dirname(fromRelPath), spec));
  else return null;
  if (!extname(rel)) rel += '.mjs';
  return rel;
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

// Every module reachable from the entries: Map<key, { path, src, imports }>.
// Throws naming file:line for a specifier that cannot be inlined, a module
// outside studio/ and tools/lib, or a file that is not there.
export function collectModuleGraph(root = DEFAULT_ROOT, entries = ENTRIES, { read } = {}) {
  const readFile = read || ((rel) => {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) throw new Error(`module file missing: ${rel}`);
    return readFileSync(abs, 'utf8');
  });
  const graph = new Map();
  const queue = [];
  const enqueue = (rel, from) => {
    const key = keyOf(rel);
    if (!key) throw new Error(`${from}: ${rel} is outside studio/ and tools/lib/ — the bundle inlines those two trees only`);
    if (!graph.has(key)) { graph.set(key, null); queue.push(key); }
    return key;
  };
  for (const e of entries) enqueue(e, 'entry');
  while (queue.length) {
    const key = queue.shift();
    const path = pathOf(key);
    const src = readFile(path);
    const imports = [];
    for (const { spec, index } of importSpecifiers(src)) {
      const target = resolveSpecifier(spec, path);
      if (!target) {
        throw new Error(`${path}:${lineOf(src, index)}: cannot inline the specifier '${spec}' — only ./, ../ and /lib/ paths into studio/ and tools/lib/ are bundled (a bare package or node:* module cannot be)`);
      }
      imports.push({ spec, key: enqueue(target, `${path}:${lineOf(src, index)}`) });
    }
    graph.set(key, { path, src, imports });
  }
  return graph;
}

// The source with every inlinable specifier replaced by its key — nothing
// else touched. A specifier that does not resolve stays as it is. The
// splices run from the last specifier back, so earlier indices hold.
export function rewriteSpecifiers(src, fromKey) {
  const fromPath = pathOf(fromKey);
  let out = src;
  for (const { spec, index } of importSpecifiers(src).reverse()) {
    const target = resolveSpecifier(spec, fromPath);
    const key = target && keyOf(target);
    if (!key) continue;
    out = `${out.slice(0, index + 1)}${key}${out.slice(index + 1 + spec.length)}`;
  }
  return out;
}

// After the rewrite no module may still name a path specifier (comments aside).
export function assertRewritten(rewritten, key) {
  for (const { spec, index } of importSpecifiers(rewritten)) {
    if (PATH_SPEC_RE.test(spec)) throw new Error(`${pathOf(key)}:${lineOf(rewritten, index)}: a path specifier survived the rewrite: ${spec}`);
  }
}

// ---------- the HTML ----------

// JSON inside a <script>: `<` can never start `</script` or `<!--`, and the
// two line terminators JSON allows raw are escaped (both stay valid JSON).
export function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// A stylesheet as an inline <style>: the one sequence that ends a style
// element's text is "</style", and nothing can escape it — such a sheet
// fails the build rather than being inlined cut short.
export function styleBlock(name, css) {
  if (/<\/style/i.test(css)) throw new Error(`studio/${name} contains "</style" and cannot be inlined`);
  return `<style data-src="${name}">\n${css}\n</style>`;
}

const STYLESHEET_RE = /^([ \t]*)<link rel="stylesheet" href="\/([\w.-]+\.css)">[ \t]*$/gm;
// The shell's modulepreload of /lib/brand.mjs (and any other /lib module): in
// the bundle the module is a data: URL in the import map, so there is
// nothing to preload — the line goes.
const MODULEPRELOAD_RE = /^[ \t]*<link rel="modulepreload" href="\/lib\/[\w./-]+">[ \t]*\n/gm;
const FONT_LINE_RE = /^[ \t]*<link [^>\n]*fonts\.g(?:oogleapis|static)\.com[^>\n]*>[ \t]*\n/gm;
const APP_SCRIPT = '<script type="module" src="/app.mjs"></script>';

const NORMALIZED_BRAND_KEYS = Object.keys(DEFAULT_BRAND);
const isNormalizedBrand = (o) => NORMALIZED_BRAND_KEYS.every((k) => k in o) && typeof o.configured === 'boolean';

function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// { html, modules: [{ key, bytes }], stylesheets: [names], config, bytes, taxonomy, brand }
// taxonomy: the override document (a plain object) to bake, or null. brand:
// the brand to render into the shell — normalizeBrand's output (used as is)
// or a raw object (normalized here) — or null. Both are inert when
// null or unconfigured: the shell is the one shipped and the config has no
// `taxonomy` key, so the bytes are those of a build without them.
// mcpSettingsPolicy: the settings-policy document to bake, or null.
// mcpOrigins: { listed: true, origins: [origin] | null } (null: any
// origin), or null. Each is a config key only when given.
export function buildStudioBundle({ root = DEFAULT_ROOT, packs = [], remoteFonts = true, version, builtAt = new Date().toISOString(), taxonomy = null, brand = null, mcpSettingsPolicy = null, mcpOrigins = null } = {}) {
  const readRel = (rel) => readFileSync(resolve(root, rel), 'utf8');
  const pkgVersion = version ?? JSON.parse(readRel('package.json')).version;
  const schema = JSON.parse(readRel(SPEC_SCHEMA_PATH));

  // The seams, guarded here too: the CLI validated already, a programmatic
  // caller gets the same refusals (the classifier's `taxonomy: …` reason;
  // normalizeBrand's `brand: …`; a server path in a brand URL).
  if (taxonomy !== null) {
    const errs = validateTaxonomy(taxonomy);
    if (errs.length) throw new Error(errs[0]);
  }
  if (mcpSettingsPolicy !== null) {
    const { errors } = compileSettingsPolicy(mcpSettingsPolicy);
    if (errors.length) throw new Error(`MCP settings policy: ${errors[0]}`);
  }
  if (mcpOrigins !== null) checkBakedOrigins(mcpOrigins);
  // `brand` is normalizeBrand's output (recognised by its shape: every key
  // normalizeBrand writes, `configured` among them — normalizing it again
  // would count its own defaults as given and bake the upstream strings) or
  // a raw object, normalized here. A raw object that merely carries a
  // `configured` key is still raw: it has not the full shape.
  const b = brand ? (isNormalizedBrand(brand) ? brand : normalizeBrand(brand)) : null;
  const branded = b && b.configured ? b : null;
  if (branded) checkBrandUrls(branded);

  // The modules.
  const graph = collectModuleGraph(root, ENTRIES);
  const imports = {};
  const modules = [];
  for (const [key, mod] of graph) {
    const rewritten = rewriteSpecifiers(mod.src, key);
    assertRewritten(rewritten, key);
    imports[key] = `data:text/javascript;base64,${toBase64(rewritten)}`;
    modules.push({ key, bytes: Buffer.byteLength(rewritten, 'utf8') });
  }

  // The config the page reads: the packs with their canonical, the schema,
  // and — only when baked, after `packs`, so the unconfigured config is the
  // same four keys in the same order — the taxonomy document the shim serves,
  // then the MCP settings policy and the MCP origin list.
  const config = {
    version: pkgVersion,
    builtAt,
    schema,
    packs: packs.map((p) => (p.url
      ? { id: p.id, label: p.label, ...(p.description ? { description: p.description } : {}), url: p.url }
      : { id: p.id, label: p.label, ...(p.description ? { description: p.description } : {}), source: 'bundle', canonical: p.canonical })),
    ...(taxonomy ? { taxonomy } : {}),
    ...(mcpSettingsPolicy ? { mcpSettingsPolicy } : {}),
    ...(mcpOrigins ? { mcpOrigins } : {}),
  };

  // The page: studio/index.html — the server's branded rendering when a
  // brand is baked (tools/lib/brand.mjs brandShellHtml, exactly what
  // server/index.mjs sendShell serves; the identity when none) — with its
  // stylesheets, fonts and script replaced. The brand goes first: its
  // anchors are on the shipped shell, and it keeps the design-tokens link
  // alone on its line, so the inlining below still matches every sheet and
  // #brand-tokens lands right after design-tokens.css, the server's cascade
  // position.
  let html = brandShellHtml(readRel('studio/index.html'), branded || DEFAULT_BRAND);
  const stylesheets = [];
  const inlineCss = (name) => {
    const block = styleBlock(name, readRel(`studio/${name}`));
    stylesheets.push(name);
    return block;
  };
  html = html.replace(MODULEPRELOAD_RE, '');
  html = html.replace(STYLESHEET_RE, (whole, indent, name) => `${indent}${inlineCss(name)}`);
  if (!stylesheets.length) throw new Error('studio/index.html: no <link rel="stylesheet" href="/…css"> to inline');
  // The notice's stylesheet, after the adapter (reskin.css) — the live studio never links it.
  const lastStyle = `<style data-src="${stylesheets[stylesheets.length - 1]}">`;
  const lastAt = html.indexOf(lastStyle);
  const lastEnd = html.indexOf('</style>', lastAt) + '</style>'.length;
  html = `${html.slice(0, lastEnd)}\n${inlineCss(NOTICE_CSS)}${html.slice(lastEnd)}`;
  if (!remoteFonts) html = html.replace(FONT_LINE_RE, '');

  const scriptAt = html.indexOf(APP_SCRIPT);
  if (scriptAt < 0 || html.indexOf(APP_SCRIPT, scriptAt + 1) >= 0) throw new Error(`studio/index.html: expected exactly one ${APP_SCRIPT}`);
  const scripts = [
    `<script type="application/json" id="${CONFIG_ID}">${inlineJson(config)}</script>`,
    `<script type="importmap">${inlineJson({ imports })}</script>`,
    `<script type="module">import { installStaticBackend } from 'studio/static-backend.mjs'; installStaticBackend(JSON.parse(document.getElementById('${CONFIG_ID}').textContent));</script>`,
    `<script type="module">import 'studio/app.mjs';</script>`,
  ];
  html = html.replace(APP_SCRIPT, scripts.join('\n'));
  html = html.replace('<body>\n', '<body>\n<noscript><p class="no-backend-notice">This studio is a static bundle: it needs JavaScript and a browser with import maps (Chrome 89, Firefox 108, Safari 16.4 or newer).</p></noscript>\n');

  const leftover = /(?:href|src)="\/[^"]*"/.exec(html);
  if (leftover) throw new Error(`the bundle still references the server: ${leftover[0]}`);

  return { html, modules, stylesheets, config, bytes: Buffer.byteLength(html, 'utf8'), taxonomy, brand: branded, mcpSettingsPolicy, mcpOrigins };
}

// ---------- the seams: the taxonomy and the brand ----------

// Which taxonomy file to bake: the flag, else the file OBSERVOGRAM_TAXONOMY
// (TOMOGRAPH_TAXONOMY honoured, the modern name in the text — server/taxonomy.mjs)
// names, so a build machine configured for a server bakes the same override;
// else none. A relative path resolves against `cwd`, as the server resolves
// its own against the working directory. Returns { file, origin } or null.
export function resolveTaxonomySource(opts, env = process.env, cwd = process.cwd()) {
  if (opts.taxonomy) return { file: resolve(cwd, opts.taxonomy), origin: '--taxonomy' };
  const fromEnv = brandEnvFrom(env, 'TAXONOMY');
  if (fromEnv) return { file: resolve(cwd, fromEnv), origin: 'OBSERVOGRAM_TAXONOMY' };
  return null;
}

// The taxonomy file read, parsed and validated — server/taxonomy.mjs
// readTaxonomyConfig text for text with the origin swapped (that module
// holds the process-wide override and names the variable even for a flag).
// Returns { taxonomy, compiled, file, origin }; throws `<origin>: <file>:
// <the ENOENT text | invalid JSON: … | taxonomy: … (+N more)>`.
export function loadTaxonomyFile(file, origin = '--taxonomy') {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`${origin}: ${file}: ${e.message}`, { cause: e }); }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${origin}: ${file}: invalid JSON: ${e.message}`, { cause: e }); }
  const errors = validateTaxonomy(json);
  if (errors.length) throw new Error(`${origin}: ${file}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
  return { taxonomy: json, compiled: compileTaxonomy(json), file, origin };
}

// ---------- the seams: the MCP settings policy and the MCP origin list ----------

// Which settings-policy file to bake: the flag, else the file
// OBSERVOGRAM_MCP_SETTINGS_POLICY (TOMOGRAPH_ honoured, the modern name in
// the text — server/mcp-settings-policy.mjs) names; else none. A relative
// path resolves against `cwd`. Returns { file, origin } or null.
export function resolveSettingsPolicySource(opts, env = process.env, cwd = process.cwd()) {
  if (opts.mcpSettingsPolicy) return { file: resolve(cwd, opts.mcpSettingsPolicy), origin: '--mcp-settings-policy' };
  const fromEnv = brandEnvFrom(env, 'MCP_SETTINGS_POLICY');
  if (fromEnv) return { file: resolve(cwd, fromEnv), origin: 'OBSERVOGRAM_MCP_SETTINGS_POLICY' };
  return null;
}

// The settings-policy file read, one leading U+FEFF stripped, parsed and
// compiled — server/mcp-settings-policy.mjs readSettingsPolicyConfig text for
// text with the origin swapped. Returns { policy, compiled, file, origin };
// throws `<origin>: <file>: <the ENOENT text | invalid JSON: … | the first
// error (+N more)>`.
export function loadSettingsPolicyFile(file, origin = '--mcp-settings-policy') {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`${origin}: ${file}: ${e.message}`, { cause: e }); }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${origin}: ${file}: invalid JSON: ${e.message}`, { cause: e }); }
  const { policy, errors } = compileSettingsPolicy(json);
  if (errors.length) throw new Error(`${origin}: ${file}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
  return { policy: json, compiled: policy, file, origin };
}

// The MCP origin list to bake: the flag's value, else OBSERVOGRAM_MCP_ORIGINS
// (TOMOGRAPH_ honoured) — the deployment list a build machine configured for
// a server has; a per-org list has no meaning in a bundle. Read by the
// server's rule (parseOriginList). The server names a rejected entry on
// stderr and ignores it; a build refuses it instead — the list is baked into
// a file that is distributed, and a silently shortened one would surface
// only as a refusal in some reader's browser. Returns { origins: { listed:
// true, origins: [origin] (sorted) | null }, origin } or null.
export function resolveMcpOrigins(opts, env = process.env) {
  const flag = opts.mcpOrigins ?? null;
  const value = flag ?? brandEnvFrom(env, 'MCP_ORIGINS');
  if (flag === null && !value) return null;
  const origin = flag !== null ? '--mcp-origins' : 'OBSERVOGRAM_MCP_ORIGINS';
  const list = parseOriginList(value);
  if (list.rejected.length) {
    throw new Error(`${origin}: ${list.rejected.map((e) => JSON.stringify(e)).join(', ')} ${list.rejected.length === 1 ? 'is not an origin' : 'are not origins'} — list each as scheme://host[:port] (http or https, no path, user or wildcard), or * for any origin`);
  }
  if (!list.any && list.origins.size === 0) throw new Error(`${origin}: no origin listed — name at least one (scheme://host[:port]), or * for any origin`);
  return { origins: { listed: true, origins: list.any ? null : [...list.origins].sort() }, origin };
}

// A baked origin list, guarded for a programmatic caller: { listed: true,
// origins: [origin] | null }, each entry an origin parseOriginList keeps.
export function checkBakedOrigins(o) {
  const shape = o && typeof o === 'object' && o.listed === true && (o.origins === null || Array.isArray(o.origins));
  if (!shape) throw new Error('mcpOrigins must be { listed: true, origins: [origin] | null }');
  if (o.origins !== null) {
    const parsed = parseOriginList(o.origins.join(','));
    if (parsed.rejected.length || parsed.any || parsed.origins.size !== o.origins.length || !o.origins.every((x) => parsed.origins.has(x))) {
      throw new Error(`mcpOrigins: every entry must be an origin as the URL parser writes it (scheme://host[:port]): ${JSON.stringify(o.origins)}`);
    }
  }
  return o;
}

/** How the summary names a baked origin list. */
const originsText = (o) => (o.origins === null ? 'any (*)' : o.origins.join(', '));

// The bundle is served without the server, so a root-relative brand URL is
// a server path: refused with the field named and the fix spelled (the
// leftover guard in buildStudioBundle would refuse the favicon anyway, with
// a worse message). The default hero is not a brand's choice — an unnamed
// but configured brand inherits '/assets/observogram-hero.png' exactly as
// every unbranded bundle does — so it passes: the static host serves that
// asset or the brand names its own hero.src (docs/DOWNSTREAM.md §10).
export function checkBrandUrls(b) {
  for (const [field, value, dflt] of [['favicon', b.favicon, DEFAULT_BRAND.favicon], ['logo.url', b.logo.url, DEFAULT_BRAND.logo.url], ['hero.src', b.hero.src, DEFAULT_BRAND.hero.src]]) {
    if (value && value !== dflt && /^\/(?!\/)/.test(value)) {
      throw new Error(`brand ${field} ${JSON.stringify(value)} is a server path — the bundle is served without the server; use an absolute URL (https://…, data:…) or a path relative to the bundle's own directory (${JSON.stringify(value.slice(1))})`);
    }
  }
  return b;
}

// The brand to bake: the --brand file, else the file OBSERVOGRAM_BRAND_FILE
// names, with the OBSERVOGRAM_BRAND_* scalars on top either way — tools/lib/
// brand-env.mjs loadBrand, the server's one loader (so "renders identically"
// holds by construction, and OBSERVOGRAM_BRAND_NAME=Acme alone is the
// one-field rebadge), over a synthetic env: the chosen file absolute so the
// cwd is ours, the legacy file spelling silenced so it cannot shadow the
// flag; an env that is not process.env is never cached. The refusal names
// what was actually set — a brand the environment supplied is refused behind
// its variable, the server-path refusal included, so a build machine
// configured for a server is told where the brand came from (the --brand
// case keeps checkBrandUrls' own text: the flag is on the command line).
// Returns { brand: normalized | null, source: 'flag' | 'env' | null, file:
// absolute | null } — `env` with `file: null` is the scalars alone.
export function loadBundleBrand(opts, env = process.env, cwd = process.cwd()) {
  const flag = opts.brand ? resolve(cwd, opts.brand) : null;
  const envFile = brandEnvFrom(env, 'BRAND_FILE');
  const file = flag ?? (envFile ? resolve(cwd, envFile) : null);
  const origin = flag ? '--brand' : envFile ? 'OBSERVOGRAM_BRAND_FILE' : 'OBSERVOGRAM_BRAND_*';
  let brand;
  try { brand = loadBrandFromEnv({ env: { ...env, OBSERVOGRAM_BRAND_FILE: file ?? '', TOMOGRAPH_BRAND_FILE: '' } }); }
  catch (e) { throw new Error(`${origin}: ${e.message}`, { cause: e }); }
  if (flag && !brand.configured) throw new Error(`--brand: brand file ${file}: an empty brand (no field set) — nothing to bake`);
  if (!brand.configured) return { brand: null, source: null, file: null };
  try { checkBrandUrls(brand); }
  catch (e) { throw flag ? e : new Error(`${origin}: ${e.message}`, { cause: e }); }
  return { brand, source: flag ? 'flag' : 'env', file };
}

// ---------- the packs ----------

const PACK_EXT_RE = /\.(?:pack\.)?(?:ya?ml|json)$/i;

export function defaultPackId(fileOrUrlPath) {
  return fileSlug(basename(fileOrUrlPath).replace(PACK_EXT_RE, ''), 'pack') || 'pack';
}

// A --pack file: parsed as server/index.mjs loadPackFile does, validated
// against the spec schema. Throws with the validator's texts.
export function loadPackFile(file, schema, { cwd = process.cwd() } = {}) {
  const abs = resolve(cwd, file);
  if (!existsSync(abs)) throw new Error(`pack file missing: ${file}`);
  const text = readFileSync(abs, 'utf8');
  const canonical = extname(abs).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text);
  const errors = validateCanonical(canonical, schema);
  if (errors.length) throw new Error(`${file} fails the ObservabilityPack schema:\n  - ${errors.join('\n  - ')}`);
  return canonical;
}

// A --pack-url: http(s), no userinfo, no credential-bearing query (the rule
// of tools/lib/mcp-url-safety.mjs stripMcpUrl) — the URL is baked into a
// file that gets distributed and printed by --json. Returns the URL as given.
export function checkPackUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error(`--pack-url ${JSON.stringify(raw)} is not a URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`--pack-url must be http(s): ${url.protocol}`);
  const { safe, dropped } = stripMcpUrl(raw);
  if (url.username || url.password) throw new Error(`--pack-url carries credentials (userinfo) — a pack URL is baked into the bundle, which is distributed; use ${safe}`);
  if (dropped.length) throw new Error(`--pack-url carries a credential in its query (${dropped.join(', ')}) — a pack URL is baked into the bundle, which is distributed; use ${safe}`);
  return url.href;
}

// ---------- the CLI ----------

export function parseArgs(argv) {
  const opts = { packs: [], out: DEFAULT_OUT, remoteFonts: true, check: false, json: false, help: false, taxonomy: null, brand: null, mcpSettingsPolicy: null, mcpOrigins: null };
  const need = (i, a) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value\n${usage}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--check') { opts.check = true; continue; }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--no-remote-fonts') { opts.remoteFonts = false; continue; }
    if (a === '--out') { opts.out = need(++i, a); continue; }
    if (a === '--taxonomy' || a === '--brand') {
      const key = a.slice(2);
      if (opts[key] !== null) throw new Error(`${a} given twice\n${usage}`);
      opts[key] = need(++i, a);
      continue;
    }
    if (a === '--mcp-settings-policy' || a === '--mcp-origins') {
      const key = a === '--mcp-origins' ? 'mcpOrigins' : 'mcpSettingsPolicy';
      if (opts[key] !== null) throw new Error(`${a} given twice\n${usage}`);
      opts[key] = need(++i, a);
      continue;
    }
    if (a === '--pack') { opts.packs.push({ file: need(++i, a) }); continue; }
    if (a === '--pack-url') { opts.packs.push({ url: need(++i, a) }); continue; }
    if (a === '--id' || a === '--label' || a === '--description') {
      const last = opts.packs[opts.packs.length - 1];
      if (!last) throw new Error(`${a} must follow a --pack or --pack-url\n${usage}`);
      last[a.slice(2)] = need(++i, a);
      continue;
    }
    throw new Error(`unknown argument ${a}\n${usage}`);
  }
  return opts;
}

// `env` is the environment the seams fall back to (OBSERVOGRAM_TAXONOMY,
// OBSERVOGRAM_BRAND_FILE, OBSERVOGRAM_BRAND_*, OBSERVOGRAM_MCP_SETTINGS_POLICY,
// OBSERVOGRAM_MCP_ORIGINS): a parameter so a suite stays
// hermetic against the developer's shell.
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), root = DEFAULT_ROOT, env = process.env } = {}) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (e) { stderr.write(`${e.message}\n`); return 2; }
  if (opts.help) { stdout.write(`${usage}\n`); return 0; }
  try {
    const schema = JSON.parse(readFileSync(resolve(root, SPEC_SCHEMA_PATH), 'utf8'));
    const packs = [];
    const ids = new Set();
    for (const p of opts.packs) {
      let entry;
      if (p.url) {
        const href = checkPackUrl(p.url);
        const id = p.id || defaultPackId(new URL(href).pathname);
        entry = { id, label: p.label || id, description: p.description, url: href };
      } else {
        const canonical = loadPackFile(p.file, schema, { cwd });
        const id = p.id || defaultPackId(p.file);
        entry = { id, label: p.label || canonical.metadata?.name || id, description: p.description, canonical };
      }
      if (ids.has(entry.id)) throw new Error(`two packs share the id ${JSON.stringify(entry.id)} — give one an --id`);
      ids.add(entry.id);
      packs.push(entry);
    }
    // The seams: the taxonomy (the flag, else the server's variable) and the
    // brand (the flag, else the server's file and scalars) — each refusal is
    // the server's text behind the origin that was set.
    const tax = resolveTaxonomySource(opts, env, cwd);
    const taxLoaded = tax ? loadTaxonomyFile(tax.file, tax.origin) : null;
    const br = loadBundleBrand(opts, env, cwd);
    // The MCP server-settings seams: the policy (the flag, else the server's
    // variable) and the origin list (the flag, else OBSERVOGRAM_MCP_ORIGINS).
    const pol = resolveSettingsPolicySource(opts, env, cwd);
    const polLoaded = pol ? loadSettingsPolicyFile(pol.file, pol.origin) : null;
    const origins = resolveMcpOrigins(opts, env);
    const built = buildStudioBundle({
      root, packs, remoteFonts: opts.remoteFonts, taxonomy: taxLoaded?.taxonomy ?? null, brand: br.brand,
      mcpSettingsPolicy: polLoaded?.policy ?? null, mcpOrigins: origins?.origins ?? null,
    });
    const out = resolve(cwd, opts.out);
    if (!opts.check) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, built.html);
    }
    // What was baked, said only when something was: the unconfigured line is unchanged.
    const polRules = polLoaded ? polLoaded.compiled.rules.length : 0;
    const baked = `${taxLoaded ? ` · taxonomy: ${describeTaxonomy(taxLoaded.compiled)}` : ''}${br.brand ? ` · brand: ${br.brand.name}` : ''}`
      + `${polLoaded ? ` · MCP settings policy: ${polRules} rule${polRules === 1 ? '' : 's'}` : ''}${origins ? ` · MCP origins: ${originsText(origins.origins)}` : ''}`;
    const summary = `${built.modules.length} modules · ${built.stylesheets.length} stylesheets · ${built.bytes} bytes · ${packs.length} pack${packs.length === 1 ? '' : 's'}${baked}`;
    if (opts.json) {
      stdout.write(`${JSON.stringify({
        ok: true,
        out: opts.check ? null : out,
        check: opts.check,
        bytes: built.bytes,
        modules: built.modules.length,
        stylesheets: built.stylesheets,
        remoteFonts: opts.remoteFonts,
        packs: packs.map((p) => ({ id: p.id, label: p.label, source: p.url ? 'url' : 'file', ...(p.url ? { url: stripMcpUrl(p.url).safe } : {}) })),
        // Always present so a script can read them; the paths, never the contents.
        taxonomy: taxLoaded ? { source: tax.origin === '--taxonomy' ? 'flag' : 'env', file: tax.file, types: taxLoaded.compiled.types.size, ids: taxLoaded.compiled.ids.length } : null,
        brand: br.brand ? { source: br.source, file: br.file, name: br.brand.name } : null,
        mcpSettingsPolicy: polLoaded ? { source: pol.origin === '--mcp-settings-policy' ? 'flag' : 'env', file: pol.file, rules: polRules } : null,
        mcpOrigins: origins ? { source: origins.origin === '--mcp-origins' ? 'flag' : 'env', origins: origins.origins.origins } : null,
      }, null, 2)}\n`);
    } else {
      stdout.write(opts.check ? `ok (not written): ${summary}\n` : `wrote ${out} — ${summary}\n`);
    }
    return 0;
  } catch (e) {
    if (opts.json) stdout.write(`${JSON.stringify({ ok: false, error: e.message })}\n`);
    stderr.write(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main());
}
