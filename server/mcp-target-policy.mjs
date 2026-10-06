// server/mcp-target-policy.mjs — what the server does with a resolved MCP
// target beyond fetching it. SQL-free; no env read.
//
// redactTarget(text, target) is the route-level backstop for every text an
// MCP route sends back or logs after a fetch went wrong. The MCP client
// (tools/lib/mcp-client.mjs) already redacts by value every text an MCP
// answer puts into an error; each MCP route — draft-from-mcp, refresh-live,
// deploy, deploy-bulk, rollback — runs its error texts through this again,
// with the target resolveMcpTarget answered, before a 502 body, a deploy
// record's item error or a log line. The secrets are the resolved token (a
// server-held variable's value or the caller's mcpAuth — the client's
// bearer), the URL's userinfo and every credential-named query parameter
// value (stripMcpUrl's rule), each decoded and as written, longest first;
// then redactCredentials masks any `//user:pass@` left in the text.

import { redactCredentials, stripMcpUrl } from './mcp-url.mjs';

function secretsOf({ mcpUrl = null, mcpAuth = null } = {}) {
  const set = new Set();
  const add = (v) => { if (typeof v === 'string' && v !== '') set.add(v); };
  add(mcpAuth);
  try {
    const url = new URL(String(mcpUrl));
    for (const part of [url.username, url.password]) {
      add(part);
      try { add(decodeURIComponent(part)); } catch { /* malformed escape: the raw form is in */ }
    }
    for (const name of stripMcpUrl(mcpUrl).dropped) {
      for (const value of url.searchParams.getAll(name)) { add(value); add(encodeURIComponent(value)); }
    }
  } catch { /* no URL: the token alone */ }
  return [...set].sort((a, b) => b.length - a.length);
}

// `text` with the target's secrets replaced by <redacted>; '' for null or
// undefined. A target of null redacts URL userinfo only.
export function redactTarget(text, target) {
  let out = String(text ?? '');
  for (const secret of secretsOf(target ?? {})) out = out.split(secret).join('<redacted>');
  return redactCredentials(out);
}
