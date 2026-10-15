#!/usr/bin/env node
/**
 * server/test-taxonomy.mjs
 *
 * The artefact taxonomy override on the studio server (server/taxonomy.mjs):
 * OBSERVOGRAM_TAXONOMY is read once at start(), an unreadable or invalid
 * file refuses the boot naming the variable, the path and the reason, a
 * loaded one is logged once (path only) and served by GET /api/taxonomy
 * without its path, the legacy TOMOGRAPH_TAXONOMY spelling is honoured, and
 * a child started without the variable never inherits the parent's
 * (serve-child STRIP, both spellings). Every server is a child with an
 * explicit env; readTaxonomyConfig() is also exercised in-process against
 * a plain env object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, serve, childEnv, STRIP } from './fixtures/serve-child.mjs';

// Hermetic (§0): this process strips the children's list too, both spellings,
// before any server module loads (hence the dynamic import).
// server/test-hermetic-suites.mjs guards the shape.
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
const { readTaxonomyConfig, TAXONOMY_ENV } = await import('./taxonomy.mjs');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'taxonomy', 'taxonomy.json');
const FIXTURE_JSON = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const V2 = join(ROOT, 'tools', 'fixtures', 'taxonomy', 'taxonomy.v2.json');
const V2_JSON = JSON.parse(readFileSync(V2, 'utf8'));

const TMP = mkdtempSync(join(tmpdir(), 'observogram-taxonomy-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const workspace = () => join(TMP, `ws-${++n}`);
const file = (name, text) => { const p = join(TMP, name); writeFileSync(p, text); return p; };
const TOKEN = { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' };
const getTaxonomy = async (base) => { const r = await fetch(`${base}/api/taxonomy`); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };

test('readTaxonomyConfig: unset → nothing; a file → its document and resolved path; the legacy spelling; the modern name wins', () => {
  assert.deepEqual(readTaxonomyConfig({}), { taxonomy: null, path: null });
  assert.deepEqual(readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: '  ' }), { taxonomy: null, path: null });
  assert.deepEqual(readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: FIXTURE }), { taxonomy: FIXTURE_JSON, path: FIXTURE });
  assert.deepEqual(readTaxonomyConfig({ TOMOGRAPH_TAXONOMY: FIXTURE }), { taxonomy: FIXTURE_JSON, path: FIXTURE });
  const other = file('other.json', JSON.stringify({ version: 1, types: { X: 'sli' } }));
  assert.equal(readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: other, TOMOGRAPH_TAXONOMY: FIXTURE }).path, other);
  assert.equal(TAXONOMY_ENV, 'OBSERVOGRAM_TAXONOMY');
});

test('readTaxonomyConfig refuses a missing file, invalid JSON and an invalid document with `OBSERVOGRAM_TAXONOMY: <path>: <reason>`', () => {
  const missing = join(TMP, 'nope.json');
  assert.throws(() => readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: missing }), (e) => e.message.startsWith(`OBSERVOGRAM_TAXONOMY: ${missing}: ENOENT`) && e.cause?.code === 'ENOENT');
  const broken = file('broken.json', '{ "version": 1, ');
  assert.throws(() => readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: broken }), (e) => e.message.startsWith(`OBSERVOGRAM_TAXONOMY: ${broken}: invalid JSON: `));
  const unknown = file('unknown-family.json', JSON.stringify({ version: 1, types: { PackSLI: 'indicator' } }));
  assert.throws(() => readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: unknown }), { message: `OBSERVOGRAM_TAXONOMY: ${unknown}: taxonomy: types.PackSLI: unknown family "indicator"` });
  const several = file('several.json', JSON.stringify({ version: 3, ids: [{ pattern: 'x', family: 'sli' }] }));
  assert.throws(() => readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: several }), { message: `OBSERVOGRAM_TAXONOMY: ${several}: taxonomy: version must be 1 or 2 (+1 more)` });
  // Schema v2's glossary needs `version: 2`: a v1 file carrying one is refused as an unknown key.
  const v1Glossary = file('v1-glossary.json', JSON.stringify({ ...FIXTURE_JSON, glossary: V2_JSON.glossary }));
  assert.throws(() => readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: v1Glossary }), { message: `OBSERVOGRAM_TAXONOMY: ${v1Glossary}: taxonomy: unknown key "glossary"` });
  const badEntry = file('bad-entry.json', JSON.stringify({ ...V2_JSON, glossary: [{ term: 'T', definition: 'd', link: 'https://u:p@example.com/' }] }));
  assert.throws(() => readTaxonomyConfig({ OBSERVOGRAM_TAXONOMY: badEntry }), { message: `OBSERVOGRAM_TAXONOMY: ${badEntry}: taxonomy: glossary[0]: link must not carry credentials` });
  // The legacy spelling is read, the modern name is the one every message spells.
  assert.throws(() => readTaxonomyConfig({ TOMOGRAPH_TAXONOMY: missing }), (e) => e.message.startsWith(`OBSERVOGRAM_TAXONOMY: ${missing}: ENOENT`));
});

test('unconfigured: GET /api/taxonomy is { ok, taxonomy: null, configured: false }, no-store, and the boot prints no taxonomy line', async () => {
  const loud = boot(workspace(), { env: TOKEN, silent: false });
  assert.equal(loud.listening, true);
  assert.ok(!loud.stdout.includes('[taxonomy]') && !loud.stderr.includes('[taxonomy]'), 'nothing to say when nothing is configured');
  const s = await serve(workspace(), { env: TOKEN });
  try {
    const r = await getTaxonomy(s.base);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, { ok: true, taxonomy: null, configured: false });
  } finally { await s.stop(); }
});

test('configured: the document is served without its path, configured: true; the path is logged once at start, never on a silent boot', async () => {
  const ws = workspace();
  const loud = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TAXONOMY: FIXTURE }, silent: false });
  assert.equal(loud.listening, true);
  assert.deepEqual(loud.stdout.split('\n').filter(l => l.includes('[taxonomy]')), [`[taxonomy] loaded ${FIXTURE}: 7 types, 1 id rule`]);
  const quiet = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TAXONOMY: FIXTURE } });
  assert.equal(quiet.listening, true);
  assert.ok(!quiet.stdout.includes('[taxonomy]') && !quiet.stderr.includes('[taxonomy]'));
  const s = await serve(ws, { env: { ...TOKEN, OBSERVOGRAM_TAXONOMY: FIXTURE } });
  try {
    const r = await getTaxonomy(s.base);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, { ok: true, taxonomy: FIXTURE_JSON, configured: true });
    assert.ok(!JSON.stringify(r.body).includes(TMP) && !JSON.stringify(r.body).includes('fixtures/taxonomy'), 'the path is not in the body');
  } finally { await s.stop(); }
  // The legacy spelling configures the same answer.
  const legacy = await serve(workspace(), { env: { ...TOKEN, TOMOGRAPH_TAXONOMY: FIXTURE } });
  try { assert.deepEqual((await getTaxonomy(legacy.base)).body, { ok: true, taxonomy: FIXTURE_JSON, configured: true }); }
  finally { await legacy.stop(); }
});

test('schema v2: a file with a glossary boots, the log line counts its terms, and GET /api/taxonomy serves the glossary verbatim — the studio and the bundle bake read the same document', async () => {
  assert.equal(V2_JSON.version, 2);
  assert.equal(V2_JSON.glossary.length, 6);
  const ws = workspace();
  const loud = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TAXONOMY: V2 }, silent: false });
  assert.equal(loud.listening, true);
  assert.deepEqual(loud.stdout.split('\n').filter(l => l.includes('[taxonomy]')), [`[taxonomy] loaded ${V2}: 7 types, 1 id rule, 6 glossary terms`]);
  const s = await serve(ws, { env: { ...TOKEN, OBSERVOGRAM_TAXONOMY: V2 } });
  try {
    const r = await getTaxonomy(s.base);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, { ok: true, taxonomy: V2_JSON, configured: true });
    assert.deepEqual(r.body.taxonomy.glossary.map(e => e.term), ['Service level indicator', 'Service level objective', 'Alert rule', 'Telemetry backend', 'Error budget', 'Criticality tier']);
    assert.ok(!JSON.stringify(r.body).includes(TMP) && !JSON.stringify(r.body).includes('fixtures/taxonomy'), 'the path is not in the body');
  } finally { await s.stop(); }
});

test('an unknown family, a missing file or invalid JSON refuses the start, naming the variable, the path and the reason, before the store is touched', () => {
  const ws = workspace();
  const unknown = file('boot-unknown.json', JSON.stringify({ version: 1, types: { PackSLI: 'indicator' } }));
  const r1 = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TAXONOMY: unknown } });
  assert.equal(r1.listening, false);
  assert.equal(r1.message, `OBSERVOGRAM_TAXONOMY: ${unknown}: taxonomy: types.PackSLI: unknown family "indicator"`);
  const missing = join(TMP, 'boot-missing.json');
  const r2 = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_TAXONOMY: missing } });
  assert.equal(r2.listening, false);
  assert.ok(r2.message.startsWith(`OBSERVOGRAM_TAXONOMY: ${missing}: ENOENT`), r2.message);
  const broken = file('boot-broken.json', '{');
  const r3 = boot(ws, { env: { ...TOKEN, TOMOGRAPH_TAXONOMY: broken } });
  assert.equal(r3.listening, false);
  assert.ok(r3.message.startsWith(`OBSERVOGRAM_TAXONOMY: ${broken}: invalid JSON: `), 'the legacy spelling refuses with the modern name');
  assert.throws(() => readFileSync(join(ws, 'observogram.db')), /ENOENT/, 'the store was never opened');
});

test('a child started without the variable never inherits the parent\'s override (serve-child STRIP, both spellings)', async () => {
  assert.ok(STRIP.includes('TAXONOMY'), 'STRIP names TAXONOMY');
  assert.ok(STRIP.includes('GLOSSARY_SMOKE'), 'STRIP names the glossary browser suite\'s knob (server/test-glossary-shell.mjs), so a child never sees it');
  process.env.OBSERVOGRAM_TAXONOMY = FIXTURE;
  process.env.TOMOGRAPH_TAXONOMY = FIXTURE;
  let s;
  try {
    const env = childEnv(workspace(), TOKEN);
    assert.ok(!('OBSERVOGRAM_TAXONOMY' in env) && !('TOMOGRAPH_TAXONOMY' in env), 'childEnv strips both spellings');
    s = await serve(workspace(), { env: TOKEN });
    assert.deepEqual((await getTaxonomy(s.base)).body, { ok: true, taxonomy: null, configured: false });
  } finally {
    delete process.env.OBSERVOGRAM_TAXONOMY;
    delete process.env.TOMOGRAPH_TAXONOMY;
    if (s) await s.stop();
  }
});
