// server/fixtures/mount-fs.mjs — a filesystem as node:fs's lstatSync, statSync, readdirSync, readlinkSync and
// realpathSync answer it, and Linux's /proc/self/mountinfo, with what a test runner cannot make for real (no root, no
// mount(8), maybe no symlink privilege): several filesystems, bind mounts, a mount that is down (its mount point left
// empty, or holding what was written in it meanwhile), views of a directory through another filesystem as an NFS, SMB,
// overlay or FUSE mount reports them, a directory nobody may read or search, and link loops — on POSIX paths or, with
// node:path's Windows rules, on Windows ones (server/test-store-ops.mjs, the users-file place suite over
// server/store/users-file-place.mjs).
//
// Imports nothing: the caller passes node:path's posix or win32, so tools/test-platform.mjs's P5 holds.
//
// mountFs(path, { fold, devs, proc }) → a volume set, built with:
//   dir(p, { dev, ino })       mkdir -p; a directory created takes its parent's device, the last one `dev` if given
//                              (a directory on another device than its parent is what a mount point looks like),
//                              and the inode number `ino` if given (each filesystem numbers its own inodes, so a
//                              directory on another device may have the number of one under the root);
//   file(p, { size, mtimeNs, dev }) a file (its directories made as dir does), on its directory's device, or on `dev`
//                              if given with no mount there (an overlay mount whose layers lie on different
//                              filesystems, xino=off, shows a lower layer's files so);
//   hardlink(existing, p)      the same file at a second name;
//   symlink(p, target)         a symbolic link (a junction on Windows reads the same to lstatSync);
//   bind(source, target)       mount the directory at source on target: the same files, devices and inodes. A mount
//                              lies in the mount its target was in (its parent), as Linux's do: one on a path mounted
//                              already stacks on that mount, and a later one on a directory above it in its parent
//                              covers it — its path then shows what the mount above holds, and unmounting it fails
//                              with EINVAL (umount(8): not mounted), while /proc/self/mountinfo lists it still. On
//                              POSIX paths a mount on / stacks on the root and covers nothing: a lookup starts at the
//                              process's root and never crosses a mount stacked on it (mount(8) and umount(8) there
//                              take the topmost); on Windows paths a root (a drive, a UNC share) is the volume
//                              mounted there;
//   mountFolder(source, target) Windows' volume mounted in a folder: lstatSync answers the folder itself (on its
//                              parent's volume), statSync and every lookup through it the volume mounted there;
//   view(source, target, how)  mount it as another filesystem shows it: how = { dev, ino(i), mtimeNs(t) } maps what
//                              stat reports through the view (each defaults to the source's own);
//   unmount(target)            unmount what target shows mounted there: EINVAL when nothing is, EBUSY when a mount
//                              lies in it;
//   rename(from, to), remove(p), deny(p, code, { list }) (readdirSync and every lookup through p
//                              fail with code, EACCES by default; ENOTCONN is a FUSE mount whose server stopped
//                              answering; with list, readdirSync still names p's entries — a directory that may be
//                              read but not searched, r--, where lstatSync of each entry fails);
//   fs                         { lstatSync, statSync, readdirSync, readlinkSync, realpathSync, readFileSync }, stats as
//                              bigints: { dev, ino, size, mtimeNs, ctimeNs, isFile(), isDirectory(), isSymbolicLink() };
//                              readFileSync answers /proc/self/mountinfo alone, and only with proc (else ENOENT).
// A name that is not valid UTF-8 is spelled with each byte 0xNN that is not part of a UTF-8 character as the lone
// surrogate U+DCNN (Python's surrogateescape); the fs takes a path as such a string or as a Buffer of its bytes, and
// answers as node:fs does: readdirSync lists names as strings, each such byte U+FFFD (a name no lookup finds), or with
// { encoding: 'buffer' } as their bytes; readlinkSync, realpathSync and /proc/self/mountinfo (read as UTF-8) likewise.
// fold: names compared case-insensitively (NTFS); devs: { '<a root>': its device } (default 1n each); proc: Linux's
// /proc/self/mountinfo, listing / and every mount now, each with its mount ID and its parent's, one covered too (its
// path with the kernel's octal escapes), on POSIX paths;
// coarse: a clock coarser than every change made, so every change time reads the same and none moves.
// Each inode gets a distinct inode number and a modification time with nanoseconds, unless given, and a change time
// that moves, as the kernel moves a directory's, with every entry added, removed or renamed in it (unless coarse).

const MAX_LINKS = 40;
// A path's bytes (U+DCNN the byte 0xNN), a Buffer as such a string, and a string as node:fs answers one (UTF-8 decoded).
const bytesOf = (s) => Buffer.concat([...s].map((ch) => {
  const c = ch.charCodeAt(0);
  return ch.length === 1 && c >= 0xdc80 && c <= 0xdcff ? Buffer.from([c - 0xdc00]) : Buffer.from(ch, 'utf8');
}));
function fromBytes(b) {
  let s = '';
  for (let i = 0; i < b.length;) {
    const n = b[i] < 0x80 ? 1 : b[i] >= 0xc2 && b[i] < 0xe0 ? 2 : b[i] >= 0xe0 && b[i] < 0xf0 ? 3 : b[i] >= 0xf0 && b[i] < 0xf5 ? 4 : 0;
    const seq = b.subarray(i, i + n);
    const ch = n && seq.length === n ? seq.toString('utf8') : '';
    if (ch && Buffer.from(ch, 'utf8').equals(seq)) { s += ch; i += n; } else { s += String.fromCharCode(0xdc00 + b[i]); i += 1; }
  }
  return s;
}
const str = (p) => (typeof p === 'string' ? p : fromBytes(p));
const answered = (s) => bytesOf(s).toString('utf8');

export function mountFs(path, { fold = false, devs = {}, proc = false, coarse = false } = {}) {
  const key = (s) => (fold ? s.toLowerCase() : s);
  const split = (s) => s.split(path.sep === '\\' ? /[\\/]+/ : /\/+/).filter(Boolean);   // on POSIX paths a backslash is part of a name
  const fail = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
  let next = 1000n;
  let clock = 1_770_000_000_000_000_000n;
  const now = () => (coarse ? clock : (clock += 1_000_003n));
  const inode = (kind, dev, extra = {}) => {
    next += 1n;
    return { kind, dev, ino: next, size: kind === 'dir' ? 4096n : 0n, mtimeNs: 1_760_000_000_000_000_000n + next * 1_234_567n, ctimeNs: now(), ...extra };
  };
  const changed = (dir) => { dir.ctimeNs = now(); };   // an entry added, removed or renamed in dir
  const tops = new Map();     // a root (C:\, /) folded → its directory
  const TOP = 21;             // the mount ID of / (each root), as /proc/self/mountinfo lists it
  let mountId = TOP;
  const mounts = new Map();   // its parent mount's ID and its mount point's path folded → { id, parent, node, how, folder, at }
  const entries = (dir) => dir.entries;
  // What is mounted on top at `at` in the mount `mnt`: the mount there, then each stacked on it.
  const mountedAt = (mnt, at) => {
    let top = null;
    for (let m = mounts.get(`${mnt}|${key(at)}`); m; m = mounts.get(`${m.id}|${key(at)}`)) top = m;
    return top;
  };
  // / on POSIX paths, the process's root: a lookup starts there and never crosses a mount stacked on it (`mount --bind / /`,
  // or a tmpfs mounted on / in a chroot, which /proc/self/mountinfo lists at /), while mount(8) and umount(8) take the
  // topmost mount there. A Windows root (a drive, a UNC share) names the volume mounted there, which every lookup reaches.
  const processRoot = (abs) => path.sep === '/' && abs === '/';

  // Where p leads: { node, how, at, mnt } — how is the view the node is seen through, mnt the ID of the mount it lies in;
  // the last name followed when follow.
  function locate(p, follow) {
    let hops = 0;
    let stack;
    let todo;
    const start = (abs) => {
      const top = path.parse(abs).root;
      const m = processRoot(top) ? null : mountedAt(TOP, top);
      const node = m ? m.node : tops.get(key(top));
      if (!node) throw fail('ENOENT', p);
      stack = [{ node, how: m?.how ?? null, at: top, mnt: m?.id ?? TOP }];
      todo = split(abs.slice(top.length));
    };
    start(path.resolve(str(p)));
    while (todo.length) {
      const [name, ...rest] = todo;
      todo = rest;
      const cur = stack.at(-1);
      if (name === '.') continue;
      if (name === '..') { if (stack.length > 1) stack.pop(); continue; }
      if (cur.node.kind !== 'dir') throw fail('ENOTDIR', p);
      if (cur.node.denied) throw fail(cur.node.denied, p);
      const child = entries(cur.node).get(key(name));
      if (!child) throw fail('ENOENT', p);
      const at = path.join(cur.at, name);
      const m = mountedAt(cur.mnt, at);
      const folder = m?.folder && !todo.length && !follow;   // lstatSync of a folder a volume is mounted in: the folder
      const pos = m && !folder ? { node: m.node, how: m.how, at, mnt: m.id } : { node: child.node, how: cur.how, at, mnt: cur.mnt };
      if (pos.node.kind === 'link' && (todo.length || follow)) {
        if (++hops > MAX_LINKS) throw fail('ELOOP', p);
        const target = pos.node.target;
        if (path.isAbsolute(target)) {
          const after = todo;
          start(path.resolve(target));
          todo = [...todo, ...after];
        } else {
          todo = [...split(target), ...todo];
        }
        continue;
      }
      stack.push(pos);
    }
    return stack.at(-1);
  }
  const stats = ({ node, how }) => ({
    dev: how?.dev ?? node.dev,
    ino: how?.ino ? how.ino(node.ino) : node.ino,
    size: node.size,
    mtimeNs: how?.mtimeNs ? how.mtimeNs(node.mtimeNs) : node.mtimeNs,
    ctimeNs: node.ctimeNs,
    isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'link',
  });
  const parentOf = (p) => {
    const abs = path.resolve(p);
    const pos = locate(path.dirname(abs), true);
    if (pos.node.kind !== 'dir') throw fail('ENOTDIR', p);
    return { dir: pos.node, name: path.basename(abs) };
  };

  const vol = {
    dir(p, { dev = null, ino = null } = {}) {
      const abs = path.resolve(p);
      const top = path.parse(abs).root;
      if (!tops.has(key(top)) && !mounts.has(key(top))) tops.set(key(top), { ...inode('dir', devs[top] ?? 1n), entries: new Map() });
      let at = top;
      const names = split(abs.slice(top.length));
      names.forEach((name, i) => {
        const parent = locate(at, true).node;
        at = path.join(at, name);
        if (!entries(parent).has(key(name))) {
          const last = i === names.length - 1;
          const node = inode('dir', last && dev !== null ? dev : parent.dev, last && ino !== null ? { ino } : {});
          entries(parent).set(key(name), { name, node: { ...node, entries: new Map() } });
          changed(parent);
        }
      });
      return vol;
    },
    file(p, { size = 23n, mtimeNs, dev = null } = {}) {
      vol.dir(path.dirname(path.resolve(p)));
      const { dir, name } = parentOf(p);
      entries(dir).set(key(name), { name, node: inode('file', dev ?? dir.dev, { size, ...(mtimeNs === undefined ? {} : { mtimeNs }) }) });
      changed(dir);
      return vol;
    },
    hardlink(existing, p) {
      const node = locate(existing, false).node;
      vol.dir(path.dirname(path.resolve(p)));
      const { dir, name } = parentOf(p);
      entries(dir).set(key(name), { name, node });
      changed(dir);
      return vol;
    },
    symlink(p, target) {
      vol.dir(path.dirname(path.resolve(p)));
      const { dir, name } = parentOf(p);
      entries(dir).set(key(name), { name, node: inode('link', dir.dev, { target }) });
      changed(dir);
      return vol;
    },
    bind(source, target) { return vol.view(source, target, null); },
    view(source, target, how, { folder = false } = {}) {
      const src = locate(source, true);
      const abs = path.resolve(target);
      if (path.parse(abs).root !== abs) vol.dir(abs);
      let parent = TOP;
      if (processRoot(abs)) parent = mountedAt(TOP, abs)?.id ?? TOP;
      else try { parent = locate(abs, true).mnt; } catch { /* a drive no volume answers for yet */ }
      mountId += 1;
      mounts.set(`${parent}|${key(abs)}`, { id: mountId, parent, node: src.node, how: how ? { ...src.how, ...how } : src.how, folder, at: abs });
      return vol;
    },
    mountFolder(source, target) { return vol.view(source, target, null, { folder: true }); },
    unmount(target) {
      const abs = path.resolve(target);
      let mnt = null;
      if (processRoot(abs)) mnt = mountedAt(TOP, abs)?.id ?? null;
      else try { mnt = locate(abs, true).mnt; } catch { /* nothing there */ }
      const m = [...mounts.values()].find((x) => x.id === mnt && key(x.at) === key(abs));
      if (!m) throw fail('EINVAL', target);   // umount(8): not mounted
      if ([...mounts.values()].some((x) => x.parent === m.id)) throw fail('EBUSY', target);
      mounts.delete(`${m.parent}|${key(m.at)}`);
      return vol;
    },
    rename(from, to) {
      const a = parentOf(from);
      const entry = entries(a.dir).get(key(a.name));
      if (!entry) throw fail('ENOENT', from);
      vol.dir(path.dirname(path.resolve(to)));
      const b = parentOf(to);
      entries(a.dir).delete(key(a.name));
      entries(b.dir).set(key(b.name), { name: b.name, node: entry.node });
      changed(a.dir);
      changed(b.dir);
      return vol;
    },
    remove(p) { const { dir, name } = parentOf(p); entries(dir).delete(key(name)); changed(dir); return vol; },
    deny(p, code = 'EACCES', { list = false } = {}) { Object.assign(locate(p, true).node, { denied: code, listed: list }); return vol; },
    fs: {
      lstatSync: (p) => stats(locate(p, false)),
      statSync: (p) => stats(locate(p, true)),
      readdirSync(p, options) {
        const pos = locate(p, true);
        if (pos.node.kind !== 'dir') throw fail('ENOTDIR', p);
        if (pos.node.denied && !pos.node.listed) throw fail(pos.node.denied, p);
        const names = [...entries(pos.node).values()].map((e) => e.name).sort();
        return (options?.encoding ?? options) === 'buffer' ? names.map(bytesOf) : names.map(answered);
      },
      readlinkSync(p) {
        const pos = locate(p, false);
        if (pos.node.kind !== 'link') throw fail('EINVAL', p);
        return answered(pos.node.target);
      },
      realpathSync: (p) => answered(locate(p, true).at),
      readFileSync(p) {
        if (!proc || p !== '/proc/self/mountinfo') throw fail('ENOENT', p);
        const octal = (s) => s.replace(/[ \t\n\\]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);
        return answered([{ id: TOP, parent: 1, at: '/' }, ...mounts.values()]
          .map((m) => `${m.id} ${m.parent} 0:${m.id} / ${octal(m.at)} rw,relatime - fixture fixture rw\n`).join(''));
      },
    },
  };
  return vol;
}
