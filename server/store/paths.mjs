// server/store/paths.mjs — the form in which the store's offline operations
// compare two paths: an export target with the workspace (a directory
// export's refusal, the in-place detection), the database with the
// workspace, a purged org's root with <base>/orgs and the users file with
// that root, a backup or restore path with the database and its
// -wal/-shm/-journal.
//
// comparedPath(own) → compared(p, beside), the function a check compares
// through: p's form, placed beside the path it is checked against when one
// is given (on Windows, null instead when p, reached through a share, may lie
// inside it: below). Off Windows it is `own`, the calling module's realpath
// form (which takes p alone), so Linux and macOS compare exactly as before. On Windows a
// spelling does not name a path: NTFS names are case-insensitive and a
// directory has a short (8.3) name beside its long one, so C:\ws, c:/WS and
// C:\WS~1 are one directory, and JS realpathSync keeps whichever the caller
// wrote. There a path is compared as the native realpath (long names, the
// case on disk) of its longest prefix that exists, the rest appended as
// written, with \ separators, case folded and no trailing separator — the
// form a studio-run journey's org scope compares in (crawlScopeRefusal,
// tools/lib/journey.mjs). A network share is one more name that realpath
// keeps (\\myhost\ws, a drive mapped to it, \\localhost\C$\ws): a share this
// host serves is stored on a local drive, so with the workspace or the
// database named through one, their local path (C:\ws\…) is them too, and an
// admin may name a local workspace through a share. So when p and the path
// it is checked against are not under one name (their realpaths' roots
// differ), p is placed by the nearest of itself and its directories that is
// that path or one of its directories — the same file id on the same volume
// (statSync, with the volume serial's low 32 bits: all a share reports) —
// and spelled from there. A path reached through a share that this cannot
// place may still lie inside that path: a share of a directory below it
// (\\myhost\exports, which is C:\ws\exports, beside C:\ws) names none of its
// directories. So on that path's volume such a path answers null — it may lie
// inside — and the export, purge-org and no-marker checks refuse it, naming
// the way out (its path on a local drive, or for the database its path under
// the workspace as that is named; for an export with none, a local directory
// copied there afterwards), even when it lies outside (a share of
// C:\out, which no file id tells apart). A share of another machine whose
// volume has that serial is refused alike when nothing places it: machines
// cloned from one image keep their disks' serials, and the low 32 bits do not
// tell hosts apart. So does a path whose volume cannot be read, on any root:
// a share, or a drive mapped to one, that cannot be reached (its server
// stopped, its name not resolving) — or a drive that does not exist — may
// lead anywhere, under a purged root among them (\\myhost\betasub, which is
// C:\ws\orgs\beta\sub); purge-org refuses a users file recorded through one,
// an export there is refused before it would fail to write, and a database
// there is missing before it is compared. One through a share on another
// volume (another serial) stays an ordinary target.
// Placement only ever makes a check more conservative, since a file id names
// a file on one volume, not on one host: a sector copy keeps the MFT, so a
// machine cloned from this host's image, or this drive's disk image attached
// as E:, keeps the serial and the file id of every file it was copied with —
// the root directory's among them, MFT record 5 on every NTFS volume — and
// placement spells \\machineb\C$\ws or E:\ws as C:\ws. So a containment
// refusal (a directory export inside the workspace, purge-org's users file
// under the root) compares placed, where a false "inside" only refuses, with
// the ways out it names; a check whose "same" or "inside" answer writes,
// skips a file or takes it for the store's own — the in-place detection, the
// scan for another store, the no-marker check, backup.mjs's own-file check —
// compares p alone (no beside). The scan then reads a database only
// placement makes this one; the others refuse a path only placement makes
// the same (the no-marker check: inside, or null), naming the way out — the
// workspace or the database by its own path, a path on the database's drive,
// an empty or new directory. The twin of this rule is
// crawlScopeRefusal's placement, which places only a local path while the
// workspace is named through a share (it refuses any other path off a local
// drive). That form only compares: every message, record and return value
// keeps the path as given. host = { windows, path, realpathSync, statSync }
// (the platform, node:path's, node:fs's realpathSync with its .native and
// node:fs's statSync) is injectable (server/test-store-paths.mjs); the
// default is this host.

import { realpathSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

const ON_WINDOWS = process.platform === 'win32';

export function comparedPath(own, { windows = ON_WINDOWS, path = nodePath, realpathSync: fsRealpath = realpathSync, statSync: fsStat = statSync } = {}) {
  if (!windows) return own;
  const real = (p) => {
    try { return fsRealpath.native(p); } catch {
      const parent = path.dirname(p);
      return parent === p ? p : path.join(real(parent), path.basename(p));
    }
  };
  const form = (native) => {
    const folded = native.replaceAll('/', '\\').toLowerCase();
    return folded.endsWith('\\') ? folded.slice(0, -1) : folded;   // a root too, so <form> + \ prefixes what lies under it
  };
  const root = (native) => form(path.parse(native).root);
  const stat = (p) => { try { return fsStat(p, { bigint: true }); } catch { return null; } };
  const fileId = (p) => { const st = stat(p); return st && `${st.dev & 0xffffffffn}:${st.ino}`; };
  const lineage = (native) => {   // native and its ancestors, nearest first
    const dirs = [native];
    while (path.dirname(dirs.at(-1)) !== dirs.at(-1)) dirs.push(path.dirname(dirs.at(-1)));
    return dirs;
  };
  const volume = (native) => {   // the volume serial's low 32 bits of native's nearest path that exists, or null
    for (const dir of lineage(native)) { const st = stat(dir); if (st) return st.dev & 0xffffffffn; }
    return null;
  };
  return (p, beside) => {
    const native = real(path.resolve(p));
    if (beside === undefined) return form(native);
    const other = real(path.resolve(beside));
    if (root(native) === root(other)) return form(native);
    const theirs = new Map();   // file id → the directory (or file) of beside's lineage it names
    for (const dir of lineage(other)) {
      const id = fileId(dir);
      if (id && !theirs.has(id)) theirs.set(id, dir);
    }
    for (const dir of lineage(native)) {
      const same = theirs.get(fileId(dir));
      if (same) return form(path.join(same, native.slice(dir.length)));
    }
    // Not placed: through a share on beside's volume, or on a volume that cannot be read, p may lie inside it (above).
    const vol = volume(native);
    if (vol === null || (root(native).startsWith('\\\\') && vol === volume(other))) return null;
    return form(native);
  };
}
