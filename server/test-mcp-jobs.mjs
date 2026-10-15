#!/usr/bin/env node
/**
 * server/test-mcp-jobs.mjs — the live MCP jobs (rebadge batch 3, C1; RULINGS
 * R1), in process over HTTP on one stand-alone identity server: acme {ada:
 * admin, oscar and olga: operators, vera: viewer}, four more orgs where ada
 * is an admin (the deployment's cap), plus the bearer token (an operator).
 *
 * What the routes do once the guard let them through (who may reach them in
 * each posture is test-authz's matrix; another org's job is test-tenancy's
 * sweep too): a start answers 202 with an id and a Location at once; the
 * gate log is read by a cursor (only records after `since`, `next`
 * monotonic); a snapshot that ends `done` has registered a pack labelled
 * `live: 'snapshot'` whose diff against a crawled repository pairs; a draft
 * job's canonical is POST /api/draft-from-mcp's byte for byte (the clocks
 * masked) and reads `live: 'scaffold'`; one running job per org, four in the
 * deployment; another member's job and another org's are the unknown-id
 * 404, but an admin of the org may cancel any (no gate log); a cancel, a
 * validation failure, a demotion during the job, the size cap and the
 * server stopping end the job with nothing registered and a live.fetch row
 * (the origin only); a label the other live kind holds is a 409; a finished
 * job expires 15 minutes after its end (an injected clock); an MCP that
 * echoes the token never gets it into a stage message, a JobView, a row, a
 * stderr line or the registered pack; the typed-URL rule (C0) and the
 * request checks; the configured snapshot scope, and a journey whose Pack B
 * is a snapshot saves it as a file.
 */

// Hermetic (§0): a developer shell's store, identity or per-org variables
// never reach this process's imports.
const { STRIP, signIn, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, resolve, relative, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-mcp-jobs-'));
const TOKEN = 'mcp-jobs-bearer-0123456789';
const READ_TOKEN = 'acme-read-token-JOBS-SECRET-42';
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_API_TOKEN = TOKEN;
process.env.OBSERVOGRAM_ORG_ACME_MCP_TOKEN = READ_TOKEN;
// acme's configured snapshot scope; bravo has none.
process.env.OBSERVOGRAM_ORG_ACME_SNAPSHOT_METRIC_PREFIXES = 'alertmanager_, up';

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const pw = (login) => `${login}-passw0rd-jobs`;
const LOGINS = ['ada', 'oscar', 'olga', 'vera'];
const ORGS = ['acme', 'bravo', 'charlie', 'delta', 'echo'];
writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(WORKSPACE, 'users.json'));
writeOrgsFile({
  default: { name: 'Default', members: { ada: 'admin' } },
  acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', olga: 'operator', vera: 'viewer' } },
  ...Object.fromEntries(ORGS.slice(1).map((o) => [o, { name: o, members: { ada: 'admin' } }])),
}, join(WORKSPACE, 'orgs.json'));

const { start } = await import('./index.mjs');
const { currentStore, closeStore } = await import('./store/db.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { getUserByLogin } = await import('./store/users.mjs');
const { setRole } = await import('./store/memberships.mjs');
const { setLiveJobSeams, abortAllLiveJobs, JOB_TTL_MS } = await import('./live-jobs.mjs');
const { startFakeMcp, registerMcpEndpoint } = await import('./fixtures/fake-mcp.mjs');
const { capabilityTool, candidateTool, probeCandidates, productAttestedByTool } = await import('../tools/lib/contracts/mcp-capabilities.mjs');
const { stagesFor } = await import('../tools/lib/live-fetch.mjs');
const { crawlFiles } = await import('../tools/lib/crawler.mjs');
const { emit: emitYaml } = await import('../tools/lib/mini-yaml.mjs');

// ---------- the fake: the recorded fixtures, the synthetic dashboards ----------

const FIXTURES = resolve(HERE, '..', 'tools', 'fixtures');
const recorded = (f) => JSON.parse(readFileSync(join(FIXTURES, 'mcp', f), 'utf8'));
const synthetic = (f) => JSON.parse(readFileSync(join(FIXTURES, 'snapshot', f), 'utf8'));
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
const T = {
  health: capabilityTool('system_health'),
  topology: capabilityTool('system_topology'),
  vmalert: nameOf(probeCandidates('alert_rules').find((c) => productAttestedByTool(nameOf(c)) === 'vmalert')),
  metricNames: nameOf(probeCandidates('metric_names')[0]),
  targets: nameOf(probeCandidates('scrape_configs')[0]),
  amStatus: nameOf(probeCandidates('alerting_routes')[0]),
  search: candidateTool('dashboards', 'search'),
  detail: capabilityTool('dashboard_detail'),
  grafanaHealth: capabilityTool('grafana_version'),
};
const SEARCH = synthetic('grafana_dashboards_search.json');
const DETAIL = synthetic('grafana_dashboard_get.json');
// A service name too long for an id, and no recorded rules to infer SLOs
// from instead: the built pack fails the schema.
const state = { longService: false };
const ANSWERS = {
  [T.health]: () => ({ services: state.longService ? [{ name: 'a'.repeat(300) }] : [] }),
  [T.topology]: () => ({ dependencies: [] }),
  [T.vmalert]: () => (state.longService ? { data: { groups: [] } } : recorded('vmalert_rules.json')),
  [T.metricNames]: () => (state.longService ? { data: [] } : recorded('metrics_label_values.json')),
  [T.targets]: () => recorded('metrics_targets.json'),
  [T.amStatus]: () => recorded('alertmanager_status.json'),
  [T.search]: () => ({ count: SEARCH.count, results: SEARCH.results }),
  [T.detail]: (args) => DETAIL.byUid[args.uid] ?? {},
  [T.grafanaHealth]: () => ({ version: '12.4.4', commit: 'synthetic', database: 'ok' }),
};
const answer = (name, args) => (ANSWERS[name] ? ANSWERS[name](args) : { ok: true });

const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
const db = currentStore();
const fakes = [];
after(async () => {
  setLiveJobSeams({ now: null, packBytes: null });
  for (const f of fakes) await f.close();
  await new Promise((ok) => srv.close(ok));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});
async function fake(opts) {
  const f = await startFakeMcp(Object.keys(ANSWERS), answer, opts);
  fakes.push(f);
  return f;
}

const cookies = {};
for (const login of LOGINS) {
  const s = await signIn(BASE, login, pw(login));
  assert.equal(s.status, 200, `${login} signs in`);
  cookies[login] = s.session;
}
const headersOf = (who, org = 'acme') => (who === 'bearer'
  ? { Authorization: `Bearer ${TOKEN}`, 'X-Observogram-Org': org }
  : { Cookie: cookies[who], 'X-Observogram-CSRF': '1', 'X-Observogram-Org': org });
async function call(method, path, who, body, org) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headersOf(who, org) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, location: r.headers.get('location') };
}
const startJob = (who, body, org) => call('POST', '/api/mcp/jobs', who, body, org);
const poll = (who, id, since = 0, org) => call('GET', `/api/mcp/jobs/${id}?since=${since}`, who, undefined, org);
const cancel = (who, id, org) => call('POST', `/api/mcp/jobs/${id}/cancel`, who, {}, org);
// Polls until the job ends; every record read, in order.
async function settle(who, id, org) {
  const records = [];
  let since = 0;
  for (let i = 0; i < 400; i++) {
    const r = await poll(who, id, since, org);
    assert.equal(r.status, 200, r.text);
    records.push(...r.json.stages);
    since = r.json.next;
    if (r.json.job.state !== 'running') return { ...r.json, records };
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error(`job ${id} did not end`);
}
const rowsOf = (org = 'acme', action = 'live.fetch') => listAudit(db, { orgId: org, limit: 1000 }).filter((r) => r.action === action);
const packsOf = async (org = 'acme', who = 'ada') => (await call('GET', '/api/packs', who, undefined, org)).json.packs;
// A canonical with its clocks masked (every annotation holding an instant)
// and without the catalogue's own __* keys (GET …/canonical adds them).
const masked = (canonical) => {
  const out = JSON.parse(JSON.stringify(canonical));
  for (const k of Object.keys(out)) if (k.startsWith('__')) delete out[k];
  for (const [k, v] of Object.entries(out.metadata.annotations)) if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(String(v))) out.metadata.annotations[k] = '<time>';
  return out;
};

const main = await fake();
const reg = await registerMcpEndpoint(BASE, { name: 'acme-gw', url: main.url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') });
assert.equal(reg.status, 201, reg.text);
const ENDPOINT = reg.id;
const JOBVIEW_KEYS = ['id', 'kind', 'state', 'cancelRequested', 'startedAt', 'finishedAt', 'elapsedMs', 'label', 'target', 'scope'];
const RECORD_KEYS = ['seq', 'stage', 'label', 'state', 'counts', 'startedAt', 'finishedAt', 'message', 'gap'];

let snapshotPackId = null;

test('GET /api/mcp/jobs: the org\'s configured scope (acme\'s own variable), nothing running, no last duration; another org has none', async () => {
  const r = await call('GET', '/api/mcp/jobs', 'oscar');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, {
    ok: true,
    scope: { defaults: { metricPrefixes: ['alertmanager_', 'up'], folderUids: [], datasourceUid: null }, from: 'org', errors: [] },
    running: null,
    lastTook: { snapshot: null, draft: null },
  });
  const bravo = await call('GET', '/api/mcp/jobs', 'ada', undefined, 'bravo');
  assert.deepEqual(bravo.json.scope, { defaults: { metricPrefixes: [], folderUids: [], datasourceUid: null }, from: null, errors: [] }, 'acme\'s variable is never bravo\'s');
});

test('a snapshot by id: 202, an id and a Location at once; the gate log by cursor; done registers a pack labelled snapshot; one live.fetch row with the origin', async () => {
  const rows = rowsOf().length;
  const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT });
  assert.equal(r.status, 202, r.text);
  const { job } = r.json;
  assert.deepEqual(Object.keys(job), JOBVIEW_KEYS);
  assert.match(job.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(r.location, `/api/mcp/jobs/${job.id}`);
  assert.equal(r.json.poll, r.location);
  assert.deepEqual([job.kind, job.state, job.cancelRequested, job.label], ['snapshot', 'running', false, null]);
  assert.deepEqual(job.target, { mcpEndpoint: { id: ENDPOINT, name: 'acme-gw' }, origin: main.origin });
  assert.deepEqual(job.scope, { metricPrefixes: ['alertmanager_', 'up'], folderUids: [], datasourceUid: null }, 'the configured scope');
  const end = await settle('oscar', job.id);
  assert.equal(end.job.state, 'done', end.error);
  assert.deepEqual(end.records.map((x) => x.seq), end.records.map((_, i) => i + 1), 'every record once, in order');
  for (const rec of end.records) assert.deepEqual(Object.keys(rec), RECORD_KEYS);
  const ids = stagesFor('snapshot').map((s) => s.id);
  const last = new Map(end.records.map((x) => [x.stage, x]));
  assert.deepEqual([...last.keys()].sort(), [...ids].sort(), 'every snapshot stage reported');
  assert.deepEqual([...last.values()].filter((x) => x.state !== 'done').map((x) => [x.stage, x.state]), [['alerting_routes', 'failed']],
    'every stage done but the routes, offered and unanswered');
  assert.equal(last.get('register').message, 'registered as live-snapshot (live MCP snapshot)');
  assert.equal(last.get('alerting_routes').gap.reason, 'the alerting routes tool got no answer: the Alertmanager status carries no configuration', 'the recorded status carries no configuration: a gap');
  const { result } = end;
  assert.deepEqual(result.registered.label, 'live-snapshot (live MCP snapshot)');
  assert.deepEqual(result.validation, { ok: true, errors: 0, first: [] });
  assert.ok(result.counts.dashboard === 5 && result.counts.alert_rule >= 2, JSON.stringify(result.counts));
  assert.deepEqual(result.gaps.map((g) => g.stage), ['alerting_routes']);
  assert.equal(end.job.label, 'live-snapshot (live MCP snapshot)');
  snapshotPackId = result.registered.id;
  const entry = (await packsOf()).find((p) => p.id === snapshotPackId);
  assert.equal(entry.live, 'snapshot');
  const added = rowsOf().slice(0, rowsOf().length - rows);
  assert.equal(added.length, 1);
  assert.deepEqual([added[0].actor, added[0].targetKind, added[0].targetId], ['oscar', 'live', main.origin]);
  assert.deepEqual(added[0].detail, {
    kind: 'snapshot', outcome: 'done', typed: false, mcpEndpoint: { id: ENDPOINT, name: 'acme-gw' }, jobId: job.id,
    packId: snapshotPackId, stages: { done: ids.length - 1, skipped: 0, failed: 1 }, gaps: ['alerting_routes'],
  });
  assert.ok(listAudit(db, { orgId: 'acme', limit: 50 }).some((x) => x.action === 'pack.register' && x.actor === 'oscar' && x.targetId === snapshotPackId), 'the pack\'s own row, by the starter');
  const status = await call('GET', '/api/mcp/jobs', 'oscar');
  assert.equal(status.json.running, null);
  assert.ok(Number.isInteger(status.json.lastTook.snapshot) && status.json.lastTook.draft === null);
});

test('the cursor: since returns only later records, next never goes back; a bad since is a 400', async () => {
  const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'cursor run' });
  const id = r.json.job.id;
  const end = await settle('oscar', id);
  const all = (await poll('oscar', id, 0)).json;
  assert.equal(all.stages.length, end.records.length);
  const mid = Math.floor(all.stages.length / 2);
  const later = (await poll('oscar', id, mid)).json;
  assert.deepEqual(later.stages.map((x) => x.seq), all.stages.slice(mid).map((x) => x.seq));
  assert.equal(later.next, all.next);
  const none = (await poll('oscar', id, all.next)).json;
  assert.deepEqual([none.stages, none.next], [[], all.next], 'nothing new: the same cursor');
  for (const bad of ['-1', 'x', '1.5']) assert.equal((await poll('oscar', id, bad)).status, 400, bad);
});

test('the snapshot pairs with a crawled repository: GET /api/diff inBoth > 0, every dashboard paired', async () => {
  assert.ok(snapshotPackId, 'the snapshot registered');
  const root = join(FIXTURES, 'snapshot', 'repo');
  const files = new Map();
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p); else files.set(relative(root, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  const repo = crawlFiles(files, { repoName: 'snapshot-repo', now: '2026-10-07T12:00:00.000Z' }).canonical;
  const up = await fetch(`${BASE}/api/validate?source=repo.yaml`, { method: 'POST', headers: { ...headersOf('oscar'), 'Content-Type': 'text/yaml' }, body: emitYaml(repo) });
  const repoId = (await up.json()).registered?.id;
  assert.ok(repoId, 'the crawled repository registers');
  const d = await call('GET', `/api/diff?a=${encodeURIComponent(repoId)}&b=${encodeURIComponent(snapshotPackId)}`, 'oscar');
  assert.equal(d.status, 200, d.text);
  const inBoth = Object.values(d.json.layers).flatMap((l) => l.inBoth);
  assert.ok(inBoth.length > 0, 'inBoth > 0');
  assert.equal(inBoth.filter((e) => e.key.startsWith('dashboard::')).length, 5, 'every dashboard pairs');
});

test('a draft job: its canonical is POST /api/draft-from-mcp\'s byte for byte (clocks masked), labelled scaffold, the draft summary in the result', async () => {
  const route = await call('POST', '/api/draft-from-mcp', 'oscar', { mcpEndpointId: ENDPOINT, label: 'route draft' });
  assert.equal(route.status, 200, route.text);
  const r = await startJob('oscar', { kind: 'draft', mcpEndpointId: ENDPOINT, label: 'job draft' });
  assert.equal(r.status, 202, r.text);
  const end = await settle('oscar', r.json.job.id);
  assert.equal(end.job.state, 'done', end.error);
  assert.ok(end.records.some((x) => x.stage === 'signals'), 'a draft reads the stack signals');
  assert.deepEqual(Object.keys(end.result.draft), ['summary', 'conformance', 'mcpEndpoint']);
  assert.equal(end.result.registered.label, 'job draft');
  const canonical = await call('GET', `/api/packs/${encodeURIComponent(end.result.registered.id)}/canonical`, 'oscar');
  assert.deepEqual(masked(canonical.json), masked(route.json.canonical), 'the job\'s canonical is the route\'s');
  const entry = (await packsOf()).find((p) => p.id === end.result.registered.id);
  assert.equal(entry.live, 'scaffold');
  assert.equal(rowsOf().at(0).detail.kind, 'draft');
  assert.ok(Number.isInteger((await call('GET', '/api/mcp/jobs', 'oscar')).json.lastTook.draft));
});

test('one running job per org (the starter is pointed at it, another member is not); the deployment runs four at most', async () => {
  const gate = main.hold(T.detail);
  const first = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT });
  assert.equal(first.status, 202, first.text);
  await gate.reached;
  const mine = await startJob('oscar', { kind: 'draft', mcpEndpointId: ENDPOINT });
  assert.equal(mine.status, 409);
  assert.match(mine.json.error, /^a live job is already running in acme \(started \d\d:\d\d UTC by you\) — follow it here$/);
  assert.deepEqual(mine.json.running, { id: first.json.job.id });
  const theirs = await startJob('olga', { kind: 'snapshot', mcpEndpointId: ENDPOINT });
  assert.equal(theirs.status, 409);
  assert.match(theirs.json.error, /^a live job is already running in acme \(started \d\d:\d\d UTC by another member\) — it ends within 10 minutes at most; an admin of acme can cancel it$/);
  assert.ok(!('running' in theirs.json), 'another member is not handed the id');
  assert.deepEqual((await call('GET', '/api/mcp/jobs', 'oscar')).json.running?.id, first.json.job.id, 'GET /api/mcp/jobs finds it for its starter');
  assert.equal((await call('GET', '/api/mcp/jobs', 'olga')).json.running, null, '…and not for another member');
  // Three more orgs fill the deployment; the fifth is refused.
  const started = [first.json.job.id];
  for (const org of ['bravo', 'charlie', 'delta']) {
    const f = await fake();
    const g = f.hold(T.detail);
    const id = (await registerMcpEndpoint(BASE, { name: `${org}-gw`, url: f.url }, { headers: headersOf('ada', org) })).id;
    const s = await startJob('ada', { kind: 'snapshot', mcpEndpointId: id }, org);
    assert.equal(s.status, 202, `${org}: ${s.text}`);
    await g.reached;
    started.push([org, s.json.job.id]);
  }
  const echoId = (await registerMcpEndpoint(BASE, { name: 'echo-gw', url: main.url }, { headers: headersOf('ada', 'echo') })).id;
  const fifth = await startJob('ada', { kind: 'snapshot', mcpEndpointId: echoId }, 'echo');
  assert.equal(fifth.status, 409);
  assert.equal(fifth.json.error, 'the server is already running 4 live jobs (its limit) — try again in a few minutes');
  for (const [org, id] of started.slice(1)) {
    assert.equal((await cancel('ada', id, org)).status, 200);
    assert.equal((await settle('ada', id, org)).job.state, 'cancelled');
  }
  assert.equal((await cancel('oscar', first.json.job.id)).status, 200);
  gate.release();
  assert.equal((await settle('oscar', first.json.job.id)).job.state, 'cancelled');
});

test('a job is its starter\'s: another member and another org get the unknown-id 404 on the log and the cancel; an admin of the org may cancel it, without the log', async () => {
  const gate = main.hold(T.detail);
  const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT });
  const id = r.json.job.id;
  await gate.reached;
  for (const [who, org] of [['olga', 'acme'], ['bearer', 'acme'], ['ada', 'bravo']]) {
    const read = await poll(who, id, 0, org);
    assert.equal(read.status, 404, `${who}@${org} read`);
    assert.equal(read.json.gone, true);
    assert.equal(read.json.error, `no live job ${id} for you in this org — it expired 15 minutes after it finished, or the server restarted (jobs run in its memory); a pack it registered is in the catalogue — otherwise start it again`);
    assert.ok(!('denied' in read.json));
  }
  assert.equal((await cancel('olga', id)).status, 404, 'an operator may not cancel another member\'s job');
  assert.equal((await cancel('ada', id, 'bravo')).status, 404, 'another org\'s admin may not either');
  const byAdmin = await cancel('ada', id);
  assert.equal(byAdmin.status, 200, byAdmin.text);
  assert.deepEqual(byAdmin.json, { ok: true, job: { id, state: 'running' } }, 'the admin gets the id and the state, never the log');
  gate.release();
  const end = await settle('oscar', id);
  assert.equal(end.job.state, 'cancelled');
  assert.equal((await poll('ada', id)).status, 404, 'the admin still cannot read it');
});

test('cancel mid-dashboards: cancelled, nothing registered, a live.fetch row saying so; a second cancel is a 409', async () => {
  const packs = (await packsOf()).length;
  const rows = rowsOf().length;
  const gate = main.hold(T.detail);
  const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'cancelled run' });
  const id = r.json.job.id;
  await gate.reached;
  const c = await cancel('oscar', id);
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(Object.keys(c.json.job), JOBVIEW_KEYS);
  assert.equal(c.json.job.cancelRequested, true);
  gate.release();
  const end = await settle('oscar', id);
  assert.equal(end.job.state, 'cancelled');
  assert.equal(end.error, 'cancelled — nothing was registered');
  assert.ok(!end.records.some((x) => x.stage === 'register'), 'no register stage');
  assert.equal((await packsOf()).length, packs, 'no pack');
  const row = rowsOf().slice(0, rowsOf().length - rows);
  assert.equal(row.length, 1);
  assert.deepEqual([row[0].detail.outcome, row[0].detail.packId, row[0].targetId], ['cancelled', null, main.origin]);
  const again = await cancel('oscar', id);
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'the job already finished (cancelled) — nothing to cancel');
});

test('a snapshot that fails the schema: failed, the count named, nothing registered, a row', async () => {
  const packs = (await packsOf()).length;
  state.longService = true;
  try {
    const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'invalid run' });
    const end = await settle('oscar', r.json.job.id);
    assert.equal(end.job.state, 'failed');
    assert.match(end.error, /^the snapshot failed schema validation \(\d+ errors?\) — nothing was registered$/);
    assert.equal(end.result.registered, null);
    assert.equal(end.result.validation.ok, false);
    assert.ok(end.result.validation.first.length >= 1);
    assert.equal(end.records.findLast((x) => x.stage === 'build').state, 'failed');
    assert.equal((await packsOf()).length, packs);
    assert.equal(rowsOf().at(0).detail.outcome, 'failed');
  } finally { state.longService = false; }
});

test('a member demoted to viewer during the job: failed, "your access changed", nothing registered', async () => {
  const packs = (await packsOf()).length;
  const oscar = getUserByLogin(db, 'oscar');
  const gate = main.hold(T.detail);
  const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'demoted run' });
  await gate.reached;
  setRole(db, 'ada', 'acme', oscar.id, 'viewer');
  try {
    gate.release();
    // The poll is an operator route: an admin reads nothing, so wait on the state through the registry's end row.
    for (let i = 0; i < 400 && !rowsOf().some((x) => x.detail.jobId === r.json.job.id); i++) await new Promise((ok) => setTimeout(ok, 25));
  } finally { setRole(db, 'ada', 'acme', oscar.id, 'operator'); }
  const end = await settle('oscar', r.json.job.id);
  assert.equal(end.job.state, 'failed');
  assert.equal(end.error, 'your access to acme changed during the job — nothing was registered');
  assert.equal(end.records.findLast((x) => x.stage === 'register').state, 'failed');
  assert.equal((await packsOf()).length, packs);
});

test('the size cap: a pack over the limit fails, naming the size, nothing registered', async () => {
  const packs = (await packsOf()).length;
  setLiveJobSeams({ packBytes: 2000 });
  try {
    const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'big run' });
    const end = await settle('oscar', r.json.job.id);
    assert.equal(end.job.state, 'failed');
    assert.match(end.error, /^the snapshot is \d+(\.\d)? (MB|bytes), over the 2000 bytes limit an upload may be — narrow the scope$/);
    assert.equal((await packsOf()).length, packs);
  } finally { setLiveJobSeams({ packBytes: null }); }
});

test('a label the other live kind holds is a 409 at start; the same kind replaces as before', async () => {
  const s = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'Payments prod' });
  assert.equal((await settle('oscar', s.json.job.id)).job.state, 'done');
  const r = await startJob('oscar', { kind: 'draft', mcpEndpointId: ENDPOINT, label: 'Payments prod' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'the label "Payments prod" is held by a snapshot; registering under it would replace it and carry its verdicts — choose another label');
  const d = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'job draft' });
  assert.equal(d.status, 409, 'a scaffold\'s label is refused to a snapshot');
  assert.match(d.json.error, /held by a scaffold draft/);
});

test('a finished job expires 15 minutes after it ended (the clock injected): the unknown-id 404', async () => {
  const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'expiring run' });
  const id = r.json.job.id;
  await settle('oscar', id);
  setLiveJobSeams({ now: () => Date.now() + JOB_TTL_MS - 60_000 });
  try {
    assert.equal((await poll('oscar', id)).status, 200, 'still there a minute before');
    setLiveJobSeams({ now: () => Date.now() + JOB_TTL_MS + 60_000 });
    const gone = await poll('oscar', id);
    assert.equal(gone.status, 404);
    assert.equal(gone.json.gone, true);
  } finally { setLiveJobSeams({ now: null }); }
});

test('the server stopping aborts a running job (what its close event calls): failed, saying so, nothing registered', async () => {
  assert.ok(srv.listeners('close').includes(abortAllLiveJobs), 'the server\'s close aborts the jobs');
  const gate = main.hold(T.detail);
  const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'stopped run' });
  await gate.reached;
  abortAllLiveJobs();
  gate.release();
  const end = await settle('oscar', r.json.job.id);
  assert.equal(end.job.state, 'failed');
  assert.equal(end.error, 'the server stopped during the job — nothing was registered');
});

test('an MCP that echoes the token: never in a stage message, a JobView, a row, a stderr line or the registered pack', async () => {
  const echo = await fake({ echo: 'tool' });
  const id = (await registerMcpEndpoint(BASE, { name: 'acme-echo', url: echo.url, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { headers: headersOf('ada') })).id;
  const write = process.stderr.write.bind(process.stderr);
  let said = '';
  process.stderr.write = (chunk, ...rest) => { said += String(chunk); return write(chunk, ...rest); };
  let end;
  let pack;
  try {
    const r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: id, label: 'echo run' });
    end = await settle('oscar', r.json.job.id);
    if (end.result?.registered) pack = await call('GET', `/api/packs/${encodeURIComponent(end.result.registered.id)}/canonical`, 'oscar');
  } finally { process.stderr.write = write; }
  assert.ok(end.records.some((x) => x.gap), 'the echoing tools are gaps');
  assert.ok(end.records.some((x) => /<redacted>/.test(x.gap?.reason ?? '')), 'the echoed token was redacted');
  for (const [what, text] of [['the log', JSON.stringify(end)], ['stderr', said], ['the rows', JSON.stringify(rowsOf())], ['the pack', pack?.text ?? '']]) {
    assert.ok(!text.includes(READ_TOKEN), `${what} holds no token`);
  }
});

test('the typed-URL rule and the request checks: operators and the bearer send ids only; kind, scope and the configured scope are checked; a viewer is refused by the guard', async () => {
  const before = main.authHeaders.length;
  let r = await startJob('oscar', { kind: 'snapshot', mcpUrl: main.url });
  assert.deepEqual([r.status, r.json.denied], [403, 'role']);
  r = await startJob('bearer', { kind: 'snapshot', mcpUrl: main.url });
  assert.deepEqual([r.status, r.json.denied], [403, 'role']);
  r = await startJob('vera', { kind: 'snapshot', mcpEndpointId: ENDPOINT });
  assert.deepEqual([r.status, r.json.denied], [403, 'role']);
  assert.equal(main.authHeaders.length, before, 'a refused start sends nothing');
  r = await startJob('oscar', { mcpEndpointId: ENDPOINT });
  assert.deepEqual([r.status, r.json.error], [400, 'kind is snapshot or draft (got null)']);
  r = await startJob('oscar', { kind: 'draft', mcpEndpointId: ENDPOINT, scope: { metricPrefixes: ['up'] } });
  assert.deepEqual([r.status, r.json.error], [400, 'scope applies to a snapshot; a draft reads every family as POST /api/draft-from-mcp does']);
  r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, scope: { metricPrefixes: ['1bad'] } });
  assert.deepEqual([r.status, r.json.error], [400, 'scope.metricPrefixes[0] "1bad" is not a metric-name prefix (letters, digits, _ and :, not starting with a digit)']);
  r = await startJob('oscar', { kind: 'snapshot' });
  assert.equal(r.status, 400);
  process.env.OBSERVOGRAM_ORG_ACME_SNAPSHOT_FOLDER_UIDS = 'bad uid';
  try {
    r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'the configured snapshot scope does not parse — OBSERVOGRAM_ORG_ACME_SNAPSHOT_FOLDER_UIDS[0] "bad uid" is not a folder uid (1–40 letters, digits, _ and -); fix the variable, or send a scope with the request');
    assert.deepEqual((await call('GET', '/api/mcp/jobs', 'oscar')).json.scope.errors, ['OBSERVOGRAM_ORG_ACME_SNAPSHOT_FOLDER_UIDS[0] "bad uid" is not a folder uid (1–40 letters, digits, _ and -)']);
    // A request's scope replaces the configured one whole.
    r = await startJob('oscar', { kind: 'snapshot', mcpEndpointId: ENDPOINT, scope: {}, label: 'request scope' });
    assert.equal(r.status, 202, r.text);
    assert.deepEqual(r.json.job.scope, { metricPrefixes: [], folderUids: [], datasourceUid: null });
    await settle('oscar', r.json.job.id);
  } finally { delete process.env.OBSERVOGRAM_ORG_ACME_SNAPSHOT_FOLDER_UIDS; }
});

test('the bearer starts and reads its own job by id; a session cannot read it; an admin\'s typed URL runs (typed: true on the row)', async () => {
  const r = await startJob('bearer', { kind: 'snapshot', mcpEndpointId: ENDPOINT, label: 'bearer run' });
  assert.equal(r.status, 202, r.text);
  assert.equal((await poll('oscar', r.json.job.id)).status, 404);
  assert.equal((await settle('bearer', r.json.job.id)).job.state, 'done');
  const typed = await startJob('ada', { kind: 'snapshot', mcpUrl: main.url, label: 'typed run' });
  assert.equal(typed.status, 202, typed.text);
  assert.equal(typed.json.job.target.mcpEndpoint, null);
  assert.equal((await settle('ada', typed.json.job.id)).job.state, 'done');
  assert.deepEqual([rowsOf().at(0).actor, rowsOf().at(0).detail.typed], ['ada', true]);
});

test('a journey whose Pack B is a snapshot saves it as a file, never as a live mcp: source', async () => {
  const packs = await packsOf();
  const repo = packs.find((p) => !p.live);
  const r = await call('POST', '/api/journeys/capture', 'oscar', { name: 'snapshot-journey', packAId: repo.id, packBId: snapshotPackId });
  assert.equal(r.status, 200, r.text);
  const def = readFileSync(join(WORKSPACE, 'orgs', 'acme', 'journeys', 'snapshot-journey.journey.yaml'), 'utf8');
  assert.match(def, /packB:\s*\n\s+file:/, 'Pack B is a file');
  assert.doesNotMatch(def, /mcp:/);
  assert.equal(listAudit(db, { orgId: 'acme', limit: 5 }).find((x) => x.action === 'journey.capture').detail.live, false);
});
