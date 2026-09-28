// tools/lib/mcp-url-safety.mjs — the MCP URL as it may be persisted, logged
// or served (docs/STORE_PLAN.md §5: the live pack keeps no credential).
//
// One rule, three consumers: the server (server/mcp-url.mjs re-exports it;
// the live pack, a draft's mcp.url, every log line), the fetch-live CLI
// (tools/fetch-live-pack.mjs) and the studio (the remembered MCP URL,
// loaded with import('/lib/mcp-url-safety.mjs')). Pure and browser-safe:
// the WHATWG URL only, no import.
//
// What it removes: userinfo, the fragment, and every query parameter whose
// DECODED name is a credential word — or whose value carries a
// `;`-separated credential pair (`tier=x;pwd=…`: some servers split on `;`,
// URLSearchParams does not). What no name-based rule can see — a secret in
// the URL's path (`/mcp/s/<key>/mcp`), or in a parameter named like
// nothing below — stays; the documented place for a token is the separate
// auth field (sent as a header, never stored), and the server serves the
// URL to operators only (its origin to everyone).

// Matched by WORD, not by substring: the name is split at camelCase
// boundaries, at digits and at every other non-letter, and a word — or the
// whole name with its separators removed — is one of these. So `token`,
// `api_key`, `apiKey`, `X-Amz-Signature`, `access_token`, `sessionId`,
// `pwd`, `jwt`, `token1` are credentials; `signal`, `design`, `keyspace`,
// `monkey`, `author`, `bypass`, `passive`, `tenant`, `tier` are not.
const CREDENTIAL_WORDS = new Set(['token', 'tokens', 'key', 'keys', 'apikey', 'secret', 'secrets',
  'pass', 'passwd', 'password', 'passphrase', 'pwd', 'auth', 'authorization', 'authtoken',
  'accesstoken', 'sig', 'signature', 'credential', 'credentials', 'jwt', 'session', 'sessionid',
  'bearer', 'sas']);

// A name written as one run — all lowercase or all uppercase, with no
// boundary to split at (`apitoken`, `APISECRET`, `clientsecret`,
// `refreshtoken`, `ACCESSKEY`, `xapikey`) — is still a credential: a word
// that ENDS in one of these is one. No common word ends in them; `key`
// alone is not one of them (`monkey`, `turkey`, `hockey`), only its
// credential compounds are.
const CREDENTIAL_TAILS = ['token', 'tokens', 'secret', 'secrets', 'password', 'passwd',
  'passphrase', 'passcode', 'pwd', 'credential', 'credentials', 'signature', 'sessionid',
  'apikey', 'accesskey', 'secretkey', 'privatekey', 'authkey', 'sessionkey', 'signingkey'];

const credentialWord = (w) => CREDENTIAL_WORDS.has(w) || CREDENTIAL_TAILS.some((t) => w.endsWith(t));

export function credentialParamName(name) {
  const text = String(name ?? '');
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.some(credentialWord)) return true;
  return credentialWord(text.replace(/[^A-Za-z]+/g, '').toLowerCase());
}

// A value that smuggles a `;`-separated `name=value` pair naming a credential.
function carriesCredentialPair(value) {
  return String(value).split(';').slice(1).some((part) => {
    const eq = part.indexOf('=');
    return eq > 0 && credentialParamName(part.slice(0, eq).trim());
  });
}

// { safe, dropped } — the URL without userinfo, fragment and credential
// parameters, and the (decoded) names of the parameters it dropped; safe is
// null when `raw` is not a URL.
export function stripMcpUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { return { safe: null, dropped: [] }; }
  url.username = '';
  url.password = '';
  url.hash = '';
  const dropped = [];
  // A copy of the keys: deleting while iterating the live iterator skips entries.
  for (const name of [...new Set(url.searchParams.keys())]) {
    if (credentialParamName(name) || url.searchParams.getAll(name).some(carriesCredentialPair)) {
      dropped.push(name);
    }
  }
  // Only rewrite the query when something goes: the rest keeps its spelling.
  for (const name of dropped) url.searchParams.delete(name);
  return { safe: url.href, dropped };
}

// The URL as it may be persisted, logged or served; null when not a URL.
export function safeMcpUrl(raw) {
  return stripMcpUrl(raw).safe;
}

// scheme://host:port — never a path, a query or userinfo; null when `raw`
// is not an http(s) URL.
export function mcpUrlOrigin(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

// The sentence a route or the studio shows when it dropped something.
export function droppedNote(dropped, { where = 'not kept in the live pack' } = {}) {
  if (!dropped?.length) return null;
  const names = dropped.map((n) => `"${n}"`).join(', ');
  return `${where}: the ${names} parameter${dropped.length === 1 ? '' : 's'} of the MCP URL, which look${dropped.length === 1 ? 's' : ''} like ${dropped.length === 1 ? 'a credential' : 'credentials'} — put a token in the auth field instead`;
}
