// tools/test-studio-bundle.mjs — the embeddable studio bundle (W6).
//
//   node --test tools/test-studio-bundle.mjs
//
// T1 the module graph · T2 the specifier rewrite · T3 the build (a real
// bundle in a tmpdir: every data: module parses, the stylesheets in order,
// nothing left pointing at the server, the guards and the CLI exits) · T4
// inert by default (a build changes no source file; the live studio never
// imports the shim; the shim links headlessly) · T5 parity against a running
// child server for every route the shim ports — payment-service (an example
// pack) and a library-built pack registered through POST /api/validate, so
// onPlaceholder is compared too; export.zip headers and entry names · T6 the
// denial table · T7 the REAL bundle booted in headless Chromium against the
// fixture pack, the Export download and the audit-report anchor's 501 sentence
// asserted · T4b inert by default: a build
// with nothing baked is the build of the same tree with --taxonomy/--brand
// unset, byte for byte (config-vs-no-config identity on the same tree — the
// shim's source changed, so no cross-tree claim) · T8 a --taxonomy bundle
// answers /api/taxonomy as a server started with OBSERVOGRAM_TAXONOMY does
// and its board is the typed-canonical mapped golden · T8c a v2 taxonomy's
// glossary is baked and answered as the server answers it · T8b a --brand bundle
// carries the branded server's shell fragments · T9 the baked bundle in
// headless Chromium (skips like T7).
//
// Playwright is an environment-provided tool, never a dependency:
// OBSERVOGRAM_PLAYWRIGHT names its index.mjs (else the bare 'playwright');
// T7 skips when neither imports or the browser does not launch, unless
// OBSERVOGRAM_BUNDLE_SMOKE=require (CI with browsers) turns the skip into a
// failure. Hermetic: the page may only reach the loopback server that
// serves the bundle; the child server AND every CLI spawn get serve-child's
// stripped env (both spellings of TAXONOMY and the nine BRAND_* names), so a
// developer shell with OBSERVOGRAM_BRAND_NAME exported bakes into no test
// build (T4b, T7's exact texts).
//
// `document` is named only inside page.evaluate callbacks, which run in the browser.
/* global document */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, sep } from 'node:path';

import {
  collectModuleGraph, rewriteSpecifiers, assertRewritten, inlineJson, styleBlock, buildStudioBundle,
  checkPackUrl, parseArgs, defaultPackId, ENTRIES, CONFIG_ID, DEFAULT_ROOT,
  resolveTaxonomySource, loadTaxonomyFile, loadBundleBrand, checkBrandUrls,
  resolveSettingsPolicySource, loadSettingsPolicyFile, resolveMcpOrigins, checkBakedOrigins,
} from './build-studio-bundle.mjs';
import { createStaticBackend, featureOf, denialText, noticeText, apiMenuSubText, DENIED, FEATURES } from '../studio/static-backend.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { listEnvironments } from './lib/adapter.mjs';
import { listTargets } from './lib/compile.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { normalizeBrand, DEFAULT_BRAND, SHELL_ANCHORS } from './lib/brand.mjs';
import * as artefactClassify from './lib/artefact-classify.mjs';
import { bindTaxonomy } from '../studio/taxonomy.mjs';
import { serve, childEnv } from '../server/fixtures/serve-child.mjs';
// The board renderer the goldens are made with (its top level binds no override and reads the catalogue; isMain is false here).
import { renderBoard, familiesOf, boardGroupCounts } from './test-golden-board.mjs';

const ROOT = DEFAULT_ROOT;
const TOOL = resolve(ROOT, 'tools/build-studio-bundle.mjs');
const PAYMENT = 'vendor/observability-pack-spec/v1.4/examples/payment-service.pack.yaml';
const GOLDEN = 'tools/fixtures/golden-crawl.pack.json';
const LIBRARY_BUILT = 'tools/fixtures/build/orders-api.tier-2.instantiate.json';
// The seams' fixtures: the taxonomy override, the canonical pack with seven declared
// types (the golden-board fixture), the bundle-safe brand and the server's brand (root-relative URLs).
const TAX = resolve(DEFAULT_ROOT, 'tools/fixtures/taxonomy/taxonomy.json');
const TAX_V2 = resolve(DEFAULT_ROOT, 'tools/fixtures/taxonomy/taxonomy.v2.json');
const TYPED_CANONICAL = resolve(DEFAULT_ROOT, 'tools/fixtures/taxonomy/typed-canonical.pack.json');
const ACME_STATIC = resolve(DEFAULT_ROOT, 'tools/fixtures/brand/acme-static.json');
const ACME = resolve(DEFAULT_ROOT, 'tools/fixtures/brand/acme.json');
// The MCP server-settings policy (the SPEC's example; server/test-mcp-settings.mjs reads it too).
const MSP = resolve(DEFAULT_ROOT, 'tools/fixtures/mcp-settings/policy.json');
const MAPPED_BOARD = 'tools/fixtures/golden/board/typed-canonical.mapped.board.html';
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const schema = JSON.parse(read(SPEC_SCHEMA_PATH));
const paymentCanonical = parseYaml(read(PAYMENT));
const ordersCanonical = JSON.parse(read(LIBRARY_BUILT)).canonical;
const TMP = mkdtempSync(join(tmpdir(), 'observogram-studio-bundle-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const filesUnder = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(resolve(ROOT, dir));
  return out.sort();
};
const treeHashes = (dirs) => Object.fromEntries(dirs.flatMap(filesUnder).map((p) => [p, sha256(readFileSync(p))]));
// Every CLI spawn gets the stripped env (serve-child STRIP: TAXONOMY, the BRAND_* names, MCP_SETTINGS_POLICY and MCP_ORIGINS, both spellings) plus the test's own.
const cli = (args, cwd = TMP, extraEnv = {}) => spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', env: childEnv(null, extraEnv) });
// The body as JSON when it is (a compiled 'all' dashboards bundle carries
// comments under a JSON content type on both sides), else as text.
const bodyOf = async (r) => {
  const text = await r.text();
  if (!(r.headers.get('content-type') || '').includes('application/json')) return text;
  try { return JSON.parse(text); } catch { return text; }
};
const DATA_PREFIX = 'data:text/javascript;base64,';
const decodeModule = (address) => {
  assert.ok(address.startsWith(DATA_PREFIX), `a data: module address: ${address.slice(0, 40)}`);
  return Buffer.from(address.slice(DATA_PREFIX.length), 'base64').toString('utf8');
};
const importMapOf = (html) => JSON.parse(/<script type="importmap">([\s\S]*?)<\/script>/.exec(html)[1]);
const configOf = (html) => JSON.parse(new RegExp(`<script type="application/json" id="${CONFIG_ID}">([\\s\\S]*?)</script>`).exec(html)[1]);
const normalizeBuiltAt = (html) => html.replace(/"builtAt":"[^"]*"/, '"builtAt":"x"');
// The shell fragments brandShellHtml writes — each exactly once on a branded shell, absent (undefined) on the shipped one.
const BRAND_FRAGMENTS = {
  title: /<title>[^<]*<\/title>/g,
  description: /<meta name="description" content="[^"]*">/g,
  h1: /<h1>[\s\S]*?<\/h1>/g,
  hdrSub: /<div class="hdr-sub">[^<]*<\/div>/g,
  footer: /<footer class="ftr">[\s\S]*?<\/footer>/g,
  tokens: /<style id="brand-tokens">[\s\S]*?<\/style>/g,
  config: /<script type="application\/json" id="brand-config">.*?<\/script>/g,
  icon: /<link rel="icon" href="[^"]*">/g,
};
const brandFragmentsOf = (html, { branded }) => Object.fromEntries(Object.entries(BRAND_FRAGMENTS).map(([k, re]) => {
  const m = [...html.matchAll(re)].map((x) => x[0]);
  const expected = branded || !['tokens', 'config', 'icon'].includes(k) ? 1 : 0;
  assert.equal(m.length, expected, `${k}: ${expected} occurrence(s)`);
  return [k, m[0]];
}));

// The entry names of a ZIP, from its central directory (tools/lib/zip.mjs writes one).
function zipEntryNames(bytes) {
  const b = Buffer.from(bytes);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'the zip has an end-of-central-directory record');
  const count = b.readUInt16LE(eocd + 10);
  let at = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(at), 0x02014b50, 'a central file header');
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    names.push(b.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// ---------- T1 the graph ----------

test('T1 collectModuleGraph: every module under studio/ or lib/, the dynamic /lib imports reached, no node:* or bare specifier, a bare one throws naming the file', () => {
  const graph = collectModuleGraph(ROOT, ENTRIES);
  const keys = [...graph.keys()];
  assert.ok(keys.length > 60, `a real graph (${keys.length} modules)`);
  assert.ok(keys.every((k) => k.startsWith('studio/') || k.startsWith('lib/')), 'every key is studio/… or lib/…');
  for (const k of ['studio/app.mjs', 'studio/static-backend.mjs', 'lib/service-keys.mjs', 'lib/crawler.mjs', 'lib/mcp-url-safety.mjs', 'lib/artefact-classify.mjs', 'lib/library.mjs', 'lib/zip.mjs', 'lib/brand.mjs', 'lib/remediation-flow.mjs']) {
    assert.ok(graph.has(k), `${k} is in the graph`);
  }
  // The call-time engines reach the graph through the REAL views' dynamic imports — a
  // literal specifier each (a const would not be collected and the panel would stay off).
  assert.deepEqual(graph.get('studio/brand.mjs').imports.map((i) => i.spec).filter((sp) => sp.startsWith('/lib/')), ['/lib/brand.mjs'], 'studio/brand.mjs → /lib/brand.mjs');
  assert.deepEqual(graph.get('studio/remediation-flow-view.mjs').imports.map((i) => i.spec).filter((sp) => sp.startsWith('/lib/')), ['/lib/remediation-flow.mjs'], 'studio/remediation-flow-view.mjs → /lib/remediation-flow.mjs (B3.3: the response path renders in the bundle)');
  for (const [k, mod] of graph) {
    assert.ok(!/from\s+['"]node:/.test(mod.src), `${k} imports no node:* module`);
    assert.equal(mod.path, k.startsWith('lib/') ? `tools/lib/${k.slice(4)}` : k);
    for (const imp of mod.imports) assert.ok(graph.has(imp.key), `${k} → ${imp.spec} resolves to a graph module (${imp.key})`);
  }
  // The regex that collects is not the one that would be fooled: a string ending in "import" is not a side-effect import.
  const files = {
    'studio/app.mjs': "import { a } from './a.mjs';\nconst t = { note: 'nothing to import', tone: 'x' };\n",
    'studio/a.mjs': "export const a = 1; // import('/lib/zz.mjs') in a comment is not collected\n",
    'studio/static-backend.mjs': "import '/lib/side.mjs';\nexport const s = 1;\n",
    'tools/lib/side.mjs': 'export const side = 1;\n',
  };
  const synthetic = collectModuleGraph(ROOT, ENTRIES, { read: (p) => { if (!(p in files)) throw new Error(`module file missing: ${p}`); return files[p]; } });
  assert.deepEqual([...synthetic.keys()].sort(), ['lib/side.mjs', 'studio/a.mjs', 'studio/app.mjs', 'studio/static-backend.mjs']);
  // A bare package: thrown, with the file and line.
  files['studio/a.mjs'] = "export const a = 1;\nimport x from '@x/y';\n";
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => files[p] }), /studio\/a\.mjs:2: cannot inline the specifier '@x\/y'/);
  files['studio/a.mjs'] = "import { readFileSync } from 'node:fs';\nexport const a = 1;\n";
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => files[p] }), /studio\/a\.mjs:1: cannot inline the specifier 'node:fs'/);
  // A module outside the two trees.
  files['studio/a.mjs'] = "export * from '../tools/fetch-live-pack.mjs';\n";
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => files[p] ?? '' }), /tools\/fetch-live-pack\.mjs is outside studio\/ and tools\/lib\//);
  // A missing file.
  delete files['tools/lib/side.mjs'];
  files['studio/a.mjs'] = 'export const a = 1;\n';
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => { if (!(p in files)) throw new Error(`module file missing: ${p}`); return files[p]; } }), /module file missing: tools\/lib\/side\.mjs/);
  // The shape of tools/lib/compile.mjs: a `//` comment holding `/*`, later a
  // template literal holding `*/` — a regex comment strip pairs the two and
  // swallows everything between, and a specifier after them would be neither
  // collected nor flagged. The tokenizer sees it: collected when it resolves,
  // thrown with its file:line when it does not.
  const trap = (line) => `// provisioning/alerting/*.yaml\nexport const a = 1;\n${line}\nexport const banner = (id) => \`/* === ${'${id}'} === */\`;\n`;
  files['tools/lib/side.mjs'] = 'export const side = 1;\n';
  files['studio/a.mjs'] = trap("export const probe = () => import('/lib/side.mjs');");
  const trapped = collectModuleGraph(ROOT, ENTRIES, { read: (p) => { if (!(p in files)) throw new Error(`module file missing: ${p}`); return files[p]; } });
  assert.deepEqual(trapped.get('studio/a.mjs').imports.map((i) => i.spec), ['/lib/side.mjs'], 'the import() between the comment trap and the template is collected');
  files['studio/a.mjs'] = trap("export const probe = () => import('./does-not-exist.mjs');");
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => { if (!(p in files)) throw new Error(`module file missing: ${p}`); return files[p]; } }), /module file missing: studio\/does-not-exist\.mjs/);
  files['studio/a.mjs'] = trap("import x from '@x/y';");
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => files[p] }), /studio\/a\.mjs:3: cannot inline the specifier '@x\/y'/);
  // Over the real tools/lib/compile.mjs the trap is live: a probe placed right after its `/*`-in-comment line is seen.
  const compileSrc = readFileSync(join(ROOT, 'tools/lib/compile.mjs'), 'utf8');
  const markAt = compileSrc.indexOf('provisioning/alerting/*.yaml');
  assert.ok(markAt > 0 && compileSrc.indexOf('`/* === ${', markAt) > markAt, 'compile.mjs still carries the `/*`-in-comment and `*/`-in-template pair this guards');
  const probeAt = compileSrc.indexOf('\n', markAt) + 1;
  const probed = `${compileSrc.slice(0, probeAt)}export const probe = () => import('./does-not-exist.mjs');\n${compileSrc.slice(probeAt)}`;
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => (p === 'tools/lib/compile.mjs' ? probed : readFileSync(join(ROOT, p), 'utf8')) }), (e) => /tools\/lib\/does-not-exist\.mjs/.test(String(e.message).split(sep).join('/')), 'the probe past compile.mjs:605 is collected and resolved (the ENOENT text names the host path, so its separator is normalised)');
});

// ---------- T2 the rewrite ----------

test('T2 rewriteSpecifiers: every import form, comments and non-import strings untouched, byte-identical when nothing matches; the post-rewrite assertion', () => {
  const cases = [
    ["import { a } from './b.mjs';", "import { a } from 'studio/b.mjs';"],
    ["import {\n  a,\n  b\n} from './b.mjs';", "import {\n  a,\n  b\n} from 'studio/b.mjs';"],
    ["export { x } from './c.mjs';", "export { x } from 'studio/c.mjs';"],
    ["export * from '../tools/lib/d.mjs';", "export * from 'lib/d.mjs';"],
    ['import x from "./d.mjs";', 'import x from "studio/d.mjs";'],
    ["const m = import('/lib/d.mjs').catch(() => null);", "const m = import('lib/d.mjs').catch(() => null);"],
    ["const m = await import('/lib/e.mjs');", "const m = await import('lib/e.mjs');"],
    ["const m = await import('/lib/e');", "const m = await import('lib/e.mjs');"],
    ["import './side.mjs';", "import 'studio/side.mjs';"],
    ["import { q } from './q.mjs'; // import('/lib/zz.mjs')", "import { q } from 'studio/q.mjs'; // import('/lib/zz.mjs')"],
    ["/* import('/lib/zz.mjs') */ const t = `from './tpl.mjs' ${import('./e.mjs')}`; const r = /from '.\\/x'/;", "/* import('/lib/zz.mjs') */ const t = `from './tpl.mjs' ${import('studio/e.mjs')}`; const r = /from '.\\/x'/;"],
    ["// provisioning/alerting/*.yaml\nconst b = `/* === ${1} === */`;\nexport const probe = () => import('./after.mjs');", "// provisioning/alerting/*.yaml\nconst b = `/* === ${1} === */`;\nexport const probe = () => import('studio/after.mjs');"],
    ["const s = './not-an-import.mjs'; const t = { note: 'nothing to import', tone: 'x' };", null],
    ["import x from '@x/y';\nconst u = new URL('https://example.com/lib/x.mjs');", null],
    ['const a = 1;\nconst b = 2;\n', null],
  ];
  for (const [src, want] of cases) {
    assert.equal(rewriteSpecifiers(src, 'studio/x.mjs'), want ?? src, src);
  }
  // From a lib module, ./ is lib-relative and ../../studio reaches the studio.
  assert.equal(rewriteSpecifiers("import { a } from './b.mjs';\nimport { c } from '../../studio/c.mjs';", 'lib/x.mjs'), "import { a } from 'lib/b.mjs';\nimport { c } from 'studio/c.mjs';");
  assert.equal(rewriteSpecifiers("import { a } from './b.mjs';", 'lib/a/x.mjs'), "import { a } from 'lib/a/b.mjs';");
  // The whole graph rewrites with nothing left behind.
  for (const [key, mod] of collectModuleGraph(ROOT, ENTRIES)) assertRewritten(rewriteSpecifiers(mod.src, key), key);
  assert.throws(() => assertRewritten("import { a } from './left.mjs';", 'studio/x.mjs'), /studio\/x\.mjs:1: a path specifier survived the rewrite/);
  assert.throws(() => assertRewritten("const m = import('/lib/left.mjs');", 'studio/x.mjs'), /a path specifier survived/);
  assert.doesNotThrow(() => assertRewritten("// import('/lib/left.mjs') in a comment\nconst s = './data.mjs';", 'studio/x.mjs'));
  assert.throws(() => assertRewritten("// provisioning/alerting/*.yaml\nconst b = `/* === ${1} === */`;\nexport const probe = () => import('./left.mjs');", 'studio/x.mjs'), /studio\/x\.mjs:3: a path specifier survived the rewrite: \.\/left\.mjs/);
});

// ---------- T3 the build ----------

test('T3 buildStudioBundle: a real bundle — every data: module parses, the stylesheets in order, the config, nothing pointing at the server; the escaping and the stylesheet guard', () => {
  const built = buildStudioBundle({
    root: ROOT,
    packs: [
      { id: 'payment-service', label: 'Payment', description: 'd', canonical: paymentCanonical },
      { id: 'golden', label: 'Golden crawl', canonical: JSON.parse(read(GOLDEN)) },
    ],
    remoteFonts: true,
    builtAt: '2026-10-04T00:00:00.000Z',
  });
  const { html } = built;
  const map = importMapOf(html);
  const graph = collectModuleGraph(ROOT, ENTRIES);
  assert.deepEqual(Object.keys(map.imports).sort(), [...graph.keys()].sort(), 'one import-map entry per graph module');
  assert.equal(built.modules.length, graph.size);
  // Every module decodes and parses.
  const dir = join(TMP, 'modules');
  for (const [key, address] of Object.entries(map.imports)) {
    const src = decodeModule(address);
    const file = join(dir, key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, src);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${key} parses: ${r.stderr}`);
    assert.ok(!/\bfrom\s+['"](\.{1,2}\/|\/lib\/)/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')), `${key}: no path specifier left`);
  }
  // The stylesheets, in index.html's order, then the notice's.
  const hrefs = [...read('studio/index.html').matchAll(/<link rel="stylesheet" href="\/([\w.-]+\.css)">/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<style data-src="([\w.-]+\.css)">/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 15);
  assert.deepEqual(styles, [...hrefs, 'static-backend.css']);
  assert.deepEqual(built.stylesheets, styles);
  assert.equal(styles[0], 'design-tokens.css');
  assert.equal(styles[14], 'reskin.css');
  for (const name of styles) assert.ok(html.includes(read(`studio/${name}`)), `${name} is inlined verbatim`);
  // Nothing points at the server.
  assert.ok(!/(?:href|src)="\//.test(html), 'no href="/ or src="/ left');
  assert.ok(!html.includes('<link rel="stylesheet"'), 'no stylesheet link left');
  assert.ok(!html.includes('src="/app.mjs"'), 'the app script is replaced');
  assert.ok(!/['"]\/lib\//.test(decodeModule(map.imports['studio/app.mjs'])), 'app.mjs no longer names /lib/');
  // The config.
  const config = configOf(html);
  assert.deepEqual(config, built.config);
  assert.deepEqual(Object.keys(config), ['version', 'builtAt', 'schema', 'packs'], 'the unconfigured config: four keys, this order');
  assert.equal(built.taxonomy, null);
  assert.equal(built.brand, null);
  // The shell is the unbranded one: no brand script, tokens or icon; the shipped anchors intact.
  assert.ok(!html.includes('id="brand-config"') && !html.includes('id="brand-tokens"') && !html.includes('<link rel="icon"'), 'nothing of a brand in the shell');
  assert.ok(html.includes(SHELL_ANCHORS.title) && html.includes(SHELL_ANCHORS.h1) && html.includes(SHELL_ANCHORS.hdrSub), 'the shipped anchors are there');
  assert.equal(config.version, JSON.parse(read('package.json')).version);
  assert.equal(config.builtAt, '2026-10-04T00:00:00.000Z');
  assert.deepEqual(config.schema, schema);
  assert.equal(config.packs.length, 2);
  assert.deepEqual(config.packs.map((p) => [p.id, p.label, p.source, !!p.canonical]), [['payment-service', 'Payment', 'bundle', true], ['golden', 'Golden crawl', 'bundle', true]]);
  assert.equal(config.packs[0].description, 'd');
  assert.ok(!('description' in config.packs[1]), 'no description key when none was given');
  // The scripts, in order: config, import map, the install, the app.
  const order = ['<script type="application/json" id="observogram-static-config">', '<script type="importmap">', "import { installStaticBackend } from 'studio/static-backend.mjs'", "import 'studio/app.mjs';"].map((s) => html.indexOf(s));
  assert.ok(order.every((i, n) => i > 0 && (n === 0 || i > order[n - 1])), `the scripts in order: ${order}`);
  assert.ok(html.includes('<noscript>'), 'a noscript fallback');
  // Fonts: kept by default, dropped with remoteFonts: false.
  assert.ok(html.includes('fonts.googleapis.com'));
  const noFonts = buildStudioBundle({ root: ROOT, packs: [], remoteFonts: false, builtAt: 'x' }).html;
  assert.ok(!noFonts.includes('fonts.googleapis.com') && !noFonts.includes('fonts.gstatic.com'), 'no remote fonts');
  assert.deepEqual(configOf(noFonts).packs, [], 'an empty catalogue builds');
  // Escaping: a pack string that tries to close the script or open a comment cannot.
  const hostile = inlineJson({ a: '</script><!--', b: 'x y' });
  assert.ok(!hostile.includes('</') && !hostile.includes('<!--') && !hostile.includes(' '), hostile);
  assert.deepEqual(JSON.parse(hostile), { a: '</script><!--', b: 'x y' });
  const evil = buildStudioBundle({ root: ROOT, packs: [{ id: 'e', label: '</script><script>alert(1)</script>', canonical: paymentCanonical }], builtAt: 'x' }).html;
  assert.equal((evil.match(/<\/script>/g) || []).length, (html.match(/<\/script>/g) || []).length, 'the label closes no script');
  assert.equal(configOf(evil).packs[0].label, '</script><script>alert(1)</script>');
  // The stylesheet guard.
  assert.throws(() => styleBlock('x.css', '.a { color: red } </style><script>1</script>'), /studio\/x\.css contains "<\/style"/);
  assert.throws(() => styleBlock('x.css', '</STYLE'), /contains "<\/style"/);
  assert.equal(styleBlock('x.css', '.a{}'), '<style data-src="x.css">\n.a{}\n</style>');
});

test('T3 the CLI: writes, --check writes nothing, --json, --no-remote-fonts, a pack that fails the schema exits 1 with the validator text, pack-url refusals, usage exits 2', () => {
  const out = join(TMP, 'cli', 'studio.html');
  const w = cli(['--pack', resolve(ROOT, PAYMENT), '--label', 'Payment service (canonical example)', '--pack', resolve(ROOT, GOLDEN), '--id', 'golden', '--out', out, '--no-remote-fonts']);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /^wrote .*studio\.html — \d+ modules · 16 stylesheets · \d+ bytes · 2 packs\n$/);
  const html = readFileSync(out, 'utf8');
  const config = configOf(html);
  assert.deepEqual(config.packs.map((p) => [p.id, p.label]), [['payment-service', 'Payment service (canonical example)'], ['golden', 'golden']]);
  assert.ok(!html.includes('fonts.googleapis.com'));
  // The default id and label: the file name without .pack.yaml, the pack's name.
  assert.equal(defaultPackId('/x/y/payment-service.pack.yaml'), 'payment-service');
  assert.equal(defaultPackId('My Pack.json'), 'my-pack');
  assert.equal(defaultPackId('.yaml'), 'pack');
  const named = cli(['--check', '--json', '--pack', resolve(ROOT, PAYMENT)]);
  assert.equal(named.status, 0, named.stderr);
  const j = JSON.parse(named.stdout);
  assert.equal(j.ok, true);
  assert.equal(j.check, true);
  assert.equal(j.out, null);
  assert.deepEqual(j.packs, [{ id: 'payment-service', label: 'payment-service', source: 'file' }]);
  assert.equal(j.stylesheets.length, 16);
  assert.equal(j.taxonomy, null, 'nothing baked: taxonomy null, the key present');
  assert.equal(j.brand, null, 'nothing baked: brand null, the key present');
  assert.equal(j.mcpSettingsPolicy, null, 'nothing baked: mcpSettingsPolicy null, the key present');
  assert.equal(j.mcpOrigins, null, 'nothing baked: mcpOrigins null, the key present');
  assert.deepEqual(Object.keys(j), ['ok', 'out', 'check', 'bytes', 'modules', 'stylesheets', 'remoteFonts', 'packs', 'taxonomy', 'brand', 'mcpSettingsPolicy', 'mcpOrigins']);
  // --taxonomy / --brand / --mcp-settings-policy / --mcp-origins twice: usage, exit 2.
  for (const flag of ['--taxonomy', '--brand', '--mcp-settings-policy', '--mcp-origins']) {
    const twice = cli(['--check', flag, TAX, flag, TAX]);
    assert.equal(twice.status, 2, flag);
    assert.match(twice.stderr, new RegExp(`^${flag} given twice\\nusage: build-studio-bundle\\.mjs`));
  }
  // --check writes nothing.
  const checkDir = join(TMP, 'check');
  mkdirSync(checkDir);
  const c = cli(['--check', '--pack', resolve(ROOT, PAYMENT)], checkDir);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^ok \(not written\): \d+ modules · 16 stylesheets · \d+ bytes · 1 pack\n$/);
  assert.deepEqual(readdirSync(checkDir), [], '--check wrote nothing');
  // The default --out is dist/studio/index.html under the cwd.
  const defDir = join(TMP, 'default-out');
  mkdirSync(defDir);
  const d = cli([], defDir);
  assert.equal(d.status, 0, d.stderr);
  assert.ok(existsSync(join(defDir, 'dist/studio/index.html')));
  assert.deepEqual(configOf(readFileSync(join(defDir, 'dist/studio/index.html'), 'utf8')).packs, []);
  // A pack that fails the schema: exit 1, the validator's text, nothing written.
  const bad = join(TMP, 'bad.pack.yaml');
  writeFileSync(bad, 'apiVersion: observability.platform/v1\nkind: ObservabilityPack\nspec: {}\n');
  const badOut = join(TMP, 'bad-out', 'index.html');
  const b = cli(['--pack', bad, '--out', badOut]);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /bad\.pack\.yaml fails the ObservabilityPack schema:\n {2}- .*metadata/);
  assert.ok(!existsSync(badOut), 'nothing written');
  const missing = cli(['--pack', join(TMP, 'nope.pack.yaml')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /pack file missing: .*nope\.pack\.yaml/);
  // --pack-url: credentials refused, the stripped form named, --json prints stripped URLs only.
  const userinfo = cli(['--check', '--pack-url', 'https://alice:s3cret@packs.example.com/p.pack.yaml']);
  assert.equal(userinfo.status, 1);
  assert.match(userinfo.stderr, /--pack-url carries credentials \(userinfo\)/);
  assert.ok(!userinfo.stderr.includes('s3cret') && !userinfo.stdout.includes('s3cret'), 'the secret is in no output');
  const tokenQuery = cli(['--check', '--json', '--pack-url', 'https://packs.example.com/p.pack.yaml?token=abc123&x=1']);
  assert.equal(tokenQuery.status, 1);
  assert.match(tokenQuery.stderr, /carries a credential in its query \(token\)/);
  assert.ok(!tokenQuery.stdout.includes('abc123') && !tokenQuery.stderr.includes('abc123'));
  assert.equal(JSON.parse(tokenQuery.stdout).ok, false);
  assert.throws(() => checkPackUrl('ftp://x/y.yaml'), /must be http\(s\)/);
  assert.throws(() => checkPackUrl('not a url'), /is not a URL/);
  assert.equal(checkPackUrl('https://packs.example.com/p.pack.yaml?x=1'), 'https://packs.example.com/p.pack.yaml?x=1');
  const url = cli(['--check', '--json', '--pack-url', 'https://packs.example.com/dir/orders.pack.yaml?x=1', '--label', 'Orders']);
  assert.equal(url.status, 0, url.stderr);
  assert.deepEqual(JSON.parse(url.stdout).packs, [{ id: 'orders', label: 'Orders', source: 'url', url: 'https://packs.example.com/dir/orders.pack.yaml?x=1' }]);
  // Two packs with one id.
  const twins = cli(['--check', '--pack', resolve(ROOT, PAYMENT), '--pack', resolve(ROOT, PAYMENT)]);
  assert.equal(twins.status, 1);
  assert.match(twins.stderr, /two packs share the id "payment-service"/);
  // Usage.
  for (const args of [['--bogus'], ['--pack'], ['--id', 'x'], ['--out'], ['--taxonomy'], ['--brand'], ['--mcp-settings-policy'], ['--mcp-origins']]) {
    const u = cli(['--check', ...args]);
    assert.equal(u.status, 2, args.join(' '));
    assert.match(u.stderr, /usage: build-studio-bundle\.mjs/);
  }
  assert.equal(cli(['--help']).status, 0);
  assert.deepEqual(parseArgs(['--pack', 'a.yaml', '--id', 'a', '--label', 'A', '--description', 'D', '--pack-url', 'https://x/y.yaml', '--description', 'E', '--check']).packs,
    [{ file: 'a.yaml', id: 'a', label: 'A', description: 'D' }, { url: 'https://x/y.yaml', description: 'E' }]);
});

test('T3b every flag the CLI accepts is in its usage line, the README synopsis and DOWNSTREAM §9/§10', () => {
  const src = readFileSync(join(DEFAULT_ROOT, 'tools', 'build-studio-bundle.mjs'), 'utf8');
  const flags = [...new Set([...src.matchAll(/a === '(--[a-z-]+)'/g)].map(m => m[1]))];
  assert.ok(flags.includes('--description') && flags.length >= 8, flags.join(' '));
  const usageLine = src.match(/^const usage = `([^`]*)`/m)[1];
  const readme = readFileSync(join(DEFAULT_ROOT, 'README.md'), 'utf8');
  const readmeSection = readme.slice(readme.indexOf('### Serve The Studio Without The Server'));
  const downstream = readFileSync(join(DEFAULT_ROOT, 'docs', 'DOWNSTREAM.md'), 'utf8');
  const row = downstream.split('\n').find(l => l.startsWith('| Studio bundle (W6) |'));
  const embedding = downstream.slice(downstream.indexOf('## 10. Embedding the studio'));
  assert.ok(readmeSection.length > 0 && row && embedding.length > 0, 'the three documented places exist');
  const packFlags = ['--pack', '--pack-url', '--id', '--label', '--description'];
  const bakeFlags = ['--taxonomy', '--brand', '--mcp-settings-policy', '--mcp-origins'];
  assert.ok(bakeFlags.every((f) => flags.includes(f)), 'the four seams are flags');
  for (const f of flags) {
    if (f === '--help') continue;
    for (const [name, text] of [['usage line', usageLine], ['README', readmeSection]]) assert.ok(text.includes(f), `${f} is documented in the ${name}`);
    if (!packFlags.includes(f) && !bakeFlags.includes(f)) continue; // --check/--json/--out/--no-remote-fonts are the CLI's, not the pack catalogue's or the seams'
    for (const [name, text] of [['DOWNSTREAM §9 row', row], ['DOWNSTREAM §10', embedding]]) assert.ok(text.includes(f), `${f} is documented in the ${name}`);
  }
  // --description is a per-pack option of both --pack and --pack-url.
  assert.match(usageLine, /--pack-url <url> \[--id <id>\] \[--label <text>\] \[--description <text>\]/);
});

test('T3c every feature the shim denies is named in the README 501 list and the DOWNSTREAM §10 denial cell', () => {
  const readme = readFileSync(join(DEFAULT_ROOT, 'README.md'), 'utf8').replace(/\s+/g, ' ');
  const list = readme.slice(readme.indexOf('Everything the server alone can do — '), readme.indexOf("`501 { denied: 'no-backend'"));
  const downstream = readFileSync(join(DEFAULT_ROOT, 'docs', 'DOWNSTREAM.md'), 'utf8');
  const row = downstream.split('\n').find(l => l.startsWith('| `GET /api/packs`'));
  assert.ok(list.length > 0 && row, 'the two lists exist');
  const cell = row.slice(row.indexOf('every other `/api` or `/auth` path'));
  // The shim's name → how the two lists spell it (the README abbreviates two of them).
  const spelled = {
    'Refresh from MCP': /Refresh from MCP/, 'Scan a repo': /Scan a repo/, 'Draft from a live MCP server': /Draft from MCP/,
    'Testing an MCP connection': /Testing an MCP connection/,
    'Building a pack from a live MCP server': /Building a pack from a live MCP server/,
    'Passing MCP server settings through the studio server': /Passing MCP server settings through the studio server/,
    'Uploading a pack': /upload/i, Compare: /Compare/, Deploy: /Deploy/, Journeys: /Journeys/, Build: /Build/,
    Waivers: /Waivers/, Services: /Services \(/, Organisations: /Organisations \(/, Settings: /Settings \(/, 'Sign-in': /sign-in/i,
  };
  for (const [prefix, name] of FEATURES) {
    // The owner console has no door in a bundle (no sign-in, so no owner): neither list names it.
    if (name === 'Administration') continue;
    const re = spelled[name];
    assert.ok(re, `${name} (${prefix}) has a documented spelling`);
    for (const [doc, text] of [['README 501 list', list], ['DOWNSTREAM §10 denial cell', cell]]) assert.match(text, re, `${name} (${prefix}) is named in the ${doc}`);
  }
  // The two slice 6a routes beside their names in DOWNSTREAM, as every other route there.
  assert.match(cell, /Services \(`\/api\/services`, `\/api\/services\/:id`/);
  assert.match(cell, /Organisations \(`\/api\/orgs`/);
  // The Settings routes (slice 6b), every one the page calls.
  assert.match(cell, /Settings \(`\/api\/org`, `\/api\/org\/members`, `\/api\/environments\/:id`, `\/api\/mcp-endpoints`, `\/api\/audit`/);
  assert.ok(cell.indexOf('Services (') < cell.indexOf('sign-in (`/auth/*`)'), 'the order of the shim: sign-in last');
  assert.ok(cell.indexOf('Organisations (') < cell.indexOf('Settings (') && cell.indexOf('Settings (') < cell.indexOf('sign-in (`/auth/*`)'), 'Settings sits before sign-in');
});

// ---------- T4 inert by default ----------

test('T4 inert by default: a build changes no file under studio/, tools/lib or server/; the live studio never imports the shim; the shim links headlessly', async () => {
  const before = treeHashes(['studio', 'tools/lib', 'server']);
  buildStudioBundle({ root: ROOT, packs: [{ id: 'p', label: 'P', canonical: paymentCanonical }], builtAt: 'x' });
  const r = cli(['--pack', resolve(ROOT, PAYMENT), '--out', join(TMP, 'inert', 'index.html')]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(treeHashes(['studio', 'tools/lib', 'server']), before, 'every source file is byte-identical after a build');
  const indexHtml = read('studio/index.html');
  assert.equal((indexHtml.match(/<script type="module" src="\/app\.mjs"><\/script>/g) || []).length, 1, 'the live page still loads /app.mjs, once');
  assert.ok(!indexHtml.includes('static-backend'), 'the live page never names the shim');
  const studioSources = readdirSync(resolve(ROOT, 'studio')).filter((f) => f.endsWith('.mjs') && f !== 'static-backend.mjs');
  for (const f of studioSources) assert.ok(!/static-backend/.test(read(`studio/${f}`)), `${f} does not import the shim`);
  // The shim links headlessly and touches no DOM at module top level.
  const mod = await import('../studio/static-backend.mjs');
  assert.equal(typeof mod.createStaticBackend, 'function');
  assert.equal(typeof mod.installStaticBackend, 'function');
  assert.ok(!/\bfetch\(/.test(read('studio/static-backend.mjs').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1')), 'the shim never spells a fetch call (server/test-authz.mjs guard)');
  // The notice's stylesheet reads tokens only.
  const css = read('studio/static-backend.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css) && !/rgba?\(/.test(css), 'no colour literal');
  assert.ok(/\.no-backend-notice\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*0;/.test(css), 'pinned to the bottom');
});

test('T4b inert by default: a build with nothing baked is the same tree\'s build with the seams unset, byte for byte; the CLI adds nothing; the shim unconfigured; a parent env with the seams set reaches no stripped child', () => {
  const payment = { id: 'payment-service', label: 'payment-service', canonical: paymentCanonical };
  // (1) Determinism for a pinned builtAt — the only non-determinism the build has.
  const a = buildStudioBundle({ root: ROOT, packs: [payment], builtAt: 'x' });
  const b = buildStudioBundle({ root: ROOT, packs: [payment], builtAt: 'x' });
  assert.equal(b.html, a.html, 'two builds, one builtAt: identical');
  assert.equal(a.taxonomy, null);
  assert.equal(a.brand, null);
  // (2) The seams unset in every spelling: the identity (brandShellHtml is the identity for an unconfigured brand; the config gains no key).
  for (const [label, extra] of [['null/null', { taxonomy: null, brand: null, mcpSettingsPolicy: null, mcpOrigins: null }], ['DEFAULT_BRAND', { brand: DEFAULT_BRAND }], ['normalizeBrand({})', { brand: normalizeBrand({}) }], ['raw {}', { brand: {} }]]) {
    const c = buildStudioBundle({ root: ROOT, packs: [payment], builtAt: 'x', ...extra });
    assert.equal(c.html, a.html, `${label}: byte-identical`);
    assert.equal(c.brand, null, `${label}: no brand`);
  }
  assert.deepEqual(Object.keys(a.config), ['version', 'builtAt', 'schema', 'packs']);
  // (3) The CLI path, stripped env, no flags: the same bytes once builtAt is normalized.
  const out = join(TMP, 'inert-cli', 'index.html');
  const r = cli(['--pack', resolve(ROOT, PAYMENT), '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^wrote .* — \d+ modules · 16 stylesheets · \d+ bytes · 1 pack\n$/, 'the human line is today\'s');
  assert.equal(normalizeBuiltAt(readFileSync(out, 'utf8')), normalizeBuiltAt(a.html), 'the CLI adds nothing');
  // (4) The shim with no taxonomy baked: the server's unconfigured answer, the default product.
  const backend = createStaticBackend({ version: '1', schema, packs: [] });
  assert.equal(backend.taxonomyConfigured, false);
  assert.equal(backend.product, 'Observogram');
  return backend.handle('/api/taxonomy').then(async (res) => {
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { ok: true, taxonomy: null, configured: false });
    const ms = await backend.handle('/api/mcp-settings');
    assert.equal(ms.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ms.json(), { ok: true, proxy: false, policy: null, configured: false }, 'no policy, no pass-through, no origin list');
    // (5) The parent env carries the seams; the child env is stripped (childEnv) — nothing bakes. This is
    // what keeps T7's exact texts true on a developer shell with OBSERVOGRAM_BRAND_NAME exported.
    const seams = { OBSERVOGRAM_BRAND_NAME: 'Zed', OBSERVOGRAM_TAXONOMY: TAX, OBSERVOGRAM_MCP_SETTINGS_POLICY: MSP, OBSERVOGRAM_MCP_ORIGINS: 'https://mcp.example.com' };
    const saved = Object.fromEntries(Object.keys(seams).map((k) => [k, process.env[k]]));
    Object.assign(process.env, seams);
    try {
      const env = childEnv(null);
      assert.ok(Object.keys(seams).every((k) => !(k in env)), 'childEnv strips the seams');
      const out5 = join(TMP, 'inert-env', 'index.html');
      const r5 = cli(['--pack', resolve(ROOT, PAYMENT), '--out', out5, '--json']);
      assert.equal(r5.status, 0, r5.stderr);
      const j5 = JSON.parse(r5.stdout);
      assert.equal(j5.taxonomy, null);
      assert.equal(j5.brand, null);
      assert.equal(j5.mcpSettingsPolicy, null);
      assert.equal(j5.mcpOrigins, null);
      const html5 = readFileSync(out5, 'utf8');
      assert.ok(!html5.includes('id="brand-config"') && !('taxonomy' in configOf(html5)), 'nothing baked from the parent env');
      assert.ok(!('mcpSettingsPolicy' in configOf(html5)) && !('mcpOrigins' in configOf(html5)), 'no MCP settings key baked from the parent env');
      assert.equal(normalizeBuiltAt(html5), normalizeBuiltAt(a.html));
      // The same build through main()'s env parameter with the seams set bakes — the env is what decides.
      const r5b = cli(['--check', '--json', '--pack', resolve(ROOT, PAYMENT)], TMP, seams);
      assert.equal(r5b.status, 0, r5b.stderr);
      const j5b = JSON.parse(r5b.stdout);
      assert.equal(j5b.brand?.name, 'Zed');
      assert.equal(j5b.taxonomy?.source, 'env');
      assert.deepEqual(j5b.mcpSettingsPolicy, { source: 'env', file: MSP, rules: 1 });
      assert.deepEqual(j5b.mcpOrigins, { source: 'env', origins: ['https://mcp.example.com'] });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    // A branded build is self-guarding against a reordering of the shell transform: the anchors are on the shipped shell only.
    const branded = buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', brand: JSON.parse(readFileSync(ACME_STATIC, 'utf8')) });
    assert.ok(branded.html.includes('id="brand-config"'));
    assert.throws(() => buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', brand: { name: 'X', tokens: { light: { accent: '#000' } } }, taxonomy: { version: 3 } }), { message: /^taxonomy: version must be 1 or 2/ });
    // A raw brand is told from normalizeBrand's output by its shape, not by a `configured` key it may happen to carry:
    // such an object is normalized (so baked, named, and URL-checked) rather than read as is.
    for (const configured of [true, false]) {
      const raw = buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', brand: { configured, name: 'Raw' } });
      assert.equal(raw.brand?.name, 'Raw', `raw brand with configured: ${configured} is normalized and baked`);
      assert.ok(raw.html.includes('id="brand-config"') && raw.html.includes('Raw'), `configured: ${configured}: the shell is branded`);
      assert.equal(raw.html, buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', brand: normalizeBrand({ configured, name: 'Raw' }) }).html, 'the same bytes as its normalized form');
    }
    assert.throws(() => buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', brand: { configured: true, name: 'Raw', logo: { url: '/assets/logo.svg' } } }), { message: /^brand logo\.url .* is a server path/ }, 'a raw brand with a server path is refused as a brand, not a TypeError');
  });
});

// ---------- T5 parity with the server ----------

test('T5 parity: the shim answers every ported route as a running server does — payment-service and a library-built pack (onPlaceholder); export.zip headers and entries', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-parity-'));
  // The open loopback posture (OBSERVOGRAM_AUTH=off): the one the bundle mirrors.
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const server = async (path) => {
    const r = await fetch(`${child.base}${path}`, { headers: { Accept: 'application/json' } });
    return { status: r.status, type: r.headers.get('content-type'), headers: r.headers, body: await bodyOf(r), raw: r };
  };
  const shim = async (backend, path) => {
    const r = await backend.handle(path);
    assert.ok(r, `${path} is answered by the shim`);
    return { status: r.status, type: r.headers.get('content-type'), headers: r.headers, body: await bodyOf(r), raw: r };
  };
  const same = async (backend, path, { headers = [] } = {}) => {
    const [a, b] = await Promise.all([server(path), shim(backend, path)]);
    assert.equal(b.status, a.status, `${path}: status`);
    assert.equal(b.type, a.type, `${path}: content-type`);
    assert.deepEqual(b.body, a.body, `${path}: body`);
    for (const h of headers) assert.equal(b.headers.get(h), a.headers.get(h), `${path}: ${h}`);
    return a;
  };
  // GET /api/packs/:id/conformance: the server names the service record a
  // registered pack is linked to (`tier.service`, `tier.environment` — STORE_PLAN
  // slice 4 §9); the bundle has no registry, so the shim answers null there
  // and must match everywhere else — the grading itself (graded, pack, from,
  // mismatch) is the pack's own on both sides while no record tier is set.
  const sameConformance = async (backend, path) => {
    const [a, b] = await Promise.all([server(path), shim(backend, path)]);
    assert.equal(b.status, a.status, `${path}: status`);
    assert.equal(b.type, a.type, `${path}: content-type`);
    assert.equal(b.body.tier?.service, null, `${path}: the shim names no service record`);
    assert.equal(b.body.tier?.environment, null, `${path}: the shim names no environment record`);
    assert.deepEqual(b.body, { ...a.body, tier: { ...a.body.tier, service: null, environment: null } }, `${path}: body, the record's ids aside`);
    return a;
  };

  // The example pack, with the server's label and description.
  const examples = (await server('/api/examples')).body.examples;
  const example = examples.find((p) => p.id === 'payment-service');
  assert.ok(example, 'the server knows payment-service as an example');
  // The library-built pack, registered on the server through POST /api/validate (open posture, loopback).
  const registered = await fetch(`${child.base}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ordersCanonical) }).then((r) => r.json());
  assert.equal(registered.ok, true, JSON.stringify(registered.errors));
  const ordersId = registered.registered.id;
  assert.ok(Array.isArray(registered.summary?.onPlaceholder) && registered.summary.onPlaceholder.length > 0, 'the fixture carries placeholders');
  const serverCatalog = (await server('/api/packs')).body.packs;
  const ordersEntry = serverCatalog.find((p) => p.id === ordersId);
  assert.ok(ordersEntry, 'the registered pack is in the catalogue');

  const backend = createStaticBackend({
    version: JSON.parse(read('package.json')).version,
    schema,
    packs: [
      { id: 'payment-service', label: example.label, description: example.description, canonical: paymentCanonical },
      { id: ordersId, label: ordersEntry.label, description: ordersEntry.description, canonical: ordersCanonical },
    ],
  });

  // The catalogue entries, field by field (the server lists the example under /api/examples).
  const shimCatalog = (await shim(backend, '/api/packs')).body.packs;
  assert.deepEqual(shimCatalog[0], example, '/api/packs entry = the server /api/examples entry');
  // The registry's entry (tools/lib/service-keys.mjs catalogEntryOf) adds `source: 'uploaded'`; a disk pack has no source.
  const { source: registrySource, ...ordersDiskEntry } = ordersEntry;
  assert.equal(registrySource, 'uploaded');
  assert.deepEqual(shimCatalog[1], ordersDiskEntry, '/api/packs entry = the server catalogue entry for the registered pack, on the disk-entry fields');

  const envs = listEnvironments(paymentCanonical);
  assert.ok(envs.length >= 2, `environments: ${envs}`);
  const targets = listTargets();
  assert.ok(targets.length >= 4, `targets: ${targets}`);

  for (const id of ['payment-service', ordersId]) {
    const base = `/api/packs/${encodeURIComponent(id)}`;
    const packEnvs = id === 'payment-service' ? envs : listEnvironments(ordersCanonical);
    await same(backend, base);
    for (const env of packEnvs) {
      await same(backend, `${base}?env=${encodeURIComponent(env)}`);
      await sameConformance(backend, `${base}/conformance?env=${encodeURIComponent(env)}`);
      await same(backend, `${base}/canonical?env=${encodeURIComponent(env)}`);
      await same(backend, `${base}/compile-catalog?env=${encodeURIComponent(env)}`);
    }
    const conf = await sameConformance(backend, `${base}/conformance`);
    // GAP batch 2, B3.1: a bundled pack is never registered, so the empty
    // verdicts document IS the server's answer (the registered pack has no
    // verdict recorded on this fresh server either).
    const verdicts = await same(backend, `${base}/verdicts`);
    assert.deepEqual(verdicts.body.verdicts, []);
    assert.equal(verdicts.body.summary.unreviewed, verdicts.body.summary.artefacts);
    // GAP batch 2, B3.5: the placeholder report is the zero-store engine's, answered in the browser (no-store on both sides).
    const placeholders = await same(backend, `${base}/placeholders`, { headers: ['cache-control'] });
    assert.equal(typeof placeholders.body.conformant, 'boolean');
    if (id === ordersId) assert.ok(placeholders.body.rows.length > 0, 'the library-built pack has placeholder rows');
    for (const env of packEnvs) await same(backend, `${base}/placeholders?env=${encodeURIComponent(env)}`);
    if (id === ordersId) assert.ok(Array.isArray(conf.body.onPlaceholder) && conf.body.onPlaceholder.length, 'the library-built pack says onPlaceholder');
    else assert.ok(!('onPlaceholder' in conf.body), 'the example pack omits onPlaceholder');
    await same(backend, `${base}/canonical`);
    await same(backend, `${base}/canonical?format=yaml`);
    await same(backend, `${base}/canonical?format=yml`);
    const cat = await same(backend, `${base}/compile-catalog`);
    for (const target of targets) {
      await same(backend, `${base}/compile/${encodeURIComponent(target)}`, { headers: ['content-disposition', 'x-pack-source', 'x-compile-target'] });
    }
    await same(backend, `${base}/compile/${targets[0]}?download=1`, { headers: ['content-disposition'] });
    await same(backend, `${base}/compile/no-such-target`);
    // Every artefact of the compile catalogue.
    let artefacts = 0;
    for (const g of cat.body.groups || []) {
      const flavors = g.flavors?.length ? g.flavors : [{ id: undefined }];
      for (const fl of flavors) {
        const q = `group=${encodeURIComponent(g.id)}${fl.id ? `&flavor=${encodeURIComponent(fl.id)}` : ''}`;
        await same(backend, `${base}/compile-artifact?${q}`, { headers: ['content-disposition', 'x-pack-source', 'x-compile-group', 'x-compile-flavor', 'x-compile-artifact'] });
        for (const a of (g.items || []).slice(0, 2)) {
          await same(backend, `${base}/compile-artifact?${q}&artifact=${encodeURIComponent(a.id)}`, { headers: ['content-disposition', 'x-compile-artifact'] });
          artefacts++;
        }
      }
    }
    assert.ok(artefacts > 0, 'per-artefact compiles compared');
    await same(backend, `${base}/compile-artifact`);
    await same(backend, `${base}/compile-artifact?group=no-such-group`);
    // export.zip: the headers and the entry names (the bytes carry timestamps).
    const za = await fetch(`${child.base}${base}/export.zip`);
    const zb = await backend.handle(`${base}/export.zip`);
    assert.equal(zb.status, 200);
    assert.equal(zb.status, za.status);
    for (const h of ['content-type', 'content-disposition', 'x-pack-source', 'x-bundle-files']) assert.equal(zb.headers.get(h), za.headers.get(h), `export.zip ${h}`);
    assert.match(zb.headers.get('content-disposition'), /^attachment; filename="[a-z0-9-]+\.bundle\.zip"$/);
    const namesA = zipEntryNames(Buffer.from(await za.arrayBuffer()));
    const namesB = zipEntryNames(Buffer.from(await zb.arrayBuffer()));
    assert.deepEqual(namesB, namesA, 'the same entries in the same order');
    assert.ok(namesB.length === Number(zb.headers.get('x-bundle-files')) && namesB[0].endsWith('.pack.yaml') && namesB.some((n) => n.startsWith('artefacts/')));
  }
  // The pack-independent routes.
  for (const path of ['/api/compile/targets', '/api/maturity-rubric', '/api/taxonomy', '/api/mcp-settings', '/api/examples', '/api/references', '/api/live-status']) {
    const a = await server(path);
    const b = await shim(backend, path);
    assert.equal(b.status, a.status, path);
    assert.equal(b.type, a.type, path);
    if (path === '/api/examples' || path === '/api/references') assert.deepEqual(b.body, { [path.slice(5)]: [] }, `${path}: empty in the bundle`);
    else assert.deepEqual(b.body, a.body, path);
  }
  // Unknown pack: the server's shapes.
  for (const path of ['/api/packs/nope', '/api/packs/nope/conformance', '/api/packs/nope/placeholders', '/api/packs/nope/canonical', '/api/packs/nope/compile-catalog', '/api/packs/nope/compile-artifact?group=x', '/api/packs/nope/compile/prometheus-rules', '/api/packs/nope/export.zip']) {
    await same(backend, path);
  }
  // /auth/me: server/auth.mjs's stand-alone answer when no identity is
  // configured (404, this body); an OBSERVOGRAM_AUTH=off server has no
  // /auth route at all and falls through to the SPA shell, which the studio
  // reads the same way (no JSON → no identity).
  const me = await shim(backend, '/auth/me');
  assert.equal(me.status, 404);
  assert.deepEqual(me.body, { ok: false, error: 'identity not configured' });
  const meServer = await server('/auth/me');
  assert.equal(meServer.status, 200);
  assert.match(meServer.type, /^text\/html/);
  // /api/version and /healthz: the shapes the studio reads (the values differ by nature).
  const v = (await shim(backend, '/api/version')).body;
  const sv = (await server('/api/version')).body;
  for (const k of ['ok', 'version', 'build', 'commit', 'branch', 'dirty', 'date', 'source', 'label']) assert.ok(k in v && k in sv, `/api/version carries ${k}`);
  assert.equal(v.version, sv.version);
  assert.equal(v.label, `v${v.version} · static bundle`);
  const h = (await shim(backend, '/healthz')).body;
  assert.deepEqual(Object.keys(h).sort(), Object.keys((await server('/healthz')).body).sort());
  assert.equal(h.specVersion, (await server('/healthz')).body.specVersion);
});

// ---------- T6 denial ----------

test('T6 denial: the server-only routes answer 501 denied no-backend naming the feature; unknown pack 404; other origins and non-API paths pass to the page', async () => {
  let upstreamCalls = [];
  const fetchImpl = async (input, init) => { upstreamCalls.push([String(input), init]); return new Response('ok', { status: 200 }); };
  const backend = createStaticBackend({ version: '1.2.3', schema, packs: [{ id: 'p', label: 'P', canonical: paymentCanonical }] }, { fetchImpl, origin: 'https://studio.example' });
  const expectDenied = async (input, init, feature) => {
    const r = await backend.handle(input, init);
    assert.ok(r, `${String(input)} answered`);
    assert.equal(r.status, 501, String(input));
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await r.json();
    assert.deepEqual(body, { ok: false, denied: DENIED, error: denialText(feature) });
    assert.match(body.error, /needs the Observogram server; this studio is a static bundle built without one\.$/);
  };
  await expectDenied('/api/refresh-live', { method: 'POST' }, 'Refresh from MCP');
  await expectDenied('/api/crawl', { method: 'POST' }, 'Scan a repo');
  await expectDenied('/api/crawl-github', { method: 'POST' }, 'Scan a repo');
  await expectDenied('/api/draft-from-mcp', { method: 'POST' }, 'Draft from a live MCP server');
  await expectDenied('/api/mcp/ping', { method: 'POST' }, 'Testing an MCP connection');
  await expectDenied('/api/mcp/jobs', { method: 'POST' }, 'Building a pack from a live MCP server');
  await expectDenied('/api/mcp/jobs', {}, 'Building a pack from a live MCP server');
  // The MCP server-settings pass-through (rebadge batch 4): both POSTs; the GET is the shim's (T5).
  await expectDenied('/api/mcp-settings/describe', { method: 'POST' }, 'Passing MCP server settings through the studio server');
  await expectDenied('/api/mcp-settings/submit', { method: 'POST' }, 'Passing MCP server settings through the studio server');
  await expectDenied('/api/validate', { method: 'POST' }, 'Uploading a pack');
  await expectDenied('/api/uploads', { method: 'DELETE' }, 'Uploading a pack');
  await expectDenied('/api/diff?a=p&b=p', undefined, 'Compare');
  await expectDenied('/api/packs/p/retrofeed', { method: 'POST' }, 'Compare');
  await expectDenied('/api/deploy/matrix', undefined, 'Deploy');
  await expectDenied('/api/deploys?pack=p', undefined, 'Deploy');
  await expectDenied('/api/packs/p/deploy-bulk', { method: 'POST' }, 'Deploy');
  await expectDenied('/api/packs/p/verdicts/SLI-01', { method: 'PUT' }, 'Verdicts');
  await expectDenied('/api/packs/p/verdicts/SLI-01', { method: 'DELETE' }, 'Verdicts');
  await expectDenied('/api/packs/p/audit-report', undefined, 'Audit report');
  await expectDenied('/api/packs/p/audit-report?format=html', undefined, 'Audit report');
  await expectDenied('/api/services/1/waivers', undefined, 'Waivers');
  await expectDenied('/api/services/1/waivers', { method: 'POST' }, 'Waivers');
  await expectDenied('/api/waivers/7/revoke', { method: 'POST' }, 'Waivers');
  // The two routes the Services home calls (STORE_PLAN slice 6a) — no shim: the home falls back to the derived tiles.
  await expectDenied('/api/services', undefined, 'Services');
  await expectDenied('/api/services/1', undefined, 'Services');
  await expectDenied('/api/services/1', { method: 'PATCH' }, 'Services');
  await expectDenied('/api/orgs', undefined, 'Organisations');
  // Settings (STORE_PLAN slice 6b) — a bundle has no org, so every call names Settings; /api/orgs above keeps
  // Organisations (the longest prefix wins over '/api/org').
  await expectDenied('/api/org', { method: 'PATCH' }, 'Settings');
  await expectDenied('/api/org/members', undefined, 'Settings');
  await expectDenied('/api/org/members/7', { method: 'DELETE' }, 'Settings');
  await expectDenied('/api/environments/4', { method: 'PATCH' }, 'Settings');
  await expectDenied('/api/mcp-endpoints', undefined, 'Settings');
  await expectDenied('/api/mcp-endpoints/3', { method: 'DELETE' }, 'Settings');
  await expectDenied('/api/audit?limit=100', undefined, 'Settings');
  await expectDenied('/api/services/1/environments', { method: 'POST' }, 'Services');
  await expectDenied('/api/admin/users', undefined, 'Administration');
  await expectDenied('/api/journeys', undefined, 'Journeys');
  await expectDenied('/api/library', undefined, 'Build');
  await expectDenied('/api/admin/join-role', undefined, 'Administration');
  await expectDenied('/auth/logout', { method: 'POST' }, 'Sign-in');
  await expectDenied('/auth/signout-others', { method: 'POST' }, 'Sign-in');
  await expectDenied('/api/whatever', undefined, 'This action');
  await expectDenied('/api/packs', { method: 'POST' }, 'This action');
  await expectDenied('/api/packs/p/no-such-sub', undefined, 'This action');
  // A Request object, and an absolute URL on our origin.
  await expectDenied(new Request('https://studio.example/api/refresh-live', { method: 'POST' }), undefined, 'Refresh from MCP');
  await expectDenied(new URL('https://studio.example/api/journeys'), undefined, 'Journeys');
  assert.equal(featureOf('/api/crawl-github'), 'Scan a repo');
  assert.equal(featureOf('/api/mcp/ping'), 'Testing an MCP connection');
  assert.equal(featureOf('/api/mcp/jobs/abc/cancel'), 'Building a pack from a live MCP server');
  assert.equal(featureOf('/api/mcp-endpoints/3'), 'Settings', "'/api/mcp/ping' is no prefix of the endpoints");
  assert.equal(featureOf('/api/packs/x/retrofeed?y'), 'Compare');
  assert.equal(featureOf('/api/packs/x/verdicts/SLI-01'), 'Verdicts');
  assert.equal(featureOf('/api/packs/x/verdicts'), 'Verdicts', 'the feature name; the GET itself is answered before the denial');
  assert.equal(featureOf('/api/packs/x/audit-report?format=html'), 'Audit report');
  assert.equal(featureOf('/api/services/x/waivers'), 'Waivers', 'the service record route, not a /api/services prefix');
  assert.equal(featureOf('/api/services/x'), 'Services');
  assert.equal(featureOf('/api/orgs'), 'Organisations');
  assert.equal(featureOf('/api/orgs/acme'), 'Organisations', "'/api/org' does not swallow '/api/orgs'");
  assert.equal(featureOf('/api/org'), 'Settings');
  assert.equal(featureOf('/api/environments/4'), 'Settings');
  assert.equal(featureOf('/api/waivers/x/revoke'), 'Waivers');
  assert.equal(featureOf('/api/packs/x/placeholders'), 'This action', 'placeholders is answered, not a feature');
  assert.equal(featureOf('/auth/login'), 'Sign-in');
  // /auth/me is the open posture; an unknown pack is 404 with the server's text.
  const me = await backend.handle('/auth/me');
  assert.equal(me.status, 404);
  assert.deepEqual(await me.json(), { ok: false, error: 'identity not configured' });
  const nope = await backend.handle('/api/packs/x');
  assert.equal(nope.status, 404);
  assert.deepEqual(await nope.json(), { error: 'unknown pack: x' });
  const encoded = await backend.handle(`/api/packs/${encodeURIComponent('a b/c')}`);
  assert.deepEqual(await encoded.json(), { error: 'unknown pack: a b/c' });
  // Not ours: null, and the upstream untouched (the installer calls it).
  assert.equal(backend.handle('https://fonts.googleapis.com/css2?family=X'), null);
  assert.equal(backend.handle('https://other.example/api/packs'), null);
  assert.equal(backend.handle('/index.html'), null);
  assert.equal(backend.handle('/packs/x.pack.yaml'), null);
  assert.equal(backend.handle(42), null);
  assert.deepEqual(upstreamCalls, [], 'the routes never touch the page fetch');
  assert.equal(backend.isOurs('/api/packs'), true);
  assert.equal(backend.isOurs('/x'), false);
  // A url pack that cannot be fetched: an entry with ok:false and the error; one that can: a full entry.
  const failing = createStaticBackend({ version: '1', schema, packs: [
    { id: 'remote-bad', label: 'Bad', url: 'https://packs.example/bad.pack.yaml' },
    { id: 'remote-good', label: 'Good', url: 'https://packs.example/good.pack.json' },
    { id: 'remote-down', label: 'Down', url: 'https://packs.example/down.pack.yaml' },
  ] }, {
    origin: 'https://studio.example',
    fetchImpl: async (u) => {
      upstreamCalls.push([String(u)]);
      if (String(u).endsWith('bad.pack.yaml')) return new Response('nope', { status: 404, statusText: 'Not Found' });
      if (String(u).endsWith('down.pack.yaml')) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(paymentCanonical), { status: 200 });
    },
  });
  const cat = await (await failing.handle('/api/packs')).json();
  assert.deepEqual(cat.packs.map((p) => [p.id, p.ok]), [['remote-bad', false], ['remote-good', true], ['remote-down', false]]);
  assert.match(cat.packs[0].error, /404 Not Found fetching https:\/\/packs\.example\/bad\.pack\.yaml/);
  assert.equal(cat.packs[2].error, 'Failed to fetch');
  assert.equal(cat.packs[1].name, paymentCanonical.metadata.name);
  assert.equal(cat.packs[1].criticality, 'tier-1');
  await (await failing.handle('/api/packs')).json();
  assert.equal(upstreamCalls.length, 3, 'each URL fetched once, on the first catalogue read');
  const badPack = await failing.handle('/api/packs/remote-bad');
  assert.equal(badPack.status, 500);
  assert.match((await badPack.json()).error, /404 Not Found/);
  assert.equal((await failing.handle('/api/packs/remote-good/conformance')).status, 200);
  // A pack that fails the schema at read time: the server's 500.
  const invalid = createStaticBackend({ version: '1', schema, packs: [{ id: 'i', label: 'I', canonical: { apiVersion: 'observability.platform/v1', kind: 'ObservabilityPack', spec: {} } }] });
  const inv = await invalid.handle('/api/packs/i');
  assert.equal(inv.status, 500);
  const invBody = await inv.json();
  assert.equal(invBody.error, 'pack failed schema validation');
  assert.ok(invBody.details.length > 0);
  // A repeated ?env= is no env (server/index.mjs readEnv reads a string only).
  const twice = await (await backend.handle('/api/packs/p/conformance?env=prod&env=staging')).json();
  assert.equal(twice.environment, null);
  // The notice text — and the default product is today's text character for character.
  assert.equal(denialText('Compare'), denialText('Compare', DEFAULT_BRAND.name));
  assert.equal(noticeText(1), noticeText(1, DEFAULT_BRAND.name));
  assert.equal(apiMenuSubText(), 'needs the Observogram server · this studio is a static bundle');
  assert.equal(noticeText(1), 'Static studio — no Observogram server behind this page. Discover, Diagnose, Compile and conformance read the 1 pack built in; Scan a repo, Draft from MCP, Compare, Deploy, Journeys, Build and sign-in need the server.');
  assert.match(noticeText(0), /read the 0 packs built in/);
});

// ---------- T7 the real bundle in a browser ----------

async function loadPlaywright() {
  const spec = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
  try { return { pw: await import(spec) }; }
  catch (e) { return { error: `cannot import ${spec}: ${e.message.split('\n')[0]}` }; }
}

test('T7 the REAL bundle boots in headless Chromium against the fixture pack: the notice, the open posture, the pack opened, 501 for a live feature, the Export download, the audit-report anchor answered with the 501 sentence, the Settings banner the same sentence, no page error, no request off the loopback', async (t) => {
  const required = process.env.OBSERVOGRAM_BUNDLE_SMOKE === 'require';
  const skip = (why) => { if (required) assert.fail(`OBSERVOGRAM_BUNDLE_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());

  // The bundle, built as a downstream would build it, served from a loopback server.
  const out = join(TMP, 'smoke', 'index.html');
  const built = cli(['--pack', resolve(ROOT, PAYMENT), '--label', 'Payment service (canonical example)', '--out', out, '--no-remote-fonts']);
  assert.equal(built.status, 0, built.stderr);
  const html = readFileSync(out);
  assert.ok(html.length > 3_000_000, `the real bundle (${html.length} bytes)`);
  const srv = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?') || req.url.startsWith('/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const page = await browser.newPage({ acceptDownloads: true });
  const problems = [];
  const offLoopback = [];
  const served = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) { if (!u.endsWith('/favicon.ico')) served.push(u); return route.continue(); }
    offLoopback.push(u);
    return route.abort();
  });
  await page.goto(`${base}/`);
  // The home screen lists the pack's service; the notice and the open posture are there.
  await page.waitForSelector('.svc-gate-card[data-service="payment-service"]', { state: 'attached', timeout: 30_000 });
  assert.equal(await page.isVisible('.no-backend-notice'), true, 'the notice is visible');
  assert.match(await page.textContent('.no-backend-notice'), /no Observogram server behind this page/);
  assert.match(await page.textContent('.no-backend-notice'), /read the 1 pack built in/);
  assert.equal(await page.isHidden('#api-link'), true, 'the api link is hidden');
  // Open the pack the way a user does: Check → the service tile.
  await page.click('#home-choice-check');
  await page.click('.svc-gate-card[data-service="payment-service"]');
  await page.waitForSelector('#pack-select option[value="payment-service"]', { state: 'attached', timeout: 30_000 });
  assert.equal(await page.inputValue('#pack-select'), 'payment-service');
  await page.waitForFunction(() => (document.querySelector('#layer-view')?.textContent || '').trim().length > 0, null, { timeout: 30_000 });
  await page.waitForFunction(() => (document.querySelector('#build-label')?.textContent || '').includes('static bundle'), null, { timeout: 10_000 });
  assert.match(await page.textContent('#build-label'), /static bundle/);
  // The toolbar is shown now: the api link must stay hidden here too (an
  // author `display` on .ctrl-link beats the UA's [hidden] rule).
  assert.equal(await page.isVisible('#api-link'), false, 'the api link is hidden once a pack is open');
  // The Advanced menu's API item is disabled.
  const item = await page.evaluate(() => {
    const el = document.querySelector('.observa-adv-item[data-action="api"]');
    return el ? { disabled: el.disabled, aria: el.getAttribute('aria-disabled'), sub: el.querySelector('.observa-adv-item-sub')?.textContent } : null;
  });
  assert.deepEqual(item, { disabled: true, aria: 'true', sub: 'needs the Observogram server · this studio is a static bundle' });
  // A live feature from the page: 501 denied no-backend.
  const denied = await page.evaluate(async () => { const r = await fetch('/api/refresh-live', { method: 'POST' }); return { status: r.status, body: await r.json() }; });
  assert.equal(denied.status, 501);
  assert.equal(denied.body.denied, 'no-backend');
  assert.match(denied.body.error, /^Refresh from MCP needs the Observogram server/);
  // The MCP panel's "test connection" (rebadge batch 3, C2): the ping is the
  // server's, so its status line is the 501 sentence as thrown — no result
  // block, nothing logged.
  await page.evaluate(() => document.getElementById('mcp-btn').click());
  await page.waitForSelector('#mcp-panel:not([hidden])', { timeout: 10_000 });
  // The Server settings button: no server, so no sign-in way in is named —
  // the bundle's own sentences only (the server's live in its policy).
  await page.waitForFunction(() => !/^Checking /.test(document.getElementById('mcp-settings-btn')?.dataset.why ?? 'Checking '), null, { timeout: 10_000 });
  assert.doesNotMatch(await page.evaluate(() => document.getElementById('mcp-settings-btn').dataset.why), /sign-in|npm run users|OIDC/);
  await page.fill('#mcp-url', 'http://127.0.0.1:9/mcp');
  await page.click('#mcp-refresh-btn');
  await page.waitForFunction(() => /^error: 501: /.test(document.getElementById('mcp-ping-status')?.textContent || ''), null, { timeout: 10_000 });
  assert.equal(await page.textContent('#mcp-ping-status'), 'error: 501: Testing an MCP connection needs the Observogram server; this studio is a static bundle built without one.');
  assert.equal(await page.isHidden('#mcp-ping-result'), true, 'no result block for a ping that did not run');
  await page.evaluate(() => document.getElementById('mcp-panel-close').click());
  // The pack routes from the page: the shim's answers.
  const conformance = await page.evaluate(async () => (await fetch('/api/packs/payment-service/conformance')).json());
  assert.equal(typeof conformance.scorePercent, 'number');
  // Export: a Blob download named by the server's rule, and no navigation.
  assert.equal(await page.isVisible('#export-btn'), true, 'the Export button shows for an open pack');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.click('#export-btn')]);
  assert.equal(download.suggestedFilename(), 'payment-service.bundle.zip');
  assert.equal(page.url(), `${base}/`, 'no navigation');
  const downloaded = await download.path();
  assert.ok(downloaded && statSync(downloaded).size > 1000, 'the ZIP has content');
  const names = zipEntryNames(readFileSync(downloaded));
  assert.equal(names[0], 'payment-service.pack.yaml');
  assert.ok(names.some((n) => n.startsWith('artefacts/')));
  // The Conformance view's audit-report anchors: an `<a download>` navigation
  // never reaches a fetch wrapper, so the shim's click handler answers it —
  // the 501 sentence in the notice row, no navigation, no request to the
  // static host (which would 404 and cancel the download without a word).
  await page.click('.observa-adv-toggle');
  await page.click('.observa-adv-item[data-view="conformance"]');
  await page.waitForSelector('.conf-exports a[download]', { timeout: 30_000 });
  assert.match(await page.getAttribute('.conf-exports a[download]', 'href'), /^\/api\/packs\/payment-service\/audit-report\?format=html/);
  await page.click('.conf-exports a[download]');
  await page.waitForFunction(() => /^Audit report needs the Observogram server/.test(document.querySelector('.no-backend-notice-text')?.textContent || ''), null, { timeout: 10_000 });
  assert.equal(await page.textContent('.no-backend-notice-text'), 'Audit report needs the Observogram server; this studio is a static bundle built without one.');
  assert.equal(await page.$('.no-backend-notice.is-error') !== null, true, 'the notice row carries the error');
  assert.equal(page.url(), `${base}/`, 'no navigation');
  assert.deepEqual(served.filter((u) => u.includes('/api/')), [], 'the anchor never reached the static host');
  // Dismiss the notice; it stays dismissed on reload (localStorage).
  await page.click('.no-backend-notice-dismiss');
  assert.equal(await page.isVisible('.no-backend-notice'), false);
  await page.reload();
  await page.waitForSelector('#observa-chrome, .observa-hdr, #layer-view', { state: 'attached', timeout: 30_000 });
  await page.waitForFunction(() => (document.querySelector('#layer-view')?.textContent || '').trim().length > 0, null, { timeout: 30_000 });
  assert.equal(await page.$('.no-backend-notice'), null, 'the dismissal is remembered');
  // Settings: the frame's first read is denied; the banner is that sentence
  // as thrown, `501: ` included (design B15), no section list, nothing logged.
  await page.click('.observa-adv-toggle');
  await page.click('.observa-adv-item[data-action="settings"]');
  await page.waitForSelector('.set-banner.is-static', { timeout: 30_000 });
  assert.equal(await page.textContent('.set-banner'), '501: Settings needs the Observogram server; this studio is a static bundle built without one.');
  assert.equal(await page.evaluate(() => document.body.dataset.mode), 'settings');
  assert.equal(await page.$('.set-nav-item'), null, 'no section in the static bundle');

  assert.deepEqual(problems, [], 'no page error and no console.error');
  assert.deepEqual(offLoopback, [], 'no request left the loopback');
  assert.ok(served.every((u) => u === `${base}/` || u.startsWith(`${base}/?`)), `the page fetched only itself over HTTP: ${served.filter((u) => u !== `${base}/`)}`);
});

// ---------- T8 the baked taxonomy ----------

// What carries weight here: the shim's /api/taxonomy body and header equal a
// configured server's, the layered bodies carry the seven `type` keys, the
// board rendered from the shim's answer is the committed mapped golden and
// differs from the unmapped one (the bake is what regroups). shimBoard ===
// serverBoard follows from the bodies being equal; T9 is the end-to-end proof
// through the studio's own boot binding (studio/app.mjs bindTaxonomyFromServer).
test('T8 baked taxonomy: a --taxonomy bundle answers /api/taxonomy as a server started with OBSERVOGRAM_TAXONOMY does; the board is the typed-canonical mapped golden; env fallback, flag over env, refusals; no path in the bundle', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-taxonomy-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_TAXONOMY: TAX } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); bindTaxonomy(artefactClassify, null); });
  const fixture = JSON.parse(readFileSync(TAX, 'utf8'));
  const typedCanonical = JSON.parse(readFileSync(TYPED_CANONICAL, 'utf8'));
  const registered = await fetch(`${child.base}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(typedCanonical) }).then((r) => r.json());
  assert.equal(registered.ok, true, JSON.stringify(registered.errors));
  const id = registered.registered.id;

  // The build: --json names the source, the path and the counts — never the contents.
  const out = join(TMP, 'taxonomy', 'index.html');
  const w = cli(['--taxonomy', TAX, '--pack', TYPED_CANONICAL, '--id', id, '--out', out, '--json']);
  assert.equal(w.status, 0, w.stderr);
  const j = JSON.parse(w.stdout);
  assert.deepEqual(j.taxonomy, { source: 'flag', file: TAX, types: 7, ids: 1 });
  assert.equal(j.brand, null);
  assert.ok(!w.stdout.includes('promrule') && !w.stderr.includes('promrule'), 'the report prints no taxonomy contents');
  const human = cli(['--check', '--taxonomy', TAX, '--pack', TYPED_CANONICAL]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^ok \(not written\): \d+ modules · 16 stylesheets · \d+ bytes · 1 pack · taxonomy: 7 types, 1 id rule\n$/);
  const html = readFileSync(out, 'utf8');
  const config = configOf(html);
  assert.deepEqual(Object.keys(config), ['version', 'builtAt', 'schema', 'packs', 'taxonomy'], 'the taxonomy key after packs');
  assert.deepEqual(config.taxonomy, fixture, 'the document is baked verbatim (so ^promrule- legitimately appears in the bundle)');
  assert.ok(!html.includes(TAX) && !html.includes(ROOT), 'no operator path in the bundle');
  assert.ok(!/(?:href|src)="\//.test(html), 'nothing points at the server');

  // Parity: the server's body and header, the layered bodies with their `type` keys.
  const backend = createStaticBackend(config);
  assert.equal(backend.taxonomyConfigured, true);
  const server = async (path) => { const r = await fetch(`${child.base}${path}`, { headers: { Accept: 'application/json' } }); return { status: r.status, type: r.headers.get('content-type'), cc: r.headers.get('cache-control'), body: await bodyOf(r) }; };
  const shim = async (path) => { const r = await backend.handle(path); assert.ok(r, `${path} answered`); return { status: r.status, type: r.headers.get('content-type'), cc: r.headers.get('cache-control'), body: await bodyOf(r) }; };
  const same = async (path) => { const [a, b] = await Promise.all([server(path), shim(path)]); assert.equal(b.status, a.status, path); assert.equal(b.type, a.type, path); assert.deepEqual(b.body, a.body, `${path}: body`); return { a, b }; };
  const tax = await same('/api/taxonomy');
  assert.deepEqual(tax.a.body, { ok: true, taxonomy: fixture, configured: true });
  assert.equal(tax.a.cc, 'no-store');
  assert.equal(tax.b.cc, 'no-store');
  const layered = await same(`/api/packs/${encodeURIComponent(id)}`);
  const prod = await same(`/api/packs/${encodeURIComponent(id)}?env=prod`);
  assert.equal(prod.b.body.layers.L4.policy[0].type, 'PrometheusRule');
  const typed = Object.values(prod.b.body.layers).flatMap((l) => (Array.isArray(l) ? l : Object.values(l).flat())).filter((a) => typeof a.type === 'string');
  assert.equal(typed.length, 7, 'the seven declared types ride through the adapter');

  // The board, golden-board style: bound from each side's /api/taxonomy answer.
  bindTaxonomy(artefactClassify, tax.a.body.taxonomy);
  const serverBoard = renderBoard(layered.a.body, { env: 'prod' });
  const serverFamilies = familiesOf(layered.a.body);
  bindTaxonomy(artefactClassify, tax.b.body.taxonomy);
  const shimBoard = renderBoard(layered.b.body, { env: 'prod' });
  const shimFamilies = familiesOf(layered.b.body);
  assert.equal(shimBoard, serverBoard);
  assert.deepEqual(shimFamilies, serverFamilies);
  assert.equal(shimBoard, read(MAPPED_BOARD), 'the shim\'s board is the mapped golden, byte for byte');
  assert.equal(JSON.stringify(shimFamilies, null, 2) + '\n', read('tools/fixtures/golden/board/typed-canonical.mapped.families.json'));
  assert.deepEqual(boardGroupCounts(shimBoard, 'L4').filter(([, n]) => n), [['pol', 2], ['alr', 2], ['rule', 1]]);
  bindTaxonomy(artefactClassify, null);
  const unmapped = renderBoard(layered.b.body, { env: 'prod' });
  assert.equal(unmapped, read('tools/fixtures/golden/board/typed-canonical.unmapped.board.html'));
  assert.notEqual(unmapped, shimBoard, 'the bake is what regroups');

  // Env fallback (both spellings), flag over env.
  const envRun = cli(['--check', '--json', '--pack', TYPED_CANONICAL], TMP, { OBSERVOGRAM_TAXONOMY: TAX });
  assert.equal(envRun.status, 0, envRun.stderr);
  assert.deepEqual(JSON.parse(envRun.stdout).taxonomy, { source: 'env', file: TAX, types: 7, ids: 1 });
  const legacy = cli(['--check', '--json', '--pack', TYPED_CANONICAL], TMP, { TOMOGRAPH_TAXONOMY: TAX });
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).taxonomy.source, 'env');
  const broken = join(TMP, 'broken-taxonomy.json');
  writeFileSync(broken, '{');
  const flagWins = cli(['--check', '--json', '--taxonomy', TAX], TMP, { OBSERVOGRAM_TAXONOMY: broken });
  assert.equal(flagWins.status, 0, flagWins.stderr);
  assert.equal(JSON.parse(flagWins.stdout).taxonomy.source, 'flag');
  // A relative path resolves against the cwd given, not process.cwd().
  const relDir = join(TMP, 'rel-tax');
  mkdirSync(relDir, { recursive: true });
  writeFileSync(join(relDir, 't.json'), JSON.stringify(fixture));
  assert.deepEqual(resolveTaxonomySource({ taxonomy: 't.json' }, {}, relDir), { file: join(relDir, 't.json'), origin: '--taxonomy' });
  assert.deepEqual(resolveTaxonomySource({ taxonomy: null }, { TOMOGRAPH_TAXONOMY: 't.json' }, relDir), { file: join(relDir, 't.json'), origin: 'OBSERVOGRAM_TAXONOMY' });
  assert.equal(resolveTaxonomySource({ taxonomy: null }, {}, relDir), null);
  const rel = cli(['--check', '--json', '--taxonomy', 't.json'], relDir);
  assert.equal(rel.status, 0, rel.stderr);
  assert.equal(JSON.parse(rel.stdout).taxonomy.file, join(relDir, 't.json'));
  assert.deepEqual(loadTaxonomyFile(join(relDir, 't.json')).taxonomy, fixture);

  // Refusals: exit 1, nothing written, the server's texts behind the origin, --json → { ok: false, error }.
  const refuse = (args, extraEnv, re) => {
    const badOut = join(TMP, `refused-${Math.random().toString(36).slice(2)}`, 'index.html');
    const r = cli([...args, '--out', badOut], TMP, extraEnv);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.ok(!existsSync(badOut), 'nothing written');
    const rj = cli(['--json', ...args, '--out', badOut], TMP, extraEnv);
    assert.equal(rj.status, 1);
    const body = JSON.parse(rj.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, re);
    return r.stderr;
  };
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const missing = join(TMP, 'nope-taxonomy.json');
  refuse(['--taxonomy', missing], {}, new RegExp(`^--taxonomy: ${esc(missing)}: ENOENT: no such file or directory`));
  refuse(['--taxonomy', broken], {}, new RegExp(`^--taxonomy: ${esc(broken)}: invalid JSON: `));
  const indicator = join(TMP, 'indicator.json');
  writeFileSync(indicator, '{"version":1,"types":{"PackSLI":"indicator"}}');
  assert.equal(refuse(['--taxonomy', indicator], {}, /unknown family/), `--taxonomy: ${indicator}: taxonomy: types.PackSLI: unknown family "indicator"\n`);
  const v3 = join(TMP, 'v3.json');
  writeFileSync(v3, '{"version":3,"nope":1}');
  assert.equal(refuse(['--taxonomy', v3], {}, /version must be 1 or 2/), `--taxonomy: ${v3}: taxonomy: version must be 1 or 2 (+1 more)\n`);
  refuse([], { TOMOGRAPH_TAXONOMY: missing }, new RegExp(`^OBSERVOGRAM_TAXONOMY: ${esc(missing)}: ENOENT`));
  // The programmatic guard.
  assert.throws(() => buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', taxonomy: { version: 3 } }), { message: /^taxonomy: version must be 1 or 2/ });
  assert.throws(() => loadTaxonomyFile(indicator, 'OBSERVOGRAM_TAXONOMY'), { message: new RegExp(`^OBSERVOGRAM_TAXONOMY: ${esc(indicator)}: taxonomy: types\\.PackSLI`) });
});

// ---------- T8c the baked v2 taxonomy (a glossary) ----------

test('T8c baked glossary: a bundle built with a v2 taxonomy answers /api/taxonomy — the glossary included — as a server started with that file does, and --check counts the terms', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-glossary-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_TAXONOMY: TAX_V2 } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const fixture = JSON.parse(readFileSync(TAX_V2, 'utf8'));
  assert.equal(fixture.version, 2);
  assert.equal(fixture.glossary.length, 6);
  const built = buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', taxonomy: fixture });
  assert.deepEqual(built.config.taxonomy, fixture, 'baked verbatim, glossary included');
  const backend = createStaticBackend(built.config);
  assert.equal(backend.taxonomyConfigured, true);
  const r = await fetch(`${child.base}/api/taxonomy`, { headers: { Accept: 'application/json' } });
  const server = { status: r.status, type: r.headers.get('content-type'), cc: r.headers.get('cache-control'), body: await bodyOf(r) };
  const s = await backend.handle('/api/taxonomy');
  const shim = { status: s.status, type: s.headers.get('content-type'), cc: s.headers.get('cache-control'), body: await bodyOf(s) };
  assert.deepEqual(shim, server, 'status, content-type, cache-control and body: the server\'s answer');
  assert.deepEqual(server.body, { ok: true, taxonomy: fixture, configured: true });
  assert.deepEqual(server.body.taxonomy.glossary.map((e) => e.term), ['Service level indicator', 'Service level objective', 'Alert rule', 'Telemetry backend', 'Error budget', 'Criticality tier']);
  // The studio binds either answer the same way: the glossary accessors read the same entries.
  bindTaxonomy(artefactClassify, shim.body.taxonomy);
  try {
    assert.equal(artefactClassify.glossaryFor('sli').term, 'Service level indicator');
    assert.equal(artefactClassify.describeTaxonomy(artefactClassify.activeTaxonomy()), '7 types, 1 id rule, 6 glossary terms');
  } finally { bindTaxonomy(artefactClassify, null); }
  const human = cli(['--check', '--taxonomy', TAX_V2]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /· taxonomy: 7 types, 1 id rule, 6 glossary terms\n$/);
  const j = cli(['--check', '--json', '--taxonomy', TAX_V2]);
  assert.equal(j.status, 0, j.stderr);
  assert.deepEqual(JSON.parse(j.stdout).taxonomy, { source: 'flag', file: TAX_V2, types: 7, ids: 1 }, 'the report counts types and ids as before (no glossary contents)');
});

// ---------- T8d the baked MCP settings policy and MCP origin list ----------

test('T8d baked MCP settings: a --mcp-settings-policy bundle answers /api/mcp-settings as a server started with that file does (proxy false); --mcp-origins bakes the list by the server\'s rule and the shim serves it; env fallback, refusals, the summary and --json name the bakes, never the policy\'s contents', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-mcp-settings-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_MCP_SETTINGS_POLICY: MSP } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const fixture = JSON.parse(readFileSync(MSP, 'utf8'));
  const answer = async (res) => ({ status: res.status, type: res.headers.get('content-type'), cc: res.headers.get('cache-control'), body: await bodyOf(res) });
  // The policy: the server's answer, status, type, cache-control and body.
  const built = buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', mcpSettingsPolicy: fixture });
  assert.deepEqual(built.config.mcpSettingsPolicy, fixture, 'baked verbatim');
  assert.ok(!('mcpOrigins' in built.config), 'no origin list unless baked');
  const server = await answer(await fetch(`${child.base}/api/mcp-settings`, { headers: { Accept: 'application/json' } }));
  const shim = await answer(await createStaticBackend(built.config).handle('/api/mcp-settings'));
  assert.deepEqual(shim, server, 'the server\'s answer');
  assert.deepEqual(server.body, { ok: true, proxy: false, policy: fixture, configured: true });
  // The origin list: { listed, origins } (null for `*`), after `mcpSettingsPolicy`, served beside the policy.
  const both = buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', taxonomy: JSON.parse(readFileSync(TAX, 'utf8')), mcpSettingsPolicy: fixture, mcpOrigins: { listed: true, origins: ['https://mcp.example.com'] } });
  assert.deepEqual(Object.keys(both.config), ['version', 'builtAt', 'schema', 'packs', 'taxonomy', 'mcpSettingsPolicy', 'mcpOrigins'], 'appended after taxonomy, in order');
  const served = await (await createStaticBackend(both.config).handle('/api/mcp-settings')).json();
  assert.deepEqual(served, { ok: true, proxy: false, policy: fixture, configured: true, mcpOrigins: { listed: true, origins: ['https://mcp.example.com'] } });
  const anyOrigin = buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', mcpOrigins: { listed: true, origins: null } });
  assert.deepEqual(await (await createStaticBackend(anyOrigin.config).handle('/api/mcp-settings')).json(), { ok: true, proxy: false, policy: null, configured: false, mcpOrigins: { listed: true, origins: null } });
  // The list rule: the server's parseOriginList, normalised and sorted; `*` any; a bad entry refused, not dropped.
  assert.deepEqual(resolveMcpOrigins({ mcpOrigins: ' HTTPS://Mcp.Example.com:443 , http://127.0.0.1:9000/' }), { origins: { listed: true, origins: ['http://127.0.0.1:9000', 'https://mcp.example.com'] }, origin: '--mcp-origins' });
  assert.deepEqual(resolveMcpOrigins({ mcpOrigins: '*' }), { origins: { listed: true, origins: null }, origin: '--mcp-origins' });
  assert.equal(resolveMcpOrigins({ mcpOrigins: null }, {}), null);
  assert.deepEqual(resolveMcpOrigins({ mcpOrigins: null }, { TOMOGRAPH_MCP_ORIGINS: 'https://a.example' }).origin, 'OBSERVOGRAM_MCP_ORIGINS');
  assert.equal(resolveMcpOrigins({ mcpOrigins: 'https://flag.example' }, { OBSERVOGRAM_MCP_ORIGINS: 'https://env.example' }).origins.origins[0], 'https://flag.example', 'the flag wins');
  assert.throws(() => resolveMcpOrigins({ mcpOrigins: 'https://mcp.example.com, https://x.example/mcp, localhost:8080' }), { message: '--mcp-origins: "https://x.example/mcp", "localhost:8080" are not origins — list each as scheme://host[:port] (http or https, no path, user or wildcard), or * for any origin' });
  assert.throws(() => resolveMcpOrigins({ mcpOrigins: null }, { OBSERVOGRAM_MCP_ORIGINS: 'https://u:p@x.example' }), { message: 'OBSERVOGRAM_MCP_ORIGINS: "https://u:p@x.example" is not an origin — list each as scheme://host[:port] (http or https, no path, user or wildcard), or * for any origin' });
  assert.throws(() => resolveMcpOrigins({ mcpOrigins: ' , ' }), { message: '--mcp-origins: no origin listed — name at least one (scheme://host[:port]), or * for any origin' });
  assert.throws(() => checkBakedOrigins({ listed: true, origins: ['https://X.example/'] }), /every entry must be an origin as the URL parser writes it/);
  assert.throws(() => checkBakedOrigins(['https://x.example']), /mcpOrigins must be/);
  assert.throws(() => buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', mcpOrigins: { listed: true, origins: ['*'] } }), /every entry must be an origin/);
  // The policy file: the server's loader texts behind the origin; one BOM stripped.
  assert.deepEqual(resolveSettingsPolicySource({ mcpSettingsPolicy: 'p.json' }, {}, '/w'), { file: resolve('/w', 'p.json'), origin: '--mcp-settings-policy' });
  assert.deepEqual(resolveSettingsPolicySource({}, { TOMOGRAPH_MCP_SETTINGS_POLICY: 'q.json' }, '/w'), { file: resolve('/w', 'q.json'), origin: 'OBSERVOGRAM_MCP_SETTINGS_POLICY' });
  assert.equal(resolveSettingsPolicySource({}, {}, '/w'), null);
  const bom = join(TMP, 'msp-bom.json');
  writeFileSync(bom, `\uFEFF${readFileSync(MSP, 'utf8')}`);
  assert.deepEqual(loadSettingsPolicyFile(bom).policy, fixture);
  const missing = join(TMP, 'msp-missing.json');
  assert.throws(() => loadSettingsPolicyFile(missing), (e) => e.message.startsWith(`--mcp-settings-policy: ${missing}: ENOENT`));
  const typo = join(TMP, 'msp-typo.json');
  writeFileSync(typo, JSON.stringify({ version: 1, rules: [{ when: { field: 'grafanaUrl', pattren: '^x' }, warn: 'w' }] }));
  assert.throws(() => loadSettingsPolicyFile(typo, 'OBSERVOGRAM_MCP_SETTINGS_POLICY'), { message: `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${typo}: rules[0].when: unknown key "pattren"` });
  assert.throws(() => buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', mcpSettingsPolicy: { version: 2, rules: [] } }), { message: 'MCP settings policy: version must be 1 (got 2)' });
  // The CLI: the summary and --json name what was baked — the file and the rule count, never a rule's text.
  const human = cli(['--check', '--mcp-settings-policy', MSP, '--mcp-origins', 'https://mcp.example.com,http://127.0.0.1:9000']);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, / · MCP settings policy: 1 rule · MCP origins: http:\/\/127\.0\.0\.1:9000, https:\/\/mcp\.example\.com\n$/);
  const j = cli(['--check', '--json', '--mcp-settings-policy', MSP, '--mcp-origins', '*']);
  assert.equal(j.status, 0, j.stderr);
  const jj = JSON.parse(j.stdout);
  assert.deepEqual(jj.mcpSettingsPolicy, { source: 'flag', file: MSP, rules: 1 });
  assert.deepEqual(jj.mcpOrigins, { source: 'flag', origins: null });
  assert.match(cli(['--check', '--mcp-origins', '*']).stdout, / · MCP origins: any \(\*\)\n$/);
  for (const r of [human, j]) assert.ok(!r.stdout.includes('Non-approved') && !r.stdout.includes('operator approval'), 'the policy\'s contents are in no output');
  const out = join(TMP, 'msp', 'index.html');
  const w = cli(['--out', out, '--mcp-settings-policy', MSP, '--mcp-origins', 'https://mcp.example.com']);
  assert.equal(w.status, 0, w.stderr);
  const config = configOf(readFileSync(out, 'utf8'));
  assert.deepEqual(config.mcpSettingsPolicy, fixture);
  assert.deepEqual(config.mcpOrigins, { listed: true, origins: ['https://mcp.example.com'] });
  assert.ok(!readFileSync(out, 'utf8').includes(MSP), 'no operator path lands in the bundle');
  const bad = cli(['--check', '--mcp-settings-policy', typo]);
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr, `--mcp-settings-policy: ${typo}: rules[0].when: unknown key "pattren"\n`);
  const badOrigins = cli(['--check', '--mcp-origins', 'mcp.example.com']);
  assert.equal(badOrigins.status, 1);
  assert.match(badOrigins.stderr, /^--mcp-origins: "mcp\.example\.com" is not an origin/);
});

// ---------- T8b the baked brand ----------

test('T8b baked brand: a --brand bundle carries the branded server\'s shell fragments; the scalars on top; env fallback; server paths and bad brands refused; the shim names the product', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-brand-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_BRAND_FILE: ACME_STATIC } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const serverShell = await (await fetch(`${child.base}/`)).text();
  const acme = normalizeBrand(JSON.parse(readFileSync(ACME_STATIC, 'utf8')));

  const out = join(TMP, 'brand', 'index.html');
  const w = cli(['--brand', ACME_STATIC, '--pack', resolve(ROOT, PAYMENT), '--out', out, '--json']);
  assert.equal(w.status, 0, w.stderr);
  const j = JSON.parse(w.stdout);
  assert.deepEqual(j.brand, { source: 'flag', file: ACME_STATIC, name: 'Acme Watch' });
  assert.equal(j.taxonomy, null);
  assert.ok(!w.stdout.includes('b3261e') && !w.stderr.includes('b3261e'), 'the report prints no brand contents');
  const human = cli(['--check', '--brand', ACME_STATIC, '--pack', resolve(ROOT, PAYMENT)]);
  assert.match(human.stdout, /^ok \(not written\): \d+ modules · 16 stylesheets · \d+ bytes · 1 pack · brand: Acme Watch\n$/);
  const html = readFileSync(out, 'utf8');
  // The fragments brandShellHtml writes: the bundle's equal the branded server's, each exactly once.
  const bundleFragments = brandFragmentsOf(html, { branded: true });
  const serverFragments = brandFragmentsOf(serverShell, { branded: true });
  assert.deepEqual(bundleFragments, serverFragments, 'the bundle\'s shell is the server\'s branded shell');
  assert.deepEqual(JSON.parse(/<script type="application\/json" id="brand-config">(.*?)<\/script>/.exec(html)[1]), acme, '#brand-config is the normalized brand');
  const at = (s) => { const i = html.indexOf(s); assert.ok(i >= 0, `${s} present`); return i; };
  assert.ok(at('<style data-src="design-tokens.css">') < at('<style id="brand-tokens">') && at('<style id="brand-tokens">') < at('<style data-src="app.css">'), '#brand-tokens after design-tokens.css, before app.css — the server\'s cascade position');
  assert.ok(html.includes('id="build-label"'));
  assert.ok(!/(?:href|src)="\//.test(html), 'nothing points at the server (the data: favicon, the inline logo)');
  assert.ok(!html.includes(ACME_STATIC) && !html.includes(ROOT), 'no operator path in the bundle');
  assert.deepEqual(Object.keys(configOf(html)), ['version', 'builtAt', 'schema', 'packs'], 'a brand bakes no config key');
  // The inert direction: the shipped shell and the unbranded bundle carry no brand fragment and today's title/h1.
  const shipped = brandFragmentsOf(read('studio/index.html'), { branded: false });
  const unbranded = brandFragmentsOf(buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x' }).html, { branded: false });
  assert.equal(shipped.tokens, undefined);
  assert.equal(shipped.config, undefined);
  assert.equal(shipped.icon, undefined);
  assert.equal(unbranded.title, shipped.title);
  assert.equal(unbranded.h1, shipped.h1);
  assert.notEqual(bundleFragments.title, shipped.title);

  // Env: the scalars alone, the file, the legacy spelling; the scalars on top of --brand (the server's loader).
  const scalars = cli(['--check', '--json', '--pack', resolve(ROOT, PAYMENT)], TMP, { OBSERVOGRAM_BRAND_NAME: 'Zed' });
  assert.equal(scalars.status, 0, scalars.stderr);
  assert.deepEqual(JSON.parse(scalars.stdout).brand, { source: 'env', file: null, name: 'Zed' });
  const envFile = cli(['--check', '--json', '--pack', resolve(ROOT, PAYMENT)], TMP, { OBSERVOGRAM_BRAND_FILE: ACME_STATIC });
  assert.deepEqual(JSON.parse(envFile.stdout).brand, { source: 'env', file: ACME_STATIC, name: 'Acme Watch' });
  const legacy = cli(['--check', '--json', '--pack', resolve(ROOT, PAYMENT)], TMP, { TOMOGRAPH_BRAND_FILE: ACME_STATIC });
  assert.deepEqual(JSON.parse(legacy.stdout).brand, { source: 'env', file: ACME_STATIC, name: 'Acme Watch' });
  // The escape hatch on a machine whose env carries the server's brand: an empty value is unset — the form
  // cmd (`set X=`) and PowerShell (`$env:X=''`) can express, where coreutils' `env -u` does not exist. The three
  // docs that name `env -u` name both Windows spellings beside it.
  const emptied = cli(['--check', '--json', '--pack', resolve(ROOT, PAYMENT)], TMP, { OBSERVOGRAM_BRAND_FILE: '', OBSERVOGRAM_BRAND_NAME: '', OBSERVOGRAM_TAXONOMY: '' });
  assert.equal(emptied.status, 0, emptied.stderr);
  assert.deepEqual(JSON.parse(emptied.stdout).brand, null, 'an empty OBSERVOGRAM_BRAND_FILE / _NAME bakes no brand');
  assert.equal(JSON.parse(emptied.stdout).taxonomy, null, 'an empty OBSERVOGRAM_TAXONOMY bakes no taxonomy');
  for (const doc of ['README.md', 'docs/DOWNSTREAM.md', 'docs/UPDATE_JOURNEY.md']) {
    const text = readFileSync(join(DEFAULT_ROOT, doc), 'utf8');
    for (const form of ['`env -u OBSERVOGRAM_BRAND_FILE', '`set OBSERVOGRAM_BRAND_FILE=`', "`$env:OBSERVOGRAM_BRAND_FILE=''`"]) {
      assert.ok(text.includes(form), `${doc} names the unbrand escape hatch ${form}`);
    }
  }
  const onTop = join(TMP, 'brand-on-top', 'index.html');
  const top = cli(['--brand', ACME_STATIC, '--out', onTop], TMP, { OBSERVOGRAM_BRAND_TAGLINE: 'scalar wins' });
  assert.equal(top.status, 0, top.stderr);
  const topConfig = JSON.parse(/<script type="application\/json" id="brand-config">(.*?)<\/script>/.exec(readFileSync(onTop, 'utf8'))[1]);
  assert.equal(topConfig.tagline, 'scalar wins');
  assert.equal(topConfig.name, 'Acme Watch');
  // loadBundleBrand directly: a relative --brand resolves against cwd; the legacy file spelling cannot shadow the flag.
  const relDir = join(TMP, 'rel-brand');
  mkdirSync(relDir, { recursive: true });
  writeFileSync(join(relDir, 'b.json'), '{"name":"Rel"}');
  assert.deepEqual(loadBundleBrand({ brand: 'b.json' }, { TOMOGRAPH_BRAND_FILE: ACME_STATIC }, relDir).brand.name, 'Rel');
  assert.deepEqual(loadBundleBrand({ brand: null }, {}, relDir), { brand: null, source: null, file: null });

  // Refusals: the server's texts behind the origin that was set; nothing written.
  const refuse = (args, extraEnv, re) => {
    const badOut = join(TMP, `refused-brand-${Math.random().toString(36).slice(2)}`, 'index.html');
    const r = cli([...args, '--out', badOut], TMP, extraEnv);
    assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.ok(!existsSync(badOut), 'nothing written');
    return r.stderr;
  };
  const esc = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const missing = join(TMP, 'nope-brand.json');
  refuse(['--brand', missing], {}, new RegExp(`^--brand: brand file ${esc(missing)}: not found\\n$`));
  const notJson = join(TMP, 'not-json-brand.json');
  writeFileSync(notJson, 'not json');
  refuse(['--brand', notJson], {}, new RegExp(`^--brand: brand file ${esc(notJson)}: not valid JSON\\n$`));
  const arr = join(TMP, 'array-brand.json');
  writeFileSync(arr, '[]');
  refuse(['--brand', arr], {}, new RegExp(`^--brand: brand file ${esc(arr)}: not a JSON object\\n$`));
  refuse([], { OBSERVOGRAM_BRAND_FILE: missing }, new RegExp(`^OBSERVOGRAM_BRAND_FILE: brand file ${esc(missing)}: not found\\n$`));
  const empty = join(TMP, 'empty-brand.json');
  writeFileSync(empty, '{}');
  refuse(['--brand', empty], {}, new RegExp(`^--brand: brand file ${esc(empty)}: an empty brand \\(no field set\\) — nothing to bake\\n$`));
  refuse(['--brand', ACME], {}, /^brand favicon "\/assets\/acme\.ico" is a server path — the bundle is served without the server; use an absolute URL \(https:\/\/…, data:…\) or a path relative to the bundle's own directory \("assets\/acme\.ico"\)\n$/);
  // The same server path from the environment names the variable that was set — a build machine configured for a server learns where the brand came from.
  refuse([], { OBSERVOGRAM_BRAND_FILE: ACME }, /^OBSERVOGRAM_BRAND_FILE: brand favicon "\/assets\/acme\.ico" is a server path — the bundle is served without the server; use an absolute URL \(https:\/\/…, data:…\) or a path relative to the bundle's own directory \("assets\/acme\.ico"\)\n$/);
  refuse([], { OBSERVOGRAM_BRAND_NAME: 'Zed', OBSERVOGRAM_BRAND_LOGO_URL: '/logo.svg' }, /^OBSERVOGRAM_BRAND_\*: brand logo\.url "\/logo\.svg" is a server path — the bundle is served without the server; use an absolute URL \(https:\/\/…, data:…\) or a path relative to the bundle's own directory \("logo\.svg"\)\n$/);
  const badToken = join(TMP, 'bad-token-brand.json');
  writeFileSync(badToken, JSON.stringify({ name: 'X', tokens: { light: { 'Bad Name': '1' } } }));
  refuse(['--brand', badToken], {}, /^--brand: brand: tokens\.light\.Bad Name is not a design token name\n$/);
  refuse([], { OBSERVOGRAM_BRAND_ACCENT: 'a;b' }, /^OBSERVOGRAM_BRAND_\*: brand: token value for accent contains ;\{\}<>\n$/);
  // checkBrandUrls: the three fields, the exemptions.
  for (const [field, b] of [['favicon', { favicon: '/x.ico' }], ['logo.url', { logo: { url: '/l.svg' } }], ['hero.src', { hero: { src: '/h.png' } }]]) {
    assert.throws(() => checkBrandUrls(normalizeBrand({ name: 'X', ...b })), { message: new RegExp(`^brand ${esc(field)} "/`) }, field);
  }
  for (const b of [{ favicon: '//cdn.example/x.ico' }, { favicon: 'https://x.example/f.ico' }, { favicon: 'data:image/png;base64,AA==' }, { favicon: 'assets/x.ico' }, { logo: { url: 'assets/l.svg' } }]) {
    assert.ok(checkBrandUrls(normalizeBrand({ name: 'X', ...b })), JSON.stringify(b));
  }
  // An unnamed but configured brand inherits the default hero (a server asset, as every unbranded bundle): not refused.
  const unnamed = normalizeBrand({ tagline: 't' });
  assert.equal(unnamed.hero.src, DEFAULT_BRAND.hero.src);
  assert.ok(checkBrandUrls(unnamed));
  assert.ok(buildStudioBundle({ root: ROOT, packs: [], builtAt: 'x', brand: { tagline: 't' } }).html.includes('id="brand-config"'));

  // The shim names the product.
  const backend = createStaticBackend({ version: '1', schema, packs: [] }, { product: 'Acme Watch' });
  assert.equal(backend.product, 'Acme Watch');
  const diff = await backend.handle('/api/diff?a=p&b=p');
  assert.equal(diff.status, 501);
  assert.equal((await diff.json()).error, 'Compare needs the Acme Watch server; this studio is a static bundle built without one.');
  assert.match(noticeText(1, 'Acme Watch'), /^Static studio — no Acme Watch server behind this page\./);
  assert.equal(apiMenuSubText('Acme Watch'), 'needs the Acme Watch server · this studio is a static bundle');
});

// ---------- T9 the baked bundle in a browser ----------

test('T9 the baked bundle in headless Chromium: the brand in the title, wordmark, notice and 501 texts, no upstream name; /api/taxonomy from the page; Discover groups as the mapped golden; nothing fetched but the page', async (t) => {
  const required = process.env.OBSERVOGRAM_BUNDLE_SMOKE === 'require';
  const skip = (why) => { if (required) assert.fail(`OBSERVOGRAM_BUNDLE_SMOKE=require: ${why}`); t.skip(why); };
  const { pw, error } = await loadPlaywright();
  if (!pw) return skip(error);
  let browser;
  try { browser = await pw.chromium.launch(); }
  catch (e) { return skip(`chromium.launch failed: ${e.message.split('\n')[0]}`); }
  t.after(() => browser.close());

  const out = join(TMP, 'baked', 'index.html');
  const built = cli(['--taxonomy', TAX, '--brand', ACME_STATIC, '--pack', TYPED_CANONICAL, '--no-remote-fonts', '--out', out]);
  assert.equal(built.status, 0, built.stderr);
  const html = readFileSync(out);
  const srv = createServer((req, res) => {
    if (req.url === '/' || req.url.startsWith('/?') || req.url.startsWith('/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const page = await browser.newPage();
  const problems = [];
  const offLoopback = [];
  const served = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) { served.push(u); return route.continue(); }
    offLoopback.push(u);
    return route.abort();
  });
  await page.goto(`${base}/`);
  // The service tile: the fixture's bindings.service (examples/production-curated.pack.yaml).
  await page.waitForSelector('.svc-gate-card[data-service="internal-orders"]', { state: 'attached', timeout: 30_000 });
  assert.equal(await page.title(), 'Acme Watch — the Reliability Console');
  assert.equal(await page.textContent('.observa-wordmark'), 'ACMEWATCH');
  assert.match(await page.textContent('.no-backend-notice'), /^Static studio — no Acme Watch server behind this page\./);
  assert.equal(/observogram/i.test(await page.evaluate('document.body.innerText')), false, 'no upstream name rendered');
  const tax = await page.evaluate(async () => { const r = await fetch('/api/taxonomy'); return { status: r.status, body: await r.json() }; });
  assert.equal(tax.status, 200);
  assert.deepEqual(tax.body, { ok: true, taxonomy: JSON.parse(readFileSync(TAX, 'utf8')), configured: true });
  const denied = await page.evaluate(async () => { const r = await fetch('/api/refresh-live', { method: 'POST' }); return { status: r.status, body: await r.json() }; });
  assert.equal(denied.status, 501);
  assert.match(denied.body.error, /^Refresh from MCP needs the Acme Watch server/);
  // Open the pack the way a user does; Discover groups L4 as the mapped golden says (studio/discover-board.mjs
  // writes data-group and aria-label="<title>: <n>" on every .dvb-group section).
  await page.click('#home-choice-check');
  await page.click('.svc-gate-card[data-service="internal-orders"]');
  await page.waitForSelector('#pack-select option[value="typed-canonical"]', { state: 'attached', timeout: 30_000 });
  await page.waitForSelector('#layer-view .dv-layer[data-layer="L4"] .dvb-group', { state: 'attached', timeout: 30_000 });
  const browserL4 = await page.evaluate(() => [...document.querySelectorAll('#layer-view .dv-layer[data-layer="L4"] .dvb-group')].map((el) => [el.dataset.group, Number(el.getAttribute('aria-label').split(': ').pop())]).filter(([, n]) => n > 0));
  const goldenL4 = boardGroupCounts(read(MAPPED_BOARD), 'L4').filter(([, n]) => n > 0);
  assert.deepEqual(browserL4, goldenL4, 'the browser groups L4 as the mapped golden');
  assert.deepEqual(goldenL4, [['pol', 2], ['alr', 2], ['rule', 1]]);
  const item = await page.evaluate(() => {
    const el = document.querySelector('.observa-adv-item[data-action="api"]');
    return el ? { disabled: el.disabled, sub: el.querySelector('.observa-adv-item-sub')?.textContent } : null;
  });
  assert.deepEqual(item, { disabled: true, sub: 'needs the Acme Watch server · this studio is a static bundle' });
  assert.match(await page.textContent('#build-label'), /static bundle/);
  assert.equal(/observogram/i.test(await page.evaluate('document.body.innerText')), false, 'no upstream name rendered with a pack open');

  assert.deepEqual(problems, [], 'no page error and no console.error');
  assert.deepEqual(offLoopback, [], 'no request left the loopback');
  assert.ok(served.every((u) => u === `${base}/` || u.startsWith(`${base}/?`)), `the page fetched only itself (the data: favicon and the inline logo fetch nothing): ${served.filter((u) => u !== `${base}/`)}`);
});

// ---------- the catalogue labels a live pack (rebadge batch 3, C1) ----------

test('the bundle\'s catalogue says scaffold or snapshot as the server\'s does: live from service-keys livePackKind, absent for every other pack', async () => {
  const withAnnotations = (extra) => ({ ...paymentCanonical, metadata: { ...paymentCanonical.metadata, annotations: { ...(paymentCanonical.metadata.annotations || {}), ...extra } } });
  const draft = withAnnotations({ 'mcp.refreshedAt': '2026-10-07T12:00:00.000Z' });
  const snapshot = withAnnotations({ 'mcp.refreshedAt': '2026-10-07T12:00:00.000Z', 'observogram.live.mode': 'snapshot' });
  const backend = createStaticBackend({ version: '1', schema, packs: [
    { id: 'plain', label: 'Plain', canonical: paymentCanonical },
    { id: 'draft', label: 'gw (live MCP draft)', canonical: draft },
    { id: 'snap', label: 'Payments prod', canonical: snapshot },
  ] });
  const packs = (await (await backend.handle('/api/packs')).json()).packs;
  const byId = Object.fromEntries(packs.map((p) => [p.id, p]));
  assert.ok(!('live' in byId.plain), 'a pack that is no live pack carries no live key');
  assert.equal(byId.draft.live, 'scaffold');
  assert.equal(byId.snap.live, 'snapshot');
  // The same field, in the same place, as the registry's entry for the same canonical.
  const { catalogEntryOf } = await import('./lib/service-keys.mjs');
  const registry = catalogEntryOf('snap', { label: 'Payments prod', source: 'Payments prod' }, snapshot, listEnvironments(snapshot));
  const { source, description: _d, ...registryFields } = registry;
  const { description: _sd, ...shimFields } = byId.snap;
  assert.equal(source, 'uploaded');
  assert.deepEqual(shimFields, registryFields);
  assert.deepEqual(Object.keys(byId.snap).slice(-2), ['live', 'ok']);
});
