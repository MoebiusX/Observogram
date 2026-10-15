#!/usr/bin/env node
/**
 * tools/emit-manifest.mjs — `packc emit --exporter <url>`: a prebuilt
 * exporter's metrics manifest, read off its live /metrics endpoint.
 *
 * A repository that ships a prebuilt exporter (a Dockerfile and a config
 * file) names none of the exporter's metrics; the crawler reads them from a
 * `metrics-manifest.json` beside the config (tools/lib/exporter-metrics.mjs).
 * This writes one: it scrapes the endpoint once and records each metric
 * family's name, type, help and label names — never a label value, never a
 * sample. Run it in the exporter's build pipeline against the image it just
 * built and commit (or publish) the result.
 *
 *   node tools/emit-manifest.mjs --exporter <url> [--name <exporter>] [--version <v>] [--out <file>|-]
 *   node tools/emit-manifest.mjs --from <file.prom> [--name <exporter>] [--version <v>] [--out <file>|-]
 *     --exporter      the exporter's metrics URL (http or https), e.g. http://mq-exporter:9157/metrics
 *     --from          read a saved exposition instead (one the scrape needs credentials for: save it
 *                     with your own client, then pass it here)
 *     --name          the exporter's name in the manifest (default: the URL's host, or the file's name)
 *     --version       the exporter's version, recorded as given
 *     --out           where to write (default: metrics-manifest.json); `-` writes to stdout
 *     --generated-at  the stamp (default: the clock); --no-timestamp leaves it out (reproducible bytes)
 *     --timeout       the scrape timeout in seconds (default 15)
 *
 *   exit 0  the manifest was written
 *   exit 1  the scrape failed: unreachable, a redirect, a status other than 200, no metric families
 *   exit 2  usage: no source, both sources, an unknown flag, a URL that is not http(s) or carries credentials
 *
 * The recorded `source` is the URL without userinfo, query or fragment
 * (tools/lib/exporter-metrics.mjs safeSourceUrl). A redirect is refused, not
 * followed: the refusal names its target, the query as `key=value` keys only — pass that
 * URL with the values the exporter expects.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { manifestFromExposition, safeSourceUrl } from './lib/exporter-metrics.mjs';

// A URL as a message may name it: safeSourceUrl's form, or a stand-in when
// that leaves nothing (the URL is then not shown at all).
const shown = (url) => safeSourceUrl(url) || 'the exporter URL (not shown)';

// A value that may be a URL with its credentials or token: never echoed.
const urlLike = (v) => /:\/\/|@|\?|^[^/\\\s]+:\d+(?:[/?#]|$)/.test(String(v ?? ''));
// A path argument as a message may name it.
const showArg = (v) => (urlLike(v) ? '(a URL-like value, not shown)' : v);

const USAGE = 'usage: packc emit --exporter <url> | --from <file.prom> [--name <exporter>] [--version <v>] [--out <file>|-] [--generated-at <iso> | --no-timestamp] [--timeout <seconds>]';

function fail(code, message) {
  process.stderr.write(`packc emit: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { out: 'metrics-manifest.json', timeout: 15, timestamp: true };
  const takes = new Set(['--exporter', '--from', '--name', '--version', '--out', '--generated-at', '--timeout']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--no-timestamp') { out.timestamp = false; continue; }
    // `--flag=value` as well as `--flag value`.
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    let inline;
    if (eq > 0) { inline = a.slice(eq + 1); a = a.slice(0, eq); }
    // An unknown argument may be a URL with its credentials: never echoed.
    if (!takes.has(a)) fail(2, `unknown argument ${urlLike(a) ? '(a URL-like value, not shown)' : `'${a}'`}\n${USAGE}`);
    if (inline !== undefined) { out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = inline; continue; }
    const v = argv[++i];
    if (v === undefined || (v.startsWith('--') && v !== '-')) fail(2, `${a} needs a value\n${USAGE}`);
    out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

// A redirect is named, never followed: its target without userinfo, and its
// query as the keys of `key=value` parts only (`?format=…`; a bare `?<x>` is
// a value) — a value may be a token — so the URL to
// pass is the one shown with the values the exporter expects.
function redirectRefusal(url, status, location) {
  let target = null;
  try { target = location ? new URL(location, url) : null; } catch { /* not a URL: named as such */ }
  // Keys of `key=value` parts only: a bare `?<token>` is a value, not a key.
  const parts = target?.search ? target.search.slice(1).split('&').filter(Boolean) : [];
  const keys = [...new Set(parts.filter(p => p.includes('=')).map(p => p.slice(0, p.indexOf('='))))];
  const bare = parts.some(p => !p.includes('='));
  const query = !parts.length ? ''
    : `${keys.length ? `?${keys.map(k => `${k}=…`).join('&')}` : ''}${bare ? `${keys.length ? ' and' : ' with'} a query part` : ''} (query values not shown)`;
  const to = !location ? ''
    : !target ? ' to a location that is not a URL'
      : ` to ${shown(target.href)}${query}`;
  return `${shown(url)} answered ${status}, a redirect${to}; it is not followed — pass the URL the exporter serves its metrics at${parts.length ? ', with the query values it expects' : ''}`;
}

async function scrape(url, timeoutSeconds) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'text/plain;version=0.0.4;q=1, application/openmetrics-text;q=0.5, */*;q=0.1' },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? `no answer within ${timeoutSeconds}s (raise --timeout)` : (e?.cause?.message || e?.message || String(e));
    fail(1, `could not scrape ${shown(url)}: ${why}`);
  }
  if (res.status >= 300 && res.status < 400) fail(1, redirectRefusal(url, res.status, res.headers.get('location')));
  if (res.status !== 200) fail(1, `${shown(url)} answered ${res.status}; a metrics endpoint answers 200`);
  try {
    return await res.text();
  } catch (e) {
    fail(1, `could not read the response of ${shown(url)}: ${e?.name === 'TimeoutError' ? `not complete within ${timeoutSeconds}s (raise --timeout)` : 'the connection ended before the body did'}`);
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
if (!args.exporter && !args.from) fail(2, `name the exporter's metrics URL (--exporter) or a saved exposition (--from)\n${USAGE}`);
if (args.exporter && args.from) fail(2, 'pass --exporter or --from, not both');
const timeout = Number(args.timeout);
if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600) fail(2, '--timeout is a number of seconds, 1 to 600');
let generatedAt;
if (args.timestamp) {
  const at = args.generatedAt === undefined ? new Date() : new Date(args.generatedAt);
  if (Number.isNaN(at.getTime())) fail(2, `--generated-at ${urlLike(args.generatedAt) ? '(a URL-like value, not shown)' : `'${args.generatedAt}'`} is not a date`);
  generatedAt = at.toISOString();
} else if (args.generatedAt !== undefined) fail(2, 'pass --generated-at or --no-timestamp, not both');

let text, source, defaultName;
if (args.exporter) {
  let url;
  try { url = new URL(args.exporter); } catch { fail(2, `--exporter '${shown(args.exporter)}' is not a URL (e.g. http://mq-exporter:9157/metrics); shown without anything before an @ or after a ? or #`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail(2, `--exporter must be an http or https URL, not ${url.protocol}`);
  if (url.username || url.password) fail(2, 'the --exporter URL carries credentials, which are neither sent nor recorded; save the exposition with your own client and pass it with --from');
  text = await scrape(url.href, timeout);
  source = url.href;
  defaultName = url.hostname;
} else {
  // A file whose name holds `@` or `?` is read; a URL-like value that is not
  // a file is refused unshown.
  if (urlLike(args.from) && !existsSync(resolve(args.from))) fail(2, '--from takes a saved exposition file, not a URL (the value is not shown); scrape a URL with --exporter');
  try { text = readFileSync(resolve(args.from), 'utf8'); } catch (e) { fail(2, `cannot read --from ${showArg(args.from)}: ${e.code || 'read failed'}`); }
  defaultName = basename(args.from).replace(/\.[^.]+$/, '');
}

const name = String(args.name ?? defaultName ?? '').trim();
if (!name) fail(2, 'the exporter has no name; pass --name');
const manifest = manifestFromExposition(text, { exporter: name, version: args.version, source, generatedAt });
if (!manifest.metrics.length) fail(1, `${source ? shown(source) : showArg(args.from)} holds no metric family (no # TYPE, # HELP or sample line)`);

const json = `${JSON.stringify(manifest, null, 2)}\n`;
if (args.out === '-') {
  process.stdout.write(json, () => process.exit(0));
} else {
  try { writeFileSync(resolve(args.out), json); }
  catch (e) { fail(2, `cannot write --out ${showArg(args.out)}: ${e.code || 'write failed'}`); }
  process.stdout.write(`wrote ${showArg(args.out)}: ${manifest.metrics.length} metric famil${manifest.metrics.length === 1 ? 'y' : 'ies'} of ${name}\n`, () => process.exit(0));
}
