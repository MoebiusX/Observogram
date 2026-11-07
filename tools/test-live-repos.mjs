#!/usr/bin/env node
/**
 * tools/test-live-repos.mjs — a service's Run reads its repository from the
 * real GitHub and the real Azure DevOps, not from stubs.
 *
 * Why: on 2026-11-07 every stubbed test passed while a Run of a private Azure
 * DevOps repository answered "502 fetch failed". Azure DevOps refuses a read
 * with a redirect to its sign-in page unless the request asks for its 401
 * (X-TFS-FedAuthRedirect: Suppress); the stubs sent the 401 unasked (fixed
 * in 0.8.12, server/ado-crawl.mjs). A stub says what its author believes the
 * host does; this suite asks the host.
 *
 * The studio runs in this process with sign-in on (a local test user, as a
 * real deployment runs it), a fake MCP as the environment's live target, and
 * the real GitHub and Azure DevOps behind server/repo-sources.mjs
 * fetchRepositoryFiles and POST /api/services/:id/run. Every request the
 * readers send is recorded by host, never by token: which token it carried
 * is a label, so no assertion or message can print one, and every text this
 * suite shows is masked (each token, and an Azure DevOps token's Basic form).
 *
 *   the fixture        tools/fixtures/live-repo, read by a folder Run here:
 *                      the files and kinds each host must return (offline)
 *   GitHub, public     a public repository read with no token at all
 *                      (OBSERVOGRAM_LIVE_GITHUB_PUBLIC_REPO, default
 *                      MoebiusX/Observogram; "off" skips it)
 *   GitHub, private    OBSERVOGRAM_LIVE_GITHUB_REPO (owner/name): no token
 *                      is answered with the way to give one; a made-up token
 *                      is refused. With OBSERVOGRAM_LIVE_GITHUB_TOKEN (read
 *                      access to that repository's contents) the Run reads
 *                      the fixture, byte for byte.
 *   Azure DevOps       OBSERVOGRAM_LIVE_ADO_REPO (a dev.azure.com _git URL):
 *                      the same, with OBSERVOGRAM_LIVE_ADO_TOKEN (a personal
 *                      access token with Code (Read))
 *   unreachable        a host whose name does not resolve: the Run says why
 *   no leak            no token in a log line, an answer, a URL, another
 *                      header, a body or the live side, and every token went
 *                      to its repository's host only
 *
 * A host whose variables are not set is skipped, and the skip says which
 * variable; one set to something it cannot be fails its host's checks, so a
 * typo never reads as "not set". GitHub's quota for a reader with no token
 * (60 calls an hour by address) skips the check that needs it when spent.
 * docs/LIVE_REPO_TESTS.md says what to create and where each value goes;
 * .github/workflows/live-repos.yml runs this weekly. Not part of `npm test`:
 * it needs the network, and the private reads need accounts.
 *
 *   npm run test:live:repos
 */

import { randomBytes } from 'node:crypto';

// The live values, read before the hermetic strip below (they are this
// suite's own) and then removed, so no server module sees them.
const env = (k) => String(process.env[k] ?? '').trim();
const LIVE = {
  githubPublic: env('OBSERVOGRAM_LIVE_GITHUB_PUBLIC_REPO') || 'MoebiusX/Observogram',
  githubRepo: env('OBSERVOGRAM_LIVE_GITHUB_REPO'),
  githubToken: env('OBSERVOGRAM_LIVE_GITHUB_TOKEN'),
  adoRepo: env('OBSERVOGRAM_LIVE_ADO_REPO'),
  adoToken: env('OBSERVOGRAM_LIVE_ADO_TOKEN'),
};
for (const k of Object.keys(process.env)) if (k.toUpperCase().startsWith('OBSERVOGRAM_LIVE_')) delete process.env[k];

// Hermetic (§0): a developer shell's store, identity or host variables never
// reach this process's imports — above all no GITHUB_TOKEN or
// AZURE_DEVOPS_TOKEN, which a server with sign-in ignores anyway.
const { STRIP, childEnv, dropInheritedOrgVars, signIn } = await import('../server/fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();
delete process.env.GITHUB_TOKEN;
delete process.env.AZURE_DEVOPS_TOKEN;
delete process.env.OBSERVOGRAM_ADO_ORIGINS;

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { spawnSync } = await import('node:child_process');
const { tmpdir } = await import('node:os');
const { join, resolve, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURE = join(ROOT, 'tools', 'fixtures', 'live-repo');
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-live-repos-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
// A folder repository, under sign-in, is read only below a listed root.
process.env.OBSERVOGRAM_REPO_ROOTS = join(ROOT, 'tools', 'fixtures');

// One test user, made as an operator makes the first one (`npm run users --
// add`, the password on stdin, never in argv), with a password made for
// this run and kept nowhere. The first local user is the owner: sign-in is on.
const LOGIN = 'live';
const PASSWORD = `live-${randomBytes(18).toString('base64url')}`;
const made = spawnSync(process.execPath, [join(ROOT, 'tools', 'user-admin.mjs'), 'add', LOGIN, '--name', 'Live', '--email', 'live@example.test', '--password-stdin'], {
  cwd: ROOT, env: childEnv(WORKSPACE), input: `${PASSWORD}\n`, encoding: 'utf8',
});
if (made.status !== 0) throw new Error(`the test user could not be made: ${String(made.stderr || made.stdout).trim().split('\n')[0]}`);

// Made-up tokens, shaped like the hosts' own, made for this run: each host
// must refuse them.
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const madeUp = (alphabet, n) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('');
const MADE_UP = { github: `ghp_${madeUp(ALNUM, 36)}`, ado: madeUp(BASE32, 52) };

// An Azure DevOps personal access token travels as Basic base64(':' + token):
// that form gives the token back, so it is masked and looked for too
// (unpadded, so it is found with or without the `Basic ` and the padding).
const wire = (token) => Buffer.from(`:${token}`).toString('base64');
const basic = (token) => `Basic ${wire(token)}`;
// Which token a request carried, as a label: the value never leaves here.
function whose(authorization) {
  if (!authorization) return null;
  if (LIVE.githubToken && authorization === `Bearer ${LIVE.githubToken}`) return 'github';
  if (LIVE.adoToken && authorization === basic(LIVE.adoToken)) return 'ado';
  if (authorization === `Bearer ${MADE_UP.github}` || authorization === basic(MADE_UP.ado)) return 'made-up';
  return 'another';
}
const SECRETS = [
  LIVE.githubToken, LIVE.adoToken, MADE_UP.github, MADE_UP.ado, PASSWORD,
  ...[LIVE.adoToken, MADE_UP.ado].filter(Boolean).map((t) => wire(t).replace(/=+$/, '')),
].filter(Boolean);
const holdsSecret = (text) => SECRETS.some((s) => String(text ?? '').includes(s));
// Any text a message may show, with every token masked.
const masked = (text) => SECRETS.reduce((s, t) => s.split(t).join('[token]'), String(text ?? ''));

// Every request the server sends past loopback, by host and by whose token
// (its Authorization header), and whether a token rode anywhere else: the
// URL, another header, a body. The live side, on loopback, records what it
// was sent itself (server/fixtures/fake-mcp.mjs), and the no-leak check
// reads that.
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname !== '127.0.0.1') {
    const headers = new Headers(init.headers || {});
    const elsewhere = [...headers].some(([k, v]) => k !== 'authorization' && holdsSecret(v));
    sent.push({
      origin: u.origin,
      token: whose(headers.get('authorization')),
      elsewhere: elsewhere || holdsSecret(u.href) || (typeof init.body === 'string' && holdsSecret(init.body)),
      suppress: headers.get('x-tfs-fedauthredirect'),
      redirect: init.redirect ?? 'follow',
    });
  }
  return realFetch(url, init);
};
const sentSince = (n) => sent.slice(n);

// The server's log, kept to check it holds no token, and shown masked.
const logs = [];
const realWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => { logs.push(String(chunk)); return realWrite(masked(chunk)); };

const { REPO_AUTH_WAYS } = await import('../server/repo-auth.mjs');
const { fetchRepositoryFiles } = await import('../server/repo-sources.mjs');
const { parseRepository } = await import('../server/service-admin.mjs');
const { parseGithubUrl } = await import('../server/github-crawl.mjs');
const { parseAdoUrl, isAdoServices } = await import('../server/ado-crawl.mjs');
const { startFakeMcp, endpointIdFor } = await import('../server/fixtures/fake-mcp.mjs');
const { capabilityTool, probeCandidates } = await import('./lib/contracts/mcp-capabilities.mjs');
const { closeStore } = await import('../server/store/db.mjs');

// A value that is set but cannot be what it names: its host's checks fail
// with this, never skip. GitHub's is owner/name — a URL with /tree/<branch>
// would read another path than the sentences below name.
const MISSET = {
  github: LIVE.githubRepo && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(LIVE.githubRepo)
    ? 'OBSERVOGRAM_LIVE_GITHUB_REPO must be owner/name, with no URL or branch (docs/LIVE_REPO_TESTS.md)' : null,
  ado: LIVE.adoRepo && !(parseAdoUrl(LIVE.adoRepo) && isAdoServices(LIVE.adoRepo))
    ? 'OBSERVOGRAM_LIVE_ADO_REPO must be a repository on Azure DevOps Services: https://dev.azure.com/<org>/<project>/_git/<repo> (docs/LIVE_REPO_TESTS.md)' : null,
};

const recorded = (f) => JSON.parse(readFileSync(join(ROOT, 'tools', 'fixtures', 'mcp', f), 'utf8'));
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
const ANSWERS = {
  [capabilityTool('system_health')]: () => ({ services: [] }),
  [capabilityTool('system_topology')]: () => ({ dependencies: [] }),
  [nameOf(probeCandidates('metric_names')[0])]: () => recorded('metrics_label_values.json'),
  [nameOf(probeCandidates('scrape_configs')[0])]: () => recorded('metrics_targets.json'),
};
const fake = await startFakeMcp(Object.keys(ANSWERS), (name, args) => (ANSWERS[name] ? ANSWERS[name](args) : { ok: true }));

const { start } = await import('../server/index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(async () => {
  globalThis.fetch = realFetch;
  process.stderr.write = realWrite;
  await fake.close?.();
  await new Promise((ok) => srv.close(ok));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

// ---------- the signed-in person ----------

const API = { 'X-Observogram-CSRF': '1', 'X-Observogram-Org': 'default' };
const answers = [];
let session = null;
async function call(method, path, body) {
  const r = await realFetch(`${BASE}${path}`, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...API, ...(session ? { Cookie: session } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  const out = { status: r.status, json, text };
  answers.push(out);
  return out;
}
const signedIn = await signIn(BASE, LOGIN, PASSWORD);
if (signedIn.status !== 200 || !signedIn.session) throw new Error(`the test user could not sign in: HTTP ${signedIn.status}`);
session = signedIn.session;
const endpointId = await endpointIdFor(BASE, fake.url, { name: 'live-repos-fake-mcp', headers: { ...API, Cookie: session } });

// A service on `repository`, with a prod environment on the fake MCP.
let services = 0;
async function serviceOn(repository) {
  const created = await call('POST', '/api/services', { name: `Live ${++services} ${repository.kind}`, repository });
  assert.equal(created.status, 201, masked(created.text));
  const id = created.json.service.id;
  const envd = await call('POST', `/api/services/${id}/environments`, { name: 'prod', mcpEndpointId: endpointId });
  assert.equal(envd.status, 201, masked(envd.text));
  return { id, repository: created.json.service.repository };
}
const runOf = (svc, body = {}) => call('POST', `/api/services/${svc.id}/run`, { env: 'prod', ...body });

// GitHub's quota for a reader with no token is spent (ghFetch keeps GitHub's
// own sentence, "API rate limit exceeded for …"): not the reader's fault.
const quotaSpent = (status, error) => [403, 429].includes(status) && /rate limit/i.test(String(error ?? ''));
const QUOTA = (error) => `GitHub's quota without a token is spent here: ${masked(error)}`;

// ---------- the fixture ----------

// What every read of the fixture must report, and its files, read from this
// checkout once (each host's check reads them itself, so a run of one host
// alone, --test-name-pattern, compares against the same).
const FIXTURE_SCAN = Object.freeze({ files: 3, candidates: 3, capped: 0, skipped: 0, byKind: { 'grafana-dashboard': 1, 'otel-collector': 1, 'prometheus-rules': 1 }, unclassified: 0 });
let fixtureRead = null;
const fixtureFiles = () => (fixtureRead ??= fetchRepositoryFiles({ kind: 'path', location: FIXTURE, ref: null }));

// What a scan reports that two reads of the same files must share.
const scanShape = (scan) => ({ files: scan?.files, candidates: scan?.candidates, capped: scan?.capped, skipped: scan?.skipped, byKind: scan?.byKind, unclassified: scan?.unclassified });

// A host's read holds the fixture's files, byte for byte (the fixture is LF
// in every checkout, .gitattributes; a host serves what was pushed). A
// difference names paths only, never contents.
async function sameAsFixture(read, where) {
  const expected = await fixtureFiles();
  const got = Object.keys(read.files).sort();
  const want = Object.keys(expected.files).sort();
  const missing = want.filter((p) => !got.includes(p));
  const extra = got.filter((p) => !want.includes(p));
  const differ = want.filter((p) => got.includes(p) && read.files[p] !== expected.files[p]);
  assert.deepEqual({ missing, extra, differ }, { missing: [], extra: [], differ: [] },
    `${where} should hold tools/fixtures/live-repo at its root, unchanged (docs/LIVE_REPO_TESTS.md)`);
}

const unset = (...names) => {
  const missing = names.filter((n) => !LIVE[n]);
  const VAR = { githubRepo: 'OBSERVOGRAM_LIVE_GITHUB_REPO', githubToken: 'OBSERVOGRAM_LIVE_GITHUB_TOKEN', adoRepo: 'OBSERVOGRAM_LIVE_ADO_REPO', adoToken: 'OBSERVOGRAM_LIVE_ADO_TOKEN' };
  return missing.length ? `${missing.map((n) => VAR[n]).join(' and ')} not set — docs/LIVE_REPO_TESTS.md says what to create` : false;
};

test('the fixture, read from this checkout by a folder Run with sign-in on: three files, one of each kind, a valid pack — what each host must return', async () => {
  const read = await fixtureFiles();
  assert.deepEqual(Object.keys(read.files), ['grafana/dashboards/checkout.json', 'otel/collector.yaml', 'prometheus/rules.yml']);
  const svc = await serviceOn({ kind: 'path', location: FIXTURE });
  const r = await runOf(svc);
  assert.equal(r.status, 200, masked(r.text));
  assert.deepEqual(scanShape(r.json.scan), FIXTURE_SCAN);
  assert.ok(fake.calls.length > 0, 'the Run went on to the live side');
});

// ---------- GitHub ----------

test('GitHub, a public repository, read with no token: its files from raw.githubusercontent.com, no Authorization sent anywhere', { skip: LIVE.githubPublic === 'off' ? 'OBSERVOGRAM_LIVE_GITHUB_PUBLIC_REPO is off' : false }, async (t) => {
  const repository = parseRepository({ kind: 'github', location: LIVE.githubPublic });
  const gh = parseGithubUrl(repository.location);
  const from = sent.length;
  let read;
  try { read = await fetchRepositoryFiles(repository, { credential: { token: null, source: 'none' } }); }
  catch (e) {
    if (quotaSpent(e.status, e.message)) { t.skip(QUOTA(e.message)); return; }
    throw e;
  }
  assert.equal(read.source, `${gh.owner}/${gh.repo} on GitHub`);
  assert.ok(Object.keys(read.files).length > 0 && read.candidates >= Object.keys(read.files).length, `files read: ${Object.keys(read.files).length} of ${read.candidates}`);
  const calls = sentSince(from);
  assert.ok(calls.every((c) => c.token === null), 'no token at all: none sent');
  assert.ok(calls.every((c) => c.origin === 'https://api.github.com' || c.origin === 'https://raw.githubusercontent.com'), `only GitHub's hosts: ${[...new Set(calls.map((c) => c.origin))].join(', ')}`);
  assert.ok(calls.filter((c) => c.origin === 'https://api.github.com').length <= 2, 'the API for the repository and its tree only: the files come from raw, outside the quota');
});

test('GitHub, the private test repository, signed in: no token is answered 404 with the way to give one; a made-up token is refused with GitHub\'s own word', { skip: unset('githubRepo') }, async (t) => {
  assert.equal(MISSET.github, null, MISSET.github);
  const svc = await serviceOn({ kind: 'github', location: LIVE.githubRepo });
  const gh = parseGithubUrl(svc.repository.location);
  let from = sent.length;
  const none = await runOf(svc);
  if (quotaSpent(none.status, none.json?.error)) { t.skip(QUOTA(none.json.error)); return; }
  assert.equal(none.status, 404, `a private repository reads as not there without a token — is it private? ${masked(none.text).slice(0, 300)}`);
  assert.deepEqual(none.json.repoAuth, { kind: 'github', label: 'GitHub token', refused: false });
  assert.equal(none.json.error, `the repository could not be read: GitHub 404 on /repos/${gh.owner}/${gh.repo}: Not Found — ${REPO_AUTH_WAYS.needed('github')}`);
  assert.ok(sentSince(from).every((c) => c.token === null), 'none sent');

  from = sent.length;
  const wrong = await runOf(svc, { repoAuth: MADE_UP.github });
  assert.equal(wrong.status, 403, masked(wrong.text));
  assert.deepEqual(wrong.json.repoAuth, { kind: 'github', label: 'GitHub token', refused: true });
  assert.equal(wrong.json.error, `the repository could not be read: GitHub 401 on /repos/${gh.owner}/${gh.repo}: Bad credentials — ${REPO_AUTH_WAYS.refused('github')}`);
  const calls = sentSince(from);
  assert.ok(calls.length >= 1 && calls.every((c) => c.token === 'made-up' && c.origin === 'https://api.github.com'), 'the made-up token, to the API only');
});

test('GitHub, the private test repository read with its token: the Run scans the fixture, byte for byte, and the token went to api.github.com only', { skip: unset('githubRepo', 'githubToken') }, async (t) => {
  assert.equal(MISSET.github, null, MISSET.github);
  const svc = await serviceOn({ kind: 'github', location: LIVE.githubRepo });
  const gh = parseGithubUrl(svc.repository.location);
  let from = sent.length;
  const r = await runOf(svc, { repoAuth: LIVE.githubToken });
  assert.equal(r.status, 200, masked(r.text));
  assert.equal(r.json.scan.source, `${gh.owner}/${gh.repo} on GitHub`);
  assert.deepEqual(scanShape(r.json.scan), FIXTURE_SCAN, 'the same scan as the folder');
  let calls = sentSince(from);
  // The repository, its tree and its three files: all through the API with the token.
  assert.ok(calls.length >= 5 && calls.every((c) => c.token === 'github' && c.origin === 'https://api.github.com'), 'the token on every call, through the API (never raw.githubusercontent.com)');

  from = sent.length;
  const read = await fetchRepositoryFiles(svc.repository, { credential: { token: LIVE.githubToken, source: 'request' } });
  await sameAsFixture(read, `${gh.owner}/${gh.repo}`);
  calls = sentSince(from);
  assert.ok(calls.every((c) => c.token === 'github' && c.origin === 'https://api.github.com'));

  // The next Run without it reads with none: its answer is anonymous.
  const again = await runOf(svc);
  if (quotaSpent(again.status, again.json?.error)) { t.skip(`the read passed; the Run after it, with no token, could not run — ${QUOTA(again.json.error)}`); return; }
  assert.equal(again.status, 404, 'the token was for that Run only: the next one without it has none');
});

// ---------- Azure DevOps ----------

const ADO_ORIGIN = (() => { try { return new URL(LIVE.adoRepo).origin; } catch { return null; } })();

test('Azure DevOps, the private test repository, signed in: no token is "not public" with the way to give one; a made-up token is "not authorised"; every call asks for the 401 and follows no redirect', { skip: unset('adoRepo') }, async () => {
  assert.equal(MISSET.ado, null, MISSET.ado);
  const svc = await serviceOn({ kind: 'ado', location: LIVE.adoRepo });
  let from = sent.length;
  const none = await runOf(svc);
  assert.equal(none.status, 403, `a private repository is refused without a token — is it private? ${masked(none.text).slice(0, 300)}`);
  assert.deepEqual(none.json.repoAuth, { kind: 'ado', label: 'Azure DevOps token', refused: false });
  assert.equal(none.json.error, `the repository could not be read: Azure DevOps 401: this repository is not public — ${REPO_AUTH_WAYS.needed('ado')}`, 'sign-in on: the way is the person\'s own token, never AZURE_DEVOPS_TOKEN');
  let calls = sentSince(from);
  assert.ok(calls.length >= 1 && calls.every((c) => c.token === null), 'none sent');
  assert.ok(calls.every((c) => c.origin === ADO_ORIGIN && c.suppress === 'Suppress' && c.redirect === 'manual'), 'to the repository\'s host only, asking for the 401, following nothing');

  from = sent.length;
  const wrong = await runOf(svc, { repoAuth: MADE_UP.ado });
  assert.equal(wrong.status, 403, masked(wrong.text));
  assert.deepEqual(wrong.json.repoAuth, { kind: 'ado', label: 'Azure DevOps token', refused: true });
  assert.equal(wrong.json.error, `the repository could not be read: Azure DevOps 401: not authorised to read this repository — ${REPO_AUTH_WAYS.refused('ado')}`);
  calls = sentSince(from);
  assert.ok(calls.length >= 1 && calls.every((c) => c.token === 'made-up' && c.origin === ADO_ORIGIN && c.redirect === 'manual'), 'the made-up token, to the repository\'s host only');
});

test('Azure DevOps, the private test repository read with its token: the Run scans the fixture, byte for byte, and the token went to the repository\'s host only', { skip: unset('adoRepo', 'adoToken') }, async () => {
  assert.equal(MISSET.ado, null, MISSET.ado);
  const svc = await serviceOn({ kind: 'ado', location: LIVE.adoRepo });
  const ado = parseAdoUrl(svc.repository.location);
  let from = sent.length;
  const r = await runOf(svc, { repoAuth: LIVE.adoToken });
  assert.equal(r.status, 200, masked(r.text));
  assert.equal(r.json.scan.source, `${ado.project}/${ado.repo} on Azure DevOps`);
  assert.deepEqual(scanShape(r.json.scan), FIXTURE_SCAN, 'the same scan as the folder');
  let calls = sentSince(from);
  // The tree and the three files.
  assert.ok(calls.length >= 4 && calls.every((c) => c.token === 'ado' && c.origin === ADO_ORIGIN && c.suppress === 'Suppress' && c.redirect === 'manual'), 'the token as Basic on the tree and every file, to the repository\'s host only');

  from = sent.length;
  const read = await fetchRepositoryFiles(svc.repository, { credential: { token: LIVE.adoToken, source: 'request' } });
  await sameAsFixture(read, `${ado.project}/${ado.repo}`);
  calls = sentSince(from);
  assert.ok(calls.every((c) => c.token === 'ado' && c.origin === ADO_ORIGIN));
});

// ---------- a host the server cannot reach ----------

test('a host the server cannot reach: the Run answers 502 and says why, and asks for no token', async () => {
  // An Azure DevOps Server origin under .invalid (RFC 2606): no name server answers it.
  const origin = 'https://ado.observogram.invalid';
  process.env.OBSERVOGRAM_ADO_ORIGINS = origin;
  try {
    const svc = await serviceOn({ kind: 'ado', location: `${origin}/DefaultCollection/shop/_git/checkout` });
    const from = sent.length;
    const r = await runOf(svc, { repoAuth: MADE_UP.ado });
    assert.equal(r.status, 502, masked(r.text));
    assert.equal(r.json.repoAuth, undefined, 'a token would not change the answer');
    assert.match(r.json.error, /^the repository could not be read: Azure DevOps: https:\/\/ado\.observogram\.invalid could not be reached from the server — .+ \([A-Z0-9_]+\)$/, masked(r.json.error));
    assert.ok(sentSince(from).every((c) => c.origin === origin), 'nothing else was tried');
  } finally { delete process.env.OBSERVOGRAM_ADO_ORIGINS; }
});

// ---------- no leak ----------

test('no token or password reaches a log line, an answer, a URL, another header, a body or the live side, and every token went to its own host', () => {
  for (const [i, secret] of SECRETS.entries()) {
    assert.ok(!logs.some((l) => l.includes(secret)), `secret #${i + 1} never logged`);
    assert.ok(!answers.some((a) => a.text.includes(secret)), `secret #${i + 1} never answered`);
    assert.ok(!JSON.stringify(fake.calls).includes(secret), `secret #${i + 1} never in a call to the live side`);
  }
  assert.ok(fake.authHeaders.every((h) => h === null), 'the live side was sent no Authorization: its endpoint holds no key, and no person\'s token is passed on');
  assert.deepEqual(sent.filter((c) => c.elsewhere).map((c) => c.origin), [], 'no token in a URL, another header or a body');
  const hostOf = { github: ['https://api.github.com'], ado: ADO_ORIGIN ? [ADO_ORIGIN] : [] };
  const strays = sent.filter((c) => (c.token === 'github' || c.token === 'ado') && !hostOf[c.token].includes(c.origin));
  assert.deepEqual(strays.map((c) => c.origin), [], 'a real token only ever to its repository\'s host');
  assert.deepEqual(sent.filter((c) => c.token === 'another').map((c) => c.origin), [], 'no other Authorization was sent');
});
