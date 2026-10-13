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
// file that assumes no server: studio/static-backend.mjs answers the pack
// routes and Compare's computations in the browser and says "no backend" for
// the rest.
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
// The licences (docs/DOWNSTREAM.md §10): every bundle carries Observogram's
// MIT licence, in full, in one `<script type="text/plain"
// id="observogram-licenses">` element at the end of `<head>` — never executed
// or rendered, kept by minifiers that strip comments, readable by
// textContent — beside the spec's provenance (vendor/observability-pack-spec/
// VERSIONS.json; that repository publishes no licence file, and the block
// says so instead of claiming one). One comment line after the doctype points
// a human opening the file at the element. verifyBundleNotices(html) checks a
// finished file — the build's, or one a downstream pipeline rewrote.
//
// npm packages (docs/DOWNSTREAM.md §10): a tools/lib module may import a
// package by its bare name when VENDOR-MANIFEST.json lists that name in the
// module's npm field. The bundle then inlines the package and every package
// it imports, each as one import-map entry under its own name — its ES module
// entry file's bytes as npm ci installed them from package-lock.json, nothing
// rewritten — and the licence block names each with its version, licence id,
// source repository, licence files, NOTICE files and the copyright lines its
// file carries. collectBundledPackages reads the lockfile's entries and the
// files they name, never resolves a module and never compares a file with
// the registry's; it refuses a package it cannot account for (not in the
// lockfile, installed at another version, a second copy an importer would
// load, an import its package.json does not declare, no licence file) with a
// sentence that names a fix. A studio module never imports a package: the
// live studio loads tools/lib through the server's /lib mount, which has no
// import map (tools/test-studio-bundle.mjs T1 holds the live graph to none).
//
// Zero dependencies beyond Node: fs, path, this repo's tools/lib and the
// tokenizer of tools/gen-vendor-manifest.mjs — and, for the packages the
// bundled tools/lib modules import (VENDOR-MANIFEST.json's npm field and what
// those packages import), the files package-lock.json installs under
// node_modules: read, never resolved, never compared with the registry. No
// bundler.
// Exit 0 built · 1 a pack fails the schema, a specifier cannot be inlined, a
// file is missing, a licence text cannot be embedded · 2 usage.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
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

// A bare specifier: neither a path (./, ../, /) nor a URL (node:, https:, …).
const isBare = (spec) => !/^(?:\.{0,2}\/|[a-z][a-z\d+.-]*:)/i.test(spec);
// The package a bare specifier names: its first segment, or its first two
// when scoped (@scope/name).
export function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

// The npm packages each tools/lib module may import: VENDOR-MANIFEST.json's
// `modules[path].npm` (gen-vendor-manifest.mjs records each module's bare
// imports there), read once from `root`. Returns path → [name].
export function manifestNpm(root = DEFAULT_ROOT) {
  const file = resolve(root, 'VENDOR-MANIFEST.json');
  if (!existsSync(file)) throw new Error(`VENDOR-MANIFEST.json is missing from ${root} — copy it with the tree: it names the npm packages each tools/lib module may import, which the bundle inlines`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`VENDOR-MANIFEST.json in ${root} does not parse (${e.message}) — restore it from the same upstream commit as the tree, or regenerate it there (npm run vendor-manifest)`, { cause: e });
  }
  const modules = manifest && typeof manifest.modules === 'object' && manifest.modules !== null ? manifest.modules : {};
  return (path) => (Array.isArray(modules[path]?.npm) ? modules[path].npm : []);
}

// Every module reachable from the entries: Map<key, { path, src, imports }>,
// with `graph.packages`, the Set of npm packages the modules import by name.
// A bare specifier is accepted in a tools/lib module only, and only when it
// is a name `npmOf(path)` lists (by default VENDOR-MANIFEST.json's npm field,
// read at the first bare import met); it is recorded as { spec, key: spec,
// package: spec }. Throws naming file:line for any other specifier that
// cannot be inlined, a module outside studio/ and tools/lib, or a file that
// is not there.
export function collectModuleGraph(root = DEFAULT_ROOT, entries = ENTRIES, { read, npmOf } = {}) {
  const readFile = read || ((rel) => {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) throw new Error(`module file missing: ${rel}`);
    return readFileSync(abs, 'utf8');
  });
  let manifest = null;
  const npmFor = npmOf || ((path) => (manifest ??= manifestNpm(root))(path));
  const packages = new Set();
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
        const at = `${path}:${lineOf(src, index)}`;
        if (path.startsWith('tools/lib/') && isBare(spec)) {
          const name = packageNameOf(spec);
          if (spec !== name) throw new Error(`${at}: cannot inline the specifier '${spec}' — a package is bundled by its own name (${name}), never a file inside it`);
          if (!npmFor(path).includes(name)) throw new Error(`${at}: cannot inline the specifier '${spec}' — a package is bundled only when VENDOR-MANIFEST.json lists it in this module's npm field (a package.json dependency; npm run vendor-manifest)`);
          imports.push({ spec, key: spec, package: spec });
          packages.add(spec);
          continue;
        }
        throw new Error(`${at}: cannot inline the specifier '${spec}' — only ./, ../ and /lib/ paths into studio/ and tools/lib/ are bundled (a bare package or node:* module cannot be)`);
      }
      imports.push({ spec, key: enqueue(target, `${path}:${lineOf(src, index)}`) });
    }
    graph.set(key, { path, src, imports });
  }
  graph.packages = packages;
  return graph;
}

// ---------- the npm packages a bundle carries ----------

const NOTICE_FILE_RE = /^notice(?:\.md|\.txt)?$/i;
const COPYRIGHT_LINE_RE = /^\s*(?:\/\/|\/?\*+)\s*(copyright\b.*?)\s*(?:\*\/)?\s*$/gim;
const BUILD_MACHINE_FIX = '(npm ci --omit=dev on a build machine that needs no dev tools)';

// Where a package says its source lives (package.json `repository`, a string
// or its `url`): `git+` and `.git` dropped, `git://` read as https; null
// unless that is an https URL without userinfo. It is how a reader finds
// what the package does not ship (an upstream NOTICE, its history).
export function sourceUrlOf(repository) {
  const raw = typeof repository === 'string' ? repository : repository && typeof repository.url === 'string' ? repository.url : null;
  if (!raw) return null;
  let url;
  try { url = new URL(raw.trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://')); } catch { return null; }
  return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
}

// The ES module entry package.json names: `exports.import` when `exports` is
// a conditions object, else `exports["."].import` — a string, or an object's
// `default` — with the leading ./ dropped; never `main` or `module`. null
// when there is none inside the package.
function esmEntryOf(pkg) {
  const ex = pkg.exports;
  const pick = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.default === 'string' ? v.default : null);
  let rel = null;
  if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
    if (Object.hasOwn(ex, 'import')) rel = pick(ex.import);
    else if (ex['.'] && typeof ex['.'] === 'object') rel = pick(ex['.'].import);
  }
  if (rel === null) return null;
  rel = rel.replace(/^\.\//, '');
  return rel && !rel.split('/').includes('..') && !rel.startsWith('/') ? rel : null;
}

// The packages a bundle carries: `roots` — the names graph.packages holds,
// as a Map name → the module that imports it, or an iterable of names — and
// every package they import, breadth-first. Each is read from its
// package-lock.json entry and the files npm ci installed under node_modules:
// never resolved, never compared with the registry's package. Returns
// Map<name, { name, version, license, entry, bytes, src: Buffer, imports:
// [name], licenceFiles: [{ name, text }], notice: [{ name, text }] | null,
// copyright: string | null, source: string | null }> in code-point order of
// the name — empty, reading nothing, when there is no root. Each refusal
// names a fix that works for whoever runs the build; `root` appears in
// stderr only, never in the file.
export function collectBundledPackages(root = DEFAULT_ROOT, roots = []) {
  const rootPairs = roots instanceof Map ? [...roots] : [...roots].map((name) => [name, 'a bundled tools/lib module']);
  if (!rootPairs.length) return new Map();
  rootPairs.sort((a, b) => codePointOrder(a[0], b[0]));
  const lockPath = resolve(root, 'package-lock.json');
  if (!existsSync(lockPath)) {
    throw new Error(`package-lock.json is missing from ${root} — the bundle inlines ${rootPairs.map(([n]) => n).join(', ')} and the packages they need at the versions the committed lockfile pins: copy package-lock.json with the tree, then run npm ci there`);
  }
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch (e) {
    throw new Error(`package-lock.json in ${root} does not parse (${e.message}) — restore it from the same commit as the tree`, { cause: e });
  }
  if (!(Number(lock.lockfileVersion) >= 2)) throw new Error(`package-lock.json is lockfileVersion ${lock.lockfileVersion ?? 'unknown'}; the bundle reads version 2 or 3 (npm 7 or newer)`);
  const entries = lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
  const found = new Map();
  const queue = rootPairs;
  while (queue.length) {
    const [name, importer] = queue.shift();
    if (found.has(name)) continue;
    if (name === 'lib' || name === 'studio' || name.startsWith('lib/') || name.startsWith('studio/')) {
      throw new Error(`${name}: a package named lib or studio collides with the bundle's own import-map keys`);
    }
    const locked = entries[`node_modules/${name}`];
    if (!locked) throw new Error(`${name}: package-lock.json has no node_modules/${name} entry — ${importer} needs it; install it (npm install) and commit the lockfile`);
    const dir = resolve(root, 'node_modules', ...name.split('/'));
    const pkgFile = resolve(dir, 'package.json');
    if (!existsSync(pkgFile)) throw new Error(`${name}: not installed (node_modules/${name}/package.json is missing in ${root}) — run npm ci there ${BUILD_MACHINE_FIX}`);
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch (e) {
      throw new Error(`${name}: node_modules/${name}/package.json does not parse (${e.message}) — run npm ci there ${BUILD_MACHINE_FIX}`, { cause: e });
    }
    if (pkg.version !== locked.version) throw new Error(`${name}: installed ${pkg.version}, package-lock.json pins ${locked.version} — run npm ci there, so the bundle is built from the committed lockfile ${BUILD_MACHINE_FIX}`);
    const v = pkg.version;
    if (pkg.license !== locked.license) throw new Error(`${name} ${v}: package.json declares the licence ${pkg.license ?? 'none'}, package-lock.json ${locked.license ?? 'none'} — run npm ci there ${BUILD_MACHINE_FIX}`);
    if (typeof pkg.license !== 'string' || !pkg.license.trim()) throw new Error(`${name} ${v} declares no licence (a "license" SPDX id in its package.json) — the bundle redistributes it and must name its licence; review the dependency before bundling it`);
    const entry = esmEntryOf(pkg);
    if (!entry) throw new Error(`${name} ${v}: package.json exports no ES module entry (exports.import or exports["."].import) — the bundle inlines ES modules only`);
    const entryFile = resolve(dir, ...entry.split('/'));
    if (!existsSync(entryFile)) throw new Error(`${name} ${v}: its entry ${entry} is not installed (node_modules/${name}/${entry} is missing in ${root}) — run npm ci there ${BUILD_MACHINE_FIX}`);
    const src = readFileSync(entryFile);
    const text = src.toString('utf8');
    const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.peerDependencies || {})]);
    const deps = [];
    for (const { spec, index } of importSpecifiers(text)) {
      const at = `${name}/${entry}:${lineOf(text, index)}`;
      if (spec.startsWith('node:')) throw new Error(`${at}: imports '${spec}' — a node:* module cannot run in a browser`);
      if (!isBare(spec) || packageNameOf(spec) !== spec) throw new Error(`${at}: imports '${spec}' — the bundle inlines one file per package, so a package that imports a file (its own or another package's) cannot be bundled`);
      if (!declared.has(spec)) throw new Error(`${at}: imports '${spec}', which ${name} does not declare in dependencies or peerDependencies`);
      if (entries[`node_modules/${name}/node_modules/${spec}`]) {
        throw new Error(`${spec}: package-lock.json installs a second copy at node_modules/${name}/node_modules/${spec}, which ${name} loads instead of node_modules/${spec} — the bundle carries one copy of each package under its own name. Make one version serve every importer: add "overrides": { "${spec}": "${entries[`node_modules/${spec}`]?.version ?? '<the hoisted version>'}" } to package.json (npm 8.3 or newer), run npm install, and commit the lockfile`);
      }
      if (!deps.includes(spec)) deps.push(spec);
    }
    const files = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort(codePointOrder);
    const readText = (file) => {
      const t = readFileSync(resolve(dir, file), 'utf8');
      assertEmbeddable(t, `${name} ${v}`, file);
      return { name: file, text: t };
    };
    const licenceFiles = files.filter((f) => LICENCE_FILE_RE.test(f)).map(readText);
    if (!licenceFiles.length) throw new Error(`${name} ${v} ships no licence file (LICENSE, LICENCE or COPYING at its root) — the bundle redistributes it and must carry its licence; review the dependency before bundling it`);
    const notices = files.filter((f) => NOTICE_FILE_RE.test(f)).map(readText);
    const lines = [...new Set([...text.matchAll(COPYRIGHT_LINE_RE)].map((m) => m[1]))];
    const copyright = lines.length ? lines.join(' · ') : null;
    if (copyright) assertEmbeddable(copyright, `${name} ${v}`, entry);
    found.set(name, {
      name, version: v, license: pkg.license, entry, bytes: src.length, src, imports: [...deps].sort(codePointOrder),
      licenceFiles, notice: notices.length ? notices : null, copyright, source: sourceUrlOf(pkg.repository),
    });
    for (const dep of [...deps].sort(codePointOrder)) queue.push([dep, name]);
  }
  return new Map([...found.keys()].sort(codePointOrder).map((n) => [n, found.get(n)]));
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

// ---------- the licences ----------

export const LICENCES_ID = 'observogram-licenses';
const LICENCES_OPEN = `<script type="text/plain" id="${LICENCES_ID}">`;
const SPEC_VERSIONS = 'vendor/observability-pack-spec/VERSIONS.json';
// A licence file at a package's root (LICENSE, LICENCE.md, COPYING, …).
export const LICENCE_FILE_RE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]+)?$/i;
const MIT_GRANT = 'Permission is hereby granted';
const MIT_DISCLAIMER = 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND';

// The comment line after the doctype, worded for what the file holds — for a
// human opening the file; the element is what carries the texts.
export function pointerComment(withPackages) {
  return withPackages
    ? `<!-- Licences: this file contains Observogram (MIT) and third-party packages; their full texts are in the ${LICENCES_OPEN} element in the head. -->`
    : `<!-- Licence: this file contains Observogram (MIT) and no third-party package; its full text is in the ${LICENCES_OPEN} element in the head. -->`;
}

// A text the block embeds must not end the element early ("</script") or
// open a comment ("<!--", which changes how the parser reads "</script"
// inside the element). Such a text refuses the build: a licence is
// reproduced as written, never escaped.
function assertEmbeddable(text, who, file) {
  const m = /<\/script|<!--/i.exec(text);
  if (m) throw new Error(`${who}: ${file} contains "${m[0] === '<!--' ? '<!--' : '</script'}" and cannot be embedded in the bundle's licence block`);
}

// Observogram's licence (LICENSE at the root, verbatim) and the spec's
// provenance (the upstream repository and commit VERSIONS.json records),
// read from the tree the bundle is built from. `root` appears in a refusal
// only — stderr, never the file.
export function readOwnNotices(root = DEFAULT_ROOT, version) {
  const licencePath = resolve(root, 'LICENSE');
  if (!existsSync(licencePath)) throw new Error(`LICENSE is missing from ${root} — every bundle carries Observogram's licence; copy LICENSE with the tree`);
  const licence = readFileSync(licencePath, 'utf8');
  assertEmbeddable(licence, `Observogram ${version}`, 'LICENSE');
  let upstream = null;
  try { upstream = JSON.parse(readFileSync(resolve(root, SPEC_VERSIONS), 'utf8')).upstream; } catch { /* refused below */ }
  if (!upstream || typeof upstream.repo !== 'string' || !upstream.repo || typeof upstream.commit !== 'string' || !upstream.commit) {
    throw new Error(`${SPEC_VERSIONS} is missing from ${root} or names no upstream repo and commit — copy vendor/observability-pack-spec/ with the tree: every bundle embeds the spec's schema and says where it comes from`);
  }
  assertEmbeddable(`${upstream.repo} ${upstream.commit}`, 'the spec', SPEC_VERSIONS);
  return { licence, spec: { repo: upstream.repo, commit: upstream.commit } };
}

const codePointOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const endLine = (t) => (t.endsWith('\n') ? t : `${t}\n`);

// The block's text: the preamble, Observogram's section, one section per
// package in code-point order of its name — { name, version, license, entry,
// source?, copyright?, licenceFiles: [{ name, text }], notice: [{ name, text }]
// | null } — and the spec's. Every text verbatim (a final newline added only
// when it has none); a pure function of its input, so one tree builds one
// block.
export function licenceBlockText({ version, licence, packages = [], spec }) {
  const preamble = [
    `This file is a build of the Observogram studio, version ${version} (tools/build-studio-bundle.mjs).`,
    ...(packages.length
      ? [
        "It contains Observogram's code and the third-party packages listed below, each with its",
        "licence in full. Each package's file is one entry of this file's import map, embedded as",
        'npm ci installed it from package-lock.json: this build changes nothing in it, and does not',
        'compare it with the package the registry publishes. Licence and NOTICE files are the ones',
        'the published package contains.',
      ]
      : ["It contains Observogram's code and no third-party package."]),
  ];
  const sections = [`==== Observogram ${version} — MIT ====\n${endLine(licence)}`];
  for (const p of [...packages].sort((a, b) => codePointOrder(a.name, b.name))) {
    const lines = [`==== ${p.name} ${p.version} — ${p.license} ====`, `File: ${p.entry} (import-map entry "${p.name}"), as installed.`];
    if (p.source) lines.push(`Source: ${p.source}`);
    if (p.copyright) lines.push(`Copyright lines in the file: ${p.copyright}`);
    let s = `${lines.join('\n')}\n`;
    for (const f of [...p.licenceFiles, ...(p.notice || [])]) s += `---- ${f.name} ----\n${endLine(f.text)}`;
    sections.push(s);
  }
  sections.push([
    '==== The ObservabilityPack spec ====',
    "The spec schema embedded in this file (and any pack built in from the spec's examples) comes",
    `from ${spec.repo} at commit ${spec.commit}; that`,
    'repository publishes no licence file.',
  ].join('\n') + '\n');
  const text = `${preamble.join('\n')}\n\n${sections.join('\n')}`;
  assertEmbeddable(text, 'the licence block', 'its text');
  return text;
}

// The page with the licence element at the end of <head> and the pointer
// comment right after the doctype.
function withLicences(html, text, withPackages) {
  const doctype = /^<!doctype html>\n/i.exec(html);
  if (!doctype) throw new Error('studio/index.html: expected to start with <!doctype html> (the licence pointer goes right after it)');
  if (html.indexOf('</head>') < 0 || html.indexOf('</head>') !== html.lastIndexOf('</head>')) throw new Error('studio/index.html: expected exactly one </head>');
  const element = `${LICENCES_OPEN}\n${text}</script>`;
  const out = `${doctype[0]}${pointerComment(withPackages)}\n${html.slice(doctype[0].length)}`;
  return out.replace('</head>', `${element}\n</head>`);
}

// A page read the way an HTML parser reads its structure: every comment and
// the text of every <script> and <style> element blanked (indices kept), so a
// stylesheet, a script or a comment that spells a tag is not one; with the
// page's script elements ({ index, attrs, content }) and its comments.
function markupOf(html) {
  const scripts = [];
  const comments = [];
  let blank = '';
  let at = 0;
  const open = /<!--|<(script|style)\b([^>]*)>/gi;
  let m;
  while ((m = open.exec(html))) {
    let from;
    let to;
    if (m[0] === '<!--') {
      const end = html.indexOf('-->', m.index + 4);
      from = m.index;
      to = end < 0 ? html.length : end + 3;
      comments.push(html.slice(from, to));
    } else {
      from = m.index + m[0].length;
      const close = new RegExp(`</${m[1]}`, 'gi');
      close.lastIndex = from;
      const c = close.exec(html);
      to = c ? c.index : html.length;
      if (m[1].toLowerCase() === 'script') {
        const attrs = {};
        for (const a of m[2].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
        scripts.push({ index: m.index, attrs, content: html.slice(from, to) });
      }
    }
    blank += html.slice(at, from) + ' '.repeat(to - from);
    at = to;
    open.lastIndex = to;
  }
  blank += html.slice(at);
  return { blank, scripts, comments };
}

// What a finished bundle must carry — the build's own file, or one a
// pipeline rewrote after it (attributes reordered, comments stripped) — as
// { ok, packages: [name], problems: [sentence] }. Checked: exactly one
// #observogram-licenses element, text/plain, in <head>; Observogram's MIT
// section with the grant and the warranty disclaimer; for every import-map
// key that is neither studio/… nor lib/… (a bundled package), exactly one
// section headed with its name, version and licence id, a File: line naming
// that key and at least one licence text; no section for a package the map
// does not carry; the pointer comment, when the file still has it, worded
// for what the map carries. Not checked: whether the texts are the installed
// packages' (tools/test-bundle-compare.mjs compares them with node_modules).
export function verifyBundleNotices(html) {
  const problems = [];
  const { blank, scripts, comments } = markupOf(String(html));
  const mapScript = scripts.find((s) => (s.attrs.type || '').toLowerCase() === 'importmap');
  let keys = [];
  if (!mapScript) problems.push('the file has no import map');
  else {
    try { keys = Object.keys(JSON.parse(mapScript.content).imports || {}); } catch (e) { problems.push(`the import map does not parse (${e.message})`); }
  }
  const packages = keys.filter((k) => !k.startsWith('studio/') && !k.startsWith('lib/')).sort(codePointOrder);
  const blocks = scripts.filter((s) => s.attrs.id === LICENCES_ID);
  if (blocks.length !== 1) {
    problems.push(blocks.length ? `the file has ${blocks.length} #${LICENCES_ID} elements; it must have exactly one` : `the file has no ${LICENCES_OPEN} element — the licences are not embedded`);
  } else {
    const [block] = blocks;
    if ((block.attrs.type || '').toLowerCase() !== 'text/plain') problems.push(`#${LICENCES_ID} is not type="text/plain"`);
    const headEnd = blank.search(/<\/head\b|<body\b/i);
    if (headEnd < 0 || block.index > headEnd) problems.push(`#${LICENCES_ID} is not in <head>`);
    const sections = [];
    for (const line of block.content.split('\n')) {
      const h = /^==== (.+) ====$/.exec(line);
      if (h) sections.push({ header: h[1], lines: [] });
      else if (sections.length) sections[sections.length - 1].lines.push(line);
    }
    const own = sections.find((s) => /^Observogram \S+ — MIT$/.test(s.header));
    if (!own) problems.push('no "Observogram <version> — MIT" section');
    else {
      const body = own.lines.join('\n');
      if (!body.includes(MIT_GRANT)) problems.push(`the Observogram section does not hold the MIT licence's grant ("${MIT_GRANT}")`);
      if (!body.includes(MIT_DISCLAIMER)) problems.push('the Observogram section does not hold the MIT licence\'s warranty disclaimer');
    }
    const packageSections = sections
      .map((s) => ({ ...s, m: /^(\S+) (\S+) — (.+)$/.exec(s.header) }))
      .filter((s) => s.m && s.m[1] !== 'Observogram');
    for (const name of packages) {
      const mine = packageSections.filter((s) => s.m[1] === name);
      if (mine.length !== 1) { problems.push(mine.length ? `${name}: ${mine.length} licence sections; one per package` : `${name}: no licence section (==== ${name} <version> — <licence id> ====)`); continue; }
      const { lines } = mine[0];
      if (!lines.some((l) => l.startsWith('File: ') && l.includes(`(import-map entry "${name}")`))) problems.push(`${name}: its section has no File: line naming the import-map entry "${name}"`);
      let licenceText = false;
      for (let i = 0; i < lines.length; i++) {
        const f = /^---- (.+) ----$/.exec(lines[i]);
        if (!f || !LICENCE_FILE_RE.test(f[1])) continue;
        const next = lines.slice(i + 1);
        const end = next.findIndex((l) => /^---- .+ ----$/.test(l));
        if ((end < 0 ? next : next.slice(0, end)).join('').trim()) licenceText = true;
      }
      if (!licenceText) problems.push(`${name}: its section holds no licence text (---- LICENSE ---- and the text)`);
    }
    for (const s of packageSections) if (!packages.includes(s.m[1])) problems.push(`${s.m[1]}: a licence section for a package the import map does not carry`);
  }
  const pointers = comments.filter((c) => /^<!-- Licences?: this file contains Observogram\b/.test(c));
  if (pointers.length > 1) problems.push(`the file has ${pointers.length} licence pointer comments; it must have at most one`);
  else if (pointers.length === 1 && pointers[0] !== pointerComment(packages.length > 0)) {
    const worded = pointers[0] === pointerComment(true) ? 'third-party packages' : pointers[0] === pointerComment(false) ? 'no third-party package' : 'neither form';
    problems.push(`the licence pointer comment is worded for ${worded}; the import map carries ${packages.length ? packages.join(', ') : 'none'}`);
  }
  return { ok: problems.length === 0, packages, problems };
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

// { html, modules: [{ key, bytes }], thirdParty: [{ name, version, license, entry, bytes }], stylesheets: [names], config, bytes, taxonomy, brand }
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
  // Observogram's licence and the spec's provenance: every bundle carries them.
  const own = readOwnNotices(root, pkgVersion);

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
  // The npm packages the modules import, and what those import: each entry
  // file's bytes as installed, under the package's own name, after the
  // repository modules (a module's bare specifier is left as written, and
  // the map resolves it — from a data: module too).
  const rootsOf = new Map();
  for (const mod of graph.values()) for (const imp of mod.imports) if (imp.package && !rootsOf.has(imp.package)) rootsOf.set(imp.package, mod.path);
  const bundled = collectBundledPackages(root, rootsOf);
  const thirdParty = [];
  for (const p of bundled.values()) {
    imports[p.name] = `data:text/javascript;base64,${p.src.toString('base64')}`;
    thirdParty.push({ name: p.name, version: p.version, license: p.license, entry: p.entry, bytes: p.bytes });
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

  // The licences, last: the element at the end of <head>, the pointer after the doctype.
  html = withLicences(html, licenceBlockText({ version: pkgVersion, licence: own.licence, packages: [...bundled.values()], spec: own.spec }), bundled.size > 0);

  const leftover = /(?:href|src)="\/[^"]*"/.exec(html);
  if (leftover) throw new Error(`the bundle still references the server: ${leftover[0]}`);

  return { html, modules, thirdParty, stylesheets, config, bytes: Buffer.byteLength(html, 'utf8'), taxonomy, brand: branded, mcpSettingsPolicy, mcpOrigins };
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
        // The npm packages embedded: names, versions, SPDX ids, entry files, bytes — no path.
        thirdParty: built.thirdParty,
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
