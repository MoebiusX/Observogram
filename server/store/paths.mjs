// server/store/paths.mjs — the form in which the store's offline operations
// compare two paths: an export target with the workspace (a directory
// export's refusal, the in-place detection), the database with the
// workspace, a purged org's root with <base>/orgs and the users file with
// that root, a backup or restore path with the database and its
// -wal/-shm/-journal.
//
// comparedPath(own) → compared(p, beside, { deleting }), the function a check
// compares through: p's form, placed beside the path it is checked against
// when one is given (on Windows, null instead when p, reached through a share —
// or, deleting, a path the native realpath cannot fully resolve — may lie
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
// (with the volume serial's low 32 bits: all a share reports) — and spelled
// from there. A file id and a volume are read through a handle opened on the
// path (openSync, fstatSync, closeSync: libuv opens a directory too), which
// reports the serial on every libuv, never a stat by name: libuv answers one
// by the path's name (GetFileInformationByName, Windows 11 24H2 and Server
// 2025) unless the path is reached through a share or its last name is a
// reparse point, which it opens, and 1.49.0 to 1.50.x (Node 22.16.0's
// 1.49.2) declared FILE_STAT_BASIC_INFORMATION with its last two fields
// swapped, so a stat by name reported the upper half of the file's 128-bit id
// as the device, 0 on NTFS: C:\ws read as on another volume than \\myhost\ws,
// nothing placed a path through that share, and a directory export to
// \\myhost\ws\exports\new was written into the workspace. A path reached
// through a share that this cannot place may still lie inside that path: a share of a directory below it
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
// volume (another serial) stays an ordinary target — except to purge-org's
// users-file check, whose "outside" answer deletes the root beside it: it
// passes { deleting: true }, and there any path through a share (by its name
// or a drive mapped to one) that nothing places answers null, whatever volume
// it reports. A DFS link sits below a namespace root another server answers,
// so while the link's target is down (\\corp\dfs\betasub, a link to
// \\myhost\betasub) the nearest path that answers reports that server's
// volume, not the one the link leads to. A path the native realpath cannot
// fully resolve is the same unknown: realpath stops at a part that exists but
// that it cannot read through, and the rest is read as written beside it,
// while the path may lead under the root as well as anywhere else — through a
// link (a symlink or a junction) whose target cannot be opened
// (C:\links\betasub\users.json, with C:\links\betasub a symlink to
// \\myhost\betasub while that share is down, or C:\cfg\users.json, a file
// symlink to \\myhost\betasub\users.json), a chain of them, any other reparse
// point whose target cannot be opened (a cloud placeholder, a deduplicated
// file, a tag no filter on this host handles), or on a volume whose paths
// realpath cannot name at all (an ImDisk RAM disk, which bypasses the Volume
// Mount Manager: its root among them, so a short name or a link there is read
// as written). So with { deleting: true } a path answers null, on any root,
// when a part the walk that spells it could not read exists: lstatSync
// answers it, a link or not, or fails for another reason than that it does
// not exist (ENOENT) — libuv's lstat opens through a reparse point it
// does not take for a link, as stat does, and fails with that open's error —
// or when that walk could not read even its root: a drive letter not mapped
// when it runs, or one mapped to a share that cannot be reached, where the
// path stays spelled as written on that letter, as on a local drive.
// Those parts are the ones that walk could not read, not a second walk's: one
// that found a share back would read through the link while the path stays
// spelled as written on the link's drive, and a later read that found the
// letter mapped, or its share back, would give that spelling a volume
// (Z:\users.json, with Z: mapped to \\myhost\betasub, compared as outside the
// root). A path that lies outside the root is refused alike, through such a
// link or on such a volume (a declared false refusal). A path whose realpath
// stops only at parts that do not exist yet, below a root it reads, is judged
// as before, and one through a link whose target opens is followed to it —
// except that a share's server follows a junction on its volume itself, and
// SMB before Windows 10/Server 1709 (at either end) has no normalized-name
// query, so there the native realpath names a path through a share as the
// client opened it, the junction by its own name: placed by the share's
// directory, \\myhost\ws\links\j\users.json, with C:\ws\links\j a junction to
// C:\ws\orgs\beta\sub, was spelled C:\ws\links\j\users.json, outside the
// root. So with { deleting: true } a path answers null too when a part that
// walk read is a link to lstatSync — realpath named it without following
// it — or one lstatSync cannot read now; through a junction outside the root
// it is refused alike (a declared false refusal).
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
// keeps the path as given. host = { windows, path, realpathSync, lstatSync,
// openSync, fstatSync, closeSync } (the platform, node:path's, node:fs's
// realpathSync with its .native, lstatSync, openSync, fstatSync and
// closeSync) is injectable (server/test-store-paths.mjs); the default is this
// host.

import { closeSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import * as nodePath from 'node:path';

const ON_WINDOWS = process.platform === 'win32';

export function comparedPath(own, { windows = ON_WINDOWS, path = nodePath, realpathSync: fsRealpath = realpathSync, lstatSync: fsLstat = lstatSync, openSync: fsOpen = openSync, fstatSync: fsFstat = fstatSync, closeSync: fsClose = closeSync } = {}) {
  if (!windows) return own;
  const real = (p, unread = []) => {   // the native realpath of p's longest prefix it can read, the rest as written; unread gets the parts it cannot
    try { return fsRealpath.native(p); } catch {
      unread.push(p);
      const parent = path.dirname(p);
      return parent === p ? p : path.join(real(parent, unread), path.basename(p));
    }
  };
  const form = (native) => {
    const folded = native.replaceAll('/', '\\').toLowerCase();
    return folded.endsWith('\\') ? folded.slice(0, -1) : folded;   // a root too, so <form> + \ prefixes what lies under it
  };
  const root = (native) => form(path.parse(native).root);
  const stat = (p) => {   // p's stats through a handle opened on it, closed before it answers, or null when p cannot be opened
    try {
      const fd = fsOpen(p, 'r');
      try { return fsFstat(fd, { bigint: true }); } finally { fsClose(fd); }
    } catch { return null; }
  };
  const fileId = (p) => { const st = stat(p); return st && `${st.dev & 0xffffffffn}:${st.ino}`; };
  const lineage = (native) => {   // native and its ancestors, nearest first
    const dirs = [native];
    while (path.dirname(dirs.at(-1)) !== dirs.at(-1)) dirs.push(path.dirname(dirs.at(-1)));
    return dirs;
  };
  const volume = (native) => {   // the volume serial's low 32 bits of native's nearest path that opens, or null
    for (const dir of lineage(native)) { const st = stat(dir); if (st) return st.dev & 0xffffffffn; }
    return null;
  };
  const exists = (part) => {   // lstatSync answers part, or cannot read it for another reason than that it does not exist
    try { fsLstat(part); return true; } catch (e) { return e?.code !== 'ENOENT'; }
  };
  const linked = (part) => {   // lstatSync answers part as a link, or (a part the walk read) cannot read it now
    try { return fsLstat(part).isSymbolicLink(); } catch { return true; }
  };
  return (p, beside, { deleting = false } = {}) => {
    const unread = [];   // the parts of p the walk that spells native could not read, nearest first
    const native = real(path.resolve(p), unread);
    if (beside === undefined) return form(native);
    // realpath cannot resolve p — not even its root, or at a part that exists — or named a link it read as a part (a
    // junction a share's server followed): it may lead anywhere (above)
    if (deleting && (unread.some((part) => path.dirname(part) === part) || unread.some(exists) || lineage(native).slice(unread.length).some(linked))) return null;
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
    // Not placed: through a share on beside's volume (on any volume, when deleting), or on a volume that cannot be
    // read, p may lie inside it (above).
    const vol = volume(native);
    if (vol === null || (root(native).startsWith('\\\\') && (deleting || vol === volume(other)))) return null;
    return form(native);
  };
}
