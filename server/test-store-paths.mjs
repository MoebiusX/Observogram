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
 * or database (\\localhost\C$\ws\…). Each check's predicate is run
 * here as ops.mjs and backup.mjs run it, over comparedPath with an injected
 * host — Windows' path rules, an NTFS volume's realpath and statSync
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
// two names of this host, and another directory (\\myhost\out). \\nas01\obs is a share this host does not serve.
const SHARED = ntfsVolume([
  'C:\\ws\\observogram.db',
  'C:\\ws\\exports\\keep.txt',
  'C:\\ws\\orgs\\beta\\users.json',
  'C:\\ws\\orgs\\beta2\\users.json',
  'C:\\ws2\\observogram.db',
  'C:\\out\\x.txt',
], {
  short: { 'C:\\ws': 'WS~1' },
  shares: { '\\\\myhost\\ws': 'C:\\ws', '\\\\localhost\\C$': 'C:\\', '\\\\127.0.0.1\\C$': 'C:\\', '\\\\myhost\\out': 'C:\\out' },
  mapped: { 'Z:': '\\\\myhost\\ws' },
});
const shared = comparedPath(null, { windows: true, path: win32, realpathSync: SHARED.realpathSync, statSync: SHARED.statSync });
// The native realpath alone, with no file ids: a share keeps its own name, and C:\ws is not \\myhost\ws.
const byName = comparedPath(null, { windows: true, path: win32, realpathSync: SHARED.realpathSync, statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } });

// The checks' predicates, as server/store/ops.mjs and backup.mjs write them over their compared form: a path
// is compared placed beside the one it is checked against (the second argument).
function exportRelation(into, base, k = key) {   // exportDirectory: 'is' | 'inside' | 'holds' | null (null: written)
  const t = k(into, base);
  const b = k(base);
  const inside = t.startsWith(b + SEP);
  if (t === b || inside || b.startsWith(t.endsWith(SEP) ? t : t + SEP)) return t === b ? 'is' : inside ? 'inside' : 'holds';
  return null;
}
const inPlace = (target, base, k = key) => k(target, base) === k(base);                       // exportStore
const sameFile = (file, path, k = key) => k(file, path) === k(path);                          // assertNoOtherStore
const dbUnderWorkspace = (path, base, k = key) => k(path, base).startsWith(k(base) + SEP);     // exportStore, no marker
const rootUnderOrgs = (root, base, k = key) => k(root).startsWith(k(win32.join(base, 'orgs')) + SEP);   // purgeOrg
const usersUnderRoot = (usersFile, root, k = key) => k(usersFile, root).startsWith(k(root) + SEP);     // purgeOrg
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

test('with the workspace and the database on the drive (C:\\ws), a share name the admin gives for them is them; a share of another directory, or one this host does not serve, is an ordinary target', () => {
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
  // Each path is placed beside the one it is checked against, as the predicates above place it.
  assert.match(ops, /const t = compared\(into, base\);\s*const b = compared\(base\);/, 'exportDirectory');
  assert.match(ops, /compared\(file, path\) === own/, 'assertNoOtherStore');
  assert.match(ops, /const inPlace = compared\(target, base\) === compared\(base\);/, 'the in-place detection');
  assert.match(ops, /const own = compared\(path, base\);\s*const b = compared\(base\);/, 'the no-marker database check');
  assert.match(ops, /compared\(usersFile, root\)\.startsWith\(compared\(root\) \+ sep\)/, 'purge-org\'s users file');
  const backup = code('backup.mjs');
  assert.equal(count(backup, /\bcanonical\(/g), 1, 'backup.mjs: canonical is only defined, and passed to comparedPath');
  assert.match(backup, /const compared = comparedPath\(canonical\);/);
  assert.match(backup, /const db = compared\(dbFile\);\s*const p = compared\(path, dbFile\);/, 'ownFile compares through compared');
});
