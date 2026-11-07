// server/fetch-failure.mjs — a fetch that failed before the host answered, in words.
//
// Node's fetch throws `TypeError: fetch failed` for every failure below HTTP
// and keeps the reason in `cause`: a name that does not resolve, a refused,
// timed-out or dropped connection, a TLS failure — but also a redirect it
// was told not to follow, or a request it would not build. A Run that said
// only "fetch failed" left the person nothing to act on, and "could not be
// reached" is true of the first kind only. unreachable() says which it was.
// Server-only; pure.

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

// unreachable(label, url, error) → the Error to throw in place of fetch's own:
//   not reached   "<label>: <origin> could not be reached from the server — <reason> (<code>)"
//   a redirect    "<label>: <origin> answered with a redirect, which the server does not follow"
//   not sent      "<label>: the request to <origin> was not sent — <what undici said>"
//   anything else "<label>: <origin>: fetch failed — <code or what undici said>"
// `status` stays unset, so the caller answers 502 and asks the person for nothing.
// The original error is kept as `cause`. An error that is not fetch's own
// network failure is returned as it is.
export function unreachable(label, url, error) {
  if (!(error instanceof TypeError) || !/fetch failed/i.test(error.message)) return error;
  let origin = String(url);
  try { origin = new URL(url).origin; } catch { /* keep it */ }
  const cause = error.cause || {};
  const codes = codesOf(cause);
  const said = typeof cause.message === 'string' ? cause.message.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
  const named = codes.find((c) => networkReason(c));
  let text;
  if (named) text = `${origin} could not be reached from the server — ${networkReason(named)} (${named})`;
  else if (/redirect/i.test(said)) text = `${origin} answered with a redirect, which the server does not follow (${said})`;
  else if (codes.some((c) => NOT_SENT.has(c))) text = `the request to ${origin} was not sent — ${said || codes.join(', ')}`;
  else text = `${origin}: fetch failed — ${codes[0] || said || 'no reason given'}`;
  return new Error(`${label}: ${text}`, { cause: error });
}
