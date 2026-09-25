// server/store/legacy-files.mjs — the pre-store identity files, read once
// (docs/STORE_PLAN.md §4 steps 2–3).
//
// users.json and orgs.json were the source of truth before the store. The
// first start of a store build imports them, records their SHA-256 in
// schema_meta legacy_hashes and in <base>/.store-imported (the marker), and
// never reads them again except to compare hashes. This module is the only
// place that knows their paths, their structure and how they are written:
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
// server/store/{import,ops,cli}.mjs, the suites and server/fixtures/* may
// import it.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { baseWorkspacePath, brandEnv } from '../../tools/lib/brand-env.mjs';
import { nowIso } from './db.mjs';
import { getMeta } from './meta.mjs';

// The flat workspace entries that belong to an org (moved from tenancy.mjs).
export const MIGRATABLE = Object.freeze(['packs', 'deploys.jsonl', 'snapshots', 'journeys', 'runs']);
export const MARKER = '.store-imported';
const MARKER_BY = Object.freeze(['import', 'replace', 'export', 'repair', 'purge-org']);

const LEGACY_TAIL = 'the upgrade imports nothing until it is fixed';
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
