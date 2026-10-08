#!/usr/bin/env node
/**
 * server/test-mcp-target-policy.mjs — server/mcp-target-policy.mjs, in
 * process: the typed-URL rule (TYPED_MCP_URL_ROLE, by rank for sessions and
 * the bearer, by kind for the anonymous local caller) and what
 * GET /api/mcp-endpoints says of it, the origin allowlist (parsing,
 * loopback, the per-org list and its owner, the rule per use and
 * credential) over a temp store, and
 * redactTarget, the route-level backstop every MCP route runs its 502
 * bodies, deploy-record errors and log lines through. The rule at the
 * routes' resolver is server/test-service-admin.mjs's.
 */

// Hermetic (§0): the children's STRIP list, both spellings, before any server
// module loads (serve-child.mjs imports no server code).
const { STRIP, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
dropInheritedOrgVars();
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const {
  redactTarget, parseOriginList, isLoopbackOrigin, originOf, mcpOriginList, mcpOriginDecision, credentialThatRides, mcpRefusalBody,
  MCP_ORIGINS_VAR, orgMcpOriginsVar, TYPED_MCP_URL_ROLE, typedMcpUrlDecision, mcpCallerOf, mcpTargetView,
} = await import('./mcp-target-policy.mjs');
const { closeStore, openStore } = await import('./store/db.mjs');
const { runWithOrg } = await import('./tenancy.mjs');
const orgs = await import('./store/orgs.mjs');
const mcpEndpoints = await import('./store/mcp-endpoints.mjs');

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
async function freshStore(...orgIds) {
  const d = mkdtempSync(join(tmpdir(), 'observogram-mcp-policy-'));
  tmpDirs.push(d);
  const path = join(d, 'observogram.db');
  const db = await openStore({ path });
  for (const id of orgIds) orgs.createOrg(db, 'system', { id, name: id });
  return { db, path, close: () => closeStore(path) };
}

// stderr lines written while fn runs.
async function stderrOf(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true; };
  try { await fn(); } finally { process.stderr.write = write; }
  return lines.join('');
}

test('redactTarget: the resolved token, wherever the text repeats it', () => {
  const target = { mcpUrl: 'https://mcp.example.com/mcp', mcpAuth: 'tok-1234' };
  assert.equal(redactTarget('MCP HTTP 401 on initialize: you sent Bearer tok-1234 (tok-1234)', target),
    'MCP HTTP 401 on initialize: you sent Bearer <redacted> (<redacted>)');
  assert.equal(redactTarget('nothing secret here', target), 'nothing secret here');
});

test('redactTarget: userinfo, decoded and as written, and any //user:pass@ left', () => {
  const target = { mcpUrl: 'https://us%40er:p%3Ass@mcp.example.com/mcp', mcpAuth: null };
  assert.equal(redactTarget('as written us%40er:p%3Ass, decoded us@er and p:ss', target), 'as written <redacted>:<redacted>, decoded <redacted> and <redacted>');
  assert.equal(redactTarget('fetch https://someone:else@other.example/x failed', target), 'fetch https://***@other.example/x failed');
});

test('redactTarget: credential-named query values, decoded and encoded; other parameters kept', () => {
  const target = { mcpUrl: 'https://mcp.example.com/mcp?api_key=a%2Fb%2Bc&tier=x&token=zz-9', mcpAuth: null };
  assert.equal(redactTarget('GET /mcp?api_key=a%2Fb%2Bc&tier=x&token=zz-9 said a/b+c', target), 'GET /mcp?api_key=<redacted>&tier=x&token=<redacted> said <redacted>');
});

test('redactTarget: longest first, so a secret containing another goes whole', () => {
  const target = { mcpUrl: 'https://mcp.example.com/mcp?token=abc', mcpAuth: 'abcdef' };
  assert.equal(redactTarget('abcdef and abc', target), '<redacted> and <redacted>');
});

test('redactTarget: null or undefined text is empty; a null target or one without a URL still redacts what it can', () => {
  assert.equal(redactTarget(undefined, { mcpAuth: 'x1' }), '');
  assert.equal(redactTarget(null, null), '');
  assert.equal(redactTarget('Bearer x1y2', { mcpAuth: 'x1y2' }), 'Bearer <redacted>');
  assert.equal(redactTarget('see http://u:p@h/', null), 'see http://***@h/');
  assert.equal(redactTarget(new Error('boom tok').message, { mcpUrl: 'not a url', mcpAuth: 'tok' }), 'boom <redacted>');
});

// ---------- the origin allowlist ----------

test('parseOriginList: an origin as the URL parser normalises it; `*`; every entry that cannot match or carries credentials rejected, never kept', () => {
  const p = parseOriginList(' HTTPS://Mcp.Example.com:443 , http://mcp.lab.test:3001/, https://mcp.example.com., https://bücher.example ');
  assert.deepEqual([...p.origins], ['https://mcp.example.com', 'http://mcp.lab.test:3001', 'https://mcp.example.com.', 'https://xn--bcher-kva.example']);
  assert.deepEqual([p.any, p.rejected], [false, []]);
  const bad = ['localhost:8080', 'https://*.example.com', 'https://u:p@mcp.example.com', 'https://mcp.example.com/mcp', 'https://mcp.example.com/?x=1',
    'https://mcp.example.com/?', 'https://mcp.example.com#f', 'ftp://mcp.example.com', 'mcp.example.com', 'https://evil.com\\@mcp.example.com/'];
  const r = parseOriginList(bad.join(','));
  assert.deepEqual([r.any, [...r.origins], r.rejected], [false, [], bad]);
  assert.deepEqual(parseOriginList('*'), { any: true, origins: new Set(), rejected: [] });
  assert.deepEqual(parseOriginList(' , ,'), { any: false, origins: new Set(), rejected: [] }, 'no entry at all');
  assert.equal(parseOriginList(null).origins.size, 0);
});

test('isLoopbackOrigin and originOf: this machine after normalisation; the backslash form is the host before it', () => {
  for (const yes of ['http://localhost:3000', 'http://127.0.0.1', 'http://127.255.0.9:1', 'http://[::1]:9', 'http://[::ffff:127.0.0.1]/', 'http://0x7f.1/', 'https://LOCALHOST/']) assert.ok(isLoopbackOrigin(yes), yes);
  for (const no of ['http://localhost.:3', 'http://127.evil.example', 'http://10.0.0.1', 'http://[::2]', 'http://[::ffff:10.0.0.1]', 'https://mcp.example.com', 'not a url', 'http://app.localhost']) assert.ok(!isLoopbackOrigin(no), no);
  assert.equal(originOf('http://[::ffff:127.0.0.1]/x'), 'http://[::ffff:7f00:1]');
  assert.equal(originOf('https://evil.com\\@mcp.example.com/'), 'https://evil.com');
  assert.equal(originOf('https://u:p@MCP.example.com:443/mcp?token=1'), 'https://mcp.example.com');
  assert.equal(originOf('file:///etc/passwd'), null);
  assert.equal(originOf('nope'), null);
});

test('mcpOriginList: unset or empty is no list; the deployment\'s and the org\'s variables unioned; the org\'s read only by the org owning its name (longest prefix: ab never reads OBSERVOGRAM_ORG_AB_MCP_ORIGINS beside ab-mcp); `*` and every rejected entry said once on stderr', async () => {
  const { db, close } = await freshStore('ab', 'ab-mcp', 'acme');
  try {
    assert.equal(MCP_ORIGINS_VAR, 'OBSERVOGRAM_MCP_ORIGINS');
    assert.equal(orgMcpOriginsVar('pay-eu'), 'OBSERVOGRAM_ORG_PAY_EU_MCP_ORIGINS');
    assert.deepEqual(mcpOriginList(db, 'acme', {}), { set: false });
    assert.deepEqual(mcpOriginList(db, 'acme', { OBSERVOGRAM_MCP_ORIGINS: '  ' }), { set: false });
    assert.deepEqual(mcpOriginList(db, 'acme', { TOMOGRAPH_MCP_ORIGINS: 'https://old.example' }).origins, new Set(['https://old.example']), 'the legacy spelling (brand-env)');
    const both = mcpOriginList(db, 'acme', { OBSERVOGRAM_MCP_ORIGINS: 'https://g.example', OBSERVOGRAM_ORG_ACME_MCP_ORIGINS: 'https://acme.example' });
    assert.deepEqual(both, { set: true, any: false, origins: new Set(['https://g.example', 'https://acme.example']), from: ['deployment', 'org'] });
    assert.deepEqual(mcpOriginList(db, 'acme', { OBSERVOGRAM_ORG_ACME_MCP_ORIGINS: 'https://acme.example' }).from, ['org']);
    // OBSERVOGRAM_ORG_AB_MCP_ORIGINS is org ab-mcp's (its prefix OBSERVOGRAM_ORG_AB_MCP_ is longer), so org ab never reads it
    const env = { OBSERVOGRAM_ORG_AB_MCP_ORIGINS: 'https://ab.example' };
    assert.deepEqual(mcpOriginList(db, 'ab', env), { set: false });
    assert.deepEqual(mcpOriginList(db, 'acme', env), { set: false }, 'nor another org');
    // set but nothing accepted: fail closed
    let said = await stderrOf(() => assert.deepEqual(mcpOriginList(db, 'acme', { OBSERVOGRAM_MCP_ORIGINS: 'mcp.zz.example, https://*.zz.example' }),
      { set: true, any: false, origins: new Set(), from: ['deployment'] }));
    assert.match(said, /OBSERVOGRAM_MCP_ORIGINS: "mcp\.zz\.example" is not an origin \(http\(s\):\/\/host\[:port\], no path, no credentials\) — ignored/);
    assert.match(said, /OBSERVOGRAM_MCP_ORIGINS: "https:\/\/\*\.zz\.example" is not an origin/);
    said = await stderrOf(() => mcpOriginList(db, 'acme', { OBSERVOGRAM_MCP_ORIGINS: 'mcp.zz.example' }));
    assert.equal(said, '', 'once per process');
    said = await stderrOf(() => assert.equal(mcpOriginList(db, 'acme', { OBSERVOGRAM_ORG_ACME_MCP_ORIGINS: '*' }).any, true));
    assert.match(said, /every MCP origin is allowed \(OBSERVOGRAM_ORG_ACME_MCP_ORIGINS=\*\)/);
  } finally {
    close();
  }
});

test('credentialThatRides: the strongest that rides — the endpoint\'s variable, mcpAuth, one in the URL, a loaded hook; none otherwise', () => {
  assert.equal(credentialThatRides({ hook: false }), 'none');
  assert.equal(credentialThatRides({ url: 'https://mcp.example/mcp?tier=x', hook: false }), 'none');
  assert.equal(credentialThatRides({ url: 'https://mcp.example/mcp?api_key=x', hook: false }), 'url');
  assert.equal(credentialThatRides({ url: 'https://u@mcp.example/', hook: false }), 'url');
  assert.equal(credentialThatRides({ url: 'https://mcp.example/', hook: true }), 'hook', 'a loaded hook makes every request credential-bearing');
  assert.equal(credentialThatRides({ requestToken: true, url: 'https://mcp.example/?token=1', hook: true }), 'request');
  assert.equal(credentialThatRides({ serverToken: true, requestToken: true, hook: true }), 'server');
  assert.equal(credentialThatRides({}), 'none', 'no hook loaded in this process');
});

test('mcpOriginDecision: every row — loopback passes; a list set admits its origins only; unset, a credential (each kind named) goes to loopback only, a typed URL without one to the org\'s endpoint origins only, a registered endpoint and a token-less registration anywhere', async () => {
  const { db, close } = await freshStore('acme', 'bravo');
  try {
    runWithOrg('acme', () => {
      mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'known', url: 'https://known.example/mcp' });
      const unset = {};
      const d = (url, opts, env = unset) => mcpOriginDecision(db, url, { env, ...opts });
      const deny = (error) => ({ status: 403, denied: 'origin', error });
      for (const use of ['typed', 'registered', 'register']) {
        for (const credential of ['none', 'server', 'request', 'url', 'hook']) {
          assert.equal(d('http://127.0.0.1:9/mcp', { use, credential }), null, `${use}/${credential} loopback`);
          assert.equal(d('https://listed.example/mcp', { use, credential }, { OBSERVOGRAM_MCP_ORIGINS: 'https://listed.example' }), null, `${use}/${credential} listed`);
          assert.equal(d('https://listed.example/mcp', { use, credential }, { OBSERVOGRAM_MCP_ORIGINS: '*' }), null, `${use}/${credential} any`);
          assert.equal(d('https://known.example/mcp', { use, credential }, { OBSERVOGRAM_MCP_ORIGINS: 'https://listed.example' })?.denied, 'origin', `${use}/${credential} set, not listed`);
          if (credential !== 'none') assert.equal(d('https://known.example/mcp', { use, credential })?.denied, 'origin', `${use}/${credential} unset`);
        }
      }
      // unset, no credential
      assert.equal(d('https://known.example/other', { use: 'typed' }), null, 'typed: an origin of the org\'s endpoints');
      assert.deepEqual(d('https://new.example/mcp?q=1', { use: 'typed' }), deny('https://new.example is not an origin this org\'s MCP endpoints use — an admin registers the endpoint in Settings → MCP endpoints, or the server\'s operator lists the origin in OBSERVOGRAM_MCP_ORIGINS (or OBSERVOGRAM_ORG_ACME_MCP_ORIGINS)'));
      assert.equal(runWithOrg('bravo', () => d('https://known.example/mcp', { use: 'typed' }))?.denied, 'origin', 'another org\'s endpoint origin is not this org\'s');
      assert.equal(d('https://new.example/mcp', { use: 'registered' }), null);
      assert.equal(d('https://new.example/mcp', { use: 'register' }), null);
      // the credential texts
      const cred = (what, tail = '') => deny(`https://new.example is not a listed MCP origin, and the server sends a credential (${what}) only to a listed origin or this machine — the server's operator adds https://new.example to OBSERVOGRAM_MCP_ORIGINS (or OBSERVOGRAM_ORG_ACME_MCP_ORIGINS)${tail}`);
      assert.deepEqual(d('https://new.example/mcp', { use: 'registered', credential: 'server', tokenVar: 'OBSERVOGRAM_ORG_ACME_T' }), cred('the endpoint\'s variable OBSERVOGRAM_ORG_ACME_T'));
      assert.deepEqual(d('https://new.example/mcp', { use: 'register', credential: 'server', tokenVar: 'OBSERVOGRAM_ORG_ACME_T' }), cred('the endpoint\'s variable OBSERVOGRAM_ORG_ACME_T', ', or register it without readTokenEnv'));
      assert.deepEqual(d('https://new.example/mcp', { use: 'registered', credential: 'request' }), cred('the auth key sent with this request', ', or send the request without mcpAuth'));
      assert.deepEqual(d('https://new.example/mcp', { use: 'typed', credential: 'url' }), cred('a credential in the URL', ', or send the URL without its credential'));
      assert.deepEqual(d('https://new.example/mcp', { use: 'registered', credential: 'hook' }), cred('the transport hook\'s'));
      // the caller's org, when given, is the org judged
      assert.equal(d('https://new.example/', { use: 'registered', credential: 'request', caller: { org: 'bravo' } }).error.includes('OBSERVOGRAM_ORG_BRAVO_MCP_ORIGINS'), true);
      // a trailing dot and IDN: compared as the parser writes them
      assert.equal(d('https://listed.example./', { use: 'registered', credential: 'request' }, { OBSERVOGRAM_MCP_ORIGINS: 'https://listed.example' })?.denied, 'origin', 'a trailing dot does not match without it');
      assert.equal(d('https://xn--bcher-kva.example/mcp', { use: 'registered', credential: 'request' }, { OBSERVOGRAM_MCP_ORIGINS: 'https://bücher.example' }), null, 'a Unicode entry matches its punycode URL');
      assert.equal(d('https://evil.com\\@listed.example/', { use: 'typed' }, { OBSERVOGRAM_MCP_ORIGINS: 'https://listed.example' })?.denied, 'origin', 'the backslash form is evil.com');
      // the list-set texts, by source
      assert.deepEqual(d('https://new.example/', { use: 'registered' }, { OBSERVOGRAM_MCP_ORIGINS: 'https://listed.example', OBSERVOGRAM_ORG_ACME_MCP_ORIGINS: 'https://other.example' }),
        deny('https://new.example is not in OBSERVOGRAM_MCP_ORIGINS, nor in OBSERVOGRAM_ORG_ACME_MCP_ORIGINS — the server\'s operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or choose another registered endpoint'));
      assert.deepEqual(d('https://new.example/', { use: 'register' }, { OBSERVOGRAM_ORG_ACME_MCP_ORIGINS: 'https://other.example' }),
        deny('https://new.example is not in OBSERVOGRAM_ORG_ACME_MCP_ORIGINS — the server\'s operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or register an endpoint at a listed origin'));
      assert.deepEqual(d('not a url', { use: 'typed' }), deny('the MCP URL is not an http(s) URL'));
      assert.throws(() => d('https://x.example/', { use: 'fetch' }), TypeError);
      assert.throws(() => d('https://x.example/', { use: 'typed', credential: 'cookie' }), TypeError);
      assert.deepEqual(mcpRefusalBody(deny('no')), { ok: false, error: 'no', denied: 'origin' });
      assert.deepEqual(mcpRefusalBody({ status: 400, error: 'bad' }), { ok: false, error: 'bad' });
    });
  } finally {
    close();
  }
});

test('mcpOriginDecision at registration without sign-in (D4): the anonymous local caller registers only a loopback MCP or a listed origin, token or not — the way out names the list and arming sign-in (a restart under OBSERVOGRAM_AUTH=off); a session admin\'s token-less registration stays allowed', async () => {
  const { db, close } = await freshStore('acme');
  try {
    runWithOrg('acme', () => {
      const local = { principal: { kind: 'local', actor: 'local', role: 'admin', owner: true }, org: 'acme', port: 8123, posture: 'open-loopback', direct: true, authOff: false };
      const admin = { ...local, principal: { kind: 'session', actor: 'ada', role: 'admin', owner: false }, posture: 'identity', direct: false };
      const d = (url, opts, env = {}) => mcpOriginDecision(db, url, { use: 'register', env, ...opts });
      const D4 = 'on a server without sign-in, only a loopback MCP or an origin listed in OBSERVOGRAM_MCP_ORIGINS may be registered — list https://demo.example there, or sign in as an admin (npm run users -- add <login> arms sign-in)';
      for (const credential of ['none', 'server']) {
        assert.deepEqual(d('https://demo.example/mcp?tier=1', { caller: local, credential }), { status: 403, denied: 'origin', error: D4 }, `local, ${credential}: the origin only`);
        assert.equal(d('http://127.0.0.1:3001/mcp', { caller: local, credential }), null, `local, ${credential}: loopback`);
        assert.equal(d('http://[::1]:3001/mcp', { caller: local, credential }), null, `local, ${credential}: [::1]`);
        assert.equal(d('https://demo.example/mcp', { caller: local, credential }, { OBSERVOGRAM_MCP_ORIGINS: 'https://demo.example' }), null, `local, ${credential}: listed`);
        assert.equal(d('https://demo.example/mcp', { caller: local, credential }, { OBSERVOGRAM_ORG_ACME_MCP_ORIGINS: 'https://demo.example' }), null, `local, ${credential}: listed for the org`);
        assert.equal(d('https://demo.example/mcp', { caller: local, credential }, { OBSERVOGRAM_MCP_ORIGINS: '*' }), null, `local, ${credential}: any`);
      }
      assert.match(d('https://demo.example/', { caller: local }, { OBSERVOGRAM_MCP_ORIGINS: 'https://other.example' }).error, /^https:\/\/demo\.example is not in OBSERVOGRAM_MCP_ORIGINS — /, 'a list set: its own text');
      assert.equal(d('https://demo.example/', { caller: { ...local, authOff: true } }).error,
        'on a server without sign-in, only a loopback MCP or an origin listed in OBSERVOGRAM_MCP_ORIGINS may be registered — list https://demo.example there, or sign in as an admin (restart it without OBSERVOGRAM_AUTH=off once a user exists — npm run users -- add <login>)');
      assert.equal(d('https://demo.example/mcp', { caller: admin }), null, 'a session admin registers a token-less endpoint anywhere');
      assert.equal(d('https://demo.example/mcp', {}), null, 'no caller: judged as before (the registration functions require one)');
      for (const use of ['typed', 'registered']) assert.notEqual(d('https://demo.example/mcp', { use, caller: local })?.error, D4, `${use}: not a registration`);
    });
  } finally {
    close();
  }
});

// ---------- the typed-URL rule ----------

const SESSION = (role, owner = false) => ({ kind: 'session', actor: role, role, owner });
const BEARER = { kind: 'bearer', actor: 'ci-bot', role: 'operator', owner: false };
const LOCAL = { kind: 'local', actor: 'local', role: 'admin', owner: true };
const callerOf = (principal, extra = {}) => ({ principal, org: 'acme', port: 8123, posture: 'identity', direct: false, authOff: false, ...extra });

test('typedMcpUrlDecision: TYPED_MCP_URL_ROLE is admin — an admin or an owner may type; an operator, a viewer and the bearer are refused by rank, each told the way that works in its posture; the anonymous local caller by kind, even on loopback', () => {
  assert.equal(TYPED_MCP_URL_ROLE, 'admin');
  assert.equal(typedMcpUrlDecision(callerOf(SESSION('admin'))), null);
  assert.equal(typedMcpUrlDecision(callerOf(SESSION('viewer', true))), null, 'an owner is an admin in every org');
  assert.deepEqual(typedMcpUrlDecision(callerOf(SESSION('operator'))), {
    status: 403, denied: 'role', need: 'admin',
    error: "a typed MCP URL needs the admin role in org 'acme' (you are operator) — choose one of the org's registered MCP endpoints (mcpEndpointId; GET /api/mcp-endpoints lists them), or ask an admin of acme to register this one in Settings → MCP endpoints",
  });
  assert.match(typedMcpUrlDecision(callerOf(SESSION('viewer'))).error, /^a typed MCP URL needs the admin role in org 'acme' \(you are viewer\)/);
  assert.deepEqual(typedMcpUrlDecision(callerOf(BEARER)), {
    status: 403, denied: 'role', need: 'admin',
    error: "the bearer token acts as an operator: it fetches from the org's registered MCP endpoints only — send mcpEndpointId (GET /api/mcp-endpoints lists them); an admin of 'acme' registers a new one in Settings → MCP endpoints",
  });
  assert.equal(typedMcpUrlDecision(callerOf(BEARER, { posture: 'token' })).error,
    "the bearer token acts as an operator: it fetches from the org's registered MCP endpoints only — send mcpEndpointId (GET /api/mcp-endpoints lists them); registering one needs a signed-in admin — this server has no sign-in: add the first user with npm run users -- add <login>, or configure OIDC");
  assert.match(typedMcpUrlDecision(callerOf(BEARER, { posture: 'token', authOff: true })).error, /restart it without OBSERVOGRAM_AUTH=off, once a user exists \(npm run users -- add <login>\) or with OIDC configured$/);
  assert.deepEqual(typedMcpUrlDecision(callerOf(LOCAL, { posture: 'open-loopback', direct: true })), {
    status: 403, denied: 'posture',
    error: 'a typed MCP URL is refused on a server without sign-in, even from this machine — choose a registered MCP endpoint (mcpEndpointId), or register one in Settings → MCP endpoints from http://127.0.0.1:8123 (a loopback MCP, or an origin listed in OBSERVOGRAM_MCP_ORIGINS)',
  });
  assert.deepEqual(typedMcpUrlDecision(callerOf(LOCAL, { posture: 'open-exposed' })), {
    status: 403, denied: 'posture',
    error: 'a typed MCP URL is refused on a server without sign-in, and MCP endpoints cannot be registered while it is exposed — add the first user with npm run users -- add <login> (it arms sign-in; the first user is an owner), or bind the server to loopback',
  });
  for (const c of [callerOf({ kind: 'anonymous', actor: null, role: 'viewer', owner: false }, { posture: 'token' }), callerOf(null), null]) {
    assert.equal(typedMcpUrlDecision(c)?.denied, 'role', 'fail closed');
  }
});

test('typedMcpUrlDecision: the constant flips in one place — with role operator a session operator and the bearer may type, a viewer may not, and local still may not', () => {
  const flip = { role: 'operator' };
  assert.equal(typedMcpUrlDecision(callerOf(SESSION('operator')), flip), null);
  assert.equal(typedMcpUrlDecision(callerOf(BEARER), flip), null, 'the bearer is judged by rank, never refused by kind');
  assert.equal(typedMcpUrlDecision(callerOf(SESSION('viewer')), flip).need, 'operator');
  assert.equal(typedMcpUrlDecision(callerOf(LOCAL, { posture: 'open-loopback', direct: true }), flip).denied, 'posture');
});

test('mcpCallerOf: the principal, the org, the port, the posture and the direct fact of the request the org middleware stamped', async () => {
  // The posture reads the store (is sign-in armed?): a fresh one, no user.
  const { path, close } = await freshStore('acme');
  process.env.OBSERVOGRAM_DB = path;
  try {
    const req = {
      observogramPrincipal: SESSION('admin'), observogramOrg: 'acme', observogramListen: { loopback: true, host: '127.0.0.1' },
      socket: { localPort: 8123 }, headers: { host: '127.0.0.1:8123' },
    };
    const c = mcpCallerOf(req);
    assert.deepEqual(c, { principal: SESSION('admin'), org: 'acme', port: 8123, posture: 'open-loopback', direct: true, authOff: false });
    assert.equal(mcpCallerOf({ ...req, headers: { host: '127.0.0.1:8123', 'x-forwarded-for': '10.0.0.1' } }).direct, false);
    assert.deepEqual(mcpCallerOf({ headers: {} }), { principal: null, org: null, port: null, posture: 'open-exposed', direct: false, authOff: false });
  } finally {
    delete process.env.OBSERVOGRAM_DB;
    close();
  }
});

test('mcpTargetView: what GET /api/mcp-endpoints says — typed and register, allowed or why, and only the reader\'s own org\'s list', async () => {
  const { db, close } = await freshStore('acme', 'bravo');
  const saved = process.env.OBSERVOGRAM_MCP_ORIGINS;
  try {
    const view = (p, extra) => mcpTargetView(db, callerOf(p, extra));
    assert.deepEqual(view(SESSION('admin')), {
      typed: { allowed: true, why: null, listed: false, origins: [] },
      register: { allowed: true, why: null, listed: false, origins: [], listedOnly: false },
    });
    const op = view(SESSION('operator'));
    assert.deepEqual([op.typed.allowed, op.register.allowed], [false, false]);
    assert.match(op.typed.why, /^a typed MCP URL needs the admin role in org 'acme' \(you are operator\)/);
    assert.equal(op.register.why, "registering an MCP endpoint needs the admin role in org 'acme' (you are operator) — ask an admin of acme");
    const bearer = view(BEARER, { posture: 'token' });
    assert.deepEqual([bearer.typed.allowed, bearer.register.allowed], [false, false]);
    assert.match(bearer.register.why, /never registers an MCP endpoint — a signed-in admin of 'acme' registers it in Settings → MCP endpoints; this server has no sign-in: add the first user with npm run users -- add <login>/);
    const local = view(LOCAL, { posture: 'open-loopback', direct: true });
    assert.deepEqual([local.typed.allowed, local.register.allowed, local.register.why], [false, true, null], 'local registers from this machine, never types');
    assert.deepEqual([local.register.listed, local.register.origins, local.register.listedOnly], [false, [], true], 'without sign-in, only a loopback MCP or a listed origin (D4): no list, so loopback only');
    assert.equal(view(LOCAL, { posture: 'open-loopback', direct: false }).register.why, 'on a server without sign-in MCP endpoints are registered only from this machine — open the studio at http://127.0.0.1:8123');
    assert.match(view(LOCAL, { posture: 'open-exposed' }).register.why, /^MCP endpoints cannot be registered on a server without sign-in while it is exposed/);
    assert.match(view({ kind: 'anonymous', actor: null, role: 'viewer', owner: false }, { posture: 'token' }).register.why, /^anonymous callers are viewers here/);
    process.env.OBSERVOGRAM_MCP_ORIGINS = 'https://b.example,https://a.example';
    process.env.OBSERVOGRAM_ORG_BRAVO_MCP_ORIGINS = 'https://bravo-only.example';
    assert.deepEqual(view(SESSION('admin')).typed, { allowed: true, why: null, listed: true, origins: ['https://a.example', 'https://b.example'] }, "acme never sees bravo's list");
    assert.deepEqual(mcpTargetView(db, callerOf(SESSION('admin'), { org: 'bravo' })).register.origins, ['https://a.example', 'https://b.example', 'https://bravo-only.example']);
    process.env.OBSERVOGRAM_MCP_ORIGINS = '*';
    assert.deepEqual(view(SESSION('viewer')).register, { allowed: false, why: "registering an MCP endpoint needs the admin role in org 'acme' (you are viewer) — ask an admin of acme", listed: true, origins: null, listedOnly: true });
  } finally {
    if (saved === undefined) delete process.env.OBSERVOGRAM_MCP_ORIGINS; else process.env.OBSERVOGRAM_MCP_ORIGINS = saved;
    delete process.env.OBSERVOGRAM_ORG_BRAVO_MCP_ORIGINS;
    close();
  }
});
