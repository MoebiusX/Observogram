#!/usr/bin/env node
// ============================================================
// tools/crawl-repo.mjs — CLI for Path A of pack creation.
//
// Walks a service repo on disk, builds an in-memory file map,
// feeds it to the shared crawler library, and emits a draft
// canonical pack to stdout. The summary report goes to stderr.
//
// Usage:
//   node tools/crawl-repo.mjs <path> [--name foo] [--env prod] [--criticality tier-2]
// ============================================================

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { crawlToYaml } from './lib/crawler.mjs';
import { validateCanonical } from './lib/validator.mjs';
import { brandEnv } from './lib/brand-env.mjs';
import { readFileSync } from 'node:fs';
const SCHEMA = JSON.parse(readFileSync(
  new URL('../vendor/observability-pack-spec/v1.2/observability-pack.schema.json', import.meta.url), 'utf8'));

const SCAN_EXT = /\.(ya?ml|json|cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/i;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.cache', '.next', '.terraform']);
const DIFF_SCOPE_TOKENS = new Set(['service', 'family', 'legacy', 'off', 'all', 'none', 'strict']);

function argValue(a, prefix) {
  return a.startsWith(`${prefix}=`) ? a.slice(prefix.length + 1) : null;
}

async function walk(root) {
  const out = new Map();
  async function visit(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.') && ent.name !== '.observability') continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        await visit(abs);
      } else if (ent.isFile() && SCAN_EXT.test(ent.name)) {
        // Cap per-file size at 5 MB so a stray big binary won't OOM us.
        try {
          const st = await stat(abs);
          if (st.size > 5 * 1024 * 1024) continue;
          const rel = relative(root, abs).replace(/\\/g, '/');
          out.set(rel, await readFile(abs, 'utf8'));
        } catch (_) { /* unreadable; skip */ }
      }
    }
  }
  await visit(root);
  return out;
}

const USAGE = `\
crawl-repo — Path A of pack creation.

Walks a service repository and emits a draft canonical ObservabilityPack
v1.2 manifest by introspecting common observability artefacts.

  Usage:
    node tools/crawl-repo.mjs <repo-path> [options]
    npm run crawl -- <repo-path> [options]

  Options:
    --name <slug>        metadata.name for the draft pack
                         (default: basename of <repo-path>)
    --env <name>         environment tag in metadata.bindings.environments
                         (default: prod)
    --criticality <t>    tier-1 | tier-2 | tier-3 (default: inferred from
                         what was discovered in the repo)
    --binding <name>     metadata.binding (default: otel-elastic-prometheus-grafana)
    --owners a,b,c       comma-separated metadata.owners list
                         (default: team-platform)
    --diff-scope <mode>  live-drift comparison lens: service | family | all
                         (default: service)
    -h, --help           print this message

  Output:
    stdout — the canonical YAML (pipe to a file or to npm run validate)
    stderr — a summary of what was discovered, classified, and stubbed

  What gets detected:
    - docker-compose.yml services → spec.telemetry.backends[]
    - Prometheus rules files     → spec.queries.recording_rules / policy.burn_rate_alerts
    - alertmanager.yml           → spec.alerting.routes[]
    - OTel Collector configs     → spec.pipelines
    - Grafana dashboard JSONs    → spec.dashboards[]
    - Helm values / K8s workloads→ spec.telemetry.backends[]

  Example:
    npm run crawl -- ./payments-svc --name payments --criticality tier-2 > payments.pack.yaml
    npm run validate -- payments.pack.yaml      # sanity check the draft
`;

function parseArgs(argv) {
  const out = { repoPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { out.help = true; continue; }
    if (a === '--') continue;
    if (!a.startsWith('--') && !out.repoPath) { out.repoPath = a; continue; }
    if (!a.startsWith('--') && out.repoPath && !out.diffScopeMode && DIFF_SCOPE_TOKENS.has(a.toLowerCase())) {
      out.diffScopeMode = a;
      continue;
    }
    const diffScopeEquals = argValue(a, '--diff-scope') ?? argValue(a, '--live-scope');
    if (diffScopeEquals !== null) { out.diffScopeMode = diffScopeEquals; continue; }
    if (a === '--name')        out.repoName = argv[++i];
    else if (a === '--env')         out.environment = argv[++i];
    else if (a === '--criticality') out.criticality = argv[++i];
    else if (a === '--binding')     out.binding = argv[++i];
    else if (a === '--owners')      out.owners = argv[++i].split(',');
    else if (a === '--diff-scope' || a === '--live-scope') out.diffScopeMode = argv[++i];
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (!opts.diffScopeMode && brandEnv('DIFF_SCOPE')) opts.diffScopeMode = brandEnv('DIFF_SCOPE');
  if (opts.help) { process.stdout.write(USAGE); process.exit(0); }
  if (!opts.repoPath) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const st = await stat(opts.repoPath).catch(() => null);
  if (!st || !st.isDirectory()) {
    process.stderr.write(`not a directory: ${opts.repoPath}\n`);
    process.exit(2);
  }
  if (!opts.repoName) opts.repoName = basename(opts.repoPath.replace(/[\\/]$/, ''));

  const files = await walk(opts.repoPath);
  const { yaml, canonical, summary, evidence } = crawlToYaml(files, opts);

  // Tripwire: the crawler's contract is that its output validates against
  // the spec it crawls for. Check it HERE, before anyone downstream has to
  // discover it the hard way. Invalid output is still emitted (for
  // debugging) but the summary says so loudly and the exit code is 3.
  const schemaErrors = validateCanonical(canonical, SCHEMA);

  process.stdout.write(yaml);

  // Summary on stderr — doesn't pollute the YAML when piped.
  process.stderr.write([
    '',
    `# crawler summary`,
    `#   files scanned    : ${summary.files.scanned}`,
    `#   files included   : ${summary.files.included}`,
    `#   env scope        : ${summary.environment.profile || 'none'}${summary.environment.scoped ? ` (${summary.files.excludedByEnvironment} excluded)` : ''}`,
    `#   diff scope       : ${summary.comparison?.diffScopeMode || 'service'}`,
    `#   files classified : ${summary.files.classified}`,
    `#   by kind          : ${JSON.stringify(summary.files.byKind)}`,
    `#   backends         : ${summary.discovered.backends}`,
    `#   recording rules  : ${summary.discovered.recordingRules}`,
    `#   burn-rate alerts : ${summary.discovered.burnRateAlerts}`,
    `#   metric definitions: ${summary.discovered.metricDefinitions}`,
    `#   scrape jobs       : ${summary.discovered.scrapeJobs}`,
    `#   dashboards       : ${summary.discovered.dashboards}`,
    `#   alerting routes  : ${summary.discovered.alertingRoutes}`,
    `#   pipelines        : ${summary.discovered.pipelines}`,
    `#   scaffold         : ${summary.scaffold?.length || 0}`,
    `#   tier inferred    : ${summary.inferred.tier}`,
    `#   warnings         : ${summary.warnings.length}`,
    ...summary.warnings.map(w => `#     · ${w}`),
    `#   evidence entries : ${Object.keys(evidence).length}`,
    schemaErrors.length
      ? `#   schema           : INVALID — ${schemaErrors.length} error(s); this is a crawler bug, please report it`
      : `#   schema           : valid (spec v1.2)`,
    ...schemaErrors.map(e => `#     ✗ ${e}`),
    '',
  ].join('\n'));
  if (schemaErrors.length) process.exit(3);
}

main().catch(e => {
  process.stderr.write(`crawler failed: ${e.stack || e.message}\n`);
  process.exit(1);
});
