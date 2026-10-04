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
// fixture pack, the Export download asserted.
//
// Playwright is an environment-provided tool, never a dependency:
// OBSERVOGRAM_PLAYWRIGHT names its index.mjs (else the bare 'playwright');
// T7 skips when neither imports or the browser does not launch, unless
// OBSERVOGRAM_BUNDLE_SMOKE=require (CI with browsers) turns the skip into a
// failure. Hermetic: the page may only reach the loopback server that
// serves the bundle; the child server gets serve-child's stripped env.
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
import { join, resolve, dirname } from 'node:path';

import {
  collectModuleGraph, rewriteSpecifiers, assertRewritten, inlineJson, styleBlock, buildStudioBundle,
  checkPackUrl, parseArgs, defaultPackId, ENTRIES, CONFIG_ID, DEFAULT_ROOT,
} from './build-studio-bundle.mjs';
import { createStaticBackend, featureOf, denialText, noticeText, DENIED } from '../studio/static-backend.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { listEnvironments } from './lib/adapter.mjs';
import { listTargets } from './lib/compile.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { serve } from '../server/fixtures/serve-child.mjs';

const ROOT = DEFAULT_ROOT;
const TOOL = resolve(ROOT, 'tools/build-studio-bundle.mjs');
const PAYMENT = 'vendor/observability-pack-spec/v1.4/examples/payment-service.pack.yaml';
const GOLDEN = 'tools/fixtures/golden-crawl.pack.json';
const LIBRARY_BUILT = 'tools/fixtures/build/orders-api.tier-2.instantiate.json';
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
const cli = (args, cwd = TMP) => spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', env: { ...process.env } });
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
  for (const k of ['studio/app.mjs', 'studio/static-backend.mjs', 'lib/service-keys.mjs', 'lib/crawler.mjs', 'lib/mcp-url-safety.mjs', 'lib/artefact-classify.mjs', 'lib/library.mjs', 'lib/zip.mjs']) {
    assert.ok(graph.has(k), `${k} is in the graph`);
  }
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
  assert.throws(() => collectModuleGraph(ROOT, ENTRIES, { read: (p) => (p === 'tools/lib/compile.mjs' ? probed : readFileSync(join(ROOT, p), 'utf8')) }), /tools\/lib\/does-not-exist\.mjs/, 'the probe past compile.mjs:605 is collected and resolved');
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
  for (const args of [['--bogus'], ['--pack'], ['--id', 'x'], ['--out']]) {
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
  for (const f of flags) {
    if (f === '--help') continue;
    for (const [name, text] of [['usage line', usageLine], ['README', readmeSection]]) assert.ok(text.includes(f), `${f} is documented in the ${name}`);
    if (!packFlags.includes(f)) continue; // --check/--json/--out/--no-remote-fonts are the CLI's, not the pack catalogue's
    for (const [name, text] of [['DOWNSTREAM §9 row', row], ['DOWNSTREAM §10', embedding]]) assert.ok(text.includes(f), `${f} is documented in the ${name}`);
  }
  // --description is a per-pack option of both --pack and --pack-url.
  assert.match(usageLine, /--pack-url <url> \[--id <id>\] \[--label <text>\] \[--description <text>\]/);
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
  for (const path of ['/api/compile/targets', '/api/maturity-rubric', '/api/taxonomy', '/api/examples', '/api/references', '/api/live-status']) {
    const a = await server(path);
    const b = await shim(backend, path);
    assert.equal(b.status, a.status, path);
    assert.equal(b.type, a.type, path);
    if (path === '/api/examples' || path === '/api/references') assert.deepEqual(b.body, { [path.slice(5)]: [] }, `${path}: empty in the bundle`);
    else assert.deepEqual(b.body, a.body, path);
  }
  // Unknown pack: the server's shapes.
  for (const path of ['/api/packs/nope', '/api/packs/nope/conformance', '/api/packs/nope/canonical', '/api/packs/nope/compile-catalog', '/api/packs/nope/compile-artifact?group=x', '/api/packs/nope/compile/prometheus-rules', '/api/packs/nope/export.zip']) {
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
  await expectDenied('/api/validate', { method: 'POST' }, 'Uploading a pack');
  await expectDenied('/api/uploads', { method: 'DELETE' }, 'Uploading a pack');
  await expectDenied('/api/diff?a=p&b=p', undefined, 'Compare');
  await expectDenied('/api/packs/p/retrofeed', { method: 'POST' }, 'Compare');
  await expectDenied('/api/deploy/matrix', undefined, 'Deploy');
  await expectDenied('/api/deploys?pack=p', undefined, 'Deploy');
  await expectDenied('/api/packs/p/deploy-bulk', { method: 'POST' }, 'Deploy');
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
  assert.equal(featureOf('/api/packs/x/retrofeed?y'), 'Compare');
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
  // The notice text.
  assert.equal(noticeText(1), 'Static studio — no Observogram server behind this page. Discover, Diagnose, Compile and conformance read the 1 pack built in; Scan a repo, Draft from MCP, Compare, Deploy, Journeys, Build and sign-in need the server.');
  assert.match(noticeText(0), /read the 0 packs built in/);
});

// ---------- T7 the real bundle in a browser ----------

async function loadPlaywright() {
  const spec = process.env.OBSERVOGRAM_PLAYWRIGHT || 'playwright';
  try { return { pw: await import(spec) }; }
  catch (e) { return { error: `cannot import ${spec}: ${e.message.split('\n')[0]}` }; }
}

test('T7 the REAL bundle boots in headless Chromium against the fixture pack: the notice, the open posture, the pack opened, 501 for a live feature, the Export download, no page error, no request off the loopback', async (t) => {
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
  // Dismiss the notice; it stays dismissed on reload (localStorage).
  await page.click('.no-backend-notice-dismiss');
  assert.equal(await page.isVisible('.no-backend-notice'), false);
  await page.reload();
  await page.waitForSelector('#observa-chrome, .observa-hdr, #layer-view', { state: 'attached', timeout: 30_000 });
  await page.waitForFunction(() => (document.querySelector('#layer-view')?.textContent || '').trim().length > 0, null, { timeout: 30_000 });
  assert.equal(await page.$('.no-backend-notice'), null, 'the dismissal is remembered');

  assert.deepEqual(problems, [], 'no page error and no console.error');
  assert.deepEqual(offLoopback, [], 'no request left the loopback');
  assert.ok(served.every((u) => u === `${base}/` || u.startsWith(`${base}/?`)), `the page fetched only itself over HTTP: ${served.filter((u) => u !== `${base}/`)}`);
});
