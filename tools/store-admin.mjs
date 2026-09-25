#!/usr/bin/env node
/**
 * tools/store-admin.mjs — `packc store …`: back up, restore and export the
 * embedded store, and request a re-import (docs/STORE_PLAN.md §3, §4).
 *
 *   packc store backup <path>      a consistent copy, safe while the server runs
 *   packc store restore <backup>   with the server stopped
 *   packc store export <dir>       users.json / orgs.json a pre-store build boots
 *                                  on; <dir> = the workspace exports in place
 *                                  (server stopped) — the rollback's first step
 *   packc store import --replace   ask the next server start to re-import
 *                                  users.json / orgs.json as they stand (server
 *                                  stopped) — the re-upgrade after a rollback
 *
 * The database is OBSERVOGRAM_DB, else <workspace>/observogram.db. Exit
 * codes: 0 done · 1 refused or failed (one line on stderr) · 2 usage.
 */

import { backupStore, restoreStore } from '../server/store/backup.mjs';
import { exportStore, formatExport, REPLACE_REQUESTED, requestReplace } from '../server/store/ops.mjs';

const USAGE = `usage: packc store backup <path>      Write a consistent copy of the store (safe while the server runs)
       packc store restore <backup>   Replace the store with a backup (server stopped; the old files are moved aside)
       packc store export <dir>       Write users.json / orgs.json a pre-store build boots on; <dir> = the workspace
                                      exports in place (server stopped: before rolling the image back)
       packc store import --replace   Ask the next server start to re-import users.json / orgs.json as they stand
                                      (server stopped: after a rollback, before starting the store build again)`;

async function main([cmd, arg, ...extra]) {
  if (cmd === 'import' && (arg !== '--replace' || extra.length)) {
    console.error('packc store import: only `packc store import --replace` exists — the first start of the server imports; '
      + '--replace asks the next start to re-import the files as they stand');
    console.error(USAGE);
    return 2;
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
    return 0;
  } catch (e) {
    console.error(`packc store ${cmd}: ${e.message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
