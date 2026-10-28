#!/usr/bin/env node
/**
 * server/test-update-api.mjs — the UPDATE journey's routes (docs/UPDATE_JOURNEY.md;
 * tools/lib/pack-update.mjs), in-process over HTTP on one identity server, as
 * test-verdicts-api.mjs does.
 *
 * POST /api/library/reopen answers the Open stage: a pack made in Build reopens
 * exactly (its inputs, no additions), one with additions recorded reopens with
 * them, a hand-edited one names what Build did not write and which of it can be
 * read in as additions, a scan and a shipped example say what they are and have
 * no definition. POST /api/library/update registers the next version of a Build
 * pack — version bumped, lineage recorded, the base kept and listed as superseded
 * with its head by GET /api/packs — and refuses a reading (409), a moved base
 * (409 with `newer`), a renamed pack (400) and an unknown base (404).
 * POST /api/library/instantiate takes `additions` and reports a refused one as a
 * warning of kind `addition`. The registry's eviction keeps every saved version.
 * Who may reach these routes is test-authz's; this suite is what they do.
 */

// Hermetic (§0): a developer shell's store, identity or per-org token
// variables never reach this process's imports.
const { STRIP, signIn, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-update-api-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');

const pw = (login) => `${login}-passw0rd-api`;
writeUsersFile({ users: { ada: { name: 'ada', createdAt: 'test', password: hashPassword(pw('ada')) } } }, join(WORKSPACE, 'users.json'));
writeOrgsFile({ acme: { name: 'Acme', members: { ada: 'admin' } } }, join(WORKSPACE, 'orgs.json'));

const { start } = await import('./index.mjs');
const { closeStore } = await import('./store/db.mjs');
const { savedVersionIds } = await import('./pack-registry.mjs');
const { UPDATE_PREVIOUS_KEY, ADDITIONS_KEY } = await import('../tools/lib/pack-update.mjs');

const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(async () => {
  await new Promise((resolve) => srv.close(resolve));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const session = await signIn(BASE, 'ada', pw('ada'));
assert.equal(session.status, 200, `ada signs in: ${JSON.stringify(session.json)}`);
const COOKIE = session.session;

async function call(method, path, body) {
  const headers = { Accept: 'application/json', 'X-Observogram-CSRF': '1', Cookie: COOKIE, 'X-Observogram-Org': 'acme' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const post = (path, body) => call('POST', path, body);

const INPUTS = { id: 'http-service', name: 'checkout', tier: 'tier-2', environment: 'prod', owners: ['team-a'], params: { oncall_channel: '#checkout-oncall' } };
const SLO_ADDITION = { kind: 'slo', slo: { sli: 'availability', objective: 0.9995, window: '30d' }, burn_rate: { windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV2' }] } };
const ROUTE_ADDITION = { kind: 'route', route: { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/checkout' }] } };

let baseId, baseCanonical;

test('instantiate takes additions, applies them in order, and names a refused one as an addition warning', async () => {
  const r = await post('/api/library/instantiate', { ...INPUTS, additions: [SLO_ADDITION, ROUTE_ADDITION, { kind: 'slo', slo: { sli: 'nope', objective: 0.5, window: '30d' }, burn_rate: { windows: [] } }] });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.json.additions.applied.length, 2);
  assert.equal(r.json.additions.refused.length, 1);
  assert.equal(r.json.additions.refused[0].index, 2);
  const w = r.json.warnings.filter(x => x.kind === 'addition');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /addition 3 .*was not applied: slo\.sli: the pack has no SLI "nope"/);
  assert.ok(r.json.canonical.spec.slos.some(s => s.id === 'availability_99_95'));
  assert.ok(r.json.canonical.spec.policy.burn_rate_alerts.some(b => b.slo === 'availability_99_95'));
  assert.equal(r.json.canonical.spec.alerting.routes.filter(x => x.severity === 'SEV2').length, 2);
  assert.deepEqual(r.json.schemaErrors, []);
  assert.equal(JSON.parse(r.json.canonical.metadata.annotations[ADDITIONS_KEY]).length, 2);
  // The adapter and the summary are computed over the pack WITH its additions.
  assert.ok(r.json.adapted && r.json.summary);
  assert.ok(JSON.stringify(r.json.adapted).includes('hooks.example/checkout'), 'the projected pack carries the added route');
  const bad = await post('/api/library/instantiate', { ...INPUTS, additions: 'x' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.errors[0], /^additions: expected a list/);
});

test('a pack made in Build reopens exactly: its inputs, no additions, nothing foreign', async () => {
  const reg = await post('/api/library/register', INPUTS);
  assert.equal(reg.status, 200, reg.text.slice(0, 300));
  baseId = reg.json.registered.id;
  const r = await post('/api/library/reopen', { id: baseId });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const j = r.json;
  assert.equal(j.origin, 'build');
  assert.equal(j.originSentence, null);
  assert.equal(j.exact, true, JSON.stringify({ d: j.differences, f: j.foreign, m: j.missing, e: j.errors }));
  assert.equal(j.name, 'checkout');
  assert.equal(j.version, '0.1.0');
  assert.equal(j.head, null);
  assert.deepEqual(j.earlier, []);
  assert.deepEqual(j.inputs.entries, [{ id: 'http-service', version: '1.0.0' }]);
  assert.equal(j.inputs.tier, 'tier-2');
  assert.deepEqual(j.inputs.params, { oncall_channel: '#checkout-oncall' });
  assert.deepEqual(j.inputs.toggles.slis, ['availability', 'latency_p99']);
  assert.deepEqual(j.additions, []);
  assert.deepEqual(j.adoptable, { additions: [], leftover: [] });
  baseCanonical = j.canonical;
});

test('reopen: an unknown id is 404, a missing id 400', async () => {
  assert.equal((await post('/api/library/reopen', { id: 'uploaded-nope-00000000' })).status, 404);
  assert.equal((await post('/api/library/reopen', {})).status, 400);
});

test('reopen: a pack edited by hand names what Build did not write, and which of it reads in as additions', async () => {
  const hand = JSON.parse(JSON.stringify(baseCanonical));
  hand.spec.alerting.routes.push({ severity: 'SEV4', channels: [{ email: 'ops@example.test' }] });
  hand.spec.dashboards.push({ ...JSON.parse(JSON.stringify(hand.spec.dashboards[0])), id: 'extra-board' });
  const reg = await post('/api/library/register', { canonical: hand });
  assert.equal(reg.status, 200, reg.text.slice(0, 300));
  const r = await post('/api/library/reopen', { id: reg.json.registered.id });
  assert.equal(r.status, 200);
  assert.equal(r.json.origin, 'build');
  assert.equal(r.json.exact, false);
  assert.deepEqual(r.json.foreign.map(f => f.key), ['route:SEV4', 'dashboard:extra-board']);
  assert.deepEqual(r.json.adoptable.additions, [{ kind: 'route', route: { severity: 'SEV4', channels: [{ email: 'ops@example.test' }] } }]);
  assert.equal(r.json.adoptable.leftover.length, 1);
  assert.equal(r.json.adoptable.leftover[0].key, 'dashboard:extra-board');
  assert.match(r.json.adoptable.leftover[0].reason, /cannot be opened here yet/);
});

test('reopen: a scan is a reading with no definition; a shipped example is read-only', async () => {
  const scan = JSON.parse(JSON.stringify(baseCanonical));
  scan.metadata.name = 'checkout-scan';
  for (const k of Object.keys(scan.metadata.annotations)) delete scan.metadata.annotations[k];
  scan.metadata.annotations['crawler.discoveredAt'] = '2026-10-01T00:00:00.000Z';
  const reg = await post('/api/library/register', { canonical: scan });
  assert.equal(reg.status, 200, reg.text.slice(0, 300));
  const r = await post('/api/library/reopen', { id: reg.json.registered.id });
  assert.equal(r.json.origin, 'scan');
  assert.match(r.json.originSentence, /reading of the repository/);
  assert.equal(r.json.inputs, null);
  const examples = await call('GET', '/api/examples');
  const ex = examples.json.examples[0];
  const e = await post('/api/library/reopen', { id: ex.id });
  assert.equal(e.status, 200, e.text.slice(0, 200));
  assert.equal(e.json.origin, 'example');
  assert.match(e.json.originSentence, /read-only/);
});

let v2Id;
test('update saves the next version of the same pack: version bumped, lineage recorded, the base kept and superseded', async () => {
  const inst = await post('/api/library/instantiate', { ...INPUTS, additions: [SLO_ADDITION] });
  assert.equal(inst.status, 200);
  const r = await post('/api/library/update', { base: baseId, canonical: inst.json.canonical });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.json.registered.version, '0.2.0');
  assert.equal(r.json.registered.previous, baseId);
  assert.equal(r.json.registered.previousVersion, '0.1.0');
  assert.match(r.json.registered.source, /^library:http-service@tier-2$/);
  v2Id = r.json.registered.id;
  assert.notEqual(v2Id, baseId);
  const packs = (await call('GET', '/api/packs')).json.packs;
  const v1 = packs.find(p => p.id === baseId);
  const v2 = packs.find(p => p.id === v2Id);
  assert.ok(v1 && v2, 'both versions are listed');
  assert.equal(v1.superseded, true);
  assert.equal(v1.head, v2Id);
  assert.equal(v2.previous, baseId);
  assert.equal(v2.superseded, undefined);
  assert.equal(v2.version, '0.2.0');
  // The new version reopens exactly, with its addition, and names the version under it.
  const re = await post('/api/library/reopen', { id: v2Id });
  assert.equal(re.json.exact, true, JSON.stringify({ d: re.json.differences, f: re.json.foreign, m: re.json.missing }));
  assert.equal(re.json.additions.length, 1);
  assert.equal(re.json.additions[0].slo.id, 'availability_99_95');
  assert.deepEqual(re.json.earlier, [{ id: baseId, version: '0.1.0' }]);
  assert.equal(re.json.canonical.metadata.annotations[UPDATE_PREVIOUS_KEY], baseId);
  // The old version says which version replaced it.
  const old = await post('/api/library/reopen', { id: baseId });
  assert.deepEqual(old.json.head, { id: v2Id, version: '0.2.0' });
});

test('update refuses a moved base (409 with the newer version), a renamed pack (400), a reading (409) and an unknown base (404)', async () => {
  const inst = await post('/api/library/instantiate', INPUTS);
  const moved = await post('/api/library/update', { base: baseId, canonical: inst.json.canonical });
  assert.equal(moved.status, 409);
  assert.deepEqual(moved.json.newer, { id: v2Id, version: '0.2.0' });
  assert.match(moved.json.errors[0], /saved as v0\.2\.0 since this update began/);
  const renamed = await post('/api/library/instantiate', { ...INPUTS, name: 'checkout-two' });
  const ren = await post('/api/library/update', { base: v2Id, canonical: renamed.json.canonical });
  assert.equal(ren.status, 400);
  assert.match(ren.json.errors[0], /name changed \(checkout → checkout-two\)/);
  const packs = (await call('GET', '/api/packs')).json.packs;
  const scan = packs.find(p => p.name === 'checkout-scan');
  const reading = await post('/api/library/update', { base: scan.id, canonical: inst.json.canonical });
  assert.equal(reading.status, 409);
  assert.equal(reading.json.origin, 'scan');
  assert.equal((await post('/api/library/update', { base: 'uploaded-nope-00000000', canonical: inst.json.canonical })).status, 404);
  assert.equal((await post('/api/library/update', { canonical: inst.json.canonical })).status, 400);
  // A third version on the head still works, and the chain reads v3 → v2 → v1.
  const v3 = await post('/api/library/update', { base: v2Id, canonical: inst.json.canonical });
  assert.equal(v3.status, 200, v3.text.slice(0, 200));
  assert.equal(v3.json.registered.version, '0.3.0');
  const re = await post('/api/library/reopen', { id: v3.json.registered.id });
  assert.deepEqual(re.json.earlier.map(e => e.version), ['0.2.0', '0.1.0']);
});

test('the registry never evicts a saved version: every id of a chain is kept, a lone pack is not', () => {
  const pack = (name, version, previous = null) => ({ canonical: { metadata: { name, version, annotations: previous ? { [UPDATE_PREVIOUS_KEY]: previous } : {} } } });
  const uploads = new Map([
    ['a1', pack('a', '0.1.0')],
    ['a2', pack('a', '0.2.0', 'a1')],
    ['b1', pack('b', '0.1.0')],
    ['c1', pack('c', '0.1.0')],
  ]);
  assert.deepEqual([...savedVersionIds(uploads)].sort(), ['a1', 'a2']);
  // The incoming pack is the next version of c1: both are kept from now on.
  assert.deepEqual([...savedVersionIds(uploads, { id: 'c2', canonical: pack('c', '0.2.0', 'c1').canonical })].sort(), ['a1', 'a2', 'c1', 'c2']);
});
