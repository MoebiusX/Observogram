#!/usr/bin/env node
/**
 * server/test-mcp-url.mjs
 *
 * Unit tests for the SSRF guard (server/mcp-url.mjs) — the single gate
 * every caller-supplied mcpUrl passes before the server fetches it. This
 * guard had ZERO direct tests while index.mjs was a monolith; extraction
 * makes it testable, so it gets its suite in the same commit.
 */

import { validateMcpUrl, isLocalOrPrivateHost, redactCredentials, safeMcpUrl, stripMcpUrl, mcpUrlOrigin, credentialParamName } from './mcp-url.mjs';
import { readFileSync } from 'node:fs';
import { createHarness } from '../tools/lib/harness.mjs';

const { assert, report } = createHarness({ indent: '  ', truncate: 160 });

// ---------- scheme gate ----------
for (const bad of ['file:///etc/passwd', 'ftp://host/x', 'gopher://host/x', 'javascript:alert(1)']) {
  assert(!!validateMcpUrl(bad).error, `rejects non-http(s) scheme: ${bad.split(':')[0]}:`);
}
assert(!!validateMcpUrl('not a url at all').error, 'rejects unparseable input');
assert(!!validateMcpUrl('').error, 'rejects empty input');
assert(!validateMcpUrl('https://mcp.example.com/observability').error, 'accepts plain https');
assert(!validateMcpUrl('http://mcp.example.com/observability').error, 'accepts plain http');

// ---------- credential stripping ----------
const withCreds = validateMcpUrl('https://user:secret@mcp.example.com/path');
assert(withCreds.safeUrl === 'https://mcp.example.com/path', 'safeUrl strips embedded credentials', withCreds.safeUrl);
assert(redactCredentials('https://user:secret@x.test/a https://t0ken@y.test/b')
  === 'https://***@x.test/a https://***@y.test/b',
  'redactCredentials masks every //user:pass@ / //token@ occurrence');
assert(!validateMcpUrl('https://user:secret@host.invalid bad').safeUrl?.includes('secret'),
  'error paths never echo credentials');

// ---------- private/local detection ----------
const PRIVATE = [
  '127.0.0.1', '127.8.8.8', '10.0.0.1', '192.168.1.34', '169.254.169.254',
  '0.0.0.0', '172.16.0.1', '172.31.255.255', 'localhost', 'foo.localhost',
  '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
];
for (const h of PRIVATE) assert(isLocalOrPrivateHost(h), `private/local: ${h}`);
const PUBLIC = ['8.8.8.8', '172.32.0.1', '172.15.0.1', '11.0.0.1', 'mcp.example.com', '2606:4700::1111', '::ffff:8.8.8.8'];
for (const h of PUBLIC) assert(!isLocalOrPrivateHost(h), `public: ${h}`);

// WHATWG normalisation closes the alternate-encoding holes: hex / decimal /
// octal IPv4 forms parse to dotted-decimal before the check runs.
for (const [raw, label] of [
  ['http://0x7f000001/', 'hex 0x7f000001'],
  ['http://2130706433/', 'decimal 2130706433'],
  ['http://0177.0.0.1/', 'octal 0177.0.0.1'],
]) {
  const v = validateMcpUrl(raw);
  // Allowed by default posture, but it must be RECOGNISED as loopback —
  // assert via the strict posture below instead of log inspection.
  process.env.OBSERVOGRAM_ALLOW_LOCAL_MCP = '0';
  const strict = validateMcpUrl(raw);
  delete process.env.OBSERVOGRAM_ALLOW_LOCAL_MCP;
  assert(!v.error && !!strict.error, `${label} normalises to loopback (allowed lax, refused strict)`, strict);
}

// ---------- OBSERVOGRAM_ALLOW_LOCAL_MCP=0 posture ----------
process.env.OBSERVOGRAM_ALLOW_LOCAL_MCP = '0';
assert(!!validateMcpUrl('http://127.0.0.1:3001/mcp').error, 'strict posture refuses loopback');
assert(!!validateMcpUrl('http://192.168.1.34:3001/mcp').error, 'strict posture refuses RFC1918');
assert(!validateMcpUrl('https://mcp.example.com/x').error, 'strict posture still accepts public hosts');
delete process.env.OBSERVOGRAM_ALLOW_LOCAL_MCP;
assert(!validateMcpUrl('http://127.0.0.1:3001/mcp').error, 'default posture allows loopback (local dev)');

// ---------- safeMcpUrl: what may be persisted, logged or served ----------
// (tools/lib/mcp-url-safety.mjs, re-exported by server/mcp-url.mjs)
assert(safeMcpUrl('https://u:p@mcp.example.com/obs#frag') === 'https://mcp.example.com/obs', 'safeMcpUrl removes userinfo and the fragment');
for (const name of ['token', 'api_key', 'apiKey', 'X-Amz-Signature', 'access_token', 'password', 'pwd', 'jwt', 'session', 'bearer', 'sessionId', 'APIKey', 'auth']) {
  const { safe, dropped } = stripMcpUrl(`https://mcp.example.com/obs?${encodeURIComponent(name)}=s3cret&tier=x`);
  assert(safe === 'https://mcp.example.com/obs?tier=x' && dropped.length === 1 && dropped[0] === name, `a credential parameter is removed: ${name}`, [safe, dropped]);
  assert(credentialParamName(name), `credentialParamName(${name})`);
}
// A name written as one run (no camelCase, no separator) or ending in a
// digit is a credential too, whatever its case: APISECRET goes like apiSecret.
for (const name of ['apitoken', 'APITOKEN', 'accesskey', 'ACCESSKEY', 'secretkey', 'clientsecret', 'CLIENTSECRET',
  'APISECRET', 'API_SECRET', 'apiSecret', 'privatetoken', 'privatekey', 'authkey', 'xapikey', 'sessiontoken',
  'refreshtoken', 'idtoken', 'mytoken', 'token1', 'password1', 'key2', 'passcode', 'jsessionid', 'urlsignature']) {
  const { safe, dropped } = stripMcpUrl(`https://mcp.example.com/obs?${name}=s3cret&tier=x`);
  assert(safe === 'https://mcp.example.com/obs?tier=x' && dropped.length === 1 && dropped[0] === name, `a run-together credential parameter is removed: ${name}`, [safe, dropped]);
}
const both = stripMcpUrl('https://mcp.example.com/obs?token=A&apitoken=B&tier=x');
assert(both.safe === 'https://mcp.example.com/obs?tier=x' && both.dropped.join() === 'token,apitoken',
  'token and apitoken both go, and dropped names both', both);
assert(safeMcpUrl('https://mcp.example.com/obs?tier=x;APITOKEN=B&design=1') === 'https://mcp.example.com/obs?design=1',
  'a ;-separated pair naming a run-together credential is removed whole');
assert(stripMcpUrl('https://mcp.example.com/obs?%74oken=s3cret').safe === 'https://mcp.example.com/obs'
  && stripMcpUrl('https://mcp.example.com/obs?%74oken=s3cret').dropped[0] === 'token', 'an ENCODED name is decoded first: %74oken is token');
assert(safeMcpUrl('https://mcp.example.com/obs?tier=x;pwd=hunter2&design=1') === 'https://mcp.example.com/obs?design=1',
  'a value carrying a ;-separated credential pair is removed whole');
const KEPT = ['signal', 'design', 'keyspace', 'author', 'bypass', 'tenant', 'tier', 'monkey', 'passive',
  'turkey', 'hockey', 'keyword', 'tokenizer', 'secretary', 'obsession', 'compass', 'tier1', 'v2', 'sha256'];
const kept = `https://mcp.example.com/obs?${KEPT.map((n, i) => `${n}=${i}`).join('&')}`;
assert(safeMcpUrl(kept) === kept, 'names that merely contain a credential word are kept (a word rule, not a substring rule)', safeMcpUrl(kept));
for (const n of KEPT) assert(!credentialParamName(n), `not a credential: ${n}`);
const pathSecret = 'https://mcp.example.com/mcp/s/sk-ak-0123456789abcdef/mcp';
assert(safeMcpUrl(pathSecret) === pathSecret, 'a secret in the PATH is kept (names only: the server serves url to operators only)');
assert(mcpUrlOrigin(pathSecret) === 'https://mcp.example.com' && mcpUrlOrigin('https://u:p@h.test:8443/x?token=1') === 'https://h.test:8443',
  'mcpUrlOrigin: scheme://host:port, never a path, a query or userinfo');
assert(safeMcpUrl('not a url') === null && mcpUrlOrigin('not a url') === null && mcpUrlOrigin('file:///etc/passwd') === null, 'not an http(s) URL → null');
assert(safeMcpUrl('https://mcp.example.com/obs?a=%20b+c&tier=x') === 'https://mcp.example.com/obs?a=%20b+c&tier=x', 'nothing dropped → the query keeps its spelling');
const creds = 'https://user:pw@mcp.example.com/obs?token=abc&tier=x#f';
assert(validateMcpUrl(creds).safeUrl === safeMcpUrl(creds) && validateMcpUrl(creds).safeUrl === 'https://mcp.example.com/obs?tier=x',
  'validateMcpUrl().safeUrl is safeMcpUrl()');
const lib = readFileSync(new URL('../tools/lib/mcp-url-safety.mjs', import.meta.url), 'utf8');
assert(!/^\s*import\b/m.test(lib) && !/\brequire\(/.test(lib) && !/node:/.test(lib), 'tools/lib/mcp-url-safety.mjs imports nothing (browser-safe: the studio loads it from /lib)');

report('mcp-url', 'the SSRF guard rejects bad schemes, strips credentials, and classifies hosts correctly.');
