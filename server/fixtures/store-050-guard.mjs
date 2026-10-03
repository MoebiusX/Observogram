// server/fixtures/store-050-guard.mjs — a frozen copy of what a 0.5.0 build
// (tag v0.5.0; develop before STORE_PLAN slice 4) does at boot step 2 (d)
// with the hashes a store recorded: the loop of staleImportGuard() in
// server/boot.mjs at that tag (lines 474–520), byte for byte, its imports
// rewired to this fixture. It compares EVERY key it finds in
// schema_meta legacy_hashes against the file at that path, and refuses on a
// difference — which is why slice 4 records packs/index.json under a key of
// its own, schema_meta pack_index_hashes: a 0.5.0 build rewrites index.json
// on every pack read (lastUsedAt) and on every register, so a pack key in
// legacy_hashes would make a rollback to 0.5.0 refuse its second start with
// no way out that works on that build (its `import --replace` keeps unknown
// legacy_hashes keys; "move it aside" makes it recreate the file).
// server/test-store-ops.mjs runs this loop over a slice-4 workspace after a
// slice-4 export and a 0.5.0-style rewrite: it must not refuse; over a
// workspace whose pack key was (wrongly) put into legacy_hashes it refuses
// — the proof the key separation matters (design §12.2 (iii), trap 1b/36).
//
// Do not "fix" anything in it: it reads legacy_hashes only — that is the
// point. Like pre-store-build.mjs, it is what the old build does.

import { isAbsolute, join } from 'node:path';
import { getMeta, getMetaJson, storeId } from '../store/meta.mjs';
import { compareHashes, legacyUsersPath, markerPath, readMarker, sha256File } from '../store/legacy-files.mjs';

// v0.5.0 boot.mjs: the refusal, REPLACE and keyPath as that build spelt them.
export class BootRefusal050 extends Error {
  constructor(message, { nothingMoved = false } = {}) {
    super(message);
    this.name = 'BootRefusal';
    this.code = 'ERR_OBSERVOGRAM_BOOT_REFUSED';
    this.nothingMoved = nothingMoved;
  }
}
const BootRefusal = BootRefusal050;
const REPLACE = '`packc store import --replace`';
const keyPath = (base, key) => (isAbsolute(key) ? key : join(base, key));

// The 0.5.0 guard's (d) step over a store and a workspace: `ctx` is
// { base, dbPath, memory }, as bootStore()'s context carries them. Returns
// what (d) found for (e) — { changed, appeared, disappeared } — or throws
// the 0.5.0 refusal. Reads only.
export function guard050(db, ctx) {
  const id = storeId(db);
  const marker = ctx.memory ? null : readMarker(ctx.base);
  const usersPath = legacyUsersPath(db, ctx.base);
  // ---- v0.5.0 server/boot.mjs lines 474–520, verbatim ----
  // (d) files edited since the import.
  const recorded = getMetaJson(db, 'legacy_hashes', {}) || {};
  const usersKey = getMeta(db, 'users_file') || 'users.json';
  const current = {};
  for (const key of new Set([...Object.keys(recorded), usersKey, 'orgs.json'])) {
    current[key] = sha256File(key === usersKey ? usersPath : keyPath(ctx.base, key));
  }
  // A file recorded absent after the import keeps the hash it was imported
  // with, and is compared as that: put back byte for byte it passes (and
  // (e) records it present again); any other file refuses as a change.
  const importedOf = (key) => (recorded[key]?.absent && typeof recorded[key].importedSha256 === 'string'
    ? recorded[key].importedSha256 : null);
  const asImported = {};
  for (const [key, value] of Object.entries(recorded)) {
    asImported[key] = importedOf(key) ? { sha256: importedOf(key) } : value;
  }
  const cmp = compareHashes(asImported, current);
  const stale = [...cmp.changed, ...cmp.appeared];
  if (stale.length) {
    const pathOf = (key) => (key === usersKey ? usersPath : keyPath(ctx.base, key));
    const lines = stale.map((key) => (!cmp.changed.includes(key)
      ? `${pathOf(key)} appeared since store ${id} last imported it (it was absent then).`
      : importedOf(key)
        ? `${pathOf(key)} came back since store ${id} recorded it absent, but not as it was imported ` +
          `(it was SHA-256 ${importedOf(key)} at the import, it is ${current[key].sha256}).`
        : `${pathOf(key)} changed since store ${id} last imported it (it was SHA-256 ${recorded[key].sha256}, it is ${current[key].sha256}) — ` +
          'it was edited outside the store (a pre-store build during a rollback, or config management).'));
    // The replace request needs the marker (requestReplace): with it
    // missing, the way to the replace goes through the (e) repair first.
    const noMarker = !ctx.memory && !marker;
    // The marker names the hash only while it still agrees with the store
    // (an export's marker, over a backup restored from before it, does not).
    const markerRecords = (key) => !!marker && JSON.stringify(marker.files[key]) === JSON.stringify(recorded[key]);
    // Every stale file is exactly what an export from this store wrote: the
    // database was restored from a backup taken before that export.
    const exportedAfter = !!marker && marker.by === 'export' && marker.storeId === id
      && stale.every((key) => current[key] && marker.files[key]?.sha256 === current[key].sha256);
    const ways = [
      ...(exportedAfter
        ? [`  - put back the database that export wrote: \`packc store restore\` the ${ctx.dbPath}.pre-restore-… copy ` +
          'the restore moved aside (or a backup taken after the export) — it starts on these files as they stand; or'] : []),
      ...cmp.changed.map((key) => `  - put ${pathOf(key)} back exactly as it was imported (SHA-256 ${asImported[key].sha256}; ` +
        `the store's legacy_hashes${markerRecords(key) ? ` and ${markerPath(ctx.base)}` : ''} record it), or`),
      ...stale.map((key) => `  - move ${pathOf(key)} aside: a file that disappears is recorded as absent and changes no user or org;`),
    ];
    throw new BootRefusal(
      `refusing to start: ${lines.join('\n  ')}\n` +
      (exportedAfter
        ? `${stale.length === 1 ? 'It is' : 'They are'} exactly what an export from store ${id} wrote (${markerPath(ctx.base)}, ` +
          `written by that export, records ${stale.length === 1 ? 'it' : 'them'}): this database was restored from a backup taken before the export, ` +
          'which may also have moved the default org\'s data into orgs/default: moving the files aside starts on the ' +
          `backup's default-org root without that data, and ${REPLACE} follows the move.\n`
        : '') +
      'Nothing was changed. The store keeps its own users and orgs; the file is only compared, never read again. ' +
      'With the server stopped:\n' +
      `${ways.join('\n')}\n` +
      '    then make the change with `npm run users` / `npm run orgs`;\n' +
      (noMarker
        ? `  - or, to re-import the files as they stand: ${REPLACE} needs ${markerPath(ctx.base)}, which is missing — ` +
          `move ${stale.map(pathOf).join(' and ')} aside, start once (it records ${stale.length === 1 ? 'it' : 'them'} absent ` +
          `and rewrites the marker), stop the server, put ${stale.length === 1 ? 'it' : 'them'} back, then run ${REPLACE}: ` +
          'the next start re-imports the files as they stand.'
        : `  - or run ${REPLACE}: the next start re-imports the files as they stand.`),
      { nothingMoved: true });
  }
  // ---- end of the verbatim copy ----
  return cmp;
}
