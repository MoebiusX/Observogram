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
const { parseAdoUrl, adoHostRefusal, adoFetch, listedAdoOrigins } = await import('./ado-crawl.mjs');
const { fetchGithubFiles } = await import('./github-crawl.mjs');
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

test('adoFetch: the token as Basic only to an allowed host; 203 and 401 read as the token; the host\'s message on another error', async () => {
  const seen = [];
  const answer = (status, body, ct = 'application/json') => async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization ?? null, redirect: init.redirect });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': ct } });
  };
  const ok = await adoFetch('https://dev.azure.com/acme/Shop/_apis/git/repositories/c/items', { fetchImpl: answer(200, { value: [] }), token: 'pat-SECRET' });
  assert.deepEqual(ok, { value: [] });
  assert.equal(seen[0].auth, `Basic ${Buffer.from(':pat-SECRET').toString('base64')}`);
  assert.equal(seen[0].redirect, 'error', 'a redirect never carries the token elsewhere');
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(203, '<html>sign in</html>', 'text/html'), token: '' }),
    (e) => e.status === 401 && /sign-in needed — give your own Azure DevOps token \(a personal access token with Code \(Read\)\), or, on a server without sign-in, set AZURE_DEVOPS_TOKEN$/.test(e.message));
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(401, ''), token: 'pat-MINE', tokenSource: 'request' }),
    (e) => e.status === 401 && /your Azure DevOps token was refused \(it needs Code \(Read\) on this repository\)$/.test(e.message) && !e.message.includes('pat-MINE'));
  assert.equal(seen.at(-1).auth, `Basic ${Buffer.from(':pat-MINE').toString('base64')}`, 'their own token, as Basic');
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(401, ''), token: 'pat-SECRET' }),
    (e) => e.status === 401 && /the token in AZURE_DEVOPS_TOKEN was refused/.test(e.message) && !e.message.includes('pat-SECRET'));
  await assert.rejects(adoFetch('https://dev.azure.com/a/b/_apis/x', { fetchImpl: answer(404, { message: 'TF401019: The Git repository does not exist.' }), token: '' }),
    (e) => e.status === 404 && e.message === 'Azure DevOps 404: TF401019: The Git repository does not exist.');
  const before = seen.length;
  await assert.rejects(adoFetch('https://evil.test/a/b/_apis/x', { fetchImpl: answer(200, {}), token: 'pat-SECRET' }), (e) => e.status === 400 && /OBSERVOGRAM_ADO_ORIGINS/.test(e.message));
  assert.equal(seen.length, before, 'a refused host is never fetched');
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
  assert.deepEqual([ado.ref, ado.candidates, ado.skipped, ado.source], ['release', 2, [], 'Shop/checkout on Azure DevOps']);
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
  assert.deepEqual([gh.ref, Object.keys(gh.files), gh.source], ['develop', ['alerts/api.rules.yaml'], 'acme/shop on GitHub']);
  assert.deepEqual(api, ['/repos/acme/shop', '/repos/acme/shop/git/trees/develop?recursive=1'], 'two API calls — the contents come from raw');
  assert.deepEqual(raw, [['acme', 'shop', 'develop', 'alerts/api.rules.yaml']]);
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
    if (auth !== `Bearer ${MINE}`) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
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
