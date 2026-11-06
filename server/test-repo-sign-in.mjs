#!/usr/bin/env node
/**
 * server/test-repo-sign-in.mjs — a person signs in to GitHub or Azure DevOps
 * (server/repo-sign-in.mjs), so their repositories read as them without a
 * pasted token. In process over HTTP on a server with sign-in (local users),
 * with GitHub, Microsoft Entra ID and Azure DevOps stubbed at their own
 * addresses.
 *
 * The configuration (each host's variables, Entra ID borrowed from the
 * sign-in's own registration), then the flow: the start sends the person to
 * the host with PKCE and a state; the host's answer is refused when it is
 * not the flow this person started (another state, another login, a host
 * error, a refused exchange); a good one leaves the host's token sealed in
 * the person's browser — never on the server, never readable in the cookie
 * — and /auth/me names the account. A Run and Expert's GitHub scan read as
 * that account; a cookie that is tampered with, another login's, or from
 * before a session-epoch change reads as no one's; GitHub ending the token
 * drops it; sign-out ends it (GitHub's grant revoked), and so does signing
 * out of Observogram. An Azure DevOps token, larger than one cookie, is split
 * and still reads as Bearer, on Azure DevOps Services only. No token reaches
 * a log line or an answer.
 */

// Hermetic (§0): a developer shell's store, identity or host variables
// never reach this process's imports.
const { STRIP, dropInheritedOrgVars, signIn } = await import('./fixtures/serve-child.mjs');
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
const { createHash } = await import('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-repo-sign-in-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_USERS_FILE = join(WORKSPACE, 'users.json');
const RULES = readFileSync(join(ROOT, 'tools', 'fixtures', 'crawl', 'operational-alerts', 'prometheus', 'rules.yml'), 'utf8');

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile } = await import('./store/legacy-files.mjs');
writeUsersFile({ users: {
  ada: { name: 'Ada', email: 'ada@example.test', createdAt: 'test', password: hashPassword('ada-pass-12345') },
  bob: { name: 'Bob', email: 'bob@example.test', createdAt: 'test', password: hashPassword('bob-pass-12345') },
} }, process.env.OBSERVOGRAM_USERS_FILE);

const signInMod = await import('./repo-sign-in.mjs');
const { repoSignInConfig, safeReturn, callbackUrl, readRepoLink, ADO_SCOPE } = signInMod;
const { REPO_AUTH_WAYS, repositoryCredential } = await import('./repo-auth.mjs');
const { fetchRepositoryFiles } = await import('./repo-sources.mjs');
const { currentStore, closeStore } = await import('./store/db.mjs');
const { getUserByLogin } = await import('./store/users.mjs');
const { endpointIdFor } = await import('./fixtures/fake-mcp.mjs');

// ---------- the hosts, stubbed at their own addresses ----------

const GH_ID = 'Iv1.testclient0000';
const GH_SECRET = 'gh-client-secret-0000000000';
const GH_TOKEN = 'gho_PersonSignIn0123456789abcdefABCDEF';
const ADO_ID = 'ado-app-00000000';
const ADO_SECRET = 'ado-client-secret-0000000000';
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
// An Entra ID access token as large as real ones get (with group claims): more than one cookie holds.
const ADO_TOKEN = `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ aud: '499b84ac-1321-427f-aa17-267ca6975798', upn: 'ada@contoso.example', groups: 'g'.repeat(3200) })}.${'s'.repeat(342)}`;

const realFetch = globalThis.fetch;
const hostCalls = [];
const host = { ghRevoked: false, ghExchange: null, adoExchange: null };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init);
  const headers = new Headers(init.headers || {});
  const auth = headers.get('authorization');
  const method = init.method || 'GET';
  const body = init.body instanceof URLSearchParams ? init.body.toString() : (typeof init.body === 'string' ? init.body : null);
  hostCalls.push({ url: u, method, auth, body });
  if (u === 'https://github.com/login/oauth/access_token') return json(host.ghExchange(new URLSearchParams(body)));
  if (u.startsWith('https://login.microsoftonline.com/contoso.example/oauth2/v2.0/token')) return json(host.adoExchange(new URLSearchParams(body)));
  if (u.startsWith('https://api.github.com/')) {
    if (method === 'DELETE' && u === `https://api.github.com/applications/${GH_ID}/token`) return new Response(null, { status: 204 });
    if (auth === `Bearer ${GH_TOKEN}` && host.ghRevoked) return json({ message: 'Bad credentials' }, 401);
    if (auth !== `Bearer ${GH_TOKEN}`) return json({ message: 'Not Found' }, 404);
    if (u === 'https://api.github.com/user') return json({ login: 'ada-gh' });
    if (u.endsWith('/repos/acme/private-shop')) return json({ default_branch: 'main' });
    if (u.includes('/repos/acme/private-shop/git/trees/main')) return json({ tree: [{ type: 'blob', path: 'alerts/api.rules.yml', size: RULES.length }] });
    if (u.includes('/repos/acme/private-shop/contents/')) return new Response(RULES);
    return json({ message: 'Not Found' }, 404);
  }
  if (u.startsWith('https://dev.azure.com/contoso/shop/_apis/git/repositories/api/items')) {
    if (auth !== `Bearer ${ADO_TOKEN}`) return new Response('', { status: 401 });
    if (u.includes('recursionLevel=Full')) return json({ value: [{ gitObjectType: 'blob', path: '/alerts/api.rules.yml' }] });
    return json({ content: RULES });
  }
  return new Response('not stubbed', { status: 599 });
};

const logs = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => { logs.push(String(chunk)); return realWrite(chunk, ...rest); };

const { start } = await import('./index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(async () => {
  globalThis.fetch = realFetch;
  process.stderr.write = realWrite;
  await new Promise((ok) => srv.close(ok));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

// ---------- a browser's cookies ----------

const answers = [];
function absorb(jar, setCookies) {
  for (const c of setCookies) {
    const [nv, ...attrs] = c.split(';');
    const i = nv.indexOf('=');
    const name = nv.slice(0, i).trim();
    const maxAge = attrs.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
    if (maxAge && Number(maxAge.split('=')[1]) <= 0) jar.delete(name);
    else jar.set(name, nv.slice(i + 1).trim());
  }
}
async function browse(jar, method, path, { body, headers = {} } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method, redirect: 'manual',
    headers: {
      Accept: 'application/json', ...(jar?.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a page */ }
  const setCookies = r.headers.getSetCookie?.() || [];
  if (jar) absorb(jar, setCookies);
  const out = { status: r.status, text, json: parsed, location: r.headers.get('location'), setCookies };
  answers.push(out);
  return out;
}
const API = { 'X-Observogram-CSRF': '1', 'X-Observogram-Org': 'default' };
async function personJar(login, password) {
  const s = await signIn(BASE, login, password);
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const [name, value] = s.session.split('=');
  return new Map([[name, value]]);
}
const setCookie = (r, name) => r.setCookies.find((c) => c.startsWith(`${name}=`)) || null;
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');

function setGithub(on) {
  if (on) { process.env.OBSERVOGRAM_GITHUB_CLIENT_ID = GH_ID; process.env.OBSERVOGRAM_GITHUB_CLIENT_SECRET = GH_SECRET; }
  else { delete process.env.OBSERVOGRAM_GITHUB_CLIENT_ID; delete process.env.OBSERVOGRAM_GITHUB_CLIENT_SECRET; }
}
function setAdo(on) {
  if (on) { process.env.OBSERVOGRAM_ADO_CLIENT_ID = ADO_ID; process.env.OBSERVOGRAM_ADO_CLIENT_SECRET = ADO_SECRET; process.env.OBSERVOGRAM_ADO_TENANT = 'contoso.example'; }
  else { delete process.env.OBSERVOGRAM_ADO_CLIENT_ID; delete process.env.OBSERVOGRAM_ADO_CLIENT_SECRET; delete process.env.OBSERVOGRAM_ADO_TENANT; }
}

// The start, followed to the host: the state and the challenge it sent.
async function startAt(jar, kind, query = '') {
  const r = await browse(jar, 'GET', `/auth/repo/${kind}/start${query}`);
  assert.equal(r.status, 302, r.text);
  const to = new URL(r.location);
  return { r, to, state: to.searchParams.get('state'), challenge: to.searchParams.get('code_challenge') };
}
// The host's exchange answering for the challenge this start sent.
function githubAnswers(challenge, token = GH_TOKEN) {
  host.ghExchange = (form) => {
    assert.equal(form.get('client_id'), GH_ID);
    assert.equal(form.get('client_secret'), GH_SECRET);
    assert.equal(form.get('redirect_uri'), `${BASE}/auth/repo/github/callback`);
    if (form.get('code') !== 'code-ok') return { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' };
    assert.equal(challengeOf(form.get('code_verifier')), challenge, 'the verifier proves the challenge (PKCE)');
    return { access_token: token, token_type: 'bearer', scope: 'repo' };
  };
}

// ---------- configuration ----------

test('the configuration: each host offers sign-in only with its own registration; Azure DevOps borrows an Entra ID sign-in\'s; the return page is a path on this server; the callback is the public address when one is set', () => {
  assert.equal(repoSignInConfig('github', { env: {} }), null);
  assert.equal(repoSignInConfig('github', { env: { OBSERVOGRAM_GITHUB_CLIENT_ID: 'x' } }), null, 'the web flow needs the secret too');
  const gh = repoSignInConfig('github', { env: { OBSERVOGRAM_GITHUB_CLIENT_ID: 'x', OBSERVOGRAM_GITHUB_CLIENT_SECRET: 'y' } });
  assert.deepEqual([gh.scope, gh.authorizeUrl, gh.tokenUrl], ['repo', 'https://github.com/login/oauth/authorize', 'https://github.com/login/oauth/access_token']);
  assert.equal(repoSignInConfig('github', { env: { TOMOGRAPH_GITHUB_CLIENT_ID: 'x', TOMOGRAPH_GITHUB_CLIENT_SECRET: 'y', OBSERVOGRAM_GITHUB_SCOPE: 'public_repo' } }).scope, 'public_repo', 'the legacy spelling and a scope of one\'s own');

  assert.equal(repoSignInConfig('ado', { env: {} }), null);
  const own = repoSignInConfig('ado', { env: { OBSERVOGRAM_ADO_CLIENT_ID: 'a' } });
  assert.deepEqual([own.tenant, own.clientSecret, own.scope, own.tokenUrl], ['organizations', null, ADO_SCOPE, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token'], 'a public client, any work account');
  const entra = { OBSERVOGRAM_OIDC_ISSUER: 'https://login.microsoftonline.com/contoso.example/v2.0', OBSERVOGRAM_OIDC_CLIENT_ID: 'signin-app', OBSERVOGRAM_OIDC_CLIENT_SECRET: 'signin-secret' };
  const borrowed = repoSignInConfig('ado', { env: entra });
  assert.deepEqual([borrowed.clientId, borrowed.clientSecret, borrowed.tenant], ['signin-app', 'signin-secret', 'contoso.example'], 'the sign-in\'s own Entra ID registration and tenant');
  assert.equal(repoSignInConfig('ado', { env: { ...entra, OBSERVOGRAM_ADO_CLIENT_ID: 'mine' } }).clientId, 'mine', 'a registration of its own wins');
  assert.equal(repoSignInConfig('ado', { env: { OBSERVOGRAM_OIDC_ISSUER: 'https://idp.example/realms/x', OBSERVOGRAM_OIDC_CLIENT_ID: 'c' } }), null, 'another identity provider lends nothing');
  assert.equal(repoSignInConfig('ado', { env: { OBSERVOGRAM_ADO_CLIENT_ID: 'a', OBSERVOGRAM_ADO_TENANT: 'x/../y' } }), null, 'a tenant that is no tenant');
  assert.equal(repoSignInConfig('gitlab', { env: {} }), null);

  for (const [given, want] of [['/', '/'], ['/?mode=overview#list', '/?mode=overview#list'], ['//evil.example/x', '/'], ['/\\evil.example', '/'], ['https://evil.example/', '/'], ['', '/'], [undefined, '/'], ['/a\nb', '/'], [`/${'a'.repeat(600)}`, '/']]) {
    assert.equal(safeReturn(given), want, JSON.stringify(given));
  }
  const req = { protocol: 'http', get: () => 'studio.internal:8000' };
  assert.equal(callbackUrl(req, 'github', { env: {} }), 'http://studio.internal:8000/auth/repo/github/callback');
  assert.equal(callbackUrl(req, 'ado', { env: { OBSERVOGRAM_PUBLIC_URL: 'https://observogram.example/some/path' } }), 'https://observogram.example/auth/repo/ado/callback', 'behind a TLS proxy: the public address');
  assert.equal(callbackUrl(req, 'github', { env: { OBSERVOGRAM_OIDC_REDIRECT_URL: 'https://sso.example/auth/callback' } }), 'https://sso.example/auth/repo/github/callback');
});

// ---------- GitHub ----------

let ada;
test('GitHub: the start needs a session and a configured host, and sends the person to GitHub with PKCE and a state in a signed flow cookie', async () => {
  ada = await personJar('ada', 'ada-pass-12345');
  const off = await browse(ada, 'GET', '/auth/me');
  assert.deepEqual(off.json.repoSignIn, {
    github: { available: false, signedIn: false, account: null, expiresAt: null },
    ado: { available: false, signedIn: false, account: null, expiresAt: null },
  });
  assert.equal((await browse(ada, 'GET', '/auth/repo/github/start')).status, 404, 'not set up: nothing to start');
  setGithub(true);
  assert.deepEqual((await browse(ada, 'GET', '/auth/me')).json.repoSignIn.github, { available: true, signedIn: false, account: null, expiresAt: null });
  const anonymous = await browse(null, 'GET', '/auth/repo/github/start');
  assert.deepEqual([anonymous.status, anonymous.location], [302, '/auth/login'], 'no session: sign in to Observogram first');
  assert.equal((await browse(ada, 'GET', '/auth/repo/gitlab/start')).status, 404);

  const { r, to, state, challenge } = await startAt(ada, 'github', '?return=%2F%3Fmode%3Doverview');
  assert.equal(to.href.split('?')[0], 'https://github.com/login/oauth/authorize');
  assert.deepEqual(Object.fromEntries(to.searchParams), {
    client_id: GH_ID, redirect_uri: `${BASE}/auth/repo/github/callback`, scope: 'repo', state, code_challenge: challenge, code_challenge_method: 'S256', allow_signup: 'false',
  });
  assert.match(state, /^[A-Za-z0-9_-]{32}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  const flow = setCookie(r, 'observogram_repoflow_github');
  assert.ok(flow && /HttpOnly/.test(flow) && /SameSite=Lax/.test(flow) && /Max-Age=600/.test(flow), flow);
});

test('GitHub: an answer that is not the flow this person started signs no one in — another state, a host error, a refused exchange, another login\'s flow', async () => {
  await startAt(ada, 'github');
  const r1 = await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${'x'.repeat(32)}`);
  assert.equal(r1.status, 400);
  assert.match(r1.text, /does not belong to the sign-in you started/);
  assert.equal(setCookie(r1, 'observogram_repo_github'), null);
  assert.match(setCookie(r1, 'observogram_repoflow_github'), /Max-Age=0/, 'the flow is spent either way');

  await startAt(ada, 'github');
  const r2 = await browse(ada, 'GET', '/auth/repo/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.');
  assert.equal(r2.status, 400);
  assert.match(r2.text, /GitHub did not sign you in: The user has denied your application access\./);

  const s3 = await startAt(ada, 'github');
  githubAnswers(s3.challenge);
  const r3 = await browse(ada, 'GET', `/auth/repo/github/callback?code=code-stale&state=${s3.state}`);
  assert.equal(r3.status, 502);
  assert.match(r3.text, /GitHub refused the sign-in: The code passed is incorrect or expired\./);
  assert.equal(setCookie(r3, 'observogram_repo_github'), null);

  // Ada's flow cookie in Bob's browser: Bob's session is not the one that started it.
  const s4 = await startAt(ada, 'github');
  const bob = await personJar('bob', 'bob-pass-12345');
  bob.set('observogram_repoflow_github', ada.get('observogram_repoflow_github'));
  githubAnswers(s4.challenge);
  const r4 = await browse(bob, 'GET', `/auth/repo/github/callback?code=code-ok&state=${s4.state}`);
  assert.equal(r4.status, 400);
  assert.match(r4.text, /expired or was started somewhere else/);
  assert.equal(setCookie(r4, 'observogram_repo_github'), null);
  const noSession = await browse(null, 'GET', `/auth/repo/github/callback?code=code-ok&state=${s4.state}`);
  assert.deepEqual([noSession.status, noSession.location], [302, '/auth/login']);
});

test('GitHub: a good answer leaves the token sealed in the person\'s browser, never readable there, and /auth/me names the account; back to the page it started from, never another site', async () => {
  const s = await startAt(ada, 'github', '?return=%2F%3Fmode%3Doverview');
  githubAnswers(s.challenge);
  const r = await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${s.state}`);
  assert.deepEqual([r.status, r.location], [302, '/?mode=overview']);
  const link = setCookie(r, 'observogram_repo_github');
  assert.ok(link && /HttpOnly/.test(link) && /SameSite=Lax/.test(link), link);
  const maxAge = Number(/Max-Age=(\d+)/.exec(link)[1]);
  assert.ok(maxAge > 0 && maxAge <= 8 * 3600, `until the session ends at the latest (${maxAge}s)`);
  const value = ada.get('observogram_repo_github');
  assert.match(value, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  for (const part of value.split('.').slice(1)) assert.ok(!Buffer.from(part, 'base64url').toString('latin1').includes(GH_TOKEN), 'sealed: the token cannot be read out of the cookie');
  assert.ok(!value.includes(GH_TOKEN));

  const me = await browse(ada, 'GET', '/auth/me');
  assert.deepEqual([me.json.repoSignIn.github.available, me.json.repoSignIn.github.signedIn, me.json.repoSignIn.github.account], [true, true, 'ada-gh']);
  assert.ok(Date.parse(me.json.repoSignIn.github.expiresAt) > Date.now());

  const away = await startAt(ada, 'github', `?return=${encodeURIComponent('//evil.example/x')}`);
  githubAnswers(away.challenge);
  const r2 = await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${away.state}`);
  assert.deepEqual([r2.status, r2.location], [302, '/'], 'another site is never a way back');

  const pop = await startAt(ada, 'github', '?popup=r1x2&return=%2F%3Fmode%3Doverview');
  githubAnswers(pop.challenge);
  const r3 = await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${pop.state}`);
  assert.equal(r3.status, 200);
  assert.match(r3.text, /Signed in to GitHub/);
  assert.match(r3.text, /Your GitHub repositories now read as ada-gh in Observogram/);
  assert.ok(r3.text.includes('new BroadcastChannel(\'observogram-repo-sign-in\')') && r3.text.includes('"type":"observogram-repo-sign-in","kind":"github","ok":true,"rid":"r1x2"'), 'a window of the studio tells it, under the id the studio gave it');
  assert.ok(r3.text.includes('d.type === \'observogram-repo-sign-in-ack\' && d.rid === note.rid') && r3.text.includes('var back = "/?mode=overview";') && r3.text.includes('location.replace(back)'),
    'it closes only when the tab that started it answers; else back to the page (a browser that opened it in the studio\'s own tab)');
  assert.equal(r3.json, null);
  const odd = await startAt(ada, 'github', `?popup=${encodeURIComponent('<b>"x"</b>')}`);
  githubAnswers(odd.challenge);
  const r4 = await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${odd.state}`);
  assert.deepEqual([r4.status, r4.location], [302, '/'], 'an id that is no id: no window page, the redirect');
});

test('GitHub: Expert\'s scan of a private repository reads as the signed-in account; without the sign-in it asks for it; a tampered cookie, another login\'s and one from before a session-epoch change read as no one\'s', async () => {
  hostCalls.length = 0;
  const signedIn = await browse(ada, 'POST', '/api/crawl-github', { body: { url: 'acme/private-shop' }, headers: API });
  assert.equal(signedIn.status, 200, signedIn.text);
  const reads = hostCalls.filter((c) => c.url.startsWith('https://api.github.com/repos/'));
  assert.ok(reads.length >= 3 && reads.every((c) => c.auth === `Bearer ${GH_TOKEN}`), 'every read with the person\'s own GitHub token');

  const bare = new Map([...ada].filter(([k]) => k === 'observogram_session'));
  const without = await browse(bare, 'POST', '/api/crawl-github', { body: { url: 'acme/private-shop' }, headers: API });
  assert.deepEqual([without.status, without.json.repoAuth], [404, { kind: 'github', label: 'GitHub token', refused: false, signIn: true }]);
  assert.equal(without.json.hint, `${REPO_AUTH_WAYS.signIn('github')}.`);

  const value = ada.get('observogram_repo_github');
  const flipped = value.slice(0, -2) + (value.at(-2) === 'A' ? 'B' : 'A') + value.at(-1);
  const tampered = new Map([...bare, ['observogram_repo_github', flipped]]);
  assert.equal((await browse(tampered, 'POST', '/api/crawl-github', { body: { url: 'acme/private-shop' }, headers: API })).json.repoAuth.refused, false, 'a tampered cookie is no sign-in');

  const bob = await personJar('bob', 'bob-pass-12345');
  bob.set('observogram_repo_github', value);
  assert.equal((await browse(bob, 'GET', '/auth/me')).json.repoSignIn.github.signedIn, false, 'Ada\'s sign-in in Bob\'s browser is no one\'s');

  // "Sign out my other sessions": a new session epoch, so every sign-in sealed before it ends.
  const other = new Map(ada);
  const out = await browse(other, 'POST', '/auth/signout-others', { headers: API });
  assert.equal(out.status, 200, out.text);
  assert.equal((await browse(other, 'GET', '/auth/me')).json.repoSignIn.github.signedIn, false);
  ada = other;
});

test('GitHub: the token GitHub no longer takes is dropped from the browser and the row is told; sign-out drops it and revokes GitHub\'s grant; signing out of Observogram drops every host\'s', async () => {
  const s = await startAt(ada, 'github');
  githubAnswers(s.challenge);
  await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${s.state}`);
  assert.ok(ada.has('observogram_repo_github'));

  host.ghRevoked = true;
  const ended = await browse(ada, 'POST', '/api/crawl-github', { body: { url: 'acme/private-shop' }, headers: API });
  assert.deepEqual(ended.json.repoAuth, { kind: 'github', label: 'GitHub token', refused: true, signIn: true, via: 'sign-in', account: 'ada-gh', expired: true });
  assert.equal(ended.json.hint, `${REPO_AUTH_WAYS.signedInRefused('github', 'ada-gh', { expired: true })}.`);
  assert.match(setCookie(ended, 'observogram_repo_github'), /Max-Age=0/, 'GitHub ended it: this browser forgets it');
  host.ghRevoked = false;

  const s2 = await startAt(ada, 'github');
  githubAnswers(s2.challenge);
  await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${s2.state}`);
  const noHeader = await browse(ada, 'POST', '/auth/repo/github/sign-out');
  assert.equal(noHeader.status, 403, 'the sign-out takes the CSRF header');
  hostCalls.length = 0;
  const out = await browse(ada, 'POST', '/auth/repo/github/sign-out', { headers: API });
  assert.deepEqual([out.status, out.json], [200, { ok: true, signedOut: 'github' }]);
  assert.ok(!ada.has('observogram_repo_github'));
  const revoke = hostCalls.find((c) => c.method === 'DELETE');
  assert.deepEqual([revoke?.url, revoke?.auth, JSON.parse(revoke?.body || 'null')], [
    `https://api.github.com/applications/${GH_ID}/token`, `Basic ${Buffer.from(`${GH_ID}:${GH_SECRET}`).toString('base64')}`, { access_token: GH_TOKEN },
  ], 'GitHub\'s grant revoked with the app\'s own credentials');
  assert.equal((await browse(ada, 'GET', '/auth/me')).json.repoSignIn.github.signedIn, false);

  const s3 = await startAt(ada, 'github');
  githubAnswers(s3.challenge);
  await browse(ada, 'GET', `/auth/repo/github/callback?code=code-ok&state=${s3.state}`);
  const logout = await browse(ada, 'POST', '/auth/logout');
  assert.equal(logout.status, 204);
  for (const name of ['observogram_repo_github', 'observogram_repo_ado', 'observogram_repo_ado_1']) assert.match(setCookie(logout, name) || '', /Max-Age=0/, `${name} dropped at sign-out`);
});

// ---------- Azure DevOps ----------

test('Azure DevOps: Entra ID with PKCE and the Azure DevOps scope; a token larger than a cookie is split, reads as Bearer on a Run, and only on Azure DevOps Services; without it the Run asks to sign in', async () => {
  ada = await personJar('ada', 'ada-pass-12345');
  setAdo(true);
  const s = await startAt(ada, 'ado', '?return=%2F');
  assert.equal(s.to.href.split('?')[0], 'https://login.microsoftonline.com/contoso.example/oauth2/v2.0/authorize');
  assert.deepEqual(Object.fromEntries(s.to.searchParams), {
    client_id: ADO_ID, redirect_uri: `${BASE}/auth/repo/ado/callback`, scope: ADO_SCOPE, state: s.state, code_challenge: s.challenge, code_challenge_method: 'S256',
    response_type: 'code', response_mode: 'query',
  });
  host.adoExchange = (form) => {
    assert.deepEqual([form.get('grant_type'), form.get('client_id'), form.get('client_secret'), form.get('scope'), form.get('code')], ['authorization_code', ADO_ID, ADO_SECRET, ADO_SCOPE, 'code-ado']);
    assert.equal(challengeOf(form.get('code_verifier')), s.challenge);
    return { access_token: ADO_TOKEN, token_type: 'Bearer', expires_in: 3599 };
  };
  const r = await browse(ada, 'GET', `/auth/repo/ado/callback?code=code-ado&state=${s.state}`);
  assert.deepEqual([r.status, r.location], [302, '/']);
  const first = setCookie(r, 'observogram_repo_ado');
  assert.match(first, /^observogram_repo_ado=2\*v1\./, 'split over two cookies');
  assert.ok(setCookie(r, 'observogram_repo_ado_1'));
  assert.match(setCookie(r, 'observogram_repo_ado_2'), /Max-Age=0/, 'a longer split before is not left behind');
  assert.ok(r.setCookies.every((c) => c.length < 4096), 'each cookie fits');
  assert.ok(Number(/Max-Age=(\d+)/.exec(first)[1]) <= 3599, 'it ends when Entra ID\'s token does');
  const me = (await browse(ada, 'GET', '/auth/me')).json.repoSignIn.ado;
  assert.deepEqual([me.signedIn, me.account], [true, 'ada@contoso.example']);
  assert.ok(Date.parse(me.expiresAt) <= Date.now() + 3600_000);

  // The Run of an Azure DevOps service reads as the person.
  const created = await browse(ada, 'POST', '/api/services', { body: { name: 'Ado Shop', repository: { kind: 'ado', location: 'https://dev.azure.com/contoso/shop/_git/api' } }, headers: API });
  assert.equal(created.status, 201, created.text);
  const cookieHeader = [...ada].map(([k, v]) => `${k}=${v}`).join('; ');
  const endpointId = await endpointIdFor(BASE, 'http://127.0.0.1:9/mcp', { name: 'nowhere', headers: { ...API, Cookie: cookieHeader } });
  const id = created.json.service.id;
  assert.equal((await browse(ada, 'POST', `/api/services/${id}/environments`, { body: { name: 'prod', mcpEndpointId: endpointId }, headers: API })).status, 201);
  hostCalls.length = 0;
  const run = await browse(ada, 'POST', `/api/services/${id}/run`, { body: { env: 'prod' }, headers: API });
  const reads = hostCalls.filter((c) => c.url.startsWith('https://dev.azure.com/'));
  assert.ok(reads.length >= 2 && reads.every((c) => c.auth === `Bearer ${ADO_TOKEN}`), `the person's Entra ID token as Bearer (${run.status} ${run.text.slice(0, 200)})`);
  assert.equal(run.json?.repoAuth, undefined, 'the repository read; whatever the live side said');

  const bare = new Map([...ada].filter(([k]) => k === 'observogram_session'));
  const without = await browse(bare, 'POST', `/api/services/${id}/run`, { body: { env: 'prod' }, headers: API });
  assert.deepEqual([without.status, without.json.repoAuth], [403, { kind: 'ado', label: 'Azure DevOps token', refused: false, signIn: true }]);
  assert.ok(without.json.error.endsWith(` — ${REPO_AUTH_WAYS.signIn('ado')}`), without.json.error);

  // Azure DevOps Server takes a personal access token: the sign-in is never sent there.
  const user = getUserByLogin(currentStore(), 'ada');
  const link = readRepoLink({ headers: { cookie: cookieHeader } }, 'ado', user);
  assert.equal(link.token, ADO_TOKEN);
  process.env.OBSERVOGRAM_ADO_ORIGINS = 'https://tfs.example.test';
  try {
    hostCalls.length = 0;
    await assert.rejects(
      fetchRepositoryFiles({ kind: 'ado', location: 'https://tfs.example.test/DefaultCollection/shop/_git/api', ref: null }, { credential: repositoryCredential('ado', { link }) }),
      (e) => e.status === 400 && /an Azure DevOps sign-in reads Azure DevOps Services only/.test(e.message),
    );
    assert.equal(hostCalls.length, 0, 'refused before a request is made');
  } finally { delete process.env.OBSERVOGRAM_ADO_ORIGINS; }
  assert.equal(readRepoLink({ headers: { cookie: cookieHeader } }, 'ado', { ...user, sessionEpoch: user.sessionEpoch + 1 }), null);
  assert.equal(readRepoLink({ headers: { cookie: cookieHeader.replace(/observogram_repo_ado_1=[^;]+/, 'observogram_repo_ado_1=xyz') } }, 'ado', user), null, 'a part missing or changed: no sign-in');
  setAdo(false);
  setGithub(false);
});

test('no token the hosts gave reaches a log line or an answer', () => {
  for (const token of [GH_TOKEN, ADO_TOKEN, GH_SECRET, ADO_SECRET]) {
    assert.ok(!logs.some((l) => l.includes(token)), `${token.slice(0, 8)}… never logged`);
    assert.ok(!answers.some((a) => a.text.includes(token)), `${token.slice(0, 8)}… never answered`);
  }
  assert.ok(logs.some((l) => l.includes('[repo-sign-in] ada signed in to GitHub as ada-gh')), 'the sign-in itself is logged, by account');
});
