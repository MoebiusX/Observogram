// server/pack-registry.mjs — the org's upload registry over FILES and ROWS
// (STORE_PLAN slice 4). A registered pack is one file,
// <org root>/packs/<id>.pack.yaml (server/workspace.mjs, the artefact), and
// one row in `packs` (server/store/packs.mjs: label, source, timestamps)
// with its `pack_services` links (server/store/pack-links.mjs: the services
// and environments it names). The per-org in-memory Map — the catalogue's
// working set and its LRU order — is kept here too, rehydrated from the
// rows and the files on an org's first touch (boot step 6).
//
//   registerPack(db, actor, { canonical, source, label }) → id
//   loadPacks(db)                 the rehydrate: rows reconciled with files
//   touchPack(db, id)             lastUsedAt, debounced, audit-free
//   clearPacks(db, actor)         DELETE /api/uploads: rows, links, files
//   uploadsMap(db) / ensureOrgLoaded(db)   the in-memory map
//   flushPackTouches() / resetPackRegistry()   test hooks
//
// The file order of a register is deliberate (A12): the NEW file is written
// first, then the replaced and evicted files are deleted, THEN the rows are
// written in one atomic(). A crash between the files and the rows leaves
// rows without a file, which the next rehydrate PRUNES on positive
// evidence (pack.remove { reason: 'file gone' }); the other order would
// leave a file without a row, which it would ADOPT as an unlabelled
// duplicate of a pack the label dedup had just replaced. Do not "fix" it.
//
// Rows outside a request — the rehydrate's adoption of an orphan file and
// its prune — are written by `system`; a register's by the principal's
// actor. The one audit-free write is the debounced lastUsedAt touch
// (packs.touchMany: bookkeeping, plan §5).

import { createHash } from 'node:crypto';
import { parse as parseYaml } from '../tools/lib/mini-yaml.mjs';
import { listEnvironments } from '../tools/lib/adapter.mjs';
import { catalogEntryOf } from '../tools/lib/service-keys.mjs';
import {
  clearWorkspacePackFiles, deleteWorkspacePack, listPackFiles, packFileStat, readPackFile, saveWorkspacePack,
} from './workspace.mjs';
import { atomic, currentStore, nowIso } from './store/db.mjs';
import { addPack, clampPackText, clearPacks as clearPackRows, getPack, listPacks, removePack, touchMany, upsertPack } from './store/packs.mjs';
import { linkPack } from './store/pack-links.mjs';
import { SYSTEM } from './store/identity.mjs';
import { currentOrg, runWithOrg } from './org-context.mjs';

// Capped to bound memory; the oldest entry (least recently used) is
// evicted on overflow, its file and row with it.
export const MAX_UPLOADS = 200;
const TOUCH_DEBOUNCE_MS = 1500;
const ID_MAX = 200;   // the id column's text limit

// ---------- the id ----------

export function slugify(s) {
  return String(s || 'pack')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pack';
}

// Deterministic content hash — same canonical → same id across restarts,
// engineers, and environments. The first 8 hex chars of SHA-256 over the
// JSON.stringify of the canonical pack object. Run-time annotations
// (metadata.annotations.mcp.refreshedAt etc.) ARE included in the hash on
// purpose — two packs that differ only in their refreshedAt timestamp are
// genuinely different snapshots and deserve distinct ids.
export function contentHash(canonical) {
  const json = JSON.stringify(canonical || {});
  return createHash('sha256').update(json).digest('hex').slice(0, 8);
}

export function packIdOf(canonical, source) {
  return `uploaded-${slugify(canonical?.metadata?.name || source || 'pack')}-${contentHash(canonical)}`;
}

// ---------- the in-memory map ----------
//
// Tenancy is always on: each org has its own map — a process-wide one
// would leak one org's packs into another's catalogue. The scope key is
// the request's org (currentOrg()) within a store handle, so a suite that
// re-points the workspace (and so the store) between boots in one process
// never sees the previous workspace's packs.
let UPLOAD_REGISTRIES = new WeakMap();   // store handle → Map(orgId → Map(id → { canonical, source, label, createdAt }))
// A WeakMap cannot be iterated: the handles seen are remembered here for
// the test hooks alone (a server process holds one).
const trackedStores = new Set();

const entryOf = (id, rec, canonical) => catalogEntryOf(id, { label: rec.label, source: rec.source }, canonical, listEnvironments(canonical));

// The org's map; rehydrated from the rows and the files on the first
// touch. Returns the map.
export function uploadsMap(db = currentStore()) {
  ensureOrgLoaded(db);
  return UPLOAD_REGISTRIES.get(db).get(currentOrg());
}

// The org's map, loaded if it was not: returns how many packs this call
// restored (0 when the map existed — a map that exists is not refilled,
// so start() may run several times in one process).
export function ensureOrgLoaded(db = currentStore()) {
  const scope = currentOrg();
  if (!scope) throw new Error('uploadsMap() outside an org context');
  trackedStores.add(db);
  let byOrg = UPLOAD_REGISTRIES.get(db);
  if (!byOrg) { byOrg = new Map(); UPLOAD_REGISTRIES.set(db, byOrg); }
  if (byOrg.has(scope)) return 0;
  const m = new Map();
  byOrg.set(scope, m);
  let restored = 0;
  try {
    // Entries arrive oldest lastUsedAt first, preserving the map's LRU
    // insertion order.
    for (const p of loadPacks(db)) {
      if (m.has(p.id)) continue;
      m.set(p.id, { canonical: p.canonical, source: p.source, label: p.label, createdAt: p.createdAt });
      restored++;
    }
  } catch (e) {
    process.stderr.write(`[workspace] org '${scope}' rehydrate failed: ${e.message}\n`);
  }
  return restored;
}

// ---------- register ----------

export function registerPack(db, actor, { canonical, source, label }) {
  // The clamp runs first, so the dedup below compares the cut label with the
  // cut labels in the map (a rehydrated map holds the rows' cut labels). A
  // 201-character label or a long `library:` source is cut, never refused.
  label = clampPackText(label);
  source = clampPackText(source) || 'upload';
  const id = packIdOf(canonical, source);
  const uploads = uploadsMap(db);
  // The quick-start dedup: an older entry whose friendly label collides with
  // the new one is replaced — a second "KrystalineX (repo scan)" replaces
  // the first instead of accumulating clones in the picker.
  const replaced = label ? [...uploads].filter(([otherId, rec]) => rec.label === label && otherId !== id).map(([otherId]) => otherId) : [];
  // The eviction: the oldest ids (insertion order) that the insert of `id`
  // pushes beyond the cap — never `id` itself, never one already replaced.
  const sizeAfter = uploads.size - replaced.length - (uploads.has(id) ? 1 : 0) + 1;
  const evicted = [];
  for (const otherId of uploads.keys()) {
    if (evicted.length >= sizeAfter - MAX_UPLOADS) break;
    if (otherId === id || replaced.includes(otherId)) continue;
    evicted.push(otherId);
  }
  const entry = catalogEntryOf(id, { label, source }, canonical, listEnvironments(canonical));
  // Files: the new one, then the old ones (A12 — see the header).
  saveWorkspacePack(id, { canonical });
  for (const otherId of [...replaced, ...evicted]) deleteWorkspacePack(otherId);
  // Rows, all or nothing.
  const pack = atomic(db, () => {
    for (const otherId of replaced) {
      if (getPack(db, otherId)) removePack(db, actor, otherId, { action: 'pack.replace', detail: { label, replacedBy: id } });
    }
    const { pack: row } = upsertPack(db, actor, { id, label, source });
    linkPack(db, actor, { packId: id, entry, canonical, via: 'register' });
    for (const otherId of evicted) {
      if (getPack(db, otherId)) removePack(db, actor, otherId, { action: 'pack.evict', detail: { cap: MAX_UPLOADS } });
    }
    return row;
  });
  // The map: delete + re-set refreshes the LRU position without minting a
  // new id, so a re-upload is safe (no duplicate entries) and keeps the
  // user's pick alive when they are actively working with that pack.
  for (const otherId of [...replaced, ...evicted]) uploads.delete(otherId);
  uploads.delete(id);
  uploads.set(id, { canonical, source, label, createdAt: pack.createdAt });
  return id;
}

// ---------- the rehydrate ----------

// Every persisted pack of the org, the rows reconciled with the files on
// disk, sorted oldest lastUsedAt first (ISO strings sort as time) so a
// caller can seed an LRU-ordered Map by insertion order:
//   - a file with no row is ADOPTED (actor system, label null, source
//     'workspace', at its mtime) and linked — the rows a register would
//     have given it; a pack that already has a row gets NO linkPack here:
//     its links are what a register or the import wrote and what an
//     operator's deletion of a service may have cascaded away since — a
//     boot must not resurrect a deleted service under actor `system`;
//   - a row whose file is gone is PRUNED only on positive evidence (the
//     listing succeeded AND the file is not there); an unreadable or
//     unparseable file keeps its row (unreadable is not absent) and is not
//     served;
//   - a listing error is not an empty directory: the rows' ids are read
//     directly and nothing is pruned.
// Read-only on the file side: an absent packs/ makes no directory.
export function loadPacks(db) {
  const rows = listPacks(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const files = listPackFiles();
  const listingOk = !files.error;
  if (!listingOk) process.stderr.write(`[workspace] could not list the pack files (${files.error}); falling back to the registry's rows\n`);
  const candidates = listingOk ? files.ids : rows.map((r) => r.id);
  const seen = new Set();
  const out = [];
  for (const id of candidates) {
    const file = readPackFile(id);
    if (!file) continue;                                   // ENOENT: in the fallback path a dangling row, left for the next listing
    if (file.error) {
      process.stderr.write(`[workspace] could not read pack ${id}.pack.yaml: ${file.error}\n`);
      seen.add(id);                                        // it exists: never pruned for a transient error
      continue;
    }
    seen.add(id);
    let canonical = null;
    try {
      const parsed = parseYaml(file.raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) canonical = parsed;
      else process.stderr.write(`[workspace] skipping pack ${id}.pack.yaml: parsed to ${parsed === null ? 'null' : typeof parsed}, not an object\n`);
    } catch (e) {
      process.stderr.write(`[workspace] skipping unparseable pack ${id}.pack.yaml: ${e.message}\n`);
    }
    let row = byId.get(id);
    if (!row) {
      if (id.length > ID_MAX) {
        process.stderr.write(`[workspace] not adopting ${id.slice(0, 60)}….pack.yaml: its name is over ${ID_MAX} characters (rename it)\n`);
        continue;
      }
      const at = new Date(packFileStat(id)?.mtimeMs ?? Date.now()).toISOString();
      row = atomic(db, () => {
        const r = addPack(db, SYSTEM, { id, label: null, source: 'workspace', createdAt: at, lastUsedAt: at, detail: { adopted: true } });
        if (canonical) linkPack(db, SYSTEM, { packId: id, entry: entryOf(id, r, canonical), canonical, via: 'adopt' });
        return r;
      });
    }
    if (canonical) out.push({ id, canonical, label: row.label, source: row.source, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt });
  }
  if (listingOk) {
    for (const row of rows) {
      if (seen.has(row.id) || packFileStat(row.id)) continue;
      removePack(db, SYSTEM, row.id, { detail: { reason: 'file gone' } });
    }
  }
  out.sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? -1 : a.lastUsedAt > b.lastUsedAt ? 1 : 0));
  return out;
}

// ---------- the touch ----------
//
// uploadedMeta() touches on every /api/packs/:id/* hit. A write per read is
// what the file's debounce avoided, and avoids for the table: one unref'd
// timer per (store handle, org), capturing both — the flush runs outside
// any request context — and one touchMany() per flush. A store a suite
// closed before the timer fires is swallowed: a late timer must not throw.
let PENDING = new WeakMap();   // store handle → Map(orgId → { timer, at: Map(id → ISO) })

export function touchPack(db, id) {
  const scope = currentOrg();
  if (!scope) throw new Error('touchPack() outside an org context');
  trackedStores.add(db);
  let byOrg = PENDING.get(db);
  if (!byOrg) { byOrg = new Map(); PENDING.set(db, byOrg); }
  let p = byOrg.get(scope);
  if (!p) { p = { timer: null, at: new Map() }; byOrg.set(scope, p); }
  p.at.set(id, nowIso());
  if (p.timer) return;
  p.timer = setTimeout(() => flushOrg(db, scope), TOUCH_DEBOUNCE_MS);
  if (typeof p.timer.unref === 'function') p.timer.unref();
}

function flushOrg(db, scope) {
  const p = PENDING.get(db)?.get(scope);
  if (!p) return;
  if (p.timer) { clearTimeout(p.timer); p.timer = null; }
  const entries = [...p.at.entries()];
  p.at.clear();
  if (!entries.length) return;
  try {
    runWithOrg(scope, () => touchMany(db, entries));
  } catch (e) {
    const closed = ['ERR_OBSERVOGRAM_STORE_NOT_OPEN', 'ERR_INVALID_STATE', 'ERR_SQLITE_ERROR'].includes(e?.code);
    if (!closed) process.stderr.write(`[workspace] org '${scope}' lastUsedAt flush failed: ${e.message}\n`);
  }
}

// Test hook: every pending touch, of every store and org, lands now.
export function flushPackTouches() {
  for (const db of trackedStores) {
    const byOrg = PENDING.get(db);
    if (!byOrg) continue;
    for (const scope of [...byOrg.keys()]) flushOrg(db, scope);
  }
}
// ---------- clear ----------

// DELETE /api/uploads: the org's rows (their links cascade; services and
// environments STAY — a reset of the working set is not a deletion of the
// org's services), one pack.clear row, then the map and the files (never
// the live pack). Returns the rows dropped.
export function clearPacks(db, actor) {
  const dropped = atomic(db, () => clearPackRows(db, actor));
  uploadsMap(db).clear();
  clearWorkspacePackFiles();
  return dropped;
}

// Test hook: drop every in-memory map and pending touch, so a re-pointed
// workspace or a fresh store takes effect within the same process.
export function resetPackRegistry() {
  for (const db of trackedStores) {
    const byOrg = PENDING.get(db);
    if (!byOrg) continue;
    for (const p of byOrg.values()) if (p.timer) clearTimeout(p.timer);
  }
  trackedStores.clear();
  UPLOAD_REGISTRIES = new WeakMap();
  PENDING = new WeakMap();
}
