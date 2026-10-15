#!/usr/bin/env node
/**
 * server/test-service-admin.mjs — the rules of server/service-admin.mjs
 * (docs/STORE_PLAN.md slice 4 §7.2–§7.6, §9): every refusal with its kind
 * and its exact text, the views, the tier from the service record, and
 * resolveMcpTarget — in-process over a temp store, no route and no fetch
 * (the API over these rules is server/test-services-api.mjs).
 *
 * Hermetic: the environment is stripped before any server module loads,
 * and the one variable the token test sets (OBSERVOGRAM_ORG_ACME_TEST_TOKEN)
 * is deleted inside the test. The suite lists its remote origins in
 * OBSERVOGRAM_MCP_ORIGINS (its typed URLs point at origins no endpoint uses,
 * and its readTokenEnv and mcpAuth cases carry credentials); the origin
 * rule's own cases unset it, each restoring it in a finally.
 */

const { STRIP, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();
const SUITE_ORIGINS = 'https://mcp.example,https://mcp.acme.example,https://mcp2.acme.example,http://mcp.lab.example:3001,https://mcp.lab.example,https://mcp.eu.example';
process.env.OBSERVOGRAM_MCP_ORIGINS = SUITE_ORIGINS;

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const { closeStore, openStore } = await import('./store/db.mjs');
const { runWithOrg } = await import('./tenancy.mjs');
const { AdminRefusal } = await import('./identity-admin.mjs');
const { rankOfRole } = await import('./authz.mjs');
const orgs = await import('./store/orgs.mjs');
const auditRepo = await import('./store/audit.mjs');
const services = await import('./store/services.mjs');
const environments = await import('./store/environments.mjs');
const mcpEndpoints = await import('./store/mcp-endpoints.mjs');
const packs = await import('./store/packs.mjs');
const packServices = await import('./store/pack-services.mjs');
const admin = await import('./service-admin.mjs');
const { currentOrg } = await import('./org-context.mjs');

// resolveMcpTarget as a route calls it: an admin session of the context org
// (an owner) unless the case names another caller.
const callerIn = (org, principal = { kind: 'session', actor: 'ada', role: 'admin', owner: true }) => ({ principal, org, port: 8000, posture: 'identity', direct: false, authOff: false });
const resolve = (db, body, opts = {}) => admin.resolveMcpTarget(db, body, { caller: callerIn(currentOrg()), ...opts });
// Registration as an admin session of the current org, unless a caller is given.
const createEp = (db, actor, body, opts = {}) => admin.createMcpEndpointFromApi(db, actor, body, { caller: callerIn(currentOrg()), ...opts });
const updateEp = (db, actor, id, patch, opts = {}) => admin.updateMcpEndpointFromApi(db, actor, id, patch, { caller: callerIn(currentOrg()), ...opts });

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

async function freshStore(tag) {
  const d = mkdtempSync(join(tmpdir(), `observogram-service-admin-${tag}-`));
  tmpDirs.push(d);
  const path = join(d, 'observogram.db');
  const db = await openStore({ path });
  orgs.createOrg(db, 'system', { id: 'acme', name: 'Acme' });
  orgs.createOrg(db, 'system', { id: 'bravo', name: 'Bravo' });
  return { db, close: () => closeStore(path) };
}

const refusedAs = (text, kind) => (e) => {
  assert.ok(e instanceof AdminRefusal, `an AdminRefusal, not ${e?.constructor?.name}: ${e?.message}`);
  assert.equal(e.message, text);
  assert.equal(e.kind, kind);
  return true;
};
const invalid = (text) => refusedAs(text, 'invalid');
const missing = (text) => refusedAs(text, 'missing');
const conflict = (text) => refusedAs(text, 'conflict');
const storeError = (re) => (e) => e instanceof TypeError && re.test(e.message) && !(e instanceof AdminRefusal);
const rows = (db, orgId, action) => auditRepo.listAudit(db, { orgId, limit: 1000, ...(action ? { action } : {}) }).reverse()
  .map((r) => [r.action, r.actor, r.targetId, r.detail]);

test('parseTier, parseSlug, parseOwners, parseBindings, parseEndpoints, positiveId: the field rules and their texts', () => {
  assert.deepEqual(admin.TIERS, ['tier-1', 'tier-2', 'tier-3']);
  assert.equal(admin.parseTier(undefined), null);
  assert.equal(admin.parseTier(null), null);
  for (const t of admin.TIERS) assert.equal(admin.parseTier(t), t);
  for (const bad of ['critical', 'tier-4', 'Tier-1', '', 1]) {
    assert.throws(() => admin.parseTier(bad), invalid(`a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not ${JSON.stringify(bad)}`));
  }

  assert.equal(admin.parseSlug(undefined, 'Checkout API'), 'checkout-api');
  assert.equal(admin.parseSlug(null, 'Pay_EU'), 'pay-eu');
  assert.equal(admin.parseSlug('checkout', 'anything'), 'checkout');
  assert.throws(() => admin.parseSlug(undefined, '!!!'), invalid('"!!!" yields no slug — send "slug"'));
  assert.throws(() => admin.parseSlug(undefined, ''), invalid('"" yields no slug — send "slug"'));
  assert.throws(() => admin.parseSlug('Checkout API', 'x'), invalid('"Checkout API" is not a service slug (lowercase letters, digits and -, as the catalogue keys services: "checkout-api")'));
  assert.throws(() => admin.parseSlug('-pay-', 'x'), invalid('"-pay-" is not a service slug (lowercase letters, digits and -, as the catalogue keys services: "pay")'));
  assert.throws(() => admin.parseSlug('', 'x'), invalid('"" is not a service slug (lowercase letters, digits and -, as the catalogue keys services: "")'));
  assert.throws(() => admin.parseSlug(7, 'x'), invalid('7 is not a service slug (lowercase letters, digits and -, as the catalogue keys services: "7")'));
  assert.throws(() => admin.parseSlug('a'.repeat(201), 'x'), (e) => e.kind === 'invalid' && /is not a service slug/.test(e.message));

  assert.deepEqual(admin.parseOwners(undefined), []);
  assert.deepEqual(admin.parseOwners([]), []);
  assert.deepEqual(admin.parseOwners([' team-pay ', 'ada']), ['team-pay', 'ada']);
  const ownersText = 'owners is an array of at most 50 names of 1–200 characters';
  for (const bad of [null, 'ada', {}, [''], ['  '], [1], ['a'.repeat(201)], Array.from({ length: 51 }, (_, i) => `o${i}`)]) {
    assert.throws(() => admin.parseOwners(bad), invalid(ownersText), JSON.stringify(bad));
  }

  assert.deepEqual(admin.parseBindings(undefined), {});
  assert.deepEqual(admin.parseBindings({}), {});
  assert.deepEqual(admin.parseBindings({ region: 'eu', cluster: 'c1' }), { region: 'eu', cluster: 'c1' });
  const bindingsText = 'bindings is an object of at most 32 string values; keys and values are 1–256 characters';
  for (const bad of [null, [], 'eu', { region: 1 }, { region: '' }, { '': 'eu' }, { ['k'.repeat(257)]: 'eu' }, { region: 'v'.repeat(257) },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v']))]) {
    assert.throws(() => admin.parseBindings(bad), invalid(bindingsText), JSON.stringify(bad));
  }

  assert.deepEqual(admin.parseEndpoints(undefined), {});
  assert.deepEqual(admin.parseEndpoints({ grafana: 'https://grafana.example/d/abc?orgId=1', prom: 'http://prom.internal:9090/graph' }),
    { grafana: 'https://grafana.example/d/abc?orgId=1', prom: 'http://prom.internal:9090/graph' });
  const head = 'endpoints is an object of at most 20 http(s) URLs by name';
  for (const bad of [null, [], 'https://x.example']) assert.throws(() => admin.parseEndpoints(bad), invalid(head), JSON.stringify(bad));
  assert.throws(() => admin.parseEndpoints(Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`e${i}`, 'https://x.example']))), invalid(head));
  for (const [name, value] of [['grafana', 'not a url'], ['grafana', 'ftp://files.example'], ['grafana', ''], ['grafana', 7], ['', 'https://x.example'], ['grafana', `https://x.example/${'p'.repeat(2000)}`]]) {
    assert.throws(() => admin.parseEndpoints({ [name]: value }), invalid(`${head}; ${JSON.stringify(name)} is not one`), `${name}=${value}`);
  }
  assert.throws(() => admin.parseEndpoints({ grafana: 'https://grafana.example/d?token=s3cr3t&apiKey=s3cr3t' }),
    invalid('endpoints.grafana carries the parameter(s) "token", "apiKey", which look like credentials — a token goes in the auth field, never in a URL'));
  assert.throws(() => admin.parseEndpoints({ prom: 'https://me:s3cr3t@prom.example/' }), invalid('endpoints.prom carries userinfo — a token goes in the auth field, never in a URL'));
  assert.throws(() => admin.parseEndpoints({ prom: 'https://prom.example/#auth=s3cr3t' }), invalid('endpoints.prom carries a fragment — a token goes in the auth field, never in a URL'));

  for (const [v, want] of [[1, 1], ['1', 1], [9007199254740991, 9007199254740991], ['9007199254740991', 9007199254740991], [0, null], [-1, null], ['0', null], ['01', null], [1.5, null], ['1e3', null], [null, null], [undefined, null], ['', null], [9007199254740992, null], ['9007199254740992', null]]) {
    assert.equal(admin.positiveId(v), want, JSON.stringify(v));
  }
});

test('services: create with every refusal, the 409, update (changed fields; the slug is fixed; unchanged writes no row), delete with its counts', async () => {
  const { db, close } = await freshStore('services');
  try {
    runWithOrg('acme', () => {
      const svc = admin.createServiceFromApi(db, 'oscar', { name: 'Checkout API', owners: ['team-pay'], tier: 'tier-1', description: 'the checkout' });
      assert.deepEqual([svc.slug, svc.name, svc.owners, svc.tier, svc.description], ['checkout-api', 'Checkout API', ['team-pay'], 'tier-1', 'the checkout']);
      const bare = admin.createServiceFromApi(db, 'oscar', { name: 'Ledger', slug: 'ledger' });
      assert.deepEqual([bare.slug, bare.owners, bare.tier, bare.description], ['ledger', [], null, null]);
      assert.deepEqual(rows(db, 'acme'), [['service.create', 'oscar', 'checkout-api', null], ['service.create', 'oscar', 'ledger', null]]);

      const nameText = 'a service name is 1–200 characters';
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', {}), invalid(nameText));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: '' }), invalid(nameText));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'x'.repeat(201) }), invalid(nameText));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 7 }), invalid(nameText));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'X', slug: 'Bad Slug' }), invalid('"Bad Slug" is not a service slug (lowercase letters, digits and -, as the catalogue keys services: "bad-slug")'));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: '***' }), invalid('"***" yields no slug — send "slug"'));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'X', owners: 'me' }), invalid('owners is an array of at most 50 names of 1–200 characters'));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'X', tier: 'critical' }), invalid('a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not "critical"'));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'X', description: 'd'.repeat(4001) }), invalid('a description is at most 4000 characters'));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'X', description: 7 }), invalid('a description is at most 4000 characters'));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'Checkout API' }), conflict(`service "checkout-api" exists (id ${svc.id}) — PATCH /api/services/${svc.id} changes it`));
      assert.throws(() => admin.createServiceFromApi(db, 'oscar', { name: 'Other', slug: 'checkout-api' }), conflict(`service "checkout-api" exists (id ${svc.id}) — PATCH /api/services/${svc.id} changes it`));
      assert.equal(rows(db, 'acme').length, 2, 'a refusal writes no row');

      // update
      assert.throws(() => admin.updateServiceFromApi(db, 'oscar', 999999, { name: 'x' }), missing('no service 999999'));
      assert.throws(() => admin.updateServiceFromApi(db, 'oscar', svc.id, { slug: 'checkout' }), invalid("a service's slug is fixed (packs link to it by slug) — create a new service with POST /api/services"));
      assert.throws(() => admin.updateServiceFromApi(db, 'oscar', svc.id, { slug: 'checkout-api' }), invalid("a service's slug is fixed (packs link to it by slug) — create a new service with POST /api/services"), 'even unchanged');
      assert.throws(() => admin.updateServiceFromApi(db, 'oscar', svc.id, { tier: 'high' }), invalid('a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not "high"'));
      assert.throws(() => admin.updateServiceFromApi(db, 'oscar', svc.id, { name: '' }), invalid('a service name is 1–200 characters'));
      assert.throws(() => admin.updateServiceFromApi(db, 'oscar', svc.id, { owners: [''] }), invalid('owners is an array of at most 50 names of 1–200 characters'));
      const same = admin.updateServiceFromApi(db, 'oscar', svc.id, { name: 'Checkout API', owners: ['team-pay'], tier: 'tier-1', description: 'the checkout', ignored: 1 });
      assert.deepEqual([same.changed, same.service.updatedAt], [[], svc.updatedAt], 'nothing differs: no write');
      assert.equal(rows(db, 'acme').length, 2);
      const up = admin.updateServiceFromApi(db, 'oscar', svc.id, { name: 'Checkout API', tier: 'tier-2', owners: [' ada ', 'team-pay'], description: null });
      assert.deepEqual([up.changed, up.service.tier, up.service.owners, up.service.description], [['owners', 'tier', 'description'], 'tier-2', ['ada', 'team-pay'], null]);
      assert.deepEqual(rows(db, 'acme', 'service.update'), [['service.update', 'oscar', 'checkout-api', { fields: ['owners', 'tier', 'description'] }]]);
      assert.deepEqual(admin.updateServiceFromApi(db, 'oscar', svc.id, { tier: null }).changed, ['tier']);
      assert.equal(services.getService(db, svc.id).tier, null, 'null: graded by the pack');

      // delete: the view as it was, the counts, the detail; packs stay.
      const ep = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'prod-mcp', url: 'https://mcp.acme.example/mcp' });
      admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod', mcpEndpointId: ep.id });
      admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'staging' });
      packs.addPack(db, 'oscar', { id: 'uploaded-checkout-0123abcd', label: 'Checkout', source: 'upload' });
      packServices.linkPackService(db, 'oscar', { packId: 'uploaded-checkout-0123abcd', serviceId: svc.id, role: 'primary' });
      assert.throws(() => admin.deleteServiceFromApi(db, 'oscar', 999999), missing('no service 999999'));
      const gone = admin.deleteServiceFromApi(db, 'oscar', svc.id);
      assert.deepEqual([gone.environments, gone.packLinks, gone.waivers, gone.service.slug, gone.service.environments.map((e) => e.name), gone.service.packs],
        [2, 1, 0, 'checkout-api', ['prod', 'staging'], [{ id: 'uploaded-checkout-0123abcd', label: 'Checkout', source: 'upload', role: 'primary' }]]);
      assert.equal(services.getService(db, svc.id), null);
      assert.deepEqual(environments.listEnvironmentsForOrg(db), []);
      assert.deepEqual(packServices.listLinksForOrg(db), []);
      assert.equal(packs.getPack(db, 'uploaded-checkout-0123abcd').label, 'Checkout', 'the pack stays registered');
      assert.deepEqual(rows(db, 'acme', 'service.delete'), [['service.delete', 'oscar', 'checkout-api', { environments: 2, packLinks: 1, waivers: 0 }]]);
      assert.deepEqual(rows(db, 'acme').map((r) => r[0]), [
        'service.create', 'service.create', 'service.update', 'service.update', 'mcp_endpoint.create', 'environment.create', 'environment.create',
        'pack.register', 'pack.link', 'service.delete',
      ], 'the cascaded rows write none of their own');
    });
  } finally {
    close();
  }
});

test('environments: create (404 service, the texts, the 409, the endpoint of this org only), update (rename clash, unbind), delete', async () => {
  const { db, close } = await freshStore('environments');
  try {
    const bravoEp = runWithOrg('bravo', () => mcpEndpoints.createMcpEndpoint(db, 'bob', { name: 'bravo-mcp', url: 'https://mcp.bravo.example/mcp' }));
    runWithOrg('acme', () => {
      const svc = admin.createServiceFromApi(db, 'oscar', { name: 'Pay', tier: 'tier-2' });
      const ep = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'prod-mcp', url: 'https://mcp.acme.example:8443/x/mcp?transport=sse' });
      assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', 999999, { name: 'prod' }), missing('no service 999999'));
      const nameText = 'an environment name is 1–200 characters';
      for (const bad of [{}, { name: '' }, { name: 'p'.repeat(201) }, { name: 3 }]) assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', svc.id, bad), invalid(nameText));
      assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod', tier: 'high' }), invalid('a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not "high"'));
      assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod', bindings: [] }), invalid('bindings is an object of at most 32 string values; keys and values are 1–256 characters'));
      assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod', endpoints: { grafana: 'nope' } }), invalid('endpoints is an object of at most 20 http(s) URLs by name; "grafana" is not one'));
      assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod', endpoints: { grafana: 'https://g.example/?api_key=x' } }),
        invalid('endpoints.grafana carries the parameter(s) "api_key", which look like credentials — a token goes in the auth field, never in a URL'));
      for (const bad of [999999, bravoEp.id, 'x', 0, -1, 1.5]) {
        assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod', mcpEndpointId: bad }), invalid(`no MCP endpoint ${bad} in this org — GET /api/mcp-endpoints lists them`), String(bad));
      }
      assert.deepEqual(rows(db, 'acme').map((r) => r[0]), ['service.create', 'mcp_endpoint.create'], 'refusals write no row');

      const prod = admin.createEnvironmentFromApi(db, 'oscar', svc.id, {
        name: 'prod', tier: 'tier-1', bindings: { region: 'eu' }, endpoints: { grafana: 'https://g.example/d/1?orgId=1' }, mcpEndpointId: ep.id,
      });
      assert.deepEqual([prod.serviceId, prod.name, prod.tier, prod.bindings, prod.endpoints, prod.mcpEndpointId], [svc.id, 'prod', 'tier-1', { region: 'eu' }, { grafana: 'https://g.example/d/1?orgId=1' }, ep.id]);
      const staging = admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'staging', mcpEndpointId: null });
      assert.deepEqual([staging.tier, staging.bindings, staging.endpoints, staging.mcpEndpointId], [null, {}, {}, null]);
      assert.throws(() => admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod' }), conflict(`environment "prod" of pay exists (id ${prod.id}) — PATCH /api/environments/${prod.id} changes it`));
      assert.deepEqual(rows(db, 'acme', 'environment.create'), [['environment.create', 'oscar', 'pay/prod', null], ['environment.create', 'oscar', 'pay/staging', null]]);

      // the views
      const view = admin.environmentViewOf(db, prod);
      assert.deepEqual(view, {
        id: prod.id, serviceId: svc.id, name: 'prod', tier: 'tier-1', effectiveTier: 'tier-1', bindings: { region: 'eu' },
        endpoints: { grafana: 'https://g.example/d/1?orgId=1' }, mcpEndpoint: { id: ep.id, name: 'prod-mcp', origin: 'https://mcp.acme.example:8443' },
        createdAt: prod.createdAt, updatedAt: prod.updatedAt,
      }, 'the MCP URL itself never: its origin');
      assert.deepEqual([admin.environmentViewOf(db, staging).effectiveTier, admin.environmentViewOf(db, staging).mcpEndpoint], ['tier-2', null], "the service's tier when the environment sets none");

      // update
      assert.throws(() => admin.updateEnvironmentFromApi(db, 'oscar', 999999, { tier: 'tier-1' }), missing('no environment 999999'));
      assert.throws(() => admin.updateEnvironmentFromApi(db, 'oscar', staging.id, { name: 'prod' }), conflict(`environment "prod" of pay exists (id ${prod.id}) — PATCH /api/environments/${prod.id} changes it`));
      assert.throws(() => admin.updateEnvironmentFromApi(db, 'oscar', staging.id, { mcpEndpointId: bravoEp.id }), invalid(`no MCP endpoint ${bravoEp.id} in this org — GET /api/mcp-endpoints lists them`));
      assert.throws(() => admin.updateEnvironmentFromApi(db, 'oscar', staging.id, { endpoints: { prom: 'https://me:pw@prom.example/' } }), invalid('endpoints.prom carries userinfo — a token goes in the auth field, never in a URL'));
      const same = admin.updateEnvironmentFromApi(db, 'oscar', prod.id, { name: 'prod', tier: 'tier-1', bindings: { region: 'eu' }, mcpEndpointId: ep.id });
      assert.deepEqual(same.changed, []);
      assert.equal(admin.updateEnvironmentFromApi(db, 'oscar', prod.id, { name: 'prod' }).changed.length, 0, 'its own name is no clash');
      const up = admin.updateEnvironmentFromApi(db, 'oscar', prod.id, { tier: null, bindings: { region: 'eu', cluster: 'c1' }, mcpEndpointId: null });
      assert.deepEqual([up.changed, up.environment.tier, up.environment.bindings, up.environment.mcpEndpointId], [['tier', 'bindings', 'mcpEndpointId'], null, { region: 'eu', cluster: 'c1' }, null]);
      assert.deepEqual(rows(db, 'acme', 'environment.update'), [['environment.update', 'oscar', 'pay/prod', { fields: ['tier', 'bindings', 'mcpEndpointId'] }]]);
      const renamed = admin.updateEnvironmentFromApi(db, 'oscar', staging.id, { name: 'stage' });
      assert.deepEqual([renamed.changed, renamed.environment.name], [['name'], 'stage']);

      // delete
      assert.throws(() => admin.deleteEnvironmentFromApi(db, 'oscar', 999999), missing('no environment 999999'));
      const gone = admin.deleteEnvironmentFromApi(db, 'oscar', renamed.environment.id);
      assert.deepEqual([gone.environment.name, gone.environment.effectiveTier], ['stage', 'tier-2']);
      assert.equal(environments.getEnvironment(db, staging.id), null);
      assert.deepEqual(rows(db, 'acme', 'environment.delete'), [['environment.delete', 'oscar', 'pay/stage', null]]);
    });
  } finally {
    close();
  }
});

test('MCP endpoints: create (the texts, the 409, the repository\'s URL and env-var rules as TypeErrors), update, delete with the unbound ids; the view by rank', async () => {
  const { db, close } = await freshStore('mcp');
  try {
    runWithOrg('acme', () => {
      const nameText = 'an MCP endpoint name is 1–200 characters';
      for (const bad of [{}, { name: '' }, { name: 'n'.repeat(201) }, { name: 1 }]) assert.throws(() => createEp(db, 'ada', { ...bad, url: 'https://mcp.example/mcp' }), invalid(nameText));
      assert.throws(() => createEp(db, 'ada', { name: 'x', url: 'https://mcp.example/mcp?token=s3cr3t' }), storeError(/may not carry credentials in its query — the parameter\(s\) "token" look like credentials/));
      assert.throws(() => createEp(db, 'ada', { name: 'x', url: 'ftp://mcp.example' }), storeError(/an MCP endpoint is http\(s\)/));
      assert.throws(() => createEp(db, 'ada', { name: 'x' }), storeError(/url must be a non-empty string/));
      assert.throws(() => createEp(db, 'ada', { name: 'x', url: 'https://mcp.example/mcp', readTokenEnv: 'MCP_TOKEN' }), storeError(/readTokenEnv names an env var of this org/));
      assert.throws(() => createEp(db, 'ada', { name: 'x', url: 'https://mcp.example/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_BRAVO_T' }), storeError(/belongs to org bravo/));
      assert.deepEqual(rows(db, 'acme'), [], 'refusals write no row');

      const ep = createEp(db, 'ada', { name: 'prod-mcp', url: 'https://mcp.acme.example/mcp?transport=sse', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' });
      assert.deepEqual([ep.name, ep.url, ep.readTokenEnv], ['prod-mcp', 'https://mcp.acme.example/mcp?transport=sse', 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN']);
      const plain = createEp(db, 'ada', { name: 'lab', url: 'http://mcp.lab.example:3001' });
      assert.equal(plain.readTokenEnv, null);
      assert.throws(() => createEp(db, 'ada', { name: 'prod-mcp', url: 'https://other.example/' }), conflict(`MCP endpoint "prod-mcp" exists (id ${ep.id}) — PATCH /api/mcp-endpoints/${ep.id} changes it`));
      assert.deepEqual(rows(db, 'acme', 'mcp_endpoint.create'), [
        ['mcp_endpoint.create', 'ada', 'prod-mcp', { fields: ['name', 'url', 'readTokenEnv'], origin: 'https://mcp.acme.example', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }],
        ['mcp_endpoint.create', 'ada', 'lab', { fields: ['name', 'url', 'readTokenEnv'], origin: 'http://mcp.lab.example:3001', readTokenEnv: null }],
      ]);

      // the view by rank
      const svc = admin.createServiceFromApi(db, 'oscar', { name: 'Pay' });
      const prod = admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod', mcpEndpointId: ep.id });
      const dev = admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'dev', mcpEndpointId: ep.id });
      assert.deepEqual(admin.mcpEndpointViewOf(db, ep, { rank: rankOfRole('viewer') }),
        { id: ep.id, name: 'prod-mcp', origin: 'https://mcp.acme.example', url: null, readTokenEnv: null, environments: 2, createdAt: ep.createdAt });
      assert.deepEqual(admin.mcpEndpointViewOf(db, ep, { rank: rankOfRole('operator') }),
        { id: ep.id, name: 'prod-mcp', origin: 'https://mcp.acme.example', url: 'https://mcp.acme.example/mcp?transport=sse', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN', environments: 2, createdAt: ep.createdAt });
      assert.equal(admin.mcpEndpointViewOf(db, plain, { rank: rankOfRole('admin') }).environments, 0);

      // update
      assert.throws(() => updateEp(db, 'ada', 999999, { name: 'x' }), missing('no MCP endpoint 999999'));
      assert.throws(() => updateEp(db, 'ada', plain.id, { name: 'prod-mcp' }), conflict(`MCP endpoint "prod-mcp" exists (id ${ep.id}) — PATCH /api/mcp-endpoints/${ep.id} changes it`));
      assert.throws(() => updateEp(db, 'ada', plain.id, { name: '' }), invalid(nameText));
      assert.throws(() => updateEp(db, 'ada', plain.id, { url: 'https://x.example/?sig=1' }), storeError(/the parameter\(s\) "sig" look like credentials/));
      assert.throws(() => updateEp(db, 'ada', plain.id, { readTokenEnv: 'OBSERVOGRAM_ORG_BRAVO_T' }), storeError(/belongs to org bravo/));
      assert.deepEqual(updateEp(db, 'ada', ep.id, { name: 'prod-mcp', url: 'https://mcp.acme.example/mcp?transport=sse', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }).changed, []);
      const up = updateEp(db, 'ada', ep.id, { url: 'https://mcp2.acme.example/mcp', readTokenEnv: null });
      assert.deepEqual([up.changed, up.endpoint.url, up.endpoint.readTokenEnv], [['url', 'readTokenEnv'], 'https://mcp2.acme.example/mcp', null]);
      assert.deepEqual(rows(db, 'acme', 'mcp_endpoint.update'), [['mcp_endpoint.update', 'ada', 'prod-mcp', { fields: ['url', 'readTokenEnv'], origin: 'https://mcp2.acme.example', readTokenEnv: null }]]);
      assert.deepEqual(updateEp(db, 'ada', plain.id, { name: 'lab2' }).changed, ['name']);

      // delete: the admin's view as it was, the unbound ids, the environments unbound.
      assert.throws(() => admin.deleteMcpEndpointFromApi(db, 'ada', 999999), missing('no MCP endpoint 999999'));
      const gone = admin.deleteMcpEndpointFromApi(db, 'ada', ep.id);
      assert.deepEqual(gone.unbound, [prod.id, dev.id].sort((a, b) => a - b));
      assert.deepEqual([gone.endpoint.url, gone.endpoint.environments], ['https://mcp2.acme.example/mcp', 2]);
      assert.deepEqual(environments.listEnvironments(db, svc.id).map((e) => e.mcpEndpointId), [null, null]);
      assert.deepEqual(admin.environmentViewOf(db, environments.getEnvironment(db, prod.id)).mcpEndpoint, null);
      assert.deepEqual(rows(db, 'acme', 'mcp_endpoint.delete'), [['mcp_endpoint.delete', 'ada', 'prod-mcp', { origin: 'https://mcp2.acme.example', unbound: 2 }]]);
    });
  } finally {
    close();
  }
});

test('the views: serviceViewOf and listServiceViews agree, sorted by slug, environments by name, packs primary first', async () => {
  const { db, close } = await freshStore('views');
  try {
    runWithOrg('acme', () => {
      const ep = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'prod-mcp', url: 'https://mcp.acme.example/mcp' });
      const pay = admin.createServiceFromApi(db, 'oscar', { name: 'Pay', tier: 'tier-1', owners: ['team-pay'], description: 'pays' });
      const api = admin.createServiceFromApi(db, 'oscar', { name: 'API Gateway' });
      admin.createEnvironmentFromApi(db, 'oscar', pay.id, { name: 'staging' });
      admin.createEnvironmentFromApi(db, 'oscar', pay.id, { name: 'prod', tier: 'tier-2', mcpEndpointId: ep.id });
      packs.addPack(db, 'oscar', { id: 'uploaded-z', label: 'Z', source: 'upload' });
      packs.addPack(db, 'oscar', { id: 'uploaded-a', label: null, source: 'workspace' });
      packs.addPack(db, 'oscar', { id: 'uploaded-m', label: 'M', source: 'mcp-x.yaml' });
      packServices.linkPackService(db, 'oscar', { packId: 'uploaded-z', serviceId: pay.id, role: 'member' });
      packServices.linkPackService(db, 'oscar', { packId: 'uploaded-a', serviceId: pay.id, role: 'member' });
      packServices.linkPackService(db, 'oscar', { packId: 'uploaded-m', serviceId: pay.id, role: 'primary' });
      const list = admin.listServiceViews(db);
      assert.deepEqual(list.map((v) => v.slug), ['api-gateway', 'pay']);
      assert.deepEqual(list, [admin.serviceViewOf(db, services.getService(db, api.id)), admin.serviceViewOf(db, services.getService(db, pay.id))]);
      const [, payView] = list;
      assert.deepEqual(Object.keys(payView), ['id', 'slug', 'name', 'owners', 'tier', 'description', 'source', 'createdAt', 'updatedAt', 'environments', 'packs']);
      assert.deepEqual([payView.name, payView.owners, payView.tier, payView.description, payView.source], ['Pay', ['team-pay'], 'tier-1', 'pays', { kind: 'observogram' }]);
      assert.deepEqual(payView.environments.map((e) => [e.name, e.tier, e.effectiveTier, e.mcpEndpoint]),
        [['prod', 'tier-2', 'tier-2', { id: ep.id, name: 'prod-mcp', origin: 'https://mcp.acme.example' }], ['staging', null, 'tier-1', null]]);
      assert.deepEqual(payView.packs, [
        { id: 'uploaded-m', label: 'M', source: 'mcp-x.yaml', role: 'primary' },
        { id: 'uploaded-a', label: null, source: 'workspace', role: 'member' },
        { id: 'uploaded-z', label: 'Z', source: 'upload', role: 'member' },
      ]);
      assert.deepEqual([list[0].environments, list[0].packs, list[0].tier, list[0].owners], [[], [], null, []]);
      assert.equal(auditRepo.listAudit(db, { orgId: 'acme', limit: 1000 }).length, 11, 'the views write nothing');
    });
    runWithOrg('bravo', () => assert.deepEqual(admin.listServiceViews(db), []));
  } finally {
    close();
  }
});

test('serviceTierFor: the primary link\'s service, its environment by name; null without a primary (a member-only aggregate, a catalogue pack)', async () => {
  const { db, close } = await freshStore('tier');
  try {
    runWithOrg('acme', () => {
      packs.addPack(db, 'oscar', { id: 'uploaded-demo', label: 'Demo', source: 'upload' });
      assert.equal(admin.serviceTierFor(db, 'uploaded-demo', 'prod'), null, 'no link');
      assert.equal(admin.serviceTierFor(db, 'production-curated', 'prod'), null, 'a catalogue pack has no row');
      const svc = admin.createServiceFromApi(db, 'oscar', { name: 'Demo' });
      packServices.linkPackService(db, 'oscar', { packId: 'uploaded-demo', serviceId: svc.id, role: 'primary' });
      const unset = { tier: null, from: null, service: { id: svc.id, slug: 'demo' }, environment: null };
      assert.deepEqual(admin.serviceTierFor(db, 'uploaded-demo', 'prod'), unset, 'a row with no tier: graded by the pack');
      assert.deepEqual(admin.serviceTierFor(db, 'uploaded-demo'), unset);
      assert.deepEqual(admin.serviceTierFor(db, 'uploaded-demo', undefined), unset);
      admin.updateServiceFromApi(db, 'oscar', svc.id, { tier: 'tier-1' });
      assert.deepEqual(admin.serviceTierFor(db, 'uploaded-demo', 'prod'), { tier: 'tier-1', from: 'service', service: { id: svc.id, slug: 'demo' }, environment: null });
      const prod = admin.createEnvironmentFromApi(db, 'oscar', svc.id, { name: 'prod' });
      assert.deepEqual(admin.serviceTierFor(db, 'uploaded-demo', 'prod'), { tier: 'tier-1', from: 'service', service: { id: svc.id, slug: 'demo' }, environment: { id: prod.id, name: 'prod' } }, 'an environment row without a tier falls back to the service');
      admin.updateEnvironmentFromApi(db, 'oscar', prod.id, { tier: 'tier-2' });
      assert.deepEqual(admin.serviceTierFor(db, 'uploaded-demo', 'prod'), { tier: 'tier-2', from: 'environment', service: { id: svc.id, slug: 'demo' }, environment: { id: prod.id, name: 'prod' } });
      assert.deepEqual(admin.serviceTierFor(db, 'uploaded-demo', 'staging').from, 'service', 'no row of that name');
      // a member-only pack (a live aggregate) grades by the pack.
      packs.addPack(db, 'oscar', { id: 'uploaded-live', label: 'Live (live MCP draft)', source: 'upload' });
      packServices.linkPackService(db, 'oscar', { packId: 'uploaded-live', serviceId: svc.id, role: 'member' });
      assert.equal(admin.serviceTierFor(db, 'uploaded-live', 'prod'), null);
    });
    runWithOrg('bravo', () => assert.equal(admin.serviceTierFor(db, 'uploaded-demo', 'prod'), null, 'another org reads nothing'));
  } finally {
    close();
  }
});

test('resolveMcpTarget: mcpUrl as today, or mcpEndpointId — the record\'s URL, the read token from the org\'s variable (never for a write), the ownership re-checked at request time', async () => {
  const { db, close } = await freshStore('target');
  const VAR = 'OBSERVOGRAM_ORG_ACME_TEST_TOKEN';
  try {
    runWithOrg('acme', () => {
      const ep = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'prod-mcp', url: 'https://mcp.acme.example/mcp?transport=sse', readTokenEnv: VAR });
      const plain = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'lab', url: 'https://mcp.lab.example/mcp' });
      const bad = (body, error, opts) => assert.deepEqual(resolve(db, body, opts), { status: 400, error }, JSON.stringify(body));
      // the body as today
      assert.deepEqual(resolve(db, { mcpUrl: 'https://mcp.example/mcp?token=t&tier=x', mcpAuth: 'Bearer x' }),
        { mcpUrl: 'https://mcp.example/mcp?token=t&tier=x', safeMcpUrl: 'https://mcp.example/mcp?tier=x', mcpAuth: 'Bearer x', endpoint: null });
      bad({ mcpUrl: 'https://alice:pw@mcp.example/mcp?token=t', mcpAuth: 'Bearer x' }, 'a typed MCP URL may not carry user:password — send the token as mcpAuth');
      bad({ mcpUrl: 'https://alice@mcp.example/mcp' }, 'a typed MCP URL may not carry user:password — send the token as mcpAuth', { forWrite: true });
      assert.deepEqual(resolve(db, { mcpUrl: 'https://mcp.example/mcp' }).mcpAuth, null, 'no token sent → null, as the routes passed it');
      assert.deepEqual(resolve(db, { mcpUrl: '  https://mcp.example/mcp ', mcpAuth: '' }),
        { mcpUrl: 'https://mcp.example/mcp', safeMcpUrl: 'https://mcp.example/mcp', mcpAuth: null, endpoint: null }, 'the URL trimmed, an empty token none — the routes\' reading of the body');
      bad({}, 'mcpUrl or mcpEndpointId required in JSON body');
      bad({ mcpUrl: '' }, 'mcpUrl or mcpEndpointId required in JSON body');
      bad({ mcpUrl: '   ' }, 'mcpUrl or mcpEndpointId required in JSON body');
      bad({ mcpUrl: 42 }, 'mcpUrl or mcpEndpointId required in JSON body');
      bad({ mcpAuth: 'x' }, 'mcpUrl or mcpEndpointId required in JSON body');
      bad({ mcpUrl: 'ftp://mcp.example' }, "mcpUrl must be http or https; got scheme 'ftp'");
      bad({ mcpUrl: 'https://mcp.example', mcpEndpointId: ep.id }, 'send mcpUrl or mcpEndpointId, not both');
      bad({ mcpUrl: 'https://mcp.example', mcpEndpointId: 0 }, 'send mcpUrl or mcpEndpointId, not both');
      assert.equal(resolve(db, { mcpUrl: 'https://mcp.example', mcpEndpointId: null }).error, undefined, 'null is "not sent"');
      for (const id of [0, -1, 1.5, 'x', '', true, {}]) bad({ mcpEndpointId: id }, 'mcpEndpointId must be a positive integer');
      bad({ mcpEndpointId: 999999 }, 'no MCP endpoint 999999 in this org — GET /api/mcp-endpoints lists them');
      bad({ mcpEndpointId: '999999' }, 'no MCP endpoint 999999 in this org — GET /api/mcp-endpoints lists them');
      // the record's URL; no variable named → no token
      assert.deepEqual(resolve(db, { mcpEndpointId: plain.id }),
        { mcpUrl: 'https://mcp.lab.example/mcp', safeMcpUrl: 'https://mcp.lab.example/mcp', mcpAuth: null, endpoint: { id: plain.id, name: 'lab' } });
      assert.deepEqual(resolve(db, { mcpEndpointId: String(plain.id), mcpAuth: 'Bearer mine' }).mcpAuth, 'Bearer mine');
      // the variable: unset → 400 naming it; set → the token, never for a write
      delete process.env[VAR];
      bad({ mcpEndpointId: ep.id }, `MCP endpoint "prod-mcp" reads its token from ${VAR}, which is not set in the server's environment — set it on the server (the k8s Deployment's env), or send mcpAuth with this request`);
      assert.equal(resolve(db, { mcpEndpointId: ep.id, mcpAuth: 'Bearer sent' }).mcpAuth, 'Bearer sent', 'a sent token needs no variable');
      assert.deepEqual(resolve(db, { mcpEndpointId: ep.id }, { forWrite: true }),
        { mcpUrl: 'https://mcp.acme.example/mcp?transport=sse', safeMcpUrl: 'https://mcp.acme.example/mcp?transport=sse', mcpAuth: null, endpoint: { id: ep.id, name: 'prod-mcp' } }, 'a write reads no variable');
      process.env[VAR] = 'Bearer from-env';
      try {
        assert.deepEqual(resolve(db, { mcpEndpointId: ep.id }),
          { mcpUrl: 'https://mcp.acme.example/mcp?transport=sse', safeMcpUrl: 'https://mcp.acme.example/mcp?transport=sse', mcpAuth: 'Bearer from-env', endpoint: { id: ep.id, name: 'prod-mcp' } });
        assert.equal(resolve(db, { mcpEndpointId: ep.id, mcpAuth: 'Bearer sent' }).mcpAuth, 'Bearer sent', 'the request\'s token wins');
        assert.equal(resolve(db, { mcpEndpointId: ep.id, mcpAuth: '' }).mcpAuth, 'Bearer from-env', 'an empty one is none');
        assert.equal(resolve(db, { mcpEndpointId: ep.id }, { forWrite: true }).mcpAuth, null);
        // ownership re-checked at request time: a name registered before acme-eu existed is acme-eu's now.
        const eu = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'eu', url: 'https://mcp.eu.example/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_EU_X' });
        process.env.OBSERVOGRAM_ORG_ACME_EU_X = 'Bearer eu';
        assert.equal(resolve(db, { mcpEndpointId: eu.id }).mcpAuth, 'Bearer eu');
        orgs.createOrg(db, 'system', { id: 'acme-eu', name: 'Acme EU' });
        bad({ mcpEndpointId: eu.id }, `observogram store: OBSERVOGRAM_ORG_ACME_EU_X belongs to org acme-eu (the longest org prefix wins) — an admin may only name variables set aside for their org — PATCH /api/mcp-endpoints/${eu.id} names another variable`);
        bad({ mcpEndpointId: eu.id, mcpAuth: 'Bearer sent' }, `observogram store: OBSERVOGRAM_ORG_ACME_EU_X belongs to org acme-eu (the longest org prefix wins) — an admin may only name variables set aside for their org — PATCH /api/mcp-endpoints/${eu.id} names another variable`, undefined);
        assert.equal(resolve(db, { mcpEndpointId: eu.id }, { forWrite: true }).mcpAuth, null, 'a write names no variable, so nothing to own');
        assert.equal(mcpEndpoints.updateMcpEndpoint(db, 'ada', eu.id, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_EU2' }).readTokenEnv, 'OBSERVOGRAM_ORG_ACME_EU2', 'the way out works');
      } finally {
        delete process.env[VAR];
        delete process.env.OBSERVOGRAM_ORG_ACME_EU_X;
      }
      assert.ok(!(VAR in process.env));
    });
    runWithOrg('bravo', () => {
      const acmeId = runWithOrg('acme', () => mcpEndpoints.listMcpEndpoints(db)[0].id);
      assert.deepEqual(resolve(db, { mcpEndpointId: acmeId }), { status: 400, error: `no MCP endpoint ${acmeId} in this org — GET /api/mcp-endpoints lists them` }, 'another org\'s id is never found');
    });
  } finally {
    close();
  }
});

// The origin rule (server/mcp-target-policy.mjs, D2 (c)) at use and at
// registration: one case per row of the table, the variable unset, then set.
async function withOrigins(value, fn) {
  if (value === undefined) delete process.env.OBSERVOGRAM_MCP_ORIGINS; else process.env.OBSERVOGRAM_MCP_ORIGINS = value;
  try { return await fn(); } finally { process.env.OBSERVOGRAM_MCP_ORIGINS = SUITE_ORIGINS; }
}

test('the origin rule, no list set: a credential (the endpoint\'s variable, mcpAuth, one in a typed URL) leaves only for loopback; a typed URL without one reaches only an origin of the org\'s endpoints; a registered endpoint without one is allowed', async () => {
  const { db, close } = await freshStore('origins-unset');
  const VAR = 'OBSERVOGRAM_ORG_ACME_ORIGIN_TOKEN';
  try {
    await withOrigins(undefined, () => runWithOrg('acme', () => {
      const remote = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'remote', url: 'https://mcp.acme.example/mcp' });
      const tokened = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'tokened', url: 'https://mcp.tok.example/mcp', readTokenEnv: VAR });
      const local = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'local', url: 'http://127.0.0.1:9/mcp', readTokenEnv: VAR });
      const refused = (body, error, opts) => assert.deepEqual(resolve(db, body, opts), { status: 403, denied: 'origin', error }, JSON.stringify(body));
      const way = 'the server\'s operator adds https://mcp.acme.example to OBSERVOGRAM_MCP_ORIGINS (or OBSERVOGRAM_ORG_ACME_MCP_ORIGINS)';
      process.env[VAR] = 'Bearer held';
      try {
        // typed, no credential: an origin of this org's endpoints, or loopback
        assert.equal(resolve(db, { mcpUrl: 'https://mcp.acme.example/other' }).mcpUrl, 'https://mcp.acme.example/other');
        assert.equal(resolve(db, { mcpUrl: 'http://localhost:7/mcp' }).mcpUrl, 'http://localhost:7/mcp');
        refused({ mcpUrl: 'https://mcp.elsewhere.example/mcp?tier=x' },
          'https://mcp.elsewhere.example is not an origin this org\'s MCP endpoints use — an admin registers the endpoint in Settings → MCP endpoints, or the server\'s operator lists the origin in OBSERVOGRAM_MCP_ORIGINS (or OBSERVOGRAM_ORG_ACME_MCP_ORIGINS)');
        runWithOrg('bravo', () => refused({ mcpUrl: 'https://mcp.acme.example/mcp' },
          'https://mcp.acme.example is not an origin this org\'s MCP endpoints use — an admin registers the endpoint in Settings → MCP endpoints, or the server\'s operator lists the origin in OBSERVOGRAM_MCP_ORIGINS (or OBSERVOGRAM_ORG_BRAVO_MCP_ORIGINS)'));
        // typed with a credential: loopback only
        refused({ mcpUrl: 'https://mcp.acme.example/mcp', mcpAuth: 'Bearer mine' },
          `https://mcp.acme.example is not a listed MCP origin, and the server sends a credential (the auth key sent with this request) only to a listed origin or this machine — ${way}, or send the request without mcpAuth`);
        refused({ mcpUrl: 'https://mcp.acme.example/mcp?token=abc' },
          `https://mcp.acme.example is not a listed MCP origin, and the server sends a credential (a credential in the URL) only to a listed origin or this machine — ${way}, or send the URL without its credential`);
        assert.equal(resolve(db, { mcpUrl: 'http://127.0.0.1:9/mcp', mcpAuth: 'Bearer mine' }).mcpAuth, 'Bearer mine', 'loopback takes a credential');
        // registered, no credential: allowed; with one: loopback only
        assert.equal(resolve(db, { mcpEndpointId: remote.id }).mcpUrl, 'https://mcp.acme.example/mcp');
        assert.equal(resolve(db, { mcpEndpointId: remote.id }, { forWrite: true }).mcpAuth, null, 'a write without a token');
        refused({ mcpEndpointId: remote.id, mcpAuth: 'Bearer write' },
          `https://mcp.acme.example is not a listed MCP origin, and the server sends a credential (the auth key sent with this request) only to a listed origin or this machine — ${way}, or send the request without mcpAuth`, { forWrite: true });
        refused({ mcpEndpointId: tokened.id },
          `https://mcp.tok.example is not a listed MCP origin, and the server sends a credential (the endpoint's variable ${VAR}) only to a listed origin or this machine — the server's operator adds https://mcp.tok.example to OBSERVOGRAM_MCP_ORIGINS (or OBSERVOGRAM_ORG_ACME_MCP_ORIGINS)`);
        assert.equal(resolve(db, { mcpEndpointId: tokened.id }, { forWrite: true }).mcpAuth, null, 'a write sends no variable: nothing rides');
        assert.equal(resolve(db, { mcpEndpointId: local.id }).mcpAuth, 'Bearer held', 'the variable rides to a loopback endpoint');
        for (const r of [resolve(db, { mcpEndpointId: tokened.id }), resolve(db, { mcpEndpointId: remote.id, mcpAuth: 'Bearer write' })]) {
          assert.ok(!JSON.stringify(r).includes('Bearer'), 'a refusal never carries the token');
        }
      } finally {
        delete process.env[VAR];
      }

      // registration: with readTokenEnv loopback only; without, anywhere
      const reg = (url) => `${url} is not a listed MCP origin, and the server sends a credential (the endpoint's variable OBSERVOGRAM_ORG_ACME_MCP_TOKEN) only to a listed origin or this machine — the server's operator adds ${url} to OBSERVOGRAM_MCP_ORIGINS (or OBSERVOGRAM_ORG_ACME_MCP_ORIGINS), or register it without readTokenEnv`;
      const before = rows(db, 'acme').length;
      assert.throws(() => createEp(db, 'ada', { name: 'x', url: 'https://mcp.new.example/mcp?tier=1', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }), invalid(reg('https://mcp.new.example')));
      assert.equal(mcpEndpoints.listMcpEndpoints(db).some((ep) => ep.name === 'x'), false, 'the refused record is not there');
      assert.equal(rows(db, 'acme').length, before, 'and wrote no row');
      assert.equal(createEp(db, 'ada', { name: 'loop', url: 'http://[::1]:3001/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }).name, 'loop');
      const open = createEp(db, 'ada', { name: 'open', url: 'https://mcp.new.example/mcp' });
      assert.equal(open.readTokenEnv, null, 'token-less, anywhere');
      // a PATCH that makes the record carry the server's credential to an unlisted origin
      assert.throws(() => updateEp(db, 'ada', open.id, { readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }), invalid(reg('https://mcp.new.example')));
      const loop = mcpEndpoints.listMcpEndpoints(db).find((ep) => ep.name === 'loop');
      assert.throws(() => updateEp(db, 'ada', loop.id, { url: 'https://mcp.moved.example/mcp' }), invalid(reg('https://mcp.moved.example')));
      assert.deepEqual([mcpEndpoints.getMcpEndpoint(db, open.id).readTokenEnv, mcpEndpoints.getMcpEndpoint(db, loop.id).url], [null, 'http://[::1]:3001/mcp'], 'both records as they were');
      assert.equal(updateEp(db, 'ada', loop.id, { name: 'loop-2' }).changed.join(), 'name', 'a rename alone is not judged');
    }));
  } finally {
    close();
  }
});

test('the origin rule, a list set: every origin but loopback must be in OBSERVOGRAM_MCP_ORIGINS ∪ OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS — at use and at registration; an endpoint registered under `*` is refused once the list no longer has it', async () => {
  const { db, close } = await freshStore('origins-set');
  try {
    let wide;
    await withOrigins('*', () => runWithOrg('acme', () => {
      wide = createEp(db, 'ada', { name: 'wide', url: 'https://mcp.wide.example/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_WIDE_TOKEN' });
    }));
    await withOrigins('https://mcp.acme.example', () => runWithOrg('acme', () => {
      const refused = (body, error, opts) => assert.deepEqual(resolve(db, body, opts), { status: 403, denied: 'origin', error }, JSON.stringify(body));
      refused({ mcpEndpointId: wide.id, mcpAuth: 'Bearer x' }, 'https://mcp.wide.example is not in OBSERVOGRAM_MCP_ORIGINS — the server\'s operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or choose another registered endpoint');
      refused({ mcpUrl: 'https://mcp.wide.example/mcp' }, 'https://mcp.wide.example is not in OBSERVOGRAM_MCP_ORIGINS — the server\'s operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or choose one of the org\'s registered endpoints');
      assert.equal(resolve(db, { mcpUrl: 'HTTPS://MCP.ACME.EXAMPLE:443/mcp', mcpAuth: 'Bearer x' }).mcpAuth, 'Bearer x', 'listed: a credential rides; the origin compared normalised');
      assert.equal(resolve(db, { mcpUrl: 'http://127.0.0.1:9/mcp', mcpAuth: 'Bearer x' }).mcpAuth, 'Bearer x', 'loopback always');
      assert.throws(() => createEp(db, 'ada', { name: 'n', url: 'https://mcp.new.example/mcp' }),
        invalid('https://mcp.new.example is not in OBSERVOGRAM_MCP_ORIGINS — the server\'s operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or register an endpoint at a listed origin'));
      // the org's own list joins the deployment's, for that org only
      process.env.OBSERVOGRAM_ORG_ACME_MCP_ORIGINS = 'https://mcp.new.example';
      try {
        assert.equal(createEp(db, 'ada', { name: 'n', url: 'https://mcp.new.example/mcp', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_N_TOKEN' }).name, 'n');
        refused({ mcpEndpointId: wide.id, mcpAuth: 'Bearer x' }, 'https://mcp.wide.example is not in OBSERVOGRAM_MCP_ORIGINS, nor in OBSERVOGRAM_ORG_ACME_MCP_ORIGINS — the server\'s operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or choose another registered endpoint');
        runWithOrg('bravo', () => assert.throws(() => createEp(db, 'bob', { name: 'n', url: 'https://mcp.new.example/mcp' }),
          invalid('https://mcp.new.example is not in OBSERVOGRAM_MCP_ORIGINS — the server\'s operator adds it there (comma-separated origins, e.g. https://mcp.example.com), or register an endpoint at a listed origin')));
      } finally {
        delete process.env.OBSERVOGRAM_ORG_ACME_MCP_ORIGINS;
      }
    }));
    // a list set with no accepted entry allows nothing but loopback (fail closed)
    await withOrigins('mcp.acme.example', () => runWithOrg('acme', () => {
      assert.equal(resolve(db, { mcpEndpointId: wide.id }, { forWrite: true }).denied, 'origin', 'even without a credential');
      assert.equal(resolve(db, { mcpUrl: 'http://localhost:9/' }).error, undefined);
    }));
  } finally {
    close();
  }
});

test('resolveMcpTarget takes the caller: none throws; a typed URL needs the admin role (owner included) — an operator session, the bearer and the anonymous local caller are refused before any other check but userinfo, the deploy routes\' forWrite included (D3); by id every caller the class admitted', async () => {
  const { db, close } = await freshStore('caller');
  try {
    runWithOrg('acme', () => {
      const ep = mcpEndpoints.createMcpEndpoint(db, 'ada', { name: 'lab', url: 'https://mcp.lab.example/mcp' });
      assert.throws(() => admin.resolveMcpTarget(db, { mcpEndpointId: ep.id }), { name: 'TypeError', message: 'resolveMcpTarget: the caller (mcpCallerOf(req)) is required' });
      const oscar = callerIn('acme', { kind: 'session', actor: 'oscar', role: 'operator', owner: false });
      const bearer = { ...callerIn('acme', { kind: 'bearer', actor: 'ci-bot', role: 'operator', owner: false }), posture: 'token' };
      const local = { ...callerIn('acme', { kind: 'local', actor: 'local', role: 'admin', owner: true }), posture: 'open-loopback' };
      const plainAdmin = callerIn('acme', { kind: 'session', actor: 'ada', role: 'admin', owner: false });
      const typed = { mcpUrl: 'https://mcp.lab.example/other', mcpAuth: 'Bearer t' };
      assert.deepEqual(resolve(db, typed, { caller: oscar }), {
        status: 403, denied: 'role', need: 'admin',
        error: "a typed MCP URL needs the admin role in org 'acme' (you are operator) — choose one of the org's registered MCP endpoints (mcpEndpointId; GET /api/mcp-endpoints lists them), or ask an admin of acme to register this one in Settings → MCP endpoints",
      });
      assert.equal(resolve(db, typed, { caller: bearer }).denied, 'role');
      assert.equal(resolve(db, typed, { caller: local }).denied, 'posture');
      assert.equal(resolve(db, { mcpUrl: 'file:///etc/passwd' }, { caller: oscar }).denied, 'role', 'the role rule runs before the scheme');
      assert.equal(resolve(db, { mcpUrl: 'https://u:p@mcp.lab.example/' }, { caller: local }).status, 400, 'userinfo first: native fetch would repeat it');
      for (const c of [plainAdmin, callerIn('acme')]) assert.equal(resolve(db, typed, { caller: c }).mcpAuth, 'Bearer t', `${c.principal.actor} (admin${c.principal.owner ? ', an owner' : ''}) types a URL`);
      for (const c of [oscar, bearer, local]) {
        assert.equal(resolve(db, typed, { caller: c, forWrite: true }).denied, c.principal.kind === 'local' ? 'posture' : 'role', `${c.principal.kind}: the deploy routes' forWrite refuses it too (D3)`);
        assert.equal(resolve(db, { mcpEndpointId: ep.id, mcpAuth: 'Bearer w' }, { caller: c, forWrite: true }).mcpUrl, 'https://mcp.lab.example/mcp', `${c.principal.kind}: a deploy by id`);
        assert.equal(resolve(db, { mcpEndpointId: ep.id }, { caller: c }).mcpUrl, 'https://mcp.lab.example/mcp', `${c.principal.kind}: by id`);
      }
    });
  } finally {
    close();
  }
});

test('registration takes the caller (D4): none throws; without sign-in (the anonymous local caller) only a loopback MCP or a listed origin is registered, token or not — a PATCH of the url too; the refused record and its row are not written', async () => {
  const { db, close } = await freshStore('register-local');
  try {
    await withOrigins(undefined, () => runWithOrg('acme', () => {
      const local = { ...callerIn('acme', { kind: 'local', actor: 'local', role: 'admin', owner: true }), posture: 'open-loopback', direct: true };
      assert.throws(() => admin.createMcpEndpointFromApi(db, 'local', { name: 'x', url: 'http://127.0.0.1:9/mcp' }), { name: 'TypeError', message: 'createMcpEndpointFromApi: the caller (mcpCallerOf(req)) is required' });
      const D4 = 'on a server without sign-in, only a loopback MCP or an origin listed in OBSERVOGRAM_MCP_ORIGINS may be registered — list https://mcp.demo.example there, or sign in as an admin (npm run users -- add <login> arms sign-in)';
      const before = rows(db, 'acme').length;
      assert.throws(() => createEp(db, 'local', { name: 'demo', url: 'https://mcp.demo.example/mcp' }, { caller: local }), invalid(D4));
      assert.equal(mcpEndpoints.listMcpEndpoints(db).length, 0, 'the refused record is not there');
      assert.equal(rows(db, 'acme').length, before, 'and wrote no row');
      const loop = createEp(db, 'local', { name: 'loop', url: 'http://127.0.0.1:3001/mcp' }, { caller: local });
      assert.equal(loop.name, 'loop', 'a loopback MCP registers');
      assert.throws(() => admin.updateMcpEndpointFromApi(db, 'local', loop.id, { url: 'https://mcp.demo.example/mcp' }), TypeError);
      assert.throws(() => updateEp(db, 'local', loop.id, { url: 'https://mcp.demo.example/mcp' }, { caller: local }), invalid(D4));
      assert.equal(mcpEndpoints.getMcpEndpoint(db, loop.id).url, 'http://127.0.0.1:3001/mcp', 'the record as it was');
      assert.equal(updateEp(db, 'local', loop.id, { name: 'loop-2' }, { caller: local }).changed.join(), 'name', 'a rename alone is not judged');
      assert.equal(createEp(db, 'ada', { name: 'demo', url: 'https://mcp.demo.example/mcp' }).name, 'demo', 'a session admin registers it token-less');
    }));
    await withOrigins('https://mcp.listed.example', () => runWithOrg('acme', () => {
      const local = { ...callerIn('acme', { kind: 'local', actor: 'local', role: 'admin', owner: true }), posture: 'open-loopback', direct: true };
      assert.equal(createEp(db, 'local', { name: 'listed', url: 'https://mcp.listed.example/mcp' }, { caller: local }).name, 'listed', 'a listed origin registers without sign-in');
    }));
  } finally {
    close();
  }
});
