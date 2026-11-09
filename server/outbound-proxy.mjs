// server/outbound-proxy.mjs — the proxy the server's own requests go through.
//
// A server whose egress is through an HTTP proxy reaches Azure DevOps,
// GitHub and the sign-in hosts through it, configured as Grafana's is:
// HTTPS_PROXY, HTTP_PROXY and NO_PROXY in the environment. Node's fetch reads
// them only when the process starts with NODE_USE_ENV_PROXY=1 (or
// --use-env-proxy), from Node 22.21 / 24.0. The image starts the server
// through server/launch.mjs, which turns that switch on when a proxy variable
// is set and every one set is a URL Node can use (launchPlan below): Node
// builds its proxy agent before any of the server's code runs and stops the
// start, printing the value whole, on one it cannot parse.
//
// Node then sends every fetch through undici's EnvHttpProxyAgent. This module
// mirrors that agent's choice, so that the start can say which proxy is in
// use and a failed read can say whether it went through it:
//   - the lower-case name wins over the upper-case one (http_proxy, HTTP_PROXY);
//   - an https request takes HTTPS_PROXY, else HTTP_PROXY; an http one HTTP_PROXY;
//   - NO_PROXY is a comma- or space-separated list of host, host:port, .suffix,
//     *.suffix, or * for every host. A bare name matches that name only, and
//     it takes no IP ranges and no CIDR.
// A proxy is only ever shown as scheme://host:port, never its user name or
// password. Server-only; reads only the environment it is given.

const DEFAULT_PORTS = Object.freeze({ 'http:': 80, 'https:': 443 });

// The Node that reads the proxy variables for fetch: 22.21 on the 22 line, 24.0 after it.
export const PROXY_NODE = '22.21';

// The variables, as Node's fetch reads them, with the name each came from.
// (Windows reads a name in any case, so the name shown is the spelling the
// environment holds.)
export function proxySettings(env = process.env) {
  const keys = Object.keys(env);
  const spelt = (lower, upper) => keys.find((k) => k === lower) || keys.find((k) => k === upper) || keys.find((k) => k.toLowerCase() === lower) || upper;
  const pick = (lower, upper) => ({ value: env[lower] !== undefined ? env[lower] : env[upper], name: spelt(lower, upper) });
  const http = pick('http_proxy', 'HTTP_PROXY');
  const https = pick('https_proxy', 'HTTPS_PROXY');
  const no = pick('no_proxy', 'NO_PROXY');
  return {
    http: http.value ? { raw: String(http.value), name: http.name } : null,
    https: https.value ? { raw: String(https.value), name: https.name } : null,
    noProxy: no.value ? String(no.value) : '',
    noProxyName: no.name,
  };
}

// Whether this Node sends fetch through those variables: a Node that can
// (`supported`), started with the switch (`switched`), or turned off on
// purpose (`optedOut`). Node 22.21+ and 24.5+ read NODE_USE_ENV_PROXY=1, then
// --use-env-proxy / --no-use-env-proxy in NODE_OPTIONS, then on the command
// line, the last one winning; 24.0–24.4 take any non-empty NODE_USE_ENV_PROXY
// and have no flag.
export function proxyHonoured({ env = process.env, execArgv = process.execArgv, version = process.versions.node } = {}) {
  const v = String(version).replace(/^v/, '');
  const [major, minor] = v.split('.').map(Number);
  const supported = major >= 24 || (major === 22 && minor >= 21);
  const early = major === 24 && minor < 5;
  const value = env.NODE_USE_ENV_PROXY;
  let switched = early ? !!value : value === '1';
  let flagOff = false;
  if (!early) {
    for (const f of [...String(env.NODE_OPTIONS || '').split(/\s+/), ...execArgv]) {
      if (f === '--use-env-proxy') { switched = true; flagOff = false; } else if (f === '--no-use-env-proxy') { switched = false; flagOff = true; }
    }
  }
  const optedOut = !switched && (flagOff || (!!value && value !== '1'));
  return { supported, switched, honoured: supported && switched, optedOut, version: `v${v}` };
}

// A proxy URL as it may be shown: scheme://host:port, and what it carries
// to sign in: 'both' (a user name and a password, sent as Basic), 'user' (a
// user name alone, which undici does not send), or null. null when it is no
// http(s) URL.
export function showProxy(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const credentials = u.username && u.password ? 'both' : (u.username || u.password) ? 'user' : null;
  return { shown: `${u.protocol}//${u.hostname}:${u.port || DEFAULT_PORTS[u.protocol]}`, credentials };
}

// Whether undici's ProxyAgent takes this value: an http(s) URL with no path,
// query or fragment, whose user name and password decode. Anything else
// stops a Node started with the switch, before the server runs.
export function usableProxy(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.pathname !== '/' || u.search || u.hash) return false;
  try { decodeURIComponent(u.username); decodeURIComponent(u.password); } catch { return false; }
  return true;
}

// NO_PROXY's entries, split and read as undici reads them.
export function noProxyEntries(value) {
  return String(value || '').split(/[,\s]/).filter(Boolean).map((entry) => {
    const m = /^(.+):(\d+)$/.exec(entry);
    return { hostname: (m ? m[1] : entry).toLowerCase(), port: m ? Number.parseInt(m[2], 10) : 0 };
  });
}

// Whether NO_PROXY sends a request to `target` (a URL) directly.
export function bypassesProxy(target, noProxy) {
  const entries = noProxyEntries(noProxy);
  if (entries.length === 0) return false;
  if (String(noProxy) === '*') return true;
  // The port stripped from host, not hostname, so an IPv6 address keeps its brackets.
  const host = target.host.replace(/:\d*$/, '').toLowerCase();
  const port = Number.parseInt(target.port, 10) || DEFAULT_PORTS[target.protocol] || 0;
  for (const e of entries) {
    if (e.port && e.port !== port) continue;
    if (!/^[.*]/.test(e.hostname)) { if (host === e.hostname) return true; }
    else if (host.endsWith(e.hostname.replace(/^\*/, ''))) return true;
  }
  return false;
}

// How a request to `url` leaves the server:
//   { through: 'http://h:p', variable, credentials }          through that proxy
//   { through: null, why: 'none' }                            no proxy variable applies
//   { through: null, why: 'not-a-url', variable }             the variable is no proxy URL Node can use
//   { through: null, why: 'no-proxy', variable, proxy, noProxyName }  NO_PROXY sends it directly
//   { through: null, why: 'not-switched' | 'opted-out' | 'old-node', variable, proxy, version }
//                                                             one is set, but this Node sends it directly
export function outboundRoute(url, { env = process.env, execArgv = process.execArgv, version = process.versions.node } = {}) {
  let target;
  try { target = new URL(url); } catch { return { through: null, why: 'none' }; }
  const s = proxySettings(env);
  const chosen = target.protocol === 'https:' ? (s.https || s.http) : target.protocol === 'http:' ? s.http : null;
  if (!chosen) return { through: null, why: 'none' };
  if (!usableProxy(chosen.raw)) return { through: null, why: 'not-a-url', variable: chosen.name };
  const proxy = showProxy(chosen.raw);
  if (bypassesProxy(target, s.noProxy)) return { through: null, why: 'no-proxy', variable: chosen.name, proxy: proxy.shown, noProxyName: s.noProxyName };
  const node = proxyHonoured({ env, execArgv, version });
  if (!node.honoured) return { through: null, why: !node.supported ? 'old-node' : node.optedOut ? 'opted-out' : 'not-switched', variable: chosen.name, proxy: proxy.shown, version: node.version };
  return { through: proxy.shown, variable: chosen.name, credentials: proxy.credentials };
}

// The environment server/launch.mjs starts the server with: NODE_USE_ENV_PROXY=1
// added when a proxy variable is set, this Node reads it, it was not turned
// off on purpose, and every proxy variable set is a URL Node can use. On a
// value it cannot use the switch stays off, so the start goes on and says
// which variable to fix instead of stopping on it. (A switch already in the
// environment applies to the launcher's own Node too: with an unusable value
// that Node stops before the launcher runs, which is why the image does not
// set it.)
export function launchPlan({ env = process.env, execArgv = process.execArgv, version = process.versions.node } = {}) {
  const s = proxySettings(env);
  const set = [s.https, s.http].filter(Boolean);
  const out = { ...env };
  if (set.length === 0 || set.some((v) => !usableProxy(v.raw))) return { env: out, switched: false };
  const node = proxyHonoured({ env, execArgv, version });
  if (!node.supported || node.optedOut) return { env: out, switched: false };
  out.NODE_USE_ENV_PROXY = '1';
  return { env: out, switched: true };
}

// What the start says about the proxy, printed beside "listening on" so that
// whoever set one sees at once whether it took effect: `log` names the proxy
// in use, or says there is none; `warn` says why a variable that is set is
// not used, and names any NO_PROXY address range fetch will not read.
// Hosts and ports only, never a user name or password.
export function proxyBootReport({ env = process.env, execArgv = process.execArgv, version = process.versions.node } = {}) {
  const s = proxySettings(env);
  const set = [s.https, s.http].filter(Boolean);
  const out = { log: [], warn: [] };
  if (set.length === 0) {
    out.log.push('[studio] outbound proxy: none, every request goes directly (no HTTPS_PROXY or HTTP_PROXY is set)');
    return out;
  }
  const node = proxyHonoured({ env, execArgv, version });
  const bad = set.filter((v) => !usableProxy(v.raw));
  for (const v of bad) {
    out.warn.push(`[studio] WARNING: ${v.name} is not a proxy URL Node can use, so the server sends every request directly. It must be http://host:port or https://host:port with no path, and a user name or password with any of # / ? @ : % in it percent-encoded (# as %23, @ as %40)`);
  }
  if (bad.length && !node.honoured) return out;
  const names = set.map((v) => v.name).join(' and ');
  const are = set.length > 1 ? 'are' : 'is';
  if (!node.supported) {
    out.warn.push(`[studio] WARNING: ${names} ${are} set, but this Node (${node.version}) sends every request directly: Node ${PROXY_NODE} or later reads ${set.length > 1 ? 'them' : 'it'}, with NODE_USE_ENV_PROXY=1`);
    return out;
  }
  if (node.optedOut) {
    out.log.push(`[studio] outbound proxy: none, every request goes directly (${names} ${are} set, and the switch is off: ${env.NODE_USE_ENV_PROXY ? `NODE_USE_ENV_PROXY=${env.NODE_USE_ENV_PROXY}` : '--no-use-env-proxy'})`);
    return out;
  }
  if (!node.switched) {
    out.warn.push(`[studio] WARNING: ${names} ${are} set, but the server sends every request directly: Node reads ${set.length > 1 ? 'them' : 'it'} only with NODE_USE_ENV_PROXY=1 — set it too, or start the server with node server/launch.mjs`);
    return out;
  }
  const parts = [];
  for (const v of set.filter((x) => usableProxy(x.raw))) {
    const p = showProxy(v.raw);
    const scope = v === s.https ? 'https' : (s.https ? 'http' : 'http and https');
    const signIn = p.credentials === 'both' ? ', with a user name and password' : p.credentials === 'user' ? ', with a user name but no password, so it signs in with neither' : '';
    parts.push(`${scope} requests through ${p.shown}${signIn} (${v.name})`);
  }
  const direct = noProxyEntries(s.noProxy);
  const noProxy = s.noProxy.trim() === '*' ? `${s.noProxyName} is *: every request goes directly`
    : direct.length ? `directly to the hosts ${s.noProxyName} names: ${direct.map((e) => (e.port ? `${e.hostname}:${e.port}` : e.hostname)).join(', ')}`
      : s.http ? 'NO_PROXY is not set: every request goes through the proxy, the MCP endpoints too'
        : 'NO_PROXY is not set: every https request goes through the proxy, https MCP endpoints too (http ones go directly)';
  out.log.push(`[studio] outbound proxy: ${parts.join(', ')}; ${noProxy}`);
  const ranges = addressRanges(s.noProxy);
  if (ranges.length) out.warn.push(`[studio] WARNING: ${s.noProxyName} names ${ranges.join(' and ')} as ${ranges.length > 1 ? 'address ranges' : 'an address range'}, which Node's fetch does not read: requests to those addresses go through the proxy. List the hosts or addresses one by one`);
  return out;
}

// NO_PROXY entries written as address ranges (CIDR, as Docker's own example
// has, or a-b): another tool reads them, Node's fetch matches them as names.
export function addressRanges(value) {
  const range = /^[0-9a-f.:[\]]+\/\d{1,3}$|^\d{1,3}(?:\.\d{1,3}){3}-\d{1,3}(?:\.\d{1,3}){3}$/i;
  return String(value || '').split(/[,\s]/).filter((e) => range.test(e));
}
