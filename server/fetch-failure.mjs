// server/fetch-failure.mjs — a fetch that failed before the host answered, in words.
//
// Node's fetch throws `TypeError: fetch failed` for every failure below HTTP
// and keeps the reason in `cause`: a name that does not resolve, a refused,
// timed-out or dropped connection, a TLS failure — but also a redirect it
// was told not to follow, or a request it would not build. A Run that said
// only "fetch failed" left the person nothing to act on, and "could not be
// reached" is true of the first kind only. unreachable() says which it was,
// and whether the request went through the server's proxy
// (server/outbound-proxy.mjs): through one, the server's connection is to
// the proxy, which then fails or refuses to open the way to the host.
// Server-only; pure but for the default route, read from this process's
// environment.

import { outboundRoute } from './outbound-proxy.mjs';

// The codes that mean the host was not reached, in words.
const NETWORK = Object.freeze({
  ENOTFOUND: 'its name does not resolve on the server',
  EAI_AGAIN: 'its name does not resolve on the server (the lookup timed out)',
  ECONNREFUSED: 'the connection was refused',
  ETIMEDOUT: 'the connection timed out',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
  ECONNRESET: 'the connection was dropped',
  UND_ERR_SOCKET: 'the connection was dropped',
  ENETUNREACH: 'the network is unreachable from the server',
  EHOSTUNREACH: 'the host is unreachable from the server',
});
// The TLS codes where the server does not trust the certificate's issuer:
// the one case an extra certificate authority (NODE_EXTRA_CA_CERTS) fixes.
const UNTRUSTED_ISSUER = new Set(['UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT']);
// Codes for a request the server would not send: nothing left the machine.
const NOT_SENT = new Set(['UND_ERR_INVALID_ARG', 'UND_ERR_NOT_SUPPORTED', 'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE']);

// Why the host was not reached, for one code, or '' when the code is no network failure.
function networkReason(code) {
  if (NETWORK[code]) return NETWORK[code];
  if (UNTRUSTED_ISSUER.has(code)) return 'its certificate is not one the server trusts (if a proxy re-signs the traffic, give the server its certificate authority with NODE_EXTRA_CA_CERTS)';
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') return 'its certificate has expired or is not yet valid';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'HOSTNAME_MISMATCH') return 'its certificate does not name this host (something else answered, or the address uses a name the certificate is not for)';
  if (/^(?:ERR_SSL_|ERR_TLS_|CERT_)/.test(code)) return 'the TLS handshake failed (is it https on that port?)';
  return '';
}

// The codes a cause carries: its own, and, for a host with several addresses
// (Node tries IPv6 and IPv4 and rejects with an AggregateError), each
// attempt's, the last attempt first.
function codesOf(cause) {
  const codes = [];
  if (Array.isArray(cause?.errors)) for (const e of [...cause.errors].reverse()) if (typeof e?.code === 'string') codes.push(e.code);
  if (typeof cause?.code === 'string') codes.push(cause.code);
  return [...new Set(codes)];
}

// The codes that mean no way to the host was found from here: a name that does
// not resolve, a connection that times out, a network or host with no route.
// Where egress is through a proxy, these are what a direct request meets.
const NO_ROUTE = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

// Through a proxy, a connection that fails below HTTP is the server's to the
// proxy itself (undici tunnels every request, and the proxy looks the host
// up): these codes mean the proxy was not reached. One exception: the TLS
// handshake with the host runs inside the open tunnel under the same connect
// timeout, and undici's timeout then names the host's address, not the
// proxy's. A dropped connection or a TLS failure can be the proxy's or the
// host's, so those name the host, through the proxy.
const PROXY_NOT_REACHED = new Set([...NO_ROUTE, 'ECONNREFUSED']);

// How long one read of a repository host may take, answer and body, before
// it is given up (AbortSignal.timeout on the readers' fetch). Without it, a
// proxy that closes a CONNECT without answering keeps undici reconnecting
// and the Run never answers.
export const READ_TIMEOUT_MS = 60_000;

// The status a proxy answered a CONNECT with, when it would not open the way
// to the host. undici words it "Proxy response (407) !== 200 when HTTP
// Tunneling", an UND_ERR_ABORTED one or two causes down (6.21–6.29).
function proxyAnswer(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    const m = /Proxy response \((\d{3})\) !== 200/.exec(typeof e.message === 'string' ? e.message : '');
    if (m) return Number(m[1]);
  }
  return null;
}

// What a proxy's status means for this host, in words. A 407 says what the
// proxy URL already carries: undici signs in with Basic, and only with both
// a user name and a password.
function proxyStatusText(status, host, route) {
  if (status === 407) {
    if (route.credentials === 'both') return `the proxy refused the user name and password in ${route.variable} (407), or it asks for a sign-in other than Basic, such as NTLM or Kerberos, which Node's fetch cannot give`;
    if (route.credentials === 'user') return `the proxy asks for a user name and password (407): ${route.variable} has a user name but no password, and neither is sent without the other`;
    return 'the proxy asks for a user name and password (407): give them in the proxy URL, http://user:password@host:port, percent-encoded';
  }
  if (status === 403) return `the proxy does not allow it (403): ask for ${host} to be allowed through it`;
  if (status === 502 || status === 503 || status === 504) return `the proxy could not reach it (${status}): if ${host} is inside your network, add it to NO_PROXY`;
  return `the proxy answered ${status} instead of opening the connection`;
}

// The hint a host not reached directly carries, by how the request left (route).
function directHint(route, host) {
  if (route.why === 'none') return 'if this server reaches it through a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1';
  if (route.why === 'not-switched') return `${route.variable} is set, but the server sends its requests directly: set NODE_USE_ENV_PROXY=1 too, or start it with node server/launch.mjs`;
  if (route.why === 'opted-out') return `${route.variable} is set, but the switch is off (NODE_USE_ENV_PROXY is not 1), so the server sends its requests directly`;
  if (route.why === 'old-node') return `${route.variable} is set, but this Node (${route.version}) sends its requests directly: Node 22.21 or later reads it, with NODE_USE_ENV_PROXY=1`;
  if (route.why === 'no-proxy') return `${route.noProxyName} sends ${host} directly, not through the proxy ${route.proxy}`;
  if (route.why === 'not-a-url') return `${route.variable} is not a proxy URL Node can use (http://host:port with no path, a user name and password percent-encoded), so the server sends its requests directly`;
  return '';
}

// unreachable(label, url, error, { route }) → the Error to throw in place of fetch's own:
//   not reached   "<label>: <origin> could not be reached from the server — <reason> (<code>)"
//                 and, for a code with no route (NO_ROUTE), "; <how a proxy would be set>"
//   the proxy     "<label>: the proxy <proxy> could not be reached from the server — <reason> (<code>)"
//   refused by it "<label>: <origin> could not be reached through the proxy <proxy> — <what its status means>"
//   through it    "<label>: <origin> could not be reached through the proxy <proxy> — <reason> (<code>)"
//   too long      "<label>: <origin> did not answer within 60 s[ through the proxy <proxy>]"
//   a redirect    "<label>: <origin> answered with a redirect, which the server does not follow"
//   not sent      "<label>: the request to <origin> was not sent — <what undici said>"
//   anything else "<label>: <origin>: fetch failed — <code or what undici said>"
// `route` is how the request left the server (outboundRoute): by default, as
// this process's environment sends it. `status` stays unset, so the caller
// answers 502 and asks the person for nothing. The original error is kept as
// `cause`. An error that is neither fetch's own network failure nor the
// readers' deadline (a TimeoutError) is returned as it is.
export function unreachable(label, url, error, { route = outboundRoute(url) } = {}) {
  let origin = String(url);
  let host = origin;
  let port = '';
  try { const u = new URL(url); origin = u.origin; host = u.hostname; port = u.port || (u.protocol === 'http:' ? '80' : '443'); } catch { /* keep it */ }
  const proxy = route?.through || null;
  if (error?.name === 'TimeoutError') {
    return new Error(`${label}: ${origin} did not answer within ${Math.round(READ_TIMEOUT_MS / 1000)} s${proxy ? ` through the proxy ${proxy}` : ''}`, { cause: error });
  }
  if (!(error instanceof TypeError) || !/fetch failed/i.test(error.message)) return error;
  const cause = error.cause || {};
  const codes = codesOf(cause);
  const said = typeof cause.message === 'string' ? cause.message.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  const named = codes.find((c) => networkReason(c));
  const answered = proxy ? proxyAnswer(cause) : null;
  // A connect timeout that names the host's address: the tunnel was open, its TLS handshake was not.
  const hostTimedOut = named === 'UND_ERR_CONNECT_TIMEOUT' && typeof cause.message === 'string' && cause.message.includes(`${host}:${port}`);
  let text;
  if (answered) text = `${origin} could not be reached through the proxy ${proxy} — ${proxyStatusText(answered, host, route)}`;
  else if (proxy && hostTimedOut) text = `${origin} could not be reached through the proxy ${proxy} — the proxy opened the connection, but the TLS handshake with ${host} timed out (${named})`;
  else if (proxy && named && PROXY_NOT_REACHED.has(named)) text = `the proxy ${proxy} could not be reached from the server — ${networkReason(named)} (${named})`;
  else if (proxy && named) text = `${origin} could not be reached through the proxy ${proxy} — ${networkReason(named)} (${named})`;
  else if (named) {
    const hint = NO_ROUTE.has(named) && route ? directHint(route, host) : '';
    text = `${origin} could not be reached from the server — ${networkReason(named)} (${named})${hint ? `; ${hint}` : ''}`;
  } else if (/redirect/i.test(said)) text = `${origin} answered with a redirect, which the server does not follow (${said})`;
  else if (codes.some((c) => NOT_SENT.has(c))) text = `the request to ${origin} was not sent — ${said || codes.join(', ')}`;
  else text = `${origin}: fetch failed — ${codes[0] || said || 'no reason given'}`;
  return new Error(`${label}: ${text}`, { cause: error });
}
