// tools/test-journey-scope.mjs — a studio-run journey's org scope (A-24,
// crawlScopeTest in tools/lib/journey.mjs) holds on Windows. NTFS gives one
// file many spellings — another case, another drive-letter case, / for \, a
// short (8.3) name — and JS realpathSync keeps the caller's. Compared by
// spelling, another org's file named in another spelling read as "outside the
// workspace", nobody's part, and an acme journey loaded it. The host is
// injected — Windows' path rules, an NTFS volume's realpath
// (server/fixtures/ntfs.mjs) and the platform — so the proof runs on every
// host. On Linux and macOS the comparison is unchanged: the A-24 cases in
// tools/test-journey.mjs and server/test-tenancy.mjs hold it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { crawlScopeTest } from './lib/journey.mjs';
import { ntfsVolume } from '../server/fixtures/ntfs.mjs';

const VOLUME = ntfsVolume([
  'C:\\ws\\orgs\\acme\\packs\\own.pack.yaml',
  'C:\\ws\\orgs\\acme2\\packs\\a2.pack.yaml',
  'C:\\ws\\orgs\\beta\\packs\\b1.pack.yaml',
  'C:\\ws\\packs\\demo.pack.yaml',
  'C:\\ws2\\packs\\next-door.pack.yaml',
  'C:\\repo\\catalog.pack.yaml',
], { short: { 'C:\\ws': 'WS~1' } });
const WINDOWS = { windows: true, path: win32, realpathSync: VOLUME.realpathSync };
// The comparison this replaces on Windows: the spelling JS realpathSync keeps.
const BY_SPELLING = { windows: false, path: win32, realpathSync: VOLUME.realpathSync };

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
