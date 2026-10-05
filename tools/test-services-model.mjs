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
  serviceChipModel, discoverEmptyNote, buildPrefillFromService, buildServiceEditorModel, serviceSaveStatus,
} from '../studio/services-model.mjs';
import { servicesRefusal, loadOrgs, loadServices, loadService, loadVerdict, patchService, verdictLoader } from '../studio/services-api.mjs';
import { WAYS } from '../server/service-admin.mjs';
import { persistence, state, defaultBuildState, BUILD_PERSIST_FIELDS } from '../studio/state.mjs';
import { renderNoOrgHome, renderServicesHome, renderServicePage, renderServiceEditor, paintServiceEditorStatus, wireServiceTabs, markUnavailable } from '../studio/services-view.mjs';
import { readFileSync } from 'node:fs';

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
  assert.deepEqual([stat.kind, stat.derived, stat.error, stat.cards], ['derived', [{ ...derived[0], openedAt: null }], null, []]);
  assert.deepEqual([stat.build, stat.sources], [{ enabled: true, reason: null }, { enabled: true, reason: null }], 'a bundle draws every affordance');
  // Any other failure: the derived tiles plus the status line with the parsed refusal.
  const err = buildServicesHomeModel({ status: { kind: 'error', error: '500: boom' }, services: null, derived });
  assert.deepEqual([err.kind, err.derived.map((d) => d.key), err.error], ['error', ['payment-service'], 'The services table could not be read — 500: boom. Showing the services the loaded packs name.']);
  // The derived tiles are ordered as the cards are: most recently opened first, then by label, each with its openedAt.
  const two = [{ key: 'zeta', label: 'zeta' }, { key: 'alpha', label: 'alpha' }, { key: 'mid', label: 'mid' }];
  const ordered = buildServicesHomeModel({ status: { kind: 'static', error: null }, derived: two, opened: { zeta: '2026-10-01T00:00:00.000Z' } }).derived;
  assert.deepEqual(ordered.map((d) => [d.key, d.openedAt]), [['zeta', '2026-10-01T00:00:00.000Z'], ['alpha', null], ['mid', null]]);
  // The loading state (before GET /api/services answered) is the derived kind too, with nothing said.
  assert.deepEqual(buildServicesHomeModel({ derived }).kind, 'derived');
  // Every environment on a card names the pack its verdict is fetched from.
  assert.deepEqual(table.cards.find((c) => c.slug === 'orders-api').envs.map((e) => e.packId), ['uploaded-orders-api-aaaa', 'uploaded-orders-api-aaaa', 'uploaded-orders-api-aaaa']);
  assert.deepEqual(table.cards.find((c) => c.slug === 'ledger').envs, []);
  // Examples not in the catalogue join the catalogue list; an uploaded pack never does.
  const withExamples = buildServicesHomeModel({ status: ok, services: [orders], catalog, examples: [{ id: 'ex-1', label: 'Example', version: '1.0' }, { id: 'payment-service', label: 'dup' }] });
  assert.deepEqual(withExamples.catalogue.map((c) => c.id), ['payment-service', 'ex-1']);
});

test('buildServicesHomeModel: a registered pack whose service row was deleted stays reachable — its derived tile beside the cards, or under an empty sentence that says so, never "No services"', () => {
  const operator = { posture: 'identity', role: 'operator', rank: 1, canWrite: true, reason: null, orgName: 'Acme' };
  const viewer = { posture: 'identity', role: 'viewer', rank: 0, canWrite: false, reason: 'needs the operator role in Acme — yours is viewer', orgName: 'Acme' };
  const ok = { kind: 'ok', error: null };
  // serviceCatalogue({ ownOnly: true }): the orphan's key, and the keys the records cover.
  const orphan = { key: 'orphan-svc', label: 'orphan svc', packCount: 1, liveCount: 0, environments: ['prod'], tiers: [] };
  const derived = [orphan, { key: 'orders-api', label: 'Orders API', packCount: 2, liveCount: 1, environments: ['prod', 'staging'], tiers: [] }, { key: 'billing', label: 'Billing', packCount: 0, liveCount: 1, environments: [], tiers: [] }];
  // With records: the cards, then only the uncovered key as a tile (the selector's "from packs only" rule).
  const table = buildServicesHomeModel({ status: ok, services: [orders, memberOnly], catalog, derived, access: operator, orgName: 'Acme', now: NOW, isLiveAggregatePack });
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.cards.map((c) => c.slug), ['billing', 'orders-api']);
  assert.deepEqual(table.derived, [{ ...orphan, openedAt: null }], 'a covered key is a card, never a tile too');
  // No records at all: the orphan is the only service here — the sentence is true and names the way back.
  const emptyOp = buildServicesHomeModel({ status: ok, services: [], catalog, derived: [orphan], access: operator, orgName: 'Acme' });
  assert.equal(emptyOp.kind, 'empty');
  assert.deepEqual(emptyOp.derived, [{ ...orphan, openedAt: null }]);
  assert.deepEqual(emptyOp.empty, { title: 'No service records in Acme yet.', body: 'The registered packs name 1 service without a row — a tile below opens the pack; registering a pack again (Build, a scan, a draft or an upload) writes the row.', primary: 'build' });
  const emptyV = buildServicesHomeModel({ status: ok, services: [], catalog, derived: [orphan, { key: 'other', label: 'other', packCount: 1, liveCount: 0, environments: [], tiers: [] }], access: viewer, orgName: 'Acme' });
  assert.equal(emptyV.empty.body, 'The registered packs name 2 services without a row — a tile below opens the pack; an operator registers a pack again to write the row — your role in Acme is viewer.');
  assert.equal(emptyV.empty.primary, 'catalogue');
  assert.ok(!/\byou (scan|upload|build|register)\b/i.test(emptyV.empty.body), 'a viewer is never told to register');
  // The sentence that says "No services" is kept for a truly empty org (no own derived service either).
  assert.equal(buildServicesHomeModel({ status: ok, services: [], catalog, derived: [], access: operator, orgName: 'Acme' }).empty.title, 'No services in Acme yet.');
  // The orphan tiles are ordered as the fallback tiles are: most recently opened first.
  const two = buildServicesHomeModel({ status: ok, services: [bare], derived: [{ key: 'zeta', label: 'zeta' }, { key: 'alpha', label: 'alpha' }], opened: { zeta: '2026-10-01T00:00:00.000Z' } }).derived;
  assert.deepEqual(two.map((d) => d.key), ['zeta', 'alpha']);
});

// ---------- the page ----------

test('buildServicePageModel: tabs, the selected panel (verdict, endpoint as name and origin only, tier line, bindings, http(s) links), the actions, Packs linked with the current one', () => {
  const verdicts = { 'uploaded-orders-api-aaaa::prod': report(), 'uploaded-orders-api-aaaa::dev': report({ environment: 'dev' }) };
  const operator = { posture: 'identity', role: 'operator', rank: 1, canWrite: true, reason: null, orgName: 'Acme' };
  // The endpoint object carries a URL with a secret in the fixture (mutation check 3): the model never reads it.
  const withUrl = { ...orders, environments: orders.environments.map((e) => (e.mcpEndpoint ? { ...e, mcpEndpoint: { ...e.mcpEndpoint, url: 'https://x/secret?token=1' } } : e)) };
  const m = buildServicePageModel({ service: withUrl, envName: 'prod', verdicts, catalog, access: operator, orgName: 'Acme', isLiveAggregatePack });
  assert.deepEqual([m.id, m.slug, m.name, m.description], [1, 'orders-api', 'Orders API', 'Order intake and payment hand-off']);
  assert.deepEqual(m.facts, { tierText: 'tier-2 (service)', ownersText: 'team-orders, sre-platform', packsText: '3 packs' });
  assert.deepEqual(m.tabs, [{ id: 11, name: 'prod', selected: true }, { id: 12, name: 'staging', selected: false }, { id: 13, name: 'dev', selected: false }]);
  assert.equal(m.panel.env.id, 11);
  assert.equal(m.panel.verdict.text, 'Conformant · 92% · tier-2 (service)');
  assert.deepEqual(m.panel.mcp, { kind: 'bound', name: 'prod-grafana-mcp', origin: 'https://mcp.example' }, 'the safe form only — never the URL');
  assert.equal(m.panel.tierLine, "tier-2 — the service's (no environment override)");
  assert.deepEqual(m.panel.bindings, [['cluster', 'eks-eu-1'], ['namespace', 'orders']]);
  assert.deepEqual(m.panel.links, [['dashboard', 'https://grafana.example/d/orders'], ['runbook', 'https://wiki.example/orders']], 'the javascript: fixture is dropped');
  assert.deepEqual(m.panel.pack, { id: 'uploaded-orders-api-aaaa', label: 'Orders API (library)', version: '1.4', source: 'library', how: 'primary' });
  assert.deepEqual(m.actions.map((a) => [a.view, a.label, a.enabled]), [['layers', 'Discover', true], ['compare', 'Diagnose', true], ['compile', 'Remediate', true], ['build', 'Build a pack for prod', true]]);
  assert.deepEqual(m.packs.map((p) => [p.id, p.role, p.current, p.inCatalogue]), [['uploaded-orders-api-aaaa', 'primary', true, true], ['uploaded-orders-api-zzzz', 'primary', false, true], ['uploaded-live-agg-1111', 'member', false, true]], 'current marks the newest primary, not the first by id');
  assert.equal(buildServicePageModel({ service: orders, envName: 'prod', catalog: catalog.slice(2), isLiveAggregatePack }).packs[1].inCatalogue, false, 'a link to a pack no longer in the catalogue is listed, not openable');
  assert.match(m.panel.driftNote, /^Drift runs: Neuron/, 'the verdict is the conformance report only; drift runs are named, not folded in (D3)');
  assert.equal(m.canEdit, true);
  assert.equal(m.noEnvironments, null);
  // A tab the pack does not declare: the base grade; an environment with its own tier; the unbound endpoint names the way out.
  const staging = buildServicePageModel({ service: { ...orders, environments: orders.environments.map((e) => (e.name === 'dev' ? { ...e, tier: 'tier-1' } : e)) }, envName: 'dev', verdicts, catalog, access: operator, isLiveAggregatePack });
  assert.equal(staging.panel.verdict.state, 'base');
  assert.equal(staging.panel.tierLine, "tier-1 — this environment's override (the service says tier-2)");
  assert.equal(staging.panel.mcp.kind, 'none');
  assert.equal(staging.panel.mcp.text, 'No MCP endpoint bound to dev — Diagnose compares with whatever live pack you load as Pack B; an admin binds one with PATCH /api/environments/13 { "mcpEndpointId": <n> } — GET /api/mcp-endpoints lists them.');
  // Product wording, not plan wording: no roadmap slice reference (and no screen that does not exist yet) reaches the service page.
  assert.doesNotMatch(JSON.stringify([staging.panel, staging.noEnvironments, staging.actions]), /slice\s*\d|\b6b\b|Settings/i, 'the service page never names a roadmap slice or an unbuilt screen');
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
  assert.equal(none.facts.tierText, TIER_BY_PACK);
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
  // The table unavailable with an example open: its service is still the one "(catalogue pack)" option, selected.
  const offCur = servicesSelectModel(null, ownDerived, 'payment-service', { current: 'payment-service' });
  assert.deepEqual(offCur.extra, [{ value: 'payment-service', label: 'payment-service (catalogue pack)' }]);
  assert.equal(offCur.value, 'payment-service');
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

test('buildServiceEditorModel: the record\'s values until typed, the tier choices with "graded by the pack" for null, the limits the server applies, the slug note and no slug field; serviceSaveStatus names what changed', () => {
  const m = buildServiceEditorModel(orders);
  assert.deepEqual(m.fields, { name: 'Orders API', owners: 'team-orders, sre-platform', tier: 'tier-2', description: 'Order intake and payment hand-off' });
  assert.deepEqual(m.tiers.map((t) => [t.value, t.label, t.selected]), [['tier-1', 'tier-1', false], ['tier-2', 'tier-2', true], ['tier-3', 'tier-3', false], [null, TIER_BY_PACK, false]]);
  assert.deepEqual(m.limits, { name: 200, owners: 50, description: 4000 }, 'WAYS.serviceName, WAYS.owners, WAYS.description');
  assert.match(WAYS.serviceName, /200/); assert.match(WAYS.owners, /50/); assert.match(WAYS.description, /4000/);
  assert.equal(m.slugNote, 'The slug orders-api stays; packs link to it by slug — a renamed service still receives the packs that name orders-api, and a Build from this page says when its name would land elsewhere.');
  assert.ok(!('slug' in m.fields), 'no slug field: WAYS.slugFixed');
  assert.deepEqual([m.id, m.slug, m.title, m.saving], [1, 'orders-api', 'Edit Orders API', false]);
  assert.deepEqual(m.status, { kind: 'idle', text: 'Name, owners, tier and description. The slug is fixed.' });
  // The draft wins over the record; an unknown tier is "graded by the pack"; a pending status is `saving`.
  const typed = buildServiceEditorModel(orders, { draft: { name: 'Orders Platform', owners: '', tier: 'x', description: '' }, status: { kind: 'pending', text: 'Saving…' } });
  assert.deepEqual(typed.fields, { name: 'Orders Platform', owners: '', tier: null, description: '' });
  assert.equal(typed.tiers.find((t) => t.selected).value, null);
  assert.equal(typed.saving, true);
  // A record without tier, owners or description.
  const bareM = buildServiceEditorModel(bare);
  assert.deepEqual(bareM.fields, { name: bare.name, owners: '', tier: null, description: '' });
  assert.deepEqual(serviceSaveStatus(['owners', 'tier']), { kind: 'saved', text: 'Saved: owners, tier' });
  assert.deepEqual(serviceSaveStatus([]), { kind: 'idle', text: 'Nothing changed.' });
});

test('buildNoOrgModel: the server\'s sentence as is, the login checked, sign-out the one action', () => {
  const err = Object.assign(new Error('403: no org membership — ask an admin to add you'), { denied: 'org', status: 403 });
  const m = buildNoOrgModel({ identity: me('nora', []), error: err, chromeName: 'Acme Watch' });
  assert.deepEqual([m.title, m.checked, m.body], ['Signed in, but in no organisation yet', '/api/packs as nora', '403: no org membership — ask an admin to add you']);
  assert.equal(m.hint, 'Acme Watch has no member screen yet; an admin adds you with POST /api/org/members.');
  // Product wording, not plan wording: no roadmap slice reference reaches a signed-in user.
  assert.doesNotMatch(`${m.title} ${m.body} ${m.hint}`, /slice\s*\d|\b6b\b/i, 'the no-org screen never names a roadmap slice');
  assert.deepEqual(m.actions, [{ id: 'sign-out', label: 'Sign out' }]);
  assert.equal(buildNoOrgModel({}).checked, '/api/packs as you');
});

// A headless container (the tools/test-build-model.mjs stubContainer shape): the markup and the one wired button.
function noOrgContainer() {
  const handlers = {};
  const btn = { addEventListener: (t, fn) => { handlers[t] = fn; }, fire: (t) => handlers[t]?.() };
  return { innerHTML: '', querySelector: (sel) => (sel === '#svc-noorg-sign-out' ? btn : null), btn };
}

test('renderNoOrgHome: the refusal as is and escaped, the login checked, one Sign out button proxied to host.services.signOut; a headless host never throws', () => {
  const err = Object.assign(new Error('403: no org membership — ask <an admin> to add you'), { denied: 'org', status: 403 });
  const m = buildNoOrgModel({ identity: me('nora<img src=x onerror="window.__xss=1">', []), error: err, chromeName: 'Acme Watch' });
  const c = noOrgContainer();
  let signedOut = 0;
  renderNoOrgHome(c, m, { services: { signOut: () => { signedOut++; } } });
  assert.ok(c.innerHTML.includes('<section class="svc-noorg">'), 'the Services zone\'s prefix');
  assert.ok(c.innerHTML.includes('Signed in, but in no organisation yet'));
  assert.ok(c.innerHTML.includes('403: no org membership — ask &lt;an admin&gt; to add you'), 'the server\'s sentence, escaped at the seam');
  assert.ok(c.innerHTML.includes('/api/packs as nora&lt;img') && !c.innerHTML.includes('<img'), 'the login is escaped — nothing from it reaches the page');
  assert.ok(c.innerHTML.includes('Acme Watch has no member screen yet'), 'the hint names the product through chromeName');
  assert.equal((c.innerHTML.match(/<button /g) || []).length, 1, 'one action: Sign out — no fabricated way in');
  assert.ok(c.innerHTML.includes('id="svc-noorg-sign-out"') && c.innerHTML.includes('>Sign out</button>'));
  c.btn.fire('click');
  assert.equal(signedOut, 1, 'the button proxies the account menu\'s sign-out');
  // The headless render with an empty host: the click is a no-op, never a throw.
  const c2 = noOrgContainer();
  renderNoOrgHome(c2, buildNoOrgModel({}), { services: {} });
  assert.doesNotThrow(() => c2.btn.fire('click'));
  assert.ok(c2.innerHTML.includes('/api/packs as you'));
});

// A headless container for the Services home: the markup as a string, and the buttons the renderer wires
// read back from it (class, data-*), so a click can be fired without a DOM.
function homeContainer() {
  let html = '';
  let els = [];
  const fakeEl = (attrs) => {
    const handlers = {};
    return {
      dataset: attrs, hidden: false, value: '',
      addEventListener: (t, fn) => { handlers[t] = fn; }, fire: (t) => handlers[t]?.(),
    };
  };
  const c = {
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      els = [...v.matchAll(/<button type="button" class="([^"]*)"([^>]*)>/g)].map((m) => {
        const attrs = Object.fromEntries([...m[2].matchAll(/data-([\w-]+)="([^"]*)"/g)].map((a) => [a[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), a[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
        const el = fakeEl(attrs);
        el.className = m[1];
        el.id = (m[2].match(/\bid="([^"]+)"/) || [])[1] || null;
        return el;
      });
      if (/id="home-service-search"/.test(v)) { c.search = fakeEl({}); c.search.id = 'home-service-search'; } else c.search = null;
      if (/id="home-service-none"/.test(v)) c.none = { hidden: true }; else c.none = null;
    },
    querySelectorAll: (sel) => els.filter((e) => (sel === '.svc-gate-card' ? /\bsvc-gate-card\b/.test(e.className) : sel === '.home-pick-row' ? /\bhome-pick-row\b/.test(e.className) : false)),
    querySelector: (sel) => {
      if (sel === '#home-services-retry') return els.find((e) => e.id === 'home-services-retry') || null;
      if (sel === '#home-service-search') return c.search;
      if (sel === '#home-service-none') return c.none;
      return null;
    },
    cards: () => els.filter((e) => /\bsvc-gate-card\b/.test(e.className)),
  };
  return c;
}
const OPERATOR = { posture: 'identity', role: 'operator', rank: 1, canWrite: true, reason: null, orgName: 'Acme' };
const VIEWER = { posture: 'identity', role: 'viewer', rank: 0, canWrite: false, reason: 'needs the operator role in Acme — yours is viewer', orgName: 'Acme' };

test('renderServicesHome: the table — one record card per row with tier, owners, packs, the verdict per environment, escaped at the seam; a card opens the service; the catalogue packs apart; the search filters', () => {
  const xss = { ...orders, name: 'Orders<img src=x onerror="window.__xss=1">', owners: ['team-<b>x</b>'] };
  const verdicts = { 'uploaded-orders-api-aaaa::prod': report({ tier: { ...report().tier, mismatch: true, pack: 'tier-3' } }), 'uploaded-orders-api-aaaa::dev': { error: '404: unknown pack: {x}' } };
  const m = buildServicesHomeModel({ status: { kind: 'ok', error: null }, services: [xss, bare, memberOnly], catalog, verdicts, opened: { ledger: '2026-10-05T11:00:00.000Z' }, access: OPERATOR, orgName: 'Acme', now: NOW, isLiveAggregatePack });
  const c = homeContainer();
  const calls = [];
  renderServicesHome(c, m, { services: { openService: (id, slug) => calls.push(['service', id, slug]), openPack: (id) => calls.push(['pack', id]), openDerived: (k) => calls.push(['derived', k]) } });
  const html = c.innerHTML;
  assert.ok(html.includes('id="svc-gate-which">Recent services</h2>') && html.includes('id="home-service-search"') && html.includes('id="home-service-grid"'), 'the heading, the search and the grid T7 and the glossary suite know');
  assert.equal(c.cards().length, 3, 'one card per record');
  assert.ok(c.cards().every((e) => /\bsvc-card\b/.test(e.className)), 'a record card carries .svc-card beside the tile class');
  assert.deepEqual(c.cards().map((e) => [e.dataset.service, e.dataset.serviceId]), [['ledger', '2'], ['billing', '3'], ['orders-api', '1']], 'the opened one first, then by name; the slug is the selector, the id the record');
  assert.ok(html.includes('aria-describedby="svc-card-1-meta"') && html.includes('id="svc-card-1-meta">tier-2 · team-&lt;b&gt;x&lt;/b&gt; · 3 packs</span>'), 'the meta line describes the card; owners are escaped');
  assert.ok(html.includes('Orders&lt;img src=x onerror=') && !html.includes('<img'), 'the name is escaped — nothing from it reaches the page');
  assert.ok(html.includes('<span class="svc-card-slug">orders-api</span>'));
  assert.ok(html.includes('id="svc-card-2-meta">graded by the pack · no owners yet · no pack yet</span>'), 'a bare record says what it lacks, never a zero');
  assert.ok(html.includes('<li class="svc-env svc-env-none">no environments yet</li>'));
  // The pills: pass with the mismatch detail, loading with aria-busy on the list, an error with the parsed refusal in its title, a member-only service with no fetch.
  assert.ok(html.includes('<span class="svc-verdict is-pass is-mismatch">Conformant · 92% · tier-2 (service) <small class="svc-verdict-detail">· pack says tier-3</small></span>'));
  assert.ok(html.includes('<span class="svc-verdict is-loading">Loading…</span>') && html.includes('aria-label="Environments" aria-busy="true"'), 'staging awaits its report');
  assert.ok(html.includes('<span class="svc-verdict is-error" title="404: unknown pack: {x}">Unavailable</span>'), 'a failed report reads Unavailable with the parsed text in its title');
  assert.ok(html.includes('<span class="svc-verdict is-none">Member pack only — open it under Packs linked</span>'));
  assert.ok(html.includes('<span class="svc-gate-activity">Opened 1 hour ago</span>'));
  // The catalogue packs apart, closed, as pick rows — never as cards.
  assert.ok(html.includes('<details class="ux-disclosure svc-catalogue"><summary>Catalogue packs (1)</summary>'), 'closed by default');
  assert.ok(html.includes('data-pack-id="payment-service"') && html.includes('<span class="home-pick-tier">tier-1</span>'));
  assert.ok(!html.includes('data-service="payment-service"'), 'a catalogue pack is not a card');
  assert.ok(!html.includes('home-sources') && !html.includes('svc-status'), 'the sources are the controller\'s; no status line when the table read');
  // The wiring: a card opens the service record, a row the catalogue pack.
  c.cards()[2].fire('click');
  c.querySelectorAll('.home-pick-row')[0].fire('click');
  assert.deepEqual(calls, [['service', 1, 'orders-api'], ['pack', 'payment-service']]);
  // The search filters by the card's search text; the "no match" line shows when nothing matches.
  c.search.value = 'ledger';
  c.search.fire('input');
  assert.deepEqual(c.cards().map((e) => e.hidden), [false, true, true]);
  assert.equal(c.none.hidden, true);
  c.search.value = 'nothing-like-it';
  c.search.fire('input');
  assert.equal(c.none.hidden, false);
  c.search.value = '';
  c.search.fire('input');
  assert.deepEqual(c.cards().map((e) => e.hidden), [false, false, false]);
  // A headless host without the actions never throws.
  const c2 = homeContainer();
  renderServicesHome(c2, m, { services: {} });
  assert.doesNotThrow(() => c2.cards()[0].fire('click'));
});

test('renderServicesHome: the empty states by rank, the derived tiles where the table is unavailable, the status line with Retry on a failed read', () => {
  const ok = { kind: 'ok', error: null };
  const op = homeContainer();
  renderServicesHome(op, buildServicesHomeModel({ status: ok, services: [], catalog, access: OPERATOR, orgName: 'Acme' }), { services: {} });
  assert.ok(op.innerHTML.includes('<p class="home-check-empty">No services in Acme yet. Build a pack — Define · Compile · Verify — or import one below; registering it writes the service row.</p>'));
  assert.ok(op.innerHTML.includes('Catalogue packs (1)'), 'the catalogue packs under the empty state too');
  assert.equal(op.cards().length, 0);
  const v = homeContainer();
  renderServicesHome(v, buildServicesHomeModel({ status: ok, services: [], catalog, access: VIEWER, orgName: 'Acme' }), { services: {} });
  assert.ok(v.innerHTML.includes('No services in Acme yet. An operator registers the first pack (Build, a scan, a draft or an upload) — your role in Acme is viewer. You can read the catalogue packs below.</p>'));
  // The derived tiles (the bundle): today's markup — the tile class and data-service, no .svc-card, no record id, no catalogue list.
  const derived = [{ key: 'payment-service', label: 'payment service', packCount: 1, liveCount: 0, environments: ['prod'], tiers: ['tier-1'] }, { key: 'live-only', label: 'live only', packCount: 0, liveCount: 1, environments: [], tiers: [] }];
  const d = homeContainer();
  const calls = [];
  renderServicesHome(d, buildServicesHomeModel({ status: { kind: 'static', error: null }, derived, catalog, opened: { 'live-only': new Date(NOW - 3600e3).toISOString() } }), { services: { openDerived: (k) => calls.push(k), openService: () => calls.push('wrong') } });
  assert.deepEqual(d.cards().map((e) => [e.dataset.service, e.dataset.serviceId, /\bsvc-card\b/.test(e.className)]), [['live-only', undefined, false], ['payment-service', undefined, false]]);
  assert.ok(d.innerHTML.includes('<span class="svc-gate-meta">prod · 1 pack · tier-1</span>') && d.innerHTML.includes('Not opened here yet') && d.innerHTML.includes('Live draft only — no repository pack to compare with'));
  assert.ok(d.innerHTML.includes('id="svc-gate-which">Recent services</h2>'));
  assert.ok(!d.innerHTML.includes('svc-catalogue') && !d.innerHTML.includes('home-services-status'), 'nothing said in a bundle — its notice already says what needs the server');
  d.cards()[1].fire('click');
  assert.deepEqual(calls, ['payment-service'], 'a derived tile opens the workspace as today');
  // A failed read: the tiles plus the status line with the parsed refusal and a Retry wired to host.services.retry.
  const e = homeContainer();
  let retried = 0;
  renderServicesHome(e, buildServicesHomeModel({ status: { kind: 'error', error: '500: <boom>' }, derived, catalog }), { services: { retry: () => { retried++; } } });
  assert.ok(e.innerHTML.includes('<p class="svc-status" id="home-services-status" role="status">The services table could not be read — 500: &lt;boom&gt;. Showing the services the loaded packs name. <button type="button" class="ux-secondary-btn" id="home-services-retry">Retry</button></p>'));
  e.querySelector('#home-services-retry').fire('click');
  assert.equal(retried, 1);
  assert.equal(e.cards().length, 2);
  // No derived services at all: today's sentence.
  const none = homeContainer();
  renderServicesHome(none, buildServicesHomeModel({ status: { kind: 'static', error: null }, derived: [] }), { services: {} });
  assert.ok(none.innerHTML.includes('<p class="home-check-empty">No services yet. Bring a pack in from one of the sources below.</p>'));
});

test('renderServicesHome: the orphan derived tiles — after the cards in the table, under the sentence when the table is empty — open the workspace; nothing drawn when every key is covered', () => {
  const ok = { kind: 'ok', error: null };
  const orphan = { key: 'orphan-svc', label: 'orphan svc', packCount: 1, liveCount: 0, environments: ['prod'], tiers: ['tier-2'] };
  const calls = [];
  const host = { services: { openDerived: (k) => calls.push(['derived', k]), openService: (id, slug) => calls.push(['record', id, slug]) } };
  const t = homeContainer();
  renderServicesHome(t, buildServicesHomeModel({ status: ok, services: [bare], catalog, derived: [orphan, { key: 'ledger', label: 'Ledger', packCount: 1 }], access: OPERATOR, orgName: 'Acme' }), host);
  assert.deepEqual(t.cards().map((e) => [e.dataset.service, e.dataset.serviceId, /\bsvc-card\b/.test(e.className)]), [['ledger', '2', true], ['orphan-svc', undefined, false]], 'the record card first, the orphan as a tile, the covered key once');
  assert.ok(t.innerHTML.includes('<span class="svc-gate-meta">prod · 1 pack · tier-2</span>'));
  t.cards()[1].fire('click');
  t.cards()[0].fire('click');
  assert.deepEqual(calls, [['derived', 'orphan-svc'], ['record', 2, 'ledger']]);
  const e = homeContainer();
  renderServicesHome(e, buildServicesHomeModel({ status: ok, services: [], catalog, derived: [orphan], access: OPERATOR, orgName: 'Acme' }), host);
  assert.ok(e.innerHTML.includes('<p class="home-check-empty">No service records in Acme yet. The registered packs name 1 service without a row — a tile below opens the pack; registering a pack again (Build, a scan, a draft or an upload) writes the row.</p>'));
  assert.deepEqual(e.cards().map((c) => c.dataset.service), ['orphan-svc'], 'the tile under the sentence');
  assert.ok(e.search, 'the grid with its search');
  assert.ok(e.innerHTML.includes('Catalogue packs (1)'), 'the catalogue packs still apart, after the tiles');
  assert.ok(e.innerHTML.indexOf('home-check-empty') < e.innerHTML.indexOf('svc-gate-grid') && e.innerHTML.indexOf('svc-gate-grid') < e.innerHTML.indexOf('svc-catalogue'));
  const none = homeContainer();
  renderServicesHome(none, buildServicesHomeModel({ status: ok, services: [], catalog, derived: [], access: OPERATOR, orgName: 'Acme' }), host);
  assert.equal(none.cards().length, 0);
  assert.equal(none.search, null, 'no grid when there is nothing to draw in it');
});

test('markUnavailable: aria-disabled (never disabled), .is-unavailable and the reason as one .svc-why — in the control or in the slot beside it; repainting does not repeat it', () => {
  const fakeControl = () => {
    const attrs = {}; const classes = new Set(); let why = null;
    return {
      attrs, classes, disabled: false,
      setAttribute: (k, v) => { attrs[k] = v; }, classList: { add: (c) => classes.add(c) },
      querySelector: (sel) => (sel === '.svc-why' ? why : null),
      insertAdjacentHTML: (where, html) => { assert.equal(where, 'beforeend'); assert.equal(html, '<span class="svc-why"></span>'); why = { textContent: '' }; },
      why: () => why,
    };
  };
  const build = fakeControl();
  markUnavailable(build, VIEWER.reason);
  assert.deepEqual([build.attrs['aria-disabled'], build.disabled, [...build.classes], build.why().textContent], ['true', false, ['is-unavailable'], 'needs the operator role in Acme — yours is viewer']);
  markUnavailable(build, 'needs the operator role — this server takes mutations with its API token only, not from a browser');
  assert.equal(build.why().textContent, 'needs the operator role — this server takes mutations with its API token only, not from a browser', 'the one .svc-why is updated, not doubled');
  const connect = fakeControl(); const slot = fakeControl();
  markUnavailable(connect, VIEWER.reason, { into: slot });
  assert.deepEqual([connect.attrs['aria-disabled'], connect.why(), slot.why().textContent], ['true', null, VIEWER.reason]);
  assert.doesNotThrow(() => markUnavailable(null, 'x'));
});

test('services-view.mjs is a renderer module: it imports host.mjs, util.mjs and ux-kit.mjs only — never app.mjs or state.mjs — and reads no state, fetches nothing', () => {
  const src = readFileSync(new URL('../studio/services-view.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(x => x[1]).sort();
  assert.deepEqual(imports, ['./host.mjs', './util.mjs', './ux-kit.mjs']);
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bfetch\(|\bapi\(|\bstate\./.test(code), 'no fetch, no api(), no state');
  assert.ok(!/Observogram|OBSERVOGRAM/.test(code), 'the brand: no product name literal');
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

// A Storage double for the persistence layer (state.mjs): the studio's
// snapshot is read and written under the scoped key only.
function fakeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()].sort(),
  };
}
const withStorage = (store, fn) => {
  const before = globalThis.localStorage;
  globalThis.localStorage = store;
  try { return fn(); } finally {
    if (before === undefined) delete globalThis.localStorage; else globalThis.localStorage = before;
  }
};

test('persistence.scope keys the snapshot per login and org; the unscoped v1 snapshot is adopted once into the first scoped key it is read under, then removed', () => {
  const v1 = JSON.stringify({ mode: 'build', build: { name: 'Orders API', step: 'define' } });
  const store = fakeStorage({ 'studioState.v1': v1 });
  withStorage(store, () => {
    assert.equal(persistence.key(), 'studioState.v2:local:default', 'before boot scopes it: the open posture\'s key');
    persistence.scope('olive', 'acme');
    assert.equal(persistence.key(), persistedStateKey('olive', 'acme'));
    assert.deepEqual(persistence.read(), JSON.parse(v1), 'the first read under a scoped key adopts the old snapshot');
    assert.deepEqual(store.keys(), ['studioState.v2:olive:acme'], 'the v1 key is removed, the snapshot lives under the scoped key');
    // The same user in another org starts empty: the draft is acme\'s (STORE_PLAN §6.4, C-2).
    persistence.scope('olive', 'bravo');
    assert.equal(persistence.read(), null, 'bravo has no snapshot — the acme draft does not cross the org boundary');
    assert.deepEqual(store.keys(), ['studioState.v2:olive:acme'], 'nothing written by a read');
    // A write lands under the current scope; clear() removes that key only.
    persistence.resume();
    persistence.write();
    persistence.suspend();
    assert.deepEqual(store.keys(), ['studioState.v2:olive:acme', 'studioState.v2:olive:bravo']);
    persistence.clear();
    assert.deepEqual(store.keys(), ['studioState.v2:olive:acme']);
  });
});

test('persistence.forget removes every snapshot of the login and the unscoped one, and no other user\'s', () => {
  const store = fakeStorage({
    'studioState.v1': '{}',
    'studioState.v2:olive:acme': '{}', 'studioState.v2:olive:bravo': '{}',
    'studioState.v2:vera:acme': '{}', 'studioOrg.v1': 'acme', 'mcpUrl.v2:olive:acme': 'https://mcp.example',
  });
  withStorage(store, () => {
    persistence.forget('olive');
    assert.deepEqual(store.keys(), ['mcpUrl.v2:olive:acme', 'studioOrg.v1', 'studioState.v2:vera:acme']);
    persistence.forget(null);
    assert.deepEqual(store.keys(), ['mcpUrl.v2:olive:acme', 'studioOrg.v1', 'studioState.v2:vera:acme'], 'the open posture\'s login is local: nothing of a signed-in user goes');
  });
  // Without a Storage at all (a private window that throws) the calls are no-ops.
  const throwing = new Proxy({}, { get() { throw new Error('SecurityError'); } });
  withStorage(throwing, () => {
    assert.doesNotThrow(() => persistence.forget('olive'));
    assert.equal(persistence.read(), null);
  });
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

// ---------- the service page: the chip, the empty Discover, the Build prefill ----------

test('serviceChipModel: a record → a button back to its page; a derived-only key → today\'s label; nothing active → hidden', () => {
  assert.deepEqual(serviceChipModel({ services: [orders, bare], selected: 'orders-api', derivedLabel: 'orders api' }), { kind: 'record', label: 'Orders API', serviceId: 1 });
  assert.deepEqual(serviceChipModel({ services: [orders], selected: 'payment-service', derivedLabel: 'payment service' }), { kind: 'derived', label: 'payment service', serviceId: null });
  assert.deepEqual(serviceChipModel({ services: null, selected: 'payment-service', derivedLabel: 'payment service' }), { kind: 'derived', label: 'payment service', serviceId: null }, 'the table unavailable: the derived label');
  assert.deepEqual(serviceChipModel({ services: [orders], selected: 'nothing', derivedLabel: null }), { kind: 'none', label: '', serviceId: null });
  assert.deepEqual(serviceChipModel({ services: [orders], selected: null, derivedLabel: 'x' }), { kind: 'none', label: '', serviceId: null });
});

test('discoverEmptyNote: the sentence by rank — an operator is offered Build, a viewer told who registers; nothing without a service', () => {
  assert.equal(discoverEmptyNote({ service: null }), null);
  assert.deepEqual(discoverEmptyNote({ service: orders, env: 'prod', access: OPERATOR }), { text: 'No pack for Orders API (prod) yet — scan its repository, draft from its MCP, upload one, or Build one (the DEFINE step is prefilled).', build: true });
  assert.deepEqual(discoverEmptyNote({ service: orders, env: null, access: null }), { text: 'No pack for Orders API yet — scan its repository, draft from its MCP, upload one, or Build one (the DEFINE step is prefilled).', build: true }, 'no access known (a bundle, the unknown posture): the server decides');
  const v = discoverEmptyNote({ service: orders, env: 'prod', access: VIEWER });
  assert.deepEqual(v, { text: 'No pack for Orders API (prod) yet — an operator scans, drafts, uploads or builds one; you can read the catalogue packs on the home.', build: false });
  assert.ok(!/\byou (scan|upload|build)\b/i.test(v.text), 'the viewer is never told to scan, upload or Build');
});

test('buildPrefillFromService: an empty draft takes the record (name, owners, tier, the tab\'s environment, the origin id); a draft in progress is kept and said so', () => {
  const empty = defaultBuildState();
  const p = buildPrefillFromService(empty, orders, 'staging');
  assert.deepEqual(p, { apply: true, note: null, patch: { name: 'Orders API', owners: 'team-orders, sre-platform', tier: 'tier-2', environment: 'staging', serviceId: 1 } });
  assert.deepEqual(buildPrefillFromService(empty, bare, null).patch, { name: 'Ledger', owners: '', tier: 'tier-2', environment: 'prod', serviceId: 2 }, 'a record with no tier keeps the draft\'s default; no environment keeps the draft\'s');
  const busy = { ...empty, name: 'Payments', owners: 'team-pay', seeded: true };
  const kept = buildPrefillFromService(busy, orders, 'prod');
  assert.equal(kept.apply, false);
  assert.equal(kept.note, 'Your Build draft is kept — its DEFINE fields are as you left them; edit them to start from Orders API.');
  const same = buildPrefillFromService({ ...empty, name: 'Orders API', owners: 'team-orders, sre-platform', tier: 'tier-2', environment: 'prod', seeded: true }, orders, 'prod');
  assert.deepEqual([same.apply, same.note], [false, null], 'the same fields: nothing to say');
  assert.ok(BUILD_PERSIST_FIELDS.includes('serviceId') && 'serviceId' in empty && empty.serviceId === null, 'the origin id persists with the draft');
});

// A headless container for the service page: the markup as a string, every <button> wired by the renderer read
// back from it (id, class, role, data-*) so a click or a key can be fired without a DOM.
function pageContainer() {
  let html = '';
  let els = [];
  const fakeEl = (attrs, id, className, role) => {
    const handlers = {};
    const el = {
      dataset: attrs, id, className, role, hidden: false, focused: false, attrs: {},
      classList: { add(c) { if (!el.className.includes(c)) el.className += ` ${c}`; }, contains(c) { return el.className.split(/\s+/).includes(c); } },
      setAttribute(k, v) { el.attrs[k] = v; }, getAttribute(k) { return el.attrs[k] ?? null; }, removeAttribute(k) { delete el.attrs[k]; },
      why: null,
      querySelector(sel) { return sel === '.svc-why' ? el.why : null; },
      insertAdjacentHTML(_pos, markup) { if (/svc-why/.test(markup)) el.why = { textContent: '' }; },
      addEventListener: (t, fn) => { handlers[t] = fn; }, fire: (t, ev = {}) => handlers[t]?.(ev),
      focus() { el.focused = true; c.focused = el; },
      closest(sel) { return sel === '[role="tab"]' && el.role === 'tab' ? el : null; },
    };
    return el;
  };
  const c = {
    focused: null,
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      els = [...v.matchAll(/<button type="button"([^>]*)>/g)].map((m) => {
        const attrs = Object.fromEntries([...m[1].matchAll(/data-([\w-]+)="([^"]*)"/g)].map((a) => [a[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), a[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
        const id = (m[1].match(/\bid="([^"]+)"/) || [])[1] || null;
        const className = (m[1].match(/\bclass="([^"]*)"/) || [])[1] || '';
        const role = (m[1].match(/\brole="([^"]+)"/) || [])[1] || null;
        return fakeEl(attrs, id, className, role);
      });
      const tabs = els.filter((e) => e.role === 'tab');
      const tablistHandlers = {};
      c.tablist = /class="svc-tabs" role="tablist"/.test(v) ? {
        querySelectorAll: (sel) => (sel === '[role="tab"]' ? tabs : []),
        addEventListener: (t, fn) => { tablistHandlers[t] = fn; },
        key: (key, from) => tablistHandlers.keydown?.({ key, target: from, preventDefault() { c.prevented = (c.prevented || 0) + 1; } }),
      } : null;
    },
    querySelector(sel) {
      if (sel === '.svc-tabs') return c.tablist;
      const m = /^#([\w-]+)$/.exec(sel);
      return m ? els.find((e) => e.id === m[1]) || null : null;
    },
    querySelectorAll(sel) { return sel === '.svc-pack-open' ? els.filter((e) => /\bsvc-pack-open\b/.test(e.className)) : []; },
    byId: (id) => els.find((e) => e.id === id) || null,
    tabs: () => els.filter((e) => e.role === 'tab'),
  };
  return c;
}

test('renderServicePage: the head, the tabs with the selected one marked, the panel — the endpoint as name · origin only, http(s) links with rel="noopener noreferrer", the pack, the drift note — the four actions bound to the service and the environment, the packs linked; escaped at the seam', () => {
  const verdicts = { 'uploaded-orders-api-aaaa::prod': report() };
  const nasty = { ...orders, name: 'Orders <img src=x onerror="window.__xss=1">', description: 'Hand-off <b>x</b>',
    environments: orders.environments.map((e) => (e.mcpEndpoint ? { ...e, mcpEndpoint: { ...e.mcpEndpoint, url: 'https://mcp.example/secret/path?token=1' } } : e)) };
  const m = buildServicePageModel({ service: nasty, envName: 'prod', verdicts, catalog, access: OPERATOR, orgName: 'Acme', isLiveAggregatePack });
  const c = pageContainer();
  const calls = [];
  const host = { services: { home: () => calls.push(['home']), selectEnv: (n) => calls.push(['selectEnv', n]), openIn: (v, b) => calls.push(['openIn', v, b]), openBuild: (b) => calls.push(['openBuild', b]), openPack: (id, env) => calls.push(['openPack', id, env]), explain: (r) => calls.push(['explain', r]), openEditor: (id) => calls.push(['openEditor', id]) } };
  renderServicePage(c, m, host);
  const h = c.innerHTML;
  // Edit, for a rank that may PATCH: in the page bar, opening the editor over this record.
  assert.ok(h.includes('<button type="button" class="svc-edit ux-secondary-btn" id="svc-edit">Edit</button>'));
  c.byId('svc-edit').fire('click');
  assert.deepEqual(calls, [['openEditor', 1]]);
  calls.length = 0;
  assert.ok(h.includes('<section class="svc-page" aria-labelledby="svc-page-name">'));
  assert.ok(h.includes('<h1 class="svc-page-name" id="svc-page-name" tabindex="-1">Orders &lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;</h1>') && !h.includes('<img'), 'the name is escaped — nothing from it reaches the page');
  assert.ok(h.includes('<span class="svc-page-slug">orders-api</span>'));
  assert.ok(h.includes('<p class="svc-page-facts">tier-2 (service) · team-orders, sre-platform · 3 packs</p>'));
  assert.ok(h.includes('<p class="svc-page-desc">Hand-off &lt;b&gt;x&lt;/b&gt;</p>'));
  // The tabs: a tablist, the selected one aria-selected with tabindex 0, the others -1, each controlling the panel.
  assert.ok(h.includes('<div class="svc-tabs" role="tablist" aria-label="Environments">'));
  assert.deepEqual(c.tabs().map((t) => [t.dataset.env, t.id]), [['prod', 'svc-tab-11'], ['staging', 'svc-tab-12'], ['dev', 'svc-tab-13']]);
  assert.match(h, /id="svc-tab-11"[^>]*aria-selected="true"[^>]*aria-controls="svc-env-11"[^>]*tabindex="0"/);
  assert.match(h, /id="svc-tab-12"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
  assert.ok(h.includes('<div class="svc-panel" id="svc-env-11" aria-labelledby="svc-tab-11" role="tabpanel" tabindex="0">'));
  // The panel: the verdict pill with its text; the endpoint as name · origin and nothing past the origin — the fixture\'s URL carries a path and a token.
  assert.ok(h.includes('<span class="svc-verdict is-pass">Conformant · 92% · tier-2 (service)</span>'));
  assert.ok(h.includes('<span class="svc-env-mcp-name">prod-grafana-mcp</span> · <span class="svc-env-mcp-origin">https://mcp.example</span>'));
  assert.ok(!h.includes('secret') && !h.includes('token=1') && !h.includes('mcp.example/'), 'never the URL, nothing past the origin');
  assert.ok(h.includes('<dd>tier-2 — the service&#39;s (no environment override)</dd>'));
  assert.ok(h.includes('<dl class="svc-env-bindings"><div><dt>cluster</dt><dd>eks-eu-1</dd></div><div><dt>namespace</dt><dd>orders</dd></div></dl>'));
  assert.ok(h.includes('<a href="https://grafana.example/d/orders" target="_blank" rel="noopener noreferrer">dashboard ↗</a>'));
  assert.ok(!h.includes('javascript:'), 'the javascript: endpoint is not linked');
  assert.ok(h.includes('<span class="svc-env-pack">Orders API (library) v1.4 <span class="svc-env-pack-how">(current primary · library)</span></span>'));
  assert.ok(h.includes('<dt>Drift runs</dt><dd>Drift runs: Neuron (Advanced) keeps the saved journeys and their runs — not part of this verdict.</dd>'));
  // The four actions, bound to the service and the environment; Build is usable for an operator.
  assert.deepEqual(['svc-action-discover', 'svc-action-diagnose', 'svc-action-remediate', 'svc-action-build'].map((id) => c.byId(id)?.dataset.view), ['layers', 'compare', 'compile', 'build']);
  assert.equal(c.byId('svc-action-build').getAttribute('aria-disabled'), null);
  c.byId('svc-action-discover').fire('click');
  c.byId('svc-action-remediate').fire('click');
  c.byId('svc-action-build').fire('click');
  c.byId('svc-page-back').fire('click');
  assert.deepEqual(calls, [['openIn', 'layers', { serviceId: 1, env: 'prod' }], ['openIn', 'compile', { serviceId: 1, env: 'prod' }], ['openBuild', { serviceId: 1, env: 'prod' }], ['home']]);
  // Packs linked: every row, the current one marked, each opens on its own at the tab\'s environment.
  assert.ok(h.includes('Packs linked to this service (3)'));
  assert.match(h, /<li class="svc-pack-row is-current" data-pack-id="uploaded-orders-api-aaaa">[\s\S]*?<span class="svc-pack-current">current<\/span>/);
  assert.equal((h.match(/svc-pack-current/g) || []).length, 1, 'one current');
  calls.length = 0;
  c.querySelectorAll('.svc-pack-open')[1].fire('click');
  assert.deepEqual(calls, [['openPack', 'uploaded-orders-api-zzzz', 'prod']]);
  // The tabs: a click selects; ArrowRight / ArrowLeft / Home / End move the focus and select.
  calls.length = 0;
  const [prod, staging, dev] = c.tabs();
  staging.fire('click');
  c.tablist.key('ArrowRight', prod);
  c.tablist.key('ArrowLeft', prod);
  c.tablist.key('End', staging);
  c.tablist.key('Home', dev);
  c.tablist.key('Enter', dev);
  assert.deepEqual(calls, [['selectEnv', 'staging'], ['selectEnv', 'staging'], ['selectEnv', 'dev'], ['selectEnv', 'dev'], ['selectEnv', 'prod']]);
  assert.equal(c.prevented, 4, 'the arrow keys are consumed; Enter is left to the button');
  assert.equal(c.focused, prod, 'Home moved the focus to the first tab');
});

test('renderServicePage: a viewer gets Build drawn aria-disabled with the reason (the click explains) and no Edit; a record with no environments gets the rank-worded line; a headless host never throws', () => {
  const c = pageContainer();
  const calls = [];
  renderServicePage(c, buildServicePageModel({ service: orders, envName: 'staging', catalog, access: VIEWER, orgName: 'Acme', isLiveAggregatePack }), { services: { explain: (r) => calls.push(r), openBuild: () => calls.push('BUILD') } });
  const build = c.byId('svc-action-build');
  assert.equal(build.getAttribute('aria-disabled'), 'true');
  assert.ok(build.classList.contains('is-unavailable'));
  assert.equal(build.why.textContent, VIEWER.reason);
  build.fire('click');
  assert.deepEqual(calls, [VIEWER.reason], 'the click explains, never opens Build');
  assert.ok(!c.innerHTML.includes('svc-edit'), 'a viewer has no Edit: a viewer has no PATCH, the facts are read-only for them');
  assert.ok(c.innerHTML.includes('Base grade (no staging overlay in the pack)') === false, 'the verdict for a tab not yet read is Loading…');
  assert.ok(c.innerHTML.includes('<span class="svc-verdict is-loading">Loading…</span>'));
  // No environments: the status line for the rank, no tablist, the actions with the service only.
  const c2 = pageContainer();
  renderServicePage(c2, buildServicePageModel({ service: bare, access: OPERATOR, orgName: 'Acme' }), { services: {} });
  assert.ok(c2.innerHTML.includes('<p class="svc-status svc-noenv" role="status">No environments yet. Register a pack that declares one') && c2.innerHTML.includes('<code>POST /api/services/2/environments { &quot;name&quot;: &quot;prod&quot; }</code>'));
  assert.equal(c2.tablist, null);
  assert.ok(c2.innerHTML.includes('No pack yet for this service'));
  assert.ok(c2.innerHTML.includes('None yet — a register'));
  assert.doesNotThrow(() => { c2.byId('svc-action-discover').fire('click'); c2.byId('svc-action-build').fire('click'); c2.byId('svc-page-back').fire('click'); });
  const c3 = pageContainer();
  renderServicePage(c3, buildServicePageModel({ service: bare, access: VIEWER, orgName: 'Acme' }), { services: {} });
  assert.ok(c3.innerHTML.includes('An operator registers a pack that declares one') && !c3.innerHTML.includes('<code>'));
  // wireServiceTabs alone tolerates no tablist.
  assert.doesNotThrow(() => wireServiceTabs(null, () => {}));
});

// A headless container for the editor: every <button>, <input>, <textarea> and the two status / dialog <div>s wired
// by the renderer are read back from the markup (id, class, role, data-*, value) so a click or a key can be fired.
function editorContainer() {
  let html = '';
  let els = [];
  const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const fakeEl = (tag, attrText, text) => {
    const handlers = {};
    const attrs = Object.fromEntries([
      ...[...attrText.matchAll(/(?:^|\s)([\w-]+)(?=\s|$)/g)].map((a) => [a[1], '']),   // a bare attribute (data-editor-close, disabled)
      ...[...attrText.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], unesc(a[2])]),
    ]);
    const el = {
      tag, attrs, handlers, id: attrs.id || null, className: attrs.class || '', role: attrs.role || null, disabled: /\bdisabled\b/.test(attrText),
      dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase()), v])),
      value: tag === 'textarea' ? unesc(text) : (attrs.value ?? ''), textContent: unesc(text),
      setAttribute(k, v) { el.attrs[k] = v; }, getAttribute(k) { return el.attrs[k] ?? null; },
      addEventListener: (t, fn) => { handlers[t] = fn; }, fire: (t, ev = {}) => handlers[t]?.(ev),
      focus() { c.focused = el; }, closest(sel) { return sel === '[role="radio"]' && el.role === 'radio' ? el : null; },
      contains() { return false; },
    };
    return el;
  };
  const match = (el, sel) => {
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel.startsWith('.')) return el.className.split(/\s+/).includes(sel.slice(1));
    const m = /^\[([\w-]+)\]$/.exec(sel);
    return m ? m[1] in el.attrs : false;
  };
  const c = {
    focused: null,
    get innerHTML() { return html; },
    set innerHTML(v) {
      html = v;
      els = [
        ...[...v.matchAll(/<(button|input)([^>]*)>/g)].map((m) => fakeEl(m[1], m[2], '')),
        ...[...v.matchAll(/<textarea([^>]*)>([\s\S]*?)<\/textarea>/g)].map((m) => fakeEl('textarea', m[1], m[2])),
        ...[...v.matchAll(/<div (class="svc-editor(?:-status|-seg|-scrim)?(?: [^"]*)?"[^>]*)>([^<]*)/g)].map((m) => fakeEl('div', m[1], m[2])),
      ];
    },
    querySelector(sel) { return els.find((e) => match(e, sel)) || null; },
    querySelectorAll(sel) { return els.filter((e) => match(e, sel)); },
    byId: (id) => els.find((e) => e.id === id) || null,
  };
  return c;
}

test('renderServiceEditor: a modal dialog over one record — name, owners, tier as a radio group, description, no slug field and the slug note; Save hands the typed draft to saveService; every close goes to closeEditor; escaped at the seam', () => {
  const nasty = { ...orders, name: 'Orders "API" <img src=x onerror="window.__xss=1">', description: '</textarea><script>1</script>' };
  const m = buildServiceEditorModel(nasty);
  const c = editorContainer();
  const calls = [];
  const host = { services: { saveService: (id, draft) => calls.push(['save', id, draft]), closeEditor: () => calls.push(['close']) } };
  renderServiceEditor(c, m, host);
  const h = c.innerHTML;
  assert.ok(h.includes('<div class="svc-editor-scrim" data-editor-close aria-hidden="true"></div>'));
  assert.ok(h.includes('<div class="svc-editor" role="dialog" aria-modal="true" aria-labelledby="svc-editor-title" aria-describedby="svc-editor-status" data-service-id="1" tabindex="-1">'));
  assert.ok(h.includes('<h2 class="svc-editor-title" id="svc-editor-title">Edit Orders &quot;API&quot; &lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;</h2>') && !h.includes('<img') && !h.includes('<script'), 'the name and the description are escaped — nothing from them reaches the page');
  assert.ok(h.includes('<input id="svc-edit-name" type="text" value="Orders &quot;API&quot; &lt;img src=x onerror=&quot;window.__xss=1&quot;&gt;" maxlength="200"'));
  assert.ok(h.includes('<p class="svc-editor-note" id="svc-editor-slug-note">The slug orders-api stays; packs link to it by slug'));
  assert.ok(h.includes('<input id="svc-edit-owners" type="text" value="team-orders, sre-platform"'));
  assert.ok(h.includes('<div class="svc-editor-field" role="radiogroup" aria-labelledby="svc-edit-tier-label">'));
  assert.ok(h.includes('<textarea id="svc-edit-desc" rows="3" maxlength="4000">&lt;/textarea&gt;&lt;script&gt;1&lt;/script&gt;</textarea>'));
  assert.ok(!/id="svc-edit-slug"|name="slug"/.test(h), 'no slug field');
  assert.ok(h.includes('<div class="svc-editor-status is-idle" id="svc-editor-status" role="status" aria-live="polite">Name, owners, tier and description. The slug is fixed.</div>'));
  assert.ok(h.includes('<button type="button" class="mcp-refresh-btn svc-editor-save" id="svc-editor-save" aria-disabled="false">Save</button>'));
  const radios = c.querySelectorAll('.svc-editor-seg-btn');
  assert.deepEqual(radios.map((r) => [r.dataset.tier, r.getAttribute('aria-checked'), r.getAttribute('tabindex')]), [['tier-1', 'false', '-1'], ['tier-2', 'true', '0'], ['tier-3', 'false', '-1'], ['', 'false', '-1']]);
  // Save with nothing touched: the draft as the record reads.
  c.byId('svc-editor-save').fire('click');
  assert.deepEqual(calls, [['save', 1, { name: nasty.name, owners: 'team-orders, sre-platform', tier: 'tier-2', description: nasty.description }]]);
  // Type a name and owners, check tier-1 by click, "graded by the pack" by keyboard (End), then Save.
  calls.length = 0;
  c.byId('svc-edit-name').value = ' Orders Platform ';
  c.byId('svc-edit-owners').value = 'team-orders';
  radios[0].fire('click');
  assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['true', 'false', 'false', 'false']);
  const seg = c.querySelector('.svc-editor-seg');
  seg.fire('keydown', { key: 'End', target: radios[0], preventDefault() { c.prevented = (c.prevented || 0) + 1; } });
  assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'false', 'false', 'true']);
  assert.equal(c.focused, radios[3], 'the roving focus follows');
  seg.fire('keydown', { key: 'ArrowRight', target: radios[3], preventDefault() { c.prevented += 1; } });
  seg.fire('keydown', { key: 'Enter', target: radios[0], preventDefault() { c.prevented += 1; } });
  assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['true', 'false', 'false', 'false'], 'ArrowRight wraps; Enter is left to the button');
  assert.equal(c.prevented, 2);
  c.byId('svc-editor-save').fire('click');
  assert.deepEqual(calls, [['save', 1, { name: ' Orders Platform ', owners: 'team-orders', tier: 'tier-1', description: nasty.description }]], 'the draft as typed — the controller trims and diffs it (buildServicePatch)');
  // Every close: the scrim, the esc button, Close, Escape on the dialog.
  calls.length = 0;
  for (const el of c.querySelectorAll('[data-editor-close]')) el.fire('click');
  c.querySelector('.svc-editor').fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  c.querySelector('.svc-editor').fire('keydown', { key: 'a', preventDefault() { throw new Error('not consumed'); }, stopPropagation() {} });
  assert.deepEqual(calls, [['close'], ['close'], ['close'], ['close']]);
  // Rendered again for the same record with a status: the status line and the Save button alone are repainted — the typed name stays.
  renderServiceEditor(c, buildServiceEditorModel(nasty, { status: { kind: 'pending', text: 'Saving…' } }), host);
  assert.equal(c.byId('svc-edit-name').value, ' Orders Platform ');
  assert.deepEqual([c.byId('svc-editor-status').className, c.byId('svc-editor-status').textContent, c.byId('svc-editor-save').getAttribute('aria-disabled')], ['svc-editor-status is-pending', 'Saving…', 'true'], 'aria-disabled, never disabled: the focus stays on Save while the PATCH runs');
  renderServiceEditor(c, buildServiceEditorModel(nasty, { status: { kind: 'error', text: '400: a tier is tier-1, tier-2 or tier-3 (or null: graded by the pack), not "x"' } }), host);
  assert.deepEqual([c.byId('svc-editor-status').className, c.byId('svc-editor-save').getAttribute('aria-disabled')], ['svc-editor-status is-error', 'false']);
  assert.ok(!c.byId('svc-editor-status').textContent.includes('{'), 'the server\'s sentence, never a raw body');
  paintServiceEditorStatus(c, serviceSaveStatus(['tier']));
  assert.deepEqual([c.byId('svc-editor-status').className, c.byId('svc-editor-status').textContent], ['svc-editor-status is-saved', 'Saved: tier']);
  // Another record: drawn whole.
  renderServiceEditor(c, buildServiceEditorModel(bare), host);
  assert.ok(c.innerHTML.includes('data-service-id="2"') && c.byId('svc-edit-name').value === bare.name);
  // A headless host never throws.
  assert.doesNotThrow(() => { const c2 = editorContainer(); renderServiceEditor(c2, buildServiceEditorModel(orders), { services: {} }); c2.byId('svc-editor-save').fire('click'); c2.querySelector('.svc-editor-close').fire('click'); });
});

test('the service page persists: mode, serviceId and serviceEnv are in the snapshot, the draft\'s origin id with the Build fields', () => {
  const store = fakeStorage();
  withStorage(store, () => {
    persistence.scope('oscar', 'acme');
    const before = { mode: state.mode, serviceId: state.serviceId, serviceEnv: state.serviceEnv, buildServiceId: state.build.serviceId };
    state.mode = 'service'; state.serviceId = 7; state.serviceEnv = 'prod'; state.build.serviceId = 7;
    persistence.resume();
    persistence.write();
    persistence.suspend();
    const snap = JSON.parse(store.getItem('studioState.v2:oscar:acme'));
    assert.deepEqual([snap.mode, snap.serviceId, snap.serviceEnv, snap.build.serviceId], ['service', 7, 'prod', 7]);
    state.mode = before.mode; state.serviceId = before.serviceId; state.serviceEnv = before.serviceEnv; state.build.serviceId = before.buildServiceId;
    persistence.clear();
  });
});
