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
 *
 * The opt-in pass-through (POST /api/mcp-settings/describe and /submit,
 * OBSERVOGRAM_MCP_ADMIN_PROXY=1), against the fake MCP's admin surface, on
 * identity children (acme: ada admin, oscar operator): off → 404 before the
 * body is read; admin only (an operator, the bearer refused by class), a
 * typed URL an admin's; an mcpAuth and a malformed body refused without
 * quoting it (another route's malformed body the app-wide JSON 400); the path
 * is the server's (a described submit goes to the description's endpoint
 * whatever the caller says, a generic one only to the configured path);
 * describe and submit pass back no upstream text (the outcome shape only);
 * the allowlist, https and the studio's own address; a redirect, a
 * timeout and an oversize description refused naming the origin only; the
 * endpoint's read token never sent, the transport hook never used, the
 * exact request headers; the policy re-checked (409, then forwarded) in a
 * worker under a 100 ms deadline (server/mcp-settings-eval.mjs: a slow
 * pattern counts as matched and the server keeps answering); an
 * echoed secret redacted; one live.mcp-settings row without a value; the
 * secret in no log line, no store file and nothing under the workspace.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, serve, childEnv, signIn, STRIP } from './fixtures/serve-child.mjs';
import { startFakeMcp, registerMcpEndpoint, EXAMPLE_SETTINGS_DESCRIPTOR } from './fixtures/fake-mcp.mjs';

// Hermetic (§0): this process strips the children's list too, both spellings,
// before any server module loads (hence the dynamic import).
// server/test-hermetic-suites.mjs guards the shape.
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];
const { readSettingsPolicyConfig, MCP_SETTINGS_POLICY_ENV, MCP_ADMIN_PROXY_ENV } = await import('./mcp-settings-policy.mjs');
const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { evaluatePolicy, POLICY_EVAL_DEADLINE_MS } = await import('./mcp-settings-eval.mjs');
const { compileSettingsPolicy, genericDescriptor } = await import('../tools/lib/mcp-server-settings.mjs');

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

// ---------- the opt-in pass-through (OBSERVOGRAM_MCP_ADMIN_PROXY=1) ----------

const SECRET = 'S3cr3t-proxy-7f2c9a41b0';
const API_KEY = 'K3y-proxy-5e8d1c0a';
const READ_TOKEN = 'acme-read-token-NEVER-SENT-91';
const pw = (login) => `${login}-passw0rd-settings`;
const CSRF = { 'X-Observogram-CSRF': '1' };
const ACME = { 'X-Observogram-Org': 'acme' };
const DESCRIBE = '/api/mcp-settings/describe';
const SUBMIT = '/api/mcp-settings/submit';
// What Node's fetch adds on its own to every request; the rest is the proxy's.
const FETCH_OWN = new Set(['host', 'connection', 'accept-language', 'sec-fetch-mode', 'user-agent', 'accept-encoding', 'content-length']);
const FORBIDDEN = /^(origin|cookie|referer|x-observogram-.*|x-forwarded-.*|forwarded|x-hook)$/;
// The SPEC's description with the API key as a bearer, at an endpoint other than /configure.
const BEARER_DESCRIPTOR = { ...EXAMPLE_SETTINGS_DESCRIPTOR, endpoint: '/apply', auth: { field: 'apiKey', scheme: 'bearer' }, actions: [{ name: 'disable', label: 'Clear server credential', endpoint: '/apply' }] };

const fakes = [];
const children = [];
after(async () => {
  for (const c of children) await c.stop();
  for (const f of fakes) await f.close();
});
async function fakeMcp(admin) {
  const f = await startFakeMcp(['zz_tool'], null, { admin });
  fakes.push(f);
  return f;
}

// An identity child — acme { ada: admin, oscar: operator } — with the pass-through on unless `env` says otherwise.
async function studio(env = {}) {
  const ws = workspace();
  mkdirSync(ws, { recursive: true });
  writeUsersFile({ users: Object.fromEntries(['ada', 'oscar'].map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(ws, 'users.json'));
  writeOrgsFile({ default: { name: 'Default', members: { ada: 'admin' } }, acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator' } } }, join(ws, 'orgs.json'));
  const s = await serve(ws, { env: { ...TOKEN, OBSERVOGRAM_MCP_ADMIN_PROXY: '1', OBSERVOGRAM_ORG_ACME_MCP_TOKEN: READ_TOKEN, ...env } });
  children.push(s);
  const cookies = {};
  for (const login of ['ada', 'oscar']) {
    const r = await signIn(s.base, login, pw(login));
    assert.equal(r.status, 200, `${login} signs in`);
    cookies[login] = r.session;
  }
  const headers = (who) => (who === 'bearer' ? { Authorization: `Bearer ${TOKEN.OBSERVOGRAM_API_TOKEN}`, ...ACME } : { Cookie: cookies[who], ...CSRF, ...ACME });
  const post = async (path, body, { who = 'ada', raw = null, extra = {} } = {}) => {
    const r = await fetch(`${s.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(who), ...extra }, body: raw ?? JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text, type: r.headers.get('content-type') ?? '', cache: r.headers.get('cache-control'), nosniff: r.headers.get('x-content-type-options') };
  };
  const register = async (url, extra = {}) => {
    const r = await registerMcpEndpoint(s.base, { name: `mcp-${++n}`, url, ...extra }, { headers: headers('ada') });
    assert.equal(r.status, 201, r.text);
    return r.id;
  };
  const audit = async () => (await (await fetch(`${s.base}/api/audit?limit=100`, { headers: headers('ada') })).json()).rows ?? [];
  return { ...s, ws, headers, post, register, audit };
}

// Every file under `dir` as bytes.
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else out.push([p, readFileSync(p)]);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
function assertNowhere(s, values) {
  const logs = s.logs();
  for (const v of values) {
    assert.ok(!logs.stdout.includes(v) && !logs.stderr.includes(v), 'no value in the server\'s output');
    for (const [p, bytes] of filesUnder(s.ws)) {
      assert.ok(!bytes.includes(Buffer.from(v, 'utf8')) && !bytes.includes(Buffer.from(v, 'utf16le')), `no value in ${p}`);
    }
  }
}
const headerNames = (r) => Object.keys(r.headers).filter((k) => !FETCH_OWN.has(k)).sort();

test('the pass-through off (the default): both POSTs answer 404 denied off, before the body is read — a malformed one too — and nothing reaches the MCP server', async () => {
  const f = await fakeMcp({ cors: false });
  const s = await studio({ OBSERVOGRAM_MCP_ADMIN_PROXY: undefined });
  const id = await s.register(f.url);
  const off = 'the MCP server-settings proxy is off — the browser talks to the MCP server directly; the server\'s operator sets OBSERVOGRAM_MCP_ADMIN_PROXY=1 to pass settings through the studio server';
  for (const path of [DESCRIBE, SUBMIT]) {
    const r = await s.post(path, { mcpEndpointId: id, mode: 'described', values: { secret: SECRET } });
    assert.deepEqual([r.status, r.json], [404, { ok: false, denied: 'off', error: off }], path);
    const bad = await s.post(path, null, { raw: `{"secret":"${SECRET}"` });
    assert.deepEqual([bad.status, bad.json?.denied], [404, 'off'], `${path}: malformed, still off`);
  }
  assert.deepEqual(f.adminRequests, []);
  assert.equal((await (await fetch(`${s.base}/api/mcp-settings`, { headers: s.headers('ada') })).json()).proxy, false);
  assertNowhere(s, [SECRET]);
});

test('describe by id as an admin: the validated description re-serialised, no-store and nosniff; GET <root>/admin/schema with Accept only — no token although the endpoint names a read-token variable, no Origin, no cookie; one [mcp-settings] line', async () => {
  const f = await fakeMcp({ descriptor: BEARER_DESCRIPTOR });
  const s = await studio();
  const id = await s.register(f.url, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' });
  const r = await s.post(DESCRIBE, { mcpEndpointId: id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ['ok', 'status', 'descriptor']);
  assert.equal(r.json.status, 200);
  assert.deepEqual(r.json.descriptor.fields.map((x) => [x.name, x.type]), [['grafanaUrl', 'url'], ['user', 'text'], ['secret', 'secret'], ['apiKey', 'secret']]);
  assert.deepEqual([r.json.descriptor.endpoint, r.json.descriptor.auth], ['/apply', { field: 'apiKey', scheme: 'bearer' }]);
  assert.equal(r.cache, 'no-store');
  assert.equal(r.nosniff, 'nosniff');
  assert.equal(f.adminRequests.length, 1);
  const [g] = f.adminRequests;
  assert.deepEqual([g.method, g.path, g.origin], ['GET', '/admin/schema', null]);
  assert.deepEqual(headerNames(g), ['accept']);
  assert.equal(g.headers.accept, 'application/json');
  assert.ok(!JSON.stringify(f.authHeaders).includes(READ_TOKEN), 'the read token never left');
  assert.match(s.logs().stderr, /^\[mcp-settings\] describe 200 \d+ms$/m);
});

test('who may: an operator and the bearer are refused by class, a typed URL is an admin\'s, an mcpAuth is refused, the CSRF header is required — nothing reaches the MCP server but the admin\'s own requests', async () => {
  const f = await fakeMcp({});
  const s = await studio();
  const id = await s.register(f.url);
  const oscar = await s.post(DESCRIBE, { mcpEndpointId: id }, { who: 'oscar' });
  assert.deepEqual([oscar.status, oscar.json.denied, oscar.json.error], [403, 'role', "requires the admin role in org 'acme' (you are operator) — ask an admin of acme"]);
  const bearer = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', values: {} }, { who: 'bearer' });
  assert.deepEqual([bearer.status, bearer.json.denied], [403, 'role']);
  const noCsrf = await fetch(`${s.base}${DESCRIBE}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: s.headers('ada').Cookie, ...ACME }, body: JSON.stringify({ mcpEndpointId: id }) });
  assert.deepEqual([noCsrf.status, (await noCsrf.json()).denied], [403, 'csrf']);
  const auth = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', values: {}, mcpAuth: 'tok' });
  assert.deepEqual([auth.status, auth.json.error], [400, 'the server-settings proxy sends no MCP token — a server API key goes in the descriptor\'s own field']);
  assert.deepEqual(f.adminRequests, []);
  const typed = await s.post(DESCRIBE, { mcpUrl: f.url });
  assert.deepEqual([typed.status, Object.keys(typed.json)], [200, ['ok', 'status', 'descriptor']], typed.text);
  assert.equal(f.adminRequests.length, 1);
});

test('a malformed body holding the secret is a 400 that quotes none of it, nothing logged; a body over 64 KiB is a 400; another route\'s malformed body is the app-wide handler\'s JSON 400, the same text', async () => {
  const f = await fakeMcp({});
  const s = await studio();
  for (const path of [DESCRIBE, SUBMIT]) {
    const r = await s.post(path, null, { raw: `{"mcpUrl":"${f.url}","values":{"secret":"${SECRET}"` });
    assert.deepEqual([r.status, r.json], [400, { ok: false, error: 'the request body is not valid JSON' }], path);
    assert.match(r.type, /^application\/json/);
    assert.ok(!r.text.includes(SECRET));
    const big = await s.post(path, { mcpUrl: f.url, mode: 'generic', values: { secret: 'x'.repeat(70_000) } });
    assert.deepEqual([big.status, big.json], [400, { ok: false, error: 'the request body is larger than 64 KiB' }], path);
  }
  const other = await s.post('/api/mcp/ping', null, { raw: `{"mcpUrl":"${f.url}","mcpAuth":"not-json` });
  assert.deepEqual([other.status, other.json], [400, { ok: false, error: 'the request body is not valid JSON' }]);
  assert.match(other.type, /^application\/json/, 'the app-wide handler\'s answer (malformed-json-app-wide; server/test-malformed-json.mjs)');
  assert.deepEqual(f.adminRequests, []);
  assertNowhere(s, [SECRET]);
});

test('a described submit sends to the description\'s endpoint — not the caller\'s path — with exactly Content-Type, Accept and the description\'s Authorization; the answer is the outcome shape; one live.mcp-settings row: names and indexes, never a value', async () => {
  const f = await fakeMcp({ descriptor: BEARER_DESCRIPTOR });
  const s = await studio();
  const id = await s.register(f.url, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' });
  const r = await s.post(SUBMIT, {
    mcpEndpointId: id, mode: 'described', generic: { path: '/evil', names: {}, auth: 'body' },
    values: { grafanaUrl: 'HTTPS://Backend.Example/', user: 'svc', secret: SECRET, apiKey: API_KEY, endpoint: '/evil' }, acks: [],
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json), ['ok', 'status', 'contentType', 'bytes', 'outcome', 'redacted']);
  assert.deepEqual(r.json.outcome, {
    ok: true, message: 'Settings applied.',
    checks: [{ label: 'Identity', status: 'pass', detail: 'the backend accepted the credential' }, { label: 'Toolset', status: 'pass', detail: 'every tool answered' }],
  });
  assert.deepEqual([r.json.status, r.json.contentType, r.json.redacted, r.json.bytes > 0], [200, 'application/json', 0, true]);
  const posts = f.adminRequests.filter((x) => x.method === 'POST');
  assert.deepEqual(f.adminRequests.map((x) => `${x.method} ${x.path}`), ['GET /admin/schema', 'POST /apply'], 'the description read again, then its endpoint');
  assert.deepEqual(headerNames(posts[0]), ['accept', 'authorization', 'content-type']);
  assert.equal(posts[0].headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(posts[0].headers['content-type'], 'application/json');
  assert.equal(posts[0].origin, null);
  assert.deepEqual(posts[0].body, { grafanaUrl: 'https://backend.example/', user: 'svc', secret: SECRET });
  assert.ok(!Object.keys(posts[0].headers).some((k) => FORBIDDEN.test(k)));
  assert.ok(!JSON.stringify(f.authHeaders).includes(READ_TOKEN));
  assert.equal(f.adminConfigured(), true);
  const rows = (await s.audit()).filter((x) => x.action === 'live.mcp-settings');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].actor, rows[0].targetKind, rows[0].targetId], ['ada', 'live', f.origin]);
  assert.deepEqual(rows[0].detail, { op: 'configure', path: '/apply', endpointId: id, typed: false, status: 200, fields: ['grafanaUrl', 'user', 'secret', 'apiKey'], acks: [] });
  assert.match(s.logs().stderr, /^\[mcp-settings\] submit 200 \d+ms$/m);
  // A declared action: its endpoint, `{ action }` plus what it carries (the auth field, as the header).
  const a = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', action: 'disable', values: { apiKey: API_KEY } });
  assert.deepEqual([a.status, a.json.outcome.message], [200, 'The server forgot the backend credential.'], a.text);
  const last = f.adminRequests.at(-1);
  assert.deepEqual([last.path, last.body, last.headers.authorization], ['/apply', { action: 'disable' }, `Bearer ${API_KEY}`]);
  assert.equal(f.adminConfigured(), false);
  assert.match(s.logs().stderr, /^\[mcp-settings\] action:disable 200 \d+ms$/m);
  assertNowhere(s, [SECRET, API_KEY]);
});

test('the generic form goes only to the configured path (/configure here), every field in the body; any other path is a 400 naming the way, nothing sent; a description that no longer parses is a 409', async () => {
  const f = await fakeMcp({ descriptor: null });
  const s = await studio();
  // The endpoint holds a read token: a configure never carries it (forWrite), so the body-auth POST has no Authorization.
  const id = await s.register(f.url, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' });
  const d = await s.post(DESCRIBE, { mcpEndpointId: id });
  assert.deepEqual(d.json, { ok: true, status: 404 });
  const wrong = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'generic', generic: { path: '/admin/other', names: {}, auth: 'body' }, values: { url: 'https://b.example', secret: SECRET } });
  assert.deepEqual([wrong.status, wrong.json], [400, { ok: false, denied: 'path', error: 'the proxy sends a generic form only to /configure — a downstream sets another in the settings policy\'s generic.path' }]);
  assert.deepEqual(f.adminRequests.map((x) => x.method), ['GET']);
  const ok = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'generic', generic: { path: '/configure', names: { url: 'url', user: 'user', secret: 'secret', apiKey: 'apiKey' }, auth: 'body' }, values: { url: 'https://b.example', secret: SECRET, apiKey: API_KEY } });
  assert.equal(ok.status, 200, ok.text);
  const post = f.adminRequests.at(-1);
  assert.deepEqual([post.method, post.path, post.body, post.headers.authorization], ['POST', '/configure', { url: 'https://b.example/', secret: SECRET, apiKey: API_KEY }, undefined]);
  assert.ok(!JSON.stringify(post.headers).includes(READ_TOKEN), 'the endpoint\'s read token never rides a configure');
  const described = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', values: { url: 'https://b.example' } });
  assert.deepEqual([described.status, described.json.denied, described.json.error], [409, 'descriptor', 'the server\'s settings description does not read as one now (GET /admin/schema answered 404) — close and reopen the server settings']);
  assert.equal(f.adminRequests.filter((x) => x.method === 'POST').length, 1, 'nothing sent for the 409');
  assertNowhere(s, [SECRET, API_KEY]);
});

test('no upstream text passes back: a non-description is named, not quoted; an HTML 500 is outcome null with its status, type and size; an echoed secret is redacted in the outcome', async () => {
  const f = await fakeMcp({ descriptor: 'not-json', outcome: (body) => (body.secret === 'html' ? { status: 500, text: `<html><body>stack trace near ${body.apiKey}</body></html>`, contentType: 'text/html' } : { status: 400, json: { ok: false, message: `the backend refused ${body.secret}`, checks: [{ label: 'Identity', status: 'fail', detail: `token=${body.secret}` }] } }) });
  const s = await studio();
  const id = await s.register(f.url);
  const d = await s.post(DESCRIBE, { mcpEndpointId: id });
  assert.deepEqual(d.json, { ok: true, status: 200, notDescriptor: 'text/plain, not JSON' });
  assert.ok(!d.text.includes('This server has no settings description'));
  const html = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'generic', values: { url: 'https://b.example', secret: 'html', apiKey: API_KEY } });
  assert.equal(html.status, 200, html.text);
  assert.deepEqual([html.json.status, html.json.contentType, html.json.outcome], [500, 'text/html', null]);
  assert.ok(html.json.redacted >= 1, 'the echoed API key counted, though no body passes back');
  assert.ok(!html.text.includes('stack trace') && !html.text.includes(API_KEY));
  const echo = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'generic', values: { url: 'https://b.example', secret: SECRET } });
  assert.equal(echo.json.status, 400);
  assert.deepEqual(echo.json.outcome, { ok: false, message: 'the backend refused <redacted>', checks: [{ label: 'Identity', status: 'fail', detail: 'token=<redacted>' }] });
  assert.ok(echo.json.redacted >= 2);
  assert.ok(!echo.text.includes(SECRET));
  assertNowhere(s, [SECRET, API_KEY]);
});

test('the target rules: an unlisted remote origin gets no credential, a plain-http remote is refused, the studio\'s own address is refused — nothing is sent', async () => {
  const s = await studio({ OBSERVOGRAM_MCP_ORIGINS: 'http://plain.mcp.test' });
  const plain = await s.register('http://plain.mcp.test/mcp');
  const r1 = await s.post(DESCRIBE, { mcpEndpointId: plain });
  assert.deepEqual([r1.status, r1.json.denied, r1.json.error], [403, 'target', 'http://plain.mcp.test is plain http, and settings carry a credential across the network — serve the MCP server over https, or run it on this machine']);
  const own = await s.post(DESCRIBE, { mcpUrl: `${s.base}/mcp` });
  assert.deepEqual([own.status, own.json.denied, own.json.error], [403, 'target', `the MCP server shares the studio's origin (${s.base}), so its settings would go to the studio server — give the MCP server its own origin (another port or host)`]);
  const t = await studio();
  const unlisted = await t.register('https://unlisted.mcp.test/mcp');
  const r2 = await t.post(SUBMIT, { mcpEndpointId: unlisted, mode: 'generic', values: { url: 'https://b.example', secret: SECRET } });
  assert.deepEqual([r2.status, r2.json.denied, r2.json.error], [403, 'origin', 'https://unlisted.mcp.test is not a listed MCP origin, and settings carry a credential, which goes only to a listed origin or this machine — the server\'s operator adds https://unlisted.mcp.test to OBSERVOGRAM_MCP_ORIGINS (or the org\'s OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS)']);
  assert.ok(!/\[mcp-settings\]/.test(s.logs().stderr + t.logs().stderr), 'no request left');
});

test('a redirect is refused naming its origin only (the sink receives nothing), an oversize description is refused, and a configure that never answers is a 502 after 10 s that says it may have applied', { timeout: 60_000 }, async () => {
  const redirect = await fakeMcp({ descriptorStatus: 302 });
  const s = await studio();
  const r = await s.post(DESCRIBE, { mcpUrl: redirect.url });
  assert.deepEqual([r.status, r.json], [502, { ok: false, error: `the MCP server at ${redirect.origin} answered with a redirect to ${redirect.sink.origin} — the studio server never follows redirects; configure the MCP endpoint's final URL` }]);
  assert.deepEqual(redirect.sink.requests, []);
  const configure307 = await fakeMcp({ descriptor: null, configureStatus: 307 });
  const r307 = await s.post(SUBMIT, { mcpUrl: configure307.url, mode: 'generic', values: { url: 'https://b.example', secret: SECRET } });
  assert.equal(r307.status, 502);
  assert.ok(r307.json.error.startsWith(`the MCP server at ${configure307.origin} answered with a redirect to ${configure307.sink.origin} —`), r307.json.error);
  assert.deepEqual(configure307.sink.requests, []);
  const big = await fakeMcp({ descriptor: { ...EXAMPLE_SETTINGS_DESCRIPTOR, padding: 'x'.repeat(17_000) } });
  const rb = await s.post(DESCRIBE, { mcpUrl: big.url });
  assert.deepEqual([rb.status, rb.json.error], [502, `the MCP server at ${big.origin} answered with a settings description larger than 16 KiB`]);
  const held = await fakeMcp({ descriptor: null, holdAnswer: true });
  const t0 = Date.now();
  const rh = await s.post(SUBMIT, { mcpUrl: held.url, mode: 'generic', values: { url: 'https://b.example', secret: SECRET } });
  assert.ok(Date.now() - t0 >= 9_500);
  assert.deepEqual([rh.status, rh.json.error], [502, `the MCP server at ${held.origin} did not answer within 10 s — the server may have applied the settings: test the connection, or check the server's log`]);
  assert.equal(held.adminConfigured(), true, 'it did apply them');
  assert.match(s.logs().stderr, /^\[mcp-settings\] submit timeout \d+ms$/m);
  const row = (await s.audit()).find((x) => x.action === 'live.mcp-settings' && x.targetId === held.origin);
  assert.equal(row.detail.status, null, 'the row says no answer came');
  assertNowhere(s, [SECRET]);
});

test('a loaded transport hook is never used: its record stays empty and the MCP server never sees its header', async () => {
  const record = join(TMP, `hook-record-${++n}.txt`);
  const hook = file(`hook-${n}.mjs`, [
    "import { appendFileSync } from 'node:fs';",
    `export function prepareRequest({ url, headers }) { appendFileSync(${JSON.stringify(record)}, 'prepare ' + url + '\\n'); return { url, headers: { ...headers, 'X-Hook': 'gateway-credential' } }; }`,
    `export async function fetchImpl(url, init) { appendFileSync(${JSON.stringify(record)}, 'fetch ' + url + '\\n'); return fetch(url, init); }`,
    '',
  ].join('\n'));
  const f = await fakeMcp({ descriptor: BEARER_DESCRIPTOR });
  const s = await studio({ OBSERVOGRAM_TRANSPORT_HOOK: hook });
  const id = await s.register(f.url);
  assert.equal((await s.post(DESCRIBE, { mcpEndpointId: id })).status, 200);
  const r = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', values: { grafanaUrl: 'https://b.example', apiKey: API_KEY } });
  assert.equal(r.status, 200, r.text);
  assert.equal(f.adminRequests.length, 3);
  assert.ok(f.adminRequests.every((x) => !('x-hook' in x.headers)), 'the hook\'s header never arrived');
  assert.equal(existsSync(record) ? readFileSync(record, 'utf8') : '', '', 'the hook saw nothing');
});

test('the settings policy is re-checked against the description the server read: a missing acknowledgement is a 409 naming it, nothing sent; ticked, the configure goes and the row records the index; on the generic form a rule keyed to an absent field still wants its ack', async () => {
  const f = await fakeMcp({ descriptor: EXAMPLE_SETTINGS_DESCRIPTOR });
  const s = await studio({ OBSERVOGRAM_MCP_SETTINGS_POLICY: FIXTURE });
  const id = await s.register(f.url);
  const values = { grafanaUrl: 'https://evil.example/', secret: SECRET };
  const want = [409, 'policy-ack', 0, 'Non-approved backend host. — tick "I have operator approval for this target" in the server settings'];
  const r1 = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', values, acks: [] });
  assert.deepEqual([r1.status, r1.json.denied, r1.json.rule, r1.json.error], want);
  assert.equal(f.adminRequests.filter((x) => x.method === 'POST').length, 0);
  const approved = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', values: { grafanaUrl: 'HTTPS://Approved.example/', secret: SECRET } });
  assert.equal(approved.status, 200, 'an approved host needs no ack');
  const r2 = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'described', values, acks: [0] });
  assert.equal(r2.status, 200, r2.text);
  const rows = (await s.audit()).filter((x) => x.action === 'live.mcp-settings');
  assert.deepEqual(rows.map((x) => x.detail.acks), [[0], []], 'newest first: the acknowledged index, then none');
  const g1 = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'generic', values: { url: 'https://approved.example/', secret: SECRET } });
  assert.deepEqual([g1.status, g1.json.denied, g1.json.rule], [409, 'policy-ack', 0], 'unevaluated: its field is absent, so its ack is required');
  const g2 = await s.post(SUBMIT, { mcpEndpointId: id, mode: 'generic', values: { url: 'https://approved.example/', secret: SECRET }, acks: [0] });
  assert.equal(g2.status, 200, g2.text);
  assertNowhere(s, [SECRET]);
});

// A slow part followed by what a probe's last character satisfies: compiles
// in milliseconds, backtracks for minutes on a long underscore run.
const BANG = '^.*_{0,60}_{0,60}_{0,60}_{0,60}!$';

test('evaluatePolicy: a rule that does not finish within the deadline counts as matched, its warn and ack apply; a fast rule before it is evaluated as written; one line names the rule, never the value', async (t) => {
  assert.equal(POLICY_EVAL_DEADLINE_MS, 100);
  const { policy, errors } = compileSettingsPolicy({ version: 1, rules: [
    { when: { field: 'url', pattern: '^https://slow\\.example/' }, warn: 'Fast match.', require: { ack: 'ack 0' } },
    { when: { field: 'user', pattern: '^root$' }, warn: 'Fast miss.' },
    { when: { type: 'url', pattern: BANG }, warn: 'Slow pattern.', require: { ack: 'ack 2' } },
  ] });
  assert.deepEqual(errors, [], 'the shape checks admit the slow pattern');
  const d = genericDescriptor();
  const value = `https://slow.example/${'_'.repeat(400)}`;
  const lines = [];
  const t0 = Date.now();
  const out = await evaluatePolicy(policy, d, { url: value, user: 'bob' }, { log: (l) => lines.push(l) });
  const tookMs = Date.now() - t0;
  t.diagnostic(`bound: evaluatePolicy answers within the deadline plus a worker start: ${tookMs} ms < 2000 ms`);
  assert.ok(tookMs < 2000, `answered within the deadline plus a worker start (${tookMs} ms)`);
  assert.deepEqual(out.timedOut, [2]);
  assert.deepEqual(out.findings.map((f) => [f.rule, f.field, f.ack, f.timedOut === true]), [[0, 'url', 'ack 0', false], [2, 'url', 'ack 2', true]]);
  assert.equal(out.findings[1].note, 'Policy rule 3 did not finish within 100 ms, so it counts as matched');
  assert.deepEqual(lines, ['[mcp-settings] policy rules[2] did not finish within 100 ms — counted as matched']);
  // All fast: exactly policyFindings' answer, nothing logged.
  const fast = await evaluatePolicy(policy, d, { url: 'https://slow.example/a', user: 'root' }, { log: (l) => lines.push(l) });
  assert.deepEqual(fast.timedOut, []);
  assert.deepEqual(fast.findings.map((f) => [f.rule, f.field, f.ack]), [[0, 'url', 'ack 0'], [1, 'user', null]]);
  assert.equal(lines.length, 1);
  assert.deepEqual(await evaluatePolicy(null, d, { url: value }), { findings: [], timedOut: [] });
});

test('a slow policy pattern costs its acknowledgement, never the server: the submit is a 409 within 2 s naming the rule, the server answers meanwhile, with the ack the configure goes; the log names the rule, never the value', { timeout: 30_000 }, async (t) => {
  const f = await fakeMcp({ descriptor: null });
  const policyFile = file('policy-slow.json', JSON.stringify({ version: 1, rules: [{ when: { type: 'url', pattern: BANG }, warn: 'Unreviewed backend.', require: { ack: 'I reviewed the backend' } }] }));
  const s = await studio({ OBSERVOGRAM_MCP_SETTINGS_POLICY: policyFile });
  const id = await s.register(f.url);
  const value = `https://slow.example/${'_'.repeat(480)}`;
  const body = (acks) => ({ mcpEndpointId: id, mode: 'generic', values: { url: value, secret: SECRET }, acks });
  const t0 = Date.now();
  const pending = s.post(SUBMIT, body([]));
  const g0 = Date.now();
  const r = await fetch(`${s.base}/api/mcp-settings`, { headers: s.headers('ada'), signal: AbortSignal.timeout(5000) });
  assert.equal(r.status, 200);
  const otherMs = Date.now() - g0;
  t.diagnostic(`bound: another request answers while the submit is checked: ${otherMs} ms < 1500 ms`);
  assert.ok(otherMs < 1500, `another request answers while the submit is checked (${otherMs} ms)`);
  const r1 = await pending;
  const submitMs = Date.now() - t0;
  t.diagnostic(`bound: the submit answers within 2 s: ${submitMs} ms < 2000 ms`);
  assert.ok(submitMs < 2000, `the submit answers within 2 s (${submitMs} ms)`);
  assert.deepEqual([r1.status, r1.json.denied, r1.json.rule, r1.json.error], [409, 'policy-ack', 0, 'Unreviewed backend. — tick "I reviewed the backend" in the server settings']);
  assert.ok(!r1.text.includes('_'.repeat(20)), 'the answer never echoes the value');
  assert.equal(f.adminRequests.filter((x) => x.method === 'POST').length, 0, 'nothing sent');
  const r2 = await s.post(SUBMIT, body([0]));
  assert.equal(r2.status, 200, r2.text);
  assert.equal(f.adminRequests.filter((x) => x.method === 'POST').length, 1, 'acknowledged, the configure goes');
  const lines = s.logs().stderr.split('\n').filter((l) => l.includes('did not finish'));
  assert.deepEqual(lines, Array(2).fill('[mcp-settings] policy rules[0] did not finish within 100 ms — counted as matched'));
  assertNowhere(s, [SECRET, value, '_'.repeat(60)]);
});

test('without sign-in (open loopback): the anonymous local caller describes and submits by id from this machine; a typed URL stays refused by kind', async () => {
  const f = await fakeMcp({ descriptor: null });
  const ws = workspace();
  const s = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_MCP_ADMIN_PROXY: '1' } });
  children.push(s);
  const reg = await registerMcpEndpoint(s.base, { name: 'local-mcp', url: f.url });
  assert.equal(reg.status, 201, reg.text);
  const post = async (path, body) => {
    const r = await fetch(`${s.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...CSRF }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  assert.deepEqual((await post(DESCRIBE, { mcpEndpointId: reg.id })).json, { ok: true, status: 404 });
  const sub = await post(SUBMIT, { mcpEndpointId: reg.id, mode: 'generic', values: { url: 'https://b.example', secret: SECRET } });
  assert.equal(sub.status, 200);
  const typed = await post(DESCRIBE, { mcpUrl: f.url });
  assert.deepEqual([typed.status, typed.json.denied], [403, 'posture']);
  assert.match(typed.json.error, /^a typed MCP URL is refused on a server without sign-in, even from this machine/);
});
