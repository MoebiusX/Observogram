#!/usr/bin/env node
/**
 * tools/drift-profiles.mjs
 *
 * Registry staleness checker — answers "did a new product/protocol version
 * ship that our profiles don't know about yet?"
 *
 * The profile facts (protocols.mjs / profiles.mjs) are curated by hand: someone
 * has to read a changelog to know that, say, the OTel Collector renamed an
 * exporter. This tool does NOT write those facts. It does the one thing that
 * CAN be automated honestly: it compares the *newest version we've profiled*
 * (`upstream.latestKnown` in the registry) against the *latest upstream
 * release* (GitHub Releases API), and tells you when the registry has fallen
 * behind so you know to go read the changelog.
 *
 * It is resilient by default: with no network (offline / rate-limited) it
 * reports "could not check" and exits 0, so it never blocks a build it can't
 * actually evaluate. Pass --strict to make unreachable upstreams a failure
 * (for a scheduled CI job that SHOULD have network).
 *
 * Usage:
 *   node tools/drift-profiles.mjs            # report; exit 1 only if stale
 *   node tools/drift-profiles.mjs --strict   # also fail when upstream unreachable
 *   node tools/drift-profiles.mjs --json     # machine-readable report
 *   GITHUB_TOKEN=… node tools/drift-profiles.mjs   # higher rate limit
 *
 * Exit codes:
 *   0  registry is current (or could-not-check without --strict)
 *   1  at least one upstream is newer than our newest profiled version
 *   2  --strict and at least one upstream was unreachable
 *
 * Requires Node 18+ (global fetch).
 */

import { listProfiles, listProtocols, parseVersion, compareVersions } from './lib/profiles.mjs';

const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const JSON_OUT = args.has('--json');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

// Collect the distinct upstreams declared across products and protocols. The
// registry is the single source of truth for the repo → latestKnown mapping;
// this tool never hardcodes it.
function collectUpstreams() {
  const byRepo = new Map();
  const add = (origin, upstream) => {
    if (!upstream?.repo) return;
    const cur = byRepo.get(upstream.repo);
    // Keep the HIGHEST latestKnown declared for a repo (grafana products share
    // grafana/grafana); track every origin that references it.
    if (!cur) {
      byRepo.set(upstream.repo, { repo: upstream.repo, latestKnown: upstream.latestKnown, origins: [origin] });
    } else {
      cur.origins.push(origin);
      if (compareVersions(upstream.latestKnown, cur.latestKnown) > 0) cur.latestKnown = upstream.latestKnown;
    }
  };
  for (const p of listProfiles())  if (p.upstream) add(`product:${p.product}`, p.upstream);
  for (const p of listProtocols()) if (p.upstream) add(`protocol:${p.id}`, p.upstream);
  return [...byRepo.values()];
}

// Strip a release tag down to a version: "v0.96.0" → "0.96.0", "2.55.1" stays.
// Skip pre-releases / RCs so we compare against stable lines only.
function tagToVersion(tag) {
  if (!tag) return null;
  if (/(-rc|-beta|-alpha|rc\.|beta\.|alpha\.)/i.test(tag)) return null;
  const v = parseVersion(tag);
  return v ? v : null;
}

async function latestRelease(repo) {
  const headers = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'observogram-drift-profiles' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

  // Prefer /releases/latest; fall back to /tags for repos that don't mark a
  // "latest" release. Both are best-effort.
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    if (r.ok) {
      const j = await r.json();
      const v = tagToVersion(j.tag_name || j.name);
      if (v) return { version: v, tag: j.tag_name || j.name, source: 'releases/latest' };
    }
    // Fall through to tags for 404 (no releases) or unusable tag.
    const rt = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=30`, { headers });
    if (rt.ok) {
      const tags = await rt.json();
      let best = null, bestTag = null;
      for (const t of tags) {
        const v = tagToVersion(t.name);
        if (v && (!best || compareVersions(v, best) > 0)) { best = v; bestTag = t.name; }
      }
      if (best) return { version: best, tag: bestTag, source: 'tags' };
    }
    return { error: `HTTP ${r.status}` };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

// A new upstream version is "ahead" when its MAJOR.MINOR exceeds our
// latestKnown. We compare on major.minor (ignore patch) because our profiles
// are keyed at that granularity — a patch release rarely changes the contract.
function isAhead(upstreamVer, latestKnown) {
  const known = parseVersion(latestKnown);
  if (!known || !upstreamVer) return false;
  if (upstreamVer[0] !== known[0]) return upstreamVer[0] > known[0];
  return upstreamVer[1] > known[1];
}

async function main() {
  const upstreams = collectUpstreams();
  const results = [];
  for (const u of upstreams) {
    const rel = await latestRelease(u.repo);
    if (rel.error) {
      results.push({ ...u, status: 'unreachable', detail: rel.error });
      continue;
    }
    const ahead = isAhead(rel.version, u.latestKnown);
    results.push({
      ...u,
      status: ahead ? 'stale' : 'current',
      latestUpstream: rel.version.join('.'),
      upstreamTag: rel.tag,
      source: rel.source,
    });
  }

  const stale = results.filter(r => r.status === 'stale');
  const unreachable = results.filter(r => r.status === 'unreachable');

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ results, stale: stale.length, unreachable: unreachable.length }, null, 2) + '\n');
  } else {
    process.stdout.write('\nProfile registry staleness check\n');
    process.stdout.write('────────────────────────────────\n');
    for (const r of results.sort((a, b) => a.repo.localeCompare(b.repo))) {
      if (r.status === 'stale') {
        process.stdout.write(`  ⚠ ${r.repo}: upstream ${r.latestUpstream} > profiled ${r.latestKnown}\n`);
        process.stdout.write(`      referenced by: ${r.origins.join(', ')}\n`);
        process.stdout.write(`      → review the changelog and add a band/protocol version.\n`);
      } else if (r.status === 'unreachable') {
        process.stdout.write(`  · ${r.repo}: could not check (${r.detail})\n`);
      } else {
        process.stdout.write(`  ✓ ${r.repo}: current (profiled ${r.latestKnown}, upstream ${r.latestUpstream})\n`);
      }
    }
    process.stdout.write('\n');
    if (stale.length) process.stdout.write(`${stale.length} registry entr${stale.length === 1 ? 'y is' : 'ies are'} stale.\n`);
    else process.stdout.write('Registry is current with all reachable upstreams.\n');
    if (unreachable.length) process.stdout.write(`${unreachable.length} upstream(s) could not be checked.\n`);
  }

  if (stale.length) process.exit(1);
  if (STRICT && unreachable.length) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`drift-profiles: ${e.message || e}\n`);
  process.exit(STRICT ? 2 : 0);
});
