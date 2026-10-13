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
 * to read, nothing tells where it leads. To purge-org, whose "outside" answer
 * deletes the root, any share nothing places may lie under it, whatever volume
 * it reports: a DFS link whose target is down reads its namespace root's,
 * served from another volume. So may a path the native realpath cannot fully
 * resolve — through a link on the drive whose target cannot be opened (a
 * symlink to such a share, a chain of them, a link to a path that does not
 * exist), through any other reparse point whose target cannot be opened
 * (lstatSync answers it as no link, or cannot read it either), or on a volume
 * whose paths realpath cannot name at all (a RAM disk, where a short name or a
 * link is read as written): realpath stops at a part that exists, the rest
 * read as written compared as outside the root, and the purge deleted a users
 * file recorded through it; one through a link whose target opens, or whose
 * realpath stops only at a part not created yet, is judged as before. A
 * machine cloned from this host's image, or this drive's disk image attached
 * as E:, keeps its volume's serial
 * and its files' ids, the root directory's among them, so a file id places
 * its paths on this host's: a share of a directory it made later is refused
 * alike (the export's way out, a local directory copied to the share, holds
 * there too), a containment refusal holds for the rest, and the checks whose
 * "same" or "inside" answer writes, skips a file or takes it for the
 * database's own — the in-place detection, the scan for another store, the
 * no-marker check, the own-file check — decide by path alone: one only
 * placement equates is refused naming the way out (the scan reads it), never
 * exported in place over the workspace or called the database itself. Each
 * check's predicate is run here
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
const key = comparedPath(null, { windows: true, path: win32, realpathSync: VOLUME.realpathSync, statSync: VOLUME.statSync, lstatSync: VOLUME.lstatSync });
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
const shared = comparedPath(null, { windows: true, path: win32, realpathSync: SHARED.realpathSync, statSync: SHARED.statSync, lstatSync: SHARED.lstatSync });
// The native realpath alone: a statSync that tells every path apart (no two share a file id or a volume), so nothing
// is placed and nothing is taken to lie inside — a share keeps its own name, and C:\ws is not \\myhost\ws.
const byNameOf = (volume) => {
  const ids = new Map();
  const apart = (p) => { if (!ids.has(p)) ids.set(p, BigInt(ids.size + 1)); return { dev: ids.get(p), ino: ids.get(p) }; };
  return comparedPath(null, { windows: true, path: win32, realpathSync: volume.realpathSync, statSync: apart, lstatSync: volume.lstatSync });
};
const byName = byNameOf(SHARED);

// The checks' predicates, as server/store/ops.mjs and backup.mjs write them over their compared form. A containment
// refusal compares a path placed beside the one it is checked against (the second argument); 'unplaced' is the
// refusal of a null answer — through a share on that path's volume, it may lie inside it. A check whose "same" or
// "inside" answer writes, skips a file or takes it for the database's own compares by path alone (no second
// argument); 'placed' is the refusal of a path that only placement makes the same (or inside).
function exportRelation(into, base, k = key) {   // exportDirectory: 'is' | 'inside' | 'holds' | 'unplaced' | null (null: written)
  const t = k(into, base);
  if (t === null) return 'unplaced';
  const b = k(base);
  const inside = t.startsWith(b + SEP);
  if (t === b || inside || b.startsWith(t.endsWith(SEP) ? t : t + SEP)) return t === b ? 'is' : inside ? 'inside' : 'holds';
  return null;
}
function inPlace(target, base, k = key) {   // exportStore: true (in place) | 'placed' (refused) | false (a directory export)
  if (k(target) === k(base)) return true;
  return k(target, base) === k(base) ? 'placed' : false;
}
const sameFile = (file, path, k = key) => k(file) === k(path);   // assertNoOtherStore: true skips file as the database itself
function dbUnderWorkspace(path, base, k = key) {   // exportStore, no marker: true | false (refused: outside) | 'unplaced' | 'placed' (refused alike)
  const b = k(base);
  if (k(path).startsWith(b + SEP)) return true;
  const placed = k(path, base);
  return placed === null ? 'unplaced' : placed.startsWith(b + SEP) ? 'placed' : false;
}
const rootUnderOrgs = (root, base, k = key) => k(root).startsWith(k(win32.join(base, 'orgs')) + SEP);   // purgeOrg
function usersUnderRoot(usersFile, root, k = key, how = { deleting: true }) {   // purgeOrg: true (refused) | false (purged) | 'unplaced'
  const users = k(usersFile, root, how);
  return users === null ? 'unplaced' : users.startsWith(k(root) + SEP);
}
function ownFile(dbFile, path, k = key) {   // backup.mjs: '' | '-wal' | '-shm' | '-journal' (its own: refused) | 'placed' + one (refused) | null
  const own = (p) => ['', '-wal', '-shm', '-journal'].find((s) => p === `${k(dbFile)}${s}`) ?? null;
  const s = own(k(path));
  if (s !== null) return s;
  const placed = own(k(path, dbFile));
  return placed === null ? null : `placed${placed}`;
}

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

test('with the workspace and the database named through a share this host serves (\\\\myhost\\ws, Z:), their local path lies in them for a containment refusal, and a check whose "same" answer writes or skips refuses it naming them by their own path', () => {
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
    // Only its file id makes the local path the workspace or the database (a copy that keeps the ids would match as well):
    // refused, and named by their own path — any name of the share — they are judged.
    for (const target of ['C:\\ws', 'c:/WS/', 'C:\\WS~1']) assert.equal(inPlace(target, base, shared), 'placed', `refused, not the in-place export: ${target} is ${base} only by its file id`);
    for (const target of ['\\\\myhost\\ws', 'Z:\\', '//MYHOST/WS/']) assert.equal(inPlace(target, base, shared), true, `the way out: the in-place export of ${target} (${base})`);
    assert.equal(inPlace('C:\\ws2', base, shared), false, `not in place: C:\\ws2 (${base})`);
    for (const path of ['C:\\ws\\observogram.db', 'C:\\WS~1\\db\\other.db']) assert.equal(dbUnderWorkspace(path, base, shared), 'placed', `the no-marker check refuses ${path}: only its file id puts it in ${base}`);
    for (const path of [dbFile, win32.join(base, 'DB', 'other.db')]) assert.equal(dbUnderWorkspace(path, base, shared), true, `the way out: OBSERVOGRAM_DB=${path} lies in ${base}`);
    assert.equal(dbUnderWorkspace('C:\\ws2\\observogram.db', base, shared), false, `outside ${base}: C:\\ws2\\observogram.db`);
    assert.equal(sameFile(dbFile, 'C:\\ws\\observogram.db', shared), false, `the scan for another store reads ${dbFile} (its store id is this one's): a file id never skips it`);
    assert.equal(sameFile('\\\\MYHOST\\ws\\Observogram.db', dbFile, shared), true, `the database by another name of the share is skipped: ${dbFile}`);
    assert.equal(sameFile(dbFile, 'C:\\ws2\\observogram.db', shared), false, `another store's database: ${dbFile} beside C:\\ws2\\observogram.db`);
    for (const [p, s] of [['C:\\ws\\observogram.db-wal', '-wal'], ['c:/WS/Observogram.db', ''], ['C:\\WS~1\\OBSERVOGRAM.DB-SHM', '-shm'], ['C:\\ws\\observogram.db-journal', '-journal']]) {
      assert.equal(ownFile(dbFile, p, shared), `placed${s}`, `refused: ${p} matches the database ${dbFile}${s} only by its file id`);
    }
    assert.equal(ownFile(dbFile, '\\\\myhost\\WS\\OBSERVOGRAM.DB-wal', shared), '-wal', `named through the share, the database ${dbFile}'s own -wal`);
    assert.equal(ownFile(dbFile, win32.join(win32.parse(dbFile).root, 'backups', 'obs.db'), shared), null, `the way out: a new path under ${win32.parse(dbFile).root}`);
    assert.equal(ownFile(dbFile, 'C:\\ws\\observogram.db-wal', byName), null, `by name alone a backup was written over the -wal (${dbFile})`);
    for (const p of ['C:\\ws\\observogram.db.bak', 'C:\\ws2\\observogram.db', 'C:\\out\\observogram.db-wal']) assert.equal(ownFile(dbFile, p, shared), null, `another file: ${p}`);
  }
});

test('with the workspace and the database on the drive (C:\\ws), a share name the admin gives for them lies in them for a containment refusal, and a check whose "same" answer writes or skips refuses it; a share on another volume or of another host is an ordinary export target', () => {
  const [base, root, dbFile] = ['C:\\ws', 'C:\\ws\\orgs\\beta', 'C:\\ws\\observogram.db'];
  for (const into of ['\\\\localhost\\C$\\ws\\exports', '\\\\127.0.0.1\\c$\\WS~1\\exports\\new', '\\\\myhost\\ws\\orgs\\beta', 'Z:\\exports', '//localhost/C$/ws/exports/']) {
    assert.equal(exportRelation(into, base, shared), 'inside', `a directory export is refused: ${into} lies inside ${base}`);
  }
  assert.equal(exportRelation('\\\\localhost\\C$\\ws\\exports', base, byName), null, 'by name alone it was written into the workspace');
  assert.equal(exportRelation('\\\\localhost\\C$', base, shared), 'holds', 'the admin share of the drive holds the workspace');
  for (const into of ['\\\\localhost\\C$\\out\\new', '\\\\myhost\\out\\new', '\\\\localhost\\C$\\ws2', '\\\\nas01\\obs\\exports']) {
    assert.equal(exportRelation(into, base, shared), null, `written, an ordinary target: ${into}`);
  }
  for (const target of ['\\\\localhost\\C$\\ws', '\\\\myhost\\ws', 'Z:\\', '\\\\127.0.0.1\\C$\\WS~1\\']) assert.equal(inPlace(target, base, shared), 'placed', `refused, not the in-place export: ${target} is ${base} only by its file id`);
  assert.equal(inPlace('c:/WS~1/', base, shared), true, 'the way out: the workspace by its own path is the in-place export');
  for (const target of ['\\\\myhost\\out', '\\\\nas01\\obs']) assert.equal(inPlace(target, base, shared), false, `not in place: ${target}`);
  for (const path of ['\\\\localhost\\C$\\ws\\observogram.db', 'Z:\\db\\other.db']) assert.equal(dbUnderWorkspace(path, base, shared), 'placed', `the no-marker check refuses ${path}: only its file id puts it in the workspace`);
  assert.equal(dbUnderWorkspace('C:\\WS\\db\\other.db', base, shared), true, 'the way out: OBSERVOGRAM_DB under C:\\ws');
  assert.equal(dbUnderWorkspace('\\\\localhost\\C$\\ws2\\observogram.db', base, shared), false, 'outside: \\\\localhost\\C$\\ws2\\observogram.db');
  assert.equal(sameFile('C:\\ws\\observogram.db', '\\\\myhost\\ws\\observogram.db', shared), false, 'the scan for another store reads it (its store id is this one\'s): a file id never skips it');
  for (const users of ['\\\\localhost\\C$\\ws\\orgs\\beta\\users.json', 'Z:\\orgs\\beta\\users.json', '\\\\myhost\\ws\\ORGS\\Beta\\users.json']) {
    assert.equal(usersUnderRoot(users, root, shared), true, `purge-org refuses: ${users} lies under ${root}`);
  }
  assert.equal(usersUnderRoot('\\\\myhost\\ws\\orgs\\beta2\\users.json', root, shared), false, `not under ${root}: \\\\myhost\\ws\\orgs\\beta2\\users.json`);
  assert.equal(usersUnderRoot('\\\\myhost\\out\\users.json', root, shared), 'unplaced', 'purge-org refuses a users file through a share no file id places, on another volume too: \\\\myhost\\out\\users.json');
  for (const [p, s] of [['\\\\localhost\\C$\\ws\\observogram.db-wal', '-wal'], ['\\\\myhost\\ws\\OBSERVOGRAM.DB', ''], ['Z:\\observogram.db-shm', '-shm']]) {
    assert.equal(ownFile(dbFile, p, shared), `placed${s}`, `refused: ${p} matches the database${s ? `'s own ${s}` : ''} only by its file id`);
  }
  assert.equal(ownFile(dbFile, 'C:\\backups\\obs.db', shared), null, 'the way out: a new path under C:\\');
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
const subshared = comparedPath(null, { windows: true, path: win32, realpathSync: SUBSHARED.realpathSync, statSync: SUBSHARED.statSync, lstatSync: SUBSHARED.lstatSync });

test('a path through a share no file id places, on the volume of the path it is checked against, may lie inside it — the export, purge-org and the no-marker check refuse it, and named on the drive it is judged; a share on another volume or host is an ordinary export target', () => {
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
  assert.equal(usersUnderRoot('\\\\myhost\\betasub\\users.json', root, byNameOf(SUBSHARED), {}), false, 'before, the purge deleted C:\\ws\\orgs\\beta\\sub\\users.json');
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
  // On another volume or another host: an ordinary export target.
  for (const into of ['\\\\myhost\\dout\\new', '\\\\nas01\\obs\\exports']) assert.equal(exportRelation(into, base, subshared), null, `written: ${into}`);
  for (const users of ['\\\\myhost\\dout\\users.json', '\\\\nas01\\obs\\users.json']) assert.equal(usersUnderRoot(users, root, subshared), 'unplaced', `but purge-org refuses a users file recorded through one: ${users}`);
  assert.equal(dbUnderWorkspace('\\\\myhost\\dout\\observogram.db', base, subshared), false, 'outside the workspace: \\\\myhost\\dout\\observogram.db');
  // An equality check compares by path alone: a share of the database's directory places it, and the scan reads it; the
  // own-file check refuses it by its file id alone; a sub-share nothing places is never the database or its own file.
  assert.equal(sameFile('\\\\myhost\\dbdir\\observogram.db', 'C:\\ws\\db\\observogram.db', subshared), false, 'read by the scan, not skipped');
  assert.equal(sameFile('\\\\myhost\\exports\\observogram.db', 'C:\\ws\\observogram.db', subshared), false, 'another file');
  assert.equal(ownFile('C:\\ws\\db\\observogram.db', '\\\\myhost\\dbdir\\observogram.db-wal', subshared), 'placed-wal', 'refused: the database\'s -wal only by its file id');
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
const down = comparedPath(null, { windows: true, path: win32, realpathSync: DOWN.realpathSync, statSync: DOWN.statSync, lstatSync: DOWN.lstatSync });

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
  for (const users of ['\\\\myhost\\dout\\users.json', '\\\\nas01\\obs\\users.json']) {
    assert.equal(usersUnderRoot(users, root, down), 'unplaced', `reached on another volume or host, nothing places it: refused (${users})`);
  }
  assert.equal(usersUnderRoot('C:\\out\\users.json', root, down), false, 'on the drive outside the root: purged');
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

// A DFS namespace another server answers (\\corp\dfs, its root F:\dfsroot: another volume) with a link betasub whose
// target is \\myhost\betasub (C:\ws\orgs\beta\sub), and Z: mapped to the namespace — while that target is down. The
// link does not answer, but the namespace root does, with its own volume's serial: the nearest path through the link
// that answers reports a volume that is not where the link leads.
const DFS = ntfsVolume([...SUBSHARED_FILES, 'F:\\dfsroot\\readme.txt'], {
  shares: { ...Object.fromEntries(Object.entries(SUBSHARES).filter(([unc]) => unc !== '\\\\myhost\\betasub')), '\\\\corp\\dfs': 'F:\\dfsroot' },
  mapped: { 'Z:': '\\\\corp\\dfs' },
});
const dfs = comparedPath(null, { windows: true, path: win32, realpathSync: DFS.realpathSync, statSync: DFS.statSync, lstatSync: DFS.lstatSync });

test('purge-org refuses a users file recorded through any network share no file id places, whatever volume it reports — a DFS link whose target is down reads the namespace root\'s — and purges with one on a local drive outside the root, or placed outside it', () => {
  const root = 'C:\\ws\\orgs\\beta';
  assert.throws(() => DFS.statSync('\\\\corp\\dfs\\betasub\\users.json'), { code: 'ENOENT' }, 'the link does not answer');
  assert.notEqual(DFS.statSync('Z:\\').dev, DFS.statSync('C:\\ws').dev & 0xffffffffn, 'the namespace root does, with another volume\'s serial');
  // C:\ws\orgs\beta\sub\users.json recorded through the link — by its name, a device path or the drive mapped to the namespace.
  for (const users of ['\\\\corp\\dfs\\betasub\\users.json', '//CORP/dfs/betasub/Users.json', '\\\\?\\UNC\\corp\\dfs\\betasub\\users.json', 'Z:\\betasub\\users.json', 'z:/betasub/users.json']) {
    assert.equal(usersUnderRoot(users, root, dfs), 'unplaced', `purge-org refuses: ${users} may lie under ${root}`);
  }
  for (const users of ['\\\\corp\\dfs\\betasub\\users.json', 'Z:\\betasub\\users.json']) {
    assert.equal(usersUnderRoot(users, root, dfs, {}), false, `before, compared as the export compares, the purge deleted C:\\ws\\orgs\\beta\\sub\\users.json: ${users}`);
  }
  assert.equal(usersUnderRoot('C:\\ws\\orgs\\beta\\sub\\users.json', root, dfs), true, 'the way out: named on the drive, it lies under the root');
  // Any other share nothing places beside the root is refused alike, on whichever volume: no serial tells where it leads.
  for (const users of ['\\\\corp\\dfs\\users.json', 'Z:\\users.json', '\\\\myhost\\dout\\users.json', '\\\\nas01\\obs\\users.json']) {
    assert.equal(usersUnderRoot(users, root, dfs), 'unplaced', `purge-org refuses: ${users}`);
  }
  // On a local drive outside the root, or through a share a file id places outside it: purged.
  for (const users of ['C:\\out\\users.json', 'D:\\out\\users.json', 'F:\\dfsroot\\users.json', 'C:\\ws\\users.json', '\\\\myhost\\ws\\users.json', '\\\\myhost\\orgs\\users.json']) {
    assert.equal(usersUnderRoot(users, root, dfs), false, `purged: ${users}`);
  }
  // The export's comparison is unchanged: a share on another volume is an ordinary target.
  for (const into of ['\\\\corp\\dfs\\exports', 'Z:\\exports', '\\\\nas01\\obs\\exports']) assert.equal(exportRelation(into, 'C:\\ws', dfs), null, `written: ${into}`);
});

// Links on the drive to \\myhost\betasub, which is C:\ws\orgs\beta\sub (mklink /D and mklink: a link on a local drive
// may lead to a share): a directory link C:\links\betasub, a file link C:\cfg\users.json to its users.json, and a chain
// C:\links\chain → C:\links\betasub. Beside them, links whose target is on the drive: C:\links\out (C:\out, outside
// beta's root), C:\links\betadir (C:\ws\orgs\beta\sub, under it), and C:\links\gone and the file link C:\cfg\old.json
// (C:\gone and C:\gone\users.json, which do not exist). While \\myhost\betasub is down, the native realpath stops at a
// link to it — the link exists (lstatSync answers it), its target cannot be opened — and reads the rest as written, on C:.
const LINKS = {
  'C:\\links\\betasub': '\\\\myhost\\betasub', 'C:\\cfg\\users.json': '\\\\myhost\\betasub\\users.json', 'C:\\links\\chain': 'C:\\links\\betasub',
  'C:\\links\\out': 'C:\\out', 'C:\\links\\betadir': 'C:\\ws\\orgs\\beta\\sub', 'C:\\links\\gone': 'C:\\gone', 'C:\\cfg\\old.json': 'C:\\gone\\users.json',
};
const LINKS_SERVED = ntfsVolume(SUBSHARED_FILES, { shares: SUBSHARES, links: LINKS });
const linksServed = comparedPath(null, { windows: true, path: win32, realpathSync: LINKS_SERVED.realpathSync, statSync: LINKS_SERVED.statSync, lstatSync: LINKS_SERVED.lstatSync });
const LINKS_DOWN = ntfsVolume(SUBSHARED_FILES, {
  shares: Object.fromEntries(Object.entries(SUBSHARES).filter(([unc]) => unc !== '\\\\myhost\\betasub')), links: LINKS,
});
const linksDown = comparedPath(null, { windows: true, path: win32, realpathSync: LINKS_DOWN.realpathSync, statSync: LINKS_DOWN.statSync, lstatSync: LINKS_DOWN.lstatSync });

test('purge-org refuses a users file recorded through a link on the drive whose target cannot be opened — a directory or file symlink to a share that is down, a chain ending at one, a link to a path that does not exist — and judges one through a link whose target opens where it leads', () => {
  const root = 'C:\\ws\\orgs\\beta';
  assert.equal(LINKS_SERVED.realpathSync.native('C:\\links\\betasub\\users.json'), '\\\\myhost\\betasub\\users.json', 'served, the native realpath follows the link to the share');
  assert.throws(() => LINKS_DOWN.realpathSync.native('C:\\links\\betasub'), { code: 'ENOENT' }, 'down, it stops at the link');
  assert.equal(LINKS_DOWN.realpathSync.native('C:\\links'), 'C:\\links', 'the directory that holds the link answers');
  assert.equal(LINKS_DOWN.lstatSync('C:\\links\\betasub').isSymbolicLink(), true, 'and lstatSync answers the link itself');
  assert.throws(() => LINKS_DOWN.lstatSync('C:\\links\\betasub\\users.json'), { code: 'ENOENT' }, 'but nothing through it');
  // C:\ws\orgs\beta\sub\users.json recorded through a link to \\myhost\betasub — refused while the share is served, as before, and while it is down.
  const through = ['C:\\links\\betasub\\users.json', 'c:/LINKS/BetaSub/Users.json', '\\\\?\\C:\\links\\betasub\\users.json', 'C:\\cfg\\users.json', 'C:\\links\\chain\\users.json'];
  for (const users of through) {
    assert.equal(usersUnderRoot(users, root, linksServed), 'unplaced', `served, purge-org refuses: ${users} leads to a share nothing places`);
    assert.equal(usersUnderRoot(users, root, linksDown), 'unplaced', `down, purge-org refuses it too: ${users} may lie under ${root}`);
    assert.equal(usersUnderRoot(users, root, linksDown, {}), false, `before, compared by its name on C:, the purge deleted C:\\ws\\orgs\\beta\\sub\\users.json: ${users}`);
  }
  for (const users of ['C:\\links\\gone\\users.json', 'C:\\cfg\\old.json']) {
    assert.equal(usersUnderRoot(users, root, linksDown), 'unplaced', `a link whose target does not exist leads nowhere known: refused (${users})`);
  }
  assert.equal(usersUnderRoot('C:\\ws\\orgs\\beta\\sub\\users.json', root, linksDown), true, 'named on the drive, it lies under the root');
  // A link whose target opens is followed: on the drive outside the root, purged — a users file there, or one not created
  // yet (the native realpath stops at a part that does not exist) — and under it, refused as lying there.
  for (const volume of [linksServed, linksDown]) {
    for (const users of ['C:\\links\\out\\users.json', 'C:\\links\\out\\new.json', 'C:\\out\\new.json']) assert.equal(usersUnderRoot(users, root, volume), false, `purged: ${users}`);
    assert.equal(usersUnderRoot('C:\\links\\betadir\\users.json', root, volume), true, 'through a link to C:\\ws\\orgs\\beta\\sub: under the root, refused');
  }
  // The share may come back, or go down, while the check runs. Whether the path is resolved is read of the parts the
  // walk that spelled it could not read, not of a second walk that may find the share in another state: with every host
  // call from the (n+1)th on answered in the other state, for each n up to an unflipped check's count, purge-org refuses.
  const flipping = (from, to, n) => {
    let calls = 0;
    const now = () => (calls++ < n ? from : to);
    const realpathSync = (p) => now().realpathSync(p);
    realpathSync.native = (p) => now().realpathSync.native(p);
    const k = comparedPath(null, { windows: true, path: win32, realpathSync, statSync: (p, o) => now().statSync(p, o), lstatSync: (p) => now().lstatSync(p) });
    return Object.assign(k, { calls: () => calls });
  };
  for (const [from, to, how] of [[LINKS_DOWN, LINKS_SERVED, 'comes back'], [LINKS_SERVED, LINKS_DOWN, 'goes down']]) {
    for (const users of through) {
      const unflipped = flipping(from, from, 0);
      usersUnderRoot(users, root, unflipped);
      for (let n = 0; n <= unflipped.calls(); n += 1) {
        assert.equal(usersUnderRoot(users, root, flipping(from, to, n)), 'unplaced', `the share ${how} after host call ${n}: purge-org refuses ${users}`);
      }
    }
  }
  // Only purge-org passes deleting: the export compares a path through such a link as before.
  assert.equal(exportRelation('C:\\links\\betasub\\new', 'C:\\ws', linksDown), null, 'the export\'s comparison is unchanged');
});

// Reparse points on the drive that are no link, whose target cannot be opened — a cloud placeholder whose provider is not
// running, a deduplicated file whose chunk store is damaged, a tag no filter on this host handles — and so may lead under
// beta's root as well as anywhere else: through C:\cloud\betasub (and at the file C:\cloud\users.json) an open reaches
// something, so lstatSync answers the point, isSymbolicLink() false; through C:\tagged\betasub it does not, and lstatSync
// fails as statSync does, with the open's error, not ENOENT.
const REPARSE = ntfsVolume(SUBSHARED_FILES, {
  shares: SUBSHARES,
  reparse: {
    'C:\\cloud\\betasub': { code: 'EIO', lstat: true }, 'C:\\cloud\\users.json': { code: 'EIO', lstat: true },
    'C:\\tagged\\betasub': { code: 'EACCES', lstat: false },
  },
});
const reparse = comparedPath(null, { windows: true, path: win32, realpathSync: REPARSE.realpathSync, statSync: REPARSE.statSync, lstatSync: REPARSE.lstatSync });

test('purge-org refuses a users file recorded through any other reparse point whose target cannot be opened — one lstatSync answers as no link, or cannot read either — and judges a path not created yet as before', () => {
  const root = 'C:\\ws\\orgs\\beta';
  assert.throws(() => REPARSE.realpathSync.native('C:\\cloud\\betasub'), { code: 'EIO' }, 'the native realpath cannot read through the point');
  assert.equal(REPARSE.realpathSync.native('C:\\cloud'), 'C:\\cloud', 'the directory that holds it answers');
  assert.equal(REPARSE.lstatSync('C:\\cloud\\betasub').isSymbolicLink(), false, 'lstatSync answers the point, and it is no link');
  assert.throws(() => REPARSE.lstatSync('C:\\tagged\\betasub'), { code: 'EACCES' }, 'or lstatSync cannot read it either, for another reason than that it does not exist');
  for (const users of ['C:\\cloud\\betasub\\users.json', 'c:/CLOUD/BetaSub/Users.json', 'C:\\cloud\\betasub\\new.json', 'C:\\cloud\\users.json', 'C:\\tagged\\betasub\\users.json']) {
    assert.equal(usersUnderRoot(users, root, reparse), 'unplaced', `purge-org refuses: ${users} may lie under ${root}`);
    assert.equal(usersUnderRoot(users, root, reparse, {}), false, `before, compared by its name on C:, the purge went through: ${users}`);
  }
  // A path whose native realpath stops only at parts that do not exist yet is judged as before.
  for (const users of ['C:\\cloud\\new.json', 'C:\\cloud\\sub\\new.json', 'C:\\tagged\\new.json', 'C:\\out\\new.json']) assert.equal(usersUnderRoot(users, root, reparse), false, `purged: ${users}`);
  assert.equal(usersUnderRoot('C:\\ws\\orgs\\beta\\sub\\new.json', root, reparse), true, 'under the root, refused as lying there');
  // Only purge-org passes deleting: the export compares a path through such a point as before.
  assert.equal(exportRelation('C:\\cloud\\betasub\\new', 'C:\\ws', reparse), null, 'the export\'s comparison is unchanged');
});

// A drive that bypasses the Volume Mount Manager (an ImDisk RAM disk, R:): the native realpath names no path on it
// (EISDIR), its root among them, while statSync and lstatSync answer — so a path there is read as written, its short
// name (R:\WS~1 for R:\ws) and its link R:\links\betasub (to R:\ws\orgs\beta\sub) among them. Beside it, C:\links\ramsub,
// a link on C: to R:\ws\orgs\beta\sub: a target that opens, on a drive realpath cannot name.
const RAMDISK = ntfsVolume([...SUBSHARED_FILES, 'R:\\ws\\observogram.db', 'R:\\ws\\orgs\\beta\\users.json', 'R:\\ws\\orgs\\beta\\sub\\users.json', 'R:\\cfg\\users.json'], {
  short: { 'R:\\ws': 'WS~1' },
  shares: SUBSHARES,
  links: { 'R:\\links\\betasub': 'R:\\ws\\orgs\\beta\\sub', 'C:\\links\\ramsub': 'R:\\ws\\orgs\\beta\\sub' },
  unmanaged: ['R:'],
});
const ramdisk = comparedPath(null, { windows: true, path: win32, realpathSync: RAMDISK.realpathSync, statSync: RAMDISK.statSync, lstatSync: RAMDISK.lstatSync });

test('on a volume whose paths the native realpath cannot name (a RAM disk that bypasses the Volume Mount Manager), purge-org refuses a users file — a short name or a link there is read as written — as through a link to it; one outside the root is a declared false refusal', () => {
  const root = 'R:\\ws\\orgs\\beta';
  assert.throws(() => RAMDISK.realpathSync.native('R:\\'), { code: 'EISDIR' }, 'the native realpath names nothing on R:, not even its root');
  assert.equal(RAMDISK.lstatSync('R:\\cfg\\users.json').isSymbolicLink(), false, 'while lstatSync answers there');
  // Under the root, by its short name or through the link on R: — or through the link on C: to it — the path read as
  // written compared as outside it, and the purge deleted R:\ws\orgs\beta\users.json or R:\ws\orgs\beta\sub\users.json.
  for (const users of ['R:\\WS~1\\orgs\\beta\\users.json', 'r:/ws~1/ORGS/beta/sub/users.json', 'R:\\links\\betasub\\users.json', 'C:\\links\\ramsub\\users.json']) {
    assert.equal(usersUnderRoot(users, root, ramdisk), 'unplaced', `purge-org refuses: ${users} may lie under ${root}`);
    assert.equal(usersUnderRoot(users, root, ramdisk, {}), false, `before, read as written, the purge deleted it: ${users}`);
  }
  // Named as on disk under the root, or outside it — on R:, with the workspace there or on C: — refused alike: nothing
  // tells the path apart from one that leads elsewhere. Outside the root it is a false refusal, whose way out holds.
  for (const users of ['R:\\ws\\orgs\\beta\\users.json', 'R:\\cfg\\users.json', 'r:/CFG/Users.json', 'R:\\cfg\\new.json']) {
    assert.equal(usersUnderRoot(users, root, ramdisk), 'unplaced', `refused: ${users}`);
  }
  assert.equal(usersUnderRoot('R:\\cfg\\users.json', 'C:\\ws\\orgs\\beta', ramdisk), 'unplaced', 'refused beside a root on C: too');
  // A path on another drive is judged as before, beside a root on R: or on C:.
  for (const r of [root, 'C:\\ws\\orgs\\beta']) assert.equal(usersUnderRoot('C:\\out\\users.json', r, ramdisk), false, `purged beside ${r}: C:\\out\\users.json`);
  // Only purge-org passes deleting: the export compares a path on R: as before.
  assert.equal(exportRelation('R:\\exports\\new', 'C:\\ws', ramdisk), null, 'the export\'s comparison is unchanged');
});

// Another machine cloned from this host's image (machineb), and this drive's disk image attached here as E: (a VHDX of
// C:, mounted to restore from). A sector copy keeps the disk's serial and its MFT, so every file present at the copy
// keeps its file id there — the root directory's among them, MFT record 5 on every NTFS volume — and through a share
// both report the same low 32 bits. Each copy is this volume as it was (the image's paths statted in one order on
// all three: the same ids), then diverges: machineb's C:\exports (shared as \\machineb\exports) and its D:
// (\\machineb\dexports) were made after cloning, and C:\out here.
const IMAGE = ['C:\\ws\\observogram.db', 'C:\\ws\\orgs\\beta\\users.json', 'C:\\ws\\exports\\keep.txt'];
const HOST = ntfsVolume([...IMAGE, 'C:\\out\\x.txt']);
const MACHINEB = ntfsVolume([...IMAGE, 'C:\\exports\\keep.txt', 'D:\\exports\\keep.txt'], {
  shares: { '\\\\machineb\\C$': 'C:\\', '\\\\machineb\\exports': 'C:\\exports', '\\\\machineb\\dexports': 'D:\\exports' },
});
const DISK = ntfsVolume(IMAGE);
const lineageOf = (p) => (win32.dirname(p) === p ? [p] : [...lineageOf(win32.dirname(p)), p]);   // the root first
for (const p of IMAGE.flatMap(lineageOf)) for (const volume of [HOST, MACHINEB, DISK]) volume.statSync(p);
const onMachineB = (p) => /^[\\/]{2}machineb[\\/]/i.test(p);
const onDisk = (p) => /^e:/i.test(p);   // E:\… is the image's C:\…, reached on a local drive (its full serial)
const asDrive = (letter, p) => `${letter}:${p.slice(2)}`;
const clonedRealpath = (p) => { clonedRealpath.native(p); return win32.resolve(p); };
clonedRealpath.native = (p) => (onMachineB(p) ? MACHINEB.realpathSync.native(p)
  : onDisk(p) ? asDrive('E', DISK.realpathSync.native(asDrive('C', p))) : HOST.realpathSync.native(p));
const clonedStat = (p) => (onMachineB(p) ? MACHINEB.statSync(p) : onDisk(p) ? DISK.statSync(asDrive('C', p)) : HOST.statSync(p));
const clonedLstat = (p) => (onMachineB(p) ? MACHINEB.lstatSync(p) : onDisk(p) ? DISK.lstatSync(asDrive('C', p)) : HOST.lstatSync(p));
const cloned = comparedPath(null, { windows: true, path: win32, realpathSync: clonedRealpath, statSync: clonedStat, lstatSync: clonedLstat });

test('a machine cloned from this host\'s image, or this drive\'s disk image attached as E:, keeps its serial and its files\' ids — a containment refusal holds for its paths, and no check takes one for the workspace, the database or one of its files: each is refused naming the way out, and the scan reads it', () => {
  const [base, root, dbFile] = ['C:\\ws', 'C:\\ws\\orgs\\beta', 'C:\\ws\\observogram.db'];
  for (const [p, here] of [['\\\\machineb\\C$\\ws', base], ['\\\\machineb\\C$\\', 'C:\\'], ['E:\\ws\\observogram.db', dbFile], ['E:\\', 'C:\\']]) {
    assert.equal(clonedStat(p).ino, clonedStat(here).ino, `the copy keeps the file id: ${p} has ${here}'s`);
    assert.equal(clonedStat(p).dev & 0xffffffffn, clonedStat(here).dev & 0xffffffffn, `and the serial: ${p} reports ${here}'s volume's`);
  }
  assert.notEqual(clonedRealpath.native('E:\\ws\\observogram.db'), clonedRealpath.native(dbFile), 'another file');
  // The in-place export is never taken on a copy: only its file id makes it the workspace. Before, it ran on C:\ws.
  for (const target of ['\\\\machineb\\C$\\ws', '\\\\machineb\\c$\\WS\\', 'E:\\ws', 'e:/WS']) {
    assert.equal(inPlace(target, base, cloned), 'placed', `refused, not the in-place export: ${target}`);
    assert.equal(cloned(target, base), cloned(base), `by its file id alone it was the workspace: ${target}`);
  }
  assert.equal(inPlace('c:/WS', base, cloned), true, 'the way out: the workspace by its own path is the in-place export');
  // With OBSERVOGRAM_DB on a copy and no marker, the scan reads the workspace's own database (store A's, whose store id
  // refuses the export) — before, it skipped it as the database itself — and the no-marker check refuses a database
  // only its file id puts in the workspace.
  for (const path of ['\\\\machineb\\C$\\ws\\observogram.db', 'E:\\ws\\observogram.db']) {
    assert.equal(sameFile(dbFile, path, cloned), false, `read by the scan, not skipped: ${dbFile} beside OBSERVOGRAM_DB=${path}`);
    assert.equal(cloned(dbFile, path), cloned(path), `by its file id alone it was the database: ${dbFile} beside ${path}`);
    assert.equal(dbUnderWorkspace(path, base, cloned), 'placed', `the no-marker check refuses OBSERVOGRAM_DB=${path}`);
  }
  // The backup's and the restore's own-file check: a copy is refused by its file id alone, never called the database
  // itself (before, a restore from last week's E:\ws\observogram.db was, with no way out); a new path under C:\ is the way out.
  for (const [p, s] of [['E:\\ws\\observogram.db', ''], ['\\\\machineb\\C$\\ws\\observogram.db', ''], ['\\\\machineb\\C$\\ws\\observogram.db-wal', '-wal'], ['E:\\ws\\observogram.db-shm', '-shm']]) {
    assert.equal(ownFile(dbFile, p, cloned), `placed${s}`, `refused by its file id alone, not as the database's own: ${p}`);
  }
  assert.equal(cloned('E:\\ws\\observogram.db', dbFile), cloned(dbFile), 'by its file id alone it was the database itself');
  for (const p of ['C:\\restore\\observogram.db', 'C:\\backups\\obs-2026.db']) assert.equal(ownFile(dbFile, p, cloned), null, `the way out, a new path under C:\\: ${p}`);
  // A containment refusal keeps placement — a false refusal is the safe direction, with the ways out it names.
  assert.equal(exportRelation('\\\\machineb\\C$\\ws\\exports\\obs-2026', base, cloned), 'inside', 'a directory export into the copy\'s workspace is refused');
  assert.equal(exportRelation('E:\\ws\\exports\\obs-2026', base, cloned), 'inside', 'on the disk image too');
  assert.equal(usersUnderRoot('\\\\machineb\\C$\\ws\\orgs\\beta\\users.json', root, cloned), true, 'purge-org refuses a users file recorded on the copy');
  assert.equal(exportRelation('\\\\machineb\\C$\\out\\obs-2026', base, cloned), null, 'placed outside the workspace: written');
  // A share of a directory made after cloning: nothing places it, and its serial is the workspace volume's — refused
  // alike. It has no path on this host's drives: the way out that holds is a local directory, copied there by hand.
  assert.equal(exportRelation('\\\\machineb\\exports\\obs-2026', base, cloned), 'unplaced', 'a directory export is refused: no serial tells it from a share of C:\\ws\'s volume');
  assert.equal(inPlace('\\\\machineb\\exports\\obs-2026', base, cloned), false, 'not the in-place export');
  assert.equal(exportRelation('C:\\out\\obs-2026', base, cloned), null, 'the way out: C:\\out\\obs-2026, on a local drive outside the workspace, is written');
  assert.equal(usersUnderRoot('\\\\machineb\\exports\\users.json', root, cloned), 'unplaced', 'purge-org refuses a users file recorded through it (its way out: delete the root by hand)');
  // Its D: has a serial C:\ws's volume does not: an ordinary target for the export.
  assert.equal(exportRelation('\\\\machineb\\dexports\\obs-2026', base, cloned), null, 'written: \\\\machineb\\dexports\\obs-2026');
  assert.equal(usersUnderRoot('\\\\machineb\\dexports\\users.json', root, cloned), 'unplaced', 'purge-org refuses a users file recorded through it, as through any share nothing places');
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
  assert.equal(count(ops, /\bcompared\(/g), 15, 'ops.mjs: the export, in-place, no-marker, other-store and purge checks');
  // A containment refusal places a path beside the one it is checked against, as the predicates above place it, and
  // refuses a null answer before it is compared. A check whose "same" or "inside" answer writes or skips compares by
  // path alone, and refuses a path only placement makes the same (the no-marker check: inside, or null); the scan
  // for another store reads it.
  assert.match(ops, /const t = compared\(into, base\);\s*if \(t === null\) \{[^}]*\}\s*const b = compared\(base\);/, 'exportDirectory');
  assert.match(ops, /const own = compared\(path\);[^]*?if \(compared\(file\) === own\) continue;/, 'assertNoOtherStore');
  assert.match(ops, /const inPlace = compared\(target\) === compared\(base\);\s*if \(!inPlace && compared\(target, base\) === compared\(base\)\) \{/, 'the in-place detection');
  assert.match(ops, /const b = compared\(base\);\s*if \(!compared\(path\)\.startsWith\(b \+ sep\)\) \{\s*const placed = compared\(path, base\);\s*if \(placed === null \|\| placed\.startsWith\(b \+ sep\)\) \{/, 'the no-marker database check');
  assert.match(ops, /const users = [^;]*\? compared\(usersFile, root, \{ deleting: true \}\) : undefined;\s*if \(users === null\) \{[^}]*\}\s*if \(users\?\.startsWith\(compared\(root\) \+ sep\)\)/, 'purge-org\'s users file');
  // Each such refusal names its way out (its message from the guard to the throw's end, the parts joined).
  const joined = (file) => readFileSync(join(HERE, 'store', file), 'utf8');
  const refusal = (raw, guard) => {
    const at = raw.indexOf(`if (${guard}) {`);
    return at < 0 ? '' : raw.slice(at, raw.indexOf(');\n', at)).replace(/[`']\s*\+\s*[`']/g, '');
  };
  const raw = joined('ops.mjs');
  for (const [guard, way] of [
    ['t === null', 'Nothing was changed. Name the directory by its path on a local drive'],
    ['t === null', 'if it has none on this host, export to an empty or new directory on a local drive outside the workspace, then copy that directory to ${target}'],
    ['!inPlace && compared(target, base) === compared(base)', 'only by its file id, not by its path'],
    ['!inPlace && compared(target, base) === compared(base)', 'To export the workspace in place, stop the server and run packc store export ${base}; otherwise choose'],
    ['!inPlace && compared(target, base) === compared(base)', 'Nothing was changed. ${inPlaceWay} an empty or new directory'],
    ['placed === null || placed.startsWith(b + sep)', 'Nothing was changed. Set OBSERVOGRAM_DB to the database\'s path under ${base}, then run the export again'],
    ['users === null', 'nothing was deleted. If it does not lie under'],
    ['users === null', 'by hand, then run purge-org again: it drops org'],
    ['users === null', 'records. If it does, move it out of ${root} first, then do the same'],
  ]) assert.ok(refusal(raw, guard).includes(way), `the refusal of ${guard} names its way out: ${way}`);
  // And purge-org's says why the users file may lie under the root, true of every path compared answers null for: a share
  // no file id places, on any volume, or a path this host cannot fully resolve — through a link or another reparse point
  // whose target cannot be opened, a part it cannot read, or on a volume whose paths do not resolve. The earlier text,
  // naming a share alone, read beside the same way out.
  const why = 'the recorded users file ${usersFile} is not a path on a local drive, or its path cannot be resolved on this host (a link '
    + 'or another reparse point on it whose target cannot be opened, a part of it this host cannot read, or a volume whose paths do not '
    + 'resolve), and such a path, like a network share no file id places beside ${root} (one on any volume, a DFS link, one that cannot '
    + 'be reached), may lead under it — nothing was deleted.';
  assert.ok(refusal(raw, 'users === null').includes(why), `purge-org's refusal says why the users file may lie under the root: ${why}`);
  const backup = code('backup.mjs');
  assert.equal(count(backup, /\bcanonical\(/g), 1, 'backup.mjs: canonical is only defined, and passed to comparedPath');
  assert.match(backup, /const compared = comparedPath\(canonical\);/);
  assert.match(backup, /function ownFile\(dbFile, path, \{ placed = false \} = \{\}\) \{\s*const db = compared\(dbFile\);\s*const p = placed \? compared\(path, dbFile\) : compared\(path\);/, 'ownFile compares by path alone unless it is asked to place');
  assert.match(backup, /const s = ownFile\(dbFile, path\);\s*if \(s === ''\) throw refuse\([^;]*\);\s*if \(s !== null\) throw refuse\([^;]*\);\s*refusePlacedOwnFile\(dbFile, path, way\);/, 'refuseOwnFile: "the database itself" by its path alone, then what only placement makes one of its files');
  assert.match(backup, /const s = ownFile\(dbFile, path, \{ placed: true \}\);\s*if \(s === null\) return;\s*throw refuse\(/, 'refusePlacedOwnFile');
  assert.match(backup, /refuseOwnFile\(source, target, way\);/, 'the backup\'s target');
  assert.match(backup, /if \(ownFile\(source, tmp\) !== null\) throw refuse\([^;]*\);\s*refusePlacedOwnFile\(source, tmp, way\);/, 'the backup\'s temporary file');
  assert.match(backup, /refuseOwnFile\(target, source, `/, 'the restore\'s source');
  const rawBackup = joined('backup.mjs');
  for (const way of [
    'only by its file id, not by its path: it may be that file named through a network share or a mapped drive, or a copy that keeps its file id',
    'Nothing was changed. ${way}',
    'const way = `Back up to a new path under ${parse(source).root}`;',
    'refuseOwnFile(target, source, `If it is a backup, copy it to a new path under ${parse(target).root}, then restore from the copy`);',
  ]) assert.ok(rawBackup.replace(/[`']\s*\+\s*[`']/g, '').includes(way), `backup.mjs names the way out: ${way}`);
});
