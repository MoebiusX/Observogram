#!/usr/bin/env node
/**
 * server/test-waivers-api.mjs — the waivers API (GAP batch 2 B3.2,
 * server/routes/waivers.mjs over server/waiver-admin.mjs) and the
 * conformance report's waivers overlay, in-process over HTTP on one
 * stand-alone identity server, as test-services-api.mjs does.
 *
 * For every route: the success path with its exact response and its exact
 * audit rows (action, actor = the caller's login, org, target kind and id,
 * detail — each action one the route table lists for it), and every
 * refusal with its status, text and no new row. The inert proof is T0: the
 * `/conformance` body of a registered pack, captured as text BEFORE any
 * waiver exists, is what the route answers again once every waiver is
 * revoked; `/api/validate` never carries a `waivers` key. Who may reach
 * these routes in each posture is test-authz's and which org's rows a member
 * reaches is test-tenancy's; this suite is what the routes do once reached.
 *
 * The fixture is test-identity-api's: default {olive: admin} (an owner),
 * acme {ada: admin, oscar: operator, vera: viewer}, bravo {bob: admin}.
 */

// Hermetic (§0): a developer shell's store, identity or per-org token
// variables never reach this process's imports. serve-child.mjs imports no
// server code.
const { STRIP, signIn } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-waivers-api-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');

const pw = (login) => `${login}-passw0rd-api`;
const LOGINS = ['olive', 'ada', 'oscar', 'vera', 'bob'];
writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(WORKSPACE, 'users.json'));
writeOrgsFile({
  default: { name: 'Default', members: { olive: 'admin' } },
  acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer' } },
  bravo: { name: 'Bravo', members: { bob: 'admin' } },
}, join(WORKSPACE, 'orgs.json'));

const { start } = await import('./index.mjs');
const { currentStore, closeStore, prepare } = await import('./store/db.mjs');
const { routeEntry } = await import('./route-table.mjs');
const { EXPIRY_MAX_DAYS, WAYS } = await import('./waiver-admin.mjs');
const { createWaiver } = await import('./store/waivers.mjs');
const { runWithOrg } = await import('./org-context.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');
const { SUBJECT_CLAUSES } = await import('../tools/lib/conformance.mjs');

const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
const db = currentStore();
after(async () => {
  await new Promise((resolve) => srv.close(resolve));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const cookies = {};
for (const login of LOGINS) {
  const s = await signIn(BASE, login, pw(login));
  assert.equal(s.status, 200, `${login} signs in: ${JSON.stringify(s.json)}`);
  cookies[login] = s.session;
}

// ---------- requests and the audit trail ----------

const CSRF = { 'X-Observogram-CSRF': '1' };

// One request as `who` (a login whose cookie is held): { status, json, text, headers }.
async function call(who, method, path, body, extra = {}) {
  const headers = { Accept: 'application/json', ...CSRF, Cookie: cookies[who], ...(who === 'olive' ? { 'X-Observogram-Org': 'acme' } : {}), ...extra };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

const seqNow = () => prepare(db, 'SELECT coalesce(max(seq), 0) AS s FROM audit').get().s;
// The rows after `seq`: [action, actor, org, targetKind, targetId, detail].
const rowsAfter = (seq) => prepare(db, 'SELECT org_id, actor, action, target_kind, target_id, detail FROM audit WHERE seq > ? ORDER BY seq').all(seq)
  .map((r) => [r.action, r.actor, r.org_id, r.target_kind, r.target_id, r.detail === null ? null : JSON.parse(r.detail)]);

const noBody = (method) => method === 'GET' || method === 'DELETE';

// A successful call of route `key`: its status, and the rows it wrote —
// each an action the route table lists for the route.
async function ok(key, who, path, body, status) {
  const { method } = routeEntry(key);
  if (noBody(method)) [body, status] = [undefined, body];
  const seq = seqNow();
  const r = await call(who, method, path, body);
  assert.equal(r.status, status ?? 200, `${key} as ${who}: ${r.text.slice(0, 300)}`);
  assert.equal(r.json.ok, true);
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

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VIEW_KEYS = ['id', 'artefactId', 'ruleId', 'reason', 'expiresAt', 'author', 'createdAt', 'revokedAt', 'revokedBy', 'revokeReason', 'state', 'expiresInDays', 'serviceId'];
const PAY_YAML = readFileSync(join(ROOT, `${SPEC_DIR}/examples/payment-service.pack.yaml`), 'utf8');
const YAML = { 'Content-Type': 'text/yaml' };
const L5 = 'L5.MUST.tier1_chaos_for_each_slo';
const L3 = 'L3.MUST.recording_rule_per_slo';
const THREE = ['slos.api_latency_99_p99_500ms', 'slos.settlement_consumers_99_9_min_2', 'slos.consumer_success_99_95'];
const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();
const K_LIST = 'GET /api/services/:id/waivers';
const K_CREATE = 'POST /api/services/:id/waivers';
const K_REVOKE = 'POST /api/waivers/:id/revoke';

// The ids the tests create, by name; T0, the conformance body before any waiver.
const ids = {};
let T0 = null;

// ---------- T0 and the reads ----------

test('T0: a registered pack\'s /conformance body before any waiver has no `waivers` key (captured as text); /api/validate carries none either; GET /api/services/:id/waivers answers the empty list to a viewer, no row', async () => {
  const r = await call('ada', 'POST', '/api/validate?source=pay.yaml', PAY_YAML, YAML);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  ids.pay = r.json.registered.id;
  assert.ok(!('waivers' in r.json) && !('waivers' in (r.json.conformance || {})), '/api/validate has no waivers key');
  const services = (await call('vera', 'GET', '/api/services')).json.services;
  ids.service = services.find((s) => s.slug === 'payment-service').id;
  assert.ok(Number.isInteger(ids.service));
  const conf = await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`);
  assert.equal(conf.status, 200);
  assert.ok(!('waivers' in conf.json), 'no waivers key before any waiver');
  assert.deepEqual([conf.json.conformant, conf.json.must, conf.json.tier.service], [false, { passed: 21, total: 25 }, { id: ids.service, slug: 'payment-service' }]);
  T0 = conf.text;
  assert.equal((await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`)).text, T0, 'the body is stable across requests');
  const { json, rows } = await ok(K_LIST, 'vera', `/api/services/${ids.service}/waivers`);
  assert.deepEqual([json, rows], [{ ok: true, service: { id: ids.service, slug: 'payment-service' }, waivers: [], counts: { active: 0, expired: 0, revoked: 0 } }, []]);
});

test('an unknown or malformed id: GET and POST /api/services/:id/waivers 404 `no service <id>` (a valid body), a malformed id 400; POST /api/waivers/:id/revoke 404 `no waiver <id>`', async () => {
  const body = { ruleId: L5, reason: 'x', expiresAt: inDays(30) };
  await refused(K_LIST, 'vera', '/api/services/999999/waivers', 404, WAYS.noService(999999));
  await refused(K_CREATE, 'oscar', '/api/services/999999/waivers', body, 404, WAYS.noService(999999));
  await refused(K_LIST, 'vera', '/api/services/abc/waivers', 400, 'service id must be a positive integer, at most 9007199254740991');
  await refused(K_CREATE, 'oscar', '/api/services/0/waivers', body, 400, 'service id must be a positive integer, at most 9007199254740991');
  await refused(K_REVOKE, 'oscar', '/api/waivers/999999/revoke', {}, 404, WAYS.noWaiver(999999));
  await refused(K_REVOKE, 'oscar', '/api/waivers/x/revoke', {}, 400, 'waiver id must be a positive integer, at most 9007199254740991');
});

// ---------- create ----------

test('POST /api/services/:id/waivers: a pack-level waiver (201) with its exact view and its exact waiver.create row — the author is the actor, the body\'s author and createdAt ignored, the expiry normalised; a scoped waiver names its symbol', async () => {
  const expires = '2027-01-15T10:00:00Z';
  const { json, rows } = await ok(K_CREATE, 'oscar', `/api/services/${ids.service}/waivers`, {
    ruleId: L5, reason: 'chaos day is scheduled for the next quarter', expiresAt: expires, author: 'someone-else', createdAt: '2000-01-01T00:00:00.000Z', ignored: 1,
  }, 201);
  assert.deepEqual(Object.keys(json), ['ok', 'waiver']);
  assert.deepEqual(Object.keys(json.waiver), VIEW_KEYS);
  const w = json.waiver;
  assert.ok(Number.isInteger(w.id) && ISO.test(w.createdAt) && w.createdAt > '2026', 'the id is the row\'s, createdAt the server\'s clock');
  assert.deepEqual({ ...w, id: 0, createdAt: 'T', expiresInDays: 0 }, {
    id: 0, artefactId: null, ruleId: L5, reason: 'chaos day is scheduled for the next quarter', expiresAt: '2027-01-15T10:00:00.000Z', author: 'oscar', createdAt: 'T',
    revokedAt: null, revokedBy: null, revokeReason: null, state: 'active', expiresInDays: 0, serviceId: ids.service,
  });
  assert.ok(w.expiresInDays > 0 && w.expiresInDays <= EXPIRY_MAX_DAYS);
  assert.deepEqual(rows, [['waiver.create', 'oscar', 'acme', 'waiver', String(w.id), { service: 'payment-service', ruleId: L5, artefactId: null, expiresAt: '2027-01-15T10:00:00.000Z', reason: 'chaos day is scheduled for the next quarter' }]]);
  ids.whole = w.id;
  // A scoped waiver by an admin, on the L3 subject the pack fails; the reason cut to 200 in the row and whole in the view.
  const long = 'r'.repeat(2000);
  const scoped = await ok(K_CREATE, 'ada', `/api/services/${ids.service}/waivers`, { ruleId: L3, artefactId: THREE[2], reason: long, expiresAt: inDays(10) }, 201);
  assert.deepEqual([scoped.json.waiver.artefactId, scoped.json.waiver.author, scoped.json.waiver.reason.length, scoped.json.waiver.state], [THREE[2], 'ada', 2000, 'active']);
  assert.deepEqual(scoped.rows.map((x) => [x[0], x[1], x[5].artefactId, x[5].reason.length]), [['waiver.create', 'ada', THREE[2], 200]]);
  ids.scoped = scoped.json.waiver.id;
  // An owner with no acme membership, naming acme: a record too.
  const owner = await ok(K_CREATE, 'olive', `/api/services/${ids.service}/waivers`, { ruleId: 'L4.MUST.multi_window_burn_rate', artefactId: THREE[0], reason: 'the burn alert ships next sprint', expiresAt: inDays(5) }, 201);
  assert.deepEqual([owner.json.waiver.author, owner.rows.map((x) => [x[0], x[1], x[2]])], ['olive', [['waiver.create', 'olive', 'acme']]]);
  ids.l4 = owner.json.waiver.id;
  // The list: newest first, counts.
  const list = await ok(K_LIST, 'vera', `/api/services/${ids.service}/waivers`);
  assert.deepEqual(list.json.waivers.map((x) => x.id), [ids.l4, ids.scoped, ids.whole]);
  assert.deepEqual(list.json.counts, { active: 3, expired: 0, revoked: 0 });
  assert.deepEqual(list.rows, []);
});

test('every refusal of a create, 400 naming the way out and writing no row: an unknown rule, a malformed or misplaced artefactId, a bad reason, a past, far or malformed expiry; the same key again is 409 naming the active waiver; a viewer may not record (the guard\'s 403)', async () => {
  const P = `/api/services/${ids.service}/waivers`;
  const good = { ruleId: L5, reason: 'x', expiresAt: inDays(30) };
  await refused(K_CREATE, 'oscar', P, { ...good, ruleId: 'L9.MUST.nope' }, 400, WAYS.ruleId('L9.MUST.nope'));
  await refused(K_CREATE, 'oscar', P, { reason: 'x', expiresAt: inDays(1) }, 400, WAYS.ruleId(undefined));
  await refused(K_CREATE, 'oscar', P, '[1]', 400, WAYS.ruleId(undefined));
  await refused(K_CREATE, 'oscar', P, { ...good, artefactId: 'SLO-01' }, 400, WAYS.artefactId);
  await refused(K_CREATE, 'oscar', P, { ...good, artefactId: 'slos.' }, 400, WAYS.artefactId);
  await refused(K_CREATE, 'oscar', P, { ...good, artefactId: `slos.${'a'.repeat(200)}` }, 400, WAYS.artefactId);
  await refused(K_CREATE, 'oscar', P, { ...good, artefactId: 7 }, 400, WAYS.artefactId);
  await refused(K_CREATE, 'oscar', P, { ...good, ruleId: 'L2.MUST.tail_sampling', artefactId: 'slos.x' }, 400, WAYS.packLevelOnly('L2.MUST.tail_sampling'));
  assert.ok(WAYS.packLevelOnly('L2.MUST.tail_sampling').includes(SUBJECT_CLAUSES.join(', ')), 'the way out lists the per-item clauses');
  await refused(K_CREATE, 'oscar', P, { ...good, reason: '' }, 400, WAYS.reason);
  await refused(K_CREATE, 'oscar', P, { ...good, reason: 'x'.repeat(2001) }, 400, WAYS.reason);
  await refused(K_CREATE, 'oscar', P, { ...good, reason: 'two\nlines' }, 400, WAYS.reason);
  await refused(K_CREATE, 'oscar', P, { ...good, reason: ['x'] }, 400, WAYS.reason);
  await refused(K_CREATE, 'oscar', P, { ...good, expiresAt: '2000-01-01T00:00:00.000Z' }, 400, WAYS.expiresAt('2000-01-01T00:00:00.000Z'));
  const far = inDays(EXPIRY_MAX_DAYS + 1);
  await refused(K_CREATE, 'oscar', P, { ...good, expiresAt: far }, 400, WAYS.expiresAt(far));
  await refused(K_CREATE, 'oscar', P, { ...good, expiresAt: 'next week' }, 400, WAYS.expiresAt('next week'));
  await refused(K_CREATE, 'oscar', P, { ...good, expiresAt: 12 }, 400, WAYS.expiresAt(12));
  // One active waiver per (service, ruleId, artefactId).
  const whole = (await call('vera', 'GET', P)).json.waivers.find((w) => w.id === ids.whole);
  await refused(K_CREATE, 'oscar', P, { ...good, reason: 'again' }, 409, WAYS.duplicate(whole));
  const scoped = (await call('vera', 'GET', P)).json.waivers.find((w) => w.id === ids.scoped);
  await refused(K_CREATE, 'oscar', P, { ruleId: L3, artefactId: THREE[2], reason: 'again', expiresAt: inDays(3) }, 409, WAYS.duplicate(scoped));
  assert.match(WAYS.duplicate(scoped), new RegExp(`POST /api/waivers/${ids.scoped}/revoke`), 'the way out is the revoke');
  // Another subject of the same clause is another key.
  const other = await ok(K_CREATE, 'oscar', P, { ruleId: L3, artefactId: 'slos.api_latency_99_p99_500ms', reason: 'covers nothing: L3 passes for this SLO', expiresAt: inDays(3) }, 201);
  ids.unused = other.json.waiver.id;
  const seq = seqNow();
  const r = await call('vera', 'POST', P, good);
  assert.equal(r.status, 403);
  assert.equal(r.json.denied, 'role');
  assert.deepEqual(rowsAfter(seq), []);
});

// ---------- the conformance overlay ----------

test('GET /api/packs/:id/conformance with waivers on the pack\'s service: the engine\'s fields are T0\'s byte for byte, plus a `waivers` block naming the service — L5 waived (three subjects), L3 partial (one of one subject waived… the clause\'s only failing subject), the L4 subject waived, the unused waiver listed; `effective` recomputed; /api/validate still carries none', async () => {
  const r = await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`);
  assert.equal(r.status, 200);
  const { waivers, ...engine } = r.json;
  assert.equal(JSON.stringify(engine), JSON.stringify(JSON.parse(T0)), 'every engine field as T0 states it, in T0\'s order');
  assert.deepEqual(Object.keys(waivers), ['service', 'counts', 'clauses', 'effective', 'unused']);
  assert.deepEqual(waivers.service, { id: ids.service, slug: 'payment-service' });
  assert.deepEqual(Object.keys(waivers.clauses), [L3, 'L4.MUST.multi_window_burn_rate', L5]);
  assert.deepEqual(waivers.clauses[L5].status, 'waived');
  assert.deepEqual(waivers.clauses[L5].subjects, { failing: THREE, waived: THREE, remaining: [] });
  assert.deepEqual(waivers.clauses[L5].waivers.map((w) => [w.id, w.author, w.state]), [[ids.whole, 'oscar', 'active']]);
  // Every quoted view is the list route's WaiverView: its keys in its order, the org never echoed.
  for (const c of Object.values(waivers.clauses)) for (const w of c.waivers) assert.deepEqual(Object.keys(w), VIEW_KEYS);
  for (const w of waivers.unused) assert.deepEqual(Object.keys(w), VIEW_KEYS);
  assert.deepEqual(waivers.clauses[L3], { status: 'waived', waivers: [waivers.clauses[L3].waivers[0]], subjects: { failing: [THREE[2]], waived: [THREE[2]], remaining: [] } });
  assert.equal(waivers.clauses[L3].waivers[0].id, ids.scoped);
  assert.deepEqual([waivers.clauses['L4.MUST.multi_window_burn_rate'].status, waivers.clauses['L4.MUST.multi_window_burn_rate'].waivers[0].id], ['waived', ids.l4]);
  assert.deepEqual(waivers.unused.map((w) => w.id), [ids.unused]);
  assert.deepEqual(waivers.counts, { failing: 1, waived: 5, expired: 0, unused: 1 }, 'the weekly-chaos clause alone still fails');
  assert.deepEqual([engine.must, waivers.effective.must, waivers.effective.conformant, waivers.effective.mustPercent], [{ passed: 21, total: 25 }, { passed: 24, total: 25 }, false, 96]);
  assert.deepEqual(Object.keys(waivers.effective.byDimension), Object.keys(engine.byDimension));
  assert.deepEqual(waivers.effective.byDimension.L5, { ...engine.byDimension.L5, mustPassed: engine.byDimension.L5.mustPassed + 1 });
  // The author is the actor — a login, never an email — and every member reads it.
  for (const c of Object.values(waivers.clauses)) for (const w of c.waivers) assert.ok(['oscar', 'ada', 'olive'].includes(w.author) && !w.author.includes('@'));
  // ?env= grades the overlay; the waivers are the service's whatever the environment.
  const staging = await call('vera', 'GET', `/api/packs/${ids.pay}/conformance?env=staging`);
  assert.equal(staging.json.waivers?.service?.id, ids.service);
  // A catalogue pack has no service record: no waivers key, the same body as before.
  const catalogue = await call('vera', 'GET', '/api/packs/payment-service/conformance');
  assert.ok(!('waivers' in catalogue.json) && catalogue.json.tier.service === null);
  // /api/validate: the bare report, no waivers key, whatever the service holds.
  const again = await call('oscar', 'POST', '/api/validate?source=pay.yaml', PAY_YAML, YAML);
  assert.equal(again.json.registered.id, ids.pay);
  assert.ok(!('waivers' in again.json) && !('waivers' in (again.json.conformance || {})), '/api/validate keeps the bare report');
});

test('a re-upload of changed content under the same service keeps the waivers (they are the service\'s, not the pack\'s): the new pack id answers the same overlay', async () => {
  const v2 = PAY_YAML.replace(/^ {2}version: .*$/m, '  version: 9.9.9');
  assert.notEqual(v2, PAY_YAML);
  const r = await call('oscar', 'POST', '/api/validate?source=pay-v2.yaml', v2, YAML);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.notEqual(r.json.registered.id, ids.pay);
  const conf = await call('vera', 'GET', `/api/packs/${r.json.registered.id}/conformance`);
  assert.deepEqual([conf.json.waivers.service, Object.keys(conf.json.waivers.clauses), conf.json.waivers.effective.must.passed], [{ id: ids.service, slug: 'payment-service' }, [L3, 'L4.MUST.multi_window_burn_rate', L5], 24]);
  ids.payV2 = r.json.registered.id;
});

// ---------- expiry, renewal ----------

test('an expired waiver (written through the repository with a past expiry) reads `expired` in the list and marks its clause `expired` in the report — failing again, the lapsed waiver surfaced; a new waiver of the same key is a renewal (201, no 409)', async () => {
  // Revoke the whole-pack L5 waiver first, so the lapsed one is what the clause sees.
  await ok(K_REVOKE, 'oscar', `/api/waivers/${ids.whole}/revoke`, { reason: 'superseded by a lapsed test row' });
  let lapsed;
  runWithOrg('acme', () => { lapsed = createWaiver(db, 'oscar', { serviceId: ids.service, ruleId: L5, reason: 'lapsed', expiresAt: '2000-01-01T00:00:00.000Z' }); });
  const list = await ok(K_LIST, 'vera', `/api/services/${ids.service}/waivers`);
  const view = list.json.waivers.find((w) => w.id === lapsed.id);
  assert.deepEqual([view.state, view.expiresInDays < -9000, list.json.counts], ['expired', true, { active: 3, expired: 1, revoked: 1 }]);
  const conf = await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`);
  const c = conf.json.waivers.clauses[L5];
  assert.deepEqual([c.status, c.waivers.map((w) => [w.id, w.state]), c.subjects.remaining], ['expired', [[lapsed.id, 'expired']], THREE]);
  assert.deepEqual([conf.json.waivers.effective.must.passed, conf.json.waivers.counts.expired], [23, 3]);
  // Renewal: the same key again is allowed once the previous one lapsed.
  const renewed = await ok(K_CREATE, 'oscar', `/api/services/${ids.service}/waivers`, { ruleId: L5, reason: 'renewed for one more quarter', expiresAt: inDays(90) }, 201);
  assert.equal(renewed.json.waiver.state, 'active');
  ids.renewed = renewed.json.waiver.id;
  const after = await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`);
  assert.deepEqual([after.json.waivers.clauses[L5].status, after.json.waivers.clauses[L5].waivers.map((w) => w.id)], ['waived', [ids.renewed]], 'the active waiver, not the lapsed one, covers the clause');
  ids.lapsed = lapsed.id;
});

// ---------- revoke ----------

test('POST /api/waivers/:id/revoke: the view (state revoked, who and why) and the exact waiver.revoke row; a second revoke is 409 and writes nothing; a bad reason 400; a viewer 403; the list keeps the row as history; once every waiver is revoked the /conformance body is T0 again, byte for byte', async () => {
  const { json, rows } = await ok(K_REVOKE, 'ada', `/api/waivers/${ids.scoped}/revoke`, { reason: 'the recording rule landed' });
  assert.deepEqual(Object.keys(json), ['ok', 'waiver']);
  assert.ok(ISO.test(json.waiver.revokedAt));
  assert.deepEqual([json.waiver.id, json.waiver.state, json.waiver.revokedBy, json.waiver.revokeReason, json.waiver.author], [ids.scoped, 'revoked', 'ada', 'the recording rule landed', 'ada']);
  assert.deepEqual(rows, [['waiver.revoke', 'ada', 'acme', 'waiver', String(ids.scoped), { service: 'payment-service', ruleId: L3, artefactId: THREE[2], reason: 'the recording rule landed' }]]);
  const current = (await call('vera', 'GET', `/api/services/${ids.service}/waivers`)).json.waivers.find((w) => w.id === ids.scoped);
  await refused(K_REVOKE, 'oscar', `/api/waivers/${ids.scoped}/revoke`, {}, 409, WAYS.revoked(current));
  await refused(K_REVOKE, 'oscar', `/api/waivers/${ids.l4}/revoke`, { reason: 'x'.repeat(2001) }, 400, WAYS.revokeReason);
  await refused(K_REVOKE, 'oscar', `/api/waivers/${ids.l4}/revoke`, { reason: 'a\nb' }, 400, WAYS.revokeReason);
  const seq = seqNow();
  const denied = await call('vera', 'POST', `/api/waivers/${ids.l4}/revoke`, {});
  assert.deepEqual([denied.status, denied.json.denied, rowsAfter(seq)], [403, 'role', []]);
  // No reason: null in the view and the row.
  const bare = await ok(K_REVOKE, 'oscar', `/api/waivers/${ids.l4}/revoke`, {});
  assert.deepEqual([bare.json.waiver.revokeReason, bare.rows[0][5].reason], [null, null]);
  for (const id of [ids.unused, ids.renewed, ids.lapsed]) await ok(K_REVOKE, 'oscar', `/api/waivers/${id}/revoke`, { reason: 'closing the test' });
  const list = await ok(K_LIST, 'vera', `/api/services/${ids.service}/waivers`);
  assert.deepEqual(list.json.counts, { active: 0, expired: 0, revoked: 6 });
  assert.ok(list.json.waivers.every((w) => w.state === 'revoked' && w.revokedAt && w.revokedBy), 'history, not deletion');
  const conf = await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`);
  assert.equal(conf.text, T0, 'revoked waivers are history: the body is T0 again, byte for byte');
  assert.equal((await call('vera', 'GET', `/api/packs/${ids.payV2}/conformance`)).json.waivers, undefined);
});

// ---------- the service's deletion ----------

test('DELETE /api/services/:id counts the waivers it takes with it — the body and the service.delete detail gain `waivers: n` — and the rows cascade', async () => {
  const seq = seqNow();
  const r = await call('ada', 'DELETE', `/api/services/${ids.service}`);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.deepEqual([Object.keys(r.json), r.json.environments, r.json.packLinks, r.json.waivers], [['ok', 'deleted', 'environments', 'packLinks', 'waivers'], 2, 2, 6]);
  assert.deepEqual(rowsAfter(seq), [['service.delete', 'ada', 'acme', 'service', 'payment-service', { environments: 2, packLinks: 2, waivers: 6 }]]);
  assert.equal(prepare(db, 'SELECT count(*) AS n FROM waivers').get().n, 0, 'the rows cascaded with the service');
  await refused(K_LIST, 'vera', `/api/services/${ids.service}/waivers`, 404, WAYS.noService(ids.service));
  const conf = await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`);
  assert.deepEqual([conf.json.waivers, conf.json.tier.service], [undefined, null], 'no service record: the bare report');
});
