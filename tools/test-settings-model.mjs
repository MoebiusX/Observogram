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
  buildSettingsEditorModel, buildEnvironmentPatch, buildEnvironmentCreate, buildEndpointPatch, buildEndpointCreate, buildMemberAddBody, leftOrgText,
  parseKeyValueLines, environmentSaveStatus, endpointSaveStatus, memberSaveStatus, orgRenameStatus, endpointDeleteStatus,
  lastAdmin, orgEnvPrefix, mcpTargetModel, mcpTargetBody, mcpPickerCanAdmin, profileEndpointNote, endpointDrift,
  mcpTargetMissingText, mcpRegisterCheck,
  noOwnerText, PASSWORD_ALPHABET, temporaryPassword, signInModeLine, buildUsersSectionModel, userActions, userActionStatus,
  buildUserCreateBody, userCreateStatus,
  activeOrgChoice, isActingOrg, orgChipEntries, orgChipLabel, actingRecovery,
  buildOrgsSectionModel, buildOrgCreateBody, orgCreateStatus, orgRemoveStatus, joinRoleModeSentence, buildJoinRoleSectionModel, joinRoleBody, joinRoleStatus,
} from '../studio/settings-model.mjs';
import {
  loadMcpEndpoints, createEndpoint, patchEndpoint, deleteEndpoint, createEnvironment, patchEnvironment, deleteEnvironment,
  loadMembers, addMember, patchMember, removeMember, renameOrg, loadAudit,
  loadUsers, createUser, userAction, setOwner, loadAdminOrgs, loadJoinRole, createOrg, removeOrg, putJoinRole,
} from '../studio/settings-api.mjs';
import { accessModel, TIER_BY_PACK } from '../studio/services-model.mjs';
import { renderSettings, renderSettingsEditor, renderMcpTarget, readAuditDrafts } from '../studio/settings-view.mjs';
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
  // The token posture: the probe's 403 is the banner, verbatim; every write carries 6a's one reason (B16);
  // the admin's and the owner's reads (why.read) point at the banner — never the operator role, which opens neither (§3.3).
  assert.deepEqual(TOKEN.banner, { kind: 'token', text: `403: ${TOKEN_TEXT}` });
  assert.deepEqual(TOKEN.can, { operate: false, admin: false, own: false, createOrg: false });
  for (const k of ['operate', 'admin', 'own', 'createOrg']) assert.equal(TOKEN.why[k], TOKEN_ACCESS.reason, `token why.${k}`);
  assert.deepEqual(TOKEN.why.read, { admin: 'needs the admin role and a signed-in user — the banner above names the way in', own: 'needs a signed-in owner — the banner above names the way in' });
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
  assert.deepEqual(BUILT_SECTIONS, SETTINGS_SECTIONS, 'the sections this build draws: the org\'s four and the deployment\'s three');
  assert.deepEqual(BUILT_EDITORS, ['endpoint', 'environment', 'org-name', 'member-add', 'member', 'user-create', 'user', 'org-create', 'org', 'join-role'], 'the record editors this build draws: the MCP endpoint, the environment, the org name, the member editors, the user editors, the organisation editors and the join role');
  const FOUR = ['environments', 'endpoints', 'members', 'audit'];
  assert.deepEqual(buildSettingsFrameModel({ access: OLIVE }).nav.map((n) => n.id), BUILT_SECTIONS, 'the default nav is the built sections (an owner\'s)');
  assert.deepEqual(buildSettingsFrameModel({ access: ADA }).nav.map((n) => n.id), FOUR, 'a non-owner\'s nav: the org\'s sections — the deployment\'s collapse into one line');
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
  // The token posture: environments and endpoints readable, members and audit disabled with the banner's pointer.
  const token = buildSettingsFrameModel({ access: TOKEN, orgName: 'Default', orgId: 'default', builtSections: FOUR });
  assert.equal(token.scope, 'Settings · Default (default) · you are viewer');
  assert.deepEqual(token.nav.filter((n) => !n.enabled).map((n) => [n.id, n.reason]), [['members', TOKEN.why.read.admin], ['audit', TOKEN.why.read.admin]]);
  assert.ok(token.nav.every((n) => n.reason !== TOKEN_ACCESS.reason), 'no read names the operator role');
  assert.equal(token.banner.kind, 'token');
  // The token posture whose probe FAILED (no answer, or a 5xx): the banner shows that failure, which names no way
  // in — so the nav's reason does not point at it; it says what is true (the read failed) and what works (reload).
  const failedNav = (probe) => buildSettingsFrameModel({ access: settingsAccessModel({ access: TOKEN_ACCESS, probe }), builtSections: FOUR })
    .nav.filter((n) => !n.enabled).map((n) => [n.id, n.reason]);
  const FAILED_ADMIN = 'needs the admin role and a signed-in user — the read above failed; reload this page to retry';
  for (const probe of [new TypeError('Failed to fetch'), refused(500, { ok: false, error: 'boom' })]) {
    const tokenFailed = settingsAccessModel({ access: TOKEN_ACCESS, probe });
    assert.deepEqual(tokenFailed.banner, { kind: 'token', text: probe.message }, 'the failure is shown as is');
    assert.deepEqual(tokenFailed.why.read, { admin: FAILED_ADMIN, own: 'needs a signed-in owner — the read above failed; reload this page to retry' });
    assert.deepEqual(failedNav(probe), [['members', FAILED_ADMIN], ['audit', FAILED_ADMIN]], probe.message);
    assert.ok(failedNav(probe).every(([, r]) => !/names the way in/.test(r)), `${probe.message}: no claim the banner names a way in`);
  }
  // Before the probe answers there is no banner, and no reason points at one.
  assert.deepEqual(failedNav(null), [['members', 'needs the admin role and a signed-in user'], ['audit', 'needs the admin role and a signed-in user']]);
  // Static: the banner only — no nav, no section.
  const stat = buildSettingsFrameModel({ access: STATIC });
  assert.deepEqual([stat.nav, stat.section, stat.banner.kind, stat.scope], [[], null, 'static', 'Settings']);
  assert.equal(settingsSectionFor(STATIC, 'environments'), null);
  assert.equal(settingsSectionFor(CLOSED, 'members', FOUR), 'environments', 'closed: members falls back');
  assert.equal(settingsSectionFor(OLIVE, 'orgs', FOUR), 'environments', 'a section not built is never opened');
  assert.equal(settingsSectionFor(OLIVE, 'orgs'), 'orgs', 'Organisations is built, and an owner\'s');
  assert.equal(settingsSectionFor(ADA, 'join-role'), 'environments', 'the join role is an owner\'s');
  assert.equal(settingsSectionFor(ADA, 'users'), 'environments', 'a section the rank cannot read is never opened');
  assert.equal(settingsSectionFor(OLIVE, 'users'), 'users', 'Users is built, and an owner\'s');
  assert.equal(settingsSectionFor(ADA, 'members'), 'members', 'Members is built');
  assert.equal(settingsSectionFor(ADA, 'audit'), 'audit', 'the audit is built');
  // The heads: the title, the scope sentence naming the org, the reading line.
  assert.deepEqual(settingsSectionHead('environments', { orgName: 'Acme' }).loading, 'Reading environments…');
  assert.equal(settingsSectionHead('endpoints').loading, 'Reading MCP endpoints…');
  assert.equal(settingsSectionHead('endpoints').title, 'MCP endpoints');
  assert.match(settingsSectionHead('environments', { orgName: 'Acme' }).scope, /^Every environment of Acme's services — /);
  assert.match(settingsSectionHead('endpoints', { orgName: 'Acme' }).scope, /never its value\.$/);
  for (const id of BUILT_SECTIONS) assert.doesNotMatch(settingsSectionHead(id).scope ?? '', /slice|Settings →/, 'no roadmap wording, no control named that is not built');
});

test('the Advanced → Settings item\'s sub-line names every built section (§3.1) — and nothing not built', () => {
  const src = readFileSync(new URL('../studio/app.mjs', import.meta.url), 'utf8');
  const item = src.match(/data-action="settings">[\s\S]*?<span class="observa-adv-item-sub">([^<]*)<\/span>/);
  assert.ok(item, 'the Settings menu item carries a sub-line');
  const sub = item[1];
  const WORDS = { environments: /\benvironments\b/, endpoints: /\bMCP endpoints\b/, members: /\bmembers\b/, audit: /\baudit\b/, users: /\busers\b/, orgs: /\borganisations\b/, 'join-role': /\bthe join role\b/ };
  for (const id of BUILT_SECTIONS) assert.match(sub, WORDS[id] ?? /(?!)/, `the sub-line names the built section ${id}`);
  assert.doesNotMatch(sub, /slice/i, 'no roadmap wording');
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
  // A reader who cannot Build (a viewer, the token posture's anonymous reader) is told who registers one — no Build button,
  // no sentence offering Build as hers (the 6a home's viewer wording).
  for (const [who, access, text] of [
    ['vera', VERA, 'No service in Acme yet — an operator registers one with Build (its DEFINE names the service); your role in Acme is viewer.'],
    ['token', TOKEN, 'No service in Default yet — an operator registers one with Build (its DEFINE names the service); your role in Default is viewer.'],
  ]) {
    const m = buildEnvironmentsSectionModel({ services: [], access, orgName: access === TOKEN ? 'Default' : 'Acme' });
    assert.deepEqual([m.primary, m.empty, m.build], [{ enabled: false, reason: text }, text, false], who);
  }
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
  assert.deepEqual(m.remove, { enabled: true, reason: null }, 'Delete… for an operator');
  assert.equal(add.remove, null, 'a new record has no Delete…');
  const viewer = buildSettingsEditorModel('environment', prod, { ctx: { ...ctx, access: VERA } });
  assert.deepEqual(viewer.primary, { label: 'Save', enabled: false, reason: 'needs the operator role in Acme — yours is viewer' });
  assert.deepEqual(viewer.remove, { enabled: false, reason: 'needs the operator role in Acme — yours is viewer' });
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
  assert.deepEqual(op.rows[0], { id: 3, name: 'gw', origin: 'https://mcp.acme.test', url: 'https://mcp.acme.test/obs', tokenText: 'token: OBSERVOGRAM_ORG_ACME_MCP_TOKEN', boundText: 'checked by 2 environments: payment-service / prod, payment-service / staging', canEdit: false });
  // Edit… is an admin's (the editor's writes are admin class), and only once the editor is built.
  assert.deepEqual(buildEndpointsSectionModel({ endpoints: EP_OP, services: SERVICES, access: ADA, orgName: 'Acme' }).rows.map((r) => r.canEdit), [true, true]);
  assert.deepEqual(buildEndpointsSectionModel({ endpoints: EP_OP, services: SERVICES, access: ADA, orgName: 'Acme', editable: false }).rows.map((r) => r.canEdit), [false, false]);
  assert.deepEqual(buildEndpointsSectionModel({ endpoints: EP_VIEWER, access: CLOSED }).rows.map((r) => r.canEdit), [false, false]);
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
  // Delete… is a record's, an admin's; a new endpoint has none.
  assert.equal(create.remove, null);
  assert.deepEqual(edit.remove, { enabled: true, reason: null });
  assert.deepEqual(buildSettingsEditorModel('endpoint', gw, { ctx: { ...ctx, access: OSCAR } }).remove, { enabled: false, reason: 'needs the admin role in Acme — yours is operator; ask an admin of Acme' });
  // While a call is pending the primary is not usable, and says why.
  assert.deepEqual(buildSettingsEditorModel('endpoint', gw, { ctx, status: { kind: 'pending', text: 'Saving…' } }).primary, { label: 'Save', enabled: false, reason: 'Saving…' });
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
  assert.deepEqual(self.remove, { enabled: false, reason: 'ada is the last admin of Acme: only an owner can demote or remove them — make another member an admin first', label: 'Remove…' });
  assert.equal(self.fields[0].help, self.remove.reason, 'the role group says once why its other choices are unavailable');
  assert.equal(buildSettingsEditorModel('member', MEMBERS[1], { ctx }).fields[0].help, null, 'no lock, no help');
  const oscar = buildSettingsEditorModel('member', MEMBERS[1], { ctx, step: 'confirm-delete' });
  assert.equal(oscar.confirm.text, 'Remove oscar from Acme? Their sessions keep working elsewhere; here their next request is refused, unless they are an owner.');
  assert.equal(oscar.id, 3);
  // ada not the last admin any more: removing herself says so first.
  const two = [...MEMBERS, { userId: 9, login: 'abe', role: 'admin', disabled: false }];
  const leave = buildSettingsEditorModel('member', MEMBERS[0], { ctx: { ...ctx, members: two }, step: 'confirm-delete' });
  assert.equal(leave.confirm.text, 'Remove ada from Acme? Their sessions keep working elsewhere; here their next request is refused. This is you: you lose access to Acme at once.');
  // An owner removing herself: no "next request is refused" — an owner's never is (authz orgContext).
  const olive = { userId: 7, login: 'olive', role: 'admin', disabled: false };
  const ownerLeave = buildSettingsEditorModel('member', olive, { ctx: { ...ctx, access: OLIVE, me: 'olive', members: [olive] }, step: 'confirm-delete' });
  assert.ok(!/refused/.test(ownerLeave.confirm.text), ownerLeave.confirm.text);
  assert.equal(ownerLeave.confirm.text, "Remove olive from Acme? This is you: your membership changes, but as an owner you keep the admin role in Acme. olive is Acme's last admin: afterwards only an owner can manage its members, endpoints and audit.");
  assert.equal(leftOrgText('Acme'), 'You left Acme; this browser switches to your next organisation.');
  assert.equal(leftOrgText('Acme', true), 'You left Acme; as an owner you go on acting in it — this browser reloads.');
  // The flag the controller passes is the access model's owner bit (removeMemberEditor: settingsAccess().owner).
  assert.equal(leftOrgText('Acme', OLIVE.owner), 'You left Acme; as an owner you go on acting in it — this browser reloads.');
  assert.equal(leftOrgText('Acme', ADA.owner), 'You left Acme; this browser switches to your next organisation.');
  const demote = buildSettingsEditorModel('member', MEMBERS[0], { ctx: { ...ctx, members: two }, step: 'confirm-action', draft: { role: 'operator' } });
  assert.equal(demote.confirm.text, "Change ada's role to operator? This is you: you lose the admin role at once.");
  // An owner demoting the last admin: allowed, and warned (A12).
  const owner = buildSettingsEditorModel('member', MEMBERS[0], { ctx: { ...ctx, access: OLIVE, me: 'olive' }, step: 'confirm-action', draft: { role: 'viewer' } });
  assert.equal(owner.confirm.text, "Change ada's role to viewer? ada is Acme's last admin: afterwards only an owner can manage its members, endpoints and audit.");
  assert.equal(owner.remove.enabled, true);
  const rename = buildSettingsEditorModel('org-name', { id: 'acme', name: 'Acme' }, { ctx, draft: { name: 'Acme Corp' } });
  assert.deepEqual([rename.title, rename.draft, rename.fields[0].help], ['Rename Acme', { name: 'Acme Corp' }, 'The id acme stays; only the name changes.']);
  assert.throws(() => buildSettingsEditorModel('org-member', null, { ctx }), /no Settings editor of kind "org-member"/);
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
  assert.equal(buildAuditSectionModel({ access: TOKEN }).reason, TOKEN.why.read.admin, 'the token posture: the audit is a read — the banner, not the operator role');
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
  // The person's choice in the picker outranks every preselection: '' is Type a URL…, an id while listed.
  const typedChoice = mcpTargetModel({ endpoints: EP_OP, remembered: 5, chosen: '' });
  assert.deepEqual([typedChoice.value, typedChoice.showUrl, typedChoice.authHelp], ['', true, null]);
  assert.equal(mcpTargetModel({ endpoints: EP_OP, remembered: 3, chosen: '5' }).value, '5');
  assert.equal(mcpTargetModel({ endpoints: EP_OP, remembered: 5, chosen: '99' }).value, '5', 'a choice no longer listed falls back to the preselection');
  assert.deepEqual(m.options.map((o) => [o.name, o.origin]), [['gw', 'https://mcp.acme.test'], ['spare', 'https://spare.acme.test'], [null, null]], 'each option names its endpoint and the origin it shows');
  assert.equal(mcpTargetModel({ endpoints: EP_OP, remembered: 5 }).authHelp, 'Optional — this endpoint names no token variable; send one here if the server needs it.');
  assert.equal(mcpTargetModel({ endpoints: EP_VIEWER }).authHelp, 'Optional.');
  assert.equal(mcpTargetModel({ endpoints: EP_OP, purpose: 'write' }).authHelp, "MCP client key — a write token, sent with this request only, never stored. (The endpoint's read variable is never used to write.)");
  // null (not read, failed) → typed only, no hint; [] → the hint, a button only when can.admin is known (C-7).
  const unread = mcpTargetModel({ endpoints: null, typedUrl: 'https://x.test' });
  assert.deepEqual([unread.show, unread.value, unread.showUrl, unread.hint, unread.options.length], [false, '', true, null, 1]);
  assert.deepEqual(mcpTargetModel({ endpoints: [], orgName: 'Acme' }).hint, { text: 'No MCP endpoint is registered in Acme yet — an admin registers them.', button: null });
  assert.deepEqual(mcpTargetModel({ endpoints: [], orgName: 'Acme', canAdmin: true }).hint, { text: 'No MCP endpoint is registered in Acme yet.', button: 'Settings → MCP endpoints' });
});

test('mcpPickerCanAdmin: known true only — the identity posture at rank admin, or the open posture whose probe answered 200 for this org (C-7)', () => {
  const can = (posture, role, probe, orgId = 'acme') => mcpPickerCanAdmin({ access: { posture, role }, probe, orgId });
  assert.equal(can('identity', 'admin', null), true);
  for (const role of ['operator', 'viewer', null]) assert.equal(can('identity', role, null), false, `identity ${role}`);
  // Open on loopback: the probe's 200 says you act as local, an owner.
  assert.equal(can('open', null, { orgId: 'acme', ok: true }), true, 'open, the probe answered 200');
  assert.equal(can('open', null, null), false, 'open, no probe yet: not guessed');
  assert.equal(can('open', null, { orgId: 'acme', ok: false }), false, 'open-exposed: the probe was refused');
  assert.equal(can('open', null, { orgId: 'bravo', ok: true }), false, "another org's answer");
  for (const posture of ['token', 'static', 'unknown']) assert.equal(can(posture, 'admin', { orgId: 'acme', ok: true }), false, posture);
  assert.equal(mcpPickerCanAdmin(), false);
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
      const af = /^#set-audit-([\w-]+)$/.exec(sel)?.[1];
      if (af && af !== 'filters' && af !== 'more') {
        const el = get(sel, html.includes(`id="set-audit-${af}"`));
        if (el && el.value === undefined) {
          // A select's value is its selected option's; an input's its value attribute.
          const at = html.slice(html.indexOf(`id="set-audit-${af}"`));
          el.value = (at.startsWith(`id="set-audit-${af}" name="${af}">`) ? /<option value="([^"]*)" selected>/.exec(at)?.[1] : null) ?? /value="([^"]*)"/.exec(at)?.[1] ?? '';
        }
        return el;
      }
      const id = /^#([\w-]+)$/.exec(sel)?.[1];
      if (id) return get(sel, html.includes(`id="${id}"`));
      const nav = /^\.set-nav-item\[data-section="([\w-]+)"\]$/.exec(sel)?.[1];
      if (nav) return get(sel, html.includes(`class="set-nav-item" data-section="${nav}"`), { section: nav });
      if (sel === '.set-editor') {
        const el = get(sel, html.includes('class="set-editor"'));
        if (el && !el.attrs['data-editor-key']) el.attrs['data-editor-key'] = /data-editor-key="([^"]*)"/.exec(html)?.[1] ?? null;
        return el;
      }
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '[data-open-service]') return [...html.matchAll(/data-open-service="(\d+)"/g)].map((m) => get(`open:${m[1]}`, true, { openService: m[1] }));
      if (sel === '[data-edit-endpoint]') return [...html.matchAll(/data-edit-endpoint="(\d+)"/g)].map((m) => get(`edit:${m[1]}`, true, { editEndpoint: m[1] }));
      if (sel === '[data-edit-env]') return [...html.matchAll(/data-edit-env="(\d+)"/g)].map((m) => get(`env:${m[1]}`, true, { editEnv: m[1] }));
      const seg = /^\[data-seg="([\w-]+)"\]$/.exec(sel)?.[1];
      if (seg) {
        return [...html.matchAll(new RegExp(`data-seg="${seg}" data-value="([^"]*)" aria-checked="(\\w+)"( aria-disabled="true")?`, 'g'))].map((m) => {
          const el = get(`seg:${seg}:${m[1]}`, true, { seg, value: m[1] });
          if (m[3] && !el.attrs['aria-disabled']) el.attrs['aria-disabled'] = 'true';
          return el;
        });
      }
      if (sel === '[data-member-role]') return [...html.matchAll(/data-member-role="(\d+)"/g)].map((m) => get(`role:${m[1]}`, true, { memberRole: m[1] }));
      if (sel === '[data-member-remove]') return [...html.matchAll(/data-member-remove="(\d+)"/g)].map((m) => get(`remove:${m[1]}`, true, { memberRemove: m[1] }));
      if (sel === '[data-editor-close]') return [...html.matchAll(/data-editor-close/g)].map((_, i) => get(`close:${i}`, true));
      if (sel === '[data-user-manage]') return [...html.matchAll(/data-user-manage="(\d+)"/g)].map((m) => get(`user:${m[1]}`, true, { userManage: m[1] }));
      if (sel === '[data-user-action]') return [...html.matchAll(/data-user-action="([\w-]+)"/g)].map((m) => get(`uact:${m[1]}`, true, { userAction: m[1] }));
      if (sel === '[data-org-remove]') return [...html.matchAll(/data-org-remove="([\w-]+)"/g)].map((m) => get(`org:${m[1]}`, true, { orgRemove: m[1] }));
      if (sel === '[data-org-act]') return [...html.matchAll(/data-org-act="([\w-]+)"/g)].map((m) => get(`act:${m[1]}`, true, { orgAct: m[1] }));
      return [];
    },
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
  assert.deepEqual([...h.matchAll(/class="set-nav-item" data-section="([\w-]+)" aria-current="(\w+)"/g)].map((m) => [m[1], m[2]]), [['environments', 'page'], ['endpoints', 'false'], ['members', 'false'], ['audit', 'false']], 'the built sections only, the one on screen current');
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
  assert.equal(members.why.textContent, TOKEN.why.read.admin);
  members.fire('click');
  c3.querySelector('#set-retry').fire('click');
  assert.deepEqual(calls, [['explain', TOKEN.why.read.admin], ['retry', 'environments']]);

  // No service yet, an operator: the Build sentence and its button; reading: the status says so.
  const c4 = settingsContainer();
  calls.length = 0;
  renderSettings(c4, frame, { id: 'environments', head: settingsSectionHead('environments', { orgName: 'Acme' }), model: buildEnvironmentsSectionModel({ services: [], access: OSCAR, orgName: 'Acme', editable: false }), status: null }, host);
  assert.ok(c4.innerHTML.includes('No service in Acme yet — Build registers one (its DEFINE names the service). <button type="button" class="ux-secondary-btn" id="set-build">Build</button>'));
  c4.querySelector('#set-build').fire('click');
  assert.deepEqual(calls, [['build']]);
  const c4v = settingsContainer();
  renderSettings(c4v, frame, { id: 'environments', head: settingsSectionHead('environments', { orgName: 'Acme' }), model: buildEnvironmentsSectionModel({ services: [], access: VERA, orgName: 'Acme', editable: false }), status: null }, host);
  assert.ok(c4v.innerHTML.includes('No service in Acme yet — an operator registers one with Build (its DEFINE names the service); your role in Acme is viewer.'));
  assert.equal(c4v.querySelector('#set-build'), null, 'no Build control for a viewer');
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

test('the endpoints section: New MCP endpoint and Edit… for an admin; for an operator the primary unavailable with its reason and no Edit…', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const xss = '<img src=x onerror="window.__x=1">';
  const eps = [{ ...EP_OP[0], name: `gw ${xss}` }, EP_OP[1]];
  const ada = settingsContainer();
  renderSettings(ada, buildSettingsFrameModel({ access: ADA, section: 'endpoints', orgName: 'Acme', orgId: 'acme' }), { id: 'endpoints', head: settingsSectionHead('endpoints', { orgName: 'Acme' }), model: buildEndpointsSectionModel({ endpoints: eps, services: SERVICES, access: ADA, orgName: 'Acme' }), status: null }, host);
  const h = ada.innerHTML;
  assert.ok(h.includes('<button type="button" class="mcp-refresh-btn set-primary" id="set-primary">New MCP endpoint</button>'));
  assert.deepEqual([...h.matchAll(/data-edit-endpoint="(\d+)" aria-label="([^"]*)">Edit…/g)].map((m) => m[1]), ['3', '5']);
  assert.ok(!h.includes('<img') && h.includes('aria-label="Edit gw &lt;img src=x onerror=&quot;window.__x=1&quot;&gt;"'), 'the name in the label is escaped');
  assert.equal(ada.querySelector('#set-primary').getAttribute('aria-disabled'), null, 'usable');
  ada.querySelector('#set-primary').fire('click');
  ada.querySelectorAll('[data-edit-endpoint]')[1].fire('click');
  assert.deepEqual(calls, [['openEditor', { kind: 'endpoint' }], ['openEditor', { kind: 'endpoint', id: 5 }]]);

  calls.length = 0;
  const oscar = settingsContainer();
  renderSettings(oscar, buildSettingsFrameModel({ access: OSCAR, section: 'endpoints', orgName: 'Acme', orgId: 'acme' }), { id: 'endpoints', head: settingsSectionHead('endpoints', { orgName: 'Acme' }), model: buildEndpointsSectionModel({ endpoints: EP_OP, services: SERVICES, access: OSCAR, orgName: 'Acme' }), status: null }, host);
  assert.ok(!oscar.innerHTML.includes('data-edit-endpoint'), 'no Edit… for an operator: the row shows every fact');
  const primary = oscar.querySelector('#set-primary');
  assert.equal(primary.getAttribute('aria-disabled'), 'true');
  assert.equal(primary.why.textContent, 'needs the admin role in Acme — yours is operator; ask an admin of Acme');
  primary.fire('click');
  assert.deepEqual(calls, [['explain', 'needs the admin role in Acme — yours is operator; ask an admin of Acme']]);

  // What the last write did stays in the status line (a delete: the row is gone).
  const done = settingsContainer();
  renderSettings(done, buildSettingsFrameModel({ access: ADA, section: 'endpoints', orgName: 'Acme', orgId: 'acme' }), { id: 'endpoints', head: settingsSectionHead('endpoints', { orgName: 'Acme' }), model: buildEndpointsSectionModel({ endpoints: [], access: ADA, orgName: 'Acme' }), status: { kind: 'ok', text: 'Deleted <gw>.' } }, host);
  assert.ok(done.innerHTML.includes('>Deleted &lt;gw&gt;. No MCP endpoints in Acme yet. New MCP endpoint registers one.</p>'));
});

test('renderSettingsEditor: a modal dialog over one endpoint — the fields escaped, the variable named never a value, save / delete step / confirm, a repaint in place', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const ctx = { access: ADA, orgName: 'Acme', orgId: 'acme', services: SERVICES };
  const gw = { ...EP_OP[0], name: 'gw"><img src=x onerror=alert(1)>' };
  const c = settingsContainer();
  renderSettingsEditor(c, buildSettingsEditorModel('endpoint', gw, { ctx }), host);
  const h = c.innerHTML;
  assert.ok(h.includes('<div class="set-editor-scrim" data-editor-close aria-hidden="true"></div>'));
  assert.ok(h.includes('class="set-editor" role="dialog" aria-modal="true" aria-labelledby="set-editor-title" aria-describedby="set-editor-status" data-kind="endpoint" data-record-id="3" data-editor-key="endpoint:3:edit" tabindex="-1"'));
  assert.ok(h.includes('<div class="set-editor-status is-idle" id="set-editor-status" role="status" aria-live="polite">'));
  assert.ok(!h.includes('<img') && h.includes('value="gw&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'), 'a typed value is escaped');
  assert.ok(h.includes('<input id="set-edit-url" name="url" type="url" value="https://mcp.acme.test/obs" maxlength="2000" autocomplete="off" spellcheck="false" aria-describedby="set-edit-url-help">'));
  assert.ok(h.includes('<input id="set-edit-readTokenEnv" name="readTokenEnv" type="text" value="OBSERVOGRAM_ORG_ACME_MCP_TOKEN" autocomplete="off" spellcheck="false" autocapitalize="characters" aria-describedby="set-edit-readTokenEnv-help">'));
  assert.ok(h.includes('OBSERVOGRAM_ORG_ACME_&lt;NAME&gt;'), 'the prefix help, escaped');
  assert.ok(h.includes('id="set-editor-delete">Delete…</button>') && h.includes('id="set-editor-save" aria-disabled="false">Save</button>'));
  assert.ok(!/\btitle="/.test(h), 'no title attribute');
  c.querySelector('#set-edit-url').value = 'https://mcp2.acme.test/obs';
  c.querySelector('#set-editor-save').fire('click');
  c.querySelector('#set-editor-delete').fire('click');
  c.querySelectorAll('[data-editor-close]').forEach((el) => el.fire('click'));
  const draft = { name: gw.name, url: 'https://mcp2.acme.test/obs', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' };
  assert.deepEqual(calls, [['save', draft], ['step', 'confirm-delete', draft], ['closeEditor'], ['closeEditor'], ['closeEditor']]);

  // The same record and step again: the status and the buttons only — what was typed stays.
  calls.length = 0;
  const typed = c.querySelector('#set-edit-url');
  renderSettingsEditor(c, buildSettingsEditorModel('endpoint', gw, { ctx, status: { kind: 'pending', text: 'Saving…' } }), host);
  assert.equal(c.querySelector('#set-edit-url'), typed, 'not redrawn');
  assert.equal(c.querySelector('#set-editor-save').getAttribute('aria-disabled'), 'true');
  c.querySelector('#set-editor-save').fire('click');
  assert.deepEqual(calls, [], 'a second Save while one is pending does nothing');

  // The delete step: the consequence sentence, Back and the danger button naming the record.
  const d = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(d, buildSettingsEditorModel('endpoint', EP_OP[0], { ctx, step: 'confirm-delete' }), host);
  assert.ok(d.innerHTML.includes('<p class="set-confirm" id="set-editor-confirm-text">Delete gw? 2 environments are checked through it (payment-service / prod, payment-service / staging); they keep their rows, unbound.</p>'));
  assert.ok(d.innerHTML.includes('class="set-danger" id="set-editor-confirm" aria-disabled="false">Delete gw</button>') && !d.innerHTML.includes('set-edit-name'));
  d.querySelector('#set-editor-back').fire('click');
  d.querySelector('#set-editor-confirm').fire('click');
  assert.deepEqual(calls, [['step', 'edit'], ['confirm']]);

  // A rank that cannot write (the access downgraded while it was open): unavailable with the reason; the click explains.
  const o = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(o, buildSettingsEditorModel('endpoint', null, { ctx: { ...ctx, access: OSCAR } }), host);
  const save = o.querySelector('#set-editor-save');
  assert.deepEqual([save.getAttribute('aria-disabled'), save.why.textContent], ['true', 'needs the admin role in Acme — yours is operator; ask an admin of Acme']);
  assert.ok(!o.innerHTML.includes('set-editor-delete'), 'a new record has no Delete…');
  save.fire('click');
  assert.deepEqual(calls, [['explain', 'needs the admin role in Acme — yours is operator; ask an admin of Acme']]);
});

test('the environments section and editor: Add environment and Edit… for an operator; the select, the tier group and the textareas; a failed list keeps the binding (A4)', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const xss = '<img src=x onerror="window.__x=1">';
  // The section: the primary and one Edit… per environment, for an operator; none for a viewer.
  const op = settingsContainer();
  renderSettings(op, buildSettingsFrameModel({ access: OSCAR, section: 'environments', orgName: 'Acme', orgId: 'acme' }), { id: 'environments', head: settingsSectionHead('environments', { orgName: 'Acme' }), model: buildEnvironmentsSectionModel({ services: [{ ...PAYMENT, name: `Pay ${xss}` }, LEDGER], access: OSCAR, orgName: 'Acme' }), status: null }, host);
  assert.ok(op.innerHTML.includes('<button type="button" class="mcp-refresh-btn set-primary" id="set-primary">Add environment</button>'));
  assert.deepEqual([...op.innerHTML.matchAll(/data-edit-env="(\d+)" aria-label="([^"]*)">Edit…/g)].map((m) => [m[1], m[2]]), [['3', 'Edit prod of Pay &lt;img src=x onerror=&quot;window.__x=1&quot;&gt;'], ['7', 'Edit staging of Pay &lt;img src=x onerror=&quot;window.__x=1&quot;&gt;']]);
  op.querySelector('#set-primary').fire('click');
  op.querySelectorAll('[data-edit-env]')[1].fire('click');
  assert.deepEqual(calls, [['openEditor', { kind: 'environment' }], ['openEditor', { kind: 'environment', id: 7 }]]);
  const vw = settingsContainer();
  calls.length = 0;
  renderSettings(vw, buildSettingsFrameModel({ access: VERA, section: 'environments', orgName: 'Acme', orgId: 'acme' }), { id: 'environments', head: settingsSectionHead('environments', { orgName: 'Acme' }), model: buildEnvironmentsSectionModel({ services: SERVICES, access: VERA, orgName: 'Acme' }), status: null }, host);
  assert.ok(!vw.innerHTML.includes('data-edit-env'), 'no Edit… for a viewer: the row shows every fact');
  assert.equal(vw.querySelector('#set-primary').getAttribute('aria-disabled'), 'true');
  vw.querySelector('#set-primary').fire('click');
  assert.deepEqual(calls, [['explain', 'needs the operator role in Acme — yours is viewer']]);

  // The editor over prod: the endpoint select (the binding selected), the tier as a radio group, the textareas.
  const ctx = { access: OSCAR, orgName: 'Acme', orgId: 'acme', services: SERVICES, endpoints: EP_OP };
  const prod = PAYMENT.environments[0];
  const c = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(c, buildSettingsEditorModel('environment', prod, { ctx }), host);
  const h = c.innerHTML;
  assert.ok(h.includes('data-kind="environment" data-record-id="3" data-editor-key="environment:3:edit"'));
  assert.ok(h.includes('<select id="set-edit-mcpEndpointId" name="mcpEndpointId">'));
  assert.deepEqual([...h.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], Boolean(m[2]), m[3]]), [['', false, 'none'], ['3', true, 'gw — https://mcp.acme.test'], ['5', false, 'spare — https://spare.acme.test']]);
  assert.ok(h.includes('<div class="set-editor-field" role="radiogroup" aria-labelledby="set-edit-tier-label" aria-describedby="set-edit-tier-help">'));
  assert.deepEqual([...h.matchAll(/data-seg="tier" data-value="([^"]*)" aria-checked="(\w+)" tabindex="(-?\d)">([^<]*)</g)].map((m) => [m[1], m[2], m[3], m[4]]),
    [['tier-1', 'true', '0', 'tier-1'], ['tier-2', 'false', '-1', 'tier-2'], ['tier-3', 'false', '-1', 'tier-3'], ['', 'false', '-1', 'graded by the service']]);
  assert.ok(h.includes('<textarea id="set-edit-bindings" name="bindings" rows="4" spellcheck="false" aria-describedby="set-edit-bindings-help">cluster=eks\nnamespace=pay</textarea>'));
  assert.ok(h.includes('id="set-editor-delete">Delete…</button>') && h.includes('id="set-editor-save" aria-disabled="false">Save</button>'));
  // Save reads every field: the tier checked, the select's value, the textareas.
  c.querySelectorAll('[data-seg="tier"]')[3].fire('click');
  c.querySelector('#set-edit-mcpEndpointId').value = '5';
  c.querySelector('#set-editor-save').fire('click');
  assert.deepEqual(calls, [['save', { name: 'prod', tier: null, mcpEndpointId: '5', bindings: 'cluster=eks\nnamespace=pay', endpoints: 'dashboard=https://grafana.test/d/pay' }]]);
  assert.equal(c.querySelectorAll('[data-seg="tier"]')[3].getAttribute('aria-checked'), 'true');
  assert.deepEqual(buildEnvironmentPatch(prod, calls[0][1]), { tier: null, mcpEndpointId: 5 });

  // The list could not be read: the select aria-disabled with its reason; Save leaves the binding out (A4); a change is undone and explained.
  const f = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(f, buildSettingsEditorModel('environment', prod, { ctx: { ...ctx, endpoints: null, endpointsError: `403: ${xss}` } }), host);
  assert.ok(f.innerHTML.includes('<select id="set-edit-mcpEndpointId" name="mcpEndpointId" aria-disabled="true" aria-describedby="set-edit-mcpEndpointId-help">'));
  assert.ok(f.innerHTML.includes("The org&#39;s MCP endpoints could not be read — 403: &lt;img") && !f.innerHTML.includes('<img'));
  const sel = f.querySelector('#set-edit-mcpEndpointId');
  sel.value = '';
  sel.fire('change');
  f.querySelector('#set-editor-save').fire('click');
  assert.equal(calls[0][0], 'explain');
  assert.equal(calls[1][0], 'save');
  assert.equal(calls[1][1].mcpEndpointId, undefined, 'the binding is neither resent nor nulled');
  assert.deepEqual(buildEnvironmentPatch(prod, calls[1][1]), {});

  // Add: the service select first, Create, no Delete….
  const a = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(a, buildSettingsEditorModel('environment', null, { ctx: { ...ctx, serviceId: 2 } }), host);
  assert.ok(a.innerHTML.includes('<select id="set-edit-serviceId" name="serviceId">') && a.innerHTML.includes('<option value="2" selected>Ledger (ledger)</option>'));
  assert.ok(a.innerHTML.includes('id="set-editor-save" aria-disabled="false">Create</button>') && !a.innerHTML.includes('set-editor-delete'));
  a.querySelector('#set-edit-name').value = 'qa';
  a.querySelector('#set-editor-save').fire('click');
  assert.deepEqual(calls, [['save', { serviceId: 2, name: 'qa', tier: null, mcpEndpointId: null, bindings: '', endpoints: '' }]], 'a field untouched reads as drawn');
  assert.deepEqual(buildEnvironmentCreate(calls[0][1]), { name: 'qa' });
});

test('the members section: no email, "you" by login, Rename…, Add member, Change role… and Remove… — the last admin\'s Remove… unavailable with the rule, its click explains', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const xss = '<img src=x onerror="window.__x=1">';
  const raw = [...MEMBERS_RAW, { userId: 6, login: `eve${xss}`, kind: 'local', name: null, email: 'eve@acme.test', role: 'viewer', disabled: true, since: '2026-10-03T00:00:00.000Z' }];
  // What the loader keeps (no email), as the section reads it.
  const members = raw.map(strip);
  const model = buildMembersSectionModel({ members, org: { id: 'acme', name: 'Acme', default: false }, access: ADA, me: 'ada' });
  const c = settingsContainer();
  renderSettings(c, buildSettingsFrameModel({ access: ADA, section: 'members', orgName: 'Acme', orgId: 'acme' }), { id: 'members', head: settingsSectionHead('members', { orgName: 'Acme' }), model, status: null }, host);
  const h = c.innerHTML;
  assert.deepEqual([...h.matchAll(/class="set-nav-item" data-section="([\w-]+)"/g)].map((m) => m[1]), ['environments', 'endpoints', 'members', 'audit'], 'the org\'s four sections');
  assert.ok(h.includes('<p class="set-section-scope">The members of Acme (acme) and their roles.</p>'), 'the model\'s scope sentence');
  assert.ok(h.includes('<button type="button" class="mcp-refresh-btn set-primary" id="set-primary">Add member</button>'));
  assert.ok(h.includes('id="set-rename">Rename…</button>'));
  assert.ok(!/@acme\.test|x@y\.test/.test(h), 'C-8: no member email anywhere');
  assert.ok(!h.includes('<img') && h.includes('eve&lt;img src=x onerror=&quot;window.__x=1&quot;&gt;'), 'a login is escaped');
  assert.ok(/data-member-id="2">\s*<span class="set-row-name">ada<\/span>\s*<span class="set-you">you<\/span>/.test(h), '"you" on the reader\'s row');
  assert.ok(h.includes('<span class="set-row-meta">Ada · admin · since 2026-10-01</span>'));
  assert.ok(h.includes('<span class="set-badge is-disabled">disabled</span>'));
  const lock = 'ada is the last admin of Acme: only an owner can demote or remove them — make another member an admin first';
  const [adaRemove, oscarRemove] = c.querySelectorAll('[data-member-remove]');
  assert.deepEqual([adaRemove.getAttribute('aria-disabled'), adaRemove.why.textContent], ['true', lock]);
  assert.equal(oscarRemove.getAttribute('aria-disabled'), null);
  adaRemove.fire('click');
  oscarRemove.fire('click');
  c.querySelectorAll('[data-member-role]')[1].fire('click');
  c.querySelector('#set-rename').fire('click');
  c.querySelector('#set-primary').fire('click');
  assert.deepEqual(calls, [
    ['explain', lock],
    ['openEditor', { kind: 'member', id: 3, step: 'confirm-delete' }],
    ['openEditor', { kind: 'member', id: 3 }],
    ['openEditor', { kind: 'org-name', id: 'acme' }],
    ['openEditor', { kind: 'member-add' }],
  ]);
  // An owner passes the rule: every Remove… usable.
  const o = settingsContainer();
  renderSettings(o, buildSettingsFrameModel({ access: OLIVE, section: 'members', orgName: 'Acme', orgId: 'acme' }), { id: 'members', head: settingsSectionHead('members'), model: buildMembersSectionModel({ members, org: ACME, access: OLIVE, me: 'olive' }), status: null }, host);
  assert.ok(o.querySelectorAll('[data-member-remove]').every((b) => b.getAttribute('aria-disabled') === null));
  // A read refused: the server's sentence and Retry.
  const f = settingsContainer();
  renderSettings(f, buildSettingsFrameModel({ access: ADA, section: 'members' }), { id: 'members', head: settingsSectionHead('members'), model: buildMembersSectionModel({ members: null, org: ACME, access: ADA, error: '403: <no>' }), status: null }, host);
  assert.ok(f.innerHTML.includes('403: &lt;no&gt; <button type="button" class="ux-secondary-btn" id="set-retry">Retry</button>'));
});

test('the member editors: the role group with the locked choices unavailable, Remove…, the confirm step for one\'s own role; Add member by login or verified email', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const ctx = { access: ADA, orgName: 'Acme', orgId: 'acme', members: MEMBERS, me: 'ada' };
  const c = settingsContainer();
  renderSettingsEditor(c, buildSettingsEditorModel('member', MEMBERS[0], { ctx }), host);
  const h = c.innerHTML;
  assert.ok(h.includes('data-kind="member" data-record-id="2" data-editor-key="member:2:edit"'));
  assert.ok(h.includes('role="radiogroup" aria-labelledby="set-edit-role-label" aria-describedby="set-edit-role-help"'));
  assert.deepEqual([...h.matchAll(/data-seg="role" data-value="(\w+)" aria-checked="(\w+)"( aria-disabled="true")?/g)].map((m) => [m[1], m[2], Boolean(m[3])]), [['viewer', 'false', true], ['operator', 'false', true], ['admin', 'true', false]]);
  const lock = 'ada is the last admin of Acme: only an owner can demote or remove them — make another member an admin first';
  assert.ok(h.includes(`<span class="set-editor-help" id="set-edit-role-help">${lock}</span>`), 'the reason said once, under the group');
  assert.ok(h.includes('id="set-editor-delete">Remove…</button>'));
  assert.ok(!h.includes('@acme.test'));
  // A locked choice is not taken: its click explains; Save sends the role still checked.
  c.querySelectorAll('[data-seg="role"]')[0].fire('click');
  c.querySelector('#set-editor-save').fire('click');
  c.querySelector('#set-editor-delete').fire('click');
  assert.deepEqual(calls, [['explain', lock], ['save', { role: 'admin' }], ['explain', lock]]);

  // oscar (not locked): a choice is taken and sent.
  calls.length = 0;
  const o = settingsContainer();
  renderSettingsEditor(o, buildSettingsEditorModel('member', MEMBERS[1], { ctx }), host);
  o.querySelectorAll('[data-seg="role"]')[2].fire('click');
  o.querySelector('#set-editor-save').fire('click');
  assert.deepEqual(calls, [['save', { role: 'admin' }]]);

  // The confirm step for one's own role: the sentence, Back and the danger button.
  calls.length = 0;
  const two = [...MEMBERS, { userId: 9, login: 'abe', role: 'admin', disabled: false }];
  const d = settingsContainer();
  renderSettingsEditor(d, buildSettingsEditorModel('member', MEMBERS[0], { ctx: { ...ctx, members: two }, step: 'confirm-action', draft: { role: 'operator' } }), host);
  assert.ok(d.innerHTML.includes("<p class=\"set-confirm\" id=\"set-editor-confirm-text\">Change ada&#39;s role to operator? This is you: you lose the admin role at once.</p>"));
  assert.ok(d.innerHTML.includes('id="set-editor-confirm" aria-disabled="false">Make ada operator</button>'));
  d.querySelector('#set-editor-back').fire('click');
  d.querySelector('#set-editor-confirm').fire('click');
  assert.deepEqual(calls, [['step', 'edit'], ['confirm']]);

  // Add member: by login or by verified email (a radio group), the value, the role (operator by default).
  calls.length = 0;
  const a = settingsContainer();
  renderSettingsEditor(a, buildSettingsEditorModel('member-add', null, { ctx }), host);
  assert.deepEqual([...a.innerHTML.matchAll(/data-seg="by" data-value="(\w+)" aria-checked="(\w+)"/g)].map((m) => [m[1], m[2]]), [['login', 'true'], ['email', 'false']]);
  assert.ok(a.innerHTML.includes('<input id="set-edit-value" name="value" type="text" value="" maxlength="200" autocomplete="off" spellcheck="false">'));
  a.querySelector('#set-edit-value').value = 'oscar';
  a.querySelector('#set-editor-save').fire('click');
  assert.deepEqual(calls, [['save', { by: 'login', value: 'oscar', role: 'operator' }]]);

  // Rename: the name, the id that stays.
  const r = settingsContainer();
  renderSettingsEditor(r, buildSettingsEditorModel('org-name', { id: 'acme', name: 'Acme' }, { ctx }), host);
  assert.ok(r.innerHTML.includes('<input id="set-edit-name" name="name" type="text" value="Acme" maxlength="200"') && r.innerHTML.includes('The id acme stays; only the name changes.'));
  assert.ok(!r.innerHTML.includes('set-editor-delete'), 'an org is not removed here');
});

test('the audit section: the filters (the scope an owner\'s), the kinds listed, the rows escaped — the detail inside <details>, the time in <time>; Apply and Older rows', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const xss = '<img src=x onerror="window.__x=1">';
  const rows = [
    { seq: 12, at: '2026-10-06T10:00:00.000Z', orgId: 'acme', actor: `ada${xss}`, action: 'membership.role', targetKind: 'user', targetId: '3', detail: { from: 'operator', to: 'admin', note: xss } },
    { seq: 11, at: '2026-10-06T09:00:00.000Z', orgId: 'acme', actor: 'cli', action: 'org.rename', targetKind: 'org', targetId: 'acme', detail: null },
  ];
  const filters = { kind: 'membership', from: '2026-10-06', through: '2026-10-06' };
  const model = buildAuditSectionModel({ doc: { scope: 'org', org: 'acme', rows, next: 11 }, rows, filters, access: ADA, orgId: 'acme', formatTime: () => 'local time' });
  const c = settingsContainer();
  renderSettings(c, buildSettingsFrameModel({ access: ADA, section: 'audit', orgName: 'Acme', orgId: 'acme' }), { id: 'audit', head: settingsSectionHead('audit', { orgName: 'Acme' }), model, status: null, filters }, host);
  const h = c.innerHTML;
  assert.ok(h.includes("<p class=\"set-section-scope\">This org&#39;s rows (acme) — the deployment&#39;s are an owner&#39;s.</p>"), 'an admin is told the scope, no control');
  assert.ok(!h.includes('id="set-audit-scope"'));
  assert.ok(h.includes('<form class="set-audit-filters" id="set-audit-filters" aria-label="Filter the audit">'));
  assert.ok(h.includes('<input id="set-audit-kind" name="kind" type="text" value="membership" list="set-audit-kinds"'));
  assert.ok(h.includes('<input id="set-audit-from" name="from" type="date" value="2026-10-06"') && h.includes('<input id="set-audit-through" name="through" type="date" value="2026-10-06"'));
  assert.ok(h.includes('a login, local, token, system or cli — as the rows show it'));
  assert.deepEqual([...h.matchAll(/<option value="([\w_]+)"><\/option>/g)].map((m) => m[1]), AUDIT_KINDS, 'the datalist: the kinds the server writes');
  assert.ok(h.includes('<caption>2 rows, newest first · scope org · org acme</caption>'));
  assert.ok(!h.includes('<th scope="col">Org</th>'), 'one org: no org column');
  assert.ok(h.includes('<td><time datetime="2026-10-06T10:00:00.000Z">local time</time></td>'));
  assert.ok(!h.includes('<img') && h.includes('<td class="set-audit-actor">ada&lt;img src=x onerror=&quot;window.__x=1&quot;&gt;</td>'), 'the actor as served, escaped');
  assert.ok(/<td class="set-audit-detail"><details><summary>detail<\/summary><pre>\{\n {2}&quot;from&quot;: &quot;operator&quot;,[^<]*&lt;img[^<]*<\/pre><\/details><\/td>/.test(h), 'the detail pretty-printed, escaped, folded');
  assert.ok(h.includes('<td>org acme</td>') && h.includes('<pre>null</pre>'));
  assert.ok(h.includes('id="set-audit-more">Older rows</button>'));
  assert.ok(!/\btitle="|\bhref="/.test(h), 'no title, no link built from a row');
  c.querySelector('#set-audit-actor').value = ' ada ';
  c.querySelector('#set-audit-filters').fire('submit');
  c.querySelector('#set-audit-more').fire('click');
  assert.deepEqual(calls, [['auditApply', { actor: 'ada', kind: 'membership', from: '2026-10-06', through: '2026-10-06' }], ['auditMore']]);

  // A repaint (a read settling) keeps what was typed but not applied: the
  // drafts read off the form on screen are drawn over the applied filters.
  c.querySelector('#set-audit-kind').value = 'store';
  const drafts = readAuditDrafts(c);
  assert.deepEqual(drafts.find(([n]) => n === 'kind'), ['kind', 'store']);
  assert.deepEqual(drafts.find(([n]) => n === 'actor'), ['actor', ' ada ']);
  assert.ok(!drafts.some(([n]) => n === 'scope'), 'no scope control: no scope draft');
  calls.length = 0;
  renderSettings(c, buildSettingsFrameModel({ access: ADA, section: 'audit', orgName: 'Acme', orgId: 'acme' }), { id: 'audit', head: settingsSectionHead('audit', { orgName: 'Acme' }), model, status: null, filters, drafts }, host);
  assert.deepEqual([c.querySelector('#set-audit-kind').value, c.querySelector('#set-audit-actor').value], ['store', ' ada '], 'the typed values survive the repaint');
  c.querySelector('#set-audit-filters').fire('submit');
  assert.deepEqual(calls, [['auditApply', { actor: 'ada', kind: 'store', from: '2026-10-06', through: '2026-10-06' }]]);
  assert.equal(readAuditDrafts(settingsContainer()), null, 'no audit form on screen: no drafts');
  calls.length = 0;

  // An owner: the scope control, the org column; the last page says so.
  const olive = buildAuditSectionModel({ doc: { scope: 'all', org: null, rows: [rows[1]], next: null }, rows: [rows[1]], filters: { scope: 'deployment' }, access: OLIVE, orgId: 'acme' });
  const o = settingsContainer();
  calls.length = 0;
  renderSettings(o, buildSettingsFrameModel({ access: OLIVE, section: 'audit', orgName: 'Acme', orgId: 'acme' }), { id: 'audit', head: settingsSectionHead('audit'), model: olive, status: null, filters: { scope: 'deployment' } }, host);
  assert.ok(o.innerHTML.includes('<option value="deployment" selected>the deployment&#39;s own rows</option>'));
  assert.ok(o.innerHTML.includes('<th scope="col">Org</th>') && o.innerHTML.includes('<td>acme</td>'));
  assert.ok(!o.innerHTML.includes('set-audit-more') && o.innerHTML.includes('role="status" aria-live="polite">No older rows.</p>'));
  o.querySelector('#set-audit-filters').fire('submit');
  assert.deepEqual(calls, [['auditApply', { scope: 'deployment' }]]);

  // A refusal (a filter the server refuses): the sentence as served, no table.
  const f = settingsContainer();
  renderSettings(f, buildSettingsFrameModel({ access: ADA, section: 'audit' }), { id: 'audit', head: settingsSectionHead('audit'), model: buildAuditSectionModel({ access: ADA, orgId: 'acme', filters: {}, error: '400: since must be before until' }), status: null, filters: {} }, host);
  assert.ok(f.innerHTML.includes('role="status" aria-live="polite">400: since must be before until</p>') && !f.innerHTML.includes('<table'), 'a refused filter: the sentence as served, no Retry — the filters are the way out');
  assert.ok(f.innerHTML.includes('id="set-audit-filters"'), 'the filters stay to change');
  assert.ok(!/maxlength="(40|80)"/.test(h), 'no limit tighter than the server\'s (kind and action have none; target kind 100)');
  const g = settingsContainer();
  renderSettings(g, buildSettingsFrameModel({ access: ADA, section: 'audit' }), { id: 'audit', head: settingsSectionHead('audit'), model: buildAuditSectionModel({ access: ADA, orgId: 'acme', filters: {}, error: '500: no answer' }), status: null, filters: {} }, host);
  assert.ok(g.innerHTML.includes('500: no answer <button type="button" class="ux-secondary-btn" id="set-retry">Retry</button>'), 'any other failure offers Retry');
});

test('renderMcpTarget: the endpoints first and "Type a URL…" last, each option its name and origin (never a URL or a variable); the empty line; a change is the controller\'s', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const handlers = {};
  const mk = () => {
    let html = '';
    const sel = { value: '', addEventListener: (t, fn) => { handlers[`sel:${t}`] = fn; } };
    const btn = { addEventListener: (t, fn) => { handlers[`btn:${t}`] = fn; } };
    return {
      hidden: false,
      get innerHTML() { return html; },
      set innerHTML(v) { html = v; },
      querySelector: (q) => (q === 'select.set-mcp-target' && html.includes('<select') ? sel : q === '[data-mcp-target-settings]' && html.includes('data-mcp-target-settings') ? btn : null),
      sel,
    };
  };
  const xss = { id: 9, name: '<img src=x onerror=1>', origin: 'https://evil.test', url: 'https://evil.test/p?secret=1', readTokenEnv: 'OBSERVOGRAM_ORG_ACME_X' };
  const c = mk();
  renderMcpTarget(c, mcpTargetModel({ endpoints: [...EP_OP, xss], orgName: 'Acme' }), host);
  assert.equal(c.hidden, false);
  const values = [...c.innerHTML.matchAll(/<option value="([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(values, ['3', '5', '9', ''], 'the list first, Type a URL… last');
  assert.match(c.innerHTML, /<select class="set-mcp-target" aria-label="Registered MCP endpoint">/);
  assert.match(c.innerHTML, /<option value="3" selected data-name="gw" data-origin="https:\/\/mcp\.acme\.test">gw — https:\/\/mcp\.acme\.test<\/option>/);
  assert.match(c.innerHTML, /<option value="">Type a URL…<\/option>\s*<\/select>/);
  assert.ok(!c.innerHTML.includes('<img'), 'escaped');
  for (const secret of ['/obs', 'secret=1', 'OBSERVOGRAM_ORG_']) assert.ok(!c.innerHTML.includes(secret), `no URL path or variable in the picker: ${secret}`);
  c.sel.value = '';
  handlers['sel:change']();
  assert.deepEqual(calls.pop(), ['pickMcpTarget', c, '']);
  // None registered: the sentence; the button only for a reader known to be an admin (C-7).
  const e = mk();
  renderMcpTarget(e, mcpTargetModel({ endpoints: [], orgName: 'Acme' }), host);
  assert.equal(e.hidden, false);
  assert.ok(!e.innerHTML.includes('<select') && !e.innerHTML.includes('<button'));
  assert.match(e.innerHTML, /<span class="set-mcp-target-hint">No MCP endpoint is registered in Acme yet — an admin registers them\.<\/span>/);
  renderMcpTarget(e, mcpTargetModel({ endpoints: [], orgName: 'Acme', canAdmin: true }), host);
  assert.match(e.innerHTML, /data-mcp-target-settings>Settings → MCP endpoints<\/button>/);
  handlers['btn:click']();
  assert.deepEqual(calls.pop(), ['openMcpEndpoints']);
  // Unread or failed: nothing drawn, the container hidden (the typed URL alone).
  const n = mk();
  renderMcpTarget(n, mcpTargetModel({ endpoints: null }), host);
  assert.deepEqual([n.innerHTML, n.hidden], ['', true]);
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

test('the Settings actions: every host.settings call the view makes is one settingsActions defines, and docs/UI_CONVENTIONS.md §3 lists them all', () => {
  const view = readFileSync(new URL('../studio/settings-view.mjs', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../studio/app.mjs', import.meta.url), 'utf8');
  const doc = readFileSync(new URL('../docs/UI_CONVENTIONS.md', import.meta.url), 'utf8');
  const called = [...new Set([...view.matchAll(/host\.settings\??\.([A-Za-z]+)/g)].map((x) => x[1]))].sort();
  const block = app.match(/const settingsActions = \{\n([\s\S]*?)\n\};/);
  assert.ok(block, 'app.mjs defines settingsActions');
  const defined = [...block[1].matchAll(/^ {2}([A-Za-z]+):/gm)].map((x) => x[1]).sort();
  for (const name of called) assert.ok(defined.includes(name), `settingsActions defines ${name}`);
  const listed = doc.replace(/\s+/g, ' ').match(/the Settings actions ([^)]*)\)/);
  assert.ok(listed, 'UI_CONVENTIONS.md lists the Settings actions');
  const names = [...listed[1].matchAll(/`([A-Za-z]+)`/g)].map((x) => x[1]).sort();
  assert.deepEqual(names, defined, 'UI_CONVENTIONS.md lists exactly the actions settingsActions defines');
});

// ---------- the MCP target for a reader the server refuses a typed URL (rebadge batch 3, C0) ----------

test('mcpTargetModel with typed { allowed: false } (R4): list-only — no "Type a URL…", the value never typed, no URL row; the empty list names the way in per posture and per register; an unreadable list is said', () => {
  const closed = { allowed: false };
  const m = mcpTargetModel({ endpoints: EP_OP, orgName: 'Acme', typed: closed, typedUrl: 'https://x.test', chosen: '' });
  assert.deepEqual(m.options.map((o) => o.value), EP_OP.map((ep) => String(ep.id)), 'the endpoints only');
  assert.equal(m.value, String(EP_OP[0].id), 'a typed choice or a remembered typed URL falls to the first endpoint');
  assert.deepEqual([m.show, m.showUrl, m.hint], [true, false, null]);
  assert.equal(mcpTargetModel({ endpoints: EP_OP, remembered: 5, typed: closed }).value, '5', 'the preselection otherwise as before');
  assert.equal(mcpTargetModel({ endpoints: EP_OP, typed: { allowed: true }, typedUrl: 'https://x.test' }).value, '', 'allowed: as 6b-i');
  const none = mcpTargetModel({ endpoints: [], orgName: 'Acme', typed: closed });
  assert.deepEqual([none.show, none.showUrl, none.options], [false, false, []]);
  assert.deepEqual(none.hint, { text: 'No MCP endpoint is registered in Acme yet — an admin registers them in Settings → MCP endpoints.', button: null });
  assert.deepEqual(mcpTargetModel({ endpoints: [], orgName: 'Acme', typed: closed, posture: 'token' }).hint,
    { text: 'No MCP endpoint is registered in Acme yet — registering one needs a signed-in admin (npm run users -- add <login>).', button: null });
  assert.deepEqual(mcpTargetModel({ endpoints: [], orgName: 'Acme', typed: closed, canAdmin: true }).hint,
    { text: 'No MCP endpoint is registered in Acme yet.', button: 'Settings → MCP endpoints' }, 'a reader who may register: the button');
  assert.deepEqual(mcpTargetModel({ endpoints: null, orgName: 'Acme', typed: closed, unreadable: true }).hint,
    { text: "Acme's MCP endpoints could not be read just now — reopen this to try again.", button: null });
  assert.equal(mcpTargetModel({ endpoints: null, orgName: 'Acme', typed: closed }).hint, null, 'not read yet: nothing said');
  assert.equal(mcpTargetModel({ endpoints: null, typed: closed }).showUrl, false, 'closed when unknown: no URL row');
});

test('mcpTargetMissingText: the typed URL named only for a reader who may type one', () => {
  assert.equal(mcpTargetMissingText(), 'choose an MCP endpoint or type a URL');
  assert.equal(mcpTargetMissingText({ typedAllowed: false, orgName: 'Acme' }), "choose one of Acme's MCP endpoints");
  assert.equal(mcpTargetMissingText({ typedAllowed: false, orgName: 'Acme', empty: true }), 'no MCP endpoint is registered in Acme yet — an admin registers them in Settings → MCP endpoints');
  assert.equal(mcpTargetMissingText({ typedAllowed: false, orgName: 'Acme', empty: true, canRegister: true }), 'no MCP endpoint is registered in Acme yet — register one in Settings → MCP endpoints', 'a reader the server lets register');
});

test('profileEndpointNote and endpointDrift with typedAllowed false: no sentence offers typing a URL; a typed profile is said', () => {
  const p = { mcpEndpoint: { orgId: 'acme', id: 3, name: 'gw' } };
  assert.equal(profileEndpointNote(p, { orgId: 'bravo', orgName: 'Bravo', endpoints: [], profileName: 'nightly', typedAllowed: false }).note,
    'Profile "nightly" names MCP endpoint "gw" of acme — choose one of Bravo\'s MCP endpoints.');
  assert.deepEqual(profileEndpointNote({ mcpUrl: 'https://x.test/mcp' }, { orgId: 'acme', orgName: 'Acme', endpoints: EP_OP, profileName: 'old', typedAllowed: false }),
    { select: null, note: 'Profile "old" sends a typed MCP URL, which only an admin may send — choose one of Acme\'s MCP endpoints.' });
  assert.equal(profileEndpointNote({ mcpUrl: 'https://x.test/mcp' }, { orgId: 'acme', endpoints: EP_OP }).note, null, 'allowed: nothing to say, as before');
  const shown = { id: 3, name: 'gw', origin: 'https://mcp.acme.test' };
  assert.equal(endpointDrift(shown, [EP_OP[1]], { orgName: 'Acme', typedAllowed: false }), "gw is no longer one of Acme's MCP endpoints — choose another of Acme's MCP endpoints.");
  assert.equal(endpointDrift(shown, null, { orgName: 'Acme', typedAllowed: false }), "gw could not be checked against Acme's MCP endpoints just now — send again.");
  for (const text of [endpointDrift(shown, [EP_OP[1]], { typedAllowed: false }), endpointDrift(shown, null, { typedAllowed: false })]) assert.ok(!/type a URL/.test(text), text);
});

test('mcpRegisterCheck (D4): Register and connect is sent only for an origin the server would accept from this reader — loopback, a listed origin, or any while no list applies to a signed-in admin', () => {
  const local = { allowed: true, why: null, listed: false, origins: [], listedOnly: true };
  assert.deepEqual(mcpRegisterCheck('http://127.0.0.1:3001/mcp', local), { origin: 'http://127.0.0.1:3001', name: '127.0.0.1:3001', error: null });
  assert.equal(mcpRegisterCheck('http://localhost/mcp', local).error, null);
  assert.equal(mcpRegisterCheck('http://[::1]:9/mcp', local).error, null);
  assert.equal(mcpRegisterCheck('https://demo.example/mcp?x=1', local).error,
    'https://demo.example cannot be registered on a server without sign-in — only a loopback MCP or an origin listed in OBSERVOGRAM_MCP_ORIGINS; the server\'s operator lists it there, or a first user arms sign-in (npm run users -- add <login>)');
  assert.equal(mcpRegisterCheck('https://demo.example/mcp', { ...local, listed: true, origins: ['https://demo.example'] }).error, null, 'listed');
  assert.equal(mcpRegisterCheck('https://demo.example/mcp', { ...local, listed: true, origins: null }).error, null, 'any (`*`)');
  assert.equal(mcpRegisterCheck('https://demo.example/mcp', { allowed: true, listed: false, origins: [], listedOnly: false }).error, null, 'a session admin, no list');
  assert.equal(mcpRegisterCheck('https://demo.example/mcp', { allowed: false, why: 'registering an MCP endpoint needs the admin role' }).error, 'registering an MCP endpoint needs the admin role');
  assert.equal(mcpRegisterCheck('not a url', local).error, 'type the MCP URL (http:// or https://)');
  assert.equal(mcpRegisterCheck('https://demo.example/', local).name, 'demo.example', 'the name is the host');
});

test('loadMcpEndpoints({ withPolicy }): { endpoints, policy } — the policy as the server sent it, null when none; without it the array as before', async () => {
  const policy = { typed: { allowed: false, why: 'w', listed: false, origins: [] }, register: { allowed: true, why: null, listed: false, origins: [], listedOnly: true } };
  assert.deepEqual(await loadMcpEndpoints({ fetchFn: async () => ({ ok: true, endpoints: EP_OP, policy }), withPolicy: true }), { endpoints: EP_OP, policy });
  assert.deepEqual(await loadMcpEndpoints({ fetchFn: async () => ({ ok: true, endpoints: [] }), withPolicy: true }), { endpoints: [], policy: null });
  assert.deepEqual(await loadMcpEndpoints({ fetchFn: async () => ({ ok: true, endpoints: EP_OP, policy }) }), EP_OP);
});

// ---------- the deployment's users (6b-ii: an owner's) ----------

// GET /api/admin/users in the server's shape (emails included — the loader drops them).
const USERS_RAW = [
  { id: 1, login: 'olive', kind: 'local', name: 'Olive', email: 'olive@mail.test', emailVerified: true, owner: true, disabled: false, mustChange: false, seededDefault: false, createdAt: 't', lastLoginAt: '2026-10-06T09:00:00.000Z', memberships: [{ orgId: 'default', role: 'admin' }, { orgId: 'acme', role: 'operator' }] },
  { id: 2, login: 'ada', kind: 'local', name: 'Ada', email: 'ada@mail.test', emailVerified: false, owner: false, disabled: false, mustChange: true, seededDefault: false, createdAt: 't', lastLoginAt: null, memberships: [{ orgId: 'acme', role: 'admin' }] },
  { id: 3, login: 'https://idp.test#u1', kind: 'oidc', name: null, email: 'u1@mail.test', emailVerified: true, owner: false, disabled: true, mustChange: false, seededDefault: false, createdAt: 't', lastLoginAt: null, memberships: [] },
];
const USERS = USERS_RAW.map(({ email: _e, emailVerified: _v, ...u }) => u);
const OWNER_CTX = { access: OLIVE, orgName: 'Acme', orgId: 'acme', me: 'olive', users: USERS, defaultOrg: 'default',
  orgs: [{ id: 'default', name: 'Default', removedAt: null }, { id: 'acme', name: 'Acme', removedAt: null }, { id: 'gone', name: 'Gone', removedAt: 't' }] };

test('the deployment group: an owner\'s nav lists Users under its head; a signed-in non-owner reads one line saying who to ask (D-H); the token and closed postures draw it unavailable with their reasons', () => {
  const owner = buildSettingsFrameModel({ access: OLIVE, orgName: 'Acme', orgId: 'acme' });
  assert.deepEqual(owner.deployment, { head: 'The deployment', note: null });
  assert.deepEqual(owner.nav.filter((n) => n.group === 'deployment').map((n) => [n.id, n.label, n.enabled]), [['users', 'Users', true], ['orgs', 'Organisations', true], ['join-role', 'Join role', true]]);
  for (const access of [ADA, OSCAR, VERA]) {
    const f = buildSettingsFrameModel({ access, orgName: 'Acme', orgId: 'acme' });
    assert.ok(!f.nav.some((n) => n.group === 'deployment'), 'no section a non-owner cannot open is listed');
    assert.match(f.deployment.note, /^Users, organisations and the join role are an owner's — ask one\. /);
    assert.equal(f.deployment.note, "Users, organisations and the join role are an owner's — ask one. (A deployment with no owner gets one from the server's shell: npm run users -- owner <login>.)");
  }
  // The line names only the deployment sections built (B3) — the full set once all three are.
  assert.equal(noOwnerText(['users']), "Users are an owner's — ask one. (A deployment with no owner gets one from the server's shell: npm run users -- owner <login>.)");
  assert.equal(noOwnerText(['users', 'orgs', 'join-role']), noOwnerText());
  assert.equal(noOwnerText(['users', 'orgs', 'join-role']), "Users, organisations and the join role are an owner's — ask one. (A deployment with no owner gets one from the server's shell: npm run users -- owner <login>.)");
  assert.equal(noOwnerText(['environments']), null);
  assert.equal(buildSettingsFrameModel({ access: ADA, builtSections: ['environments', 'endpoints', 'members', 'audit'] }).deployment, null, 'no deployment section built: no group, no line');
  const token = buildSettingsFrameModel({ access: TOKEN }).nav.find((n) => n.id === 'users');
  assert.deepEqual([token.enabled, token.reason], [false, 'needs a signed-in owner — the banner above names the way in']);
  const closed = buildSettingsFrameModel({ access: CLOSED }).nav.find((n) => n.id === 'users');
  assert.deepEqual([closed.enabled, closed.reason], [false, 'closed on this server without sign-in — the banner above names the way in']);
  assert.equal(buildSettingsFrameModel({ access: OPEN }).nav.find((n) => n.id === 'users').enabled, true, 'without sign-in, on the loopback: local is an owner (D-E)');
  // The CHANGELOG's entry says the same: the token and closed postures, never the open one.
  const entry = readFileSync(new URL('../docs/CHANGELOG.md', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith("- **6b-ii — the nav's deployment group**"));
  assert.ok(entry, "docs/CHANGELOG.md has the deployment group's entry");
  assert.match(entry, /the token and closed postures draw the items unavailable with their reasons\.$/);
  assert.deepEqual(buildSettingsFrameModel({ access: STATIC }).deployment, null);
  assert.match(settingsSectionHead('users').scope, /temporary password, shown once\.$/);
  assert.equal(settingsSectionHead('users').loading, 'Reading users…');
});

test('PASSWORD_ALPHABET and temporaryPassword (D-D, C-9): exactly 32 symbols, no look-alikes, 20 symbols of one byte each in groups of four', () => {
  assert.equal(PASSWORD_ALPHABET.length, 32);
  assert.equal(new Set(PASSWORD_ALPHABET).size, 32, 'no duplicate symbol');
  assert.ok(!/[lo01A-Z]/.test(PASSWORD_ALPHABET), 'no l, o, 0, 1, no capitals');
  const fixed = temporaryPassword(Uint8Array.from({ length: 20 }, (_, i) => i * 13));
  assert.equal(fixed, 'ap4h-wbq5-ixcr-6jyd-s7kz');
  assert.equal(fixed.length, 24);
  assert.match(fixed, /^[a-km-np-z2-9]{4}(-[a-km-np-z2-9]{4}){4}$/);
  for (let b = 0; b < 256; b++) {
    const p = temporaryPassword(new Uint8Array(20).fill(b));
    assert.ok(!p.includes('undefined') && p.length === 24, `byte ${b}`);
    assert.equal(p[0], PASSWORD_ALPHABET[b & 31]);
  }
  assert.throws(() => temporaryPassword(new Uint8Array(19)), /20 random bytes/);
});

test('the users section: no email, the badges, the memberships, "you" by login; the last enabled owner; Manage… for an owner only', () => {
  const m = buildUsersSectionModel({ users: USERS, access: OLIVE, me: 'olive' });
  assert.equal(m.enabledOwners, 1);
  assert.deepEqual(m.primary, { enabled: true, reason: null });
  assert.deepEqual(m.rows.map((r) => [r.login, r.badges, r.memberships, r.lastSignIn, r.you, r.lastOwner, r.canManage]), [
    ['olive', ['owner'], 'default:admin, acme:operator', 'last sign-in 2026-10-06T09:00:00.000Z', true, true, true],
    ['ada', ['must change password'], 'acme:admin', 'never signed in', false, false, true],
    ['https://idp.test#u1', ['disabled'], 'no organisation', 'never signed in', false, false, true],
  ]);
  assert.ok(!JSON.stringify(m).includes('@mail.test'), 'C-8: no email in the model');
  const failed = buildUsersSectionModel({ users: null, access: OLIVE, error: '500: boom' });
  assert.deepEqual([failed.rows, failed.error], [[], '500: boom']);
  assert.equal(buildUsersSectionModel({ users: [], access: OLIVE }).empty, 'No users yet. New local user creates one.');
  const ada = buildUsersSectionModel({ users: USERS, access: ADA });
  assert.deepEqual(ada.primary, { enabled: false, reason: "users, organisations and the join role belong to the deployment's owners — ask an owner" });
  assert.ok(ada.rows.every((r) => !r.canManage));
});

test('userActions: the server\'s rules drawn first — the last enabled owner, one\'s own password, an IdP user\'s, a disabled user made owner', () => {
  const by = (rec, users = USERS, me = 'olive') => Object.fromEntries(userActions(rec, users, { me }).map((a) => [a.id, a.reason]));
  assert.deepEqual(by(USERS[0]), {
    reset: 'this is your own account — change your password at /auth/change-password',
    disable: 'olive is the last enabled owner — make another user an owner first',
    signout: null,
    'owner-revoke': 'olive is the last enabled owner — make another user an owner first',
  });
  assert.deepEqual(by(USERS[1]), { reset: null, disable: null, signout: null, 'owner-grant': null });
  assert.deepEqual(by(USERS[2]), {
    reset: 'https://idp.test#u1 signs in through the IdP and has no password here — sign them out everywhere, or disable them',
    enable: null, signout: null, 'owner-grant': 'https://idp.test#u1 is disabled — enable them first',
  });
  // A second enabled owner lifts the last-owner rule.
  const two = USERS.map((u) => (u.login === 'ada' ? { ...u, owner: true } : u));
  assert.deepEqual([by(two[0], two).disable, by(two[0], two)['owner-revoke']], [null, null]);
  // A reader who may not act: every action carries their reason.
  assert.ok(userActions(USERS[1], USERS, { can: false, reason: 'r' }).every((a) => !a.enabled && a.reason === 'r'));
});

test('the user editors: New local user has no password field and the organisation choice; the secret step shows the password once and the status never; a user\'s actions confirm first', () => {
  const create = buildSettingsEditorModel('user-create', null, { ctx: OWNER_CTX });
  assert.deepEqual(create.fields.map((f) => f.name), ['login', 'name', 'email', 'role', 'orgId'], 'no password field (D-D)');
  assert.deepEqual(create.draft, { login: '', name: '', email: '', role: 'operator', orgId: 'acme' });
  assert.deepEqual(create.fields.find((f) => f.name === 'orgId').options.map((o) => [o.value, o.selected]), [['default', false], ['acme', true]], 'live orgs only, the active one chosen');
  assert.equal(create.primary.label, 'Create');
  assert.equal(create.status.text, 'A local user who signs in with a password: a temporary one is drawn on Create and shown once.');
  // The sign-in mode line (A13).
  assert.equal(signInModeLine({ mode: 'local' }), null);
  const oidcCtx = { ...OWNER_CTX, joinRole: { mode: 'oidc', issuerKey: 'https://idp.test' } };
  assert.equal(buildSettingsEditorModel('user-create', null, { ctx: oidcCtx }).status.text, 'This server signs in through OIDC issuer https://idp.test: a local user cannot sign in here until it runs local sign-in.');
  assert.equal(signInModeLine({ mode: 'proxy' }), 'This server signs in through its reverse proxy: a local user cannot sign in here until it runs local sign-in.');
  assert.deepEqual(buildUserCreateBody({ login: ' nina ', name: '', email: ' n@x.test ', role: 'viewer', orgId: 'acme' }), { login: 'nina', email: 'n@x.test', role: 'viewer', orgId: 'acme' });
  assert.deepEqual(buildUserCreateBody({ login: 'nina' }), { login: 'nina', role: 'operator' });
  // The secret step.
  const PW = 'abcd-efgh-ijkm-npqr-stuv';
  const secret = buildSettingsEditorModel('user-create', null, { ctx: { ...OWNER_CTX, secret: { login: 'nina', value: PW, forced: true } }, step: 'secret', status: userCreateStatus({ user: { login: 'nina' }, owner: false, joined: [{ orgId: 'acme', role: 'viewer' }] }, { orgId: 'acme', orgName: 'Acme' }) });
  assert.deepEqual(secret.secret, { text: 'Temporary password for nina — shown once. It is not stored in this browser and cannot be shown again; nina sets their own at first sign-in. Reset it to get a new one.', value: PW });
  assert.equal(secret.primary, null);
  assert.equal(secret.status.text, 'Created nina (viewer in Acme). Copy the temporary password before closing.');
  assert.ok(!secret.status.text.includes(PW));
  const oidcSecret = buildSettingsEditorModel('user-create', null, { ctx: { ...oidcCtx, secret: { login: 'nina', value: PW } }, step: 'secret' });
  assert.ok(!/sets their own/.test(oidcSecret.secret.text), 'under OIDC the clause about setting their own goes (A13)');
  // A user's dialog.
  const ada = buildSettingsEditorModel('user', USERS[1], { ctx: OWNER_CTX });
  assert.deepEqual([ada.title, ada.primary, ada.facts], ['ada', null, ['local · must change password', 'organisations: acme:admin', 'never signed in']]);
  assert.deepEqual(ada.actions.map((a) => [a.id, a.label, a.enabled]), [['reset', 'Reset password…', true], ['disable', 'Disable…', true], ['signout', 'Sign out everywhere…', true], ['owner-grant', 'Make owner…', true]]);
  const confirm = (action, rec = USERS[1]) => buildSettingsEditorModel('user', rec, { ctx: { ...OWNER_CTX, action }, step: 'confirm-action' }).confirm;
  assert.deepEqual(confirm('reset'), { text: "Reset ada's password? Every session of ada ends; a new temporary password is shown once, and ada sets their own at their next sign-in.", danger: "Reset ada's password" });
  assert.equal(confirm('owner-grant').text, "Make ada an owner? An owner manages this deployment's users and acts as an admin in every organisation; ada also becomes an admin of default.");
  assert.match(confirm('signout', USERS[0]).text, / This is you: this browser is signed out too\.$/);
  assert.match(confirm('disable').text, /^Disable ada\? Every session of ada ends/);
  const reset = buildSettingsEditorModel('user', USERS[1], { ctx: { ...OWNER_CTX, secret: { login: 'ada', value: PW, forced: true } }, step: 'secret' });
  assert.equal(reset.secret.text, 'Temporary password for ada — shown once. It is not stored in this browser and cannot be shown again; ada sets their own at their next sign-in. Reset it to get a new one.');
  assert.equal(buildSettingsEditorModel('user', USERS[1], { ctx: { ...OWNER_CTX, signIn: true }, step: 'notice' }).signIn, true);
  // A non-owner (the access downgraded while open): Create unavailable with the owner reason.
  assert.deepEqual(buildSettingsEditorModel('user-create', null, { ctx: { ...OWNER_CTX, access: ADA } }).primary.enabled, false);
  // …and a user's confirm step after the owner role went: no danger button, the actions back with the reason.
  const revoked = buildSettingsEditorModel('user', USERS[1], { ctx: { ...OWNER_CTX, access: ADA, action: 'disable' }, step: 'confirm-action' });
  assert.equal(revoked.confirm, null);
  assert.ok(revoked.actions.length > 0 && revoked.actions.every((a) => a.enabled === false && a.reason === ADA.why.own));
});

test('the user statuses: what the server did, by action; a create that armed sign-in says which way (D-E); a refused reset says the password is not forced', () => {
  const s = (a, ans = {}) => userActionStatus(a, ans, { login: 'ada', defaultOrg: 'default' }).text;
  assert.equal(s('reset'), 'Every session of ada ended; they set a new password at their next sign-in.');
  assert.equal(s('disable'), 'ada disabled — every session ended.');
  assert.equal(s('disable', { you: true }), 'You disabled your own account — this browser is signed out at its next request.');
  assert.equal(s('enable'), 'ada enabled.');
  assert.equal(s('signout'), 'Every session of ada ended.');
  assert.equal(s('signout', { you: true }), 'You signed out everywhere — this browser is signed out at its next request.');
  assert.equal(s('owner-grant', { changed: true, note: null }), 'ada is an owner (and an admin of default).');
  assert.equal(s('owner-revoke', { changed: true, note: 'ada is still an admin of default: …' }), 'ada is no longer an owner. ada is still an admin of default: …');
  assert.equal(s('owner-revoke', { changed: false }), 'ada is not an owner — nothing changed.');
  const created = { user: { login: 'first' }, owner: true, joined: [{ orgId: 'default', role: 'admin' }], armed: false, note: null };
  assert.equal(userCreateStatus(created, { orgId: null }).text, 'Created first (admin in default) — an owner: the first local user. Copy the temporary password before closing.');
  const refused = userCreateStatus(created, { orgId: null, reset: '409: no' });
  assert.equal(refused.kind, 'error');
  assert.equal(refused.text, "Created first (admin in default) — an owner: the first local user, but making its password temporary was refused — 409: no. The password below is not forced to change: reset it from first's Manage….");
  const armed = { ...created, armed: true };
  assert.equal(userCreateStatus(armed, { signIn: true }).text, 'Sign-in is on now: first is an owner. Sign in as first with the password below.');
  assert.equal(userCreateStatus(armed, { signIn: false }).text, 'first is created (an owner: the first local user). This server runs without sign-in (OBSERVOGRAM_AUTH=off): first signs in once it starts without it, with the password below. It is not forced to change — change it at /auth/change-password after signing in.');
  assert.equal(userCreateStatus({ ...created, owner: false, joined: [{ orgId: 'acme', role: 'viewer' }], note: 'local users cannot sign in while …' }, { orgId: 'acme', orgName: 'Acme' }).text,
    'Created first (viewer in Acme). Copy the temporary password before closing. local users cannot sign in while …');
});

test('the users loaders: one requestJson call each, ids and actions encoded, the password in the body only — and no email kept', async () => {
  const calls = [];
  const answer = { ok: true, users: USERS_RAW, user: USERS_RAW[1], owner: false, joined: [{ orgId: 'acme', role: 'viewer' }], armed: false, note: null, you: true, mustChange: true, changed: true, defaultOrg: 'default', orgs: [{ id: 'acme' }], role: null, mode: 'local', oidc: false, issuerKey: null };
  const fetchFn = async (path, opts) => { calls.push([path, opts?.method ?? 'GET', opts?.body ?? null]); return answer; };
  const users = await loadUsers({ fetchFn });
  assert.deepEqual(users, USERS);
  assert.ok(!JSON.stringify(users).includes('@mail.test') && !JSON.stringify(users).includes('emailVerified'), 'C-8: loadUsers drops every email');
  const made = await createUser({ login: 'nina', password: 'pw-pw-pw-pw', role: 'viewer' }, { fetchFn });
  assert.deepEqual([made.user.login, 'email' in made.user, made.armed, made.joined], ['ada', false, false, [{ orgId: 'acme', role: 'viewer' }]]);
  assert.ok(!JSON.stringify(made).includes('pw-pw'), 'nothing of the password comes back');
  assert.deepEqual(await userAction(2, 'password', { password: 'x' }, { fetchFn }), { user: USERS[1], you: true, mustChange: true });
  await userAction('2/x', 'disable', null, { fetchFn });
  assert.deepEqual(await setOwner(2, true, { fetchFn }), { user: USERS[1], changed: true, note: null });
  assert.deepEqual(await loadAdminOrgs({ fetchFn }), { defaultOrg: 'default', orgs: [{ id: 'acme' }] });
  assert.equal((await loadJoinRole({ fetchFn })).mode, 'local');
  assert.equal('ok' in (await loadJoinRole({ fetchFn })), false);
  assert.deepEqual(calls.slice(0, 6), [
    ['/api/admin/users', 'GET', null],
    ['/api/admin/users', 'POST', '{"login":"nina","password":"pw-pw-pw-pw","role":"viewer"}'],
    ['/api/admin/users/2/password', 'POST', '{"password":"x"}'],
    ['/api/admin/users/2%2Fx/disable', 'POST', '{}'],
    ['/api/admin/users/2/owner', 'PUT', '{"owner":true}'],
    ['/api/admin/orgs', 'GET', null],
  ]);
  assert.deepEqual(await loadUsers({ fetchFn: async () => ({}) }), []);
});

test('renderSettings and the user editor: Users under the deployment head, no email, Manage…; the no-owner line; the secret drawn once, never in the status; Copy and Go to sign-in', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const xss = '<img src=x onerror="window.__x=1">';
  const rows = [{ ...USERS[1], login: xss }, USERS[0]];
  const frame = buildSettingsFrameModel({ access: OLIVE, section: 'users', orgName: 'Acme', orgId: 'acme' });
  const c = settingsContainer();
  renderSettings(c, frame, { id: 'users', head: settingsSectionHead('users'), model: buildUsersSectionModel({ users: rows, access: OLIVE, me: 'olive' }), status: { kind: 'ok', text: '' } }, host);
  const h = c.innerHTML;
  assert.ok(h.includes('<p class="set-nav-group" id="set-nav-deployment">The deployment</p>'));
  assert.ok(h.indexOf('id="set-nav-deployment"') < h.indexOf('data-section="users"'), 'Users under the deployment head');
  assert.ok(!h.includes('<img') && h.includes('&lt;img src=x onerror=&quot;window.__x=1&quot;&gt;'), 'a login is escaped');
  assert.ok(!h.includes('@mail.test'));
  assert.ok(h.includes('<span class="set-badge is-owner">owner</span>') && h.includes('<span class="set-badge">must change password</span>'));
  assert.ok(h.includes('id="set-primary">New local user</button>'));
  c.querySelectorAll('[data-user-manage]').forEach((b) => b.fire('click'));
  c.querySelector('#set-primary').fire('click');
  assert.deepEqual(calls, [['openEditor', { kind: 'user', id: 2 }], ['openEditor', { kind: 'user', id: 1 }], ['openEditor', { kind: 'user-create' }]]);
  // A non-owner: the head and the line, no Users item.
  const n = settingsContainer();
  renderSettings(n, buildSettingsFrameModel({ access: ADA, orgName: 'Acme', orgId: 'acme' }), null, host);
  assert.ok(n.innerHTML.includes('<p class="set-nav-note" id="set-nav-no-owner">Users, organisations and the join role are an owner&#39;s — ask one. (A deployment with no owner gets one from the server&#39;s shell: npm run users -- owner &lt;login&gt;.)</p>'));
  assert.ok(!n.innerHTML.includes('data-section="users"'));

  // The secret step: the password exactly once, in the <code>; never in the status line (mutation check 8).
  const PW = 'abcd-efgh-ijkm-npqr-stuv';
  const e = settingsContainer();
  calls.length = 0;
  const status = userCreateStatus({ user: { login: 'nina' }, joined: [{ orgId: 'acme', role: 'viewer' }] }, { orgId: 'acme', orgName: 'Acme' });
  renderSettingsEditor(e, buildSettingsEditorModel('user-create', null, { ctx: { ...OWNER_CTX, secret: { login: 'nina', value: PW, forced: true }, signIn: true }, step: 'secret', status }), host);
  const eh = e.innerHTML;
  assert.equal(eh.split(PW).length - 1, 1, 'the password appears exactly once');
  assert.ok(eh.includes(`<code class="set-secret-value" id="set-secret-value">${PW}</code>`));
  const statusLine = eh.slice(eh.indexOf('id="set-editor-status"'), eh.indexOf('</div>', eh.indexOf('id="set-editor-status"')));
  assert.ok(!statusLine.includes(PW) && statusLine.includes('Copy the temporary password before closing.'));
  assert.ok(!/\b(title|aria-label)="[^"]*abcd-/.test(eh), 'never in a title or a label');
  assert.ok(!eh.includes('set-editor-save" id="set-editor-save"'), 'no Create on the secret step');
  e.querySelector('#set-secret-copy').fire('click');
  e.querySelector('#set-editor-signin').fire('click');
  assert.deepEqual(calls, [['copySecret'], ['signIn']]);
  // A user's dialog: the facts, the actions; an unavailable one explains; another opens its confirm step.
  const u = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(u, buildSettingsEditorModel('user', USERS[0], { ctx: OWNER_CTX }), host);
  assert.ok(u.innerHTML.includes('data-user-action="reset">Reset password…</button>') && !u.innerHTML.includes('set-edit-'));
  for (const b of u.querySelectorAll('[data-user-action]')) b.fire('click');
  assert.deepEqual(calls, [
    ['explain', 'this is your own account — change your password at /auth/change-password'],
    ['explain', 'olive is the last enabled owner — make another user an owner first'],
    ['step', 'confirm-action:signout'],
    ['explain', 'olive is the last enabled owner — make another user an owner first'],
  ]);
  const unavailable = u.querySelectorAll('[data-user-action]').find((b) => b.dataset.userAction === 'reset');
  assert.equal(unavailable.getAttribute('aria-disabled'), 'true');
  // The confirm step after the owner role went elsewhere (a 403 by role): no danger button left usable; the actions, unavailable.
  const r = settingsContainer();
  renderSettingsEditor(r, buildSettingsEditorModel('user', USERS[1], { ctx: { ...OWNER_CTX, access: ADA, action: 'disable' }, step: 'confirm-action' }), host);
  assert.equal(r.querySelector('#set-editor-confirm'), null);
  assert.equal(r.querySelectorAll('[data-user-action]').find((b) => b.dataset.userAction === 'disable').getAttribute('aria-disabled'), 'true');
});

// ---------- the organisations and the join role (design §5.8–5.9, C12) ----------

// GET /api/admin/orgs as the server sends it: the default org at the workspace root, two live ones, one removed.
const ORGS_DOC = {
  defaultOrg: 'default',
  orgs: [
    { id: 'default', name: 'Default', root: '.', default: true, removedAt: null, createdAt: '2026-10-01T00:00:00.000Z', members: 1 },
    { id: 'acme', name: 'Acme', root: 'orgs/acme', default: false, removedAt: null, createdAt: '2026-10-02T00:00:00.000Z', members: 4 },
    { id: 'charlie', name: 'Charlie', root: 'orgs/charlie', default: false, removedAt: null, createdAt: '2026-10-03T00:00:00.000Z', members: 1 },
    { id: 'gone', name: 'Gone', root: 'orgs/gone', default: false, removedAt: '2026-10-04T00:00:00.000Z', createdAt: '2026-10-01T00:00:00.000Z', members: 0 },
  ],
};

test('buildOrgsSectionModel: every org with its members, files and dates; removed ones greyed, never removable; the default org\'s Remove… unavailable with the server\'s sentence; New organisation needs sign-in', () => {
  const m = buildOrgsSectionModel({ orgs: ORGS_DOC.orgs, defaultOrg: 'default', access: OLIVE, activeOrg: 'acme', formatTime: (iso) => iso.slice(0, 10) });
  assert.deepEqual(m.primary, { enabled: true, reason: null });
  assert.deepEqual(m.rows.map((r) => [r.id, r.facts, r.removedText, r.remove, r.active]), [
    ['default', '1 member · files: the workspace root · created 2026-10-01', null, { enabled: false, reason: 'default is the default org and cannot be removed' }, false],
    ['acme', '4 members · files: orgs/acme · created 2026-10-02', null, { enabled: true, reason: null }, true],
    ['charlie', '1 member · files: orgs/charlie · created 2026-10-03', null, { enabled: true, reason: null }, false],
    ['gone', '0 members · files: orgs/gone · created 2026-10-01', 'removed 2026-10-04 — a slug is never reused', null, false],
  ]);
  assert.deepEqual(m.rows.map((r) => [r.isDefault, r.removed]), [[true, false], [false, false], [false, false], [false, true]]);
  // Act in <id> (D-M): each live org but the active one, where the server signs in.
  assert.deepEqual(m.rows.map((r) => r.act), ['Act in default', null, 'Act in charlie', null]);
  // Without sign-in, on the loopback: listed, removable, but no second organisation (the server's NEEDS_IDENTITY).
  const open = buildOrgsSectionModel({ orgs: ORGS_DOC.orgs, defaultOrg: 'default', access: OPEN });
  assert.deepEqual([open.primary.enabled, open.primary.reason], [false, OPEN.why.createOrg]);
  assert.match(open.primary.reason, /^a second organisation needs sign-in, and this server runs without it — /);
  assert.equal(open.rows[2].remove.enabled, true);
  assert.deepEqual(open.rows.map((r) => r.act), [null, null, null, null], 'no Act in without sign-in: the server ignores the org a browser names');
  // A non-owner never reaches the list; its controls carry the owner reason.
  const ada = buildOrgsSectionModel({ orgs: ORGS_DOC.orgs, defaultOrg: 'default', access: ADA });
  assert.deepEqual([ada.primary.reason, ada.rows[1].remove, ada.rows[2].act], [ADA.why.own, null, null]);
  assert.deepEqual(buildOrgsSectionModel({ orgs: null, access: OLIVE, error: '403: owner only' }), { rows: [], primary: { enabled: true, reason: null }, empty: null, error: '403: owner only' });
  assert.equal(settingsSectionHead('orgs').title, 'Organisations');
  assert.equal(settingsSectionHead('orgs').loading, 'Reading organisations…');
  assert.match(settingsSectionHead('orgs').scope, /its id is never used again\.$/);
  assert.equal(settingsSectionHead('join-role').loading, 'Reading join role…');
  assert.equal(settingsSectionHead('join-role').scope, null, 'the join role\'s scope sentence is the sign-in mode (the section model\'s)');
});

test('an owner acting in an org they are not a member of (D-M): the boot keeps it, the chip lists it, the head says it, a refusal recovers once (T25)', () => {
  const owner = { ...me('olive', true), orgs: [{ id: 'acme', name: 'Acme', role: 'admin' }] };
  const member = { ...me('ada'), orgs: [{ id: 'acme', name: 'Acme', role: 'admin' }, { id: 'bravo', name: 'Bravo', role: 'viewer' }] };
  // activeOrgChoice: a membership kept for anyone; a non-membership kept for an owner only (6a A-17 unchanged otherwise).
  assert.equal(activeOrgChoice({ identity: member, saved: 'bravo' }), 'bravo');
  assert.equal(activeOrgChoice({ identity: member, saved: 'delta' }), 'acme', 'a member: the first membership');
  assert.equal(activeOrgChoice({ identity: owner, saved: 'delta', savedBy: 'olive' }), 'delta', 'an owner keeps an org they are not a member of');
  assert.equal(activeOrgChoice({ identity: owner, saved: null }), 'acme');
  assert.equal(activeOrgChoice({ identity: { ...me('olive', true), orgs: [] }, saved: 'delta', savedBy: 'olive' }), 'delta', 'an owner in no org');
  // A shared browser: an org another login chose is never inherited by an owner who is not its member.
  assert.equal(activeOrgChoice({ identity: owner, saved: 'delta', savedBy: 'ada' }), 'acme', 'another login\'s choice: the first membership');
  assert.equal(activeOrgChoice({ identity: owner, saved: 'delta' }), 'acme', 'a choice saved by no login: the first membership');
  assert.equal(activeOrgChoice({ identity: { ...me('olive', true), orgs: [] }, saved: 'delta', savedBy: 'ada' }), null, 'an owner in no org: the server lands the request in the default org');
  assert.equal(activeOrgChoice({ identity: member, saved: 'bravo', savedBy: 'olive' }), 'bravo', 'a membership is kept whoever saved it');
  assert.equal(activeOrgChoice({ identity: { ...me('olive', true), orgs: [] }, saved: null }), null, 'none: the server lands the owner in the default org');
  assert.equal(activeOrgChoice({ identity: { ...me('ada'), orgs: [] }, saved: 'delta' }), null);
  assert.equal(activeOrgChoice({ identity: null, saved: 'delta' }), null, 'the open posture sends no org');
  assert.equal(activeOrgChoice({ identity: { ok: true, authenticated: false, orgs: [] }, saved: 'delta' }), null);
  // isActingOrg: a signed-in owner outside their memberships only.
  assert.equal(isActingOrg({ identity: owner, orgId: 'delta' }), true);
  assert.equal(isActingOrg({ identity: owner, orgId: 'acme' }), false);
  assert.equal(isActingOrg({ identity: member, orgId: 'delta' }), false);
  assert.equal(isActingOrg({ identity: owner, orgId: null }), false);
  assert.equal(isActingOrg({ identity: null, orgId: 'default' }), false);
  // The chip: the memberships plus the acting org, labelled; a member's list unchanged.
  const entries = orgChipEntries({ identity: owner, orgId: 'delta', orgName: 'Delta' });
  assert.deepEqual(entries.map((e) => [e.id, orgChipLabel(e)]), [['acme', 'Acme'], ['delta', 'Delta — acting as owner']]);
  assert.deepEqual(orgChipEntries({ identity: owner, orgId: 'delta' }).map(orgChipLabel), ['Acme', 'delta — acting as owner'], 'the id before the name is read');
  assert.equal(orgChipEntries({ identity: owner, orgId: 'acme', orgName: 'Acme' }), owner.orgs);
  assert.equal(orgChipEntries({ identity: member, orgId: 'bravo', orgName: 'Bravo' }), member.orgs);
  // The boot's recovery: once, for an owner's acting org refused with denied 'org'; then the no-org screen.
  const unknown = Object.assign(new Error("403: unknown org 'delta'"), { status: 403, denied: 'org' });
  assert.deepEqual(actingRecovery({ identity: owner, orgId: 'delta', error: unknown }), { to: 'acme' });
  assert.deepEqual(actingRecovery({ identity: { ...me('olive', true), orgs: [] }, orgId: 'delta', error: unknown }), { to: null });
  assert.equal(actingRecovery({ identity: owner, orgId: 'delta', error: unknown, tried: true }), null, 'never twice: no loop');
  assert.equal(actingRecovery({ identity: owner, orgId: 'acme', error: unknown }), null, 'a membership refused is the no-org screen');
  assert.equal(actingRecovery({ identity: member, orgId: 'delta', error: unknown }), null);
  assert.equal(actingRecovery({ identity: owner, orgId: 'delta', error: new Error('500: boom') }), null);
  // The head and the Members scope sentence.
  assert.equal(buildSettingsFrameModel({ access: OLIVE, orgName: 'Delta', orgId: 'delta', acting: true }).scope, 'Settings · Delta (delta) · you are an owner acting in delta — not a member');
  assert.equal(buildSettingsFrameModel({ access: OLIVE, orgName: 'Acme', orgId: 'acme' }).scope, 'Settings · Acme (acme) · you are admin, an owner');
});

test('the organisation editors: New organisation (id, name, take over a directory) → the created sentence and Switch to it; Remove… says what cannot be undone and asks for the id typed', () => {
  const ctx = { access: OLIVE, orgName: 'Acme', orgId: 'acme', defaultOrg: 'default', formatTime: (iso) => iso.slice(0, 10) };
  const create = buildSettingsEditorModel('org-create', null, { ctx });
  assert.deepEqual([create.title, create.primary.label, create.primary.enabled, create.switchTo], ['New organisation', 'Create', true, null]);
  assert.deepEqual(create.fields.map((f) => [f.name, f.type]), [['id', 'text'], ['name', 'text'], ['adopt', 'checkbox']]);
  assert.equal(create.fields[0].help, 'a slug: lowercase letters, digits, - and _; never reused');
  assert.equal(create.fields[2].help, 'when orgs/<id>/ already holds files — adopt them instead of being refused');
  assert.deepEqual(buildSettingsEditorModel('org-create', null, { ctx: { ...ctx, access: OPEN } }).primary, { label: 'Create', enabled: false, reason: OPEN.why.createOrg });
  assert.deepEqual(buildOrgCreateBody({ id: ' charlie ', name: '', adopt: false }), { id: 'charlie' });
  assert.deepEqual(buildOrgCreateBody({ id: 'charlie', name: ' Charlie ', adopt: true }), { id: 'charlie', name: 'Charlie', adopt: true });
  const answer = { org: { id: 'charlie', name: 'Charlie', root: 'orgs/charlie' }, adopted: false, path: '/srv/ws/orgs/charlie' };
  assert.deepEqual(orgCreateStatus(answer), { kind: 'saved', text: 'Created Charlie (charlie) — you are its first admin; its files live in /srv/ws/orgs/charlie.' });
  assert.equal(orgCreateStatus({ ...answer, adopted: true }).text, "Created Charlie (charlie) — you are its first admin; its files live in /srv/ws/orgs/charlie. The directory's files were taken over.");
  const created = buildSettingsEditorModel('org-create', null, { ctx: { ...ctx, created: { id: 'charlie' } }, step: 'notice', status: orgCreateStatus(answer) });
  assert.deepEqual([created.primary, created.switchTo], [null, { orgId: 'charlie', label: 'Switch to it' }]);

  const charlie = ORGS_DOC.orgs[2];
  const facts = buildSettingsEditorModel('org', charlie, { ctx });
  assert.deepEqual([facts.id, facts.title, facts.facts, facts.remove, facts.confirm], ['charlie', 'Charlie (charlie)', ['1 member', 'files: orgs/charlie', 'created 2026-10-03'], { enabled: true, reason: null, label: 'Remove…' }, null]);
  const remove = buildSettingsEditorModel('org', charlie, { ctx, step: 'confirm-delete' });
  assert.deepEqual(remove.confirm, {
    text: 'Remove Charlie (charlie)? This cannot be undone here: no route restores an organisation, and charlie is never used again. Its 1 member loses access, and its services, environments and MCP endpoints can no longer be reached from the studio. The files stay under orgs/charlie.',
    danger: 'Remove charlie', typed: 'charlie',
  });
  // The org this browser is in: the step says where the browser goes next.
  const here = buildSettingsEditorModel('org', ORGS_DOC.orgs[1], { ctx, step: 'confirm-delete' });
  assert.match(here.confirm.text, /^Remove Acme \(acme\)\? This cannot be undone here: .* Its 4 members lose access, .* This is the org you are in; afterwards this browser switches to your first other organisation\.$/);
  // The default org: no step — Remove… unavailable with the server's sentence.
  const def = buildSettingsEditorModel('org', ORGS_DOC.orgs[0], { ctx, step: 'confirm-delete' });
  assert.deepEqual([def.confirm, def.remove.enabled, def.remove.reason], [null, false, 'default is the default org and cannot be removed']);
  assert.deepEqual(orgRemoveStatus(charlie, { note: 'its files under /srv/ws/orgs/charlie stay; with the server stopped, packc store purge-org charlie deletes them' }),
    { kind: 'saved', text: 'Removed Charlie (charlie) — its files under /srv/ws/orgs/charlie stay; with the server stopped, packc store purge-org charlie deletes them.' });
  assert.equal(orgRemoveStatus(charlie, {}).text, 'Removed Charlie (charlie).');
});

test('the join role: the sign-in mode first, per mode; joinRoleBody sends confirm with admin only and nothing for admin unticked (B14); the status names from and to', () => {
  assert.equal(joinRoleModeSentence({ mode: 'oidc', issuerKey: 'https://idp.test', role: 'viewer' }, { defaultOrgName: 'Default' }),
    'Sign-in: OIDC issuer https://idp.test. An IdP user joins Default as viewer at their first sign-in.');
  assert.equal(joinRoleModeSentence({ mode: 'oidc', issuerKey: 'https://idp.test', role: null }),
    'Sign-in: OIDC issuer https://idp.test. An IdP user gets no membership at first sign-in (an admin adds them).');
  assert.equal(joinRoleModeSentence({ mode: 'local', role: null }), 'Sign-in: local users. The join role applies to IdP users once OIDC is configured: none.');
  assert.equal(joinRoleModeSentence({ mode: 'local', role: 'operator' }), 'Sign-in: local users. The join role applies to IdP users once OIDC is configured: operator.');
  // OBSERVOGRAM_AUTH=off answers mode 'local' too: the open posture says the server has no sign-in, never "local users".
  assert.equal(joinRoleModeSentence({ mode: 'local', role: null }, { open: true }), 'This server runs without sign-in. The join role applies to IdP users once OIDC is configured: none.');
  assert.equal(buildJoinRoleSectionModel({ doc: { mode: 'local', role: null }, access: OPEN }).scopeSentence, 'This server runs without sign-in. The join role applies to IdP users once OIDC is configured: none.');
  assert.equal(buildSettingsEditorModel('join-role', { mode: 'local', role: null }, { ctx: { access: OPEN } }).status.text, 'This server runs without sign-in. The join role applies to IdP users once OIDC is configured: none.');
  assert.equal(joinRoleModeSentence({ mode: 'proxy', role: 'viewer', proxy: { joinRole: 'operator', groupsConfigured: false } }),
    "Sign-in: a reverse proxy. Its first-sight role is the proxy's (OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE: operator); the recorded join role below does not apply to proxy users.");
  assert.equal(joinRoleModeSentence({ mode: 'proxy', role: null, proxy: { joinRole: 'viewer', groupsConfigured: true } }),
    "Sign-in: a reverse proxy. Its first-sight role is the proxy's (OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE: viewer) — the groups header decides when it names a group; the recorded join role below does not apply to proxy users.");
  const section = buildJoinRoleSectionModel({ doc: { mode: 'local', role: null, oidc: false, issuerKey: null }, access: OLIVE, defaultOrgName: 'Default' });
  assert.deepEqual([section.scopeSentence, section.roleText, section.primary], ['Sign-in: local users. The join role applies to IdP users once OIDC is configured: none.', 'Recorded join role: none — no automatic join', { enabled: true, reason: null }]);
  assert.equal(buildJoinRoleSectionModel({ doc: null, access: OLIVE, error: '403: x' }).error, '403: x');
  assert.deepEqual(buildJoinRoleSectionModel({ doc: { mode: 'local' }, access: ADA }).primary, { enabled: false, reason: ADA.why.own });
  // B14 (mutation check 5): confirm rides an admin body only, and admin unticked is no call at all.
  assert.deepEqual(joinRoleBody('viewer', true), { role: 'viewer' });
  assert.deepEqual(joinRoleBody('operator', false), { role: 'operator' });
  assert.deepEqual(joinRoleBody(null, true), { role: null });
  assert.deepEqual(joinRoleBody('admin', true), { role: 'admin', confirm: true });
  assert.equal(joinRoleBody('admin', false), null);
  for (const r of ['viewer', 'operator', null]) assert.ok(!('confirm' in joinRoleBody(r, true)), `no confirm with ${r}`);
  assert.deepEqual(joinRoleStatus({ role: 'admin', from: null }), { kind: 'saved', text: 'Join role: none → admin.' });
  assert.deepEqual(joinRoleStatus({ role: null, from: 'operator' }), { kind: 'saved', text: 'Join role: operator → none.' });
  assert.deepEqual(joinRoleStatus({ role: 'viewer', from: 'viewer' }), { kind: 'idle', text: 'Nothing changed.' });
  // The editor: the four choices, the box shown on admin only, required.
  const ctx = { access: OLIVE, defaultOrgName: 'Default' };
  const ed = buildSettingsEditorModel('join-role', { mode: 'local', role: null }, { ctx });
  assert.deepEqual(ed.fields[0].options.map((o) => [o.value, o.label, o.selected]), [['viewer', 'viewer', false], ['operator', 'operator', false], ['admin', 'admin', false], [null, 'no automatic join', true]]);
  assert.deepEqual([ed.fields[1].type, ed.fields[1].showWhen, ed.fields[1].required], ['checkbox', { field: 'role', value: 'admin', now: false }, 'tick the box first']);
  assert.equal(ed.fields[1].label, 'I understand: every user the IdP lets in becomes an admin of Default — its name, its members and its MCP endpoints. To add admins one by one, use Members.');
  assert.deepEqual(ed.primary, { label: 'Save', enabled: true, reason: null });
  assert.equal(buildSettingsEditorModel('join-role', { mode: 'local', role: 'admin' }, { ctx }).fields[1].showWhen.now, true);
  assert.deepEqual(buildSettingsEditorModel('join-role', { mode: 'local', role: null }, { ctx, draft: { role: 'admin', confirm: true } }).draft, { role: 'admin', confirm: true });
});

test('the organisation and join-role loaders: one requestJson call each, the id encoded, confirm only when asked', async () => {
  const calls = [];
  const answer = { ok: true, org: { id: 'a/b' }, adopted: true, path: '/p', note: 'n', role: 'admin', from: null };
  const fetchFn = async (path, opts) => { calls.push([path, opts?.method ?? 'GET', opts?.body ?? null]); return answer; };
  assert.deepEqual(await createOrg({ id: 'charlie', adopt: true }, { fetchFn }), { org: { id: 'a/b' }, adopted: true, path: '/p' });
  assert.deepEqual(await removeOrg('a/b', { fetchFn }), { org: { id: 'a/b' }, note: 'n' });
  assert.deepEqual(await putJoinRole('admin', true, { fetchFn }), { role: 'admin', from: null });
  await putJoinRole('operator', false, { fetchFn });
  await putJoinRole(null, undefined, { fetchFn });
  assert.deepEqual(calls, [
    ['/api/admin/orgs', 'POST', '{"id":"charlie","adopt":true}'],
    ['/api/admin/orgs/a%2Fb', 'DELETE', null],
    ['/api/admin/join-role', 'PUT', '{"role":"admin","confirm":true}'],
    ['/api/admin/join-role', 'PUT', '{"role":"operator"}'],
    ['/api/admin/join-role', 'PUT', '{"role":null}'],
  ]);
});

test('renderSettings and the organisation and join-role editors: the rows escaped, Remove… by its rule; the id typed before the danger button works; Switch to it; the admin box gates Save', () => {
  const calls = [];
  const host = { settings: new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) }) };
  const xss = '<img src=x onerror="window.__x=1">';
  const orgs = [ORGS_DOC.orgs[0], { ...ORGS_DOC.orgs[2], name: xss }, ORGS_DOC.orgs[3]];
  const frame = buildSettingsFrameModel({ access: OLIVE, section: 'orgs', orgName: 'Acme', orgId: 'acme' });
  const c = settingsContainer();
  renderSettings(c, frame, { id: 'orgs', head: settingsSectionHead('orgs'), model: buildOrgsSectionModel({ orgs, defaultOrg: 'default', access: OLIVE, activeOrg: 'acme' }), status: { kind: 'ok', text: '' } }, host);
  const h = c.innerHTML;
  assert.ok(h.indexOf('id="set-nav-deployment"') < h.indexOf('data-section="orgs"') && h.indexOf('data-section="orgs"') < h.indexOf('data-section="join-role"'), 'Organisations and Join role under the deployment head');
  assert.ok(!h.includes('<img') && h.includes('&lt;img src=x'), 'a name is escaped');
  assert.ok(h.includes('id="set-primary">New organisation</button>'));
  assert.ok(h.includes('<li class="set-row is-removed" data-org-id="gone">') && !h.includes('data-org-remove="gone"'), 'a removed org is listed greyed, with no Remove…');
  assert.ok(h.includes('<span class="set-row-meta">removed 2026-10-04T00:00:00.000Z — a slug is never reused</span>'));
  assert.ok(h.includes('<button type="button" class="ux-secondary-btn" data-org-act="default">Act in default</button>'));
  assert.ok(!h.includes('data-org-act="gone"'), 'a removed org has no Act in');
  for (const b of c.querySelectorAll('[data-org-remove]')) b.fire('click');
  c.querySelector('#set-primary').fire('click');
  [...c.querySelectorAll('[data-org-act]')].find((b) => b.dataset.orgAct === 'charlie').fire('click');
  assert.deepEqual(calls, [
    ['explain', 'default is the default org and cannot be removed'],
    ['openEditor', { kind: 'org', id: 'charlie', step: 'confirm-delete' }],
    ['openEditor', { kind: 'org-create' }],
    ['switchTo', 'charlie', 'members'],
  ]);
  assert.equal(c.querySelectorAll('[data-org-remove]')[0].getAttribute('aria-disabled'), 'true');

  // The join role's section: the mode sentence as the scope, the recorded role, Change the join role….
  const j = settingsContainer();
  calls.length = 0;
  renderSettings(j, buildSettingsFrameModel({ access: OLIVE, section: 'join-role' }), { id: 'join-role', head: settingsSectionHead('join-role'), model: buildJoinRoleSectionModel({ doc: { mode: 'local', role: null }, access: OLIVE }), status: null }, host);
  assert.ok(j.innerHTML.includes('<p class="set-section-scope">Sign-in: local users. The join role applies to IdP users once OIDC is configured: none.</p>'));
  assert.ok(j.innerHTML.includes('id="set-join-role">Recorded join role: none — no automatic join</span>'));
  j.querySelector('#set-primary').fire('click');
  assert.deepEqual(calls, [['openEditor', { kind: 'join-role' }]]);

  // Remove…: the consequence, the id typed — the danger button aria-disabled until it matches.
  const r = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(r, buildSettingsEditorModel('org', ORGS_DOC.orgs[2], { ctx: { access: OLIVE, orgId: 'acme', defaultOrg: 'default' }, step: 'confirm-delete' }), host);
  assert.ok(r.innerHTML.includes('<span class="set-editor-typed-label" id="set-editor-typed-label">Type <code>charlie</code> to remove it</span>'));
  assert.ok(r.innerHTML.includes('id="set-editor-confirm" aria-disabled="true" aria-describedby="set-editor-typed-label">Remove charlie</button>'));
  r.querySelector('#set-editor-confirm').fire('click');
  r.querySelector('#set-editor-typed').value = 'charli';
  r.querySelector('#set-editor-typed').fire('input');
  assert.equal(r.querySelector('#set-editor-confirm').getAttribute('aria-disabled'), 'true');
  r.querySelector('#set-editor-typed').value = 'charlie';
  r.querySelector('#set-editor-typed').fire('input');
  assert.equal(r.querySelector('#set-editor-confirm').getAttribute('aria-disabled'), 'false');
  r.querySelector('#set-editor-confirm').fire('click');
  assert.deepEqual(calls, [['explain', 'Type charlie to remove it'], ['confirm', 'charlie']]);

  // Created: Close and Switch to it — the new org's Members.
  const n = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(n, buildSettingsEditorModel('org-create', null, { ctx: { access: OLIVE, created: { id: 'charlie' } }, step: 'notice', status: { kind: 'saved', text: 'Created Charlie (charlie) — …' } }), host);
  assert.ok(n.innerHTML.includes('id="set-editor-switch">Switch to it</button>') && !n.innerHTML.includes('id="set-editor-save"'));
  n.querySelector('#set-editor-switch').fire('click');
  assert.deepEqual(calls, [['switchTo', 'charlie', 'members']]);

  // The join role: the admin box hidden until admin is chosen; Save unavailable with "tick the box first" until ticked.
  const e = settingsContainer();
  calls.length = 0;
  renderSettingsEditor(e, buildSettingsEditorModel('join-role', { mode: 'local', role: null }, { ctx: { access: OLIVE, defaultOrgName: 'Default' } }), host);
  assert.ok(e.innerHTML.includes('<label class="set-editor-field set-editor-check" id="set-edit-confirm-field" hidden>'));
  assert.ok(e.innerHTML.includes('<input id="set-edit-confirm" name="confirm" type="checkbox">'));
  const admin = e.querySelectorAll('[data-seg="role"]').find((b) => b.dataset.value === 'admin');
  admin.fire('click');
  assert.equal(e.querySelector('#set-edit-confirm-field').hidden, false, 'the box shows on admin');
  assert.equal(e.querySelector('#set-editor-save').getAttribute('aria-disabled'), 'true');
  assert.equal(e.querySelector('#set-editor-save').why.textContent, 'tick the box first');
  e.querySelector('#set-editor-save').fire('click');
  e.querySelector('#set-edit-confirm').checked = true;
  e.querySelector('#set-edit-confirm').fire('change');
  assert.equal(e.querySelector('#set-editor-save').getAttribute('aria-disabled'), 'false');
  e.querySelector('#set-editor-save').fire('click');
  const operator = e.querySelectorAll('[data-seg="role"]').find((b) => b.dataset.value === 'operator');
  operator.fire('click');
  assert.equal(e.querySelector('#set-edit-confirm-field').hidden, true, 'the box hides again');
  e.querySelector('#set-editor-save').fire('click');
  assert.deepEqual(calls, [['explain', 'tick the box first'], ['save', { role: 'admin', confirm: true }], ['save', { role: 'operator', confirm: true }]],
    'the draft carries the box; joinRoleBody leaves confirm off every body but admin');
});

