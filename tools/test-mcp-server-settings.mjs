#!/usr/bin/env node
/**
 * tools/test-mcp-server-settings.mjs — the MCP server-settings contract
 * (rebadge batch 4, D1–D3): tools/lib/mcp-server-settings.mjs, the
 * vendorable module the studio's Server settings modal, the studio server's
 * settings-policy loader and pass-through, and an MCP server author share.
 *
 * The descriptor contract v1 (accepted, refused with a named reason, or not
 * a descriptor at all); the MCP server root and the strict path rule, run
 * against a loopback root and a path-prefixed https root; the backend URL's
 * normalisation; the generic form; the request (auth to a header, the
 * null-prototype body, what an action carries); the outcome model and its
 * redaction by value in every form and by key class; the settings policy's
 * strict schema, its pattern bounds for URL-length values and its findings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SETTINGS_DESCRIPTOR_VERSION, SETTINGS_DESCRIPTOR_PATH, SETTINGS_LIMITS, FIELD_TYPES, GENERIC_NAMES,
  genericDescriptor, settingsRoot, resolveSettingsPath, parseSettingsDescriptor, normaliseUrlValue,
  settingsRequest, outcomeOf, redactEchoes, redactSecretKeys, compileSettingsPolicy, policyFindings,
} from './lib/mcp-server-settings.mjs';
import { compileBoundedPattern } from './lib/artefact-classify.mjs';
import * as settingsModule from './lib/mcp-server-settings.mjs';

const MCP = 'http://127.0.0.1:9000/mcp';
const GW = 'https://gw.example/team-a/mcp';
const JSON_TYPE = 'application/json';

// The descriptor the SPEC gives, as written (no `auth`).
const SPEC = Object.freeze({
  version: 1,
  endpoint: '/configure',
  fields: [
    { name: 'grafanaUrl', label: 'Backend base URL', type: 'url', required: true },
    { name: 'user', label: 'User', type: 'text' },
    { name: 'secret', label: 'Password / token', type: 'secret' },
    { name: 'apiKey', label: 'Server API key', type: 'secret', help: 'leave empty on loopback dev' },
  ],
  actions: [{ name: 'disable', label: 'Clear server credential' }],
});
const SPEC_POLICY = Object.freeze({
  version: 1,
  rules: [{ when: { field: 'grafanaUrl', pattern: '^(?!https://approved\\.)' }, warn: 'Non-approved backend host.', require: { ack: 'I have operator approval for this target' } }],
});

const clone = (o) => JSON.parse(JSON.stringify(o));
const parse = (doc, opts = { mcpUrl: MCP, contentType: JSON_TYPE }) => parseSettingsDescriptor(typeof doc === 'string' ? doc : JSON.stringify(doc), opts);
const described = (doc = SPEC) => {
  const r = parse(doc);
  assert.ok(r.descriptor, `expected a descriptor, got ${JSON.stringify(r)}`);
  return r.descriptor;
};
const policyOf = (doc) => {
  const r = compileSettingsPolicy(doc);
  assert.deepEqual(r.errors, []);
  return r.policy;
};

// ---------- the descriptor ----------

test('the constants: version 1, admin/schema under the root, the four field types and the generic names; docs/VENDORING.md lists the module', () => {
  assert.equal(SETTINGS_DESCRIPTOR_VERSION, 1);
  assert.equal(SETTINGS_DESCRIPTOR_PATH, 'admin/schema');
  assert.deepEqual([...FIELD_TYPES], ['text', 'url', 'secret', 'boolean']);
  assert.deepEqual({ ...GENERIC_NAMES }, { url: 'url', user: 'user', secret: 'secret', apiKey: 'apiKey' });
  assert.ok(Object.isFrozen(SETTINGS_LIMITS) && SETTINGS_LIMITS.descriptorBytes === 16384 && SETTINGS_LIMITS.policyValue === 512);
  assert.equal(resolveSettingsPath(SETTINGS_DESCRIPTOR_PATH, MCP).url, 'http://127.0.0.1:9000/admin/schema');
  assert.equal(resolveSettingsPath(SETTINGS_DESCRIPTOR_PATH, GW).url, 'https://gw.example/team-a/admin/schema');
  // The vendorable set's table names this module, its sibling imports and
  // every export, and the taxonomy's row names the pattern rule it shares.
  const rows = readFileSync(new URL('../docs/VENDORING.md', import.meta.url), 'utf8').split('\n');
  const row = rows.find((l) => l.startsWith('| [`tools/lib/mcp-server-settings.mjs`]'));
  assert.ok(row, 'docs/VENDORING.md has a row for tools/lib/mcp-server-settings.mjs');
  for (const dep of ['artefact-classify.mjs', 'mcp-url-safety.mjs']) assert.ok(row.includes(`\`${dep}\``), `the row names its import ${dep}`);
  for (const name of Object.keys(settingsModule)) assert.ok(row.includes(`\`${name}\``), `the row names the export ${name}`);
  const taxonomy = rows.find((l) => l.startsWith('| [`tools/lib/artefact-classify.mjs`]'));
  assert.ok(taxonomy?.includes('`compileBoundedPattern`'), "artefact-classify.mjs's row names compileBoundedPattern");
});

test('the SPEC descriptor parses into the normalised, frozen description', () => {
  const d = described();
  assert.deepEqual(clone(d), {
    version: 1, endpoint: '/configure', auth: null,
    fields: [
      { name: 'grafanaUrl', label: 'Backend base URL', type: 'url', required: true, help: null, placeholder: null },
      { name: 'user', label: 'User', type: 'text', required: false, help: null, placeholder: null },
      { name: 'secret', label: 'Password / token', type: 'secret', required: false, help: null, placeholder: null },
      { name: 'apiKey', label: 'Server API key', type: 'secret', required: false, help: 'leave empty on loopback dev', placeholder: null },
    ],
    actions: [{ name: 'disable', label: 'Clear server credential', endpoint: '/configure', fields: null, confirm: null }],
  });
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.fields[0]) && Object.isFrozen(d.actions));
});

test('a higher version is named with its way out; a missing or non-integer version is refused', () => {
  assert.equal(parse({ ...SPEC, version: 2 }).reason,
    'this server describes its settings in version 2; this studio reads version 1 — update the studio, or use the generic form');
  const { version: _v, ...noVersion } = SPEC;
  assert.match(parse(noVersion).reason, /"version" must be an integer \(got undefined\)/);
  assert.match(parse({ ...SPEC, version: '1' }).reason, /"version" must be an integer \(got "1"\)/);
  assert.match(parse({ ...SPEC, version: 0 }).reason, /version 0 is not one/);
});

test('a JSON-RPC answer, an object without version and fields, and a non-JSON type are not descriptors', () => {
  assert.deepEqual(parse({ jsonrpc: '2.0', id: 1, result: {} }), { notDescriptor: 'a JSON-RPC message' });
  assert.deepEqual(parse({ hello: 'world' }), { notDescriptor: 'a JSON object without "version" and "fields"' });
  assert.deepEqual(parseSettingsDescriptor('<html></html>', { mcpUrl: MCP, contentType: 'text/html; charset=utf-8' }), { notDescriptor: 'text/html, not JSON' });
  assert.deepEqual(parseSettingsDescriptor(JSON.stringify(SPEC), { mcpUrl: MCP, contentType: null }), { notDescriptor: 'an answer with no content type, not JSON' });
  // A structured +json type is JSON; an omitted type (a file read) is not checked.
  assert.ok(parseSettingsDescriptor(JSON.stringify(SPEC), { mcpUrl: MCP, contentType: 'application/vnd.settings+json' }).descriptor);
  assert.ok(parseSettingsDescriptor(JSON.stringify(SPEC)).descriptor);
});

test('more than 16 KiB, not JSON, not an object: each refused with its reason', () => {
  const big = JSON.stringify({ ...SPEC, pad: 'x'.repeat(SETTINGS_LIMITS.descriptorBytes) });
  assert.match(parse(big).reason, /^the settings description is larger than 16 KiB \(\d+ bytes\)$/);
  const exact = JSON.stringify({ ...SPEC, pad: '' });
  const atCap = JSON.stringify({ ...SPEC, pad: 'x'.repeat(SETTINGS_LIMITS.descriptorBytes - exact.length) });
  assert.equal(atCap.length, SETTINGS_LIMITS.descriptorBytes);
  assert.ok(parse(atCap).descriptor, '16 KiB exactly is read');
  assert.match(parse(`${atCap} `).reason, /larger than 16 KiB \(16385 bytes\)/);
  assert.match(parse('{"version":1,').reason, /^the settings description is not JSON \(/);
  assert.equal(parse('[1]').reason, 'the settings description is not a JSON object');
  assert.equal(parse('null').reason, 'the settings description is not a JSON object');
});

test('zero fields, 25 fields and 5 actions are refused', () => {
  assert.equal(parse({ ...SPEC, fields: [] }).reason, 'the settings description declares no fields');
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}`, label: `F${i}` }));
  assert.equal(parse({ ...SPEC, fields: many }).reason, 'the settings description declares 25 fields (at most 24)');
  assert.ok(parse({ ...SPEC, fields: many.slice(0, 24) }).descriptor);
  const acts = Array.from({ length: 5 }, (_, i) => ({ name: `a${i}`, label: `A${i}` }));
  assert.equal(parse({ ...SPEC, actions: acts }).reason, 'the settings description declares 5 actions (at most 4)');
});

test('a label over 80 characters, a control character in any text slot, and a bad help are refused by name', () => {
  const doc = clone(SPEC);
  doc.fields[0].label = 'x'.repeat(81);
  assert.match(parse(doc).reason, /^fields\[0\]\.label must be one line of 1–80 characters/);
  doc.fields[0].label = 'x'.repeat(80);
  assert.ok(parse(doc).descriptor);
  for (const [path, set] of [
    ['fields[1].label', (d) => { d.fields[1].label = 'User\nname'; }],
    ['fields[3].help', (d) => { d.fields[3].help = 'tab\there'; }],
    ['fields[1].placeholder', (d) => { d.fields[1].placeholder = 'esc\u001b'; }],
    ['actions[0].label', (d) => { d.actions[0].label = 'del\u007f'; }],
    ['actions[0].confirm', (d) => { d.actions[0].confirm = 'line\rbreak'; }],
  ]) {
    const bad = clone(SPEC);
    set(bad);
    assert.ok(parse(bad).reason.startsWith(path), `${path}: ${parse(bad).reason}`);
  }
  const longHelp = clone(SPEC);
  longHelp.fields[3].help = 'h'.repeat(241);
  assert.match(parse(longHelp).reason, /^fields\[3\]\.help must be one line of 1–240 characters/);
});

test('duplicate names, reserved names and bad name shapes are refused; a reason quotes at most 80 characters', () => {
  const dup = clone(SPEC);
  dup.fields[1].name = 'grafanaUrl';
  assert.equal(parse(dup).reason, 'duplicate field name "grafanaUrl"');
  for (const name of ['__proto__', 'constructor', 'prototype', 'action']) {
    const doc = clone(SPEC);
    doc.fields[2].name = name;
    assert.equal(parse(doc).reason, `fields[2].name ${JSON.stringify(name)} is reserved`);
  }
  const shape = clone(SPEC);
  shape.fields[0].name = '9lives';
  assert.match(parse(shape).reason, /^fields\[0\]\.name "9lives" is not a field name/);
  const long = clone(SPEC);
  long.fields[0].name = `a${'b'.repeat(200)}`;
  const quoted = /fields\[0\]\.name (.*) is not a field name/.exec(parse(long).reason)[1];
  assert.equal(quoted.length, 80);
  assert.ok(quoted.endsWith('…'));
  const dupAction = clone(SPEC);
  dupAction.actions.push({ name: 'disable', label: 'Again' });
  assert.equal(parse(dupAction).reason, 'duplicate action name "disable"');
  const reservedAction = clone(SPEC);
  reservedAction.actions[0].name = 'action';
  assert.equal(parse(reservedAction).reason, 'actions[0].name "action" is reserved');
});

test('an action naming an unknown field, a bad auth field or scheme, and a bad endpoint are refused', () => {
  const act = clone(SPEC);
  act.actions[0].fields = ['apiKey', 'nope'];
  assert.equal(parse(act).reason, 'actions[0].fields names an unknown field "nope"');
  assert.equal(parse({ ...SPEC, auth: { field: 'user', scheme: 'bearer' } }).reason, 'auth.field "user" does not name a secret field');
  assert.equal(parse({ ...SPEC, auth: { field: 'missing', scheme: 'bearer' } }).reason, 'auth.field "missing" does not name a secret field');
  assert.equal(parse({ ...SPEC, auth: { field: 'apiKey', scheme: 'basic' } }).reason, 'auth.scheme must be "bearer" (got "basic")');
  assert.deepEqual(clone(described({ ...SPEC, auth: { field: 'apiKey', scheme: 'bearer' } }).auth), { field: 'apiKey', scheme: 'bearer' });
  assert.match(parse({ ...SPEC, endpoint: '//evil.example/x' }).reason, /^the server's settings endpoint "\/\/evil\.example\/x" is not a plain path under http:\/\/127\.0\.0\.1:9000\//);
  const actEndpoint = clone(SPEC);
  actEndpoint.actions[0].endpoint = '../x';
  assert.match(parse(actEndpoint).reason, /^the server's endpoint for action "disable" "\.\.\/x" has a segment/);
  const { endpoint: _e, ...noEndpoint } = SPEC;
  assert.match(parse(noEndpoint).reason, /^the server's settings endpoint is missing/);
});

test('an unknown type reads as text, unknown keys are ignored, a value key is never read, a secret has no placeholder', () => {
  const doc = clone(SPEC);
  doc.fields[1].type = 'select';
  doc.fields[1].value = 'prefilled';
  doc.fields[1].options = ['a'];
  doc.fields[2].placeholder = 'hunter2';
  doc.fields[2].value = 'S3cr3t-leak';
  doc.future = { anything: true };
  doc.actions[0].colour = 'red';
  const d = described(doc);
  assert.equal(d.fields[1].type, 'text');
  assert.equal(d.fields[2].placeholder, null);
  assert.ok(!JSON.stringify(d).includes('prefilled') && !JSON.stringify(d).includes('S3cr3t-leak') && !JSON.stringify(d).includes('hunter2'));
  assert.ok(!('future' in d) && !('colour' in d.actions[0]) && !('options' in d.fields[1]));
  assert.match(parse({ ...SPEC, fields: [{ ...SPEC.fields[0], required: 'yes' }] }).reason, /^fields\[0\]\.required must be true or false/);
});

test('an action keeps its declared endpoint, field list (deduplicated) and confirm text', () => {
  const doc = clone(SPEC);
  doc.actions[0] = { name: 'disable', label: 'Clear', endpoint: 'admin/disable', fields: ['apiKey', 'apiKey'], confirm: 'The server forgets the backend credential.' };
  const a = described(doc).actions[0];
  assert.deepEqual(clone(a), { name: 'disable', label: 'Clear', endpoint: 'admin/disable', fields: ['apiKey'], confirm: 'The server forgets the backend credential.' });
});

// ---------- the root and the path rule ----------

test('the root table: one trailing slash ignored, the last segment dropped, no query, fragment or userinfo', () => {
  const table = [
    ['http://127.0.0.1:9000/mcp', 'http://127.0.0.1:9000/'],
    ['http://127.0.0.1:9000/mcp/', 'http://127.0.0.1:9000/'],
    ['https://gw.example/team-a/mcp', 'https://gw.example/team-a/'],
    ['https://gw.example/team-a/mcp/', 'https://gw.example/team-a/'],
    ['http://h:9000/', 'http://h:9000/'],
    ['http://h:9000', 'http://h:9000/'],
    ['http://user:pw@h:9000/mcp?token=x#frag', 'http://h:9000/'],
  ];
  for (const [mcp, root] of table) assert.equal(settingsRoot(mcp)?.href, root, mcp);
  assert.equal(settingsRoot('ftp://h/mcp'), null);
  assert.equal(settingsRoot('not a url'), null);
  assert.match(resolveSettingsPath('/configure', 'ftp://h/mcp').reason, /^the MCP URL is not an http\(s\) URL/);
});

const ACCEPTED = [['/configure', 'configure'], ['configure', 'configure'], ['/a/b', 'a/b'], ['.well-known/settings', '.well-known/settings'], ['~admin/x_y-z', '~admin/x_y-z']];
const REFUSED_SHAPE = ['//evil.example/x', 'https://evil/x', 'http:x', '..;/team-b/x', 'x%2f..%2fy', 'a%2F..', '%5c', '/a/%2e%2e/x', '/a/%2E/x',
  '/%zz', '%00', '\\evil', '/a?b', '/a#b', ' /a', '/a//b', 'javascript:alert(1)', '/a@b', '/a b', '/'];
const REFUSED_SEGMENT = ['/../x', '..x', '/a/./b', 'a/..', '/a/..b/c'];

// Two roots, each test a top-level `test(` (tools/test-doc-test-totals.mjs
// counts them against the journey's notes).
function acceptsUnder(mcp, root) {
  for (const [path, tail] of ACCEPTED) assert.deepEqual(resolveSettingsPath(path, mcp), { url: `${root}${tail}` }, path);
}

function refusesUnder(mcp, root) {
  for (const path of REFUSED_SHAPE) {
    const r = resolveSettingsPath(path, mcp);
    assert.ok(r.reason, `${JSON.stringify(path)} must be refused`);
    assert.equal(r.reason, `the server's settings endpoint ${JSON.stringify(path)} is not a plain path under ${root} (letters, digits, "-", "_", ".", "~" and "/" only) — the studio sends settings only to the MCP server itself; its author fixes the descriptor`);
  }
  for (const path of REFUSED_SEGMENT) assert.match(resolveSettingsPath(path, mcp).reason, /has a segment that is "\." or starts with "\.\." — the studio sends settings only to the MCP server itself/, path);
  assert.match(resolveSettingsPath('a'.repeat(129), mcp).reason, /is longer than 128 characters/);
  assert.ok(resolveSettingsPath('a'.repeat(128), mcp).url);
  assert.match(resolveSettingsPath('', mcp).reason, /is missing/);
  assert.match(resolveSettingsPath(42, mcp).reason, /is missing/);
}

test('the path rule under a loopback root: plain paths resolve under the root, a leading / relative to it', () => acceptsUnder(MCP, 'http://127.0.0.1:9000/'));
test('the path rule under a loopback root: every escape, scheme, authority, dot segment and over-long path is refused by name', () => refusesUnder(MCP, 'http://127.0.0.1:9000/'));
test('the path rule under a path-prefixed https root: plain paths resolve under the root, a leading / relative to it', () => acceptsUnder(GW, 'https://gw.example/team-a/'));
test('the path rule under a path-prefixed https root: every escape, scheme, authority, dot segment and over-long path is refused by name', () => refusesUnder(GW, 'https://gw.example/team-a/'));

test('the path rule words its reason for its caller', () => {
  const r = resolveSettingsPath('/a?b', MCP, { noun: 'the settings path', fix: 'correct it under "What the server expects"' });
  assert.equal(r.reason, 'the settings path "/a?b" is not a plain path under http://127.0.0.1:9000/ (letters, digits, "-", "_", ".", "~" and "/" only) — the studio sends settings only to the MCP server itself; correct it under "What the server expects"');
});

// ---------- the backend URL ----------

test('normaliseUrlValue: http(s) only, no userinfo, scheme and host lower-cased, never quoting the value', () => {
  assert.deepEqual(normaliseUrlValue('HTTPS://A.X'), { href: 'https://a.x/' });
  assert.deepEqual(normaliseUrlValue('  http://Grafana.Corp:3000/Path  '), { href: 'http://grafana.corp:3000/Path' });
  assert.equal(normaliseUrlValue('https://approved.corp.example@evil.example/').reason,
    'the backend URL carries a user or password before "@" — put them in their own fields, so they are treated as secrets');
  assert.ok(!normaliseUrlValue('https://u:hunter22@h/').reason.includes('hunter22'));
  assert.equal(normaliseUrlValue('ftp://files.example/').reason, "the backend URL must be http or https; got scheme 'ftp'");
  assert.equal(normaliseUrlValue('not a url').reason, 'the backend URL is not a valid URL');
  assert.equal(normaliseUrlValue('').reason, 'the backend URL is empty');
  assert.match(normaliseUrlValue(`https://h/${'a'.repeat(2048)}`).reason, /longer than 2048 characters/);
});

// ---------- the generic form ----------

test('genericDescriptor: the defaults put every field in the body, at /configure', () => {
  const d = genericDescriptor();
  assert.equal(d.endpoint, '/configure');
  assert.equal(d.auth, null);
  assert.deepEqual(d.fields.map((f) => [f.name, f.label, f.type, f.required]), [
    ['url', 'Backend base URL', 'url', true], ['user', 'User', 'text', false],
    ['secret', 'Password / token', 'secret', false], ['apiKey', 'Server API key', 'secret', false],
  ]);
  assert.equal(d.fields[3].help, 'leave empty only if the server needs none');
  assert.deepEqual(d.actions, []);
  assert.ok(Object.isFrozen(d));
  // It is a descriptor the request builder takes as is.
  assert.equal(settingsRequest(d, { url: 'https://g.example', apiKey: 'k3y-1234' }).body, '{"url":"https://g.example/","apiKey":"k3y-1234"}');
});

test('genericDescriptor: policy names (any subset), a path and bearer; bad names, paths and placements refused', () => {
  const d = genericDescriptor({ names: { url: 'grafanaUrl' }, path: 'admin/configure', auth: 'bearer' });
  assert.deepEqual(d.fields.map((f) => f.name), ['grafanaUrl', 'user', 'secret', 'apiKey']);
  assert.equal(d.endpoint, 'admin/configure');
  assert.deepEqual(clone(d.auth), { field: 'apiKey', scheme: 'bearer' });
  assert.match(genericDescriptor({ names: { url: '__proto__' } }).reason, /the url field's name "__proto__" is reserved/);
  assert.match(genericDescriptor({ names: { url: 'bad name' } }).reason, /is not a field name/);
  assert.equal(genericDescriptor({ names: { url: 'user' } }).reason, 'the field name "user" is used twice');
  assert.equal(genericDescriptor({ names: { token: 'x' } }).reason, 'unknown generic field "token" (url, user, secret, apiKey)');
  assert.match(genericDescriptor({ path: '//evil/x' }).reason, /^the settings path "\/\/evil\/x" is not a plain path/);
  assert.equal(genericDescriptor({ auth: 'header' }).reason, 'the API key goes in "body" or "bearer" (got "header")');
});

// ---------- the request ----------

test('settingsRequest: a url normalised, a secret as typed, empty optionals omitted, the body on a null prototype', () => {
  const r = settingsRequest(described(), { grafanaUrl: 'HTTPS://Grafana.Example', user: '  ada ', secret: ' p@ss word ', apiKey: '' });
  assert.equal(r.path, '/configure');
  assert.deepEqual(r.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(r.body), { grafanaUrl: 'https://grafana.example/', user: '  ada ', secret: ' p@ss word ' });
  assert.equal(Object.getPrototypeOf(r.payload), null);
  assert.deepEqual(r.sent, ['grafanaUrl', 'user', 'secret']);
  assert.deepEqual(r.secretValues, [' p@ss word ']);
  assert.deepEqual(r.secretNames, ['secret', 'apiKey']);
  assert.equal(r.user, '  ada ');
  assert.deepEqual(r.carries.map((c) => c.label), ['Backend base URL', 'User', 'Password / token']);
});

test('settingsRequest: the auth field leaves the body for Authorization: Bearer; a header-unsafe key is refused', () => {
  const d = described({ ...SPEC, auth: { field: 'apiKey', scheme: 'bearer' } });
  const r = settingsRequest(d, { grafanaUrl: 'https://g.example', apiKey: 'k3y-é' });
  assert.equal(r.headers.Authorization, 'Bearer k3y-é');
  assert.ok(!('apiKey' in r.payload));
  assert.deepEqual(r.secretValues, ['k3y-é']);
  assert.match(settingsRequest(d, { grafanaUrl: 'https://g.example', apiKey: 'a\nb' }).reason, /cannot travel in an Authorization header/);
  assert.match(settingsRequest(d, { grafanaUrl: 'https://g.example', apiKey: 'key-€' }).reason, /outside Latin-1/);
  // Empty, it is simply not sent.
  assert.equal(settingsRequest(d, { grafanaUrl: 'https://g.example', apiKey: '' }).headers.Authorization, undefined);
});

test('settingsRequest: a missing required field, a bad url, an over-long value and a body over 64 KiB are refused', () => {
  const d = described();
  const missing = settingsRequest(d, { user: 'ada' });
  assert.equal(missing.reason, 'fill in Backend base URL — the server requires it');
  assert.deepEqual(missing.missing, ['Backend base URL']);
  assert.equal(settingsRequest(d, { grafanaUrl: '   ' }).reason, 'fill in Backend base URL — the server requires it');
  assert.equal(settingsRequest(d, { grafanaUrl: 'https://a@b.example/' }).reason,
    'Backend base URL: the backend URL carries a user or password before "@" — put them in their own fields, so they are treated as secrets');
  assert.equal(settingsRequest(d, { grafanaUrl: 'https://g.example', user: 'u'.repeat(2049) }).reason, 'User is longer than 2048 characters');
  const wide = described({ version: 1, endpoint: '/configure', fields: Array.from({ length: 24 }, (_, i) => ({ name: `f${i}`, label: `F${i}` })) });
  // 24 values of 2048 quotes: each JSON-escaped to 4096 bytes.
  const values = Object.fromEntries(wide.fields.map((f) => [f.name, '"'.repeat(2048)]));
  assert.match(settingsRequest(wide, values).reason, /^the settings are \d+ bytes, more than the 65536 a request may carry$/);
});

test('settingsRequest: booleans travel as true/false, never omitted; prototype names in values are not read', () => {
  const d = described({ version: 1, endpoint: '/configure', fields: [{ name: 'verifyTls', label: 'Verify TLS', type: 'boolean' }, { name: 'note', label: 'Note' }] });
  assert.deepEqual(JSON.parse(settingsRequest(d, { verifyTls: true }).body), { verifyTls: true });
  assert.deepEqual(JSON.parse(settingsRequest(d, {}).body), { verifyTls: false });
  assert.deepEqual(JSON.parse(settingsRequest(d, { verifyTls: 'yes' }).body), { verifyTls: false });
  const inherited = Object.create({ note: 'from the prototype' });
  assert.deepEqual(JSON.parse(settingsRequest(d, inherited).body), { verifyTls: false });
});

test('an action with neither fields nor auth carries every non-empty secret, skips required, names what it sends', () => {
  const d = described();
  const empty = settingsRequest(d, {}, { action: 'disable' });
  assert.equal(empty.body, '{"action":"disable"}');
  assert.deepEqual(empty.carries, [{ name: 'secret', label: 'Password / token', empty: true }, { name: 'apiKey', label: 'Server API key', empty: true }]);
  const typed = settingsRequest(d, { apiKey: 'k3y-1234', grafanaUrl: 'https://g.example' }, { action: 'disable' });
  assert.deepEqual(JSON.parse(typed.body), { action: 'disable', apiKey: 'k3y-1234' });
  assert.equal(Object.keys(JSON.parse(typed.body))[0], 'action');
  assert.deepEqual(typed.secretValues, ['k3y-1234']);
  assert.deepEqual(typed.carries.map((c) => [c.label, c.empty]), [['Password / token', true], ['Server API key', false]]);
  assert.match(settingsRequest(d, {}, { action: 'nope' }).reason, /declares no action "nope"/);
});

test('an action with declared fields sends exactly those; with auth (and no fields) the auth field as the header', () => {
  const declared = clone(SPEC);
  declared.actions[0].fields = ['user', 'apiKey'];
  declared.actions[0].endpoint = '/disable';
  const r = settingsRequest(described(declared), { user: 'ada', secret: 'pw-123456', apiKey: '' }, { action: 'disable' });
  assert.equal(r.path, '/disable');
  assert.deepEqual(JSON.parse(r.body), { action: 'disable', user: 'ada' });
  assert.deepEqual(r.carries.map((c) => [c.label, c.empty]), [['User', false], ['Server API key', true]]);
  const withAuth = described({ ...SPEC, auth: { field: 'apiKey', scheme: 'bearer' } });
  const a = settingsRequest(withAuth, { secret: 'pw-123456', apiKey: 'k3y-1234' }, { action: 'disable' });
  assert.equal(a.body, '{"action":"disable"}');
  assert.equal(a.headers.Authorization, 'Bearer k3y-1234');
  assert.deepEqual(a.carries.map((c) => c.label), ['Server API key']);
});

// ---------- the outcome ----------

const answer = (status, json, extra = {}) => outcomeOf({ status, contentType: JSON_TYPE, text: JSON.stringify(json), ...extra });

test('outcomeOf: ok true is verified, ok absent is accepted without verification, ok false is a failure', () => {
  const verified = answer(200, { ok: true, message: 'Connected as svc', checks: [{ label: 'Identity', status: 'pass', detail: 'role Viewer' }] });
  assert.equal(verified.headline, 'The server reports the settings verified (HTTP 200).');
  assert.deepEqual([verified.tone, verified.success, verified.ok, verified.message], ['ok', true, true, 'Connected as svc']);
  assert.deepEqual(verified.checks, [{ label: 'Identity', status: 'pass', detail: 'role Viewer' }]);
  const accepted = answer(204, {});
  assert.equal(accepted.headline, 'The server accepted the settings (HTTP 204). It reported no verification.');
  assert.deepEqual([accepted.tone, accepted.success, accepted.ok, accepted.shape], ['neutral', true, null, null]);
  const text = outcomeOf({ status: 200, contentType: 'text/plain', text: 'saved' });
  assert.equal(text.headline, 'The server accepted the settings (HTTP 200). It reported no verification.');
  assert.equal(text.raw, 'saved');
  assert.equal(text.json, null);
  const failed = answer(200, { ok: false, message: 'backend refused' });
  assert.equal(failed.headline, 'The server answered HTTP 200 but reports a failure.');
  assert.deepEqual([failed.tone, failed.success], ['error', false]);
});

test('outcomeOf: a non-2xx is a refusal with its body verbatim; a redirect says it may have acted', () => {
  const refused = outcomeOf({ status: 401, contentType: 'text/html', text: '<h1>Unauthorized</h1>' });
  assert.equal(refused.headline, 'The server refused the settings: HTTP 401.');
  assert.equal(refused.raw, '<h1>Unauthorized</h1>');
  assert.deepEqual([refused.tone, refused.success], ['error', false]);
  const pretty = answer(500, { error: 'boom' });
  assert.equal(pretty.raw, '{\n  "error": "boom"\n}');
  const redirect = outcomeOf({ status: 0, type: 'opaqueredirect', contentType: null, text: '' });
  assert.equal(redirect.headline, 'The server answered with a redirect, which the studio never follows. It may have applied the settings — test the connection.');
  assert.deepEqual([redirect.tone, redirect.success], ['warn', false]);
});

test('outcomeOf: check statuses are words (anything else unknown), and the message, checks and raw text are capped', () => {
  const checks = Array.from({ length: 30 }, (_, i) => ({ label: `C${i}`, status: ['pass', 'fail', 'skip', 'PASS', 7][i % 5], detail: 'd'.repeat(300) }));
  const o = answer(200, { ok: true, message: `m\n${'x'.repeat(600)}`, checks: [{ status: 'pass' }, ...checks] });
  assert.equal(o.checks.length, 24);
  assert.deepEqual(o.checks.slice(0, 5).map((c) => c.status), ['pass', 'fail', 'skip', 'unknown', 'unknown']);
  assert.equal(o.checks[0].detail.length, 240);
  assert.equal(o.message.length, 500);
  assert.ok(o.message.startsWith('m x') && o.message.endsWith('…'), 'one line, capped');
  const big = outcomeOf({ status: 500, contentType: 'text/plain', text: 'y'.repeat(10000) });
  assert.equal(big.raw.length, 8192);
  assert.equal(big.capped, 'shown');
  const huge = outcomeOf({ status: 500, contentType: 'text/plain', text: 'z'.repeat(70000) });
  assert.equal(huge.capped, 'read');
  assert.equal(answer(200, { ok: true }).capped, null);
});

test('outcomeOf: shape is the outcome\'s own keys, or null when the body is not of that shape', () => {
  assert.deepEqual(answer(200, { ok: true, message: 'hi', extra: 'dropped' }).shape, { ok: true, message: 'hi' });
  assert.equal(answer(200, ['a']).shape, null);
  assert.equal(answer(200, { status: 'fine' }).shape, null);
  assert.equal(outcomeOf({ status: 500, contentType: 'text/html', text: '<p>x</p>' }).shape, null);
});

const SECRET = 'p"é/ss-S3cr3t';
const USER = 'ada';
const secretOpts = { secretValues: [SECRET], secretNames: ['secret', 'apiKey'], user: USER };
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('redaction on the raw text: raw, URI-encoded, JSON-escaped, base64 and Basic forms', () => {
  const forms = {
    raw: SECRET,
    uri: encodeURIComponent(SECRET),
    json: JSON.stringify(SECRET).slice(1, -1),
    jsonAscii: JSON.stringify(SECRET).slice(1, -1).replace('é', '\\u00e9'),
    jsonSlash: JSON.stringify(SECRET).slice(1, -1).replace('/', '\\/'),
    base64: b64(SECRET),
    basic: b64(`${USER}:${SECRET}`),
  };
  for (const [name, form] of Object.entries(forms)) {
    const o = outcomeOf({ status: 401, contentType: 'text/plain', text: `denied for ${form} today` }, secretOpts);
    assert.equal(o.raw, 'denied for <redacted> today', name);
    assert.equal(o.redacted, 1, name);
  }
  const r = redactEchoes(`a ${SECRET} b ${b64(SECRET)}`, [SECRET]);
  assert.deepEqual(r, { text: 'a <redacted> b <redacted>', redacted: 2 });
});

test('redaction after parse: an escape the raw text cannot show (\\u0022, \\u00e9, \\/) is caught in the parsed error string', () => {
  const escaped = 'p\\u0022\\u00e9\\/ss-S3cr3t';
  assert.equal(JSON.parse(`"${escaped}"`), SECRET);
  const text = `{"error":"bad credential ${escaped} for backend"}`;
  assert.ok(!redactEchoes(text, [SECRET]).redacted, 'the raw step cannot see it');
  const o = outcomeOf({ status: 401, contentType: JSON_TYPE, text }, secretOpts);
  assert.deepEqual({ ...o.json }, { error: 'bad credential <redacted> for backend' });
  assert.equal(o.redacted, 1);
  assert.ok(!o.raw.includes('S3cr3t'));
});

test('redaction by class: a secret field\'s name and the credential key class, whatever the length; a short secret by class only', () => {
  const o = answer(400, { secret: 'x', apiKey: 'abc', password: 'p', Token: 'tok', 'api-key': 'k', nested: [{ credential: { deep: 1 } }], fine: 'shown', empty: '', flag: true }, { status: 400 });
  assert.deepEqual(clone(o.json), { secret: '<redacted>', apiKey: '<redacted>', password: '<redacted>', Token: '<redacted>', 'api-key': '<redacted>', nested: [{ credential: '<redacted>' }], fine: 'shown', empty: '', flag: true });
  assert.equal(o.redacted, 6);
  const short = outcomeOf({ status: 400, contentType: JSON_TYPE, text: '{"msg":"bad abc","myField":"abc"}' }, { secretValues: ['abc'], secretNames: ['myField'] });
  assert.deepEqual(clone(short.json), { msg: 'bad abc', myField: '<redacted>' });
  assert.equal(short.redacted, 1);
  const keys = redactSecretKeys({ a: { authorization: 'Bearer x' }, b: 'y' }, []);
  assert.deepEqual(clone(keys.json), { a: { authorization: '<redacted>' }, b: 'y' });
  assert.equal(keys.redacted, 1);
});

test('redaction: a secret echoed as a key and in the message, longest form first, counted once each; a "__proto__" key stays a key', () => {
  const text = JSON.stringify({ message: `rejected ${SECRET}`, [SECRET]: 1, ok: false });
  const o = outcomeOf({ status: 200, contentType: JSON_TYPE, text }, secretOpts);
  assert.equal(o.message, 'rejected <redacted>');
  assert.ok(!o.raw.includes('S3cr3t'));
  assert.equal(o.redacted, 2);
  const proto = outcomeOf({ status: 200, contentType: JSON_TYPE, text: '{"__proto__":{"ok":true}}' });
  assert.equal(proto.ok, null, 'a "__proto__" key never becomes the prototype');
  assert.match(proto.raw, /"__proto__"/);
  // A base64 form that contains a shorter form is replaced whole.
  const basic = redactEchoes(`Basic ${b64(`${USER}:${SECRET}`)}`, [SECRET], { user: USER });
  assert.deepEqual(basic, { text: 'Basic <redacted>', redacted: 1 });
});

test('redaction: a body cut at the read cap loses the tail a partial echo could occupy', () => {
  const text = `${'a'.repeat(100)}${SECRET.slice(0, 6)}`;
  const o = outcomeOf({ status: 500, contentType: 'text/plain', text, truncated: true }, secretOpts);
  assert.equal(o.capped, 'read');
  assert.ok(!o.raw.includes(SECRET.slice(0, 6)));
  assert.ok(o.raw.startsWith('a'.repeat(70)) && o.raw.length < text.length);
});

// ---------- the settings policy ----------

test('the SPEC policy compiles; the policy is frozen and keeps its rules\' order and index', () => {
  const p = policyOf(SPEC_POLICY);
  assert.equal(p.version, 1);
  assert.equal(p.rules.length, 1);
  assert.deepEqual({ ...p.rules[0], re: String(p.rules[0].re) }, {
    index: 0, field: 'grafanaUrl', type: null, re: '/^(?!https:\\/\\/approved\\.)/', pattern: '^(?!https://approved\\.)', flags: '',
    warn: 'Non-approved backend host.', ack: 'I have operator approval for this target',
  });
  assert.equal(p.generic, null);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.rules) && Object.isFrozen(p.rules[0]));
});

test('the policy is strict: an unknown key anywhere, a version other than 1, 0 or 33 rules', () => {
  const errs = (doc) => compileSettingsPolicy(doc).errors;
  assert.deepEqual(errs({ ...SPEC_POLICY, extra: 1 }), ['the settings policy: unknown key "extra"']);
  assert.deepEqual(errs({ version: 1, rules: [{ ...SPEC_POLICY.rules[0], pattren: 'x' }] }), ['rules[0]: unknown key "pattren"']);
  assert.deepEqual(errs({ version: 1, rules: [{ ...SPEC_POLICY.rules[0], when: { field: 'grafanaUrl', pattren: '^x' } }] }), ['rules[0].when: unknown key "pattren"']);
  assert.deepEqual(errs({ version: 1, rules: [{ ...SPEC_POLICY.rules[0], require: { ack: 'ok', must: true } }] }), ['rules[0].require: unknown key "must"']);
  assert.deepEqual(errs({ ...SPEC_POLICY, version: 2 }), ['version must be 1 (got 2)']);
  assert.deepEqual(errs({ version: 1, rules: [] }), ['rules must be an array of 1–32 rules']);
  const rule = { when: { type: 'url', pattern: '^http:' }, warn: 'Plain http.' };
  assert.deepEqual(errs({ version: 1, rules: Array(33).fill(rule) }), ['rules: 33 rules (at most 32)']);
  assert.deepEqual(errs({ version: 1, rules: Array(32).fill(rule) }), []);
  assert.deepEqual(errs([]), ['the settings policy must be a JSON object']);
  const many = compileSettingsPolicy({ version: 3, rules: [{ when: { field: 'a', pattern: 'x' }, warn: 'w' }, { when: { field: 'b', pattern: '^y' }, warn: '' }] });
  assert.equal(many.policy, null);
  assert.equal(many.errors.length, 3, 'every error is collected');
});

test('a rule names exactly one of field or type, never a secret; warn and ack are one line within their caps', () => {
  const errs = (when, more = {}) => compileSettingsPolicy({ version: 1, rules: [{ when, warn: 'w', ...more }] }).errors;
  assert.deepEqual(errs({ field: 'a', type: 'url', pattern: '^x' }), ['rules[0].when: exactly one of field or type']);
  assert.deepEqual(errs({ pattern: '^x' }), ['rules[0].when: exactly one of field or type']);
  assert.deepEqual(errs({ type: 'secret', pattern: '^x' }), ['rules[0].when: a rule cannot match a secret: its value is never read by the policy']);
  assert.match(errs({ field: 'apiKey', pattern: '^x' })[0], /a rule cannot match a secret/);
  assert.match(errs({ type: 'select', pattern: '^x' })[0], /type must be one of url, text, boolean/);
  assert.match(errs({ field: '__proto__', pattern: '^x' })[0], /is reserved/);
  assert.deepEqual(compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'url', pattern: '^x' }, warn: 'w'.repeat(241) }] }).errors, ['rules[0].warn must be one line of 1–240 characters']);
  assert.deepEqual(errs({ type: 'url', pattern: '^x' }, { require: { ack: 'a\nb' } }), ['rules[0].require.ack must be one line of 1–160 characters']);
  assert.ok(policyOf({ version: 1, rules: [{ when: { type: 'text', pattern: '^admin$', flags: 'i' }, warn: 'w' }] }));
});

test('the taxonomy\'s pattern rule applies: unanchored, a quantified group, a bad flag, a broken regex', () => {
  const errs = (pattern, flags) => compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'url', pattern, ...(flags === undefined ? {} : { flags }) }, warn: 'w' }] }).errors;
  assert.deepEqual(errs('https://'), ['rules[0].when: pattern must be anchored (start with ^)']);
  assert.deepEqual(errs('^(a+)+$'), ['rules[0].when: nested quantifier']);
  assert.deepEqual(errs('^x', 'g'), ['rules[0].when: flags must be "" or "i"']);
  assert.match(errs('^(x')[0], /^rules\[0\]\.when: invalid regex: /);
  assert.deepEqual(errs(`^${'x'.repeat(200)}`), ['rules[0].when: pattern longer than 200 characters']);
});

test('the settings bounds: more than one unbounded quantifier is refused (the measured ^https://.*.*.*\\.internal$)', () => {
  const errs = (pattern) => compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'url', pattern }, warn: 'w' }] }).errors;
  const measured = '^https://.*.*.*\\.internal$';
  assert.ok(compileBoundedPattern(measured, { timed: false }).re, 'the taxonomy rule alone admits it');
  assert.deepEqual(errs(measured), ['rules[0].when: pattern has more than one unbounded quantifier (*, + or {n,}), which a URL-length value can make slow']);
  assert.deepEqual(errs('^https://a+b{2,}'), errs(measured));
  assert.deepEqual(errs('^https://[*+]+\\*\\+'), [], 'quantifier characters inside a class or escaped do not count');
  assert.deepEqual(errs('^https://.*\\.corp\\.example/'), []);
  assert.deepEqual(errs('^https://x{1,40}y{0,3}z?'), [], 'bounded quantifiers do not count');
});

const PREFIX_SLOW = '^https://[a./-]{0,36}[a./-]{0,36}[a./-]{0,36}[a./-]{0,36}[a./-]{0,36}!';

test('the settings bounds: a pattern slow only on URL-shaped values compiles — the loader checks shape, it runs no timing probe; timed: false skips only the id clocks', () => {
  assert.ok(compileBoundedPattern(PREFIX_SLOW).re, 'the taxonomy\'s id timing admits it (its ids never get past "https://")');
  assert.deepEqual(compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'url', pattern: PREFIX_SLOW }, warn: 'w' }] }).errors, [],
    'no probe can prove a pattern fast on every value; the studio server bounds the evaluation instead (server/mcp-settings-eval.mjs)');
  const untimed = compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'url', pattern: PREFIX_SLOW }, warn: 'w' }] }, { timed: false });
  assert.deepEqual(untimed.errors, []);
  // The static checks still run untimed.
  assert.deepEqual(compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'url', pattern: '^https://.*.*' }, warn: 'w' }] }, { timed: false }).errors,
    ['rules[0].when: pattern has more than one unbounded quantifier (*, + or {n,}), which a URL-length value can make slow']);
});

test('the settings bounds: every pattern the retired timing probe caught, and the ones that slipped past it, compile in milliseconds — speed is the evaluator\'s deadline, not the loader\'s', () => {
  const errs = (pattern, type = 'url') => compileSettingsPolicy({ version: 1, rules: [{ when: { type, pattern }, warn: 'w' }] }).errors;
  const slow = (c, end = 'x') => `^.*${c}{0,60}${c}{0,60}${c}{0,60}${c}{0,60}${end}$`;
  for (const pattern of [
    '^.*\\d{0,60}\\d{0,60}\\d{0,60}\\d{0,60}x$', '^https://.*\\d{0,60}\\d{0,60}\\d{0,60}\\.internal$', '^.*[A-Z]{0,60}[A-Z]{0,60}[A-Z]{0,60}x$',
    slow('_'), slow('%'), slow('[=&]'), slow('é'),
    // A slow part followed by what a probe's last character satisfies: no probe input is slow on it.
    slow('_', '!'), slow('_', '\\W'), slow('\\d', '[!-]'),
  ]) {
    const t0 = Date.now();
    assert.deepEqual(errs(pattern, 'text'), [], pattern);
    assert.ok(Date.now() - t0 < 1000, `${pattern}: compiled without running it on a long value (${Date.now() - t0} ms)`);
  }
  // Every bound of shape still refuses.
  assert.deepEqual(errs('^(a+)+$'), ['rules[0].when: nested quantifier']);
  assert.deepEqual(errs('^https://.*.*'), ['rules[0].when: pattern has more than one unbounded quantifier (*, + or {n,}), which a URL-length value can make slow']);
  assert.deepEqual(errs(`^${'x'.repeat(200)}`), ['rules[0].when: pattern longer than 200 characters']);
});

test('the settings bounds: a pattern linear in the value compiles, and policyFindings runs it on the calling thread as written', () => {
  const errs = (pattern) => compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'text', pattern }, warn: 'w' }] }).errors;
  for (const pattern of ['^.*[^a]{0,60}x$', '^https://[a-z0-9.-]{1,63}\\.example\\.com/[a-z0-9/_%=&~:?-]{0,200}$', '^http://.*$']) {
    assert.deepEqual(errs(pattern), [], pattern);
  }
  const p = compileSettingsPolicy({ version: 1, rules: [{ when: { type: 'url', pattern: '^https://[a-z0-9.-]{1,63}\\.example\\.com/' }, warn: 'w', require: { ack: 'ok' } }] }).policy;
  const d = genericDescriptor();
  assert.deepEqual(policyFindings(p, d, { url: 'https://a.example.com/x' }).map((f) => [f.rule, f.field, f.ack]), [[0, 'url', 'ok']]);
  assert.deepEqual(policyFindings(p, d, { url: 'https://a.example.org/x' }), []);
});

test('the policy\'s generic block: path, names (any subset) and auth, each validated; secrets of the form refused as rule fields', () => {
  const p = policyOf({ ...SPEC_POLICY, generic: { path: 'admin/configure', names: { url: 'grafanaUrl', apiKey: 'serverKey' }, auth: 'bearer' } });
  assert.deepEqual(clone(p.generic), { path: 'admin/configure', names: { url: 'grafanaUrl', user: 'user', secret: 'secret', apiKey: 'serverKey' }, auth: 'bearer' });
  assert.deepEqual(clone(policyOf({ ...SPEC_POLICY, generic: {} }).generic), { path: '/configure', names: { ...GENERIC_NAMES }, auth: 'body' });
  const errs = (generic) => compileSettingsPolicy({ ...SPEC_POLICY, generic }).errors;
  assert.match(errs({ path: '/a/../b' })[0], /^generic: the settings path "\/a\/\.\.\/b" has a segment/);
  assert.match(errs({ names: { url: 'a b' } })[0], /^generic: the url field's name "a b" is not a field name/);
  assert.deepEqual(errs({ auth: 'cookie' }), ['generic: the API key goes in "body" or "bearer" (got "cookie")']);
  assert.deepEqual(errs({ colour: 1 }), ['generic: unknown key "colour"']);
  const secretRule = compileSettingsPolicy({ version: 1, rules: [{ when: { field: 'serverKey', pattern: '^x' }, warn: 'w' }], generic: { names: { apiKey: 'serverKey' } } });
  assert.match(secretRule.errors[0], /field "serverKey" is a secret of the generic form — a rule cannot match a secret/);
});

// ---------- findings ----------

test('findings: an empty value is inert; a non-approved URL is a finding with its ack; the URL is normalised before the match', () => {
  const p = policyOf(SPEC_POLICY);
  const d = described();
  assert.deepEqual(policyFindings(p, d, {}), []);
  assert.deepEqual(policyFindings(p, d, { grafanaUrl: '   ' }), []);
  assert.deepEqual(policyFindings(p, d, { grafanaUrl: 'https://grafana.evil.example' }), [
    { rule: 0, field: 'grafanaUrl', warn: 'Non-approved backend host.', ack: 'I have operator approval for this target', unevaluated: false, note: null },
  ]);
  assert.deepEqual(policyFindings(p, d, { grafanaUrl: 'HTTPS://Approved.Corp.Example/' }), [], 'scheme and host lower-cased first');
  assert.deepEqual(policyFindings(p, d, { grafanaUrl: 'https://approved.corp.example@evil.example/' }), [], 'userinfo is refused, never matched');
  assert.ok(settingsRequest(d, { grafanaUrl: 'https://approved.corp.example@evil.example/' }).reason, '…and never sent');
  assert.deepEqual(policyFindings(null, d, { grafanaUrl: 'https://x' }), []);
});

test('findings: a value over 512 characters is itself a finding, so the cap never turns a rule off', () => {
  const p = policyOf({ version: 1, rules: [{ when: { field: 'grafanaUrl', pattern: '^https://evil\\.' }, warn: 'Evil host.', require: { ack: 'I know' } }] });
  const long = `https://approved.example/${'a'.repeat(500)}`;
  const f = policyFindings(p, described(), { grafanaUrl: long });
  assert.equal(f.length, 1);
  assert.deepEqual([f[0].unevaluated, f[0].ack, f[0].note], [false, 'I know', 'Backend base URL is longer than 512 characters, so the policy cannot check it']);
  assert.deepEqual(policyFindings(p, described(), { grafanaUrl: `https://approved.example/${'a'.repeat(480)}` }), []);
});

test('findings: a rule whose field the form lacks (or holds as a secret) is unevaluated and still requires its ack', () => {
  const p = policyOf(SPEC_POLICY);
  const generic = genericDescriptor();
  assert.deepEqual(policyFindings(p, generic, { url: 'https://approved.example' }), [{
    rule: 0, field: 'grafanaUrl', warn: 'Non-approved backend host.', ack: 'I have operator approval for this target', unevaluated: true,
    note: 'Policy rule 1 checks grafanaUrl, which this form does not have, so it cannot run',
  }]);
  // The policy's generic names make the rule run normally.
  const named = genericDescriptor({ names: { url: 'grafanaUrl' } });
  assert.deepEqual(policyFindings(p, named, { grafanaUrl: 'https://approved.example' }), []);
  assert.equal(policyFindings(p, named, { grafanaUrl: 'https://other.example' }).length, 1);
  const secretForm = described({ version: 1, endpoint: '/c', fields: [{ name: 'grafanaUrl', label: 'Key', type: 'secret' }] });
  const s = policyFindings(p, secretForm, { grafanaUrl: 'whatever' });
  assert.deepEqual([s[0].unevaluated, s[0].note], [true, 'Policy rule 1 checks grafanaUrl, which is a secret on this form, so the policy cannot read it']);
});

test('findings: a type rule covers every field of its type (the generic URL whatever its name); flags i; booleans as words', () => {
  const p = policyOf({ version: 1, rules: [
    { when: { type: 'url', pattern: '^http://' }, warn: 'Plain http backend.' },
    { when: { type: 'text', pattern: '^admin$', flags: 'i' }, warn: 'Shared admin account.', require: { ack: 'Approved' } },
    { when: { type: 'boolean', pattern: '^false$' }, warn: 'TLS verification off.' },
  ] });
  const generic = genericDescriptor({ names: { url: 'backend' } });
  assert.deepEqual(policyFindings(p, generic, { backend: 'http://g.example', user: 'ADMIN' }).map((f) => [f.rule, f.field]), [[0, 'backend'], [1, 'user']]);
  const d = described({ version: 1, endpoint: '/c', fields: [{ name: 'verify', label: 'Verify TLS', type: 'boolean' }, { name: 'u', label: 'U', type: 'weird' }] });
  assert.deepEqual(policyFindings(p, d, { verify: false, u: 'Admin' }).map((f) => [f.rule, f.field]), [[1, 'u'], [2, 'verify']]);
  assert.deepEqual(policyFindings(p, d, { verify: true, u: 'operator' }), []);
});
