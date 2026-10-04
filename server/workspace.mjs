// server/workspace.mjs
//
// File-backed persistence for registered packs — VALUE_BACKLOG item 10A.
// The server's upload registry (crawled / drafted / uploaded packs) used to
// be a process-scoped Map: every restart lost the user's working set. This
// module gives the pack files a durable home:
//
//   .observogram/                    (gitignored; OBSERVOGRAM_WORKSPACE relocates;
//                                     a pre-rebrand .tomograph/ keeps working)
//     packs/<id>.pack.yaml           one inspectable YAML file per pack — the
//                                     artefact (STORE_PLAN decision 3)
//     live/production-live.pack.yaml the org's live pack (POST /api/refresh-live)
//
// The registry itself — a pack's label, source, timestamps and the services
// it covers — is the store's `packs` and `pack_services` tables, kept by
// server/pack-registry.mjs (STORE_PLAN slice 4). A `packs/index.json` left
// by a build before slice 4 is read ONCE, at the first start of this build
// (boot step 5, server/store/pack-import.mjs), and never again: it stays
// in place, frozen, hashed by the stale-import guard. No server path
// writes it; the one writer is `packc store export` in place
// (server/store/ops.mjs), which rewrites it from the rows for an older
// build to boot on.
//
// Design constraints (deliberate):
//   - Zero new dependencies: plain YAML files, inspectable with `cat`.
//   - The pack id IS the filename (minus .pack.yaml). Ids are minted once at
//     registration from the canonical's content hash; on rehydrate we trust
//     the filename rather than re-hashing, so YAML round-trip formatting can
//     never silently re-mint an id. A hand-edited workspace file keeps its
//     id — that's documented behaviour, not drift detection's job.
//   - Env is read lazily (at call time, not module load) so tests can point
//     OBSERVOGRAM_WORKSPACE at a temp dir before booting the server.
//   - Sync fs on the write paths (files are tens of KB).
//   - Durability over trust in any single syscall (2026-06-11 incident: a
//     transient boot-time read failure cascaded into a wiped index). Files
//     are replaced atomically (tmp + rename); the readers below tell an
//     absent file (ENOENT) from one that could not be read or listed, so
//     the registry prunes a row only on positive evidence the pack file is
//     gone — never because a listing or read transiently failed.
//   - The readers are READ-ONLY: listPackFiles() makes no directory (a
//     :memory: boot writes nothing under an org root). Only
//     saveWorkspacePack() creates packs/.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { orgWorkspaceRoot } from './tenancy.mjs';

const PACK_SUFFIX = '.pack.yaml';

// Stage 2 tenancy (always on): the root is context-aware — the root of the
// request's org, fixed at its creation in the store (the default org's is
// usually the workspace itself, '.'; a created org's is orgs/<orgId>/).
// Outside an org context it throws. See server/tenancy.mjs. The pack
// readers also take an explicit `root` (an absolute org root), for the
// boot's one-shot import and the stale-import guard, which run for every
// org outside any request.
function workspaceRoot() {
  return orgWorkspaceRoot();
}
function packsDir(root = workspaceRoot()) { return join(root, 'packs'); }
function packPath(id, root) { return join(packsDir(root), id + PACK_SUFFIX); }

function ensureDirs() {
  mkdirSync(packsDir(), { recursive: true });
}

// Replace-via-rename so a process killed mid-write can never leave a torn
// pack file behind (rename is atomic on POSIX; on Windows it maps to
// MoveFileEx(MOVEFILE_REPLACE_EXISTING)). The tmp name carries the pid so
// two processes writing concurrently don't trample each other's staging
// file.
function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  try { renameSync(tmp, path); }
  catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

// ---------- the pack files ----------

// The one writer: the pack file, atomically. The only caller of ensureDirs()
// on the pack path, so a boot that registers nothing creates nothing.
export function saveWorkspacePack(id, { canonical } = {}) {
  ensureDirs();
  writeFileAtomic(packPath(id), emitYaml(canonical || {}));
}

export function deleteWorkspacePack(id) {
  try { rmSync(packPath(id), { force: true }); } catch {}
}

// The ids of every <id>.pack.yaml under the root's packs/ — read-only.
// → { ids } (an absent packs/ is { ids: [] }: ENOENT and ENOTDIR are "no
// packs", not an error) | { error: <code> } — "could not list" is NOT
// "empty": the callers fall back to what they already know and never prune
// on it.
export function listPackFiles({ root = workspaceRoot() } = {}) {
  try {
    return { ids: readdirSync(packsDir(root)).filter((f) => f.endsWith(PACK_SUFFIX)).map((f) => f.slice(0, -PACK_SUFFIX.length)).sort() };
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return { ids: [] };
    return { error: e?.code || e?.message || 'error' };
  }
}

// → { raw } | null (ENOENT: no such pack file) | { error: <code> } (it
// exists but could not be read — unreadable is not absent).
export function readPackFile(id, { root = workspaceRoot() } = {}) {
  try {
    return { raw: readFileSync(packPath(id, root), 'utf8') };
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    return { error: e?.code || e?.message || 'error' };
  }
}

// → { mtimeMs } | null (no such pack file). Positive evidence of
// existence, or of absence, for the registry's adopt and prune rules.
export function packFileStat(id, { root = workspaceRoot() } = {}) {
  try {
    const st = statSync(packPath(id, root));
    return { mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// DELETE /api/uploads: every pack file of the org — never the live pack,
// never deploys.jsonl or snapshots/. Returns how many files went.
export function clearWorkspacePackFiles() {
  let dropped = 0;
  try {
    for (const f of readdirSync(packsDir())) {
      if (f.endsWith(PACK_SUFFIX)) { rmSync(join(packsDir(), f), { force: true }); dropped++; }
    }
  } catch {}
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
//
// Each append is followed by one audit row (STORE_PLAN slice 5) written by
// the route through server/audit-after.mjs, not here: this module stays
// file-only, and the row names the deployId the line holds.

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
  try { raw = readFileSync(deploysPath(), 'utf8'); } catch { return []; }
  const deploys = [];
  const verifies = new Map();   // deployId → latest verify record
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
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
  catch { return null; }
  return {
    meta,
    readFile(name) {
      const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
      try { return JSON.parse(readFileSync(join(dir, safeName + '.json'), 'utf8')); }
      catch { return null; }
    },
  };
}

// ---------- the live pack (per org) ----------
//
// The last POST /api/refresh-live of THIS org, read by GET /api/live-status
// for the studio's LIVE badge: <org root>/live/production-live.pack.yaml.
// Replaced atomically, so a concurrent live-status never reads a torn file.
// (Before STORE_PLAN slice 3 it was one file in the install, shared by every
// org; the CLI `npm run fetch-live` still writes that path by default.)
export const LIVE_PACK_FILE = 'production-live.pack.yaml';

export function livePackPath() { return join(workspaceRoot(), 'live', LIVE_PACK_FILE); }

export function writeLivePack(yamlText) {
  mkdirSync(join(workspaceRoot(), 'live'), { recursive: true });
  writeFileAtomic(livePackPath(), yamlText);
}

// The YAML text, or null when this org has none yet.
export function readLivePack() {
  try { return readFileSync(livePackPath(), 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function workspaceInfo() {
  return { root: workspaceRoot(), packs: packsDir() };
}
