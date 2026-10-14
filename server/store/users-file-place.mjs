// server/store/users-file-place.mjs — whether `packc store purge-org` would delete the users file a pre-store build
// reads, decided by what deleting the org's root takes, not by how the users file's path is spelled.
//
// purge-org (server/store/ops.mjs) deletes a removed org's root with rmSync(root, { recursive: true }). The users
// file a pre-store build reads is the one recorded at the import (schema_meta.users_file, the path
// OBSERVOGRAM_USERS_FILE named then), or <base>/users.json when none was recorded. Its path may lie outside the root
// while its bytes lie under it: through a mount of a directory under the root (/mnt/b/users.json, /mnt/b a bind
// mount of <root>/sub), reached directly or through a link — realpath never crosses a mount back to its source —
// or as a hard link. Comparing the path alone, purge-org deleted it. So the check reads what rmSync would delete:
//
//   - the walk: the root and everything under it, as rmSync takes it — lstat each entry, list each directory, each name
//     as the bytes the filesystem holds, as rmSync lists them (as a string, node:fs gives a name that is not valid UTF-8
//     with U+FFFD in place of each such byte, a name no lookup finds, and the walk read nothing under it), never through
//     a link (a symlink, or a junction on Windows). A refusal names a path holding such a name as a POSIX shell's $'…'
//     spells it, each such byte \xNN. A mount point under the root is refused: a directory on another filesystem than
//     the directory that holds it, an entry /proc/self/mountinfo lists (Linux: a bind mount of a directory of the same
//     filesystem, which lstatSync cannot tell from a directory, or a file mounted on a file;
//     matched by the root's real path, as the kernel lists it; not one a later mount covers — mounted in the same
//     parent mount on a directory above it, or covering that parent so — which the kernel lists too, while its path
//     shows a directory of the filesystem mounted above, where nothing is mounted, unless that path leads through a
//     mount of the filesystem the covered one lies in (its device, as /proc/self/mountinfo lists it):
//     `mount --bind /srv /srv` over it, a recursive bind whose copy of it was unmounted, or a bind mount, on the
//     filesystem above, of a directory it lies in — its path may then show the very directory it is mounted on, which
//     rmdir refuses (EBUSY) while that is a mount point anywhere, so it is refused, naming what to unmount first, in
//     order (a declared false refusal where that mount shows another directory there); a mount on / itself covers nothing,
//     since a path is looked up from the process's root and a lookup never crosses a mount stacked on it, so with a
//     tmpfs mounted on / in a chroot, or `mount --bind / /`, a mount under the root is refused still), a directory the
//     walk reached already
//     (one directory mounted at a second place under the root), or on Windows a folder another volume is mounted in
//     (lstatSync answers the folder, statSync the volume). Any other entry on another filesystem than its directory is
//     one only as /proc/self/mountinfo lists it: an overlay mount whose layers lie on different filesystems (xino=off)
//     shows its directories on its own device and a lower layer's files on that layer's, with nothing mounted there
//     (without /proc/self/mountinfo, see below). On Node 22 rmSync stops part-way at a mount point; on Node 23 and later it
//     first deletes the files of the filesystem mounted there; and a directory mounted from outside the root may hold
//     the users file. The users file found under the root besides (none of it at a mount point, as placed below) is named
//     in that refusal, to move out with the unmounting: unmounted, its path may lead there no more — a link of its name in
//     a directory mounted there from outside the root, to a file under it — and run again as the refusal said, the purge
//     went on into the empty mount point and deleted it. The root itself mounted (a volume per org) is refused alike. A
//     directory the walk cannot read is refused: what lies in it cannot be told, and rmSync would fail part-way there. The
//     walk keeps nothing of a file it passes — each entry is compared with the users file, and with its name, as the walk
//     reaches it (below) — and of a directory its path, device, inode, change and modification time and a digest of its
//     names, holding besides only the listing of each directory it is in, as Node 22's rmSync does: kept entry by entry,
//     the stats of a root of millions of files took more memory than the heap had, and purge-org died where rmSync
//     completed.
//   - the users file, its path followed through every link (statSync), before the walk and again after it — one that
//     changed meanwhile (another device, inode, size or modification time) is compared with each entry read again: it
//     lies under the root when an entry the walk found is the same file — the same device and inode (on Windows the volume serial's low 32 bits, all a
//     share reports, as server/store/paths.mjs places a path) — or, on another device, the same kind with the same
//     modification time, compared at the coarser of the two clocks' precision (an SMB view keeps 100 ns, an sshfs
//     one seconds), and for a file the same size, for a directory the same inode. That is a view of it through
//     another filesystem: an NFS or SMB mount of a directory under the root reports the server's inode with
//     another device; an overlay mount reports another device and, with xino or once the file is copied up into an
//     upper directory under the root, another inode too. A copy under the root that kept the users file's size and
//     modification time on another device reads the same (a declared false refusal; moving it out is the way out).
//     Every matching entry is named, so one move clears them all (hard links included). Through a view whose
//     directories show another inode or modification time than theirs under the root (an overlay mount with an upper
//     directory shows that directory's), the path then leads where nothing traces it back, and it is refused as a users
//     file that does not exist (below): a view's refusal names that second step, deleting the root by hand.
//   - a users file that does not exist: nothing of it is under the root to delete, unless its path leads there through
//     what is not there now — a filesystem not mounted. So its place is found as the kernel would resolve the path,
//     every link that exists followed (a dangling one by its target), to the nearest directory that exists there. One
//     the walk read (by identity, as above) means it leads under the root — a users file moved out of the root,
//     recorded there or reached through a mount of a directory under it or a link into it — and, while no entry under
//     the root has the name the path ends in, the purge goes on. With one it is refused by that name (below): a
//     directory on its path may be the mount point of a mount that is down, an empty directory under the root, and
//     mounted again the path leads to the file of that name in the directory mounted there (<root>/other bind-mounted on
//     <root>/sub/m, the users file at <root>/other/users.json recorded through it: unmounted, as the refusal of that
//     mount point said, the purge deleted it). The purge goes on, too, when the path is looked up only in directories
//     the root lies in (its parent and theirs, on the root's real path) or that the root's own path, as purge-org names
//     it, is looked up in (every link on it followed: a workspace, or its orgs/, reached through a link in a directory
//     the root does not lie in, that directory and those above it) — each by its path, case folded on Windows, and its
//     device and inode — and no entry under the root has the name the path ends in: the directory of an org purged
//     before, which the users file was moved out of as its refusal said, or a file deleted in one of them. A filesystem
//     mounted again on one of them covers the root too, or hides the link the root's own path is reached through, so
//     through it the path leads under the root by a directory under the root mounted in it, which shows the users file
//     by its name, or by a link that is not seen (below). Any other is refused, failing closed: a mount that is down
//     leaves its mount point an empty directory, which tells nothing. So a recorded users file deleted elsewhere outside
//     the root is refused too (declared), and deleting the root by hand is its way out. The default <base>/users.json,
//     which nothing records, absent — nothing at its path, not even a link — is nothing to keep (a store that keeps no
//     local users may have none); a link there that leads nowhere now is placed as a recorded path is, since through a
//     mount that is down it may lead under the root.
//   - a users file that cannot be read — statSync failing otherwise (EACCES on a directory of its path, a link loop),
//     or a part of its path that cannot be read — is refused.
//   - a users file that exists and that no entry is: before the purge goes on, each directory the walk read is read
//     again — the same directory (device and inode), the same change time, which moves with every entry added, removed
//     or renamed in it, and the same names. The walk read each directory at its own moment, so an entry another process
//     renamed while it ran, from a directory not read yet into one read already (the users file, or a directory holding
//     it), was in neither listing. A directory that changed is refused; stopping what changes it and running purge-org
//     again is its way out.
//   - and then an entry under the root with its name — the name its path ends in, as written or at each link it leads
//     through, compared ignoring case and Unicode normalization: a mount that is down keeps what was written in its mount
//     point meanwhile, so the path leads to such a file now, and mounted again to the file of that name in the directory
//     mounted there, under the root. It is refused, naming each such entry and, for one that is a link, what it leads to
//     under the root (rmSync deletes that once the link is moved); moving them out of the root is its way out. An entry of
//     that name that is not the users file is refused too (a declared false refusal). A view of a directory under the root
//     shows its names, so the users file seen through one that reports neither the inode nor the size and modification
//     time is refused by its name. A users file that does not exist whose path leads into a directory the walk read is
//     refused so too (above); there moving the entries out is the whole way out.
//
// Without /proc/self/mountinfo (off Linux, or /proc not mounted), a bind mount under the root of a directory from
// outside it, on the same filesystem, is a directory to lstatSync (the same device), and the walk enters it; and any
// entry on another device than its directory is refused as a mount point, a lower layer's file of an overlay mount whose
// layers lie on different filesystems too (on Linux with /proc not mounted: a false refusal, whose way out is to mount
// proc at /proc, `mount -t proc proc /proc`, then run purge-org again). A view that reports neither the inode nor the
// size and modification time (some FUSE filesystems) is not matched as the users file (through a view of a directory, by
// its name, above); and a recorded path that passes through a link under the root keeps the file the link leads to
// (rmSync deletes the link alone), but leads nowhere once it is gone. Not seen either: what another process moves, links
// or mounts under the root after the check, before rmSync takes it; a directory changed and changed back within one tick
// of a coarse filesystem clock, its change time and names as they were; a same-filesystem bind mount made on a directory
// under the root after /proc/self/mountinfo was read, before the walk reaches it, or uncovered there then (a bind mount
// from the same filesystem over a directory above the root, unmounted); through a mount that is down, what the
// name does not tell — a file mounted on a file of another name, its mount point a file of its own, what a link of
// that name under the root leads to back through the mount that is down, or what a link of that name in a directory
// mounted under the root from outside it leads to under the root, once that mount is down before purge-org saw it up
// (up, its refusal names the users file there); and a filesystem that is down now, mounted on a directory the root lies in,
// whose link leads a users file that does not exist into the root another way than by its name there (through a second
// mount of the root's filesystem), or mounted on one only the root's path as named is looked up in (the directory
// holding the link to the workspace, say), by a link to the root's real path.
//
// usersFilePlace(file, root, { recorded, id, fs, path, windows }) → { exists, refusal }: exists is whether the users
// file's path leads to a file now (true), or not (false), or null when the check stopped before it could tell;
// refusal is purge-org's message, or null when deleting the root takes nothing of the users file. recorded is false
// for <base>/users.json when nothing was recorded; id is the org's. fs = { lstatSync, statSync, readdirSync,
// readlinkSync, realpathSync, readFileSync } (node:fs's; the stats called with { bigint: true }, readdirSync with
// { encoding: 'buffer' }), path (node:path's) and windows (the platform) are injectable (server/test-store-ops.mjs, over
// server/fixtures/mount-fs.mjs); the default is this host.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

const ON_WINDOWS = process.platform === 'win32';
const GONE = new Set(['ENOENT', 'ENOTDIR']);
const SECOND = 1_000_000_000n;
const MAX_LINKS = 40;   // Linux's MAXSYMLINKS
const MOUNTINFO = '/proc/self/mountinfo';
// A mount point as /proc/self/mountinfo spells it (its fifth field): the kernel's octal escapes (\040 a space, \011,
// \012, \134) undone.
const unoctal = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)));

// The precision of a timestamp in ns: the largest power of ten, up to a second, that divides it.
function precision(ns) {
  let q = 1n;
  while (q < SECOND && ns % (q * 10n) === 0n) q *= 10n;
  return q;
}
// Two modification times are the same at the coarser of their precisions (one clock may keep less).
function sameTime(a, b) {
  const q = precision(a) > precision(b) ? precision(a) : precision(b);
  return a - (a % q) === b - (b % q);
}

const list = (items) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// A path the walk holds as bytes — a name in it is not valid UTF-8 — spelled as a POSIX shell's $'…' takes it: each byte
// that is not part of a UTF-8 character as \xNN, a backslash or a quote escaped, so a refusal names a path one can type.
function spelled(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    const n = b < 0x80 ? 1 : b >= 0xc2 && b < 0xe0 ? 2 : b >= 0xe0 && b < 0xf0 ? 3 : b >= 0xf0 && b < 0xf5 ? 4 : 0;
    const seq = bytes.subarray(i, i + n);
    const ch = n && seq.length === n ? seq.toString('utf8') : '';
    if (ch && Buffer.from(ch, 'utf8').equals(seq)) {
      s += ch === '\\' || ch === "'" ? `\\${ch}` : ch;
      i += n;
    } else {
      s += `\\x${b.toString(16).padStart(2, '0')}`;
      i += 1;
    }
  }
  return `$'${s}'`;
}

export function usersFilePlace(file, root, { recorded = true, id = '<id>', fs = nodeFs, path = nodePath, windows = ON_WINDOWS } = {}) {
  const lstat = (p) => fs.lstatSync(p, { bigint: true });
  const stat = (p) => fs.statSync(p, { bigint: true });
  const dev = (st) => (windows ? st.dev & 0xffffffffn : st.dev);
  const same = (a, b) => {
    if (dev(a) === dev(b)) return a.ino === b.ino;
    if (a.isFile() && b.isFile()) return a.size === b.size && sameTime(a.mtimeNs, b.mtimeNs);
    if (a.isDirectory() && b.isDirectory()) return a.ino === b.ino && sameTime(a.mtimeNs, b.mtimeNs);
    return false;
  };
  // A path under the root is a string, or the bytes the filesystem holds once a name on it is not valid UTF-8 (below).
  const named = (p) => (typeof p === 'string' ? p : spelled(p));
  const under = (p) => typeof p !== 'string' || p.startsWith(root + path.sep);
  const who = recorded ? `the recorded users file ${file}`
    : `the users file ${file} (the one a pre-store build reads: OBSERVOGRAM_USERS_FILE was not set at the import)`;
  const code = (e) => e?.code || e?.message || 'error';
  const stopped = (refusal) => ({ exists: null, refusal });

  // The walk: what rmSync(root, { recursive: true }) would delete.
  const denied = (e) => e?.code === 'EACCES' || e?.code === 'EPERM';
  const unreadable = (at, e) => stopped(`${named(at)}${under(at) ? ` under ${root}` : ''} cannot be read (${code(e)}), so purge-org cannot `
    + `tell what deleting ${root} takes — nothing was deleted. `
    + (denied(e) ? `Run purge-org as a user who can read it; or, if ${who} does not lie under ${root}, delete ${root} by hand as such `
      + 'a user'
      : `If it is a filesystem mounted there that stopped answering, unmount it, then run purge-org again; or, if ${who} does not `
      + `lie under ${root}, delete ${root} by hand`)
    + `, then run purge-org again: it drops org ${id}'s records`);
  const mounts = [];    // { at, why }
  // A file's device and inode, as one string (joined, so one flat string and not a rope of its parts).
  const idOf = (st) => [dev(st), st.ino].join(':');
  const walked = new Map();   // a directory's idOf → its path
  // { at, key, ctimeNs, names, mtimeNs }: each directory the walk listed, as it found it — the same directory (key, its
  // idOf) with the same change time and names (a digest of them): an entry added, removed or renamed in it, or a mount over
  // it, changes one of them — and its modification time, which with its device and inode places a users file that does
  // not exist (below). Of the other entries the walk keeps only those that are the users file or have its name (below):
  // with the listings of the directories it is in (frames), its memory is a few hundred bytes and the path for each
  // directory under the root, and nothing for a file.
  const read = [];
  const DIRECTORY = { isFile: () => false, isDirectory: () => true };
  // Each name as the bytes the filesystem holds: listed as a string, a name that is not valid UTF-8 comes back with U+FFFD
  // in place of each such byte, a name no lookup finds, and what lies under it would go unread. A name that is valid UTF-8
  // is kept as a string and joins its directory's path as one, as before; any other is kept as its bytes, and it and every
  // path under it are joined as bytes. A directory's names, in the walk's order: as strings, then by their bytes.
  const nameIn = (b) => {
    const s = b.toString('utf8');
    return Buffer.from(s, 'utf8').equals(b) ? s : b;
  };
  const bytesOf = (n) => (typeof n === 'string' ? Buffer.from(n, 'utf8') : n);
  const keyOf = (n) => (typeof n === 'string' ? n : n.toString('utf8'));
  const order = (x, y) => {
    const [a, b] = [keyOf(x), keyOf(y)];
    return a < b ? -1 : a > b ? 1 : Buffer.compare(bytesOf(x), bytesOf(y));
  };
  const listing = (at) => Array.from(fs.readdirSync(at, { encoding: 'buffer' }), nameIn).sort(order);
  const namesOf = (names) => {
    const digest = createHash('sha256');
    for (const n of names) digest.update(typeof n === 'string' ? `${n}\0` : Buffer.concat([n, Buffer.from([0])]));
    return digest.digest('base64');
  };
  const child = (at, n) => (typeof at === 'string' && typeof n === 'string' ? path.join(at, n)
    : Buffer.concat([Buffer.from(at), Buffer.from(path.sep), bytesOf(n)]));
  const rootBytes = Buffer.byteLength(root);
  const relative = (at) => (typeof at === 'string' ? at.slice(root.length) : at.subarray(rootBytes).toString('utf8'));
  let above;
  try { above = dev(stat(path.dirname(root))); } catch (e) { return unreadable(path.dirname(root), e); }
  // The mount points Linux lists at the root or under it, as paths relative to it ('' the root itself): a bind mount of a
  // directory of the same filesystem among them, which lstatSync cannot tell from a directory. The kernel lists real
  // paths, so the root's is compared. Each maps to null, or for a covered mount whose path may show what it is mounted on
  // (below), to the mount points to unmount first, in order. No such file (off Linux, /proc not mounted): only the walk tells.
  const listed = new Map();
  let info = null;
  if (!windows) {
    try { info = fs.readFileSync(MOUNTINFO, 'utf8'); } catch (e) { if (!GONE.has(e?.code)) return unreadable(MOUNTINFO, e); }
  }
  if (info !== null) {
    let real;
    try { real = fs.realpathSync(root); } catch (e) { return unreadable(root, e); }
    // Each line's mount ID, its parent mount's, its filesystem's device (major:minor) and its mount point. The kernel lists
    // a mount that a later one covers too — one mounted in the same parent mount on a directory above it, or covering that
    // parent so — while its path shows what the mount above holds there. Of another filesystem, that is a directory where
    // nothing is mounted, and unmounting it fails (not mounted): such a covered mount is passed over. Through a mount of the
    // filesystem the covered mount lies in — a bind mount of a directory above it (`mount --bind /srv /srv`, a recursive one
    // whose copy of the covered mount was unmounted, or one made on the filesystem mounted above) — it may be the very
    // directory the covered mount is mounted on, which rmdir and unlink refuse (EBUSY) while it is a mount point anywhere:
    // such a covered mount is refused, naming what to unmount first.
    const lines = [];
    const inParent = new Map();   // a parent mount's ID → the mounts in it
    for (const line of info.split('\n')) {
      const [mount, parent, device, , field] = line.split(' ');
      if (field === undefined) continue;
      const m = { id: mount, parent, device, at: unoctal(field) };
      lines.push(m);
      if (!inParent.has(parent)) inParent.set(parent, []);
      inParent.get(parent).push(m);
    }
    const byId = new Map(lines.map((m) => [m.id, m]));
    // A mount on / itself covers nothing: a path is looked up from the process's root, and a lookup never crosses a mount
    // stacked on it (`mount --bind / /`, or a tmpfs mounted on / in a chroot), which the kernel lists at / all the same.
    const above = (a, b) => a !== path.sep && b !== a && b.startsWith(a + path.sep);
    const hidden = new Map();
    const covered = (m) => {
      if (!hidden.has(m)) {
        hidden.set(m, false);   // a loop of parents, which no kernel lists, reads as not covered
        const parent = byId.get(m.parent);
        hidden.set(m, inParent.get(m.parent).some((c) => above(c.at, m.at)) || (parent !== undefined && covered(parent)));
      }
      return hidden.get(m);
    };
    // The mount a lookup of at ends in: the deepest of those it crosses (not covered, mounted on a directory above it or on
    // at), the topmost of a stack there — on /, the lowest, the process's root.
    const endsIn = (at) => {
      const crossed = lines.filter((y) => (y.at === path.sep || y.at === at || at.startsWith(y.at + path.sep)) && !covered(y));
      const depth = Math.max(...crossed.map((y) => y.at.length));
      const stack = crossed.filter((y) => y.at.length === depth);
      return stack.find((y) => (y.at === path.sep ? !stack.some((z) => z.id === y.parent) : !stack.some((z) => z.parent === y.id)));
    };
    // Whether the path of the covered mount m may show what it is mounted on: it leads through a mount of the filesystem m
    // lies in (or either is not listed).
    const shows = (m) => {
      const [x, parent] = [endsIn(m.at), byId.get(m.parent)];
      return x === undefined || parent === undefined || x.device === parent.device;
    };
    // What to unmount, in order, before the covered mount m can be unmounted at its path: what covers its parent, then each
    // mount in its parent over a directory above it (the outermost first), and the mounts in m — each after the mounts in
    // it, which keep it busy.
    const outermost = (a, b) => a.at.length - b.at.length || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const firstOff = (m) => {
      const seen = new Set([m]);
      const within = (c) => {
        if (seen.has(c)) return [];
        seen.add(c);
        return [...[...(inParent.get(c.id) ?? [])].sort(outermost).flatMap(within), c];
      };
      const uncover = (n) => {
        const parent = byId.get(n.parent);
        const outer = [];
        if (parent !== undefined && !seen.has(parent) && covered(parent)) {
          seen.add(parent);
          outer.push(...uncover(parent));
        }
        return [...outer, ...inParent.get(n.parent).filter((c) => above(c.at, n.at)).sort(outermost).flatMap(within)];
      };
      return [...uncover(m), ...[...(inParent.get(m.id) ?? [])].sort(outermost).flatMap(within)].map((c) => c.at);
    };
    for (const m of lines) {
      if (m.at !== real && !m.at.startsWith(real + path.sep)) continue;
      const at = m.at.slice(real.length);
      if (!covered(m)) listed.set(at, null);
      else if (!listed.has(at) && shows(m)) listed.set(at, firstOff(m));
    }
  }
  // The users file, its path followed through every link, placed before the walk (and again after it, below), and the names
  // its path ends in — as written or at each link it leads through, compared ignoring case and Unicode normalization, as a
  // case-insensitive filesystem may look a name up: a mount shows a directory's entries by their names, so through one
  // that is down now the path may lead to such an entry. The walk compares each entry with both as it reaches it.
  let before = null;
  try { before = stat(file); } catch { /* placed after the walk, below */ }
  const fold = (s) => s.normalize('NFC').toLowerCase();
  const nameOf = (p) => (typeof p === 'string' ? path.basename(p) : p.subarray(p.lastIndexOf(path.sep.charCodeAt(0)) + 1).toString('utf8'));
  const ends = new Set();
  for (let at = file, hops = 0; hops <= MAX_LINKS; hops += 1) {
    ends.add(fold(path.basename(at)));
    try {
      if (!lstat(at).isSymbolicLink()) break;
      at = path.resolve(fs.realpathSync(path.dirname(at)), fs.readlinkSync(at));
    } catch { break; }
  }
  const found = [];       // { path, st }: the entries that are the users file as placed before the walk
  const namesakes = [];   // { path, st }: the entries under the root with a name its path ends in
  // The walk, depth first, each directory's entries in order: a frame per directory it is in, { at, dev, names, i } — its
  // listing, as rmSync holds the listing of each directory it is in, and the next entry's index.
  const frames = [];
  const visit = (at, from, parentDev) => {
    let st;
    try { st = lstat(at); } catch (e) {
      if (GONE.has(e?.code) && at !== root) return null;   // gone while the walk ran: nothing of it to delete
      return unreadable(at, e);
    }
    if (before && same(st, before)) found.push({ path: at, st });
    if (at !== root && ends.has(fold(nameOf(at)))) namesakes.push({ path: at, st });
    // A non-directory is a mount point only as a file mounted on a file, which Linux lists: on another device than its
    // directory it may be none, as an overlay mount whose layers lie on different filesystems (xino=off) shows a lower
    // layer's files on that layer's device and its directories on its own. So where /proc/self/mountinfo tells, only one
    // it lists is refused.
    const mountedHere = listed.has(relative(at));
    const first = listed.get(relative(at));
    const hint = first?.length ? `, covered by a later mount through which its path may show what it is mounted on: first unmount `
      + first.join(', then ') : '';
    if (dev(st) !== parentDev && (st.isDirectory() || mountedHere || info === null)) {
      mounts.push({ at, why: `another filesystem than ${named(from)}${hint}` });
      return null;
    }
    if (mountedHere) { mounts.push({ at, why: `the same filesystem as ${named(from)}, listed in ${MOUNTINFO}${hint}` }); return null; }
    if (!st.isDirectory()) return null;
    let through;
    try { through = stat(at); } catch (e) { return unreadable(at, e); }
    if (dev(through) !== dev(st)) { mounts.push({ at, why: 'another volume mounted in it' }); return null; }
    const key = idOf(st);
    if (walked.has(key)) { mounts.push({ at, why: `the directory ${named(walked.get(key))} again` }); return null; }
    walked.set(key, at);
    let names;
    try { names = listing(at); } catch (e) { return unreadable(at, e); }
    read.push({ at, key, ctimeNs: st.ctimeNs, names: namesOf(names), mtimeNs: st.mtimeNs });
    frames.push({ at, dev: dev(st), names, i: 0 });
    return null;
  };
  let walk = visit(root, path.dirname(root), above);
  while (!walk && frames.length) {
    const frame = frames.at(-1);
    if (frame.i === frame.names.length) frames.pop();
    else walk = visit(child(frame.at, frame.names[frame.i++]), frame.at, frame.dev);
  }
  if (walk) return walk;
  // Each entry the walk read that test holds for, read again in the walk's order, entering each directory it read — the
  // walk keeps none: { path, st }. A mount point is passed over, as the walk passed it.
  const atMount = new Set(mounts.map((m) => named(m.at)));
  const again = (test) => {
    const hits = [];
    const down = [];
    const look = (at) => {
      if (atMount.size && atMount.has(named(at))) return;
      let s;
      try { s = lstat(at); } catch { return; }
      if (test(s)) hits.push({ path: at, st: s });
      if (s.isDirectory() && walked.has(idOf(s))) { try { down.push({ at, names: listing(at), i: 0 }); } catch { /* gone since */ } }
    };
    look(root);
    while (down.length) {
      const frame = down.at(-1);
      if (frame.i === frame.names.length) down.pop();
      else look(child(frame.at, frame.names[frame.i++]));
    }
    return hits;
  };
  // The entries under the root that are the users file st, placed after the walk: as the walk found them, unless it changed
  // while the walk ran (created, replaced, written: another device, inode, size or modification time than before it), when
  // each entry is read again — none at a mount point.
  const entriesOf = (st) => {
    const kept = before && dev(before) === dev(st) && before.ino === st.ino && before.size === st.size && before.mtimeNs === st.mtimeNs;
    return (kept ? found : again((s) => same(s, st))).filter((e) => !atMount.has(named(e.path)));
  };
  // Where under the root the users file st lies (kin, its entries): the same file, or a view of it on another filesystem;
  // then, for a view, the step after the move its way out may take.
  const liesUnder = (kin, st) => {
    const ids = kin.filter((e) => dev(e.st) === dev(st)).map((e) => named(e.path));
    const views = kin.filter((e) => dev(e.st) !== dev(st)).map((e) => named(e.path));
    return {
      where: (ids.length ? `it is ${list(ids)} there` : '')
        + (views.length ? `${ids.length ? ', and ' : ''}${list(views)} under it ${views.length === 1 ? 'has' : 'have'} its `
          + `${st.isFile() ? 'size and ' : ''}modification time on another filesystem (the users file seen through a network or `
          + 'overlay mount, or a copy that kept them)' : ''),
      // Seen through a view, the path may then lead where nothing traces it back to the root, and a users file that does
      // not exist there is refused (below): an overlay mount's merged directory shows its upper directory's inode and time.
      then: views.length ? `; if it then refuses because ${file} does not exist (a mount whose directories show another inode or `
        + `modification time than theirs under ${root}, as an overlay mount with an upper directory does, cannot be traced back `
        + `there), delete ${root} by hand, then run purge-org again: it drops org ${id}'s records` : '',
      after: `. If ${file} then no longer leads to the users file, make it lead there again before a pre-store build or the in-place `
        + '`packc store export` uses it',
    };
  };
  if (mounts[0]?.at === root) {
    return stopped(`${root} (${mounts[0].why}) is a mount point: deleting it would take the files of the filesystem mounted there and then fail `
      + 'on the mount point itself (Node 23 and later; Node 22 fails at once) — nothing was deleted. Unmount it, then run purge-org '
      + `again: it deletes what is left at ${root} and drops org ${id}'s records, and the unmounted filesystem's files stay`);
  }
  if (mounts.length) {
    const points = mounts.map((m) => `${named(m.at)} (${m.why})`).sort();
    const held = `${root} holds ${mounts.length === 1 ? 'a mount point' : 'mount points'}, ${list(points)}: deleting `
      + `${root} would take the files of the filesystem mounted there (Node 23 and later) or stop part-way at it (Node 22), and a `
      + `directory mounted from outside ${root} may hold the users file`;
    // The users file under the root besides, found by the walk: unmounted, its path may lead there no more — a link of its
    // name in a directory mounted there from outside the root, to a file under it — so that the purge, run again as this
    // refusal said, went on into the empty mount point and deleted it. It is named here, to move out with the unmounting.
    let now = null;
    try { now = stat(file); } catch { /* nothing of it found under the root to name */ }
    const kin = now ? entriesOf(now) : [];
    if (!kin.length) return stopped(`${held} — nothing was deleted. Unmount what is mounted there, then run purge-org again`);
    const { where, then, after } = liesUnder(kin, now);
    return {
      exists: true,
      refusal: `${held}; and ${who} lies under ${root}: ${where} — nothing was deleted. Move ${list(kin.map((e) => named(e.path)))} out `
        + `of ${root} and unmount what is mounted there, then run purge-org again (unmounted, its path may no longer lead there, and `
        + `nothing would keep the purge from deleting it)${then}${after}`,
    };
  }

  // Where a path that does not exist leads: each link that exists followed (a dangling one by its target), '..' taken
  // from the directory reached, as the kernel resolves a path; { place, nearest, nearestSt, dirs } — dirs each directory
  // a name was looked up in on the way, { at, st } ('..' is not: from a mount it leads to its mount point's directory,
  // as from the directory there now) — or { at, error }.
  const split = (p) => p.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  const lead = (p) => {
    let todo;
    let cur;
    let curSt;
    let hops = 0;
    const dirs = [];
    const from = (abs) => {
      cur = path.parse(abs).root;
      todo = split(abs.slice(cur.length));
      try { curSt = lstat(cur); } catch { curSt = null; }
    };
    from(path.resolve(p));
    while (todo.length && curSt) {
      const [name, ...rest] = todo;
      if (name === '.' || name === '..') {
        todo = rest;
        if (name === '..' && path.dirname(cur) !== cur) {
          cur = path.dirname(cur);
          try { curSt = lstat(cur); } catch (e) { return { at: cur, error: e }; }
        }
        continue;
      }
      const next = path.join(cur, name);
      dirs.push({ at: cur, st: curSt });
      let st;
      try { st = lstat(next); } catch (e) {
        if (GONE.has(e?.code)) break;
        return { at: next, error: e };
      }
      if (st.isSymbolicLink()) {
        if (++hops > MAX_LINKS) return { at: next, error: { code: 'ELOOP' } };
        let target;
        try { target = fs.readlinkSync(next); } catch (e) { return { at: next, error: e }; }
        if (path.isAbsolute(target)) {
          from(target);
          todo = [...todo, ...rest];
        } else {
          todo = [...split(target), ...rest];
        }
        continue;
      }
      if (!st.isDirectory()) break;
      cur = next;
      curSt = st;
      todo = rest;
    }
    return { place: todo.length ? path.join(cur, ...todo) : cur, nearest: curSt ? cur : null, nearestSt: curSt, dirs };
  };

  // The directories the root lies in — its parent and theirs, as its real path passes through them — and those a name is
  // looked up in on its path as purge-org names it, every link on it followed (lead, above: with a workspace, or its
  // orgs/, reached through a link in a directory the root does not lie in, that directory and those above it): each by
  // its path (case folded on Windows) → its device and inode.
  const pathKey = (p) => (windows ? p.toLowerCase() : p);
  const holding = () => {
    const dirs = new Map();
    try {
      for (let d = path.dirname(fs.realpathSync(root)); !dirs.has(pathKey(d)); d = path.dirname(d)) dirs.set(pathKey(d), idOf(stat(d)));
      for (const { at, st: was } of lead(root).dirs ?? []) if (!dirs.has(pathKey(at))) dirs.set(pathKey(at), idOf(was));
    } catch { dirs.clear(); }
    return dirs;
  };

  // The users file, its path followed through every link, placed again now that the walk is done.
  const cannot = (at, e) => stopped(`${who} cannot be read on this host (${code(e)}${at === file ? '' : ` at ${at}`}`
    + `${e?.code === 'ELOOP' ? `: a link loop, or a chain of more than ${MAX_LINKS} links` : ''}), so nothing tells whether it lies `
    + `under ${root} — nothing was deleted. ${denied(e) ? `Run purge-org as a user who can read ${at}; or, if it` : 'If it'} does not `
    + `lie under ${root}, delete ${root} by hand, then run purge-org again: it drops org ${id}'s records`);
  // The refusal of the entries under the root with the name the users file's path ends in (namesakes), where no entry is the
  // users file: mounted again, a mount that is down may lead the path to one of them. It names each, and for one that is a
  // link what it leads to under the root too, which rmSync deletes while the link moves; moving them out is its way out.
  // opening says where the path leads now and ends naming the root ("under it"); why, what a mount that is down leaves
  // there; then, a step after the move.
  const byName = (opening, why, then = '') => {
    const links = namesakes.filter((e) => e.st.isSymbolicLink());
    const tos = [];
    for (const link of links) { try { tos.push(stat(link.path)); } catch { /* leads nowhere */ } }
    const besides = new Set(namesakes.map((e) => named(e.path)));
    const targets = tos.length ? again((s) => tos.some((to) => same(s, to))).filter((e) => e.path !== root && !besides.has(named(e.path))) : [];
    const pathsOf = (es) => list(es.map((e) => named(e.path)).sort());
    return `${opening}, but ${pathsOf(namesakes)} under it ${namesakes.length === 1 ? 'has' : 'have'} its name`
      + (targets.length ? `, and ${pathsOf(targets)} ${targets.length === 1 ? 'is' : 'are'} what `
        + `${links.length === 1 ? 'a link of that name leads' : 'links of that name lead'} to` : '')
      + `: ${why}, and mounted again it may lead the path there — nothing was deleted. Move ${pathsOf([...namesakes, ...targets])} out of `
      + `${root}, then run purge-org again${then}. If the users file is among them, make ${file} lead to it again before a pre-store build `
      + 'or the in-place `packc store export` uses it';
  };
  let st;
  try { st = stat(file); } catch (e) {
    if (!GONE.has(e?.code)) return cannot(file, e);
    // It does not exist, so nothing of it is under the root to delete — unless its path leads there through what is not
    // there now: a filesystem not mounted. Where it leads (lead, above): under the root — the nearest directory that
    // exists is one the walk read — with no entry under the root of its name, the purge goes on: a users file moved out of
    // the root, recorded there or reached through a mount of a directory under it or a link into it. Elsewhere nothing
    // tells, so it is refused, failing closed. <base>/users.json, the default nothing records, is absent on every store
    // that keeps no local users: absent — nothing at its path, not even a link — it is nothing to keep. A link there is
    // placed as a recorded path is.
    const nothingAt = () => { try { lstat(file); return false; } catch (e2) { return GONE.has(e2?.code); } };
    if (!recorded && nothingAt()) return { exists: false, refusal: null };
    const led = lead(file);
    if (led.error) return cannot(led.at, led.error);
    const walkedDir = ({ key, mtimeNs }) => {
      const [d, i] = key.split(':').map(BigInt);
      return same({ ...DIRECTORY, dev: d, ino: i, mtimeNs }, led.nearestSt);
    };
    // Into a directory the walk read, with an entry under the root of the users file's name, it is refused by the name: a
    // directory on its path may be the mount point of a mount that is down (an empty directory, which tells nothing), and
    // mounted again the path leads to the file of that name in the directory mounted there — under the root.
    const into = led.nearestSt ? read.find(walkedDir) : undefined;
    if (into && !namesakes.length) return { exists: false, refusal: null };
    if (into) {
      return {
        exists: false,
        refusal: byName(`${who} does not exist, and its path leads into ${named(into.at)}${into.at === root ? '' : `, under ${root}`}`,
          'a directory on its path may be the mount point of a mount that is down'),
      };
    }
    // A path looked up only in directories the root lies in, or its own path is looked up in, to one where the rest of it
    // does not exist — the directory of an org purged before, which the users file was moved out of as its refusal said:
    // a filesystem mounted again on one of them covers the root too, or hides the link the root's own path is reached
    // through, so the path leads under the root then by a directory under the root mounted in it, where the users file
    // keeps its name, or by a link that is not seen (the header). With no entry under the root of that name, the purge
    // goes on.
    if (led.nearestSt && led.dirs.length) {
      const holders = holding();
      if (led.dirs.every(({ at, st: was }) => holders.get(pathKey(at)) === idOf(was)) && !namesakes.length) return { exists: false, refusal: null };
    }
    return stopped(`${who} does not exist, and nothing on this host tells where its path leads`
      + `${led.place === path.resolve(file) ? '' : ` (to ${led.place})`}: `
      + (led.nearest === null ? 'no part of it exists' : `the nearest part of it that exists, ${led.nearest}, is no directory under ${root}`)
      + `, and a filesystem not mounted now may lead it under ${root} — nothing was deleted. If it lies on a filesystem that is not `
      + `mounted now, mount it, then run purge-org again; if it does not lie under ${root}, delete ${root} by hand, then run purge-org `
      + `again: it drops org ${id}'s records`);
  }
  // The entries that are the users file (entriesOf, above).
  const kin = entriesOf(st);
  if (!kin.length) {
    // The walk read each directory at its own moment: an entry another process renamed, while it ran, from a directory
    // not read yet into one read already (the users file, or a directory holding it) was in neither listing, and rmSync
    // deleted it. So before the purge goes on, each directory the walk read is read again, now that the users file is
    // placed: the same directory (device and inode), the same change time — which moves with every entry added, removed
    // or renamed in it — and the same names. Then none changed from its listing to now, and the walk is what lay under
    // the root at one moment, the users file placed in it. A directory that changed is refused.
    const changed = read.find(({ at, key, ctimeNs, names }) => {
      try {
        const now = lstat(at);
        return idOf(now) !== key || now.ctimeNs !== ctimeNs || namesOf(listing(at)) !== names;
      } catch { return true; }
    });
    if (changed) {
      const { at } = changed;
      return stopped(`${at === root ? root : `${named(at)} under ${root}`} changed while purge-org read ${at === root ? 'it' : root} (an entry added, `
        + `removed or renamed in it, or a mount over it), so purge-org cannot tell what deleting ${root} takes — nothing was deleted. `
        + `Stop what changes files under ${root}, then run purge-org again`);
    }
    // A mount that is down keeps what was written in its mount point meanwhile: a file of the users file's name there is
    // what its path leads to now, and mounted again the path leads to the file of that name in the directory mounted
    // there — under the root. So an entry under the root with the name the path ends in, as written or at a link it leads
    // through (compared ignoring case and Unicode normalization, as a case-insensitive filesystem may look a name up), is
    // refused; one that is a link names what it leads to under the root too, which rmSync deletes while the link moves.
    if (!namesakes.length) return { exists: true, refusal: null };
    return {
      exists: true,
      refusal: byName(`${who} is no file under ${root}`, 'a mount that is down keeps what was written in its mount point meanwhile',
        `; if it then refuses because ${file} does not exist (the users file seen there through a mount that cannot be traced back), `
        + `delete ${root} by hand, then run purge-org again: it drops org ${id}'s records`),
    };
  }
  const { where, then, after } = liesUnder(kin, st);
  return {
    exists: true,
    refusal: `${who} lies under ${root}: ${where} — nothing was deleted. Move ${list(kin.map((e) => named(e.path)))} out of ${root}, then run `
      + `purge-org again${then}${after}`,
  };
}
