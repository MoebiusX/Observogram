#!/usr/bin/env node
/**
 * server/test-malformed-json.mjs — a request body the parsers refuse is
 * answered as JSON on every route, quoting none of it, logging nothing
 * (the follow-up malformed-json-app-wide; docs/DOWNSTREAM.md §16).
 *
 * The app-wide parsers run after authGate and orgContext and before every
 * route's authorize(); Express's default error path answered their errors
 * with an HTML page carrying the error's stack — for a malformed JSON body,
 * V8's message quotes a fragment of the body: an `mcpAuth`, a password —
 * and printed the same stack on stderr. server/index.mjs's bodyParserError
 * answers each one `{ ok: false, error }` with a fixed text and the
 * parser's status (400 not JSON, 413 too large — /api/*'s keeps its crawler
 * text —, 415 an unsupported charset), on every path.
 *
 * On two children — the token posture (the bearer, and anonymous) with the
 * MCP server-settings pass-through on, and stand-alone identity (anonymous,
 * an operator without and with the CSRF header) — every mutating route of
 * server/route-table.mjs is sent a malformed body holding a marker: the
 * answer is JSON, never holds the marker, and is either the refusal a
 * well-formed body gets (the caller was refused before the body was read:
 * authGate, or the pass-through's own authorize()) or the 400 — whichever
 * came first before the change, so no auth outcome moves. The marker is in
 * neither child's output.
 */

const { STRIP, serve, signIn } = await import('./fixtures/serve-child.mjs');
// Hermetic (§0): the shell never reaches this process's imports.
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { ROUTES } = await import('./route-table.mjs');

// Short enough that V8's syntax-error window quotes it whole.
const MARKER = 'MJ7sekrt';
const MALFORMED = `{"mcpAuth": ${MARKER}}`;
const NOT_JSON = Object.freeze({ ok: false, error: 'the request body is not valid JSON' });
const TOO_LARGE_API = 'Request body too large (cap 16MB). The crawler should filter to observability artefacts only — drop a large repo and the client will pre-classify; if you\'re hitting this you may have an in-flight build.';
const CSRF = Object.freeze({ 'X-Observogram-CSRF': '1' });
const TOKEN = 'malformed-json-bearer-0123456789';
const BEARER = Object.freeze({ Authorization: `Bearer ${TOKEN}` });
// Their own router runs authorize() before their own parser (M6 (b)).
const PASS_THROUGH = new Set(['POST /api/mcp-settings/describe', 'POST /api/mcp-settings/submit']);

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function workspace() {
  const d = mkdtempSync(join(tmpdir(), 'observogram-malformed-json-'));
  dirs.push(d);
  return d;
}

async function call(base, method, path, { headers = {}, body, type = 'application/json' } = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': type, Accept: 'application/json', ...headers }, body });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control'), text, json };
}

// Every mutating route, its parameters filled.
const MUTATING = Object.keys(ROUTES)
  .filter((k) => !/^(GET|HEAD) /.test(k))
  .map((key) => {
    const [method, pattern] = key.split(' ');
    return { key, method, path: pattern.replace(/:[A-Za-z]+/g, 'x'), cls: ROUTES[key].class };
  });

function clean(r, where) {
  assert.match(r.type, /^application\/json/, `${where}: JSON, not the parser's HTML page (${r.status} ${r.text.slice(0, 80)})`);
  assert.ok(!r.text.includes(MARKER), `${where}: the answer quotes the body: ${r.text}`);
  assert.equal(r.json?.ok, false, `${where}: the house shape`);
}

function notJson(r, where) {
  clean(r, where);
  assert.deepEqual([r.status, r.json], [400, NOT_JSON], where);
}

function nothingLogged(s) {
  const { stdout, stderr } = s.logs();
  assert.ok(!stdout.includes(MARKER) && !stderr.includes(MARKER), `the marker reached the server's output:\n${stderr}`);
  assert.ok(!/SyntaxError|PayloadTooLargeError|UnsupportedMediaTypeError/.test(stderr), `a parser error's stack on stderr:\n${stderr}`);
}

test('the token posture: a malformed body is a JSON 400 on POST /api/mcp/ping, the MCP endpoint and services writes and /auth/login; an oversize body a JSON 413, an unknown charset a JSON 415; none quotes the marker, none is logged', { timeout: 120_000 }, async () => {
  const s = await serve(workspace(), { env: { OBSERVOGRAM_API_TOKEN: TOKEN, OBSERVOGRAM_MCP_ADMIN_PROXY: '1' } });
  try {
    for (const [method, path] of [['POST', '/api/mcp/ping'], ['POST', '/api/mcp-endpoints'], ['PATCH', '/api/mcp-endpoints/x'], ['PATCH', '/api/services/x'], ['POST', '/api/services'], ['POST', '/auth/login']]) {
      const r = await call(s.base, method, path, { headers: BEARER, body: MALFORMED });
      notJson(r, `${method} ${path}`);
      assert.equal(r.cache, 'no-store', `${method} ${path}: no-store`);
    }
    // A body of another shape the parser still refuses: the fragment V8 would quote is the password.
    notJson(await call(s.base, 'POST', '/auth/login', { body: `{"username":"ada","password": ${MARKER}` }), 'POST /auth/login, an unterminated body');

    const big = `{"mcpAuth":"${MARKER}","pad":"${'x'.repeat(16 * 1024 * 1024)}"}`;
    let r = await call(s.base, 'POST', '/api/mcp/ping', { headers: BEARER, body: big });
    clean(r, 'POST /api/mcp/ping, oversize');
    assert.deepEqual([r.status, r.json], [413, { ok: false, error: TOO_LARGE_API }], '/api/*\'s 413 text, unchanged');
    r = await call(s.base, 'POST', '/auth/login', { body: big });
    clean(r, 'POST /auth/login, oversize');
    assert.deepEqual([r.status, r.json], [413, { ok: false, error: 'the request body is too large' }]);

    r = await call(s.base, 'POST', '/api/mcp/ping', { headers: BEARER, body: `{"mcpAuth":"${MARKER}"}`, type: 'application/json; charset=x-bogus' });
    clean(r, 'POST /api/mcp/ping, an unknown charset');
    assert.deepEqual([r.status, r.json], [415, { ok: false, error: 'the request body\'s charset is not supported' }]);

    // Every mutating route: the bearer reaches the parser on all but the pass-through (its authorize() first);
    // anonymous is refused by authGate on every /api mutation before the body is read, exactly as a well-formed body is.
    const bad = [];
    for (const rt of MUTATING) {
      for (const [who, headers] of [['bearer', BEARER], ['anonymous', {}]]) {
        const where = `${who} ${rt.method} ${rt.path}`;
        const m = await call(s.base, rt.method, rt.path, { headers, body: MALFORMED });
        try {
          clean(m, where);
          const refusedFirst = rt.path.startsWith('/api/') && (who === 'anonymous' || PASS_THROUGH.has(rt.key));
          if (refusedFirst) {
            const w = await call(s.base, rt.method, rt.path, { headers, body: '{}' });
            assert.ok([401, 403].includes(w.status) && w.json?.denied, `${where}: a well-formed body is refused (${w.status} ${w.text})`);
            assert.deepEqual([m.status, m.json], [w.status, w.json], `${where}: the refusal, unchanged`);
          } else {
            notJson(m, where);
          }
        } catch (e) { bad.push(e.message); }
      }
    }
    assert.deepEqual(bad, [], `${bad.length} cells`);
  } finally {
    await s.stop();
  }
  nothingLogged(s);
});

test('stand-alone identity: anonymous and an operator without the CSRF header keep authGate\'s refusal; an operator with it gets the 400 on every route its role is refused (the parser runs before authorize(), as before) — the pass-through refuses first; nothing quoted, nothing logged', { timeout: 120_000 }, async () => {
  const ADMIN_PW = 'malformed-admin-passw0rd';
  const s = await serve(workspace(), { env: { OBSERVOGRAM_ADMIN_PASSWORD: ADMIN_PW } });
  try {
    const admin = await signIn(s.base, 'admin', ADMIN_PW);
    assert.ok(admin.session, 'the seeded admin signs in');
    const created = await call(s.base, 'POST', '/api/admin/users', { headers: { Cookie: admin.session, ...CSRF }, body: JSON.stringify({ login: 'olga', password: 'olga-passw0rd-1' }) });
    assert.equal(created.status, 201, created.text);
    assert.deepEqual(created.json.joined, [{ orgId: 'default', role: 'operator' }]);
    const olga = await signIn(s.base, 'olga', 'olga-passw0rd-1');
    assert.ok(olga.session, `olga signs in: ${JSON.stringify(olga.json)}`);

    const bad = [];
    const variants = [['anonymous', {}], ['olga, no CSRF', { Cookie: olga.session }], ['olga + CSRF', { Cookie: olga.session, ...CSRF }]];
    for (const rt of MUTATING) {
      for (const [who, headers] of variants) {
        const where = `${who} ${rt.method} ${rt.path}`;
        try {
          const m = await call(s.base, rt.method, rt.path, { headers, body: MALFORMED });
          clean(m, where);
          if (!rt.path.startsWith('/api/')) { notJson(m, where); continue; }
          const roleRefused = rt.cls === 'admin' || rt.cls === 'owner';
          if (who === 'olga + CSRF' && !roleRefused) { notJson(m, where); continue; }
          const w = await call(s.base, rt.method, rt.path, { headers, body: '{}' });
          assert.ok([401, 403].includes(w.status) && w.json?.denied, `${where}: a well-formed body is refused (${w.status} ${w.text})`);
          if (who === 'olga + CSRF' && !PASS_THROUGH.has(rt.key)) notJson(m, `${where} (refused by authorize() after the parser)`);
          else assert.deepEqual([m.status, m.json], [w.status, w.json], `${where}: the refusal, unchanged`);
        } catch (e) { bad.push(e.message); }
      }
    }
    assert.deepEqual(bad, [], `${bad.length} cells`);
  } finally {
    await s.stop();
  }
  nothingLogged(s);
});
