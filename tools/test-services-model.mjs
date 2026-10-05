#!/usr/bin/env node
/**
 * tools/test-services-model.mjs — the pure models of the Services home and the service page
 * (studio/services-model.mjs) and the loaders (studio/services-api.mjs), headless under node:test
 * (docs/STORE_PLAN.md §6, slice 6a). The fixtures are the shapes server/test-services-api.mjs
 * pins: ServiceView rows (several primaries per service, `packs[]` by id string), GET /api/orgs
 * bodies for the five fixture principals (olive owner outside acme, ada admin, oscar operator,
 * vera viewer, bob in bravo) and the open and token-only postures, conformance reports with the
 * record's tier, the handler refusals without `denied`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS, TIER_BY_PACK, accessModel, verdictModel, verdictKey, newestPack, packForService, serviceCardModel, agoText,
  buildServicesHomeModel, buildServicePageModel, servicesSelectModel, buildHandoffPlan, buildDefineOriginNote,
  buildServicePatch, buildNoOrgModel, servicesStatusOf, persistedStateKey, recentServicesKey,
} from '../studio/services-model.mjs';
import { servicesRefusal, loadOrgs, loadServices, loadService, loadVerdict, patchService, verdictLoader } from '../studio/services-api.mjs';
import { WAYS } from '../server/service-admin.mjs';

// ---------- fixtures ----------

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const env = (id, name, over = {}) => ({
  id, serviceId: 1, name, tier: null, effectiveTier: null, bindings: {}, endpoints: {}, mcpEndpoint: null,
  createdAt: 'test', updatedAt: 'test', ...over,
});
// A ServiceView (server/service-admin.mjs serviceView): primaries first, then by pack id STRING.
const orders = {
  id: 1, slug: 'orders-api', name: 'Orders API', owners: ['team-orders', 'sre-platform'], tier: 'tier-2', description: 'Order intake and payment hand-off',
  source: { kind: 'observogram' }, createdAt: 'test', updatedAt: 'test',
  environments: [
    env(11, 'prod', { effectiveTier: 'tier-2', bindings: { cluster: 'eks-eu-1', namespace: 'orders' }, endpoints: { dashboard: 'https://grafana.example/d/orders', runbook: 'https://wiki.example/orders', evil: 'javascript:alert(1)' },
      mcpEndpoint: { id: 3, name: 'prod-grafana-mcp', origin: 'https://mcp.example' } }),
    env(12, 'staging', { effectiveTier: 'tier-2' }),
    env(13, 'dev', { effectiveTier: 'tier-2' }),
  ],
  packs: [
    { id: 'uploaded-orders-api-aaaa', label: 'Orders API (library)', source: 'library', role: 'primary' },
    { id: 'uploaded-orders-api-zzzz', label: 'Orders API (upload)', source: 'upload', role: 'primary' },
    { id: 'uploaded-live-agg-1111', label: 'Live snapshot', source: 'live', role: 'member' },
  ],
};
// Catalogue order is oldest → newest: the 'zzzz' primary is the OLDER one despite sorting last by id.
const catalog = [
  { id: 'uploaded-orders-api-zzzz', label: 'Orders API (upload)', version: '1.3', environments: ['prod'], source: 'uploaded', ok: true },
  { id: 'uploaded-live-agg-1111', label: 'Live snapshot', version: null, environments: [], source: 'uploaded', ok: true, services: ['orders-api', 'billing'] },
  { id: 'uploaded-orders-api-aaaa', label: 'Orders API (library)', version: '1.4', environments: ['prod', 'staging'], source: 'uploaded', ok: true },
  { id: 'payment-service', label: 'payment-service', version: '1.4', environments: ['prod'], source: 'catalog', criticality: 'tier-1', ok: true },
];
const isLiveAggregatePack = (p) => p.id.startsWith('uploaded-live-agg');
const bare = { id: 2, slug: 'ledger', name: 'Ledger', owners: [], tier: null, description: null, source: { kind: 'observogram' }, createdAt: 'test', updatedAt: 'test', environments: [], packs: [] };
const memberOnly = { ...bare, id: 3, slug: 'billing', name: 'Billing', environments: [env(31, 'prod')], packs: [{ id: 'uploaded-live-agg-1111', label: 'Live snapshot', source: 'live', role: 'member' }] };

const report = (over = {}) => ({
  environment: 'prod', declaredTier: 'tier-2', conformant: true, scorePercent: 92,
  tier: { graded: 'tier-2', pack: 'tier-2', from: 'service', service: { id: 1, slug: 'orders-api' }, environment: null, mismatch: false }, ...over,
});

const orgsBody = (orgs, active) => ({ ok: true, tenancy: true, orgs, active });
const ACME = { id: 'acme', name: 'Acme' };
const me = (login, orgs) => ({ ok: true, mode: 'local', authenticated: true, sub: login, user: { login, kind: 'local', owner: login === 'olive' }, orgs });

// ---------- access ----------

test('accessModel: GET /api/orgs is the source of truth — the five fixture principals, every posture', () => {
  // olive: an owner outside her acme membership — /api/orgs appends the active org with its name and admin.
  const olive = accessModel({ orgs: orgsBody([{ id: 'default', name: 'Default', role: 'admin', effectiveRole: 'admin' }, { ...ACME, role: null, effectiveRole: 'admin' }], 'acme'), identity: me('olive', [{ id: 'default', name: 'Default', role: 'admin', effectiveRole: 'admin', default: true }]), activeOrg: 'acme' });
  assert.deepEqual(olive, { posture: 'identity', role: 'admin', rank: 2, canWrite: true, reason: null, orgName: 'Acme' });
  const ada = accessModel({ orgs: orgsBody([{ ...ACME, role: 'admin', effectiveRole: 'admin' }], 'acme'), identity: me('ada', []), activeOrg: 'acme' });
  assert.equal(ada.rank, 2);
  const oscar = accessModel({ orgs: orgsBody([{ ...ACME, role: 'operator', effectiveRole: 'operator' }], 'acme'), identity: me('oscar', []), activeOrg: 'acme' });
  assert.deepEqual([oscar.posture, oscar.rank, oscar.canWrite, oscar.reason], ['identity', 1, true, null]);
  const vera = accessModel({ orgs: orgsBody([{ ...ACME, role: 'viewer', effectiveRole: 'viewer' }], 'acme'), identity: me('vera', []), activeOrg: 'acme' });
  assert.deepEqual(vera, { posture: 'identity', role: 'viewer', rank: 0, canWrite: false, reason: 'needs the operator role in Acme — yours is viewer', orgName: 'Acme' });
  const bob = accessModel({ orgs: orgsBody([{ id: 'bravo', name: 'Bravo', role: 'admin', effectiveRole: 'admin' }], 'bravo'), identity: me('bob', []), activeOrg: 'bravo' });
  assert.equal(bob.orgName, 'Bravo');
  // The open posture: /auth/me is 404 (identity null), the server reads the browser as `local` (admin).
  const open = accessModel({ orgs: orgsBody([{ id: 'default', name: 'Default', role: null, effectiveRole: 'admin' }], 'default'), identity: null });
  assert.deepEqual([open.posture, open.canWrite, open.orgName], ['open', true, 'Default']);
  // The token-only posture: identity null and the anonymous browser is a viewer — read-only, with the token reason.
  const token = accessModel({ orgs: orgsBody([{ id: 'default', name: 'Default', role: null, effectiveRole: 'viewer' }], 'default'), identity: null });
  assert.deepEqual([token.posture, token.canWrite], ['token', false]);
  assert.equal(token.reason, 'needs the operator role — this server takes mutations with its API token only, not from a browser');
  // The static bundle: 501 no-backend → static, every affordance drawn (each write 501s with the feature named).
  const bundleErr = Object.assign(new Error('501: Organisations needs the server'), { denied: 'no-backend', status: 501 });
  assert.deepEqual(accessModel({ orgs: null, orgsError: bundleErr, identity: null }), { posture: 'static', role: null, rank: null, canWrite: true, reason: null, orgName: null });
  // The call failed otherwise: /auth/me's memberships are the fallback; with no identity the posture is unknown and the server decides.
  const fallback = accessModel({ orgs: null, orgsError: new Error('500: boom'), identity: me('vera', [{ ...ACME, role: 'viewer', effectiveRole: 'viewer', default: false }]), activeOrg: 'acme' });
  assert.deepEqual([fallback.posture, fallback.role, fallback.canWrite, fallback.orgName], ['identity', 'viewer', false, 'Acme']);
  const unknown = accessModel({ orgs: null, orgsError: new Error('500: boom'), identity: null });
  assert.deepEqual([unknown.posture, unknown.role, unknown.canWrite, unknown.reason], ['unknown', null, true, null]);
});

// ---------- the verdict ----------

test('verdictModel: the nine states — placeholders never pass, an undeclared environment is a base grade, an aggregate fetches nothing', () => {
  const pass = verdictModel(report(), { packId: 'p', env: 'prod' });
  assert.deepEqual([pass.state, pass.text, pass.fetch, pass.key], ['pass', 'Conformant · 92% · tier-2 (service)', true, 'p::prod']);
  const ph = verdictModel(report({ onPlaceholder: ['SLI-01', 'SLO-02', 'ALERT-03'] }), { env: 'prod' });
  assert.deepEqual([ph.state, ph.text, ph.onPlaceholder], ['placeholder', 'Conformant · 92% · 3 on placeholders', 3]);
  const fail = verdictModel(report({ conformant: false, scorePercent: 61, tier: { graded: 'tier-3', pack: 'tier-3', from: 'pack', service: null, environment: null, mismatch: false } }), { env: 'prod' });
  assert.deepEqual([fail.state, fail.text], ['fail', 'Not conformant · 61% · tier-3 (pack)']);
  // The pack does not declare the environment: whatever the report says, a base grade and never green.
  const base = verdictModel(report(), { env: 'staging', declared: false });
  assert.deepEqual([base.state, base.text], ['base', 'Base grade (no staging overlay in the pack) · 92% · tier-2 (service)']);
  assert.notEqual(verdictModel(report({ onPlaceholder: [] }), { env: 'staging', declared: false }).state, 'pass');
  // A tier mismatch adds the pack's own tier as the detail (the <small>).
  const mm = verdictModel(report({ tier: { graded: 'tier-2', pack: 'tier-3', from: 'service', service: { id: 1, slug: 'orders-api' }, environment: null, mismatch: true } }), { env: 'prod' });
  assert.deepEqual([mm.mismatch, mm.detail, mm.from], [true, 'pack says tier-3', 'service']);
  assert.equal(verdictModel(report({ tier: { graded: 'tier-1', pack: 'tier-2', from: 'environment', mismatch: true } }), { env: 'prod' }).text, 'Conformant · 92% · tier-1 (environment)');
  const none = verdictModel(null, { how: 'none' });
  assert.deepEqual([none.state, none.text, none.fetch], ['none', 'No pack yet', false]);
  const agg = verdictModel(report(), { how: 'aggregate' });
  assert.deepEqual([agg.state, agg.text, agg.fetch], ['none', 'Member pack only — open it under Packs linked', false]);
  const loading = verdictModel(null, { packId: 'p', env: 'prod' });
  assert.deepEqual([loading.state, loading.text, loading.fetch], ['loading', 'Loading…', true]);
  const err = verdictModel({ error: '404: unknown pack: p' }, { env: 'prod' });
  assert.deepEqual([err.state, err.text, err.detail], ['error', 'Unavailable', '404: unknown pack: p']);
  assert.ok(!err.detail.includes('{'), 'the title text is the parsed sentence, never a raw body');
  // A report without the record tier (a catalogue pack) names the pack's own tier; no score reads "no score", never 0.
  assert.equal(verdictModel({ conformant: true, scorePercent: 100, declaredTier: 'tier-3', tier: { graded: 'tier-3', pack: 'tier-3', from: 'pack', mismatch: false } }, { env: 'prod' }).text, 'Conformant · 100% · tier-3 (pack)');
  assert.equal(verdictModel({ conformant: false }, { env: 'prod' }).text, `Not conformant · no score · ${TIER_BY_PACK}`);
  assert.equal(verdictKey('p', 'prod'), 'p::prod');
});

// ---------- the pack resolver ----------

test('packForService: two primaries — the one later in catalogue order wins (not the first by id string); the member aggregate is the fallback; none', () => {
  const r = packForService(orders, catalog, { isLiveAggregatePack });
  assert.equal(r.pack.id, 'uploaded-orders-api-aaaa', 'the newest primary in catalogue order, though "zzzz" sorts last by id');
  assert.equal(r.how, 'primary');
  assert.deepEqual(r.primaries, ['uploaded-orders-api-zzzz', 'uploaded-orders-api-aaaa'], 'every primary, catalogue order');
  // The newest primary is not in the catalogue (deleted): the other primary.
  const without = packForService(orders, catalog.filter((p) => p.id !== 'uploaded-orders-api-aaaa'), { isLiveAggregatePack });
  assert.deepEqual([without.pack.id, without.how, without.primaries], ['uploaded-orders-api-zzzz', 'primary', ['uploaded-orders-api-zzzz', 'uploaded-orders-api-aaaa']]);
  // No primary in the catalogue, a member link that is a live aggregate: today's fallback, named so.
  const agg = packForService(memberOnly, catalog, { isLiveAggregatePack });
  assert.deepEqual([agg.pack.id, agg.how, agg.primaries], ['uploaded-live-agg-1111', 'aggregate', []]);
  // A member link that is NOT an aggregate is never this service's pack.
  assert.deepEqual(packForService(memberOnly, catalog, { isLiveAggregatePack: () => false }).how, 'none');
  assert.deepEqual(packForService(bare, catalog, { isLiveAggregatePack }), { pack: null, how: 'none', primaries: [] });
  // A failed catalogue entry (ok: false) is never picked.
  assert.equal(packForService(orders, catalog.map((p) => (p.id === 'uploaded-orders-api-aaaa' ? { ...p, ok: false } : p)), { isLiveAggregatePack }).pack.id, 'uploaded-orders-api-zzzz');
});

test('three entry points, one pack: the record (card, page, selector) and the derived tile share newestPack()', () => {
  // The derived tile's candidates: every catalogue pack naming the key (app.mjs enterServiceWorkspace), declared = not an aggregate.
  const matches = catalog.filter((p) => p.ok && (p.id.includes('orders-api') || (p.services || []).includes('orders-api')));
  const tile = newestPack(matches, (p) => !isLiveAggregatePack(p));
  const record = packForService(orders, catalog, { isLiveAggregatePack });
  const page = buildServicePageModel({ service: orders, envName: 'prod', catalog, isLiveAggregatePack }).panel.pack;
  const card = serviceCardModel(orders, { catalog, isLiveAggregatePack }).envs[0].key.split('::')[0];
  assert.equal(tile.pack.id, record.pack.id);
  assert.equal(page.id, record.pack.id);
  assert.equal(card, record.pack.id);
  const aggregates = matches.filter(isLiveAggregatePack);
  assert.deepEqual(newestPack(aggregates, (p) => !isLiveAggregatePack(p)), { pack: aggregates[0], how: 'aggregate' }, 'only an aggregate left: the fallback, named so');
  assert.deepEqual(newestPack([], () => true), { pack: null, how: 'none' });
});

// ---------- the card ----------

test('serviceCardModel: tier, owners, packs, one verdict per environment through the resolver, the opened line per org, the search text', () => {
  const verdicts = { 'uploaded-orders-api-aaaa::prod': report(), 'uploaded-orders-api-aaaa::dev': report({ environment: 'dev' }) };
  const opened = { 'orders-api': new Date(NOW - 2 * 86400e3).toISOString() };
  const card = serviceCardModel(orders, { verdicts, opened, now: NOW, catalog, isLiveAggregatePack });
  assert.deepEqual([card.id, card.slug, card.name, card.tierText, card.ownersText, card.packsText, card.openedText],
    [1, 'orders-api', 'Orders API', 'tier-2', 'team-orders, sre-platform', '3 packs', 'Opened 2 days ago']);
  assert.deepEqual(card.envs.map((e) => [e.name, e.verdict.state]), [['prod', 'pass'], ['staging', 'loading'], ['dev', 'base']], 'dev is not declared by the newest primary: its report is a base grade; staging awaits its report');
  assert.equal(card.envs[2].verdict.text, 'Base grade (no dev overlay in the pack) · 92% · tier-2 (service)');
  assert.equal(serviceCardModel(orders, { catalog, isLiveAggregatePack }).envs[2].verdict.state, 'loading', 'before the report: loading, not a guessed grade');
  assert.ok(card.envs.every((e) => e.verdict.fetch), 'every environment of a primary-backed service fetches');
  assert.match(card.search, /orders api orders-api team-orders sre-platform prod staging dev tier-2/);
  const empty = serviceCardModel(bare, { catalog, isLiveAggregatePack });
  assert.deepEqual([empty.tierText, empty.ownersText, empty.packsText, empty.openedText, empty.envs], [TIER_BY_PACK, 'no owners yet', 'no pack yet', '', []]);
  // A member-only service: no fetch key for any environment (mutation check 8).
  const agg = serviceCardModel(memberOnly, { catalog, isLiveAggregatePack });
  assert.deepEqual(agg.envs.map((e) => [e.verdict.state, e.verdict.fetch]), [['none', false]]);
  // The recents map is keyed by slug; a prototype key reads as never opened.
  assert.equal(serviceCardModel({ ...bare, slug: 'constructor' }, { opened: {}, now: NOW }).openedText, '');
  assert.deepEqual([agoText(new Date(NOW - 30e3).toISOString(), NOW), agoText(new Date(NOW - 5 * 60e3).toISOString(), NOW), agoText(new Date(NOW - 3600e3).toISOString(), NOW), agoText('nope', NOW)], ['just now', '5 minutes ago', '1 hour ago', '']);
});

// ---------- the home ----------

test('buildServicesHomeModel: the table ordered by recent then name; empty states by rank; the derived fallbacks; catalogue packs apart', () => {
  const operator = { posture: 'identity', role: 'operator', rank: 1, canWrite: true, reason: null, orgName: 'Acme' };
  const viewer = { posture: 'identity', role: 'viewer', rank: 0, canWrite: false, reason: 'needs the operator role in Acme — yours is viewer', orgName: 'Acme' };
  const ok = { kind: 'ok', error: null };
  const opened = { ledger: '2026-10-01T00:00:00.000Z' };
  const table = buildServicesHomeModel({ status: ok, services: [orders, bare, memberOnly], catalog, opened, access: operator, orgName: 'Acme', now: NOW, isLiveAggregatePack });
  assert.equal(table.kind, 'table');
  assert.equal(table.heading, 'Recent services');
  assert.deepEqual(table.cards.map((c) => c.slug), ['ledger', 'billing', 'orders-api'], 'the opened one first, then by name');
  assert.deepEqual(table.catalogue, [{ id: 'payment-service', label: 'payment-service', tier: 'tier-1', version: '1.4' }], 'catalogue packs are listed apart, never as cards');
  assert.deepEqual([table.build, table.sources], [{ enabled: true, reason: null }, { enabled: true, reason: null }]);
  assert.equal(buildServicesHomeModel({ status: ok, services: [orders], opened: {} }).heading, 'Your services', 'an org never visited');
  // Empty, operator: Build is the door.
  const emptyOp = buildServicesHomeModel({ status: ok, services: [], access: operator, orgName: 'Acme' });
  assert.equal(emptyOp.kind, 'empty');
  assert.deepEqual(emptyOp.empty, { title: 'No services in Acme yet.', body: 'Build a pack — Define · Compile · Verify — or import one below; registering it writes the service row.', primary: 'build' });
  // Empty, viewer: the door is an operator's; Build and the three sources are disabled with the reason.
  const emptyV = buildServicesHomeModel({ status: ok, services: [], access: viewer, orgName: 'Acme' });
  assert.equal(emptyV.empty.body, 'An operator registers the first pack (Build, a scan, a draft or an upload) — your role in Acme is viewer. You can read the catalogue packs below.');
  assert.equal(emptyV.empty.primary, 'catalogue');
  assert.ok(!/\byou (scan|upload|build)\b/i.test(emptyV.empty.body), 'a viewer is never told to scan, upload or Build');
  assert.deepEqual(emptyV.build, { enabled: false, reason: viewer.reason });
  assert.deepEqual(emptyV.sources, { enabled: false, reason: viewer.reason });
  assert.equal(buildServicesHomeModel({ status: ok, services: [], access: operator }).empty.title, 'No services in this organisation yet.', 'orgName unknown → no blank');
  // The bundle (501 → static): today's derived tiles, no notice, no error line.
  const derived = [{ key: 'payment-service', label: 'payment service', packCount: 1, liveCount: 0, environments: ['prod'], tiers: [] }];
  const stat = buildServicesHomeModel({ status: { kind: 'static', error: null }, services: null, derived, access: { posture: 'static', canWrite: true, reason: null } });
  assert.deepEqual([stat.kind, stat.derived, stat.error, stat.cards], ['derived', derived, null, []]);
  // Any other failure: the derived tiles plus the status line with the parsed refusal.
  const err = buildServicesHomeModel({ status: { kind: 'error', error: '500: boom' }, services: null, derived });
  assert.deepEqual([err.kind, err.derived, err.error], ['error', derived, 'The services table could not be read — 500: boom. Showing the services the loaded packs name.']);
  // Examples not in the catalogue join the catalogue list; an uploaded pack never does.
  const withExamples = buildServicesHomeModel({ status: ok, services: [orders], catalog, examples: [{ id: 'ex-1', label: 'Example', version: '1.0' }, { id: 'payment-service', label: 'dup' }] });
  assert.deepEqual(withExamples.catalogue.map((c) => c.id), ['payment-service', 'ex-1']);
});

// ---------- the page ----------

test('buildServicePageModel: tabs, the selected panel (verdict, endpoint as name and origin only, tier line, bindings, http(s) links), the actions, Packs linked with the current one', () => {
  const verdicts = { 'uploaded-orders-api-aaaa::prod': report(), 'uploaded-orders-api-aaaa::dev': report({ environment: 'dev' }) };
  const operator = { posture: 'identity', role: 'operator', rank: 1, canWrite: true, reason: null, orgName: 'Acme' };
  // The endpoint object carries a URL with a secret in the fixture (mutation check 3): the model never reads it.
  const withUrl = { ...orders, environments: orders.environments.map((e) => (e.mcpEndpoint ? { ...e, mcpEndpoint: { ...e.mcpEndpoint, url: 'https://x/secret?token=1' } } : e)) };
  const m = buildServicePageModel({ service: withUrl, envName: 'prod', verdicts, catalog, access: operator, orgName: 'Acme', isLiveAggregatePack });
  assert.deepEqual([m.id, m.slug, m.name, m.description], [1, 'orders-api', 'Orders API', 'Order intake and payment hand-off']);
  assert.deepEqual(m.facts, { tierText: 'tier-2', ownersText: 'team-orders, sre-platform', packsText: '3 packs' });
  assert.deepEqual(m.tabs, [{ id: 11, name: 'prod', selected: true }, { id: 12, name: 'staging', selected: false }, { id: 13, name: 'dev', selected: false }]);
  assert.equal(m.panel.env.id, 11);
  assert.equal(m.panel.verdict.text, 'Conformant · 92% · tier-2 (service)');
  assert.deepEqual(m.panel.mcp, { kind: 'bound', name: 'prod-grafana-mcp', origin: 'https://mcp.example' }, 'the safe form only — never the URL');
  assert.equal(m.panel.tierLine, "tier-2 — the service's (no environment override)");
  assert.deepEqual(m.panel.bindings, [['cluster', 'eks-eu-1'], ['namespace', 'orders']]);
  assert.deepEqual(m.panel.links, [['dashboard', 'https://grafana.example/d/orders'], ['runbook', 'https://wiki.example/orders']], 'the javascript: fixture is dropped');
  assert.deepEqual(m.panel.pack, { id: 'uploaded-orders-api-aaaa', label: 'Orders API (library)', version: '1.4', source: 'library', how: 'primary' });
  assert.deepEqual(m.actions.map((a) => [a.view, a.label, a.enabled]), [['layers', 'Discover', true], ['compare', 'Diagnose', true], ['compile', 'Remediate', true], ['build', 'Build a pack for prod', true]]);
  assert.deepEqual(m.packs.map((p) => [p.id, p.role, p.current]), [['uploaded-orders-api-aaaa', 'primary', true], ['uploaded-orders-api-zzzz', 'primary', false], ['uploaded-live-agg-1111', 'member', false]], 'current marks the newest primary, not the first by id');
  assert.equal(m.canEdit, true);
  assert.equal(m.noEnvironments, null);
  // A tab the pack does not declare: the base grade; an environment with its own tier; the unbound endpoint names the way out.
  const staging = buildServicePageModel({ service: { ...orders, environments: orders.environments.map((e) => (e.name === 'dev' ? { ...e, tier: 'tier-1' } : e)) }, envName: 'dev', verdicts, catalog, access: operator, isLiveAggregatePack });
  assert.equal(staging.panel.verdict.state, 'base');
  assert.equal(staging.panel.tierLine, "tier-1 — this environment's override (the service says tier-2)");
  assert.equal(staging.panel.mcp.kind, 'none');
  assert.match(staging.panel.mcp.text, /^No MCP endpoint bound to dev — Diagnose compares .* PATCH \/api\/environments\/13 \{ "mcpEndpointId": <n> \} — GET \/api\/mcp-endpoints lists them\.$/);
  assert.deepEqual([staging.panel.bindings, staging.panel.links], [[], []]);
  // An unknown env name falls back to the first tab.
  assert.equal(buildServicePageModel({ service: orders, envName: 'nope', catalog, isLiveAggregatePack }).tabs[0].selected, true);
  // A viewer: no Edit, Build disabled with the reason, Discover · Diagnose · Remediate usable.
  const viewer = { posture: 'identity', role: 'viewer', rank: 0, canWrite: false, reason: 'needs the operator role in Acme — yours is viewer', orgName: 'Acme' };
  const v = buildServicePageModel({ service: orders, envName: 'prod', catalog, access: viewer, orgName: 'Acme', isLiveAggregatePack });
  assert.equal(v.canEdit, false);
  assert.deepEqual(v.actions.map((a) => [a.enabled, a.reason]), [[true, null], [true, null], [true, null], [false, viewer.reason]]);
  // No environments: the two rank-worded texts; the actions row is drawn with the service only.
  const none = buildServicePageModel({ service: bare, access: operator, orgName: 'Acme' });
  assert.deepEqual(none.tabs, []);
  assert.equal(none.panel.env, null);
  assert.equal(none.panel.verdict, null);
  assert.deepEqual(none.noEnvironments, { text: 'No environments yet. Register a pack that declares one — Build (its DEFINE environment becomes a row), a scan, a draft or an upload — and it appears here.', apiLine: 'POST /api/services/2/environments { "name": "prod" }' });
  assert.equal(none.actions[3].label, 'Build a pack');
  assert.equal(none.panel.tierLine, `${TIER_BY_PACK} — neither the service nor the environment sets a tier`);
  const noneV = buildServicePageModel({ service: bare, access: viewer, orgName: 'Acme' });
  assert.deepEqual(noneV.noEnvironments, { text: 'No environments yet. An operator registers a pack that declares one (Build, a scan, a draft or an upload) — your role in Acme is viewer.', apiLine: null });
  // One environment, member pack only: the aggregate row is current and the verdict says so without a fetch.
  const one = buildServicePageModel({ service: memberOnly, catalog, isLiveAggregatePack });
  assert.deepEqual([one.panel.pack.how, one.panel.verdict.state, one.panel.verdict.fetch, one.packs[0].current], ['aggregate', 'none', false, true]);
});

// ---------- the selector ----------

test('servicesSelectModel: records by name, own derived keys apart, never the examples\' services; the open catalogue pack kept as one option', () => {
  const ownDerived = [{ key: 'orders-api', label: 'orders api' }, { key: 'orphan', label: 'orphan' }];
  const m = servicesSelectModel([orders, bare], ownDerived, 'orders-api');
  assert.deepEqual(m.options, [{ value: 'ledger', label: 'Ledger', serviceId: 2, hasPack: false }, { value: 'orders-api', label: 'Orders API', serviceId: 1, hasPack: true }]);
  assert.deepEqual(m.extra, [{ value: 'orphan', label: 'orphan' }], 'a derived key no record covers');
  assert.deepEqual([m.disabled, m.value], [false, 'orders-api']);
  // An examples-only derived set — the controller passes ownOnly, so nothing reaches here: the extra group is empty (A-M5).
  assert.deepEqual(servicesSelectModel([orders], [], 'orders-api').extra, []);
  // The open example's service, matching no record, is the one "(catalogue pack)" option.
  const cur = servicesSelectModel([orders], [], 'payment-service', { current: 'payment-service' });
  assert.deepEqual(cur.extra, [{ value: 'payment-service', label: 'payment-service (catalogue pack)' }]);
  assert.equal(cur.value, 'payment-service');
  assert.deepEqual(servicesSelectModel([orders], [], null, { current: 'orders-api' }).extra, [], 'a current that is a record adds nothing');
  // The table unavailable: today's list from the own derived services.
  const off = servicesSelectModel(null, ownDerived, 'nope');
  assert.deepEqual(off.options.map((o) => [o.value, o.serviceId, o.hasPack]), [['orders-api', null, true], ['orphan', null, true]]);
  assert.equal(off.value, '', 'a selected key not listed selects nothing');
  assert.deepEqual(servicesSelectModel([], [], null), { options: [], extra: [], disabled: true, value: '' });
});

// ---------- Build's end ----------

test('buildHandoffPlan: tier and owners written only where the row has none; a set tier is never overwritten (the mismatch shown); a row that is not the origin is never patched', () => {
  const build = { name: 'Orders API', owners: 'team-orders, sre', tier: 'tier-2', environment: 'prod' };
  const fresh = { id: 1, slug: 'orders-api', name: 'Orders API', tier: null, owners: [], environments: [{ name: 'prod' }] };
  const p = buildHandoffPlan(build, fresh);
  assert.deepEqual([p.outcome, p.patch, p.mismatch, p.environment], ['written', { tier: 'tier-2', owners: ['team-orders', 'sre'] }, null, 'linked']);
  assert.equal(p.sentence(['owners', 'tier']), ' Service Orders API written: tier-2, owners team-orders, sre.');
  assert.equal(p.sentence([]), ' Service Orders API linked.', 'the server said nothing changed');
  // The row has a tier a person set: no patch, the mismatch is shown (mutation check 2).
  const set = buildHandoffPlan(build, { ...fresh, tier: 'tier-1', owners: ['team-pay'] });
  assert.deepEqual([set.outcome, set.patch, set.mismatch], ['mismatch', {}, { record: 'tier-1', built: 'tier-2' }]);
  assert.equal(set.sentence(), ' Service Orders API linked — it already says tier-1 (its tier grades the pack; the pack was built at tier-2).');
  // Owners both ways: a row with owners keeps them; a draft without owners writes none.
  assert.deepEqual(buildHandoffPlan(build, { ...fresh, tier: 'tier-2', owners: ['team-pay'] }).outcome, 'linked');
  assert.deepEqual(buildHandoffPlan({ ...build, owners: '' }, fresh).patch, { tier: 'tier-2' });
  assert.deepEqual(buildHandoffPlan({ ...build, tier: null }, fresh).patch, { owners: ['team-orders', 'sre'] });
  // The environment the draft names is not a row of the service: said, not fixed.
  const missing = buildHandoffPlan({ ...build, environment: 'staging' }, fresh);
  assert.equal(missing.environment, 'missing');
  assert.match(missing.sentence(['tier']), / The environment staging was not declared by the pack — add it on the service page \(6b\)\.$/);
  // No row (an aggregate with no primary).
  const noRow = buildHandoffPlan(build, null);
  assert.deepEqual([noRow.outcome, noRow.row, noRow.patch, noRow.environment], ['no-row', null, {}, 'none']);
  assert.equal(noRow.sentence(), ' No service row was written (the pack has no primary service).');
  // The table did not refresh: the pack IS registered, the row was not checked.
  const unchecked = buildHandoffPlan(build, fresh, { tableRead: false });
  assert.deepEqual([unchecked.outcome, unchecked.row, unchecked.patch], ['unchecked', null, {}]);
  assert.equal(unchecked.sentence(), ' The service row was not checked (the table did not refresh).');
  // Build was opened from record 1 but the register landed on another row (renamed record / explicit slug): nothing patched there (A-B2, mutation check 2b).
  const other = buildHandoffPlan(build, { id: 9, slug: 'payments-platform', name: 'Payments Platform', tier: null, owners: [], environments: [] }, { origin: { id: 1, name: 'Payments Platform', slug: 'payment-service' } });
  assert.deepEqual([other.outcome, other.patch, other.environment], ['other-service', {}, 'missing']);
  assert.equal(other.sentence(), " Registered under a new service payments-platform — Payments Platform (payment-service) was not linked: the pack's service name yields another slug, and a slug is fixed. Open Payments Platform to compare. The environment prod was not declared by the pack — add it on the service page (6b).");
  assert.equal(buildHandoffPlan(build, { ...fresh, id: 9 }, { originId: 1 }).outcome, 'other-service', 'originId alone serves');
  assert.equal(buildHandoffPlan(build, fresh, { originId: 1 }).outcome, 'written', 'the origin row itself is written');
});

test('buildDefineOriginNote: nothing when the name yields the slug; the sentence with the one-click fix when the origin name still does; without it otherwise', () => {
  const origin = { id: 1, name: 'payment service', slug: 'payment-service' };
  assert.equal(buildDefineOriginNote({ origin, nameKey: 'payment-service', originNameKey: 'payment-service' }), null);
  assert.equal(buildDefineOriginNote({ origin: null, nameKey: 'x' }), null);
  assert.equal(buildDefineOriginNote({ origin, nameKey: '' }), null, 'an empty name has no key yet');
  const note = buildDefineOriginNote({ origin, nameKey: 'payments-platform', originNameKey: 'payment-service' });
  assert.deepEqual(note, { text: 'This pack will register under a new service "payments-platform", not payment-service — a slug is fixed. Keep a name that yields payment-service, or go on and get a second service.', useName: 'payment service' });
  const renamed = buildDefineOriginNote({ origin: { ...origin, name: 'Payments Platform' }, nameKey: 'payments-platform', originNameKey: 'payments-platform' });
  assert.equal(renamed.useName, null, 'a renamed record whose name no longer yields its slug offers no button');
  assert.match(renamed.text, /not payment-service — a slug is fixed/);
});

// ---------- the editor ----------

test('buildServicePatch: only the fields that differ, parsed; never the slug', () => {
  assert.deepEqual(buildServicePatch(orders, { name: 'Orders API', owners: 'team-orders, sre-platform', tier: 'tier-2', description: 'Order intake and payment hand-off' }), {});
  assert.deepEqual(buildServicePatch(orders, { name: ' Orders Platform ', owners: 'team-orders sre-platform billing', tier: TIER_BY_PACK, description: '  ' }),
    { name: 'Orders Platform', owners: ['team-orders', 'sre-platform', 'billing'], tier: null, description: null });
  assert.deepEqual(buildServicePatch(bare, { tier: 'tier-3', owners: [' a ', ''], slug: 'other' }), { tier: 'tier-3', owners: ['a'] });
  assert.deepEqual(buildServicePatch(bare, { tier: 'gold' }), {}, 'an unknown tier reads as null, which the row already is');
  assert.deepEqual(buildServicePatch(bare, {}), {});
  assert.deepEqual(TIERS, ['tier-1', 'tier-2', 'tier-3']);
});

// ---------- the no-org home, the status, the keys ----------

test('buildNoOrgModel: the server\'s sentence as is, the login checked, sign-out the one action', () => {
  const err = Object.assign(new Error('403: no org membership — ask an admin to add you'), { denied: 'org', status: 403 });
  const m = buildNoOrgModel({ identity: me('nora', []), error: err, chromeName: 'Acme Watch' });
  assert.deepEqual([m.title, m.checked, m.body], ['Signed in, but in no organisation yet', '/api/packs as nora', '403: no org membership — ask an admin to add you']);
  assert.equal(m.hint, 'Acme Watch has no member screen yet (Settings is slice 6b); an admin adds you with POST /api/org/members.');
  assert.deepEqual(m.actions, [{ id: 'sign-out', label: 'Sign out' }]);
  assert.equal(buildNoOrgModel({}).checked, '/api/packs as you');
});

test('servicesStatusOf: a 501 no-backend is static (silent), a 403 org is denied, anything else an error with the text', () => {
  assert.deepEqual(servicesStatusOf(Object.assign(new Error('501: Services needs the server'), { denied: 'no-backend' })), { kind: 'static', error: null });
  assert.deepEqual(servicesStatusOf(Object.assign(new Error('403: no org membership — ask an admin to add you'), { denied: 'org' })), { kind: 'denied', error: '403: no org membership — ask an admin to add you' });
  assert.deepEqual(servicesStatusOf(new Error('500: boom')), { kind: 'error', error: '500: boom' });
  assert.deepEqual(servicesStatusOf(null), { kind: 'error', error: 'no answer' });
});

test('the persisted keys are one login\'s in one org', () => {
  assert.equal(persistedStateKey('vera', 'acme'), 'studioState.v2:vera:acme');
  assert.equal(persistedStateKey(null, null), 'studioState.v2:local:default');
  assert.equal(persistedStateKey('', ''), 'studioState.v2:local:default');
  assert.equal(recentServicesKey('acme'), 'studioRecentServices:acme');
  assert.equal(recentServicesKey(null), 'studioRecentServices:default');
});

// ---------- the loaders ----------

test('servicesRefusal: the three real bodies read as the server\'s sentence — never a raw body', () => {
  const org = servicesRefusal(403, { ok: false, error: 'no org membership — ask an admin to add you', denied: 'org' });
  assert.deepEqual([org.message, org.denied, org.status], ['403: no org membership — ask an admin to add you', 'org', 403]);
  const noService = servicesRefusal(404, JSON.stringify({ ok: false, error: WAYS.noService(9) }));
  assert.equal(noService.message, '404: no service 9');
  assert.equal(noService.denied, undefined);
  assert.equal(noService.status, 404);
  assert.equal(servicesRefusal(404, { error: 'unknown pack: x' }).message, '404: unknown pack: x');
  const tier = servicesRefusal(400, { ok: false, error: WAYS.tier('x') });
  assert.equal(tier.message, '400: a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not "x"');
  assert.ok(!tier.message.includes('{'));
  assert.equal(servicesRefusal(500, '<html>oops</html>').message, '500: no answer');
  assert.equal(servicesRefusal(502, null).message, '502: no answer');
  const bundle = servicesRefusal(501, { ok: false, denied: 'no-backend', error: 'Services needs the Observogram server; this studio is a static bundle built without one.' });
  assert.equal(bundle.denied, 'no-backend');
});

test('the loaders call the one path each with the fetch they are given and return the shape the models take', async () => {
  const calls = [];
  const fetchFn = async (path, opts) => { calls.push([path, opts]); return { ok: true, orgs: [ACME], active: 'acme', services: [orders], service: orders, changed: ['tier'], conformant: true }; };
  assert.deepEqual((await loadOrgs({ fetchFn })).active, 'acme');
  assert.deepEqual(await loadServices({ fetchFn }), [orders]);
  assert.equal((await loadService(1, { fetchFn })).slug, 'orders-api');
  assert.equal((await loadVerdict('uploaded-orders-api-aaaa', 'pre prod', { fetchFn })).conformant, true);
  assert.deepEqual(await patchService(1, { tier: 'tier-1' }, { fetchFn }), { service: orders, changed: ['tier'] });
  assert.deepEqual(calls.map(([p]) => p), ['/api/orgs', '/api/services', '/api/services/1', '/api/packs/uploaded-orders-api-aaaa/conformance?env=pre%20prod', '/api/services/1']);
  assert.deepEqual(calls[4][1], { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"tier":"tier-1"}' });
  assert.deepEqual(await loadServices({ fetchFn: async () => ({}) }), [], 'no services key → none');
  assert.equal(await loadService(1, { fetchFn: async () => ({}) }), null);
  assert.deepEqual(await patchService(1, {}, { fetchFn: async () => ({}) }), { service: null, changed: [] });
  await assert.rejects(loadService(9, { fetchFn: async () => { throw servicesRefusal(404, { ok: false, error: 'no service 9' }); } }), { message: '404: no service 9' });
});

test('verdictLoader: at most `concurrency` reports in flight, one promise per (pack, env), the pool drains', async () => {
  const pending = [];
  const fetchFn = (path) => new Promise((resolve, reject) => { pending.push({ path, resolve, reject }); });
  const pool = verdictLoader({ fetchFn, concurrency: 2 });
  const a = pool.load('p1', 'prod'), b = pool.load('p2', 'prod'), c = pool.load('p3', 'prod'), a2 = pool.load('p1', 'prod');
  assert.equal(a, a2, 'the same key shares the in-flight promise');
  assert.equal(pool.pending(), 3);
  await Promise.resolve();
  assert.equal(pending.length, 2, 'two in flight, one queued');
  pending[0].resolve({ conformant: true });
  assert.deepEqual(await a, { conformant: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pending.length, 3, 'the queued one started when a slot freed');
  assert.equal(pending[2].path, '/api/packs/p3/conformance?env=prod');
  pending[1].reject(servicesRefusal(404, { error: 'unknown pack: p2' }));
  await assert.rejects(b, { message: '404: unknown pack: p2' });
  pending[2].resolve({ conformant: false });
  assert.deepEqual(await c, { conformant: false });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pool.pending(), 0);
});
