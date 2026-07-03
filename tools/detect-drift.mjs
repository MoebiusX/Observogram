#!/usr/bin/env node
/**
 * tools/detect-drift.mjs
 *
 * Drift detection across two ObservabilityPack v1.2 snapshots. Built to
 * run in a cron context: after the fetcher refreshes the live pack,
 * call this against the new file and either a second file OR a git
 * rev N hours ago. Emits a structured drift report (markdown by default,
 * --json for piping) and exits with 0 (no drift), 1 (drift detected),
 * or 2 (error).
 *
 * What we consider "drift" — observability-meaningful changes,
 * not whitespace or noisy timestamps:
 *
 *   • backends      — telemetry.backends[] added / removed,
 *                     product / version.declared / version.min /
 *                     version.gating changed
 *   • topology      — services in mcp.servicesDiscovered diff
 *   • discovery     — mcp.discovered.<key> counts moved (dashboards,
 *                     scrape jobs, metric names, rules)
 *   • versions      — mcp.versions.<product> changed (live upgrades)
 *   • capabilities  — skills / backends added or removed in the
 *                     mcp.capabilities.inventory map
 *   • tools         — mcp.toolsExposed diff (MCP server upgraded,
 *                     new skills enabled)
 *   • anomalies     — mcp.activeAnomalies count moved
 *
 * Filtered out as noise: mcp.refreshedAt (always changes),
 * mcp.verified.* (just timestamps), per-version build commit hashes
 * when the version string itself didn't change.
 *
 * Usage:
 *   node tools/detect-drift.mjs packA.yaml packB.yaml
 *   node tools/detect-drift.mjs --since 24h    # HEAD vs HEAD-from-24h-ago
 *   node tools/detect-drift.mjs --since 7d --json --output drift.json
 *   node tools/detect-drift.mjs --pack examples/production-live.pack.yaml --since 1d
 *
 * Flags:
 *   --since <dur|sha>     compare current --pack vs git rev from that ago
 *   --pack <path>         which pack file the --since mode compares
 *                         (default: examples/production-live.pack.yaml)
 *   --json                emit JSON instead of markdown
 *   --output <path>       write to file instead of stdout
 *   --quiet               suppress output when no drift detected
 *
 * Exit:
 *   0 — no drift; safe to no-op the cron downstream
 *   1 — drift detected; cron should fire the notification
 *   2 — error (file missing, parse failure, git rev unknown)
 *
 * Requires Node 18+. No dependencies.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DEFAULT_PACK = 'examples/production-live.pack.yaml';

// ----------------------------------------------------------------
// Arg parsing — tiny, dependency-free.
// ----------------------------------------------------------------
function parseArgs(argv) {
  const out = { positional: [], json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json')        out.json = true;
    else if (a === '--quiet')  out.quiet = true;
    else if (a === '--output') out.output = argv[++i];
    else if (a === '--since')  out.since = argv[++i];
    else if (a === '--pack')   out.pack = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--')) { throw new Error(`unknown flag: ${a}`); }
    else out.positional.push(a);
  }
  return out;
}

const HELP = `usage:
  detect-drift packA.yaml packB.yaml         compare two files
  detect-drift --since 24h [--pack PATH]     HEAD vs git rev from ago
  detect-drift --since <SHA>                 HEAD vs specific revision

flags:
  --pack PATH      pack file used by --since (default ${DEFAULT_PACK})
  --json           JSON output instead of markdown
  --output PATH    write to file
  --quiet          suppress output when no drift

exit codes: 0 no drift · 1 drift detected · 2 error`;

// Map "24h" / "7d" / "30m" / SHA to a git rev that matches an old commit
// touching the pack file. For durations we walk `git log --until=...` and
// take the first commit; for an explicit SHA we use it as-is.
function resolveSinceRev(spec, packPath) {
  if (/^[0-9a-f]{4,40}$/i.test(spec)) return spec;
  const m = /^(\d+)\s*([smhdwM])$/.exec(spec);
  if (!m) throw new Error(`bad --since value: ${spec} (expected 24h | 7d | <sha>)`);
  const n = Number(m[1]);
  const unitMap = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days', w: 'weeks', M: 'months' };
  const until = `${n} ${unitMap[m[2]]} ago`;
  try {
    const sha = execSync(
      `git log -1 --before="${until}" --pretty=format:%H -- "${packPath}"`,
      { cwd: ROOT, encoding: 'utf8' }
    ).trim();
    if (!sha) throw new Error(`no commit touching ${packPath} before ${until}`);
    return sha;
  } catch (e) {
    throw new Error(`git log failed for --since ${spec}: ${e.message}`);
  }
}

function loadGitRevPack(sha, packPath) {
  try {
    const text = execSync(`git show ${sha}:${packPath}`, { cwd: ROOT, encoding: 'utf8' });
    return { text, label: `${packPath}@${sha.slice(0, 8)}` };
  } catch (e) {
    throw new Error(`git show ${sha}:${packPath} failed: ${e.message}`);
  }
}

function loadFilePack(path) {
  const text = readFileSync(resolve(path), 'utf8');
  return { text, label: path };
}

// ----------------------------------------------------------------
// Drift computation — pure functions over two canonical packs.
// ----------------------------------------------------------------

function parsePack(text, label) {
  let canonical;
  try { canonical = parseYaml(text); }
  catch (e) { throw new Error(`parse failed for ${label}: ${e.message}`); }
  if (!canonical || typeof canonical !== 'object') throw new Error(`empty pack: ${label}`);
  return canonical;
}

function annotations(p) { return p?.metadata?.annotations || {}; }
function backends(p)    { return p?.spec?.telemetry?.backends || []; }

// Diff two flat sets of keys. Returns { added, removed, common }.
function setDiff(a, b) {
  const A = new Set(a), B = new Set(b);
  return {
    added:   [...B].filter(x => !A.has(x)),
    removed: [...A].filter(x => !B.has(x)),
    common:  [...A].filter(x => B.has(x)),
  };
}

// Compare a single backend pair (same id) for meaningful changes.
function diffBackend(beA, beB) {
  const changes = [];
  if (beA.product !== beB.product) {
    changes.push({ field: 'product', from: beA.product, to: beB.product });
  }
  const vA = beA.version || {}, vB = beB.version || {};
  if (vA.declared !== vB.declared) {
    changes.push({ field: 'version.declared', from: vA.declared, to: vB.declared });
  }
  if (vA.min !== vB.min) {
    changes.push({ field: 'version.min', from: vA.min, to: vB.min });
  }
  if (vA.gating !== vB.gating) {
    changes.push({ field: 'version.gating', from: vA.gating, to: vB.gating });
  }
  return changes;
}

function computeDrift(packA, packB) {
  const report = {
    backends:    { added: [], removed: [], changed: [] },
    topology:    { added: [], removed: [] },
    discovery:   [],
    versions:    [],
    capabilities:{ skills: { added: [], removed: [] }, backends: { added: [], removed: [] } },
    tools:       { added: [], removed: [] },
    anomalies:   null,
    counts:      { changes: 0 },
  };

  // --- Backends ---
  const beA = backends(packA);
  const beB = backends(packB);
  const beById = (arr) => Object.fromEntries(arr.map(b => [b.id, b]));
  const idsA = beA.map(b => b.id), idsB = beB.map(b => b.id);
  const beDiff = setDiff(idsA, idsB);
  const beAm = beById(beA), beBm = beById(beB);
  for (const id of beDiff.added)   report.backends.added.push({ id, signal: beBm[id]?.signal, product: beBm[id]?.product });
  for (const id of beDiff.removed) report.backends.removed.push({ id, signal: beAm[id]?.signal, product: beAm[id]?.product });
  for (const id of beDiff.common) {
    const cs = diffBackend(beAm[id], beBm[id]);
    if (cs.length) report.backends.changed.push({ id, changes: cs });
  }

  // --- Service topology ---
  const annA = annotations(packA), annB = annotations(packB);
  const csv = (s) => (s || '').split(',').filter(Boolean);
  const svcA = csv(annA['mcp.servicesDiscovered']);
  const svcB = csv(annB['mcp.servicesDiscovered']);
  const svcDiff = setDiff(svcA, svcB);
  report.topology.added   = svcDiff.added;
  report.topology.removed = svcDiff.removed;

  // --- Discovery counts ---
  const discoveryKeys = ['dashboards','scrape_configs','metric_names','recording_rules','alert_rules'];
  for (const k of discoveryKeys) {
    const aV = Number(annA[`mcp.discovered.${k}`] || annA[`mcp.discovered.${k}_count`] || 0);
    const bV = Number(annB[`mcp.discovered.${k}`] || annB[`mcp.discovered.${k}_count`] || 0);
    if (aV !== bV) report.discovery.push({ key: k, from: aV, to: bV, delta: bV - aV });
  }

  // --- Live versions (mcp.versions.<product>) ---
  const versionKeys = new Set([
    ...Object.keys(annA).filter(k => /^mcp\.versions\.[a-z0-9_-]+$/.test(k)),
    ...Object.keys(annB).filter(k => /^mcp\.versions\.[a-z0-9_-]+$/.test(k)),
  ]);
  for (const k of versionKeys) {
    const aV = annA[k], bV = annB[k];
    if (aV !== bV) {
      const product = k.replace(/^mcp\.versions\./, '');
      report.versions.push({ product, from: aV ?? null, to: bV ?? null });
    }
  }

  // --- Capability inventory ---
  // Stored as pipe-delimited rows skill:backend:product:must-csv. Treat
  // each `skill:backend` pair as the identity (versions are tracked
  // separately under mcp.versions.*).
  const parseInv = (raw) => {
    const set = new Set();
    const skills = new Set();
    (raw || '').split('|').filter(Boolean).forEach(row => {
      const [skill, backend] = row.split(':');
      if (skill) skills.add(skill);
      if (skill && backend) set.add(`${skill}:${backend}`);
    });
    return { skills: [...skills], backends: [...set] };
  };
  const invA = parseInv(annA['mcp.capabilities.inventory']);
  const invB = parseInv(annB['mcp.capabilities.inventory']);
  const skDiff = setDiff(invA.skills, invB.skills);
  const beInvDiff = setDiff(invA.backends, invB.backends);
  report.capabilities.skills.added   = skDiff.added;
  report.capabilities.skills.removed = skDiff.removed;
  report.capabilities.backends.added   = beInvDiff.added;
  report.capabilities.backends.removed = beInvDiff.removed;

  // --- Tool surface ---
  const toolsA = csv(annA['mcp.toolsExposed']);
  const toolsB = csv(annB['mcp.toolsExposed']);
  const toolDiff = setDiff(toolsA, toolsB);
  report.tools.added   = toolDiff.added;
  report.tools.removed = toolDiff.removed;

  // --- Active anomalies ---
  const anomA = Number(annA['mcp.activeAnomalies'] || 0);
  const anomB = Number(annB['mcp.activeAnomalies'] || 0);
  if (anomA !== anomB) {
    report.anomalies = { from: anomA, to: anomB, delta: anomB - anomA };
  }

  // Tally of changes for the exit-code decision.
  report.counts.changes =
    report.backends.added.length +
    report.backends.removed.length +
    report.backends.changed.length +
    report.topology.added.length +
    report.topology.removed.length +
    report.discovery.length +
    report.versions.length +
    report.capabilities.skills.added.length +
    report.capabilities.skills.removed.length +
    report.capabilities.backends.added.length +
    report.capabilities.backends.removed.length +
    report.tools.added.length +
    report.tools.removed.length +
    (report.anomalies ? 1 : 0);

  return report;
}

// ----------------------------------------------------------------
// Renderers
// ----------------------------------------------------------------

function renderMarkdown(report, labels) {
  const lines = [];
  lines.push(`# Observogram drift report`);
  lines.push('');
  lines.push(`Comparing **${labels.b}** against **${labels.a}**.`);
  lines.push('');
  if (report.counts.changes === 0) {
    lines.push(`✅ **No drift detected.** ${labels.b} matches ${labels.a} across every tracked dimension.`);
    return lines.join('\n') + '\n';
  }
  lines.push(`⚠️ **${report.counts.changes} change${report.counts.changes === 1 ? '' : 's'} detected.**`);
  lines.push('');

  const section = (head) => { lines.push(`## ${head}`); lines.push(''); };
  const bullet = (s) => lines.push(`- ${s}`);
  const code = (s) => '`' + s + '`';

  // Backends
  if (report.backends.added.length || report.backends.removed.length || report.backends.changed.length) {
    section('Backends');
    for (const b of report.backends.added)   bullet(`➕ added ${code(b.id)} · signal=${b.signal} · product=${b.product}`);
    for (const b of report.backends.removed) bullet(`➖ removed ${code(b.id)} · signal=${b.signal} · product=${b.product}`);
    for (const b of report.backends.changed) {
      bullet(`✏️ ${code(b.id)}`);
      for (const c of b.changes) lines.push(`    - ${c.field}: ${code(String(c.from))} → ${code(String(c.to))}`);
    }
    lines.push('');
  }

  // Topology
  if (report.topology.added.length || report.topology.removed.length) {
    section('Service topology');
    for (const s of report.topology.added)   bullet(`➕ new service ${code(s)}`);
    for (const s of report.topology.removed) bullet(`➖ service vanished ${code(s)}`);
    lines.push('');
  }

  // Discovery
  if (report.discovery.length) {
    section('Discovery counts');
    for (const d of report.discovery) {
      const arrow = d.delta > 0 ? '↑' : '↓';
      bullet(`${arrow} ${code(d.key)} ${d.from} → ${d.to} (${d.delta > 0 ? '+' : ''}${d.delta})`);
    }
    lines.push('');
  }

  // Live versions
  if (report.versions.length) {
    section('Live versions');
    for (const v of report.versions) {
      bullet(`${code(v.product)}: ${code(String(v.from ?? '—'))} → ${code(String(v.to ?? '—'))}`);
    }
    lines.push('');
  }

  // Capabilities
  const c = report.capabilities;
  if (c.skills.added.length || c.skills.removed.length || c.backends.added.length || c.backends.removed.length) {
    section('Capability inventory');
    for (const s of c.skills.added)   bullet(`➕ skill exposed ${code(s)}`);
    for (const s of c.skills.removed) bullet(`➖ skill withdrawn ${code(s)}`);
    for (const b of c.backends.added)   bullet(`➕ backend supported ${code(b)}`);
    for (const b of c.backends.removed) bullet(`➖ backend dropped ${code(b)}`);
    lines.push('');
  }

  // Tool surface
  if (report.tools.added.length || report.tools.removed.length) {
    section('MCP tool surface');
    for (const t of report.tools.added)   bullet(`➕ ${code(t)}`);
    for (const t of report.tools.removed) bullet(`➖ ${code(t)}`);
    lines.push('');
  }

  // Anomalies
  if (report.anomalies) {
    section('Active anomalies');
    const a = report.anomalies;
    const arrow = a.delta > 0 ? '↑' : '↓';
    bullet(`${arrow} ${a.from} → ${a.to} (${a.delta > 0 ? '+' : ''}${a.delta})`);
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function renderJson(report, labels) {
  return JSON.stringify({
    from: labels.a,
    to: labels.b,
    driftDetected: report.counts.changes > 0,
    changeCount: report.counts.changes,
    ...report,
  }, null, 2) + '\n';
}

// ----------------------------------------------------------------
// Entrypoint
// ----------------------------------------------------------------

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`error: ${e.message}\n${HELP}\n`); process.exit(2); }

  if (args.help) { process.stdout.write(HELP + '\n'); process.exit(0); }

  let A, B;
  try {
    if (args.positional.length === 2) {
      A = loadFilePack(args.positional[0]);
      B = loadFilePack(args.positional[1]);
    } else if (args.since && args.positional.length === 0) {
      const packPath = args.pack || DEFAULT_PACK;
      const sha = resolveSinceRev(args.since, packPath);
      A = loadGitRevPack(sha, packPath);
      B = loadFilePack(packPath);
    } else {
      process.stderr.write(`error: provide two files OR --since <duration|sha>\n${HELP}\n`);
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }

  let packA, packB;
  try {
    packA = parsePack(A.text, A.label);
    packB = parsePack(B.text, B.label);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exit(2);
  }

  const report = computeDrift(packA, packB);
  const labels = { a: A.label, b: B.label };

  // No drift + --quiet → say nothing, exit 0.
  if (report.counts.changes === 0 && args.quiet) {
    process.exit(0);
  }

  const out = args.json ? renderJson(report, labels) : renderMarkdown(report, labels);
  if (args.output) writeFileSync(resolve(args.output), out);
  else process.stdout.write(out);

  process.exit(report.counts.changes > 0 ? 1 : 0);
}

// CLI invocation
const invokedDirectly = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

// Exports for offline tests + the studio's eventual Drift view.
export { computeDrift, renderMarkdown, renderJson, parsePack };
