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
 *   to /api names the org with orgQuery(); the deploy modal and Neuron's
 *   Run all say a refusal;
 * - completeness: three children (local, oidc, off) walk the app's router
 *   (server/fixtures/route-inventory.mjs); every route's first handler, per
 *   method, is its own authorize() guard, every key is in
 *   server/route-table.mjs for its mode and agrees with EXPECTED_CLASS
 *   below, only the named middleware and the static mounts sit between;
 *   the README's API Surface states each of its rows' class as the table has it;
 * - the decision (authzDecision), pure, over synthetic entries — the
 *   always / refuse / rule / direct-loopback paths no route has yet — and
 *   the request facts it reads (the CSRF header, a cross-site form, a
 *   direct loopback request); selfGate's CSRF step; the guard's 500 for
 *   a classified route reached without a principal (fail closed);
 * - the AuthZ matrix: every /api route × every principal × every posture,
 *   each a child server (server/fixtures/serve-child.mjs), its expectations
 *   from EXPECTED_CLASS and the fixture's own membership table, never from
 *   the server; refused requests write no audit row; plus the CSRF, form,
 *   public, case, org-list and fresh admin/admin rows; the self routes'
 *   404 while stand-alone sign-in is off (selfGate's first step).
 */

// Hermetic (§0): a developer shell's store or identity variables never
// reach a child or this process's own imports. The child helpers
// (server/fixtures/serve-child.mjs) import no server code.
const { STRIP, childEnv } = await import('./fixtures/serve-child.mjs');
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

const {
  postureOf, listenOf, orgContext, authzDecision, directLoopbackRequest, crossSiteForm, hasCsrfHeader, rankOf, effectiveRoleOf, selfGate,
} = await import('./authz.mjs');
const { openStore, closeStore, currentStore } = await import('./store/db.mjs');
const { createUser } = await import('./store/users.mjs');
const { setMeta } = await import('./store/meta.mjs');
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

// ---------- the decision, pure (§6.3) ----------
//
// Synthetic entries: slice 3a has no identity-API route yet, so the
// always / refuse / rule / direct-loopback paths are proved here, on the
// function the guard calls.

const synth = (fields) => ({ csrf: 'none', exposed: 'allow', identityApi: false, ...fields });
const P = {
  local: { kind: 'local', actor: 'local', role: 'admin', owner: true },
  anon: { kind: 'anonymous', actor: null, role: 'viewer', owner: false },
  bearer: { kind: 'bearer', actor: 'ci-bot', role: 'operator', owner: false },
  viewer: { kind: 'session', actor: 'vera', role: 'viewer', owner: false },
  operator: { kind: 'session', actor: 'oscar', role: 'operator', owner: false },
  admin: { kind: 'session', actor: 'ada', role: 'admin', owner: false },
  owner: { kind: 'session', actor: 'owen', role: 'admin', owner: true },
};
const ctxOf = (posture, principal, more = {}) => ({
  posture, principal, csrf: true, direct: true, org: 'acme', authOff: false, host: '0.0.0.0', port: 8000, ...more,
});
const verdict = (d) => (d === null ? 'allow' : `${d.status} ${d.body.denied}`);

test('authzDecision: posture, CSRF and class, in that order', () => {
  const ownerApi = synth({ class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse' });
  const orgCreate = synth({ class: 'owner', identityApi: true, csrf: 'always', exposed: 'rule' });
  const adminApi = synth({ class: 'admin', identityApi: true, csrf: 'always', exposed: 'refuse' });
  const adminRead = synth({ class: 'admin', identityApi: true, exposed: 'refuse' });
  const viewerRead = synth({ class: 'viewer' });
  const opWrite = synth({ class: 'operator', csrf: 'session' });
  const rows = [
    // open, exposed: refuse closes the route (reads too), for every principal
    [ownerApi, ctxOf('open-exposed', P.local), '403 posture'],
    [adminRead, ctxOf('open-exposed', P.local), '403 posture'],
    // …rule passes to the route's rule, when sent directly with the header
    [orgCreate, ctxOf('open-exposed', P.local), 'allow'],
    [orgCreate, ctxOf('open-exposed', P.local, { csrf: false }), '403 csrf'],
    [orgCreate, ctxOf('open-exposed', P.local, { direct: false }), '403 posture'],
    // …existing routes stay open (the Local-mode gate)
    [opWrite, ctxOf('open-exposed', P.local, { direct: false, csrf: false }), 'allow'],
    // open, loopback: the identity API answers a direct loopback request only
    [ownerApi, ctxOf('open-loopback', P.local), 'allow'],
    [ownerApi, ctxOf('open-loopback', P.local, { direct: false }), '403 posture'],
    [adminRead, ctxOf('open-loopback', P.local, { direct: false, csrf: false }), '403 posture'],
    [adminRead, ctxOf('open-loopback', P.local, { csrf: false }), 'allow'],
    [ownerApi, ctxOf('open-loopback', P.local, { csrf: false }), '403 csrf'],
    [opWrite, ctxOf('open-loopback', P.local, { direct: false, csrf: false }), 'allow'],
    // always: every principal but the bearer
    [adminApi, ctxOf('identity', P.admin, { csrf: false }), '403 csrf'],
    [adminApi, ctxOf('identity', P.admin), 'allow'],
    [adminApi, ctxOf('identity', P.bearer, { csrf: false }), '403 role'],
    [ownerApi, ctxOf('identity', P.bearer, { csrf: false }), '403 role'],
    // the class
    [ownerApi, ctxOf('identity', P.owner), 'allow'],
    [ownerApi, ctxOf('identity', P.admin), '403 role'],
    [adminApi, ctxOf('identity', P.owner), 'allow'],
    [adminApi, ctxOf('identity', P.operator), '403 role'],
    [opWrite, ctxOf('identity', P.operator, { csrf: false }), 'allow'],
    [opWrite, ctxOf('identity', P.viewer), '403 role'],
    [opWrite, ctxOf('identity', P.bearer), 'allow'],
    [viewerRead, ctxOf('identity', P.viewer), 'allow'],
    [viewerRead, ctxOf('token', P.anon), 'allow'],
    [opWrite, ctxOf('token', P.anon), '403 role'],
    [adminRead, ctxOf('token', P.bearer), '403 role'],
    // the posture refusal wins over the class and the header
    [ownerApi, ctxOf('open-exposed', P.local, { csrf: false, direct: false }), '403 posture'],
  ];
  for (const [entry, ctx, want] of rows) {
    assert.equal(verdict(authzDecision(entry, ctx)), want, `${JSON.stringify(entry)} × ${ctx.posture} ${ctx.principal.kind}/${ctx.principal.role} csrf=${ctx.csrf} direct=${ctx.direct}`);
  }
});

test('authzDecision: every refusal names a way out', () => {
  const ownerApi = synth({ class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse' });
  const adminApi = synth({ class: 'admin', identityApi: true, csrf: 'always', exposed: 'refuse' });
  const opWrite = synth({ class: 'operator', csrf: 'session' });
  const text = (entry, ctx) => authzDecision(entry, ctx).body.error;
  assert.equal(text(ownerApi, ctxOf('open-exposed', P.local, { authOff: true })),
    'the identity API is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1, OBSERVOGRAM_AUTH=off): restart it without OBSERVOGRAM_AUTH=off and sign in as an owner, or bind it to loopback');
  assert.equal(text(ownerApi, ctxOf('open-exposed', P.local)),
    'the identity API is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1): add the first user with npm run users -- add <login> (it arms sign-in without a restart; the first local user is an owner), or configure OIDC');
  assert.equal(text(ownerApi, ctxOf('open-loopback', P.local, { direct: false, port: 8123 })),
    'on a server without sign-in the identity API answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; no Forwarded / X-Forwarded-* / X-Real-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:8123, or use the CLIs from this machine (npm run users -- add <login>, passwd <login>, owner <login>)');
  assert.equal(text(ownerApi, ctxOf('identity', P.owner, { csrf: false })),
    "missing X-Observogram-CSRF: 1 — identity changes need it in every posture, so a cross-site form cannot make them (the studio sends it; with curl add -H 'X-Observogram-CSRF: 1')");
  assert.equal(text(ownerApi, ctxOf('identity', P.admin)), "requires an owner of this deployment (you are admin in org 'acme') — ask an owner");
  assert.equal(text(opWrite, ctxOf('identity', P.viewer)), "requires the operator role in org 'acme' (you are viewer) — ask an admin of acme");
  assert.equal(text(adminApi, ctxOf('identity', P.bearer)),
    "the bearer token acts as an operator in org 'acme'; the admin role needs a signed-in user with that role");
  assert.equal(text(ownerApi, ctxOf('token', P.bearer)),
    "the bearer token acts as an operator in org 'acme'; an owner needs a signed-in user with that role; this server has no sign-in: add the first user with npm run users -- add <login>, or configure OIDC");
  assert.equal(text(opWrite, ctxOf('token', P.anon)),
    'anonymous callers are viewers here; the operator role needs a signed-in user; this server has no sign-in: add the first user with npm run users -- add <login>, or configure OIDC');
  const body = authzDecision(opWrite, ctxOf('identity', P.viewer)).body;
  assert.deepEqual({ ...body, error: undefined }, { ok: false, error: undefined, denied: 'role', need: 'operator', role: 'viewer', owner: false, org: 'acme' });
});

test('the request facts: the CSRF header, a cross-site form, a direct loopback request; ranks', () => {
  assert.equal(hasCsrfHeader({ headers: { 'x-observogram-csrf': '1' } }), true);
  assert.equal(hasCsrfHeader({ headers: { 'x-tomograph-csrf': '1' } }), true, 'the pre-rebrand spelling');
  assert.equal(hasCsrfHeader({ headers: { 'x-observogram-csrf': 'yes' } }), false);
  assert.equal(hasCsrfHeader({ headers: {} }), false);

  for (const [site, want] of [['cross-site', true], ['same-site', true], ['Cross-Site', true], ['same-origin', false], ['none', false], [undefined, false]]) {
    assert.equal(crossSiteForm({ headers: site === undefined ? {} : { 'sec-fetch-site': site } }), want, String(site));
  }

  const direct = (headers) => directLoopbackRequest({ headers });
  for (const host of ['127.0.0.1:8000', '127.0.0.1', 'localhost:8000', 'LOCALHOST', '[::1]:8000', '[::1]', '127.1.2.3:9']) {
    assert.equal(direct({ host }), true, host);
  }
  for (const host of ['rebind.attacker.example:8000', '127.evil.example', '127.0.0.1.nip.io', '10.0.0.1:8000', '[::2]:8000', '', undefined, 'localhost:8000:1']) {
    assert.equal(direct(host === undefined ? {} : { host }), false, String(host));
  }
  const h = { host: '127.0.0.1:8000' };
  for (const proxy of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']) {
    assert.equal(direct({ ...h, [proxy]: '203.0.113.9' }), false, proxy);
  }
  assert.equal(direct({ ...h, origin: 'http://127.0.0.1:8000' }), true);
  assert.equal(direct({ host: 'localhost', origin: 'http://localhost' }), true);
  assert.equal(direct({ host: 'localhost:80', origin: 'http://localhost' }), true, 'the default port, spelled or not');
  for (const origin of ['http://localhost:8000', 'http://127.0.0.1:9000', 'https://evil.example', 'null', 'file://', 'chrome-extension://abc']) {
    assert.equal(direct({ ...h, origin }), false, origin);
  }

  assert.deepEqual([P.viewer, P.operator, P.admin, P.owner, P.local, P.bearer, P.anon, null].map(rankOf), [0, 1, 2, 2, 2, 1, 0, -1]);
  assert.equal(effectiveRoleOf(P.owner, 'viewer'), 'admin', 'an owner who is a viewer member acts as admin');
  assert.equal(effectiveRoleOf(P.viewer, 'viewer'), 'viewer');
  assert.equal(effectiveRoleOf(P.bearer), 'operator');
  assert.equal(effectiveRoleOf(P.anon), 'viewer');
  assert.equal(effectiveRoleOf(P.local), 'admin');
});

test('selfGate: an always-CSRF self route refuses the caller\'s own session without the header', async () => {
  const { createHmac } = await import('node:crypto');
  const db = currentStore();
  const selfie = createUser(db, 'system', { login: 'selfie' });
  setMeta(db, 'system', 'identity_armed', '1');
  const secret = 'authz-suite-session-secret-0123456789-abc';
  const cookie = (() => {
    const body = Buffer.from(JSON.stringify({ sub: 'selfie', login: 'selfie', ep: selfie.sessionEpoch, purpose: 'session', iat: Date.now(), exp: Date.now() + 3600_000 })).toString('base64url');
    return `observogram_session=v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  })();
  const entry = { class: 'self', csrf: 'always', modes: ['local', 'oidc'], self: { pwflow: false, session: true, unauth: 'json' } };
  const run = (headers) => new Promise((resolve) => {
    const req = { headers, query: {} };
    const res = {
      status(code) { res.statusCode = code; return res; },
      json(body) { resolve({ status: res.statusCode, body }); return res; },
      redirect(to) { resolve({ status: 302, to }); return res; },
    };
    selfGate(entry, req, res, () => resolve({ status: null, self: req.observogramSelf }));
  });
  try {
    await withEnv({ OBSERVOGRAM_SESSION_SECRET: secret, OBSERVOGRAM_AUTH: undefined, OBSERVOGRAM_OIDC_ISSUER: undefined, OBSERVOGRAM_API_TOKEN: undefined }, async () => {
      const none = await run({});
      assert.deepEqual([none.status, none.body.denied], [401, 'auth']);
      const bare = await run({ cookie });
      assert.equal(bare.status, 403);
      assert.equal(bare.body.denied, 'csrf');
      assert.match(bare.body.error, /^missing X-Observogram-CSRF: 1 — identity changes need it in every posture/);
      const ok = await run({ cookie, 'x-observogram-csrf': '1' });
      assert.equal(ok.status, null);
      assert.equal(ok.self.via, 'session');
      assert.equal(ok.self.user.login, 'selfie');
    });
  } finally {
    setMeta(db, 'system', 'identity_armed', null);
  }
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

// The deploy modal (Compare, Compile, Remediate all open it) reads
// deploy-bulk with fetch(), not api(): a refusal must reach its status line.
const { deployRefusal } = await import('../studio/api.mjs');

// A function declaration's text, from its name to its balanced closing brace.
function functionSource(code, name) {
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `the studio source declares ${name}()`);
  let i = code.indexOf('{', code.indexOf(')', start));
  for (let depth = 0; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) break;
  }
  return code.slice(start, i + 1);
}

test('a refused Deploy says the server\'s text on the modal\'s status line and draws no result table', async () => {
  const { routeEntry } = await import('./route-table.mjs');
  const d = authzDecision(routeEntry('POST /api/packs/:id/deploy-bulk'), ctxOf('identity', P.viewer));
  const denial = deployRefusal(d.status, d.body);
  assert.equal(denial.message, "403: requires the operator role in org 'acme' (you are viewer) — ask an admin of acme");
  assert.equal(denial.denied, 'role');
  // The route's own refusals carry no summary either.
  assert.equal(deployRefusal(404, { ok: false, error: 'unknown pack: nope' }).message, '404: unknown pack: nope');
  assert.equal(deployRefusal(412, { ok: false, deployId: 'dep_1', error: 'strict snapshot' }).message, '412: strict snapshot');
  assert.equal(deployRefusal(500, {}).message, '500: no deploy result');
  // A result is none, even when every item failed: the table shows each.
  assert.equal(deployRefusal(200, { ok: true, results: [], summary: { total: 1, ok: 1, failed: 0 } }), null);
  assert.equal(deployRefusal(502, { ok: false, results: [{ ok: false, error: 'boom' }], summary: { total: 1, ok: 0, failed: 1 } }), null);

  // The handler throws it (its catch sets the status line) before it reads a
  // summary or draws the table.
  const fn = functionSource(withoutComments(readFileSync(join(STUDIO, 'app.mjs'), 'utf8')), 'doDeployBulk');
  const at = (s) => { const i = fn.indexOf(s); assert.ok(i >= 0, `doDeployBulk has ${s}`); return i; };
  const thrown = at('if (refusal) throw refusal;');
  assert.ok(at('const refusal = deployRefusal(r.status, body);') < thrown);
  assert.ok(thrown < at('body.summary'), 'the refusal is thrown before the summary is read');
  assert.ok(thrown < at('renderDeployBulkResult('), 'the refusal is thrown before the result table is drawn');
  assert.match(fn, /catch \(e\) \{\s*setStatus\(`error: \$\{e\.message\}`, 'error'\);/);
});

// Neuron's Run all runs each journey with api() and ends on ONE toast: a
// refusal (the same for every journey) must reach it, not only a count.
const { deniedError } = await import('../studio/api.mjs');
const { runAllText } = await import('../studio/journeys-view.mjs');

test('Neuron\'s Run all says the server\'s text when the runs are refused, not only how many did not finish', async () => {
  const { routeEntry } = await import('./route-table.mjs');
  const d = authzDecision(routeEntry('POST /api/journeys/:name/run'), ctxOf('identity', P.viewer));
  const denial = deniedError(d.status, d.body); // what api() throws
  const names = ['j-one', 'j-two'];
  const tally = (t) => ({ pass: 0, 'gate-failed': 0, 'vantage-lost': 0, error: 0, ...t });
  assert.equal(runAllText(names, tally({ error: 2 }), names.map((name) => ({ name, message: denial.message }))),
    "Ran 2 journeys: 2 did not finish. j-one and j-two: 403: requires the operator role in org 'acme' (you are viewer) — ask an admin of acme.");
  // Another reason is not passed off as the first one's: its journey is named.
  assert.equal(runAllText(['a', 'b', 'c', 'd'], tally({ pass: 1, error: 3 }), [
    { name: 'b', message: '502: the live source did not answer' }, { name: 'c', message: 'Failed to fetch' }, { name: 'd', message: '502: the live source did not answer' },
  ]), 'Ran 4 journeys: 1 passed and 3 did not finish. b and d: 502: the live source did not answer. c: another reason — run it alone to read it.');
  // Runs that all finished read as before.
  assert.equal(runAllText(names, tally({ pass: 1, 'gate-failed': 1 })), 'Ran 2 journeys: 1 passed and 1 failed.');

  // runJourneys keeps each thrown error's text and hands it to the toast.
  const fn = functionSource(withoutComments(readFileSync(join(STUDIO, 'neuron-view.mjs'), 'utf8')), 'runJourneys');
  assert.match(fn, /catch \(err\) \{\s*tally\.error \+= 1;\s*failures\.push\(\{ name, message: err\?\.message \|\| String\(err\) \}\);/);
  assert.match(fn, /if \(names\.length > 1\) toast\(runAllText\(names, tally, failures\),/);
});

// ---------- completeness: every route is classified and guarded (§14.1) ----------
//
// The expected class of every route, written from STORE_PLAN §5 — NOT
// imported from the table: reclassifying a route is a two-place edit.
const EXPECTED_CLASS = Object.freeze({
  'GET /healthz': 'public',
  'GET /api/version': 'public',
  'GET /auth/login': 'public',
  'POST /auth/login': 'public',
  'GET /auth/callback': 'public',
  'POST /auth/logout': 'public',
  'GET /auth/me': 'public',
  [`GET ${/^(?!\/api\/).*/}`]: 'public',
  'GET /auth/change-password': 'self',
  'POST /auth/change-password': 'self',
  'POST /auth/change-password/skip': 'self',
  'GET /api/orgs': 'viewer',
  'GET /api/packs': 'viewer',
  'GET /api/examples': 'viewer',
  'GET /api/references': 'viewer',
  'GET /api/packs/:id': 'viewer',
  'GET /api/packs/:id/canonical': 'viewer',
  'GET /api/packs/:id/conformance': 'viewer',
  'GET /api/diff': 'viewer',
  'GET /api/compile/targets': 'viewer',
  'GET /api/packs/:id/compile-catalog': 'viewer',
  'GET /api/packs/:id/compile-artifact': 'viewer',
  'GET /api/packs/:id/export.zip': 'viewer',
  'GET /api/deploy/matrix': 'viewer',
  'GET /api/deploys': 'viewer',
  'GET /api/deploys/:deployId/rollback-plan': 'viewer',
  'GET /api/journeys': 'viewer',
  'GET /api/journeys/:name/runs': 'viewer',
  'GET /api/journeys/:name/schedule': 'viewer',
  'GET /api/packs/:id/compile/:target': 'viewer',
  'GET /api/maturity-rubric': 'viewer',
  'GET /api/live-status': 'viewer',
  'GET /api/library': 'viewer',
  'GET /api/library/requirements/:tier': 'viewer',
  'GET /api/library/:id': 'viewer',
  'DELETE /api/uploads': 'operator',
  'POST /api/packs/:id/retrofeed': 'operator',
  'POST /api/deploys/:deployId/verify': 'operator',
  'POST /api/deploys/:deployId/rollback': 'operator',
  'POST /api/packs/:id/deploy-bulk': 'operator',
  'POST /api/packs/:id/deploy/:target': 'operator',
  'POST /api/journeys/:name/run': 'operator',
  'POST /api/journeys/capture': 'operator',
  'POST /api/draft-from-mcp': 'operator',
  'POST /api/refresh-live': 'operator',
  'POST /api/crawl': 'operator',
  'POST /api/crawl-github': 'operator',
  'POST /api/validate': 'operator',
  'POST /api/library/instantiate': 'operator',
  'POST /api/library/compile': 'operator',
  'POST /api/library/register': 'operator',
});
// The identity API (/api/admin/*, /api/org*) and the one open-exposed
// `rule` route arrive with slice 3b; none exists yet.
const EXPECTED_IDENTITY_API = Object.freeze([]);
const EXPECTED_EXPOSED_RULE = Object.freeze([]);

const { spawnSync } = await import('node:child_process');
const { ROUTES, STATIC_MOUNTS, MIDDLEWARE, CLASSES, MODES, routeEntry } = await import('./route-table.mjs');
const INVENTORY = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'route-inventory.mjs');

// initAuth() decides the /auth/* routes at import: one child per mode,
// each with an explicit env (this process's minus every variable a boot
// reads, plus the mode's own). OIDC discovery is lazy: nothing is contacted.
const MODE_ENV = {
  local: {},
  oidc: {
    OBSERVOGRAM_OIDC_ISSUER: 'http://127.0.0.1:9', OBSERVOGRAM_OIDC_CLIENT_ID: 'studio', OBSERVOGRAM_OIDC_ALLOW_HTTP: '1',
    OBSERVOGRAM_SESSION_SECRET: 'authz-suite-session-secret-0123456789-abc',
  },
  off: { OBSERVOGRAM_AUTH: 'off' },
};
function inventory(mode) {
  const r = spawnSync(process.execPath, [INVENTORY], { env: childEnv(WORKSPACE, MODE_ENV[mode]), encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `the ${mode} inventory child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
const inventories = Object.fromEntries(MODES.map((m) => [m, inventory(m)]));

test('completeness: every route\'s first handler, per method, is its own guard; no route.all', () => {
  for (const [mode, inv] of Object.entries(inventories)) {
    assert.ok(inv.routes.length >= 40, `${mode}: walked the router (${inv.routes.length} routes)`);
    assert.deepEqual(inv.routes.filter((r) => r.guard !== r.key).map((r) => `${r.key} (first handler: ${r.guard ?? 'not a guard'})`), [], `${mode}: unguarded routes`);
    assert.deepEqual(inv.alls, [], `${mode}: app.all / route.all registrations`);
    const keys = inv.routes.map((r) => r.key);
    assert.deepEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], `${mode}: a route registered twice`);
  }
});

test('completeness: every registered route is in the table for its mode, and every entry is registered', () => {
  for (const [mode, inv] of Object.entries(inventories)) {
    const registered = new Set(inv.routes.map((r) => r.key));
    const unclassified = [...registered].filter((k) => !Object.hasOwn(ROUTES, k));
    assert.deepEqual(unclassified, [], `${mode}: routes missing from server/route-table.mjs`);
    const wrongMode = [...registered].filter((k) => !routeEntry(k).modes.includes(mode));
    assert.deepEqual(wrongMode, [], `${mode}: registered in a mode its entry does not list`);
    const expected = Object.keys(ROUTES).filter((k) => routeEntry(k).modes.includes(mode));
    assert.deepEqual(expected.filter((k) => !registered.has(k)), [], `${mode}: entries that list this mode but are not registered`);
  }
  const union = new Set(Object.values(inventories).flatMap((inv) => inv.routes.map((r) => r.key)));
  assert.deepEqual(Object.keys(ROUTES).filter((k) => !union.has(k)), [], 'stale entries: registered in no mode');
});

test('completeness: only the named middleware, routers mounted at the root, the static mounts, case-sensitive routing', () => {
  for (const [mode, inv] of Object.entries(inventories)) {
    assert.deepEqual(inv.middleware.filter((n) => !MIDDLEWARE.includes(n)), [], `${mode}: an unexpected middleware layer (name it and list it in MIDDLEWARE)`);
    assert.deepEqual([...inv.middleware].sort(), [...MIDDLEWARE].sort(), `${mode}: every named middleware is in the stack once`);
    assert.ok(inv.routers.length >= 1, `${mode}: found the deploy router`);
    assert.deepEqual(inv.routers.filter((r) => !r.mountedAtRoot), [], `${mode}: a router mounted under a prefix (keys must be absolute paths)`);
    assert.deepEqual(inv.routers.filter((r) => !r.caseSensitive), [], `${mode}: a router without { caseSensitive: true }`);
    assert.equal(inv.appCaseSensitive, true, `${mode}: app.router is case-sensitive`);
    assert.deepEqual([...inv.statics].sort(), Object.keys(STATIC_MOUNTS).sort(), `${mode}: each static layer matches exactly one mount, each mount once`);
  }
});

test('completeness: the table agrees with the independent classification, and every entry is well formed', () => {
  assert.deepEqual(Object.keys(ROUTES).sort(), Object.keys(EXPECTED_CLASS).sort(), 'ROUTES and EXPECTED_CLASS hold the same keys');
  for (const key of Object.keys(ROUTES)) {
    const e = routeEntry(key);
    assert.equal(e.class, EXPECTED_CLASS[key], `${key}: class`);
    assert.ok(CLASSES.includes(e.class), `${key}: a known class`);
    assert.ok(e.modes.length > 0 && e.modes.every((m) => MODES.includes(m)), `${key}: modes`);
    assert.ok(['none', 'session', 'always', 'form'].includes(e.csrf), `${key}: csrf`);
    assert.ok(['allow', 'refuse', 'rule'].includes(e.exposed), `${key}: exposed`);
    assert.ok(Array.isArray(e.audit) && e.audit.every((a) => /^[a-z]+(?:[.-][a-z]+)+$/.test(a)), `${key}: audit actions`);
    assert.ok(e.later === null || (typeof e.later === 'string' && e.later.length > 0), `${key}: later`);
    const isApi = e.path.startsWith('/api/');
    if (isApi && e.method !== 'GET') {
      assert.ok(['session', 'always'].includes(e.csrf), `${key}: an /api mutation needs csrf session or always`);
      assert.ok(!['public', 'viewer'].includes(e.class), `${key}: a viewer may only read`);
    }
    if (e.identityApi) assert.ok(['admin', 'owner'].includes(e.class), `${key}: the identity API is admin or owner`);
    if (e.class === 'admin' || e.class === 'owner') assert.ok(Object.hasOwn(ROUTES[key], 'exposed'), `${key}: an ${e.class} route declares exposed`);
    if (e.csrf === 'form') assert.ok(e.method !== 'GET' && e.path.startsWith('/auth/'), `${key}: form is for a non-GET /auth route`);
    if (e.class === 'self') {
      assert.ok(e.self && typeof e.self.pwflow === 'boolean' && typeof e.self.session === 'boolean'
        && ['redirect', 'flow-expired', 'json'].includes(e.self.unauth), `${key}: a self entry has a self spec`);
    } else assert.equal(e.self, null, `${key}: only a self entry has a self spec`);
  }
  assert.deepEqual(Object.keys(ROUTES).filter((k) => routeEntry(k).identityApi).sort(), [...EXPECTED_IDENTITY_API].sort(), 'the identity API set');
  assert.deepEqual(Object.keys(ROUTES).filter((k) => routeEntry(k).exposed === 'rule').sort(), [...EXPECTED_EXPOSED_RULE].sort(), 'the exposed: rule set');
});

// The README's API Surface states each row's class in its intro: the
// public rows by name, then every other GET viewer, every other row
// operator. Each row is checked against the route table.
test('the README API Surface: its intro names each public row, every other GET is viewer, every other row operator', () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  const start = readme.indexOf('\n## API Surface\n');
  assert.ok(start >= 0, 'README has an API Surface section');
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  const intro = section.slice(0, section.indexOf('\n|')).replace(/\s+/g, ' ');
  const rows = [...section.matchAll(/^\| `([A-Z]+)` \| `([^`]+)` \|/gm)].map(([, method, path]) => ({ method, path: path.split('?')[0] }));
  assert.ok(rows.length >= 20, `read the table (${rows.length} rows)`);
  for (const { method, path } of rows) {
    const key = `${method} ${path}`;
    assert.ok(Object.hasOwn(ROUTES, key), `${key}: a README row the route table does not hold`);
    const { class: cls } = routeEntry(key);
    const named = intro.includes(`\`${path}\``);
    if (cls === 'public') assert.ok(named, `${key}: a public row the intro does not name`);
    else {
      assert.ok(!named, `${key}: the intro names a ${cls} row as public`);
      assert.equal(cls, method === 'GET' ? 'viewer' : 'operator', `${key}: the class the intro states`);
    }
  }
  assert.match(intro, /every other `GET` is `viewer`/, 'the intro states the GET rule');
  assert.match(intro, /every other route `operator`/, 'the intro states the rule for every other row');
});

test('authorize(key) throws at registration on an unclassified key, naming both files', async () => {
  const { authorize } = await import('./authz.mjs');
  assert.throws(() => authorize('GET /api/nope'),
    { message: 'unclassified route GET /api/nope — add it to server/route-table.mjs and to EXPECTED_CLASS in server/test-authz.mjs' });
  const g = authorize('GET /api/packs');
  assert.equal(g.name, 'authorize');
  assert.equal(g.routeKey, 'GET /api/packs');
});

test('authorize(key): a classified route reached without a principal is refused 500, logged once — never passed (§6.2 step 3)', async () => {
  const { authorize } = await import('./authz.mjs');
  const guard = authorize('GET /api/packs');
  const run = () => {
    const out = { status: null, body: null, next: false };
    const res = {
      status(code) { out.status = code; return res; },
      json(body) { out.body = body; return res; },
    };
    guard({ method: 'GET', path: '/api/packs', headers: {}, query: {} }, res, () => { out.next = true; });
    return out;
  };
  const logged = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).startsWith('[authz] ')) { logged.push(String(chunk)); return true; }
    return write.call(process.stderr, chunk, ...rest);
  };
  let first;
  let second;
  try {
    first = run();
    second = run();
  } finally {
    process.stderr.write = write;
  }
  for (const r of [first, second]) {
    assert.equal(r.next, false, 'the guard never passes a request without a principal');
    assert.equal(r.status, 500);
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /^no principal was resolved for GET \/api\/packs — a bug/);
  }
  assert.deepEqual(logged, ['[authz] no principal was resolved for GET /api/packs — refused (500)\n'], 'logged once per key');
});

// ---------- the AuthZ matrix (§14.2) ----------
//
// Every /api route × every principal × every posture, each posture a child
// server on its own workspace. One probe per route, side-effect-free when
// allowed (unknown ids, invalid bodies, missing parameters; DELETE
// /api/uploads on an empty registry); no probe contacts an MCP or GitHub.
// A request is ALLOWED when its status is neither 401 nor 403 and its body
// carries no `denied`. The expectation comes from EXPECTED_CLASS and the
// fixture's own membership table below — never from the server's answers
// or the table under test.

const { writeFileSync: writeFile, mkdirSync: makeDir } = await import('node:fs');
const { serve, cli, signIn } = await import('./fixtures/serve-child.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { hashPassword } = await import('./auth.mjs');
const { openRaw, prepare } = await import('./store/db.mjs');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORG_ADMIN = join(REPO, 'tools', 'org-admin.mjs');
const USER_ADMIN = join(REPO, 'tools', 'user-admin.mjs');
const TOKEN = 'authz-matrix-token-0123456789';
const RANKS = Object.freeze({ viewer: 0, operator: 1, admin: 2 });

const PROBES = Object.freeze({
  'GET /api/version': ['GET', '/api/version'],
  'GET /api/orgs': ['GET', '/api/orgs'],
  'GET /api/packs': ['GET', '/api/packs'],
  'GET /api/examples': ['GET', '/api/examples'],
  'GET /api/references': ['GET', '/api/references'],
  'GET /api/packs/:id': ['GET', '/api/packs/nope'],
  'GET /api/packs/:id/canonical': ['GET', '/api/packs/nope/canonical'],
  'GET /api/packs/:id/conformance': ['GET', '/api/packs/nope/conformance'],
  'GET /api/diff': ['GET', '/api/diff'],
  'GET /api/compile/targets': ['GET', '/api/compile/targets'],
  'GET /api/packs/:id/compile-catalog': ['GET', '/api/packs/nope/compile-catalog'],
  'GET /api/packs/:id/compile-artifact': ['GET', '/api/packs/nope/compile-artifact'],
  'GET /api/packs/:id/export.zip': ['GET', '/api/packs/nope/export.zip'],
  'GET /api/deploy/matrix': ['GET', '/api/deploy/matrix'],
  'GET /api/deploys': ['GET', '/api/deploys'],
  'GET /api/deploys/:deployId/rollback-plan': ['GET', '/api/deploys/x/rollback-plan'],
  'GET /api/journeys': ['GET', '/api/journeys'],
  'GET /api/journeys/:name/runs': ['GET', '/api/journeys/nope/runs'],
  'GET /api/journeys/:name/schedule': ['GET', '/api/journeys/nope/schedule'],
  'GET /api/packs/:id/compile/:target': ['GET', '/api/packs/nope/compile/nope'],
  'GET /api/maturity-rubric': ['GET', '/api/maturity-rubric'],
  'GET /api/live-status': ['GET', '/api/live-status'],
  'GET /api/library': ['GET', '/api/library'],
  'GET /api/library/requirements/:tier': ['GET', '/api/library/requirements/nope'],
  'GET /api/library/:id': ['GET', '/api/library/nope'],
  'DELETE /api/uploads': ['DELETE', '/api/uploads'],
  'POST /api/packs/:id/retrofeed': ['POST', '/api/packs/nope/retrofeed'],
  'POST /api/deploys/:deployId/verify': ['POST', '/api/deploys/x/verify'],
  'POST /api/deploys/:deployId/rollback': ['POST', '/api/deploys/x/rollback'],
  'POST /api/packs/:id/deploy-bulk': ['POST', '/api/packs/nope/deploy-bulk'],
  'POST /api/packs/:id/deploy/:target': ['POST', '/api/packs/nope/deploy/nope'],
  'POST /api/journeys/:name/run': ['POST', '/api/journeys/nope/run'],
  'POST /api/journeys/capture': ['POST', '/api/journeys/capture'],
  'POST /api/draft-from-mcp': ['POST', '/api/draft-from-mcp'],
  'POST /api/refresh-live': ['POST', '/api/refresh-live'],
  'POST /api/crawl': ['POST', '/api/crawl'],
  'POST /api/crawl-github': ['POST', '/api/crawl-github'],
  'POST /api/validate': ['POST', '/api/validate'],
  'POST /api/library/instantiate': ['POST', '/api/library/instantiate'],
  'POST /api/library/compile': ['POST', '/api/library/compile'],
  'POST /api/library/register': ['POST', '/api/library/register'],
});

// The /auth/* routes and the non-/api public routes have their own rows below.
test('the probe table covers every /api route the server registers', () => {
  const apiKeys = inventories.local.routes.map((r) => r.key).filter((k) => k.split(' ')[1].startsWith('/api/'));
  assert.deepEqual(Object.keys(PROBES).sort(), [...new Set(apiKeys)].sort(), 'a /api route without a probe (add one to PROBES), or a probe for no route');
});

// One request: { status, json (or null), text, type }; `query` is appended to the path.
async function call(base, [method, path], { headers = {}, body, query = '' } = {}) {
  const h = { Accept: 'application/json', ...headers };
  let payload;
  if (method !== 'GET' && method !== 'DELETE') {
    h['Content-Type'] ??= 'application/json';
    payload = body ?? '{}';
  }
  const r = await fetch(`${base}${path}${query}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, type: r.headers.get('content-type') || '' };
}
const outcome = (r) => ((r.status === 401 || r.status === 403 || r.json?.denied)
  ? `${r.status} ${r.json?.denied ?? '(no denied)'}` : 'allowed');

// Every probe for every variant; the mismatches, as readable lines.
async function sweep(base, variants, expect) {
  const bad = [];
  let n = 0;
  for (const v of variants) {
    for (const [key, probe] of Object.entries(PROBES)) {
      const r = await call(base, probe, { headers: v.headers, query: v.query || '' });
      n++;
      const got = outcome(r);
      const want = expect(v, key);
      if (got !== want) bad.push(`${v.name} ${key}: got ${got} (${r.status} ${r.text.slice(0, 120)}), want ${want}`);
    }
  }
  return { bad, n };
}

// The audit log's high-water mark, read beside the running child (WAL)
// through a separate read-only connection.
async function auditSeq(ws) {
  const db = await openRaw(join(ws, 'observogram.db'), { readOnly: true });
  try { return prepare(db, 'SELECT coalesce(max(seq), 0) AS s FROM audit').get().s; } finally { db.close(); }
}

// The case rows (the /API/… regression of C1): never a JSON 2xx.
const CASE_PROBES = [
  ['GET', '/API/live-status'], ['GET', '/Api/deploy/matrix'], ['POST', '/API/validate'], ['DELETE', '/API/uploads'],
  ['POST', '/API/refresh-live'], ['POST', '/API/deploys/x/verify'],
];
async function caseRows(base, headers = {}) {
  const bad = [];
  for (const probe of CASE_PROBES) {
    const r = await call(base, probe, { headers });
    if (r.status >= 200 && r.status < 300 && r.type.includes('application/json')) bad.push(`${probe.join(' ')} → ${r.status} JSON`);
  }
  return bad;
}

const workspaces = [];
const freshWorkspace = (tag) => {
  const ws = mkdtempSync(join(tmpdir(), `observogram-authz-${tag}-`));
  workspaces.push(ws);
  return ws;
};
after(() => { for (const ws of workspaces) rmSync(ws, { recursive: true, force: true }); });

// A live pack planted in an org root, its URL carrying a credential
// parameter and a path; what live-status serves depends on the rank.
const LIVE_URL = 'https://mcp.acme.test/mcp/s/sk-path-secret/obs?token=abc&tier=x';
function plantLivePack(root) {
  makeDir(join(root, 'live'), { recursive: true });
  writeFile(join(root, 'live', 'production-live.pack.yaml'), [
    'apiVersion: observability.pack/v1', 'kind: ObservabilityPack', 'metadata:', '  name: production-live', '  annotations:',
    '    mcp.refreshedAt: "2026-06-06T00:00:00Z"', `    mcp.url: "${LIVE_URL}"`, 'spec: {}', '',
  ].join('\n'));
}
const LIVE_SAFE = 'https://mcp.acme.test/mcp/s/sk-path-secret/obs?tier=x';
const LIVE_ORIGIN = 'https://mcp.acme.test';

// ---- the identity posture ----
//
// users.json + orgs.json, imported at the first start: default {olive, otto,
// owen: admin} makes those three owners. Then, from a shell: otto leaves
// the default org (an owner with no membership); mia joins acme as a
// viewer AFTER bravo (her first membership, bravo, is admin); every user
// signs in once; dan is disabled (his cookie is a disabled user's).
const LOGINS = ['olive', 'otto', 'owen', 'ada', 'oscar', 'vera', 'mia', 'dan', 'bob', 'mallory'];
const pw = (login) => `${login}-passw0rd-authz`;
const OWNERS = new Set(['olive', 'otto', 'owen']);
const MEMBERS = Object.freeze({                  // after the shell steps
  default: { olive: 'admin', owen: 'admin' },
  acme: { ada: 'admin', oscar: 'operator', vera: 'viewer', dan: 'viewer', owen: 'viewer', mia: 'viewer' },
  bravo: { bob: 'admin', mia: 'admin' },
});

function expectIdentity(v, key) {
  const cls = EXPECTED_CLASS[key];
  if (cls === 'public') return 'allowed';
  if (v.anonymous) return '401 auth';
  if (v.bearer) return cls === 'owner' || RANKS.operator < RANKS[cls] ? '403 role' : 'allowed';
  const owner = OWNERS.has(v.login);
  const role = owner ? 'admin' : MEMBERS[v.org]?.[v.login];
  if (!role) return '403 org';
  if (cls === 'owner') return owner ? 'allowed' : '403 role';
  return RANKS[role] >= RANKS[cls] ? 'allowed' : '403 role';
}

test('the AuthZ matrix — identity posture: every /api route × every principal, the org and CSRF vectors', { timeout: 300_000 }, async () => {
  const ws = freshWorkspace('identity');
  writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(ws, 'users.json'));
  writeOrgsFile({
    default: { name: 'Default', members: { olive: 'admin', otto: 'admin', owen: 'admin' } },
    acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer', dan: 'viewer', owen: 'viewer' } },
    bravo: { name: 'Bravo', members: { bob: 'admin', mia: 'admin' } },
  }, join(ws, 'orgs.json'));
  const srv = await serve(ws, { env: { OBSERVOGRAM_API_TOKEN: TOKEN, OBSERVOGRAM_API_TOKEN_LABEL: 'ci-bot' } });
  try {
    for (const [script, args] of [[ORG_ADMIN, ['remove-member', 'default', 'otto']], [ORG_ADMIN, ['add-member', 'acme', 'mia', '--role', 'viewer']]]) {
      const r = cli(script, args, ws);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    }
    const cookies = {};
    for (const login of LOGINS) {
      const s = await signIn(srv.base, login, pw(login));
      assert.equal(s.status, 200, `${login} signs in`);
      cookies[login] = s.session;
    }
    assert.equal(cli(USER_ADMIN, ['remove', 'dan'], ws).status, 0);

    const CSRF = { 'X-Observogram-CSRF': '1' };
    const session = (login, org, extra = {}) => ({
      name: `${login}${org ? `@${org}` : ''}`, login, org: org ?? null,
      headers: { Cookie: cookies[login], ...CSRF, ...(org ? { 'X-Observogram-Org': org } : {}), ...extra },
    });
    const variants = [
      { name: 'anonymous', anonymous: true, headers: { ...CSRF } },
      { name: 'wrong bearer', anonymous: true, headers: { Authorization: 'Bearer not-the-token', 'X-Observogram-Org': 'acme' } },
      { name: 'bearer', bearer: true, headers: { Authorization: `Bearer ${TOKEN}`, 'X-Observogram-Org': 'acme' } },
      { ...session('dan', 'acme'), anonymous: true },
      ...['vera', 'oscar', 'ada', 'olive', 'owen', 'bob', 'mallory', 'mia'].map((l) => session(l, 'acme')),
      { ...session('otto', null), org: 'default' },               // an owner, no membership, no header → the default org
      { ...session('mia', null), org: 'bravo', name: 'mia (no org → her first, bravo)' },
      { ...session('mia', null), org: 'acme', name: 'mia ?org=acme', query: '?org=acme' },
      { ...session('vera', null), org: 'acme', name: 'vera ?org=acme', query: '?org=acme' },
      { ...session('vera', null, { 'X-Tomograph-Org': 'acme' }), org: 'acme', name: 'vera X-Tomograph-Org: acme' },
      { ...session('ada', null), org: 'bravo', name: 'ada ?org=bravo', query: '?org=bravo' },
      { ...session('ada', null, { 'X-Tomograph-Org': 'bravo' }), org: 'bravo', name: 'ada X-Tomograph-Org: bravo' },
      {
        name: 'oscar with X-Tomograph-CSRF only', login: 'oscar', org: 'acme',
        headers: { Cookie: cookies.oscar, 'X-Tomograph-CSRF': '1', 'X-Observogram-Org': 'acme' },
      },
    ];

    const before = await auditSeq(ws);
    const { bad, n } = await sweep(srv.base, variants, expectIdentity);
    assert.deepEqual(bad, [], `${bad.length} of ${n} cells disagree`);
    assert.ok(n >= variants.length * 40, `${n} requests`);

    // The refusal texts a person sees.
    let r = await call(srv.base, PROBES['POST /api/validate'], { headers: variants.find((v) => v.name === 'vera@acme').headers });
    assert.deepEqual([r.status, r.json.denied, r.json.error, r.json.need, r.json.role, r.json.org],
      [403, 'role', "requires the operator role in org 'acme' (you are viewer) — ask an admin of acme", 'operator', 'viewer', 'acme']);
    r = await call(srv.base, PROBES['POST /api/validate'], { headers: variants.find((v) => v.name === 'mallory@acme').headers });
    assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'org', 'no org membership — ask an admin to add you']);
    r = await call(srv.base, PROBES['GET /api/packs'], { headers: variants.find((v) => v.name === 'bob@acme').headers });
    assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'org', "not a member of org 'acme'"]);
    r = await call(srv.base, PROBES['GET /api/packs'], { headers: {} });
    assert.deepEqual([r.status, r.json.denied, r.json.login], [401, 'auth', '/auth/login']);

    // CSRF rows: a session's mutation without the header → 403 csrf; the bearer needs none.
    const noCsrf = [];
    for (const login of ['ada', 'olive']) {
      for (const [key, probe] of Object.entries(PROBES)) {
        if (probe[0] === 'GET') continue;
        const res = await call(srv.base, probe, { headers: { Cookie: cookies[login], 'X-Observogram-Org': 'acme' } });
        if (outcome(res) !== '403 csrf') noCsrf.push(`${login} ${key}: ${outcome(res)}`);
      }
    }
    assert.deepEqual(noCsrf, [], 'a session mutation without the CSRF header');
    for (const [key, probe] of Object.entries(PROBES)) {
      if (probe[0] === 'GET') continue;
      const res = await call(srv.base, probe, { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Observogram-Org': 'acme' } });
      assert.equal(outcome(res), 'allowed', `bearer without the CSRF header: ${key}`);
    }

    // Case rows: /API/… is never a handler.
    assert.deepEqual(await caseRows(srv.base), [], 'anonymous /API/…');
    assert.deepEqual(await caseRows(srv.base, variants.find((v) => v.name === 'ada@acme').headers), [], 'ada /API/…');

    // Refused requests (and every probe) wrote nothing.
    assert.equal(await auditSeq(ws), before, 'the matrix wrote no audit row');

    // What the org lists say (§4.2): role = the membership's, effectiveRole = the guard's.
    const orgsOf = async (headers) => (await call(srv.base, ['GET', '/api/orgs'], { headers })).json;
    let o = await orgsOf(variants.find((v) => v.name === 'owen@acme').headers);
    assert.equal(o.active, 'acme');
    assert.deepEqual(o.orgs.find((x) => x.id === 'acme'), { id: 'acme', name: 'Acme', role: 'viewer', effectiveRole: 'admin' });
    o = await orgsOf(variants.find((v) => v.name === 'olive@acme').headers);
    assert.deepEqual(o.orgs.find((x) => x.id === 'acme'), { id: 'acme', name: 'Acme', role: null, effectiveRole: 'admin' }, 'an owner\'s active org is listed');
    o = await orgsOf(variants.find((v) => v.name === 'bearer').headers);
    assert.ok(o.orgs.every((x) => x.role === 'service-account' && x.effectiveRole === 'operator'), JSON.stringify(o.orgs));
    o = await orgsOf(variants.find((v) => v.name === 'vera@acme').headers);
    assert.deepEqual(o.orgs, [{ id: 'acme', name: 'Acme', role: 'viewer', effectiveRole: 'viewer' }]);
    const me = (await call(srv.base, ['GET', '/auth/me'], { headers: { Cookie: cookies.owen } })).json;
    assert.deepEqual(me.orgs.map((x) => [x.id, x.role, x.effectiveRole]), [['default', 'admin', 'admin'], ['acme', 'viewer', 'admin']]);

    // live-status by rank: `origin` to every reader, the safe `url` to an
    // operator and above — a viewer never sees the path.
    plantLivePack(join(ws, 'orgs', 'acme'));
    const liveFor = async (name) => (await call(srv.base, ['GET', '/api/live-status'], { headers: variants.find((v) => v.name === name).headers })).json;
    for (const name of ['vera@acme', 'mia@acme']) {
      const l = await liveFor(name);
      assert.deepEqual([l.present, l.origin, l.url], [true, LIVE_ORIGIN, null], `${name}: origin only`);
    }
    for (const name of ['oscar@acme', 'bearer', 'ada@acme', 'owen@acme']) {
      const l = await liveFor(name);
      assert.deepEqual([l.present, l.origin, l.url], [true, LIVE_ORIGIN, LIVE_SAFE], `${name}: the safe url`);
    }
    assert.equal((await liveFor('mia (no org → her first, bravo)')).present, false, 'bravo has no live pack: acme\'s is not read');

    // Public rows, anonymous.
    const pub = async (method, path, init = {}) => fetch(`${srv.base}${path}`, { method, redirect: 'manual', ...init });
    assert.equal((await pub('GET', '/healthz')).status, 200);
    assert.equal((await pub('GET', '/api/version')).status, 200);
    for (const path of ['/', '/some/deep/link']) {
      const res = await pub('GET', path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type') || '', /text\/html/, path);
    }
    assert.equal((await pub('GET', '/lib/mini-yaml.mjs')).status, 200);
    assert.equal((await pub('GET', '/auth/login')).status, 200);
    const anonMe = await pub('GET', '/auth/me');
    assert.equal(anonMe.status, 200);
    assert.equal((await anonMe.json()).authenticated, false);
    assert.equal((await pub('POST', '/auth/logout')).status, 204);

    // Form rows: a cross-site or same-site post to /auth/login is refused
    // before the password is read; same-origin and none keep today's answers.
    const loginForm = (site, accept = 'application/json') => pub('POST', '/auth/login', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: accept, ...(site ? { 'Sec-Fetch-Site': site } : {}) },
      body: `username=ada&password=${encodeURIComponent(pw('ada'))}`,
    });
    for (const site of ['cross-site', 'same-site']) {
      const res = await loginForm(site);
      const j = await res.json();
      assert.deepEqual([res.status, j.denied], [403, 'csrf'], site);
      assert.equal(j.error, `this form accepts posts from this server's own pages only (Sec-Fetch-Site: ${site}) — open /auth/login on this server and submit it there`);
    }
    const plain = await loginForm('cross-site', 'text/html');
    assert.equal(plain.status, 403);
    assert.match(plain.headers.get('content-type') || '', /text\/plain/);
    for (const site of ['same-origin', 'none', null]) assert.equal((await loginForm(site)).status, 200, String(site));

    // Existing routes write no audit rows yet (their rows are slices 4–5).
    const oscar = variants.find((v) => v.name === 'oscar@acme').headers;
    const yaml = readFileSync(join(REPO, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');
    const seq = await auditSeq(ws);
    const reg = await call(srv.base, PROBES['POST /api/validate'], { headers: { ...oscar, 'Content-Type': 'application/x-yaml' }, body: yaml });
    assert.equal(reg.json?.ok, true, reg.text.slice(0, 200));
    const id = reg.json.registered.id;
    const cap = await call(srv.base, ['POST', '/api/journeys/capture'], { headers: oscar, body: JSON.stringify({ name: 'authz-capture', packAId: id, packBId: id }) });
    assert.equal(cap.json?.ok, true, cap.text.slice(0, 200));
    const wipe = await call(srv.base, ['DELETE', '/api/uploads'], { headers: oscar });
    assert.equal(wipe.json?.dropped >= 1, true, wipe.text);
    assert.equal(await auditSeq(ws), seq, 'validate, capture and reset wrote no audit row');
  } finally {
    await srv.stop();
  }
});

// ---- the token posture ----
function expectToken(v, key) {
  const cls = EXPECTED_CLASS[key];
  if (cls === 'public') return 'allowed';
  if (v.bearer) return cls === 'owner' || RANKS.operator < RANKS[cls] ? '403 role' : 'allowed';
  if (key.split(' ')[0] !== 'GET') return '401 auth';
  return cls === 'viewer' ? 'allowed' : '403 role';
}

test('the AuthZ matrix — token posture: anonymous reads, the bearer an operator', { timeout: 120_000 }, async () => {
  const ws = freshWorkspace('token');
  const srv = await serve(ws, { env: { OBSERVOGRAM_API_TOKEN: TOKEN, OBSERVOGRAM_API_TOKEN_LABEL: 'ci-bot' } });
  try {
    const variants = [
      { name: 'anonymous', headers: {} },
      { name: 'bearer', bearer: true, headers: { Authorization: `Bearer ${TOKEN}` } },
      { name: 'wrong bearer', headers: { Authorization: 'Bearer not-the-token' } },
    ];
    const before = await auditSeq(ws);
    const { bad, n } = await sweep(srv.base, variants, expectToken);
    assert.deepEqual(bad, [], `${bad.length} of ${n} cells disagree`);
    assert.deepEqual(await caseRows(srv.base), []);
    assert.deepEqual(await caseRows(srv.base, variants[1].headers), []);
    assert.equal(await auditSeq(ws), before);
    const o = (await call(srv.base, ['GET', '/api/orgs'])).json;
    assert.deepEqual(o.orgs, [{ id: 'default', name: 'Default', role: null, effectiveRole: 'viewer' }]);
    // live-status by rank: an anonymous caller (a viewer) gets the origin only; the bearer the safe url.
    plantLivePack(ws);
    let l = (await call(srv.base, ['GET', '/api/live-status'])).json;
    assert.deepEqual([l.present, l.origin, l.url], [true, LIVE_ORIGIN, null]);
    l = (await call(srv.base, ['GET', '/api/live-status'], { headers: variants[1].headers })).json;
    assert.deepEqual([l.present, l.origin, l.url], [true, LIVE_ORIGIN, LIVE_SAFE]);
    // Stand-alone sign-in is off (nothing seeded): the self routes are
    // registered, and selfGate's first step answers 404 whatever the
    // caller carries — not a redirect to /auth/login, not a 401.
    for (const probe of [['GET', '/auth/change-password'], ['POST', '/auth/change-password'], ['POST', '/auth/change-password/skip']]) {
      for (const headers of [{}, { ...variants[1].headers, 'X-Observogram-CSRF': '1' }]) {
        const r = await call(srv.base, probe, { headers });
        assert.deepEqual([r.status, r.json], [404, { ok: false, error: 'identity not configured' }], `${probe.join(' ')} ${JSON.stringify(headers)}`);
      }
    }
  } finally {
    await srv.stop();
  }
});

// ---- the open postures: every existing route, as today ----
const OPEN = [
  { tag: 'open-loopback', host: '127.0.0.1', env: { OBSERVOGRAM_AUTH: 'off' } },
  {
    tag: 'open-exposed-a', host: '0.0.0.0', env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_INSECURE_NO_AUTH: '1' },
    setup: (ws) => writeUsersFile({ users: { solo: { name: 'solo', createdAt: 'test', password: hashPassword(pw('solo')) } } }, join(ws, 'users.json')),
  },
  { tag: 'open-exposed-b', host: '0.0.0.0', env: { OBSERVOGRAM_INSECURE_NO_AUTH: '1' } },
];
for (const posture of OPEN) {
  test(`the AuthZ matrix — ${posture.tag}: local is an owner; every existing route answers, with or without the CSRF header`, { timeout: 120_000 }, async () => {
    const ws = freshWorkspace(posture.tag);
    posture.setup?.(ws);
    const srv = await serve(ws, { host: posture.host, env: posture.env });
    try {
      const variants = [{ name: 'local', headers: {} }, { name: 'local + CSRF', headers: { 'X-Observogram-CSRF': '1' } }];
      const before = await auditSeq(ws);
      const { bad, n } = await sweep(srv.base, variants, () => 'allowed');
      assert.deepEqual(bad, [], `${bad.length} of ${n} cells disagree`);
      assert.deepEqual(await caseRows(srv.base), []);
      assert.equal(await auditSeq(ws), before);
      const o = (await call(srv.base, ['GET', '/api/orgs'])).json;
      assert.deepEqual(o.orgs, [{ id: 'default', name: 'Default', role: null, effectiveRole: 'admin' }]);
    } finally {
      await srv.stop();
    }
  });
}

// ---- a fresh loopback boot: the seeded admin/admin and its forced change ----
test('fresh loopback boot: the pwflow cookie alone reaches the forced change and its skip, never /api; a same-site form post is refused', { timeout: 120_000 }, async () => {
  const ws = freshWorkspace('fresh');
  const srv = await serve(ws);
  try {
    let s = await signIn(srv.base, 'admin', 'admin');
    assert.ok(s.pwflow && !s.session, 'admin/admin gets the pwflow cookie, no session');
    let r = await fetch(`${srv.base}/auth/change-password`, { headers: { Cookie: s.pwflow }, redirect: 'manual' });
    assert.equal(r.status, 200);
    assert.match(await r.text(), /formaction="\/auth\/change-password\/skip"/, 'the skip control');
    r = await fetch(`${srv.base}/api/packs`, { headers: { Cookie: s.pwflow, Accept: 'application/json' } });
    assert.equal(r.status, 401, 'the pwflow cookie is not a session');

    // A sibling subdomain's auto-submitted form: refused, and nothing set.
    const form = (cookie, site, path = '/auth/change-password') => fetch(`${srv.base}${path}`, {
      method: 'POST', redirect: 'manual',
      headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(site ? { 'Sec-Fetch-Site': site } : {}) },
      body: 'password=attacker-chosen-1&repeat=attacker-chosen-1',
    });
    r = await form(s.pwflow, 'same-site');
    assert.equal(r.status, 403);
    assert.equal((await r.json()).denied, 'csrf');
    r = await form(s.pwflow, 'cross-site', '/auth/change-password/skip');
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /open \/auth\/change-password on this server/);
    s = await signIn(srv.base, 'admin', 'admin');
    assert.ok(s.pwflow, 'the old password still reaches the forced change');

    r = await fetch(`${srv.base}/auth/change-password/skip`, { method: 'POST', headers: { Cookie: s.pwflow }, redirect: 'manual' });
    assert.equal(r.status, 302);
    const session = (r.headers.getSetCookie?.() || []).find((c) => c.startsWith('observogram_session='))?.split(';')[0];
    assert.ok(session, 'the skip issues a session');
    r = await fetch(`${srv.base}/api/packs`, { headers: { Cookie: session } });
    assert.equal(r.status, 200);
  } finally {
    await srv.stop();
  }
});
