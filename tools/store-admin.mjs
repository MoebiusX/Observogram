#!/usr/bin/env node
/**
 * tools/store-admin.mjs — `packc store …`: back up, restore and export the
 * embedded store, request a re-import, rekey the OIDC issuer and purge a
 * removed org's files (docs/STORE_PLAN.md §3, §4).
 *
 *   packc store backup <path>      a consistent copy, safe while the server runs
 *   packc store restore <backup>   with the server stopped
 *   packc store export <dir>       users.json / orgs.json and each org's
 *                                  packs/index.json a pre-store build boots on;
 *                                  <dir> = the workspace exports in place
 *                                  (server stopped) — the rollback's first step
 *   packc store import --replace   ask the next server start to re-import
 *                                  users.json / orgs.json and each org's
 *                                  packs/index.json as they stand (server
 *                                  stopped) — the re-upgrade after a rollback
 *   packc store rekey-issuer --to <issuer> | --clear
 *                                  the OIDC users follow the IdP to a new URL,
 *                                  or are retired for another IdP (server stopped)
 *   packc store purge-org <id>     delete the files of a removed org (server stopped)
 *   packc store audit [flags]      list the audit from a shell, newest first,
 *                                  one JSON row per line on stdout (read-only;
 *                                  safe while the server runs) — the way out
 *                                  for a shell on the pod or a CI job, which
 *                                  cannot read GET /api/audit (the bearer is
 *                                  an operator). STORE_PLAN §5, slice 5.
 *
 * The database is OBSERVOGRAM_DB, else <workspace>/observogram.db. Exit
 * codes: 0 done · 1 refused or failed (one line on stderr) · 2 usage.
 */

import { existsSync } from 'node:fs';
import { backupStore, restoreStore } from '../server/store/backup.mjs';
import {
  exportStore, formatExport, formatPurge, formatRekey, purgeOrg, rekeyIssuer, REPLACE_REQUESTED, requestReplace, restoreMarkerWarning,
} from '../server/store/ops.mjs';
import { closeStore, resolveDbPath } from '../server/store/db.mjs';
import { CliRefusal, openStoreForCli } from '../server/store/cli.mjs';
import { listAudit } from '../server/store/audit.mjs';
import { getOrg } from '../server/store/orgs.mjs';
import { auditView, CLI_FLAGS, parseAuditQuery } from '../server/audit-admin.mjs';

const USAGE = `usage: packc store backup <path>      Write a consistent copy of the store (safe while the server runs)
       packc store restore <backup>   Replace the store with a backup (server stopped; the old files are moved aside)
       packc store export <dir>       Write users.json / orgs.json and each org's packs/index.json a pre-store build boots on;
                                      <dir> = the workspace exports in place (server stopped: before rolling the image back)
       packc store import --replace   Ask the next server start to re-import users.json / orgs.json and each org's packs/index.json
                                      as they stand (server stopped: after a rollback, before starting the store build again)
       packc store rekey-issuer --to <issuer> | --clear
                                      Move the OIDC users to the IdP's new URL (--to), or disable them for another
                                      IdP (--clear; OBSERVOGRAM_BOOTSTRAP_ADMIN names the next owner) (server stopped)
       packc store purge-org <id>     Delete the files of an org removed with \`npm run orgs -- remove\` (server stopped)
       packc store audit [--org <id> | --deployment | --all] [--actor <a>] [--action <kind.verb>] [--kind <kind>]
                         [--target-kind <k>] [--target <id>] [--since <t>] [--until <t>] [--limit <n>] [--before <seq>]
                                      List the audit, newest first: one JSON row per line on stdout; when more rows exist,
                                      \`next: <seq>\` on stderr (pass it as --before for the next page). Every org's and the
                                      deployment's rows by default; --org <id> one org's, --deployment the rows with no org.
                                      Read-only, safe while the server runs; it writes no row`;

// `packc store audit`: the flags → the reader's query (server/audit-admin.mjs
// parseAuditQuery, its `cli` surface), the store opened read-only through
// the CLI preamble (a CLI needs the server's database file: :memory: and a
// workspace with un-imported legacy files are refused like its siblings),
// the rows listed by the audit repository and printed one JSON line each.
// The shell is an owner's: every scope is its to ask. The store line and
// the `next` line go to stderr so stdout is the rows and nothing else.
const SCOPE_FLAGS = Object.freeze({ '--org': 'org', '--deployment': 'deployment', '--all': 'all' });
const QUERY_FLAGS = Object.freeze(Object.fromEntries(Object.entries(CLI_FLAGS).map(([name, flag]) => [flag, name])));

// argv → { query (scope included when a scope flag was given), org } or a usage error (a string).
function auditArgs(args) {
  const query = {};
  let scope;
  let org = null;
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (Object.hasOwn(SCOPE_FLAGS, flag)) {
      if (scope !== undefined) return 'name one of --org <id>, --deployment or --all (every org\'s and the deployment\'s rows without any)';
      scope = SCOPE_FLAGS[flag];
      if (flag === '--org') {
        org = args[i + 1];
        if (!org || org.startsWith('--')) return '--org takes an org id';
        i += 1;
      }
    } else if (Object.hasOwn(QUERY_FLAGS, flag)) {
      const name = QUERY_FLAGS[flag];
      if (Object.hasOwn(query, name)) return `${flag} is given twice`;
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${flag} takes a value`;
      query[name] = value;
      i += 1;
    } else {
      return `unknown argument ${flag}`;
    }
  }
  if (scope !== undefined) query.scope = scope;
  return { query, org };
}

async function auditCommand(args) {
  const parsed = auditArgs(args);
  if (typeof parsed === 'string') {
    console.error(`packc store audit: ${parsed}`);
    console.error(USAGE);
    return 2;
  }
  const name = 'packc store audit';
  let opened = null;
  try {
    const { query, org } = parsed;
    const { filters, limit } = parseAuditQuery(query, { owner: true, org, surface: 'cli' });
    const dbPath = resolveDbPath();
    if (dbPath !== ':memory:' && !existsSync(dbPath)) {
      throw new CliRefusal(`${name}: no database at ${dbPath} — nothing to list (this command never creates one; check OBSERVOGRAM_DB and OBSERVOGRAM_WORKSPACE)`);
    }
    opened = await openStoreForCli({ name, out: process.stderr });
    if (org !== null && !getOrg(opened.db, org)) throw new CliRefusal(`${name}: no org ${JSON.stringify(org)} in store ${opened.path}`);
    const rows = listAudit(opened.db, { ...filters, limit: limit + 1 });
    const page = rows.slice(0, limit);
    for (const row of page) console.log(JSON.stringify(auditView(row)));
    if (rows.length > limit) console.error(`next: ${page[page.length - 1].seq}`);
    return 0;
  } catch (e) {
    // A CliRefusal is the whole line already (it starts with the command's
    // name); the rule's AdminRefusal and anything else get the prefix.
    console.error(e instanceof CliRefusal ? e.message : `${name}: ${e.message}`);
    return 1;
  } finally {
    if (opened) closeStore(opened.path);
  }
}

async function main([cmd, arg, ...extra]) {
  if (cmd === 'audit') return auditCommand(arg === undefined ? [] : [arg, ...extra]);
  if (cmd === 'import' && (arg !== '--replace' || extra.length)) {
    console.error('packc store import: only `packc store import --replace` exists — the first start of the server imports; '
      + '--replace asks the next start to re-import the files as they stand');
    console.error(USAGE);
    return 2;
  }
  if (cmd === 'rekey-issuer') {
    const to = arg === '--to' && extra.length === 1 && extra[0] ? extra[0] : null;
    if (!(to || (arg === '--clear' && !extra.length))) {
      console.error('packc store rekey-issuer: name one of --to <issuer> (the same IdP at a new URL) or --clear (a different IdP)');
      console.error(USAGE);
      return 2;
    }
    try {
      const r = await rekeyIssuer(to ? { to } : { clear: true });
      for (const line of formatRekey(r)) console.log(line);
      return 0;
    } catch (e) {
      console.error(`packc store rekey-issuer: ${e.message}`);
      return 1;
    }
  }
  if (cmd === 'purge-org') {
    if (!arg || extra.length) {
      console.error(USAGE);
      return 2;
    }
    try {
      for (const line of formatPurge(await purgeOrg(arg))) console.log(line);
      return 0;
    } catch (e) {
      console.error(`packc store purge-org: ${e.message}`);
      return 1;
    }
  }
  if (!['backup', 'restore', 'export', 'import'].includes(cmd) || !arg || extra.length) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (cmd === 'import') {
      const r = await requestReplace();
      console.log(r.alreadyPending ? `${REPLACE_REQUESTED} (already pending for store ${r.storeId})` : REPLACE_REQUESTED);
      return 0;
    }
    if (cmd === 'backup') {
      const r = await backupStore(arg);
      console.log(`backup written: ${r.path}`);
      console.log(`store_id: ${r.storeId} (schema v${r.schemaVersion}, from ${r.source})`);
      return 0;
    }
    if (cmd === 'export') {
      const r = await exportStore(arg);
      for (const line of formatExport(r)) console.log(line);
      return 0;
    }
    const r = await restoreStore(arg);
    console.log(`restored ${r.source} -> ${r.path}`);
    console.log(`store_id: ${r.storeId} (schema v${r.schemaVersion}); previous store_id: ${r.previousStoreId ?? `none${r.previousNote ? ` (${r.previousNote})` : ''}`}`);
    if (r.movedAside.length) console.log(`moved aside: ${r.movedAside.join(', ')}`);
    console.log('It is in WAL mode already; start the server on it.');
    const warning = restoreMarkerWarning(r.storeId);
    if (warning) console.error(warning);
    return 0;
  } catch (e) {
    console.error(`packc store ${cmd}: ${e.message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
