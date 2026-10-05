#!/usr/bin/env node
/**
 * server/test-services-api.mjs — the services, environments and MCP
 * endpoints API (docs/STORE_PLAN.md slice 4, design §7), in-process over
 * HTTP on one stand-alone identity server, as test-identity-api.mjs does.
 *
 * For every route of server/routes/services.mjs: the success path with its
 * exact response and its exact audit rows (action, actor = the caller's
 * login, org, target, detail — each action one the route table lists for
 * it), and every refusal of design §7.4 with its status, text and no new
 * row. Then the registry's side of the records (STORE_PLAN slice 4 §4):
 * a register writes the service, environment and link rows by the person
 * registering, the same content again writes none; a service's deletion
 * cascades its environments and links, the packs stay — and the deletion
 * HOLDS across a rehydrate and a restart (A3: a rehydrate links only the
 * files it adopts; nothing under actor `system` recreates the service),
 * until the next register of a pack naming it recreates it by that
 * person; the reconcile of a pack's links when its plan moves (A5/B4: a
 * relabelled name-less pack, a pack relabelled into a live aggregate —
 * one primary at most, no stale primary for the tier rule); rows = tiles
 * (A6: the slugs the API serves equal the keys the studio's
 * serviceCatalogue() computes in Node over GET /api/packs); a viewer reads
 * an environment's endpoints in full (D14); DELETE /api/uploads keeps the
 * services. The MCP endpoints (admin): the create, update and delete with
 * their rows (the origin and the variable's name, never the URL's path —
 * A9), every refusal (the URL word rule and the per-org variable, the
 * repository's texts), the view by rank (a viewer reads no url and no
 * variable), an environment bound to one and unbound by its deletion, and
 * the guard's answers in this posture (the admin role; the CSRF header
 * from every session, under the endpoints' own text).
 *
 * Who may reach these routes in each posture is test-authz's (the AuthZ
 * matrix) and which org's rows a member reaches is test-tenancy's; this
 * suite is what the routes do once reached.
 *
 * The fixture is test-identity-api's: default {olive: admin} (an owner),
 * acme {ada: admin, oscar: operator, vera: viewer}, bravo {bob: admin}.
 */

// Hermetic (§0): a developer shell's store, identity or per-org token
// variables never reach this process's imports. serve-child.mjs imports no
// server code.
const { STRIP, serve, signIn } = await import('./fixtures/serve-child.mjs');
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
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-services-api-'));
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
const { currentStore, closeStore, openRaw, prepare } = await import('./store/db.mjs');
const { runWithOrg } = await import('./org-context.mjs');
const { registerPack, resetPackRegistry } = await import('./pack-registry.mjs');
const { listServicesForPack, linkPackService } = await import('./store/pack-services.mjs');
const { addPack, removePack } = await import('./store/packs.mjs');
const { WAYS, serviceTierFor } = await import('./service-admin.mjs');
const { envNameOwnerText, envNameShapeText } = await import('./store/mcp-endpoints.mjs');
const { routeEntry } = await import('./route-table.mjs');
const { evaluateConformance } = await import('../tools/lib/conformance.mjs');
const { instantiatePack, validationSummary, todosFromAnnotations } = await import('../tools/lib/library.mjs');
const { loadLibrary, findEntry } = await import('./library.mjs');
const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
const serviceKeys = await import('../tools/lib/service-keys.mjs');

let srv = await start({ port: 0, host: '127.0.0.1', silent: true });
let BASE = `http://127.0.0.1:${srv.address().port}`;
const db = currentStore();

// The in-process server and its store close before the restart test
// starts a child on the same workspace; `after` closes what is still open.
let inProcess = true;
async function closeInProcess() {
  if (!inProcess) return;
  inProcess = false;
  await new Promise((resolve) => srv.close(resolve));
  closeStore();
}
after(async () => {
  await closeInProcess();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const cookies = {};
async function signInAs(base, login) {
  const s = await signIn(base, login, pw(login));
  assert.equal(s.status, 200, `${login} signs in: ${JSON.stringify(s.json)}`);
  assert.ok(s.session, `${login} gets a session`);
  cookies[login] = s.session;
  return s.session;
}
for (const login of ['olive', 'ada', 'oscar', 'vera', 'bob']) await signInAs(BASE, login);

// ---------- requests and the audit trail ----------

const CSRF = { 'X-Observogram-CSRF': '1' };

// One request as `who` (a login whose cookie is held): { status, json, text }.
// olive, an owner with no acme membership, names acme (else her default org).
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
  return { status: r.status, json, text };
}

// `fn` with everything the in-process server writes to this process's
// stdout or stderr meanwhile (console.* writes through the two streams),
// passed through: { result, output }. The one gate on §7.6's "never
// logged": a token's value is in no response AND in no line of output.
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

// A successful call of route `key`: its status, and the rows it wrote —
// each an action the route table lists for the route (exact per build).
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
// A 16-digit id past 2^53 - 1 is refused too: bound as a number it would
// round, and a refusal would name an id the caller never sent.
const BAD_IDS = ['abc', '0', '01', '-1', '1.5', '1e3', '12345678901234567', '9007199254740992', '9007199254740993', '9999999999999999'];
const SERVICE_ID_TEXT = 'service id must be a positive integer, at most 9007199254740991';
const ENVIRONMENT_ID_TEXT = 'environment id must be a positive integer, at most 9007199254740991';
const MCP_ENDPOINT_ID_TEXT = 'MCP endpoint id must be a positive integer, at most 9007199254740991';

const SERVICE_KEYS = ['id', 'slug', 'name', 'owners', 'tier', 'description', 'source', 'createdAt', 'updatedAt', 'environments', 'packs'];
const ENVIRONMENT_KEYS = ['id', 'serviceId', 'name', 'tier', 'effectiveTier', 'bindings', 'endpoints', 'mcpEndpoint', 'createdAt', 'updatedAt'];
const isServiceView = (s) => {
  assert.deepEqual(Object.keys(s), SERVICE_KEYS, `the service view of ${s.slug}: named fields only`);
  assert.ok(ISO.test(s.createdAt) && ISO.test(s.updatedAt), 'timestamps');
  s.environments.forEach(isEnvironmentView);
};
const isEnvironmentView = (e) => {
  assert.deepEqual(Object.keys(e), ENVIRONMENT_KEYS, `the environment view of ${e.name}: named fields only`);
  assert.ok(ISO.test(e.createdAt) && ISO.test(e.updatedAt), 'timestamps');
};
const MCP_ENDPOINT_KEYS = ['id', 'name', 'origin', 'url', 'readTokenEnv', 'environments', 'createdAt'];
const isMcpEndpointView = (e) => {
  assert.deepEqual(Object.keys(e), MCP_ENDPOINT_KEYS, `the MCP endpoint view of ${e.name}: named fields only`);
  assert.ok(ISO.test(e.createdAt), 'timestamp');
};
// A view with its timestamps replaced, for a deepEqual.
const stamped = (v) => (v === null ? null : { ...v, createdAt: 'T', updatedAt: 'T', ...(v.environments ? { environments: v.environments.map(stamped) } : {}) });

const DEMO_YAML = readFileSync(join(ROOT, 'examples', 'demo-skeleton.pack.yaml'), 'utf8');
const DEMO = parseYaml(DEMO_YAML);
const YAML = { 'Content-Type': 'text/yaml' };

// The ids the tests create, by name.
const ids = {};

// ---------- the reads on an empty org ----------

test('GET /api/services on an org without a record: an empty list, no row; a viewer reads it', async () => {
  const { json, rows } = await ok('GET /api/services', 'vera', '/api/services');
  assert.deepEqual([json, rows], [{ ok: true, services: [] }, []]);
});

// ---------- services ----------

test('POST /api/services: a service record (201) as the view, its exact row; the defaults; the slug is the name\'s key', async () => {
  const { json, rows } = await ok('POST /api/services', 'oscar', '/api/services', {
    name: 'Checkout Service', owners: [' team-pay ', 'sre'], tier: 'tier-1', description: 'the checkout', ignored: 'field',
  }, 201);
  isServiceView(json.service);
  ids.checkout = json.service.id;
  assert.deepEqual(stamped(json.service), {
    id: ids.checkout, slug: 'checkout-service', name: 'Checkout Service', owners: ['team-pay', 'sre'], tier: 'tier-1', description: 'the checkout',
    source: { kind: 'observogram' }, createdAt: 'T', updatedAt: 'T', environments: [], packs: [],
  });
  assert.deepEqual(rows, [['service.create', 'oscar', 'acme', 'checkout-service', null]]);
  // The defaults: owners [], tier null (graded by the pack), description null; an explicit slug.
  const second = await ok('POST /api/services', 'ada', '/api/services', { name: 'Payments', slug: 'payments' }, 201);
  ids.payments = second.json.service.id;
  assert.deepEqual(stamped(second.json.service), {
    id: ids.payments, slug: 'payments', name: 'Payments', owners: [], tier: null, description: null,
    source: { kind: 'observogram' }, createdAt: 'T', updatedAt: 'T', environments: [], packs: [],
  });
  assert.deepEqual(second.rows, [['service.create', 'ada', 'acme', 'payments', null]]);
  // tier: null is "graded by the pack", explicitly.
  const third = await ok('POST /api/services', 'oscar', '/api/services', { name: 'Ledger Nulls', tier: null, description: null }, 201);
  ids.ledgerNulls = third.json.service.id;
  assert.deepEqual([third.json.service.tier, third.json.service.description], [null, null]);
});

test('POST /api/services: every refusal, its status and text, and no row', async () => {
  const K = 'POST /api/services';
  const P = '/api/services';
  for (const name of [undefined, '', '   ', 'x'.repeat(201), 42, null]) await refused(K, 'oscar', P, { name }, 400, WAYS.serviceName);
  await refused(K, 'oscar', P, '["Checkout"]', 400, WAYS.serviceName);           // not a JSON object: nothing named
  for (const slug of ['Pay Ments', 'pay_ments', '-pay', 'pay-', 'p'.repeat(201), 7]) {
    await refused(K, 'oscar', P, { name: 'Pay', slug }, 400, WAYS.slug(slug));
  }
  assert.equal(WAYS.slug('Pay Ments'), '"Pay Ments" is not a service slug (lowercase letters, digits and -, as the catalogue keys services: "pay-ments")');
  await refused(K, 'oscar', P, { name: '!!!' }, 400, WAYS.noSlug('!!!'));
  assert.equal(WAYS.noSlug('!!!'), '"!!!" yields no slug — send "slug"');
  for (const owners of ['team', {}, Array(51).fill('t'), [''], ['x'.repeat(201)], [42], [null]]) await refused(K, 'oscar', P, { name: 'Pay', owners }, 400, WAYS.owners);
  for (const tier of ['gold', 'tier-4', 'TIER-1', 1, '']) await refused(K, 'oscar', P, { name: 'Pay', tier }, 400, WAYS.tier(tier));
  assert.equal(WAYS.tier('gold'), 'a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not "gold"');
  for (const description of ['d'.repeat(4001), 42, {}]) await refused(K, 'oscar', P, { name: 'Pay', description }, 400, WAYS.description);
  await refused(K, 'oscar', P, { name: 'Checkout Service' }, 409, `service "checkout-service" exists (id ${ids.checkout}) — PATCH /api/services/${ids.checkout} changes it`);
  await refused(K, 'oscar', P, { name: 'Other', slug: 'payments' }, 409, `service "payments" exists (id ${ids.payments}) — PATCH /api/services/${ids.payments} changes it`);
});

test('GET /api/services and GET /api/services/:id: the views by slug, as a viewer; 404 and the id rule', async () => {
  const { json, rows } = await ok('GET /api/services', 'vera', '/api/services');
  assert.deepEqual(rows, []);
  json.services.forEach(isServiceView);
  assert.deepEqual(json.services.map((s) => s.slug), ['checkout-service', 'ledger-nulls', 'payments']);
  const one = await ok('GET /api/services/:id', 'vera', `/api/services/${ids.checkout}`);
  assert.deepEqual(stamped(one.json.service), {
    id: ids.checkout, slug: 'checkout-service', name: 'Checkout Service', owners: ['team-pay', 'sre'], tier: 'tier-1', description: 'the checkout',
    source: { kind: 'observogram' }, createdAt: 'T', updatedAt: 'T', environments: [], packs: [],
  });
  await refused('GET /api/services/:id', 'vera', '/api/services/999999', 404, 'no service 999999');
  for (const id of BAD_IDS) await refused('GET /api/services/:id', 'vera', `/api/services/${id}`, 400, SERVICE_ID_TEXT);
});

test('PATCH /api/services/:id: name, owners, tier, description with `changed` and one row; nothing differing → changed [] and no row; the slug is fixed', async () => {
  const K = 'PATCH /api/services/:id';
  const P = `/api/services/${ids.checkout}`;
  const { json, rows } = await ok(K, 'oscar', P, { name: 'Checkout', owners: ['team-pay'], tier: 'tier-2', description: null, slugx: 'ignored' });
  assert.deepEqual(json.changed, ['name', 'owners', 'tier', 'description']);
  assert.deepEqual(stamped(json.service), {
    id: ids.checkout, slug: 'checkout-service', name: 'Checkout', owners: ['team-pay'], tier: 'tier-2', description: null,
    source: { kind: 'observogram' }, createdAt: 'T', updatedAt: 'T', environments: [], packs: [],
  });
  assert.deepEqual(rows, [['service.update', 'oscar', 'acme', 'checkout-service', { fields: ['name', 'owners', 'tier', 'description'] }]]);
  // Only what differs is a change (and a row names only those fields).
  const partial = await ok(K, 'ada', P, { name: 'Checkout', tier: 'tier-1' });
  assert.deepEqual([partial.json.changed, partial.rows], [['tier'], [['service.update', 'ada', 'acme', 'checkout-service', { fields: ['tier'] }]]]);
  const same = await ok(K, 'oscar', P, { name: 'Checkout', owners: ['team-pay'], tier: 'tier-1' });
  assert.deepEqual([same.json.changed, same.rows], [[], []]);
  const empty = await ok(K, 'oscar', P, {});
  assert.deepEqual([empty.json.changed, empty.rows, empty.json.service.tier], [[], [], 'tier-1']);
  // tier: null clears a tier (graded by the pack again).
  const cleared = await ok(K, 'oscar', `/api/services/${ids.payments}`, { tier: 'tier-3' });
  assert.deepEqual(cleared.json.changed, ['tier']);
  const back = await ok(K, 'oscar', `/api/services/${ids.payments}`, { tier: null });
  assert.deepEqual([back.json.changed, back.json.service.tier, back.rows], [['tier'], null, [['service.update', 'oscar', 'acme', 'payments', { fields: ['tier'] }]]]);
  // The refusals.
  await refused(K, 'oscar', P, { slug: 'checkout' }, 400, WAYS.slugFixed);
  assert.equal(WAYS.slugFixed, "a service's slug is fixed (packs link to it by slug) — create a new service with POST /api/services");
  await refused(K, 'oscar', P, { slug: 'checkout-service' }, 400, WAYS.slugFixed);   // even its own: the field is not patchable
  await refused(K, 'oscar', P, { name: '' }, 400, WAYS.serviceName);
  await refused(K, 'oscar', P, { owners: 'x' }, 400, WAYS.owners);
  await refused(K, 'oscar', P, { tier: 'gold' }, 400, WAYS.tier('gold'));
  await refused(K, 'oscar', P, { description: 'd'.repeat(4001) }, 400, WAYS.description);
  await refused(K, 'oscar', '/api/services/999999', { name: 'x' }, 404, 'no service 999999');
  for (const id of BAD_IDS) await refused(K, 'oscar', `/api/services/${id}`, { name: 'x' }, 400, SERVICE_ID_TEXT);
});

// ---------- environments ----------

test('POST /api/services/:id/environments: an environment (201) as the view, its exact row; effectiveTier falls back to the service\'s', async () => {
  const K = 'POST /api/services/:id/environments';
  const P = `/api/services/${ids.checkout}/environments`;
  const endpoints = { grafana: 'https://grafana.example/d/abc?tier=gold&orgId=1', runbook: 'http://wiki.example/checkout' };
  const { json, rows } = await ok(K, 'oscar', P, { name: 'prod', bindings: { region: 'eu-west-1', cluster: 'prod-a' }, endpoints, extra: 1 }, 201);
  isEnvironmentView(json.environment);
  ids.prod = json.environment.id;
  assert.deepEqual(stamped(json.environment), {
    id: ids.prod, serviceId: ids.checkout, name: 'prod', tier: null, effectiveTier: 'tier-1',
    bindings: { region: 'eu-west-1', cluster: 'prod-a' }, endpoints, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T',
  });
  assert.deepEqual(rows, [['environment.create', 'oscar', 'acme', 'checkout-service/prod', null]]);
  // Its own tier overrides the service's; the defaults are {} and {}.
  const staging = await ok(K, 'ada', P, { name: 'staging', tier: 'tier-3' }, 201);
  ids.staging = staging.json.environment.id;
  assert.deepEqual(stamped(staging.json.environment), {
    id: ids.staging, serviceId: ids.checkout, name: 'staging', tier: 'tier-3', effectiveTier: 'tier-3',
    bindings: {}, endpoints: {}, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T',
  });
  assert.deepEqual(staging.rows, [['environment.create', 'ada', 'acme', 'checkout-service/staging', null]]);
  // A service without a tier: effectiveTier null (graded by the pack).
  const dev = await ok(K, 'oscar', `/api/services/${ids.payments}/environments`, { name: 'dev' }, 201);
  ids.paymentsDev = dev.json.environment.id;
  assert.deepEqual([dev.json.environment.tier, dev.json.environment.effectiveTier], [null, null]);
});

test('POST /api/services/:id/environments: every refusal, its status and text, and no row', async () => {
  const K = 'POST /api/services/:id/environments';
  const P = `/api/services/${ids.checkout}/environments`;
  await refused(K, 'oscar', '/api/services/999999/environments', { name: 'prod' }, 404, 'no service 999999');
  for (const id of BAD_IDS) await refused(K, 'oscar', `/api/services/${id}/environments`, { name: 'prod' }, 400, SERVICE_ID_TEXT);
  for (const name of [undefined, '', 'x'.repeat(201), 3]) await refused(K, 'oscar', P, { name }, 400, WAYS.environmentName);
  await refused(K, 'oscar', P, { name: 'prod' }, 409, `environment "prod" of checkout-service exists (id ${ids.prod}) — PATCH /api/environments/${ids.prod} changes it`);
  // Names are trimmed like owners: ' prod ' is the existing prod, not a second one.
  await refused(K, 'oscar', P, { name: ' prod ' }, 409, `environment "prod" of checkout-service exists (id ${ids.prod}) — PATCH /api/environments/${ids.prod} changes it`);
  await refused(K, 'oscar', P, { name: 'qa', tier: 'gold' }, 400, WAYS.tier('gold'));
  for (const bindings of ['eu', [], { region: 1 }, { region: '' }, { ['k'.repeat(257)]: 'v' }, { region: 'v'.repeat(257) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))]) {
    await refused(K, 'oscar', P, { name: 'qa', bindings }, 400, WAYS.bindings);
  }
  assert.equal(WAYS.bindings, 'bindings is an object of at most 32 string values; keys and values are 1–256 characters');
  for (const endpoints of ['https://x', [], Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`e${i}`, 'https://x.example/']))]) {
    await refused(K, 'oscar', P, { name: 'qa', endpoints }, 400, WAYS.endpoints());
  }
  assert.equal(WAYS.endpoints(), 'endpoints is an object of at most 20 http(s) URLs by name');
  for (const bad of ['not a url', 'ftp://x.example/', 'mailto:a@b', '', 42]) {
    await refused(K, 'oscar', P, { name: 'qa', endpoints: { grafana: bad } }, 400, WAYS.endpoints('grafana'));
  }
  assert.equal(WAYS.endpoints('grafana'), 'endpoints is an object of at most 20 http(s) URLs by name; "grafana" is not one');
  // A credential in a link: the §7.5 word rule (names only, never a value;
  // the decoded name — %74oken is "token"; the carrying parameter of a ;-pair).
  const CRED = (where, note) => `${where} carries ${note} — a token goes in the auth field, never in a URL`;
  await refused(K, 'oscar', P, { name: 'qa', endpoints: { grafana: 'https://g.example/?token=abc&sig=x' } }, 400, CRED('endpoints.grafana', 'the parameter(s) "token", "sig", which look like credentials'));
  await refused(K, 'oscar', P, { name: 'qa', endpoints: { prom: 'https://p.example/?%74oken=abc' } }, 400, CRED('endpoints.prom', 'the parameter(s) "token", which look like credentials'));
  await refused(K, 'oscar', P, { name: 'qa', endpoints: { prom: 'https://p.example/?tier=x;pwd=y' } }, 400, CRED('endpoints.prom', 'the parameter(s) "tier", which look like credentials'));
  await refused(K, 'oscar', P, { name: 'qa', endpoints: { prom: 'https://user:pw@p.example/' } }, 400, CRED('endpoints.prom', 'userinfo'));
  await refused(K, 'oscar', P, { name: 'qa', endpoints: { prom: 'https://p.example/#frag' } }, 400, CRED('endpoints.prom', 'a fragment'));
  // An endpoint id no record of this org holds (none exists yet).
  for (const mcpEndpointId of [999999, '999999', 0, 'x', true]) {
    await refused(K, 'oscar', P, { name: 'qa', mcpEndpointId }, 400, WAYS.noMcpEndpointInOrg(mcpEndpointId));
  }
  assert.equal(WAYS.noMcpEndpointInOrg(999999), 'no MCP endpoint 999999 in this org — GET /api/mcp-endpoints lists them');
  // A name clash is checked after the fields: a bad tier on an existing name is the 400.
  await refused(K, 'oscar', P, { name: 'prod', tier: 'gold' }, 400, WAYS.tier('gold'));
});

test('GET /api/services/:id/environments and GET /api/environments/:id: the views by name, as a viewer — endpoints in full (D14); 404 and the id rule', async () => {
  const list = await ok('GET /api/services/:id/environments', 'vera', `/api/services/${ids.checkout}/environments`);
  assert.deepEqual(list.rows, []);
  assert.deepEqual(list.json.service, { id: ids.checkout, slug: 'checkout-service', name: 'Checkout', tier: 'tier-1' });
  list.json.environments.forEach(isEnvironmentView);
  assert.deepEqual(list.json.environments.map((e) => [e.name, e.effectiveTier]), [['prod', 'tier-1'], ['staging', 'tier-3']]);
  await refused('GET /api/services/:id/environments', 'vera', '/api/services/999999/environments', 404, 'no service 999999');
  for (const id of BAD_IDS) await refused('GET /api/services/:id/environments', 'vera', `/api/services/${id}/environments`, 400, SERVICE_ID_TEXT);
  const one = await ok('GET /api/environments/:id', 'vera', `/api/environments/${ids.prod}`);
  assert.deepEqual(one.rows, []);
  assert.deepEqual({ ...one.json, environment: stamped(one.json.environment) }, {
    ok: true,
    environment: {
      id: ids.prod, serviceId: ids.checkout, name: 'prod', tier: null, effectiveTier: 'tier-1', bindings: { region: 'eu-west-1', cluster: 'prod-a' },
      endpoints: { grafana: 'https://grafana.example/d/abc?tier=gold&orgId=1', runbook: 'http://wiki.example/checkout' }, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T',
    },
    service: { id: ids.checkout, slug: 'checkout-service', name: 'Checkout', tier: 'tier-1' },
  });
  // The service view carries its environments by name, with the same endpoints.
  const svc = await ok('GET /api/services/:id', 'vera', `/api/services/${ids.checkout}`);
  assert.deepEqual(svc.json.service.environments.map((e) => e.id), [ids.prod, ids.staging]);
  assert.deepEqual(svc.json.service.environments[0].endpoints, { grafana: 'https://grafana.example/d/abc?tier=gold&orgId=1', runbook: 'http://wiki.example/checkout' });
  await refused('GET /api/environments/:id', 'vera', '/api/environments/999999', 404, 'no environment 999999');
  for (const id of BAD_IDS) await refused('GET /api/environments/:id', 'vera', `/api/environments/${id}`, 400, ENVIRONMENT_ID_TEXT);
});

test('PATCH /api/environments/:id: name, tier, bindings, endpoints, mcpEndpointId with `changed` and one row; a rename clash is 409; nothing differing → no row', async () => {
  const K = 'PATCH /api/environments/:id';
  const P = `/api/environments/${ids.prod}`;
  // The name is stored trimmed (' production ' → 'production').
  const { json, rows } = await ok(K, 'oscar', P, { name: ' production ', tier: 'tier-2', bindings: { region: 'eu-west-1' }, endpoints: {}, mcpEndpointId: null });
  assert.deepEqual(json.changed, ['name', 'tier', 'bindings', 'endpoints']);   // mcpEndpointId: null on an unbound environment differs in nothing
  assert.deepEqual(stamped(json.environment), {
    id: ids.prod, serviceId: ids.checkout, name: 'production', tier: 'tier-2', effectiveTier: 'tier-2',
    bindings: { region: 'eu-west-1' }, endpoints: {}, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T',
  });
  // The row names the environment as it was and the fields written (API names, as the create rows and `changed`).
  assert.deepEqual(rows, [['environment.update', 'oscar', 'acme', 'checkout-service/prod', { fields: ['name', 'tier', 'bindings', 'endpoints'] }]]);
  const same = await ok(K, 'oscar', P, { name: 'production', bindings: { region: 'eu-west-1' }, mcpEndpointId: null });
  assert.deepEqual([same.json.changed, same.rows], [[], []]);
  const back = await ok(K, 'ada', P, { name: 'prod', tier: null, endpoints: { grafana: 'https://grafana.example/d/abc?tier=gold&orgId=1' } });
  assert.deepEqual([back.json.changed, back.json.environment.effectiveTier], [['name', 'tier', 'endpoints'], 'tier-1']);
  assert.deepEqual(back.rows, [['environment.update', 'ada', 'acme', 'checkout-service/production', { fields: ['name', 'tier', 'endpoints'] }]]);
  // The refusals.
  await refused(K, 'oscar', P, { name: 'staging' }, 409, `environment "staging" of checkout-service exists (id ${ids.staging}) — PATCH /api/environments/${ids.staging} changes it`);
  await refused(K, 'oscar', P, { name: '' }, 400, WAYS.environmentName);
  await refused(K, 'oscar', P, { tier: 'gold' }, 400, WAYS.tier('gold'));
  await refused(K, 'oscar', P, { bindings: [] }, 400, WAYS.bindings);
  await refused(K, 'oscar', P, { endpoints: { g: 'ftp://x' } }, 400, WAYS.endpoints('g'));
  await refused(K, 'oscar', P, { endpoints: { g: 'https://x.example/?api_key=1' } }, 400, 'endpoints.g carries the parameter(s) "api_key", which look like credentials — a token goes in the auth field, never in a URL');
  await refused(K, 'oscar', P, { mcpEndpointId: 999999 }, 400, WAYS.noMcpEndpointInOrg(999999));
  await refused(K, 'oscar', '/api/environments/999999', { tier: 'tier-1' }, 404, 'no environment 999999');
  for (const id of BAD_IDS) await refused(K, 'oscar', `/api/environments/${id}`, { tier: 'tier-1' }, 400, ENVIRONMENT_ID_TEXT);
  // The same name as its own is no clash.
  const own = await ok(K, 'oscar', P, { name: 'prod' });
  assert.deepEqual([own.json.changed, own.rows], [[], []]);
});

test('DELETE /api/environments/:id: the view as it was, one row; gone afterwards', async () => {
  const K = 'DELETE /api/environments/:id';
  const { json, rows } = await ok(K, 'oscar', `/api/environments/${ids.staging}`);
  assert.deepEqual(stamped(json.deleted), {
    id: ids.staging, serviceId: ids.checkout, name: 'staging', tier: 'tier-3', effectiveTier: 'tier-3',
    bindings: {}, endpoints: {}, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T',
  });
  assert.deepEqual(rows, [['environment.delete', 'oscar', 'acme', 'checkout-service/staging', null]]);
  await refused('GET /api/environments/:id', 'vera', `/api/environments/${ids.staging}`, 404, `no environment ${ids.staging}`);
  await refused(K, 'oscar', `/api/environments/${ids.staging}`, 404, `no environment ${ids.staging}`);
  for (const id of BAD_IDS) await refused(K, 'oscar', `/api/environments/${id}`, 400, ENVIRONMENT_ID_TEXT);
  const list = await ok('GET /api/services/:id/environments', 'vera', `/api/services/${ids.checkout}/environments`);
  assert.deepEqual(list.json.environments.map((e) => e.name), ['prod']);
});

// ---------- MCP endpoints (admin; the identity API's defences) ----------

const MCP_URL = 'https://mcp.acme.test/mcp/s/sk-path-secret/obs?tier=x';
const MCP_ORIGIN = 'https://mcp.acme.test';
const ACME_TOKEN = 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN';
// A 403 is the guard's: { ok, error, denied, … }, and no row.
async function denied(key, who, path, body, kind, error) {
  const { method } = routeEntry(key);
  if (noBody(method)) [body, kind, error] = [undefined, body, kind];
  const seq = seqNow();
  const r = await call(who, method, path, body);
  assert.deepEqual([r.status, r.json.ok, r.json.denied, r.json.error], [403, false, kind, error], `${key} as ${who}`);
  assert.deepEqual(rowsAfter(seq), [], `${key}: a refusal writes no row`);
}

test('POST /api/mcp-endpoints: a record (201) as the admin\'s own view, its exact row (the origin and the variable, never the URL\'s path); an owner too; the CSRF header from every session; operators and viewers refused by the guard', async () => {
  const K = 'POST /api/mcp-endpoints';
  const { json, rows } = await ok(K, 'ada', '/api/mcp-endpoints', { name: 'prod-mcp', url: MCP_URL, readTokenEnv: ACME_TOKEN, extra: 1 }, 201);
  isMcpEndpointView(json.endpoint);
  ids.mcp = json.endpoint.id;
  assert.deepEqual({ ...json.endpoint, createdAt: 'T' }, { id: ids.mcp, name: 'prod-mcp', origin: MCP_ORIGIN, url: MCP_URL, readTokenEnv: ACME_TOKEN, environments: 0, createdAt: 'T' });
  assert.deepEqual(rows, [['mcp_endpoint.create', 'ada', 'acme', 'prod-mcp', { fields: ['name', 'url', 'readTokenEnv'], origin: MCP_ORIGIN, readTokenEnv: ACME_TOKEN }]]);
  assert.ok(!JSON.stringify(rows).includes('sk-path-secret'), 'the row never holds the URL\'s path');
  // An owner in the org; no variable → null.
  const second = await ok(K, 'olive', '/api/mcp-endpoints', { name: 'staging-mcp', url: 'http://mcp-staging.acme.test:8080/mcp' }, 201);
  ids.mcpStaging = second.json.endpoint.id;
  assert.deepEqual({ ...second.json.endpoint, createdAt: 'T' }, {
    id: ids.mcpStaging, name: 'staging-mcp', origin: 'http://mcp-staging.acme.test:8080', url: 'http://mcp-staging.acme.test:8080/mcp', readTokenEnv: null, environments: 0, createdAt: 'T',
  });
  assert.deepEqual(second.rows, [['mcp_endpoint.create', 'olive', 'acme', 'staging-mcp', { fields: ['name', 'url', 'readTokenEnv'], origin: 'http://mcp-staging.acme.test:8080', readTokenEnv: null }]]);
  // The guard: the admin role, and the header in every posture (csrf: always).
  await denied(K, 'oscar', '/api/mcp-endpoints', { name: 'x', url: MCP_URL }, 'role', "requires the admin role in org 'acme' (you are operator) — ask an admin of acme");
  await denied(K, 'vera', '/api/mcp-endpoints', { name: 'x', url: MCP_URL }, 'role', "requires the admin role in org 'acme' (you are viewer) — ask an admin of acme");
  const seq = seqNow();
  const bare = await fetch(`${BASE}/api/mcp-endpoints`, {
    method: 'POST', headers: { Accept: 'application/json', Cookie: cookies.ada, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x', url: MCP_URL }),
  });
  // (With sign-in, the session gate's own CSRF check answers first; the
  // entry's always-text is what `local` reads without sign-in — test-authz.)
  assert.deepEqual([bare.status, await bare.json()], [403, { ok: false, denied: 'csrf', error: 'missing X-Observogram-CSRF header on a session-authenticated mutation' }], 'ada without the header');
  assert.deepEqual(rowsAfter(seq), []);
});

test('POST /api/mcp-endpoints: every refusal, its status and text, and no row — the name, a clash, the URL rules (never echoing the URL), the per-org variable', async () => {
  const K = 'POST /api/mcp-endpoints';
  const P = '/api/mcp-endpoints';
  for (const name of [undefined, '', 'x'.repeat(201), 3]) await refused(K, 'ada', P, { name, url: MCP_URL }, 400, WAYS.mcpEndpointName);
  assert.equal(WAYS.mcpEndpointName, 'an MCP endpoint name is 1–200 characters');
  await refused(K, 'ada', P, { name: 'prod-mcp', url: MCP_URL }, 409, `MCP endpoint "prod-mcp" exists (id ${ids.mcp}) — PATCH /api/mcp-endpoints/${ids.mcp} changes it`);
  // The URL: the repository's texts (a TypeError → 400), none echoing the URL.
  for (const url of [undefined, '', 42, 'x'.repeat(2001)]) await refused(K, 'ada', P, { name: 'u', url }, 400, 'observogram store: url must be a non-empty string of at most 2000 characters');
  await refused(K, 'ada', P, { name: 'u', url: 'not a url' }, 400, 'observogram store: url is not a URL');
  await refused(K, 'ada', P, { name: 'u', url: 'ftp://mcp.acme.test/x' }, 400, 'observogram store: an MCP endpoint is http(s)');
  await refused(K, 'ada', P, { name: 'u', url: 'https://user:pw@mcp.acme.test/x' }, 400, 'observogram store: an MCP endpoint URL may not carry credentials — name an env var in readTokenEnv');
  await refused(K, 'ada', P, { name: 'u', url: 'https://mcp.acme.test/x#frag' }, 400, 'observogram store: an MCP endpoint URL has no fragment');
  const WORD = (names) => `observogram store: an MCP endpoint URL may not carry credentials in its query — the parameter(s) ${names} look like credentials; remove them and name an env var in readTokenEnv`;
  await refused(K, 'ada', P, { name: 'u', url: 'https://mcp.acme.test/x?token=abc&sig=x&tier=x' }, 400, WORD('"token", "sig"'));
  await refused(K, 'ada', P, { name: 'u', url: 'https://mcp.acme.test/x?%74oken=abc' }, 400, WORD('"token"'));
  await refused(K, 'ada', P, { name: 'u', url: 'https://mcp.acme.test/x?api_key=1' }, 400, WORD('"api_key"'));
  await refused(K, 'ada', P, { name: 'u', url: 'https://mcp.acme.test/x?tier=x;pwd=y' }, 400, WORD('"tier"'));
  // The variable: this org's, OBSERVOGRAM_ORG_ACME_<NAME>; another org's is
  // refused naming its owner; a name no org owns, or of the wrong shape, the shape.
  for (const readTokenEnv of ['MCP_TOKEN', 'OBSERVOGRAM_ORG_ACME_', 'observogram_org_acme_token', 'OBSERVOGRAM_ORG_NOBODY_X', 42]) {
    await refused(K, 'ada', P, { name: 'u', url: MCP_URL, readTokenEnv }, 400, envNameShapeText(readTokenEnv, 'acme'));
  }
  assert.equal(envNameShapeText('MCP_TOKEN', 'acme'),
    'observogram store: readTokenEnv names an env var of this org, OBSERVOGRAM_ORG_<KEY>_<NAME> with <NAME> of [A-Z0-9_]+ (for example OBSERVOGRAM_ORG_ACME_MCP_TOKEN), not "MCP_TOKEN" — an admin may only name variables set aside for their org');
  await refused(K, 'ada', P, { name: 'u', url: MCP_URL, readTokenEnv: 'OBSERVOGRAM_ORG_BRAVO_TOKEN' }, 400, envNameOwnerText('OBSERVOGRAM_ORG_BRAVO_TOKEN', ['bravo']));
  assert.equal(envNameOwnerText('OBSERVOGRAM_ORG_BRAVO_TOKEN', ['bravo']),
    'observogram store: OBSERVOGRAM_ORG_BRAVO_TOKEN belongs to org bravo (the longest org prefix wins) — an admin may only name variables set aside for their org');
  // The name clash is checked after the name, before the URL and the variable.
  await refused(K, 'ada', P, { name: 'prod-mcp', url: 'not a url' }, 409, `MCP endpoint "prod-mcp" exists (id ${ids.mcp}) — PATCH /api/mcp-endpoints/${ids.mcp} changes it`);
});

test('GET /api/mcp-endpoints by rank: the url and the variable to an operator and above, null to a viewer; the origin and the name to every member; by name; another org lists its own only', async () => {
  const K = 'GET /api/mcp-endpoints';
  const vera = await ok(K, 'vera', '/api/mcp-endpoints');
  vera.json.endpoints.forEach(isMcpEndpointView);
  assert.deepEqual(vera.json.endpoints.map((e) => ({ ...e, createdAt: 'T' })), [
    { id: ids.mcp, name: 'prod-mcp', origin: MCP_ORIGIN, url: null, readTokenEnv: null, environments: 0, createdAt: 'T' },
    { id: ids.mcpStaging, name: 'staging-mcp', origin: 'http://mcp-staging.acme.test:8080', url: null, readTokenEnv: null, environments: 0, createdAt: 'T' },
  ], 'vera: the name and origin only, by name');
  const veraText = JSON.stringify(vera.json);
  assert.ok(!veraText.includes('sk-path-secret') && !veraText.includes('OBSERVOGRAM_ORG'), 'nothing of the url or the variable reaches a viewer');
  for (const who of ['oscar', 'ada', 'olive']) {
    const { json } = await ok(K, who, '/api/mcp-endpoints');
    assert.deepEqual(json.endpoints.map((e) => [e.name, e.url, e.readTokenEnv]), [['prod-mcp', MCP_URL, ACME_TOKEN], ['staging-mcp', 'http://mcp-staging.acme.test:8080/mcp', null]], `${who}: the url and the variable`);
  }
  // bob, bravo's admin: his org's list; acme's ids are not his to change.
  assert.deepEqual((await ok(K, 'bob', '/api/mcp-endpoints')).json.endpoints, []);
  const bravo = await ok('POST /api/mcp-endpoints', 'bob', '/api/mcp-endpoints', { name: 'bravo-mcp', url: 'https://mcp.bravo.test/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_BRAVO_TOKEN' }, 201);
  ids.bravoMcp = bravo.json.endpoint.id;
  assert.deepEqual(bravo.rows, [['mcp_endpoint.create', 'bob', 'bravo', 'bravo-mcp', { fields: ['name', 'url', 'readTokenEnv'], origin: 'https://mcp.bravo.test', readTokenEnv: 'OBSERVOGRAM_ORG_BRAVO_TOKEN' }]]);
  assert.deepEqual((await ok(K, 'bob', '/api/mcp-endpoints')).json.endpoints.map((e) => e.id), [ids.bravoMcp]);
  assert.deepEqual((await ok(K, 'vera', '/api/mcp-endpoints')).json.endpoints.map((e) => e.id), [ids.mcp, ids.mcpStaging], 'acme lists none of bravo\'s');
  await refused('PATCH /api/mcp-endpoints/:id', 'bob', `/api/mcp-endpoints/${ids.mcp}`, { name: 'taken' }, 404, `no MCP endpoint ${ids.mcp}`);
  await refused('DELETE /api/mcp-endpoints/:id', 'bob', `/api/mcp-endpoints/${ids.mcp}`, 404, `no MCP endpoint ${ids.mcp}`);
  // ada, acme's admin, cannot name bravo's endpoint for an acme environment.
  await refused('PATCH /api/environments/:id', 'ada', `/api/environments/${ids.prod}`, { mcpEndpointId: ids.bravoMcp }, 400, WAYS.noMcpEndpointInOrg(ids.bravoMcp));
});

test('PATCH /api/mcp-endpoints/:id: name, url, readTokenEnv (null clears) with `changed` and one row naming the fields (API names, as the create row and `changed`), the origin and the variable after the change; nothing differing → no row; a rename clash is 409; the refusals; the id rule', async () => {
  const K = 'PATCH /api/mcp-endpoints/:id';
  const P = `/api/mcp-endpoints/${ids.mcp}`;
  const { json, rows } = await ok(K, 'ada', P, { name: 'prod-mcp-2', url: 'https://mcp2.acme.test/mcp/v2?tier=y', readTokenEnv: null });
  assert.deepEqual(json.changed, ['name', 'url', 'readTokenEnv']);
  assert.deepEqual({ ...json.endpoint, createdAt: 'T' }, { id: ids.mcp, name: 'prod-mcp-2', origin: 'https://mcp2.acme.test', url: 'https://mcp2.acme.test/mcp/v2?tier=y', readTokenEnv: null, environments: 0, createdAt: 'T' });
  assert.deepEqual(rows, [['mcp_endpoint.update', 'ada', 'acme', 'prod-mcp', { fields: ['name', 'url', 'readTokenEnv'], origin: 'https://mcp2.acme.test', readTokenEnv: null }]], 'the row names the record as it was, the fields written as the create row spells them, and where the token goes next');
  const same = await ok(K, 'ada', P, { name: 'prod-mcp-2', readTokenEnv: null, extra: true });
  assert.deepEqual([same.json.changed, same.rows], [[], []]);
  const back = await ok(K, 'olive', P, { name: 'prod-mcp', url: MCP_URL, readTokenEnv: ACME_TOKEN });
  assert.deepEqual([back.json.changed, back.json.endpoint.url, back.json.endpoint.readTokenEnv], [['name', 'url', 'readTokenEnv'], MCP_URL, ACME_TOKEN]);
  assert.deepEqual(back.rows, [['mcp_endpoint.update', 'olive', 'acme', 'prod-mcp-2', { fields: ['name', 'url', 'readTokenEnv'], origin: MCP_ORIGIN, readTokenEnv: ACME_TOKEN }]]);
  const only = await ok(K, 'ada', P, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_OTHER' });
  assert.deepEqual([only.json.changed, only.rows], [['readTokenEnv'], [['mcp_endpoint.update', 'ada', 'acme', 'prod-mcp', { fields: ['readTokenEnv'], origin: MCP_ORIGIN, readTokenEnv: 'OBSERVOGRAM_ORG_ACME_OTHER' }]]], 'changed and the row spell the field the same way');
  await ok(K, 'ada', P, { readTokenEnv: ACME_TOKEN });
  // The refusals.
  await refused(K, 'ada', P, { name: 'staging-mcp' }, 409, `MCP endpoint "staging-mcp" exists (id ${ids.mcpStaging}) — PATCH /api/mcp-endpoints/${ids.mcpStaging} changes it`);
  await refused(K, 'ada', P, { name: '' }, 400, WAYS.mcpEndpointName);
  await refused(K, 'ada', P, { url: 'https://mcp.acme.test/x?token=1' }, 400, 'observogram store: an MCP endpoint URL may not carry credentials in its query — the parameter(s) "token" look like credentials; remove them and name an env var in readTokenEnv');
  await refused(K, 'ada', P, { url: 'ftp://x' }, 400, 'observogram store: an MCP endpoint is http(s)');
  await refused(K, 'ada', P, { readTokenEnv: 'OBSERVOGRAM_ORG_BRAVO_TOKEN' }, 400, envNameOwnerText('OBSERVOGRAM_ORG_BRAVO_TOKEN', ['bravo']));
  await refused(K, 'ada', P, { readTokenEnv: 'TOKEN' }, 400, envNameShapeText('TOKEN', 'acme'));
  await refused(K, 'ada', '/api/mcp-endpoints/999999', { name: 'x' }, 404, 'no MCP endpoint 999999');
  for (const id of BAD_IDS) await refused(K, 'ada', `/api/mcp-endpoints/${id}`, { name: 'x' }, 400, MCP_ENDPOINT_ID_TEXT);
  await denied(K, 'oscar', P, { name: 'x' }, 'role', "requires the admin role in org 'acme' (you are operator) — ask an admin of acme");
  // The same name as its own is no clash.
  const own = await ok(K, 'ada', P, { name: 'prod-mcp' });
  assert.deepEqual([own.json.changed, own.rows], [[], []]);
});

test('an environment bound to an endpoint: PATCH /api/environments/:id { mcpEndpointId } with its row; the view says { id, name, origin } — a viewer reads no url; the endpoint counts it', async () => {
  const bind = await ok('PATCH /api/environments/:id', 'oscar', `/api/environments/${ids.prod}`, { mcpEndpointId: ids.mcp });
  assert.deepEqual(bind.json.changed, ['mcpEndpointId']);
  assert.deepEqual(bind.json.environment.mcpEndpoint, { id: ids.mcp, name: 'prod-mcp', origin: MCP_ORIGIN });
  assert.deepEqual(bind.rows, [['environment.update', 'oscar', 'acme', 'checkout-service/prod', { fields: ['mcpEndpointId'] }]], 'the row spells the field as changed does');
  const again = await ok('PATCH /api/environments/:id', 'oscar', `/api/environments/${ids.prod}`, { mcpEndpointId: String(ids.mcp) });
  assert.deepEqual([again.json.changed, again.rows], [[], []], 'the same id (as a string) differs in nothing');
  const read = await ok('GET /api/environments/:id', 'vera', `/api/environments/${ids.prod}`);
  assert.deepEqual(read.json.environment.mcpEndpoint, { id: ids.mcp, name: 'prod-mcp', origin: MCP_ORIGIN });
  assert.ok(!JSON.stringify(read.json).includes('sk-path-secret'), 'the URL\'s path is nowhere in an environment');
  const list = await ok('GET /api/services', 'vera', '/api/services');
  assert.deepEqual(list.json.services.find((s) => s.id === ids.checkout).environments.find((e) => e.id === ids.prod).mcpEndpoint, { id: ids.mcp, name: 'prod-mcp', origin: MCP_ORIGIN });
  assert.ok(!JSON.stringify(list.json).includes('sk-path-secret'));
  const eps = await ok('GET /api/mcp-endpoints', 'vera', '/api/mcp-endpoints');
  assert.deepEqual(eps.json.endpoints.map((e) => [e.name, e.environments]), [['prod-mcp', 1], ['staging-mcp', 0]]);
});

// ---------- an endpoint picked by id (§7.6, C11) ----------

// resolveMcpTarget's refusals through POST /api/refresh-live: each a 400
// before any fetch (no MCP runs here; the one URL that would be fetched
// is a closed loopback port, so a request that passes the resolver ends in
// a 502 that proves it passed). The success path with a live fake and the
// written pack is test-smoke's.
test('POST /api/refresh-live { mcpEndpointId }: both fields, neither, the id shape, an unknown or another org\'s id, the unset variable (naming it), the owner re-checked once acme-eu exists — each a 400 before any fetch; the PATCH way out works; a token value never comes back and is never logged', async () => {
  const K = 'POST /api/refresh-live';
  const P = '/api/refresh-live';
  const LOOP = 'http://127.0.0.1:1/mcp';   // a closed port: a fetch there fails at once
  assert.equal(WAYS.bothTargets, 'send mcpUrl or mcpEndpointId, not both');
  assert.equal(WAYS.neitherTarget, 'mcpUrl or mcpEndpointId required in JSON body');
  assert.equal(WAYS.mcpEndpointIdShape, 'mcpEndpointId must be a positive integer');
  await refused(K, 'oscar', P, { mcpUrl: LOOP, mcpEndpointId: ids.mcp }, 400, WAYS.bothTargets);
  await refused(K, 'oscar', P, {}, 400, WAYS.neitherTarget);
  await refused(K, 'oscar', P, { mcpUrl: '  ', mcpAuth: 'x' }, 400, WAYS.neitherTarget);
  for (const mcpEndpointId of ['abc', 0, -1, 1.5, '01', true, '9007199254740992']) await refused(K, 'oscar', P, { mcpEndpointId }, 400, WAYS.mcpEndpointIdShape);
  await refused(K, 'oscar', P, { mcpEndpointId: 999999 }, 400, 'no MCP endpoint 999999 in this org — GET /api/mcp-endpoints lists them');
  await refused(K, 'oscar', P, { mcpEndpointId: ids.bravoMcp }, 400, `no MCP endpoint ${ids.bravoMcp} in this org — GET /api/mcp-endpoints lists them`);
  // The variable this org's endpoint names is not set in this process.
  assert.equal(process.env[ACME_TOKEN], undefined, 'hermetic: the suite stripped every OBSERVOGRAM_ORG_* variable');
  const UNSET = `MCP endpoint "prod-mcp" reads its token from ${ACME_TOKEN}, which is not set in the server's environment — set it on the server (the k8s Deployment's env), or send mcpAuth with this request`;
  assert.equal(WAYS.tokenUnset({ name: 'prod-mcp', readTokenEnv: ACME_TOKEN }), UNSET);
  await refused(K, 'oscar', P, { mcpEndpointId: ids.mcp }, 400, UNSET);
  await refused(K, 'oscar', P, { mcpEndpointId: String(ids.mcp), mcpAuth: '' }, 400, UNSET);   // an empty token is none
  // An endpoint at the closed port: set, the variable is read and the
  // request goes on to the fetch (a 502, not a 400); the token's value is
  // in no response. A sent mcpAuth needs no variable.
  const loop = await ok('POST /api/mcp-endpoints', 'ada', '/api/mcp-endpoints', { name: 'loop-mcp', url: LOOP, readTokenEnv: ACME_TOKEN }, 201);
  const loopId = loop.json.endpoint.id;
  // Each token-bearing request runs under logged(): the server's line
  // names the safe URL (so the capture is known to see its stderr) and
  // no line carries the token (§7.6: never logged).
  const SAFE_LINE = `[refresh-live] POST /api/refresh-live -> ${LOOP}\n`;
  const { result: sent, output: sentOut } = await logged(() => call('oscar', 'POST', P, { mcpEndpointId: loopId, mcpAuth: 'sent-token-value' }));
  assert.equal(sent.status, 502, `a sent token passes the resolver: ${sent.text.slice(0, 200)}`);
  assert.ok(!sent.text.includes('sent-token-value'), 'the token is in no response');
  assert.ok(sentOut.includes(SAFE_LINE), `the server logged the safe URL: ${JSON.stringify(sentOut)}`);
  assert.ok(!sentOut.includes('sent-token-value'), `a sent token is never logged: ${JSON.stringify(sentOut)}`);
  process.env[ACME_TOKEN] = 'env-token-value';
  try {
    const { result: fetched, output: fetchedOut } = await logged(() => call('oscar', 'POST', P, { mcpEndpointId: loopId }));
    assert.equal(fetched.status, 502, `the variable set: past the resolver, to the fetch: ${fetched.text.slice(0, 200)}`);
    assert.ok(!fetched.text.includes('env-token-value'), 'the variable\'s value is in no response');
    assert.ok(fetchedOut.includes(SAFE_LINE), `the server logged the safe URL: ${JSON.stringify(fetchedOut)}`);
    assert.ok(!fetchedOut.includes('env-token-value'), `the variable's value is never logged: ${JSON.stringify(fetchedOut)}`);
    // draft-from-mcp reads the same variable the same way.
    const { result: draft, output: draftOut } = await logged(() => call('oscar', 'POST', '/api/draft-from-mcp', { mcpEndpointId: loopId }));
    assert.equal(draft.status, 502, `draft-from-mcp, the variable set: past the resolver, to the fetch: ${draft.text.slice(0, 200)}`);
    assert.ok(!draft.text.includes('env-token-value'), 'the variable\'s value is in no draft response');
    assert.ok(draftOut.includes(`[draft-from-mcp] POST -> ${LOOP}\n`), `the server logged the safe URL: ${JSON.stringify(draftOut)}`);
    assert.ok(!draftOut.includes('env-token-value'), `the variable's value is never logged by draft-from-mcp: ${JSON.stringify(draftOut)}`);
  } finally {
    delete process.env[ACME_TOKEN];
  }
  // The owner is re-checked at request time (A4): a name registered while
  // acme owned it is acme-eu's once that org exists — refused naming the
  // owner and the PATCH way out, before the variable is read; the PATCH
  // works, and the write routes never read a variable.
  const EU_VAR = 'OBSERVOGRAM_ORG_ACME_EU_TOKEN';
  const eu = await ok('POST /api/mcp-endpoints', 'ada', '/api/mcp-endpoints', { name: 'eu-mcp', url: LOOP, readTokenEnv: EU_VAR }, 201);
  const euId = eu.json.endpoint.id;
  process.env[EU_VAR] = 'eu-token-value';
  try {
    const { result: euRead, output: euOut } = await logged(() => call('oscar', 'POST', P, { mcpEndpointId: euId }));
    assert.equal(euRead.status, 502, 'before acme-eu exists the name is acme\'s: read, fetched');
    assert.ok(!`${euRead.text}${euOut}`.includes('eu-token-value'), `the variable's value is in no response and never logged: ${JSON.stringify(euOut)}`);
    const org = await ok('POST /api/admin/orgs', 'olive', '/api/admin/orgs', { id: 'acme-eu', name: 'Acme EU' }, 201);
    assert.equal(org.json.org.id, 'acme-eu');
    const OWNER = `${envNameOwnerText(EU_VAR, ['acme-eu'])} — PATCH /api/mcp-endpoints/${euId} names another variable`;
    assert.equal(OWNER, `observogram store: OBSERVOGRAM_ORG_ACME_EU_TOKEN belongs to org acme-eu (the longest org prefix wins) — an admin may only name variables set aside for their org — PATCH /api/mcp-endpoints/${euId} names another variable`);
    await refused(K, 'oscar', P, { mcpEndpointId: euId }, 400, OWNER);
    await refused(K, 'oscar', P, { mcpEndpointId: euId, mcpAuth: 'sent' }, 400, OWNER);   // a sent token does not excuse a name that is another org's
    await refused('POST /api/draft-from-mcp', 'oscar', '/api/draft-from-mcp', { mcpEndpointId: euId }, 400, OWNER);
    // The write routes take the URL only: no variable, nothing to own — the
    // request reaches the MCP (a 502 at the closed port, no 400).
    const { result: write, output: writeOut } = await logged(() => call('oscar', 'POST', `/api/packs/payment-service/deploy/grafana-dashboard`, { mcpEndpointId: euId, mcpAuth: 'write-token-value', dryRun: true }));
    assert.notEqual(write.status, 400, `deploy with mcpEndpointId takes the record's URL: ${write.text.slice(0, 200)}`);
    assert.ok(!write.text.includes('eu-token-value'));
    assert.ok(!`${write.text}${writeOut}`.includes('write-token-value'), `the sent write token is in no response and never logged: ${JSON.stringify(writeOut)}`);
    // The way out: a name under acme's prefix that is not acme-eu's
    // (OBSERVOGRAM_ORG_ACME_EU_<X> would be — the longest prefix owns it).
    const patched = await ok('PATCH /api/mcp-endpoints/:id', 'ada', `/api/mcp-endpoints/${euId}`, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_EU2_MCP' });
    assert.deepEqual(patched.json.changed, ['readTokenEnv']);
    await refused(K, 'oscar', P, { mcpEndpointId: euId }, 400, `MCP endpoint "eu-mcp" reads its token from OBSERVOGRAM_ORG_ACME_EU2_MCP, which is not set in the server's environment — set it on the server (the k8s Deployment's env), or send mcpAuth with this request`);
  } finally {
    delete process.env[EU_VAR];
  }
  // The two endpoints of this test go; the list reads as before it.
  await ok('DELETE /api/mcp-endpoints/:id', 'ada', `/api/mcp-endpoints/${loopId}`);
  await ok('DELETE /api/mcp-endpoints/:id', 'ada', `/api/mcp-endpoints/${euId}`);
  assert.deepEqual((await ok('GET /api/mcp-endpoints', 'vera', '/api/mcp-endpoints')).json.endpoints.map((e) => e.name), ['prod-mcp', 'staging-mcp']);
});

test('DELETE /api/mcp-endpoints/:id: the view as it was, the environments it unbinds, one row { origin, unbound }; the environment reads mcpEndpoint null; gone afterwards; the id rule; the guard', async () => {
  const K = 'DELETE /api/mcp-endpoints/:id';
  await denied(K, 'oscar', `/api/mcp-endpoints/${ids.mcp}`, 'role', "requires the admin role in org 'acme' (you are operator) — ask an admin of acme");
  const { json, rows } = await ok(K, 'ada', `/api/mcp-endpoints/${ids.mcp}`);
  assert.deepEqual({ ...json, deleted: { ...json.deleted, createdAt: 'T' } }, {
    ok: true, deleted: { id: ids.mcp, name: 'prod-mcp', origin: MCP_ORIGIN, url: MCP_URL, readTokenEnv: ACME_TOKEN, environments: 1, createdAt: 'T' }, unbound: [ids.prod],
  });
  assert.deepEqual(rows, [['mcp_endpoint.delete', 'ada', 'acme', 'prod-mcp', { origin: MCP_ORIGIN, unbound: 1 }]], 'one row; the unbound environment writes none of its own');
  const env = await ok('GET /api/environments/:id', 'vera', `/api/environments/${ids.prod}`);
  assert.deepEqual([env.json.environment.mcpEndpoint, env.json.environment.name], [null, 'prod'], 'the environment stays, unbound');
  await refused(K, 'ada', `/api/mcp-endpoints/${ids.mcp}`, 404, `no MCP endpoint ${ids.mcp}`);
  await refused('PATCH /api/mcp-endpoints/:id', 'ada', `/api/mcp-endpoints/${ids.mcp}`, { name: 'x' }, 404, `no MCP endpoint ${ids.mcp}`);
  await refused('PATCH /api/environments/:id', 'oscar', `/api/environments/${ids.prod}`, { mcpEndpointId: ids.mcp }, 400, WAYS.noMcpEndpointInOrg(ids.mcp));
  for (const id of BAD_IDS) await refused(K, 'ada', `/api/mcp-endpoints/${id}`, 400, MCP_ENDPOINT_ID_TEXT);
  assert.deepEqual((await ok('GET /api/mcp-endpoints', 'vera', '/api/mcp-endpoints')).json.endpoints.map((e) => e.name), ['staging-mcp']);
  // Nothing bound: unbound is [].
  const none = await ok(K, 'olive', `/api/mcp-endpoints/${ids.mcpStaging}`);
  assert.deepEqual([none.json.unbound, none.rows], [[], [['mcp_endpoint.delete', 'olive', 'acme', 'staging-mcp', { origin: 'http://mcp-staging.acme.test:8080', unbound: 0 }]]]);
});

test('DELETE /api/services/:id on a record without packs: the view as it was, the cascaded environments counted, one row', async () => {
  const K = 'DELETE /api/services/:id';
  const { json, rows } = await ok(K, 'ada', `/api/services/${ids.payments}`);
  assert.deepEqual({ ...json, deleted: stamped(json.deleted) }, {
    ok: true,
    deleted: {
      id: ids.payments, slug: 'payments', name: 'Payments', owners: [], tier: null, description: null, source: { kind: 'observogram' },
      createdAt: 'T', updatedAt: 'T',
      environments: [{ id: ids.paymentsDev, serviceId: ids.payments, name: 'dev', tier: null, effectiveTier: null, bindings: {}, endpoints: {}, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T' }],
      packs: [],
    },
    environments: 1, packLinks: 0, waivers: 0,
  });
  assert.deepEqual(rows, [['service.delete', 'ada', 'acme', 'payments', { environments: 1, packLinks: 0, waivers: 0 }]]);
  await refused('GET /api/services/:id', 'vera', `/api/services/${ids.payments}`, 404, `no service ${ids.payments}`);
  await refused('GET /api/environments/:id', 'vera', `/api/environments/${ids.paymentsDev}`, 404, `no environment ${ids.paymentsDev}`);
  await refused(K, 'ada', `/api/services/${ids.payments}`, 404, `no service ${ids.payments}`);
  for (const id of BAD_IDS) await refused(K, 'ada', `/api/services/${id}`, 400, SERVICE_ID_TEXT);
  // The slug is free again.
  const again = await ok('POST /api/services', 'oscar', '/api/services', { name: 'Payments' }, 201);
  ids.payments = again.json.service.id;
});

// ---------- the registry's side: a register writes the rows ----------

test('a register writes the service, environment and link rows by the person registering; the same content again writes none', async () => {
  const seq = seqNow();
  const r = await call('oscar', 'POST', '/api/validate', DEMO_YAML, YAML);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  ids.demoPack = r.json.registered.id;
  assert.ok(ids.demoPack.startsWith('uploaded-demo-skeleton-'), ids.demoPack);
  assert.deepEqual(rowsAfter(seq), [
    ['pack.register', 'oscar', 'acme', ids.demoPack, { label: null, source: 'demo-skeleton' }],
    ['service.create', 'oscar', 'acme', 'demo-skeleton', { via: 'register', pack: ids.demoPack }],
    ['environment.create', 'oscar', 'acme', 'demo-skeleton/prod', { via: 'register', pack: ids.demoPack }],
    ['pack.link', 'oscar', 'acme', ids.demoPack, { service: 'demo-skeleton', role: 'primary' }],
  ]);
  const again = seqNow();
  const r2 = await call('oscar', 'POST', '/api/validate', DEMO_YAML, YAML);
  assert.deepEqual([r2.status, r2.json.registered.id, rowsAfter(again)], [200, ids.demoPack, []], 'the same content again: a touch, no row');
  // The record the API serves: tier null (graded by the pack), the pack linked as primary.
  const { json } = await ok('GET /api/services', 'vera', '/api/services');
  const demo = json.services.find((s) => s.slug === 'demo-skeleton');
  ids.demo = demo.id;
  ids.demoProd = demo.environments[0].id;
  assert.deepEqual(stamped(demo), {
    id: ids.demo, slug: 'demo-skeleton', name: 'demo-skeleton', owners: [], tier: null, description: null, source: { kind: 'observogram' },
    createdAt: 'T', updatedAt: 'T',
    environments: [{ id: ids.demoProd, serviceId: ids.demo, name: 'prod', tier: null, effectiveTier: null, bindings: {}, endpoints: {}, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T' }],
    packs: [{ id: ids.demoPack, label: null, source: 'demo-skeleton', role: 'primary' }],
  });
  // A record is a record: its tier is set on the row the register created.
  const patched = await ok('PATCH /api/services/:id', 'oscar', `/api/services/${ids.demo}`, { tier: 'tier-1', owners: ['team-demo'] });
  assert.deepEqual(patched.json.changed, ['owners', 'tier'], 'changed lists the fields in the rule\'s order (name, owners, tier, description)');
});

// Every pack of the org as GET /api/packs serves it, and the studio's
// serviceCatalogue() — its source read from studio/app.mjs and run here
// with the module's functions bound and `state` stubbed — over those
// entries: the keys of the tiles a studio would draw for this org.
async function tilesAndRows() {
  const packs = (await call('vera', 'GET', '/api/packs')).json.packs;
  const studio = readFileSync(join(ROOT, 'studio', 'app.mjs'), 'utf8');
  const from = studio.indexOf('\nfunction serviceCatalogue(');
  const to = studio.indexOf('\n}\n', from);
  assert.ok(from > 0 && to > from, 'studio/app.mjs declares serviceCatalogue');
  const source = studio.slice(from, to + 3);
  const uploaded = packs.filter((p) => p.source === 'uploaded');
  const state = { catalog: packs, _examplesCache: packs.filter((p) => p.source !== 'uploaded'), pack: null };
  const { normalizeServiceKey, isLiveAggregatePack, servicesForPack } = serviceKeys;
  const serviceCatalogue = new Function('normalizeServiceKey', 'isLiveAggregatePack', 'servicesForPack', 'state', `${source}; return serviceCatalogue;`)(
    normalizeServiceKey, isLiveAggregatePack, servicesForPack, state);
  const tiles = serviceCatalogue({ ownOnly: true }).map((t) => t.key).sort();
  const services = (await call('vera', 'GET', '/api/services')).json.services;
  return { tiles, rows: services.filter((s) => s.packs.length > 0).map((s) => s.slug).sort(), uploaded, services };
}

test('rows = tiles (A6): the slugs with a pack linked equal the keys of the studio\'s serviceCatalogue() over GET /api/packs, for every kind of register', async () => {
  // A ?source= hint naming an MCP file makes the pack a live aggregate (the
  // studio's verbatim regex): no primary, and its own name is skipped — no
  // service row at all for a pack naming only itself.
  const hinted = { ...DEMO, metadata: { ...DEMO.metadata, name: 'hinted-skeleton', bindings: { ...DEMO.metadata.bindings, service: 'hinted-skeleton' } } };
  let seq = seqNow();
  const r = await call('oscar', 'POST', '/api/validate?source=mcp-x.yaml', JSON.stringify(hinted), { 'Content-Type': 'application/json' });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  ids.hintedPack = r.json.registered.id;
  assert.deepEqual(rowsAfter(seq), [['pack.register', 'oscar', 'acme', ids.hintedPack, { label: null, source: 'mcp-x.yaml' }]], 'an aggregate naming only itself links nothing');
  // A name-less canonical, with a label and without one (the label, then
  // the id, is the primary's name — as the studio's tile).
  const nameless = { apiVersion: 'observability.platform/v1', kind: 'ObservabilityPack', metadata: { version: '0.1.0' }, spec: {} };
  const nameless2 = { ...nameless, metadata: { version: '0.2.0' } };
  seq = seqNow();
  runWithOrg('acme', () => {
    ids.labelledPack = registerPack(db, 'oscar', { canonical: nameless, source: 'upload', label: 'L1' });
    ids.unlabelledPack = registerPack(db, 'oscar', { canonical: nameless2, source: 'upload', label: null });
  });
  assert.deepEqual(rowsAfter(seq), [
    ['pack.register', 'oscar', 'acme', ids.labelledPack, { label: 'L1', source: 'upload' }],
    ['service.create', 'oscar', 'acme', 'l1', { via: 'register', pack: ids.labelledPack }],
    ['pack.link', 'oscar', 'acme', ids.labelledPack, { service: 'l1', role: 'primary' }],
    ['pack.register', 'oscar', 'acme', ids.unlabelledPack, { label: null, source: 'upload' }],
    ['service.create', 'oscar', 'acme', ids.unlabelledPack, { via: 'register', pack: ids.unlabelledPack }],
    ['pack.link', 'oscar', 'acme', ids.unlabelledPack, { service: ids.unlabelledPack, role: 'primary' }],
  ]);
  const { tiles, rows, uploaded } = await tilesAndRows();
  assert.deepEqual(uploaded.map((p) => p.id).sort(), [ids.demoPack, ids.hintedPack, ids.labelledPack, ids.unlabelledPack].sort(), 'GET /api/packs serves the four');
  assert.deepEqual(rows, tiles);
  assert.deepEqual(tiles, ['demo-skeleton', 'l1', ids.unlabelledPack].sort());
});

test('the reconcile (A5/B4): a name-less pack relabelled moves its primary — one pack.update, pack.unlink relabelled, pack.link to the new primary, exactly one primary, no 500', async () => {
  const nameless = { apiVersion: 'observability.platform/v1', kind: 'ObservabilityPack', metadata: { version: '0.1.0' }, spec: {} };
  const seq = seqNow();
  let id;
  runWithOrg('acme', () => { id = registerPack(db, 'ada', { canonical: nameless, source: 'upload', label: 'L2' }); });
  assert.equal(id, ids.labelledPack, 'the same content under the same source: the same id');
  assert.deepEqual(rowsAfter(seq), [
    ['pack.update', 'ada', 'acme', id, { fields: ['label'] }],
    ['pack.unlink', 'ada', 'acme', id, { service: 'l1', reason: 'relabelled' }],
    ['service.create', 'ada', 'acme', 'l2', { via: 'register', pack: id }],
    ['pack.link', 'ada', 'acme', id, { service: 'l2', role: 'primary' }],
  ]);
  const links = runWithOrg('acme', () => listServicesForPack(db, id));
  assert.deepEqual(links.map((l) => [l.slug, l.role]), [['l2', 'primary']], 'exactly one primary, the new one');
  const { json } = await ok('GET /api/services', 'vera', '/api/services');
  const bySlug = Object.fromEntries(json.services.map((s) => [s.slug, s]));
  assert.deepEqual([bySlug.l1.packs, bySlug.l2.packs], [[], [{ id, label: 'L2', source: 'upload', role: 'primary' }]], 'l1 stays as a record without a pack; l2 holds the link');
  const { tiles, rows } = await tilesAndRows();
  assert.deepEqual(rows, tiles);
});

test('the reconcile (A5): a pack re-registered byte-identical as a live aggregate loses its primary, its members stay linked, and serviceTierFor reads no stale primary', async () => {
  const ledger = {
    ...DEMO,
    metadata: {
      ...DEMO.metadata, name: 'ledger-skeleton', bindings: { ...DEMO.metadata.bindings, service: 'ledger' },
      annotations: { 'mcp.servicesDiscovered': 'billing,refunds' },
    },
  };
  let seq = seqNow();
  let id;
  runWithOrg('acme', () => { id = registerPack(db, 'oscar', { canonical: ledger, source: 'ledger-skeleton', label: null }); });
  assert.deepEqual(rowsAfter(seq), [
    ['pack.register', 'oscar', 'acme', id, { label: null, source: 'ledger-skeleton' }],
    ['service.create', 'oscar', 'acme', 'ledger', { via: 'register', pack: id }],
    ['environment.create', 'oscar', 'acme', 'ledger/prod', { via: 'register', pack: id }],
    ['pack.link', 'oscar', 'acme', id, { service: 'ledger', role: 'primary' }],
    ['service.create', 'oscar', 'acme', 'billing', { via: 'register', pack: id }],
    ['environment.create', 'oscar', 'acme', 'billing/prod', { via: 'register', pack: id }],
    ['pack.link', 'oscar', 'acme', id, { service: 'billing', role: 'member' }],
    ['service.create', 'oscar', 'acme', 'refunds', { via: 'register', pack: id }],
    ['environment.create', 'oscar', 'acme', 'refunds/prod', { via: 'register', pack: id }],
    ['pack.link', 'oscar', 'acme', id, { service: 'refunds', role: 'member' }],
  ]);
  await ok('PATCH /api/services/:id', 'oscar', `/api/services/${(await ok('GET /api/services', 'vera', '/api/services')).json.services.find((s) => s.slug === 'ledger').id}`, { tier: 'tier-2' });
  assert.deepEqual(runWithOrg('acme', () => serviceTierFor(db, id, 'prod')).tier, 'tier-2', 'graded at the primary\'s tier while it is the primary');
  seq = seqNow();
  let same;
  runWithOrg('acme', () => { same = registerPack(db, 'oscar', { canonical: ledger, source: 'ledger-skeleton', label: 'Ledger (live MCP draft)' }); });
  assert.equal(same, id);
  assert.deepEqual(rowsAfter(seq), [
    ['pack.update', 'oscar', 'acme', id, { fields: ['label'] }],
    ['pack.unlink', 'oscar', 'acme', id, { service: 'ledger', reason: 'relabelled' }],
  ], 'the primary link goes; the members were linked already (nothing written for them)');
  const links = runWithOrg('acme', () => listServicesForPack(db, id));
  assert.deepEqual(links.map((l) => [l.slug, l.role]).sort(), [['billing', 'member'], ['refunds', 'member']]);
  assert.equal(runWithOrg('acme', () => serviceTierFor(db, id, 'prod')), null, 'no primary: graded by the pack, never the stale one');
  const { tiles, rows } = await tilesAndRows();
  assert.deepEqual(rows, tiles);
  assert.ok(tiles.includes('billing') && tiles.includes('refunds') && !tiles.includes('ledger'), tiles);
});

// ---------- the tier rule (design §9): the conformance report is graded at the record's tier ----------

// The report's own keys (environment and tier aside), for a byte-equal check
// against tools/lib/conformance.mjs grading the same canonical in process.
const reportOf = (json) => { const { environment, tier, ...report } = json; return { environment, tier, report }; };
// A read of the route as `who` (200, no row — the report carries no `ok`): its JSON.
async function conformance(who, path) {
  const seq = seqNow();
  const r = await call(who, 'GET', path);
  assert.equal(r.status, 200, `${path} as ${who}: ${r.text.slice(0, 300)}`);
  assert.deepEqual(rowsAfter(seq), [], 'a read writes no row');
  return r.json;
}

test('GET /api/packs/:id/conformance grades an uploaded pack at its service record\'s tier — the pack\'s own without one (byte-equal to the scorer), the service\'s, the environment\'s for ?env=; declaredTier is the graded tier and tier.mismatch says it differs; a catalogue pack has no record; a viewer reads all of it', async () => {
  // A fresh pack naming a fresh service (the demo record above already carries a tier).
  const tiered = { ...DEMO, metadata: { ...DEMO.metadata, name: 'tiered-skeleton', bindings: { ...DEMO.metadata.bindings, service: 'tiered' } } };
  const reg = await call('oscar', 'POST', '/api/validate', JSON.stringify(tiered), { 'Content-Type': 'application/json' });
  assert.equal(reg.status, 200, reg.text.slice(0, 300));
  const packId = reg.json.registered.id;
  const svc = (await ok('GET /api/services', 'vera', '/api/services')).json.services.find((s) => s.slug === 'tiered');
  assert.deepEqual([svc.tier, svc.environments.map((e) => [e.name, e.tier])], [null, [['prod', null]]], 'the register sets no tier');
  const prodId = svc.environments[0].id;
  const record = { service: { id: svc.id, slug: 'tiered' }, environment: null };

  // No tier set anywhere: graded by the pack, as every pack was before — the report byte-equal to the scorer's.
  const { environment, tier, report } = reportOf(await conformance('vera', `/api/packs/${packId}/conformance`));
  assert.deepEqual([environment, tier], [null, { graded: 'tier-3', pack: 'tier-3', from: 'pack', ...record, mismatch: false }]);
  assert.deepEqual(report, evaluateConformance(tiered), 'the report is the scorer\'s own over the pack');
  assert.equal(tier.graded, report.declaredTier);
  const applied = report.clauses.filter((c) => c.applies).length;

  // The service's tier: graded there, mismatch shown (never blocked), more clauses apply at tier-1.
  await ok('PATCH /api/services/:id', 'oscar', `/api/services/${svc.id}`, { tier: 'tier-1' });
  const bySvc = reportOf(await conformance('vera', `/api/packs/${packId}/conformance`));
  assert.deepEqual(bySvc.tier, { graded: 'tier-1', pack: 'tier-3', from: 'service', ...record, mismatch: true });
  assert.equal(bySvc.report.declaredTier, 'tier-1', 'declaredTier is the graded tier');
  assert.equal(bySvc.tier.graded, bySvc.report.declaredTier);
  assert.ok(bySvc.report.clauses.filter((c) => c.applies).length > applied, 'more clauses apply at tier-1');
  assert.deepEqual(bySvc.report, evaluateConformance({ ...tiered, metadata: { ...tiered.metadata, bindings: { ...tiered.metadata.bindings, criticality: 'tier-1' } } }),
    'the scorer\'s own report at tier-1: tools/lib/conformance.mjs grades a copy of the pack with the record\'s tier');
  const canonical = await call('vera', 'GET', `/api/packs/${packId}/canonical`);
  assert.equal(canonical.json.metadata.bindings.criticality, 'tier-3', 'the registry\'s pack is not mutated');

  // The environment's tier wins for ?env=; an env without a row (staging) falls back to the service's.
  await ok('PATCH /api/environments/:id', 'oscar', `/api/environments/${prodId}`, { tier: 'tier-2' });
  const byEnv = reportOf(await conformance('vera', `/api/packs/${packId}/conformance?env=prod`));
  assert.deepEqual([byEnv.environment, byEnv.tier], ['prod', { graded: 'tier-2', pack: 'tier-3', from: 'environment', service: record.service, environment: { id: prodId, name: 'prod' }, mismatch: true }]);
  assert.equal(byEnv.report.declaredTier, 'tier-2');
  const staging = reportOf(await conformance('vera', `/api/packs/${packId}/conformance?env=staging`));
  assert.deepEqual([staging.environment, staging.tier], ['staging', { graded: 'tier-1', pack: 'tier-3', from: 'service', ...record, mismatch: true }]);
  // The record's tier equal to the pack's: graded from the record, no mismatch.
  await ok('PATCH /api/services/:id', 'oscar', `/api/services/${svc.id}`, { tier: 'tier-3' });
  const same = reportOf(await conformance('vera', `/api/packs/${packId}/conformance`));
  assert.deepEqual(same.tier, { graded: 'tier-3', pack: 'tier-3', from: 'service', ...record, mismatch: false });
  assert.deepEqual(same.report, report, 'byte-equal to the pack\'s own report');
  // Unset again: graded by the pack.
  await ok('PATCH /api/services/:id', 'oscar', `/api/services/${svc.id}`, { tier: null });
  assert.deepEqual(reportOf(await conformance('vera', `/api/packs/${packId}/conformance`)).tier,
    { graded: 'tier-3', pack: 'tier-3', from: 'pack', ...record, mismatch: false });

  // A catalogue pack has no record: its own tier, service null.
  const cat = await conformance('vera', '/api/packs/production-curated/conformance');
  assert.deepEqual(cat.tier, { graded: cat.declaredTier, pack: cat.declaredTier, from: 'pack', service: null, environment: null, mismatch: false });
  // ... even with a live primary link under its id (a hand-copied
  // packs/production-curated.pack.yaml the rehydrate adopted and linked, then
  // left unparseable: the row and its link stay, the catalogue entry is
  // served). The record is read for an uploaded pack only; the catalogue
  // pack is never graded at the service's tier-1.
  await ok('PATCH /api/services/:id', 'oscar', `/api/services/${svc.id}`, { tier: 'tier-1' });
  runWithOrg('acme', () => {
    addPack(db, 'oscar', { id: 'production-curated', source: 'upload' });
    linkPackService(db, 'oscar', { packId: 'production-curated', serviceId: svc.id, role: 'primary' });
  });
  assert.equal(runWithOrg('acme', () => serviceTierFor(db, 'production-curated')).tier, 'tier-1', 'the fixture holds: a record under the catalogue id');
  try {
    const linked = await conformance('vera', '/api/packs/production-curated/conformance');
    assert.deepEqual(linked, cat, 'the catalogue pack is graded by itself, the record under its id unread');
  } finally {
    runWithOrg('acme', () => removePack(db, 'oscar', 'production-curated'));
    await ok('PATCH /api/services/:id', 'oscar', `/api/services/${svc.id}`, { tier: null });
  }
  // Another org's member reads none of it: the pack is acme's.
  const other = await call('bob', 'GET', `/api/packs/${packId}/conformance`);
  assert.equal(other.status, 404);
});

// Trap 24: the placeholder list follows the graded tier too. onPlaceholder is
// validationSummary over the graded copy — the clauses that apply at the
// record's tier — never over the pack's own tier. A library-built pack is the
// only kind that carries one (the §12.3 skeleton above has no library.todo.*).
test('GET /api/packs/:id/conformance names the placeholder passes at the graded tier: a library-built pack registered at tier-2 lists them for tier-2 without a record tier (the register summary\'s list) and, once the service says tier-3, only those applying there — the list is worked out over the graded copy, not the pack\'s own', async () => {
  const lib = loadLibrary();
  const { canonical } = instantiatePack(['kafka', 'http-service'].map((id) => findEntry(lib, id)), { name: 'orders-api', tier: 'tier-2', environment: 'prod', owners: ['team-orders'] });
  // The scorer's own list at a tier: validationSummary over a copy with that criticality, the pack's todos.
  const placeholdersAt = (tier) => validationSummary({ ...canonical, metadata: { ...canonical.metadata, bindings: { ...canonical.metadata.bindings, criticality: tier } } }, todosFromAnnotations(canonical)).onPlaceholder;
  assert.ok(placeholdersAt('tier-2').length > placeholdersAt('tier-3').length, 'the fixture tells the tiers apart: fewer placeholder clauses apply at tier-3');
  const reg = await call('oscar', 'POST', '/api/library/register', JSON.stringify({ canonical }), { 'Content-Type': 'application/json' });
  assert.equal(reg.status, 200, reg.text.slice(0, 300));
  const packId = reg.json.registered.id;
  assert.deepEqual(reg.json.summary.onPlaceholder, placeholdersAt('tier-2'), 'the register summary lists the pack\'s own tier');
  const svc = (await ok('GET /api/services', 'vera', '/api/services')).json.services.find((s) => s.slug === 'orders-api');
  assert.equal(svc?.tier, null, 'the register sets no tier');

  // No record tier: graded at the pack's own tier-2, the register summary's list.
  const own = await conformance('vera', `/api/packs/${packId}/conformance?env=prod`);
  assert.deepEqual([own.tier.graded, own.tier.from, own.onPlaceholder], ['tier-2', 'pack', reg.json.summary.onPlaceholder]);

  // The service's tier-3: fewer clauses apply, and the placeholder list is theirs — not the pack's own.
  await ok('PATCH /api/services/:id', 'oscar', `/api/services/${svc.id}`, { tier: 'tier-3' });
  const graded = await conformance('vera', `/api/packs/${packId}/conformance?env=prod`);
  assert.deepEqual([graded.tier.graded, graded.tier.pack, graded.tier.mismatch, graded.declaredTier], ['tier-3', 'tier-2', true, 'tier-3']);
  assert.deepEqual(graded.onPlaceholder, placeholdersAt('tier-3'), 'onPlaceholder is worked out over the graded copy');
  assert.notDeepEqual(graded.onPlaceholder, reg.json.summary.onPlaceholder, 'not the pack\'s own list');
  assert.ok(graded.onPlaceholder.every((p) => graded.clauses.find((c) => c.id === p.id)?.applies === true), 'every clause named applies at the graded tier');
  // And tier-1 the other way: the list grows with the clauses that apply.
  await ok('PATCH /api/services/:id', 'oscar', `/api/services/${svc.id}`, { tier: 'tier-1' });
  const strict = await conformance('vera', `/api/packs/${packId}/conformance?env=prod`);
  assert.deepEqual([strict.tier.graded, strict.onPlaceholder], ['tier-1', placeholdersAt('tier-1')]);
  assert.ok(strict.onPlaceholder.every((p) => strict.clauses.find((c) => c.id === p.id)?.applies === true));
});

// ---------- a service's deletion and the registry ----------

test('DELETE /api/services/:id cascades the environments and the pack links; the packs stay registered; the deletion holds across a rehydrate (A3)', async () => {
  const K = 'DELETE /api/services/:id';
  const { json, rows } = await ok(K, 'oscar', `/api/services/${ids.demo}`);
  assert.deepEqual({ ...json, deleted: stamped(json.deleted) }, {
    ok: true,
    deleted: {
      id: ids.demo, slug: 'demo-skeleton', name: 'demo-skeleton', owners: ['team-demo'], tier: 'tier-1', description: null, source: { kind: 'observogram' },
      createdAt: 'T', updatedAt: 'T',
      environments: [{ id: ids.demoProd, serviceId: ids.demo, name: 'prod', tier: null, effectiveTier: 'tier-1', bindings: {}, endpoints: {}, mcpEndpoint: null, createdAt: 'T', updatedAt: 'T' }],
      packs: [{ id: ids.demoPack, label: null, source: 'demo-skeleton', role: 'primary' }],
    },
    environments: 1, packLinks: 1, waivers: 0,
  });
  assert.deepEqual(rows, [['service.delete', 'oscar', 'acme', 'demo-skeleton', { environments: 1, packLinks: 1, waivers: 0 }]]);
  await refused('GET /api/environments/:id', 'vera', `/api/environments/${ids.demoProd}`, 404, `no environment ${ids.demoProd}`);
  const packs = (await call('vera', 'GET', '/api/packs')).json.packs;
  assert.ok(packs.some((p) => p.id === ids.demoPack), 'the pack stays registered');
  assert.equal(runWithOrg('acme', () => listServicesForPack(db, ids.demoPack)).length, 0, 'its link is gone');
  // A rehydrate from the rows and the files (the maps dropped, GET /api/packs
  // rebuilds them): the pack has a row, so nothing links it again.
  const seq = seqNow();
  resetPackRegistry();
  const after = (await call('vera', 'GET', '/api/packs')).json.packs;
  assert.deepEqual(after.filter((p) => p.source === 'uploaded').map((p) => p.id).sort(), packs.filter((p) => p.source === 'uploaded').map((p) => p.id).sort(), 'the rehydrate serves the same packs');
  assert.deepEqual(rowsAfter(seq), [], 'the rehydrate writes nothing — no service.create by system');
  const services = (await call('vera', 'GET', '/api/services')).json.services;
  assert.ok(!services.some((s) => s.slug === 'demo-skeleton'), 'the deleted service is not back');
  assert.equal(runWithOrg('acme', () => serviceTierFor(db, ids.demoPack, 'prod')), null, 'the pack is graded by itself again');
});

test('the next register of a pack naming a deleted service re-creates it, by the person registering', async () => {
  const seq = seqNow();
  const r = await call('ada', 'POST', '/api/validate', DEMO_YAML, YAML);
  assert.deepEqual([r.status, r.json.registered.id], [200, ids.demoPack]);
  assert.deepEqual(rowsAfter(seq), [
    ['service.create', 'ada', 'acme', 'demo-skeleton', { via: 'register', pack: ids.demoPack }],
    ['environment.create', 'ada', 'acme', 'demo-skeleton/prod', { via: 'register', pack: ids.demoPack }],
    ['pack.link', 'ada', 'acme', ids.demoPack, { service: 'demo-skeleton', role: 'primary' }],
  ], 'the pack row exists (a touch); the service, its environment and the link are new, by ada');
  const demo = (await call('vera', 'GET', '/api/services')).json.services.find((s) => s.slug === 'demo-skeleton');
  assert.ok(demo && demo.id !== ids.demo, 'a new record (a new id), its tier unset again');
  assert.deepEqual([demo.tier, demo.owners, demo.packs.map((p) => p.role)], [null, [], ['primary']]);
  ids.demo = demo.id;
});

test('the quick-start dedup: the same label on new content replaces the old pack (pack.replace on the old id) and links the new', async () => {
  const v1 = { ...DEMO, metadata: { ...DEMO.metadata, name: 'quick-start', version: '1.0.0', bindings: { ...DEMO.metadata.bindings, service: 'quick-start' } } };
  const v2 = { ...v1, metadata: { ...v1.metadata, version: '2.0.0' } };
  let first;
  let second;
  runWithOrg('acme', () => { first = registerPack(db, 'oscar', { canonical: v1, source: 'quick-start', label: 'Quick Start' }); });
  const seq = seqNow();
  runWithOrg('acme', () => { second = registerPack(db, 'oscar', { canonical: v2, source: 'quick-start', label: 'Quick Start' }); });
  assert.notEqual(first, second);
  assert.deepEqual(rowsAfter(seq), [
    ['pack.replace', 'oscar', 'acme', first, { label: 'Quick Start', replacedBy: second }],
    ['pack.register', 'oscar', 'acme', second, { label: 'Quick Start', source: 'quick-start' }],
    ['pack.link', 'oscar', 'acme', second, { service: 'quick-start', role: 'primary' }],
  ], 'the service and its environment exist from the first register; the replaced pack\'s link cascaded with its row');
  const qs = (await call('vera', 'GET', '/api/services')).json.services.find((s) => s.slug === 'quick-start');
  assert.deepEqual(qs.packs, [{ id: second, label: 'Quick Start', source: 'quick-start', role: 'primary' }]);
  const { tiles, rows } = await tilesAndRows();
  assert.deepEqual(rows, tiles);
});

test('another org reads none of it: bob (bravo) lists no service and every acme id is 404 there', async () => {
  const { json } = await ok('GET /api/services', 'bob', '/api/services');
  assert.deepEqual(json.services, []);
  await refused('GET /api/services/:id', 'bob', `/api/services/${ids.checkout}`, 404, `no service ${ids.checkout}`);
  await refused('GET /api/environments/:id', 'bob', `/api/environments/${ids.prod}`, 404, `no environment ${ids.prod}`);
  await refused('PATCH /api/services/:id', 'bob', `/api/services/${ids.checkout}`, { tier: 'tier-1' }, 404, `no service ${ids.checkout}`);
  await refused('DELETE /api/services/:id', 'bob', `/api/services/${ids.checkout}`, 404, `no service ${ids.checkout}`);
});

test('DELETE /api/uploads drops the packs (one pack.clear row) and keeps the services, now without packs', async () => {
  const before = (await call('vera', 'GET', '/api/services')).json.services;
  const uploaded = (await call('vera', 'GET', '/api/packs')).json.packs.filter((p) => p.source === 'uploaded').length;
  assert.ok(uploaded >= 5, `${uploaded} uploaded packs`);
  const seq = seqNow();
  const r = await call('oscar', 'DELETE', '/api/uploads');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(rowsAfter(seq), [['pack.clear', 'oscar', 'acme', null, { dropped: uploaded }]]);
  const after = (await call('vera', 'GET', '/api/services')).json.services;
  assert.deepEqual(after.map((s) => s.slug), before.map((s) => s.slug), 'every service stays');
  assert.deepEqual(after.flatMap((s) => s.packs), [], 'no pack is linked any more');
  assert.deepEqual(after.map((s) => s.environments.length), before.map((s) => s.environments.length), 'the environments stay');
  const { tiles, rows } = await tilesAndRows();
  assert.deepEqual([rows, tiles], [[], []]);
});

// ---------- the deletion holds across a restart (A3) ----------

test('a restart (a child server on the same workspace) rehydrates the packs without recreating a deleted service; no service.create by system', async () => {
  // A pack whose service is then deleted, left on disk for the restart.
  const r = await call('oscar', 'POST', '/api/validate', DEMO_YAML, YAML);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const demo = (await call('vera', 'GET', '/api/services')).json.services.find((s) => s.slug === 'demo-skeleton');
  const del = await ok('DELETE /api/services/:id', 'oscar', `/api/services/${demo.id}`);
  assert.deepEqual([del.json.environments, del.json.packLinks, del.json.waivers], [1, 1, 0]);
  const slugsBefore = (await call('vera', 'GET', '/api/services')).json.services.map((s) => s.slug);
  const seq = seqNow();
  await closeInProcess();
  const child = await serve(WORKSPACE);
  try {
    const session = (await signIn(child.base, 'vera', pw('vera'))).session;
    assert.ok(session, 'vera signs in to the restarted server');
    const h = { Cookie: session, Accept: 'application/json' };
    const packs = await (await fetch(`${child.base}/api/packs`, { headers: h })).json();
    assert.ok(packs.packs.some((p) => p.id === ids.demoPack), 'the restarted server rehydrates the pack from its row and file');
    const services = await (await fetch(`${child.base}/api/services`, { headers: h })).json();
    assert.deepEqual(services.services.map((s) => s.slug), slugsBefore, 'the deleted service is not back; every other record is');
    assert.ok(!services.services.some((s) => s.slug === 'demo-skeleton'));
  } finally {
    await child.stop();
  }
  const raw = await openRaw(join(WORKSPACE, 'observogram.db'), { readOnly: true });
  try {
    // A boot over an upgraded store and a sign-in write no row: nothing at
    // all since the deletion — no service.create, no pack.link, nothing by system.
    const rows = prepare(raw, 'SELECT actor, action, target_id FROM audit WHERE seq > ? ORDER BY seq').all(seq);
    assert.deepEqual(rows, [], 'the restart wrote no row');
  } finally {
    raw.close();
  }
});
