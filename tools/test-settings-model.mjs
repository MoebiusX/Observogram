#!/usr/bin/env node
/**
 * tools/test-settings-model.mjs — the pure models of Settings and of the MCP target
 * (studio/settings-model.mjs) and their loaders (studio/settings-api.mjs), headless under
 * node:test (docs/STORE_PLAN.md §6 item 3, slice 6b). The fixtures are the server's shapes:
 * 6a's accessModel() over GET /api/orgs for the fixture principals (olive an owner, ada admin,
 * oscar operator, vera viewer) and the token, open and static postures; the probe's answers
 * (GET /api/org/members: a 200, the token posture's 403 role, the open posture's 403 posture);
 * ServiceView rows with their EnvironmentViews; McpEndpointView rows as an operator and as a
 * viewer reads them; GET /api/org/members (with emails — the loaders drop them); GET /api/audit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_SECTIONS, BUILT_SECTIONS, BUILT_EDITORS, settingsSectionHead, AUDIT_KINDS, settingsAccessModel, settingsSectionFor, buildSettingsFrameModel, settingsAboveRank,
  buildEnvironmentsSectionModel, buildEndpointsSectionModel, buildMembersSectionModel, buildAuditSectionModel, auditQuery,
  buildSettingsEditorModel, buildEnvironmentPatch, buildEnvironmentCreate, buildEndpointPatch, buildEndpointCreate, buildMemberAddBody,
  parseKeyValueLines, environmentSaveStatus, endpointSaveStatus, memberSaveStatus, orgRenameStatus, endpointDeleteStatus,
  lastAdmin, orgEnvPrefix, mcpTargetModel, mcpTargetBody, profileEndpointNote, endpointDrift,
} from '../studio/settings-model.mjs';
import {
  loadMcpEndpoints, createEndpoint, patchEndpoint, deleteEndpoint, createEnvironment, patchEnvironment, deleteEnvironment,
  loadMembers, addMember, patchMember, removeMember, renameOrg, loadAudit,
} from '../studio/settings-api.mjs';
import { accessModel, TIER_BY_PACK } from '../studio/services-model.mjs';
import { renderSettings } from '../studio/settings-view.mjs';
import { readFileSync } from 'node:fs';
import { servicesRefusal } from '../studio/services-api.mjs';
import { orgEnvPrefix as serverOrgEnvPrefix } from '../server/store/mcp-endpoints.mjs';

// ---------- fixtures ----------

const orgsBody = (orgs, active) => ({ ok: true, tenancy: true, orgs, active });
const ACME = { id: 'acme', name: 'Acme' };
const me = (login, owner = false) => ({ ok: true, mode: 'local', authenticated: true, sub: login, user: { login, kind: 'local', owner }, orgs: [] });
const as = (login, role, { owner = false } = {}) => {
  const access = accessModel({ orgs: orgsBody([{ ...ACME, role: owner ? null : role, effectiveRole: owner ? 'admin' : role }], 'acme'), identity: me(login, owner), activeOrg: 'acme' });
  return settingsAccessModel({ access, identity: me(login, owner) });
};
const OLIVE = as('olive', 'admin', { owner: true });
const ADA = as('ada', 'admin');
const OSCAR = as('oscar', 'operator');
const VERA = as('vera', 'viewer');

const TOKEN_ACCESS = accessModel({ orgs: orgsBody([{ id: 'default', name: 'Default', role: null, effectiveRole: 'viewer' }], 'default'), identity: null });
const OPEN_ACCESS = accessModel({ orgs: orgsBody([{ id: 'default', name: 'Default', role: null, effectiveRole: 'admin' }], 'default'), identity: null });
const refused = (status, body) => servicesRefusal(status, body);
const TOKEN_TEXT = 'anonymous callers are viewers here; the admin role needs a signed-in user; this server has no sign-in: add the first user with npm run users -- add <login>, or configure OIDC';
const CLOSED_TEXT = 'on a server without sign-in the identity API answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:8123, or use the CLIs from this machine (npm run users -- add <login>, passwd <login>, owner <login>)';
const TOKEN = settingsAccessModel({ access: TOKEN_ACCESS, probe: refused(403, { ok: false, error: TOKEN_TEXT, denied: 'role' }) });
const CLOSED = settingsAccessModel({ access: OPEN_ACCESS, probe: refused(403, { ok: false, error: CLOSED_TEXT, denied: 'posture' }) });
const OPEN = settingsAccessModel({ access: OPEN_ACCESS, probe: { ok: true, body: { members: [] } } });
const STATIC_ERR = Object.assign(new Error('501: Settings needs the Studio server; this studio is a static bundle built without one.'), { denied: 'no-backend', status: 501 });
const STATIC = settingsAccessModel({ access: { posture: 'static', role: null, rank: null, canWrite: true, reason: null, orgName: null }, probe: STATIC_ERR });

const env = (id, name, over = {}) => ({ id, serviceId: 1, name, tier: null, effectiveTier: null, bindings: {}, endpoints: {}, mcpEndpoint: null, createdAt: 't', updatedAt: 't', ...over });
const GW = { id: 3, name: 'gw', origin: 'https://mcp.acme.test' };
const PAYMENT = {
  id: 1, slug: 'payment-service', name: 'Payment service', owners: [], tier: 'tier-2', description: null, source: { kind: 'observogram' },
  environments: [
    env(3, 'prod', { tier: 'tier-1', effectiveTier: 'tier-1', bindings: { cluster: 'eks', namespace: 'pay' }, endpoints: { dashboard: 'https://grafana.test/d/pay' }, mcpEndpoint: GW }),
    env(7, 'staging', { effectiveTier: 'tier-2', mcpEndpoint: GW }),
  ],
  packs: [],
};
const LEDGER = { id: 2, slug: 'ledger', name: 'Ledger', owners: [], tier: null, description: null, source: { kind: 'observogram' }, environments: [], packs: [] };
const SERVICES = [PAYMENT, LEDGER];
// McpEndpointView as an operator reads it, and as a viewer does (the server nulls url and readTokenEnv).
const EP_OP = [
  { id: 3, name: 'gw', origin: 'https://mcp.acme.test', url: 'https://mcp.acme.test/obs', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN', environments: 2, createdAt: 't' },
  { id: 5, name: 'spare', origin: 'https://spare.acme.test', url: 'https://spare.acme.test/mcp', readTokenEnv: null, environments: 0, createdAt: 't' },
];
const EP_VIEWER = EP_OP.map((ep) => ({ ...ep, url: null, readTokenEnv: null }));
// GET /api/org/members as the server sends it — with emails.
const MEMBERS_RAW = [
  { userId: 2, login: 'ada', kind: 'local', name: 'Ada', email: 'ada@acme.test', role: 'admin', disabled: false, since: '2026-10-01T00:00:00.000Z' },
  { userId: 3, login: 'oscar', kind: 'local', name: null, email: 'x@y.test', role: 'operator', disabled: false, since: '2026-10-01T00:00:00.000Z' },
  { userId: 4, login: 'vera', kind: 'oidc', name: 'Vera', email: null, role: 'viewer', disabled: false, since: '2026-10-02T00:00:00.000Z' },
];
const strip = (m) => { const { email: _email, ...rest } = m; return rest; };
const MEMBERS = MEMBERS_RAW.map(strip);

// ---------- access ----------

test('settingsAccessModel: each rank, each posture — the reasons name a way out the reader can take', () => {
  assert.deepEqual(OLIVE.can, { operate: true, admin: true, own: true, createOrg: true });
  assert.equal(OLIVE.owner, true);
  assert.equal(OLIVE.banner, null);
  assert.deepEqual(ADA.can, { operate: true, admin: true, own: false, createOrg: false });
  assert.equal(ADA.why.own, "users, organisations and the join role belong to the deployment's owners — ask an owner");
  assert.deepEqual([OSCAR.can.operate, OSCAR.can.admin], [true, false]);
  assert.equal(OSCAR.why.admin, 'needs the admin role in Acme — yours is operator; ask an admin of Acme');
  assert.equal(VERA.can.operate, false);
  assert.equal(VERA.why.operate, 'needs the operator role in Acme — yours is viewer', "6a's reason");
  // The token posture: the probe's 403 is the banner, verbatim; every write carries 6a's one reason (B16).
  assert.deepEqual(TOKEN.banner, { kind: 'token', text: `403: ${TOKEN_TEXT}` });
  assert.deepEqual(TOKEN.can, { operate: false, admin: false, own: false, createOrg: false });
  for (const k of ['operate', 'admin', 'own', 'createOrg']) assert.equal(TOKEN.why[k], TOKEN_ACCESS.reason, `token why.${k}`);
  assert.equal(TOKEN.why.operate, 'needs the operator role — this server takes mutations with its API token only, not from a browser');
  assert.equal(settingsAccessModel({ access: TOKEN_ACCESS }).banner, null, 'no banner before the probe answers — never a made-up sentence');
  // Open, the probe 200: an owner (local); a second org needs sign-in; the open banner.
  assert.equal(OPEN.owner, true);
  assert.deepEqual(OPEN.can, { operate: true, admin: true, own: true, createOrg: false });
  assert.match(OPEN.why.createOrg, /^a second organisation needs sign-in, and this server runs without it — /);
  assert.equal(OPEN.banner.kind, 'open');
  assert.equal(OPEN.banner.text, 'This server runs without sign-in: you act as local, an owner, and every change here is audited as local.');
  // Open, the probe 403 posture: closed — the text as served; operator routes stay usable.
  assert.equal(CLOSED.closed, `403: ${CLOSED_TEXT}`);
  assert.deepEqual(CLOSED.banner, { kind: 'closed', text: `403: ${CLOSED_TEXT}` });
  assert.deepEqual(CLOSED.can, { operate: true, admin: false, own: false, createOrg: false });
  for (const k of ['admin', 'own', 'closed', 'createOrg']) assert.equal(CLOSED.why[k], 'closed on this server without sign-in — the banner above names the way in');
  // Static: the 501 as thrown (B15), nothing usable.
  assert.deepEqual(STATIC.banner, { kind: 'static', text: STATIC_ERR.message });
  assert.deepEqual(STATIC.can, { operate: false, admin: false, own: false, createOrg: false });
  assert.equal(settingsAccessModel({ access: { posture: 'static' }, chromeName: 'Acme Studio' }).banner.text,
    '501: Settings needs the Acme Studio server; this studio is a static bundle built without one.');
});

test('the frame: the scope line, the nav lists only the built sections, each unreadable one disabled with its reason', () => {
  assert.deepEqual(SETTINGS_SECTIONS, ['environments', 'endpoints', 'members', 'audit', 'users', 'orgs', 'join-role']);
  assert.deepEqual(BUILT_SECTIONS, ['environments', 'endpoints'], 'the sections this build draws: no members, audit or deployment group yet');
  assert.deepEqual(BUILT_EDITORS, [], 'no record editor in this build');
  const FOUR = ['environments', 'endpoints', 'members', 'audit'];
  assert.deepEqual(buildSettingsFrameModel({ access: ADA }).nav.map((n) => n.id), BUILT_SECTIONS, 'the default nav is the built sections');
  const ada = buildSettingsFrameModel({ access: ADA, orgName: 'Acme', orgId: 'acme', builtSections: FOUR });
  assert.equal(ada.scope, 'Settings · Acme (acme) · you are admin');
  assert.equal(ada.section, 'environments', 'the first readable section by default');
  assert.deepEqual(ada.nav.map((n) => [n.id, n.label, n.group, n.enabled]), [
    ['environments', 'Environments', 'org', true], ['endpoints', 'MCP endpoints', 'org', true], ['members', 'Members', 'org', true], ['audit', 'Audit', 'org', true],
  ]);
  assert.equal(buildSettingsFrameModel({ access: OLIVE, orgName: 'Acme', orgId: 'acme' }).scope, 'Settings · Acme (acme) · you are admin, an owner');
  const oscar = buildSettingsFrameModel({ access: OSCAR, section: 'members', orgName: 'Acme', orgId: 'acme', builtSections: FOUR });
  assert.equal(oscar.scope, 'Settings · Acme (acme) · you are operator');
  assert.equal(oscar.section, 'environments', 'a section the rank cannot read falls back to the first it can');
  const members = oscar.nav.find((n) => n.id === 'members');
  assert.deepEqual([members.enabled, members.reason], [false, 'needs the admin role in Acme — yours is operator; ask an admin of Acme']);
  assert.equal(oscar.nav.find((n) => n.id === 'audit').enabled, false);
  // B3: the nav is what is built — two sections at the first UI commit.
  const two = buildSettingsFrameModel({ access: ADA, section: 'members', builtSections: ['environments', 'endpoints'] });
  assert.deepEqual(two.nav.map((n) => n.id), ['environments', 'endpoints']);
  assert.equal(two.section, 'environments');
  // A section asked for and readable is kept; its status comes from statusOf.
  const audit = buildSettingsFrameModel({ access: ADA, section: 'audit', statusOf: (id) => ({ kind: 'loading', text: `Reading ${id}…` }), builtSections: FOUR });
  assert.deepEqual([audit.section, audit.status], ['audit', { kind: 'loading', text: 'Reading audit…' }]);
  assert.ok(audit.nav.find((n) => n.id === 'audit').current);
  // The token posture: environments and endpoints readable, members and audit disabled with 6a's reason.
  const token = buildSettingsFrameModel({ access: TOKEN, orgName: 'Default', orgId: 'default', builtSections: FOUR });
  assert.equal(token.scope, 'Settings · Default (default) · you are viewer');
  assert.deepEqual(token.nav.filter((n) => !n.enabled).map((n) => [n.id, n.reason]), [['members', TOKEN_ACCESS.reason], ['audit', TOKEN_ACCESS.reason]]);
  assert.equal(token.banner.kind, 'token');
  // Static: the banner only — no nav, no section.
  const stat = buildSettingsFrameModel({ access: STATIC });
  assert.deepEqual([stat.nav, stat.section, stat.banner.kind, stat.scope], [[], null, 'static', 'Settings']);
  assert.equal(settingsSectionFor(STATIC, 'environments'), null);
  assert.equal(settingsSectionFor(CLOSED, 'members', FOUR), 'environments', 'closed: members falls back');
  assert.equal(settingsSectionFor(ADA, 'members'), 'environments', 'a section not built is never opened');
  // The heads: the title, the scope sentence naming the org, the reading line.
  assert.deepEqual(settingsSectionHead('environments', { orgName: 'Acme' }).loading, 'Reading environments…');
  assert.equal(settingsSectionHead('endpoints').loading, 'Reading MCP endpoints…');
  assert.equal(settingsSectionHead('endpoints').title, 'MCP endpoints');
  assert.match(settingsSectionHead('environments', { orgName: 'Acme' }).scope, /^Every environment of Acme's services — /);
  assert.match(settingsSectionHead('endpoints', { orgName: 'Acme' }).scope, /never its value\.$/);
  for (const id of BUILT_SECTIONS) assert.doesNotMatch(settingsSectionHead(id).scope, /slice|Settings →/, 'no roadmap wording, no control named that is not built');
});

test('settingsAboveRank: a downgrade forgets what the new rank may not read (C-6)', () => {
  const cached = {
    probe: null, endpoints: EP_OP, members: MEMBERS, org: ACME,
    audit: { doc: { next: null }, rows: [{ seq: 2, orgId: 'acme' }, { seq: 1, orgId: 'bravo' }, { seq: 0, orgId: null }], filters: {} },
    users: [{ login: 'x' }], orgs: [], joinRole: { role: null }, status: {},
  };
  const asOperator = settingsAboveRank(cached, OSCAR, { orgId: 'acme' });
  assert.deepEqual([asOperator.members, asOperator.org, asOperator.audit, asOperator.users, asOperator.orgs, asOperator.joinRole], [null, null, null, null, null, null]);
  assert.equal(asOperator.endpoints, EP_OP, 'what every rank reads stays');
  const asAdmin = settingsAboveRank(cached, ADA, { orgId: 'acme' });
  assert.deepEqual(asAdmin.audit.rows.map((r) => r.seq), [2], "a non-owner admin keeps the active org's rows only");
  assert.equal(asAdmin.members, MEMBERS);
  assert.equal(asAdmin.users, null, 'the deployment answers are an owner\'s');
  const asOwner = settingsAboveRank(cached, OLIVE, { orgId: 'acme' });
  assert.equal(asOwner.audit.rows.length, 3);
  assert.deepEqual(asOwner.users, [{ login: 'x' }]);
  assert.equal(cached.members, MEMBERS, 'the input is not mutated');
  assert.equal(settingsAboveRank(null, ADA), null);
});

// ---------- environments ----------

test('environments: the services table flattened, the binding named, the edit by rank, the empty and failed states', () => {
  const op = buildEnvironmentsSectionModel({ services: SERVICES, access: OSCAR, orgName: 'Acme' });
  assert.deepEqual(op.groups.map((g) => [g.slug, g.name, g.envs.map((e) => e.name)]), [['payment-service', 'Payment service', ['prod', 'staging']], ['ledger', 'Ledger', []]]);
  const prod = op.groups[0].envs[0];
  assert.deepEqual(prod, { id: 3, name: 'prod', tierText: 'tier-1', mcpText: 'gw — https://mcp.acme.test', bindingsCount: 2, linksCount: 1, canEdit: true });
  assert.deepEqual(op.primary, { enabled: true, reason: null });
  assert.equal(op.empty, null);
  const vera = buildEnvironmentsSectionModel({ services: [{ ...LEDGER, environments: [env(9, 'qa')] }], access: VERA, orgName: 'Acme' });
  assert.deepEqual([vera.groups[0].envs[0].canEdit, vera.groups[0].envs[0].tierText, vera.groups[0].envs[0].mcpText], [false, TIER_BY_PACK, 'none']);
  assert.deepEqual(vera.primary, { enabled: false, reason: 'needs the operator role in Acme — yours is viewer' });
  // A11: no service yet — the primary disabled with the Build sentence; the Build button for an operator only.
  const none = buildEnvironmentsSectionModel({ services: [], access: OSCAR, orgName: 'Acme' });
  const buildText = 'No service in Acme yet — Build registers one (its DEFINE names the service).';
  assert.deepEqual([none.primary, none.empty, none.build], [{ enabled: false, reason: buildText }, buildText, true]);
  assert.equal(buildEnvironmentsSectionModel({ services: [], access: VERA, orgName: 'Acme' }).build, false);
  // Services but no environment.
  assert.equal(buildEnvironmentsSectionModel({ services: [LEDGER], access: OSCAR, orgName: 'Acme' }).empty, 'No environments in Acme yet. Add environment registers one.');
  assert.equal(buildEnvironmentsSectionModel({ services: [LEDGER], access: VERA, orgName: 'Acme' }).empty, 'No environments in Acme yet.');
  // The table failed: the error is the primary's reason.
  const failed = buildEnvironmentsSectionModel({ services: null, access: OSCAR, orgName: 'Acme', error: '500: boom' });
  assert.deepEqual([failed.error, failed.primary], ['500: boom', { enabled: false, reason: '500: boom' }]);
});

test('the environment editor: the endpoint list awaited — [] vs null, the binding always an option, never unbound by accident (A4)', () => {
  const ctx = { access: OSCAR, orgName: 'Acme', orgId: 'acme', services: SERVICES, endpoints: EP_OP };
  const prod = PAYMENT.environments[0];
  const m = buildSettingsEditorModel('environment', prod, { ctx });
  assert.equal(m.title, 'Edit prod');
  assert.equal(m.eyebrow, 'Environment of Payment service');
  const mcp = m.fields.find((f) => f.name === 'mcpEndpointId');
  assert.deepEqual(mcp.options.map((o) => [o.value, o.label, o.selected]), [[null, 'none', false], [3, 'gw — https://mcp.acme.test', true], [5, 'spare — https://spare.acme.test', false]]);
  assert.equal(mcp.help, null);
  assert.deepEqual(buildEnvironmentPatch(prod, m.draft), {}, 'the record as drawn is no change');
  assert.equal(m.fields.find((f) => f.name === 'tier').help, "Graded by the service: Payment service's tier, tier-2.");
  assert.deepEqual(m.fields.find((f) => f.name === 'tier').options.map((o) => o.label), ['tier-1', 'tier-2', 'tier-3', 'graded by the service']);
  assert.equal(m.fields.find((f) => f.name === 'bindings').value, 'cluster=eks\nnamespace=pay');
  assert.equal(m.primary.label, 'Save');
  assert.equal(m.primary.enabled, true);
  // [] → the empty help; the record's binding is still an option, still selected.
  const empty = buildSettingsEditorModel('environment', prod, { ctx: { ...ctx, endpoints: [] } });
  const emptyField = empty.fields.find((f) => f.name === 'mcpEndpointId');
  assert.equal(emptyField.help, 'No MCP endpoint is registered in Acme yet — an admin registers one in Settings → MCP endpoints.');
  assert.deepEqual(emptyField.options.map((o) => [o.value, o.selected]), [[null, false], [3, true]]);
  assert.deepEqual(buildEnvironmentPatch(prod, empty.draft), {});
  // null (the read failed) → disabled, the binding kept: no mcpEndpointId: null in any patch built from it.
  const failed = buildSettingsEditorModel('environment', prod, { ctx: { ...ctx, endpoints: null, endpointsError: '403: nope' }, draft: { tier: 'tier-2' } });
  const failedField = failed.fields.find((f) => f.name === 'mcpEndpointId');
  assert.equal(failedField.disabled, true);
  assert.equal(failedField.help, "The org's MCP endpoints could not be read — 403: nope; the binding is kept.");
  assert.equal(failed.draft.mcpEndpointId, undefined);
  assert.deepEqual(buildEnvironmentPatch(prod, failed.draft), { tier: 'tier-2' }, 'the tier only — the binding is neither resent nor nulled');
  // The bound endpoint missing from the list (another admin deleted it): still an option, selected.
  const gone = buildSettingsEditorModel('environment', prod, { ctx: { ...ctx, endpoints: [EP_OP[1]] } });
  assert.deepEqual(gone.fields.find((f) => f.name === 'mcpEndpointId').options.map((o) => [o.value, o.selected]), [[null, false], [5, false], [3, true]]);
  assert.deepEqual(buildEnvironmentPatch(prod, gone.draft), {});
  // Choosing none unbinds — only when chosen.
  assert.deepEqual(buildEnvironmentPatch(prod, buildSettingsEditorModel('environment', prod, { ctx, draft: { mcpEndpointId: '' } }).draft), { mcpEndpointId: null });
  // Add: the service select, Create, the body with the non-empty fields only.
  const add = buildSettingsEditorModel('environment', null, { ctx: { ...ctx, serviceId: 2 }, draft: { name: ' qa ' } });
  assert.equal(add.title, 'Add environment');
  assert.deepEqual(add.fields[0].options.map((o) => [o.value, o.label, o.selected]), [[1, 'Payment service (payment-service)', false], [2, 'Ledger (ledger)', true]]);
  assert.equal(add.primary.label, 'Create');
  assert.deepEqual(buildEnvironmentCreate(add.draft), { name: 'qa' });
  assert.deepEqual(buildEnvironmentCreate({ name: 'qa', tier: 'tier-3', mcpEndpointId: '3', bindings: 'a=b', endpoints: '' }), { name: 'qa', tier: 'tier-3', mcpEndpointId: 3, bindings: { a: 'b' } });
  // The delete step and a viewer's disabled primary.
  const del = buildSettingsEditorModel('environment', prod, { ctx, step: 'confirm-delete' });
  assert.equal(del.confirm.text, 'Delete prod of Payment service? Its tier, bindings, links and endpoint binding go; the packs stay registered, and a pack that declares prod brings the name back without them.');
  assert.equal(del.confirm.danger, 'Delete prod');
  const viewer = buildSettingsEditorModel('environment', prod, { ctx: { ...ctx, access: VERA } });
  assert.deepEqual(viewer.primary, { label: 'Save', enabled: false, reason: 'needs the operator role in Acme — yours is viewer' });
  const pending = buildSettingsEditorModel('environment', prod, { ctx, status: { kind: 'pending', text: 'Saving…' } });
  assert.deepEqual([pending.saving, pending.primary.enabled], [true, false]);
});

test('buildEnvironmentPatch, parseKeyValueLines: only what differs, objects whole', () => {
  const prod = PAYMENT.environments[0];
  assert.deepEqual(buildEnvironmentPatch(prod, { name: ' prod ', tier: 'tier-1', bindings: 'namespace=pay\ncluster=eks' }), {}, 'trimmed name, same tier, the same bindings in another order');
  assert.deepEqual(buildEnvironmentPatch(prod, { name: 'production', tier: '' }), { name: 'production', tier: null }, "'' tier → null (graded by the service)");
  assert.deepEqual(buildEnvironmentPatch(prod, { bindings: 'cluster=eks' }), { bindings: { cluster: 'eks' } }, 'sent whole: the server replaces');
  assert.deepEqual(buildEnvironmentPatch(prod, { endpoints: { dashboard: 'https://grafana.test/d/pay', runbook: 'https://wiki.test' } }), { endpoints: { dashboard: 'https://grafana.test/d/pay', runbook: 'https://wiki.test' } });
  assert.deepEqual(buildEnvironmentPatch(prod, { mcpEndpointId: 5 }), { mcpEndpointId: 5 });
  assert.deepEqual(buildEnvironmentPatch(env(9, 'qa'), { mcpEndpointId: null }), {}, 'unbound stays unbound');
  assert.deepEqual(parseKeyValueLines(' a = b \n\nurl=https://x.test/?q=1\r\nbare line\n'), { a: 'b', url: 'https://x.test/?q=1', 'bare line': '' });
  assert.deepEqual(parseKeyValueLines(''), {});
  assert.deepEqual(parseKeyValueLines(null), {});
});

// ---------- MCP endpoints ----------

test('endpoints: a viewer reads name and origin only, an operator the URL and the variable name; the bound environments named', () => {
  const op = buildEndpointsSectionModel({ endpoints: EP_OP, services: SERVICES, access: OSCAR, orgName: 'Acme' });
  assert.deepEqual(op.rows[0], { id: 3, name: 'gw', origin: 'https://mcp.acme.test', url: 'https://mcp.acme.test/obs', tokenText: 'token: OBSERVOGRAM_ORG_ACME_MCP_TOKEN', boundText: 'checked by 2 environments: payment-service / prod, payment-service / staging' });
  assert.deepEqual([op.rows[1].tokenText, op.rows[1].boundText], ['token: none (requests send their own)', 'checked by 0 environments']);
  assert.deepEqual(op.primary, { enabled: false, reason: 'needs the admin role in Acme — yours is operator; ask an admin of Acme' });
  // Mutation check 3: even a fixture that carries the URL is not read for a viewer.
  const vera = buildEndpointsSectionModel({ endpoints: EP_OP, services: SERVICES, access: VERA, orgName: 'Acme' });
  assert.deepEqual(vera.rows.map((r) => [r.url, r.tokenText]), [[null, null], [null, null]]);
  assert.ok(!JSON.stringify(vera).includes('/obs') && !JSON.stringify(vera).includes('MCP_TOKEN'));
  assert.deepEqual(buildEndpointsSectionModel({ endpoints: EP_VIEWER, access: TOKEN, orgName: 'Default' }).rows[0].url, null);
  // The count alone when the table is unavailable, or disagrees.
  assert.equal(buildEndpointsSectionModel({ endpoints: EP_OP, services: null, access: ADA }).rows[0].boundText, 'checked by 2 environments');
  assert.equal(buildEndpointsSectionModel({ endpoints: [{ ...EP_OP[0], environments: 3 }], services: SERVICES, access: ADA }).rows[0].boundText, 'checked by 3 environments');
  assert.equal(buildEndpointsSectionModel({ endpoints: [{ ...EP_OP[0], environments: 1 }], services: [{ ...PAYMENT, environments: [PAYMENT.environments[0]] }], access: ADA }).rows[0].boundText, 'checked by 1 environment: payment-service / prod');
  const ada = buildEndpointsSectionModel({ endpoints: [], access: ADA, orgName: 'Acme' });
  assert.deepEqual([ada.primary.enabled, ada.empty], [true, 'No MCP endpoints in Acme yet. New MCP endpoint registers one.']);
  assert.equal(buildEndpointsSectionModel({ endpoints: [], access: OSCAR, orgName: 'Acme' }).empty, 'No MCP endpoints in Acme yet. An admin registers them.');
  assert.equal(buildEndpointsSectionModel({ endpoints: null, access: ADA, error: '500: boom' }).error, '500: boom');
  assert.equal(buildEndpointsSectionModel({ endpoints: [], access: CLOSED }).primary.reason, 'closed on this server without sign-in — the banner above names the way in');
});

test('the endpoint editor: the token variable under the org prefix, never a value; the patch and the delete step', () => {
  for (const id of ['acme', 'pay-eu', 'default', 'a_b']) assert.equal(orgEnvPrefix(id), serverOrgEnvPrefix(id), `orgEnvPrefix(${id}) mirrors the server`);
  assert.equal(orgEnvPrefix('pay-eu'), 'OBSERVOGRAM_ORG_PAY_EU_');
  assert.equal(orgEnvPrefix('default'), 'OBSERVOGRAM_ORG_DEFAULT_');
  const ctx = { access: ADA, orgName: 'Acme', orgId: 'acme', services: SERVICES };
  const create = buildSettingsEditorModel('endpoint', null, { ctx });
  assert.deepEqual([create.title, create.primary.label, create.primary.enabled], ['New MCP endpoint', 'Create', true]);
  assert.deepEqual(create.fields.map((f) => [f.name, f.label, f.type]), [['name', 'Name', 'text'], ['url', 'URL', 'url'], ['readTokenEnv', 'Token variable', 'text']]);
  assert.equal(create.fields[2].help, 'The NAME of an environment variable on the server, set aside for Acme: OBSERVOGRAM_ORG_ACME_<NAME> (for example OBSERVOGRAM_ORG_ACME_MCP_TOKEN). Its value stays on the server — this page never sees it, and nothing here says whether it is set. Leave empty when requests send their own token.');
  assert.equal(create.fields[1].help, "The gateway's address — no credentials in it: the server refuses a URL with a user, a fragment or a token-like parameter.");
  assert.deepEqual(buildEndpointCreate({ name: ' gw ', url: ' https://mcp.acme.test/obs ', readTokenEnv: '' }), { name: 'gw', url: 'https://mcp.acme.test/obs' }, 'an empty variable is omitted on create');
  assert.deepEqual(buildEndpointCreate({ name: 'gw', url: 'u', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_T' }), { name: 'gw', url: 'u', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_T' });
  const gw = EP_OP[0];
  assert.deepEqual(buildEndpointPatch(gw, { name: 'gw', url: 'https://mcp.acme.test/obs', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }), {});
  assert.deepEqual(buildEndpointPatch(gw, { readTokenEnv: '' }), { readTokenEnv: null }, "'' clears it on PATCH");
  assert.deepEqual(buildEndpointPatch(gw, { url: 'https://mcp2.acme.test/obs ' }), { url: 'https://mcp2.acme.test/obs' });
  assert.deepEqual(buildEndpointPatch(EP_OP[1], { readTokenEnv: '' }), {}, 'null stays null');
  const edit = buildSettingsEditorModel('endpoint', gw, { ctx });
  assert.deepEqual([edit.title, edit.draft], ['Edit gw', { name: 'gw', url: 'https://mcp.acme.test/obs', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }]);
  assert.deepEqual(buildEndpointPatch(gw, edit.draft), {});
  const del = buildSettingsEditorModel('endpoint', gw, { ctx, step: 'confirm-delete' });
  assert.equal(del.confirm.text, 'Delete gw? 2 environments are checked through it (payment-service / prod, payment-service / staging); they keep their rows, unbound.');
  assert.equal(buildSettingsEditorModel('endpoint', EP_OP[1], { ctx, step: 'confirm-delete' }).confirm.text, 'Delete spare? No environment is checked through it.');
  assert.equal(buildSettingsEditorModel('endpoint', { ...gw, environments: 1 }, { ctx: { ...ctx, services: null }, step: 'confirm-delete' }).confirm.text, 'Delete gw? 1 environment is checked through it; they keep their rows, unbound.');
  assert.deepEqual(buildSettingsEditorModel('endpoint', null, { ctx: { ...ctx, access: OSCAR } }).primary, { label: 'Create', enabled: false, reason: 'needs the admin role in Acme — yours is operator; ask an admin of Acme' });
});

// ---------- members and the org's name ----------

test('members: no email, "you" by login, the last-admin rule drawn first — an owner passes it and is told what it leaves', () => {
  assert.equal(lastAdmin(MEMBERS[0], MEMBERS, { owner: false }), true, 'the only enabled admin, a non-owner caller');
  assert.equal(lastAdmin(MEMBERS[0], MEMBERS, { owner: true }), false, 'an owner passes the rule');
  const two = [...MEMBERS, { userId: 9, login: 'abe', role: 'admin', disabled: false }];
  assert.equal(lastAdmin(MEMBERS[0], two, { owner: false }), false, 'a second enabled admin');
  assert.equal(lastAdmin(MEMBERS[0], [...MEMBERS, { userId: 9, login: 'abe', role: 'admin', disabled: true }], { owner: false }), true, 'the other admin is disabled');
  assert.equal(lastAdmin(MEMBERS[1], MEMBERS, { owner: false }), false, 'not an admin');
  const ada = buildMembersSectionModel({ members: MEMBERS, org: { id: 'acme', name: 'Acme', default: false }, access: ADA, me: 'ada' });
  assert.equal(ada.scopeSentence, 'The members of Acme (acme) and their roles.');
  assert.deepEqual(ada.org, { id: 'acme', name: 'Acme', canRename: true, renameReason: null });
  const self = ada.rows[0];
  assert.deepEqual([self.you, self.lastAdmin, self.canEdit], [true, true, true]);
  const lock = 'ada is the last admin of Acme: only an owner can demote or remove them — make another member an admin first';
  assert.deepEqual(self.reasons, { remove: lock, roles: { viewer: lock, operator: lock, admin: null } });
  assert.deepEqual(self.selfNote, { demote: 'This is you: you lose the admin role at once.', remove: 'This is you: you lose access to Acme at once.' });
  assert.deepEqual(ada.rows[1].reasons, { remove: null, roles: { viewer: null, operator: null, admin: null } });
  assert.equal(ada.rows[1].you, false);
  assert.ok(!JSON.stringify(buildMembersSectionModel({ members: MEMBERS_RAW, org: ACME, access: ADA, me: 'ada' })).includes('x@y.test'), 'C-8: a model fed an email does not carry it');
  // An owner: usable, with the note (A12), and the self note worded for an owner (C-2).
  const olive = buildMembersSectionModel({ members: MEMBERS, org: ACME, access: OLIVE, me: 'ada' });
  assert.deepEqual([olive.rows[0].lastAdmin, olive.rows[0].reasons.remove], [false, null]);
  assert.equal(olive.rows[0].ownerLastAdminNote, "ada is Acme's last admin: afterwards only an owner can manage its members, endpoints and audit.");
  assert.equal(olive.rows[0].selfNote.remove, 'This is you: your membership changes, but as an owner you keep the admin role in Acme.');
  assert.equal(olive.rows[1].ownerLastAdminNote, null);
  assert.equal(buildMembersSectionModel({ members: MEMBERS, org: ACME, access: OLIVE, acting: true }).scopeSentence, 'The members of Acme (acme) — you are an owner acting in acme — not a member.');
  // An operator never reaches the list; its controls carry the admin reason.
  const oscar = buildMembersSectionModel({ members: MEMBERS, org: ACME, access: OSCAR, me: 'oscar' });
  assert.deepEqual([oscar.primary.enabled, oscar.org.canRename, oscar.rows[1].reasons.remove], [false, false, 'needs the admin role in Acme — yours is operator; ask an admin of Acme']);
  assert.equal(buildMembersSectionModel({ members: null, org: ACME, access: ADA, error: '403: x' }).error, '403: x');
});

test('the member editors: add by login or email, a role change, the remove step; the self and owner notes', () => {
  const ctx = { access: ADA, orgName: 'Acme', orgId: 'acme', members: MEMBERS, me: 'ada' };
  const add = buildSettingsEditorModel('member-add', null, { ctx });
  assert.deepEqual([add.title, add.primary.label, add.draft], ['Add member', 'Add', { by: 'login', value: '', role: 'operator' }]);
  assert.deepEqual(add.fields.find((f) => f.name === 'role').options.map((o) => o.value), ['viewer', 'operator', 'admin']);
  assert.equal(buildSettingsEditorModel('member-add', null, { ctx, draft: { by: 'email' } }).fields[1].label, 'Verified email');
  assert.deepEqual(buildMemberAddBody({ by: 'login', value: ' oscar ', role: 'admin' }), { login: 'oscar', role: 'admin' });
  assert.deepEqual(buildMemberAddBody({ by: 'email', value: 'o@acme.test', role: 'viewer' }), { email: 'o@acme.test', role: 'viewer' });
  const self = buildSettingsEditorModel('member', MEMBERS[0], { ctx });
  assert.deepEqual(self.fields[0].options.map((o) => [o.value, o.enabled]), [['viewer', false], ['operator', false], ['admin', true]]);
  assert.deepEqual(self.remove, { enabled: false, reason: 'ada is the last admin of Acme: only an owner can demote or remove them — make another member an admin first' });
  const oscar = buildSettingsEditorModel('member', MEMBERS[1], { ctx, step: 'confirm-delete' });
  assert.equal(oscar.confirm.text, 'Remove oscar from Acme? Their sessions keep working elsewhere; here their next request is refused.');
  assert.equal(oscar.id, 3);
  // ada not the last admin any more: removing herself says so first.
  const two = [...MEMBERS, { userId: 9, login: 'abe', role: 'admin', disabled: false }];
  const leave = buildSettingsEditorModel('member', MEMBERS[0], { ctx: { ...ctx, members: two }, step: 'confirm-delete' });
  assert.equal(leave.confirm.text, 'Remove ada from Acme? Their sessions keep working elsewhere; here their next request is refused. This is you: you lose access to Acme at once.');
  const demote = buildSettingsEditorModel('member', MEMBERS[0], { ctx: { ...ctx, members: two }, step: 'confirm-action', draft: { role: 'operator' } });
  assert.equal(demote.confirm.text, "Change ada's role to operator? This is you: you lose the admin role at once.");
  // An owner demoting the last admin: allowed, and warned (A12).
  const owner = buildSettingsEditorModel('member', MEMBERS[0], { ctx: { ...ctx, access: OLIVE, me: 'olive' }, step: 'confirm-action', draft: { role: 'viewer' } });
  assert.equal(owner.confirm.text, "Change ada's role to viewer? ada is Acme's last admin: afterwards only an owner can manage its members, endpoints and audit.");
  assert.equal(owner.remove.enabled, true);
  const rename = buildSettingsEditorModel('org-name', { id: 'acme', name: 'Acme' }, { ctx, draft: { name: 'Acme Corp' } });
  assert.deepEqual([rename.title, rename.draft, rename.fields[0].help], ['Rename Acme', { name: 'Acme Corp' }, 'The id acme stays; only the name changes.']);
  assert.throws(() => buildSettingsEditorModel('user', null, { ctx }), /no Settings editor of kind "user"/);
});

test('the status sentences name what the server changed, by label', () => {
  assert.deepEqual(environmentSaveStatus(['mcpEndpointId', 'bindings']), { kind: 'saved', text: 'Saved: MCP endpoint, bindings' });
  assert.deepEqual(environmentSaveStatus(['tier', 'endpoints']), { kind: 'saved', text: 'Saved: tier, links' });
  assert.deepEqual(environmentSaveStatus([]), { kind: 'idle', text: 'Nothing changed.' });
  assert.deepEqual(endpointSaveStatus(['url', 'readTokenEnv']), { kind: 'saved', text: 'Saved: URL, token variable' });
  assert.equal(memberSaveStatus({ member: { login: 'oscar', role: 'admin' }, added: true, changed: null }).text, 'Added oscar as admin.');
  assert.equal(memberSaveStatus({ member: { login: 'oscar', role: 'admin' }, added: false, changed: { from: 'operator', to: 'admin' } }).text, 'oscar was already a member: operator → admin.');
  assert.equal(memberSaveStatus({ member: { login: 'oscar', role: 'operator' }, added: false, changed: null }).text, 'oscar is already an operator — nothing changed.');
  assert.equal(memberSaveStatus({ member: { login: 'vera', role: 'viewer' }, added: false, changed: null }).text, 'vera is already a viewer — nothing changed.');
  assert.equal(memberSaveStatus({ member: { login: 'oscar', role: 'operator' }, changed: { from: 'admin', to: 'operator' } }).text, 'oscar: admin → operator.');
  assert.deepEqual(memberSaveStatus({ member: { login: 'oscar', role: 'operator' }, changed: null }), { kind: 'idle', text: 'Nothing changed.' });
  assert.deepEqual(orgRenameStatus('Acme', 'Acme Corp'), { kind: 'saved', text: 'Renamed: Acme → Acme Corp.' });
  assert.deepEqual(orgRenameStatus('Acme', 'Acme'), { kind: 'idle', text: 'Nothing changed.' });
  // B2: unbound is an array of environment ids.
  assert.deepEqual(endpointDeleteStatus('gw', [3, 7], SERVICES), { kind: 'saved', text: 'Deleted gw — 2 environments unbound: payment-service / prod, payment-service / staging' });
  assert.equal(endpointDeleteStatus('gw', [], SERVICES).text, 'Deleted gw.');
  assert.equal(endpointDeleteStatus('gw', [3, 99], SERVICES).text, 'Deleted gw — 2 environments unbound: payment-service / prod, environment 99');
  assert.equal(endpointDeleteStatus('gw', [3], null).text, 'Deleted gw — 1 environment unbound: environment 3');
});

// ---------- the audit ----------

test('auditQuery: only the filled parameters; scope for an owner only; "through" a day sends the next (A7)', () => {
  assert.equal(auditQuery({}, { owner: false }), '?limit=100');
  assert.equal(auditQuery({ scope: 'deployment', actor: ' ada ', kind: '', action: 'membership.role' }, { owner: false }), '?actor=ada&action=membership.role&limit=100', 'never a scope for an admin');
  assert.equal(auditQuery({ scope: 'deployment', kind: 'store' }, { owner: true }), '?scope=deployment&kind=store&limit=100');
  assert.equal(auditQuery({ from: '2026-10-06', through: '2026-10-06' }, { owner: false }), '?since=2026-10-06&until=2026-10-07&limit=100', 'a same-day query includes the day');
  assert.equal(auditQuery({ through: '2026-10-31' }, {}), '?until=2026-11-01&limit=100', 'a month rolls over');
  assert.equal(auditQuery({ through: '2026-12-31' }, {}), '?until=2027-01-01&limit=100', 'a year rolls over');
  assert.equal(auditQuery({ from: '2026-10-07', through: '2026-10-05' }, {}), '?since=2026-10-07&until=2026-10-06&limit=100', 'a "through" before "from" still reaches the server');
  assert.equal(auditQuery({ targetKind: 'environment', targetId: '4' }, { before: 120, limit: 50 }), '?targetKind=environment&targetId=4&limit=50&before=120');
  assert.equal(auditQuery({ actor: 'a&b c' }, {}), '?actor=a%26b%20c&limit=100');
});

test('the audit section: the caption, the scope control for an owner, the actor as served, the detail a string; paging', () => {
  const rows = [
    { seq: 12, at: '2026-10-06T10:00:00.000Z', orgId: 'acme', actor: 'ada', action: 'membership.role', targetKind: 'user', targetId: '3', detail: { from: 'operator', to: 'admin', note: '<img src=x onerror=alert(1)>' } },
    { seq: 11, at: '2026-10-06T09:00:00.000Z', orgId: null, actor: 'cli', action: 'store.export', targetKind: 'store', targetId: null, detail: null },
  ];
  const ada = buildAuditSectionModel({ doc: { scope: 'org', org: 'acme', limit: 100, rows, next: 11 }, rows, filters: {}, access: ADA, orgId: 'acme' });
  assert.equal(ada.caption, '2 rows, newest first · scope org · org acme');
  assert.deepEqual([ada.scopeControl, ada.scopeSentence, ada.showOrg], [null, "This org's rows (acme) — the deployment's are an owner's.", false]);
  assert.deepEqual(ada.rows[0], { seq: 12, iso: '2026-10-06T10:00:00.000Z', when: '2026-10-06T10:00:00.000Z', org: null, actor: 'ada', action: 'membership.role', target: 'user 3', detailJson: JSON.stringify(rows[0].detail, null, 2) });
  assert.equal(typeof ada.rows[0].detailJson, 'string');
  assert.equal(ada.rows[1].target, 'store');
  assert.equal(ada.rows[1].detailJson, 'null');
  assert.deepEqual([ada.more, ada.end], [true, null]);
  assert.ok(AUDIT_KINDS.includes('issuer') && AUDIT_KINDS.includes('store') && AUDIT_KINDS.includes('mcp_endpoint'));
  const olive = buildAuditSectionModel({ doc: { scope: 'all', org: null, rows: [rows[0]], next: null }, rows: [rows[0]], filters: {}, access: OLIVE, orgId: 'acme', formatTime: () => 'local' });
  assert.equal(olive.caption, '1 row, newest first · scope all');
  assert.deepEqual(olive.scopeControl.options.map((o) => [o.value, o.label]), [['all', 'all'], ['org', 'this org (acme)'], ['deployment', "the deployment's own rows"]]);
  assert.deepEqual([olive.scopeControl.value, olive.scopeSentence, olive.showOrg, olive.rows[0].org, olive.rows[0].when], ['all', null, true, 'acme', 'local']);
  assert.deepEqual([olive.more, olive.end], [false, 'No older rows.']);
  const before = buildAuditSectionModel({ doc: null, rows: [], access: ADA, orgId: 'acme' });
  assert.deepEqual([before.caption, before.more, before.end, before.canRead], [null, false, null, true]);
  assert.deepEqual([buildAuditSectionModel({ access: OSCAR }).canRead, buildAuditSectionModel({ access: OSCAR }).reason], [false, 'needs the admin role in Acme — yours is operator; ask an admin of Acme']);
});

// ---------- the MCP target ----------

test('mcpTargetModel: the list first, "Type a URL…" last; the preselection order; the auth help by purpose', () => {
  const m = mcpTargetModel({ endpoints: EP_OP, purpose: 'read', orgName: 'Acme' });
  assert.deepEqual(m.options.map((o) => [o.value, o.label]), [['3', 'gw — https://mcp.acme.test'], ['5', 'spare — https://spare.acme.test'], ['', 'Type a URL…']]);
  assert.deepEqual([m.show, m.value, m.showUrl], [true, '3', false], 'the first endpoint when nothing else says');
  assert.equal(m.authHelp, 'Optional — empty uses OBSERVOGRAM_ORG_ACME_MCP_TOKEN on the server.');
  // remembered > live > remembered typed URL > first > typed.
  assert.equal(mcpTargetModel({ endpoints: EP_OP, remembered: 5, liveUrl: 'https://mcp.acme.test/obs', typedUrl: 'https://x.test' }).value, '5');
  assert.equal(mcpTargetModel({ endpoints: EP_OP, remembered: 99, liveUrl: 'https://spare.acme.test/mcp', typedUrl: 'https://x.test' }).value, '5', 'a remembered id no longer listed is skipped');
  const typed = mcpTargetModel({ endpoints: EP_OP, typedUrl: 'https://x.test' });
  assert.deepEqual([typed.value, typed.showUrl, typed.authHelp], ['', true, null]);
  assert.equal(mcpTargetModel({ endpoints: EP_OP, typedUrl: '   ' }).value, '3');
  assert.equal(mcpTargetModel({ endpoints: EP_OP, remembered: 5 }).authHelp, 'Optional — this endpoint names no token variable; send one here if the server needs it.');
  assert.equal(mcpTargetModel({ endpoints: EP_VIEWER }).authHelp, 'Optional.');
  assert.equal(mcpTargetModel({ endpoints: EP_OP, purpose: 'write' }).authHelp, "MCP client key — a write token, sent with this request only, never stored. (The endpoint's read variable is never used to write.)");
  // null (not read, failed) → typed only, no hint; [] → the hint, a button only when can.admin is known (C-7).
  const unread = mcpTargetModel({ endpoints: null, typedUrl: 'https://x.test' });
  assert.deepEqual([unread.show, unread.value, unread.showUrl, unread.hint, unread.options.length], [false, '', true, null, 1]);
  assert.deepEqual(mcpTargetModel({ endpoints: [], orgName: 'Acme' }).hint, { text: 'No MCP endpoint is registered in Acme yet — an admin registers them.', button: null });
  assert.deepEqual(mcpTargetModel({ endpoints: [], orgName: 'Acme', canAdmin: true }).hint, { text: 'No MCP endpoint is registered in Acme yet.', button: 'Settings → MCP endpoints' });
});

test('mcpTargetBody: an id or a URL, never both; null for nothing (T23)', () => {
  assert.deepEqual(mcpTargetBody('3', 'https://typed.test', ''), { mcpEndpointId: 3 }, 'the typed URL never rides with an id');
  assert.deepEqual(mcpTargetBody(3, '', ' key '), { mcpEndpointId: 3, mcpAuth: 'key' });
  assert.deepEqual(mcpTargetBody('', ' https://typed.test ', 'k'), { mcpUrl: 'https://typed.test', mcpAuth: 'k' });
  assert.deepEqual(mcpTargetBody('', 'https://typed.test', '  '), { mcpUrl: 'https://typed.test' });
  assert.equal(mcpTargetBody('', '', 'k'), null);
  assert.equal(mcpTargetBody(null, '   ', null), null);
  assert.deepEqual(mcpTargetBody(undefined, 'u', undefined), { mcpUrl: 'u' });
  for (const [sel, url] of [['3', 'u'], ['', 'u'], [5, ''], ['abc', 'u'], ['0', 'u']]) {
    const body = mcpTargetBody(sel, url, 'k');
    assert.ok(!(body && 'mcpUrl' in body && 'mcpEndpointId' in body), `never both for ${sel}`);
  }
  assert.deepEqual(mcpTargetBody('0', 'u', ''), { mcpUrl: 'u' }, 'not an id → the typed URL');
});

test('profileEndpointNote: a profile names its endpoint per org (A-12); endpointDrift refuses to send to a moved or gone endpoint (C-3)', () => {
  const p = { name: 'p1', mcpUrl: '', mcpEndpoint: { orgId: 'acme', id: 3, name: 'gw' } };
  assert.deepEqual(profileEndpointNote(p, { orgId: 'acme', orgName: 'Acme', endpoints: EP_OP }), { select: 3, note: null });
  const other = profileEndpointNote(p, { orgId: 'bravo', orgName: 'Bravo', endpoints: [{ ...EP_OP[0], id: 3 }] });
  assert.deepEqual(other, { select: null, note: 'Profile "p1" names MCP endpoint "gw" of acme — choose one of Bravo\'s, or type a URL.' }, 'another org: never sent, even when the id exists there');
  assert.equal(profileEndpointNote(p, { orgId: 'acme', orgName: 'Acme', endpoints: [EP_OP[1]] }).select, null, 'gone from the list');
  assert.equal(profileEndpointNote(p, { orgId: 'acme', orgName: 'Acme', endpoints: null }).select, null, 'the list unread');
  assert.equal(profileEndpointNote({ mcpUrl: 'https://x' }, { orgId: 'acme', endpoints: EP_OP }).note, null, 'a typed profile: nothing to say');
  assert.match(profileEndpointNote({ mcpEndpoint: { orgId: 'acme', id: 3, name: 'gw' } }, { orgId: 'bravo', orgName: 'Bravo', profileName: 'nightly' }).note, /^Profile "nightly"/);
  const shown = { id: 3, name: 'gw', origin: 'https://mcp.acme.test' };
  assert.equal(endpointDrift(shown, EP_OP, { orgName: 'Acme' }), null);
  assert.equal(endpointDrift(shown, [{ ...EP_OP[0], origin: 'https://mcp2.acme.test' }], { orgName: 'Acme' }), 'gw now points at https://mcp2.acme.test (it showed https://mcp.acme.test) — check the target and send again.');
  assert.equal(endpointDrift(shown, [EP_OP[1]], { orgName: 'Acme' }), "gw is no longer one of Acme's MCP endpoints — choose another or type a URL.");
  assert.equal(endpointDrift(shown, null, { orgName: 'Acme' }), "gw could not be checked against Acme's MCP endpoints just now — send again, or type a URL.");
  assert.equal(endpointDrift(null, EP_OP), null, 'a typed URL: nothing to check');
});

// ---------- the loaders ----------

test('the loaders: one requestJson call each, ids encoded, JSON bodies, the answer unwrapped — and no email kept', async () => {
  const calls = [];
  const answer = {
    ok: true, endpoints: EP_OP, endpoint: EP_OP[0], changed: ['url'], deleted: EP_OP[0], unbound: [3, 7], environment: PAYMENT.environments[0],
    org: { id: 'acme', name: 'Acme', default: false }, members: MEMBERS_RAW, member: MEMBERS_RAW[1], added: false, removed: MEMBERS_RAW[1],
    scope: 'org', rows: [], next: null,
  };
  const fetchFn = async (path, opts) => { calls.push([path, opts?.method ?? 'GET', opts?.body ?? null, opts?.headers?.['Content-Type'] ?? null]); return answer; };
  assert.deepEqual(await loadMcpEndpoints({ fetchFn }), EP_OP);
  assert.deepEqual(await createEndpoint({ name: 'gw', url: 'u' }, { fetchFn }), EP_OP[0]);
  assert.deepEqual(await patchEndpoint(3, { url: 'u' }, { fetchFn }), { endpoint: EP_OP[0], changed: ['url'] });
  assert.deepEqual(await deleteEndpoint(3, { fetchFn }), { deleted: EP_OP[0], unbound: [3, 7] });
  assert.deepEqual(await createEnvironment('1/x', { name: 'qa' }, { fetchFn }), PAYMENT.environments[0]);
  assert.deepEqual(await patchEnvironment(4, { tier: null }, { fetchFn }), { environment: PAYMENT.environments[0], changed: ['url'] });
  assert.deepEqual(await deleteEnvironment(4, { fetchFn }), EP_OP[0]);
  const members = await loadMembers({ fetchFn });
  assert.deepEqual(members, { org: { id: 'acme', name: 'Acme', default: false }, members: MEMBERS.map((m) => ({ ...m, name: m.name ?? null })) });
  assert.ok(!JSON.stringify(members).includes('@'), 'C-8: loadMembers drops every email');
  const added = await addMember({ login: 'oscar', role: 'admin' }, { fetchFn });
  assert.deepEqual([added.added, added.member.login, 'email' in added.member], [false, 'oscar', false]);
  const patched = await patchMember(3, 'admin', { fetchFn });
  assert.equal('email' in patched.member, false);
  assert.equal('email' in (await removeMember(3, { fetchFn })), false);
  assert.deepEqual(await renameOrg('Acme Corp', { fetchFn }), { id: 'acme', name: 'Acme', default: false });
  assert.equal((await loadAudit('?limit=100', { fetchFn })).scope, 'org');
  assert.deepEqual(calls, [
    ['/api/mcp-endpoints', 'GET', null, null],
    ['/api/mcp-endpoints', 'POST', '{"name":"gw","url":"u"}', 'application/json'],
    ['/api/mcp-endpoints/3', 'PATCH', '{"url":"u"}', 'application/json'],
    ['/api/mcp-endpoints/3', 'DELETE', null, null],
    ['/api/services/1%2Fx/environments', 'POST', '{"name":"qa"}', 'application/json'],
    ['/api/environments/4', 'PATCH', '{"tier":null}', 'application/json'],
    ['/api/environments/4', 'DELETE', null, null],
    ['/api/org/members', 'GET', null, null],
    ['/api/org/members', 'POST', '{"login":"oscar","role":"admin"}', 'application/json'],
    ['/api/org/members/3', 'PATCH', '{"role":"admin"}', 'application/json'],
    ['/api/org/members/3', 'DELETE', null, null],
    ['/api/org', 'PATCH', '{"name":"Acme Corp"}', 'application/json'],
    ['/api/audit?limit=100', 'GET', null, null],
  ]);
  // Empty answers read as empty, never a throw; a refusal is thrown as the server's sentence.
  const blank = async () => ({});
  assert.deepEqual(await loadMcpEndpoints({ fetchFn: blank }), []);
  assert.deepEqual(await loadMembers({ fetchFn: blank }), { org: null, members: [] });
  assert.deepEqual(await deleteEndpoint(1, { fetchFn: blank }), { deleted: null, unbound: [] });
  assert.deepEqual(await patchEnvironment(1, {}, { fetchFn: blank }), { environment: null, changed: [] });
  await assert.rejects(createEndpoint({}, { fetchFn: async () => { throw servicesRefusal(400, { ok: false, error: 'an MCP endpoint name is 1–200 characters' }); } }), { message: '400: an MCP endpoint name is 1–200 characters' });
});

// ---------- what this build draws (B3) ----------

test('a section whose editor is not built draws no primary and no row Edit, and its empty line names no control', () => {
  const env = buildEnvironmentsSectionModel({ services: SERVICES, access: OSCAR, orgName: 'Acme', editable: false });
  assert.equal(env.primary, null);
  assert.ok(env.groups.every((g) => g.envs.every((e) => e.canEdit === false)));
  assert.equal(buildEnvironmentsSectionModel({ services: [LEDGER], access: OSCAR, orgName: 'Acme', editable: false }).empty, 'No environments in Acme yet.');
  const none = buildEnvironmentsSectionModel({ services: [], access: OSCAR, orgName: 'Acme', editable: false });
  assert.deepEqual([none.primary, none.build], [null, true], 'Build is built: the no-service line keeps its button');
  assert.equal(buildEnvironmentsSectionModel({ services: null, access: OSCAR, error: '500: boom', editable: false }).primary, null);
  const ep = buildEndpointsSectionModel({ endpoints: [], access: ADA, orgName: 'Acme', editable: false });
  assert.deepEqual([ep.primary, ep.empty], [null, 'No MCP endpoints in Acme yet.']);
});

// ---------- the renderer (studio/settings-view.mjs) ----------

// A headless container: the markup as a string; the controls the renderer wires are read back from it
// (an id, a nav item's data-section, the Open service buttons), so a click fires without a DOM.
function settingsContainer() {
  let html = '';
  const els = new Map();
  const fakeEl = (dataset = {}) => {
    const handlers = {};
    const attrs = {};
    let why = null;
    return {
      dataset, attrs, classes: new Set(),
      get classList() { const self = this; return { add: (c) => self.classes.add(c) }; },
      setAttribute: (k, v) => { attrs[k] = String(v); },
      getAttribute: (k) => attrs[k] ?? null,
      querySelector: (sel) => (sel === '.svc-why' ? why : null),
      insertAdjacentHTML: () => { why = { textContent: '' }; },
      get why() { return why; },
      addEventListener: (t, fn) => { handlers[t] = fn; }, fire: (t) => handlers[t]?.(),
    };
  };
  const get = (key, present, dataset) => {
    if (!present) return null;
    if (!els.has(key)) els.set(key, fakeEl(dataset));
    return els.get(key);
  };
  return {
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; els.clear(); },
    querySelector: (sel) => {
      const id = /^#([\w-]+)$/.exec(sel)?.[1];
      if (id) return get(sel, html.includes(`id="${id}"`));
      const nav = /^\.set-nav-item\[data-section="([\w-]+)"\]$/.exec(sel)?.[1];
      if (nav) return get(sel, html.includes(`class="set-nav-item" data-section="${nav}"`), { section: nav });
      return null;
    },
    querySelectorAll: (sel) => (sel === '[data-open-service]'
      ? [...html.matchAll(/data-open-service="(\d+)"/g)].map((m) => get(`open:${m[1]}`, true, { openService: m[1] }))
      : []),
  };
}

test('renderSettings: the head, the banner as served, the nav by rank, the environments and the endpoints escaped, the status line and its buttons', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const xss = '<img src=x onerror="window.__x=1">';
  const services = [{ ...PAYMENT, name: `Pay ${xss}` }, LEDGER];
  // An operator in Acme, both sections built: the environments.
  const frame = buildSettingsFrameModel({ access: OSCAR, section: 'environments', orgName: 'Acme', orgId: 'acme' });
  const c = settingsContainer();
  renderSettings(c, frame, { id: 'environments', head: settingsSectionHead('environments', { orgName: 'Acme' }), model: buildEnvironmentsSectionModel({ services, access: OSCAR, orgName: 'Acme', editable: false }), status: { kind: 'ok', text: '' } }, host);
  const h = c.innerHTML;
  assert.ok(h.includes('<section class="set-page" aria-labelledby="set-title">'));
  assert.ok(h.includes('<h1 class="set-title" id="set-title" tabindex="-1">Settings</h1>'));
  assert.ok(h.includes('<p class="set-scope">Settings · Acme (acme) · you are operator</p>'));
  assert.ok(h.includes('<nav class="set-nav" aria-label="Settings sections">'));
  assert.deepEqual([...h.matchAll(/class="set-nav-item" data-section="([\w-]+)" aria-current="(\w+)"/g)].map((m) => [m[1], m[2]]), [['environments', 'page'], ['endpoints', 'false']], 'the built sections only, the one on screen current');
  assert.ok(!h.includes('<img') && h.includes('Pay &lt;img src=x onerror=&quot;window.__x=1&quot;&gt;'), 'a service name is escaped');
  assert.ok(h.includes('tier-1 · MCP: gw — https://mcp.acme.test · 2 bindings · 1 link'));
  assert.ok(h.includes('no environments'), 'a service with none says so');
  assert.ok(!/set-banner|Edit…|Add environment|New MCP endpoint/.test(h), 'no banner in the identity posture; no control this build does not have');
  assert.ok(h.includes('role="status" aria-live="polite"'));
  c.querySelector('#set-back').fire('click');
  c.querySelector('.set-nav-item[data-section="endpoints"]').fire('click');
  c.querySelectorAll('[data-open-service]')[0].fire('click');
  assert.deepEqual(calls, [['back'], ['selectSection', 'endpoints'], ['openService', 1]]);

  // A viewer's endpoints: name and origin only — the URL and the variable never reach the page.
  const vera = buildSettingsFrameModel({ access: VERA, section: 'endpoints', orgName: 'Acme', orgId: 'acme' });
  const c2 = settingsContainer();
  renderSettings(c2, vera, { id: 'endpoints', head: settingsSectionHead('endpoints', { orgName: 'Acme' }), model: buildEndpointsSectionModel({ endpoints: EP_OP, services: SERVICES, access: VERA, orgName: 'Acme', editable: false }), status: null }, host);
  assert.ok(c2.innerHTML.includes('https://mcp.acme.test') && !c2.innerHTML.includes('/obs') && !c2.innerHTML.includes('MCP_TOKEN'));

  // The token posture: the probe's sentence as the banner, as served and escaped.
  const tok = buildSettingsFrameModel({ access: TOKEN, section: 'environments', orgName: 'Default', orgId: 'default', builtSections: ['environments', 'endpoints', 'members'] });
  const c3 = settingsContainer();
  calls.length = 0;
  renderSettings(c3, tok, { id: 'environments', head: settingsSectionHead('environments'), model: buildEnvironmentsSectionModel({ services: null, access: TOKEN, error: '500: <boom>', editable: false }), status: null }, host);
  assert.ok(c3.innerHTML.includes(`<div class="set-banner is-token" role="status">403: ${TOKEN_TEXT.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`));
  assert.ok(c3.innerHTML.includes('500: &lt;boom&gt; <button type="button" class="ux-secondary-btn" id="set-retry">Retry</button>'), 'a failed read: the refusal as served, and Retry');
  // A section the rank cannot read: drawn, aria-disabled with its reason; its click explains.
  const members = c3.querySelector('.set-nav-item[data-section="members"]');
  assert.equal(members.getAttribute('aria-disabled'), 'true');
  assert.equal(members.why.textContent, TOKEN_ACCESS.reason);
  members.fire('click');
  c3.querySelector('#set-retry').fire('click');
  assert.deepEqual(calls, [['explain', TOKEN_ACCESS.reason], ['retry', 'environments']]);

  // No service yet, an operator: the Build sentence and its button; reading: the status says so.
  const c4 = settingsContainer();
  calls.length = 0;
  renderSettings(c4, frame, { id: 'environments', head: settingsSectionHead('environments', { orgName: 'Acme' }), model: buildEnvironmentsSectionModel({ services: [], access: OSCAR, orgName: 'Acme', editable: false }), status: null }, host);
  assert.ok(c4.innerHTML.includes('No service in Acme yet — Build registers one (its DEFINE names the service). <button type="button" class="ux-secondary-btn" id="set-build">Build</button>'));
  c4.querySelector('#set-build').fire('click');
  assert.deepEqual(calls, [['build']]);
  const c5 = settingsContainer();
  renderSettings(c5, frame, { id: 'environments', head: settingsSectionHead('environments'), model: buildEnvironmentsSectionModel({ services: SERVICES, access: OSCAR, editable: false }), status: { kind: 'loading', text: 'Reading environments…' } }, host);
  assert.ok(c5.innerHTML.includes('aria-busy="true"') && c5.innerHTML.includes('>Reading environments…</p>'));

  // The static bundle: the banner alone — no nav, no section; a headless host never throws.
  const c6 = settingsContainer();
  renderSettings(c6, buildSettingsFrameModel({ access: STATIC }), null, { settings: {} });
  assert.ok(c6.innerHTML.includes(`<div class="set-banner is-static" role="status">${STATIC_ERR.message}</div>`));
  assert.ok(!c6.innerHTML.includes('set-nav') && !c6.innerHTML.includes('set-section'));
  assert.doesNotThrow(() => c6.querySelector('#set-back').fire('click'));
});

test('settings-view.mjs is a renderer module: it imports host.mjs, util.mjs and services-view.mjs only — never app.mjs or state.mjs — and reads no state, fetches nothing', () => {
  const src = readFileSync(new URL('../studio/settings-view.mjs', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(imports, ['./host.mjs', './services-view.mjs', './util.mjs']);
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bfetch\(|\bapi\(|\bstate\./.test(code), 'no fetch, no api(), no state');
  assert.ok(!/Observogram|OBSERVOGRAM/.test(code), 'the brand: no product name literal');
  assert.ok(!/\btitle="|\bhref="/.test(code), 'no title, no href built from data');
});
