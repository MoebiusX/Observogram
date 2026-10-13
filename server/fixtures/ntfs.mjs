// server/fixtures/ntfs.mjs — an NTFS volume as Windows' realpath sees it, so
// the path-comparison suites prove the Windows rule on any host
// (tools/test-journey-scope.mjs, server/test-store-paths.mjs). On NTFS a name
// is case-insensitive and a directory may also be named by its short (8.3)
// name. The native realpath (realpathSync.native) answers the on-disk
// spelling — the long names, the case they were created with, the drive
// letter upper case — while JS realpathSync answers the caller's own spelling
// of a path that exists.
// \\?\C:\… and \\.\C:\… name C:\…. A network share is libuv's case: a path
// reached through one (\\host\share\…, \\?\UNC\host\share\…, a mapped drive)
// resolves to \\host\share\ and the on-disk rest, never to the volume's own
// path; a share the volume does not serve is ENOENT. What statSync reports
// names the file whatever path reached it: one file id per file, and the
// volume's serial — of which a share reports only the low 32 bits
// (FILE_FS_VOLUME_INFORMATION's), while a local stat may report all 64
// (FILE_STAT_BASIC_INFORMATION's). A symbolic link (a directory or file
// symlink, or a junction) is followed to its target by the native realpath
// and statSync, wherever it sits in the path; lstatSync follows each but the
// last part, so it reports a link itself. Through a link whose target cannot
// be opened (a share that is down, a path that does not exist) neither the
// native realpath nor statSync answers, while lstatSync still answers the link.
// A reparse point that is no link — a cloud placeholder, a deduplicated file,
// a tag no filter on this host handles — whose target cannot be opened stops
// the native realpath and statSync too, with the error the open through it
// gets, not ENOENT. libuv's lstat takes only a symlink, a junction to a drive
// path and an app execution alias for a link; such a point it reads as stat
// does, opening through it, so it fails with that error too — unless that open
// reaches something (here, lstat: true): then lstatSync answers,
// isSymbolicLink() false, while the native realpath still cannot read through
// the point. A drive that bypasses the Volume Mount Manager (an ImDisk RAM
// disk) has no DOS name libuv's realpath can ask for
// (GetFinalPathNameByHandleW fails), so the native realpath of any path that
// ends on it is EISDIR — its root among them, no link involved — while
// statSync and lstatSync answer as on any drive. A junction on a share's
// volume is followed by the share's server, not the client; SMB before
// Windows 10/Server 1709 (a client or a server that old) has no
// normalized-name query, so there (unnormalized) the native realpath names a
// path through a share as the client opened it, part by part — a junction by
// its own name, not its target's — while statSync reads where it leads and
// lstatSync answers the junction as a link.
//
// Imports nothing but node:path's Windows rules: no platform is read, so
// tools/test-platform.mjs's P5 holds.

import { win32 } from 'node:path';

const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), { code: 'ENOENT' });

/**
 * ntfsVolume(files, { short, shares, mapped, links, reparse, unmanaged, unnormalized }) → { realpathSync, statSync, lstatSync } — node:fs's
 * realpathSync, statSync and lstatSync as Windows runs them on this volume:
 *   files   the on-disk spellings of the volume's files, e.g. 'C:\\ws\\orgs\\acme\\packs\\own.pack.yaml'
 *           (each one's directories exist too);
 *   short   { '<a directory, as on disk>': '<its short name>' }, e.g. { 'C:\\ws': 'WS~1' };
 *   shares  { '\\\\<host>\\<share>': '<the directory it exposes, as on disk>' }, one entry per name of
 *           its server, e.g. { '\\\\localhost\\C$': 'C:\\' };
 *   mapped  { '<drive>:': '\\\\<host>\\<share>[\\…]' }, a mapped network drive, e.g. { 'Z:': '\\\\localhost\\C$\\ws' };
 *   links   { '<a link, as on disk>': '<its target, an absolute path>' }, a symbolic link on the volume (its directories
 *           exist), e.g. { 'C:\\links\\betasub': '\\\\myhost\\betasub' } — the target may be another link, or a path
 *           that does not exist;
 *   reparse { '<a reparse point that is no link, as on disk>': { code, lstat } }, one whose target cannot be opened, e.g.
 *           { 'C:\\cloud\\betasub': { code: 'EIO', lstat: true } }: the native realpath and statSync of it and of any
 *           path through it fail with code, and so does lstatSync of a path through it, and of the point itself unless
 *           lstat (then lstatSync answers it, isSymbolicLink() false);
 *   unmanaged  ['<drive>:'], drives that bypass the Volume Mount Manager, e.g. ['R:'] (an ImDisk RAM disk);
 *   unnormalized  true for SMB with no normalized-name query (before Windows 10/Server 1709): the native realpath of a
 *           path through a share names each part as the client opened it, by its name on disk, and a link on the way
 *           (here every link reached through a share is taken for a junction, which the server follows) by its own
 *           name, not its target's.
 *   realpathSync(p)         the JS one: p resolved, in the caller's spelling (from a link's target on, the target's), or ENOENT;
 *   realpathSync.native(p)  the on-disk spelling (\\host\share\… through a share; unnormalized, as opened), or ENOENT
 *                           (a reparse point's code through one) — EISDIR when it ends on an unmanaged drive;
 *   statSync(p)             { dev, ino } as bigints — the volume's serial (its low 32 bits through a share) and the
 *                           file's id, the same through every name of the file — and isSymbolicLink() (false), or ENOENT
 *                           (a reparse point's code through one);
 *   lstatSync(p)            the same, of a link itself when p ends at one (isSymbolicLink() true).
 */
export function ntfsVolume(files, { short = {}, shares = {}, mapped = {}, links = {}, reparse = {}, unmanaged = [], unnormalized = false } = {}) {
  const names = new Map();   // a directory's on-disk path, folded → Map(name folded → name on disk)
  const add = (dir, name) => {
    const key = dir.toLowerCase();
    if (!names.has(key)) names.set(key, new Map());
    names.get(key).set(name.toLowerCase(), name);
  };
  for (const file of [...files, ...Object.keys(links), ...Object.keys(reparse)]) {
    const { root } = win32.parse(file);
    let dir = root.toUpperCase();
    for (const name of file.slice(root.length).split('\\')) {
      add(dir, name);
      dir = win32.join(dir, name);
    }
  }
  const shortNames = new Map();   // <parent on disk>\<short name>, folded → the long name on disk
  for (const [long, alias] of Object.entries(short)) {
    shortNames.set(win32.join(win32.dirname(long), alias).toLowerCase(), win32.basename(long));
  }
  const served = new Map(Object.entries(shares).map(([unc, dir]) => [win32.resolve(unc).toLowerCase(), { unc: win32.resolve(unc), dir }]));
  const drives = new Map(Object.entries(mapped).map(([drive, unc]) => [drive.toLowerCase(), unc]));
  const linked = new Map(Object.entries(links).map(([at, to]) => [at.toLowerCase(), to]));   // a link, folded → its target
  const points = new Map(Object.entries(reparse).map(([at, how]) => [at.toLowerCase(), how]));   // a reparse point, folded → { code, lstat }
  const nameless = new Set(unmanaged.map((drive) => drive.toLowerCase()));   // drives the native realpath cannot name

  // abs's on-disk path — or, at the first link it passes (or ends at, with follow), { link: its target, rest: what follows };
  // at a reparse point it passes (or ends at, with follow or without its lstat), the error the open through it gets.
  function onVolume(abs, p, follow = true) {
    const { root } = win32.parse(abs);
    let out = root.toUpperCase();
    if (!names.has(out.toLowerCase())) throw enoent(p);
    const parts = abs.slice(root.length).split('\\').filter(Boolean);
    for (const [i, name] of parts.entries()) {
      const found = names.get(out.toLowerCase())?.get(name.toLowerCase()) ?? shortNames.get(win32.join(out, name).toLowerCase());
      if (!found) throw enoent(p);
      out = win32.join(out, found);
      const point = points.get(out.toLowerCase());
      if (point && (follow || i < parts.length - 1 || !point.lstat)) {
        throw Object.assign(new Error(`${point.code}: the target of the reparse point ${out} cannot be opened, '${p}'`), { code: point.code });
      }
      const link = linked.get(out.toLowerCase());
      if (link !== undefined && (follow || i < parts.length - 1)) return { link, rest: parts.slice(i + 1) };
    }
    return { local: out };
  }
  // The file a path reaches, each link on the way followed (with follow, the last part too): its on-disk path, the share
  // it was reached through, if any, the path as the JS realpath spells it, and the share p names and the parts below it.
  function reach(p, follow = true) {
    let abs = win32.resolve(p);
    let spelled = abs;
    let opened = null;
    for (let hops = 0; ; hops += 1) {
      if (hops > 31) throw Object.assign(new Error(`ELOOP: too many symbolic links encountered, realpath '${p}'`), { code: 'ELOOP' });   // a link loop
      if (/^\\\\\?\\UNC\\/i.test(abs)) abs = `\\${abs.slice(7)}`;          // \\?\UNC\host\share\… is \\host\share\…
      else if (/^\\\\[?.]\\[a-z]:/i.test(abs)) abs = abs.slice(4);          // \\?\C:\…, \\.\C:\… are C:\…
      const drive = drives.get(abs.slice(0, 2).toLowerCase());
      if (drive) abs = win32.join(drive, abs.slice(2));
      const { root } = win32.parse(abs);
      let share = null;
      if (root.startsWith('\\\\')) {
        share = served.get(root.toLowerCase());
        if (!share) throw enoent(p);
        if (hops === 0) opened = { share, parts: abs.slice(root.length).split('\\').filter(Boolean) };
      }
      const at = onVolume(share ? win32.join(share.dir, abs.slice(root.length)) : abs, p, follow);
      if (at.local) return { local: at.local, share, spelled, opened };
      abs = win32.resolve(at.link, ...at.rest);
      spelled = abs;
    }
  }
  function native(p) {
    const { local, share, opened } = reach(p);
    if (unnormalized && opened) {   // each part as the client opened it: its name on disk, a link's own
      const { share: { unc }, parts } = opened;
      return win32.join(unc, ...parts.map((_, i) => win32.basename(reach(win32.join(unc, ...parts.slice(0, i + 1)), false).local)));
    }
    return share ? win32.join(share.unc, local.slice(onVolume(share.dir, p).local.length)) : local;
  }
  const realpathSync = (p) => { native(p); return reach(p).spelled; };   // the JS one walks with lstat: it answers on an unmanaged drive
  realpathSync.native = (p) => {
    const { local, share } = reach(p);
    if (!share && nameless.has(local.slice(0, 2).toLowerCase())) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, realpath '${p}'`), { code: 'EISDIR' });
    }
    return native(p);
  };
  const ids = new Map();   // an on-disk path, folded → its file id
  const stat = ({ local, share }) => {
    const key = local.toLowerCase();
    if (!ids.has(key)) ids.set(key, BigInt(ids.size + 1));
    const serial = 0x5eed000000000000n | BigInt(local.charCodeAt(0));   // one per drive letter, above 32 bits too
    return { dev: share ? serial & 0xffffffffn : serial, ino: ids.get(key), isSymbolicLink: () => linked.has(key) };   // only lstatSync ends at one
  };
  const statSync = (p) => stat(reach(p));
  const lstatSync = (p) => stat(reach(p, false));
  return { realpathSync, statSync, lstatSync };
}
