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
// DECODED name is or ends in a credential word — or whose value carries a
// `;`-separated credential pair (`tier=x;pwd=…`: some servers split on `;`,
// URLSearchParams does not). What no name-based rule can see — a secret in
// the URL's path (`/mcp/s/<key>/mcp`), or in a parameter named like
// nothing below — stays; the documented place for a token is the separate
// auth field (sent as a header, never stored), and the server serves the
// URL to operators only (its origin to everyone).

// Matched by WORD, not by substring: the name is split at camelCase
// boundaries, at digits and at every other non-letter, and a word — or the
// whole name with its separators and digits removed, which is how a name
// written as one run is read — that IS or ENDS IN one of these, in any
// case, is a credential. So `token`, `api_key`, `apiKey`, `X-Amz-Signature`,
// `access_token`, `sessionId`, `pwd`, `jwt`, `token1` are credentials, and
// so are `apitoken`, `APISECRET`, `clientsecret`, `appkey`, `DBPASS`,
// `urlsig`, `basicauth`, `apijwt`, `usersession`, `PHPSESSID`; `signal`,
// `design`, `keyspace`, `keyword`, `author`, `passive`, `tenant`, `tier`
// (a credential word inside, not at the end) are not.
const CREDENTIAL_WORDS = ['token', 'tokens', 'key', 'keys', 'secret', 'secrets', 'pass', 'passwd',
  'password', 'passphrase', 'passcode', 'pwd', 'auth', 'authorization', 'sig', 'signature',
  'credential', 'credentials', 'jwt', 'session', 'sessionid', 'sessid', 'cookie', 'bearer', 'sas'];

// ...unless it ends in one of these ordinary words, which merely end in a
// credential word. Short on purpose: a secret kept costs more than a
// harmless parameter dropped (the server still fetches the raw URL), so
// `sortkey` or `partitionkey` go; `bypass`, `monkey`, `obsession` stay.
const ORDINARY_WORDS = ['bypass', 'compass', 'overpass', 'surpass', 'monkey', 'donkey', 'turkey',
  'hockey', 'jockey', 'whiskey', 'hotkey', 'obsession'];

const credentialWord = (w) => CREDENTIAL_WORDS.some((c) => w.endsWith(c))
  && !ORDINARY_WORDS.some((o) => w.endsWith(o));

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
  // Only the dropped names' own `&`-segments go (and the empty ones, which
  // carry nothing); every other segment keeps its spelling.
  // (searchParams.delete() would re-serialise the rest — `%20` → `+`,
  // `,` → `%2C`, a bare `flag` → `flag=` — and a journey drafted from this
  // URL would call a different one.) A segment's name is decoded as
  // searchParams decodes it; the leading `&` keeps the constructor from
  // eating a `?` the name starts with (`??token=…`).
  if (dropped.length) {
    const gone = new Set(dropped);
    const rest = url.search.slice(1).split('&').filter((segment) => {
      const [entry] = new URLSearchParams(`&${segment}`);
      return entry && !gone.has(entry[0]);
    }).join('&');
    url.search = rest ? `?${rest}` : '';
  }
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

// The sentence a route or the studio shows when it dropped something:
// `where` names the place, `of` the URL (the MCP URL unless told
// otherwise) and `hint` the way out — the auth field, which holds for the
// MCP URL alone.
export function droppedNote(dropped, { where = 'not kept in the live pack', of = 'the MCP URL', hint = ' — put a token in the auth field instead' } = {}) {
  if (!dropped?.length) return null;
  const names = dropped.map((n) => `"${n}"`).join(', ');
  return `${where}: the ${names} parameter${dropped.length === 1 ? '' : 's'} of ${of}, which look${dropped.length === 1 ? 's' : ''} like ${dropped.length === 1 ? 'a credential' : 'credentials'}${hint}`;
}

// ---------- the fetch policy: what may be FETCHED, not only persisted ----------
//
// server/mcp-url.mjs's validateMcpUrl() (the SSRF gate every caller-supplied
// mcpUrl passes) is this policy plus the server's stderr note; the MCP client
// (tools/lib/mcp-client.mjs) runs the same policy on the URL a transport hook
// returns, so a hook cannot reach what the caller's URL could not. Pure: the
// posture (`allowLocal`) is an argument, never an env read.

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

// localhost / loopback / private / link-local, by literal host — hostnames
// that RESOLVE to private addresses are not caught (no DNS lookup here); the
// literal-IP check covers hex/decimal/octal IPv4 forms because the WHATWG URL
// parser normalises those to dotted-decimal before this runs.
export function isLocalOrPrivateHost(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (PRIVATE_V4.some(re => re.test(host))) return true;
  // IPv6: loopback/unspecified, unique-local fc00::/7, link-local fe80::/10,
  // and IPv4-mapped forms of any of the above.
  if (host === '::1' || host === '::') return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
  if (host.startsWith('::ffff:')) return isLocalOrPrivateHost(host.slice(7));
  return false;
}

// Every `//user:pass@` / `//token@` occurrence in a text → `//***@`.
export function redactCredentials(text) {
  return String(text).replace(/\/\/[^/\s@]+@/g, '//***@');
}

// { error } when the URL must be refused, else { safeUrl, local }: safeUrl is
// safeMcpUrl(url) (what may be persisted or logged), local says the host is
// local/private (allowed unless `allowLocal` is false — the server reads
// OBSERVOGRAM_ALLOW_LOCAL_MCP=0 into that flag). Texts are the server's own.
export function mcpUrlPolicy(raw, { allowLocal = true } = {}) {
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
  const local = isLocalOrPrivateHost(url.hostname);
  if (local && !allowLocal) {
    return { error: `mcpUrl targets a local/private address (${url.hostname}), which OBSERVOGRAM_ALLOW_LOCAL_MCP=0 forbids` };
  }
  return { safeUrl, local };
}
