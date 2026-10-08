#!/usr/bin/env node
/**
 * tools/test-mcp-settings-model.mjs — the pure models of the MCP panel's
 * Server settings modal (studio/mcp-settings-model.mjs, rebadge batch 4,
 * D1/D2): who may open it (every row of the gate), the browser's target
 * rule (the studio's own origin, a loopback MCP from a remote page in each
 * posture's words, plain http, the allowlist mirror, file://, the URL
 * policy), what a descriptor read means, the status line of every state,
 * the inputs' attributes, what an action sends, what the settings policy
 * shows and when its acknowledgement blocks, why the primary waits, and
 * the line after the connection test — from the read's outcome, never from
 * the verdict alone; and, through the studio server's pass-through, the
 * target rule's first step only, what its describe and submit answered and
 * how the lede and the status lines say so. The URL rules and the contract are the real tools/lib
 * modules, handed in as the browser hands in its /lib imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as lib from './lib/mcp-server-settings.mjs';
import * as safety from './lib/mcp-url-safety.mjs';
import {
  pageIsLoopback, settingsGateModel, settingsTargetModel, descriptorReadModel, statusLine, ledeText,
  fieldInputSpec, actionNote, primaryBlock, actionBlock, policyView, verifiedLine, proxyDescribeModel, proxyOutcomeModel,
} from '../studio/mcp-settings-model.mjs';
import { pingResultModel } from '../studio/live-model.mjs';

const libs = { lib, safety };
const PAGE = 'http://127.0.0.1:8090';
const admin = { posture: 'identity', role: 'admin', orgName: 'Acme' };
const allowed = { typed: { allowed: true }, register: { allowed: true } };

test('pageIsLoopback: this machine\'s origins, never a file:// page or a remote host', () => {
  for (const o of ['http://127.0.0.1:8090', 'http://localhost:3000', 'http://[::1]:8080', 'http://127.4.5.6']) assert.equal(pageIsLoopback(o), true, o);
  for (const o of ['null', 'https://studio.example', 'http://a.localhost:1', '', 'file:///x/index.html']) assert.equal(pageIsLoopback(o), false, o);
});

test('the gate: register.allowed opens it; a session below admin, the local caller off loopback, an unread or failed policy, the token posture each say why', () => {
  assert.deepEqual(settingsGateModel({ access: admin, mcpTargetPolicy: allowed, hasTarget: true, pageOrigin: PAGE }), { enabled: true, reason: null });
  const oscar = settingsGateModel({ access: { posture: 'identity', role: 'operator', orgName: 'Acme' }, mcpTargetPolicy: { typed: { allowed: false }, register: { allowed: false, why: 'x' } }, hasTarget: true });
  assert.equal(oscar.enabled, false);
  assert.equal(oscar.reason, "Configuring the MCP server is endpoint configuration: it needs the admin role in org 'Acme' (you are operator) — ask an admin of Acme.");
  const local = settingsGateModel({ access: { posture: 'open', role: 'admin' }, mcpTargetPolicy: { register: { allowed: false, why: 'registering an MCP endpoint without sign-in answers only requests sent straight to http://127.0.0.1:8090' } }, hasTarget: true });
  assert.match(local.reason, /^Configuring the MCP server is endpoint configuration: registering an MCP endpoint without sign-in answers only requests sent straight to http:\/\/127\.0\.0\.1:8090\.$/);
  assert.equal(settingsGateModel({ access: admin, mcpTargetPolicy: null, hasTarget: true }).reason, 'Checking whether you may configure the MCP server…');
  assert.equal(settingsGateModel({ access: admin, mcpTargetPolicy: { typed: { allowed: false }, register: { allowed: false }, failed: true }, hasTarget: true }).reason,
    'Could not check whether you may configure the MCP server — close and reopen the panel to try again.');
  assert.equal(settingsGateModel({ access: { posture: 'token', role: 'viewer' }, hasTarget: true }).reason, 'Checking whether you may configure the MCP server…', 'the token posture waits for the server\'s sentence');
  assert.equal(settingsGateModel({ access: { posture: 'unknown' }, hasTarget: true }).enabled, false);
});

// The way in the button names without sign-in is the server's own sentence
// (GET /api/mcp-endpoints `policy.register.why`, which ends in the server's
// way in for its posture — OBSERVOGRAM_AUTH=off included); a sentinel here,
// the real sentences per posture in server/test-mcp-target-policy.mjs.
test('the gate in the token posture: the server\'s own sentence as served, never a way in of its own; unread, failed or silent, it names none; the module keeps no copy of the rule', () => {
  const token = { posture: 'token', role: 'viewer', orgName: 'Default' };
  const WHY = 'anonymous callers are viewers here; registering an MCP endpoint needs a signed-in admin; <the server\'s way in>';
  const refused = { typed: { allowed: false, why: 'x' }, register: { allowed: false, why: WHY } };
  for (const hasTarget of [true, false]) {
    assert.deepEqual(settingsGateModel({ access: token, mcpTargetPolicy: refused, hasTarget, missing: 'choose an MCP endpoint or type a URL' }),
      { enabled: false, reason: `Configuring the MCP server is endpoint configuration: ${WHY}.` }, `hasTarget ${hasTarget}: the server's sentence first`);
  }
  assert.equal(settingsGateModel({ access: token, mcpTargetPolicy: null, hasTarget: true }).reason, 'Checking whether you may configure the MCP server…');
  assert.equal(settingsGateModel({ access: token, mcpTargetPolicy: { typed: { allowed: false }, register: { allowed: false }, failed: true }, hasTarget: true }).reason,
    'Could not check whether you may configure the MCP server — close and reopen the panel to try again.', 'a failed read names no way in');
  assert.equal(settingsGateModel({ access: token, mcpTargetPolicy: { typed: { allowed: false }, register: { allowed: false } }, hasTarget: true }).reason,
    'Configuring the MCP server is endpoint configuration, which is not open to you here.', 'a policy without a sentence names no way in');
  for (const [posture, policy] of [['token', null], ['token', refused], ['static', null], ['open', refused]]) {
    const reason = settingsGateModel({ access: { posture, role: 'viewer' }, mcpTargetPolicy: policy, hasTarget: true, pageOrigin: 'https://cdn.example', bundleOrigins: null }).reason ?? '';
    assert.doesNotMatch(reason.replace(WHY, ''), /npm run users|OIDC|OBSERVOGRAM_AUTH|sign-in/, `${posture}: no way in but the server's`);
  }
  const src = readFileSync(new URL('../studio/mcp-settings-model.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /npm run users|configure OIDC|has no sign-in/, 'the rule lives in the server (server/authz.mjs noSignInWay) only');
});

test('the gate: no target says the panel\'s own sentence; the static bundle needs a loopback page or a baked origin list', () => {
  assert.equal(settingsGateModel({ access: admin, mcpTargetPolicy: allowed, hasTarget: false, missing: 'choose one of Acme\'s MCP endpoints' }).reason, 'Choose one of Acme\'s MCP endpoints.');
  const stat = { posture: 'static' };
  assert.equal(settingsGateModel({ access: stat, hasTarget: true, pageOrigin: 'https://cdn.example', bundleOrigins: undefined }).enabled, false, 'unread');
  assert.equal(settingsGateModel({ access: stat, hasTarget: true, pageOrigin: 'https://cdn.example', bundleOrigins: null }).reason,
    'This bundle was built without an MCP origin list, so from https://cdn.example it can send settings to no MCP server — rebuild it with --mcp-origins <origin>, or serve it from this machine (http://127.0.0.1) to configure a loopback MCP server.');
  assert.equal(settingsGateModel({ access: stat, hasTarget: true, pageOrigin: 'https://cdn.example', bundleOrigins: { listed: true, origins: ['https://mcp.example'] } }).enabled, true);
  assert.equal(settingsGateModel({ access: stat, hasTarget: true, pageOrigin: PAGE, bundleOrigins: null }).enabled, true, 'a loopback page');
  assert.equal(settingsGateModel({ access: stat, hasTarget: false, missing: 'choose an MCP endpoint or type a URL', pageOrigin: PAGE, bundleOrigins: null }).reason, 'Choose an MCP endpoint or type a URL.');
});

const target = (url, o = {}) => settingsTargetModel({ url, posture: 'identity', origins: { listed: false, origins: [] }, pageOrigin: PAGE, ...o }, libs);

test('the target rule: a loopback MCP from a loopback page passes; the descriptor URL is under the MCP server root', () => {
  assert.deepEqual(target('http://127.0.0.1:9000/mcp'), { ok: true, origin: 'http://127.0.0.1:9000', descriptorUrl: 'http://127.0.0.1:9000/admin/schema' });
  assert.equal(target('http://127.0.0.1:9000/team-a/mcp/').descriptorUrl, 'http://127.0.0.1:9000/team-a/admin/schema');
  assert.equal(target('https://mcp.example/gw/mcp', { origins: { listed: true, origins: ['https://mcp.example'] } }).descriptorUrl, 'https://mcp.example/gw/admin/schema');
});

test('the target rule: the URL policy first, then never the studio\'s own origin', () => {
  assert.equal(target('ftp://127.0.0.1/mcp').reason, safety.mcpUrlPolicy('ftp://127.0.0.1/mcp').error);
  assert.equal(target('not a url').ok, false);
  assert.equal(target(`${PAGE}/mcp`).reason, "the MCP server shares the studio's origin (http://127.0.0.1:8090), so its settings would go to the studio server — give the MCP server its own origin (another port or host)");
  for (const u of ['http://localhost:8090/mcp', 'http://[::1]:8090/mcp', 'http://127.0.0.2:8090/mcp', 'http://a.localhost:8090/mcp', 'https://localhost:8090/mcp']) {
    assert.match(target(u).reason ?? '', /^the MCP server shares the studio's origin \(/, `${u}: another name for the studio's own address`);
  }
  assert.equal(target('http://localhost:9000/mcp').ok, true, 'another port on this machine is not the studio');
  assert.equal(target('http://localhost/mcp', { pageOrigin: 'http://127.0.0.1' }).ok, false, 'the default port, spelled or not');
});

test('the target rule: a target that may be this machine, from a page that is not, is refused in each posture\'s words (file:// is the static one)', () => {
  const remote = { pageOrigin: 'https://studio.example' };
  assert.equal(target('http://127.0.0.1:9000/mcp', remote).reason, "http://127.0.0.1:9000 names the studio server's own machine, which your browser cannot reach as the same host — open the studio on that machine (http://127.0.0.1:<port>)");
  assert.match(target('http://127.0.0.1:9000/mcp', { ...remote, proxyWayOut: true }).reason, /, or the studio's operator turns on OBSERVOGRAM_MCP_ADMIN_PROXY=1$/);
  for (const u of ['http://a.localhost:9000/mcp', 'http://0.0.0.0:9000/mcp', 'http://[::]:9000/mcp']) assert.match(target(u, remote).reason, /names the studio server's own machine/, u);
  assert.equal(target('http://127.0.0.1:9000/mcp', { posture: 'static', pageOrigin: 'null' }).reason,
    'http://127.0.0.1:9000 names a loopback address, and this bundle is served from null: the static bundle sends settings to a loopback MCP server only from a page served on that machine — serve the bundle over http://127.0.0.1 (not file://)');
  assert.ok(!/studio server|OBSERVOGRAM_MCP_ADMIN_PROXY/.test(target('http://127.0.0.1:9000/mcp', { posture: 'static', pageOrigin: 'https://cdn.example', proxyWayOut: true }).reason), 'a static refusal names no studio server');
});

test('the target rule: https unless loopback, and a remote origin only when listed (or the list is *)', () => {
  assert.equal(target('http://mcp.example/mcp', { origins: { listed: true, origins: null } }).reason, 'http://mcp.example is plain http, and settings carry a credential across the network — serve the MCP server over https, or run it on this machine');
  assert.equal(target('https://mcp.example/mcp').reason, "https://mcp.example is not a listed MCP origin, and settings carry a credential, which goes only to a listed origin or this machine — the server's operator adds https://mcp.example to OBSERVOGRAM_MCP_ORIGINS (or the org's OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS)");
  assert.equal(target('https://mcp.example/mcp', { origins: { listed: true, origins: ['https://other.example'] } }).ok, false);
  assert.equal(target('https://mcp.example/mcp', { origins: null }).ok, false, 'no list at all');
  assert.equal(target('https://mcp.example/mcp', { origins: { listed: true, origins: null } }).ok, true, '*');
  assert.equal(target('https://mcp.example/mcp', { posture: 'static', origins: null }).reason, 'https://mcp.example is not a listed MCP origin, and settings carry a credential, which goes only to a listed origin or this machine — rebuild the bundle with --mcp-origins https://mcp.example');
  assert.equal(target('http://a.localhost:9000/mcp').ok, false, 'a may-be-local name is never a loopback exemption: plain http, unlisted');
});

const ctx = { mcpUrl: 'http://127.0.0.1:9000/mcp', descriptorUrl: 'http://127.0.0.1:9000/admin/schema' };
const read = (status, json, contentType = 'application/json') => ({ kind: 'answer', status, contentType, text: typeof json === 'string' ? json : JSON.stringify(json) });
const SPEC = { version: 1, endpoint: '/configure', fields: [{ name: 'grafanaUrl', label: 'Backend base URL', type: 'url', required: true }, { name: 'apiKey', label: 'Server API key', type: 'secret' }], actions: [{ name: 'disable', label: 'Clear server credential' }] };

test('the descriptor read: a description, the generic form for 404/405/501/401/403 and a non-description, refusals named, unreachable and redirect', () => {
  const d = descriptorReadModel(read(200, SPEC), ctx, libs);
  assert.equal(d.state, 'described');
  assert.deepEqual(d.descriptor.fields.map((f) => f.name), ['grafanaUrl', 'apiKey']);
  for (const s of [404, 405, 501]) assert.deepEqual(descriptorReadModel(read(s, { error: 'x' }), ctx, libs), { state: 'generic', reason: `GET /admin/schema answered ${s}` });
  assert.deepEqual(descriptorReadModel(read(401, {}), ctx, libs), { state: 'generic', reason: 'it answered 401 — a settings description must be readable without a key' });
  assert.deepEqual(descriptorReadModel(read(200, { jsonrpc: '2.0', id: 1, result: {} }), ctx, libs), { state: 'generic', reason: 'what it answered is not a settings description: a JSON-RPC message' });
  assert.equal(descriptorReadModel(read(200, 'hello', 'text/plain'), ctx, libs).state, 'generic');
  assert.match(descriptorReadModel(read(200, { ...SPEC, version: 2 }), ctx, libs).reason, /version 2; this studio reads version 1/);
  assert.match(descriptorReadModel(read(200, { ...SPEC, endpoint: '//evil.example/x' }), ctx, libs).reason, /is not a plain path under http:\/\/127\.0\.0\.1:9000\//);
  assert.equal(descriptorReadModel(read(500, 'boom', 'text/plain'), ctx, libs).state, 'refused');
  assert.match(descriptorReadModel({ kind: 'oversize', bytes: 20000 }, ctx, libs).reason, /larger than 16 KiB \(20000 bytes\)/);
  assert.deepEqual(descriptorReadModel({ kind: 'unreachable' }, ctx, libs), { state: 'unreachable', redirect: false });
  assert.deepEqual(descriptorReadModel({ kind: 'redirect' }, ctx, libs), { state: 'unreachable', redirect: true });
});

test('the status line of every state, exactly', () => {
  const m = { descriptorUrl: ctx.descriptorUrl, pageOrigin: PAGE };
  assert.equal(statusLine({ ...m, state: 'reading' }).text, "Reading the server's settings description from http://127.0.0.1:9000/admin/schema…");
  assert.equal(statusLine({ ...m, state: 'described' }).text, 'The server describes its settings (version 1).');
  assert.equal(statusLine({ ...m, state: 'generic', genericReason: 'GET /admin/schema answered 404' }).text,
    "This server publishes no settings description (GET /admin/schema answered 404). This is a generic form: check the field names and the path against the server's documentation.");
  assert.equal(statusLine({ ...m, state: 'unreachable' }).text,
    'Your browser could not read http://127.0.0.1:9000/admin/schema. The server may be down, or it does not answer this page\'s origin (http://127.0.0.1:8090) with CORS headers — its operator adds that origin to the MCP server\'s allowed origins (MCP_INTEGRATION "Server settings").');
  assert.match(statusLine({ ...m, state: 'unreachable', proxyWayOut: true }).text, /, or the studio's operator turns on OBSERVOGRAM_MCP_ADMIN_PROXY=1\.$/);
  assert.equal(statusLine({ ...m, state: 'unreachable', redirect: true }).text, "The server answered with a redirect, which the studio never follows — configure the MCP endpoint's final URL.");
  assert.equal(statusLine({ ...m, state: 'refused', reason: 'duplicate field name "user"' }).text, 'Duplicate field name "user".');
  assert.equal(statusLine({ ...m, state: 'target-refused', reason: 'x is plain http' }).kind, 'error');
  assert.equal(statusLine({ ...m, state: 'target-refused', reason: 'http://mcp.example is plain http' }).text, 'http://mcp.example is plain http.', 'a reason that starts with an origin keeps its scheme as typed');
  assert.equal(statusLine({ ...m, state: 'refused', reason: 'https://mcp.example is not a listed MCP origin' }).text, 'https://mcp.example is not a listed MCP origin.');
  assert.equal(statusLine({ ...m, state: 'sending', sendingTo: 'http://127.0.0.1:9000/configure' }).text, 'Sending to http://127.0.0.1:9000/configure…');
  assert.deepEqual(statusLine({ ...m, state: 'outcome', outcome: { headline: 'The server reports the settings verified (HTTP 200).', tone: 'ok' } }), { text: 'The server reports the settings verified (HTTP 200).', kind: 'ok' });
  assert.match(statusLine({ ...m, state: 'unknown' }).text, /^The request was sent, but its answer could not be read \(no CORS header on the answer, a network error, or no answer within 15 s\)\. The server may have applied the settings/);
  assert.equal(statusLine({ ...m, state: 'verifying', outcome: { headline: 'H.' } }).text, 'H. Testing the connection through the studio…');
  assert.equal(ledeText('http://127.0.0.1:9000'), 'These settings go to the MCP server itself — your browser sends them directly to http://127.0.0.1:9000. The studio keeps none of them.');
});

test('the inputs: a secret is a password with autocomplete=new-password; every text-like input has the managers\' ignore attributes and maxlength; never a name or a value', () => {
  const secret = fieldInputSpec({ name: 'apiKey', type: 'secret', placeholder: 'ignored' });
  assert.equal(secret.type, 'password');
  assert.equal(secret.attrs.autocomplete, 'new-password');
  assert.equal(secret.attrs.placeholder, undefined, 'never a placeholder on a secret');
  const url = fieldInputSpec({ name: 'grafanaUrl', type: 'url', required: true, placeholder: 'https://…' });
  assert.deepEqual([url.type, url.attrs.autocomplete, url.attrs['aria-required'], url.attrs.placeholder, url.attrs.maxlength], ['url', 'off', 'true', 'https://…', '2048']);
  for (const s of [secret, url, fieldInputSpec({ name: 'user', type: 'text' })]) {
    for (const k of ['data-1p-ignore', 'data-lpignore', 'data-bwignore']) assert.ok(k in s.attrs, k);
    assert.ok(!('name' in s.attrs) && !('value' in s.attrs));
  }
  assert.deepEqual(fieldInputSpec({ name: 'tls', type: 'boolean' }), { type: 'checkbox', attrs: { 'data-field': 'tls' } });
  assert.equal(fieldInputSpec({ name: 'x', type: 'text' }).attrs['data-field'], 'x');
});

test('what an action sends: its carried fields by label, and an empty one named with the way to fill it', () => {
  const d = lib.parseSettingsDescriptor(JSON.stringify(SPEC)).descriptor;
  assert.equal(actionNote(lib.settingsRequest(d, {}, { action: 'disable' }).carries), 'Sends: nothing but the action — Server API key is empty, so a server that needs it will refuse; type it above.');
  assert.equal(actionNote(lib.settingsRequest(d, { apiKey: 'k3y-1' }, { action: 'disable' }).carries), 'Sends: Server API key.');
  assert.equal(actionNote([{ label: 'A', empty: false }, { label: 'B', empty: true }, { label: 'C', empty: true }]), 'Sends: A. B and C are empty, so a server that needs them will refuse; type them above.');
  assert.equal(actionNote([]), 'Sends: only the action.');
});

test('why the primary waits: an unreadable policy, the generic form\'s expectations, an unticked ack, a missing field — a served policy alone blocks nothing', () => {
  assert.equal(primaryBlock({ policyState: 'served' }), null, 'a served policy blocks only through its findings');
  assert.equal(primaryBlock({ policyState: 'failed' }), 'Could not read the settings policy, so its checks cannot run — close and reopen to try again.');
  assert.match(primaryBlock({ policyState: 'loading' }), /^Reading the settings policy/);
  assert.equal(primaryBlock({ genericReason: 'the field name "url" is used twice', requestReason: 'x', ackReason: 'y' }), 'What the server expects: the field name "url" is used twice.');
  assert.equal(primaryBlock({ policyState: 'served', ackReason: 'Tick "a" to send — w.', requestReason: 'x' }), 'Tick "a" to send — w.');
  assert.equal(primaryBlock({ requestReason: 'fill in Backend base URL — the server requires it' }), 'Fill in Backend base URL — the server requires it.');
  assert.equal(primaryBlock({}), null);
});

test('the settings policy in the modal: one entry per rule, its notes, and the first unticked ack blocks the send — a ticked one, or a rule without an ack, does not', () => {
  const { policy } = lib.compileSettingsPolicy({
    version: 1,
    rules: [
      { when: { field: 'grafanaUrl', pattern: '^(?!https://approved\\.)' }, warn: 'Non-approved backend host.', require: { ack: 'I have operator approval for this target' } },
      { when: { type: 'text', pattern: '^root$' }, warn: 'A shared login.' },
    ],
  }, { timed: false });
  const form = lib.parseSettingsDescriptor(JSON.stringify({ version: 1, endpoint: '/configure', fields: [{ name: 'grafanaUrl', label: 'Backend base URL', type: 'url', required: true }, { name: 'user', label: 'User', type: 'text' }] })).descriptor;
  assert.deepEqual(policyView(lib.policyFindings(policy, form, {}), []), { rules: [], block: null }, 'an empty form finds nothing');
  const bad = policyView(lib.policyFindings(policy, form, { grafanaUrl: 'https://elsewhere.example', user: 'root' }), []);
  assert.deepEqual(bad.rules, [
    { rule: 0, warn: 'Non-approved backend host.', ack: 'I have operator approval for this target', notes: [] },
    { rule: 1, warn: 'A shared login.', ack: null, notes: [] },
  ]);
  assert.equal(bad.block, 'Tick "I have operator approval for this target" to send — Non-approved backend host.');
  assert.equal(policyView(lib.policyFindings(policy, form, { grafanaUrl: 'https://elsewhere.example' }), [0]).block, null, 'ticked');
  assert.equal(policyView(lib.policyFindings(policy, form, { grafanaUrl: 'HTTPS://APPROVED.example/' }), []).rules.length, 0, 'matched as the normalised href');
  // The generic form names its URL "url": the grafanaUrl rule cannot run, and its ack is required all the same.
  const generic = lib.genericDescriptor();
  const unevaluated = policyView(lib.policyFindings(policy, generic, {}), ['1']);
  assert.deepEqual(unevaluated.rules, [{ rule: 0, warn: 'Non-approved backend host.', ack: 'I have operator approval for this target', notes: ['Policy rule 1 checks grafanaUrl, which this form does not have, so it cannot run.'] }]);
  assert.match(unevaluated.block, /^Tick "I have operator approval for this target" to send/);
  assert.equal(policyView(lib.policyFindings(policy, generic, {}), ['0']).block, null, 'the indexes read from the DOM are strings');
  // A type rule that matches two fields warns once.
  const two = lib.parseSettingsDescriptor(JSON.stringify({ version: 1, endpoint: '/configure', fields: [{ name: 'a', label: 'A', type: 'text' }, { name: 'b', label: 'B', type: 'text' }] })).descriptor;
  assert.deepEqual(policyView(lib.policyFindings(policy, two, { a: 'root', b: 'root' })).rules.map((r) => r.rule), [0, 1], 'rule 0 unevaluated, rule 1 once for two fields');
  assert.deepEqual(policyView(null), { rules: [], block: null });
  // An action: the pass-through's rule — only a matched rule on a field it sends, and an unread policy only when it sends one.
  const found = lib.policyFindings(policy, form, { grafanaUrl: 'https://elsewhere.example', user: 'root' });
  assert.equal(actionBlock({ policyState: 'served', findings: found, sent: ['grafanaUrl'] }), bad.block, 'an action that carries the URL waits for its ack');
  assert.equal(actionBlock({ policyState: 'served', findings: found, sent: ['grafanaUrl'], ticked: ['0'] }), null, 'ticked');
  assert.equal(actionBlock({ policyState: 'served', findings: found, sent: ['user'] }), null, 'rule 1 has no ack');
  assert.equal(actionBlock({ policyState: 'served', findings: found, sent: [] }), null, 'an action that carries nothing sets no value the policy checks');
  assert.equal(actionBlock({ policyState: 'served', findings: lib.policyFindings(policy, generic, {}), sent: ['url'] }), null, 'an unevaluated rule concerns the form, not the action');
  assert.equal(actionBlock({ policyState: 'failed', findings: [], sent: ['grafanaUrl'] }), primaryBlock({ policyState: 'failed' }));
  assert.equal(actionBlock({ policyState: 'failed', findings: [], sent: [] }), null);
});

const ping = (verdict, read) => {
  const answer = { ok: verdict === 'connected', verdict, timings: { totalMs: 12 }, tools: { count: 1, unmatched: 0, capabilities: {} }, read };
  return { model: pingResultModel(answer), answer };
};

test('after the connection test: "the read answered" only on a read outcome ok — a connected ping whose read failed says so', () => {
  const h = 'The server reports the settings verified (HTTP 200).';
  assert.deepEqual(verifiedLine(h, ping('connected', { outcome: 'ok', tool: 'health', detail: 'version 11' })), { text: `${h} Connection test: connected, and the read health answered: version 11.`, kind: 'ok' });
  const failed = ping('connected', { outcome: 'failed', tool: 'health', error: 'health: backend not configured' });
  assert.equal(failed.model.status.startsWith('connected'), true, 'the verdict alone says connected');
  assert.deepEqual(verifiedLine(h, failed), { text: `${h} Connection test: connected, but the read failed: health: backend not configured.`, kind: 'warn' });
  assert.equal(verifiedLine(h, ping('connected', { outcome: 'failed', tool: 'health', error: null })).text, `${h} Connection test: connected, but the read failed: health answered with an error.`, 'the server passes no error text back');
  assert.match(verifiedLine(h, ping('connected', { outcome: 'timeout', tool: 'health' })).text, /the read failed: health did not answer in time\.$/);
  assert.match(verifiedLine(h, ping('connected', { outcome: 'failed', tool: 'health', backendAuthRefused: true })).text, /the read failed: health's backend refused the MCP's own credentials\.$/);
  assert.equal(verifiedLine(h, ping('connected', { outcome: 'not-advertised' })).text, `${h} Connection test: connected; this server offers no read the studio tests with.`);
  assert.equal(verifiedLine(h, ping('unreachable', null)).kind, 'error');
  assert.equal(verifiedLine('', null, { error: '403: no' }).text, 'Connection test: could not run — 403: no.');
  assert.equal(verifiedLine(h, null, { isStatic: true }).text, `${h} The connection test needs the studio server; the static bundle has none.`);
});

test('through the studio server (the pass-through): only the URL policy runs in the page — the server applies the origin, https and own-address rules', () => {
  const t = (url, o = {}) => settingsTargetModel({ url, posture: 'identity', origins: null, pageOrigin: 'https://studio.example', proxy: true, ...o }, libs);
  assert.deepEqual(t('http://127.0.0.1:9000/mcp'), { ok: true, origin: 'http://127.0.0.1:9000', descriptorUrl: 'http://127.0.0.1:9000/admin/schema' }, 'a loopback MCP from a remote page: the studio server reaches it');
  assert.deepEqual(t('http://mcp.example/team/mcp'), { ok: true, origin: 'http://mcp.example', descriptorUrl: 'http://mcp.example/team/admin/schema' }, 'plain http and unlisted: the server decides');
  assert.equal(t('ftp://mcp.example/mcp').ok, false, 'the URL policy still runs');
  assert.equal(settingsTargetModel({ url: 'http://mcp.example/mcp', posture: 'identity', pageOrigin: PAGE, proxy: false }, libs).ok, false, 'without it, the browser\'s rules');
});

test('what the pass-through answered: its describe read as the browser\'s own read (the description parsed again), a refusal in the studio server\'s words; its submit as an outcome with no body', () => {
  const at = { mcpUrl: 'http://127.0.0.1:9000/mcp', descriptorUrl: 'http://127.0.0.1:9000/admin/schema' };
  const desc = { version: 1, endpoint: '/configure', fields: [{ name: 'u', label: 'URL', type: 'url', required: true }] };
  const d = proxyDescribeModel({ ok: true, status: 200, descriptor: desc }, at, libs);
  assert.equal(d.state, 'described');
  assert.deepEqual(d.descriptor.fields.map((f) => f.name), ['u']);
  // As the studio server sends it: the normalised form, absent keys as null (an action's fields, a help).
  const served = lib.parseSettingsDescriptor(JSON.stringify({ ...desc, actions: [{ name: 'disable', label: 'Clear' }] })).descriptor;
  assert.equal(served.actions[0].fields, null);
  assert.deepEqual(proxyDescribeModel({ ok: true, status: 200, descriptor: JSON.parse(JSON.stringify(served)) }, at, libs).descriptor?.actions.map((a) => a.name), ['disable']);
  assert.deepEqual(proxyDescribeModel({ ok: true, status: 200, descriptor: { ...desc, endpoint: '//evil.example/x' } }, at, libs).state, 'refused', 'the path rule runs in the page too');
  assert.deepEqual(proxyDescribeModel({ ok: true, status: 404 }, at, libs), { state: 'generic', reason: 'GET /admin/schema answered 404' });
  assert.deepEqual(proxyDescribeModel({ ok: true, status: 401 }, at, libs), { state: 'generic', reason: 'it answered 401 — a settings description must be readable without a key' });
  assert.deepEqual(proxyDescribeModel({ ok: true, status: 200, notDescriptor: 'a JSON-RPC message' }, at, libs), { state: 'generic', reason: 'what it answered is not a settings description: a JSON-RPC message' });
  assert.deepEqual(proxyDescribeModel({ ok: true, status: 200, reason: 'duplicate field name "u"' }, at, libs), { state: 'refused', reason: 'duplicate field name "u"' });
  assert.deepEqual(proxyDescribeModel({ ok: true, status: 500 }, at, libs).state, 'refused');
  assert.deepEqual(proxyDescribeModel(null, { ...at, error: new Error('502: the MCP server at http://127.0.0.1:9000 answered with a redirect') }, libs),
    { state: 'refused', reason: 'the studio server answered 502: the MCP server at http://127.0.0.1:9000 answered with a redirect' });
  const ok = proxyOutcomeModel({ ok: true, status: 200, contentType: 'application/json', bytes: 80, outcome: { ok: true, message: 'Applied.', checks: [{ label: 'Identity', status: 'pass', detail: null }] }, redacted: 0 }, libs);
  assert.deepEqual([ok.tone, ok.headline, ok.success, ok.message, ok.checks.length, ok.raw, ok.note], ['ok', 'The server reports the settings verified (HTTP 200).', true, 'Applied.', 1, null, null]);
  const html = proxyOutcomeModel({ ok: true, status: 500, contentType: 'text/html', bytes: 2048, outcome: null, redacted: 1 }, libs);
  assert.deepEqual([html.tone, html.headline, html.success, html.raw, html.redacted], ['error', 'The server refused the settings: HTTP 500.', false, null, 1]);
  assert.equal(html.note, "The server's answer was not in the outcome shape (2048 bytes of text/html); the studio server does not pass other bodies through.");
  const plain = proxyOutcomeModel({ ok: true, status: 204, contentType: null, bytes: 0, outcome: null, redacted: 0 }, libs);
  assert.deepEqual([plain.headline, plain.success], ['The server accepted the settings (HTTP 204). It reported no verification.', true]);
  assert.match(plain.note, /\(0 bytes of no stated type\)/);
  assert.equal(proxyOutcomeModel({ ok: true, status: 200, bytes: 9, outcome: { ok: false }, redacted: 0 }, libs).success, false, 'ok: false is no success');
});

test('the words of the pass-through: the lede says the studio server passes the settings through; reading, sending and unknown say so; the way out names OBSERVOGRAM_MCP_ADMIN_PROXY only where it is off', () => {
  assert.equal(ledeText('http://127.0.0.1:9000', { proxy: true }), 'These settings go to the MCP server itself — the studio server passes them through to http://127.0.0.1:9000 without keeping them (OBSERVOGRAM_MCP_ADMIN_PROXY). The studio keeps none of them.');
  assert.equal(ledeText('http://127.0.0.1:9000'), 'These settings go to the MCP server itself — your browser sends them directly to http://127.0.0.1:9000. The studio keeps none of them.');
  const m = { descriptorUrl: 'http://127.0.0.1:9000/admin/schema', pageOrigin: PAGE, proxy: true };
  assert.equal(statusLine({ ...m, state: 'reading' }).text, "Reading the server's settings description from http://127.0.0.1:9000/admin/schema through the studio server…");
  assert.equal(statusLine({ ...m, state: 'sending', sendingTo: 'http://127.0.0.1:9000/configure' }).text, 'Sending to http://127.0.0.1:9000/configure through the studio server…');
  assert.equal(statusLine({ ...m, state: 'unknown' }).text, "The studio server sent the settings, but no answer came back from the MCP server. The server may have applied the settings — test the connection, or check the server's log.");
  assert.ok(!/CORS/.test(statusLine({ ...m, state: 'unknown' }).text), 'no CORS on the studio server\'s path');
});

test('mcp-settings-model.mjs is a pure model and mcp-settings-api.mjs a loader: no DOM, no state, no app import; the brand stays out', () => {
  const model = readFileSync(new URL('../studio/mcp-settings-model.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...model.matchAll(/from '([^']+)'/g)].map((x) => x[1]), [], 'the model imports nothing');
  const code = model.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bdocument\.|\bwindow\.|\bfetch\(|\bstate\.|localStorage|sessionStorage/.test(code), 'no DOM, fetch, state or storage');
  assert.ok(!/Observogram\b/.test(code), 'no product name in what the reader is told');
  const api = readFileSync(new URL('../studio/mcp-settings-api.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...api.matchAll(/from '([^']+)'/g)].map((x) => x[1]), ['./services-api.mjs']);
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(api), 'the loader keeps nothing');
});
