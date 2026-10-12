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
// (FILE_STAT_BASIC_INFORMATION's).
//
// Imports nothing but node:path's Windows rules: no platform is read, so
// tools/test-platform.mjs's P5 holds.

import { win32 } from 'node:path';

const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), { code: 'ENOENT' });

/**
 * ntfsVolume(files, { short, shares, mapped }) → { realpathSync, statSync } — node:fs's realpathSync and statSync as Windows runs them on this volume:
 *   files   the on-disk spellings of the volume's files, e.g. 'C:\\ws\\orgs\\acme\\packs\\own.pack.yaml'
 *           (each one's directories exist too);
 *   short   { '<a directory, as on disk>': '<its short name>' }, e.g. { 'C:\\ws': 'WS~1' };
 *   shares  { '\\\\<host>\\<share>': '<the directory it exposes, as on disk>' }, one entry per name of
 *           its server, e.g. { '\\\\localhost\\C$': 'C:\\' };
 *   mapped  { '<drive>:': '\\\\<host>\\<share>[\\…]' }, a mapped network drive, e.g. { 'Z:': '\\\\localhost\\C$\\ws' }.
 *   realpathSync(p)         the JS one: p resolved, in the caller's spelling, or ENOENT;
 *   realpathSync.native(p)  the on-disk spelling (\\host\share\… through a share), or ENOENT;
 *   statSync(p)             { dev, ino } as bigints — the volume's serial (its low 32 bits through a share) and the
 *                           file's id, the same through every name of the file — or ENOENT.
 */
export function ntfsVolume(files, { short = {}, shares = {}, mapped = {} } = {}) {
  const names = new Map();   // a directory's on-disk path, folded → Map(name folded → name on disk)
  const add = (dir, name) => {
    const key = dir.toLowerCase();
    if (!names.has(key)) names.set(key, new Map());
    names.get(key).set(name.toLowerCase(), name);
  };
  for (const file of files) {
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

  function onVolume(abs, p) {
    const { root } = win32.parse(abs);
    let out = root.toUpperCase();
    if (!names.has(out.toLowerCase())) throw enoent(p);
    for (const name of abs.slice(root.length).split('\\').filter(Boolean)) {
      const found = names.get(out.toLowerCase())?.get(name.toLowerCase()) ?? shortNames.get(win32.join(out, name).toLowerCase());
      if (!found) throw enoent(p);
      out = win32.join(out, found);
    }
    return out;
  }
  // The file a path reaches: its on-disk path, and the share it was reached through, if any.
  function reach(p) {
    let abs = win32.resolve(p);
    if (/^\\\\\?\\UNC\\/i.test(abs)) abs = `\\${abs.slice(7)}`;          // \\?\UNC\host\share\… is \\host\share\…
    else if (/^\\\\[?.]\\[a-z]:/i.test(abs)) abs = abs.slice(4);          // \\?\C:\…, \\.\C:\… are C:\…
    const drive = drives.get(abs.slice(0, 2).toLowerCase());
    if (drive) abs = win32.join(drive, abs.slice(2));
    const { root } = win32.parse(abs);
    if (!root.startsWith('\\\\')) return { local: onVolume(abs, p), share: null };
    const share = served.get(root.toLowerCase());
    if (!share) throw enoent(p);
    return { local: onVolume(win32.join(share.dir, abs.slice(root.length)), p), share };
  }
  function native(p) {
    const { local, share } = reach(p);
    return share ? win32.join(share.unc, local.slice(onVolume(share.dir, p).length)) : local;
  }
  const realpathSync = (p) => { native(p); return win32.resolve(p); };
  realpathSync.native = native;
  const ids = new Map();   // an on-disk path, folded → its file id
  const statSync = (p) => {
    const { local, share } = reach(p);
    const key = local.toLowerCase();
    if (!ids.has(key)) ids.set(key, BigInt(ids.size + 1));
    const serial = 0x5eed000000000000n | BigInt(local.charCodeAt(0));   // one per drive letter, above 32 bits too
    return { dev: share ? serial & 0xffffffffn : serial, ino: ids.get(key) };
  };
  return { realpathSync, statSync };
}
