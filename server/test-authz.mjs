#!/usr/bin/env node
/**
 * server/test-authz.mjs — roles enforced (docs/STORE_PLAN.md slice 3, §5
 * postures, roles and the route table; §8 gate AuthZ matrix).
 *
 * - the posture function, and the principal the org middleware stamps on
 *   a request (server/authz.mjs orgContext), called in-process with a fake
 *   request on a temp store — the session's role is the membership of the
 *   CONTEXT org, never the first one;
 * - the studio guards: every fetch() sends authHeaders(), every navigation
 *   to /api names the org with orgQuery().
 */

// Hermetic (§0): a developer shell's store or identity variables never
// reach this process's own imports.
const STRIP = [
  'DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH', 'WORKSPACE', 'USERS_FILE',
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URL', 'OIDC_ALLOW_HTTP', 'OIDC_SECURE_COOKIES',
  'SESSION_SECRET', 'API_TOKEN', 'API_TOKEN_LABEL', 'AUTH',
];
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-authz-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;

const { postureOf, listenOf, orgContext } = await import('./authz.mjs');
const { openStore, closeStore } = await import('./store/db.mjs');
const { createUser } = await import('./store/users.mjs');
const { createOrg } = await import('./store/orgs.mjs');
const { addMembership } = await import('./store/memberships.mjs');
const { ensureDefaultOrg } = await import('./store/identity.mjs');
const { currentOrg } = await import('./tenancy.mjs');

after(() => {
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

// A value for the env variables a case sets, restored afterwards.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---------- postures ----------

test('postureOf: identity wins, then the token, then the bind', () => {
  const rows = [
    [{ identity: true, token: true, loopback: true }, 'identity'],
    [{ identity: true, token: false, loopback: false }, 'identity'],
    [{ identity: false, token: true, loopback: true }, 'token'],
    [{ identity: false, token: true, loopback: false }, 'token'],
    [{ identity: false, token: false, loopback: true }, 'open-loopback'],
    [{ identity: false, token: false, loopback: false }, 'open-exposed'],
  ];
  for (const [input, want] of rows) assert.equal(postureOf(input), want, JSON.stringify(input));
});

test('listenOf: the server\'s stamp, else exposed (fail closed)', () => {
  const listen = Object.freeze({ host: '127.0.0.1', loopback: true });
  assert.equal(listenOf({ observogramListen: listen }), listen);
  assert.deepEqual(listenOf({}), { loopback: false });
  assert.deepEqual(listenOf(undefined), { loopback: false });
});

// ---------- the principal ----------

// Run orgContext over a fake request; resolves to { status, body, principal, org, inContext }.
function runOrgContext({ user = null, bearer = false, headers = {}, query = {}, path = '/api/packs' } = {}) {
  return new Promise((resolve) => {
    const req = { path, headers, query };
    if (user) req.observogramUser = user;
    if (bearer) req.observogramBearer = true;
    const res = {
      set() { return res; },
      status(code) { res.statusCode = code; return res; },
      json(body) { resolve({ status: res.statusCode, body, principal: req.observogramPrincipal }); return res; },
    };
    orgContext(req, res, () => resolve({ status: null, principal: req.observogramPrincipal, org: req.observogramOrg, inContext: currentOrg() }));
  });
}

test('orgContext stamps the principal; a session\'s role is the context org\'s membership', async () => {
  const db = await openStore();
  ensureDefaultOrg(db, 'system');
  createOrg(db, 'system', { id: 'acme', name: 'Acme' });
  createOrg(db, 'system', { id: 'bravo', name: 'Bravo' });
  const olive = createUser(db, 'system', { login: 'olive', isOwner: true });
  const owen = createUser(db, 'system', { login: 'owen', isOwner: true });
  const vera = createUser(db, 'system', { login: 'vera' });
  const mia = createUser(db, 'system', { login: 'mia' });
  const mallory = createUser(db, 'system', { login: 'mallory' });
  addMembership(db, 'system', { orgId: 'acme', userId: owen.id, role: 'viewer' });
  addMembership(db, 'system', { orgId: 'acme', userId: vera.id, role: 'viewer' });
  addMembership(db, 'system', { orgId: 'bravo', userId: mia.id, role: 'admin' });   // mia's FIRST membership
  addMembership(db, 'system', { orgId: 'acme', userId: mia.id, role: 'operator' });

  // A path outside /api/ is not the org middleware's.
  const off = await runOrgContext({ path: '/healthz' });
  assert.equal(off.principal, undefined);

  // The open postures: local, an owner acting as admin, in the default org.
  await withEnv({ OBSERVOGRAM_API_TOKEN: undefined, OBSERVOGRAM_AUTH: 'off' }, async () => {
    const r = await runOrgContext({ headers: { 'x-observogram-org': 'acme' } });
    assert.equal(r.org, 'default', 'the header is ignored');
    assert.equal(r.inContext, 'default');
    assert.deepEqual(r.principal, { kind: 'local', actor: 'local', role: 'admin', owner: true });
  });

  // Token-only, anonymous: a viewer.
  await withEnv({ OBSERVOGRAM_API_TOKEN: 'tok-0123456789', OBSERVOGRAM_AUTH: 'off' }, async () => {
    const r = await runOrgContext();
    assert.deepEqual(r.principal, { kind: 'anonymous', actor: null, role: 'viewer', owner: false });
  });

  // The bearer: an operator on its header's org, labelled.
  await withEnv({ OBSERVOGRAM_API_TOKEN: 'tok-0123456789', OBSERVOGRAM_API_TOKEN_LABEL: 'ci-bot' }, async () => {
    const r = await runOrgContext({ bearer: true, headers: { 'x-observogram-org': 'acme' } });
    assert.equal(r.org, 'acme');
    assert.deepEqual(r.principal, { kind: 'bearer', actor: 'ci-bot', role: 'operator', owner: false });
  });
  await withEnv({ OBSERVOGRAM_API_TOKEN: 'tok-0123456789', OBSERVOGRAM_API_TOKEN_LABEL: undefined }, async () => {
    const r = await runOrgContext({ bearer: true });
    assert.equal(r.org, 'default');
    assert.equal(r.principal.actor, 'token');
  });

  // Sessions (the principal is stamped whatever the posture: the gate put the user there).
  const session = async (user, opts = {}) => (await runOrgContext({ user, ...opts })).principal;
  let p = await session(vera, { headers: { 'x-observogram-org': 'acme' } });
  assert.deepEqual({ ...p, user: p.user.login }, { kind: 'session', actor: 'vera', user: 'vera', owner: false, role: 'viewer' });
  p = await session(mia);   // no org named: her first membership
  assert.equal(p.role, 'admin');
  p = await session(mia, { headers: { 'x-observogram-org': 'acme' } });
  assert.equal(p.role, 'operator', 'the context org\'s membership, not the first one');
  p = await session(mia, { query: { org: 'acme' } });
  assert.equal(p.role, 'operator', '?org= names the context org too');
  p = await session(mia, { headers: { 'x-tomograph-org': 'acme' } });
  assert.equal(p.role, 'operator', 'the legacy header names the context org too');
  p = await session(owen, { headers: { 'x-observogram-org': 'acme' } });
  assert.equal(p.owner, true);
  assert.equal(p.role, 'admin', 'an owner who is a viewer member acts as admin');
  const olives = await runOrgContext({ user: olive, headers: { 'x-observogram-org': 'bravo' } });
  assert.equal(olives.org, 'bravo');
  assert.equal(olives.principal.role, 'admin', 'an owner with no membership is admin in any live org');
  assert.equal((await runOrgContext({ user: olive })).org, 'default');

  // Refusals stamp nothing.
  const refused = await runOrgContext({ user: mallory });
  assert.equal(refused.status, 403);
  assert.equal(refused.principal, undefined);
  const foreign = await runOrgContext({ user: vera, headers: { 'x-observogram-org': 'bravo' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.error, "not a member of org 'bravo'");
  assert.equal(foreign.principal, undefined);

  // Identity on, no user: unreachable behind the gate — stamped null (fail closed), never local.
  await withEnv({ OBSERVOGRAM_API_TOKEN: undefined, OBSERVOGRAM_AUTH: undefined, OBSERVOGRAM_OIDC_ISSUER: 'http://127.0.0.1:9' }, async () => {
    const r = await runOrgContext();
    assert.equal(r.principal, null);
  });
});

// ---------- the studio's calls and navigations (§7) ----------
//
// Every /api call the studio makes carries the CSRF header and the active
// org (authHeaders()); every navigation to /api — which cannot send a
// header — names the org in its query (orgQuery()). Static guards over
// studio/*.mjs (the proto*.mjs sketches skipped), comments stripped first.

const { readFileSync, readdirSync } = await import('node:fs');
const { dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const STUDIO = join(dirname(fileURLToPath(import.meta.url)), '..', 'studio');

function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

// Each `fetch(` call's text, from the name to its balanced closing parenthesis.
function fetchCalls(code) {
  const calls = [];
  const re = /\bfetch\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 0;
    let end = m.index + m[0].length - 1;
    for (; end < code.length; end++) {
      if (code[end] === '(') depth++;
      else if (code[end] === ')' && --depth === 0) break;
    }
    calls.push(code.slice(m.index, end + 1));
  }
  return calls;
}
const EXEMPT_FETCH = new Set(["fetch('/auth/me')"]);
const unguardedFetches = (code) => fetchCalls(code).filter((c) => !EXEMPT_FETCH.has(c) && !c.includes('authHeaders()'));

// Statements (split at `;` and at a line ending in a brace) that hold a
// string or template beginning /api/ and a navigation sink, without orgQuery(.
const API_LITERAL = /['"`]\/api\//;
const NAV_SINK = /\bhref\b|Href\b|window\.open\(|\blocation\b/;
function navigationsWithoutOrg(code) {
  return code.split(/;|[{}][ \t]*\n/)
    .filter((s) => API_LITERAL.test(s) && NAV_SINK.test(s))
    .map((s) => ({ text: s.trim(), ok: s.includes('orgQuery(') }));
}

function studioSources() {
  return readdirSync(STUDIO)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('proto'))
    .map((f) => ({ file: `studio/${f}`, code: withoutComments(readFileSync(join(STUDIO, f), 'utf8')) }));
}

test('the studio guards flag what they must and pass what they must', () => {
  for (const bad of [
    "fetch('/api/uploads', { method: 'DELETE' })",
    'fetch(url)',
    'fetch(`/api/packs/${enc(id)}/canonical${q}`, { headers: { Accept: "application/json" } })',
    "fetch('/api/x'); const h = authHeaders();",
  ]) assert.equal(unguardedFetches(bad).length, 1, bad);
  for (const good of [
    "fetch('/api/uploads', { method: 'DELETE', headers: { ...authHeaders() } })",
    'fetch(`/api/packs/${enc(id)}`, { headers: { Accept: "x", ...authHeaders() } }).then((r) => r.json())',
    "fetch('/auth/me')",
    '// fetch() in a comment',
  ]) assert.deepEqual(unguardedFetches(withoutComments(good)), [], good);

  for (const bad of [
    'a.href = `/api/packs/${id}/export.zip${qs}`;',
    "window.open('/api/packs', '_blank', 'noopener');",
    "const downloadHref = packId ? `/api/packs/${packId}/export.zip` : '';",
    "window.location.assign('/api/packs');",
  ]) assert.deepEqual(navigationsWithoutOrg(bad).map((n) => n.ok), [false], bad);
  for (const good of [
    'a.href = `/api/packs/${id}/export.zip${qs}${orgQuery(qs ? "&" : "?")}`;',
    "window.open(`/api/packs${orgQuery()}`, '_blank', 'noopener');",
    'dl.href = URL.createObjectURL(blob);',
    "const r = await api('/api/packs');",
  ]) assert.ok(navigationsWithoutOrg(good).every((n) => n.ok), good);
});

test('every studio fetch() sends authHeaders() — the CSRF header and the active org', () => {
  const sources = studioSources();
  const all = sources.flatMap(({ file, code }) => fetchCalls(code).map((c) => `${file}: ${c}`));
  assert.ok(all.length >= 17, `found the studio's fetch() calls (${all.length})`);
  const offenders = sources.flatMap(({ file, code }) => unguardedFetches(code).map((c) => `${file}: ${c.slice(0, 120)}`));
  assert.deepEqual(offenders, [], 'a studio fetch() without ...authHeaders() (only fetch(\'/auth/me\') is exempt)');
});

test('every studio navigation to /api names the active org (orgQuery())', () => {
  const sources = studioSources();
  const navs = sources.flatMap(({ file, code }) => navigationsWithoutOrg(code).map((n) => ({ file, ...n })));
  assert.ok(navs.length >= 4, `found the studio's navigations to /api (${navs.length})`);
  assert.deepEqual(navs.filter((n) => !n.ok).map((n) => `${n.file}: ${n.text.slice(0, 120)}`), []);
  const html = readFileSync(join(STUDIO, 'index.html'), 'utf8');
  assert.ok(!/href\s*=\s*["']\/api\//i.test(html), 'studio/index.html links to /api with a static href (it cannot name the org)');
});
