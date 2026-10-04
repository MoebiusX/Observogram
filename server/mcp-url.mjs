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
// The rules themselves are tools/lib/mcp-url-safety.mjs's mcpUrlPolicy()
// (pure: the posture is an argument), which the MCP client also runs on the
// URL a transport hook returns — this module adds the env read and the
// stderr note. Hostnames that RESOLVE to private addresses are not caught
// (no DNS lookup); the literal-IP check covers hex/decimal/octal IPv4 forms
// because the WHATWG URL parser normalises those to dotted-decimal.

import { brandEnv } from '../tools/lib/brand-env.mjs';
import { mcpUrlPolicy } from '../tools/lib/mcp-url-safety.mjs';

export {
  credentialParamName, safeMcpUrl, stripMcpUrl, mcpUrlOrigin, droppedNote,
  isLocalOrPrivateHost, redactCredentials, mcpUrlPolicy,
} from '../tools/lib/mcp-url-safety.mjs';

// The server's posture: local/private targets are allowed unless
// OBSERVOGRAM_ALLOW_LOCAL_MCP=0, read per call so a suite can flip it.
export function allowLocalMcp() {
  return brandEnv('ALLOW_LOCAL_MCP') !== '0';
}

// Returns { safeUrl } when the URL is fetchable, { error } when it must be
// rejected with a 400. safeUrl is safeMcpUrl(): the URL with userinfo, the
// fragment and credential parameters removed.
export function validateMcpUrl(raw) {
  const verdict = mcpUrlPolicy(raw, { allowLocal: allowLocalMcp() });
  if (verdict.error) return { error: verdict.error };
  if (verdict.local) {
    process.stderr.write(`[mcp-url] note: ${verdict.safeUrl} targets a local/private address; set OBSERVOGRAM_ALLOW_LOCAL_MCP=0 to refuse these\n`);
  }
  return { safeUrl: verdict.safeUrl };
}
