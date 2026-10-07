#!/usr/bin/env node
/**
 * server/test-mcp-settings.mjs
 *
 * The MCP server-settings API on the studio server (rebadge batch 4):
 * the settings policy (server/mcp-settings-policy.mjs) — OBSERVOGRAM_MCP_SETTINGS_POLICY
 * is read once at start(), an unreadable or invalid file refuses the boot
 * naming the variable, the path and the reason before the store is touched,
 * a BOM-led file loads, a loaded one is logged once (path and rule count)
 * and served by GET /api/mcp-settings without its path, the legacy
 * TOMOGRAPH_ spelling is honoured — and the opt-in pass-through's switch
 * (OBSERVOGRAM_MCP_ADMIN_PROXY=1, read per request) as the GET reports it.
 * A child started without either variable never inherits the parent's
 * (serve-child STRIP, both spellings). Every server is a child with an
 * explicit env; readSettingsPolicyConfig() is also exercised in-process
 * against a plain env object.
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
const { readSettingsPolicyConfig, MCP_SETTINGS_POLICY_ENV, MCP_ADMIN_PROXY_ENV } = await import('./mcp-settings-policy.mjs');

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'mcp-settings', 'policy.json');
const FIXTURE_JSON = JSON.parse(readFileSync(FIXTURE, 'utf8'));

const TMP = mkdtempSync(join(tmpdir(), 'observogram-mcp-settings-'));
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });
let n = 0;
const workspace = () => join(TMP, `ws-${++n}`);
const file = (name, text) => { const p = join(TMP, name); writeFileSync(p, text); return p; };
const TOKEN = { OBSERVOGRAM_API_TOKEN: 'tok-0123456789' };
const getSettings = async (base) => { const r = await fetch(`${base}/api/mcp-settings`); return { status: r.status, cache: r.headers.get('cache-control'), body: await r.json() }; };
const UNSET = { ok: true, proxy: false, policy: null, configured: false };

// A policy with a generic block and a type rule: served as the file holds it, not normalised.
const GENERIC = {
  version: 1,
  rules: [
    { when: { type: 'url', pattern: '^http://', flags: 'i' }, warn: 'A plain-http backend.' },
    { when: { field: 'grafanaUrl', pattern: '^(?!https://approved\\.)' }, warn: 'Non-approved backend host.', require: { ack: 'I have operator approval for this target' } },
  ],
  generic: { names: { url: 'grafanaUrl' } },
};

test('readSettingsPolicyConfig: unset → nothing; a file → its document, the compiled policy and the resolved path; the legacy spelling; the modern name wins', () => {
  assert.equal(MCP_SETTINGS_POLICY_ENV, 'OBSERVOGRAM_MCP_SETTINGS_POLICY');
  assert.equal(MCP_ADMIN_PROXY_ENV, 'OBSERVOGRAM_MCP_ADMIN_PROXY');
  assert.deepEqual(readSettingsPolicyConfig({}), { policy: null, compiled: null, path: null });
  assert.deepEqual(readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: '  ' }), { policy: null, compiled: null, path: null });
  const r = readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: FIXTURE });
  assert.deepEqual(r.policy, FIXTURE_JSON);
  assert.equal(r.path, FIXTURE);
  assert.equal(r.compiled.version, 1);
  assert.deepEqual(r.compiled.rules.map((x) => [x.index, x.field, x.warn, x.ack]), [[0, 'grafanaUrl', 'Non-approved backend host.', 'I have operator approval for this target']]);
  assert.ok(Object.isFrozen(r.compiled));
  assert.equal(readSettingsPolicyConfig({ TOMOGRAPH_MCP_SETTINGS_POLICY: FIXTURE }).path, FIXTURE);
  const other = file('other.json', JSON.stringify(GENERIC));
  const both = readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: other, TOMOGRAPH_MCP_SETTINGS_POLICY: FIXTURE });
  assert.equal(both.path, other);
  assert.deepEqual(both.policy, GENERIC, 'the document as the file holds it');
  assert.deepEqual(both.compiled.generic, { path: '/configure', names: { url: 'grafanaUrl', user: 'user', secret: 'secret', apiKey: 'apiKey' }, auth: 'body' });
});

test('readSettingsPolicyConfig refuses a missing file, invalid JSON, an unknown key and an unbounded pattern with `OBSERVOGRAM_MCP_SETTINGS_POLICY: <path>: <reason>`, the first error and how many more', () => {
  const missing = join(TMP, 'nope.json');
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: missing }), (e) => e.message.startsWith(`OBSERVOGRAM_MCP_SETTINGS_POLICY: ${missing}: ENOENT`) && e.cause?.code === 'ENOENT');
  const broken = file('broken.json', '{ "version": 1, ');
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: broken }), (e) => e.message.startsWith(`OBSERVOGRAM_MCP_SETTINGS_POLICY: ${broken}: invalid JSON: `));
  const typo = file('typo.json', JSON.stringify({ version: 1, rules: [{ when: { field: 'grafanaUrl', pattren: '^x' }, warn: 'w' }] }));
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: typo }), { message: `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${typo}: rules[0].when: unknown key "pattren"` });
  const unanchored = file('unanchored.json', JSON.stringify({ version: 1, rules: [{ when: { field: 'grafanaUrl', pattern: 'evil' }, warn: 'w' }] }));
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: unanchored }), { message: `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${unanchored}: rules[0].when: pattern must be anchored (start with ^)` });
  const slow = file('slow.json', JSON.stringify({ version: 1, rules: [{ when: { field: 'u', pattern: '^https://.*.*.*\\.internal$' }, warn: 'w' }] }));
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: slow }), { message: `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${slow}: rules[0].when: pattern has more than one unbounded quantifier (*, + or {n,}), which a URL-length value can make slow` });
  const several = file('several.json', JSON.stringify({ version: 2, rules: [] }));
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: several }), { message: `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${several}: version must be 1 (got 2) (+1 more)` });
  const notObject = file('array.json', '[]');
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: notObject }), { message: `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${notObject}: the settings policy must be a JSON object` });
  // The legacy spelling is read, the modern name is the one every message spells.
  assert.throws(() => readSettingsPolicyConfig({ TOMOGRAPH_MCP_SETTINGS_POLICY: missing }), (e) => e.message.startsWith(`OBSERVOGRAM_MCP_SETTINGS_POLICY: ${missing}: ENOENT`));
});

test('a file that starts with a byte-order mark (Windows PowerShell 5) loads as the same document — one BOM, no more', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const bom = file('bom.json', `\uFEFF${text}`);
  assert.deepEqual(readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: bom }).policy, FIXTURE_JSON);
  const two = file('two-boms.json', `\uFEFF\uFEFF${text}`);
  assert.throws(() => readSettingsPolicyConfig({ OBSERVOGRAM_MCP_SETTINGS_POLICY: two }), (e) => e.message.startsWith(`OBSERVOGRAM_MCP_SETTINGS_POLICY: ${two}: invalid JSON: `));
});

test('unconfigured: GET /api/mcp-settings is { ok, proxy: false, policy: null, configured: false }, no-store, and the boot prints no policy line', async () => {
  const loud = boot(workspace(), { env: TOKEN, silent: false });
  assert.equal(loud.listening, true);
  assert.ok(!loud.stdout.includes('MCP settings policy') && !loud.stderr.includes('MCP settings policy'), 'nothing to say when nothing is configured');
  const s = await serve(workspace(), { env: TOKEN });
  try {
    const r = await getSettings(s.base);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, UNSET);
  } finally { await s.stop(); }
});

test('configured: the document is served as the file holds it, without its path, configured: true; the path and the rule count are logged once at start, never on a silent boot', async () => {
  const ws = workspace();
  const generic = file('generic.json', JSON.stringify(GENERIC));
  const loud = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_MCP_SETTINGS_POLICY: generic }, silent: false });
  assert.equal(loud.listening, true);
  assert.deepEqual(loud.stdout.split('\n').filter((l) => l.includes('MCP settings policy')), [`[studio] MCP settings policy: ${generic} (2 rules)`]);
  const quiet = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_MCP_SETTINGS_POLICY: generic } });
  assert.equal(quiet.listening, true);
  assert.ok(!quiet.stdout.includes('MCP settings policy') && !quiet.stderr.includes('MCP settings policy'));
  const s = await serve(ws, { env: { ...TOKEN, OBSERVOGRAM_MCP_SETTINGS_POLICY: generic }, verbose: true });
  try {
    const r = await getSettings(s.base);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.body, { ok: true, proxy: false, policy: GENERIC, configured: true });
    assert.ok(!JSON.stringify(r.body).includes(TMP), 'the path is not in the body');
    assert.deepEqual(s.logs().stdout.split('\n').filter((l) => l.includes('MCP settings policy')), [`[studio] MCP settings policy: ${generic} (2 rules)`], 'said once, at start — never per request');
  } finally { await s.stop(); }
  // The legacy spelling configures the same answer; one rule is "1 rule".
  const legacyLoud = boot(workspace(), { env: { ...TOKEN, TOMOGRAPH_MCP_SETTINGS_POLICY: FIXTURE }, silent: false });
  assert.deepEqual(legacyLoud.stdout.split('\n').filter((l) => l.includes('MCP settings policy')), [`[studio] MCP settings policy: ${FIXTURE} (1 rule)`]);
  const legacy = await serve(workspace(), { env: { ...TOKEN, TOMOGRAPH_MCP_SETTINGS_POLICY: FIXTURE } });
  try { assert.deepEqual((await getSettings(legacy.base)).body, { ok: true, proxy: false, policy: FIXTURE_JSON, configured: true }); }
  finally { await legacy.stop(); }
});

test('a missing file, invalid JSON, an unknown key or an unbounded pattern refuses the start, naming the variable, the path and the reason, before the store is touched; a BOM-led file boots', () => {
  const ws = workspace();
  const missing = join(TMP, 'boot-missing.json');
  const r1 = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_MCP_SETTINGS_POLICY: missing } });
  assert.equal(r1.listening, false);
  assert.ok(r1.message.startsWith(`OBSERVOGRAM_MCP_SETTINGS_POLICY: ${missing}: ENOENT`), r1.message);
  const broken = file('boot-broken.json', '{');
  const r2 = boot(ws, { env: { ...TOKEN, TOMOGRAPH_MCP_SETTINGS_POLICY: broken } });
  assert.equal(r2.listening, false);
  assert.ok(r2.message.startsWith(`OBSERVOGRAM_MCP_SETTINGS_POLICY: ${broken}: invalid JSON: `), 'the legacy spelling refuses with the modern name');
  const typo = file('boot-typo.json', JSON.stringify({ ...FIXTURE_JSON, rule: [] }));
  const r3 = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_MCP_SETTINGS_POLICY: typo } });
  assert.equal(r3.listening, false);
  assert.equal(r3.message, `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${typo}: the settings policy: unknown key "rule"`);
  const unanchored = file('boot-unanchored.json', JSON.stringify({ version: 1, rules: [{ when: { field: 'grafanaUrl', pattern: '(?!https://approved\\.)' }, warn: 'w' }] }));
  const r4 = boot(ws, { env: { ...TOKEN, OBSERVOGRAM_MCP_SETTINGS_POLICY: unanchored } });
  assert.equal(r4.listening, false);
  assert.equal(r4.message, `OBSERVOGRAM_MCP_SETTINGS_POLICY: ${unanchored}: rules[0].when: pattern must be anchored (start with ^)`);
  assert.throws(() => readFileSync(join(ws, 'observogram.db')), /ENOENT/, 'the store was never opened');
  const bom = file('boot-bom.json', `\uFEFF${readFileSync(FIXTURE, 'utf8')}`);
  assert.equal(boot(workspace(), { env: { ...TOKEN, OBSERVOGRAM_MCP_SETTINGS_POLICY: bom } }).listening, true);
});

test('the pass-through switch: GET /api/mcp-settings says proxy: true only for OBSERVOGRAM_MCP_ADMIN_PROXY=1 (TOMOGRAPH_ honoured), read per request', async () => {
  for (const [env, proxy] of [
    [{ OBSERVOGRAM_MCP_ADMIN_PROXY: '1' }, true],
    [{ TOMOGRAPH_MCP_ADMIN_PROXY: '1' }, true],
    [{ OBSERVOGRAM_MCP_ADMIN_PROXY: 'true' }, false],
    [{ OBSERVOGRAM_MCP_ADMIN_PROXY: '0' }, false],
  ]) {
    const s = await serve(workspace(), { env: { ...TOKEN, ...env, OBSERVOGRAM_MCP_SETTINGS_POLICY: FIXTURE } });
    try {
      const r = await getSettings(s.base);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, proxy, policy: FIXTURE_JSON, configured: true }, JSON.stringify(env));
    } finally { await s.stop(); }
  }
});

test('a child started without the variables never inherits the parent\'s policy or switch (serve-child STRIP, both spellings)', async () => {
  for (const name of ['MCP_SETTINGS_POLICY', 'MCP_ADMIN_PROXY']) assert.ok(STRIP.includes(name), `STRIP names ${name}`);
  const names = ['OBSERVOGRAM_MCP_SETTINGS_POLICY', 'TOMOGRAPH_MCP_SETTINGS_POLICY', 'OBSERVOGRAM_MCP_ADMIN_PROXY', 'TOMOGRAPH_MCP_ADMIN_PROXY'];
  process.env.OBSERVOGRAM_MCP_SETTINGS_POLICY = FIXTURE;
  process.env.TOMOGRAPH_MCP_SETTINGS_POLICY = FIXTURE;
  process.env.OBSERVOGRAM_MCP_ADMIN_PROXY = '1';
  process.env.TOMOGRAPH_MCP_ADMIN_PROXY = '1';
  let s;
  try {
    const env = childEnv(workspace(), TOKEN);
    for (const k of names) assert.ok(!(k in env), `childEnv strips ${k}`);
    s = await serve(workspace(), { env: TOKEN });
    assert.deepEqual((await getSettings(s.base)).body, UNSET);
  } finally {
    for (const k of names) delete process.env[k];
    if (s) await s.stop();
  }
});
