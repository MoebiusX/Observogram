#!/usr/bin/env node
/**
 * tools/store-admin.mjs — `packc store …`: back up and restore the
 * embedded store (docs/STORE_PLAN.md §3).
 *
 *   packc store backup <path>      a consistent copy, safe while the server runs
 *   packc store restore <backup>   with the server stopped
 *
 * The database is OBSERVOGRAM_DB, else <workspace>/observogram.db. Exit
 * codes: 0 done · 1 refused or failed (one line on stderr) · 2 usage.
 */

import { backupStore, restoreStore } from '../server/store/backup.mjs';

const USAGE = `usage: packc store backup <path>      Write a consistent copy of the store (safe while the server runs)
       packc store restore <backup>   Replace the store with a backup (server stopped; the old files are moved aside)`;

async function main([cmd, arg, ...extra]) {
  if (!['backup', 'restore'].includes(cmd) || !arg || extra.length) {
    console.error(USAGE);
    return 2;
  }
  try {
    if (cmd === 'backup') {
      const r = await backupStore(arg);
      console.log(`backup written: ${r.path}`);
      console.log(`store_id: ${r.storeId} (schema v${r.schemaVersion}, from ${r.source})`);
      return 0;
    }
    const r = await restoreStore(arg);
    console.log(`restored ${r.source} -> ${r.path}`);
    console.log(`store_id: ${r.storeId} (schema v${r.schemaVersion}); previous store_id: ${r.previousStoreId ?? `none${r.previousNote ? ` (${r.previousNote})` : ''}`}`);
    if (r.movedAside.length) console.log(`moved aside: ${r.movedAside.join(', ')}`);
    console.log('The next start opens it and switches it back to WAL.');
    return 0;
  } catch (e) {
    console.error(`packc store ${cmd}: ${e.message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
