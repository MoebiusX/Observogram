#!/usr/bin/env node
/**
 * server/test-mcp-url.mjs
 *
 * Unit tests for the SSRF guard (server/mcp-url.mjs) — the single gate
 * every caller-supplied mcpUrl passes before the server fetches it. This
 * guard had ZERO direct tests while index.mjs was a monolith; extraction
 * makes it testable, so it gets its suite in the same commit.
 */

import { validateMcpUrl, isLocalOrPrivateHost, redactCredentials } from './mcp-url.mjs';
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

report('mcp-url', 'the SSRF guard rejects bad schemes, strips credentials, and classifies hosts correctly.');
