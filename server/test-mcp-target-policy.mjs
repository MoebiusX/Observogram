#!/usr/bin/env node
/**
 * server/test-mcp-target-policy.mjs — server/mcp-target-policy.mjs, in
 * process: the origin allowlist (parsing, loopback, the per-org list and
 * its owner, the rule per use and credential) over a temp store, and
 * redactTarget, the route-level backstop every MCP route runs its 502
 * bodies, deploy-record errors and log lines through. The rule at the
 * routes' resolver is server/test-service-admin.mjs's.
 */

// Hermetic (§0): the children's STRIP list, both spellings, before any server
// module loads (serve-child.mjs imports no server code).
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const {
  redactTarget, parseOriginList, isLoopbackOrigin, originOf, mcpOriginList, mcpOriginDecision, credentialThatRides, mcpRefusalBody,
  MCP_ORIGINS_VAR, orgMcpOriginsVar,
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
  return { db, close: () => closeStore(path) };
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
