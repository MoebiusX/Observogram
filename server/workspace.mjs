// server/workspace.mjs
//
// File-backed persistence for registered packs — VALUE_BACKLOG item 10A.
// The server's upload registry (crawled / drafted / uploaded packs) used to
// be a process-scoped Map: every restart lost the user's working set. This
// module gives that registry a durable home without changing its contract:
//
//   .observogram/                    (gitignored; OBSERVOGRAM_WORKSPACE relocates;
//                                     a pre-rebrand .tomograph/ keeps working)
//     packs/<id>.pack.yaml           one inspectable YAML file per pack
//     packs/index.json               id → { label, source, createdAt, lastUsedAt }
//
// Design constraints (deliberate):
//   - File-first, zero new dependencies: plain YAML files + one JSON index,
//     all inspectable with `cat`. No database.
//   - The pack id IS the filename (minus .pack.yaml). Ids are minted once at
//     registration from the canonical's content hash; on rehydrate we trust
//     the filename rather than re-hashing, so YAML round-trip formatting can
//     never silently re-mint an id. A hand-edited workspace file keeps its
//     id — that's documented behaviour, not drift detection's job.
//   - Env is read lazily (at call time, not module load) so tests can point
//     OBSERVOGRAM_WORKSPACE at a temp dir before booting the server.
//   - Sync fs on the write paths (files are tens of KB); lastUsedAt touches
//     are debounced and the timer is unref'd so the process can still exit.
//   - Durability over trust in any single syscall (2026-06-11 incident: a
//     transient boot-time read failure cascaded into a wiped index). Files
//     are replaced atomically (tmp + rename), index flushes MERGE with the
//     on-disk copy instead of clobbering it, and index entries are pruned
//     only on positive evidence the pack file is gone — never because a
//     listing or read transiently failed.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { orgWorkspaceRoot } from './tenancy.mjs';

const PACK_SUFFIX = '.pack.yaml';

// Stage 2 tenancy: the root is context-aware — <workspace>/orgs/<orgId>/
// inside a request that carries an org, the flat workspace otherwise
// (byte-identical v1 behaviour when tenancy is off). See server/tenancy.mjs.
function workspaceRoot() {
  return orgWorkspaceRoot();
}
function packsDir()  { return join(workspaceRoot(), 'packs'); }
function indexPath() { return join(packsDir(), 'index.json'); }

function ensureDirs() {
  mkdirSync(packsDir(), { recursive: true });
}

// Replace-via-rename so a process killed mid-write can never leave a torn
// index.json or pack file behind (rename is atomic on POSIX; on Windows it
// maps to MoveFileEx(MOVEFILE_REPLACE_EXISTING)). The tmp name carries the
// pid so two processes flushing concurrently don't trample each other's
// staging file.
function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  try { renameSync(tmp, path); }
  catch (e) {
    try { rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}

// ---------- index ----------
//
// The index carries the registry metadata that isn't part of the canonical
// pack itself (friendly label, source, timestamps). It's advisory: the pack
// files are the truth, and loadWorkspacePacks() reconciles the two — an
// index entry without a file is dropped, an orphan file is adopted.

function readIndex() {
  let raw;
  try { raw = readFileSync(indexPath(), 'utf8'); }
  catch (e) {
    // ENOENT is the normal first-boot case. Anything else (EPERM/EBUSY from
    // an AV scanner, a torn handle, ...) is a TRANSIENT failure that must be
    // loud: silently treating it as "empty index" is how a boot once wiped
    // the registry metadata (2026-06-11 incident).
    if (e.code !== 'ENOENT') {
      process.stderr.write(`[workspace] index read failed (${e.code || e.message}); treating as empty\n`);
    }
    return {};
  }
  try {
    const data = JSON.parse(raw);
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (e) {
    process.stderr.write(`[workspace] index.json is corrupt (${e.message}); rebuilding from pack files\n`);
    return {};
  }
}

// In-memory index state is keyed BY ROOT: with tenancy on, each org has
// its own workspace subtree, and a process-wide single cache would bleed
// one org's index (ids, labels, deletions) into another's flush. The
// per-root record holds exactly the state the old module-level variables
// did.
const rootState = new Map();    // root → { pendingIndex, deletedIds, flushTimer }

function stateFor(root = workspaceRoot()) {
  let s = rootState.get(root);
  if (!s) { s = { pendingIndex: null, deletedIds: new Set(), flushTimer: null }; rootState.set(root, s); }
  return s;
}

function index() {
  const s = stateFor();
  if (!s.pendingIndex) s.pendingIndex = readIndex();
  return s.pendingIndex;
}

function flushIndexNow({ merge = true, root = workspaceRoot() } = {}) {
  const s = stateFor(root);
  if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
  if (!s.pendingIndex) return;
  const idxPath = join(root, 'packs', 'index.json');
  mkdirSync(join(root, 'packs'), { recursive: true });
  if (merge) {
    // index.json is shared state: a dying process's debounced timer, a
    // sibling server, or a boot whose first read transiently failed can all
    // hold an in-memory copy that never saw entries other writers added.
    // Fold the on-disk entries back in before the whole-file rewrite so a
    // flush is never destructive; deletions made in this process are tracked
    // in deletedIds so they still win over the merge.
    let disk = {};
    try {
      const data = JSON.parse(readFileSync(idxPath, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) disk = data;
    } catch (_) {}
    for (const [id, meta] of Object.entries(disk)) {
      if (!(id in s.pendingIndex) && !s.deletedIds.has(id)) s.pendingIndex[id] = meta;
    }
  }
  writeFileAtomic(idxPath, JSON.stringify(s.pendingIndex, null, 2));
  s.deletedIds.clear();
}

function scheduleIndexFlush() {
  const s = stateFor();
  const root = workspaceRoot();
  if (s.flushTimer) clearTimeout(s.flushTimer);
  // The debounced flush must land in the SAME org workspace it was
  // scheduled from — the timer fires outside any request context, so the
  // root is captured here, not re-resolved at fire time.
  s.flushTimer = setTimeout(() => { s.flushTimer = null; flushIndexNow({ root }); }, 1500);
  // Never keep the process alive just to persist a lastUsedAt touch.
  if (typeof s.flushTimer.unref === 'function') s.flushTimer.unref();
}

// ---------- public API ----------

export function saveWorkspacePack(id, { canonical, label, source, createdAt, lastUsedAt } = {}) {
  ensureDirs();
  writeFileAtomic(join(packsDir(), id + PACK_SUFFIX), emitYaml(canonical || {}));
  index()[id] = {
    label: label || null,
    source: source || 'upload',
    createdAt: createdAt || Date.now(),
    lastUsedAt: lastUsedAt || Date.now(),
  };
  flushIndexNow();
}

export function deleteWorkspacePack(id) {
  try { rmSync(join(packsDir(), id + PACK_SUFFIX), { force: true }); } catch (_) {}
  delete index()[id];
  stateFor().deletedIds.add(id);
  flushIndexNow();
}

// Record that a pack was read. Debounced: high-traffic /api/packs/:id/*
// handlers touch on every hit, and lastUsedAt only needs to be roughly
// right (it drives retention pruning, nothing user-visible).
export function touchWorkspacePack(id) {
  const entry = index()[id];
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  scheduleIndexFlush();
}

// Load every persisted pack, reconciling index against the files on disk.
// Returns entries sorted oldest-lastUsedAt first so callers can seed an
// LRU-ordered Map by insertion order.
export function loadWorkspacePacks() {
  ensureDirs();
  const idx = index();
  const out = [];
  let files = null;   // null = listing failed, NOT "directory is empty"
  try { files = readdirSync(packsDir()).filter(f => f.endsWith(PACK_SUFFIX)); }
  catch (e) {
    // A transient listing failure (AV scanner, EBUSY, ...) must not present
    // as an empty workspace — fall back to the filenames the index already
    // knows about and try to read them directly. Pruning is disabled below:
    // "could not list" is not evidence that anything is gone.
    process.stderr.write(`[workspace] could not list ${packsDir()} (${e.code || e.message}); falling back to index entries\n`);
  }
  const listingOk = files !== null;
  const candidates = listingOk ? files : Object.keys(idx).map(id => id + PACK_SUFFIX);
  const seen = new Set();   // ids whose pack file demonstrably exists, parseable or not
  let adopted = false;
  for (const file of candidates) {
    const id = file.slice(0, -PACK_SUFFIX.length);
    let raw;
    try { raw = readFileSync(join(packsDir(), file), 'utf8'); }
    catch (e) {
      // In the fallback path a missing file just means a dangling index
      // entry (pruned next time the listing works); anything else is worth
      // a line — every skip here is a pack the catalog will be missing.
      if (listingOk || e.code !== 'ENOENT') {
        process.stderr.write(`[workspace] could not read pack ${file}: ${e.code || e.message}\n`);
      }
      continue;
    }
    seen.add(id);   // the file exists even if it turns out not to parse
    let canonical;
    try { canonical = parseYaml(raw); }
    catch (e) {
      process.stderr.write(`[workspace] skipping unparseable pack ${file}: ${e.message}\n`);
      continue;
    }
    if (!canonical || typeof canonical !== 'object') {
      process.stderr.write(`[workspace] skipping pack ${file}: parsed to ${canonical === null ? 'null' : typeof canonical}, not an object\n`);
      continue;
    }
    const meta = idx[id];
    if (!meta) {
      // Orphan file (e.g. copied in by hand) — adopt it with file mtime.
      let mtime = Date.now();
      try { mtime = statSync(join(packsDir(), file)).mtimeMs; } catch (_) {}
      idx[id] = { label: null, source: 'workspace', createdAt: mtime, lastUsedAt: mtime };
      adopted = true;
    }
    const m = idx[id];
    out.push({ id, canonical, label: m.label, source: m.source, createdAt: m.createdAt, lastUsedAt: m.lastUsedAt });
  }
  // Index entries whose pack file vanished are dropped — but only on
  // positive evidence: the listing succeeded AND an individual existence
  // check agrees the file is gone. An unreadable or unparseable file keeps
  // its entry (the pack file may recover; its label/source/createdAt must
  // not be lost to a transient error and re-minted by orphan adoption).
  let pruned = false;
  if (listingOk) {
    for (const id of Object.keys(idx)) {
      if (seen.has(id)) continue;
      if (existsSync(join(packsDir(), id + PACK_SUFFIX))) continue;
      delete idx[id];
      stateFor().deletedIds.add(id);   // a deliberate drop must win over merge-on-flush
      pruned = true;
    }
  }
  if (pruned || adopted) flushIndexNow();
  out.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  return out;
}

export function clearWorkspacePacks() {
  let dropped = 0;
  try {
    for (const f of readdirSync(packsDir())) {
      if (f.endsWith(PACK_SUFFIX)) { rmSync(join(packsDir(), f), { force: true }); dropped++; }
    }
  } catch (_) {}
  const s = stateFor();
  s.pendingIndex = {};
  s.deletedIds.clear();
  // Reset means reset: replace the file outright, no merge — merging would
  // resurrect the very entries the user just asked to clear.
  flushIndexNow({ merge: false });
  return dropped;
}

// ---------- deploy audit (VALUE_BACKLOG item 10C) ----------
//
// Append-only JSONL: audit history is never rewritten. Two record types —
// { type: 'deploy', deployId, ... } written when a deploy is attempted, and
// { type: 'verify', deployId, ... } appended later by post-deploy re-verify
// (item 9). readDeployRecords() merges the latest verify into its deploy
// record at read time, so consumers see one object per deploy while the
// on-disk log stays a faithful, immutable sequence of events.
//
// Deliberately NOT cleared by DELETE /api/uploads: resetting the pack
// registry must not erase the record of what was pushed to production.

function deploysPath() { return join(workspaceRoot(), 'deploys.jsonl'); }

export function appendDeployRecord(record) {
  mkdirSync(workspaceRoot(), { recursive: true });
  appendFileSync(deploysPath(), JSON.stringify({ type: 'deploy', ...record }) + '\n');
}

export function appendDeployVerify(deployId, verify) {
  mkdirSync(workspaceRoot(), { recursive: true });
  appendFileSync(deploysPath(), JSON.stringify({ type: 'verify', deployId, at: new Date().toISOString(), ...verify }) + '\n');
}

// Newest-first deploy records with the latest verify (if any) merged in.
// Unparseable lines are skipped — a torn write must not poison the log.
export function readDeployRecords({ packId, limit = 50 } = {}) {
  let raw = '';
  try { raw = readFileSync(deploysPath(), 'utf8'); } catch (_) { return []; }
  const deploys = [];
  const verifies = new Map();   // deployId → latest verify record
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (rec.type === 'deploy' && rec.deployId) deploys.push(rec);
    else if (rec.type === 'verify' && rec.deployId) verifies.set(rec.deployId, rec);
  }
  let out = deploys.map(d => {
    const v = verifies.get(d.deployId);
    if (!v) return d;
    const { type: _t, deployId: _id, ...verify } = v;
    return { ...d, verify };
  });
  if (packId) out = out.filter(d => d.pack?.id === packId);
  out.reverse();   // appended oldest-first → serve newest-first
  return limit > 0 ? out.slice(0, limit) : out;
}

// ---------- pre-deploy snapshots (VALUE_BACKLOG item 10D) ----------
//
// One directory per deploy: snapshots/<deployId>/meta.json plus one JSON
// file per captured artefact. The snapshot is taken BEFORE the first write
// so rollback always has a pre-state to restore — or an honest record that
// the artefact did not exist (a create, whose rollback is a delete).

function snapshotDir(deployId) {
  // deployIds are server-minted (dep_<ts>_<rand>), but never trust a path
  // component: strip anything that isn't filename-safe.
  const safe = String(deployId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('workspace: empty snapshot id');
  return join(workspaceRoot(), 'snapshots', safe);
}

export function saveDeploySnapshot(deployId, meta, files = {}) {
  const dir = snapshotDir(deployId);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
    writeFileSync(join(dir, safeName + '.json'), JSON.stringify(data, null, 2));
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return dir;
}

// → { meta, readFile(name) } or null when no snapshot was taken.
export function readDeploySnapshot(deployId) {
  const dir = snapshotDir(deployId);
  let meta;
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); }
  catch (_) { return null; }
  return {
    meta,
    readFile(name) {
      const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
      try { return JSON.parse(readFileSync(join(dir, safeName + '.json'), 'utf8')); }
      catch (_) { return null; }
    },
  };
}

// Test hook: force any debounced index write to land now.
export function flushWorkspaceIndex() { flushIndexNow(); }

// Test hook: drop the in-memory index caches so a re-pointed
// OBSERVOGRAM_WORKSPACE takes effect within the same process.
export function resetWorkspaceCache() {
  for (const s of rootState.values()) {
    if (s.flushTimer) { clearTimeout(s.flushTimer); s.flushTimer = null; }
  }
  rootState.clear();
}

export function workspaceInfo() {
  return { root: workspaceRoot(), packs: packsDir() };
}
