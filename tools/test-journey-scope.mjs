// tools/test-journey-scope.mjs — a studio-run journey's org scope (A-24,
// crawlScopeRefusal and crawlScopeTest in tools/lib/journey.mjs) holds on
// Windows. NTFS gives one file many spellings — another case, another
// drive-letter case, / for \, a short (8.3) name — and JS realpathSync keeps
// the caller's. Compared by spelling, another org's file named in another
// spelling read as "outside the workspace", nobody's part, and an acme
// journey loaded it. The host is injected — Windows' path rules, an NTFS
// volume's realpath (server/fixtures/ntfs.mjs) and the platform — so the
// proof runs on every host. A network share is one more name: the native
// realpath answers a path reached through one as the share names it, never as
// the volume behind it, so on Windows a path outside the workspace is
// nobody's part only on a local drive — and, while the workspace is itself
// named through a share, only if none of its directories is the workspace's
// own by file id (read through a handle on the volume, as every libuv reports
// it): a share this host serves is stored on a local drive, and its path there
// is one more name for the workspace.
// On Linux and macOS the comparison is
// unchanged: the A-24 cases in tools/test-journey.mjs and
// server/test-tenancy.mjs hold it. The last test runs the default host on a
// real workspace, so the platform's choice of rule is pinned too: the
// expected verdict reads isWin32 (server/fixtures/platform.mjs), and a
// Windows run fails if its default host compared by spelling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { crawlScopeRefusal, crawlScopeTest } from './lib/journey.mjs';
import { ntfsVolume } from '../server/fixtures/ntfs.mjs';
import { isWin32 } from '../server/fixtures/platform.mjs';

const VOLUME = ntfsVolume([
  'C:\\ws\\orgs\\acme\\packs\\own.pack.yaml',
  'C:\\ws\\orgs\\acme2\\packs\\a2.pack.yaml',
  'C:\\ws\\orgs\\beta\\packs\\b1.pack.yaml',
  'C:\\ws\\packs\\demo.pack.yaml',
  'C:\\ws2\\packs\\next-door.pack.yaml',
  'C:\\repo\\catalog.pack.yaml',
], {
  short: { 'C:\\ws': 'WS~1' },
  // The admin share by three names of this host, and a share of the workspace itself; Z: is mapped to it.
  shares: { '\\\\localhost\\C$': 'C:\\', '\\\\127.0.0.1\\C$': 'C:\\', '\\\\myhost.corp.example\\C$': 'C:\\', '\\\\myhost\\ws': 'C:\\ws' },
  mapped: { 'Z:': '\\\\localhost\\C$\\ws' },
});
// A volume's realpath and the handles a file id is read through.
const onVolume = ({ realpathSync, openSync, fstatSync, closeSync }) => ({ path: win32, realpathSync, openSync, fstatSync, closeSync });
const WINDOWS = { windows: true, ...onVolume(VOLUME) };
// The comparison this replaces on Windows: the spelling JS realpathSync keeps.
const BY_SPELLING = { windows: false, ...onVolume(VOLUME) };

const ACME = { base: 'C:\\ws', ownRoot: 'C:\\ws\\orgs\\acme' };
const DEFAULT_ORG = { base: 'C:\\ws', ownRoot: 'C:\\ws' };

// Beta's pack file, spelled every way NTFS opens it.
const BETA_FILE = [
  'C:\\ws\\orgs\\beta\\packs\\b1.pack.yaml',
  'C:\\WS\\orgs\\beta\\packs\\b1.pack.yaml',
  'c:/ws/orgs/beta/packs/b1.pack.yaml',
  'c:\\ws\\orgs\\beta\\packs\\b1.pack.yaml',
  'C:\\WS~1\\orgs\\beta\\packs\\b1.pack.yaml',
  'C:/Ws/ORGS/Beta/packs/B1.PACK.YAML',
];
const ACME_FILE = [
  'C:\\ws\\orgs\\acme\\packs\\own.pack.yaml',
  'C:\\WS\\ORGS\\ACME\\packs\\own.pack.yaml',
  'c:/ws/orgs/acme/packs/own.pack.yaml',
  'C:\\WS~1\\orgs\\acme\\packs\\own.pack.yaml',
];

test('for the workspace C:\\ws, another org\'s file in another case, drive-letter case or by a short name is refused to acme', () => {
  const inScope = crawlScopeTest(ACME, WINDOWS);
  for (const p of BETA_FILE) assert.equal(inScope(p), false, `refused: ${p}`);
  // A crawl root there, a file not written yet (the existing prefix decides), the default org's part, the base itself.
  for (const p of ['C:\\WS\\orgs\\beta', 'c:/ws/orgs/BETA/', 'C:\\WS\\orgs\\beta\\new\\x.pack.yaml', 'C:\\WS~1\\ORGS\\nobody\\x.yaml',
    'C:\\WS\\packs\\demo.pack.yaml', 'c:/ws/packs/demo.pack.yaml', 'C:\\WS~1\\packs\\demo.pack.yaml', 'c:/WS/', 'C:\\WS~1']) {
    assert.equal(inScope(p), false, `refused: ${p}`);
  }
  // By spelling (the comparison before), every spelling but the workspace's own read as outside it.
  const bySpelling = crawlScopeTest(ACME, BY_SPELLING);
  assert.deepEqual(BETA_FILE.map((p) => bySpelling(p)), [false, true, true, true, true, true], 'compared by spelling, the cross-org read passes');
});

test('acme\'s own file in any spelling is still read, and so is a file outside the workspace', () => {
  const inScope = crawlScopeTest(ACME, WINDOWS);
  for (const p of [...ACME_FILE, 'C:\\WS~1\\orgs\\acme', 'c:/ws/orgs/acme/new/x.pack.yaml', 'C:\\repo\\catalog.pack.yaml', 'c:/REPO/Catalog.Pack.Yaml']) {
    assert.equal(inScope(p), true, `read: ${p}`);
  }
});

test('the default org at the base never reads under orgs\\ in any spelling; the rest of the base is its own', () => {
  const inScope = crawlScopeTest(DEFAULT_ORG, WINDOWS);
  for (const p of [...BETA_FILE, ...ACME_FILE, 'C:\\ws\\Orgs', 'C:\\WS~1\\ORGS\\']) assert.equal(inScope(p), false, `refused: ${p}`);
  for (const p of ['C:\\ws\\packs\\demo.pack.yaml', 'c:/WS/Packs/demo.pack.yaml', 'C:\\WS~1\\packs\\demo.pack.yaml', 'c:/ws', 'C:\\repo\\catalog.pack.yaml']) {
    assert.equal(inScope(p), true, `read: ${p}`);
  }
});

test('the workspace itself may be spelled any way: OBSERVOGRAM_WORKSPACE=c:/WS/ or its short name gives the same verdicts', () => {
  for (const scope of [{ base: 'c:/WS/', ownRoot: 'c:/WS/orgs/ACME' }, { base: 'C:\\WS~1', ownRoot: 'C:\\WS~1\\orgs\\acme' }]) {
    const inScope = crawlScopeTest(scope, WINDOWS);
    for (const p of BETA_FILE) assert.equal(inScope(p), false, `${scope.base}: refused: ${p}`);
    for (const p of ACME_FILE) assert.equal(inScope(p), true, `${scope.base}: read: ${p}`);
  }
  const dflt = crawlScopeTest({ base: 'C:\\WS~1', ownRoot: 'c:/ws' }, WINDOWS);
  assert.equal(dflt('C:\\WS\\orgs\\beta\\packs\\b1.pack.yaml'), false, 'the default org named two ways is still the base');
  assert.equal(dflt('C:\\ws\\packs\\demo.pack.yaml'), true);
});

test('a name that only starts like the workspace or the org is not inside it: C:\\ws2 is outside, orgs\\acme2 is another org', () => {
  const inScope = crawlScopeTest(ACME, WINDOWS);
  assert.equal(inScope('C:\\WS2\\packs\\next-door.pack.yaml'), true, 'C:\\ws2 is outside the workspace');
  assert.equal(inScope('c:/ws/ORGS/Acme2/packs/a2.pack.yaml'), false, 'orgs\\acme2 is not acme\'s');
  assert.equal(crawlScopeTest(null, WINDOWS), null, 'no scope is the CLI\'s walk: nothing is tested');
});

test('an org whose directory is not created yet: its own paths in any case are read, another org\'s are refused', () => {
  // Only C:\ws\orgs exists: the rest of each side is appended as written, so the case fold decides.
  const inScope = crawlScopeTest({ base: 'C:\\ws', ownRoot: 'C:\\ws\\orgs\\gamma' }, WINDOWS);
  for (const p of ['C:\\WS\\ORGS\\GAMMA\\packs\\g.pack.yaml', 'c:/ws/orgs/Gamma/x.yaml', 'C:\\WS~1\\orgs\\gamma']) assert.equal(inScope(p), true, `read: ${p}`);
  for (const p of [...BETA_FILE, 'C:\\WS\\ORGS\\DELTA\\x.yaml', 'C:\\WS\\ORGS\\GAMMA2\\x.yaml']) assert.equal(inScope(p), false, `refused: ${p}`);
});

const IN_ANOTHER_ORGS_PART = 'belongs to another org\'s part of the workspace — refused';
const NOT_ON_A_LOCAL_DRIVE = 'is not a path on a local drive, and a network share or a device path may lead into another org\'s part of the workspace — refused; '
  + 'name it by its path on a local drive (copy it there if it has none)';

test('for the workspace C:\\ws, a path reached through a network share is refused — beta\'s file by any name of the share, and acme\'s own; \\\\?\\C:\\ is C:\\', () => {
  // The native realpath keeps the share's name: compared by it alone, beta's file lay outside C:\ws.
  assert.equal(VOLUME.realpathSync.native('//127.0.0.1/c$/WS~1/orgs/beta'), '\\\\127.0.0.1\\C$\\ws\\orgs\\beta');
  assert.equal(VOLUME.realpathSync.native('Z:\\orgs\\beta'), '\\\\localhost\\C$\\ws\\orgs\\beta');
  const betaThroughAShare = [
    '\\\\localhost\\C$\\ws\\orgs\\beta\\packs\\b1.pack.yaml',
    '//127.0.0.1/c$/ws/orgs/beta/packs/b1.pack.yaml',
    '\\\\?\\UNC\\localhost\\C$\\ws\\orgs\\beta',
    '\\\\myhost.corp.example\\c$\\WS~1\\orgs\\beta',
    '\\\\MYHOST\\WS\\orgs\\beta\\packs\\b1.pack.yaml',
    'Z:\\orgs\\beta\\packs\\b1.pack.yaml',
    'z:/ORGS/beta',
    '\\\\elsewhere\\share\\orgs\\beta',   // a share no realpath reaches: its spelling is all there is
  ];
  for (const scope of [ACME, DEFAULT_ORG]) {
    const refusal = crawlScopeRefusal(scope, WINDOWS);
    const inScope = crawlScopeTest(scope, WINDOWS);
    for (const p of [...betaThroughAShare, '\\\\localhost\\C$\\ws\\orgs\\acme\\packs\\own.pack.yaml', 'Z:\\orgs\\acme', '\\\\myhost\\ws\\packs\\demo.pack.yaml', '\\\\localhost\\C$\\repo\\catalog.pack.yaml']) {
      assert.equal(refusal(p), NOT_ON_A_LOCAL_DRIVE, `${scope.ownRoot}: refused, reached through a share: ${p}`);
      assert.equal(inScope(p), false, `${scope.ownRoot}: refused: ${p}`);
    }
  }
  // A device path to a local drive is that drive's path.
  const refusal = crawlScopeRefusal(ACME, WINDOWS);
  for (const p of ['\\\\?\\C:\\ws\\orgs\\beta\\packs\\b1.pack.yaml', '\\\\.\\c:\\WS~1\\orgs\\beta']) assert.equal(refusal(p), IN_ANOTHER_ORGS_PART, `beta's: ${p}`);
  for (const p of ['\\\\?\\C:\\ws\\orgs\\acme\\packs\\own.pack.yaml', '\\\\?\\c:\\repo\\catalog.pack.yaml', 'C:\\repo\\catalog.pack.yaml']) assert.equal(refusal(p), '', `read: ${p}`);
});

test('a workspace named through a share this host serves (\\\\myhost\\ws, Z: mapped to \\\\localhost\\C$\\ws): its path on the local drive is the workspace — beta\'s file there is refused in every spelling, acme\'s own is read', () => {
  // The share and the drive name C:\ws, yet the native realpath keeps their names: by name alone, C:\ws lay outside the
  // workspace. A file's id is the same through every name; through a share the volume's serial is only its low 32 bits.
  assert.equal(VOLUME.realpathSync.native('Z:\\'), '\\\\localhost\\C$\\ws');
  const [local, shared] = [VOLUME.statSync('C:\\WS~1', { bigint: true }), VOLUME.statSync('\\\\myhost\\ws', { bigint: true })];
  assert.equal(local.ino, shared.ino);
  assert.notEqual(local.dev, shared.dev);
  assert.equal(local.dev & 0xffffffffn, shared.dev);
  const noFileId = { ...WINDOWS, openSync: () => { throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }); } };
  for (const [base, ownRoot] of [['\\\\myhost\\ws', '\\\\myhost\\ws\\orgs\\acme'], ['Z:\\', 'Z:\\orgs\\acme'], ['z:/', 'z:/ORGS/Acme'], ['\\\\MYHOST\\WS\\', '//myhost/ws/orgs/acme/']]) {
    const refusal = crawlScopeRefusal({ base, ownRoot }, WINDOWS);
    // Beta's file, a crawl root and a file not written yet there, the default org's part, the workspace itself, orgs\acme2.
    for (const p of [...BETA_FILE, 'c:/WS~1/orgs/beta', 'C:\\WS\\orgs\\beta\\new\\x.pack.yaml', 'C:\\WS~1\\packs\\demo.pack.yaml', 'c:/ws', 'c:/ws/ORGS/Acme2/packs/a2.pack.yaml']) {
      assert.equal(refusal(p), IN_ANOTHER_ORGS_PART, `${base}: not acme's: ${p}`);
    }
    // Acme's own in every spelling, and what lies outside the share's storage: another directory, the drive's root.
    for (const p of [...ACME_FILE, 'c:/ws/orgs/acme/new/x.pack.yaml', 'C:\\repo\\catalog.pack.yaml', 'C:\\WS2\\packs\\next-door.pack.yaml', 'C:\\']) {
      assert.equal(refusal(p), '', `${base}: read: ${p}`);
    }
    // By name alone (no file id: the comparison before), each of beta's local spellings read as outside the workspace.
    const byName = crawlScopeRefusal({ base, ownRoot }, noFileId);
    assert.deepEqual(BETA_FILE.map((p) => byName(p)), BETA_FILE.map(() => ''), `${base}: by name alone, beta's file is read`);
  }
  // The default org: the workspace's local path is its own, never under orgs\.
  const dflt = crawlScopeRefusal({ base: '\\\\myhost\\ws', ownRoot: '\\\\myhost\\ws' }, WINDOWS);
  for (const p of [...BETA_FILE, ...ACME_FILE, 'C:\\ws\\Orgs', 'C:\\WS~1\\ORGS\\']) assert.equal(dflt(p), IN_ANOTHER_ORGS_PART, `refused: ${p}`);
  for (const p of ['C:\\ws\\packs\\demo.pack.yaml', 'c:/WS/Packs/demo.pack.yaml', 'C:\\WS~1', 'C:\\repo\\catalog.pack.yaml']) assert.equal(dflt(p), '', `read: ${p}`);
});

// libuv answers a stat by the path's name (GetFileInformationByName, Windows 11 24H2 and Server 2025) unless the path is
// reached through a share or its last name is a reparse point, which it opens: 1.51.0 and later read all 64 bits of the
// volume's serial by name, 1.49.0 to 1.50.x (Node 22.16.0's 1.49.2) the upper half of the file's 128-bit id — 0 on
// NTFS — while a handle reports the serial's low 32 bits on every one (server/fixtures/ntfs.mjs, fastDev).
const LIBUVS = [['1.51.0', null], ['1.49.2', 0n]];

test('on every libuv a local path is placed in a workspace named through a share by its file id read through a handle — on 1.49.2 a stat by name reports no volume, and acme read beta\'s file on the local drive', () => {
  for (const [libuv, fastDev] of LIBUVS) {
    const volume = ntfsVolume(['C:\\ws\\orgs\\acme\\packs\\own.pack.yaml', 'C:\\ws\\orgs\\beta\\packs\\b1.pack.yaml', 'C:\\repo\\catalog.pack.yaml'], {
      short: { 'C:\\ws': 'WS~1' },
      shares: { '\\\\myhost\\ws': 'C:\\ws', '\\\\localhost\\C$': 'C:\\' },
      mapped: { 'Z:': '\\\\localhost\\C$\\ws' },
      fastDev,
    });
    const serial = (p) => { const fd = volume.openSync(p); try { return volume.fstatSync(fd).dev; } finally { volume.closeSync(fd); } };
    assert.equal(serial('C:\\ws'), serial('\\\\myhost\\ws'), `libuv ${libuv}: through a handle C:\\ws and \\\\myhost\\ws report one serial`);
    assert.equal(volume.statSync('C:\\ws').dev === 0n, fastDev === 0n, `libuv ${libuv}: by name C:\\ws reports ${fastDev === 0n ? 'no volume' : 'its volume'}`);
    // A stat by name is on offer too, so a file id read by name again fails here on 1.49.2 alone.
    const host = { windows: true, ...onVolume(volume), statSync: volume.statSync };
    for (const [base, ownRoot] of [['\\\\myhost\\ws', '\\\\myhost\\ws\\orgs\\acme'], ['Z:\\', 'Z:\\orgs\\acme']]) {
      const refusal = crawlScopeRefusal({ base, ownRoot }, host);
      for (const p of [...BETA_FILE, 'c:/WS~1/orgs/beta', 'C:\\ws\\orgs\\beta\\new\\x.pack.yaml']) {
        assert.equal(refusal(p), IN_ANOTHER_ORGS_PART, `libuv ${libuv}, ${base}: not acme's: ${p}`);
      }
      for (const p of [...ACME_FILE, 'C:\\repo\\catalog.pack.yaml']) assert.equal(refusal(p), '', `libuv ${libuv}, ${base}: read: ${p}`);
    }
    assert.equal(volume.opened(), 0, `libuv ${libuv}: every handle opened is closed`);
  }
});

test('a workspace on a share: its own share name decides as a drive path does, another name of its server is refused, a local drive outside its storage is read', () => {
  // The share's server keeps the workspace at N:\obs on its own disk (the model's volume stands in for it); this host
  // reaches it as \\nas01\obs and by two more names of that server, and maps Y: to it.
  const nas = ntfsVolume([
    'N:\\obs\\orgs\\acme\\packs\\own.pack.yaml',
    'N:\\obs\\orgs\\beta\\packs\\b1.pack.yaml',
    'C:\\repo\\catalog.pack.yaml',
  ], {
    shares: { '\\\\nas01\\obs': 'N:\\obs', '\\\\nas01.corp.example\\obs': 'N:\\obs', '\\\\10.0.0.5\\obs': 'N:\\obs' },
    mapped: { 'Y:': '\\\\nas01\\obs' },
  });
  const host = { windows: true, ...onVolume(nas) };
  const refusal = crawlScopeRefusal({ base: '\\\\nas01\\obs', ownRoot: '\\\\nas01\\obs\\orgs\\acme' }, host);
  // Where this host reaches the share's disk itself (here the model's one volume), N:\obs is one more name of the workspace.
  for (const p of ['\\\\nas01\\obs\\orgs\\beta\\packs\\b1.pack.yaml', '\\\\NAS01\\OBS\\ORGS\\BETA', '//nas01/obs/orgs/beta/', 'Y:\\orgs\\beta\\packs\\b1.pack.yaml',
    'N:\\obs\\orgs\\beta\\packs\\b1.pack.yaml', 'n:/OBS/orgs/beta']) {
    assert.equal(refusal(p), IN_ANOTHER_ORGS_PART, `beta's: ${p}`);
  }
  for (const p of ['\\\\nas01.corp.example\\obs\\orgs\\beta\\packs\\b1.pack.yaml', '//10.0.0.5/obs/orgs/beta', '\\\\nas01.corp.example\\obs\\orgs\\acme\\packs\\own.pack.yaml']) {
    assert.equal(refusal(p), NOT_ON_A_LOCAL_DRIVE, `refused, another name of the share: ${p}`);
  }
  for (const p of ['\\\\nas01\\obs\\orgs\\acme\\packs\\own.pack.yaml', '\\\\NAS01\\obs\\Orgs\\ACME', 'Y:\\orgs\\acme\\packs\\own.pack.yaml', 'n:/OBS/ORGS/acme', 'C:\\repo\\catalog.pack.yaml']) {
    assert.equal(refusal(p), '', `read: ${p}`);
  }
});

test('the default host is this platform\'s rule: under a real workspace, beta\'s file with the workspace spelled in another case is refused to acme on Windows, and elsewhere names another path, outside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'observogram-scope-'));
  try {
    const base = join(dir, 'ws');
    const betaFile = join(base, 'orgs', 'beta', 'packs', 'b1.pack.yaml');
    mkdirSync(dirname(betaFile), { recursive: true });
    mkdirSync(join(base, 'orgs', 'acme'));
    writeFileSync(betaFile, '');
    const refusal = crawlScopeRefusal({ base, ownRoot: join(base, 'orgs', 'acme') });
    assert.equal(refusal(betaFile), IN_ANOTHER_ORGS_PART, `beta's as written, on every platform: ${betaFile}`);
    // On NTFS this is beta's file; off Windows the comparison is the realpath's spelling, and this one lies outside the workspace.
    const otherCase = join(dir, 'WS', 'orgs', 'beta', 'packs', 'b1.pack.yaml');
    assert.equal(refusal(otherCase), isWin32 ? IN_ANOTHER_ORGS_PART : '', `the default host compares as this platform names paths: ${otherCase}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
