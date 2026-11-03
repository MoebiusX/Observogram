#!/usr/bin/env node
/**
 * server/test-request-hardening.mjs — what an untrusted request or pack can
 * make the server hold or believe.
 *
 * - A pack's environment override is a dotted path into the spec. One whose
 *   segment names the prototype chain is refused by POST /api/validate,
 *   whichever environment the request selects, and the server's posture does
 *   not move: anonymous stays refused, an attacker-chosen bearer is no
 *   bearer, a viewer stays a viewer (tools/test-adapt.mjs pins the overlay's
 *   skip for a pack stored before the refusal, and that brandEnvFrom reads
 *   only the env's own variables).
 * - Request bodies: a caller the gate has not admitted to /api — the /auth/*
 *   forms, a non-API path, an anonymous read in the token posture — is read
 *   up to 64 KiB; the bearer and a session keep the 16 MB cap.
 * - The login damper's key holds at most a login's length (LOCAL_LOGIN_RE
 *   allows 64): names past that share a key, so fresh long usernames cannot
 *   grow its map.
 */

const { STRIP, serve, signIn } = await import('./fixtures/serve-child.mjs');
// Hermetic (§0): the shell never reaches this process's imports.
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { request } = await import('node:http');
const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');

const EXAMPLE = join(import.meta.dirname, '..', SPEC_DIR, 'examples', 'payment-service.pack.yaml');
const ADMIN_PW = 'hardening-admin-passw0rd';
const TOKEN = 'hardening-bearer-0123456789abcdef';
const CHOSEN = 'chosen-by-the-pack-0123456789';
const CSRF = Object.freeze({ 'X-Observogram-CSRF': '1' });
const TOO_LARGE = Object.freeze({ ok: false, error: 'the request body is too large' });

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function workspace() {
  const d = mkdtempSync(join(tmpdir(), 'observogram-request-hardening-'));
  dirs.push(d);
  return d;
}

// fetch() refuses a body on GET, so the raw request carries one (with its
// length: Node's client sends a GET's body without one, and the server would
// read none).
function send(base, method, path, { headers = {}, body = '' } = {}) {
  return new Promise((res, rej) => {
    const all = { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers };
    const r = request(base + path, { method, headers: all }, (resp) => {
      let text = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => { text += c; });
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        res({ status: resp.statusCode, text, json });
      });
    });
    r.on('error', rej);
    r.end(body);
  });
}

const padded = (bytes) => JSON.stringify({ username: 'ada', password: 'x', pad: 'p'.repeat(bytes) });

test('an environment override naming the prototype chain is refused at validation, and the posture does not move', { timeout: 120_000 }, async () => {
  const s = await serve(workspace(), { env: { OBSERVOGRAM_ADMIN_PASSWORD: ADMIN_PW } });
  try {
    const admin = await signIn(s.base, 'admin', ADMIN_PW);
    assert.ok(admin.session, 'the seeded admin signs in');
    const created = await send(s.base, 'POST', '/api/admin/users', { headers: { Cookie: admin.session, ...CSRF }, body: JSON.stringify({ login: 'vera', password: 'vera-passw0rd-1', role: 'viewer' }) });
    assert.equal(created.status, 201, created.text);
    const vera = await signIn(s.base, 'vera', 'vera-passw0rd-1');
    assert.ok(vera.session, 'the viewer signs in');

    const before = {
      anonymous: (await send(s.base, 'GET', '/api/admin/users')).status,
      chosen: (await send(s.base, 'GET', '/api/admin/users', { headers: { Authorization: `Bearer ${CHOSEN}` } })).status,
      viewer: (await send(s.base, 'POST', '/api/validate', { headers: { Cookie: vera.session, ...CSRF }, body: '{}' })).status,
    };
    assert.deepEqual(before, { anonymous: 401, chosen: 401, viewer: 403 });

    const pack = parseYaml(readFileSync(EXAMPLE, 'utf8'));
    Object.assign(pack.spec.environments.prod.overrides, {
      '__proto__.OBSERVOGRAM_AUTH': 'off',
      '__proto__.OBSERVOGRAM_API_TOKEN': CHOSEN,
      '__proto__.observogramBearer': true,
    });
    for (const query of ['', '?env=prod']) {
      const r = await send(s.base, 'POST', `/api/validate${query}`, { headers: { Cookie: admin.session, ...CSRF }, body: JSON.stringify(pack) });
      assert.equal(r.json?.ok, false, `validate${query}: refused (${r.text.slice(0, 200)})`);
      assert.equal(r.json.errors.length, 3, r.json.errors.join(' | '));
      assert.ok(r.json.errors.every((e) => e.startsWith('$.spec.environments.prod.overrides: key "__proto__.')), r.json.errors.join(' | '));
    }

    const afterwards = {
      anonymous: (await send(s.base, 'GET', '/api/admin/users')).status,
      chosen: (await send(s.base, 'GET', '/api/admin/users', { headers: { Authorization: `Bearer ${CHOSEN}` } })).status,
      viewer: (await send(s.base, 'POST', '/api/validate', { headers: { Cookie: vera.session, ...CSRF }, body: '{}' })).status,
    };
    assert.deepEqual(afterwards, before, 'nobody gained anything');
    const packs = await send(s.base, 'GET', '/api/packs', { headers: { Cookie: admin.session } });
    assert.ok(!packs.text.includes('OBSERVOGRAM_AUTH'), 'the refused pack was not registered');
  } finally {
    await s.stop();
  }
});

test('a caller the gate has not admitted to /api is read up to 64 KiB; the bearer and a session keep the 16 MB cap', { timeout: 120_000 }, async () => {
  const tokenPosture = await serve(workspace(), { env: { OBSERVOGRAM_API_TOKEN: TOKEN } });
  try {
    const { base } = tokenPosture;
    let r = await send(base, 'POST', '/auth/login', { body: padded(70 * 1024) });
    assert.deepEqual([r.status, r.json], [413, TOO_LARGE], 'anonymous /auth/login, 70 KiB');
    r = await send(base, 'POST', '/not-an-api-path', { body: padded(70 * 1024) });
    assert.deepEqual([r.status, r.json], [413, TOO_LARGE], 'anonymous non-API path, 70 KiB');
    r = await send(base, 'GET', '/api/packs', { body: padded(70 * 1024) });
    assert.equal(r.status, 413, `an anonymous read in the token posture, 70 KiB: ${r.text.slice(0, 120)}`);
    assert.match(r.json?.error ?? '', /\(cap 64KB\)/, 'the /api text names the cap it hit');
    r = await send(base, 'GET', '/api/packs', { body: padded(1024) });
    assert.equal(r.status, 200, 'an anonymous read with a small body is answered as before');
    r = await send(base, 'POST', '/auth/login', { body: padded(60 * 1024) });
    assert.notEqual(r.status, 413, 'under the cap, /auth/login reads the body');
    r = await send(base, 'POST', '/api/mcp/ping', { headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ pad: 'p'.repeat(2 * 1024 * 1024) }) });
    assert.notEqual(r.status, 413, `the bearer keeps the large cap: ${r.text.slice(0, 120)}`);
  } finally {
    await tokenPosture.stop();
  }

  const identity = await serve(workspace(), { env: { OBSERVOGRAM_ADMIN_PASSWORD: ADMIN_PW } });
  try {
    const admin = await signIn(identity.base, 'admin', ADMIN_PW);
    assert.ok(admin.session, 'the seeded admin signs in');
    const r = await send(identity.base, 'POST', '/api/validate', { headers: { Cookie: admin.session, ...CSRF }, body: JSON.stringify({ pad: 'p'.repeat(2 * 1024 * 1024) }) });
    assert.equal(r.status, 200, `a session keeps the large cap: ${r.text.slice(0, 120)}`);
    assert.equal(r.json?.ok, false, 'the body was read and validated');
  } finally {
    await identity.stop();
  }
});

test('the login damper keys at most a login\'s length: names past 64 characters share a key', { timeout: 60_000 }, async () => {
  const s = await serve(workspace(), { env: { OBSERVOGRAM_ADMIN_PASSWORD: ADMIN_PW } });
  try {
    const stem = 'u'.repeat(64);
    for (let i = 0; i < 5; i++) assert.equal((await signIn(s.base, `${stem}${i}`, 'guess')).status, 401, `failure ${i + 1}`);
    assert.equal((await signIn(s.base, `${stem}-another`, 'guess')).status, 429, 'a sixth name with the same 64-character stem is locked');
    assert.equal((await signIn(s.base, 'someone-else', 'guess')).status, 401, 'another name is not');
  } finally {
    await s.stop();
  }
});
