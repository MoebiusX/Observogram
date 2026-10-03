// server/store/legacy-files.mjs — the pre-store identity files, read once
// (docs/STORE_PLAN.md §4 steps 2–3).
//
// users.json and orgs.json were the source of truth before the store. The
// first start of a store build imports them, records their SHA-256 in
// schema_meta legacy_hashes and in <base>/.store-imported (the marker), and
// never reads them again except to compare hashes. Each org root's
// packs/index.json (the pack registry before STORE_PLAN slice 4) goes the
// same way at boot step 5 — read once, hashed under schema_meta
// pack_index_hashes (a key of its own: a 0.5.0 build's guard compares every
// legacy_hashes key and rewrites index.json on every pack read, so a pack
// key there would brick a rollback), in a CANONICAL form that drops
// lastUsedAt (canonicalPackIndex below). This module is the only place that
// knows their paths, their structure and how they are written:
//
//   - strict readers: they refuse only what makes the FILE unusable — a
//     read error other than ENOENT, a parse error, or the wrong structure.
//     An entry the store cannot hold (a name, an org id, a field value) is
//     never a reason to refuse the upgrade: the import drops it and lists
//     it in its report, and every entry that works today is imported. So
//     the readers return every entry with its values as parsed. `raw` is
//     the exact bytes read, so the hash recorded at commit is the hash of
//     what was imported;
//   - the writers today's tools used (kept for the migration's `default`
//     entry and for the suites' fixtures);
//   - hashing, the marker, and hasData(): the one definition of "data" for
//     the flat-workspace migration and the empty-default-org test.
//
// Only server/boot.mjs, server/tenancy.mjs (the migration),
// server/store/{import,ops,cli,pack-import}.mjs, the suites and
// server/fixtures/* may import it.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { baseWorkspacePath, brandEnv } from '../../tools/lib/brand-env.mjs';
import { nowIso } from './db.mjs';
import { getMeta } from './meta.mjs';

// The flat workspace entries that belong to an org (moved from tenancy.mjs):
// what a PRE-STORE build keeps, and so what the import's flat → orgs/default
// migration moves.
export const MIGRATABLE = Object.freeze(['packs', 'deploys.jsonl', 'snapshots', 'journeys', 'runs']);
// The entries of an org root the store build owns: MIGRATABLE plus the
// org's live pack (live/, STORE_PLAN slice 3). The in-place export's
// default-org move and the boot's left-behind / empty-leftover checks use
// this list.
export const ORG_ENTRIES = Object.freeze([...MIGRATABLE, 'live']);
export const MARKER = '.store-imported';
// Who last wrote the marker. 'packs-import' is reserved for the pack
// registry's import (boot step 5); today that step writes NO marker — the
// marker records the identity files only (a 0.5.0 build's applyRepairs
// rewrites it whenever its files differ from legacy_hashes, so a pack key
// there would be fought over).
const MARKER_BY = Object.freeze(['import', 'replace', 'export', 'repair', 'purge-org', 'packs-import']);

const LEGACY_TAIL = 'the upgrade imports nothing until it is fixed';
// A packs/index.json that exists but cannot be read (or a packs/ that
// cannot be listed) at boot step 5: the 2026-06-11 incident's rule.
export const PACK_INDEX_TAIL = 'the start imports no pack registry until it can be read — a transient EPERM or EBUSY must not become an empty '
  + 'registry (the 2026-06-11 incident); with the server stopped, make it readable or move it aside (its labels are then lost: the rows are '
  + 'rebuilt from the pack files) and start again: the next start imports only the packs';
// The marker is written by the store, not by a person, and a corrupt one
// on an imported store is not an upgrade problem: say so and name the way
// out (applyRepairs rewrites a missing marker from the database).
const MARKER_TAIL = 'nothing was changed. The store writes this file: with the server stopped, delete it and the next ' +
  'start rewrites it from the store — unless this workspace\'s database was lost or moved, since the marker is then ' +
  'the only record of the store the legacy files were imported into';

export class LegacyFileError extends Error {
  constructor(path, reason, options, tail = LEGACY_TAIL) {
    super(`${path}: ${reason} — ${tail}`, options);
    this.name = 'LegacyFileError';
    this.code = 'ERR_OBSERVOGRAM_LEGACY_FILE';
    this.path = path;
  }
}

// ---------- paths ----------

export function orgsFilePath(base = baseWorkspacePath()) {
  return join(base, 'orgs.json');
}

// The users file this shell's environment names: OBSERVOGRAM_USERS_FILE
// (resolved), else <base>/users.json.
export function envUsersFilePath(base = baseWorkspacePath()) {
  const fromEnv = brandEnv('USERS_FILE');
  return fromEnv ? resolve(fromEnv) : join(base, 'users.json');
}

// The users file a store compares against: the one recorded at the import
// when OBSERVOGRAM_USERS_FILE was set then; <base>/users.json after an
// import without it; before any import, the one this environment names.
export function legacyUsersPath(db, base = baseWorkspacePath()) {
  return getMeta(db, 'users_file') ?? (getMeta(db, 'import_done') ? join(base, 'users.json') : envUsersFilePath(base));
}

// The users file's key in legacy_hashes and the marker: the recorded
// absolute path when there is one, else 'users.json' (base-relative).
export function usersHashKey(recorded) {
  return recorded || 'users.json';
}

// ---------- strict readers ----------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ENOENT → null (absent); any other read error, or a parse error, throws.
function readJson(path, tail = LEGACY_TAIL) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch (e) {
    if (e?.code === 'ENOENT') return null;
    throw new LegacyFileError(path, `cannot be read (${e?.code || e?.message})`, { cause: e }, tail);
  }
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw new LegacyFileError(path, `is not valid JSON (${e.message})`, { cause: e }, tail);
  }
  return { raw, data };
}

// → { path, exists: false } | { path, exists: true, raw, entries: [[name, record]] }
export function readUsersFileStrict(path) {
  const read = readJson(path);
  if (!read) return { path, exists: false };
  const { raw, data } = read;
  if (!isPlainObject(data)) throw new LegacyFileError(path, 'is not a JSON object');
  if (!isPlainObject(data.users)) throw new LegacyFileError(path, '"users" is not an object of user records');
  const entries = Object.entries(data.users);
  for (const [name, rec] of entries) {
    if (!isPlainObject(rec)) throw new LegacyFileError(path, `the record of user ${JSON.stringify(name)} is not an object`);
  }
  return { path, exists: true, raw, entries };
}

// → { path, exists: false } | { path, exists: true, raw, entries: [[id, { name, members: [[key, role]] }]] }
// A `members` of null reads as no members, as it always did.
export function readOrgsFileStrict(path) {
  const read = readJson(path);
  if (!read) return { path, exists: false };
  const { raw, data } = read;
  if (!isPlainObject(data)) throw new LegacyFileError(path, 'is not a JSON object of orgs');
  const entries = Object.entries(data).map(([id, org]) => {
    if (!isPlainObject(org)) throw new LegacyFileError(path, `org ${JSON.stringify(id)} is not an object`);
    if (org.members !== undefined && org.members !== null && !isPlainObject(org.members)) {
      throw new LegacyFileError(path, `the members of org ${JSON.stringify(id)} are not an object of member → role`);
    }
    return [id, { name: org.name, members: Object.entries(org.members || {}) }];
  });
  return { path, exists: true, raw, entries };
}

// ---------- the pack index (STORE_PLAN slice 4, boot step 5) ----------

// The pack_index_hashes key of an org root: base-relative, forward slashes
// ('packs/index.json' for the root '.', 'orgs/<id>/packs/index.json'
// otherwise) — so purge-org's `orgs/<id>/` prefix filter matches.
export function packIndexKey(root) {
  const rel = String(root).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return rel === '.' || rel === '' ? 'packs/index.json' : `${rel}/packs/index.json`;
}

// A time as index.json held it (ms numbers; a build may also have written
// a string) → the ISO string the rows hold; null when it is no time at
// all. Shared by the import (an unusable value falls back to the file's
// mtime) and the canonical form below.
export function isoOf(value) {
  const ms = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}

// → { path, exists: false }                                   ENOENT
//   { path, exists: true, raw, entries: [[id, meta]] }       an object of entries (meta as parsed; the import validates each field)
//   { path, exists: true, raw, corrupt: '<reason>' }          unparseable JSON, an array, null, a scalar — not an error (the rows
//                                                            are rebuilt from the pack files, the labels are lost)
// Any read error but ENOENT throws LegacyFileError(path, …, PACK_INDEX_TAIL):
// an unreadable registry is not an empty one.
export function readPackIndexStrict(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch (e) {
    if (e?.code === 'ENOENT') return { path, exists: false };
    throw new LegacyFileError(path, `cannot be read (${e?.code || e?.message})`, { cause: e }, PACK_INDEX_TAIL);
  }
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch (e) {
    return { path, exists: true, raw, corrupt: `not valid JSON (${e.message})` };
  }
  if (!isPlainObject(data)) {
    const what = data === null ? 'null' : Array.isArray(data) ? 'an array' : `a ${typeof data}`;
    return { path, exists: true, raw, corrupt: `${what}, not an object of id → entry` };
  }
  return { path, exists: true, raw, entries: Object.entries(data) };
}

// The canonical form the stale-import guard compares: the entries sorted
// by id, each reduced to { label, source, createdAt } — lastUsedAt dropped
// (a 0.4.0 / 0.5.0 build rewrites it on every pack READ, and a read is not
// an edit), the fields read as the import reads them (a label that is no
// string → null; a source that is no string, or empty → 'upload', as every
// pre-slice-4 writer defaulted it), createdAt normalised to the ISO form
// the rows hold (a number re-serialised, or a float mtime cut to the
// millisecond, is the same time). JSON.stringify with no spacing. The same
// form is built from the store's rows (the guard's reference), so a file
// that says exactly what the store holds hashes equal.
export function canonicalPackIndex(entries) {
  const rows = [...entries].map(([id, meta]) => [String(id), {
    label: typeof meta?.label === 'string' ? meta.label : null,
    source: typeof meta?.source === 'string' && meta.source ? meta.source : 'upload',
    createdAt: isoOf(meta?.createdAt),
  }]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(rows);
}

export const PACK_INDEX_CANON = 'pack-index-v1';

// The hash recorded for a read index: the canonical form's SHA-256 (what
// compareHashes reads), plus `raw` — the bytes' SHA-256 — so a rewrite
// that changed nothing canonical can still be told and logged. A corrupt
// index hashes its raw bytes only (canon 'raw'): any change to it is a
// change. An absent one is { absent: true }.
export function packIndexHash(idx) {
  if (!idx?.exists) return { absent: true };
  const raw = sha256Of(idx.raw);
  if (idx.corrupt) return { sha256: raw, canon: 'raw', raw };
  return { sha256: sha256Of(canonicalPackIndex(idx.entries)), canon: PACK_INDEX_CANON, raw };
}

// ---------- writers (today's, verbatim) ----------

// users.json as the pre-store tools wrote it: a 0600 temp file, then its
// bytes copied in place, which keeps working for a bind-mounted file. It
// holds password hashes, so a file this creates is 0600 too (an existing
// one keeps its mode), and the temp file is removed, not left empty.
export function writeUsersFile(data, path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  writeFileSync(path, readFileSync(tmp), { mode: 0o600 });
  try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
}

// orgs.json: a 0600 temp file renamed over it, with a trailing newline.
export function writeOrgsFile(orgs, path) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(orgs, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, path); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
}

// ---------- hashes ----------

export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// → { sha256 } | { absent: true }. A read error other than ENOENT throws,
// naming the path: an unreadable file is not an absent one.
export function sha256File(path) {
  let raw;
  try {
    raw = readFileSync(path);
  } catch (e) {
    if (e?.code === 'ENOENT') return { absent: true };
    throw new LegacyFileError(path, `cannot be read (${e?.code || e?.message})`, { cause: e });
  }
  return { sha256: sha256Of(raw) };
}

// Recorded vs current, per key ({ sha256 } | { absent: true }; a key
// missing on one side reads as absent there).
export function compareHashes(recorded = {}, current = {}) {
  const changed = [];
  const appeared = [];
  const disappeared = [];
  const hashOf = (m, k) => (isPlainObject(m?.[k]) && typeof m[k].sha256 === 'string' ? m[k].sha256 : null);
  for (const key of new Set([...Object.keys(recorded || {}), ...Object.keys(current || {})])) {
    const was = hashOf(recorded, key);
    const now = hashOf(current, key);
    if (was && now && was !== now) changed.push(key);
    else if (!was && now) appeared.push(key);
    else if (was && !now) disappeared.push(key);
  }
  return { changed, appeared, disappeared };
}

// ---------- the marker ----------

export function markerPath(base = baseWorkspacePath()) {
  return join(base, MARKER);
}

// null when absent; a marker that cannot be read or has the wrong shape
// throws naming it (it cannot be compared), with `tail` as its way out
// (the start's by default; the in-place export names its own).
export function readMarker(base = baseWorkspacePath(), { tail = MARKER_TAIL } = {}) {
  const path = markerPath(base);
  const read = readJson(path, tail);
  if (!read) return null;
  const m = read.data;
  if (!isPlainObject(m) || typeof m.storeId !== 'string' || !m.storeId || !isPlainObject(m.files)
    || typeof m.by !== 'string' || typeof m.writtenAt !== 'string') {
    throw new LegacyFileError(path, 'is not a store import marker ({ storeId, files, by, writtenAt })', undefined, tail);
  }
  return { storeId: m.storeId, files: m.files, by: m.by, writtenAt: m.writtenAt };
}

export function writeMarker(base, { storeId, files, by }) {
  if (typeof storeId !== 'string' || !storeId) throw new TypeError('observogram store: the marker needs the store_id');
  if (!isPlainObject(files)) throw new TypeError('observogram store: the marker\'s files are the legacy_hashes object');
  if (!MARKER_BY.includes(by)) throw new TypeError(`observogram store: a marker is written by one of ${MARKER_BY.join(', ')}, not ${JSON.stringify(by)}`);
  const path = markerPath(base);
  mkdirSync(base, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ storeId, writtenAt: nowIso(), by, files }, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, path); } catch (e) { try { rmSync(tmp, { force: true }); } catch { /* best effort */ } throw e; }
  return path;
}

// ---------- data ----------

// Does `path` hold data? Absent → false; a symlink → true (never
// followed); a regular file → it is not empty; a directory → some
// descendant holds data. So an empty packs/, a tree of empty directories
// and a zero-byte deploys.jsonl hold none.
export function hasData(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink()) return true;
  if (st.isFile()) return st.size > 0;
  if (st.isDirectory()) return readdirSync(path).some((name) => hasData(join(path, name)));
  return true;
}

// Exists, without following a symlink (a dangling one exists).
export function lexists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if (e?.code === 'ENOENT') return false;
    throw e;
  }
}
