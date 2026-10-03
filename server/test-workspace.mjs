#!/usr/bin/env node
/**
 * server/test-workspace.mjs
 *
 * Unit test for the pack registry over files and rows (server/pack-registry.mjs
 * over server/workspace.mjs and the store; STORE_PLAN slice 4) and the
 * file-backed deploy audit, snapshots and live pack (server/workspace.mjs).
 * Exercises the full lifecycle against a temp directory and a temp store:
 * register → rehydrate round-trip (YAML fidelity on a representative
 * canonical), the rows and their audit, orphan-file adoption, the prune of a
 * row whose file is gone (positive evidence only), the debounced touch, the
 * quick-start dedup, the file order on a failed register, and clear. Exit 0
 * = pass.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, report } = createHarness();

// Point the workspace at a fresh temp dir BEFORE first use — resolution is
// lazy by design, exactly so tests can do this.
const TMP = mkdtempSync(join(tmpdir(), 'observogram-ws-'));
process.env.OBSERVOGRAM_WORKSPACE = TMP;
delete process.env.TOMOGRAPH_WORKSPACE;
// Tenancy is always on (docs/STORE_PLAN.md slice 2): the workspace root is
// the org's root from the store, so the suite runs inside the default org
// at '.'. It re-points its workspace below (TMP2, TMP3), so the store is
// PINNED to a temp file of its own, outside every workspace it points at
// (deleting OBSERVOGRAM_DB would look for <TMP2>/observogram.db, never
// opened) — as hermetic as deleting it. '.' resolves against whatever base
// the env names at each call.
const DB_DIR = mkdtempSync(join(tmpdir(), 'observogram-ws-db-'));
const DB_PATH = join(DB_DIR, 'observogram.db');
process.env.OBSERVOGRAM_DB = DB_PATH;
for (const k of ['BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH']) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
delete process.env.TOMOGRAPH_DB;

const {
  saveWorkspacePack, deleteWorkspacePack, listPackFiles, readPackFile, packFileStat, workspaceInfo,
  appendDeployRecord, appendDeployVerify, readDeployRecords,
  saveDeploySnapshot, readDeploySnapshot,
  livePackPath, writeLivePack, readLivePack,
} = await import('./workspace.mjs');
const {
  registerPack, loadPacks, clearPacks, touchPack, flushPackTouches, resetPackRegistry, uploadsMap, packIdOf, MAX_UPLOADS,
} = await import('./pack-registry.mjs');
const { openStore, execScript } = await import('./store/db.mjs');
const { createOrg } = await import('./store/orgs.mjs');
const { addPack, getPack, listPacks, removePack } = await import('./store/packs.mjs');
const { listServices } = await import('./store/services.mjs');
const { listServicesForPack } = await import('./store/pack-services.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { runWithOrg } = await import('./tenancy.mjs');

const db = await openStore();
createOrg(db, 'test', { id: 'default', name: 'Default', root: '.' });
const actions = (sinceSeq = 0) => listAudit(db, { orgId: 'default', limit: 1000 }).filter((r) => r.seq > sinceSeq).reverse().map((r) => [r.action, r.actor, r.targetId, r.detail]);
const lastSeq = () => listAudit(db, { orgId: 'default', limit: 1 })[0]?.seq ?? 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let outsideThrew = false;
try { workspaceInfo(); } catch { outsideThrew = true; }
assert(outsideThrew, 'workspaceInfo() outside an org context throws');
let adoptThrew = false;
try { loadPacks(db); } catch { adoptThrew = true; }
assert(adoptThrew, 'loadPacks() outside an org context throws (fails closed)');

try {
  await runWithOrg('default', async () => {
  // A representative canonical: nested objects, arrays, numbers, booleans,
  // multi-word strings — the shapes a real pack exercises in YAML round-trip.
  const canonical = {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: { name: 'ws-test', version: '1.2.3', owners: ['team-a', 'team-b'], bindings: { service: 'ws-test', environments: ['prod'] } },
    spec: {
      slis: [{ id: 'avail', type: 'ratio', good: 'sum(rate(ok[5m]))', total: 'sum(rate(all[5m]))' }],
      slos: [{ id: 'avail_99', sli: 'avail', objective: 0.99, window: '30d' }],
      otel: { semconv: '1.27.0', sdk: { sampling: { ratio: 0.1 } } },
      flagish: { enabled: true, count: 42 },
    },
  };
  const two = { ...canonical, metadata: { ...canonical.metadata, name: 'ws-two', bindings: { service: 'ws-two' } } };

  assert(workspaceInfo().root.startsWith(TMP), 'workspace resolves under the temp dir', workspaceInfo().root, TMP);
  assert(same(listPackFiles(), { ids: [] }) && !existsSync(join(TMP, 'packs')), 'listPackFiles() on an absent packs/ is { ids: [] } and makes no directory');
  assert(same(loadPacks(db), []) && !existsSync(join(TMP, 'packs')), 'the rehydrate of an empty org is read-only: no packs/ directory');

  // --- register + rehydrate round-trip ---
  const seq0 = lastSeq();
  const id1 = registerPack(db, 'unit', { canonical, label: 'WS Test', source: 'unit' });
  const id2 = registerPack(db, 'unit', { canonical: two, label: 'WS Two', source: 'unit' });
  assert(id1 === packIdOf(canonical, 'unit') && id1.startsWith('uploaded-ws-test-') && id2.startsWith('uploaded-ws-two-'), 'ids are minted from the name and the content hash', [id1, id2]);
  let rows = listPacks(db);
  assert(rows.length === 2, 'two registered packs are two rows', rows.length, 2);
  const r1 = rows.find((p) => p.id === id1);
  assert(r1.label === 'WS Test' && r1.source === 'unit' && /^\d{4}-.*Z$/.test(r1.createdAt) && r1.lastUsedAt === r1.createdAt, 'the row carries label, source and ISO times', r1);
  assert(same(actions(seq0), [
    ['pack.register', 'unit', id1, { label: 'WS Test', source: 'unit' }],
    ['service.create', 'unit', 'ws-test', { via: 'register', pack: id1 }],
    ['environment.create', 'unit', 'ws-test/prod', { via: 'register', pack: id1 }],
    ['pack.link', 'unit', id1, { service: 'ws-test', role: 'primary' }],
    ['pack.register', 'unit', id2, { label: 'WS Two', source: 'unit' }],
    ['service.create', 'unit', 'ws-two', { via: 'register', pack: id2 }],
    ['pack.link', 'unit', id2, { service: 'ws-two', role: 'primary' }],
  ]), 'a register writes the pack row, the service and environment rows it names and the link, by its actor', actions(seq0));
  resetPackRegistry();
  let packs = loadPacks(db);
  assert(packs.length === 2, 'two registered packs load back', packs.length, 2);
  const p1 = packs.find(p => p.id === id1);
  assert(!!p1, 'pack id round-trips via filename');
  assert(p1.label === 'WS Test' && p1.source === 'unit', 'the row\'s metadata round-trips', { label: p1.label, source: p1.source }, { label: 'WS Test', source: 'unit' });
  assert(JSON.stringify(p1.canonical) === JSON.stringify(canonical),
         'canonical round-trips through YAML byte-equivalently (JSON view)');
  assert(p1.canonical.spec.slos[0].objective === 0.99, 'numbers survive round-trip', p1.canonical.spec.slos[0].objective, 0.99);
  assert(p1.canonical.spec.flagish.enabled === true, 'booleans survive round-trip');
  assert(actions(seq0).length === 7, 'a rehydrate of packs that have rows writes nothing (no re-link by system)');

  // Files are inspectable YAML on disk; no index.json any more.
  const files = readdirSync(join(TMP, 'packs')).filter(f => f.endsWith('.pack.yaml'));
  assert(files.length === 2, 'one .pack.yaml per pack on disk', files.length, 2);
  assert(!existsSync(join(TMP, 'packs', 'index.json')), 'no index.json is written: the registry is the packs table');
  assert(same(listPackFiles(), { ids: [id1, id2].sort() }), 'listPackFiles() lists the ids', listPackFiles());
  assert(readPackFile(id1).raw.includes('ws-test') && readPackFile('nope') === null && typeof packFileStat(id1).mtimeMs === 'number' && packFileStat('nope') === null, 'readPackFile / packFileStat: present vs ENOENT');

  // --- the same content again: the same id, a touch, no new row ---
  const seq1 = lastSeq();
  assert(registerPack(db, 'unit', { canonical, label: 'WS Test', source: 'unit' }) === id1, 're-registering the same content keeps its id');
  assert(actions(seq1).length === 0, 'an unchanged re-register writes no audit row');
  assert(registerPack(db, 'unit', { canonical, label: 'WS Test', source: 'another-hint' }) === id1, 'the same content under another source hint keeps its id');
  assert(same(actions(seq1), [['pack.update', 'unit', id1, { fields: ['source'] }]]), 'but records the field that changed', actions(seq1));
  assert(getPack(db, id1).source === 'another-hint', 'the row follows');

  // --- touch reorders retention (oldest lastUsedAt first), debounced, audit-free ---
  const seq2 = lastSeq();
  const before1 = getPack(db, id1).lastUsedAt;
  await new Promise((r) => setTimeout(r, 5));
  touchPack(db, id1);
  touchPack(db, id1);
  assert(getPack(db, id1).lastUsedAt === before1, 'a touch is debounced: nothing written yet');
  flushPackTouches();
  assert(getPack(db, id1).lastUsedAt > before1, 'flushPackTouches() lands the touch', [getPack(db, id1).lastUsedAt, before1]);
  assert(actions(seq2).length === 0, 'a touch writes no audit row (bookkeeping)');
  packs = loadPacks(db);
  assert(packs[packs.length - 1].id === id1, 'touched pack sorts newest (last) in lastUsedAt order', packs[packs.length - 1].id, id1);

  // --- a row whose file is gone is pruned (positive evidence), by system ---
  deleteWorkspacePack(id2);
  packs = loadPacks(db);
  assert(packs.length === 1 && packs[0].id === id1, 'the prune removes exactly the one pack', packs.map(p => p.id), [id1]);
  assert(getPack(db, id2) === null, 'its row is gone');
  assert(same(actions(seq2), [['pack.remove', 'system', id2, { reason: 'file gone' }]]), 'the prune is a pack.remove by system', actions(seq2));
  assert(listServices(db).map((s) => s.slug).join() === 'ws-test,ws-two', 'the service it named stays: a service without a pack exists');

  // --- orphan file adoption (hand-copied pack, no row) ---
  const seq3 = lastSeq();
  writeFileSync(join(TMP, 'packs', 'uploaded-orphan-cccc3333.pack.yaml'),
    'apiVersion: observability.platform/v1\nkind: ObservabilityPack\nmetadata:\n  name: orphan\n  bindings:\n    service: orphan\n');
  packs = loadPacks(db);
  const orphan = packs.find(p => p.id === 'uploaded-orphan-cccc3333');
  assert(!!orphan, 'orphan pack file is adopted on load');
  assert(orphan?.source === 'workspace' && orphan?.label === null, 'adopted orphan gets workspace source and no label', [orphan?.source, orphan?.label]);
  assert(orphan?.canonical?.metadata?.name === 'orphan', 'orphan canonical parses');
  const mtime = new Date(packFileStat('uploaded-orphan-cccc3333').mtimeMs).toISOString();
  assert(getPack(db, 'uploaded-orphan-cccc3333').createdAt === mtime, 'adopted at the file\'s mtime', getPack(db, 'uploaded-orphan-cccc3333').createdAt, mtime);
  assert(same(actions(seq3), [
    ['pack.register', 'system', 'uploaded-orphan-cccc3333', { label: null, source: 'workspace', adopted: true }],
    ['service.create', 'system', 'orphan', { via: 'adopt', pack: 'uploaded-orphan-cccc3333' }],
    ['pack.link', 'system', 'uploaded-orphan-cccc3333', { service: 'orphan', role: 'primary' }],
  ]), 'an adoption is a pack.register { adopted } by system, with the rows a register would have written', actions(seq3));
  assert(loadPacks(db).length === 2 && actions(seq3).length === 3, 'a second rehydrate adopts nothing again');

  // --- dangling row (file vanished) is pruned ---
  rmSync(join(TMP, 'packs', 'uploaded-orphan-cccc3333.pack.yaml'), { force: true });
  packs = loadPacks(db);
  assert(!packs.find(p => p.id === 'uploaded-orphan-cccc3333') && getPack(db, 'uploaded-orphan-cccc3333') === null, 'a row without a file is pruned');

  // --- unparseable pack file is skipped, not fatal; its row is adopted, with no services ---
  const seq4 = lastSeq();
  writeFileSync(join(TMP, 'packs', 'uploaded-broken-dddd4444.pack.yaml'), '{{{{ not yaml at all: [');
  packs = loadPacks(db);
  assert(!packs.find(p => p.id === 'uploaded-broken-dddd4444'), 'unparseable pack file is not served');
  assert(getPack(db, 'uploaded-broken-dddd4444')?.source === 'workspace' && same(listServicesForPack(db, 'uploaded-broken-dddd4444'), []), 'but it is a pack: a row, no service links');
  assert(same(actions(seq4).map((a) => a[0]), ['pack.register']), 'one row for it', actions(seq4));
  deleteWorkspacePack('uploaded-broken-dddd4444');
  loadPacks(db);
  assert(getPack(db, 'uploaded-broken-dddd4444') === null, 'its file gone, its row is pruned');

  // --- REGRESSION (2026-06-11 empty-catalog incident) ---
  // A pack file that exists but is unreadable/corrupt must NOT lose its
  // row. Before the fix, any pack skipped during load was treated like a
  // vanished file: its entry was pruned, and the pack later came back as
  // an orphan with label/source/createdAt re-minted from mtime.
  const keep = registerPack(db, 'unit', { canonical: { ...canonical, metadata: { ...canonical.metadata, name: 'keep-me' } }, label: 'Keep Me', source: 'unit' });
  const keepRow = getPack(db, keep);
  const corruptPath = join(TMP, 'packs', `${keep}.pack.yaml`);
  const goodYaml = readFileSync(corruptPath, 'utf8');
  writeFileSync(corruptPath, '{{{{ torn write [');
  const seq5 = lastSeq();
  packs = loadPacks(db);
  assert(!packs.find(p => p.id === keep), 'corrupt pack is not served');
  assert(getPack(db, keep)?.label === 'Keep Me', 'corrupt pack KEEPS its row — unreadable is not absent', getPack(db, keep)?.label, 'Keep Me');
  assert(actions(seq5).length === 0, 'and nothing is written for it');
  writeFileSync(corruptPath, goodYaml);
  packs = loadPacks(db);
  const recovered = packs.find(p => p.id === keep);
  assert(recovered?.label === 'Keep Me' && recovered?.createdAt === keepRow.createdAt,
         'recovered pack file rejoins with its ORIGINAL metadata (no orphan re-adoption)',
         { label: recovered?.label, createdAt: recovered?.createdAt }, { label: 'Keep Me', createdAt: keepRow.createdAt });

  // A row another process inserted (a direct addPack) loads with its label —
  // the rows are the registry of record, not this process's memory.
  const seq6 = lastSeq();
  writeFileSync(join(TMP, 'packs', 'uploaded-foreign-ffff7777.pack.yaml'),
    'apiVersion: observability.platform/v1\nkind: ObservabilityPack\nmetadata:\n  name: foreign\n');
  addPack(db, 'other-process', { id: 'uploaded-foreign-ffff7777', label: 'Foreign', source: 'other-process' });
  packs = loadPacks(db);
  assert(packs.find(p => p.id === 'uploaded-foreign-ffff7777')?.label === 'Foreign', 'a row inserted by another process loads with its own metadata, not orphan-adopted');
  assert(same(actions(seq6).map((a) => a[0]), ['pack.register']), 'the direct insert is the only row written', actions(seq6));
  // A row removed while its file stays: the file is adopted again (source workspace) — a store with no row for a file adopts it.
  removePack(db, 'other-process', 'uploaded-foreign-ffff7777');
  packs = loadPacks(db);
  assert(packs.find(p => p.id === 'uploaded-foreign-ffff7777')?.source === 'workspace', 'a file with no row is adopted');
  deleteWorkspacePack('uploaded-foreign-ffff7777');
  loadPacks(db);

  // Atomic replace: no staging files left behind by pack writes.
  const tmpDroppings = readdirSync(join(TMP, 'packs')).filter(f => f.includes('.tmp'));
  assert(tmpDroppings.length === 0, 'no .tmp staging files left behind by atomic writes', tmpDroppings, []);

  // --- the quick-start dedup: the same label on new content replaces the old pack ---
  const seq7 = lastSeq();
  const scanA = registerPack(db, 'unit', { canonical: { ...canonical, metadata: { ...canonical.metadata, name: 'scan-a' } }, label: 'KrystalineX (scanned)', source: 'KrystalineX (scanned)' });
  const scanB = registerPack(db, 'unit', { canonical: { ...canonical, metadata: { ...canonical.metadata, name: 'scan-b' } }, label: 'KrystalineX (scanned)', source: 'KrystalineX (scanned)' });
  assert(scanA !== scanB && getPack(db, scanA) === null && !existsSync(join(TMP, 'packs', `${scanA}.pack.yaml`)) && !uploadsMap(db).has(scanA),
    'the older pack with the same label is replaced: row, file and map entry gone');
  assert(same(actions(seq7).filter((a) => a[0] === 'pack.replace'), [['pack.replace', 'unit', scanA, { label: 'KrystalineX (scanned)', replacedBy: scanB }]]),
    'the replacement is a pack.replace row naming the new id', actions(seq7));
  assert(actions(seq7).findIndex((a) => a[0] === 'pack.replace') < actions(seq7).findIndex((a) => a[0] === 'pack.register' && a[2] === scanB), 'pack.replace before pack.register: the audit reads in order');

  // --- the clamp: a 201-character label is cut, never refused; the dedup compares the cut label ---
  const long = `L${'x'.repeat(250)}`;
  const longA = registerPack(db, 'unit', { canonical: { ...canonical, metadata: { ...canonical.metadata, name: 'long-a' } }, label: long, source: `library:${'y'.repeat(300)}` });
  assert(getPack(db, longA).label === long.slice(0, 200) && getPack(db, longA).source.length === 200, 'label and source cut to 200');
  const longB = registerPack(db, 'unit', { canonical: { ...canonical, metadata: { ...canonical.metadata, name: 'long-b' } }, label: `${long}zzz`, source: 'unit' });
  assert(getPack(db, longA) === null && getPack(db, longB).label === long.slice(0, 200), 'two labels equal after the cut dedup as one');

  // --- the file order (A12): the new file first, the replaced one deleted, THEN the rows ---
  // The rows are made to fail under the register (a trigger on this test
  // store aborts the new row's INSERT, as a crash between the files and the
  // commit would): the files are already in their final state, the rows
  // unchanged — and the next rehydrate prunes the replaced row and adopts
  // the new file ONCE, with no duplicate labelled pack.
  const crashC = { ...canonical, metadata: { ...canonical.metadata, name: 'scan-c' } };
  const scanC = packIdOf(crashC, 'KrystalineX (scanned)');
  execScript(db, `CREATE TRIGGER ws_crash BEFORE INSERT ON packs WHEN NEW.id = '${scanC}' BEGIN SELECT RAISE(ABORT, 'simulated crash between the files and the rows'); END`);
  let failed = null;
  try { registerPack(db, 'unit', { canonical: crashC, label: 'KrystalineX (scanned)', source: 'KrystalineX (scanned)' }); } catch (e) { failed = e; }
  execScript(db, 'DROP TRIGGER ws_crash');
  assert(failed !== null && /simulated crash/.test(failed.message), 'a register whose rows cannot be written throws', failed?.message);
  assert(existsSync(join(TMP, 'packs', `${scanC}.pack.yaml`)) && !existsSync(join(TMP, 'packs', `${scanB}.pack.yaml`)), 'the new file is there, the replaced file is gone', [existsSync(join(TMP, 'packs', `${scanC}.pack.yaml`)), existsSync(join(TMP, 'packs', `${scanB}.pack.yaml`))]);
  assert(getPack(db, scanB)?.label === 'KrystalineX (scanned)' && getPack(db, scanC) === null, 'the rows are unchanged (the replaced row stays, the new has none)');
  assert(uploadsMap(db).has(scanB) && !uploadsMap(db).has(scanC), 'and so is the map');
  const seq8 = lastSeq();
  resetPackRegistry();
  packs = loadPacks(db);
  const labelled = packs.filter((p) => p.label === 'KrystalineX (scanned)');
  assert(labelled.length === 0 && packs.filter((p) => p.id === scanC).length === 1 && getPack(db, scanC)?.source === 'workspace', 'the next rehydrate prunes the replaced row and adopts the new file once, unlabelled — never a duplicate labelled pack', packs.map((p) => [p.id, p.label]));
  assert(same(actions(seq8).filter((a) => a[0].startsWith('pack.')).map((a) => [a[0], a[2]]), [['pack.register', scanC], ['pack.link', scanC], ['pack.remove', scanB]]), 'one adoption for the new file, pack.remove { file gone } for the replaced row', actions(seq8));
  assert(loadPacks(db).length === packs.length, 'and the rehydrate after that writes nothing');

  // --- the cap: the oldest pack is evicted, row and file ---
  const evictedId = packs[0].id;
  for (let i = packs.length; i < MAX_UPLOADS; i++) registerPack(db, 'unit', { canonical: { ...canonical, metadata: { ...canonical.metadata, name: `fill-${i}` } }, source: 'fill' });
  assert(listPacks(db).length === MAX_UPLOADS && getPack(db, evictedId) !== null, 'at the cap nothing is evicted yet', listPacks(db).length, MAX_UPLOADS);
  const seq9 = lastSeq();
  registerPack(db, 'unit', { canonical: { ...canonical, metadata: { ...canonical.metadata, name: 'one-too-many' } }, source: 'fill' });
  assert(listPacks(db).length === MAX_UPLOADS && getPack(db, evictedId) === null && !existsSync(join(TMP, 'packs', `${evictedId}.pack.yaml`)), 'beyond the cap the oldest goes: row and file');
  assert(same(actions(seq9).filter((a) => a[0] === 'pack.evict'), [['pack.evict', 'unit', evictedId, { cap: MAX_UPLOADS }]]), 'as a pack.evict row', actions(seq9));

  // --- deploy audit (10C): append-only JSONL, merge-at-read ---
  appendDeployRecord({ deployId: 'dep_t1', at: '2026-06-10T01:00:00Z', actor: 'local',
    pack: { id: 'uploaded-ws-test-aaaa1111', version: '1.2.3', contentHash: 'aaaa1111' },
    env: 'prod', mcpUrl: 'https://mcp.example/x', target: { product: 'grafana', version: '12', folder: null },
    mode: 'upsert', dryRun: false,
    items: [{ group: 'rules', artifact: 'all', ok: true, tool: 't', operations: 3, bytes: 100, tookMs: 5 }],
    summary: { total: 1, ok: 1, failed: 0 }, tookMs: 5 });
  appendDeployRecord({ deployId: 'dep_t2', at: '2026-06-10T02:00:00Z', actor: 'local',
    pack: { id: 'uploaded-other-ffff9999', version: '0.1.0', contentHash: 'ffff9999' },
    env: null, mcpUrl: 'https://mcp.example/y', target: { product: 'grafana', version: '13', folder: 'obs' },
    mode: 'upsert', dryRun: true, items: [], summary: { total: 0, ok: 0, failed: 0 }, tookMs: 1 });

  let recs = readDeployRecords();
  assert(recs.length === 2, 'two deploy records read back', recs.length, 2);
  assert(recs[0].deployId === 'dep_t2', 'records come back newest first', recs[0].deployId, 'dep_t2');
  assert(recs[0].dryRun === true, 'dry runs are audited too');
  assert(recs[1].items[0].operations === 3, 'item detail round-trips');

  recs = readDeployRecords({ packId: 'uploaded-ws-test-aaaa1111' });
  assert(recs.length === 1 && recs[0].deployId === 'dep_t1', '?pack filter scopes to one pack', recs.map(r => r.deployId), ['dep_t1']);

  // Verify write-back (item 9's contract): a later verify record merges into
  // its deploy at read time — the deploy line itself is never rewritten.
  appendDeployVerify('dep_t1', { outcome: 'verified', transitions: { aligned: 1, pending: 0 } });
  recs = readDeployRecords({ packId: 'uploaded-ws-test-aaaa1111' });
  assert(recs[0].verify?.outcome === 'verified', 'verify record merges into its deploy at read time');
  assert(recs[0].verify?.transitions?.aligned === 1, 'verify payload round-trips');

  // Torn/garbage line is skipped, not fatal.
  appendFileSync(join(TMP, 'deploys.jsonl'), '{"type":"deploy","deployId":"dep_torn"');
  recs = readDeployRecords();
  assert(recs.length === 2 && !recs.find(r => r.deployId === 'dep_torn'), 'torn JSONL line is skipped');

  // limit caps the result set (newest kept).
  recs = readDeployRecords({ limit: 1 });
  assert(recs.length === 1 && recs[0].deployId === 'dep_t2', 'limit keeps the newest record');

  // --- pre-deploy snapshots (10D) ---
  const snapMeta = { deployId: 'dep_snap1', at: '2026-06-10T03:00:00Z', folder: 'obs', status: 'captured',
    items: [{ ref: 'payment-overview', kind: 'dashboard', preState: 'captured', file: 'dashboard-payment-overview', restore: 'redeploy' }] };
  saveDeploySnapshot('dep_snap1', snapMeta, { 'dashboard-payment-overview': { dashboard: { uid: 'payment-overview', title: 'Pay' } } });
  const snap = readDeploySnapshot('dep_snap1');
  assert(snap?.meta?.status === 'captured', 'snapshot meta round-trips');
  assert(snap.readFile('dashboard-payment-overview')?.dashboard?.title === 'Pay', 'snapshot file round-trips');
  assert(snap.readFile('no-such-file') === null, 'missing snapshot file reads as null, never throws');
  assert(readDeploySnapshot('dep_never-happened') === null, 'unknown deployId has no snapshot');
  saveDeploySnapshot('../escape', { status: 'x' }, {});
  assert(!existsSync(join(TMP, 'escape')) && existsSync(join(TMP, 'snapshots', 'escape', 'meta.json')),
         'path-traversal snapshot ids are sanitized inside the workspace');

  // --- clear wipes packs (rows, links, files) but NEVER the audit log, nor the services ---
  const servicesBefore = listServices(db).map((s) => s.slug);
  const seq10 = lastSeq();
  const dropped = clearPacks(db, 'unit');
  assert(dropped === MAX_UPLOADS, 'clear reports the rows dropped', dropped, MAX_UPLOADS);
  assert(loadPacks(db).length === 0 && listPacks(db).length === 0 && readdirSync(join(TMP, 'packs')).filter(f => f.endsWith('.pack.yaml')).length === 0, 'workspace is empty after clear: rows and files');
  assert(same(actions(seq10), [['pack.clear', 'unit', null, { dropped: MAX_UPLOADS }]]), 'one pack.clear row', actions(seq10));
  assert(same(listServices(db).map((s) => s.slug), servicesBefore) && servicesBefore.length > 0, 'the services the packs named stay');
  assert(readDeployRecords().length === 2, 'deploy audit survives a registry clear — reset is not amnesia');

  // --- the org's live pack: <org root>/live/, replaced atomically ---
  assert(readLivePack() === null, 'readLivePack: null before the first refresh');
  assert(livePackPath() === join(TMP, 'live', 'production-live.pack.yaml'), 'livePackPath: <org root>/live/production-live.pack.yaml', livePackPath());
  writeLivePack('kind: ObservabilityPack\nmetadata:\n  name: one\n');
  writeLivePack('kind: ObservabilityPack\nmetadata:\n  name: two\n');
  assert(readLivePack() === 'kind: ObservabilityPack\nmetadata:\n  name: two\n', 'writeLivePack replaces the live pack; readLivePack reads it back');
  assert(JSON.stringify(readdirSync(join(TMP, 'live'))) === JSON.stringify(['production-live.pack.yaml']), 'writeLivePack leaves no .tmp file behind', readdirSync(join(TMP, 'live')));
  assert(clearPacks(db, 'unit') === 0 && readLivePack() !== null, 'a registry clear (RESET) keeps the live pack');

  // --- cache reset honors a re-pointed workspace ---
  const TMP2 = mkdtempSync(join(tmpdir(), 'observogram-ws2-'));
  process.env.OBSERVOGRAM_WORKSPACE = TMP2;
  resetPackRegistry();
  saveWorkspacePack('uploaded-relocated-eeee5555', { canonical });
  assert(existsSync(join(TMP2, 'packs', 'uploaded-relocated-eeee5555.pack.yaml')),
         'OBSERVOGRAM_WORKSPACE relocation takes effect after cache reset');
  rmSync(TMP2, { recursive: true, force: true });

  // --- rebrand shim: the legacy TOMOGRAPH_WORKSPACE spelling still works ---
  const TMP3 = mkdtempSync(join(tmpdir(), 'observogram-ws3-'));
  delete process.env.OBSERVOGRAM_WORKSPACE;
  process.env.TOMOGRAPH_WORKSPACE = TMP3;
  resetPackRegistry();
  saveWorkspacePack('uploaded-legacyenv-ffff6666', { canonical });
  assert(existsSync(join(TMP3, 'packs', 'uploaded-legacyenv-ffff6666.pack.yaml')),
         'legacy TOMOGRAPH_WORKSPACE is honored when OBSERVOGRAM_WORKSPACE is unset');
  delete process.env.TOMOGRAPH_WORKSPACE;
  process.env.OBSERVOGRAM_WORKSPACE = TMP;
  resetPackRegistry();
  rmSync(TMP3, { recursive: true, force: true });
  });
} finally {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(DB_DIR, { recursive: true, force: true });
}

report('workspace', 'all workspace persistence assertions pass.');
