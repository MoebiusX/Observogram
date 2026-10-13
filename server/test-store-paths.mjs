#!/usr/bin/env node
/**
 * server/test-store-paths.mjs — the store's offline operations compare paths
 * as Windows names them (server/store/paths.mjs). On NTFS one file has many
 * spellings — another case, another drive-letter case, / for \, a short
 * (8.3) name — and JS realpathSync keeps the caller's, so a spelling
 * comparison let a directory export write into the workspace, missed the
 * workspace itself (the in-place export) and the database under it, let
 * purge-org delete the users file under the root it purged, and let a backup
 * be written over the database's own -wal. A network share this host serves
 * is one more name: with the workspace or the database named through one
 * (\\myhost\ws, Z: mapped to it) their local path (C:\ws\…) compared as
 * outside them, and so did a share name the admin gave for a local workspace
 * or database (\\localhost\C$\ws\…). A share of a directory inside the
 * workspace or the purged root (\\myhost\exports, which is C:\ws\exports)
 * names none of their directories, so it compared as outside them; on their
 * volume it now answers null and is refused, and so does a share, or a drive
 * mapped to one, that cannot be reached when the check runs: with no volume
 * to read, nothing tells where it leads. A share of another machine cloned
 * from this host's image reports its volume's serial and is refused alike;
 * the export's refusal names the way out that holds there too (a local
 * directory, copied to the share). Each check's predicate is run here
 * as ops.mjs and backup.mjs run it, over comparedPath with an injected host —
 * Windows' path rules, an NTFS volume's realpath and statSync
 * (server/fixtures/ntfs.mjs) and the platform — so the proof runs on every
 * host. One test runs the default host on a real directory, so the
 * platform's choice of rule is pinned too: the expected value reads isWin32
 * (server/fixtures/platform.mjs), and a Windows run fails if its default host
 * compared by spelling. The last test pins that every check compares through
 * it. On Linux and macOS the form is the module's own, unchanged:
 * server/test-store-ops.mjs and server/test-store.mjs hold those checks.
 *
 * Hermetic (§0): nothing here reads the environment; the strip loop is the
 * shape server/test-hermetic-suites.mjs pins for a suite importing server code.
 */

const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join, resolve, win32 } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { tokenize } = await import('../tools/gen-vendor-manifest.mjs');
const { ntfsVolume } = await import('./fixtures/ntfs.mjs');
const { isWin32 } = await import('./fixtures/platform.mjs');
const { comparedPath } = await import('./store/paths.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));

const VOLUME = ntfsVolume([
  'C:\\ws\\observogram.db',
  'C:\\ws\\exports\\keep.txt',
  'C:\\ws\\orgs\\beta\\users.json',
  'C:\\ws\\orgs\\beta2\\users.json',
  'C:\\ws2\\observogram.db',
  'C:\\out\\x.txt',
], { short: { 'C:\\ws': 'WS~1' } });
const key = comparedPath(null, { windows: true, path: win32, realpathSync: VOLUME.realpathSync, statSync: VOLUME.statSync });
const SEP = '\\';
// The comparison this replaces on Windows: ops.mjs's realOr, the spelling JS realpathSync keeps.
const bySpelling = (p) => { try { return VOLUME.realpathSync(p); } catch { return win32.resolve(p); } };

// The same volume served as shares: the workspace itself (\\myhost\ws, and Z: mapped to it), the admin share by
// two names of this host, and a directory on another volume (\\myhost\out, D:\out). \\nas01\obs is another host's
// share, reached: what it reports is its own volume's (here E:'s), not the workspace's.
const SHARED = ntfsVolume([
  'C:\\ws\\observogram.db',
  'C:\\ws\\exports\\keep.txt',
  'C:\\ws\\orgs\\beta\\users.json',
  'C:\\ws\\orgs\\beta2\\users.json',
  'C:\\ws2\\observogram.db',
  'C:\\out\\x.txt',
  'D:\\out\\x.txt',
  'E:\\obs\\keep.txt',
], {
  short: { 'C:\\ws': 'WS~1' },
  shares: { '\\\\myhost\\ws': 'C:\\ws', '\\\\localhost\\C$': 'C:\\', '\\\\127.0.0.1\\C$': 'C:\\', '\\\\myhost\\out': 'D:\\out', '\\\\nas01\\obs': 'E:\\obs' },
  mapped: { 'Z:': '\\\\myhost\\ws' },
});
const shared = comparedPath(null, { windows: true, path: win32, realpathSync: SHARED.realpathSync, statSync: SHARED.statSync });
// The native realpath alone: a statSync that tells every path apart (no two share a file id or a volume), so nothing
// is placed and nothing is taken to lie inside — a share keeps its own name, and C:\ws is not \\myhost\ws.
const byNameOf = (volume) => {
  const ids = new Map();
  const apart = (p) => { if (!ids.has(p)) ids.set(p, BigInt(ids.size + 1)); return { dev: ids.get(p), ino: ids.get(p) }; };
  return comparedPath(null, { windows: true, path: win32, realpathSync: volume.realpathSync, statSync: apart });
};
const byName = byNameOf(SHARED);

// The checks' predicates, as server/store/ops.mjs and backup.mjs write them over their compared form: a path
// is compared placed beside the one it is checked against (the second argument). 'unplaced' is the refusal of a
// null answer — through a share on that path's volume, it may lie inside it.
function exportRelation(into, base, k = key) {   // exportDirectory: 'is' | 'inside' | 'holds' | 'unplaced' | null (null: written)
  const t = k(into, base);
  if (t === null) return 'unplaced';
  const b = k(base);
  const inside = t.startsWith(b + SEP);
  if (t === b || inside || b.startsWith(t.endsWith(SEP) ? t : t + SEP)) return t === b ? 'is' : inside ? 'inside' : 'holds';
  return null;
}
const inPlace = (target, base, k = key) => k(target, base) === k(base);                       // exportStore
const sameFile = (file, path, k = key) => k(file, path) === k(path);                          // assertNoOtherStore
function dbUnderWorkspace(path, base, k = key) {   // exportStore, no marker: true | false (refused: outside) | 'unplaced'
  const own = k(path, base);
  return own === null ? 'unplaced' : own.startsWith(k(base) + SEP);
}
const rootUnderOrgs = (root, base, k = key) => k(root).startsWith(k(win32.join(base, 'orgs')) + SEP);   // purgeOrg
function usersUnderRoot(usersFile, root, k = key) {   // purgeOrg: true (refused) | false (purged) | 'unplaced'
  const users = k(usersFile, root);
  return users === null ? 'unplaced' : users.startsWith(k(root) + SEP);
}
const ownFile = (dbFile, path, k = key) => ['', '-wal', '-shm', '-journal'].find((s) => k(path, dbFile) === `${k(dbFile)}${s}`) ?? null;   // backup.mjs

test('on Windows every spelling of one path compares equal — case, drive letter, / for \\, a short name, a trailing separator, a part not created yet', () => {
  for (const group of [
    ['C:\\ws', 'c:/WS', 'C:\\WS~1', 'c:\\ws\\', 'C:/Ws/'],
    ['C:\\ws\\observogram.db', 'C:\\WS~1\\OBSERVOGRAM.DB', 'c:/ws/Observogram.db'],
    ['C:\\ws\\exports\\new\\dir', 'C:\\WS~1\\EXPORTS\\NEW\\Dir', 'c:/WS/exports/new/dir/'],
  ]) {
    for (const p of group) assert.equal(key(p), key(group[0]), `${p} is ${group[0]}`);
  }
  for (const other of ['C:\\ws2', 'D:\\ws', 'C:\\ws\\orgs', 'C:\\wsx']) assert.notEqual(key(other), key('C:\\ws'), `${other} is not C:\\ws`);
  assert.notEqual(bySpelling('C:\\WS'), bySpelling('C:\\ws'), 'by spelling the same directory compared unequal');
});

test('a directory export into the workspace, spelled another way, is refused as inside it (exportDirectory)', () => {
  for (const into of ['C:\\WS\\exports', 'c:/ws/exports/new', 'C:\\WS~1\\orgs\\beta', 'c:\\WS\\Exports\\']) {
    assert.equal(exportRelation(into, 'C:\\ws'), 'inside', `refused: ${into}`);
    assert.equal(exportRelation(into, 'C:\\ws', bySpelling), null, `by spelling it was written: ${into}`);
  }
  for (const into of ['c:\\', 'C:/']) assert.equal(exportRelation(into, 'C:\\WS~1'), 'holds', `refused, it holds the workspace: ${into}`);
  for (const into of ['C:\\out', 'c:/OUT/new', 'C:\\ws2', 'C:\\wsx\\a']) assert.equal(exportRelation(into, 'C:\\ws'), null, `written: ${into}`);
});

test('the workspace named another way is the in-place export, and a database under it lies in the workspace (exportStore)', () => {
  for (const target of ['C:\\WS', 'c:/ws/', 'C:\\WS~1', 'c:\\Ws']) {
    assert.equal(inPlace(target, 'C:\\ws'), true, `in place: ${target}`);
    assert.equal(inPlace(target, 'C:\\ws', bySpelling), false, `by spelling it was a directory export: ${target}`);
  }
  for (const target of ['C:\\ws\\exports', 'C:\\ws2', 'D:\\ws']) assert.equal(inPlace(target, 'C:\\ws'), false, `not in place: ${target}`);
  for (const db of ['C:\\WS~1\\observogram.db', 'c:/WS/OBSERVOGRAM.DB', 'C:\\ws\\db\\other.db']) {
    assert.equal(dbUnderWorkspace(db, 'c:\\ws'), true, `in the workspace: ${db}`);
  }
  assert.equal(dbUnderWorkspace('C:\\WS~1\\observogram.db', 'c:\\ws', bySpelling), false, 'by spelling it lived outside');
  for (const db of ['C:\\ws2\\observogram.db', 'C:\\out\\observogram.db']) assert.equal(dbUnderWorkspace(db, 'C:\\ws'), false, `outside: ${db}`);
});

test('purge-org: the root lies under orgs\\ and the users file under the root, whatever their spelling (purgeOrg)', () => {
  for (const base of ['C:\\ws', 'c:/WS', 'C:\\WS~1']) assert.equal(rootUnderOrgs('C:\\ws\\orgs\\beta', base), true, `under ${base}\\orgs`);
  for (const users of ['C:\\WS\\ORGS\\BETA\\users.json', 'c:/ws/orgs/beta/Users.json', 'C:\\WS~1\\orgs\\beta\\users.json', 'C:\\ws\\orgs\\beta\\sub\\new.json']) {
    assert.equal(usersUnderRoot(users, 'C:\\ws\\orgs\\beta'), true, `under the root, refused: ${users}`);
  }
  assert.equal(usersUnderRoot('C:\\WS\\ORGS\\BETA\\users.json', 'C:\\ws\\orgs\\beta', bySpelling), false, 'by spelling the purge deleted it');
  for (const users of ['C:\\ws\\users.json', 'C:\\ws\\orgs\\beta2\\users.json', 'C:\\ws\\orgs\\BETA2\\x\\users.json']) {
    assert.equal(usersUnderRoot(users, 'C:\\ws\\orgs\\beta'), false, `not under the root: ${users}`);
  }
});

test('backup and restore: the database and its -wal, -shm and -journal spelled another way are its own files (ownFile)', () => {
  const db = 'C:\\ws\\observogram.db';
  for (const [p, s] of [['C:\\WS\\observogram.db', ''], ['C:\\WS~1\\OBSERVOGRAM.DB', ''], ['c:/ws/Observogram.db-wal', '-wal'], ['C:\\WS\\OBSERVOGRAM.DB-SHM', '-shm'], ['c:\\ws~1\\observogram.db-journal', '-journal']]) {
    assert.equal(ownFile(db, p), s, `the database's own${s ? ` ${s}` : ''}: ${p}`);
  }
  assert.equal(ownFile(db, 'c:/ws/Observogram.db-wal', bySpelling), null, 'by spelling a backup could be written over the -wal');
  for (const p of ['C:\\ws\\observogram.db.bak', 'C:\\ws2\\observogram.db', 'C:\\ws\\observogram.db-wal2']) assert.equal(ownFile(db, p), null, `another file: ${p}`);
});

test('with the workspace and the database named through a share this host serves (\\\\myhost\\ws, Z:), their local path is them — every check holds for a target named on the drive', () => {
  assert.equal(SHARED.realpathSync.native('Z:\\'), '\\\\myhost\\ws\\', 'Z: is the share, as the native realpath names it');
  for (const base of ['\\\\myhost\\ws', 'Z:\\', '//MYHOST/ws/']) {
    const root = win32.join(base, 'orgs', 'beta');
    const dbFile = win32.join(base, 'observogram.db');
    for (const users of ['C:\\ws\\orgs\\beta\\users.json', 'c:/WS/orgs/BETA/Users.json', 'C:\\WS~1\\orgs\\beta\\users.json']) {
      assert.equal(usersUnderRoot(users, root, shared), true, `purge-org refuses: ${users} lies under ${root}`);
    }
    assert.equal(usersUnderRoot('C:\\ws\\orgs\\beta\\users.json', root, byName), false, `by name alone the purge deleted it (${base})`);
    for (const users of ['C:\\ws\\orgs\\beta2\\users.json', 'C:\\ws\\users.json', 'C:\\out\\users.json']) assert.equal(usersUnderRoot(users, root, shared), false, `not under ${root}: ${users}`);
    for (const into of ['C:\\ws\\exports', 'c:/WS/exports/new', 'C:\\WS~1\\orgs\\beta', `${base}${base.endsWith('\\') || base.endsWith('/') ? '' : '\\'}exports`]) {
      assert.equal(exportRelation(into, base, shared), 'inside', `a directory export is refused: ${into} lies inside ${base}`);
    }
    assert.equal(exportRelation('C:\\ws\\exports', base, byName), null, `by name alone it was written into the workspace (${base})`);
    for (const into of ['C:\\out', 'C:\\ws2', 'c:/out/new']) assert.equal(exportRelation(into, base, shared), null, `written: ${into}`);
    for (const target of ['C:\\ws', 'c:/WS/', 'C:\\WS~1']) assert.equal(inPlace(target, base, shared), true, `the in-place export: ${target} is ${base}`);
    assert.equal(inPlace('C:\\ws2', base, shared), false, `not in place: C:\\ws2 (${base})`);
    for (const path of ['C:\\ws\\observogram.db', 'C:\\WS~1\\db\\other.db']) assert.equal(dbUnderWorkspace(path, base, shared), true, `in the workspace ${base}: ${path}`);
    assert.equal(dbUnderWorkspace('C:\\ws2\\observogram.db', base, shared), false, `outside ${base}: C:\\ws2\\observogram.db`);
    assert.equal(sameFile(dbFile, 'C:\\ws\\observogram.db', shared), true, `the scan for another store skips the database itself: ${dbFile}`);
    assert.equal(sameFile(dbFile, 'C:\\ws2\\observogram.db', shared), false, `another store's database: ${dbFile} beside C:\\ws2\\observogram.db`);
    for (const [p, s] of [['C:\\ws\\observogram.db-wal', '-wal'], ['c:/WS/Observogram.db', ''], ['C:\\WS~1\\OBSERVOGRAM.DB-SHM', '-shm'], ['C:\\ws\\observogram.db-journal', '-journal']]) {
      assert.equal(ownFile(dbFile, p, shared), s, `the database ${dbFile}'s own${s ? ` ${s}` : ''}: ${p}`);
    }
    assert.equal(ownFile(dbFile, 'C:\\ws\\observogram.db-wal', byName), null, `by name alone a backup was written over the -wal (${dbFile})`);
    for (const p of ['C:\\ws\\observogram.db.bak', 'C:\\ws2\\observogram.db', 'C:\\out\\observogram.db-wal']) assert.equal(ownFile(dbFile, p, shared), null, `another file: ${p}`);
  }
});

test('with the workspace and the database on the drive (C:\\ws), a share name the admin gives for them is them; a share on another volume or of another host is an ordinary target', () => {
  const [base, root, dbFile] = ['C:\\ws', 'C:\\ws\\orgs\\beta', 'C:\\ws\\observogram.db'];
  for (const into of ['\\\\localhost\\C$\\ws\\exports', '\\\\127.0.0.1\\c$\\WS~1\\exports\\new', '\\\\myhost\\ws\\orgs\\beta', 'Z:\\exports', '//localhost/C$/ws/exports/']) {
    assert.equal(exportRelation(into, base, shared), 'inside', `a directory export is refused: ${into} lies inside ${base}`);
  }
  assert.equal(exportRelation('\\\\localhost\\C$\\ws\\exports', base, byName), null, 'by name alone it was written into the workspace');
  assert.equal(exportRelation('\\\\localhost\\C$', base, shared), 'holds', 'the admin share of the drive holds the workspace');
  for (const into of ['\\\\localhost\\C$\\out\\new', '\\\\myhost\\out\\new', '\\\\localhost\\C$\\ws2', '\\\\nas01\\obs\\exports']) {
    assert.equal(exportRelation(into, base, shared), null, `written, an ordinary target: ${into}`);
  }
  for (const target of ['\\\\localhost\\C$\\ws', '\\\\myhost\\ws', 'Z:\\', '\\\\127.0.0.1\\C$\\WS~1\\']) assert.equal(inPlace(target, base, shared), true, `the in-place export: ${target} is ${base}`);
  for (const target of ['\\\\myhost\\out', '\\\\nas01\\obs']) assert.equal(inPlace(target, base, shared), false, `not in place: ${target}`);
  for (const path of ['\\\\localhost\\C$\\ws\\observogram.db', 'Z:\\db\\other.db']) assert.equal(dbUnderWorkspace(path, base, shared), true, `in the workspace: ${path}`);
  assert.equal(dbUnderWorkspace('\\\\localhost\\C$\\ws2\\observogram.db', base, shared), false, 'outside: \\\\localhost\\C$\\ws2\\observogram.db');
  assert.equal(sameFile('C:\\ws\\observogram.db', '\\\\myhost\\ws\\observogram.db', shared), true, 'the scan for another store skips the database itself');
  for (const users of ['\\\\localhost\\C$\\ws\\orgs\\beta\\users.json', 'Z:\\orgs\\beta\\users.json', '\\\\myhost\\ws\\ORGS\\Beta\\users.json']) {
    assert.equal(usersUnderRoot(users, root, shared), true, `purge-org refuses: ${users} lies under ${root}`);
  }
  for (const users of ['\\\\myhost\\ws\\orgs\\beta2\\users.json', '\\\\myhost\\out\\users.json']) assert.equal(usersUnderRoot(users, root, shared), false, `not under ${root}: ${users}`);
  for (const [p, s] of [['\\\\localhost\\C$\\ws\\observogram.db-wal', '-wal'], ['\\\\myhost\\ws\\OBSERVOGRAM.DB', ''], ['Z:\\observogram.db-shm', '-shm']]) {
    assert.equal(ownFile(dbFile, p, shared), s, `the database's own${s ? ` ${s}` : ''}: ${p}`);
  }
  assert.equal(ownFile(dbFile, '\\\\localhost\\C$\\ws\\observogram.db-wal', byName), null, 'by name alone a backup was written over the -wal');
  for (const p of ['\\\\myhost\\out\\observogram.db-wal', '\\\\localhost\\C$\\ws2\\observogram.db', '\\\\nas01\\obs\\observogram.db-wal']) {
    assert.equal(ownFile(dbFile, p, shared), null, `another file, an ordinary target: ${p}`);
  }
});

// Shares of directories inside the workspace (C:\ws): its exports (and Y: mapped to it), its orgs, a directory under
// beta's root and its db directory; a share of a directory outside it on the same volume (\\myhost\cout, C:\out); one
// on another volume (\\myhost\dout, D:\out); another host's (\\nas01\obs, as above). None names a directory of C:\ws's
// lineage, so no file id places a path through one beside the workspace, beta's root or the database.
const SUBSHARED_FILES = [
  'C:\\ws\\observogram.db',
  'C:\\ws\\exports\\keep.txt',
  'C:\\ws\\orgs\\beta\\users.json',
  'C:\\ws\\orgs\\beta\\sub\\users.json',
  'C:\\ws\\db\\observogram.db',
  'C:\\out\\users.json',
  'D:\\out\\users.json',
  'E:\\obs\\keep.txt',
];
const SUBSHARES = {
  '\\\\myhost\\ws': 'C:\\ws', '\\\\myhost\\exports': 'C:\\ws\\exports', '\\\\myhost\\orgs': 'C:\\ws\\orgs', '\\\\myhost\\betasub': 'C:\\ws\\orgs\\beta\\sub',
  '\\\\myhost\\dbdir': 'C:\\ws\\db', '\\\\myhost\\cout': 'C:\\out', '\\\\myhost\\dout': 'D:\\out', '\\\\nas01\\obs': 'E:\\obs',
};
const SUBSHARED = ntfsVolume(SUBSHARED_FILES, { shares: SUBSHARES, mapped: { 'Y:': '\\\\myhost\\exports' } });
const subshared = comparedPath(null, { windows: true, path: win32, realpathSync: SUBSHARED.realpathSync, statSync: SUBSHARED.statSync });

test('a path through a share no file id places, on the volume of the path it is checked against, may lie inside it — the export, purge-org and the no-marker check refuse it, and named on the drive it is judged; a share on another volume or host is an ordinary target', () => {
  const [base, root] = ['C:\\ws', 'C:\\ws\\orgs\\beta'];
  // [the path through a share, the same path on the drive]: each sub-share, by its name or a drive mapped to it.
  for (const [into, local] of [
    ['\\\\myhost\\exports\\new', 'C:\\ws\\exports\\new'], ['Y:\\new', 'C:\\ws\\exports\\new'], ['\\\\myhost\\orgs\\beta\\x', 'C:\\ws\\orgs\\beta\\x'],
    ['\\\\myhost\\betasub\\new', 'C:\\ws\\orgs\\beta\\sub\\new'], ['\\\\myhost\\dbdir\\new', 'C:\\ws\\db\\new'],
  ]) {
    assert.equal(exportRelation(into, base, subshared), 'unplaced', `a directory export is refused: ${into} may lie inside ${base}`);
    assert.equal(exportRelation(into, base, byNameOf(SUBSHARED)), null, `before, it was written: ${into} (${local})`);
    assert.equal(inPlace(into, base, subshared), false, `not the in-place export: ${into}`);
    assert.equal(exportRelation(local, base, subshared), 'inside', `the way out: named on the drive, ${local} is refused as inside ${base}`);
  }
  assert.equal(exportRelation('\\\\myhost\\exports\\new', '\\\\myhost\\ws', subshared), 'unplaced', 'with the workspace named through a share too');
  // purge-org: the users file recorded through each sub-share; through a share of beta's own subdirectory it lies under the root.
  for (const users of ['\\\\myhost\\betasub\\users.json', '\\\\myhost\\exports\\users.json', '\\\\myhost\\dbdir\\users.json']) {
    assert.equal(usersUnderRoot(users, root, subshared), 'unplaced', `purge-org refuses: ${users} may lie under ${root}`);
  }
  assert.equal(usersUnderRoot('\\\\myhost\\betasub\\users.json', root, byNameOf(SUBSHARED)), false, 'before, the purge deleted C:\\ws\\orgs\\beta\\sub\\users.json');
  assert.equal(usersUnderRoot('\\\\myhost\\orgs\\beta\\users.json', root, subshared), true, 'a share of the root\'s parent places it: under the root, refused');
  assert.equal(usersUnderRoot('\\\\myhost\\orgs\\users.json', root, subshared), false, 'placed beside the root, not under it: purged');
  // The no-marker check: the database named through a share of its directory, or of the workspace's exports or orgs.
  for (const [path, local] of [['\\\\myhost\\dbdir\\observogram.db', 'C:\\ws\\db\\observogram.db'], ['\\\\myhost\\orgs\\x.db', 'C:\\ws\\orgs\\x.db'], ['\\\\myhost\\exports\\x.db', 'C:\\ws\\exports\\x.db']]) {
    assert.equal(dbUnderWorkspace(path, base, subshared), 'unplaced', `refused, it may or may not lie in ${base}: ${path}`);
    assert.equal(dbUnderWorkspace(local, base, subshared), true, `the way out: OBSERVOGRAM_DB=${local} lies in ${base}`);
  }
  assert.equal(dbUnderWorkspace('\\\\myhost\\dbdir\\observogram.db', base, byNameOf(SUBSHARED)), false, 'before, refused as living outside the workspace');
  // A share outside the workspace on its volume is refused too (no file id tells it apart); named on the drive it is written.
  assert.equal(exportRelation('\\\\myhost\\cout\\new', base, subshared), 'unplaced', 'a share of C:\\out on the workspace\'s volume is refused');
  assert.equal(exportRelation('C:\\out\\new', base, subshared), null, 'the way out: C:\\out\\new, named on the drive, is written');
  assert.equal(usersUnderRoot('\\\\myhost\\cout\\users.json', root, subshared), 'unplaced', 'purge-org refuses a users file recorded through it');
  // On another volume or another host: an ordinary target.
  for (const into of ['\\\\myhost\\dout\\new', '\\\\nas01\\obs\\exports']) assert.equal(exportRelation(into, base, subshared), null, `written: ${into}`);
  for (const users of ['\\\\myhost\\dout\\users.json', '\\\\nas01\\obs\\users.json']) assert.equal(usersUnderRoot(users, root, subshared), false, `purged: ${users}`);
  assert.equal(dbUnderWorkspace('\\\\myhost\\dout\\observogram.db', base, subshared), false, 'outside the workspace: \\\\myhost\\dout\\observogram.db');
  // An equality check takes null as unequal, as each such answer is: a sub-share it cannot place is never the database or its own file.
  assert.equal(sameFile('\\\\myhost\\dbdir\\observogram.db', 'C:\\ws\\db\\observogram.db', subshared), true, 'a share of the database\'s directory places it');
  assert.equal(sameFile('\\\\myhost\\exports\\observogram.db', 'C:\\ws\\observogram.db', subshared), false, 'another file');
  assert.equal(ownFile('C:\\ws\\db\\observogram.db', '\\\\myhost\\dbdir\\observogram.db-wal', subshared), '-wal', 'the database\'s own -wal');
  assert.equal(ownFile('C:\\ws\\observogram.db', '\\\\myhost\\exports\\observogram.db-wal', subshared), null, 'a backup target, not its own file');
});

// The same shares when a check runs with \\myhost\betasub (a directory under beta's root) and \\myhost\exports down —
// the server's sharing stopped, or its name not resolving: neither realpath nor statSync reads a path through them, by
// their names or by the drives still mapped to them (X:, Y:), so no file id places one and its volume is unknown.
// \\nas02\obs is a host that does not answer at all.
const DOWN = ntfsVolume(SUBSHARED_FILES, {
  shares: Object.fromEntries(Object.entries(SUBSHARES).filter(([unc]) => !['\\\\myhost\\betasub', '\\\\myhost\\exports'].includes(unc))),
  mapped: { 'X:': '\\\\myhost\\betasub', 'Y:': '\\\\myhost\\exports' },
});
const down = comparedPath(null, { windows: true, path: win32, realpathSync: DOWN.realpathSync, statSync: DOWN.statSync });

test('a path through a share that cannot be reached, or a drive mapped to one, may lie anywhere — purge-org refuses a users file recorded through it and the export refuses it, as a share on their volume; it is never the workspace, the database or one of its files', () => {
  const [base, root] = ['C:\\ws', 'C:\\ws\\orgs\\beta'];
  assert.throws(() => DOWN.statSync('\\\\myhost\\betasub\\users.json'), { code: 'ENOENT' }, 'the share cannot be reached');
  assert.throws(() => DOWN.statSync('X:\\'), { code: 'ENOENT' }, 'nor the drive mapped to it');
  // purge-org: C:\ws\orgs\beta\sub\users.json recorded through \\myhost\betasub — refused while it is served, and while it is down.
  assert.equal(usersUnderRoot('\\\\myhost\\betasub\\users.json', root, subshared), 'unplaced', 'served, purge-org refuses it');
  for (const users of ['\\\\myhost\\betasub\\users.json', '//MYHOST/betasub/Users.json', '\\\\?\\UNC\\myhost\\betasub\\users.json', 'X:\\users.json', 'x:/users.json', '\\\\nas02\\obs\\users.json']) {
    assert.equal(usersUnderRoot(users, root, down), 'unplaced', `down, purge-org refuses it too: ${users} may lie under ${root}`);
  }
  assert.equal(usersUnderRoot('C:\\ws\\orgs\\beta\\sub\\users.json', root, down), true, 'the way out: named on the drive, it lies under the root');
  for (const users of ['\\\\myhost\\dout\\users.json', '\\\\nas01\\obs\\users.json', 'C:\\out\\users.json']) {
    assert.equal(usersUnderRoot(users, root, down), false, `reached on another volume or host, or on the drive outside the root: purged (${users})`);
  }
  // The export: a target through a share that is down is refused, naming its path on a local drive (it could not be written either).
  for (const into of ['\\\\myhost\\exports\\new', 'Y:\\new', '\\\\nas02\\obs\\exports']) {
    assert.equal(exportRelation(into, base, down), 'unplaced', `a directory export is refused: ${into} may lie inside ${base}`);
    assert.equal(inPlace(into, base, down), false, `not the in-place export: ${into}`);
  }
  assert.equal(exportRelation('C:\\ws\\exports\\new', base, down), 'inside', 'the way out: named on the drive, it is refused as inside the workspace');
  assert.equal(exportRelation('\\\\nas01\\obs\\exports', base, down), null, 'another host\'s share, reached: written');
  // The no-marker check refuses such a database as it refuses any null (ops.mjs finds it missing first); an equality check takes null as unequal.
  assert.equal(dbUnderWorkspace('\\\\myhost\\betasub\\x.db', base, down), 'unplaced', 'the no-marker check: it may or may not lie in the workspace');
  assert.equal(sameFile('\\\\myhost\\exports\\observogram.db', 'C:\\ws\\observogram.db', down), false, 'not the database');
  assert.equal(ownFile('C:\\ws\\observogram.db', '\\\\myhost\\exports\\observogram.db-wal', down), null, 'a backup target, not the database\'s own file');
});

// Another machine cloned from this host's image: its disks keep the serials they were formatted with, so its C: has
// this host's C: serial (each fixture gives a drive letter one serial), and through a share both report the same low
// 32 bits. \\fileserver\exports is a share of its C:, \\fileserver\dexports of its D:. Its file ids are its own.
const LOCAL = ntfsVolume(['C:\\ws\\observogram.db', 'C:\\ws\\orgs\\beta\\users.json', 'C:\\out\\x.txt']);
const FILESERVER = ntfsVolume(['C:\\exports\\keep.txt', 'D:\\exports\\keep.txt'], {
  shares: { '\\\\fileserver\\exports': 'C:\\exports', '\\\\fileserver\\dexports': 'D:\\exports' },
});
const hostOf = (p) => (/^[\\/]{2}fileserver[\\/]/i.test(p) ? FILESERVER : LOCAL);
const clonedRealpath = (p) => hostOf(p).realpathSync(p);
clonedRealpath.native = (p) => hostOf(p).realpathSync.native(p);
const clonedStat = (p) => { const st = hostOf(p).statSync(p); return hostOf(p) === FILESERVER ? { ...st, ino: st.ino + 1000n } : st; };
const cloned = comparedPath(null, { windows: true, path: win32, realpathSync: clonedRealpath, statSync: clonedStat });

test('a share of another machine whose volume has the workspace volume\'s serial (cloned from one image) is refused as one on that volume — the export\'s way out, a local directory copied there, is written; a share of its other volume is an ordinary target', () => {
  const [base, root] = ['C:\\ws', 'C:\\ws\\orgs\\beta'];
  assert.equal(clonedStat('\\\\fileserver\\exports').dev, clonedStat('C:\\ws').dev & 0xffffffffn, 'the clone\'s share reports the workspace volume\'s serial');
  assert.equal(exportRelation('\\\\fileserver\\exports\\obs-2026', base, cloned), 'unplaced', 'a directory export is refused: no serial tells it from a share of C:\\ws\'s volume');
  assert.equal(inPlace('\\\\fileserver\\exports\\obs-2026', base, cloned), false, 'not the in-place export');
  // It has no path on this host's drives: the way out that holds is the export to a local directory, copied to the share by hand.
  assert.equal(exportRelation('C:\\out\\obs-2026', base, cloned), null, 'the way out: C:\\out\\obs-2026, on a local drive outside the workspace, is written');
  assert.equal(usersUnderRoot('\\\\fileserver\\exports\\users.json', root, cloned), 'unplaced', 'purge-org refuses a users file recorded through it (its way out: delete the root by hand)');
  // Its D: has a serial C:\ws's volume does not: an ordinary target.
  assert.equal(exportRelation('\\\\fileserver\\dexports\\obs-2026', base, cloned), null, 'written: \\\\fileserver\\dexports\\obs-2026');
  assert.equal(usersUnderRoot('\\\\fileserver\\dexports\\users.json', root, cloned), false, 'purged: \\\\fileserver\\dexports\\users.json');
});

test('off Windows a check compares through the module\'s own form, unchanged', () => {
  const own = (p) => `own:${p}`;
  assert.equal(comparedPath(own, { windows: false }), own, 'the module\'s realpath form itself: Linux and macOS compare as before');
  assert.equal(comparedPath(own, { windows: false, path: win32, realpathSync: VOLUME.realpathSync }), own, 'whatever the path rules');
});

test('the default host is this platform\'s rule: a real directory spelled in another case is itself on Windows, and elsewhere another path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'observogram-paths-'));
  try {
    mkdirSync(join(dir, 'ws'));
    const realOr = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };   // ops.mjs's own form
    const compared = comparedPath(realOr);
    // On NTFS C:\…\WS is the directory ws; off Windows the comparison is realOr's spelling, and WS is another path.
    assert.equal(compared(join(dir, 'WS')) === compared(join(dir, 'ws')), isWin32, `the default host compares as this platform names paths: ${join(dir, 'WS')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every path comparison in ops.mjs and backup.mjs goes through compared; realOr only spells the journey rewrites\' base', () => {
  const code = (f) => tokenize(readFileSync(join(HERE, 'store', f), 'utf8')).code;
  const count = (src, re) => (src.match(re) || []).length;
  const ops = code('ops.mjs');
  assert.equal(count(ops, /\brealOr\(/g), 2, 'ops.mjs: realOr\'s definition and planJourneyRewrites\' spelling of the base, nothing else');
  assert.match(ops, /slashed\(realOr\(base\)\)/, 'the journey rewrites spell the base as realpath does (text, not a comparison)');
  assert.match(ops, /const compared = comparedPath\(realOr\);/);
  assert.equal(count(ops, /\bcompared\(/g), 12, 'ops.mjs: the export, in-place, no-marker, other-store and purge checks');
  // Each path is placed beside the one it is checked against, as the predicates above place it, and a null answer
  // is refused before it is compared (an equality check takes it as unequal).
  assert.match(ops, /const t = compared\(into, base\);\s*if \(t === null\) \{[^}]*\}\s*const b = compared\(base\);/, 'exportDirectory');
  assert.match(ops, /compared\(file, path\) === own/, 'assertNoOtherStore');
  assert.match(ops, /const inPlace = compared\(target, base\) === compared\(base\);/, 'the in-place detection');
  assert.match(ops, /const own = compared\(path, base\);\s*if \(own === null\) \{[^}]*\}\s*const b = compared\(base\);/, 'the no-marker database check');
  assert.match(ops, /const users = [^;]*\? compared\(usersFile, root\) : undefined;\s*if \(users === null\) \{[^}]*\}\s*if \(users\?\.startsWith\(compared\(root\) \+ sep\)\)/, 'purge-org\'s users file');
  // Each refusal of a null answer names its way out (its message from the guard to the throw's end, the parts joined).
  const raw = readFileSync(join(HERE, 'store', 'ops.mjs'), 'utf8');
  const refusal = (guard) => {
    const at = raw.indexOf(`if (${guard}) {`);
    return at < 0 ? '' : raw.slice(at, raw.indexOf(');\n', at)).replace(/[`']\s*\+\s*[`']/g, '');
  };
  for (const [guard, way] of [
    ['t === null', 'Nothing was changed. Name the directory by its path on a local drive'],
    ['t === null', 'if it has none on this host, export to an empty or new directory on a local drive outside the workspace, then copy that directory to ${target}'],
    ['own === null', 'Nothing was changed. Set OBSERVOGRAM_DB to the database\\\'s path on a local drive, then run the export again'],
    ['users === null', 'nothing was deleted. If it does not lie under'],
    ['users === null', 'by hand, then run purge-org again: it drops org'],
  ]) assert.ok(refusal(guard).includes(way), `the refusal of ${guard} names its way out: ${way}`);
  const backup = code('backup.mjs');
  assert.equal(count(backup, /\bcanonical\(/g), 1, 'backup.mjs: canonical is only defined, and passed to comparedPath');
  assert.match(backup, /const compared = comparedPath\(canonical\);/);
  assert.match(backup, /const db = compared\(dbFile\);\s*const p = compared\(path, dbFile\);/, 'ownFile compares through compared');
});
