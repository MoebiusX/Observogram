#!/usr/bin/env node
/**
 * server/test-mcp-target-policy.mjs — server/mcp-target-policy.mjs, in
 * process: redactTarget, the route-level backstop every MCP route runs its
 * 502 bodies, deploy-record errors and log lines through.
 */

// Hermetic (§0): the children's STRIP list, both spellings, before any server
// module loads (serve-child.mjs imports no server code).
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { redactTarget } = await import('./mcp-target-policy.mjs');

test('redactTarget: the resolved token, wherever the text repeats it', () => {
  const target = { mcpUrl: 'https://mcp.example.com/mcp', mcpAuth: 'tok-1234' };
  assert.equal(redactTarget('MCP HTTP 401 on initialize: you sent Bearer tok-1234 (tok-1234)', target),
    'MCP HTTP 401 on initialize: you sent Bearer <redacted> (<redacted>)');
  assert.equal(redactTarget('nothing secret here', target), 'nothing secret here');
});

test('redactTarget: userinfo, decoded and as written, and any //user:pass@ left', () => {
  const target = { mcpUrl: 'https://us%40er:p%3Ass@mcp.example.com/mcp', mcpAuth: null };
  assert.equal(redactTarget('as written us%40er:p%3Ass, decoded us@er and p:ss', target), 'as written <redacted>:<redacted>, decoded <redacted> and <redacted>');
  assert.equal(redactTarget('fetch https://someone:else@other.example/x failed', target), 'fetch https://***@other.example/x failed');
});

test('redactTarget: credential-named query values, decoded and encoded; other parameters kept', () => {
  const target = { mcpUrl: 'https://mcp.example.com/mcp?api_key=a%2Fb%2Bc&tier=x&token=zz-9', mcpAuth: null };
  assert.equal(redactTarget('GET /mcp?api_key=a%2Fb%2Bc&tier=x&token=zz-9 said a/b+c', target), 'GET /mcp?api_key=<redacted>&tier=x&token=<redacted> said <redacted>');
});

test('redactTarget: longest first, so a secret containing another goes whole', () => {
  const target = { mcpUrl: 'https://mcp.example.com/mcp?token=abc', mcpAuth: 'abcdef' };
  assert.equal(redactTarget('abcdef and abc', target), '<redacted> and <redacted>');
});

test('redactTarget: null or undefined text is empty; a null target or one without a URL still redacts what it can', () => {
  assert.equal(redactTarget(undefined, { mcpAuth: 'x1' }), '');
  assert.equal(redactTarget(null, null), '');
  assert.equal(redactTarget('Bearer x1y2', { mcpAuth: 'x1y2' }), 'Bearer <redacted>');
  assert.equal(redactTarget('see http://u:p@h/', null), 'see http://***@h/');
  assert.equal(redactTarget(new Error('boom tok').message, { mcpUrl: 'not a url', mcpAuth: 'tok' }), 'boom <redacted>');
});
