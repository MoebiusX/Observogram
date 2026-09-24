#!/usr/bin/env node
//
// tools/cli.mjs — the `packc` / `observogram` entry point.
//
// A thin dispatcher: it reads the first positional argument as a command
// and either forwards to one of the existing single-purpose tools (so their
// behaviour stays identical whether run directly or via `packc`) or, for
// `compile`, calls tools/lib/compile.mjs programmatically.
//
//   packc validate <file...>          → tools/validate-pack.mjs
//   packc adapt    <file> [env]       → tools/adapt-spec-pack.mjs
//   packc x-ray    <repo-dir>         → tools/crawl-repo.mjs
//   packc compile  <file> [target]    → tools/lib/compile.mjs (programmatic)
//   packc init     …                  → tools/pack-init.mjs (build a pack from the library)
//   packc serve                       → server/index.mjs (boots the studio)
//   observogram                       → same as `serve`
//
// Both bin names point here (a pre-rebrand global `tomograph` shim still
// resolves too). With no command, the `observogram` bin boots the studio;
// everything else prints help. `serve` works under either name, so
// behaviour is identical across platforms even where the invoked bin name
// isn't recoverable (e.g. npm's Windows .cmd shims).

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { buildInfo, buildLabel } from '../server/build-info.mjs';
import { SPEC_VERSION } from './lib/validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const [, , command, ...rest] = process.argv;

// Run a project script in a child process, forwarding args + stdio and
// propagating its exit code. Keeps each tool's argv contract untouched.
function delegate(relPath, args) {
  const child = spawn(process.execPath, [resolve(ROOT, relPath), ...args], {
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error(`packc: failed to run ${relPath}: ${err.message}`);
    process.exit(1);
  });
}

// Exit only once stdout and stderr have flushed. On a pipe both streams
// are asynchronous, so a bare process.exit() straight after a large
// write drops the tail: `packc journey run --all --json` lost ~146 KB of
// its 150 KB report to the pipe under `node --test`, and the reader got
// unparseable JSON. The returned promise never settles; the pending
// write keeps the process alive until the callback exits it, so
// `await exitAfterFlush(n)` stops the caller exactly like process.exit.
function exitAfterFlush(code) {
  return new Promise(() => {
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });
}

async function runCompile(args) {
  // The third positional is the dashboard id for grafana-dashboard (the
  // target's own descriptor says "pass the dashboard id as an arg"); without
  // it the compiler picks the first declared board, else the unified one.
  const [file, target, dashboardId] = args;
  if (!file) {
    console.error('usage: packc compile <file> [target] [dashboardId]');
    process.exit(2);
  }
  const { compile, listTargets } = await import('../tools/lib/compile.mjs');
  const text = readFileSync(resolve(process.cwd(), file), 'utf8');
  let canonical;
  if (file.endsWith('.json')) {
    canonical = JSON.parse(text);
  } else {
    const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
    canonical = parseYaml(text);
  }

  if (!target) {
    console.error('No target given. Available compile targets:\n');
    for (const t of listTargets()) {
      console.error(`  ${t.id.padEnd(22)} ${t.label}`);
    }
    process.exit(2);
  }

  const out = compile(canonical, target, dashboardId ? { dashboardId } : {});
  // The artefact text goes to stdout (pipe-friendly); the provenance line
  // and any compile warnings go to stderr so redirecting stdout yields a
  // clean artefact file.
  for (const w of out.warnings || []) console.error(`warning: ${w}`);
  const p = out.profile || {};
  console.error(
    `# ${out.filename}  (${out.contentType})  ` +
    `profile=${p.product || '?'}@${p.version || '?'}${p.matched === false ? ' [extrapolated]' : ''}`,
  );
  process.stdout.write(out.content);
  if (!out.content.endsWith('\n')) process.stdout.write('\n');
}

function printHelp() {
  console.log(`Observogram — the Observability Compiler · ${buildLabel(buildInfo())}

Usage:
  packc validate <file...>        Validate pack(s) against spec v${SPEC_VERSION}
  packc adapt    <file> [env]     Adapt a pack into the layered projection
  packc x-ray    <repo-dir>       Crawl a repo into a draft pack
  packc compile  <file> [target]  Compile a pack into a backend artefact
  packc init     --list           List the library entries (products and archetypes) a pack can be built from
  packc init     --show <entry>   An entry's params, SLIs per tier, per-tier objectives and evidence
  packc init     --entry <id> --tier <tier> --name <svc>  Build a pack from the library (YAML to stdout, todos to stderr)
  packc journey  run <name>       Run a saved drift check (exit 0 pass · 1 gate-failed · 2 error)
  packc journey  run --all        Run every saved journey in sequence (exit = the worst of them)
  packc journey  schedule <name>  Print cron / schtasks / GitHub Actions / CronJob snippets from its schedule:
  packc journey  list             List saved journeys + their last outcome
  packc serve                     Boot the studio (Express server)
  observogram                     Same as \`packc serve\`

Run a command with no/invalid args to see its own usage.`);
}

// `packc journey run <name|path> [--json]` — the repeatable drift check
// (VALUE_BACKLOG 11). Exit codes follow the gate contract in
// docs/PHASE_1_VERDICT_TRUST_RESEARCH.md Workstream D:
//   0 verdict passes the gate · 1 gate failed · 2 tooling/config error.
// Schedule it externally (cron, Task Scheduler, GitHub Actions) — the
// journey file is the unit of repetition, not a built-in scheduler.
async function runJourneyCommand([sub, ...args]) {
  const journeyLib = await import('./lib/journey.mjs');
  if (sub === 'list') {
    const names = journeyLib.listJourneys();
    if (!names.length) { console.log('(no journeys saved — add .observogram/journeys/<name>.journey.yaml)'); return; }
    for (const n of names) {
      const last = journeyLib.readJourneyRuns(n, { limit: 1 })[0];
      // A definition that fails to load must not read like a healthy
      // never-run journey.
      let loadError = null;
      try { journeyLib.loadJourneyDef(n); } catch (e) { loadError = e.message; }
      // Step 5: the delivery outcome of the last run, only when the record
      // carries a notify object (a record written without one says nothing
      // — never "skipped").
      const notifySeg = last && journeyLib.notifyStatusLine(last) ? ` · ${journeyLib.notifyStatusLine(last)}` : '';
      const inventorySeg = last && journeyLib.inventoryStatusLine(last) ? ` · ${journeyLib.inventoryStatusLine(last)}` : '';
      const tail = loadError ? `(definition does not load: ${loadError})`
        : !last ? '(never run)'
        : last.outcome === 'vantage-lost' ? `vantage-lost · ${last.startedAt} · ${last.error || 'live source unreachable'}${notifySeg}`
        : `${last.outcome} · ${last.startedAt} · alignment ${last.drift?.alignmentPct}% · ${journeyLib.stackStatusLine(last)} · ${journeyLib.chainStatusLine(last)}`
          // Step 4: the top candidate cause, only when a chain got worse —
          // a quiet run has nothing to explain — and, whenever the vantage
          // itself changed, that change beside it (never as a cause).
          + (journeyLib.transitionGotWorse(last) ? ` · ${journeyLib.causeLine(last)}` : '')
          + (journeyLib.vantageLine(last) ? ` · ${journeyLib.vantageLine(last)}` : '')
          + inventorySeg + notifySeg;
      console.log(`${n}\t${tail}`);
    }
    return;
  }
  if (sub === 'run') {
    const ref = args.find(a => !a.startsWith('--'));
    const asJson = args.includes('--json');
    // Step 5: `run --all` — every saved journey, sequentially, in one
    // workspace (the CronJob's `concurrencyPolicy: Forbid` keeps two
    // fleets apart; an interleaved POST /api/journeys/:name/run is
    // tolerated by the prune logic). One journey's failure never stops the
    // loop; the exit code is the worst of them (0 pass · 1 gate failed ·
    // 2 error, a definition that does not load included).
    if (args.includes('--all') && !ref) {
      const names = journeyLib.listJourneys();
      if (!names.length) { console.log('(no journeys saved — add .observogram/journeys/<name>.journey.yaml)'); await exitAfterFlush(0); }
      const results = [];
      let worst = 0;
      for (const n of names) {
        let record = null, error = null, exitCode;
        try {
          record = await journeyLib.runJourney(journeyLib.loadJourneyDef(n));
          exitCode = record.outcome === 'pass' ? 0 : 1;
        } catch (e) {
          error = e.message;
          exitCode = 2;
          console.error(`packc journey ${n}: ${e.message}`);
        }
        if (!asJson) process.stdout.write(`## journey ${n}\n\n${record ? journeyLib.renderJourneyMarkdown(record) : `_error: ${error}_`}\n\n`);
        results.push({ name: n, record, error, exitCode });
        worst = Math.max(worst, exitCode);
      }
      if (asJson) process.stdout.write(JSON.stringify(results, null, 2) + '\n');
      await exitAfterFlush(worst);
    }
    if (!ref) { console.error('usage: packc journey run <name|path/to/file.journey.yaml> [--json] | packc journey run --all [--json]'); await exitAfterFlush(2); }
    try {
      const def = journeyLib.loadJourneyDef(ref);
      const record = await journeyLib.runJourney(def);
      process.stdout.write(asJson ? JSON.stringify(record, null, 2) + '\n' : journeyLib.renderJourneyMarkdown(record) + '\n');
      await exitAfterFlush(record.outcome === 'pass' ? 0 : 1);
    } catch (e) {
      console.error(`packc journey: ${e.message}`);
      await exitAfterFlush(2);
    }
  }
  // Step 5: `schedule <name|path> [--format cron|schtasks|actions|k8s|all] [--json]`
  // — the delegated form of scheduling (VALUE_BACKLOG 11): ready-made
  // snippets from the journey's schedule:. Without a schedule: every
  // snippet carries the placeholder */15 * * * *, marked as such, and a
  // stderr note says so (exit 0 — nothing fabricated is presented as the
  // journey's cadence).
  if (sub === 'schedule') {
    // `--format` takes a value: skip that slot when locating the journey ref,
    // so `schedule --format cron <name>` and `schedule <name> --format cron`
    // both work (fix round 0: the former read `cron` as the journey name).
    const fmtIdx = args.indexOf('--format');
    const ref = args.find((a, i) => !a.startsWith('--') && !(fmtIdx >= 0 && i === fmtIdx + 1));
    const asJson = args.includes('--json');
    const format = fmtIdx >= 0 ? String(args[fmtIdx + 1] || '') : 'all';
    if (!ref) { console.error('usage: packc journey schedule <name|path/to/file.journey.yaml> [--format cron|schtasks|actions|k8s|all] [--json]'); await exitAfterFlush(2); }
    const snippetsLib = await import('./lib/schedule-snippets.mjs');
    if (format !== 'all' && !snippetsLib.SNIPPET_FORMATS.includes(format)) { console.error(`packc journey schedule: unknown --format ${format} (cron | schtasks | actions | k8s | all)`); await exitAfterFlush(2); }
    let def;
    try { def = journeyLib.loadJourneyDef(ref); } catch (e) { console.error(`packc journey: ${e.message}`); await exitAfterFlush(2); }
    const { parseSchedule } = await import('./lib/schedule.mjs');
    const { brandEnv } = await import('./lib/brand-env.mjs');
    const parsed = def.schedule === undefined || def.schedule === null ? null : parseSchedule(def.schedule);
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    const envNames = [...new Set([def.packB?.mcp?.authEnv, def.notify?.urlEnv, def.notify?.authEnv].filter(Boolean))];
    const input = {
      name: def.name,
      cron: parsed?.cron ?? null, timezone: parsed?.timezone ?? null, every: parsed?.every ?? null, cadenceNote: parsed?.cadenceNote ?? null,
      envNames,
      nodePath: process.execPath, cliPath: resolve(ROOT, 'tools/cli.mjs'), cwd: process.cwd(),
      workspace: brandEnv('WORKSPACE') || '.observogram',
      image: `observogram:${pkg.version}`, namespace: 'observability',
      retention: brandEnv('JOURNEY_RUN_RETENTION') || null,
      placeholder: !parsed,
      source: def.__source || null,
    };
    if (!parsed) console.error(`packc journey schedule: ${def.name} declares no schedule: — printing the placeholder ${snippetsLib.PLACEHOLDER_CRON}; edit before installing`);
    const snippets = snippetsLib.scheduleSnippets(input);
    if (asJson) {
      process.stdout.write(JSON.stringify({ name: def.name, source: def.__source || null, schedule: parsed, placeholder: !parsed, envNames, snippets: format === 'all' ? snippets : { [format]: snippets[format] } }, null, 2) + '\n');
      await exitAfterFlush(0);
    }
    if (format !== 'all') { process.stdout.write(snippets[format]); await exitAfterFlush(0); }
    const titles = { cron: 'cron', schtasks: 'schtasks (Windows Task Scheduler)', actions: 'github-actions', k8s: 'kubernetes-cronjob' };
    for (const f of snippetsLib.SNIPPET_FORMATS) process.stdout.write(`## ${titles[f]}\n\n${snippets[f]}\n`);
    await exitAfterFlush(0);
  }
  console.error('usage: packc journey <run|schedule|list> …');
  await exitAfterFlush(2);
}

switch (command) {
  case 'validate':
    delegate('tools/validate-pack.mjs', rest);
    break;
  case 'adapt':
    delegate('tools/adapt-spec-pack.mjs', rest);
    break;
  case 'x-ray':
  case 'xray':
  case 'crawl':
    delegate('tools/crawl-repo.mjs', rest);
    break;
  case 'compile':
    await runCompile(rest);
    break;
  case 'init':
    delegate('tools/pack-init.mjs', rest);
    break;
  case 'journey':
    await runJourneyCommand(rest);
    break;
  case 'serve':
  case 'studio':
    delegate('server/index.mjs', rest);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  case '--version':
  case '-v': {
    // Which build is this? 'v0.4.0 · build 975 · 9c4f827 · develop' — the
    // version stays the first token, so `packc --version | grep 0.4.0`
    // still works; `--json` is the structured form (server/build-info.mjs).
    const info = buildInfo();
    if (rest.includes('--json')) console.log(JSON.stringify({ ...info, label: buildLabel(info) }, null, 2));
    else console.log(buildLabel(info));
    break;
  }
  case undefined: {
    // No subcommand: the `observogram` bin boots the studio (so does a
    // stale global `tomograph` shim); `packc` shows help.
    const bin = basename(process.argv[1] || '');
    if (bin.startsWith('observogram') || bin.startsWith('tomograph')) {
      delegate('server/index.mjs', rest);
    } else {
      printHelp();
    }
    break;
  }
  default:
    console.error(`packc: unknown command "${command}"\n`);
    printHelp();
    process.exit(2);
}
