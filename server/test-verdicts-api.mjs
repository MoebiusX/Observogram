#!/usr/bin/env node
/**
 * server/test-verdicts-api.mjs — the verdicts API (GAP batch 2 B3.1,
 * server/routes/verdicts.mjs over server/verdict-admin.mjs), in-process over
 * HTTP on one stand-alone identity server, as test-services-api.mjs does.
 *
 * For every route: the success path with its exact response and its exact
 * audit rows (action, actor = the caller's login, org, target kind and id,
 * detail — each action one the route table lists for it), and every
 * refusal with its status, text and no new row. A catalogue pack answers
 * the empty document and refuses a record (409); the same status and
 * reason again writes no row; a re-upload of the same content keeps the
 * verdicts (same content-hash id). Who may reach these routes in each
 * posture is test-authz's and which org's rows a member reaches is
 * test-tenancy's; this suite is what the routes do once reached.
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
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-verdicts-api-'));
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
const { WAYS } = await import('./verdict-admin.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');
const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
const { adapt } = await import('../tools/lib/adapter.mjs');
const { classify } = await import('../tools/lib/artefact-model.mjs');

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
const VIEW_KEYS = ['artefact', 'key', 'family', 'title', 'status', 'reason', 'actor', 'setAt', 'carriedFrom'];
const EMPTY_SUMMARY = (n) => ({ artefacts: n, trusted: 0, suspect: 0, failed: 0, unreviewed: n, orphaned: 0 });

const PAY_YAML = readFileSync(join(ROOT, `${SPEC_DIR}/examples/payment-service.pack.yaml`), 'utf8');
const PAYMENT = adapt(parseYaml(PAY_YAML));
const YAML = { 'Content-Type': 'text/yaml' };
const SLI01 = PAYMENT.layers.L1[0];

// The ids the tests create, by name.
const ids = {};

// ---------- the reads ----------

test('GET /api/packs/:id/verdicts on a catalogue pack: the empty document — every artefact unreviewed — to a viewer, no row; an unknown pack is 404 in the services shape', async () => {
  const { json, rows } = await ok('GET /api/packs/:id/verdicts', 'vera', '/api/packs/payment-service/verdicts');
  assert.deepEqual([json, rows], [{ ok: true, pack: 'payment-service', verdicts: [], summary: EMPTY_SUMMARY(84) }, []]);
  const env = await ok('GET /api/packs/:id/verdicts', 'vera', '/api/packs/payment-service/verdicts?env=staging');
  assert.deepEqual(env.json, json, '?env= is ignored: verdicts are per pack');
  await refused('GET /api/packs/:id/verdicts', 'vera', '/api/packs/nope/verdicts', 404, 'unknown pack: nope');
  await refused('PUT /api/packs/:id/verdicts/:artefact', 'oscar', '/api/packs/nope/verdicts/SLI-01', { status: 'trusted' }, 404, 'unknown pack: nope');
  await refused('DELETE /api/packs/:id/verdicts/:artefact', 'oscar', '/api/packs/nope/verdicts/SLI-01', 404, 'unknown pack: nope');
});

test('a catalogue pack takes no verdict: PUT and DELETE are 409 naming the way out (register it), the body checked first (400)', async () => {
  const K = 'PUT /api/packs/:id/verdicts/:artefact';
  await refused(K, 'oscar', '/api/packs/payment-service/verdicts/SLI-01', { status: 'trusted' }, 409, WAYS.notRegistered('payment-service'));
  await refused('DELETE /api/packs/:id/verdicts/:artefact', 'oscar', '/api/packs/payment-service/verdicts/SLI-01', 409, WAYS.notRegistered('payment-service'));
  await refused(K, 'oscar', '/api/packs/payment-service/verdicts/SLI-01', { status: 'maybe' }, 400, WAYS.status('maybe'));
  await refused(K, 'oscar', '/api/packs/payment-service/verdicts/SLI-01', {}, 400, WAYS.status(undefined));
  await refused(K, 'oscar', '/api/packs/payment-service/verdicts/SLI-01', '[1]', 400, WAYS.status(undefined));
  await refused(K, 'oscar', '/api/packs/payment-service/verdicts/SLI-01', { status: 'trusted', reason: 'x'.repeat(2001) }, 400, WAYS.reason);
  await refused(K, 'oscar', '/api/packs/payment-service/verdicts/SLI%2001', { status: 'trusted' }, 400, WAYS.artefactId);
});

// ---------- a registered pack ----------

test('PUT /api/packs/:id/verdicts/:artefact on a registered pack: the view and `changed`, the exact verdict.set row; the same again writes nothing; a reason-only and a status-only change; the document counts it', async () => {
  const r = await call('ada', 'POST', '/api/validate?source=pay.yaml', PAY_YAML, YAML);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  ids.pay = r.json.registered.id;
  assert.match(ids.pay, /^uploaded-payment-service-[0-9a-f]{8}$/);
  const K = 'PUT /api/packs/:id/verdicts/:artefact';
  const first = await ok(K, 'oscar', `/api/packs/${ids.pay}/verdicts/SLI-01`, { status: 'suspect', reason: 'the window is short', ignored: 'field' });
  assert.deepEqual(Object.keys(first.json), ['ok', 'verdict', 'changed']);
  assert.deepEqual(Object.keys(first.json.verdict), VIEW_KEYS);
  assert.ok(ISO.test(first.json.verdict.setAt));
  assert.deepEqual({ ...first.json.verdict, setAt: 'T' }, {
    artefact: 'SLI-01', key: 'L1/SLI-01', family: 'sli', title: SLI01.title || 'SLI-01', status: 'suspect', reason: 'the window is short', actor: 'oscar', setAt: 'T', carriedFrom: null,
  });
  assert.deepEqual(first.json.changed, ['status', 'reason']);
  assert.deepEqual(first.rows, [['verdict.set', 'oscar', 'acme', 'artefact', `${ids.pay}/SLI-01`, { pack: ids.pay, artefact: 'SLI-01', family: 'sli', from: null, to: 'suspect', reason: 'the window is short' }]]);
  // The same again: no row, the record as it was (oscar's).
  const same = await ok(K, 'ada', `/api/packs/${ids.pay}/verdicts/SLI-01`, { status: 'suspect', reason: 'the window is short' });
  assert.deepEqual([same.json.changed, same.json.verdict.actor, same.rows], [[], 'oscar', []]);
  // A status change by an admin: the transition in the row, the reason cut to 200 there and whole in the view.
  const long = 'r'.repeat(2000);
  const changed = await ok(K, 'ada', `/api/packs/${ids.pay}/verdicts/SLI-01`, { status: 'failed', reason: long });
  assert.deepEqual([changed.json.changed, changed.json.verdict.status, changed.json.verdict.reason.length, changed.json.verdict.actor], [['status', 'reason'], 'failed', 2000, 'ada']);
  assert.deepEqual(changed.rows, [['verdict.set', 'ada', 'acme', 'artefact', `${ids.pay}/SLI-01`, { pack: ids.pay, artefact: 'SLI-01', family: 'sli', from: 'suspect', to: 'failed', reason: 'r'.repeat(200) }]]);
  // An owner with no acme membership, naming acme: a record too; an L4 artefact's key names its subgroup.
  const alr = PAYMENT.layers.L4.alerting[0];
  const owner = await ok(K, 'olive', `/api/packs/${ids.pay}/verdicts/${alr.id}`, { status: 'trusted' });
  assert.deepEqual([owner.json.verdict.key, owner.json.verdict.family, owner.json.verdict.actor, owner.json.verdict.reason], [`L4/alerting/${alr.id}`, classify(alr), 'olive', null]);
  assert.deepEqual(owner.rows.map((x) => [x[0], x[1], x[2], x[5].to]), [['verdict.set', 'olive', 'acme', 'trusted']]);
  // The document: both, in artefact order, the summary counting them.
  const doc = await ok('GET /api/packs/:id/verdicts', 'vera', `/api/packs/${ids.pay}/verdicts`);
  assert.deepEqual(doc.json.verdicts.map((v) => [v.artefact, v.status]), [[alr.id, 'trusted'], ['SLI-01', 'failed']]);
  assert.deepEqual(doc.json.summary, { artefacts: 84, trusted: 1, suspect: 0, failed: 1, unreviewed: 82, orphaned: 0 });
  assert.deepEqual(doc.rows, []);
});

test('every refusal on a registered pack: an unknown artefact 404, a bad status, a long reason, a malformed id 400 — no row; a viewer may not record (the guard\'s 403)', async () => {
  const K = 'PUT /api/packs/:id/verdicts/:artefact';
  await refused(K, 'oscar', `/api/packs/${ids.pay}/verdicts/SLI-99`, { status: 'trusted' }, 404, WAYS.noArtefact(ids.pay, 'SLI-99'));
  await refused(K, 'oscar', `/api/packs/${ids.pay}/verdicts/SLI-01`, { status: 'unreviewed' }, 400, WAYS.status('unreviewed'));
  await refused(K, 'oscar', `/api/packs/${ids.pay}/verdicts/SLI-01`, { status: 'trusted', reason: ['a'] }, 400, WAYS.reason);
  await refused(K, 'oscar', `/api/packs/${ids.pay}/verdicts/${encodeURIComponent('x'.repeat(101))}`, { status: 'trusted' }, 400, WAYS.artefactId);
  await refused('DELETE /api/packs/:id/verdicts/:artefact', 'oscar', `/api/packs/${ids.pay}/verdicts/SLI-02`, 404, WAYS.noVerdict(ids.pay, 'SLI-02'));
  const seq = seqNow();
  const r = await call('vera', 'PUT', `/api/packs/${ids.pay}/verdicts/SLI-02`, { status: 'trusted' });
  assert.equal(r.status, 403);
  assert.equal(r.json.denied, 'role');
  assert.deepEqual(rowsAfter(seq), []);
});

test('a re-upload of the same content is the same pack id: the verdicts stay; DELETE clears one with its exact verdict.clear row, a second DELETE is 404', async () => {
  const again = await call('oscar', 'POST', '/api/validate?source=pay.yaml', PAY_YAML, YAML);
  assert.equal(again.json.registered.id, ids.pay, 'the content hash is the id');
  const doc = await ok('GET /api/packs/:id/verdicts', 'vera', `/api/packs/${ids.pay}/verdicts`);
  assert.equal(doc.json.verdicts.length, 2, 'a re-upload keeps the verdicts');
  const K = 'DELETE /api/packs/:id/verdicts/:artefact';
  const cleared = await ok(K, 'oscar', `/api/packs/${ids.pay}/verdicts/SLI-01`);
  assert.deepEqual(Object.keys(cleared.json), ['ok', 'cleared']);
  assert.deepEqual([cleared.json.cleared.artefact, cleared.json.cleared.status, cleared.json.cleared.actor], ['SLI-01', 'failed', 'ada']);
  assert.deepEqual(cleared.rows, [['verdict.clear', 'oscar', 'acme', 'artefact', `${ids.pay}/SLI-01`, { pack: ids.pay, artefact: 'SLI-01', from: 'failed' }]]);
  await refused(K, 'oscar', `/api/packs/${ids.pay}/verdicts/SLI-01`, 404, WAYS.noVerdict(ids.pay, 'SLI-01'));
  const after = await ok('GET /api/packs/:id/verdicts', 'vera', `/api/packs/${ids.pay}/verdicts`);
  assert.deepEqual(after.json.summary, { artefacts: 84, trusted: 1, suspect: 0, failed: 0, unreviewed: 83, orphaned: 0 });
});

test('DELETE /api/uploads drops the pack and, with it, its verdicts (the cascade): the id is unknown afterwards', async () => {
  const r = await call('ada', 'DELETE', '/api/uploads');
  assert.equal(r.status, 200);
  await refused('GET /api/packs/:id/verdicts', 'vera', `/api/packs/${ids.pay}/verdicts`, 404, `unknown pack: ${ids.pay}`);
  assert.equal(prepare(db, 'SELECT count(*) AS n FROM verdicts').get().n, 0, 'the rows cascaded with the pack');
  assert.deepEqual(rowsAfter(seqNow() - 1).map((x) => x[0]), ['pack.clear'], 'the cascade writes no verdict row');
});
