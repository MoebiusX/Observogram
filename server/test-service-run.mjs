#!/usr/bin/env node
/**
 * server/test-service-run.mjs — a service's two places and its Run
 * (Overview's service list): the repository on the service record
 * (server/service-admin.mjs parseRepository, schema v3), the Azure DevOps
 * and GitHub readers (server/ado-crawl.mjs, server/github-crawl.mjs
 * fetchGithubFiles, server/repo-sources.mjs) against stubbed hosts, and
 * POST /api/services/:id/run in process over HTTP — the open posture on
 * loopback, a fake MCP on loopback as the environment's endpoint, a folder
 * from tools/fixtures as the repository.
 *
 * The route: every refusal before anything is read (no service, no
 * environment, no repository, no endpoint, a folder that is not there, a
 * folder with nothing to scan), then a Run end to end — the scan registered
 * as the service's own pack under its label, the journey `<slug>.<env>`
 * saved with the scan as Pack A and the endpoint as Pack B and run (its
 * record), the audit rows — and a second Run that replaces the scan and
 * keeps the journey's gate. Who may reach the route in each posture is
 * test-authz's matrix.
 */

// Hermetic (§0): a developer shell's store, identity or per-org variables
// never reach this process's imports.
const { STRIP, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();
delete process.env.GITHUB_TOKEN;
delete process.env.AZURE_DEVOPS_TOKEN;
delete process.env.OBSERVOGRAM_ADO_ORIGINS;
delete process.env.OBSERVOGRAM_REPO_ROOTS;
// No proxy from the shell: the sentences below are a direct request's (server/test-outbound-proxy.mjs has the proxy's).
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete process.env[k];

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-service-run-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
// The open posture on loopback, as `npm run demo` serves it: no sign-in.
process.env.OBSERVOGRAM_AUTH = 'off';
// A folder with nothing the crawler reads, beside the workspace.
const EMPTY_REPO = mkdtempSync(join(tmpdir(), 'observogram-service-run-empty-'));
writeFileSync(join(EMPTY_REPO, 'notes.txt'), 'nothing to scan here\n');
const REPO = join(ROOT, 'tools', 'fixtures', 'crawl', 'operational-alerts');

const { parseRepository, folderRefusal, repositoryRoots, WAYS } = await import('./service-admin.mjs');
const { parseAdoUrl, adoHostRefusal, adoFetch, listedAdoOrigins, tenantMismatch } = await import('./ado-crawl.mjs');
const { fetchGithubFiles, ghFetch, rawFetch, downloadFiles, outOfTime, planCrawlerFetch, HOST_READ_CAPS, HOST_READ_PARALLEL, HOST_READ_FILES_BUDGET_MS } = await import('./github-crawl.mjs');
const { unreachable, readSignal } = await import('./fetch-failure.mjs');
const { fetchRepositoryFiles } = await import('./repo-sources.mjs');

const LOCAL = { posture: 'open-loopback', direct: true };

// ---------- the repository rule ----------

test('parseRepository: GitHub, Azure DevOps and a folder, normalised; a branch from the URL or the body; every refusal names the way out', () => {
  assert.equal(parseRepository(undefined), undefined, 'not sent');
  assert.equal(parseRepository(null), null, 'none yet');
  assert.deepEqual(parseRepository({ kind: 'github', location: 'MoebiusX/Observogram' }), { kind: 'github', location: 'https://github.com/MoebiusX/Observogram', ref: null });
  assert.deepEqual(parseRepository({ kind: 'github', location: 'https://github.com/a/b/tree/develop' }), { kind: 'github', location: 'https://github.com/a/b', ref: 'develop' });
  assert.deepEqual(parseRepository({ kind: 'github', location: 'https://github.com/a/b.git', ref: ' main ' }), { kind: 'github', location: 'https://github.com/a/b', ref: 'main' }, 'the body\'s ref, trimmed');
  assert.deepEqual(parseRepository({ kind: 'ado', location: 'https://ada@dev.azure.com/acme/Shop/_git/checkout?version=GBrelease%2F2' }),
    { kind: 'ado', location: 'https://dev.azure.com/acme/Shop/_git/checkout', ref: 'release/2' }, 'a clone URL: the user dropped, the branch from ?version=GB');
  assert.deepEqual(parseRepository({ kind: 'path', location: REPO }, { caller: LOCAL }), { kind: 'path', location: resolve(REPO), ref: null });
  const refused = (value, re, opts) => assert.throws(() => parseRepository(value, opts), (e) => e.kind === 'invalid' && re.test(e.message), JSON.stringify(value));
  refused({ kind: 'svn', location: 'x' }, /kind is github, ado or path/);
  refused({ kind: 'github', location: 'not a repo' }, /is not a GitHub repository — https:\/\/github\.com\/<owner>\/<repo>/);
  refused({ kind: 'github', location: '' }, /is not a GitHub repository/);
  refused({ kind: 'github', location: 'a/b', ref: 'has space' }, /a branch is 1–200 characters with no spaces/);
  refused({ kind: 'github', location: 'a/b', extra: 1 }, /a repository is \{ kind, location, ref \}/);
  refused('a/b', /a repository is \{ kind, location, ref \}/);
  refused({ kind: 'ado', location: 'https://github.com/a/b' }, /is not an Azure DevOps repository/);
  refused({ kind: 'ado', location: 'https://tfs.corp.test/Main/Shop/_git/checkout' }, /https:\/\/tfs\.corp\.test is not Azure DevOps Services .* OBSERVOGRAM_ADO_ORIGINS/);
  refused({ kind: 'path', location: 'relative/dir' }, /is not a folder path on the server — give its full path/, { caller: LOCAL });
  refused({ kind: 'path', location: REPO }, /taken only under the folders listed in OBSERVOGRAM_REPO_ROOTS/, { caller: { posture: 'identity', direct: false } });
  refused({ kind: 'path', location: REPO }, /OBSERVOGRAM_REPO_ROOTS/, { caller: { posture: 'open-loopback', direct: false } });
});

test('the folder rule: under a listed root, else the server\'s own machine without sign-in; an Azure DevOps Server only when its origin is listed', () => {
  const root = resolve(ROOT, 'tools', 'fixtures');
  assert.equal(folderRefusal(REPO, { posture: 'identity' }, { roots: [root] }), '', 'under a listed root, whoever asks');
  assert.equal(folderRefusal(EMPTY_REPO, LOCAL, { roots: [root] }), WAYS.repositoryFolderRoots(EMPTY_REPO), 'a list applies to the local machine too');
  assert.equal(folderRefusal(REPO, LOCAL, { roots: [] }), '');
  assert.equal(folderRefusal(REPO, { posture: 'token', direct: true }, { roots: [] }), WAYS.repositoryFolderPosture);
  assert.deepEqual(repositoryRoots(`${root},relative,${EMPTY_REPO}`), [root, resolve(EMPTY_REPO)], 'absolute folders only');
  assert.deepEqual(listedAdoOrigins('https://tfs.corp.test/, http://plain.test, nonsense'), ['https://tfs.corp.test'], 'https origins only');
  assert.equal(adoHostRefusal('https://tfs.corp.test', { listed: ['https://tfs.corp.test'] }), '');
  assert.equal(adoHostRefusal('https://acme.visualstudio.com', { listed: [] }), '');
  assert.match(adoHostRefusal('http://dev.azure.com', { listed: [] }), /https only/);
});

// ---------- Azure DevOps ----------

test('parseAdoUrl: Services (dev.azure.com, <org>.visualstudio.com), a Server collection, the project left out; not a URL it can read', () => {
  const p = (u) => parseAdoUrl(u);
  assert.deepEqual(p('https://dev.azure.com/acme/Shop/_git/checkout'), { base: 'https://dev.azure.com/acme', project: 'Shop', repo: 'checkout', ref: null, location: 'https://dev.azure.com/acme/Shop/_git/checkout' });
  assert.deepEqual(p('https://dev.azure.com/acme/_git/checkout'), { base: 'https://dev.azure.com/acme', project: 'checkout', repo: 'checkout', ref: null, location: 'https://dev.azure.com/acme/checkout/_git/checkout' }, 'the project named after the repository');
  assert.equal(p('https://acme.visualstudio.com/DefaultCollection/Shop/_git/checkout').base, 'https://acme.visualstudio.com/DefaultCollection');
  assert.equal(p('https://acme.visualstudio.com/Shop/_git/checkout').base, 'https://acme.visualstudio.com');
  assert.deepEqual(p('https://tfs.corp.test/tfs/Main/Shop/_git/checkout'), { base: 'https://tfs.corp.test/tfs/Main', project: 'Shop', repo: 'checkout', ref: null, location: 'https://tfs.corp.test/tfs/Main/Shop/_git/checkout' });
  assert.equal(p('https://dev.azure.com/a/My%20Project/_git/c.git').project, 'My Project');
  for (const bad of ['https://dev.azure.com/_git/x', 'http://dev.azure.com/a/b/_git/c', 'https://tfs.corp.test/_git/x', 'https://dev.azure.com/a/b/c', 'not a url', '', null]) assert.equal(p(bad), null, String(bad));
});

test('adoFetch: the token as Basic only to an allowed host, with the redirect suppressed; 203 and 401 read as the token, worded for whoever can fix it; the host\'s message on another error', async () => {
  const seen = [];
  const answer = (status, body, ct = 'application/json') => async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization ?? null, redirect: init.redirect, suppress: init.headers['X-TFS-FedAuthRedirect'] ?? null });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': ct } });
  };
  const ok = await adoFetch('https://dev.azure.com/acme/Shop/_apis/git/repositories/c/items', { fetchImpl: answer(200, { value: [] }), token: 'pat-SECRET' });
  assert.deepEqual(ok, { value: [] });
  assert.equal(seen[0].auth, `Basic ${Buffer.from(':pat-SECRET').toString('base64')}`);
  assert.equal(seen[0].redirect, 'manual', 'a redirect is read, never followed: the token never goes elsewhere');
  assert.equal(seen[0].suppress, 'Suppress', 'Azure DevOps is asked to refuse with a 401, not a redirect to its sign-in page');
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(203, '<html>sign in</html>', 'text/html'), token: '' }),
    (e) => e.status === 401 && e.message === 'Azure DevOps 401: this repository is not public');
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(401, ''), token: 'pat-MINE', tokenSource: 'request' }),
    (e) => e.status === 401 && e.message === 'Azure DevOps 401: not authorised to read this repository');
  assert.equal(seen.at(-1).auth, `Basic ${Buffer.from(':pat-MINE').toString('base64')}`, 'their own token, as Basic');
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(401, ''), token: 'pat-SECRET' }),
    (e) => e.status === 401 && e.message === 'Azure DevOps 401: the token in AZURE_DEVOPS_TOKEN was refused');
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(404, { message: 'TF401019: The Git repository does not exist.' }), token: '' }),
    (e) => e.status === 404 && e.message === 'Azure DevOps 404: TF401019: The Git repository does not exist.');
  const before = seen.length;
  await assert.rejects(adoFetch('https://evil.test/a/b/_apis/x', { fetchImpl: answer(200, {}), token: 'pat-SECRET' }), (e) => e.status === 400 && /OBSERVOGRAM_ADO_ORIGINS/.test(e.message));
  assert.equal(seen.length, before, 'a refused host is never fetched');
});

// How Azure DevOps Services refuses a read it will not serve (no token, a wrong one, a sign-in
// it does not take), measured against dev.azure.com on 2026-11-07: with
// `X-TFS-FedAuthRedirect: Suppress`, a 401 with JSON (TF400813); without it, a 302 to its
// sign-in page — under redirect: 'error' Node's fetch throws "fetch failed" on that. Both name
// the tenant the organization signs in through. Tenant ids with hex letters, so case matters.
const ORG_TENANT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PERSON_TENANT = 'ffffffff-1111-4222-8333-444444444444';
const WWW = `Bearer authorization_uri=https://login.microsoftonline.com/${ORG_TENANT}, Basic realm="https://tfsprod-example.app.visualstudio.com/"`;
const jwtFor = (tid) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ tid, upn: 'ada@contoso.example' })).toString('base64url')}.sig`;
const adoRefusal = (init, { status = 302, location = 'https://spsprod-example.vssps.visualstudio.com/_signin?realm=dev.azure.com', www = WWW } = {}) => {
  if (init.headers?.['X-TFS-FedAuthRedirect'] === 'Suppress') {
    return new Response(JSON.stringify({ message: "TF400813: The user '' is not authorized to access this resource." }), { status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'www-authenticate': www } });
  }
  if (init.redirect === 'error') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
  return new Response('<html>sign in</html>', { status, headers: { 'content-type': 'text/html; charset=utf-8', location, ...(www ? { 'www-authenticate': www } : {}) } });
};
// A host that ignores the suppress header and redirects anyway (an older Server, a proxy).
const redirectAnyway = (seen, opts) => async (url, init) => {
  seen.push({ url, auth: init.headers.Authorization ?? null, redirect: init.redirect });
  return adoRefusal({ ...init, headers: { ...init.headers, 'X-TFS-FedAuthRedirect': undefined } }, opts);
};

test('adoFetch: a refusal reads as the token, the fact worded for whoever can fix it — Azure DevOps\'s 401 (asked to suppress its redirect), or a redirect to its sign-in page, of any 3xx, never followed; a refused sign-in names both tenants when they differ', async () => {
  const URL_ = 'https://dev.azure.com/acme/Private/_apis/git/repositories/shop/items?scopePath=/';
  const each = [
    [{ token: '' }, 'Azure DevOps 401: this repository is not public'],
    [{ token: 'pat-MINE-0000', tokenSource: 'request' }, 'Azure DevOps 401: not authorised to read this repository'],
    [{ token: 'pat-SERVER-0000' }, 'Azure DevOps 401: the token in AZURE_DEVOPS_TOKEN was refused'],
    [{ token: jwtFor(PERSON_TENANT), tokenSource: 'link' }, `Azure DevOps 401: not authorised to read this repository: this organization signs in through Entra tenant ${ORG_TENANT}, and your sign-in is for tenant ${PERSON_TENANT}`],
    [{ token: jwtFor(ORG_TENANT.toUpperCase()), tokenSource: 'link' }, 'Azure DevOps 401: not authorised to read this repository'],
  ];
  // Suppressed: the 401 Azure DevOps sends to a call that asks for it.
  for (const [opts, message] of each) {
    await assert.rejects(adoFetch(URL_, { fetchImpl: async (url, init) => adoRefusal(init), ...opts }), (e) => e.status === 401 && e.message === message, message);
  }
  // Not suppressed: the redirect to its sign-in page, whatever 3xx it comes as.
  for (const status of [301, 302, 303, 307, 308]) {
    const seen = [];
    for (const [opts, message] of each) {
      await assert.rejects(adoFetch(URL_, { fetchImpl: redirectAnyway(seen, { status }), ...opts }), (e) => e.status === 401 && e.message === message, `${status}: ${message}`);
    }
    assert.ok(seen.every((s) => s.redirect === 'manual' && s.url === URL_), `${status}: one call each, the sign-in page never fetched`);
  }
  // Entra ID's sign-in as the Location, or a challenge beside any Location: the same refusal.
  await assert.rejects(adoFetch(URL_, { fetchImpl: redirectAnyway([], { location: `https://login.microsoftonline.com/${ORG_TENANT}/oauth2/authorize`, www: null }), token: '' }), (e) => e.status === 401);
  await assert.rejects(adoFetch(URL_, { fetchImpl: redirectAnyway([], { location: 'https://elsewhere.example/x' }), token: '' }), (e) => e.status === 401, 'a challenge beside it');
});

test('adoFetch: a redirect anywhere but the sign-in page is named as one — to another host, or to a page on the same host (a sign-in page or a proxy answering for the repository) — never followed, never read as the token, the person not asked', async () => {
  process.env.OBSERVOGRAM_ADO_ORIGINS = 'https://tfs.corp.example';
  try {
    const seen = [];
    const moved = redirectAnyway(seen, { status: 302, location: 'https://tfs.corp.example.com/DefaultCollection/Shop/_apis/git/repositories/c/items', www: null });
    const tokens = [{ token: 'pat-MINE-0000', tokenSource: 'request' }, { token: 'pat-SERVER-0000' }, { token: '' }];
    for (const opts of tokens) {
      await assert.rejects(adoFetch('https://tfs.corp.example/DefaultCollection/Shop/_apis/git/repositories/c/items', { fetchImpl: moved, ...opts }),
        (e) => e.status === undefined && e.message === "Azure DevOps 302: https://tfs.corp.example redirects this read to https://tfs.corp.example.com, which the server does not follow — give the repository's address on the host that serves it");
    }
    // The request's own origin (a Server that ignores the suppress header, a sign-in proxy): there is no
    // other address to give, and the query — which may carry a reply address — is never quoted.
    const SAME_HOST = "Azure DevOps 302: https://tfs.corp.example redirects this read to /tfs/_signin on the same host, which the server does not follow — a sign-in page or a proxy in front of the repository answers instead of it";
    const signInPage = redirectAnyway(seen, { status: 302, location: 'https://tfs.corp.example/tfs/_signin?ReturnUrl=%2Ftfs%2FDefaultCollection%2FShop%2F_apis%2Fgit', www: null });
    for (const opts of tokens) {
      await assert.rejects(adoFetch('https://tfs.corp.example/tfs/DefaultCollection/Shop/_apis/git/repositories/c/items', { fetchImpl: signInPage, ...opts }),
        (e) => e.status === undefined && e.message === SAME_HOST && !e.message.includes('ReturnUrl'), JSON.stringify(opts));
    }
    await assert.rejects(adoFetch('https://tfs.corp.example/tfs/DefaultCollection/Shop/_apis/git/repositories/c/items', { fetchImpl: redirectAnyway(seen, { status: 302, location: '/tfs/_signin', www: null }), token: '' }),
      (e) => e.status === undefined && e.message === SAME_HOST, 'a relative Location resolves against the request');
    // The same host on another scheme or port is the same host: its "address" could not be given anyway
    // (adoHostRefusal takes https only), and a sign-in port beside the repository's answers for it.
    await assert.rejects(adoFetch('https://tfs.corp.example/tfs/DefaultCollection/Shop/_apis/git/repositories/c/items', { fetchImpl: redirectAnyway(seen, { status: 302, location: 'http://tfs.corp.example/tfs/_signin', www: null }), token: '' }),
      (e) => e.status === undefined && e.message === SAME_HOST, 'http: on the same host');
    await assert.rejects(adoFetch('https://tfs.corp.example/tfs/DefaultCollection/Shop/_apis/git/repositories/c/items', { fetchImpl: redirectAnyway(seen, { status: 302, location: 'https://tfs.corp.example:8443/x', www: null }), token: '' }),
      (e) => e.status === undefined && e.message === SAME_HOST.replace('/tfs/_signin', '/x'), 'another port on the same host');
    const ELSEWHERE = "Azure DevOps 302: https://tfs.corp.example redirects this read to another address, which the server does not follow — give the repository's address on the host that serves it";
    await assert.rejects(adoFetch('https://tfs.corp.example/x/_apis/y', { fetchImpl: redirectAnyway([], { location: '', www: null }), token: '' }),
      (e) => e.status === undefined && e.message === ELSEWHERE, 'no Location at all');
    // A Location with no host in it (an opaque origin): another address, unnamed — never the URL's "null".
    await assert.rejects(adoFetch('https://tfs.corp.example/x/_apis/y', { fetchImpl: redirectAnyway(seen, { status: 302, location: 'data:text/html,hello', www: null }), token: '' }),
      (e) => e.status === undefined && e.message === ELSEWHERE, 'an opaque origin');
    assert.ok(seen.every((s) => s.url.startsWith('https://tfs.corp.example/') && s.redirect === 'manual'), 'nothing followed');
  } finally { delete process.env.OBSERVOGRAM_ADO_ORIGINS; }
});

test('tenantMismatch: the organization\'s tenant from the refusal, the person\'s from the token, compared without case; null unless both are whole tenant ids and differ', () => {
  assert.deepEqual(tenantMismatch(WWW, jwtFor(PERSON_TENANT)), { organization: ORG_TENANT, yours: PERSON_TENANT });
  assert.deepEqual(tenantMismatch(WWW.replace(ORG_TENANT, ORG_TENANT.toUpperCase()), jwtFor(PERSON_TENANT.toUpperCase())), { organization: ORG_TENANT, yours: PERSON_TENANT }, 'both come back lower case');
  assert.equal(tenantMismatch(WWW.replace(ORG_TENANT, ORG_TENANT.toUpperCase()), jwtFor(ORG_TENANT)), null, 'the same tenant in another case is the same tenant');
  assert.equal(tenantMismatch(`Bearer authorization_uri=https://login.microsoftonline.com/${ORG_TENANT}0`, jwtFor(PERSON_TENANT)), null, 'more than a tenant id is no tenant id');
  assert.deepEqual(tenantMismatch(`Bearer authorization_uri=https://login.microsoftonline.com/${ORG_TENANT}x, Bearer authorization_uri="https://login.microsoftonline.com/${PERSON_TENANT}"`, jwtFor(ORG_TENANT)),
    { organization: PERSON_TENANT, yours: ORG_TENANT }, 'a malformed challenge is passed over for a whole one');
  assert.equal(tenantMismatch(WWW, jwtFor(ORG_TENANT)), null);
  assert.equal(tenantMismatch(WWW, 'pat-not-a-jwt'), null);
  assert.equal(tenantMismatch(WWW, jwtFor('not-a-tenant')), null);
  assert.equal(tenantMismatch('Basic realm="x"', jwtFor(PERSON_TENANT)), null);
  assert.equal(tenantMismatch(null, null), null);
});

test('unreachable: "could not be reached" only when the host was not reached, with the reason per code; a redirect, a request never sent, a connection dropped while the answer was read and anything else are each named as what they are; the original error is kept; any other error is left as it is', async () => {
  const failed = (cause) => new TypeError('fetch failed', { cause });
  const withCode = (code, message = code) => Object.assign(new Error(message), { code });
  const said = (cause) => unreachable('Azure DevOps', 'https://dev.azure.com/acme/x/_apis/y', failed(cause)).message;
  const REACH = 'Azure DevOps: https://dev.azure.com could not be reached from the server — ';
  const table = [
    ['ENOTFOUND', 'its name does not resolve on the server (ENOTFOUND); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1'],
    ['EAI_AGAIN', 'its name does not resolve on the server (the lookup timed out) (EAI_AGAIN); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1'],
    ['ECONNREFUSED', 'the connection was refused (ECONNREFUSED)'],
    ['ETIMEDOUT', 'the connection timed out (ETIMEDOUT); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1'],
    ['UND_ERR_CONNECT_TIMEOUT', 'the connection timed out (UND_ERR_CONNECT_TIMEOUT); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1'],
    ['ECONNRESET', 'the connection was dropped (ECONNRESET)'],
    ['UND_ERR_SOCKET', 'the connection was dropped (UND_ERR_SOCKET)'],
    ['ENETUNREACH', 'the network is unreachable from the server (ENETUNREACH); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'its certificate is not one the server trusts (if a proxy re-signs the traffic, give the server its certificate authority with NODE_EXTRA_CA_CERTS) (SELF_SIGNED_CERT_IN_CHAIN)'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'its certificate is not one the server trusts (if a proxy re-signs the traffic, give the server its certificate authority with NODE_EXTRA_CA_CERTS) (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)'],
    ['CERT_HAS_EXPIRED', 'its certificate has expired or is not yet valid (CERT_HAS_EXPIRED)'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'its certificate does not name this host (something else answered, or the address uses a name the certificate is not for) (ERR_TLS_CERT_ALTNAME_INVALID)'],
    // Node's X509 verify codes outside the cases above: no hint, the code says which (an extra authority fixes none).
    ['CERT_REVOKED', 'its certificate did not verify on the server (CERT_REVOKED)'],
    ['INVALID_CA', 'its certificate did not verify on the server (INVALID_CA)'],
    // The handshake itself: a protocol or cipher the two sides do not share, or no TLS on that port — no guess at which.
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'the TLS handshake failed (ERR_SSL_WRONG_VERSION_NUMBER)'],
  ];
  for (const [code, reason] of table) assert.equal(said(withCode(code)), REACH + reason, code);
  // The host answered, then the body could not be read to the end: undici's TypeError 'terminated', told apart
  // by its cause's code. Never "could not be reached": it was.
  const terminated = (cause) => (cause === undefined ? new TypeError('terminated') : new TypeError('terminated', { cause }));
  const DROPPED = 'Azure DevOps: the connection to https://dev.azure.com was dropped while the answer was read';
  const cut = (cause) => unreachable('Azure DevOps', 'https://dev.azure.com/acme/x/_apis/y', terminated(cause)).message;
  // A drop: the socket's code, or no code at all.
  assert.equal(cut(withCode('UND_ERR_SOCKET', 'other side closed')), `${DROPPED} (UND_ERR_SOCKET)`);
  assert.equal(cut(withCode('ECONNRESET', 'read ECONNRESET')), `${DROPPED} (ECONNRESET)`);
  assert.equal(cut(withCode('EPIPE', 'write EPIPE')), `${DROPPED} (EPIPE)`);
  assert.equal(cut(new Error('other side closed')), `${DROPPED} (other side closed)`, 'no code: what the cause said');
  assert.equal(cut(undefined), `${DROPPED} (no reason given)`);
  // undici's own body timeout: the host answered and its answer did not finish — the connection was not dropped.
  assert.equal(cut(withCode('UND_ERR_BODY_TIMEOUT', 'Body Timeout Error')), 'Azure DevOps: https://dev.azure.com answered, but its answer did not finish in time (UND_ERR_BODY_TIMEOUT)');
  // Any other code is a body the server could not read while the connection held: a 200 whose Content-Encoding
  // says gzip or deflate over bytes that are not (the decoder's Z_*), brotli (ERR__ERROR_FORMAT_*), or a chunk
  // the parser cannot frame (HPE_*). Never "dropped": nothing was.
  const NOT_READ = 'Azure DevOps: the answer from https://dev.azure.com could not be read to the end — ';
  assert.equal(cut(withCode('Z_DATA_ERROR', 'incorrect header check')), `${NOT_READ}incorrect header check (Z_DATA_ERROR)`);
  assert.equal(cut(withCode('ERR__ERROR_FORMAT_PADDING_1', 'Decompression failed')), `${NOT_READ}Decompression failed (ERR__ERROR_FORMAT_PADDING_1)`);
  assert.equal(cut(withCode('HPE_INVALID_CHUNK_SIZE', 'Invalid character in chunk size')), `${NOT_READ}Invalid character in chunk size (HPE_INVALID_CHUNK_SIZE)`);
  const PROXIED = { route: { through: 'http://proxy.example:3128', variable: 'HTTPS_PROXY', credentials: null } };
  assert.equal(unreachable('GitHub', 'https://api.github.com', terminated(withCode('UND_ERR_SOCKET', 'other side closed')), PROXIED).message,
    'GitHub: the connection to https://api.github.com was dropped while the answer was read through the proxy http://proxy.example:3128 (UND_ERR_SOCKET)');
  assert.equal(unreachable('GitHub', 'https://api.github.com', terminated(withCode('Z_DATA_ERROR', 'incorrect header check')), PROXIED).message,
    'GitHub: the answer from https://api.github.com could not be read to the end through the proxy http://proxy.example:3128 — incorrect header check (Z_DATA_ERROR)');
  const originalCut = terminated(withCode('UND_ERR_SOCKET'));
  assert.equal(unreachable('GitHub', 'https://api.github.com', originalCut).cause, originalCut, 'the original kept as the cause');
  // A body that stalls past the readers' deadline rejects with the same TimeoutError a host that never answered
  // does; the body-read call sites say `answered`, since the status was read, and the sentence says so.
  const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(unreachable('Azure DevOps', 'https://dev.azure.com/acme/x/_apis/y', timedOut).message, 'Azure DevOps: https://dev.azure.com did not answer within 60 s', 'a fetch() call site: the host did not answer');
  assert.equal(unreachable('Azure DevOps', 'https://dev.azure.com/acme/x/_apis/y', timedOut, { answered: true }).message, 'Azure DevOps: https://dev.azure.com answered, but its answer did not finish within 60 s');
  assert.equal(unreachable('GitHub', 'https://api.github.com', timedOut, { ...PROXIED, answered: true }).message, 'GitHub: https://api.github.com answered, but its answer did not finish within 60 s through the proxy http://proxy.example:3128');
  assert.equal(unreachable('GitHub', 'https://api.github.com', timedOut, { answered: true }).cause, timedOut, 'the original kept as the cause');
  const notJson = await new Response('not json', { status: 200 }).json().catch((e) => e);
  assert.ok(notJson instanceof SyntaxError && unreachable('Azure DevOps', 'https://dev.azure.com', notJson) === notJson, 'a body that is not JSON is no network failure: the SyntaxError stays');
  // A host with IPv6 and IPv4 addresses: an AggregateError, the last attempt's reason first.
  const both = Object.assign(new AggregateError([withCode('ENETUNREACH'), withCode('ETIMEDOUT')], ''), { code: 'ENETUNREACH' });
  assert.equal(said(both), `${REACH}the connection timed out (ETIMEDOUT); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1`);
  // Reached, but not followed / not sent / something else.
  assert.equal(said(new Error('unexpected redirect')), 'Azure DevOps: https://dev.azure.com answered with a redirect, which the server does not follow (unexpected redirect)');
  assert.equal(said(new Error('redirect count exceeded')), 'Azure DevOps: https://dev.azure.com answered with a redirect, which the server does not follow (redirect count exceeded)');
  assert.equal(said(withCode('UND_ERR_INVALID_ARG', 'invalid Authorization header')), 'Azure DevOps: the request to https://dev.azure.com was not sent — invalid Authorization header');
  assert.equal(said(withCode('EWHATEVER', 'x')), 'Azure DevOps: https://dev.azure.com: fetch failed — EWHATEVER');
  assert.equal(said(new Error(`other side\n  closed ${'y'.repeat(300)}`)), `Azure DevOps: https://dev.azure.com: fetch failed — other side closed ${'y'.repeat(160 - 'other side closed '.length)}`, 'one line, at most 160 characters');
  assert.equal(said(undefined), 'Azure DevOps: https://dev.azure.com: fetch failed — no reason given');
  const original = failed(withCode('ENOTFOUND'));
  assert.equal(unreachable('GitHub', 'https://api.github.com', original).cause, original, 'the original kept as the cause');
  const other = new Error('Azure DevOps 404: no such repository');
  assert.equal(unreachable('Azure DevOps', 'https://dev.azure.com', other), other, 'not fetch\'s network failure: untouched');
  // A read's budget running out (github-crawl.mjs downloadFiles aborts the read's files with it): a
  // ReadBudgetError, neither fetch's failure nor a TimeoutError, so its sentence passes through.
  const budgetOut = outOfTime(HOST_READ_FILES_BUDGET_MS);
  assert.equal(unreachable('GitHub', 'https://raw.githubusercontent.com/acme/shop/main/a.yml', budgetOut), budgetOut, 'the budget\'s error: untouched');
  assert.equal(unreachable('Azure DevOps', 'https://dev.azure.com', budgetOut, { answered: true }), budgetOut, 'at a body-read call site too');
  assert.ok(unreachable('x', 'not a url', failed(withCode('ENOTFOUND'))).message.startsWith('x: not a url could not be reached'));

  // Through the readers: the token never in the sentence, no status, so the Run answers 502.
  await assert.rejects(adoFetch('https://dev.azure.com/acme/x/_apis/y', { fetchImpl: async () => { throw failed(withCode('ENOTFOUND')); }, token: 'pat-SECRET-0000' }),
    (e) => e.status === undefined && e.message === `${REACH}its name does not resolve on the server (ENOTFOUND); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1` && !e.message.includes('pat-SECRET'));
  // A 200 whose body is cut short: res.json() rejects with the TypeError above, and the reader says so.
  const cutShort = () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"value":[')); c.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })); },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(adoFetch('https://dev.azure.com/acme/x/_apis/y', { fetchImpl: async () => cutShort(), token: 'pat-SECRET-0000' }),
    (e) => e.status === undefined && e.message === `${DROPPED} (UND_ERR_SOCKET)` && !e.message.includes('pat-SECRET'), 'Azure DevOps: the tree cut short');
  await assert.rejects(fetchGithubFiles({ owner: 'acme', repo: 'shop', ref: 'main' }, { rawFn: null, fetchFn: async () => cutShort() }),
    (e) => e.status === undefined && e.message === 'GitHub: the connection to https://api.github.com was dropped while the answer was read (UND_ERR_SOCKET)', 'GitHub: the tree cut short');
  // A file cut short is that file's skipped reason, never fatal — from raw without a token, from the API with one.
  const treeOf = (paths) => new Response(JSON.stringify({ tree: paths.map((path) => ({ type: 'blob', path })) }));
  const cutFile = await fetchGithubFiles({ owner: 'acme', repo: 'shop', ref: 'main' }, {
    fetchFn: async () => treeOf(['alerts/a.rules.yaml', 'alerts/b.rules.yaml']),
    rawFn: async (_o, _r, _ref, path) => (path === 'alerts/b.rules.yaml' ? cutShort() : new Response(`# ${path}`)),
  });
  assert.deepEqual([cutFile.files, cutFile.skipped], [{ 'alerts/a.rules.yaml': '# alerts/a.rules.yaml' }, [{ path: 'alerts/b.rules.yaml', why: 'it could not be downloaded (GitHub: the connection to https://raw.githubusercontent.com was dropped while the answer was read (UND_ERR_SOCKET))' }]]);
  const cutViaApi = await fetchGithubFiles({ owner: 'acme', repo: 'shop', ref: 'main' }, {
    rawFn: null, fetchFn: async (path) => (path.includes('/git/trees/') ? treeOf(['alerts/b.rules.yaml']) : cutShort()),
  });
  assert.deepEqual(cutViaApi.skipped, [{ path: 'alerts/b.rules.yaml', why: 'it could not be downloaded (GitHub: the connection to https://api.github.com was dropped while the answer was read (UND_ERR_SOCKET))' }]);
  // A 200 whose body stalls past the readers' deadline: the status was read, so the sentence is the answer not
  // finishing, never "did not answer" — through the Azure DevOps tree and a GitHub file alike.
  const stalled = () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('{"value":[')); c.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(adoFetch('https://dev.azure.com/acme/x/_apis/y', { fetchImpl: async () => stalled(), token: 'pat-SECRET-0000' }),
    (e) => e.status === undefined && e.message === 'Azure DevOps: https://dev.azure.com answered, but its answer did not finish within 60 s' && !e.message.includes('pat-SECRET'), 'Azure DevOps: the tree stalled');
  const stalledFile = await fetchGithubFiles({ owner: 'acme', repo: 'shop', ref: 'main' }, { fetchFn: async () => treeOf(['alerts/b.rules.yaml']), rawFn: async () => stalled() });
  assert.deepEqual(stalledFile.skipped, [{ path: 'alerts/b.rules.yaml', why: 'it could not be downloaded (GitHub: https://raw.githubusercontent.com answered, but its answer did not finish within 60 s)' }]);
  // A 200 that is not JSON keeps what it was: a SyntaxError, no status, so the Run answers 502 with it.
  await assert.rejects(adoFetch('https://dev.azure.com/acme/x/_apis/y', { fetchImpl: async () => new Response('<html>a portal</html>', { status: 200, headers: { 'content-type': 'application/json' } }), token: '' }),
    (e) => e instanceof SyntaxError && e.status === undefined, 'not JSON: the SyntaxError as it was');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw failed(withCode('ECONNREFUSED')); };
    await assert.rejects(ghFetch('/repos/acme/shop', {}, { token: 'ghp_Secret0000' }),
      (e) => e.status === undefined && e.message === 'GitHub: https://api.github.com could not be reached from the server — the connection was refused (ECONNREFUSED)');
    await assert.rejects(rawFetch('acme', 'shop', 'main', 'alerts/a.yml'),
      (e) => e.status === undefined && e.message === 'GitHub: https://raw.githubusercontent.com could not be reached from the server — the connection was refused (ECONNREFUSED)');
    const rawSeen = [];
    globalThis.fetch = async (url, init) => { rawSeen.push(init.redirect); return new Response('', { status: 301, headers: { location: 'https://raw.githubusercontent.com/acme/shop-renamed/main/alerts/a.yml' } }); };
    await assert.rejects(rawFetch('acme', 'shop', 'main', 'alerts/a.yml'),
      (e) => e.status === 301 && e.message === 'GitHub 301 on alerts/a.yml: raw.githubusercontent.com redirected it, which the server does not follow (the repository may have moved)');
    assert.deepEqual(rawSeen, ['manual'], 'read, not followed');
  } finally { globalThis.fetch = realFetch; }
});

test('fetchRepositoryFiles: an Azure DevOps tree, the crawler\'s files downloaded on the branch; GitHub through raw without a token; a folder; an unknown kind', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const u = new URL(url);
    const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.searchParams.get('recursionLevel') === 'Full') {
      return json({ value: [
        { path: '/', gitObjectType: 'tree' },
        { path: '/prometheus/rules/api.rules.yml', gitObjectType: 'blob' },
        { path: '/README.md', gitObjectType: 'blob' },
        { path: '/dashboards/api.json', gitObjectType: 'blob' },
      ] });
    }
    return json({ content: `# ${u.searchParams.get('path')}\n` });
  };
  const ado = await fetchRepositoryFiles({ kind: 'ado', location: 'https://dev.azure.com/acme/Shop/_git/checkout', ref: 'release' }, { fetchImpl });
  assert.deepEqual(Object.keys(ado.files).sort(), ['dashboards/api.json', 'prometheus/rules/api.rules.yml'], 'the crawler\'s files only (README is not one)');
  assert.equal(ado.files['dashboards/api.json'], '# /dashboards/api.json\n');
  assert.deepEqual([ado.ref, ado.candidates, ado.capped, ado.truncated, ado.skipped, ado.source], ['release', 2, 0, false, [], 'Shop/checkout on Azure DevOps']);
  assert.ok(urls.every((u) => new URL(u).searchParams.get('versionDescriptor.version') === 'release'), 'every call on the branch');

  const api = [];
  const ghFetchFn = async (path) => {
    api.push(path);
    if (path === '/repos/acme/shop') return new Response(JSON.stringify({ default_branch: 'develop' }));
    if (path.startsWith('/repos/acme/shop/git/trees/develop')) return new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'alerts/api.rules.yaml' }, { type: 'blob', path: 'src/app.py' }] }));
    throw new Error(`unexpected API call ${path}`);
  };
  const raw = [];
  const rawFn = async (owner, repo, ref, path) => { raw.push([owner, repo, ref, path]); return new Response(`# ${path}`); };
  const gh = await fetchRepositoryFiles({ kind: 'github', location: 'https://github.com/acme/shop', ref: null }, { ghFetchFn, rawFn });
  assert.deepEqual([gh.ref, Object.keys(gh.files), gh.source], ['develop', ['alerts/api.rules.yaml', 'src/app.py'], 'acme/shop on GitHub'], 'the crawler\'s own rule: a source file no keyword names is read too');
  assert.deepEqual([gh.candidates, gh.capped, gh.truncated, gh.skipped], [2, 0, false, []]);
  assert.deepEqual(api, ['/repos/acme/shop', '/repos/acme/shop/git/trees/develop?recursive=1'], 'two API calls — the contents come from raw');
  assert.deepEqual(raw.map((x) => x.join(' ')).sort(), ['acme shop develop alerts/api.rules.yaml', 'acme shop develop src/app.py']);
  // With a token the contents API is used instead (rawFn null).
  const viaApi = await fetchGithubFiles({ owner: 'acme', repo: 'shop', ref: 'main' }, {
    rawFn: null,
    fetchFn: async (path) => (path.includes('/git/trees/') ? new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'alerts/x.rules.yaml' }] })) : new Response('# via the API')),
  });
  assert.deepEqual(viaApi.files, { 'alerts/x.rules.yaml': '# via the API' });

  const folder = await fetchRepositoryFiles({ kind: 'path', location: REPO });
  assert.ok(Object.keys(folder.files).length > 0 && folder.source === `the folder ${REPO}`);
  await assert.rejects(fetchRepositoryFiles({ kind: 'path', location: join(EMPTY_REPO, 'gone') }), (e) => e.status === 404 && /no folder .* on the server/.test(e.message));
  await assert.rejects(fetchRepositoryFiles({ kind: 'svn', location: 'x' }), (e) => e.status === 400);
});

// ---------- the read's bound: 8 files at a time, one budget ----------

// Twenty blobs the crawler reads, listed out of path order: one tier, so the
// plan takes them in tree order, and the crawler gets them in path order.
const TWENTY = Array.from({ length: 20 }, (_, i) => `alerts/${String(i).padStart(2, '0')}.rules.yaml`);
const TWENTY_TREE = [...TWENTY].reverse().map((path) => ({ type: 'blob', path }));
const answerJson = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const ghTreeOf = (tree) => answerJson({ tree });
const adoTreeOf = (tree) => answerJson({ value: [{ path: '/', gitObjectType: 'tree' }, ...tree.map((n) => ({ path: `/${n.path}`, gitObjectType: 'blob' }))] });
const isAdoTreeCall = (url) => new URL(url).searchParams.get('recursionLevel') === 'Full';
// The file a GitHub contents call or an Azure DevOps items call is for.
const contentsPathOf = (apiPath) => decodeURIComponent(/^\/repos\/acme\/shop\/contents\/(.+)\?ref=main$/.exec(apiPath)[1]);
const itemsPathOf = (url) => new URL(url).searchParams.get('path').replace(/^\//, '');
// A host that never answers: settles only when its signal aborts, with the signal's reason.
const untilAborted = (signal) => new Promise((_, reject) => {
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});
const ADO_REPO = { kind: 'ado', location: 'https://dev.azure.com/acme/Shop/_git/checkout', ref: null };
const GH_REPO = { owner: 'acme', repo: 'shop', ref: 'main' };

test('a host read fetches at most 8 files at once — a pool, the next file taken as a slot frees, never a batch waiting on its slowest — and every file reaches the crawler in path order; each download carries the read\'s signal, which the fetchers combine with their own deadline', async () => {
  assert.equal(HOST_READ_PARALLEL, 8);
  assert.equal(HOST_READ_FILES_BUDGET_MS, 120_000);
  const order = planCrawlerFetch(TWENTY_TREE, HOST_READ_CAPS).selected.map((n) => n.path);
  assert.equal(order.length, 20);
  // A gauge over the downloads: how many are in flight, the peak, the order they started in, their
  // signals. The plan's first file is held until the test releases it; the others answer a tick later.
  const gauge = () => {
    const g = { inFlight: 0, peak: 0, started: [], signals: [], held: order[0] };
    g.released = new Promise((r) => { g.release = r; });
    g.take = async (path, signal) => {
      g.started.push(path); g.signals.push(signal);
      g.inFlight++; g.peak = Math.max(g.peak, g.inFlight);
      if (path === g.held) await g.released; else await new Promise((r) => setTimeout(r, 0));
      g.inFlight--;
    };
    // Until every download has started and the held one is the only one left in flight.
    g.drained = async () => { for (let i = 0; i < 500 && !(g.started.length === 20 && g.inFlight === 1); i++) await new Promise((r) => setTimeout(r, 1)); };
    return g;
  };
  const check = async (label, g, read) => {
    await g.drained();
    assert.deepEqual([g.started.length, g.inFlight], [20, 1], `${label}: every download started while one was still held — a pool, not batches`);
    g.release();
    const out = await read;
    assert.equal(g.peak, 8, `${label}: 8 at once, never more`);
    assert.deepEqual(g.started, order, `${label}: taken in the plan's order`);
    assert.deepEqual(Object.keys(out.files), TWENTY, `${label}: every file, in path order`);
    assert.deepEqual([out.candidates, out.capped, out.skipped], [20, 0, []], label);
    assert.ok(g.signals.length === 20 && g.signals.every((s) => s instanceof AbortSignal && !s.aborted), `${label}: each download carries the read's signal, not aborted`);
  };
  // GitHub from raw: rawFn's fifth argument is { signal }.
  const raw = gauge();
  await check('raw', raw, fetchGithubFiles(GH_REPO, {
    fetchFn: async () => ghTreeOf(TWENTY_TREE),
    rawFn: async (_o, _r, _ref, path, { signal }) => { await raw.take(path, signal); return new Response(`# ${path}`); },
  }));
  // GitHub through the contents API: init.signal.
  const api = gauge();
  await check('api', api, fetchGithubFiles(GH_REPO, {
    rawFn: null,
    fetchFn: async (path, init) => {
      if (path.includes('/git/trees/')) return ghTreeOf(TWENTY_TREE);
      const file = contentsPathOf(path);
      await api.take(file, init.signal);
      return new Response(`# ${file}`);
    },
  }));
  // Azure DevOps through fetchRepositoryFiles: adoFetch's init.signal, the tree call apart.
  const ado = gauge();
  await check('ado', ado, fetchRepositoryFiles(ADO_REPO, {
    fetchImpl: async (url, init) => {
      if (isAdoTreeCall(url)) return adoTreeOf(TWENTY_TREE);
      const file = itemsPathOf(url);
      await ado.take(file, init.signal);
      return answerJson({ content: `# ${file}` });
    },
  }));
  // The fetchers combine the caller's signal with their own deadline: the signal fetch gets is a
  // third one, not yet aborted, and aborting the caller's aborts it with the caller's reason.
  const combined = async (label, call) => {
    const budget = new AbortController();
    const seen = await call(budget.signal);
    assert.ok(seen instanceof AbortSignal && seen !== budget.signal && !seen.aborted, `${label}: a signal of its own, not yet aborted`);
    const reason = outOfTime(1000);
    budget.abort(reason);
    assert.ok(seen.aborted && seen.reason === reason, `${label}: aborting the budget aborts it, with the budget's reason`);
  };
  await combined('adoFetch', async (signal) => {
    let seen;
    await adoFetch('https://dev.azure.com/acme/Shop/_apis/git/repositories/c/items', { fetchImpl: async (_u, init) => { seen = init.signal; return answerJson({ value: [] }); }, signal });
    return seen;
  });
  const realFetch = globalThis.fetch;
  try {
    let seen;
    globalThis.fetch = async (_u, init) => { seen = init.signal; return new Response('{}', { status: 200 }); };
    await combined('ghFetch', async (signal) => { await ghFetch('/repos/acme/shop', { signal }); return seen; });
    await combined('rawFetch', async (signal) => { await rawFetch('acme', 'shop', 'main', 'alerts/a.yml', { signal }); return seen; });
  } finally { globalThis.fetch = realFetch; }
});

test('the read\'s files share one budget: when it runs out, every file not read — in flight or not yet started — is skipped with the sentence, never fatal, and the read ends then, GitHub from raw, through the API and through ghFetch itself, and Azure DevOps alike; the files that answered before it are read; the repository and tree calls run outside the budget, under a deadline of their own; without a budget each fetch still carries a deadline signal of its own — not the caller\'s, not yet aborted', async (t) => {
  const limits = { budgetMs: 1000 };
  const WHY = 'it could not be downloaded (the read\'s 1 s for its files ran out)';
  const allSkipped = TWENTY.map((path) => ({ path, why: WHY }));
  const timed = async (read) => { const t0 = Date.now(); const out = await read; return { out, ms: Date.now() - t0 }; };
  // The ceiling is far under the 60 s deadline and far over the 1 s budget: a slow CI box still
  // passes, and the diagnostic says how close it came.
  const ended = (label, { out, ms }, files, skipped) => {
    t.diagnostic(`${label}: the read ended in ${ms} ms (budget 1000, ceiling 5000)`);
    assert.ok(ms < 5000, `${label}: the read ended with the budget, not at a 60 s deadline (${ms} ms)`);
    assert.deepEqual([out.files, out.skipped, out.candidates, out.capped], [files, skipped, 20, 0], label);
  };
  // The calls a GitHub read makes before its files — the repository, when the ref is not known,
  // and the tree — answered at once; null for a file call. `GH_NO_REF` makes a read ask for both.
  const GH_NO_REF = { ...GH_REPO, ref: null };
  const ghBefore = (path) => (path.endsWith('/repos/acme/shop') ? answerJson({ default_branch: 'main' }) : path.includes('/git/trees/') ? ghTreeOf(TWENTY_TREE) : null);
  // What the calls before the files reach their seam with: through fetchFn the call alone (no
  // init, so nothing of the read's budget), through fetch and fetchImpl the signal the fetcher made.
  const seamInits = [];
  const ghSignals = [];
  const adoSignals = [];
  // Every file stalls until the budget aborts it.
  const stalledRaw = fetchGithubFiles(GH_REPO, { fetchFn: async (path, init) => { seamInits.push(init); return ghBefore(path); }, rawFn: (_o, _r, _ref, _p, { signal }) => untilAborted(signal), limits });
  const stalledApi = fetchGithubFiles(GH_NO_REF, { rawFn: null, fetchFn: (path, init) => { const before = ghBefore(path); if (before) { seamInits.push(init); return before; } return untilAborted(init.signal); }, limits });
  const stalledAdo = fetchRepositoryFiles(ADO_REPO, { fetchImpl: (url, init) => { if (isAdoTreeCall(url)) { adoSignals.push(init.signal); return adoTreeOf(TWENTY_TREE); } return untilAborted(init.signal); }, limits });
  // The plan's first two answer at once, the rest stall: the two are read, the rest carry the sentence.
  const fast = new Set(planCrawlerFetch(TWENTY_TREE, HOST_READ_CAPS).selected.slice(0, 2).map((n) => n.path));
  const mixed = fetchGithubFiles(GH_REPO, {
    fetchFn: async () => ghTreeOf(TWENTY_TREE),
    rawFn: (_o, _r, _ref, path, { signal }) => (fast.has(path) ? new Response(`# ${path}`) : untilAborted(signal)), limits,
  });
  // downloadFiles itself, one slot: the first file stalls, so the two behind it are never asked for.
  const calls = [];
  const direct = downloadFiles([{ path: 'a' }, { path: 'b' }, { path: 'c' }], (node, signal) => { calls.push(node.path); return untilAborted(signal); }, { parallel: 1, budgetMs: 1000 });
  // GitHub through ghFetch itself over a stubbed fetch, so the signal each call runs under is seen
  // where the host would see it; the budget's sentence passes through unreachable() unchanged.
  const realFetch = globalThis.fetch;
  let raw, api, ado, mix, texts, gh;
  try {
    globalThis.fetch = async (url, init) => { const before = ghBefore(url); if (before) { ghSignals.push(init.signal); return before; } return untilAborted(init.signal); };
    const stalledGh = fetchGithubFiles(GH_NO_REF, { rawFn: null, limits });
    [raw, api, ado, mix, texts, gh] = await Promise.all([timed(stalledRaw), timed(stalledApi), timed(stalledAdo), timed(mixed), direct, timed(stalledGh)]);
  } finally { globalThis.fetch = realFetch; }
  ended('raw', raw, {}, allSkipped);
  ended('api', api, {}, allSkipped);
  ended('ado', ado, {}, allSkipped);
  ended('gh', gh, {}, allSkipped);
  ended('mixed', mix, Object.fromEntries([...fast].sort().map((p) => [p, `# ${p}`])), allSkipped.filter((s) => !fast.has(s.path)));
  assert.deepEqual(calls, ['a'], 'b and c were reached after the budget was up: stored without a call');
  assert.deepEqual([...texts], ['a', 'b', 'c'].map((path) => [path, { error: 'the read\'s 1 s for its files ran out' }]));
  // The reads have ended, their budgets spent: a signal under a budget would be aborted by now. The
  // calls before the files are not under one — through fetchFn they carried no init at all, so
  // nothing of the read's budget; through fetch and fetchImpl the fetcher's own deadline, still running.
  assert.deepEqual(seamInits, [undefined, undefined, undefined], 'GitHub through fetchFn: the tree call (raw) and the repository and tree calls (api) carry no init — nothing of the read\'s budget is handed to them');
  assert.ok(ghSignals.length === 2 && ghSignals.every((s) => s instanceof AbortSignal && !s.aborted), 'GitHub through ghFetch: the repository and tree calls\' signals are AbortSignals of their own, not aborted after the budget ran out — a deadline, not the budget');
  assert.ok(adoSignals.length === 1 && adoSignals[0] instanceof AbortSignal && !adoSignals[0].aborted, 'Azure DevOps: the tree call\'s signal is an AbortSignal of its own, not aborted after the budget ran out — a deadline, not the budget');
  const budgetOut = outOfTime(HOST_READ_FILES_BUDGET_MS);
  assert.deepEqual([budgetOut.name, budgetOut.message], ['ReadBudgetError', 'the read\'s 120 s for its files ran out']);
  // No budget: each fetch still gets a deadline signal of its own (readSignal's AbortSignal.timeout;
  // its 60 s delay is nothing a test can see), not the caller's and not yet aborted.
  const deadline = readSignal();
  assert.ok(deadline instanceof AbortSignal && !deadline.aborted, 'readSignal() alone: a deadline signal of its own, not yet aborted');
  let adoSignal;
  await adoFetch('https://dev.azure.com/acme/Shop/_apis/git/repositories/c/items', { fetchImpl: async (_u, init) => { adoSignal = init.signal; return answerJson({ value: [] }); } });
  assert.ok(adoSignal instanceof AbortSignal && !adoSignal.aborted, 'adoFetch without a signal: a deadline signal of its own, not yet aborted');
  try {
    const seen = [];
    globalThis.fetch = async (_u, init) => { seen.push(init.signal); return new Response('{}', { status: 200 }); };
    await ghFetch('/repos/acme/shop');
    await rawFetch('acme', 'shop', 'main', 'alerts/a.yml');
    assert.ok(seen.length === 2 && seen.every((s) => s instanceof AbortSignal && !s.aborted), 'ghFetch and rawFetch without a signal: a deadline signal of their own, not yet aborted');
  } finally { globalThis.fetch = realFetch; }
});

// The live suite's test repositories hold tools/fixtures/live-repo
// (tools/test-live-repos.mjs, docs/LIVE_REPO_TESTS.md): a change to how a
// scan reads or classifies it shows here, before the weekly live run does.
test('the live-repo fixture, what the live suite\'s test repositories hold: three files read, one of each kind, a valid pack; its README is not read', async () => {
  const { crawlFiles, scanReport } = await import('../tools/lib/crawler.mjs');
  const { validateCanonical, SPEC_SCHEMA_PATH } = await import('../tools/lib/validator.mjs');
  const fixture = join(ROOT, 'tools', 'fixtures', 'live-repo');
  const read = await fetchRepositoryFiles({ kind: 'path', location: fixture, ref: null });
  assert.deepEqual(Object.keys(read.files), ['grafana/dashboards/checkout.json', 'otel/collector.yaml', 'prometheus/rules.yml']);
  const { canonical, summary } = crawlFiles(read.files, { repoName: 'checkout', environment: 'prod' });
  const scan = scanReport(read, summary);
  assert.deepEqual([scan.files, scan.candidates, scan.skipped, scan.byKind, scan.unclassified], [3, 3, 0, { 'grafana-dashboard': 1, 'otel-collector': 1, 'prometheus-rules': 1 }, 0]);
  assert.deepEqual(validateCanonical(canonical, JSON.parse(readFileSync(join(ROOT, SPEC_SCHEMA_PATH), 'utf8'))), []);
});

// ---------- the route ----------

const { start } = await import('./index.mjs');
const { currentStore, closeStore } = await import('./store/db.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { runWithOrg } = await import('./org-context.mjs');
const { startFakeMcp, endpointIdFor } = await import('./fixtures/fake-mcp.mjs');
const { capabilityTool, probeCandidates } = await import('../tools/lib/contracts/mcp-capabilities.mjs');

const FIXTURES = resolve(ROOT, 'tools', 'fixtures');
const recorded = (f) => JSON.parse(readFileSync(join(FIXTURES, 'mcp', f), 'utf8'));
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
const ANSWERS = {
  [capabilityTool('system_health')]: () => ({ services: [] }),
  [capabilityTool('system_topology')]: () => ({ dependencies: [] }),
  [nameOf(probeCandidates('metric_names')[0])]: () => recorded('metrics_label_values.json'),
  [nameOf(probeCandidates('scrape_configs')[0])]: () => recorded('metrics_targets.json'),
};
const fake = await startFakeMcp(Object.keys(ANSWERS), (name, args) => (ANSWERS[name] ? ANSWERS[name](args) : { ok: true }));
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(async () => {
  await fake.close?.();
  await new Promise((ok) => srv.close(ok));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
  rmSync(EMPTY_REPO, { recursive: true, force: true });
});

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Observogram-CSRF': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const auditRows = (action) => runWithOrg('default', () => listAudit(currentStore(), { action })).map((r) => r.detail);

const ids = {};

test('the service record carries its repository: POST, GET, PATCH (changed), null clears; a refusal writes nothing', async () => {
  const created = await call('POST', '/api/services', { name: 'Shop API', repository: { kind: 'github', location: 'acme/shop' } });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.service.repository, { kind: 'github', location: 'https://github.com/acme/shop', ref: null });
  ids.shop = created.json.service.id;
  const patched = await call('PATCH', `/api/services/${ids.shop}`, { repository: { kind: 'path', location: REPO } });
  assert.deepEqual([patched.status, patched.json.changed, patched.json.service.repository], [200, ['repository'], { kind: 'path', location: resolve(REPO), ref: null }]);
  const same = await call('PATCH', `/api/services/${ids.shop}`, { repository: { kind: 'path', location: REPO } });
  assert.deepEqual(same.json.changed, [], 'the same repository: nothing changed');
  const bad = await call('PATCH', `/api/services/${ids.shop}`, { repository: { kind: 'ado', location: 'https://tfs.corp.test/Main/Shop/_git/c' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /OBSERVOGRAM_ADO_ORIGINS/);
  assert.deepEqual((await call('GET', `/api/services/${ids.shop}`)).json.service.repository, { kind: 'path', location: resolve(REPO), ref: null }, 'the refusal changed nothing');
  const bare = await call('POST', '/api/services', { name: 'Bare' });
  assert.equal(bare.json.service.repository, null, 'a service without one');
  ids.bare = bare.json.service.id;
});

test('POST /api/services/:id/run refuses before it reads anything: no service, no environment, no repository, no endpoint, an unknown environment, a folder that is gone or empty', async () => {
  ids.endpoint = await endpointIdFor(BASE, fake.url, { name: 'fake-live' });
  const run = (id, body = {}) => call('POST', `/api/services/${id}/run`, body);
  assert.deepEqual([(await run(999999)).status, (await run(999999)).json.error], [404, WAYS.noService('999999')]);
  const noEnv = await run(ids.shop);
  assert.deepEqual([noEnv.status, noEnv.json.error], [400, 'Shop API has no environment yet — add one, with the MCP endpoint that reads it']);
  assert.equal((await call('POST', `/api/services/${ids.shop}/environments`, { name: 'prod' })).status, 201);
  const noEndpoint = await run(ids.shop, { env: 'prod' });
  assert.deepEqual([noEndpoint.status, noEndpoint.json.error], [409, 'Shop API in prod has no live target yet — choose the MCP endpoint that reads it, or upload an export of live']);
  const envId = (await call('GET', `/api/services/${ids.shop}`)).json.service.environments[0].id;
  assert.equal((await call('PATCH', `/api/environments/${envId}`, { mcpEndpointId: ids.endpoint })).status, 200);
  const unknownEnv = await run(ids.shop, { env: 'staging' });
  assert.deepEqual([unknownEnv.status, unknownEnv.json.error], [404, 'Shop API has no environment "staging" — add it to the service first']);
  assert.equal((await call('POST', `/api/services/${ids.bare}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);
  const noRepo = await run(ids.bare);
  assert.deepEqual([noRepo.status, noRepo.json.error], [409, 'Bare names no repository yet — say where its declaration lives: GitHub, Azure DevOps or a folder on the server']);
  // A folder that went away, and one with nothing the crawler reads.
  assert.equal((await call('PATCH', `/api/services/${ids.bare}`, { repository: { kind: 'path', location: join(EMPTY_REPO, 'gone') } })).status, 200);
  const gone = await run(ids.bare);
  assert.equal(gone.status, 404);
  assert.match(gone.json.error, /^the repository could not be read: no folder .*gone on the server$/);
  assert.equal((await call('PATCH', `/api/services/${ids.bare}`, { repository: { kind: 'path', location: EMPTY_REPO } })).status, 200);
  const empty = await run(ids.bare);
  assert.equal(empty.status, 422);
  assert.match(empty.json.error, /has no file the scan reads/);
  assert.equal(fake.calls.length, 0, 'no refusal reached the live side');
  assert.deepEqual(auditRows('journey.run'), [], 'and no run was recorded');
});

test('POST /api/services/:id/run: the folder scanned and registered as the service\'s pack, the check saved as <slug>.<env> and run; a second Run replaces the scan and keeps the gate', async () => {
  const r = await call('POST', `/api/services/${ids.shop}/run`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.journey, 'shop-api.prod');
  assert.equal(r.json.pack.label, 'Shop API · prod · repository');
  assert.equal(r.json.scan.source, `the folder ${resolve(REPO)}`);
  assert.ok(r.json.scan.files > 0 && r.json.scan.skipped === 0, JSON.stringify(r.json.scan));
  assert.ok(r.json.record && typeof r.json.record.outcome === 'string', 'the run record');
  assert.ok(fake.calls.length > 0, 'the live side was read');
  // The scan is the service's own pack, and the journey names the service and the environment.
  const svc = (await call('GET', `/api/services/${ids.shop}`)).json.service;
  assert.deepEqual(svc.packs.filter((p) => p.role === 'primary').map((p) => [p.id, p.label, p.source]), [[r.json.pack.id, 'Shop API · prod · repository', 'repository:path']]);
  const journeys = (await call('GET', '/api/journeys')).json.journeys;
  const j = journeys.find((x) => x.name === 'shop-api.prod');
  assert.deepEqual([j.scope.service, j.scope.env], ['shop-api', 'prod']);
  assert.match(j.packA, new RegExp(`${r.json.pack.id}\\.pack\\.yaml$`));
  // Pack A is named by the pack (the Neuron and the journeys list show its
  // label), and saved beside the journey, not at this workspace's absolute
  // path: a moved or copied workspace checks its own copy.
  assert.deepEqual(j.packARef, { id: r.json.pack.id, label: 'Shop API · prod · repository' });
  assert.equal(j.packBRef, null, 'a live Pack B is no registered pack');
  assert.match(readFileSync(join(WORKSPACE, 'journeys', 'shop-api.prod.journey.yaml'), 'utf8'), new RegExp(`packA:\\s*\\{?\\s*file: \\.\\./packs/${r.json.pack.id}\\.pack\\.yaml`));
  assert.match(String(j.packB), /^mcp:/, 'Pack B is the live endpoint, re-drafted on every run');
  assert.equal(j.lastRun.outcome, r.json.record.outcome);
  const capture = auditRows('journey.capture');
  assert.deepEqual(capture.at(-1), { via: 'service', service: 'shop-api', env: 'prod', packA: r.json.pack.id, live: true });
  assert.equal(auditRows('journey.run').length, 1);
  // A gate set by hand on the saved check survives the next Run; the scan is replaced, not added.
  const file = join(WORKSPACE, 'journeys', 'shop-api.prod.journey.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('minAlignmentPct: 85', 'minAlignmentPct: 40'));
  const again = await call('POST', `/api/services/${ids.shop}/run`, { env: 'prod' });
  assert.equal(again.status, 200, again.text);
  assert.match(readFileSync(file, 'utf8'), /minAlignmentPct: 40/);
  const after2 = (await call('GET', `/api/services/${ids.shop}`)).json.service;
  assert.equal(after2.packs.filter((p) => p.role === 'primary').length, 1, 'one scan per service and environment');
  assert.equal(auditRows('journey.run').length, 2);
});

test("a live run keeps the Pack B it graded as the journey's live pack — the listing names it with the read's time; the next Run and a Check now each replace it", async () => {
  const livePacks = async () => (await call('GET', '/api/packs')).json.packs.filter((p) => p.label === 'Shop API · prod · live');
  const listed = async () => (await call('GET', '/api/journeys')).json.journeys.find((x) => x.name === 'shop-api.prod');
  const r = await call('POST', `/api/services/${ids.shop}/run`, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.livePack?.label, 'Shop API · prod · live', 'the Run answers with the live pack it kept');
  assert.ok(r.json.record.packB.refreshedAt, 'the record names its read time');
  assert.deepEqual((await listed()).livePack, { id: r.json.livePack.id, label: 'Shop API · prod · live', refreshedAt: r.json.record.packB.refreshedAt },
    'the listing names the kept pack and the read it is, the one the record graded');
  assert.deepEqual((await livePacks()).map((p) => p.id), [r.json.livePack.id], 'it is in the catalogue, once');
  // A live pack is never the service's own: the scan stays its one primary, and its environments stay as written.
  const svc = (await call('GET', `/api/services/${ids.shop}`)).json.service;
  assert.deepEqual(svc.packs.filter((p) => p.role === 'primary').map((p) => p.id), [r.json.pack.id]);
  assert.deepEqual(svc.environments.map((e) => e.name), ['prod']);
  // The next Run replaces it.
  const again = await call('POST', `/api/services/${ids.shop}/run`, {});
  assert.equal(again.status, 200, again.text);
  assert.deepEqual((await livePacks()).map((p) => p.id), [again.json.livePack.id], 'one live pack per journey after a second Run');
  assert.equal((await listed()).livePack.refreshedAt, again.json.record.packB.refreshedAt);
  // So does Check now (POST /api/journeys/:name/run), under the same label.
  const check = await call('POST', '/api/journeys/shop-api.prod/run', {});
  assert.equal(check.status, 200, check.text);
  assert.deepEqual(check.json.livePack, { id: (await listed()).livePack.id, label: 'Shop API · prod · live' });
  assert.deepEqual((await livePacks()).map((p) => p.id), [check.json.livePack.id], 'and after a Check now');
  assert.equal((await listed()).livePack.refreshedAt, check.json.record.packB.refreshedAt, 'the listing follows the last run');
});

test('the folder rule holds at run time: a folder outside OBSERVOGRAM_REPO_ROOTS, listed after the record was written, is refused before it is read', async () => {
  mkdirSync(join(WORKSPACE, 'repos'), { recursive: true });
  process.env.OBSERVOGRAM_REPO_ROOTS = join(WORKSPACE, 'repos');
  try {
    const r = await call('POST', `/api/services/${ids.shop}/run`, {});
    assert.equal(r.status, 403);
    assert.equal(r.json.error, WAYS.repositoryFolderRoots(resolve(REPO)));
  } finally {
    delete process.env.OBSERVOGRAM_REPO_ROOTS;
  }
});

// ---------- the criteria a service is not graded on ----------
//
// A service record may switch grade criteria off (PATCH /api/services/:id
// { gradeOff }; server/test-services-api.mjs has the rule). Every server run
// of a journey of that service — its Run and a Check now — then grades over
// the others and says so: the record's grade.off names the keys, and the
// journeys listing gives them as lastRun.gradeOff. What a record's score
// should be is asked of the engine itself, over the two packs the record
// graded, the way tools/lib/journey.mjs grades them.

const { computeDiagnosticGrade, computePostureMatrix } = await import('../studio/diagnostic-grade.mjs');
const { adapt } = await import('../tools/lib/adapter.mjs');
const { diffPacks } = await import('../tools/lib/diff.mjs');
const { comparePackBranches } = await import('../tools/lib/traceability-graph.mjs');
const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');

// The engine's grade of Pack A against Pack B, scoped as the journey is, with
// `off` left out. A pack is named by its id: a registered pack's workspace
// copy (a scan; the live pack a run kept — the read its record graded), or a
// catalogue example's file under examples/.
const packFileOf = (id) => [join(WORKSPACE, 'packs', `${id}.pack.yaml`), join(ROOT, 'examples', `${id}.pack.yaml`)].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
function engineGrade({ packA, packB, env, service = null, off = [] }) {
  const canonical = (id) => parseYaml(readFileSync(packFileOf(id), 'utf8'));
  const layeredA = adapt(canonical(packA), { environment: env || undefined });
  const layeredB = adapt(canonical(packB), {});
  const diff = { ...diffPacks(layeredA, layeredB, { scopeMode: undefined, service: service || undefined }), traceabilityGraph: comparePackBranches(layeredA, layeredB) };
  return computeDiagnosticGrade(layeredA, layeredB, computePostureMatrix(layeredA, layeredB), null, diff, { off });
}
const scoreOf = (grade) => Math.round(grade.overall.audit.scorePctExact);
const listedRun = async (name) => (await call('GET', '/api/journeys')).json.journeys.find((x) => x.name === name)?.lastRun;
const newestRecord = async (name) => (await call('GET', `/api/journeys/${name}/runs?limit=1`)).json.runs[0];

test('a service with chaos-validated switched off: its Run and its Check now grade over the six others — grade.off names it on the answer and on the saved record, the score is the engine\'s over six, the listing gives lastRun.gradeOff; with nothing off the record carries no grade.off and the score is over seven; switched back on, the next run is over seven again', async () => {
  const P = `/api/services/${ids.shop}`;
  const NAME = 'shop-api.prod';
  const off = ['chaos-validated'];
  const scope = { env: 'prod', service: 'shop-api' };
  const listed = async () => { const r = await listedRun(NAME); return [r.gradeScore, r.gradeOff]; };

  // Nothing off: all seven, and no grade.off — on the answer, on the saved record, [] in the listing.
  assert.deepEqual((await call('GET', P)).json.service.gradeOff, []);
  const plain = await call('POST', `${P}/run`, {});
  assert.equal(plain.status, 200, plain.text);
  const seven = engineGrade({ packA: plain.json.pack.id, packB: plain.json.livePack.id, ...scope });
  assert.deepEqual([seven.overall.total, 'off' in seven.overall], [7, false]);
  assert.ok(!('off' in plain.json.record.grade), JSON.stringify(plain.json.record.grade));
  assert.equal(plain.json.record.grade.score, scoreOf(seven), 'the record\'s score is the engine\'s over all seven');
  assert.deepEqual((await newestRecord(NAME)).grade, plain.json.record.grade, 'the saved record is the answer\'s: no grade.off');
  assert.deepEqual(await listed(), [scoreOf(seven), []]);

  // Switched off on the service record.
  const patched = await call('PATCH', P, { gradeOff: [{ key: 'chaos-validated', reason: 'no fault injection on this project' }] });
  assert.deepEqual([patched.status, patched.json.changed, patched.json.service.gradeOff.map((x) => x.key)], [200, ['gradeOff'], off]);

  // The Run: the repository scanned again, graded over six.
  const run = await call('POST', `${P}/run`, {});
  assert.equal(run.status, 200, run.text);
  const six = engineGrade({ packA: run.json.pack.id, packB: run.json.livePack.id, ...scope, off });
  const chaos = six.trust.criteria.find((c) => c.key === 'chaos-validated');
  assert.deepEqual([six.overall.total, six.overall.off, chaos.applies], [6, off, false], 'the engine, asked the same: six criteria apply');
  assert.deepEqual(run.json.record.grade.off, off, 'the Run\'s record names the criterion left out');
  assert.equal(run.json.record.grade.score, scoreOf(six), 'and its score is the engine\'s over the six that apply');
  assert.notEqual(scoreOf(six), scoreOf(seven), 'which is not the score over seven: the switch moved it');
  assert.deepEqual([run.json.record.grade.pass, run.json.record.grade.letter, run.json.record.grade.schema], [six.overall.audit.passes, six.overall.instrumentGrade.letter, 5], 'the pass, the letter and the schema are that grade\'s');
  assert.deepEqual((await newestRecord(NAME)).grade, run.json.record.grade, 'the saved record says the same');
  assert.deepEqual(await listed(), [scoreOf(six), off], 'the listing names what the last score left out');
  assert.equal((await listedRun(NAME)).gradeSchema, run.json.record.grade.schema, 'and the grade schema it was scored under');
  assert.equal(auditRows('journey.run')[0].gradeScore, scoreOf(six), 'the journey.run row carries that score');

  // Check now (POST /api/journeys/:name/run) on the same scan: a new live read, the same switches.
  const check = await call('POST', `/api/journeys/${NAME}/run`, {});
  assert.equal(check.status, 200, check.text);
  const sixAgain = engineGrade({ packA: run.json.pack.id, packB: check.json.livePack.id, ...scope, off });
  assert.notEqual(check.json.record.startedAt, run.json.record.startedAt, 'another run');
  assert.deepEqual(check.json.record.grade.off, off, 'a Check now names it too');
  assert.equal(check.json.record.grade.score, scoreOf(sixAgain));
  assert.deepEqual((await newestRecord(NAME)).grade, check.json.record.grade);
  assert.deepEqual(await listed(), [scoreOf(sixAgain), off]);

  // Switched back on: the next run is over seven again, and says nothing of a criterion left out.
  const back = await call('PATCH', P, { gradeOff: [] });
  assert.deepEqual([back.status, back.json.changed, back.json.service.gradeOff], [200, ['gradeOff'], []]);
  const whole = await call('POST', `/api/journeys/${NAME}/run`, {});
  assert.equal(whole.status, 200, whole.text);
  const sevenAgain = engineGrade({ packA: run.json.pack.id, packB: whole.json.livePack.id, ...scope });
  assert.ok(!('off' in whole.json.record.grade), JSON.stringify(whole.json.record.grade));
  assert.equal(whole.json.record.grade.score, scoreOf(sevenAgain));
  assert.deepEqual(await listed(), [scoreOf(sevenAgain), []]);
  // The records before it keep what they were graded on: the history says when the grade's basis changed.
  const history = (await call('GET', `/api/journeys/${NAME}/runs?limit=4`)).json.runs.map((r) => r.grade.off ?? null);
  assert.deepEqual(history, [null, off, off, null], 'newest first: seven, six (Check now), six (Run), seven');
});

// A check written by hand into the journeys folder (no studio comment on its
// first line), over two packs by id — a registered pack's workspace copy, or a
// catalogue example's file. Files only: nothing is read live.
const CATALOGUE_A = 'target-advanced';
const CATALOGUE_B = 'production-curated';
const journeyFileOf = (name) => join(WORKSPACE, 'journeys', `${name}.journey.yaml`);
const packSourceOf = (id) => (packFileOf(id).startsWith(join(WORKSPACE, 'packs')) ? `../packs/${id}.pack.yaml` : packFileOf(id).replaceAll('\\', '/'));
function writeCheckByHand(name, { packA, packB, lines = [] }) {
  writeFileSync(journeyFileOf(name), [`name: ${name}`, `packA: { file: ${packSourceOf(packA)} }`, `packB: { file: ${packSourceOf(packB)} }`, 'env: prod', ...lines, 'gate: { minAlignmentPct: 1 }', ''].join('\n'));
  return readFileSync(journeyFileOf(name), 'utf8');
}
const forgetChecks = (names) => { for (const name of names) { rmSync(journeyFileOf(name), { force: true }); rmSync(join(WORKSPACE, 'runs', name), { recursive: true, force: true }); } };

test('which record a journey is graded on, through the server: the one its `service` names — typed in any case or spelling the catalogue keys the same — before any other; else the one whose own pack is its Pack A; a journey that is neither is graded on all seven, and another service on its own switches; the listing reads lastRun.gradeOff from the record alone', async () => {
  const P = `/api/services/${ids.shop}`;
  const off = ['chaos-validated', 'fresh'];
  const names = [];
  try {
    const patched = await call('PATCH', P, { gradeOff: [{ key: 'fresh', reason: 'read by hand each week' }, { key: 'chaos-validated', reason: 'no fault injection on this project' }] });
    assert.deepEqual([patched.status, patched.json.service.gradeOff.map((x) => x.key)], [200, off]);
    const run = await call('POST', `${P}/run`, {});
    assert.equal(run.status, 200, run.text);
    const scan = run.json.pack.id;
    assert.deepEqual(run.json.record.grade.off, off, 'two left out, in the engine\'s order');
    assert.equal(run.json.record.grade.score, scoreOf(engineGrade({ packA: scan, packB: run.json.livePack.id, env: 'prod', service: 'shop-api', off })), 'the engine\'s score over five');
    // Another service with nothing switched off, to tell the two records apart.
    assert.equal((await call('PATCH', `/api/services/${ids.bare}`, { repository: { kind: 'path', location: REPO } })).status, 200);
    const other = await call('POST', `/api/services/${ids.bare}/run`, {});
    assert.equal(other.status, 200, other.text);
    assert.ok(!('off' in other.json.record.grade), `another service is graded on its own switches — none: ${JSON.stringify(other.json.record.grade)}`);
    assert.equal(other.json.record.grade.score, scoreOf(engineGrade({ packA: other.json.pack.id, packB: other.json.livePack.id, env: 'prod', service: 'bare' })));
    assert.deepEqual([(await listedRun('bare.prod')).gradeOff, (await listedRun('shop-api.prod')).gradeOff], [[], off]);

    const calls = fake.calls.length;
    // What the server's run of a hand-written check records: [grade.off or null, the score, the engine's score for that reading].
    const graded = async (name, { packA, packB = CATALOGUE_B, lines = [], service = null, expectOff = [] }) => {
      names.push(name);
      writeCheckByHand(name, { packA, packB, lines });
      const r = await call('POST', `/api/journeys/${name}/run`, {});
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.record.grade.score, scoreOf(engineGrade({ packA, packB, env: 'prod', service, off: expectOff })), `${name}: the engine's score over ${7 - expectOff.length}`);
      return r.json.record.grade.off ?? null;
    };
    // The service it names, as a person types it: the slug, the name, another case and separator. Pack A is no service's.
    for (const [name, typed] of [['grade-by-slug', 'shop-api'], ['grade-by-name', 'Shop API'], ['grade-by-caps', 'SHOP_API']]) {
      assert.deepEqual(await graded(name, { packA: CATALOGUE_A, lines: [`service: ${typed}`], service: typed, expectOff: off }), off, `service: ${typed} is the record shop-api`);
    }
    // No service named: the record whose own pack — its scan — is the check's Pack A.
    assert.deepEqual(await graded('grade-by-pack', { packA: scan, expectOff: off }), off, 'Pack A is the service\'s own pack');
    // A service named that has no record: still Pack A's.
    assert.deepEqual(await graded('grade-by-pack-not-name', { packA: scan, lines: ['service: nobody-home'], service: 'nobody-home', expectOff: off }), off, 'a name that finds no record leaves Pack A to say');
    // The service named comes first: Pack A is this service's own, the check says it is the other's.
    assert.equal(await graded('grade-name-first', { packA: scan, lines: ['service: bare'], service: 'bare' }), null, 'the named record — nothing off — not Pack A\'s');
    assert.deepEqual(await graded('grade-name-first-back', { packA: other.json.pack.id, lines: ['service: shop-api'], service: 'shop-api', expectOff: off }), off, 'and the other way round');
    // Neither: no record is asked, and the check carries no gradeOff of its own — all seven.
    assert.equal(await graded('grade-of-none', { packA: CATALOGUE_A }), null, 'a check of no service');
    assert.equal(await graded('grade-of-stranger', { packA: CATALOGUE_A, lines: ['service: nobody-home'], service: 'nobody-home' }), null, 'a check of a service without a record');
    assert.equal(fake.calls.length, calls, 'file checks: the live side was not read');
    assert.deepEqual([(await listedRun('grade-by-pack')).gradeOff, (await listedRun('grade-of-none')).gradeOff], [off, []]);

    // The listing reads the newest record as it is: only strings, seven at most; a record with no grade gives [].
    const sample = (await call('GET', '/api/journeys/grade-of-none/runs?limit=1')).json.runs[0];
    const drop = (startedAt, grade) => writeFileSync(join(WORKSPACE, 'runs', 'grade-of-none', `${startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({ ...sample, startedAt, grade }));
    drop('2099-01-01T00:00:00.000Z', { ...sample.grade, off: ['fresh', 7, null, { key: 'calibrated' }, 'a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    assert.deepEqual((await listedRun('grade-of-none')).gradeOff, ['fresh', 'a', 'b', 'c', 'd', 'e', 'f']);
    drop('2099-01-02T00:00:00.000Z', { ...sample.grade, off: 'chaos-validated' });
    assert.deepEqual((await listedRun('grade-of-none')).gradeOff, [], 'what is not a list is none');
    drop('2099-01-03T00:00:00.000Z', undefined);
    assert.deepEqual([(await listedRun('grade-of-none')).gradeScore, (await listedRun('grade-of-none')).gradeOff], [null, []], 'a record that graded nothing');
  } finally {
    forgetChecks(names);
    await call('PATCH', P, { gradeOff: [] });
  }
  assert.deepEqual((await call('GET', P)).json.service.gradeOff, [], 'the service is graded on everything again');
  assert.deepEqual((await call('GET', '/api/journeys')).json.journeys.map((x) => x.name).filter((n) => n.startsWith('grade-')), [], 'the hand-written checks are gone');
});

// ---------- the switches in the checks the studio saved ----------
//
// A run through the server asks the service record. A run with no record to
// ask — `packc journey run`, which is what a schedule runs — has only the
// check's file, so the server writes the record's switches into every check
// the studio saved for that service: a Run saves <slug>.<env> with them, a
// capture (POST /api/journeys/capture) of the service's pack, or scoped to
// the service, is saved with them, and a PATCH that changes them rewrites
// those files — the keys only (gradeOff: [...]), absent when none is off,
// under the comment block the file had and with every other key as it was. A
// file written by hand is never rewritten: through the server it is graded
// on the record anyway.

const gradedShop = { why: 'no fault injection on this project' };

test('a service\'s switches are written into the checks the studio saved for it: a PATCH before any Run makes no file; a Run with a criterion off saves gradeOff; a capture of the service\'s own pack, or one scoped to it by a name in any case, is saved with it, a capture of a pack that is no service\'s or of a service with nothing off without it; a PATCH that changes the switches rewrites those files — the list, or no key for [] — keeping their comment block, name, packA, packB, env, service, gate and schedule; files written by hand, checks of other services and a check of no service are left byte for byte; a PATCH that changes no key touches no file; a Run with nothing off saves no such key', async () => {
  const { existsSync, statSync } = await import('node:fs');
  const { loadJourneyDef } = await import('../tools/lib/journey.mjs');
  const { why } = gradedShop;
  const created = await call('POST', '/api/services', { name: 'Graded Shop', repository: { kind: 'path', location: REPO } });
  assert.equal(created.status, 201, created.text);
  ids.graded = created.json.service.id;
  const P = `/api/services/${ids.graded}`;
  for (const name of ['prod', 'staging']) assert.equal((await call('POST', `${P}/environments`, { name, mcpEndpointId: ids.endpoint })).status, 201);
  const NAME = 'graded-shop.prod';
  const textOf = (name = NAME) => readFileSync(journeyFileOf(name), 'utf8');
  const commentsOf = (name = NAME) => textOf(name).split('\n').filter((l) => l.startsWith('#'));
  // A saved check as the command line loads it (the loader's own __source aside), and without its gradeOff.
  const defOf = (name = NAME) => { const { __source: _source, ...def } = runWithOrg('default', () => loadJourneyDef(name)); return def; };
  const rest = ({ gradeOff: _gradeOff, ...others }) => others;
  const patchOff = async (list) => { const r = await call('PATCH', P, { gradeOff: list }); assert.equal(r.status, 200, r.text); return r.json; };
  const capture = async (body) => { const r = await call('POST', '/api/journeys/capture', body); assert.deepEqual([r.status, r.json?.ok, r.json?.name], [200, true, body.name], r.text); return defOf(body.name); };
  gradedShop.textOf = textOf;
  gradedShop.defOf = defOf;
  gradedShop.capture = capture;

  // No check saved yet: the switch is on the record, and no file is made for it.
  assert.deepEqual((await patchOff([{ key: 'chaos-validated', reason: why }])).changed, ['gradeOff']);
  assert.deepEqual([existsSync(journeyFileOf(NAME)), existsSync(journeyFileOf('graded-shop.staging'))], [false, false], 'a switch creates no check');

  // The first Run saves the check, and the switches with it.
  const run = await call('POST', `${P}/run`, { env: 'prod' });
  assert.equal(run.status, 200, run.text);
  const scan = run.json.pack.id;
  const saved = defOf();
  assert.deepEqual(saved, {
    name: NAME, packA: { file: `../packs/${scan}.pack.yaml` }, packB: { mcp: { url: saved.packB.mcp.url, endpointId: ids.endpoint } },
    env: 'prod', service: 'graded-shop', gate: { minAlignmentPct: 85 }, gradeOff: ['chaos-validated'],
  });
  assert.match(commentsOf()[0], /^# Saved by the service graded-shop, environment prod, on \d{4}-\d{2}-\d{2}T[\d:.]+Z\.$/);
  assert.equal(commentsOf().length, 3);
  assert.ok(!textOf().includes(why) && !/\bby:|\bat:|reason/.test(textOf()), 'the file carries the keys — never a reason, a name or a time');
  assert.deepEqual(run.json.record.grade.off, ['chaos-validated']);
  assert.equal(existsSync(journeyFileOf('graded-shop.staging')), false, 'the environment that was not run has no check');

  // By hand on the saved check: a looser gate and a schedule.
  writeFileSync(journeyFileOf(NAME), `${textOf().replace('minAlignmentPct: 85', 'minAlignmentPct: 40')}schedule:\n  every: 15m\n`);
  assert.deepEqual([defOf().gate, defOf().schedule, defOf().gradeOff], [{ minAlignmentPct: 40 }, { every: '15m' }, ['chaos-validated']]);

  // Captures from the studio, each saved with the switches of the service it is a check of — or none.
  const shopScan = (await call('GET', '/api/packs')).json.packs.find((p) => p.label === 'Shop API · prod · repository')?.id;
  assert.ok(shopScan, 'the other service\'s scan is registered');
  const ofItsPack = await capture({ name: 'graded-shop-repo-vs-reference', packAId: scan, packBId: CATALOGUE_B, env: 'prod', gate: { minAlignmentPct: 50 }, schedule: { every: '30m' } });
  assert.deepEqual(ofItsPack, {
    name: 'graded-shop-repo-vs-reference', packA: { file: `../packs/${scan}.pack.yaml` }, packB: { file: packSourceOf(CATALOGUE_B) },
    env: 'prod', gate: { minAlignmentPct: 50 }, schedule: { every: '30m' }, gradeOff: ['chaos-validated'],
  }, 'no service named: Pack A is the service\'s own pack, so its switches are saved with the capture');
  const byName = await capture({ name: 'graded-shop-scoped', packAId: CATALOGUE_A, packBId: CATALOGUE_B, service: 'Graded_SHOP' });
  assert.deepEqual([byName.service, byName.gradeOff], ['Graded_SHOP', ['chaos-validated']], 'scoped to the service by a name in another case and spelling');
  const ofNone = await capture({ name: 'graded-reference-only', packAId: CATALOGUE_A, packBId: CATALOGUE_B, env: 'prod' });
  assert.ok(!('gradeOff' in ofNone), `a capture of a pack that is no service's carries none: ${JSON.stringify(ofNone)}`);
  const ofStranger = await capture({ name: 'graded-stranger-scope', packAId: CATALOGUE_A, packBId: CATALOGUE_B, service: 'nobody-home' });
  assert.ok(!('gradeOff' in ofStranger), 'nor one scoped to a service that has no record');
  const ofOther = await capture({ name: 'graded-other-service', packAId: shopScan, packBId: CATALOGUE_B, env: 'prod' });
  assert.ok(!('gradeOff' in ofOther), 'nor one of a service that has nothing switched off');
  for (const name of ['graded-shop-repo-vs-reference', 'graded-shop-scoped', 'graded-reference-only', 'graded-stranger-scope', 'graded-other-service']) {
    assert.match(commentsOf(name)[0], /^# Captured from a studio session on \d{4}-/, name);
    assert.equal(commentsOf(name).length, 5, name);
  }
  // Two files written by hand that name the service: one bare, one under a comment of its writer's.
  const byHand = writeCheckByHand('graded-shop-by-hand', { packA: scan, packB: CATALOGUE_B, lines: ['service: graded-shop', 'gradeOff: [drift-free]'] });
  writeFileSync(journeyFileOf('graded-shop-annotated'), `# my own check of the shop\n${writeCheckByHand('graded-shop-annotated', { packA: CATALOGUE_A, packB: CATALOGUE_B, lines: ['service: graded-shop'] })}`);
  const annotated = textOf('graded-shop-annotated');

  const STUDIO = [NAME, 'graded-shop-repo-vs-reference', 'graded-shop-scoped'];
  const LEFT = ['graded-reference-only', 'graded-stranger-scope', 'graded-other-service', 'graded-shop-by-hand', 'graded-shop-annotated', 'shop-api.prod', 'bare.prod'];
  const snapshot = (names) => Object.fromEntries(names.map((n) => [n, { text: textOf(n), mtimeMs: statSync(journeyFileOf(n)).mtimeMs }]));
  const before = Object.fromEntries(STUDIO.map((n) => [n, { def: defOf(n), comments: commentsOf(n) }]));
  const left = snapshot(LEFT);

  // A PATCH that changes the switches: the three studio-saved checks of this service carry the new list …
  assert.deepEqual((await patchOff([{ key: 'fresh', reason: 'read by hand each week' }, { key: 'chaos-validated', reason: why }])).changed, ['gradeOff']);
  for (const name of STUDIO) {
    const now = defOf(name);
    assert.deepEqual(now.gradeOff, ['chaos-validated', 'fresh'], `${name}: the keys, in the engine's order`);
    assert.deepEqual(rest(now), rest(before[name].def), `${name}: every other key as it was`);
    assert.deepEqual(commentsOf(name), before[name].comments, `${name}: its comment block as it was — the first line still says who saved it and when`);
    assert.ok(!/read by hand|no fault injection/.test(textOf(name)), `${name}: never a reason`);
  }
  assert.deepEqual([defOf().gate, defOf().schedule, defOf().packA, defOf().packB, defOf().env, defOf().service, defOf().name],
    [{ minAlignmentPct: 40 }, { every: '15m' }, saved.packA, saved.packB, 'prod', 'graded-shop', NAME], 'the service\'s own check keeps the hand-set gate and the schedule');
  // … and nothing else is touched: not a file written by hand, not a check of another service or of none, and none is created.
  assert.deepEqual(snapshot(LEFT), left, 'the other files are byte for byte, their times included');
  assert.deepEqual([textOf('graded-shop-by-hand'), textOf('graded-shop-annotated')], [byHand, annotated]);
  assert.equal(existsSync(journeyFileOf('graded-shop.staging')), false);

  // A PATCH that changes no key — a reworded reason, another field, the same list — touches no file at all.
  const settled = snapshot([...STUDIO, ...LEFT]);
  assert.deepEqual((await patchOff([{ key: 'fresh', reason: 'read by hand each month' }, { key: 'chaos-validated', reason: why }])).changed, ['gradeOff'], 'a reworded reason is a change of the record');
  assert.deepEqual((await call('PATCH', P, { tier: 'tier-2' })).json.changed, ['tier']);
  assert.deepEqual((await patchOff([{ key: 'chaos-validated', reason: why }, { key: 'fresh', reason: 'read by hand each month' }])).changed, []);
  assert.deepEqual(snapshot([...STUDIO, ...LEFT]), settled, 'the keys are the ones the files hold: nothing is rewritten');

  // [] switches everything back on: the key is gone from the three, the rest as it was; the hand-written file still says what its writer typed.
  assert.deepEqual((await patchOff([])).changed, ['gradeOff']);
  for (const name of STUDIO) {
    assert.ok(!('gradeOff' in defOf(name)) && !/gradeOff/.test(textOf(name)), `${name}: no gradeOff key`);
    assert.deepEqual(defOf(name), rest(before[name].def), `${name}: every other key as it was`);
    assert.deepEqual(commentsOf(name), before[name].comments, name);
  }
  assert.deepEqual(snapshot(LEFT), left);
  assert.deepEqual(defOf('graded-shop-by-hand').gradeOff, ['drift-free']);

  // A Run with nothing off saves the check without the key — and, as a Run does, with the gate and the schedule it had.
  const runBare = await call('POST', `${P}/run`, { env: 'prod' });
  assert.equal(runBare.status, 200, runBare.text);
  assert.ok(!('off' in runBare.json.record.grade), JSON.stringify(runBare.json.record.grade));
  assert.deepEqual(defOf(), { ...rest(before[NAME].def), packA: { file: `../packs/${runBare.json.pack.id}.pack.yaml` } }, 'no gradeOff; the new scan as Pack A; the rest kept');
  // The service and its own check go on to the next test; the captures and the hand-written files end here.
  forgetChecks(['graded-shop-scoped', 'graded-reference-only', 'graded-stranger-scope', 'graded-other-service', 'graded-shop-annotated', 'graded-shop-repo-vs-reference', 'graded-shop-by-hand']);
});

test('a check is a service\'s by its Pack A only when that file is the service\'s own pack in this workspace — a pack of the same name elsewhere is not; a rewrite keeps the check\'s own name, edited or not', async () => {
  const { mkdirSync, copyFileSync } = await import('node:fs');
  const { why, defOf, capture, textOf } = gradedShop;
  const P = `/api/services/${ids.graded}`;
  const scanId = defOf('graded-shop.prod').packA.file.replace(/^.*\//, '').replace(/\.pack\.yaml$/, '');
  const names = ['graded-lookalike', 'graded-renamed'];
  try {
    // A check the studio would have written, whose Pack A carries the scan's file name in another folder.
    mkdirSync(join(WORKSPACE, 'elsewhere'), { recursive: true });
    copyFileSync(join(WORKSPACE, 'packs', `${scanId}.pack.yaml`), join(WORKSPACE, 'elsewhere', `${scanId}.pack.yaml`));
    const hand = writeCheckByHand('graded-lookalike', { packA: scanId, packB: CATALOGUE_B }).replace(`../packs/${scanId}.pack.yaml`, `../elsewhere/${scanId}.pack.yaml`);
    writeFileSync(journeyFileOf('graded-lookalike'), `# Captured from a studio session on 2026-11-10T00:00:00.000Z.\n${hand}`);
    const lookalike = textOf('graded-lookalike');
    // A capture of the service's own pack whose name was edited by hand.
    await capture({ name: 'graded-renamed', packAId: scanId, packBId: CATALOGUE_B, env: 'prod' });
    writeFileSync(journeyFileOf('graded-renamed'), textOf('graded-renamed').replace('name: graded-renamed', 'name: graded-renamed-original'));

    assert.deepEqual((await call('PATCH', P, { gradeOff: [{ key: 'fresh', reason: why }] })).json.changed, ['gradeOff']);
    assert.equal(textOf('graded-lookalike'), lookalike, 'a pack of the same name elsewhere is not the service\'s: the file is not rewritten');
    const run = await call('POST', '/api/journeys/graded-lookalike/run', {});
    assert.equal(run.status, 200, run.text);
    assert.equal(run.json.record.grade.off, undefined, 'and it is graded on all seven, not on the service\'s switches');
    const renamed = defOf('graded-renamed');
    assert.deepEqual([renamed.name, renamed.gradeOff], ['graded-renamed-original', ['fresh']], 'the rewrite keeps the name the file gives, and carries the switch');
    assert.match(textOf('graded-renamed'), /^# Captured from a studio session on /);
  } finally {
    await call('PATCH', P, { gradeOff: [] });
    forgetChecks([...names, 'graded-renamed-original']);
  }
});

test('a run with no record to ask is graded as the service is — the saved check run from the command line, in process and as a child process, and a capture of the service\'s pack; through the server the record is asked whatever a file says — a list typed into the saved check, a file written by hand, with the record\'s switches on or all off; a check of no service is graded on its own gradeOff; a mistyped one does not load; once the service is deleted its leftover check is graded on what it carries', async () => {
  const { spawn } = await import('node:child_process');
  const { loadJourneyDef, runJourney } = await import('../tools/lib/journey.mjs');
  const { why, textOf, defOf, capture } = gradedShop;
  const P = `/api/services/${ids.graded}`;
  const NAME = 'graded-shop.prod';
  const off = ['chaos-validated'];
  const scope = { env: 'prod', service: 'graded-shop' };
  const serverRun = async (name) => { const r = await call('POST', `/api/journeys/${name}/run`, {}); assert.equal(r.status, 200, r.text); return r.json; };
  // The command line's own path, in this process: the saved file loaded and run with nothing handed in.
  const commandLine = (name) => runWithOrg('default', () => runJourney(loadJourneyDef(name)));
  const names = ['graded-shop-by-hand'];
  try {
    assert.deepEqual((await call('PATCH', P, { gradeOff: [{ key: 'chaos-validated', reason: why }] })).json.changed, ['gradeOff']);
    const run = await call('POST', `${P}/run`, { env: 'prod' });
    assert.equal(run.status, 200, run.text);
    const scan = run.json.pack.id;
    const six = scoreOf(engineGrade({ packA: scan, packB: run.json.livePack.id, ...scope, off }));
    const seven = scoreOf(engineGrade({ packA: scan, packB: run.json.livePack.id, ...scope }));
    assert.notEqual(six, seven, 'the switch moves this service\'s score');
    assert.deepEqual([run.json.record.grade.off, run.json.record.grade.score, defOf().gradeOff], [off, six, off], 'the Run: the record, and the check it saved');

    // The command line on the saved check: it reads the live side itself and has no record to ask — the file's list.
    const calls = fake.calls.length;
    const cli = await commandLine(NAME);
    assert.ok(fake.calls.length > calls, 'it read the live side through the URL the check names');
    assert.deepEqual([cli.grade.off, cli.grade.score, cli.drift], [off, six, run.json.record.drift], 'graded as the service is: grade.off, the engine\'s score over six, on the comparison the Run made');
    assert.deepEqual((await newestRecord(NAME)).grade, cli.grade, 'the board reads that record');
    assert.deepEqual([(await listedRun(NAME)).gradeOff, (await listedRun(NAME)).gradeScore], [off, six]);
    // … and the command line itself, as a schedule runs it: a child process on this workspace.
    const child = await new Promise((done, failed) => {
      const proc = spawn(process.execPath, [join(ROOT, 'tools', 'cli.mjs'), 'journey', 'run', NAME, '--json'], { env: { ...process.env, OBSERVOGRAM_WORKSPACE: WORKSPACE }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { proc.kill('SIGKILL'); failed(new Error(`packc journey run did not end in 60 s: ${stderr || stdout}`)); }, 60_000);
      proc.stdout.on('data', (b) => { stdout += b; });
      proc.stderr.on('data', (b) => { stderr += b; });
      proc.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
    });
    let printed = null;
    try { printed = JSON.parse(child.stdout); } catch { /* asserted below */ }
    assert.ok(printed, `packc journey run --json prints the record: exit ${child.code}, ${child.stderr.slice(0, 400)}`);
    assert.deepEqual([printed.journey, printed.grade, child.code], [NAME, cli.grade, printed.outcome === 'pass' ? 0 : 1], 'the same grade — grade.off and the score over six — from the command line itself');

    // A capture of the service's own pack, named no service: saved with the switches, and graded on them both ways.
    const captured = await capture({ name: 'graded-shop-repo-vs-reference', packAId: scan, packBId: CATALOGUE_B, env: 'prod' });
    names.push('graded-shop-repo-vs-reference');
    assert.deepEqual([captured.gradeOff, 'service' in captured], [off, false]);
    const capturedSix = scoreOf(engineGrade({ packA: scan, packB: CATALOGUE_B, env: 'prod', off }));
    const viaServer = await serverRun('graded-shop-repo-vs-reference');
    assert.deepEqual([viaServer.record.scope.service, viaServer.record.grade.off, viaServer.record.grade.score], [null, off, capturedSix], 'through the server: the record of its Pack A\'s service');
    const viaCli = await commandLine('graded-shop-repo-vs-reference');
    assert.deepEqual([viaCli.grade.off, viaCli.grade.score], [off, capturedSix], 'from the command line: the list the capture was saved with');

    // Through the server the record is asked, whatever the file says.
    // (1) Another list typed into the service's own check.
    writeFileSync(journeyFileOf(NAME), textOf().replace('- chaos-validated', '- drift-free'));
    assert.deepEqual(defOf().gradeOff, ['drift-free']);
    const check = await serverRun(NAME);
    assert.deepEqual([check.record.grade.off, check.record.grade.score], [off, scoreOf(engineGrade({ packA: scan, packB: check.livePack.id, ...scope, off }))], 'Check now: the record\'s switch, not the one typed into the file');
    assert.deepEqual(defOf().gradeOff, ['drift-free'], 'a run does not rewrite the check');
    assert.deepEqual((await commandLine(NAME)).grade.off, ['drift-free'], 'the command line has only the file');
    // (2) A file written by hand that names the service and says another list: the record's, and the file stays as written.
    const handSix = scoreOf(engineGrade({ packA: scan, packB: CATALOGUE_B, ...scope, off }));
    const handText = writeCheckByHand('graded-shop-by-hand', { packA: scan, packB: CATALOGUE_B, lines: ['service: graded-shop', 'gradeOff: [drift-free]'] });
    const hand = await serverRun('graded-shop-by-hand');
    assert.deepEqual([hand.record.grade.off, hand.record.grade.score], [off, handSix], 'the record\'s switch, not drift-free');
    assert.equal(textOf('graded-shop-by-hand'), handText, 'and the file is as its writer left it');
    // (3) With every switch back on, the record still decides: all seven, though both files name a criterion.
    assert.deepEqual((await call('PATCH', P, { gradeOff: [] })).json.changed, ['gradeOff']);
    assert.ok(!('gradeOff' in defOf()), 'the switch rewrote the service\'s own check: the typed list is gone with the key');
    assert.equal(textOf('graded-shop-by-hand'), handText, 'and left the file written by hand as it was');
    const handSeven = await serverRun('graded-shop-by-hand');
    assert.ok(!('off' in handSeven.record.grade), `nothing is off on the record: ${JSON.stringify(handSeven.record.grade)}`);
    assert.equal(handSeven.record.grade.score, scoreOf(engineGrade({ packA: scan, packB: CATALOGUE_B, ...scope })));
    assert.deepEqual((await call('PATCH', P, { gradeOff: [{ key: 'chaos-validated', reason: why }] })).json.changed, ['gradeOff']);
    assert.deepEqual([defOf().gradeOff, defOf('graded-shop-repo-vs-reference').gradeOff, textOf('graded-shop-by-hand')], [off, off, handText], 'switched off again: back in the two studio-saved checks');

    // A check of no service — Pack A is no service's, and it names none or one without a record — is graded on its own gradeOff.
    names.push('graded-own-list', 'graded-own-list-stranger', 'graded-typo', 'graded-all-seven');
    writeCheckByHand('graded-own-list', { packA: CATALOGUE_A, packB: CATALOGUE_B, lines: ['gradeOff: [fresh, chaos-validated]'] });
    const own = await serverRun('graded-own-list');
    assert.deepEqual([own.record.grade.off, own.record.grade.score], [['chaos-validated', 'fresh'], scoreOf(engineGrade({ packA: CATALOGUE_A, packB: CATALOGUE_B, env: 'prod', off: ['chaos-validated', 'fresh'] }))], 'its own list, in the engine\'s order');
    writeCheckByHand('graded-own-list-stranger', { packA: CATALOGUE_A, packB: CATALOGUE_B, lines: ['service: nobody-home', 'gradeOff: [fresh]'] });
    assert.deepEqual((await serverRun('graded-own-list-stranger')).record.grade.off, ['fresh']);
    // A mistyped list, or one naming all seven, does not load: the listing says why, and a run is refused with that sentence.
    const KEYS = 'multi-modal, correlated, calibrated, comprehensive, chaos-validated, drift-free, fresh';
    for (const [name, line, whyNot] of [['graded-typo', 'gradeOff: [chaos]', '"chaos" is not one'], ['graded-all-seven', `gradeOff: [${KEYS}]`, 'a check is graded on at least one criterion']]) {
      writeCheckByHand(name, { packA: CATALOGUE_A, packB: CATALOGUE_B, lines: [line] });
      const sentence = `journey ${name}: gradeOff must be a list of grade criteria (${KEYS}) — ${whyNot}`;
      const listed = (await call('GET', '/api/journeys')).json.journeys.find((x) => x.name === name);
      assert.deepEqual([listed.loadError, listed.lastRun], [sentence, null], name);
      const refused = await call('POST', `/api/journeys/${name}/run`, {});
      assert.deepEqual([refused.status, refused.json], [404, { ok: false, error: sentence }], name);
    }

    // The service's next Run puts the record's switches in its check again, whatever was typed there.
    writeFileSync(journeyFileOf(NAME), textOf().replace('- chaos-validated', '- drift-free'));
    assert.equal((await call('POST', `${P}/run`, { env: 'prod' })).status, 200);
    assert.deepEqual(defOf().gradeOff, off);

    // The service deleted: its check stays in the workspace without the switches — they were the record's, and
    // a service made again under the name starts with none — so the server and the command line agree on seven.
    const deleted = await call('DELETE', P);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(defOf().gradeOff, undefined, 'the deletion takes the switches out of the check that was the service\'s');
    assert.ok(/^# Saved by the service /.test(textOf()), 'and keeps the check and its comment block');
    assert.deepEqual([defOf().service, defOf().env], ['graded-shop', 'prod'], 'and its keys');
    assert.equal((await serverRun(NAME)).record.grade.off, undefined, 'through the server: all seven');
    assert.equal((await commandLine(NAME)).grade.off, undefined, 'from the command line: all seven too');
  } finally {
    forgetChecks([NAME, ...names]);
  }
});

test('a Run saves its check with the switches as they are when it saves: a criterion switched off while the repository is being read is in the saved check and in the run\'s record, not undone', async () => {
  const { loadJourneyDef } = await import('../tools/lib/journey.mjs');
  const created = await call('POST', '/api/services', { name: 'Slow Shop', repository: { kind: 'github', location: 'acme/slow-shop' } });
  assert.equal(created.status, 201, created.text);
  const P = `/api/services/${created.json.service.id}`;
  assert.equal((await call('POST', `${P}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);
  // GitHub, stubbed in this process: the repository answers the made-up token below, and holds its one file until released.
  const MINE = 'ghp_MadeUpTokenForTheSlowRead0123';
  const RULES = readFileSync(join(REPO, 'prometheus', 'rules.yml'), 'utf8');
  const realFetch = globalThis.fetch;
  let reading;
  let release;
  const isReading = new Promise((ok) => { reading = ok; });
  const released = new Promise((ok) => { release = ok; });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/') && !u.startsWith('https://raw.githubusercontent.com/')) return realFetch(url, init);
    if ((init.headers?.Authorization ?? null) !== `Bearer ${MINE}`) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (u.endsWith('/repos/acme/slow-shop')) return new Response(JSON.stringify({ default_branch: 'main' }));
    if (u.includes('/repos/acme/slow-shop/git/trees/main')) return new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'alerts/api.rules.yml', size: RULES.length }] }));
    if (u.includes('/repos/acme/slow-shop/contents/')) { reading(); await released; return new Response(RULES); }
    return new Response('', { status: 404 });
  };
  try {
    assert.deepEqual((await call('GET', P)).json.service.gradeOff, [], 'nothing off when the Run starts');
    const pending = call('POST', `${P}/run`, { repoAuth: MINE });
    await Promise.race([isReading, pending.then((r) => { throw new Error(`the Run answered before it read the repository: ${r.status} ${r.text}`); })]);
    // The repository is being read: the switch lands now. No check is saved yet, so the switch itself writes no file.
    const patched = await call('PATCH', P, { gradeOff: [{ key: 'chaos-validated', reason: 'no fault injection on this project' }] });
    assert.deepEqual([patched.status, patched.json.changed], [200, ['gradeOff']]);
    release();
    const run = await pending;
    assert.equal(run.status, 200, run.text);
    const saved = runWithOrg('default', () => loadJourneyDef('slow-shop.prod'));
    assert.deepEqual(saved.gradeOff, ['chaos-validated'], 'the check is saved with the switch made during the read');
    assert.deepEqual(run.json.record.grade.off, ['chaos-validated'], 'and the run it then makes is graded on the record as it is');
  } finally {
    release();
    globalThis.fetch = realFetch;
    await call('DELETE', P);
    forgetChecks(['slow-shop.prod']);
  }
});

// ---------- a repository uploaded from the person's own machine ----------
//
// Overview's Upload: the files the browser read from a folder or a .zip are
// kept as the service's copy (server/repository-uploads.mjs), and each Run
// scans the copy. No token reads anything: the person's own access got the files.

const { walkRepoFiles } = await import('../tools/lib/journey.mjs');
const { parseUpload, uploadPathOf, UPLOAD_LIMITS, UPLOAD_WAYS } = await import('./repository-uploads.mjs');
const { existsSync } = await import('node:fs');
// The files as a browser reads a picked folder: each path under the folder's name.
const UPLOADED = Object.fromEntries(Object.entries(walkRepoFiles(REPO)).map(([k, v]) => [`operational-alerts/${k}`, v]));
const copyOf = (id) => runWithOrg('default', () => uploadPathOf(id));

test('PUT /api/services/:id/repository-upload keeps the copy and points the record at it (one service.update row); POST and PATCH never name an upload; each refusal writes nothing', async () => {
  const created = await call('POST', '/api/services', { name: 'Uploaded Shop' });
  assert.equal(created.status, 201, created.text);
  ids.uploaded = created.json.service.id;
  const env = await call('POST', `/api/services/${ids.uploaded}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint });
  assert.equal(env.status, 201, env.text);
  const updates = auditRows('service.update').length;

  for (const [body, error] of [
    [undefined, UPLOAD_WAYS.body],
    [{ name: 'x', files: [] }, UPLOAD_WAYS.body],
    [{ files: UPLOADED }, UPLOAD_WAYS.name],
    [{ name: 'two\nlines', files: UPLOADED }, UPLOAD_WAYS.name],
    [{ name: 'empty', files: {} }, UPLOAD_WAYS.none],
    [{ name: 'up', files: { '../outside.yaml': 'x' } }, UPLOAD_WAYS.path('../outside.yaml')],
    [{ name: 'abs', files: { '/etc/x.yaml': 'x' } }, UPLOAD_WAYS.path('/etc/x.yaml')],
    [{ name: 'drive', files: { 'C:/x.yaml': 'x' } }, UPLOAD_WAYS.path('C:/x.yaml')],
    [{ name: 'dots', files: { 'a/./b.yaml': 'x' } }, UPLOAD_WAYS.path('a/./b.yaml')],
    [{ name: 'bytes', files: { 'a.yaml': 7 } }, UPLOAD_WAYS.text('a.yaml')],
  ]) {
    const r = await call('PUT', `/api/services/${ids.uploaded}/repository-upload`, body);
    assert.deepEqual([r.status, r.json?.error], [400, error], JSON.stringify(body)?.slice(0, 80));
  }
  assert.equal(existsSync(copyOf(ids.uploaded)), false, 'a refusal keeps no copy');
  assert.equal(auditRows('service.update').length, updates, 'and writes no row');
  assert.equal((await call('PUT', '/api/services/999999/repository-upload', { name: 'x', files: UPLOADED })).status, 404);
  for (const [method, path] of [['POST', '/api/services'], ['PATCH', `/api/services/${ids.uploaded}`]]) {
    const r = await call(method, path, { name: 'Named Upload', repository: { kind: 'upload', location: 'shop.zip' } });
    assert.deepEqual([r.status, r.json.error], [400, WAYS.repositoryUploadNamed], method);
  }

  const before = Date.now();
  const up = await call('PUT', `/api/services/${ids.uploaded}/repository-upload`, { name: ' operational-alerts.zip ', files: UPLOADED });
  assert.equal(up.status, 200, up.text);
  const bytes = Object.values(UPLOADED).reduce((n, v) => n + v.length, 0);
  const repository = { kind: 'upload', location: 'operational-alerts.zip', ref: null, uploadedAt: up.json.upload.uploadedAt, files: Object.keys(UPLOADED).length, bytes };
  assert.deepEqual([up.json.upload, up.json.service.repository], [repository, repository]);
  assert.ok(Date.parse(repository.uploadedAt) >= before - 1000);
  assert.deepEqual((await call('GET', `/api/services/${ids.uploaded}`)).json.service.repository, repository, 'the record says where its copy came from and when');
  assert.equal(existsSync(copyOf(ids.uploaded)), true);
  assert.equal(auditRows('service.update').length, updates + 1, 'one service.update row');

  // The caps parseUpload holds (the JSON body limit refuses a larger request before it).
  assert.throws(() => parseUpload({ name: 'big', files: { 'a.yaml': 'x'.repeat(UPLOAD_LIMITS.fileBytes + 1) } }), { message: UPLOAD_WAYS.fileTooBig('a.yaml') });
  const four = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}.yaml`, 'x'.repeat(UPLOAD_LIMITS.fileBytes)]));
  assert.throws(() => parseUpload({ name: 'big', files: four }), { message: UPLOAD_WAYS.tooBig(4 * UPLOAD_LIMITS.fileBytes) });
  const many = Object.fromEntries(Array.from({ length: UPLOAD_LIMITS.files + 1 }, (_, i) => [`f${i}.yaml`, '']));
  assert.throws(() => parseUpload({ name: 'many', files: many }), { message: UPLOAD_WAYS.tooMany });
});

test('a Run scans the upload as the repository and registers it as the service\'s pack; a copy that is gone is named; a new upload replaces it; pointed elsewhere or deleted, the service takes its copy with it', async () => {
  const r = await call('POST', `/api/services/${ids.uploaded}/run`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.scan.source, r.json.scan.files, r.json.scan.skipped], ['the upload operational-alerts.zip', Object.keys(UPLOADED).length, 0]);
  assert.equal(r.json.journey, 'uploaded-shop.prod');
  const svc = (await call('GET', `/api/services/${ids.uploaded}`)).json.service;
  assert.deepEqual(svc.packs.filter((p) => p.role === 'primary').map((p) => [p.id, p.source]), [[r.json.pack.id, 'repository:upload']]);

  rmSync(copyOf(ids.uploaded));
  const gone = await call('POST', `/api/services/${ids.uploaded}/run`, {});
  assert.deepEqual([gone.status, gone.json.error], [404, `the repository could not be read: ${UPLOAD_WAYS.gone('operational-alerts.zip')}`]);

  const again = await call('PUT', `/api/services/${ids.uploaded}/repository-upload`, { name: 'operational-alerts', files: UPLOADED });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.service.repository.location, 'operational-alerts', 'the new upload replaces the last');
  assert.equal((await call('POST', `/api/services/${ids.uploaded}/run`, {})).status, 200);

  const moved = await call('PATCH', `/api/services/${ids.uploaded}`, { repository: { kind: 'github', location: 'acme/shop' } });
  assert.deepEqual([moved.status, moved.json.changed], [200, ['repository']]);
  assert.equal(existsSync(copyOf(ids.uploaded)), false, 'pointed elsewhere: the copy goes');
  await call('PUT', `/api/services/${ids.uploaded}/repository-upload`, { name: 'operational-alerts', files: UPLOADED });
  assert.equal(existsSync(copyOf(ids.uploaded)), true);
  const deleted = await call('DELETE', `/api/services/${ids.uploaded}`);
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(existsSync(copyOf(ids.uploaded)), false, 'deleted: the copy goes');
});

// ---------- what a scan left out, said and kept ----------
//
// The Run answers with what its scan saw (tools/lib/crawler.mjs scanReport)
// and the run record keeps it (packA.scan): a folder's .gitignore files are
// honoured and a secrets file is never read — both named — and the files read
// and recognised as nothing are listed. A Check now on the same scan keeps it.

const { SCAN_WHY } = await import('../tools/lib/crawler.mjs');

test('a Run names what the scan left out — a file git ignores and a secrets file, never read — and the files it recognised as nothing; the record keeps it as packA.scan, and a Check now keeps it', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'observogram-service-run-ignored-'));
  const files = {
    ...walkRepoFiles(REPO),
    '.gitignore': 'values-local.yaml\n',
    'values-local.yaml': 'password: hunter2-local\n',
    'k8s/values-secrets.yaml': 'password: hunter2-secrets\n',
    'notes/unrelated.json': '{ "a": 1 }\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, rel)), { recursive: true });
    writeFileSync(join(folder, rel), text);
  }
  try {
    assert.equal((await call('PATCH', `/api/services/${ids.bare}`, { repository: { kind: 'path', location: folder } })).status, 200);
    const r = await call('POST', `/api/services/${ids.bare}/run`, {});
    assert.equal(r.status, 200, r.text);
    const { scan } = r.json;
    assert.deepEqual([scan.skipped, scan.skippedFiles], [2, [
      { path: 'k8s/values-secrets.yaml', why: SCAN_WHY.secret },
      { path: 'values-local.yaml', why: SCAN_WHY.gitignored },
    ]]);
    assert.ok(scan.unknownFiles.includes('notes/unrelated.json') && scan.unclassified >= 1, JSON.stringify(scan.unknownFiles));
    assert.ok(scan.classified > 0 && Object.keys(scan.byKind).length > 0 && Array.isArray(scan.warnings));
    assert.equal(scan.files, Object.keys(walkRepoFiles(REPO)).length + 1, 'the repository\'s files and the unrecognised one');
    assert.deepEqual(r.json.record.packA.scan, scan, 'the record keeps what the scan saw');
    const pack = (await call('GET', `/api/packs/${r.json.pack.id}`)).text;
    assert.ok(!/hunter2/.test(pack), 'nothing of either file reached the pack');
    const check = await call('POST', `/api/journeys/${r.json.journey}/run`, {});
    assert.equal(check.status, 200, check.text);
    assert.deepEqual(check.json.record.packA.scan, scan, 'Check now on the same scan keeps it');
    const listed = (await call('GET', `/api/journeys/${r.json.journey}/runs?limit=1`)).json.runs[0];
    assert.deepEqual(listed.packA.scan, scan, 'and the runs the board reads carry it');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('an upload never keeps a secrets file and keeps what the browser did not read; the Run names both', async () => {
  const created = await call('POST', '/api/services', { name: 'Uploaded Ledger' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.service.id;
  assert.equal((await call('POST', `/api/services/${id}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);
  const browserSkipped = [{ path: 'operational-alerts/values-local.yaml', why: SCAN_WHY.gitignored }];
  const up = await call('PUT', `/api/services/${id}/repository-upload`, {
    name: 'operational-alerts', skipped: browserSkipped,
    files: { ...UPLOADED, 'operational-alerts/k8s/values-secrets.yaml': 'password: hunter2\n' },
  });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.upload.files, Object.keys(UPLOADED).length, 'the secrets file is not kept');
  assert.ok(!readFileSync(copyOf(id), 'utf8').includes('hunter2'), 'not a byte of it on the server');
  const r = await call('POST', `/api/services/${id}/run`, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.scan.skippedFiles, [
    { path: 'operational-alerts/k8s/values-secrets.yaml', why: SCAN_WHY.secret },
    { path: 'operational-alerts/values-local.yaml', why: SCAN_WHY.gitignored },
  ]);
  assert.throws(() => parseUpload({ name: 'only', files: { 'secrets.yaml': 'x' } }), { message: UPLOAD_WAYS.none }, 'an upload of a secrets file alone holds nothing');
  const bounded = parseUpload({ name: 'b', files: { 'a.yaml': 'x' }, skipped: [{ path: 'p', why: 'w' }, { path: 7 }, 'x', ...Array.from({ length: UPLOAD_LIMITS.skipped + 5 }, () => ({ path: 'q', why: 'w' }))] });
  assert.equal(bounded.skipped.length, UPLOAD_LIMITS.skipped - 2, 'the browser\'s list is bounded, and an entry that is not { path, why } strings is dropped');
  assert.equal((await call('DELETE', `/api/services/${id}`)).status, 200);
});

// ---------- a repository read as the person who asked ----------
//
// server/repo-auth.mjs: a GitHub or Azure DevOps repository is read with the
// token the person sends with that request, used for that read only; the
// server's own token only on a server without sign-in; never in a log or an
// answer.

const REPO_AUTH = await import('./repo-auth.mjs');
const { repositoryCredential, parseRepoAuth, repoAuthNeed, redactToken, signInOn, REPO_AUTH_WAYS, RepoAuthRefusal } = REPO_AUTH;

test('repositoryCredential: the person\'s own token wins; the server\'s only on a server without sign-in, never once sign-in is on; a value that is no token is refused without being quoted', () => {
  const env = { GITHUB_TOKEN: 'srv-gh-00000', AZURE_DEVOPS_TOKEN: 'srv-ado-00000' };
  assert.deepEqual(repositoryCredential('github', { repoAuth: 'mine-12345', signIn: true, env }), { token: 'mine-12345', source: 'request' });
  assert.deepEqual(repositoryCredential('ado', { repoAuth: 'mine-12345', signIn: false, env }), { token: 'mine-12345', source: 'request' }, 'the person\'s own wins on the person\'s own machine too');
  assert.deepEqual(repositoryCredential('github', { signIn: false, env }), { token: 'srv-gh-00000', source: 'server' });
  assert.deepEqual(repositoryCredential('ado', { signIn: false, env }), { token: 'srv-ado-00000', source: 'server' });
  assert.deepEqual(repositoryCredential('github', { signIn: true, env }), { token: null, source: 'none', serverHeld: true }, 'sign-in on: the server\'s token is never sent');
  assert.deepEqual(repositoryCredential('ado', { signIn: true, env }), { token: null, source: 'none', serverHeld: true });
  assert.deepEqual(repositoryCredential('github', { signIn: false, env: {} }), { token: null, source: 'none', serverHeld: false });
  assert.equal(signInOn(), false, 'this suite runs with OBSERVOGRAM_AUTH=off: no sign-in');

  for (const none of [undefined, null, '']) assert.equal(parseRepoAuth(none), null);
  assert.equal(parseRepoAuth('ghp_abc123'), 'ghp_abc123');
  for (const bad of [7, 'two words', `x${'y'.repeat(4096)}`, 'line\nbreak', { token: 'x' }]) {
    assert.throws(() => parseRepoAuth(bad), (e) => e instanceof RepoAuthRefusal && e.message === REPO_AUTH_WAYS.shape && e.status === 400);
  }

  assert.deepEqual(repoAuthNeed('github', { source: 'none' }, 404), { kind: 'github', label: 'GitHub token', refused: false }, 'GitHub answers a private repository with 404');
  assert.deepEqual(repoAuthNeed('ado', { source: 'none' }, 401), { kind: 'ado', label: 'Azure DevOps token', refused: false });
  assert.deepEqual(repoAuthNeed('github', { source: 'request' }, 403), { kind: 'github', label: 'GitHub token', refused: true });
  assert.equal(repoAuthNeed('github', { source: 'server' }, 404), null, 'the server\'s token refused: its operator\'s fix, not the person\'s');
  assert.equal(repoAuthNeed('github', { source: 'none' }, 502), null);
  assert.equal(repoAuthNeed('path', { source: 'none' }, 404), null);
  assert.equal(redactToken('a mine-12345 b mine-12345', 'mine-12345'), 'a [your token] b [your token]');
  assert.equal(redactToken('nothing here', null), 'nothing here');
});

// The Run's tail sentences, word for word: every end-to-end assertion above interpolates
// REPO_AUTH_WAYS.*, so this is the one place a reword shows. README, "Whose access reads a repository".
test('REPO_AUTH_WAYS: the sentences a refused read ends with, pinned — Azure DevOps names Code (Read) and, on a server without sign-in, AZURE_DEVOPS_TOKEN; GitHub never names GITHUB_TOKEN', () => {
  const { repoAuthTail } = REPO_AUTH;
  assert.equal(REPO_AUTH_WAYS.needed('ado'), 'it needs your own Azure DevOps token (a personal access token with Code (Read)), sent with this Run and never kept');
  assert.equal(REPO_AUTH_WAYS.needed('ado', { serverToken: true }), 'it needs your own Azure DevOps token (a personal access token with Code (Read)), sent with this Run and never kept, or AZURE_DEVOPS_TOKEN set on this server for every Run');
  assert.equal(REPO_AUTH_WAYS.refused('ado'), 'your Azure DevOps token was refused or cannot read it — check that it can read this repository (Code (Read))');
  assert.equal(REPO_AUTH_WAYS.signIn('ado'), 'sign in to Azure DevOps to read it as you, or run it with your own Azure DevOps token (Code (Read))');
  assert.equal(REPO_AUTH_WAYS.signedInRefused('ado', 'ada@contoso.example'), 'you are signed in to Azure DevOps as ada@contoso.example, and that account cannot read this repository — sign in as one that can, or run it with a token that can');
  assert.equal(REPO_AUTH_WAYS.signedInRefused('ado', null), 'you are signed in to Azure DevOps, and that account cannot read this repository — sign in as one that can, or run it with a token that can', 'no account known');
  assert.equal(REPO_AUTH_WAYS.signedInRefused('ado', null, { expired: true }), 'your Azure DevOps sign-in has ended — sign in to Azure DevOps again');
  assert.equal(REPO_AUTH_WAYS.needed('github'), 'if it is private, run it with your own GitHub token (read access to its contents), sent with this Run and never kept');
  assert.equal(REPO_AUTH_WAYS.needed('github', { serverToken: true }), REPO_AUTH_WAYS.needed('github'), 'GITHUB_TOKEN is never named: the operator\'s way is said of Azure DevOps only');
  assert.equal(REPO_AUTH_WAYS.refused('github'), 'your GitHub token was refused or cannot read it — check that it can read this repository');
  assert.equal(REPO_AUTH_WAYS.signIn('github'), 'if it is private, sign in to GitHub to read it as you, or run it with your own GitHub token');
  assert.equal(REPO_AUTH_WAYS.signedInRefused('github', 'ada-gh'), 'you are signed in to GitHub as ada-gh, and that account cannot read this repository — sign in as one that can, or run it with a token that can');
  assert.equal(REPO_AUTH_WAYS.signedInRefused('github', 'ada-gh', { expired: true }), 'your GitHub sign-in has ended — sign in to GitHub again');
  // How the Run picks one (server/index.mjs): sign-in offered, else the token — the server's own named only
  // for Azure DevOps on a server without sign-in; `signIn: false` (an Azure DevOps Server) reads as not offered.
  assert.equal(repoAuthTail({ kind: 'ado', refused: false, signIn: true }, { serverToken: true }), REPO_AUTH_WAYS.signIn('ado'));
  assert.equal(repoAuthTail({ kind: 'ado', refused: false, signIn: false }, { serverToken: true }), REPO_AUTH_WAYS.needed('ado', { serverToken: true }));
  assert.equal(repoAuthTail({ kind: 'ado', refused: false }, { serverToken: false }), REPO_AUTH_WAYS.needed('ado'));
  assert.equal(repoAuthTail({ kind: 'github', refused: false }, { serverToken: true }), REPO_AUTH_WAYS.needed('github'));
  assert.equal(repoAuthTail({ kind: 'github', refused: true, signIn: true }), REPO_AUTH_WAYS.refused('github'));
  assert.equal(repoAuthTail({ kind: 'github', refused: true, via: 'sign-in', account: 'ada-gh', expired: true }), REPO_AUTH_WAYS.signedInRefused('github', 'ada-gh', { expired: true }));
  assert.equal(repoAuthTail(null), '');
});

test('a Run of a private GitHub repository sends the person\'s token for that read only: without it the answer asks for it, with it the scan reads, a wrong one is named; the server\'s token serves only a server without sign-in; no token reaches a log or an answer; Expert\'s GitHub scan follows the same rule', async () => {
  const created = await call('POST', '/api/services', { name: 'Private Shop', repository: { kind: 'github', location: 'acme/private-shop' } });
  assert.equal(created.status, 201, created.text);
  ids.privateShop = created.json.service.id;
  assert.equal((await call('POST', `/api/services/${ids.privateShop}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);

  const MINE = 'ghp_PersonalToken0123456789';
  const SERVER = 'ghp_ServerToken0123456789';
  const RULES = readFileSync(join(REPO, 'prometheus', 'rules.yml'), 'utf8');
  const realFetch = globalThis.fetch;
  const seen = [];
  // GitHub, stubbed: the repository answers only to MINE, and 404s otherwise, as GitHub hides a private repository.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/') && !u.startsWith('https://raw.githubusercontent.com/')) return realFetch(url, init);
    const auth = init.headers?.Authorization ?? null;
    seen.push({ url: u, auth });
    // GitHub's own 404 body, word for word: the sentence keeps its message only.
    if (auth !== `Bearer ${MINE}`) return new Response(JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest/repos/repos#get-a-repository', status: '404' }), { status: 404 });
    if (u.endsWith('/repos/acme/private-shop')) return new Response(JSON.stringify({ default_branch: 'main' }));
    if (u.includes('/repos/acme/private-shop/git/trees/main')) return new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'alerts/api.rules.yml', size: RULES.length }] }));
    if (u.includes('/repos/acme/private-shop/contents/')) return new Response(RULES);
    return new Response('', { status: 404 });
  };
  const logs = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { logs.push(String(chunk)); return realWrite(chunk, ...rest); };
  delete process.env.GITHUB_TOKEN;
  try {
    const run = (body) => call('POST', `/api/services/${ids.privateShop}/run`, body);

    const without = await run({});
    assert.equal(without.status, 404, without.text);
    assert.deepEqual(without.json.repoAuth, { kind: 'github', label: 'GitHub token', refused: false });
    assert.ok(without.json.error.endsWith(` — ${REPO_AUTH_WAYS.needed('github')}`), without.json.error);
    assert.ok(without.json.error.startsWith('the repository could not be read: GitHub 404 on /repos/acme/private-shop: Not Found — '), without.json.error);
    assert.ok(!/[{}]|documentation_url/.test(without.json.error), 'a sentence for a person, not the JSON GitHub sent');
    assert.ok(seen.length > 0 && seen.every((s) => s.auth === null), 'no token at all: none sent');

    seen.length = 0;
    const withMine = await run({ repoAuth: MINE });
    assert.equal(withMine.status, 200, withMine.text);
    assert.deepEqual([withMine.json.scan.source, withMine.json.scan.files], ['acme/private-shop on GitHub', 1]);
    assert.ok(seen.length >= 3 && seen.every((s) => s.auth === `Bearer ${MINE}` && s.url.startsWith('https://api.github.com/')), 'the person\'s token on every call, through the API (not raw)');

    seen.length = 0;
    const again = await run({});
    assert.equal(again.status, 404, 'the token was for that read only: the next Run without it has none');
    assert.ok(seen.every((s) => s.auth === null));

    const wrong = await run({ repoAuth: 'ghp_WrongToken000000000' });
    assert.deepEqual([wrong.status, wrong.json.repoAuth], [404, { kind: 'github', label: 'GitHub token', refused: true }]);
    assert.ok(wrong.json.error.endsWith(` — ${REPO_AUTH_WAYS.refused('github')}`));

    const shape = await run({ repoAuth: 'two words' });
    assert.deepEqual([shape.status, shape.json.error], [400, REPO_AUTH_WAYS.shape]);

    // A server without sign-in (this suite's posture) may read with its own token; a refusal of it is the operator's to fix.
    process.env.GITHUB_TOKEN = SERVER;
    seen.length = 0;
    const server = await run({});
    assert.equal(server.status, 404);
    assert.ok(seen.every((s) => s.auth === `Bearer ${SERVER}`), 'the server\'s token, on a server without sign-in');
    assert.equal(server.json.repoAuth, undefined, 'the person is not asked: their token would not be the fix');
    assert.equal((await run({ repoAuth: MINE })).status, 200, 'and the person\'s own still wins over it');

    // Expert's GitHub scan: the same rule.
    delete process.env.GITHUB_TOKEN;
    const scanNone = await call('POST', '/api/crawl-github', { url: 'acme/private-shop' });
    assert.deepEqual([scanNone.status, scanNone.json.repoAuth], [404, { kind: 'github', label: 'GitHub token', refused: false }]);
    assert.equal(scanNone.json.hint, `${REPO_AUTH_WAYS.needed('github')}.`);
    seen.length = 0;
    const scanMine = await call('POST', '/api/crawl-github', { url: 'acme/private-shop', repoAuth: MINE });
    assert.equal(scanMine.status, 200, scanMine.text);
    assert.ok(seen.every((s) => s.auth === `Bearer ${MINE}`));
    assert.deepEqual([(await call('POST', '/api/crawl-github', { url: 'acme/private-shop', repoAuth: 'a b' })).status], [400]);

    for (const token of [MINE, SERVER, 'ghp_WrongToken000000000']) {
      assert.ok(!logs.some((l) => l.includes(token)), `${token.slice(0, 8)}… never logged`);
      for (const r of [without, withMine, again, wrong, shape, server, scanNone, scanMine]) assert.ok(!r.text.includes(token), `${token.slice(0, 8)}… never answered`);
    }
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realWrite;
    delete process.env.GITHUB_TOKEN;
  }
});

// What read the repository rides on the scan (packA.scan.access), so the service list can stop offering the
// person's token field for a repository that was read without their access (studio/overview-model.mjs authOffer).
test('a Run keeps how it read a GitHub repository with its scan — with nothing (a public one), with the person\'s token, with the server\'s own on a server without sign-in — and never the value; a Check now keeps it and the journeys listing gives it; a folder has none; a record that holds anything else gives none', async () => {
  const { repositoryAccess, recordedAccess, REPOSITORY_ACCESS } = REPO_AUTH;
  const repo = { kind: 'github', location: 'https://github.com/acme/public-shop' };
  assert.deepEqual(REPOSITORY_ACCESS, ['token', 'sign-in', 'server', 'none']);
  assert.deepEqual(repositoryAccess(repo, { token: null, source: 'none' }), { by: 'none', ...repo });
  assert.deepEqual(repositoryAccess(repo, { token: 'made-up-value', source: 'request' }), { by: 'token', ...repo });
  assert.deepEqual(repositoryAccess(repo, { token: 'made-up-value', source: 'link', account: 'ada-gh' }), { by: 'sign-in', ...repo }, 'never the account');
  assert.deepEqual(repositoryAccess({ kind: 'ado', location: 'https://dev.azure.com/a/b/_git/c', ref: 'main' }, { token: 'made-up-value', source: 'server' }), { by: 'server', kind: 'ado', location: 'https://dev.azure.com/a/b/_git/c' });
  for (const none of [{ kind: 'path', location: '/srv/x' }, { kind: 'upload', location: 'x.zip' }, { kind: 'github' }, { kind: 'github', location: '' }, null]) assert.equal(repositoryAccess(none, { source: 'none' }), null);
  assert.deepEqual(recordedAccess({ by: 'none', ...repo, token: 'made-up-value', extra: 1 }), { by: 'none', ...repo }, 'the three fields, nothing else a record may hold');
  for (const junk of [null, undefined, 'none', {}, { by: 'admin', ...repo }, { by: 'none', kind: 'path', location: '/x' }, { by: 'none', kind: 'github', location: '' }, { by: 'none', kind: 'github', location: 'x'.repeat(2049) }, { by: 'none', kind: 'github', location: 7 }]) assert.equal(recordedAccess(junk), null);

  const created = await call('POST', '/api/services', { name: 'Public Shop', repository: { kind: 'github', location: 'acme/public-shop' } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.service.id;
  const location = created.json.service.repository.location;
  assert.equal((await call('POST', `/api/services/${id}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);
  const MINE = 'ghp_PersonalToken0123456789';
  const SERVER = 'ghp_ServerToken0123456789';
  const RULES = readFileSync(join(REPO, 'prometheus', 'rules.yml'), 'utf8');
  const realFetch = globalThis.fetch;
  const seen = [];
  // GitHub, stubbed: a public repository, which answers whoever asks.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/') && !u.startsWith('https://raw.githubusercontent.com/')) return realFetch(url, init);
    seen.push(init.headers?.Authorization ?? null);
    if (u.endsWith('/repos/acme/public-shop')) return new Response(JSON.stringify({ default_branch: 'main' }));
    if (u.includes('/repos/acme/public-shop/git/trees/main')) return new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'alerts/api.rules.yml', size: RULES.length }] }));
    if (u.includes('/repos/acme/public-shop/contents/') || u.startsWith('https://raw.githubusercontent.com/acme/public-shop/')) return new Response(RULES);
    return new Response('', { status: 404 });
  };
  delete process.env.GITHUB_TOKEN;
  try {
    const run = (body) => call('POST', `/api/services/${id}/run`, body);
    const listed = async (name) => (await call('GET', '/api/journeys')).json.journeys.find((j) => j.name === name).lastRun.repositoryAccess;

    const none = await run({});
    assert.equal(none.status, 200, none.text);
    assert.ok(seen.length > 0 && seen.every((auth) => auth === null), 'read with nothing');
    assert.deepEqual(none.json.scan.access, { by: 'none', kind: 'github', location });
    assert.deepEqual(none.json.record.packA.scan.access, none.json.scan.access, 'the record keeps it with the scan');
    assert.deepEqual(await listed(none.json.journey), { by: 'none', kind: 'github', location });

    const mine = await run({ repoAuth: MINE });
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(mine.json.scan.access, { by: 'token', kind: 'github', location });
    assert.ok(!mine.text.includes(MINE), 'the kind of access, never its value');
    const check = await call('POST', `/api/journeys/${mine.json.journey}/run`, {});
    assert.equal(check.status, 200, check.text);
    assert.deepEqual(check.json.record.packA.scan.access, { by: 'token', kind: 'github', location }, 'a Check now is on the same scan: it keeps what read it');
    assert.deepEqual(await listed(mine.json.journey), { by: 'token', kind: 'github', location });

    // A server without sign-in (this suite's posture) reads with its own.
    process.env.GITHUB_TOKEN = SERVER;
    seen.length = 0;
    const server = await run({});
    assert.equal(server.status, 200, server.text);
    assert.ok(seen.every((auth) => auth === `Bearer ${SERVER}`));
    assert.deepEqual(server.json.scan.access, { by: 'server', kind: 'github', location });
    assert.deepEqual(await listed(server.json.journey), { by: 'server', kind: 'github', location });
    assert.ok(!server.text.includes(SERVER));

    // A folder is read by the server itself: nothing to say.
    const folder = await call('POST', `/api/services/${ids.shop}/run`, {});
    assert.equal(folder.status, 200, folder.text);
    assert.equal(folder.json.scan.access, undefined);
    assert.equal(Object.hasOwn(folder.json.record.packA.scan, 'access'), false);
    assert.equal(await listed(folder.json.journey), null);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.GITHUB_TOKEN;
  }
});

test('a Run of a private Azure DevOps repository on a server without sign-in: the refusal asks for the person\'s token (never "fetch failed") and names the server\'s own; the person\'s token reads it; a wrong one, the server\'s refused one and an unreachable host each say so, exactly', async () => {
  const created = await call('POST', '/api/services', { name: 'Private Ado', repository: { kind: 'ado', location: 'https://dev.azure.com/acme/Private/_git/shop' } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.service.id;
  assert.equal((await call('POST', `/api/services/${id}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);

  const MINE = 'ado-pat-PersonalToken0123456789';
  const SERVER = 'ado-pat-ServerToken0123456789';
  const RULES = readFileSync(join(REPO, 'prometheus', 'rules.yml'), 'utf8');
  const realFetch = globalThis.fetch;
  const seen = [];
  let down = false;
  // Azure DevOps, stubbed as it answers: the repository serves only MINE; anything else is its refusal.
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://dev.azure.com/')) return realFetch(url, init);
    seen.push({ url: u, auth: init.headers?.Authorization ?? null, redirect: init.redirect, suppress: init.headers?.['X-TFS-FedAuthRedirect'] ?? null });
    if (down) throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND dev.azure.com'), { code: 'ENOTFOUND' }) });
    if (init.headers?.Authorization !== `Basic ${Buffer.from(`:${MINE}`).toString('base64')}`) return adoRefusal(init);
    if (u.includes('recursionLevel=Full')) return new Response(JSON.stringify({ value: [{ gitObjectType: 'blob', path: '/alerts/api.rules.yml' }] }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ content: RULES }), { headers: { 'content-type': 'application/json' } });
  };
  delete process.env.AZURE_DEVOPS_TOKEN;
  const answers = [];
  const run = async (body) => { const r = await call('POST', `/api/services/${id}/run`, body); answers.push(r); return r; };
  try {
    const without = await run({});
    assert.equal(without.status, 403, without.text);
    assert.deepEqual(without.json.repoAuth, { kind: 'ado', label: 'Azure DevOps token', refused: false });
    assert.equal(without.json.error, `the repository could not be read: Azure DevOps 401: this repository is not public — ${REPO_AUTH_WAYS.needed('ado', { serverToken: true })}`);
    assert.ok(without.json.error.endsWith('or AZURE_DEVOPS_TOKEN set on this server for every Run'), 'a server without sign-in: the operator\'s way is named too');
    assert.ok(seen.every((s) => s.redirect === 'manual' && s.suppress === 'Suppress' && s.url.startsWith('https://dev.azure.com/acme/')), 'asked for a 401, never following a redirect');

    seen.length = 0;
    const withMine = await run({ repoAuth: MINE });
    assert.equal(withMine.status, 200, withMine.text);
    assert.deepEqual([withMine.json.scan.source, withMine.json.scan.files], ['Private/shop on Azure DevOps', 1]);
    assert.ok(seen.length >= 2 && seen.every((s) => s.auth === `Basic ${Buffer.from(`:${MINE}`).toString('base64')}`), 'the person\'s token, as Basic, on the tree and the file');

    const wrong = await run({ repoAuth: 'ado-pat-WrongToken000000000' });
    assert.deepEqual([wrong.status, wrong.json.repoAuth], [403, { kind: 'ado', label: 'Azure DevOps token', refused: true }]);
    assert.equal(wrong.json.error, `the repository could not be read: Azure DevOps 401: not authorised to read this repository — ${REPO_AUTH_WAYS.refused('ado')}`);

    const shape = await run({ repoAuth: 'ado-pat-with-a-bell\u0007' });
    assert.deepEqual([shape.status, shape.json.error], [400, REPO_AUTH_WAYS.shape], 'a control character is refused before anything is sent');

    // The server's own token, refused: the operator's to fix — the person is not asked.
    process.env.AZURE_DEVOPS_TOKEN = SERVER;
    const server = await run({});
    assert.deepEqual([server.status, server.json.repoAuth, server.json.error], [403, undefined, 'the repository could not be read: Azure DevOps 401: the token in AZURE_DEVOPS_TOKEN was refused']);
    delete process.env.AZURE_DEVOPS_TOKEN;

    down = true;
    const unreachableRun = await run({ repoAuth: MINE });
    assert.deepEqual([unreachableRun.status, unreachableRun.json.repoAuth, unreachableRun.json.error],
      [502, undefined, 'the repository could not be read: Azure DevOps: https://dev.azure.com could not be reached from the server — its name does not resolve on the server (ENOTFOUND); if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1']);
    for (const r of answers) for (const token of [MINE, SERVER]) assert.ok(!r.text.includes(token), 'no token is ever answered');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.AZURE_DEVOPS_TOKEN;
  }
});

// ---------- the org's repository sources ----------
//
// Settings → Repository sources (server/store/orgs.mjs, the rule in
// server/service-admin.mjs): one switch per source the service form offers,
// per org, every source on until an org admin switches it off. Off, a save
// naming it, an upload and the Run of a service declared there are refused
// (409, the sentence naming the switch) and write nothing; the records keep
// their repository; switched back on, they work again. These cases run last
// and leave every source on.

const { REPOSITORY_SOURCES, repositorySourcesOf, setRepositorySources, createOrg, removeOrg } = await import('./store/orgs.mjs');
const { getMeta, putMeta } = await import('./store/meta.mjs');
const { atomic } = await import('./store/db.mjs');
const { REPOSITORY_SOURCE_LABEL } = await import('./service-admin.mjs');

const ALL_ON = Object.freeze({ github: true, ado: true, path: true, upload: true });
const SOURCES_KEY = 'repository_sources:default';
const OFF = (label) => WAYS.repositorySourceOff(label);
const switchSources = (body) => call('PUT', '/api/repository-sources', body);
const allOn = () => switchSources({ ...ALL_ON });
// The org.repository_sources rows, oldest first: [actor, org, target kind, target, detail].
const sourceRows = () => listAudit(currentStore(), { action: 'org.repository_sources' }).reverse()
  .map((r) => [r.actor, r.orgId, r.targetKind, r.targetId, r.detail]);

test('repository sources: every source on until one is switched off — GET /api/repository-sources, and the store\'s one key per org (absent, [] and a kind this build does not know read as on; that kind is kept when a switch is written); the store refuses a bad switch and an org that is not live', async () => {
  // The studio says a source switched off in the server's words (studio/overview-model.mjs sourceOffText), and labels it alike.
  const { sourceOffText, REPOSITORY_KINDS: FORM_KINDS } = await import('../studio/overview-model.mjs');
  for (const kind of REPOSITORY_SOURCES) assert.equal(sourceOffText(kind), WAYS.repositorySourceOff(REPOSITORY_SOURCE_LABEL[kind]), `the studio's sentence for ${kind} is the server's`);
  // Pack file is no switch of its own: the Upload switch governs it (repositorySourceRefusal).
  assert.deepEqual(Object.fromEntries(FORM_KINDS.filter((k) => k.kind !== 'pack').map((k) => [k.kind, k.label])), { ...REPOSITORY_SOURCE_LABEL }, 'the form\'s labels are the server\'s');
  const r = await call('GET', '/api/repository-sources');
  assert.deepEqual([r.status, r.json], [200, { ok: true, sources: ALL_ON }]);
  assert.deepEqual(REPOSITORY_SOURCES, ['github', 'ado', 'path', 'upload']);
  assert.deepEqual(REPOSITORY_SOURCE_LABEL, { github: 'GitHub', ado: 'Azure DevOps', path: 'Folder', upload: 'Upload' });
  assert.equal(OFF('Azure DevOps'), 'Azure DevOps is switched off in Settings → Repository sources — an org admin can switch it back on');
  const db = currentStore();
  const rows = sourceRows().length;
  try {
    assert.equal(getMeta(db, SOURCES_KEY), null, 'nothing stored: every source on');
    atomic(db, () => putMeta(db, SOURCES_KEY, '[]'));
    assert.deepEqual(repositorySourcesOf(db, 'default'), ALL_ON, '[] is every source on');
    atomic(db, () => putMeta(db, SOURCES_KEY, JSON.stringify(['gitlab', 'upload'])));
    assert.deepEqual(repositorySourcesOf(db, 'default'), { ...ALL_ON, upload: false }, 'a kind this build does not know is ignored');
    assert.deepEqual(repositorySourcesOf(db, 'another-org'), ALL_ON, 'the key is the org\'s own');
    const moved = setRepositorySources(db, 'local', 'default', { upload: true });
    assert.deepEqual([moved.sources, moved.from, moved.changed], [ALL_ON, { ...ALL_ON, upload: false }, ['upload']]);
    assert.equal(getMeta(db, SOURCES_KEY), '["gitlab"]', 'the kind this build does not know is kept');
    assert.deepEqual(sourceRows().slice(rows), [['local', 'default', 'org', 'default', { from: ['upload', 'gitlab'], to: ['gitlab'] }]]);

    for (const patch of [null, [], { gitlab: false }, { github: 'off' }, { upload: 1 }]) {
      assert.throws(() => setRepositorySources(db, 'local', 'default', patch), (e) => e instanceof TypeError && /^observogram store: /.test(e.message), JSON.stringify(patch));
    }
    assert.throws(() => setRepositorySources(db, 'local', 'no-such-org', { github: false }), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_NOT_FOUND', 'an org that does not exist');
    createOrg(db, 'system', { id: 'gone-org', name: 'Gone' });
    removeOrg(db, 'system', 'gone-org');
    assert.throws(() => setRepositorySources(db, 'local', 'gone-org', { github: false }), (e) => e.code === 'ERR_OBSERVOGRAM_STORE_NOT_FOUND', 'a removed org');
    assert.equal(getMeta(db, 'repository_sources:gone-org'), null);
    assert.equal(sourceRows().length, rows + 1, 'the refusals wrote nothing');
  } finally {
    atomic(db, () => putMeta(db, SOURCES_KEY, null));
  }
  assert.deepEqual((await call('GET', '/api/repository-sources')).json.sources, ALL_ON);
});

test('PUT /api/repository-sources: a switch writes one org.repository_sources row — the org\'s id, the sources switched off before and after — read in the org\'s own audit; the same switch again writes none; every source on again leaves no key; an empty body, an unknown source or a value that is not true or false is a 400 that writes nothing', async () => {
  const rows = sourceRows().length;
  try {
    for (const [body, error] of [
      [undefined, WAYS.repositorySourcesBody],
      [{}, WAYS.repositorySourcesBody],
      [['github'], WAYS.repositorySourcesBody],
      [{ gitlab: false }, WAYS.repositorySourceKey('gitlab')],
      [{ github: false, svn: true }, WAYS.repositorySourceKey('svn')],
      [{ github: 'off' }, WAYS.repositorySourceValue('github', 'off')],
      [{ upload: 0 }, WAYS.repositorySourceValue('upload', 0)],
      [{ path: null }, WAYS.repositorySourceValue('path', null)],
    ]) {
      const r = await switchSources(body);
      assert.deepEqual([r.status, r.json], [400, { ok: false, error }], JSON.stringify(body));
    }
    assert.equal(WAYS.repositorySourceValue('github', 'off'), 'github is true (on) or false (off), not "off"');
    assert.equal(sourceRows().length, rows, 'a refusal writes no row');
    assert.deepEqual([(await call('GET', '/api/repository-sources')).json.sources, getMeta(currentStore(), SOURCES_KEY)], [ALL_ON, null], 'and switches nothing');

    const off = await switchSources({ github: false, ado: false });
    assert.deepEqual([off.status, off.json], [200, { ok: true, sources: { ...ALL_ON, github: false, ado: false }, from: ALL_ON }]);
    assert.deepEqual(sourceRows().slice(rows), [['local', 'default', 'org', 'default', { from: [], to: ['github', 'ado'] }]]);
    assert.equal(getMeta(currentStore(), SOURCES_KEY), '["github","ado"]', 'one key for the org: the sources switched off');
    const again = await switchSources({ github: false });
    assert.deepEqual([again.status, again.json.sources, again.json.from], [200, { ...ALL_ON, github: false, ado: false }, { ...ALL_ON, github: false, ado: false }]);
    assert.equal(sourceRows().length, rows + 1, 'nothing moved: no row');
    const some = await switchSources({ ado: true, upload: true });
    assert.deepEqual(some.json.sources, { ...ALL_ON, github: false }, 'Upload was on already: Azure DevOps alone moved');
    assert.deepEqual(sourceRows().at(-1), ['local', 'default', 'org', 'default', { from: ['github', 'ado'], to: ['github'] }]);
    const back = await switchSources({ github: true });
    assert.deepEqual([back.json.sources, back.json.from], [ALL_ON, { ...ALL_ON, github: false }]);
    assert.equal(getMeta(currentStore(), SOURCES_KEY), null, 'every source on again: no key left');
    assert.equal(sourceRows().length, rows + 3);
    // The rows carry the org's id, so the org's own audit (what an org admin reads) lists them.
    const audit = await call('GET', '/api/audit?scope=org&action=org.repository_sources');
    assert.equal(audit.status, 200, audit.text);
    assert.equal(audit.json.rows.length, sourceRows().length);
    assert.ok(audit.json.rows.every((x) => x.orgId === 'default' && x.targetKind === 'org'), 'every row in the org\'s audit');
  } finally {
    await allOn();
  }
});

test('a source switched off refuses a save naming it (409, the sentence, nothing written) — a create, an update to another source or another address of it — before its address is read; an update that keeps the repository or changes something else saves; the records keep their repository; switched back on, the same saves work', async () => {
  const creates = auditRows('service.create').length;
  const updates = auditRows('service.update').length;
  const made = [];
  try {
    assert.equal((await switchSources({ github: false, path: false })).status, 200);
    const create = await call('POST', '/api/services', { name: 'Switched Off', repository: { kind: 'github', location: 'acme/switched' } });
    assert.deepEqual([create.status, create.json], [409, { ok: false, error: OFF('GitHub') }]);
    const badFolder = await call('POST', '/api/services', { name: 'Switched Off', repository: { kind: 'path', location: 'relative/dir' } });
    assert.deepEqual([badFolder.status, badFolder.json.error], [409, OFF('Folder')], 'switched off is the answer, before the address is read');
    assert.ok(!(await call('GET', '/api/services')).json.services.some((x) => x.name === 'Switched Off'), 'no service was made');
    // A source still on saves.
    const ado = await call('POST', '/api/services', { name: 'Ado Still On', repository: { kind: 'ado', location: 'https://dev.azure.com/acme/Shop/_git/on' } });
    assert.equal(ado.status, 201, ado.text);
    made.push(ado.json.service.id);
    assert.equal(auditRows('service.create').length, creates + 1, 'only the save of a source still on wrote its row');

    for (const [id, repository, label] of [
      [ado.json.service.id, { kind: 'github', location: 'acme/x' }, 'GitHub'],
      [ado.json.service.id, { kind: 'path', location: 'relative/dir' }, 'Folder'],
      [ids.shop, { kind: 'path', location: EMPTY_REPO }, 'Folder'],
      [ids.shop, { kind: 'path', location: 'relative/dir' }, 'Folder'],
      [ids.privateShop, { kind: 'github', location: 'not a repository' }, 'GitHub'],
      [ids.privateShop, { kind: 'github', location: 'acme/another-shop' }, 'GitHub'],
    ]) {
      const r = await call('PATCH', `/api/services/${id}`, { repository, tier: 'tier-3' });
      assert.deepEqual([r.status, r.json], [409, { ok: false, error: OFF(label) }], JSON.stringify(repository));
    }
    const keep = await call('PATCH', `/api/services/${ids.shop}`, { repository: { kind: 'path', location: REPO } });
    assert.deepEqual([keep.status, keep.json.changed], [200, []], 'the record\'s own repository, sent again, saves');
    const other = await call('PATCH', `/api/services/${ids.privateShop}`, { repository: { kind: 'github', location: 'acme/private-shop' }, description: 'kept while GitHub is off' });
    assert.deepEqual([other.status, other.json.changed], [200, ['description']], 'another field of a service declared on GitHub saves');
    assert.equal(auditRows('service.update').length, updates + 1, 'the refused updates wrote nothing');
    assert.deepEqual((await call('GET', `/api/services/${ids.shop}`)).json.service.repository, { kind: 'path', location: resolve(REPO), ref: null }, 'the records keep their repository');
    assert.deepEqual((await call('GET', `/api/services/${ids.privateShop}`)).json.service.repository, { kind: 'github', location: 'https://github.com/acme/private-shop', ref: null });

    assert.equal((await switchSources({ github: true, path: true })).status, 200);
    const created = await call('POST', '/api/services', { name: 'Switched Off', repository: { kind: 'github', location: 'acme/switched' } });
    assert.equal(created.status, 201, created.text);
    made.push(created.json.service.id);
    const moved = await call('PATCH', `/api/services/${ado.json.service.id}`, { repository: { kind: 'github', location: 'acme/x' } });
    assert.deepEqual([moved.status, moved.json.changed], [200, ['repository']], 'switched back on, the same save works');
  } finally {
    await allOn();
    for (const id of made) await call('DELETE', `/api/services/${id}`);
  }
});

test('a source switched off refuses its Run (409) after the record\'s own refusals and before the folder rule, any repository read, any MCP call or any row; switched back on, the Run reads and runs again', async () => {
  const calls = fake.calls.length;
  const runs = auditRows('journey.run').length;
  const captures = auditRows('journey.capture').length;
  const packs = (await call('GET', '/api/packs')).json.packs.length;
  const realFetch = globalThis.fetch;
  const hosts = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://')) { hosts.push(u); return new Response('', { status: 404 }); }
    return realFetch(url, init);
  };
  const made = [];
  try {
    assert.equal((await switchSources({ github: false, path: false })).status, 200);
    const bare = await call('POST', '/api/services', { name: 'No Repository Yet' });
    made.push(bare.json.service.id);
    assert.equal((await call('POST', `/api/services/${bare.json.service.id}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);
    const none = await call('POST', `/api/services/${bare.json.service.id}/run`, {});
    assert.deepEqual([none.status, none.json.error], [409, 'No Repository Yet names no repository yet — say where its declaration lives: GitHub, Azure DevOps or a folder on the server'], 'the record\'s own refusal first');

    process.env.OBSERVOGRAM_REPO_ROOTS = join(WORKSPACE, 'repos');   // the folder rule would refuse REPO (403)
    try {
      const folder = await call('POST', `/api/services/${ids.shop}/run`, {});
      assert.deepEqual([folder.status, folder.json], [409, { ok: false, error: OFF('Folder') }], 'switched off is said before the folder rule');
    } finally {
      delete process.env.OBSERVOGRAM_REPO_ROOTS;
    }
    const github = await call('POST', `/api/services/${ids.privateShop}/run`, { repoAuth: 'ghp_PersonalToken0123456789' });
    assert.deepEqual([github.status, github.json], [409, { ok: false, error: OFF('GitHub') }], 'never a repoAuth: there is nothing to sign in to');
    assert.deepEqual(hosts, [], 'no request left for the repository\'s host');
    assert.equal(fake.calls.length, calls, 'no MCP call');
    assert.deepEqual([auditRows('journey.run').length, auditRows('journey.capture').length], [runs, captures], 'no row');
    assert.equal((await call('GET', '/api/packs')).json.packs.length, packs, 'no scan registered');

    assert.equal((await switchSources({ github: true, path: true })).status, 200);
    const again = await call('POST', `/api/services/${ids.shop}/run`, {});
    assert.equal(again.status, 200, again.text);
    assert.ok(fake.calls.length > calls, 'the live side was read');
    assert.equal(auditRows('journey.run').length, runs + 1);
  } finally {
    globalThis.fetch = realFetch;
    await allOn();
    for (const id of made) await call('DELETE', `/api/services/${id}`);
  }
});

test('Upload switched off: an upload is refused (409) before its body is read or a copy kept, and the Run of an uploaded repository is refused; Folder switched off: Browse… says so in place of the folders, a named folder is 409; switched back on, each works again', async () => {
  const created = await call('POST', '/api/services', { name: 'Uploaded Switch' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.service.id;
  try {
    assert.equal((await call('POST', `/api/services/${id}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);
    const first = await call('PUT', `/api/services/${id}/repository-upload`, { name: 'operational-alerts', files: UPLOADED });
    assert.equal(first.status, 200, first.text);
    const copy = readFileSync(copyOf(id), 'utf8');
    const updates = auditRows('service.update').length;
    const calls = fake.calls.length;
    const runs = auditRows('journey.run').length;

    assert.equal((await switchSources({ upload: false })).status, 200);
    for (const body of [{ name: 'replacement', files: UPLOADED }, undefined, { name: 'empty', files: {} }]) {
      const r = await call('PUT', `/api/services/${id}/repository-upload`, body);
      assert.deepEqual([r.status, r.json], [409, { ok: false, error: OFF('Upload') }], JSON.stringify(body)?.slice(0, 40) ?? 'no body');
    }
    assert.equal((await call('PUT', '/api/services/999999/repository-upload', { name: 'x', files: UPLOADED })).status, 404, 'an unknown service is still 404 first');
    assert.equal(readFileSync(copyOf(id), 'utf8'), copy, 'the kept copy is untouched');
    assert.equal((await call('GET', `/api/services/${id}`)).json.service.repository.location, 'operational-alerts', 'the record keeps its repository');
    assert.equal(auditRows('service.update').length, updates, 'no row');
    const run = await call('POST', `/api/services/${id}/run`, {});
    assert.deepEqual([run.status, run.json], [409, { ok: false, error: OFF('Upload') }]);
    assert.deepEqual([fake.calls.length, auditRows('journey.run').length], [calls, runs], 'no MCP call, no row');

    assert.equal((await switchSources({ path: false })).status, 200);
    const top = await call('GET', '/api/repository-folders');
    assert.deepEqual([top.status, top.json.allowed, top.json.why, top.json.path, top.json.folders], [200, false, OFF('Folder'), null, []]);
    const named = await call('GET', `/api/repository-folders?path=${encodeURIComponent(REPO)}`);
    assert.deepEqual([named.status, named.json], [409, { ok: false, error: OFF('Folder') }]);

    assert.equal((await switchSources({ upload: true, path: true })).status, 200);
    const again = await call('PUT', `/api/services/${id}/repository-upload`, { name: 'replacement', files: UPLOADED });
    assert.deepEqual([again.status, again.json.service.repository.location], [200, 'replacement'], 'switched back on, the upload is kept');
    assert.equal((await call('POST', `/api/services/${id}/run`, {})).status, 200, 'and its Run runs');
    const listed = await call('GET', `/api/repository-folders?path=${encodeURIComponent(REPO)}`);
    assert.deepEqual([listed.status, listed.json.allowed, listed.json.path], [200, true, resolve(REPO)], 'and Browse… lists folders again');
  } finally {
    await allOn();
    await call('DELETE', `/api/services/${id}`);
  }
});

test('a service\'s set-asides: its Check now grades and counts without them — grade.setAside names the set, drift.setAside counts it, lastRun.setAside lists it; they are written into the check its Run saved, so the command line grades the same; [] takes them out of the record and the check; a deletion takes them out of the check that was the service\'s', async () => {
  const { loadJourneyDef, runJourney } = await import('../tools/lib/journey.mjs');
  const { applySetAsides, setAsideCandidates, setAsideFingerprint } = await import('../studio/set-asides.mjs');
  const created = await call('POST', '/api/services', { name: 'Aside Shop', repository: { kind: 'path', location: REPO } });
  assert.equal(created.status, 201, created.text);
  const P = `/api/services/${created.json.service.id}`;
  assert.equal((await call('POST', `${P}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint })).status, 201);
  const NAME = 'aside-shop.prod';
  const defOf = () => { const { __source: _source, ...def } = runWithOrg('default', () => loadJourneyDef(NAME)); return def; };
  const serverRun = async () => { const r = await call('POST', `/api/journeys/${NAME}/run`, {}); assert.equal(r.status, 200, r.text); return r.json; };
  try {
    const run = await call('POST', `${P}/run`, { env: 'prod' });
    assert.equal(run.status, 200, run.text);
    assert.ok(!('setAside' in defOf()), 'nothing set aside: the saved check carries no setAside key');
    assert.ok(!('setAside' in run.json.record.grade), 'and the record no grade.setAside');
    const scan = run.json.pack.id;
    const live = run.json.livePack.id;
    // The comparison the engine makes of the two, and what a person could set aside in it.
    const canonical = (id) => parseYaml(readFileSync(packFileOf(id), 'utf8'));
    const layeredA = adapt(canonical(scan), { environment: 'prod' });
    const layeredB = adapt(canonical(live), {});
    const diff = { ...diffPacks(layeredA, layeredB, { scopeMode: undefined, service: 'aside-shop' }), traceabilityGraph: comparePackBranches(layeredA, layeredB) };
    const { declared } = setAsideCandidates(diff);
    assert.ok(declared.length >= 2, `the scan declares things the live side does not show: ${declared.length}`);
    const list = declared.slice(0, 2).map((c) => ({ key: c.key, side: 'declared', layer: c.layer, label: c.label, kind: 'in-development', until: '2099-01-01' }));
    const patched = await call('PATCH', P, { setAside: list });
    assert.deepEqual([patched.status, patched.json.changed], [200, ['setAside']], patched.text);
    assert.deepEqual(defOf().setAside, list.map(({ key, side, kind, until, label }) => ({ key, side, kind, until, ...(label !== key ? { label } : {}) })),
      'the PATCH wrote them into the check the Run saved — keys, sides, kinds, review dates, labels; never who or when');

    const check = await serverRun();
    const now = check.record.startedAt;
    const adjusted = applySetAsides(diff, list, { now });
    const expected = computeDiagnosticGrade(layeredA, layeredB, computePostureMatrix(layeredA, layeredB), null, adjusted, {});
    assert.equal(check.record.grade.score, scoreOf(expected), 'Check now: the engine\'s score over the comparison without them');
    assert.deepEqual(check.record.grade.setAside, { fingerprint: setAsideFingerprint(list, now), declared: adjusted.setAsides.declared, live: 0, chains: adjusted.setAsides.chains, due: 0 });
    assert.deepEqual([check.record.drift.declaredNotLive, check.record.drift.setAside], [adjusted.summary.onlyInA, { declaredNotLive: adjusted.setAsides.declared, liveNotDeclared: 0 }]);
    assert.deepEqual((await listedRun(NAME)).setAside, { fingerprint: setAsideFingerprint(list, now), declared: adjusted.setAsides.declared, live: 0 }, 'the listing says what the last run set aside');
    // The command line on the saved check has only the file: it grades the same.
    const cli = await runWithOrg('default', () => runJourney(loadJourneyDef(NAME)));
    assert.deepEqual([cli.grade.score, cli.grade.setAside.fingerprint, cli.drift.declaredNotLive], [check.record.grade.score, check.record.grade.setAside.fingerprint, check.record.drift.declaredNotLive]);

    // [] takes them out of the record and of the check; the next run counts everything again.
    assert.deepEqual((await call('PATCH', P, { setAside: [] })).json.changed, ['setAside']);
    assert.ok(!('setAside' in defOf()), 'the check loses the key');
    const again = await serverRun();
    assert.ok(!('setAside' in again.record.grade), `nothing set aside on the record: ${JSON.stringify(again.record.grade)}`);
    assert.equal(again.record.drift.declaredNotLive, diff.summary.onlyInA);
    assert.equal((await listedRun(NAME)).setAside, null);

    // Set aside again, then the service deleted: the check stays, without them.
    assert.equal((await call('PATCH', P, { setAside: list })).status, 200);
    assert.ok(Array.isArray(defOf().setAside));
    assert.equal((await call('DELETE', P)).status, 200);
    assert.ok(!('setAside' in defOf()), 'the deletion takes the set-asides out of the check that was the service\'s');
  } finally {
    await call('DELETE', P);
    forgetChecks([NAME]);
  }
});

// A branch per environment (envRefs): the service keeps the branch each environment's Run reads where it is not
// the repository's own; the environment's view names it; a rename takes it along, a deletion takes it away; the
// Run of each environment reads its own branch.
test('a branch per environment: POST and PATCH envRefs (the whole map; an empty branch is none), the environment view\'s ref, a refusal writes nothing, a rename and a deletion move it; each environment\'s Run reads its own branch, else the repository\'s', async () => {
  const made = await call('POST', '/api/services', { name: 'Branchy Shop', repository: { kind: 'github', location: 'acme/branchy-shop', ref: 'main' }, envRefs: { stg: ' develop ', dev: '' } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.service.id;
  assert.deepEqual(made.json.service.envRefs, { stg: 'develop' }, 'trimmed; an empty branch is none');
  assert.deepEqual(auditRows('service.create').find((d) => d?.envRefs)?.envRefs, { stg: 'develop' }, 'the create row names them');
  for (const name of ['stg', 'prod', 'qa']) assert.equal((await call('POST', `/api/services/${id}/environments`, { name, mcpEndpointId: ids.endpoint })).status, 201);
  const view = async () => (await call('GET', `/api/services/${id}`)).json.service;
  assert.deepEqual((await view()).environments.map((e) => [e.name, e.ref]).sort(), [['prod', null], ['qa', null], ['stg', 'develop']]);

  const before = auditRows('service.update').length;
  for (const [body, why] of [[{ envRefs: { stg: 'has space' } }, /the branch for "stg" is 1–200 characters with no spaces/], [{ envRefs: ['stg'] }, /envRefs is the branch each environment's Run reads/], [{ envRefs: { stg: 7 } }, /the branch for "stg"/]]) {
    const r = await call('PATCH', `/api/services/${id}`, body);
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error, why);
  }
  assert.equal(auditRows('service.update').length, before, 'a refusal writes no row');

  const patched = await call('PATCH', `/api/services/${id}`, { envRefs: { stg: 'develop', qa: 'release/2' } });
  assert.deepEqual([patched.status, patched.json.changed, patched.json.service.envRefs], [200, ['envRefs'], { stg: 'develop', qa: 'release/2' }]);
  assert.deepEqual(auditRows('service.update').find((d) => d?.envRefs)?.envRefs, { stg: 'develop', qa: 'release/2' }, 'the row names the branches');
  assert.deepEqual((await call('PATCH', `/api/services/${id}`, { envRefs: { qa: 'release/2', stg: 'develop' } })).json.changed, [], 'the same map: nothing changes');

  // A rename takes the branch along; a deletion takes it away.
  const qa = (await view()).environments.find((e) => e.name === 'qa');
  assert.equal((await call('PATCH', `/api/environments/${qa.id}`, { name: 'uat' })).status, 200);
  assert.deepEqual((await view()).envRefs, { stg: 'develop', uat: 'release/2' });
  assert.equal((await call('DELETE', `/api/environments/${qa.id}`)).status, 200);
  assert.deepEqual((await view()).envRefs, { stg: 'develop' });
  // An environment named after an inherited property reads no branch of its own.
  assert.equal((await call('POST', `/api/services/${id}/environments`, { name: 'constructor', mcpEndpointId: ids.endpoint })).status, 201);
  assert.equal((await view()).environments.find((e) => e.name === 'constructor').ref, null);

  // Each environment's Run reads its own branch, else the repository's.
  const RULES = readFileSync(join(REPO, 'prometheus', 'rules.yml'), 'utf8');
  const realFetch = globalThis.fetch;
  const trees = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.github.com/') && !u.startsWith('https://raw.githubusercontent.com/')) return realFetch(url, init);
    if (u.endsWith('/repos/acme/branchy-shop')) return new Response(JSON.stringify({ default_branch: 'main' }));
    const tree = /\/repos\/acme\/branchy-shop\/git\/trees\/([^?]+)/.exec(u);
    if (tree) { trees.push(decodeURIComponent(tree[1])); return new Response(JSON.stringify({ tree: [{ type: 'blob', path: 'alerts/api.rules.yml', size: RULES.length }] })); }
    if (u.includes('/branchy-shop/')) return new Response(RULES);
    return new Response('', { status: 404 });
  };
  delete process.env.GITHUB_TOKEN;
  try {
    for (const env of ['stg', 'prod']) {
      const r = await call('POST', `/api/services/${id}/run`, { env });
      assert.ok([200, 502].includes(r.status), r.text);
    }
    assert.deepEqual(trees, ['develop', 'main'], 'stg read develop, prod the repository\'s main');
    // Another repository: the branches named for the old one go; a folder names none.
    const moved = await call('PATCH', `/api/services/${id}`, { repository: { kind: 'github', location: 'acme/branchy-shop-v2', ref: 'main' } });
    assert.deepEqual([moved.status, moved.json.changed.sort(), moved.json.service.envRefs], [200, ['envRefs', 'repository'], {}]);
  } finally {
    globalThis.fetch = realFetch;
    await call('DELETE', `/api/services/${id}`);
    forgetChecks(['branchy-shop.stg', 'branchy-shop.prod']);
  }
});

// A pack file in place of either side (server/service-packs.mjs): an export of the declared pack for the
// repository, an export of live for an environment's MCP endpoint — each Run then uses them as they are.
test('pack files as the two sides: PUT repository-pack (named after the service, no stray service; refusals, POST/PATCH never name one, the Upload switch) and PUT / DELETE live-pack (one or the other with the endpoint); a Run on both — no scan, no MCP call — graded on the files', async () => {
  const made = await call('POST', '/api/services', { name: 'Packed Shop', repository: { kind: 'github', location: 'acme/packed-shop' } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.service.id;
  const env = await call('POST', `/api/services/${id}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint });
  assert.equal(env.status, 201, env.text);
  const envId = env.json.environment.id;
  const DECLARED = readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');
  const LIVE = readFileSync(join(ROOT, 'examples', 'production-curated.pack.yaml'), 'utf8');
  const servicesBefore = (await call('GET', '/api/services')).json.services.length;
  try {
    // Refusals: no body, no name, not a pack, not valid; nothing registered or changed.
    for (const [body, why] of [[{}, /expected \{ name, text \}/], [{ name: '', text: DECLARED }, /name the pack file/], [{ name: 'x.yaml', text: '   ' }, /the pack file is empty/], [{ name: 'x.yaml', text: '{ not json' }, /could not be read as YAML or JSON/], [{ name: 'x.yaml', text: 'kind: Something\nmetadata:\n  name: x\n' }, /is not a valid pack/]]) {
      const r = await call('PUT', `/api/services/${id}/repository-pack`, body);
      assert.equal(r.status, 400, r.text);
      assert.match(r.json.error, why);
    }
    assert.equal((await call('GET', `/api/services/${id}`)).json.service.repository.kind, 'github', 'a refusal changes nothing');
    // POST and PATCH never name a pack file.
    const named = await call('PATCH', `/api/services/${id}`, { repository: { kind: 'pack', location: 'x.yaml' } });
    assert.deepEqual([named.status, /PUT \/api\/services\/:id\/repository-pack/.test(named.json.error)], [400, true]);

    // The declared side: registered, named after the service (no stray service), the record pointed at it.
    // It declares qa too, which this service does not have: no environment is made for it.
    assert.ok(DECLARED.includes('environments: [prod]'));
    const repo = await call('PUT', `/api/services/${id}/repository-pack`, { name: 'skeleton.pack.yaml', text: DECLARED.replace('environments: [prod]', 'environments: [prod, qa]') });
    assert.equal(repo.status, 200, repo.text);
    assert.deepEqual(repo.json.service.environments.map((e) => e.name), ['prod'], 'the environments it declares are not made');
    const r = repo.json.service.repository;
    assert.deepEqual([r.kind, r.location, r.ref, typeof r.packId, typeof r.uploadedAt, r.bytes > 0], ['pack', 'skeleton.pack.yaml', null, 'string', 'string', true]);
    const after = (await call('GET', '/api/services')).json.services;
    assert.equal(after.length, servicesBefore, 'the pack, named demo-skeleton, made no second service');
    assert.deepEqual(after.find((x) => x.id === id).packs.map((p) => [p.id, p.role]), [[r.packId, 'primary']], 'it is this service\'s own pack');

    // The live side: the export kept for prod, the endpoint unbound.
    const live = await call('PUT', `/api/environments/${envId}/live-pack`, { name: 'prod-live.pack.yaml', text: LIVE });
    assert.equal(live.status, 200, live.text);
    assert.deepEqual([live.json.environment.mcpEndpoint, live.json.environment.livePack.name], [null, 'prod-live.pack.yaml']);

    // The Run on both files: no scan (no repository read), no MCP call; the record's two sides are the files.
    const run = await call('POST', `/api/services/${id}/run`, { env: 'prod' });
    assert.equal(run.status, 200, run.text);
    assert.equal(run.json.scan, undefined, 'no scan');
    assert.ok(String(run.json.record.packB.source).endsWith(`${live.json.environment.livePack.packId}.pack.yaml`), `Pack B is the export's file: ${run.json.record.packB.source}`);
    assert.ok(String(run.json.record.packA.source).endsWith(`${r.packId}.pack.yaml`), 'Pack A is the declared pack file');
    assert.ok(Number.isFinite(run.json.record.grade.score), 'graded');

    // An endpoint chosen again: the export goes (one or the other); DELETE then has nothing to take.
    const rebound = await call('PATCH', `/api/environments/${envId}`, { mcpEndpointId: ids.endpoint });
    assert.equal(rebound.status, 200, rebound.text);
    assert.equal((await call('GET', `/api/environments/${envId}`)).json.environment.livePack, null);
    const none = await call('DELETE', `/api/environments/${envId}/live-pack`);
    assert.deepEqual([none.status, none.json.error], [409, 'prod has no export of live to take away']);
    // …and one uploaded again goes with DELETE.
    assert.equal((await call('PUT', `/api/environments/${envId}/live-pack`, { name: 'again.pack.yaml', text: LIVE })).status, 200);
    const gone = await call('DELETE', `/api/environments/${envId}/live-pack`);
    assert.deepEqual([gone.status, gone.json.environment.livePack], [200, null]);

    // One file in two environments is one pack (its id is its content): a new prod export under the
    // same file name replaces prod's label, never the pack stg still stands on.
    const stg = await call('POST', `/api/services/${id}/environments`, { name: 'stg' });
    assert.equal(stg.status, 201, stg.text);
    const stgLive = await call('PUT', `/api/environments/${stg.json.environment.id}/live-pack`, { name: 'live.yaml', text: LIVE });
    assert.equal((await call('PUT', `/api/environments/${envId}/live-pack`, { name: 'live.yaml', text: LIVE })).json.environment.livePack.packId, stgLive.json.environment.livePack.packId, 'the same pack');
    assert.equal((await call('PUT', `/api/environments/${envId}/live-pack`, { name: 'live.yaml', text: DECLARED })).status, 200);
    const stgRun = await call('POST', `/api/services/${id}/run`, { env: 'stg' });
    assert.equal(stgRun.status, 200, `stg's export is still on the server: ${stgRun.text}`);
    forgetChecks(['packed-shop.stg']);

    // The org's Upload switch: a pack file in place of the repository is an upload.
    assert.equal((await switchSources({ upload: false })).status, 200);
    const off = await call('PUT', `/api/services/${id}/repository-pack`, { name: 'skeleton.pack.yaml', text: DECLARED });
    assert.equal(off.status, 409, off.text);
    assert.equal((await switchSources({ upload: true })).status, 200);
  } finally {
    await call('DELETE', `/api/services/${id}`);
    forgetChecks(['packed-shop.prod']);
  }
});

// A service slug the spec's pack name does not take (it starts with a digit): the repository pack is
// named as a scan names it (packSlug), so it stays a valid pack and the Run checks it.
test('a pack file for a service whose slug starts with a digit: named svc-…, and the Run on it graded', async () => {
  const made = await call('POST', '/api/services', { name: '2FA Gate' });
  assert.equal(made.status, 201, made.text);
  const id = made.json.service.id;
  assert.equal(made.json.service.slug, '2fa-gate');
  try {
    const env = await call('POST', `/api/services/${id}/environments`, { name: 'prod' });
    const DECLARED = readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');
    const LIVE = readFileSync(join(ROOT, 'examples', 'production-curated.pack.yaml'), 'utf8');
    assert.equal((await call('PUT', `/api/services/${id}/repository-pack`, { name: 'gate.pack.yaml', text: DECLARED })).status, 200);
    assert.equal((await call('PUT', `/api/environments/${env.json.environment.id}/live-pack`, { name: 'live.pack.yaml', text: LIVE })).status, 200);
    const run = await call('POST', `/api/services/${id}/run`, { env: 'prod' });
    assert.equal(run.status, 200, run.text);
    assert.ok(Number.isFinite(run.json.record.grade.score), 'graded');
  } finally {
    await call('DELETE', `/api/services/${id}`);
    const stray = (await call('GET', '/api/services')).json.services.find((s) => s.slug === 'svc-2fa-gate');
    if (stray) await call('DELETE', `/api/services/${stray.id}`);
    forgetChecks(['2fa-gate.prod']);
  }
});

// A live scope per environment (server/service-admin.mjs parseLiveScopes): the Run's live read narrowed to the
// service's own metric names, folders and rule groups as a Path-B snapshot narrows them (a scoped draft), written
// into the check as packB.mcp.scope and said on the record; without one, the org's configured snapshot scope.
test('a live scope per environment: PATCH liveScopes (the whole map; a bad scope 400 before anything is sent), the environment view, a rename moves it; the Run saves it as packB.mcp.scope, reads only the scoped metric names and says so on the record; without one the configured snapshot scope, else none', async () => {
  const { loadJourneyDef } = await import('../tools/lib/journey.mjs');
  const made = await call('POST', '/api/services', { name: 'Scoped Shop' });
  assert.equal(made.status, 201, made.text);
  const id = made.json.service.id;
  const NAME = 'scoped-shop.prod';
  const defOf = (name = NAME) => runWithOrg('default', () => loadJourneyDef(name));
  const livePackOfRun = (run) => parseYaml(readFileSync(join(WORKSPACE, 'packs', `${run.json.livePack.id}.pack.yaml`), 'utf8'));
  const namesOf = (pack) => JSON.parse(pack.metadata.annotations['mcp.discovered.metric_names'] || '[]');
  try {
    const env = await call('POST', `/api/services/${id}/environments`, { name: 'prod', mcpEndpointId: ids.endpoint });
    assert.equal(env.status, 201, env.text);
    assert.equal(env.json.environment.liveScope, null);
    const DECLARED = readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');
    assert.equal((await call('PUT', `/api/services/${id}/repository-pack`, { name: 'shop.pack.yaml', text: DECLARED })).status, 200);

    // Refusals: each a 400 naming the environment and the field, nothing kept, nothing sent.
    const calls = fake.calls.length;
    for (const [body, why] of [
      [{ liveScopes: { prod: { metricPrefixes: ['9bad'] } } }, /^liveScopes\.prod: scope\.metricPrefixes\[0\] "9bad" is not a metric-name prefix/],
      [{ liveScopes: { prod: { colour: 'blue' } } }, /^liveScopes\.prod: scope\.colour is not a scope field/],
      [{ liveScopes: { prod: { metricExclude: ['nope'] } } }, /is not anchored/],
      [{ liveScopes: ['prod'] }, /^liveScopes is the scope each environment's live read applies/],
    ]) {
      const r = await call('PATCH', `/api/services/${id}`, body);
      assert.equal(r.status, 400, r.text);
      assert.match(r.json.error, why);
    }
    assert.deepEqual([(await call('GET', `/api/services/${id}`)).json.service.liveScopes, fake.calls.length], [{}, calls], 'nothing kept, nothing sent');

    // No scope anywhere: the read is unscoped, and the record says so.
    const plain = await call('POST', `/api/services/${id}/run`, { env: 'prod' });
    assert.equal(plain.status, 200, plain.text);
    assert.equal(defOf().packB.mcp.scope, undefined);
    assert.equal(plain.json.record.packB.liveScope, null, 'an unscoped read is said, not left out');
    assert.equal(namesOf(livePackOfRun(plain)).length, 43, 'every name the endpoint lists');

    // The environment's own scope: kept compact, on the view, saved into the check, applied to the read.
    const set = await call('PATCH', `/api/services/${id}`, { liveScopes: { prod: { metricPrefixes: 'alertmanager_', folderUids: [], datasourceUid: '' } } });
    assert.deepEqual([set.status, set.json.changed, set.json.service.liveScopes], [200, ['liveScopes'], { prod: { metricPrefixes: ['alertmanager_'] } }], set.text);
    assert.deepEqual(set.json.service.environments[0].liveScope, { metricPrefixes: ['alertmanager_'] });
    const scoped = await call('POST', `/api/services/${id}/run`, { env: 'prod' });
    assert.equal(scoped.status, 200, scoped.text);
    assert.deepEqual(defOf().packB.mcp.scope, { metricPrefixes: ['alertmanager_'] }, 'the check carries the scope: a Check now and the command line read the same');
    assert.deepEqual(scoped.json.record.packB.liveScope, { metricPrefixes: ['alertmanager_'] });
    const pack = livePackOfRun(scoped);
    const names = namesOf(pack);
    assert.ok(names.length === 27 && names.every((n) => n.startsWith('alertmanager_')), `only the scoped names: ${names.length}`);
    assert.deepEqual(JSON.parse(pack.metadata.annotations['observogram.scope.metric']), { by: 'prefix', values: ['alertmanager_'] }, 'the snapshot\'s annotations, so the diff parks what the read did not look at');
    assert.equal(pack.metadata.annotations['observogram.live.mode'], undefined, 'still a draft, not a snapshot');
    // A Check now runs the saved check as it is: scoped too.
    const again = await call('POST', `/api/journeys/${NAME}/run`, {});
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(again.json.record.packB.liveScope, { metricPrefixes: ['alertmanager_'] });
    // A change of scope reaches the saved check at once, as the service's switches do: the next Check now reads it.
    assert.equal((await call('PATCH', `/api/services/${id}`, { liveScopes: { prod: { metricPrefixes: ['alertmanager_cluster_'] } } })).status, 200);
    assert.deepEqual(defOf().packB.mcp.scope, { metricPrefixes: ['alertmanager_cluster_'] }, 'no Run needed');

    // Without the environment's own: the org's configured snapshot scope; one that does not parse is a 409.
    assert.equal((await call('PATCH', `/api/services/${id}`, { liveScopes: { prod: null } })).json.service.liveScopes.prod, undefined);
    assert.equal(defOf().packB.mcp.scope, undefined, 'none of its own and none configured: the check reads unscoped');
    process.env.OBSERVOGRAM_SNAPSHOT_METRIC_PREFIXES = 'ALERTS';
    try {
      const configured = await call('POST', `/api/services/${id}/run`, { env: 'prod' });
      assert.equal(configured.status, 200, configured.text);
      assert.deepEqual(configured.json.record.packB.liveScope, { metricPrefixes: ['ALERTS'] });
      assert.deepEqual(namesOf(livePackOfRun(configured)), ['ALERTS', 'ALERTS_FOR_STATE']);
      process.env.OBSERVOGRAM_SNAPSHOT_METRIC_PREFIXES = '9bad';
      const before = fake.calls.length;
      const bad = await call('POST', `/api/services/${id}/run`, { env: 'prod' });
      assert.equal(bad.status, 409, bad.text);
      assert.match(bad.json.error, /^the configured snapshot scope does not parse — OBSERVOGRAM_SNAPSHOT_METRIC_PREFIXES\[0\] "9bad"/);
      assert.equal(fake.calls.length, before, 'nothing sent');
    } finally { delete process.env.OBSERVOGRAM_SNAPSHOT_METRIC_PREFIXES; }

    // A rename takes the scope along; a deletion takes it away.
    assert.equal((await call('PATCH', `/api/services/${id}`, { liveScopes: { prod: { ruleGroups: ['shop'] } } })).status, 200);
    assert.equal((await call('PATCH', `/api/environments/${env.json.environment.id}`, { name: 'production' })).status, 200);
    assert.deepEqual((await call('GET', `/api/services/${id}`)).json.service.liveScopes, { production: { ruleGroups: ['shop'] } });
    assert.equal((await call('DELETE', `/api/environments/${env.json.environment.id}`)).status, 200);
    assert.deepEqual((await call('GET', `/api/services/${id}`)).json.service.liveScopes, {});
  } finally {
    await call('DELETE', `/api/services/${id}`);
    forgetChecks([NAME, 'scoped-shop.production']);
  }
});

