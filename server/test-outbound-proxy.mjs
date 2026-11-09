#!/usr/bin/env node
/**
 * server/test-outbound-proxy.mjs — the server's own requests through a proxy
 * (server/outbound-proxy.mjs, server/launch.mjs) and what a failed one says
 * (server/fetch-failure.mjs).
 *
 * The pure half runs on every Node: which proxy a request takes, as undici's
 * EnvHttpProxyAgent chooses it (the agent Node's fetch uses under
 * NODE_USE_ENV_PROXY=1); when the launcher turns that switch on; what the
 * start says; and the sentences a read that failed through a proxy, or failed
 * directly, carries, from the error shapes undici 6.21–6.29 throws.
 *
 * The live half needs a Node that reads the proxy variables (22.21 or later)
 * and skips, saying so, on an older one. Its children run with
 * NODE_USE_ENV_PROXY=1 and a proxy on loopback. For each NO_PROXY form they
 * check that outboundRoute's answer is the way Node really sent the request.
 * The Azure DevOps and GitHub readers' requests reach the proxy, and its
 * refusals come back as the sentences below; no request leaves the machine.
 * The real start() and the real launcher say which proxy is in use, never its
 * password, and the launcher starts the server on a value that would stop a
 * Node started with the switch.
 */

// Hermetic (§0): the children's STRIP list, both spellings, before any server
// module loads (serve-child.mjs imports no server code); and no proxy
// variable or switch from the developer's shell; this suite sets its own.
const { STRIP, dropInheritedOrgVars, childEnv, boot } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_USE_ENV_PROXY']) delete process.env[k];
if (process.env.NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.split(/\s+/).filter((f) => f !== '--use-env-proxy' && f !== '--no-use-env-proxy').join(' ');

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { createServer } = await import('node:http');
const net = await import('node:net');
const { spawn, spawnSync } = await import('node:child_process');
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const { isWin32, win32Skip, WIN32 } = await import('./fixtures/platform.mjs');

const { proxySettings, proxyHonoured, showProxy, usableProxy, noProxyEntries, bypassesProxy, outboundRoute, launchPlan, proxyBootReport, addressRanges } = await import('./outbound-proxy.mjs');
const { unreachable, READ_TIMEOUT_MS } = await import('./fetch-failure.mjs');
const { adoFetch } = await import('./ado-crawl.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE = { version: '22.23.4', execArgv: [] };
const ON = { NODE_USE_ENV_PROXY: '1' };
const PROXY = 'http://proxy.example.com:3128';
const SECRET = 'pr0xy-pa55';
const failed = (cause) => new TypeError('fetch failed', { cause });
const withCode = (code, message = code) => Object.assign(new Error(message), { code });
// What undici throws when a proxy answers a CONNECT with something else than 200.
const proxyAnswered = (status) => failed(Object.assign(new Error('Request was cancelled.'), {
  code: 0,
  cause: Object.assign(new Error(`Proxy response (${status}) !== 200 when HTTP Tunneling`), { name: 'AbortError', code: 'UND_ERR_ABORTED' }),
}));
// The values undici's ProxyAgent refuses, which stop a Node started with the switch.
const UNUSABLE = ['proxy.example.com:3128', 'socks5://proxy.example.com:1080', 'http://proxy.example.com:abc', `http://svc:50%off@proxy.example.com:3128`, 'http://proxy.example.com:3128/path', 'http://proxy.example.com:3128/?x=1', 'not a url'];

test('proxySettings: the lower-case name wins over the upper-case one, an empty one too, as undici reads them; the name shown is the spelling the environment holds', () => {
  const both = proxySettings({ HTTPS_PROXY: 'http://a.example.com:1', https_proxy: 'http://b.example.com:2', NO_PROXY: 'x', no_proxy: 'y' });
  assert.deepEqual(both.https, { raw: 'http://b.example.com:2', name: 'https_proxy' });
  assert.equal(both.noProxy, 'y');
  assert.equal(both.noProxyName, 'no_proxy');
  assert.equal(proxySettings({ HTTPS_PROXY: 'http://a.example.com:1', https_proxy: '' }).https, null, 'an empty lower-case name hides the upper-case one');
  const upper = proxySettings({ HTTP_PROXY: PROXY });
  assert.deepEqual(upper.http, { raw: PROXY, name: 'HTTP_PROXY' });
  assert.equal(upper.https, null);
  assert.equal(upper.noProxy, '');
  assert.equal(upper.noProxyName, 'NO_PROXY');
  assert.deepEqual(proxySettings({}), { http: null, https: null, noProxy: '', noProxyName: 'NO_PROXY' });
});

test('proxyHonoured: Node reads the variables from 22.21 on the 22 line and from 24.0; NODE_USE_ENV_PROXY=1, then the flags in NODE_OPTIONS, then on the command line, the last one winning; 24.0–24.4 take any non-empty value and no flag', () => {
  const at = (version, env = ON, execArgv = []) => proxyHonoured({ env, execArgv, version });
  assert.deepEqual(at('22.16.0'), { supported: false, switched: true, honoured: false, optedOut: false, version: 'v22.16.0' });
  assert.equal(at('22.20.9').honoured, false);
  assert.equal(at('22.21.0').honoured, true);
  assert.equal(at('v22.23.4').honoured, true);
  assert.equal(at('23.11.0').supported, false);
  assert.equal(at('24.0.0').honoured, true);
  assert.equal(at('26.1.0').honoured, true);
  assert.deepEqual(at('22.23.4', {}), { supported: true, switched: false, honoured: false, optedOut: false, version: 'v22.23.4' });
  assert.equal(at('22.23.4', {}, ['--use-env-proxy']).honoured, true);
  assert.equal(at('22.23.4', { NODE_OPTIONS: '--max-old-space-size=512 --use-env-proxy' }).honoured, true);
  assert.equal(at('22.23.4', { NODE_OPTIONS: '--use-env-proxy-not' }).honoured, false, 'the whole flag only');
  assert.deepEqual(at('22.23.4', { ...ON, NODE_OPTIONS: '--no-use-env-proxy' }), { supported: true, switched: false, honoured: false, optedOut: true, version: 'v22.23.4' });
  assert.equal(at('22.23.4', { NODE_OPTIONS: '--no-use-env-proxy' }, ['--use-env-proxy']).honoured, true, 'the command line after NODE_OPTIONS');
  assert.deepEqual(at('22.23.4', { NODE_USE_ENV_PROXY: '0' }), { supported: true, switched: false, honoured: false, optedOut: true, version: 'v22.23.4' });
  assert.equal(at('22.23.4', { NODE_USE_ENV_PROXY: 'true' }).honoured, false, '1 only, from 22.21 and 24.5');
  assert.equal(at('24.4.1', { NODE_USE_ENV_PROXY: 'true' }).honoured, true, 'any non-empty value on 24.0–24.4');
  assert.equal(at('24.4.1', {}, ['--use-env-proxy']).honoured, false, 'and no flag there');
  assert.equal(at('24.5.0', { NODE_USE_ENV_PROXY: 'true' }).honoured, false);
});

test('showProxy and usableProxy: scheme://host:port and what it signs in with, never the user name or password; only what undici\'s ProxyAgent takes is usable', () => {
  assert.deepEqual(showProxy(`http://svc:${SECRET}@proxy.example.com:3128`), { shown: 'http://proxy.example.com:3128', credentials: 'both' });
  assert.deepEqual(showProxy('http://svc@proxy.example.com:3128'), { shown: 'http://proxy.example.com:3128', credentials: 'user' });
  assert.deepEqual(showProxy('http://proxy.example.com'), { shown: 'http://proxy.example.com:80', credentials: null });
  assert.deepEqual(showProxy('https://proxy.example.com'), { shown: 'https://proxy.example.com:443', credentials: null });
  assert.deepEqual(showProxy('http://[::1]:8080'), { shown: 'http://[::1]:8080', credentials: null });
  for (const bad of ['proxy.example.com:3128', 'socks5://proxy.example.com:1080', '', 'not a url']) assert.equal(showProxy(bad), null, bad);
  for (const good of [PROXY, `${PROXY}/`, `http://svc:${SECRET}@proxy.example.com:3128`, 'http://svc:50%25off@proxy.example.com:3128', 'https://proxy.example.com', 'http://[::1]:8080']) assert.equal(usableProxy(good), true, good);
  for (const bad of UNUSABLE) assert.equal(usableProxy(bad), false, bad);
});

test('NO_PROXY: host, host:port, .suffix, *.suffix and * as undici\'s EnvHttpProxyAgent matches them — case-blind, exact for a bare host, no IP ranges — over a comma- or space-separated list', () => {
  assert.deepEqual(noProxyEntries(' localhost, 127.0.0.1:8080  .svc.cluster.local,,*.example.com '), [
    { hostname: 'localhost', port: 0 }, { hostname: '127.0.0.1', port: 8080 }, { hostname: '.svc.cluster.local', port: 0 }, { hostname: '*.example.com', port: 0 },
  ]);
  const table = [
    ['https://dev.azure.com/acme', '', false],
    ['https://dev.azure.com/acme', '*', true],
    ['https://dev.azure.com/acme', 'dev.azure.com', true],
    ['https://dev.azure.com/acme', 'DEV.AZURE.COM', true],
    ['https://eu.dev.azure.com/acme', 'dev.azure.com', false],
    ['https://eu.dev.azure.com/acme', '.azure.com', true],
    ['https://azure.com/', '.azure.com', false],
    ['https://eu.azure.com/', '*.azure.com', true],
    ['https://dev.azure.com/', 'dev.azure.com:443', true],
    ['https://dev.azure.com/', 'dev.azure.com:8443', false],
    ['http://mcp.observability.svc.cluster.local:8080/mcp', '.svc.cluster.local', true],
    ['http://otel-mcp-server:3001/mcp', '.svc,.svc.cluster.local', false],
    ['http://otel-mcp-server:3001/mcp', 'otel-mcp-server', true],
    ['http://10.1.2.3/', '10.1.2.3', true],
    ['http://10.1.2.3/', '10.0.0.0-10.255.255.255', false],
    ['http://[::1]:8080/', '[::1]', true],
    ['https://a.example.com/', 'b.example.com, .example.com', true],
    ['https://a.example.com/', 'localhost 127.0.0.1', false],
  ];
  for (const [url, noProxy, direct] of table) assert.equal(bypassesProxy(new URL(url), noProxy), direct, `${url} with NO_PROXY=${noProxy}`);
});

test('outboundRoute: through the proxy, or why not: none applies, it is no proxy URL Node can use, NO_PROXY names the host, or this Node or its switch will not use it', () => {
  const route = (url, env, node = NODE) => outboundRoute(url, { env, ...node });
  assert.deepEqual(route('https://dev.azure.com/acme', {}), { through: null, why: 'none' });
  assert.deepEqual(route('https://dev.azure.com/acme', { HTTPS_PROXY: PROXY }), { through: null, why: 'not-switched', variable: 'HTTPS_PROXY', proxy: PROXY, version: 'v22.23.4' });
  assert.deepEqual(route('https://dev.azure.com/acme', { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '0' }), { through: null, why: 'opted-out', variable: 'HTTPS_PROXY', proxy: PROXY, version: 'v22.23.4' });
  assert.deepEqual(route('https://dev.azure.com/acme', { ...ON, HTTPS_PROXY: PROXY }, { version: '22.16.0', execArgv: [] }), { through: null, why: 'old-node', variable: 'HTTPS_PROXY', proxy: PROXY, version: 'v22.16.0' });
  assert.deepEqual(route('https://dev.azure.com/acme', { ...ON, HTTPS_PROXY: `http://svc:${SECRET}@proxy.example.com:3128` }), { through: PROXY, variable: 'HTTPS_PROXY', credentials: 'both' });
  assert.deepEqual(route('http://mcp.example.com/mcp', { ...ON, HTTPS_PROXY: PROXY }), { through: null, why: 'none' }, 'HTTPS_PROXY is for https requests only');
  assert.deepEqual(route('https://dev.azure.com/acme', { ...ON, HTTP_PROXY: PROXY }), { through: PROXY, variable: 'HTTP_PROXY', credentials: null }, 'an https request falls back to HTTP_PROXY');
  assert.deepEqual(route('https://dev.azure.com/acme', { ...ON, HTTPS_PROXY: PROXY, NO_PROXY: '.azure.com' }), { through: null, why: 'no-proxy', variable: 'HTTPS_PROXY', proxy: PROXY, noProxyName: 'NO_PROXY' });
  assert.deepEqual(route('https://dev.azure.com/acme', { HTTPS_PROXY: PROXY, NO_PROXY: '.azure.com' }), { through: null, why: 'no-proxy', variable: 'HTTPS_PROXY', proxy: PROXY, noProxyName: 'NO_PROXY' }, 'NO_PROXY sends it directly with the switch on or off');
  for (const bad of UNUSABLE) assert.deepEqual(route('https://dev.azure.com/acme', { ...ON, HTTPS_PROXY: bad }), { through: null, why: 'not-a-url', variable: 'HTTPS_PROXY' }, bad);
  assert.deepEqual(route('not a url', { ...ON, HTTPS_PROXY: PROXY }), { through: null, why: 'none' });
});

test('launchPlan: the switch goes on when a proxy variable is set, this Node reads it and every value set is one Node can use; a value it cannot use leaves it off; 0 keeps it off', () => {
  const plan = (env, node = NODE) => launchPlan({ env, ...node });
  assert.deepEqual(plan({ PATH: 'x' }), { env: { PATH: 'x' }, switched: false }, 'no proxy variable: nothing changes');
  assert.deepEqual(plan({ HTTPS_PROXY: PROXY }), { env: { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '1' }, switched: true });
  assert.deepEqual(plan({ HTTP_PROXY: PROXY, http_proxy: PROXY }), { env: { HTTP_PROXY: PROXY, http_proxy: PROXY, NODE_USE_ENV_PROXY: '1' }, switched: true }, 'Docker\'s two spellings');
  assert.deepEqual(plan({ HTTPS_PROXY: PROXY }, { version: '22.16.0', execArgv: [] }), { env: { HTTPS_PROXY: PROXY }, switched: false }, 'a Node without the switch is not given it');
  assert.deepEqual(plan({ HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '0' }), { env: { HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '0' }, switched: false }, '0 keeps every request direct');
  for (const bad of UNUSABLE) assert.deepEqual(plan({ HTTPS_PROXY: bad }), { env: { HTTPS_PROXY: bad }, switched: false }, bad);
  assert.equal(plan({ HTTPS_PROXY: PROXY, HTTP_PROXY: 'proxy.example.com:3128' }).switched, false, 'one unusable value is enough');
});

test('proxyBootReport: one line, always — the proxy in use and NO_PROXY\'s hosts, never a user name or password, or none; a warning when a value is no proxy URL Node can use, when this Node or its switch will not use one, and for a NO_PROXY address range', () => {
  const report = (env, node = NODE) => proxyBootReport({ env, ...node });
  const NONE = { log: ['[studio] outbound proxy: none, every request goes directly (no HTTPS_PROXY or HTTP_PROXY is set)'], warn: [] };
  assert.deepEqual(report({}), NONE);
  assert.deepEqual(report(ON), NONE, 'the switch alone is no proxy');
  assert.deepEqual(report({ HTTPS_PROXY: PROXY }), { log: [], warn: ['[studio] WARNING: HTTPS_PROXY is set, but the server sends every request directly: Node reads it only with NODE_USE_ENV_PROXY=1 — set it too, or start the server with node server/launch.mjs'] });
  assert.deepEqual(report({ HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY }).warn, ['[studio] WARNING: HTTPS_PROXY and HTTP_PROXY are set, but the server sends every request directly: Node reads them only with NODE_USE_ENV_PROXY=1 — set it too, or start the server with node server/launch.mjs']);
  assert.deepEqual(report({ HTTPS_PROXY: PROXY, NODE_USE_ENV_PROXY: '0' }), { log: ['[studio] outbound proxy: none, every request goes directly (HTTPS_PROXY is set, and the switch is off: NODE_USE_ENV_PROXY=0)'], warn: [] });
  assert.deepEqual(report({ ...ON, HTTPS_PROXY: PROXY }, { version: '22.16.0', execArgv: [] }).warn, ['[studio] WARNING: HTTPS_PROXY is set, but this Node (v22.16.0) sends every request directly: Node 22.21 or later reads it, with NODE_USE_ENV_PROXY=1']);
  const withPassword = report({ ...ON, HTTPS_PROXY: `http://svc:${SECRET}@proxy.example.com:3128`, NO_PROXY: 'localhost,127.0.0.1 .svc.cluster.local,mcp.example.com:8443' });
  assert.deepEqual(withPassword, { log: ['[studio] outbound proxy: https requests through http://proxy.example.com:3128, with a user name and password (HTTPS_PROXY); directly to the hosts NO_PROXY names: localhost, 127.0.0.1, .svc.cluster.local, mcp.example.com:8443'], warn: [] });
  assert.ok(!JSON.stringify(withPassword).includes(SECRET) && !JSON.stringify(withPassword).includes('svc:'), 'never the user name or password');
  assert.deepEqual(report({ ...ON, HTTPS_PROXY: 'http://svc@proxy.example.com:3128' }).log, ['[studio] outbound proxy: https requests through http://proxy.example.com:3128, with a user name but no password, so it signs in with neither (HTTPS_PROXY); NO_PROXY is not set: every https request goes through the proxy, https MCP endpoints too (http ones go directly)']);
  assert.deepEqual(report({ ...ON, HTTP_PROXY: PROXY }).log, ['[studio] outbound proxy: http and https requests through http://proxy.example.com:3128 (HTTP_PROXY); NO_PROXY is not set: every request goes through the proxy, the MCP endpoints too']);
  assert.deepEqual(report({ ...ON, https_proxy: PROXY, HTTP_PROXY: 'http://other.example.com:8080', no_proxy: '*' }).log, ['[studio] outbound proxy: https requests through http://proxy.example.com:3128 (https_proxy), http requests through http://other.example.com:8080 (HTTP_PROXY); no_proxy is *: every request goes directly']);
  const UNUSABLE_WARNING = (name) => `[studio] WARNING: ${name} is not a proxy URL Node can use, so the server sends every request directly. It must be http://host:port or https://host:port with no path, and a user name or password with any of # / ? @ : % in it percent-encoded (# as %23, @ as %40)`;
  for (const bad of UNUSABLE) {
    const r = report({ HTTPS_PROXY: bad });
    assert.deepEqual(r, { log: [], warn: [UNUSABLE_WARNING('HTTPS_PROXY')] }, `${bad}: the launcher took the switch away; the start says which variable to fix, not to set the switch`);
    assert.ok(!JSON.stringify(r).includes('50%off'), 'never the value');
  }
  // Docker's own example NO_PROXY carries a CIDR range; Node's fetch matches it as a name.
  assert.deepEqual(report({ ...ON, HTTPS_PROXY: PROXY, NO_PROXY: 'localhost,127.0.0.0/8,10.0.0.1-10.0.0.9,.svc' }).warn, ['[studio] WARNING: NO_PROXY names 127.0.0.0/8 and 10.0.0.1-10.0.0.9 as address ranges, which Node\'s fetch does not read: requests to those addresses go through the proxy. List the hosts or addresses one by one']);
  assert.deepEqual(report({ ...ON, HTTPS_PROXY: PROXY, NO_PROXY: '10.0.0.0/8' }).warn, ['[studio] WARNING: NO_PROXY names 10.0.0.0/8 as an address range, which Node\'s fetch does not read: requests to those addresses go through the proxy. List the hosts or addresses one by one']);
  assert.deepEqual(addressRanges('10.0.0.0/8 ::1/128, 10.0.0.1-10.0.0.9,a-b.example.com,host:8080,.svc,*'), ['10.0.0.0/8', '::1/128', '10.0.0.1-10.0.0.9']);
});

test('unreachable through a proxy: its refusal by status — a 407 by what the URL already carries — the proxy itself not reached, a TLS handshake that timed out inside the tunnel, and a host not reached through it are each said as what they are', () => {
  const THROUGH = { through: PROXY, variable: 'HTTPS_PROXY', credentials: null };
  const said = (error, route = THROUGH, url = 'https://dev.azure.com/acme/x/_apis/y') => unreachable('Azure DevOps', url, error, { route }).message;
  const VIA = `Azure DevOps: https://dev.azure.com could not be reached through the proxy ${PROXY} — `;
  assert.equal(said(proxyAnswered(407)), `${VIA}the proxy asks for a user name and password (407): give them in the proxy URL, http://user:password@host:port, percent-encoded`);
  assert.equal(said(proxyAnswered(407), { ...THROUGH, credentials: 'both' }), `${VIA}the proxy refused the user name and password in HTTPS_PROXY (407), or it asks for a sign-in other than Basic, such as NTLM or Kerberos, which Node's fetch cannot give`);
  assert.equal(said(proxyAnswered(407), { ...THROUGH, credentials: 'user' }), `${VIA}the proxy asks for a user name and password (407): HTTPS_PROXY has a user name but no password, and neither is sent without the other`);
  assert.equal(said(proxyAnswered(403)), `${VIA}the proxy does not allow it (403): ask for dev.azure.com to be allowed through it`);
  for (const status of [502, 503, 504]) assert.equal(said(proxyAnswered(status)), `${VIA}the proxy could not reach it (${status}): if dev.azure.com is inside your network, add it to NO_PROXY`);
  assert.equal(said(proxyAnswered(500)), `${VIA}the proxy answered 500 instead of opening the connection`);
  const PROXY_DOWN = `Azure DevOps: the proxy ${PROXY} could not be reached from the server — `;
  assert.equal(said(failed(withCode('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.9:3128'))), `${PROXY_DOWN}the connection was refused (ECONNREFUSED)`);
  assert.equal(said(failed(withCode('ENOTFOUND', 'getaddrinfo ENOTFOUND proxy.example.com'))), `${PROXY_DOWN}its name does not resolve on the server (ENOTFOUND)`);
  assert.equal(said(failed(withCode('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error (attempted address: proxy.example.com:3128, timeout: 10000ms)'))), `${PROXY_DOWN}the connection timed out (UND_ERR_CONNECT_TIMEOUT)`);
  assert.equal(said(failed(withCode('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error (attempted address: dev.azure.com:443, timeout: 10000ms)'))), `${VIA}the proxy opened the connection, but the TLS handshake with dev.azure.com timed out (UND_ERR_CONNECT_TIMEOUT)`);
  assert.equal(said(failed(withCode('ECONNRESET'))), `${VIA}the connection was dropped (ECONNRESET)`);
  assert.equal(said(failed(withCode('SELF_SIGNED_CERT_IN_CHAIN'))), `${VIA}its certificate is not one the server trusts (if a proxy re-signs the traffic, give the server its certificate authority with NODE_EXTRA_CA_CERTS) (SELF_SIGNED_CERT_IN_CHAIN)`);
  assert.equal(said(failed(new Error('unexpected redirect'))), 'Azure DevOps: https://dev.azure.com answered with a redirect, which the server does not follow (unexpected redirect)', 'a redirect is the host\'s, through a proxy or not');
  assert.equal(said(failed(Object.assign(new Error('Request was cancelled.'), { code: 0 }))), 'Azure DevOps: https://dev.azure.com: fetch failed — Request was cancelled.', 'no cause claimed that was not seen');
  assert.equal(unreachable('GitHub', 'https://api.github.com', proxyAnswered(502), { route: THROUGH }).message, `GitHub: https://api.github.com could not be reached through the proxy ${PROXY} — the proxy could not reach it (502): if api.github.com is inside your network, add it to NO_PROXY`);
});

test('unreachable directly: a host with no route from here says how a proxy is set — or why the one set was not used; a refusal or a TLS failure carries no such hint', () => {
  const said = (route, error = failed(withCode('UND_ERR_CONNECT_TIMEOUT'))) => unreachable('Azure DevOps', 'https://dev.azure.com/acme/x/_apis/y', error, { route }).message;
  const TIMED_OUT = 'Azure DevOps: https://dev.azure.com could not be reached from the server — the connection timed out (UND_ERR_CONNECT_TIMEOUT)';
  assert.equal(said({ through: null, why: 'none' }), `${TIMED_OUT}; if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1`);
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']) assert.match(said({ through: null, why: 'none' }, failed(withCode(code))), /; if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1$/, code);
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_SSL_WRONG_VERSION_NUMBER']) assert.ok(!said({ through: null, why: 'none' }, failed(withCode(code))).includes('PROXY'), code);
  assert.equal(said({ through: null, why: 'not-switched', variable: 'HTTPS_PROXY', proxy: PROXY, version: 'v22.23.4' }), `${TIMED_OUT}; HTTPS_PROXY is set, but the server sends its requests directly: set NODE_USE_ENV_PROXY=1 too, or start it with node server/launch.mjs`);
  assert.equal(said({ through: null, why: 'opted-out', variable: 'HTTPS_PROXY', proxy: PROXY, version: 'v22.23.4' }), `${TIMED_OUT}; HTTPS_PROXY is set, but the switch is off (NODE_USE_ENV_PROXY is not 1), so the server sends its requests directly`);
  assert.equal(said({ through: null, why: 'old-node', variable: 'https_proxy', proxy: PROXY, version: 'v22.16.0' }), `${TIMED_OUT}; https_proxy is set, but this Node (v22.16.0) sends its requests directly: Node 22.21 or later reads it, with NODE_USE_ENV_PROXY=1`);
  assert.equal(said({ through: null, why: 'no-proxy', variable: 'HTTPS_PROXY', proxy: PROXY, noProxyName: 'NO_PROXY' }), `${TIMED_OUT}; NO_PROXY sends dev.azure.com directly, not through the proxy ${PROXY}`);
  assert.equal(said({ through: null, why: 'not-a-url', variable: 'HTTPS_PROXY' }), `${TIMED_OUT}; HTTPS_PROXY is not a proxy URL Node can use (http://host:port with no path, a user name and password percent-encoded), so the server sends its requests directly`);
  // The default route is this process's: no proxy variable here.
  assert.equal(unreachable('Azure DevOps', 'https://dev.azure.com/acme', failed(withCode('UND_ERR_CONNECT_TIMEOUT'))).message, `${TIMED_OUT}; if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1`);
});

test('the readers give up after READ_TIMEOUT_MS: each fetch carries the deadline, and a read past it says so, through the proxy or not', async () => {
  assert.equal(READ_TIMEOUT_MS, 60_000);
  let signal = null;
  const timedOut = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  await assert.rejects(adoFetch('https://dev.azure.com/acme/_apis/projects', { fetchImpl: async (url, init) => { signal = init.signal; throw timedOut; } }),
    (e) => e.message === 'Azure DevOps: https://dev.azure.com did not answer within 60 s' && e.status === undefined && e.cause === timedOut);
  assert.ok(signal instanceof AbortSignal && !signal.aborted, 'adoFetch gives fetch a deadline');
  assert.equal(unreachable('GitHub', 'https://api.github.com', timedOut, { route: { through: PROXY, variable: 'HTTPS_PROXY', credentials: null } }).message, `GitHub: https://api.github.com did not answer within 60 s through the proxy ${PROXY}`);
  const other = new DOMException('The operation was aborted', 'AbortError');
  assert.equal(unreachable('GitHub', 'https://api.github.com', other), other, 'another abort is left as it is');
});

// ---------- the live half: Node's own fetch through a proxy on loopback ----------

const LIVE = proxyHonoured({ env: ON, execArgv: [] }).supported;
const SKIP = LIVE ? false : `this Node (${process.version}) does not read the proxy variables (22.21 or later does); CI's runners run it`;
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const servers = [];
const workspaces = [];
after(() => { for (const s of servers) s.close(); for (const w of workspaces) rmSync(w, { recursive: true, force: true }); });

// Two answers on loopback: the one a direct request reaches, and the one the
// proxy's tunnels and forwards reach. The body says which way a request went.
async function loopbackPair() {
  const direct = createServer((req, res) => res.end('direct'));
  const viaProxy = createServer((req, res) => res.end('via the proxy'));
  servers.push(direct, viaProxy);
  return { directPort: await listen(direct), viaPort: await listen(viaProxy) };
}

// A proxy on loopback: it tunnels CONNECT to loopback into `viaPort`, answers
// dev.azure.com with 407 and api.github.com with 502, refuses anything else
// with 403, and records every request it saw.
async function loopbackProxy(viaPort) {
  const seen = [];
  const proxy = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end('via the proxy'); });
  proxy.on('connect', (req, sock) => {
    seen.push(`CONNECT ${req.url}`);
    const host = req.url.replace(/:\d+$/, '');
    if (host === 'dev.azure.com') return sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\n\r\n');
    if (host === 'api.github.com') return sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    if (host !== '127.0.0.1' && host !== 'localhost') return sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const up = net.connect(viaPort, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  servers.push(proxy);
  return { seen, url: `http://127.0.0.1:${await listen(proxy)}` };
}

// One child Node with `env` beside this process's (minus STRIP), running `code`
// as a module; resolves its stdout parsed as JSON.
function child(code, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: childEnv(null, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => p.kill(), 30_000);
    p.on('close', (status) => {
      clearTimeout(t);
      try { resolve(JSON.parse(out)); } catch { reject(new Error(`the child (status ${status}) printed no JSON: ${out}${err}`)); }
    });
  });
}

const moduleUrl = (name) => pathToFileURL(join(HERE, name)).href;

test('Node\'s fetch takes the route outboundRoute names, for every NO_PROXY form: through the proxy, or directly', { skip: SKIP, timeout: 120_000 }, async () => {
  const { directPort, viaPort } = await loopbackPair();
  const proxy = await loopbackProxy(viaPort);
  const forms = ['', '*', '127.0.0.1', 'localhost', 'LOCALHOST', `127.0.0.1:${directPort}`, '127.0.0.1:1', '.0.0.1', '*.0.0.1', 'other.example.com,  localhost', '127.0.0.0-127.0.0.255'];
  const code = `
    const { outboundRoute } = await import(${JSON.stringify(moduleUrl('outbound-proxy.mjs'))});
    const out = [];
    for (const url of ['http://127.0.0.1:${directPort}/a', 'http://localhost:${directPort}/b']) {
      const body = await fetch(url).then((r) => r.text(), (e) => 'failed: ' + (e.cause?.code || e.message));
      out.push({ url, body, predicted: outboundRoute(url).through ? 'via the proxy' : 'direct' });
    }
    process.stdout.write(JSON.stringify(out));`;
  for (const NO_PROXY of forms) {
    const rows = await child(code, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy.url, NO_PROXY });
    for (const r of rows) assert.equal(r.body, r.predicted, `${r.url} with NO_PROXY=${JSON.stringify(NO_PROXY)}: Node sent it ${r.body}, outboundRoute said ${r.predicted}`);
  }
  assert.ok(proxy.seen.length > 0, 'some requests went through the proxy');
});

test('the readers through a proxy: the Azure DevOps and GitHub requests reach it, its 407 and 502 come back as sentences, a proxy that is down is named, and NO_PROXY hosts skip it', { skip: SKIP, timeout: 120_000 }, async () => {
  const { directPort, viaPort } = await loopbackPair();
  const proxy = await loopbackProxy(viaPort);
  const code = `
    const { adoFetch } = await import(${JSON.stringify(moduleUrl('ado-crawl.mjs'))});
    const { ghFetch } = await import(${JSON.stringify(moduleUrl('github-crawl.mjs'))});
    const out = {};
    try { await adoFetch('https://dev.azure.com/acme/_apis/projects'); out.ado = 'read'; } catch (e) { out.ado = e.message; }
    try { await ghFetch('/repos/acme/x'); out.gh = 'read'; } catch (e) { out.gh = e.message; }
    out.loopback = await fetch('http://localhost:${directPort}/c').then((r) => r.text());
    process.stdout.write(JSON.stringify(out));`;
  const out = await child(code, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: 'localhost' });
  assert.equal(out.ado, `Azure DevOps: https://dev.azure.com could not be reached through the proxy ${proxy.url} — the proxy asks for a user name and password (407): give them in the proxy URL, http://user:password@host:port, percent-encoded`);
  assert.equal(out.gh, `GitHub: https://api.github.com could not be reached through the proxy ${proxy.url} — the proxy could not reach it (502): if api.github.com is inside your network, add it to NO_PROXY`);
  assert.equal(out.loopback, 'direct', 'NO_PROXY=localhost sends it directly');
  assert.ok(proxy.seen.includes('CONNECT dev.azure.com:443') && proxy.seen.includes('CONNECT api.github.com:443'), `the proxy saw both hosts: ${JSON.stringify(proxy.seen)}`);
  assert.ok(!proxy.seen.some((s) => s.includes('localhost')), 'and never the NO_PROXY host');

  // A proxy that is not listening: the proxy is named, not the host.
  const gone = createServer();
  const deadPort = await listen(gone);
  await new Promise((r) => gone.close(r));
  const down = await child(`
    const { adoFetch } = await import(${JSON.stringify(moduleUrl('ado-crawl.mjs'))});
    try { await adoFetch('https://dev.azure.com/acme/_apis/projects'); process.stdout.write(JSON.stringify('read')); } catch (e) { process.stdout.write(JSON.stringify(e.message)); }`,
  { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: `http://127.0.0.1:${deadPort}` });
  assert.equal(down, `Azure DevOps: the proxy http://127.0.0.1:${deadPort} could not be reached from the server — the connection was refused (ECONNREFUSED)`);
});

// A line of the start's output: the one right after "[studio] listening on".
const lines = (text) => text.split(/\r?\n/);
const afterListening = (text) => { const all = lines(text); const i = all.findIndex((l) => l.startsWith('[studio] listening on ')); return i >= 0 ? all[i + 1] : null; };

test('the start says, right after "listening on", which proxy its requests go through or that there is none, never the password; a proxy variable this Node will not use is a warning at the start', { timeout: 120_000 }, () => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-outbound-proxy-'));
  workspaces.push(ws);
  // No proxy variable: the line says so, beside "listening on".
  let r = boot(ws, { env: { OBSERVOGRAM_AUTH: 'off' }, silent: false });
  assert.equal(r.listening, true, r.stderr);
  assert.equal(afterListening(r.stdout), '[studio] outbound proxy: none, every request goes directly (no HTTPS_PROXY or HTTP_PROXY is set)', r.stdout);
  const PROXY_ENV = { OBSERVOGRAM_AUTH: 'off', HTTPS_PROXY: `http://svc:${SECRET}@proxy.example.com:3128`, NO_PROXY: 'localhost,.svc.cluster.local' };
  // Without the switch: the warning this Node's start prints.
  r = boot(ws, { env: { ...PROXY_ENV, NODE_USE_ENV_PROXY: undefined }, silent: false });
  assert.equal(r.listening, true, r.stderr);
  const expected = proxyBootReport({ env: PROXY_ENV }).warn;
  assert.equal(expected.length, 1);
  assert.ok(lines(r.stderr).includes(expected[0]), `the start warns: ${expected[0]}\n${r.stderr}`);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), 'never the password');
  if (!LIVE) return;
  // With it, on a Node that reads the variables: the proxy in use, host and port.
  r = boot(ws, { env: { ...PROXY_ENV, NODE_USE_ENV_PROXY: '1' }, silent: false });
  assert.equal(r.listening, true, r.stderr);
  assert.equal(afterListening(r.stdout), '[studio] outbound proxy: https requests through http://proxy.example.com:3128, with a user name and password (HTTPS_PROXY); directly to the hosts NO_PROXY names: localhost, .svc.cluster.local', r.stdout);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), 'never the password');
  assert.ok(!r.stderr.includes('[studio] WARNING: HTTPS_PROXY'), 'and no warning');
});

// The image's entrypoint, started as the image starts it, until its server
// listens and has said its outbound line; then stopped: SIGTERM, which the
// launcher hands to the server (Windows ends a process outright, so there the
// tree is ended with taskkill).
function launch(env) {
  return new Promise((resolve, reject) => {
    const ws = mkdtempSync(join(tmpdir(), 'observogram-launch-'));
    workspaces.push(ws);
    const p = spawn(process.execPath, [join(HERE, 'launch.mjs')], { env: childEnv(ws, { OBSERVOGRAM_AUTH: 'off', HOST: '127.0.0.1', PORT: '0', ...env }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // A signal ends a Windows process outright, the launcher with it, so there the tree goes with taskkill.
      return isWin32 ? spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F']) : p.kill('SIGTERM');
    };
    // The outbound line or warning is written in the same tick as "listening on"; half a second covers the two pipes.
    p.stdout.on('data', (c) => { stdout += c; if (stdout.includes('[studio] listening on ')) setTimeout(stop, 500); });
    p.stderr.on('data', (c) => { stderr += c; });
    const t = setTimeout(() => { stop(); reject(new Error(`the launcher did not start in 60 s: ${stdout}${stderr}`)); }, 60_000);
    p.on('close', (code, signal) => { clearTimeout(t); resolve({ stdout, stderr, code, signal }); });
  });
}

test('the launcher: it turns the switch on for a proxy URL Node can use, starts the server on one Node cannot (where a Node started with the switch stops) and says which variable to fix without its value, and hands SIGTERM to the server', { timeout: 180_000 }, async () => {
  // A usable proxy, no switch given: the launcher gives it, where this Node reads it.
  let r = await launch({ HTTPS_PROXY: `http://svc:${SECRET}@proxy.example.com:3128`, NO_PROXY: 'localhost' });
  const usable = LIVE
    ? '[studio] outbound proxy: https requests through http://proxy.example.com:3128, with a user name and password (HTTPS_PROXY); directly to the hosts NO_PROXY names: localhost'
    : null;
  if (usable) assert.equal(afterListening(r.stdout), usable, r.stdout + r.stderr);
  else assert.ok(lines(r.stderr).includes(proxyBootReport({ env: { HTTPS_PROXY: PROXY } }).warn[0]), `a Node that cannot read it is not given the switch, and the start says so: ${r.stderr}`);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET), 'never the password');

  // A value Node cannot parse: the server starts, and says which variable.
  const BAD = 'http://svc:50%off@proxy.example.com:3128';
  r = await launch({ HTTPS_PROXY: BAD });
  assert.match(r.stdout, /^\[studio\] listening on /m, r.stdout + r.stderr);
  assert.ok(lines(r.stderr).includes(proxyBootReport({ env: { HTTPS_PROXY: BAD } }).warn[0]), r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes('50%off'), 'never the value');
  if (LIVE) {
    // What the launcher spares: Node, started with the switch on that value, stops before any code runs.
    const alone = spawnSync(process.execPath, ['-e', 'console.log("ran")'], { env: childEnv(null, { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: BAD }), encoding: 'utf8' });
    assert.notEqual(alone.status, 0, 'Node alone stops');
    assert.ok(!alone.stdout.includes('ran'), 'before any code runs');
  }
});

test('the launcher hands SIGTERM to the server, and ends with the server\'s exit code (128 + 15)', { skip: win32Skip(WIN32.signals), timeout: 120_000 }, async () => {
  const r = await launch({});
  assert.equal(afterListening(r.stdout), '[studio] outbound proxy: none, every request goes directly (no HTTPS_PROXY or HTTP_PROXY is set)', r.stdout + r.stderr);
  assert.equal(r.code, 143, `SIGTERM reached the server, and the launcher ended with its exit (${r.code}, ${r.signal})`);
});
