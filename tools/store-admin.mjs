#!/usr/bin/env node
/**
 * tools/store-admin.mjs — `packc store …`: back up, restore and export the
 * embedded store, request a re-import, rekey the OIDC issuer and purge a
 * removed org's files (docs/STORE_PLAN.md §3, §4).
 *
 *   packc store backup <path>      a consistent copy, safe while the server runs
 *   packc store restore <backup>   with the server stopped
 *   packc store export <dir>       users.json / orgs.json a pre-store build boots
 *                                  on; <dir> = the workspace exports in place
 *                                  (server stopped) — the rollback's first step
 *   packc store import --replace   ask the next server start to re-import
 *                                  users.json / orgs.json as they stand (server
 *                                  stopped) — the re-upgrade after a rollback
 *   packc store rekey-issuer --to <issuer> | --clear
 *                                  the OIDC users follow the IdP to a new URL,
 *                                  or are retired for another IdP (server stopped)
 *   packc store purge-org <id>     delete the files of a removed org (server stopped)
 *
 * The database is OBSERVOGRAM_DB, else <workspace>/observogram.db. Exit
 * codes: 0 done · 1 refused or failed (one line on stderr) · 2 usage.
 */

import { backupStore, restoreStore } from '../server/store/backup.mjs';
import {
  exportStore, formatExport, formatPurge, formatRekey, purgeOrg, rekeyIssuer, REPLACE_REQUESTED, requestReplace, restoreMarkerWarning,
} from '../server/store/ops.mjs';

const USAGE = `usage: packc store backup <path>      Write a consistent copy of the store (safe while the server runs)
       packc store restore <backup>   Replace the store with a backup (server stopped; the old files are moved aside)
       packc store export <dir>       Write users.json / orgs.json a pre-store build boots on; <dir> = the workspace
                                      exports in place (server stopped: before rolling the image back)
       packc store import --replace   Ask the next server start to re-import users.json / orgs.json as they stand
                                      (server stopped: after a rollback, before starting the store build again)
       packc store rekey-issuer --to <issuer> | --clear
                                      Move the OIDC users to the IdP's new URL (--to), or disable them for another
                                      IdP (--clear; OBSERVOGRAM_BOOTSTRAP_ADMIN names the next owner) (server stopped)
       packc store purge-org <id>     Delete the files of an org removed with \`npm run orgs -- remove\` (server stopped)`;

async function main([cmd, arg, ...extra]) {
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
