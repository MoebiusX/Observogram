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
 *   Run all say a refusal; the account menu's "sign out my other
 *   sessions" says its answer;
 * - completeness: three children (local, oidc, off) walk the app's router
 *   (server/fixtures/route-inventory.mjs); every route's first handler, per
 *   method, is its own authorize() guard, every key is in
 *   server/route-table.mjs for its mode and agrees with EXPECTED_CLASS
 *   below, only the named middleware and the static mounts sit between;
 *   the README's API Surface states each of its rows' class as the table has it,
 *   its Identity API section states the audit actor (the first local user's
 *   owner grant keeps `system`) and lists every identity route with its class, and
 *   its Roles section each orgs.json role the import maps to admin or viewer;
 *   docs/STORE_PLAN.md's build status and docs/HANDOVER.md name one next
 *   slice; no comment in server/ or tools/ still says roles are not enforced;
 * - the decision (authzDecision), pure, over synthetic entries — the
 *   always / refuse / rule / direct-loopback paths no route has yet — and
 *   the request facts it reads (the CSRF header, a cross-site form, a
 *   direct loopback request); the `direct` / `closedAs` entry of the MCP
 *   endpoint changes (slice 4: the identity API's defences without its
 *   texts' CLI way out); selfGate's CSRF step, on the entry of
 *   POST /auth/signout-others; the guard's 500 for
 *   a classified route reached without a principal (fail closed);
 * - the AuthZ matrix: every /api route × every principal × every posture,
 *   each a child server (server/fixtures/serve-child.mjs), its expectations
 *   from EXPECTED_CLASS and the fixture's own membership table, never from
 *   the server; refused requests write no audit row; plus the CSRF, form,
 *   public, case, org-list and fresh admin/admin rows; the self routes'
 *   404 while stand-alone sign-in is off (selfGate's first step); the
 *   self rows of POST /auth/signout-others (the caller's own session with
 *   the CSRF header — never anonymous, the bearer, a disabled user or the
 *   pwflow cookie; its other cookies refused, its own re-issued);
 * - the identity API in that matrix (slice 3b): an owner with no
 *   membership reaches the owner routes, everyone else is refused; the
 *   admin routes answer the context org's admins and every owner, and an
 *   org admin never reaches another org's members (a member of another org
 *   is "not a member" here; naming that org is 403 org); without
 *   sign-in they answer only a request sent straight to loopback (a
 *   foreign Host, a proxy header or a foreign Origin → 403 posture, over
 *   node:http) and every mutation needs the CSRF header; the open-loopback
 *   identity writes and their audit rows (actor local; system for the
 *   first local user's grant); Arming, the API half (an exposed server
 *   seeded with OBSERVOGRAM_ADMIN_PASSWORD never answers an anonymous read
 *   while its users change);
 * - the MCP endpoint rows in that matrix (slice 4): POST /api/mcp-endpoints
 *   closed when exposed, a direct loopback request with the header only
 *   without sign-in (its own texts), the CSRF header from every session;
 *   GET /api/mcp-endpoints by rank (the url and the variable to operators
 *   and above, null to a viewer) on an endpoint planted by a repository
 *   call; the open-loopback create by `local` and its audit row.
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
  csrfAlwaysText,
} = await import('./authz.mjs');
const { openStore, closeStore, currentStore } = await import('./store/db.mjs');
const { createUser } = await import('./store/users.mjs');
const { setMeta } = await import('./store/meta.mjs');
const { createOrg } = await import('./store/orgs.mjs');
const { addMembership } = await import('./store/memberships.mjs');
const { ensureDefaultOrg, mapLegacyRole } = await import('./store/identity.mjs');
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
// Synthetic entries: the always / refuse / rule / direct-loopback paths
// proved on the function the guard calls, whatever routes the table holds
// (the matrix below proves them again over the identity API's routes).

// `direct` and `closedAs` default as routeEntry() fills them: the identity
// API is direct, named 'the identity API'.
const synth = (fields) => ({ csrf: 'none', exposed: 'allow', identityApi: false, direct: fields.identityApi === true, closedAs: 'the identity API', ...fields });
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
  // The MCP endpoint changes (slice 4): the identity API's defences, not the identity API.
  const mcpWrite = synth({ class: 'admin', direct: true, csrf: 'always', exposed: 'refuse', closedAs: 'the MCP endpoints' });
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
    // a direct entry outside the identity API: closed when exposed, a direct
    // loopback request with the header only, the admin role with the header
    [mcpWrite, ctxOf('open-exposed', P.local), '403 posture'],
    [mcpWrite, ctxOf('open-loopback', P.local), 'allow'],
    [mcpWrite, ctxOf('open-loopback', P.local, { direct: false }), '403 posture'],
    [mcpWrite, ctxOf('open-loopback', P.local, { csrf: false }), '403 csrf'],
    [mcpWrite, ctxOf('identity', P.admin, { direct: false }), 'allow'],
    [mcpWrite, ctxOf('identity', P.admin, { csrf: false }), '403 csrf'],
    [mcpWrite, ctxOf('identity', P.owner), 'allow'],
    [mcpWrite, ctxOf('identity', P.operator), '403 role'],
    [mcpWrite, ctxOf('identity', P.bearer, { csrf: false }), '403 role'],
    [mcpWrite, ctxOf('token', P.anon), '403 role'],
  ];
  for (const [entry, ctx, want] of rows) {
    assert.equal(verdict(authzDecision(entry, ctx)), want, `${JSON.stringify(entry)} × ${ctx.posture} ${ctx.principal.kind}/${ctx.principal.role} csrf=${ctx.csrf} direct=${ctx.direct}`);
  }
});

test('authzDecision: every refusal names a way out', () => {
  const ownerApi = synth({ class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse' });
  const adminApi = synth({ class: 'admin', identityApi: true, csrf: 'always', exposed: 'refuse' });
  const mcpWrite = synth({ class: 'admin', direct: true, csrf: 'always', exposed: 'refuse', closedAs: 'the MCP endpoints' });
  const opWrite = synth({ class: 'operator', csrf: 'session' });
  const text = (entry, ctx) => authzDecision(entry, ctx).body.error;
  assert.equal(text(ownerApi, ctxOf('open-exposed', P.local, { authOff: true })),
    'the identity API is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1, OBSERVOGRAM_AUTH=off): restart it without OBSERVOGRAM_AUTH=off and sign in as an owner, or bind it to loopback');
  assert.equal(text(ownerApi, ctxOf('open-exposed', P.local)),
    'the identity API is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1): add the first user with npm run users -- add <login> (it arms sign-in without a restart; the first local user is an owner), or configure OIDC');
  assert.equal(text(ownerApi, ctxOf('open-loopback', P.local, { direct: false, port: 8123 })),
    'on a server without sign-in the identity API answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:8123, or use the CLIs from this machine (npm run users -- add <login>, passwd <login>, owner <login>)');
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
  // The MCP endpoint changes: the same refusals named after them — and no
  // CLI way out (no CLI manages endpoints).
  assert.equal(text(mcpWrite, ctxOf('open-exposed', P.local, { authOff: true })),
    'the MCP endpoints is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1, OBSERVOGRAM_AUTH=off): restart it without OBSERVOGRAM_AUTH=off and sign in as an owner, or bind it to loopback');
  assert.equal(text(mcpWrite, ctxOf('open-exposed', P.local)),
    'the MCP endpoints is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1): add the first user with npm run users -- add <login> (it arms sign-in without a restart; the first local user is an owner), or configure OIDC');
  assert.equal(text(mcpWrite, ctxOf('open-loopback', P.local, { direct: false, port: 8123 })),
    'on a server without sign-in the MCP endpoints answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:8123');
  assert.equal(text(mcpWrite, ctxOf('identity', P.admin, { csrf: false })),
    "missing X-Observogram-CSRF: 1 — changes to the MCP endpoints need it in every posture, so a cross-site form cannot make them (the studio sends it; with curl add -H 'X-Observogram-CSRF: 1')");
  assert.equal(text(mcpWrite, ctxOf('identity', P.operator)), "requires the admin role in org 'acme' (you are operator) — ask an admin of acme");
  assert.equal(csrfAlwaysText(adminApi), text(ownerApi, ctxOf('identity', P.owner, { csrf: false })), 'csrfAlwaysText: the identity text, byte for byte');
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
  // Every proxy header the refusal text names; X-Forwarded-* is the whole prefix.
  for (const proxy of ['forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'x-forwarded-prefix', 'x-real-ip', 'X-Forwarded-Proto',
    // The client-IP headers a CDN or a tunnel adds instead of X-Forwarded-For.
    'cf-connecting-ip', 'CF-Connecting-IPv6', 'true-client-ip', 'x-client-ip', 'x-cluster-client-ip', 'fastly-client-ip', 'x-azure-clientip', 'x-original-forwarded-for']) {
    assert.equal(direct({ ...h, [proxy]: '203.0.113.9' }), false, proxy);
  }
  assert.equal(direct({ ...h, 'x-forwarded-proto': undefined }), true, 'a header object\'s absent value is no header');
  assert.equal(direct({ ...h, 'x-forwardedness': '1', 'user-agent': 'curl/8', accept: '*/*' }), true, 'only the proxy headers');
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

test('selfGate: an always-CSRF self route (POST /auth/signout-others) refuses the caller\'s own session without the header', async () => {
  const { createHmac } = await import('node:crypto');
  const { routeEntry } = await import('./route-table.mjs');
  const db = currentStore();
  const selfie = createUser(db, 'system', { login: 'selfie' });
  setMeta(db, 'system', 'identity_armed', '1');
  const secret = 'authz-suite-session-secret-0123456789-abc';
  const cookie = (() => {
    const body = Buffer.from(JSON.stringify({ sub: 'selfie', login: 'selfie', ep: selfie.sessionEpoch, purpose: 'session', iat: Date.now(), exp: Date.now() + 3600_000 })).toString('base64url');
    return `observogram_session=v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
  })();
  const entry = routeEntry('POST /auth/signout-others');
  assert.deepEqual([entry.class, entry.csrf, entry.modes, entry.self], ['self', 'always', ['local', 'oidc'], { pwflow: false, session: true, unauth: 'json' }]);
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

// The account menu's "sign out my other sessions" posts to its self route
// and says the answer on the menu's id line: done, or the server's text.
const { signOutOthersText } = await import('../studio/api.mjs');

test('the account menu\'s "sign out my other sessions": the route it posts to, and what its id line says', async () => {
  const { routeEntry } = await import('./route-table.mjs');
  assert.equal(signOutOthersText(200, { ok: true, sessionEpoch: 3 }), 'other sessions signed out');
  assert.equal(signOutOthersText(401, { ok: false, error: 'unauthorized: sign in required', login: '/auth/login', denied: 'auth' }),
    '401: unauthorized: sign in required');
  assert.equal(signOutOthersText(403, { ok: false, error: 'missing X-Observogram-CSRF: 1 — …', denied: 'csrf' }), '403: missing X-Observogram-CSRF: 1 — …');
  assert.equal(signOutOthersText(0, { error: 'Failed to fetch' }), 'Failed to fetch', 'no answer: the network\'s text');
  assert.equal(signOutOthersText(502, null), '502: the other sessions were not signed out');
  assert.equal(signOutOthersText(200, null), '200: the other sessions were not signed out', 'a 200 that is not the route\'s answer');

  const fn = functionSource(withoutComments(readFileSync(join(STUDIO, 'app.mjs'), 'utf8')), 'setupIdentityChip');
  const at = (s) => { const i = fn.indexOf(s); assert.ok(i >= 0, `setupIdentityChip has ${s}`); return i; };
  assert.ok(at('>change password…</a>') < at('class="hdr-user-menu-item hdr-user-others">sign out my other sessions</button>'), 'after change password…');
  assert.ok(at('hdr-user-others">sign out my other sessions</button>') < at('class="hdr-user-menu-item hdr-user-out">sign out</button>'), 'before sign out');
  assert.match(fn, /fetch\('\/auth\/signout-others', \{ method: 'POST', headers: \{ Accept: 'application\/json', \.\.\.authHeaders\(\) \} \}\)/);
  assert.equal(routeEntry('POST /auth/signout-others').class, 'self', 'the route it posts to');
  assert.match(fn, /chip\.querySelector\('\.hdr-user-menu-id'\)\.textContent = signOutOthersText\(status, body\);/);
});

// The account menu is on every screen. setupIdentityChip mounts it in the
// chrome's action cluster (.observa-hdr .observa-actions), which boot mounts
// first and no mode rule hides. The context bar (.hdr) it used to sit in IS
// hidden on the home and Build screens — where a signed-in user then had no
// way to sign out or change a password until a pack was open.
test('the account menu mounts in the one bar every screen shows — not the context bar the home and Build screens hide', () => {
  const src = withoutComments(readFileSync(join(STUDIO, 'app.mjs'), 'utf8'));
  const fn = functionSource(src, 'setupIdentityChip');
  assert.match(fn, /const actions = document\.querySelector\('\.observa-hdr \.observa-actions'\);/, 'the chrome\'s action cluster');
  assert.match(fn, /\n {2}actions\.appendChild\(chip\);\n\}$/, 'the chip is its last child');
  assert.doesNotMatch(fn, /insertBefore\(chip,/, 'not beside the theme toggle in the context bar');
  const boot = functionSource(src, 'boot');
  const chromeAt = boot.indexOf('installObservaChrome();');
  assert.ok(chromeAt >= 0 && chromeAt < boot.indexOf('setupIdentityChip();'), 'boot mounts the chrome before the chip');
  // Beside the tabs the chip's name gives way — ten characters at a laptop
  // width, the glyph at phone width — so the tabs keep their room and the
  // popover stays on screen. The cap is on the name, never the button: the
  // glyph and the caret that marks it a menu stay. (The chrome's height is
  // measured by syncContextBarHeight, so a chrome the chip makes taller still
  // has the context bar flush under it.)
  assert.match(functionSource(src, 'syncContextBarHeight'), /setProperty\('--observa-chrome-h',/, 'the chrome\'s height is measured, not assumed');
  assert.doesNotMatch(src, /trackChromeHeight/, 'by one measurer, not two');
  // Its outside-click closer listens on the way down: the Advanced toggle
  // beside it stops its click from bubbling, and both menus stayed open.
  assert.match(fn, /document\.addEventListener\('click', \(e\) => \{ if \(!chip\.contains\(e\.target\)\) setOpen\(false\); \}, true\);/, 'opening Advanced closes the account menu');
  assert.match(fn, /<span class="hdr-user-name">\$\{escapeHtml\(me\.name \|\| me\.email \|\| me\.sub\)\}<\/span>/, 'the name is its own span, so a stylesheet can let it give way');
  const ux = readFileSync(join(STUDIO, 'ux.css'), 'utf8');
  const at1280 = ux.indexOf('@media (max-width: 1280px) {');
  const cap = ux.indexOf('.observa-actions .hdr-user-name { display: inline-block; max-width: 10ch;');
  assert.ok(!ux.includes('.observa-actions .hdr-user-btn { max-width'), 'the button itself is not capped: that clipped the caret');
  const at720 = ux.search(/@media \(max-width: 720px\) \{\r?\n\s*\.observa-actions \.hdr-user-name \{ position: absolute; width: 1px;/);
  assert.ok(at1280 >= 0 && cap > at1280 && at720 > cap, 'the chip gives way at a laptop width (ten characters) and at phone width (its glyph)');

  // Every selector a mode rule hides, from every studio stylesheet.
  const hidden = [];
  for (const f of readdirSync(STUDIO).filter((n) => n.endsWith('.css'))) {
    const css = readFileSync(join(STUDIO, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(display\s*:\s*none|visibility\s*:\s*hidden)/.test(m[2])) continue;
      for (const sel of m[1].split(',')) if (sel.includes('[data-mode=')) hidden.push(sel.trim());
    }
  }
  for (const mode of ['home', 'build']) {
    assert.ok(hidden.some((s) => s.endsWith(`[data-mode="${mode}"] .hdr`)), `the context bar is hidden in ${mode} mode (why the menu moved)`);
  }
  for (const s of hidden) assert.doesNotMatch(s, /observa-hdr|observa-actions|hdr-user/, `a mode rule hides the account menu's bar: ${s}`);
});

// The deploy modal's saved targets (studio/api.mjs): per user, each MCP
// URL stripped as the remembered URL is, the pre-slice-3 browser-wide key
// adopted once, every key gone at sign-out. The rule is tools/lib's
// (server/mcp-url.mjs re-exports it), handed in as the studio hands in the
// one it loads from /lib.
const { deployProfilesKey, safeDeployProfile, migrateDeployProfiles, deployProfileSavedText, forgetMcpUrls, setSignedInLogin, setActiveOrg } = await import('../studio/api.mjs');

test('deploy target profiles keep no credential: per user, stripped like the remembered URL, the v1 key adopted once, cleared at sign-out', async () => {
  const { stripMcpUrl, droppedNote } = await import('./mcp-url.mjs');

  // The key: per user, not per org — a profile is a destination, not org data.
  assert.equal(deployProfilesKey('ada'), 'deployProfiles.v2:ada');
  assert.equal(deployProfilesKey(null), 'deployProfiles.v2:local', 'the open and token postures');
  assert.equal(deployProfilesKey(''), 'deployProfiles.v2:local');

  // One profile as it may be stored: each URL's safe form — the MCP URL, and
  // the target URL by the same rule — the rest as given; nothing at all when
  // what was typed is no URL (no name rule can read it).
  const kept = { dropped: [], notUrl: false, droppedTarget: [], targetNotUrl: false };
  assert.deepEqual(safeDeployProfile({ folder: 'obs', product: 'grafana', mcpUrl: ' https://u:p@mcp.test/obs?api_key=X&tier=y#f ' }, stripMcpUrl),
    { ...kept, profile: { folder: 'obs', product: 'grafana', targetUrl: '', mcpUrl: 'https://mcp.test/obs?tier=y' }, dropped: ['api_key'] });
  assert.deepEqual(safeDeployProfile({ mcpUrl: 'https://mcp.test/obs?token=A&pwd=B' }, stripMcpUrl),
    { ...kept, profile: { targetUrl: '', mcpUrl: 'https://mcp.test/obs' }, dropped: ['token', 'pwd'] });
  assert.deepEqual(safeDeployProfile({ mcpUrl: 'mcp.test/obs?token=abc' }, stripMcpUrl), { ...kept, profile: { targetUrl: '', mcpUrl: '' }, notUrl: true }, 'no scheme: not a URL, not kept');
  assert.deepEqual(safeDeployProfile({ mcpUrl: '' }, stripMcpUrl), { ...kept, profile: { targetUrl: '', mcpUrl: '' } }, 'no URL typed');
  assert.deepEqual(safeDeployProfile({ folder: 'obs' }, stripMcpUrl), { ...kept, profile: { folder: 'obs', targetUrl: '', mcpUrl: '' } });
  assert.deepEqual(safeDeployProfile(null, stripMcpUrl), { ...kept, profile: { targetUrl: '', mcpUrl: '' } });
  // The target URL (Grafana, kept for the profile's notes — never sent) can carry a credential too.
  assert.deepEqual(safeDeployProfile({ targetUrl: 'https://admin:hunter2@grafana.test/?api_key=K&orgId=1#dash', mcpUrl: 'https://mcp.test/obs' }, stripMcpUrl),
    { ...kept, profile: { targetUrl: 'https://grafana.test/?orgId=1', mcpUrl: 'https://mcp.test/obs' }, droppedTarget: ['api_key'] }, 'the target URL, by the same rule');
  assert.deepEqual(safeDeployProfile({ targetUrl: 'grafana.test' }, stripMcpUrl), { ...kept, profile: { targetUrl: '', mcpUrl: '' }, targetNotUrl: true }, 'a target that is no URL: not kept');

  // The status line: the lib's wording (the refresh note's), pointing at the auth field; nothing when stored as typed.
  assert.equal(deployProfileSavedText('Prod', { dropped: ['api_key'] }, droppedNote),
    'profile "Prod" saved · not kept in the profile: the "api_key" parameter of the MCP URL, which looks like a credential — put a token in the auth field instead');
  assert.equal(deployProfileSavedText('Prod', { dropped: ['token', 'pwd'] }, droppedNote),
    'profile "Prod" saved · not kept in the profile: the "token", "pwd" parameters of the MCP URL, which look like credentials — put a token in the auth field instead');
  assert.equal(deployProfileSavedText('Prod', { notUrl: true }, droppedNote), 'profile "Prod" saved · not kept in the profile: the MCP URL, which is not a URL (scheme://host/…)');
  assert.equal(deployProfileSavedText('Prod', { dropped: [] }, droppedNote), null);
  assert.equal(deployProfileSavedText('Prod', {}, droppedNote), null);
  // What the target URL lost is named apart, without the auth-field pointer (nothing of it is sent).
  assert.equal(deployProfileSavedText('Prod', { droppedTarget: ['api_key'] }, droppedNote),
    'profile "Prod" saved · not kept in the profile: the "api_key" parameter of the target URL, which looks like a credential');
  assert.equal(deployProfileSavedText('Prod', { dropped: ['token'], targetNotUrl: true }, droppedNote),
    'profile "Prod" saved · not kept in the profile: the "token" parameter of the MCP URL, which looks like a credential — put a token in the auth field instead · not kept in the profile: the target URL, which is not a URL (scheme://host/…)');

  // The pre-slice-3 map: every URL stripped, a name this user already has keeps the stored profile, garbage is {}.
  const v1 = JSON.stringify({
    Prod: { targetUrl: 'https://admin:hunter2@grafana.test/?api_key=K', folder: 'obs', product: 'grafana', version: '12', mcpUrl: 'https://u:p@mcp.test/obs?token=SECRET&tier=gold#f' },
    Local: { mcpUrl: 'mcp.test/obs?token=abc' },
    Bare: { folder: 'x' },
    junk: 'not a profile',
  });
  const m = migrateDeployProfiles(v1, null, stripMcpUrl);
  assert.deepEqual(m, {
    profiles: {
      Prod: { targetUrl: 'https://grafana.test/', folder: 'obs', product: 'grafana', version: '12', mcpUrl: 'https://mcp.test/obs?tier=gold' },
      Local: { targetUrl: '', mcpUrl: '' },
      Bare: { folder: 'x', targetUrl: '', mcpUrl: '' },
    },
    dropped: { Prod: ['token'] },
    droppedTarget: { Prod: ['api_key'] },
  });
  for (const secret of ['SECRET', 'abc', 'u:p@', 'hunter2', 'api_key=K']) assert.ok(!JSON.stringify(m).includes(secret), `no credential survives the migration: ${secret}`);
  const m2 = migrateDeployProfiles(v1, JSON.stringify({ Prod: { mcpUrl: 'https://mcp.test/new' }, Stage: { mcpUrl: 'https://mcp.test/stage' } }), stripMcpUrl);
  assert.deepEqual(Object.keys(m2.profiles).sort(), ['Bare', 'Local', 'Prod', 'Stage']);
  assert.deepEqual(m2.profiles.Prod, { mcpUrl: 'https://mcp.test/new' }, 'the stored profile wins: already safe, and the newer');
  for (const [legacy, current] of [['not json', '[1]'], [null, null], ['[1,2]', '"x"'], ['null', '{"a":1}']]) {
    assert.deepEqual(migrateDeployProfiles(legacy, current, stripMcpUrl).profiles, {}, `garbage: ${legacy} / ${current}`);
  }

  // Sign-out: this login's remembered URLs, every deploy profile key (every user's, and v1), nothing else.
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  try {
    setSignedInLogin('ada');
    setActiveOrg('acme');
    assert.equal(deployProfilesKey(), 'deployProfiles.v2:ada', 'the active org is not in the key');
    for (const [k, v] of [
      ['mcpUrl.v2:ada:acme', 'https://mcp.acme.test/obs'], ['mcpUrl.v2:ada:bravo', 'https://mcp.bravo.test/obs'], ['mcpUrl.v2:bob:acme', 'https://mcp.bob.test/obs'], ['mcpUrl', 'x'],
      ['deployProfiles.v2:ada', '{}'], ['deployProfiles.v2:bob', '{}'], ['deployProfiles.v2:local', '{}'], ['deployProfiles.v1', '{}'],
      ['studioTheme', 'dark'],
    ]) store.set(k, v);
    forgetMcpUrls('ada');
    assert.deepEqual([...store.keys()].sort(), ['mcpUrl.v2:bob:acme', 'studioOrg.v1', 'studioTheme']);
  } finally {
    setActiveOrg(null);
    setSignedInLogin(null);
    delete globalThis.localStorage;
  }

  // The studio: app.mjs names no key (storage is api.mjs's); the modal
  // stores through storeDeployProfile and puts its text on the status
  // line; the legacy key is read in loadDeployProfiles only, and removed
  // there; the adoption runs at boot once the login is known.
  const app = withoutComments(readFileSync(join(STUDIO, 'app.mjs'), 'utf8'));
  assert.doesNotMatch(app, /['"`]deployProfiles|localStorage\.[gs]etItem\(['"`]deploy/, 'no key literal in app.mjs');
  const save = functionSource(app, 'saveDeployProfile');
  assert.match(save, /note = await storeDeployProfile\(name, \{/);
  assert.match(save, /mcpUrl:\s+\$\('#deploy-target-mcp'\)\.value\.trim\(\),/);
  assert.match(save, /setDeployStatus\(note \|\| '', note \? 'ok' : ''\);/);
  const apiSrc = withoutComments(readFileSync(join(STUDIO, 'api.mjs'), 'utf8'));
  assert.equal((apiSrc.match(/getItem\(LEGACY_DEPLOY_PROFILES_KEY\)/g) || []).length, 1, 'v1 is read in one place');
  const load = functionSource(apiSrc, 'loadDeployProfiles');
  assert.ok(load.indexOf('getItem(LEGACY_DEPLOY_PROFILES_KEY)') < load.indexOf('migrateDeployProfiles(legacy,') && load.indexOf('migrateDeployProfiles(legacy,') < load.indexOf('removeItem(LEGACY_DEPLOY_PROFILES_KEY)'),
    'read, migrated, then removed');
  const bootSrc = functionSource(app, 'boot');
  assert.ok(bootSrc.indexOf('await loadIdentity();') < bootSrc.indexOf('loadDeployProfiles()'), 'adopted at boot, once the login is known');
  // ...and not on the boot /auth/me answered "no session" — the login is not
  // known and the shell is about to redirect: an adoption there would file
  // the profiles under 'local', where the signed-in user never sees them.
  // (state.identity stays null in the open posture, which does adopt.)
  assert.match(bootSrc, /if \(state\.identity\?\.authenticated !== false\) loadDeployProfiles\(\)\.catch\(/, 'not adopted on the unauthenticated boot that redirects to sign-in');
  assert.match(functionSource(app, 'setupIdentityChip'), /forgetMcpUrls\(me\.user\?\.login\);/);
  // The save path stores the safe profile the helper returns and reports
  // what it dropped; the adoption stores the migrated map — so the helpers
  // checked above are what runs, not a copy beside them.
  assert.match(functionSource(apiSrc, 'storeDeployProfile'),
    /const \{ profile: safe, dropped, notUrl, droppedTarget, targetNotUrl \} = safeDeployProfile\(profile, stripMcpUrl\);\s*profiles\[name\] = safe;\s*writeDeployProfiles\(profiles\);\s*return deployProfileSavedText\(name, \{ dropped, notUrl, droppedTarget, targetNotUrl \}, droppedNote\);/,
    'a save stores the safe profile and reports what it dropped');
  assert.match(load, /const \{ profiles \} = migrateDeployProfiles\(legacy, localStorage\.getItem\(deployProfilesKey\(\)\), stripMcpUrl\);\s*localStorage\.setItem\(deployProfilesKey\(\), JSON\.stringify\(profiles\)\);/, 'the adoption stores the migrated map');
  assert.match(functionSource(apiSrc, 'writeDeployProfiles'), /setItem\(deployProfilesKey\(\), JSON\.stringify\(profiles\)\)/);
  // A delete never writes {} over a map it could not read.
  assert.match(functionSource(apiSrc, 'removeDeployProfile'), /const profiles = await loadDeployProfiles\(\);\s*if \(!Object\.hasOwn\(profiles, name\)\) return;/, 'a delete of a name that is not there writes nothing');
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
  'POST /auth/signout-others': 'self',
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
  'GET /api/services': 'viewer',
  'GET /api/services/:id': 'viewer',
  'GET /api/services/:id/environments': 'viewer',
  'GET /api/environments/:id': 'viewer',
  'GET /api/mcp-endpoints': 'viewer',
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
  'POST /api/services': 'operator',
  'PATCH /api/services/:id': 'operator',
  'DELETE /api/services/:id': 'operator',
  'POST /api/services/:id/environments': 'operator',
  'PATCH /api/environments/:id': 'operator',
  'DELETE /api/environments/:id': 'operator',
  'PATCH /api/org': 'admin',
  'GET /api/org/members': 'admin',
  'POST /api/org/members': 'admin',
  'PATCH /api/org/members/:userId': 'admin',
  'DELETE /api/org/members/:userId': 'admin',
  'POST /api/mcp-endpoints': 'admin',
  'PATCH /api/mcp-endpoints/:id': 'admin',
  'DELETE /api/mcp-endpoints/:id': 'admin',
  'GET /api/admin/users': 'owner',
  'POST /api/admin/users': 'owner',
  'POST /api/admin/users/:id/disable': 'owner',
  'POST /api/admin/users/:id/enable': 'owner',
  'POST /api/admin/users/:id/password': 'owner',
  'POST /api/admin/users/:id/signout': 'owner',
  'PUT /api/admin/users/:id/owner': 'owner',
  'GET /api/admin/orgs': 'owner',
  'POST /api/admin/orgs': 'owner',
  'DELETE /api/admin/orgs/:id': 'owner',
  'GET /api/admin/join-role': 'owner',
  'PUT /api/admin/join-role': 'owner',
});
// The identity API (/api/admin/*, /api/org*), and the one route the open,
// exposed posture passes to its rule (which answers 409 there).
const EXPECTED_IDENTITY_API = Object.freeze([
  'PATCH /api/org', 'GET /api/org/members', 'POST /api/org/members', 'PATCH /api/org/members/:userId', 'DELETE /api/org/members/:userId',
  'GET /api/admin/users', 'POST /api/admin/users', 'POST /api/admin/users/:id/disable', 'POST /api/admin/users/:id/enable',
  'POST /api/admin/users/:id/password', 'POST /api/admin/users/:id/signout', 'PUT /api/admin/users/:id/owner',
  'GET /api/admin/orgs', 'POST /api/admin/orgs', 'DELETE /api/admin/orgs/:id', 'GET /api/admin/join-role', 'PUT /api/admin/join-role',
]);
const EXPECTED_EXPOSED_RULE = Object.freeze(['POST /api/admin/orgs']);
// The MCP endpoint changes (STORE_PLAN slice 4): the identity API's
// defences — direct loopback only without sign-in, the CSRF header in every
// posture, closed when exposed — on rows that are not the identity API.
const EXPECTED_MCP_ENDPOINT_CHANGES = Object.freeze(['POST /api/mcp-endpoints', 'PATCH /api/mcp-endpoints/:id', 'DELETE /api/mcp-endpoints/:id']);
// Every `direct` entry, and every csrf: 'always' entry (the identity
// mutations, the self route that changes a session, the MCP endpoint changes).
const EXPECTED_DIRECT = Object.freeze([...EXPECTED_IDENTITY_API, ...EXPECTED_MCP_ENDPOINT_CHANGES]);
const EXPECTED_CSRF_ALWAYS = Object.freeze([
  ...EXPECTED_IDENTITY_API.filter((k) => !k.startsWith('GET ')), 'POST /auth/signout-others', ...EXPECTED_MCP_ENDPOINT_CHANGES,
]);

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
    // <kind>.<verb>, lower case; a kind of two words joins them with _ (mcp_endpoint.create).
    assert.ok(Array.isArray(e.audit) && e.audit.every((a) => /^[a-z]+(?:_[a-z]+)*(?:[.-][a-z]+(?:_[a-z]+)*)+$/.test(a)), `${key}: audit actions`);
    assert.ok(e.later === null || (typeof e.later === 'string' && e.later.length > 0), `${key}: later`);
    const isApi = e.path.startsWith('/api/');
    if (isApi && e.method !== 'GET') {
      assert.ok(['session', 'always'].includes(e.csrf), `${key}: an /api mutation needs csrf session or always`);
      assert.ok(!['public', 'viewer'].includes(e.class), `${key}: a viewer may only read`);
    }
    if (e.identityApi) assert.ok(['admin', 'owner'].includes(e.class), `${key}: the identity API is admin or owner`);
    if (e.identityApi) assert.equal(e.direct, true, `${key}: the identity API is direct`);
    if (e.direct) assert.ok(['admin', 'owner'].includes(e.class), `${key}: a direct entry is admin or owner`);
    if (e.direct) assert.equal(e.exposed === 'allow', false, `${key}: a direct entry is closed (or its rule's) when exposed`);
    if (e.direct && e.method !== 'GET') assert.equal(e.csrf, 'always', `${key}: a direct change takes the CSRF header in every posture`);
    assert.ok(['the identity API', 'the MCP endpoints'].includes(e.closedAs), `${key}: closedAs`);
    assert.equal(e.closedAs === 'the identity API', !EXPECTED_MCP_ENDPOINT_CHANGES.includes(key), `${key}: closed as what it is`);
    if (e.class === 'admin' || e.class === 'owner') assert.ok(Object.hasOwn(ROUTES[key], 'exposed'), `${key}: an ${e.class} route declares exposed`);
    if (e.csrf === 'form') assert.ok(e.method !== 'GET' && e.path.startsWith('/auth/'), `${key}: form is for a non-GET /auth route`);
    if (e.class === 'self') {
      assert.ok(e.self && typeof e.self.pwflow === 'boolean' && typeof e.self.session === 'boolean'
        && ['redirect', 'flow-expired', 'json'].includes(e.self.unauth), `${key}: a self entry has a self spec`);
    } else assert.equal(e.self, null, `${key}: only a self entry has a self spec`);
  }
  assert.deepEqual(Object.keys(ROUTES).filter((k) => routeEntry(k).identityApi).sort(), [...EXPECTED_IDENTITY_API].sort(), 'the identity API set');
  assert.deepEqual(Object.keys(ROUTES).filter((k) => routeEntry(k).direct).sort(), [...EXPECTED_DIRECT].sort(), 'the direct set');
  assert.deepEqual(Object.keys(ROUTES).filter((k) => routeEntry(k).csrf === 'always').sort(), [...EXPECTED_CSRF_ALWAYS].sort(), 'the csrf: always set');
  assert.deepEqual(Object.keys(ROUTES).filter((k) => routeEntry(k).exposed === 'rule').sort(), [...EXPECTED_EXPOSED_RULE].sort(), 'the exposed: rule set');
});

// The README's API Surface states each row's class in its intro: the
// public and self rows by name, the admin rows (/api/org, /api/org/…, and
// every /api/mcp-endpoints route but its GET) and the owner rows
// (/api/admin/…) by path, then every other GET viewer, every other row
// operator. Each row is checked against the route table.
test('the README API Surface: its intro states each row\'s class — public and self by name, admin and owner by path, every other GET viewer, every other row operator', () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  const start = readme.indexOf('\n## API Surface\n');
  assert.ok(start >= 0, 'README has an API Surface section');
  const end = readme.indexOf('\n## ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  const intro = section.slice(0, section.indexOf('\n|')).replace(/\s+/g, ' ');
  const rows = [...section.matchAll(/^\| `([A-Z]+)` \| `([^`]+)` \|/gm)].map(([, method, path]) => ({ method, path: path.split('?')[0] }));
  assert.ok(rows.length >= 20, `read the table (${rows.length} rows)`);
  const paths = (text) => [...(text ?? '').matchAll(/`([^`]+)`/g)].map(([, path]) => path);
  const publicNamed = paths(intro.match(/Below, (.+?) are `public`/)?.[1]);
  const selfNamed = paths(intro.match(/are `public` and (.+?) is `self`/)?.[1]);
  assert.ok(publicNamed.length > 0, 'the intro names the public rows');
  assert.ok(selfNamed.length > 0, 'the intro names the self rows');
  assert.match(intro, /`\/api\/org` and every `\/api\/org\/…` route are `admin`/, 'the intro states the admin rows');
  assert.match(intro, /every `\/api\/admin\/…` route `owner`/, 'the intro states the owner rows');
  assert.match(intro, /every `\/api\/mcp-endpoints` route but its `GET` is `admin`/, 'the intro states the MCP endpoint rows');
  assert.match(intro, /every other `GET` is `viewer`/, 'the intro states the GET rule');
  assert.match(intro, /every other route `operator`/, 'the intro states the rule for every other row');
  const stated = (method, path) => {
    if (publicNamed.includes(path)) return 'public';
    if (selfNamed.includes(path)) return 'self';
    if (path === '/api/org' || path.startsWith('/api/org/')) return 'admin';
    if (path.startsWith('/api/admin/')) return 'owner';
    if (path.startsWith('/api/mcp-endpoints') && method !== 'GET') return 'admin';
    return method === 'GET' ? 'viewer' : 'operator';
  };
  for (const { method, path } of rows) {
    const key = `${method} ${path}`;
    assert.ok(Object.hasOwn(ROUTES, key), `${key}: a README row the route table does not hold`);
    assert.equal(routeEntry(key).class, stated(method, path), `${key}: the class the intro states`);
  }
  for (const path of [...publicNamed, ...selfNamed]) assert.ok(rows.some((r) => r.path === path), `${path}: named in the intro, a row below`);
});

// The README's Identity API section: its intro states the audit actor — the
// caller's login, with its one exception, the first local user's owner grant
// that keeps `system` (the open-loopback case below pins those rows); its
// table lists every identity-API route and the self route it documents
// (POST /auth/signout-others) once, each with its class as "Who"; every
// change it lists takes the CSRF header ("on every change"), and each curl
// example that changes something sends it.
test('the README Identity API section states the audit actor and its system exception, lists every identity route once with its class, and its examples send the CSRF header', () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  const start = readme.indexOf('\n### The Identity API\n');
  assert.ok(start >= 0, 'README has an Identity API section');
  const end = readme.indexOf('\n### ', start + 1);
  const section = readme.slice(start, end < 0 ? undefined : end);
  const intro = section.slice(0, section.indexOf('\n|')).replace(/\s+/g, ' ');
  assert.match(intro, /with the caller's login as the actor \(`local` on a server without sign-in\)/, 'the intro states the actor');
  assert.ok(routeEntry('POST /api/admin/users').audit.includes('owner.first-local-user'), 'POST /api/admin/users writes the first local user\'s grant');
  assert.match(intro, /except the owner grant the first local user gets \(`owner\.first-local-user`\), which keeps `system`/,
    'the intro names the one row an identity route writes as system, not as the caller');
  const rows = [...section.matchAll(/^\| `([A-Z]+)` \| `([^`]+)` \| ([a-z]+) \|/gm)].map(([, method, path, who]) => ({ key: `${method} ${path}`, who }));
  const expected = Object.keys(ROUTES).filter((k) => routeEntry(k).identityApi || k === 'POST /auth/signout-others');
  assert.deepEqual(rows.map((r) => r.key).sort(), expected.sort(), 'the identity routes, each once');
  for (const { key, who } of rows) {
    const e = routeEntry(key);
    assert.equal(who, e.class, `${key}: "Who" is its class`);
    if (e.method !== 'GET') assert.equal(e.csrf, 'always', `${key}: a change takes the CSRF header in every posture`);
  }
  const example = section.match(/```bash\n([\s\S]*?)```/)?.[1] ?? '';
  const curls = example.replace(/\\\n\s*/g, ' ').split('\n').filter((line) => line.startsWith('curl '));
  assert.ok(curls.length >= 2, `the curl example (${curls.length} calls)`);
  for (const line of curls) {
    if (/ -d /.test(line) && /\/api\/(admin|org)/.test(line)) assert.ok(line.includes("-H 'X-Observogram-CSRF: 1'"), `${line}: sends the CSRF header`);
  }
});

// The README's Roles section states how the import maps orgs.json roles:
// each word it lists maps to that role, and every word the import sends
// to admin or viewer is listed (else a reader takes it for an operator).
test('the README Roles section lists every orgs.json role the import maps to admin or viewer', () => {
  const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'), 'utf8');
  const start = readme.indexOf('\n#### Roles\n');
  assert.ok(start >= 0, 'README has a Roles section');
  const end = readme.indexOf('\n#', start + 1);
  const text = readme.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
  const m = text.match(/`orgs\.json` roles are mapped on import: (.+?)\. Per posture:/);
  assert.ok(m, 'the Roles section states the orgs.json mapping');
  assert.match(m[1], /, anything else \(`member`, empty\) → `operator`$/, 'the mapping ends with the operator catch-all');
  assert.equal(mapLegacyRole('member').role, 'operator');
  assert.equal(mapLegacyRole('').role, 'operator');
  const listed = { admin: [], viewer: [] };
  for (const [, words, role] of m[1].matchAll(/((?:`[a-z-]+`(?: \/ )?)+) → `(admin|viewer)`/g)) {
    listed[role].push(...[...words.matchAll(/`([a-z-]+)`/g)].map(([, w]) => w));
  }
  for (const role of ['admin', 'viewer']) {
    assert.ok(listed[role].length > 0, `the mapping lists the words for ${role}`);
    for (const w of listed[role]) assert.equal(mapLegacyRole(w).role, role, `${w}: listed as ${role}`);
  }
  const candidates = ['admin', 'owner', 'viewer', 'read', 'readonly', 'read-only', 'read_only', 'ro',
    'operator', 'member', 'editor', 'write', 'maintainer', 'guest'];
  for (const w of candidates) {
    const { role } = mapLegacyRole(w);
    if (role !== 'operator') assert.ok(listed[role].includes(w), `${w} → ${role}: a mapping the README does not list`);
  }
});

// docs/STORE_PLAN.md's build status (the italic paragraphs before §0) and
// docs/HANDOVER.md say which slice is next: one slice, the same in both,
// and never one the build status already calls built.
test('docs/STORE_PLAN.md\'s build status and docs/HANDOVER.md name one next slice, after every slice built', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const plan = readFileSync(join(REPO, 'docs', 'STORE_PLAN.md'), 'utf8');
  const start = plan.indexOf('*Build status');
  const end = plan.indexOf('\n## 0 ');
  assert.ok(start >= 0 && end > start, 'docs/STORE_PLAN.md has its build status before §0');
  const status = plan.slice(start, end).replace(/\s+/g, ' ');
  const handover = readFileSync(join(REPO, 'docs', 'HANDOVER.md'), 'utf8').replace(/\s+/g, ' ');
  const NEXT = /\bslice (\d+)\b[^.;*]{0,40}?\bis next\b/gi;
  const next = [
    ...[...status.matchAll(NEXT)].map(([phrase, n]) => ({ doc: 'STORE_PLAN.md', phrase, n: Number(n) })),
    ...[...handover.matchAll(NEXT)].map(([phrase, n]) => ({ doc: 'HANDOVER.md', phrase, n: Number(n) })),
  ];
  assert.ok(next.some((x) => x.doc === 'STORE_PLAN.md') && next.some((x) => x.doc === 'HANDOVER.md'), 'both docs say which slice is next');
  const slices = [...new Set(next.map((x) => x.n))];
  assert.equal(slices.length, 1, `one next slice, not ${next.map((x) => `${x.doc}: "${x.phrase}"`).join(', ')}`);
  const built = [...status.matchAll(/\bslice (\d+) is built\b/gi)].map(([, n]) => Number(n));
  assert.ok(built.length > 0, 'the build status says which slices are built');
  for (const b of built) assert.ok(slices[0] > b, `slice ${slices[0]} is next, but the build status says slice ${b} is built`);
});

// Roles are enforced: no comment in server/ or tools/ still says a role
// is only recorded (the pre-3a "recorded for Stage 3, not yet enforced").
// Comment lines are joined first, so a sentence wrapped over two lines is
// read whole.
test('no source comment says roles are recorded but not enforced', () => {
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
  const STALE = /\brole[s]?\b[^.;]{0,60}\bnot (?:yet )?enforced|\brole[s]?\b[^.;]{0,20}\brecorded for stage 3|enforces membership only/i;
  const self = fileURLToPath(import.meta.url);
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs') && p !== self) files.push(p);
    }
  };
  walk(join(REPO, 'server'));
  walk(join(REPO, 'tools'));
  assert.ok(files.length > 50, `walked the sources (${files.length} files)`);
  const stale = files.filter((f) => STALE.test(readFileSync(f, 'utf8').replace(/\s*\n\s*(?:\*(?!\/)|\/\/)?\s*/g, ' ')))
    .map((f) => f.slice(REPO.length + 1));
  assert.deepEqual(stale, [], 'a comment still says roles are not enforced');
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
const { createMcpEndpoint } = await import('./store/mcp-endpoints.mjs');
const { runWithOrg } = await import('./org-context.mjs');

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
  // The services and environments API (STORE_PLAN slice 4): unknown ids
  // (404) and empty bodies (400) — nothing is written.
  'GET /api/services': ['GET', '/api/services'],
  'GET /api/services/:id': ['GET', '/api/services/999999'],
  'GET /api/services/:id/environments': ['GET', '/api/services/999999/environments'],
  'GET /api/environments/:id': ['GET', '/api/environments/999999'],
  'POST /api/services': ['POST', '/api/services'],
  'PATCH /api/services/:id': ['PATCH', '/api/services/999999'],
  'DELETE /api/services/:id': ['DELETE', '/api/services/999999'],
  'POST /api/services/:id/environments': ['POST', '/api/services/999999/environments'],
  'PATCH /api/environments/:id': ['PATCH', '/api/environments/999999'],
  'DELETE /api/environments/:id': ['DELETE', '/api/environments/999999'],
  // The MCP endpoints: the list, an empty body (400), an unknown id (404).
  'GET /api/mcp-endpoints': ['GET', '/api/mcp-endpoints'],
  'POST /api/mcp-endpoints': ['POST', '/api/mcp-endpoints'],
  'PATCH /api/mcp-endpoints/:id': ['PATCH', '/api/mcp-endpoints/999999'],
  'DELETE /api/mcp-endpoints/:id': ['DELETE', '/api/mcp-endpoints/999999'],
  // The admin routes: invalid bodies, and a user id that is no member (the
  // PATCH names a valid role, so the membership is what it answers).
  'PATCH /api/org': ['PATCH', '/api/org'],
  'GET /api/org/members': ['GET', '/api/org/members'],
  'POST /api/org/members': ['POST', '/api/org/members'],
  'PATCH /api/org/members/:userId': ['PATCH', '/api/org/members/999999', '{"role":"viewer"}'],
  'DELETE /api/org/members/:userId': ['DELETE', '/api/org/members/999999'],
  // The owner routes: unknown ids and invalid bodies. POST /api/admin/orgs
  // answers 409 before it reads the body on a server without identity.
  'GET /api/admin/users': ['GET', '/api/admin/users'],
  'POST /api/admin/users': ['POST', '/api/admin/users'],
  'POST /api/admin/users/:id/disable': ['POST', '/api/admin/users/999999/disable'],
  'POST /api/admin/users/:id/enable': ['POST', '/api/admin/users/999999/enable'],
  'POST /api/admin/users/:id/password': ['POST', '/api/admin/users/999999/password'],
  'POST /api/admin/users/:id/signout': ['POST', '/api/admin/users/999999/signout'],
  'PUT /api/admin/users/:id/owner': ['PUT', '/api/admin/users/999999/owner'],
  'GET /api/admin/orgs': ['GET', '/api/admin/orgs'],
  'POST /api/admin/orgs': ['POST', '/api/admin/orgs', '{"id":"!"}'],
  'DELETE /api/admin/orgs/:id': ['DELETE', '/api/admin/orgs/nope'],
  'GET /api/admin/join-role': ['GET', '/api/admin/join-role'],
  'PUT /api/admin/join-role': ['PUT', '/api/admin/join-role'],
});

// The /auth/* routes and the non-/api public routes have their own rows below.
test('the probe table covers every /api route the server registers', () => {
  const apiKeys = inventories.local.routes.map((r) => r.key).filter((k) => k.split(' ')[1].startsWith('/api/'));
  assert.deepEqual(Object.keys(PROBES).sort(), [...new Set(apiKeys)].sort(), 'a /api route without a probe (add one to PROBES), or a probe for no route');
});

// One request: { status, json (or null), text, type }; `query` is appended
// to the path; a probe's third element is its body (default {}). With
// `raw`, over node:http: fetch drops a custom Host header.
async function call(base, [method, path, probeBody], { headers = {}, body, query = '', raw = false } = {}) {
  const h = { Accept: 'application/json', ...headers };
  let payload;
  if (method !== 'GET' && method !== 'DELETE') {
    h['Content-Type'] ??= 'application/json';
    payload = body ?? probeBody ?? '{}';
  }
  if (raw) return rawCall(`${base}${path}${query}`, method, h, payload);
  const r = await fetch(`${base}${path}${query}`, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, type: r.headers.get('content-type') || '', org: r.headers.get('x-observogram-org') };
}

const { request: httpRequest } = await import('node:http');
function rawCall(url, method, headers, payload) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: payload === undefined ? headers : { ...headers, 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, text, type: res.headers['content-type'] || '', org: res.headers['x-observogram-org'] ?? null });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
const outcome = (r) => ((r.status === 401 || r.status === 403 || r.json?.denied)
  ? `${r.status} ${r.json?.denied ?? '(no denied)'}` : 'allowed');

// Every probe for every variant; the mismatches, as readable lines.
async function sweep(base, variants, expect) {
  const bad = [];
  let n = 0;
  for (const v of variants) {
    for (const [key, probe] of Object.entries(PROBES)) {
      const r = await call(base, probe, { headers: v.headers, query: v.query || '', raw: v.raw === true });
      n++;
      const got = outcome(r);
      const want = expect(v, key);
      if (got !== want) bad.push(`${v.name} ${key}: got ${got} (${r.status} ${r.text.slice(0, 120)}), want ${want}`);
    }
  }
  return { bad, n };
}

// What a matrix sweep writes: nothing — but RESET (DELETE /api/uploads)
// records one pack.clear row per cell it answered, even with nothing to
// drop (a reset is an action a person took; STORE_PLAN slice 4).
async function onlyResets(ws, before, variants, expect) {
  const rows = await auditRowsAfter(ws, before);
  const resets = variants.filter((v) => expect(v, 'DELETE /api/uploads') === 'allowed').length;
  assert.ok(resets >= 1 && rows.length >= resets && rows.length <= variants.length, `${rows.length} rows for ${resets} answered RESET cells of ${variants.length} variants`);
  assert.deepEqual(rows.map((r) => [r[0], r[3], r[4]]), Array(rows.length).fill(['pack.clear', null, { dropped: 0 }]),
    'the matrix wrote nothing but pack.clear { dropped: 0 } rows — one per RESET it answered');
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

    // The owner routes: an org admin is refused, the bearer too; an owner
    // with no membership (otto, no org named) lands in the default org and
    // reaches them — an owner acts at the deployment, whatever the org.
    r = await call(srv.base, PROBES['GET /api/admin/users'], { headers: variants.find((v) => v.name === 'ada@acme').headers });
    assert.deepEqual([r.status, r.json.denied, r.json.error, r.json.need, r.json.role, r.json.owner, r.json.org],
      [403, 'role', "requires an owner of this deployment (you are admin in org 'acme') — ask an owner", 'owner', 'admin', false, 'acme']);
    r = await call(srv.base, PROBES['GET /api/admin/users'], { headers: variants.find((v) => v.name === 'bearer').headers });
    assert.deepEqual([r.status, r.json.denied, r.json.error],
      [403, 'role', "the bearer token acts as an operator in org 'acme'; an owner needs a signed-in user with that role"]);
    const otto = variants.find((v) => v.name === 'otto').headers;
    r = await call(srv.base, PROBES['GET /api/admin/users'], { headers: otto });
    assert.deepEqual([r.status, r.org], [200, 'default'], 'otto: the default org, an owner route answered');
    assert.deepEqual(r.json.users.map((u) => u.login).sort(), [...LOGINS].sort(), 'every user');
    assert.deepEqual(r.json.users.map((u) => u.id), [...r.json.users.map((u) => u.id)].sort((a, b) => a - b), 'by id');
    assert.ok(r.json.users.every((u) => !('password' in u) && !('sessionEpoch' in u)), 'no password, no session epoch');
    const idOf = Object.fromEntries(r.json.users.map((u) => [u.login, u.id]));
    r = await call(srv.base, PROBES['POST /api/admin/users/:id/disable'], { headers: otto });
    assert.deepEqual([r.status, r.org, r.json], [404, 'default', { ok: false, error: 'no user 999999' }]);

    // The admin routes: the context org's admins (and every owner). ada,
    // acme's admin, reaches acme's members only: bob, a member of bravo,
    // is "not a member" here — the answer an id no user holds gets, so
    // nothing outside acme is told apart — and naming bravo is 403 org.
    const ada = variants.find((v) => v.name === 'ada@acme').headers;
    const toViewer = '{"role":"viewer"}';
    r = await call(srv.base, ['PATCH', `/api/org/members/${idOf.bob}`], { headers: ada, body: toViewer });
    assert.deepEqual([r.status, r.org, r.json], [404, 'acme', { ok: false, error: `user ${idOf.bob} is not a member of acme` }], 'ada: bob is no member of acme');
    r = await call(srv.base, ['DELETE', `/api/org/members/${idOf.bob}`], { headers: ada });
    assert.deepEqual([r.status, r.json], [404, { ok: false, error: `user ${idOf.bob} is not a member of acme` }], 'ada: bob is not removed');
    r = await call(srv.base, PROBES['PATCH /api/org/members/:userId'], { headers: ada });
    assert.deepEqual([r.status, r.json], [404, { ok: false, error: 'user 999999 is not a member of acme' }], 'an id no user holds: the same answer');
    r = await call(srv.base, ['PATCH', `/api/org/members/${idOf.bob}`], { headers: session('ada', 'bravo').headers, body: toViewer });
    assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'org', "not a member of org 'bravo'"], 'ada naming bravo');
    r = await call(srv.base, PROBES['GET /api/org/members'], { headers: ada });
    assert.deepEqual([r.status, r.org, r.json.org], [200, 'acme', { id: 'acme', name: 'Acme', default: false }]);
    assert.deepEqual(r.json.members.map((m) => `${m.login}:${m.role}`).sort(), Object.entries(MEMBERS.acme).map(([l, role]) => `${l}:${role}`).sort(),
      'acme\'s members, and no one else');
    assert.ok(r.json.members.every((m) => Object.keys(m).join() === 'userId,login,kind,name,email,role,disabled,since'), 'the member view: named fields only');
    r = await call(srv.base, PROBES['GET /api/org/members'], { headers: variants.find((v) => v.name === 'mia (no org → her first, bravo)').headers });
    assert.deepEqual([r.status, r.org, r.json.members.map((m) => m.login).sort()], [200, 'bravo', ['bob', 'mia']], 'mia, no org: bravo, where she is admin');
    r = await call(srv.base, PROBES['GET /api/org/members'], { headers: variants.find((v) => v.name === 'vera@acme').headers });
    assert.deepEqual([r.status, r.json.denied, r.json.error, r.json.need, r.json.role],
      [403, 'role', "requires the admin role in org 'acme' (you are viewer) — ask an admin of acme", 'admin', 'viewer']);
    r = await call(srv.base, PROBES['GET /api/org/members'], { headers: variants.find((v) => v.name === 'bearer').headers });
    assert.deepEqual([r.status, r.json.denied, r.json.error],
      [403, 'role', "the bearer token acts as an operator in org 'acme'; the admin role needs a signed-in user with that role"]);

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
      assert.equal(outcome(res), expectIdentity({ bearer: true }, key), `bearer without the CSRF header: ${key} (its class decides, never the header)`);
    }

    // Case rows: /API/… is never a handler.
    assert.deepEqual(await caseRows(srv.base), [], 'anonymous /API/…');
    assert.deepEqual(await caseRows(srv.base, variants.find((v) => v.name === 'ada@acme').headers), [], 'ada /API/…');

    // Refused requests (and every probe) wrote nothing.
    await onlyResets(ws, before, variants, expectIdentity);

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

    // GET /api/mcp-endpoints by rank, on an endpoint planted beside the
    // running child by a repository call (WAL): the url and the variable's
    // name to an operator and above — the bearer among them — null to a
    // viewer; the origin and the name to every member; none of it in bravo.
    const EP_URL = 'https://mcp.acme.test/mcp/s/sk-path-secret/obs?tier=x';
    const planted = await openRaw(join(ws, 'observogram.db'));
    try {
      runWithOrg('acme', () => createMcpEndpoint(planted, 'system', { name: 'planted', url: EP_URL, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_PLANTED_TOKEN' }));
    } finally {
      planted.close();
    }
    const endpointsFor = async (name) => (await call(srv.base, PROBES['GET /api/mcp-endpoints'], { headers: variants.find((v) => v.name === name).headers })).json;
    for (const name of ['vera@acme', 'mia@acme']) {
      const e = await endpointsFor(name);
      assert.deepEqual(e.endpoints.map((x) => [x.name, x.origin, x.url, x.readTokenEnv, x.environments]), [['planted', LIVE_ORIGIN, null, null, 0]], `${name}: the name and origin only`);
    }
    for (const name of ['oscar@acme', 'bearer', 'ada@acme', 'owen@acme', 'olive@acme']) {
      const e = await endpointsFor(name);
      assert.deepEqual(e.endpoints.map((x) => [x.name, x.origin, x.url, x.readTokenEnv, x.environments]), [['planted', LIVE_ORIGIN, EP_URL, 'OBSERVOGRAM_ORG_ACME_PLANTED_TOKEN', 0]], `${name}: the url and the variable`);
    }
    assert.deepEqual((await endpointsFor('mia (no org → her first, bravo)')).endpoints, [], 'bravo lists none of acme\'s endpoints');
    assert.deepEqual((await auditRowsAfter(ws, await auditSeq(ws))), [], 'the reads wrote nothing');

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

    // The register routes write their rows (STORE_PLAN slice 4): oscar's
    // POST /api/validate of examples/demo-skeleton.pack.yaml registers the
    // pack (pack.register, source = the pack's name: no ?source= hint) and
    // links it to the service and environment it names, created by him;
    // the capture writes none (slice 5); RESET writes one pack.clear.
    const oscar = variants.find((v) => v.name === 'oscar@acme').headers;
    const yaml = readFileSync(join(REPO, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');
    const seq = await auditSeq(ws);
    const reg = await call(srv.base, PROBES['POST /api/validate'], { headers: { ...oscar, 'Content-Type': 'application/x-yaml' }, body: yaml });
    assert.equal(reg.json?.ok, true, reg.text.slice(0, 200));
    const id = reg.json.registered.id;
    assert.deepEqual(await auditRowsAfter(ws, seq), [
      ['pack.register', 'oscar', 'acme', id, { label: null, source: 'demo-skeleton' }],
      ['service.create', 'oscar', 'acme', 'demo-skeleton', { via: 'register', pack: id }],
      ['environment.create', 'oscar', 'acme', 'demo-skeleton/prod', { via: 'register', pack: id }],
      ['pack.link', 'oscar', 'acme', id, { service: 'demo-skeleton', role: 'primary' }],
    ], 'the register\'s exact rows, by oscar, in acme');
    const afterReg = await auditSeq(ws);
    const again = await call(srv.base, PROBES['POST /api/validate'], { headers: { ...oscar, 'Content-Type': 'application/x-yaml' }, body: yaml });
    assert.equal(again.json?.registered?.id, id);
    assert.equal(await auditSeq(ws), afterReg, 'the same YAML again: the same id, a touch, no new row');
    const cap = await call(srv.base, ['POST', '/api/journeys/capture'], { headers: oscar, body: JSON.stringify({ name: 'authz-capture', packAId: id, packBId: id }) });
    assert.equal(cap.json?.ok, true, cap.text.slice(0, 200));
    assert.equal(await auditSeq(ws), afterReg, 'the capture wrote no audit row (slice 5)');
    const wipe = await call(srv.base, ['DELETE', '/api/uploads'], { headers: oscar });
    assert.equal(wipe.json?.dropped, 1, wipe.text);
    assert.deepEqual(await auditRowsAfter(ws, afterReg), [['pack.clear', 'oscar', 'acme', null, { dropped: 1 }]], 'RESET: one pack.clear row; the service stays (no service.delete)');

    // Self rows: POST /auth/signout-others answers the caller's own session,
    // with the CSRF header — never an anonymous caller, the bearer or a
    // disabled user's cookie; on a throwaway sign-in of vera's, whose
    // matrix cookie is then refused and the re-issued one answered.
    const SELF = ['POST', '/auth/signout-others'];
    const selfSeq = await auditSeq(ws);
    const NO_SESSION = { ok: false, error: 'unauthorized: sign in required', login: '/auth/login', denied: 'auth' };
    for (const [label, headers] of [['anonymous', CSRF], ['the bearer', { Authorization: `Bearer ${TOKEN}`, ...CSRF }], ['dan (disabled)', { Cookie: cookies.dan, ...CSRF }]]) {
      r = await call(srv.base, SELF, { headers });
      assert.deepEqual([r.status, r.json], [401, NO_SESSION], label);
    }
    const throwaway = (await signIn(srv.base, 'vera', pw('vera'))).session;
    r = await call(srv.base, SELF, { headers: { Cookie: throwaway } });
    assert.deepEqual([r.status, r.json.denied], [403, 'csrf'], 'a session without the header');
    assert.equal(await auditSeq(ws), selfSeq, 'the refused self calls wrote nothing');
    const out = await fetch(`${srv.base}/auth/signout-others`, { method: 'POST', headers: { Cookie: throwaway, ...CSRF, Accept: 'application/json' } });
    const outJson = await out.json();
    assert.deepEqual([out.status, outJson.ok, Number.isInteger(outJson.sessionEpoch)], [200, true, true], JSON.stringify(outJson));
    const reissued = (out.headers.getSetCookie?.() || []).find((c) => c.startsWith('observogram_session='))?.split(';')[0];
    assert.ok(reissued && reissued !== throwaway, 'this session\'s cookie is re-issued');
    for (const [label, cookie, want] of [['vera\'s matrix cookie', cookies.vera, 401], ['the throwaway before its re-issue', throwaway, 401], ['the re-issued cookie', reissued, 200]]) {
      r = await call(srv.base, PROBES['GET /api/packs'], { headers: { Cookie: cookie, 'X-Observogram-Org': 'acme' } });
      assert.equal(r.status, want, label);
    }
    assert.deepEqual((await auditRowsAfter(ws, selfSeq)).map((row) => row.slice(0, 4)), [['user.signout', 'vera', null, 'vera']], 'one row, vera its actor');
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
    await onlyResets(ws, before, variants, expectToken);
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
    for (const probe of [['GET', '/auth/change-password'], ['POST', '/auth/change-password'], ['POST', '/auth/change-password/skip'], ['POST', '/auth/signout-others']]) {
      for (const headers of [{}, { ...variants[1].headers, 'X-Observogram-CSRF': '1' }]) {
        const r = await call(srv.base, probe, { headers });
        assert.deepEqual([r.status, r.json], [404, { ok: false, error: 'identity not configured' }], `${probe.join(' ')} ${JSON.stringify(headers)}`);
      }
    }
  } finally {
    await srv.stop();
  }
});

// ---- the open postures: every existing route, as today; the identity API
// to a person at this machine only ----
//
// Without sign-in, local is an owner. Every existing route answers it as
// today, with or without the CSRF header. The identity API — and the MCP
// endpoint changes, the other `direct` entries (slice 4) — needs the header
// on a mutation and, on a loopback bind, a request sent straight to it —
// a foreign Host (a DNS-rebinding page), a proxy header or a foreign Origin
// is refused (§8.1); on an exposed bind it is closed, but for POST
// /api/admin/orgs, whose rule answers 409 (no second org without identity).
function expectOpen(tag) {
  return (v, key) => {
    if (!EXPECTED_DIRECT.includes(key)) return 'allowed';
    if (tag !== 'open-loopback' && !EXPECTED_EXPOSED_RULE.includes(key)) return '403 posture';
    if (v.foreign) return '403 posture';
    if (EXPECTED_CSRF_ALWAYS.includes(key) && !v.csrf) return '403 csrf';
    return 'allowed';
  };
}

// The audit rows after `seq`, read from a stopped child's database.
async function auditRowsAfter(ws, seq) {
  const db = await openRaw(join(ws, 'observogram.db'), { readOnly: true });
  try {
    return prepare(db, 'SELECT org_id, actor, action, target_id, detail FROM audit WHERE seq > ? ORDER BY seq').all(seq)
      .map((r) => [r.action, r.actor, r.org_id, r.target_id, r.detail === null ? null : JSON.parse(r.detail)]);
  } finally {
    db.close();
  }
}

const CSRF_HEADER = Object.freeze({ 'X-Observogram-CSRF': '1' });
// An MCP endpoint of the default org (the open postures' one org): the
// variable's name carries the org's prefix.
const MCP_BODY = Object.freeze({ name: 'local-mcp', url: 'https://mcp.local.test/mcp/obs?tier=x', readTokenEnv: 'OBSERVOGRAM_ORG_DEFAULT_MCP_TOKEN' });
const OPEN = [
  { tag: 'open-loopback', host: '127.0.0.1', env: { OBSERVOGRAM_AUTH: 'off' } },
  {
    tag: 'open-exposed-a', host: '0.0.0.0', env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_INSECURE_NO_AUTH: '1' },
    setup: (ws) => writeUsersFile({ users: { solo: { name: 'solo', createdAt: 'test', password: hashPassword(pw('solo')) } } }, join(ws, 'users.json')),
  },
  { tag: 'open-exposed-b', host: '0.0.0.0', env: { OBSERVOGRAM_INSECURE_NO_AUTH: '1' } },
];
for (const posture of OPEN) {
  test(`the AuthZ matrix — ${posture.tag}: local is an owner; every existing route answers, with or without the CSRF header; the identity API ${posture.tag === 'open-loopback' ? 'to a direct loopback request with the header' : 'closed'}`, { timeout: 120_000 }, async () => {
    const ws = freshWorkspace(posture.tag);
    posture.setup?.(ws);
    const srv = await serve(ws, { host: posture.host, env: posture.env });
    const port = new URL(srv.base).port;
    let writes = null;
    try {
      const variants = [{ name: 'local', headers: {} }, { name: 'local + CSRF', csrf: true, headers: CSRF_HEADER }];
      if (posture.tag === 'open-loopback') {
        variants.push(
          { name: 'local + CSRF, a foreign Host', csrf: true, foreign: true, raw: true, headers: { ...CSRF_HEADER, Host: `rebind.attacker.example:${port}` } },
          { name: 'local + CSRF, X-Forwarded-For', csrf: true, foreign: true, raw: true, headers: { ...CSRF_HEADER, 'X-Forwarded-For': '203.0.113.9' } },
          { name: 'local + CSRF, CF-Connecting-IP (a tunnel)', csrf: true, foreign: true, raw: true, headers: { ...CSRF_HEADER, 'CF-Connecting-IP': '203.0.113.9' } },
          { name: 'local + CSRF, a foreign Origin', csrf: true, foreign: true, raw: true, headers: { ...CSRF_HEADER, Origin: 'https://evil.example' } },
        );
      }
      const before = await auditSeq(ws);
      const { bad, n } = await sweep(srv.base, variants, expectOpen(posture.tag));
      assert.deepEqual(bad, [], `${bad.length} of ${n} cells disagree`);
      assert.deepEqual(await caseRows(srv.base), []);
      await onlyResets(ws, before, variants, expectOpen(posture.tag));
      const o = (await call(srv.base, ['GET', '/api/orgs'])).json;
      assert.deepEqual(o.orgs, [{ id: 'default', name: 'Default', role: null, effectiveRole: 'admin' }]);

      // The refusal texts, and the rule's 409 for a second org.
      const orgCreate = await call(srv.base, PROBES['POST /api/admin/orgs'], { headers: CSRF_HEADER });
      assert.equal(orgCreate.status, 409);
      assert.equal(orgCreate.json.denied, undefined, 'the rule refuses, not the guard');
      if (posture.tag === 'open-loopback') {
        const r = await call(srv.base, PROBES['GET /api/admin/users'], { headers: { Host: `rebind.attacker.example:${port}` }, raw: true });
        assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'posture',
          'on a server without sign-in the identity API answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; '
          + `no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:${port}, `
          + 'or use the CLIs from this machine (npm run users -- add <login>, passwd <login>, owner <login>)']);
        const direct = await call(srv.base, PROBES['GET /api/admin/users'], { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` }, raw: true });
        assert.deepEqual([direct.status, direct.json.users], [200, []], 'Host localhost with its own Origin is a direct request');
      } else {
        const r = await call(srv.base, PROBES['GET /api/admin/users'], { headers: CSRF_HEADER });
        assert.deepEqual([r.status, r.json.denied], [403, 'posture']);
        assert.match(r.json.error, /^the identity API is closed on a server bound to 0\.0\.0\.0 without sign-in \(OBSERVOGRAM_INSECURE_NO_AUTH=1/);
        // The MCP endpoint changes are closed here too, under their own name.
        const ep = await call(srv.base, PROBES['POST /api/mcp-endpoints'], { headers: CSRF_HEADER, body: JSON.stringify(MCP_BODY) });
        assert.deepEqual([ep.status, ep.json.denied], [403, 'posture']);
        assert.match(ep.json.error, /^the MCP endpoints is closed on a server bound to 0\.0\.0\.0 without sign-in \(OBSERVOGRAM_INSECURE_NO_AUTH=1/);
        assert.deepEqual((await call(srv.base, PROBES['GET /api/mcp-endpoints'])).json, { ok: true, endpoints: [] }, 'the list is a read: open');
      }

      // Open loopback: identity writes from this machine, and their audit (§14.2).
      if (posture.tag === 'open-loopback') {
        const seq = await auditSeq(ws);
        const lena = JSON.stringify({ login: 'lena', password: 'lena-passw0rd' });
        let r = await call(srv.base, ['POST', '/api/admin/users'], { body: lena });
        assert.deepEqual([r.status, r.json.denied], [403, 'csrf'], 'without the header');
        r = await call(srv.base, ['POST', '/api/admin/users'], { headers: { ...CSRF_HEADER, Host: `rebind.attacker.example:${port}` }, body: lena, raw: true });
        assert.deepEqual([r.status, r.json.denied], [403, 'posture'], 'a foreign Host');
        r = await call(srv.base, ['POST', '/api/admin/users'], { headers: CSRF_HEADER, body: lena });
        assert.equal(r.status, 201, r.text);
        assert.deepEqual([r.json.user.login, r.json.user.owner, r.json.owner, r.json.armed, r.json.joined, r.json.note],
          ['lena', true, true, true, [{ orgId: 'default', role: 'admin' }], null], 'the first local user is an owner (A-16), and it arms the store');
        r = await call(srv.base, ['POST', '/api/admin/orgs'], { headers: CSRF_HEADER, body: JSON.stringify({ id: 'acme' }) });
        assert.deepEqual([r.status, r.json], [409, {
          ok: false,
          error: 'creating a second org needs identity: this server runs with OBSERVOGRAM_AUTH=off, and a second org would make its next start refuse '
            + '— restart it without OBSERVOGRAM_AUTH=off and sign in as an owner (npm run users -- add <login> first when no user exists), or configure OIDC',
        }]);
        r = await call(srv.base, ['GET', '/api/packs']);
        assert.equal(r.status, 200, 'still no sign-in: OBSERVOGRAM_AUTH=off');

        // The MCP endpoint cells (slice 4): without the header → 403 csrf
        // under their own text; a foreign Host or a proxy header → 403
        // posture, with no CLI way out; then the create by `local`, its
        // view the admin's (url and variable present), and its row.
        const body = JSON.stringify(MCP_BODY);
        r = await call(srv.base, PROBES['POST /api/mcp-endpoints'], { body });
        assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'csrf',
          "missing X-Observogram-CSRF: 1 — changes to the MCP endpoints need it in every posture, so a cross-site form cannot make them (the studio sends it; with curl add -H 'X-Observogram-CSRF: 1')"]);
        for (const [label, extra] of [['a foreign Host', { Host: `rebind.attacker.example:${port}` }], ['X-Forwarded-For', { 'X-Forwarded-For': '203.0.113.9' }]]) {
          r = await call(srv.base, PROBES['POST /api/mcp-endpoints'], { headers: { ...CSRF_HEADER, ...extra }, body, raw: true });
          assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'posture',
            'on a server without sign-in the MCP endpoints answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; '
            + `no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:${port}`], label);
        }
        r = await call(srv.base, PROBES['POST /api/mcp-endpoints'], { headers: CSRF_HEADER, body });
        assert.equal(r.status, 201, r.text);
        assert.deepEqual({ ...r.json.endpoint, id: 'ID', createdAt: 'T' }, {
          id: 'ID', name: 'local-mcp', origin: 'https://mcp.local.test', url: MCP_BODY.url, readTokenEnv: MCP_BODY.readTokenEnv, environments: 0, createdAt: 'T',
        }, 'the admin\'s own view');
        r = await call(srv.base, PROBES['GET /api/mcp-endpoints']);
        assert.deepEqual(r.json.endpoints.map((e) => [e.name, e.url]), [['local-mcp', MCP_BODY.url]], 'local, an owner, reads the url');
        writes = async () => assert.deepEqual(await auditRowsAfter(ws, seq), [
          ['user.create', 'local', null, 'lena', { kind: 'local', isOwner: false, sessionEpoch: 1, disabled: false }],
          ['owner.first-local-user', 'system', null, 'lena', { via: 'api', match: null, org: 'default', membership: 'added', from: null }],
          ['meta.set', 'local', null, 'identity_armed', null],
          ['mcp_endpoint.create', 'local', 'default', 'local-mcp', { fields: ['name', 'url', 'readTokenEnv'], origin: 'https://mcp.local.test', readTokenEnv: MCP_BODY.readTokenEnv }],
        ], 'actor local, system for the grant; nothing from the refused requests');
      }
    } finally {
      await srv.stop();
    }
    await writes?.();
  });
}

// ---- Arming, the API half: an exposed server whose users change ----
test('Arming, the API half: on an exposed server seeded with OBSERVOGRAM_ADMIN_PASSWORD, users change through the API and an anonymous read is never answered', { timeout: 120_000 }, async () => {
  const ws = freshWorkspace('arming');
  const ADMIN_PW = 'arming-admin-passw0rd';
  const srv = await serve(ws, { host: '0.0.0.0', env: { OBSERVOGRAM_ADMIN_PASSWORD: ADMIN_PW } });
  try {
    const anonymousRead = async (when) => {
      const r = await call(srv.base, ['GET', '/api/packs']);
      assert.deepEqual([r.status, r.json?.denied], [401, 'auth'], `${when}: an anonymous GET /api/packs`);
    };
    await anonymousRead('at the start');
    const s = await signIn(srv.base, 'admin', ADMIN_PW);
    assert.ok(s.session && !s.pwflow?.split('=')[1], 'the seeded admin signs in, no forced change (a pwflow cookie, if any, is cleared)');
    const h = { Cookie: s.session, ...CSRF_HEADER };
    let r = await call(srv.base, ['POST', '/api/admin/users'], { headers: h, body: JSON.stringify({ login: 'bob', password: 'bob-passw0rd-1' }) });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.owner, r.json.armed, r.json.joined, r.json.note], [false, false, [{ orgId: 'default', role: 'operator' }], null]);
    const bob = r.json.user.id;
    await anonymousRead('after bob is created');
    r = await call(srv.base, ['POST', `/api/admin/users/${bob}/disable`], { headers: h });
    assert.deepEqual([r.status, r.json.user.disabled, r.json.you], [200, true, false]);
    await anonymousRead('after bob is disabled');
    const admin = (await call(srv.base, ['GET', '/api/admin/users'], { headers: h })).json.users.find((u) => u.login === 'admin');
    r = await call(srv.base, ['POST', `/api/admin/users/${admin.id}/disable`], { headers: h });
    assert.deepEqual([r.status, r.json], [409, {
      ok: false, error: 'admin is the last enabled owner — make another user an owner first (PUT /api/admin/users/<id>/owner with {"owner": true})',
    }]);
    await anonymousRead('after the refused disable');
  } finally {
    await srv.stop();
  }
});

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
    r = await fetch(`${srv.base}/auth/signout-others`, { method: 'POST', headers: { Cookie: s.pwflow, 'X-Observogram-CSRF': '1', Accept: 'application/json' } });
    assert.deepEqual([r.status, (await r.json()).denied], [401, 'auth'], 'nor is it one to sign out the other sessions');

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

    // Beside a session, a pwflow cookie never wins on POST /auth/signout-others
    // (session only): the session signs out the others — and the bump ends
    // the pending forced change too.
    r = await fetch(`${srv.base}/auth/signout-others`, { method: 'POST', headers: { Cookie: `${s.pwflow}; ${session}`, 'X-Observogram-CSRF': '1', Accept: 'application/json' } });
    assert.equal(r.status, 200);
    r = await fetch(`${srv.base}/auth/change-password`, { headers: { Cookie: s.pwflow }, redirect: 'manual' });
    assert.deepEqual([r.status, r.headers.get('location')], [302, '/auth/login'], 'the pwflow cookie of before is refused');
  } finally {
    await srv.stop();
  }
});
