// server/mcp-url.mjs — MCP URL validation (SSRF guard)
//
// Every deploy / draft / refresh endpoint fetches a caller-supplied mcpUrl
// server-side, which is a server-side request forgery vector if the URL is
// taken on faith. validateMcpUrl() is the single gate:
//   - only http(s) is accepted (no file:, ftp:, gopher:, ...);
//   - localhost / private / link-local addresses are allowed by default
//     (a local MCP server is the normal dev setup) but logged per use;
//     set OBSERVOGRAM_ALLOW_LOCAL_MCP=0 to turn them into 400s when the
//     studio is exposed beyond the developer's own machine;
//   - the returned safeUrl is safeMcpUrl(url) (tools/lib/mcp-url-safety.mjs,
//     re-exported here): userinfo, the fragment and every query parameter
//     named like a credential removed — stderr logs, deploys.jsonl and
//     every persisted pack must use it (or redactCredentials), never the
//     raw URL. Fetches keep using the raw URL.
// Hostnames that RESOLVE to private addresses are not caught (no DNS
// lookup here); the literal-IP check covers hex/decimal/octal IPv4 forms
// because the WHATWG URL parser normalises those to dotted-decimal.

import { brandEnv } from '../tools/lib/brand-env.mjs';
import { safeMcpUrl } from '../tools/lib/mcp-url-safety.mjs';

export { credentialParamName, safeMcpUrl, stripMcpUrl, mcpUrlOrigin, droppedNote } from '../tools/lib/mcp-url-safety.mjs';

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

export function isLocalOrPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (PRIVATE_V4.some(re => re.test(host))) return true;
  // IPv6: loopback/unspecified, unique-local fc00::/7, link-local fe80::/10,
  // and IPv4-mapped forms of any of the above.
  if (host === '::1' || host === '::') return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
  if (host.startsWith('::ffff:')) return isLocalOrPrivateHost(host.slice(7));
  return false;
}

export function redactCredentials(text) {
  return String(text).replace(/\/\/[^/\s@]+@/g, '//***@');
}

// Returns { safeUrl } when the URL is fetchable, { error } when it must be
// rejected with a 400. safeUrl is safeMcpUrl(): the URL with userinfo, the
// fragment and credential parameters removed.
export function validateMcpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: `mcpUrl is not a valid URL: ${redactCredentials(raw)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `mcpUrl must be http or https; got scheme '${url.protocol.replace(/:$/, '')}'` };
  }
  const safeUrl = safeMcpUrl(url.href);
  if (isLocalOrPrivateHost(url.hostname)) {
    if (brandEnv('ALLOW_LOCAL_MCP') === '0') {
      return { error: `mcpUrl targets a local/private address (${url.hostname}), which OBSERVOGRAM_ALLOW_LOCAL_MCP=0 forbids` };
    }
    process.stderr.write(`[mcp-url] note: ${safeUrl} targets a local/private address; set OBSERVOGRAM_ALLOW_LOCAL_MCP=0 to refuse these\n`);
  }
  return { safeUrl };
}
