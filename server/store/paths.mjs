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
// does not take for a link, as stat does, and fails with that open's error.
// Those parts are the ones that walk could not read, not a second walk's: one
// that found a share back would read through the link while the path stays
// spelled as written on the link's drive. A path that lies outside the root
// is refused alike, through such a link or on such a volume (a declared false
// refusal). A path whose realpath stops only at parts that do not exist yet is
// judged as before, and one through a link whose target opens is followed to
// it.
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
// keeps the path as given. host = { windows, path, realpathSync, statSync,
// lstatSync } (the platform, node:path's, node:fs's realpathSync with its
// .native, node:fs's statSync and lstatSync) is injectable
// (server/test-store-paths.mjs); the default is this host.

import { lstatSync, realpathSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

const ON_WINDOWS = process.platform === 'win32';

export function comparedPath(own, { windows = ON_WINDOWS, path = nodePath, realpathSync: fsRealpath = realpathSync, statSync: fsStat = statSync, lstatSync: fsLstat = lstatSync } = {}) {
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
  const exists = (part) => {   // lstatSync answers part, or cannot read it for another reason than that it does not exist
    try { fsLstat(part); return true; } catch (e) { return e?.code !== 'ENOENT'; }
  };
  return (p, beside, { deleting = false } = {}) => {
    const unread = [];   // the parts of p the walk that spells native could not read, nearest first
    const native = real(path.resolve(p), unread);
    if (beside === undefined) return form(native);
    if (deleting && unread.some(exists)) return null;   // realpath cannot resolve p: it may lead anywhere (above)
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
