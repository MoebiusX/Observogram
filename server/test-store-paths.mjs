#!/usr/bin/env node
/**
 * server/test-store-paths.mjs — the store's offline operations compare paths
 * as Windows names them (server/store/paths.mjs). On NTFS one file has many
 * spellings — another case, another drive-letter case, / for \, a short
 * (8.3) name — and JS realpathSync keeps the caller's, so a spelling
 * comparison let a directory export write into the workspace, missed the
 * workspace itself (the in-place export) and the database under it, let
 * purge-org delete the users file under the root it purged, and let a backup
 * be written over the database's own -wal. Each check's predicate is run
 * here as ops.mjs and backup.mjs run it, over comparedPath with an injected
 * host — Windows' path rules, an NTFS volume's realpath
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
const key = comparedPath(null, { windows: true, path: win32, realpathSync: VOLUME.realpathSync });
const SEP = '\\';
// The comparison this replaces on Windows: ops.mjs's realOr, the spelling JS realpathSync keeps.
const bySpelling = (p) => { try { return VOLUME.realpathSync(p); } catch { return win32.resolve(p); } };

// The checks' predicates, as server/store/ops.mjs and backup.mjs write them over their compared form.
function exportRelation(into, base, k = key) {   // exportDirectory: 'is' | 'inside' | 'holds' | null (null: written)
  const t = k(into);
  const b = k(base);
  const inside = t.startsWith(b + SEP);
  if (t === b || inside || b.startsWith(t.endsWith(SEP) ? t : t + SEP)) return t === b ? 'is' : inside ? 'inside' : 'holds';
  return null;
}
const inPlace = (target, base, k = key) => k(target) === k(base);                    // exportStore
const dbUnderWorkspace = (path, base, k = key) => k(path).startsWith(k(base) + SEP);    // exportStore, no marker
const rootUnderOrgs = (root, base, k = key) => k(root).startsWith(k(win32.join(base, 'orgs')) + SEP);   // purgeOrg
const usersUnderRoot = (usersFile, root, k = key) => k(usersFile).startsWith(k(root) + SEP);           // purgeOrg
const ownFile = (dbFile, path, k = key) => ['', '-wal', '-shm', '-journal'].find((s) => k(path) === `${k(dbFile)}${s}`) ?? null;   // backup.mjs

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
  const backup = code('backup.mjs');
  assert.equal(count(backup, /\bcanonical\(/g), 1, 'backup.mjs: canonical is only defined, and passed to comparedPath');
  assert.match(backup, /const compared = comparedPath\(canonical\);/);
  assert.match(backup, /const db = compared\(dbFile\);\s*const p = compared\(path\);/, 'ownFile compares through compared');
});
