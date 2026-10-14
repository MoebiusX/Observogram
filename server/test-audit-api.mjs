#!/usr/bin/env node
/**
 * server/test-audit-api.mjs — GET /api/audit, the audit reader (docs/
 * STORE_PLAN.md §5, slice 5, design §5), in-process over HTTP on one
 * stand-alone identity server, as test-services-api.mjs does.
 *
 * The scope by principal (an org admin reads the rows with its org's id
 * and may ask for nothing else; an owner reads the deployment's — every
 * org's and the deployment's in one sequence, the context org's with
 * scope=org, the rows with no org with scope=deployment); every refusal of
 * design §5.5 with its exact text and no new row; the org selector
 * attacked from this route (a header or ?org= naming an org the caller is
 * not in is the org middleware's 403, a dual-membership user is read by
 * the context org's role, the bearer is refused as an operator, and ?org=
 * is never a filter); every filter and their AND; paging that is exact
 * (follow `next` to the end: the concatenation is the repository's own
 * listing, no duplicate, no gap) at the 500 cap too, where an API cap
 * equal to the repository's clamp would have lied; the row view's eight
 * fields and nothing else. Then the slice's rows end to end by an
 * operator whose user row carries an email: the capture, the run, a deploy
 * to an unreachable MCP (502), the verify — each its exact row by the
 * LOGIN, never the email, and the deploys.jsonl line saying the same; the
 * bounded verify outcome; the refusals writing none; `auditError` when the
 * insert fails (a blocking trigger) while the file write stands;
 * `fileError` on the row when the deploys.jsonl append failed while the
 * row stands — the deploy's with the file a directory, the verify's 500
 * with the append itself faulted (the verify reads the file first, so a
 * directory is its 404); the repository's size guard; the journey run's 502 row
 * (outcome error, never the error's text); a non-member owner's actor
 * shown to the org's admin as is (design D6); the structural guard over
 * the slice's rows (no URL beyond an origin, no email).
 *
 * Who may reach the route in each posture is test-authz's (the AuthZ
 * matrix) and the per-org split under the cross-org sweep is
 * test-tenancy's; this suite is what the route answers once reached.
 *
 * The fixture is test-services-api's — default {olive: admin} (an owner),
 * acme {ada: admin, oscar: operator, vera: viewer}, bravo {bob: admin} —
 * plus mia, admin in bravo and (joined after, from a shell) viewer in
 * acme, and an email on oscar before he signs in: every other fixture
 * user has none and a local `sub` equals the login, so without it the
 * actor rule (the login, never `session.email || session.sub`) would be
 * unprovable here.
 */

// Hermetic (§0): a developer shell's store, identity or per-org token
// variables never reach this process's imports. serve-child.mjs imports no
// server code.
const { STRIP, signIn, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync } = await import('node:fs');
const fs = (await import('node:fs')).default;
const { syncBuiltinESMExports } = await import('node:module');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { setTimeout: sleep } = await import('node:timers/promises');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-audit-api-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');

const pw = (login) => `${login}-passw0rd-audit`;
const LOGINS = ['olive', 'ada', 'oscar', 'vera', 'bob', 'mia'];
writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(WORKSPACE, 'users.json'));
writeOrgsFile({
  default: { name: 'Default', members: { olive: 'admin' } },
  acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer' } },
  bravo: { name: 'Bravo', members: { bob: 'admin', mia: 'admin' } },
}, join(WORKSPACE, 'orgs.json'));

const { start } = await import('./index.mjs');
const { currentStore, closeStore, execScript, prepare } = await import('./store/db.mjs');
const { appendAudit, listAudit, DETAIL_MAX } = await import('./store/audit.mjs');
const { getUserByLogin, updateUserProfile } = await import('./store/users.mjs');
const { addMemberByLogin } = await import('./identity-admin.mjs');
const { routeEntry } = await import('./route-table.mjs');
const { LIMIT_MAX, WAYS } = await import('./audit-admin.mjs');

const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
const db = currentStore();

after(async () => {
  await new Promise((resolve) => srv.close(resolve));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

// The fixture's two additions (actor cli / system, as the shells write them):
// mia joins acme as a viewer AFTER bravo (her first membership stays bravo,
// where she is admin); oscar's user row carries a verified email.
addMemberByLogin(db, 'cli', { orgId: 'acme', arg: 'mia', role: 'viewer' });
const EMAIL = 'oscar@acme.test';
updateUserProfile(db, 'system', getUserByLogin(db, 'oscar').id, { email: EMAIL, emailVerified: true });

const cookies = {};
for (const login of LOGINS) {
  const s = await signIn(BASE, login, pw(login));
  assert.equal(s.status, 200, `${login} signs in: ${JSON.stringify(s.json)}`);
  assert.ok(s.session, `${login} gets a session`);
  cookies[login] = s.session;
}

// ---------- requests and the audit trail ----------

const CSRF = { 'X-Observogram-CSRF': '1' };
const TOKEN = 'audit-api-bearer-token-0123456789';

// One request as `who` (a login whose cookie is held, or 'bearer'):
// { status, json, text }. olive, an owner with no acme membership, names
// acme (else her default org); `extra` headers win.
async function call(who, method, path, body, extra = {}) {
  const identity = who === 'bearer' ? { Authorization: `Bearer ${TOKEN}`, 'X-Observogram-Org': 'acme' } : { Cookie: cookies[who] };
  const headers = { Accept: 'application/json', ...CSRF, ...identity, ...(who === 'olive' ? { 'X-Observogram-Org': 'acme' } : {}), ...extra };
  for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];   // an `extra` of undefined drops a header
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}

// `fn` with everything the in-process server writes to this process's
// stdout or stderr meanwhile, passed through: { result, output }.
async function logged(fn) {
  const streams = [process.stdout, process.stderr];
  const writes = streams.map((s) => s.write);
  let output = '';
  for (const s of streams) {
    const write = s.write;
    s.write = function (chunk, ...rest) {
      output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return write.call(this, chunk, ...rest);
    };
  }
  try {
    return { result: await fn(), output };
  } finally {
    streams.forEach((s, i) => { s.write = writes[i]; });
  }
}

const seqNow = () => prepare(db, 'SELECT coalesce(max(seq), 0) AS s FROM audit').get().s;
// The rows after `seq`: [action, actor, org, target, detail].
const rowsAfter = (seq) => prepare(db, 'SELECT org_id, actor, action, target_id, detail FROM audit WHERE seq > ? ORDER BY seq').all(seq)
  .map((r) => [r.action, r.actor, r.org_id, r.target_id, r.detail === null ? null : JSON.parse(r.detail)]);

// A GET or a DELETE sends no body: its helpers take (key, who, path, …) and
// the rest shifts.
const noBody = (method) => method === 'GET' || method === 'DELETE';

// A call of route `key` that reached its write: its status (`ok` true below
// 400, false from 400 on — a 502 deploy is an attempt, with its row), and
// the rows it wrote — each an action the route table lists for the route.
async function ok(key, who, path, body, status, extra = {}) {
  const { method } = routeEntry(key);
  if (noBody(method)) [body, status] = [undefined, body];
  const seq = seqNow();
  const r = await call(who, method, path, body, extra);
  assert.equal(r.status, status ?? 200, `${key} as ${who}: ${r.text.slice(0, 300)}`);
  assert.equal(r.json.ok, (status ?? 200) < 400, `${key} as ${who}: ok`);
  const rows = rowsAfter(seq);
  const listed = routeEntry(key).audit;
  assert.deepEqual(rows.map(([action]) => action).filter((a) => !listed.includes(a)), [], `${key}: rows the route table does not list`);
  return { json: r.json, rows };
}

// A refusal: exactly { ok: false, error } at `status`, and no row.
async function refused(key, who, path, body, status, error) {
  const { method } = routeEntry(key);
  if (noBody(method)) [body, status, error] = [undefined, body, status];
  const seq = seqNow();
  const r = await call(who, method, path, body);
  assert.deepEqual([r.status, r.json], [status, { ok: false, error }], `${key} ${path} ${JSON.stringify(body)}`);
  assert.deepEqual(rowsAfter(seq), [], `${key}: a refusal writes no row`);
}

// The listing as `who`, with a query string and extra headers.
const list = (who, query = '', extra = {}) => call(who, 'GET', `/api/audit${query}`, undefined, extra);
const seqs = (r) => r.json.rows.map((x) => x.seq);
const ROW_KEYS = ['seq', 'at', 'orgId', 'actor', 'action', 'targetKind', 'targetId', 'detail'];

// Every row of a listing, following `next` page by page: each page but the
// last is full and says the seq of its last row; the last says null.
async function follow(who, query, limit) {
  const out = [];
  let before = null;
  for (let pages = 0; pages < 1000; pages++) {
    const r = await list(who, `${query}&limit=${limit}${before === null ? '' : `&before=${before}`}`);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.json.limit, limit);
    assert.ok(r.json.rows.length <= limit, 'never more than limit');
    out.push(...r.json.rows);
    if (r.json.next === null) break;
    assert.equal(r.json.rows.length, limit, 'a page with a next is full');
    assert.equal(r.json.next, r.json.rows[r.json.rows.length - 1].seq, 'next is the last row\'s seq');
    before = r.json.next;
  }
  return out;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEMO_YAML = readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');
const YAML = { 'Content-Type': 'text/yaml' };
const ACME_DIR = join(WORKSPACE, 'orgs', 'acme');
const DEPLOYS = join(ACME_DIR, 'deploys.jsonl');
const NO_MCP = 'http://127.0.0.1:1/no-mcp';

// Planted rows, through the store handle: [org, actor, action, targetKind, targetId, detail].
const PLANT = [
  ['acme', 'p-ada', 'x.one', 'plant', 't1', { n: 1 }],
  ['acme', 'p-bob', 'x.two', 'plant', 't2', { n: 2 }],
  ['acme', 'p-ada', 'y.one', 'plant', 't3', null],
  ['acme', 'p-cli', 'x.one', 'plant2', 't1', { n: 4 }],
  ['bravo', 'p-bob', 'x.one', 'plant', 't5', { n: 5 }],
  ['bravo', 'p-mia', 'y.one', 'plant', 't6', { n: 6 }],
  // — a pause here: the rows below are later than T, the first one's `at` —
  ['bravo', 'p-bob', 'x.two', 'plant', 't7', null],
  [null, 'p-sys', 'x.one', 'plant', 't8', { n: 8 }],
  [null, 'p-sys', 'y.one', 'plant2', 't9', null],
  [null, 'p-cli', 'x.two', 'plant', 't10', { n: 10 }],
  ['acme', 'p-mia', 'mcp_endpoint.create', 'plant', 't11', { n: 11 }],
  ['acme', 'p-mia', 'mcp_endpointx.create', 'plant', 't12', { n: 12 }],
];
const planted = [];   // the rows as appendAudit returned them, in PLANT order
let T = null;         // the `at` of the seventh row
const plantedSeq = (i) => planted[i - 1].seq;   // 1-based, as the comments count
const ids = {};

// ---------- 1. planted rows ----------

test('planted rows: twelve through the store handle, across acme, bravo and the deployment, in two instants', async () => {
  for (let i = 0; i < PLANT.length; i++) {
    if (i === 6) await sleep(25);
    const [orgId, actor, action, targetKind, targetId, detail] = PLANT[i];
    const row = appendAudit(db, actor, { orgId, action, targetKind, targetId, detail });
    planted.push(row);
    if (i === 6) T = row.at;
  }
  assert.equal(planted.length, 12);
  assert.ok(ISO.test(T), 'T is an ISO time');
  assert.ok(planted.slice(0, 6).every((r) => r.at < T), 'the first six rows are before T');
  assert.ok(planted.slice(6).every((r) => r.at >= T), 'the last six rows are at or after T');
});

// ---------- 2. the scope by principal ----------

test('scope by principal: an admin reads its org (scope org); an owner the deployment (scope all), or one org, or the rows with no org', async () => {
  const seq = seqNow();
  let r = await list('ada');
  assert.deepEqual([r.status, r.json.ok, r.json.scope, r.json.org, r.json.limit, r.json.next], [200, true, 'org', 'acme', 100, null], 'ada: one page of acme');
  assert.ok(r.json.rows.length >= 6 && r.json.rows.every((x) => x.orgId === 'acme'), 'ada: every row is acme\'s, none the deployment\'s, none bravo\'s');
  for (const i of [1, 2, 3, 4, 11, 12]) assert.ok(seqs(r).includes(plantedSeq(i)), `ada sees planted row ${i}`);
  for (const i of [5, 6, 7, 8, 9, 10]) assert.ok(!seqs(r).includes(plantedSeq(i)), `ada does not see planted row ${i}`);
  assert.deepEqual(seqs(r), [...seqs(r)].sort((a, b) => b - a), 'newest first');

  r = await list('bob');
  assert.deepEqual([r.status, r.json.scope, r.json.org], [200, 'org', 'bravo']);
  assert.deepEqual(seqs(r), [plantedSeq(7), plantedSeq(6), plantedSeq(5)], 'bob: bravo\'s three rows, nothing else');

  r = await list('olive');
  assert.deepEqual([r.status, r.json.scope, r.json.org], [200, 'all', null], 'olive, an owner: everything');
  for (let i = 1; i <= 12; i++) assert.ok(seqs(r).includes(plantedSeq(i)), `olive sees planted row ${i}`);
  assert.ok(r.json.rows.some((x) => x.orgId === null && x.action === 'user.update' && x.targetId === 'oscar'), 'olive sees the deployment\'s own rows (oscar\'s email, a user.update)');

  r = await list('olive', '?scope=org');
  assert.deepEqual([r.status, r.json.scope, r.json.org], [200, 'org', 'acme'], 'olive scope=org: the context org, acme');
  assert.ok(r.json.rows.length > 0 && r.json.rows.every((x) => x.orgId === 'acme'));

  r = await list('olive', '?scope=deployment');
  assert.deepEqual([r.status, r.json.scope, r.json.org], [200, 'deployment', null]);
  assert.ok(r.json.rows.length >= 3 && r.json.rows.every((x) => x.orgId === null), 'olive scope=deployment: the rows with no org only');
  for (const i of [8, 9, 10]) assert.ok(seqs(r).includes(plantedSeq(i)), `olive sees deployment row ${i}`);

  r = await list('olive', '?scope=org', { 'X-Observogram-Org': 'bravo' });
  assert.deepEqual([r.status, r.json.scope, r.json.org, seqs(r)], [200, 'org', 'bravo', [plantedSeq(7), plantedSeq(6), plantedSeq(5)]], 'olive naming bravo: bravo\'s rows');
  assert.equal(seqNow(), seq, 'the reads wrote no row');
});

// ---------- 3. the refusals ----------

test('refusals: an admin asking for the deployment, every malformed parameter, and the guard below admin — each its text, none a row', async () => {
  const seq = seqNow();
  const bad = async (who, query, error) => {
    const r = await list(who, query);
    assert.deepEqual([r.status, r.json], [400, { ok: false, error }], `${who} GET /api/audit${query}`);
  };
  const ownersOnly = "the deployment's audit (scope=deployment, scope=all) is an owner's: as an admin of org 'acme' you read its rows (scope=org, the default) — drop scope, or ask an owner";
  assert.equal(WAYS.ownersOnly('acme'), ownersOnly);
  await bad('ada', '?scope=all', ownersOnly);
  await bad('ada', '?scope=deployment', ownersOnly);
  await bad('bob', '?scope=all', ownersOnly.replace("'acme'", "'bravo'"));
  for (const who of ['ada', 'olive']) {
    await bad(who, '?scope=everything', 'scope is org, deployment or all');
    await bad(who, '?scope=ORG', 'scope is org, deployment or all');
    for (const v of ['0', '501', '1000', '-1', '1.5', 'abc', '1e2', '01']) await bad(who, `?limit=${v}`, 'limit must be an integer from 1 to 500');
    await bad(who, '?limit=1&limit=2', 'limit must be an integer from 1 to 500');
    for (const v of ['0', '-1', 'x', '1.5', '9007199254740993']) await bad(who, `?before=${v}`, 'before must be a positive integer — the next value of the previous page');
    for (const v of ['yesterday', '2026-13-01', '2026-02-30', '2026-10-04T09:00', '2026-10-04T09:00:00', '2026-10-04 09:00:00Z', '2026-10-04T09:00:00+02:00']) {
      await bad(who, `?since=${encodeURIComponent(v)}`, 'since must be a date or a UTC time: 2026-10-04 or 2026-10-04T09:00:00Z');
      await bad(who, `?until=${encodeURIComponent(v)}`, 'until must be a date or a UTC time: 2026-10-04 or 2026-10-04T09:00:00Z');
    }
    await bad(who, '?since=2026-10-04&until=2026-10-04', 'since must be before until');
    await bad(who, '?since=2026-10-04T10:00:00Z&until=2026-10-04', 'since must be before until');
    for (const v of ['deploy', 'Deploy.run', 'deploy.', 'deploy run', 'deploy.run;', 'deploy..run', 'mcp_endpoint.Create']) {
      await bad(who, `?action=${encodeURIComponent(v)}`, 'action must be <kind>.<verb>, lower case, e.g. deploy.run or mcp_endpoint.create');
    }
    for (const v of ['deploy.run', 'Deploy', 'mcp-endpoint', 'x_', '_x', 'a%']) await bad(who, `?kind=${encodeURIComponent(v)}`, 'kind must be a lower-case word, e.g. deploy, pack or mcp_endpoint');
    await bad(who, `?actor=${'a'.repeat(201)}`, 'actor must be 1–200 characters');
    await bad(who, `?targetId=${'a'.repeat(201)}`, 'targetId must be 1–200 characters');
    await bad(who, `?targetKind=${'a'.repeat(101)}`, 'targetKind must be 1–100 characters');
    await bad(who, '?actor=a&actor=b', 'actor must be 1–200 characters');
  }
  // An empty value is "not given"; an unknown parameter is ignored.
  let r = await list('ada', '?actor=&scope=&limit=&nonsense=1');
  assert.deepEqual([r.status, r.json.scope, r.json.limit], [200, 'org', 100]);
  // Below admin: the guard's refusal, not the route's.
  for (const who of ['vera', 'oscar']) {
    r = await list(who);
    assert.deepEqual([r.status, r.json.denied, r.json.error, r.json.need],
      [403, 'role', `requires the admin role in org 'acme' (you are ${who === 'vera' ? 'viewer' : 'operator'}) — ask an admin of acme`, 'admin'], who);
  }
  assert.equal(seqNow(), seq, 'no GET wrote a row');
});

// ---------- 3b. the org selector attacked from this route ----------

test('the org selector: a header or ?org= naming another org is the org middleware\'s 403; a dual membership reads by the context org\'s role; the bearer is an operator; ?org= is never a filter', async () => {
  const seq = seqNow();
  let r = await list('ada', '', { 'X-Observogram-Org': 'bravo' });
  assert.deepEqual([r.status, r.json], [403, { ok: false, error: "not a member of org 'bravo'", denied: 'org' }], 'ada naming bravo by header');
  r = await list('ada', '?org=bravo');
  assert.deepEqual([r.status, r.json], [403, { ok: false, error: "not a member of org 'bravo'", denied: 'org' }], 'ada naming bravo by ?org=');
  r = await list('mia');
  assert.deepEqual([r.status, r.json.scope, r.json.org, seqs(r)], [200, 'org', 'bravo', [plantedSeq(7), plantedSeq(6), plantedSeq(5)]], 'mia, no header: bravo (her first membership), where she is admin');
  r = await list('mia', '', { 'X-Observogram-Org': 'acme' });
  assert.deepEqual([r.status, r.json.denied, r.json.error], [403, 'role', "requires the admin role in org 'acme' (you are viewer) — ask an admin of acme"], 'mia in acme: a viewer');
  // The bearer (the token set for this block only): an operator, refused
  // by the guard with the bearer text and no NO_SIGN_IN_WAY suffix (the
  // identity posture).
  process.env.OBSERVOGRAM_API_TOKEN = TOKEN;
  process.env.OBSERVOGRAM_API_TOKEN_LABEL = 'ci-bot';
  try {
    r = await list('bearer');
    assert.deepEqual([r.status, r.json.denied, r.json.error, r.json.role],
      [403, 'role', "the bearer token acts as an operator in org 'acme'; the admin role needs a signed-in user with that role", 'operator']);
  } finally {
    delete process.env.OBSERVOGRAM_API_TOKEN;
    delete process.env.OBSERVOGRAM_API_TOKEN_LABEL;
  }
  // olive: ?org= picks the context org (as the header does); scope=org
  // reads it; without scope the owner's default, all, stands — bravo's
  // rows are present (?org= filtered nothing).
  r = await list('olive', '?org=acme&scope=org', { 'X-Observogram-Org': undefined });
  assert.deepEqual([r.status, r.json.scope, r.json.org], [200, 'org', 'acme']);
  assert.ok(r.json.rows.every((x) => x.orgId === 'acme'));
  r = await call('olive', 'GET', '/api/audit?org=acme', undefined, { 'X-Observogram-Org': undefined });
  assert.deepEqual([r.status, r.json.scope, r.json.org], [200, 'all', null], 'olive ?org=acme without scope: all');
  assert.ok(r.json.rows.some((x) => x.orgId === 'bravo') && r.json.rows.some((x) => x.orgId === null), '?org= is the selector, not a filter');
  r = await list('olive', '?org=bravo&scope=org', { 'X-Observogram-Org': undefined });
  assert.deepEqual([r.status, r.json.scope, r.json.org, seqs(r)], [200, 'org', 'bravo', [plantedSeq(7), plantedSeq(6), plantedSeq(5)]], 'olive ?org=bravo&scope=org');
  r = await list('olive', '?org=nope&scope=org', { 'X-Observogram-Org': undefined });
  assert.deepEqual([r.status, r.json], [403, { ok: false, error: "unknown org 'nope'", denied: 'org' }], 'an owner naming no live org');
  assert.equal(seqNow(), seq, 'no GET wrote a row');
});

// ---------- 4. the filters ----------

test('filters: actor, action, kind (a prefix — _ is literal), targetKind, targetId, since / until by the planted rows\' own at, and their AND', async () => {
  const seq = seqNow();
  const got = async (who, query) => {
    const r = await list(who, query);
    assert.equal(r.status, 200, `${who} ${query}: ${r.text.slice(0, 200)}`);
    return seqs(r);
  };
  const want = (...is) => is.map(plantedSeq).sort((a, b) => b - a);
  assert.deepEqual(await got('ada', '?actor=p-ada'), want(1, 3));
  assert.deepEqual(await got('ada', '?action=x.one'), want(1, 4));
  assert.deepEqual(await got('ada', '?kind=x'), want(1, 2, 4), 'kind=x: x.one and x.two, never y.one');
  assert.deepEqual(await got('ada', '?kind=y'), want(3));
  assert.deepEqual(await got('ada', '?kind=mcp_endpoint'), want(11), 'kind=mcp_endpoint: not mcp_endpointx.create — the _ is literal, the dot is the boundary');
  assert.deepEqual(await got('ada', '?kind=mcp_endpointx'), want(12));
  assert.deepEqual(await got('ada', '?kind=mcp'), [], 'kind=mcp matches no mcp_endpoint.* action');
  assert.deepEqual(await got('ada', '?targetKind=plant2'), want(4));
  assert.deepEqual(await got('ada', '?targetId=t1'), want(1, 4));
  assert.deepEqual(await got('ada', '?targetId=t5'), [], 'bravo\'s t5 is not acme\'s');
  assert.deepEqual(await got('ada', `?targetKind=plant&since=${T}`), want(11, 12), 'since T: the rows at or after T');
  assert.deepEqual(await got('ada', `?targetKind=plant&until=${T}`), want(1, 2, 3), 'until T: the rows before T');
  assert.deepEqual(await got('ada', `?targetKind=plant&since=${T.slice(0, 10)}`), want(1, 2, 3, 11, 12), 'since a date: midnight UTC');
  assert.deepEqual(await got('olive', `?scope=deployment&targetKind=plant&since=${T}`), want(8, 10));
  assert.deepEqual(await got('olive', `?targetKind=plant&until=${T}`), want(1, 2, 3, 5, 6), 'the owner\'s all, until T');
  assert.deepEqual(await got('ada', '?actor=p-ada&kind=x'), want(1), 'filters AND');
  assert.deepEqual(await got('ada', '?actor=p-mia&kind=mcp_endpoint&targetId=t11'), want(11));
  assert.deepEqual(await got('ada', '?actor=p-mia&kind=x'), []);
  assert.deepEqual(await got('bob', '?actor=p-bob&action=x.two'), want(7));
  assert.deepEqual(await got('bob', '?actor=p-ada'), [], 'an actor of acme\'s rows: nothing in bravo');
  assert.equal(seqNow(), seq, 'no GET wrote a row');
});

// ---------- 5. paging ----------

test('paging is exact: follow next to the end and the concatenation is the repository\'s listing; at the cap of 500 a full page says next, the rest follows', async () => {
  const seq = seqNow();
  const acme = listAudit(db, { orgId: 'acme', limit: 1000 });
  assert.ok(acme.length >= 7 && acme.length < 1000, `acme has ${acme.length} rows`);
  const paged = await follow('ada', '?scope=org', 3);
  assert.deepEqual(paged.map((x) => x.seq), acme.map((x) => x.seq), 'limit=3: the same seqs in the same order, no duplicate, no gap');
  assert.deepEqual(paged, acme.map((x) => ({ ...x })), 'the rows as the repository returns them');
  let r = await list('ada', '?limit=500');
  assert.deepEqual([r.json.rows.length, r.json.next], [acme.length, null], 'limit=500 on acme\'s few rows: one page, no more');
  r = await list('ada', `?before=${acme[acme.length - 1].seq}`);
  assert.deepEqual([r.status, r.json.rows, r.json.next], [200, [], null], 'before the first row: nothing, and no more');
  r = await list('ada', `?limit=${LIMIT_MAX + 1}`);
  assert.deepEqual([r.status, r.json.error], [400, 'limit must be an integer from 1 to 500']);

  // The cap: 502 rows planted in bravo (cheap, through the handle), so the
  // org holds more than one full page.
  for (let i = 0; i < 502; i++) appendAudit(db, 'p-bulk', { orgId: 'bravo', action: 'bulk.plant', targetKind: 'bulk', targetId: String(i), detail: null });
  const bravo = listAudit(db, { orgId: 'bravo', limit: 1000 });
  assert.ok(bravo.length > 500 && bravo.length < 1000, `bravo has ${bravo.length} rows`);
  r = await list('bob', '?limit=500');
  assert.deepEqual([r.status, r.json.rows.length, r.json.next], [200, 500, bravo[499].seq], 'a full page of 500 with a next');
  const second = await list('bob', `?limit=500&before=${r.json.next}`);
  assert.deepEqual([second.status, second.json.rows.length, second.json.next], [200, bravo.length - 500, null], 'the second page holds the rest and ends');
  assert.deepEqual([...seqs(r), ...seqs(second)], bravo.map((x) => x.seq), 'both pages: the repository\'s listing');
  const all = await follow('bob', '?scope=org', 500);
  assert.deepEqual(all.map((x) => x.seq), bravo.map((x) => x.seq));
  const filtered = await follow('bob', '?scope=org&action=bulk.plant', 100);
  assert.deepEqual(filtered.map((x) => x.targetId), Array.from({ length: 502 }, (_, i) => String(501 - i)), 'before composes with a filter');
  const owner = await follow('olive', '?scope=all', 250);
  assert.deepEqual(owner.map((x) => x.seq), listAudit(db, { limit: 1000 }).map((x) => x.seq), 'the owner\'s all, paged');
  assert.equal(seqNow(), seq + 502, 'the reads wrote nothing (the 502 planted rows aside)');
});

// ---------- 6. the row view ----------

test('the row view: exactly the eight named fields; detail is parsed JSON or null', async () => {
  const r = await list('olive', '?scope=all&limit=500');
  assert.ok(r.json.rows.length === 500 && r.json.next !== null, 'the first of several pages (bravo holds the 502 rows)');
  for (const row of r.json.rows) {
    assert.deepEqual(Object.keys(row), ROW_KEYS, `row ${row.seq}: the named fields only`);
    assert.ok(Number.isInteger(row.seq) && row.seq > 0 && ISO.test(row.at), 'seq and at');
    assert.ok(row.orgId === null || typeof row.orgId === 'string');
    assert.ok(typeof row.actor === 'string' && typeof row.action === 'string');
    assert.ok(row.detail === null || (typeof row.detail === 'object' && !Array.isArray(row.detail)), `row ${row.seq}: detail parsed`);
  }
  assert.deepEqual(Object.keys(r.json), ['ok', 'scope', 'org', 'limit', 'rows', 'next'], 'the response shape');
  const acme = await list('ada', '?limit=500');
  const byPlant = Object.fromEntries(acme.json.rows.map((x) => [x.seq, x]));
  assert.deepEqual(byPlant[plantedSeq(1)], { ...planted[0] }, 'a planted row, as appendAudit returned it');
  assert.deepEqual(byPlant[plantedSeq(3)].detail, null);
  assert.deepEqual(byPlant[plantedSeq(3)], { ...planted[2] });
});

// ---------- 8. the slice's rows end to end, by oscar in acme ----------

test('the slice\'s rows by oscar (an operator with an email): the register, the capture, the run, a 502 deploy, the verify — each by the login, never the email, in the row and in deploys.jsonl', async () => {
  const reg = await ok('POST /api/validate', 'oscar', '/api/validate', DEMO_YAML, 200, YAML);
  ids.pack = reg.json.registered.id;
  assert.ok(ids.pack, 'the pack registered');
  assert.ok(reg.rows.some(([action, actor]) => action === 'pack.register' && actor === 'oscar'), 'pack.register by oscar');

  const cap = await ok('POST /api/journeys/capture', 'oscar', '/api/journeys/capture', { name: 'audit-j', packAId: ids.pack, packBId: ids.pack });
  assert.ok(!('auditError' in cap.json), 'no auditError');
  assert.deepEqual(cap.rows, [['journey.capture', 'oscar', 'acme', 'audit-j', { packA: ids.pack, packB: ids.pack, live: false, env: null, service: null, scopeMode: null }]]);

  const run = await ok('POST /api/journeys/:name/run', 'oscar', '/api/journeys/audit-j/run', {});
  assert.ok(!('auditError' in run.json));
  assert.equal(run.rows.length, 1, 'one journey.run row');
  const [action, actor, org, target, detail] = run.rows[0];
  assert.deepEqual([action, actor, org, target], ['journey.run', 'oscar', 'acme', 'audit-j']);
  assert.deepEqual(Object.keys(detail), ['startedAt', 'outcome', 'alignmentPct', 'gradeScore', 'gradePass', 'breaches', 'tookMs']);
  assert.deepEqual([detail.startedAt, detail.outcome], [run.json.record.startedAt, run.json.record.outcome]);
  assert.ok(['pass', 'gate-failed'].includes(detail.outcome));

  // The unreachable MCP as acme's endpoint (ada registers it): oscar, an
  // operator, deploys by its id, as every caller below the admin does.
  const ep = await ok('POST /api/mcp-endpoints', 'ada', '/api/mcp-endpoints', { name: 'unreachable', url: NO_MCP }, 201);
  ids.noMcp = ep.json.endpoint.id;
  const dep = await ok('POST /api/packs/:id/deploy/:target', 'oscar', `/api/packs/${encodeURIComponent(ids.pack)}/deploy/prometheus-rules`, { mcpEndpointId: ids.noMcp }, 502);
  ids.deploy = dep.json.deployId;
  assert.match(ids.deploy ?? '', /^dep_/, 'the 502 names its deployId');
  assert.ok(!('auditError' in dep.json));
  assert.equal(dep.rows.length, 1, 'one deploy.run row');
  assert.deepEqual(dep.rows[0].slice(0, 4), ['deploy.run', 'oscar', 'acme', ids.deploy]);
  const d = dep.rows[0][4];
  assert.deepEqual(Object.keys(d), ['pack', 'env', 'target', 'mode', 'dryRun', 'origin', 'mcpEndpoint', 'items', 'ok', 'failed', 'tookMs']);
  assert.deepEqual([d.pack.id, d.origin, d.mcpEndpoint, d.items, d.ok, d.failed, d.target.product, d.mode, d.dryRun], [ids.pack, 'http://127.0.0.1:1', { id: ids.noMcp, name: 'unreachable' }, 1, 0, 1, 'grafana', 'upsert', false]);
  assert.ok(!('fileError' in d), 'fileError is an absent key on a normal row');
  const line = readFileSync(DEPLOYS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.deployId === ids.deploy && l.type === 'deploy');
  assert.equal(line.actor, 'oscar', 'the deploys.jsonl line says the login');
  assert.deepEqual(Object.keys(line).slice(0, 4), ['type', 'deployId', 'at', 'actor'], 'the line keeps its key order: the actor third, as every line before slice 5');
  assert.ok(!readFileSync(DEPLOYS, 'utf8').includes(EMAIL), 'the email is in no line');
  assert.ok(!JSON.stringify(dep.rows).includes(EMAIL), 'the email is in no row');

  const ver = await ok('POST /api/deploys/:deployId/verify', 'oscar', `/api/deploys/${ids.deploy}/verify`, { outcome: 'verified', alignment: 97, attempts: 2 });
  assert.ok(!('auditError' in ver.json));
  assert.deepEqual(ver.rows, [['deploy.verify', 'oscar', 'acme', ids.deploy, { outcome: 'verified', alignment: 97, attempts: 2 }]]);
  const big = await ok('POST /api/deploys/:deployId/verify', 'oscar', `/api/deploys/${ids.deploy}/verify`, { outcome: 'v'.repeat(1024 * 1024), alignment: 'nope' });
  assert.ok(!('auditError' in big.json), 'bounded, not refused');
  assert.deepEqual(big.rows.map(([a, , , t, dd]) => [a, t, dd.outcome.length, dd.alignment, dd.attempts]), [['deploy.verify', ids.deploy, 100, null, null]]);

  // The refusals write none.
  await refused('POST /api/packs/:id/deploy/:target', 'oscar', '/api/packs/nope/deploy/prometheus-rules', { mcpEndpointId: ids.noMcp }, 404, 'unknown pack: nope');
  await refused('POST /api/deploys/:deployId/verify', 'oscar', '/api/deploys/x/verify', { outcome: 'verified' }, 400, 'malformed deployId');
  await refused('POST /api/deploys/:deployId/verify', 'oscar', '/api/deploys/dep_nope/verify', { outcome: 'verified' }, 404, 'unknown deployId: dep_nope');
  const seq = seqNow();
  let r = await call('oscar', 'POST', '/api/journeys/nope/run', {});
  assert.equal(r.status, 404);
  r = await call('oscar', 'POST', '/api/journeys/capture', {});
  assert.equal(r.status, 400);
  assert.deepEqual(rowsAfter(seq), [], 'the 404 run and the {} capture write no row');

  // ada lists them; vera cannot.
  r = await list('ada', '?kind=deploy');
  assert.deepEqual(r.json.rows.map((x) => [x.action, x.actor, x.targetId]), [
    ['deploy.verify', 'oscar', ids.deploy], ['deploy.verify', 'oscar', ids.deploy], ['deploy.run', 'oscar', ids.deploy],
  ], 'ada: the deploy rows, newest first');
  r = await list('ada', '?kind=journey');
  assert.deepEqual(r.json.rows.map((x) => [x.action, x.actor, x.targetId]), [['journey.run', 'oscar', 'audit-j'], ['journey.capture', 'oscar', 'audit-j']]);
  r = await list('ada', `?targetId=${ids.deploy}&action=deploy.run`);
  assert.deepEqual(r.json.rows.map((x) => x.action), ['deploy.run']);
  r = await list('vera', '?kind=deploy');
  assert.deepEqual([r.status, r.json.denied], [403, 'role']);
});

// ---------- 9. auditError: the insert fails, the file write stands ----------

test('auditError: with the audit blocked by a trigger the deploy and the verify answer as before, their lines in the file, auditError on the response and a line on stderr; unblocked, the key is absent', async () => {
  execScript(db, "CREATE TRIGGER audit_test_block BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test: audit blocked'); END;");
  try {
    const lines = () => readFileSync(DEPLOYS, 'utf8').trim().split('\n').length;
    const n = lines();
    const seq = seqNow();
    const { result: dep, output } = await logged(() => call('oscar', 'POST', `/api/packs/${encodeURIComponent(ids.pack)}/deploy/prometheus-rules`, { mcpEndpointId: ids.noMcp }));
    assert.equal(dep.status, 502);
    assert.match(dep.json.deployId ?? '', /^dep_/);
    assert.match(dep.json.auditError ?? '', /test: audit blocked/, 'the response says the row failed');
    assert.equal(lines(), n + 1, 'the deploys.jsonl line is there');
    assert.match(output, /\[deploy\] {3}audit row failed: .*test: audit blocked.*the operation stands; deploy\.run dep_/, 'stderr says so');
    const { result: ver, output: out2 } = await logged(() => call('oscar', 'POST', `/api/deploys/${dep.json.deployId}/verify`, { outcome: 'verified' }));
    assert.deepEqual([ver.status, ver.json.ok, ver.json.deployId], [200, true, dep.json.deployId]);
    assert.match(ver.json.auditError ?? '', /test: audit blocked/);
    assert.match(out2, /\[verify\] {3}audit row failed/);
    assert.equal(lines(), n + 2, 'the verify line is there');
    assert.equal(seqNow(), seq, 'no row landed');
  } finally {
    execScript(db, 'DROP TRIGGER audit_test_block');
  }
  const dep = await ok('POST /api/packs/:id/deploy/:target', 'oscar', `/api/packs/${encodeURIComponent(ids.pack)}/deploy/prometheus-rules`, { mcpEndpointId: ids.noMcp }, 502);
  assert.ok(!('auditError' in dep.json), 'unblocked: no auditError key');
  assert.equal(dep.rows.length, 1);
});

// ---------- 9b. the size guard ----------

test('the size guard: a detail past 8192 characters is refused by the repository (TypeError), no row; one under it lands', () => {
  const seq = seqNow();
  assert.throws(() => appendAudit(db, 'p-big', { orgId: 'acme', action: 'x.big', detail: { blob: 'b'.repeat(9 * 1024) } }), (e) => e instanceof TypeError && /at most 8192/.test(e.message));
  assert.equal(seqNow(), seq, 'no row');
  assert.equal(DETAIL_MAX, 8192);
  const row = appendAudit(db, 'p-big', { orgId: 'acme', action: 'x.big', detail: { blob: 'b'.repeat(8192 - '{"blob":""}'.length) } });
  assert.equal(JSON.stringify(row.detail).length, 8192);
  assert.equal(seqNow(), seq + 1);
});

// ---------- 10. fileError: the deploys.jsonl append fails, the row stands ----------

test('fileError: with deploys.jsonl a directory the deploy answers as before and its row is flagged fileError; the verify cannot find the deploy (404, no row); restored, the next rows carry no flag', async () => {
  const BAK = `${DEPLOYS}.bak`;
  renameSync(DEPLOYS, BAK);
  mkdirSync(DEPLOYS);
  try {
    const { result: dep, output } = await logged(() => ok('POST /api/packs/:id/deploy/:target', 'oscar', `/api/packs/${encodeURIComponent(ids.pack)}/deploy/prometheus-rules`, { mcpEndpointId: ids.noMcp }, 502));
    assert.ok(!('auditError' in dep.json), 'the row was written');
    assert.match(output, /\[deploy\] {3}audit append failed: .*EISDIR/, 'stderr names the failed append');
    assert.equal(dep.rows.length, 1);
    assert.deepEqual(dep.rows[0].slice(0, 4), ['deploy.run', 'oscar', 'acme', dep.json.deployId]);
    assert.equal(dep.rows[0][4].fileError, true, 'the row says the line is missing');
    assert.deepEqual([dep.rows[0][4].items, dep.rows[0][4].failed], [1, 1]);
    // The verify reads the file first: an unreadable file is an empty log,
    // so the deploy is unknown — a refusal, which writes no row (the
    // append is never reached). readDeployRecords tolerates the fault.
    await refused('POST /api/deploys/:deployId/verify', 'oscar', `/api/deploys/${ids.deploy}/verify`, { outcome: 'verified' }, 404, `unknown deployId: ${ids.deploy}`);
  } finally {
    rmSync(DEPLOYS, { recursive: true, force: true });
    renameSync(BAK, DEPLOYS);
  }
  const dep = await ok('POST /api/packs/:id/deploy/:target', 'oscar', `/api/packs/${encodeURIComponent(ids.pack)}/deploy/prometheus-rules`, { mcpEndpointId: ids.noMcp }, 502);
  assert.ok(!('fileError' in dep.rows[0][4]), 'restored: no fileError key');
  const ver = await ok('POST /api/deploys/:deployId/verify', 'oscar', `/api/deploys/${ids.deploy}/verify`, { outcome: 'verified' });
  assert.deepEqual(ver.rows, [['deploy.verify', 'oscar', 'acme', ids.deploy, { outcome: 'verified', alignment: null, attempts: null }]]);
});

// ---------- 10b. fileError: the verify's append fails, the row stands, then the 500 ----------

// The verify reads the file before it appends to it (the known-deploy
// check), so the directory fault above cannot reach its append. The fault
// here is the append itself: `fs.appendFileSync` throws for the window, and
// `syncBuiltinESMExports()` carries the patched function into the live
// bindings `workspace.mjs` imported, in this process (the server is
// in-process). Every other `node:fs` function is untouched, so the read
// finds the deploy and the route reaches the append.
async function withAppendFaulted(fn) {
  const real = fs.appendFileSync;
  fs.appendFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); };
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    fs.appendFileSync = real;
    syncBuiltinESMExports();
  }
}

test('fileError, verify: with the append failing the verify answers 500 { ok, error } and exactly one deploy.verify row is flagged fileError; with the audit blocked too, the 500 carries auditError and no row lands; restored, the next row has no flag', async () => {
  const lines = () => readFileSync(DEPLOYS, 'utf8').trim().split('\n').length;
  const n = lines();
  await withAppendFaulted(async () => {
    const seq = seqNow();
    const r = await call('oscar', 'POST', `/api/deploys/${ids.deploy}/verify`, { outcome: 'verified', alignment: 42, attempts: 3 });
    assert.deepEqual([r.status, r.json], [500, { ok: false, error: 'ENOSPC: no space left on device, write' }], 'the 500 as before, no auditError');
    assert.equal(lines(), n, 'no verify line was appended');
    assert.deepEqual(rowsAfter(seq), [['deploy.verify', 'oscar', 'acme', ids.deploy, { outcome: 'verified', alignment: 42, attempts: 3, fileError: true }]], 'exactly one row, flagged');
    // The insert blocked as well: the 500 stands, its body says auditError, no row.
    execScript(db, "CREATE TRIGGER audit_test_block BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'test: audit blocked'); END;");
    try {
      const seq2 = seqNow();
      const { result: both, output } = await logged(() => call('oscar', 'POST', `/api/deploys/${ids.deploy}/verify`, { outcome: 'verified' }));
      assert.deepEqual([both.status, both.json.ok, both.json.error], [500, false, 'ENOSPC: no space left on device, write']);
      assert.match(both.json.auditError ?? '', /test: audit blocked/, 'the 500 body says the row failed too');
      assert.match(output, /\[verify\] {3}audit row failed: .*test: audit blocked/);
      assert.equal(seqNow(), seq2, 'no row landed');
      assert.equal(lines(), n, 'still no line');
    } finally {
      execScript(db, 'DROP TRIGGER audit_test_block');
    }
  });
  const ver = await ok('POST /api/deploys/:deployId/verify', 'oscar', `/api/deploys/${ids.deploy}/verify`, { outcome: 'verified' });
  assert.deepEqual(ver.rows, [['deploy.verify', 'oscar', 'acme', ids.deploy, { outcome: 'verified', alignment: null, attempts: null }]], 'restored: no fileError key');
  assert.equal(lines(), n + 1, 'restored: the verify line is there');
});

// ---------- 11. the journey run's 502 writes one row ----------

test('a journey whose pack file is gone: 502, and one journey.run row with outcome error, the record fields null, never the error\'s text (the path)', async () => {
  const packFile = join(ACME_DIR, 'packs', `${ids.pack}.pack.yaml`);
  assert.ok(existsSync(packFile), 'the registered pack\'s file');
  unlinkSync(packFile);
  const seq = seqNow();
  const r = await call('oscar', 'POST', '/api/journeys/audit-j/run', {});
  assert.equal(r.status, 502, r.text.slice(0, 200));
  assert.ok(!('auditError' in r.json));
  const rows = rowsAfter(seq);
  assert.equal(rows.length, 1, 'one row');
  const [action, actor, org, target, detail] = rows[0];
  assert.deepEqual([action, actor, org, target], ['journey.run', 'oscar', 'acme', 'audit-j']);
  assert.deepEqual(Object.keys(detail), ['startedAt', 'outcome', 'alignmentPct', 'gradeScore', 'gradePass', 'breaches', 'tookMs']);
  assert.ok(ISO.test(detail.startedAt));
  assert.deepEqual([detail.outcome, detail.alignmentPct, detail.gradeScore, detail.gradePass, detail.breaches], ['error', null, null, null, null]);
  assert.ok(Number.isInteger(detail.tookMs) && detail.tookMs >= 0);
  assert.ok(!JSON.stringify(detail).includes(packFile) && !JSON.stringify(detail).includes(ids.pack), 'the error message (the path) stays out of the row');
  const listed = await list('ada', '?kind=journey&limit=1');
  assert.deepEqual([listed.json.rows[0].action, listed.json.rows[0].detail.outcome], ['journey.run', 'error'], 'ada reads the failed run');
});

// ---------- 12. a non-member owner's actor is shown to the org's admin ----------

test('an owner acting in an org without a membership: the org\'s admin reads the row with the owner\'s login as the actor (design D6)', async () => {
  const members = await call('olive', 'GET', '/api/org/members');
  assert.equal(members.status, 200);
  assert.ok(!members.json.members.some((m) => m.login === 'olive'), 'olive is no member of acme');
  const added = await ok('POST /api/org/members', 'olive', '/api/org/members', { login: 'bob', role: 'viewer' }, 201);
  assert.deepEqual(added.rows, [['membership.add', 'olive', 'acme', 'bob', { role: 'viewer' }]]);
  const r = await list('ada', '?action=membership.add&targetId=bob');
  assert.deepEqual(r.json.rows.map((x) => [x.action, x.actor, x.orgId, x.targetId, x.detail]), [['membership.add', 'olive', 'acme', 'bob', { role: 'viewer' }]], 'ada sees olive, a login GET /api/org/members does not list for her');
  const after = await call('ada', 'GET', '/api/org/members');
  assert.ok(!after.json.members.some((m) => m.login === 'olive'), 'still no member');
});

// ---------- 7. the structural guard, and no email anywhere ----------

test('the structural guard over the slice\'s rows: no URL beyond its origin, no email; an admin\'s listing holds no row of another org; the email is nowhere in the audit', async () => {
  const all = await follow('olive', '?scope=all', 500);
  assert.deepEqual(all.map((x) => x.seq), listAudit(db, { limit: 1000 }).map((x) => x.seq), 'every row, paged');
  const slice = all.filter((x) => /^(deploy|journey)\./.test(x.action) || x.action === 'live.refresh');
  for (const [kind, want] of [['deploy', 'deploy.'], ['journey', 'journey.']]) {
    const byKind = await follow('olive', `?scope=all&kind=${kind}`, 500);
    assert.deepEqual(byKind.map((x) => x.seq), slice.filter((x) => x.action.startsWith(want)).map((x) => x.seq), `kind=${kind} is the slice's ${kind} rows`);
  }
  assert.ok(slice.filter((x) => x.action === 'deploy.run').length >= 4 && slice.some((x) => x.action === 'journey.run') && slice.some((x) => x.action === 'deploy.verify'), 'the suite produced the slice\'s rows');
  for (const row of slice) {
    const text = JSON.stringify(row.detail);
    assert.ok(!/\w+:\/\/[^/\s"]+\/./.test(text), `${row.action} ${row.seq}: an origin at most, never a URL with a path: ${text}`);
    assert.ok(!text.includes('@'), `${row.action} ${row.seq}: no email, no userinfo: ${text}`);
  }
  assert.ok(!JSON.stringify(all).includes(EMAIL), 'the email is in no row of the whole audit');
  for (const [who, org] of [['ada', 'acme'], ['bob', 'bravo'], ['mia', 'bravo']]) {
    const mine = await list(who, '?limit=500');
    assert.ok(mine.json.rows.length > 0 && mine.json.rows.every((x) => x.orgId === org), `${who}: no row with orgId !== ${org}`);
  }
});
