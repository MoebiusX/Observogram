#!/usr/bin/env node
// tools/test-pack-conformance.mjs — the placeholder report (tools/lib/pack-conformance.mjs) and its CLI.
//
// The engine's contract is the adapter's: a placeholder is an artefact whose symbol carries a
// `crawler.scaffold.` / `mcp.scaffold.` / `library.todo.` key with a non-empty value (SCAFFOLD_PREFIXES is pinned
// to adapter.mjs's source here, never imported), its symbol grammar is the inverse of library.mjs's symbolOf, and
// its stub table recognises every literal the four writers (upconvert, crawler, fetcher, library) emit — change a
// stub in legacy.mjs and the "every marker row is `placeholder`" guard below fails. The catalogue pin is the
// inert statement: every shipped canonical pack reports zero rows. The CLI is spawned with process.execPath,
// temp files live in mkdtempSync(tmpdir()), paths compare as the strings passed — nothing to skip on win32.
//
// Run: node --test tools/test-pack-conformance.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  SCAFFOLD_PREFIXES, SOURCES, STATES, SYMBOL_FAMILIES, PLACEHOLDER_FIELDS,
  parseSymbol, resolveSymbol, scaffoldMarkers, packConformance,
} from './lib/pack-conformance.mjs';
import { validateCanonical, SPEC_VERSION, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { upconvertLegacyPack } from './lib/legacy.mjs';
import { crawlFiles } from './lib/crawler.mjs';
import { instantiatePack, parseLibraryEntry, symbolOf } from './lib/library.mjs';
import { adapt } from './lib/adapter.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { buildCanonicalPack } from './fetch-live-pack.mjs';
import { collectModuleGraph } from './build-studio-bundle.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(ROOT, ...p.split('/'));
const read = (p) => readFileSync(rel(p), 'utf8');
const loadPack = (p) => (p.endsWith('.json') ? JSON.parse(read(p)) : parseYaml(read(p)));
const SCHEMA = JSON.parse(read(SPEC_SCHEMA_PATH));
const CLI = rel('tools/pack-conformance.mjs');
const clone = (x) => JSON.parse(JSON.stringify(x));

const LEGACY_FILES = readdirSync(rel('examples/legacy')).filter(f => f.endsWith('.json')).sort();
const upconverted = Object.fromEntries(LEGACY_FILES.map(f => [f, upconvertLegacyPack(JSON.parse(read(`examples/legacy/${f}`)), { now: '2026-01-01T00:00:00.000Z' }).canonical]));
const emptyCrawl = () => crawlFiles(new Map([['README.md', '# empty']]), { repoName: 'empty-svc', environment: 'prod', now: '2026-01-01T00:00:00.000Z' }).canonical;
const libraryPack = () => instantiatePack(parseLibraryEntry(read('library/products/alertmanager.library.yaml')), { name: 'svc-x', tier: 'tier-1', environment: 'prod' }).canonical;
const fetcherPack = () => buildCanonicalPack({
  refreshedAt: '2026-06-06T00:00:00Z', mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout' }] }, topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] }, errors: {},
});

// Pinned on first run (the design: fill the exact numbers and pin them, as test-golden-board pins families).
const LEGACY_PINS = {
  'demo-skeleton.json': { markers: 15, imports: 1, symbols: 19, byState: { placeholder: 31, 'marker-only': 0, unmarked: 4, dangling: 0 } },
  'production-curated.json': { markers: 33, imports: 6, symbols: 42, byState: { placeholder: 74, 'marker-only': 0, unmarked: 9, dangling: 0 } },
  'production-live.json': { markers: 35, imports: 6, symbols: 44, byState: { placeholder: 78, 'marker-only': 0, unmarked: 9, dangling: 0 } },
  'target-advanced.json': { markers: 45, imports: 6, symbols: 54, byState: { placeholder: 95, 'marker-only': 0, unmarked: 9, dangling: 0 } },
};

// ---------- 1. tables ----------

test('the vocabularies: SOURCES, STATES, SCAFFOLD_PREFIXES (pinned to adapter.mjs\'s source), every table row well-formed', () => {
  assert.deepEqual([...SOURCES], ['crawl', 'operator', 'telemetry']);
  assert.deepEqual([...STATES], ['placeholder', 'marker-only', 'unmarked', 'dangling']);
  const adapterSrc = read('tools/lib/adapter.mjs');
  const m = /scaffoldPrefixes = \[(.*?)\]/.exec(adapterSrc);
  assert.ok(m, 'adapter.mjs declares scaffoldPrefixes');
  const adapterPrefixes = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual([...SCAFFOLD_PREFIXES], adapterPrefixes, 'the two readers of the marker contract cannot drift');
  assert.ok(!/from '\.\/adapter\.mjs'/.test(read('tools/lib/pack-conformance.mjs')), 'the engine never imports the adapter (it is in the static bundle graph)');
  for (const [family, rows] of Object.entries(PLACEHOLDER_FIELDS)) {
    assert.ok(SYMBOL_FAMILIES.some(f => f.family === family), `${family} is a symbol family`);
    for (const row of rows) {
      assert.ok(row.field && row.needs, `${family}.${row.field} has needs`);
      assert.ok(SOURCES.includes(row.source), `${family}.${row.field} source ${row.source}`);
      assert.match(`placeholder.${family}.${row.field}`, /^placeholder\.[a-z_.]+\.[a-z0-9_.*]+$/);
    }
  }
  for (const fam of SYMBOL_FAMILIES) assert.ok(fam.family && fam.re instanceof RegExp && typeof fam.resolve === 'function' && typeof fam.identity === 'function', fam.family);
});

// ---------- 2. grammar round-trip ----------

const jsonPathToArray = (p) => p.replace(/^\$\./, '').replace(/\[(\d+)\]/g, '.$1').split('.');

test('every marker of every writer resolves; library symbols round-trip through library.mjs symbolOf', () => {
  const packs = [
    ...readdirSync(rel('tools/fixtures/library')).filter(f => f.endsWith('.pack.yaml')).map(f => ['library', loadPack(`tools/fixtures/library/${f}`)]),
    ...Object.entries(upconverted).map(([f, p]) => [`legacy ${f}`, p]),
    ['golden-crawl', loadPack('tools/fixtures/golden-crawl.pack.json')],
    ['empty crawl', emptyCrawl()],
    ['library alertmanager', libraryPack()],
    ['fetcher', fetcherPack()],
  ];
  for (const [label, pack] of packs) {
    const markers = scaffoldMarkers(pack);
    assert.ok(markers.length > 0, `${label} carries markers`);
    for (const mk of markers) {
      const r = resolveSymbol(pack, mk.symbol);
      assert.equal(r.exists, true, `${label}: ${mk.key} resolves`);
      assert.ok(parseSymbol(mk.symbol), `${label}: ${mk.symbol} parses`);
      if (!label.startsWith('library') || r.family === 'dashboards.panels' || r.rest) continue;
      const back = symbolOf(jsonPathToArray(r.path), pack);
      assert.equal(back.symbol, mk.symbol, `${label}: ${r.path} → symbolOf → ${mk.symbol}`);
    }
  }
  assert.equal(resolveSymbol(upconverted['demo-skeleton.json'], 'slis.nope').exists, false);
  assert.equal(resolveSymbol({}, 'alerting.routes[3]').exists, false);
  assert.equal(parseSymbol('nonsense.thing'), null);
  assert.deepEqual(parseSymbol('alerting.routes[2].channels[1]'), { family: 'alerting.routes', index: 2, rest: 'channels.1' });
  assert.deepEqual(parseSymbol('dashboards.ov.panels.p95 latency'), { family: 'dashboards.panels', id: 'ov', panel: 'p95 latency' });
});

// ---------- 3. the four legacy examples ----------

test('every upconverted example: valid, not conformant, every marker row `placeholder` (the stub-table drift guard), the pinned counts, sorted, deterministic, no mutation', () => {
  for (const [file, pack] of Object.entries(upconverted)) {
    const before = clone(pack);
    const r = packConformance(pack);
    assert.deepEqual(pack, before, `${file}: input not mutated`);
    assert.deepEqual(validateCanonical(pack, SCHEMA), [], `${file} valid`);
    assert.equal(r.conformant, false);
    const pin = LEGACY_PINS[file];
    assert.equal(r.markers, pin.markers, `${file} markers`);
    assert.equal(pack.metadata.imports.length, pin.imports);
    assert.equal(r.counts.symbols, r.markers + 3 + pack.metadata.imports.length, `${file}: symbols = markers + owners/version/binding + imports`);
    assert.equal(r.counts.symbols, pin.symbols);
    assert.deepEqual(r.counts.byState, pin.byState, `${file} byState`);
    assert.ok(r.rows.filter(x => x.marker).every(x => x.state === 'placeholder'), `${file}: no marker row is marker-only — ${r.rows.filter(x => x.marker && x.state !== 'placeholder').map(x => `${x.symbol}.${x.field}`).join(',')}`);
    for (const row of r.rows.filter(x => x.symbol.startsWith('imports['))) {
      assert.equal(row.state, 'unmarked'); assert.equal(row.rule, 'placeholder.imports.ref'); assert.equal(row.source, 'operator');
    }
    assert.ok(r.rows.filter(x => x.marker).every(x => x.writer === 'legacy'), 'crawler.scaffold.* on a legacy.format pack is the upconvert\'s');
    assert.deepEqual(packConformance(pack), r, 'deterministic');
    const familyOrder = r.rows.map(x => SYMBOL_FAMILIES.findIndex(f => f.family === resolveSymbol(pack, x.symbol).family));
    assert.deepEqual(familyOrder, [...familyOrder].sort((a, b) => a - b), `${file}: rows in family order`);
    for (const row of r.rows) {
      assert.ok(STATES.includes(row.state) && SOURCES.includes(row.source) && row.path && row.symbol && row.rule, JSON.stringify(row));
    }
  }
  const pc = packConformance(upconverted['production-curated.json']);
  assert.ok(SOURCES.every(s => pc.counts.bySource[s] > 0), 'production-curated has all three sources');
  assert.deepEqual(pc.writers, { legacy: true, crawler: false, fetcher: false, library: false });
});

// ---------- 4. transitions ----------

test('transitions on production-curated: real value → marker-only; marker deleted → silent; id renamed → dangling; real metadata → no rows; `x or vector(1)` never fingerprints', () => {
  const base = upconverted['production-curated.json'];
  const sym = `slis.${base.spec.slis[0].id}`;
  const a = clone(base);
  a.spec.slis[0].good = 'sum(rate(real_good[5m]))'; a.spec.slis[0].total = 'sum(rate(real_total[5m]))';
  const ra = packConformance(a).rows.filter(x => x.symbol === sym);
  assert.deepEqual(ra.map(x => [x.field, x.state]), [['good', 'marker-only'], ['total', 'marker-only']]);
  const b = clone(a); delete b.metadata.annotations[`crawler.scaffold.${sym}`];
  assert.deepEqual(packConformance(b).rows.filter(x => x.symbol === sym), [], 'the marker is the truth: deleted → zero rows');
  const c = clone(base); c.spec.slis[0].id = 'renamed-sli'; for (const s of c.spec.slos) if (s.sli === base.spec.slis[0].id) s.sli = 'renamed-sli';
  const dangling = packConformance(c).rows.filter(x => x.state === 'dangling');
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].path, `$.metadata.annotations["crawler.scaffold.${sym}"]`);
  assert.equal(dangling[0].field, null); assert.equal(dangling[0].rule, 'marker.dangling');
  assert.equal(packConformance(c).rows[packConformance(c).rows.length - 1].state, 'dangling', 'dangling rows last');
  const d = clone(base); d.metadata.owners = ['team-payments']; d.metadata.version = '1.2.0'; d.metadata.binding = 'otel-elastic-prometheus-grafana';
  assert.deepEqual(packConformance(d).rows.filter(x => x.symbol.startsWith('metadata.')), []);
  const e = clone(base); e.spec.queries.recording_rules[0].expr = 'x or vector(1)'; delete e.metadata.annotations['crawler.scaffold.queries.recording_rules[0]'];
  assert.deepEqual(packConformance(e).rows.filter(x => x.symbol === 'queries.recording_rules[0]'), [], 'exact-match guard');
  const f = clone(base); f.metadata.annotations[`crawler.scaffold.${sym}`] = '';
  assert.deepEqual(packConformance(f).rows.filter(x => x.symbol === sym), [], 'an empty-valued marker is no marker (the adapter\'s truthiness test)');
  const sliCard = adapt(f).layers.L1.find(x => x.id === `SLI-${base.spec.slis[0].id}`) || adapt(f).layers.L1.find(x => /^SLI-/.test(x.id));
  assert.equal(sliCard.source, 'Declared', 'parity: the adapter projects the same artefact as Declared');
});

// ---------- 5. crawler stubs ----------

test('an empty-repo crawl: the crawler marks every value it invents (the stub SLI/SLO, the owners, the otel fields); only the version is `unmarked`', () => {
  const pack = emptyCrawl();
  const r = packConformance(pack);
  assert.equal(r.writers.crawler, true);
  assert.equal(r.markers, 17);
  const sli = r.rows.filter(x => x.symbol === 'slis.service_availability');
  assert.deepEqual(sli.map(x => [x.field, x.state, x.marker]), [['good', 'placeholder', 'crawler.scaffold.slis.service_availability'], ['total', 'placeholder', 'crawler.scaffold.slis.service_availability']]);
  assert.ok(r.rows.filter(x => x.marker).every(x => x.state === 'placeholder' && x.writer === 'crawler'), `every crawler stub is recognised: ${r.rows.filter(x => x.marker && x.state !== 'placeholder').map(x => `${x.symbol}.${x.field}`).join(',')}`);
  assert.deepEqual(r.rows.filter(x => x.symbol.startsWith('metadata.')).map(x => [x.field, x.state, x.marker]), [['version', 'unmarked', null], ['owners', 'placeholder', 'crawler.scaffold.metadata.owners']]);
  assert.deepEqual(r.rows.filter(x => x.symbol.startsWith('otel.')).map(x => x.field), ['semconv', 'resource_attributes', 'sdk.languages', 'sdk.sampling', 'sdk.propagators'], 'the five field symbols land as five rows');
  assert.deepEqual(r.counts.byState, { placeholder: 25, 'marker-only': 0, unmarked: 1, dangling: 0 });
  // The unmarked fingerprint still fires for a crawler-written pack whose stub SLI lost its marker (an older crawl).
  const older = clone(pack); delete older.metadata.annotations['crawler.scaffold.slis.service_availability'];
  assert.deepEqual(packConformance(older).rows.filter(x => x.symbol === 'slis.service_availability').map(x => [x.field, x.state]), [['good', 'unmarked'], ['total', 'unmarked']]);
});

test('the hostile fixture crawl: every crawler mark reads `placeholder` (invented channels, the assumed port, the probe target of an underscore name)', () => {
  const readTree = (dir) => {
    const out = new Map();
    (function walk(d) {
      for (const ent of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name !== 'README.md') out.set(p.slice(dir.length + 1).split(/[\\/]/).join('/'), readFileSync(p, 'utf8'));
      }
    })(dir);
    return out;
  };
  const pack = crawlFiles(readTree(rel('tools/fixtures/crawl/canonical/Hostile_Repo')), { repoName: 'Hostile_Repo', now: '2026-01-01T00:00:00.000Z' }).canonical;
  const r = packConformance(pack);
  assert.equal(r.writers.crawler, true);
  assert.deepEqual(r.rows.filter(x => x.marker && x.state !== 'placeholder').map(x => `${x.symbol}.${x.field}`), [], 'every crawler literal is recognised');
  assert.deepEqual(r.rows.filter(x => x.symbol.startsWith('alerting.routes[')).map(x => [x.symbol, x.field, x.state]),
    [['alerting.routes[0].channels[0]', 'channels.0', 'placeholder'], ['alerting.routes[1].channels[0]', 'channels.0', 'placeholder'], ['alerting.routes[2].channels[0]', 'channels.0', 'placeholder']]);
  const ep = r.rows.find(x => x.symbol === 'telemetry.backends.metrics-prometheus.endpoints');
  assert.deepEqual([ep.field, ep.source, ep.state], ['endpoints', 'telemetry', 'placeholder']);
  const real = clone(pack); real.spec.alerting.routes[2].channels[0].voice = 'pagerduty://real-service-key';
  assert.equal(packConformance(real).rows.find(x => x.symbol === 'alerting.routes[2].channels[0]').state, 'placeholder', 'a pagerduty:// value is still the library\'s stub shape');
  real.spec.alerting.routes[2].channels[0].voice = 'tel:+15551234567';
  assert.equal(packConformance(real).rows.find(x => x.symbol === 'alerting.routes[2].channels[0]').state, 'marker-only', 'a real voice target under a standing mark is marker-only');
});

// ---------- 6. library ----------

test('a library pack: the note names the fields and the literal; the value walks array indices; a note without a literal is `placeholder`; metadata.owners falls back to the table', () => {
  const pack = libraryPack();
  const r = packConformance(pack);
  assert.equal(r.writers.library, true);
  assert.ok(r.rows.every(x => x.writer === 'library' && x.state === 'placeholder'));
  const route0 = r.rows.filter(x => x.symbol === 'alerting.routes[0]');
  assert.deepEqual(route0.map(x => x.field), ['channels.0.msteams', 'channels.1.voice']);
  assert.match(route0[0].needs, /^Chat channel for SEV1\/SEV2: placeholder '#svc-x-oncall'/);
  assert.equal(route0[0].rule, 'placeholder.alerting.routes.channels');
  const recv = r.rows.find(x => x.symbol === 'pipelines.receivers[1]');
  assert.equal(recv.field, 'scrape_configs.0.static_configs.0.targets.0');
  assert.equal(resolveSymbol(pack, 'pipelines.receivers[1]').item.scrape_configs[0].static_configs[0].targets[0], 'alertmanager:9093');
  const loki = r.rows.filter(x => x.symbol === 'telemetry.backends.logs-loki');
  assert.deepEqual(loki.map(x => [x.field, x.source]), [['version.declared', 'telemetry'], ['endpoints.0', 'telemetry']]);
  const exp = r.rows.find(x => x.symbol === 'pipelines.exporters.metrics');
  assert.equal(exp.field, 'endpoint', 'a field the table does not know: the note overrides');
  const rb = r.rows.find(x => x.symbol === 'remediation[0]');
  assert.deepEqual([rb.field, rb.state, rb.source], ['runbook', 'placeholder', 'crawl']);
  const owners = r.rows.find(x => x.symbol === 'metadata.owners');
  assert.deepEqual([owners.path, owners.source, owners.field], ['$.metadata.owners', 'operator', 'owners']);
  const edited = clone(pack); edited.spec.alerting.routes[0].channels[0].msteams = '#real-channel';
  const after = packConformance(edited).rows.filter(x => x.symbol === 'alerting.routes[0]');
  assert.deepEqual(after.map(x => [x.field, x.state]), [['channels.0.msteams', 'marker-only'], ['channels.1.voice', 'placeholder']]);
});

// ---------- 7. catalogue pin + fetcher ----------

test('catalogue pin: every shipped canonical pack reports zero rows; krystaline pins its crawler rows; the fetcher\'s stubs read `placeholder`', () => {
  const shipped = [
    'examples/demo-skeleton.pack.yaml', 'examples/production-curated.pack.yaml', 'examples/target-advanced.pack.yaml',
    ...readdirSync(rel('reference-packs')).filter(f => f.endsWith('.pack.yaml')).map(f => `reference-packs/${f}`),
    `${SPEC_SCHEMA_PATH.replace(/\/[^/]+$/, '')}/examples/payment-service.pack.yaml`,
  ];
  for (const p of shipped) {
    const r = packConformance(loadPack(p));
    assert.deepEqual(r.rows, [], `${p} reports no placeholders`);
    assert.equal(r.conformant, true);
  }
  const k = packConformance(loadPack('examples/krystaline-repo-carlos.pack.yaml'));
  assert.equal(k.markers, 3);
  assert.equal(k.counts.symbols, 5, '3 markers + owners + version');
  assert.deepEqual(k.counts.byState, { placeholder: 7, 'marker-only': 0, unmarked: 2, dangling: 0 });
  assert.deepEqual(k.rows.filter(x => x.state === 'unmarked').map(x => x.symbol), ['metadata.version', 'metadata.owners']);
  const g = packConformance(loadPack('tools/fixtures/golden-crawl.pack.json'));
  assert.deepEqual([g.markers, g.counts.symbols, g.counts.byState.unmarked], [9, 10, 1], 'the golden crawl: 9 marks (4 stubs + owners + 4 otel fields; the languages are read off src/metrics.ts), the version the one unmarked row');
  const f = packConformance(fetcherPack());
  assert.equal(f.writers.fetcher, true);
  assert.ok(f.rows.every(x => x.writer === 'fetcher'));
  assert.deepEqual(f.rows.filter(x => x.state !== 'placeholder'), [], 'every fetcher stub is recognised');
  assert.deepEqual(f.rows.filter(x => x.symbol === 'otel').map(x => x.field), ['semconv', 'resource_attributes', 'sdk.languages', 'sdk.sampling', 'sdk.propagators']);
});

// ---------- 8. CLI ----------

test('the CLI: refusals, exit codes, --strict, --quiet, --json, determinism', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pack-conformance-'));
  try {
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });
    const legacyPath = rel('examples/legacy/demo-skeleton.json');
    const up = join(dir, 'up.pack.json'); writeFileSync(up, JSON.stringify(upconverted['demo-skeleton.json'], null, 2) + '\n');
    const clean = join(dir, 'clean.pack.yaml'); writeFileSync(clean, read(`${SPEC_SCHEMA_PATH.replace(/\/[^/]+$/, '')}/examples/payment-service.pack.yaml`));
    const invalid = join(dir, 'invalid.pack.json'); const inv = clone(upconverted['demo-skeleton.json']); inv.spec.slis = []; writeFileSync(invalid, JSON.stringify(inv));
    const crawl = join(dir, 'crawl.pack.json'); writeFileSync(crawl, JSON.stringify(emptyCrawl()));

    let r = run(legacyPath);
    assert.equal(r.status, 1); assert.match(r.stderr, /upconvert it first/); assert.equal(r.stdout, '');
    r = run(up);
    assert.equal(r.status, 0); assert.match(r.stdout, /^✗ /); assert.match(r.stdout, /by source: crawl \d+ · operator \d+ · telemetry \d+/); assert.match(r.stdout, /rubric @ tier-3/);
    assert.match(r.stdout, /\$\.spec\.slis\[0\] {2}slis\.[a-z0-9_-]+ {2}\(crawler\.scaffold\)/); assert.match(r.stdout, /-> then delete metadata\.annotations\["crawler\.scaffold\./);
    assert.match(r.stdout, /-> no marker: the value is an upstream stub literal/);
    assert.equal(run(up).stdout, r.stdout, 'byte-identical across runs');
    assert.equal(run(up, '--strict').status, 1);
    const q = run(up, '--quiet');
    assert.equal(q.status, 0); assert.equal(q.stdout.split('\n').filter(l => /^ {4}/.test(l)).length, 0, 'no row lines'); assert.match(q.stdout, /by source:/);
    const j = run(up, '--json');
    assert.equal(j.status, 0); assert.equal(j.stderr, '');
    const doc = JSON.parse(j.stdout);
    assert.equal(doc.tool, 'pack-conformance'); assert.equal(doc.specVersion, SPEC_VERSION); assert.equal(doc.strict, false); assert.equal(doc.exitCode, 0);
    assert.equal(doc.packs[0].path, up); assert.equal(doc.packs[0].valid, true);
    assert.equal(doc.packs[0].rows.length, packConformance(upconverted['demo-skeleton.json']).rows.length);
    assert.deepEqual(Object.keys(doc.packs[0].rubric), ['declaredTier', 'mustPassed', 'mustTotal', 'mustPercent', 'scorePercent', 'conformant']);
    assert.equal(doc.totals.rows, doc.packs[0].rows.length);
    const js = run(up, '--json', '--strict'); const sdoc = JSON.parse(js.stdout);
    assert.equal(js.status, 1); assert.equal(sdoc.strict, true); assert.equal(sdoc.exitCode, 1);
    r = run(clean, '--strict');
    assert.equal(r.status, 0); assert.match(r.stdout, /^✓ .*conformant: no placeholders {2}\[spec v/);
    r = run(invalid);
    assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`not a valid spec v${SPEC_VERSION.replace('.', '\\.')} manifest`)); assert.equal(r.stdout, '');
    r = run(join(dir, 'missing.pack.yaml'));
    assert.equal(r.status, 1); assert.match(r.stderr, /file not found/);
    r = run();
    assert.equal(r.status, 2); assert.match(r.stderr, /^usage:/);
    assert.equal(run(up, '--bogus').status, 2);
    r = run(up, invalid);
    assert.equal(r.status, 1); assert.match(r.stdout, /^✗ .*up\.pack\.json/); assert.match(r.stderr, /invalid\.pack\.json/);
    const jm = JSON.parse(run(up, invalid, '--json').stdout);
    assert.equal(jm.packs.length, 2); assert.equal(jm.packs[1].valid, false); assert.deepEqual(jm.packs[1].rows, []); assert.equal(jm.totals.valid, 1);
    r = run(crawl, '--strict');
    assert.equal(r.status, 1, 'an unmarked row alone fails --strict');
    assert.equal(run(crawl).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 9. inert by default ----------

test('inert: no server/ or studio/ file imports the engine; the static bundle graph reaches neither it nor legacy.mjs; the CLIs resolve the schema through fileURLToPath', () => {
  const walk = (d) => readdirSync(rel(d), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.mjs') ? [`${d}/${e.name}`] : []));
  for (const f of [...walk('server'), ...walk('studio')]) {
    assert.ok(!/pack-conformance\.mjs/.test(read(f)), `${f} does not import pack-conformance.mjs`);
  }
  const graph = collectModuleGraph();
  assert.ok(!graph.has('tools/lib/pack-conformance.mjs') && !graph.has('lib/pack-conformance.mjs'), 'bundle graph has no pack-conformance');
  assert.ok(![...graph.keys()].some(k => /legacy\.mjs$/.test(k)), 'bundle graph has no legacy.mjs');
  for (const cli of ['tools/pack-conformance.mjs', 'tools/upconvert-legacy.mjs']) {
    const src = read(cli);
    assert.ok(/fileURLToPath\(import\.meta\.url\)/.test(src), `${cli} uses fileURLToPath`);
    assert.ok(!/\.pathname/.test(src), `${cli} never uses .pathname as a path`);
  }
  assert.ok(existsSync(rel('VENDOR-MANIFEST.json')) && JSON.parse(read('VENDOR-MANIFEST.json')).modules['tools/lib/pack-conformance.mjs'], 'the engine is a listed module');
});
