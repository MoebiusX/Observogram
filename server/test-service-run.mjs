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
const { fetchGithubFiles, ghFetch, rawFetch } = await import('./github-crawl.mjs');
const { unreachable } = await import('./fetch-failure.mjs');
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
const WWW = `Bearer authorization_uri=https://login.microsoftonline.com/${ORG_TENANT}, Basic realm="https://tfsprodweu5.app.visualstudio.com/"`;
const jwtFor = (tid) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ tid, upn: 'ada@contoso.example' })).toString('base64url')}.sig`;
const adoRefusal = (init, { status = 302, location = 'https://spsprodweu5.vssps.visualstudio.com/_signin?realm=dev.azure.com', www = WWW } = {}) => {
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

test('adoFetch: a redirect anywhere but the sign-in page is named as one — never followed, never read as the token, the person not asked', async () => {
  process.env.OBSERVOGRAM_ADO_ORIGINS = 'https://tfs.corp.example';
  try {
    const seen = [];
    const moved = redirectAnyway(seen, { status: 302, location: 'https://tfs.corp.example.com/DefaultCollection/Shop/_apis/git/repositories/c/items', www: null });
    for (const opts of [{ token: 'pat-MINE-0000', tokenSource: 'request' }, { token: 'pat-SERVER-0000' }, { token: '' }]) {
      await assert.rejects(adoFetch('https://tfs.corp.example/DefaultCollection/Shop/_apis/git/repositories/c/items', { fetchImpl: moved, ...opts }),
        (e) => e.status === undefined && e.message === "Azure DevOps 302: https://tfs.corp.example redirects this read to https://tfs.corp.example.com, which the server does not follow — give the repository's address on the host that serves it");
    }
    await assert.rejects(adoFetch('https://tfs.corp.example/x/_apis/y', { fetchImpl: redirectAnyway([], { location: '', www: null }), token: '' }),
      (e) => e.status === undefined && /redirects this read to another address, which the server does not follow/.test(e.message), 'no Location at all');
    assert.ok(seen.every((s) => s.url.startsWith('https://tfs.corp.example/')), 'nothing followed');
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

test('unreachable: "could not be reached" only when the host was not reached, with the reason per code; a redirect, a request never sent and anything else are each named as what they are; the original error is kept; any other error is left as it is', async () => {
  const failed = (cause) => new TypeError('fetch failed', { cause });
  const withCode = (code, message = code) => Object.assign(new Error(message), { code });
  const said = (cause) => unreachable('Azure DevOps', 'https://dev.azure.com/acme/x/_apis/y', failed(cause)).message;
  const REACH = 'Azure DevOps: https://dev.azure.com could not be reached from the server — ';
  const table = [
    ['ENOTFOUND', 'its name does not resolve on the server (ENOTFOUND)'],
    ['EAI_AGAIN', 'its name does not resolve on the server (the lookup timed out) (EAI_AGAIN)'],
    ['ECONNREFUSED', 'the connection was refused (ECONNREFUSED)'],
    ['ETIMEDOUT', 'the connection timed out (ETIMEDOUT)'],
    ['UND_ERR_CONNECT_TIMEOUT', 'the connection timed out (UND_ERR_CONNECT_TIMEOUT)'],
    ['ECONNRESET', 'the connection was dropped (ECONNRESET)'],
    ['UND_ERR_SOCKET', 'the connection was dropped (UND_ERR_SOCKET)'],
    ['ENETUNREACH', 'the network is unreachable from the server (ENETUNREACH)'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'its certificate is not one the server trusts (if a proxy re-signs the traffic, give the server its certificate authority with NODE_EXTRA_CA_CERTS) (SELF_SIGNED_CERT_IN_CHAIN)'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'its certificate is not one the server trusts (if a proxy re-signs the traffic, give the server its certificate authority with NODE_EXTRA_CA_CERTS) (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)'],
    ['CERT_HAS_EXPIRED', 'its certificate has expired or is not yet valid (CERT_HAS_EXPIRED)'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'its certificate does not name this host (something else answered, or the address uses a name the certificate is not for) (ERR_TLS_CERT_ALTNAME_INVALID)'],
    ['ERR_SSL_WRONG_VERSION_NUMBER', 'the TLS handshake failed (is it https on that port?) (ERR_SSL_WRONG_VERSION_NUMBER)'],
  ];
  for (const [code, reason] of table) assert.equal(said(withCode(code)), REACH + reason, code);
  // A host with IPv6 and IPv4 addresses: an AggregateError, the last attempt's reason first.
  const both = Object.assign(new AggregateError([withCode('ENETUNREACH'), withCode('ETIMEDOUT')], ''), { code: 'ENETUNREACH' });
  assert.equal(said(both), `${REACH}the connection timed out (ETIMEDOUT)`);
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
  assert.ok(unreachable('x', 'not a url', failed(withCode('ENOTFOUND'))).message.startsWith('x: not a url could not be reached'));

  // Through the readers: the token never in the sentence, no status, so the Run answers 502.
  await assert.rejects(adoFetch('https://dev.azure.com/acme/x/_apis/y', { fetchImpl: async () => { throw failed(withCode('ENOTFOUND')); }, token: 'pat-SECRET-0000' }),
    (e) => e.status === undefined && e.message === `${REACH}its name does not resolve on the server (ENOTFOUND)` && !e.message.includes('pat-SECRET'));
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
  assert.deepEqual([noEndpoint.status, noEndpoint.json.error], [409, 'Shop API in prod has no live target yet — choose the MCP endpoint that reads it']);
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

const { repositoryCredential, parseRepoAuth, repoAuthNeed, redactToken, signInOn, REPO_AUTH_WAYS, RepoAuthRefusal } = await import('./repo-auth.mjs');

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
      [502, undefined, 'the repository could not be read: Azure DevOps: https://dev.azure.com could not be reached from the server — its name does not resolve on the server (ENOTFOUND)']);
    for (const r of answers) for (const token of [MINE, SERVER]) assert.ok(!r.text.includes(token), 'no token is ever answered');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.AZURE_DEVOPS_TOKEN;
  }
});
