// server/fixtures/mount-fs.mjs — a filesystem as node:fs's lstatSync, statSync, readdirSync and readlinkSync
// answer it, with what a test runner cannot make for real (no root, no mount(8), maybe no symlink privilege):
// several filesystems, bind mounts, a mount that is down (its mount point left empty), views of a directory
// through another filesystem as an NFS, SMB, overlay or FUSE mount reports them, a directory nobody may read, and
// link loops — on POSIX paths or, with node:path's Windows rules, on Windows ones (server/test-store-ops.mjs, the
// users-file place suite over server/store/users-file-place.mjs).
//
// Imports nothing: the caller passes node:path's posix or win32, so tools/test-platform.mjs's P5 holds.
//
// mountFs(path, { fold }) → a volume set, built with:
//   dir(p, { dev })            mkdir -p; a directory created takes its parent's device, the last one `dev` if given
//                              (a directory on another device than its parent is what a mount point looks like);
//   file(p, { size, mtimeNs }) a file (its directories made as dir does), on its directory's device;
//   hardlink(existing, p)      the same file at a second name;
//   symlink(p, target)         a symbolic link (a junction on Windows reads the same to lstatSync);
//   bind(source, target)       mount the directory at source on target: the same files, devices and inodes;
//   mountFolder(source, target) Windows' volume mounted in a folder: lstatSync answers the folder itself (on its
//                              parent's volume), statSync and every lookup through it the volume mounted there;
//   view(source, target, how)  mount it as another filesystem shows it: how = { dev, ino(i), mtimeNs(t) } maps what
//                              stat reports through the view (each defaults to the source's own);
//   unmount(target), rename(from, to), remove(p), deny(p, code) (readdirSync and every lookup through p fail with
//                              code, EACCES by default; ENOTCONN is a FUSE mount whose server stopped answering);
//   fs                         { lstatSync, statSync, readdirSync, readlinkSync }, stats as bigints:
//                              { dev, ino, size, mtimeNs, isFile(), isDirectory(), isSymbolicLink() }.
// fold: names compared case-insensitively (NTFS); devs: { '<a root>': its device } (default 1n each). Each inode gets
// a distinct inode number and a modification time with nanoseconds, unless given.

const MAX_LINKS = 40;

export function mountFs(path, { fold = false, devs = {} } = {}) {
  const key = (s) => (fold ? s.toLowerCase() : s);
  const split = (s) => s.split(/[\\/]+/).filter(Boolean);
  const fail = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code });
  let next = 1000n;
  const inode = (kind, dev, extra = {}) => {
    next += 1n;
    return { kind, dev, ino: next, size: kind === 'dir' ? 4096n : 0n, mtimeNs: 1_760_000_000_000_000_000n + next * 1_234_567n, ...extra };
  };
  const tops = new Map();     // a root (C:\, /) folded → its directory
  const mounts = new Map();   // a mount point's path folded → { node, how }
  const entries = (dir) => dir.entries;

  // Where p leads: { node, how, at } — how is the view the node is seen through; the last name followed when follow.
  function locate(p, follow) {
    let hops = 0;
    let stack;
    let todo;
    const start = (abs) => {
      const top = path.parse(abs).root;
      const m = mounts.get(key(top));
      const node = m ? m.node : tops.get(key(top));
      if (!node) throw fail('ENOENT', p);
      stack = [{ node, how: m?.how ?? null, at: top }];
      todo = split(abs.slice(top.length));
    };
    start(path.resolve(p));
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
      const m = mounts.get(key(at));
      const folder = m?.folder && !todo.length && !follow;   // lstatSync of a folder a volume is mounted in: the folder
      const pos = m && !folder ? { node: m.node, how: m.how, at } : { node: child.node, how: cur.how, at };
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
    dir(p, { dev = null } = {}) {
      const abs = path.resolve(p);
      const top = path.parse(abs).root;
      if (!tops.has(key(top)) && !mounts.has(key(top))) tops.set(key(top), { ...inode('dir', devs[top] ?? 1n), entries: new Map() });
      let at = top;
      const names = split(abs.slice(top.length));
      names.forEach((name, i) => {
        const parent = locate(at, true).node;
        at = path.join(at, name);
        if (!entries(parent).has(key(name))) {
          entries(parent).set(key(name), { name, node: { ...inode('dir', i === names.length - 1 && dev !== null ? dev : parent.dev), entries: new Map() } });
        }
      });
      return vol;
    },
    file(p, { size = 23n, mtimeNs } = {}) {
      vol.dir(path.dirname(path.resolve(p)));
      const { dir, name } = parentOf(p);
      entries(dir).set(key(name), { name, node: inode('file', dir.dev, { size, ...(mtimeNs === undefined ? {} : { mtimeNs }) }) });
      return vol;
    },
    hardlink(existing, p) {
      const node = locate(existing, false).node;
      vol.dir(path.dirname(path.resolve(p)));
      const { dir, name } = parentOf(p);
      entries(dir).set(key(name), { name, node });
      return vol;
    },
    symlink(p, target) {
      vol.dir(path.dirname(path.resolve(p)));
      const { dir, name } = parentOf(p);
      entries(dir).set(key(name), { name, node: inode('link', dir.dev, { target }) });
      return vol;
    },
    bind(source, target) { return vol.view(source, target, null); },
    view(source, target, how, { folder = false } = {}) {
      const src = locate(source, true);
      const abs = path.resolve(target);
      if (path.parse(abs).root !== abs) vol.dir(abs);
      mounts.set(key(abs), { node: src.node, how: how ? { ...src.how, ...how } : src.how, folder });
      return vol;
    },
    mountFolder(source, target) { return vol.view(source, target, null, { folder: true }); },
    unmount(target) { mounts.delete(key(path.resolve(target))); return vol; },
    rename(from, to) {
      const a = parentOf(from);
      const entry = entries(a.dir).get(key(a.name));
      if (!entry) throw fail('ENOENT', from);
      vol.dir(path.dirname(path.resolve(to)));
      const b = parentOf(to);
      entries(a.dir).delete(key(a.name));
      entries(b.dir).set(key(b.name), { name: b.name, node: entry.node });
      return vol;
    },
    remove(p) { const { dir, name } = parentOf(p); entries(dir).delete(key(name)); return vol; },
    deny(p, code = 'EACCES') { locate(p, true).node.denied = code; return vol; },
    fs: {
      lstatSync: (p) => stats(locate(p, false)),
      statSync: (p) => stats(locate(p, true)),
      readdirSync(p) {
        const pos = locate(p, true);
        if (pos.node.kind !== 'dir') throw fail('ENOTDIR', p);
        if (pos.node.denied) throw fail(pos.node.denied, p);
        return [...entries(pos.node).values()].map((e) => e.name).sort();
      },
      readlinkSync(p) {
        const pos = locate(p, false);
        if (pos.node.kind !== 'link') throw fail('EINVAL', p);
        return pos.node.target;
      },
    },
  };
  return vol;
}
