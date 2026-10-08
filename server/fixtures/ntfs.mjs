// server/fixtures/ntfs.mjs — an NTFS volume as Windows' realpath sees it, so
// the path-comparison suites prove the Windows rule on any host
// (tools/test-journey-scope.mjs). On NTFS a name is case-insensitive and a
// directory may also be named by its short (8.3) name. The native realpath
// (realpathSync.native) answers the on-disk spelling — the long names, the
// case they were created with, the drive letter upper case — while JS
// realpathSync answers the caller's own spelling of a path that exists.
// \\?\C:\… and \\.\C:\… name C:\…. A network share is libuv's case: a path
// reached through one (\\host\share\…, \\?\UNC\host\share\…, a mapped drive)
// resolves to \\host\share\ and the on-disk rest, never to the volume's own
// path; a share the volume does not serve is ENOENT.
//
// Imports nothing but node:path's Windows rules: no platform is read, so
// tools/test-platform.mjs's P5 holds.

import { win32 } from 'node:path';

const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), { code: 'ENOENT' });

/**
 * ntfsVolume(files, { short, shares, mapped }) → { realpathSync } — node:fs's realpathSync as Windows runs it on this volume:
 *   files   the on-disk spellings of the volume's files, e.g. 'C:\\ws\\orgs\\acme\\packs\\own.pack.yaml'
 *           (each one's directories exist too);
 *   short   { '<a directory, as on disk>': '<its short name>' }, e.g. { 'C:\\ws': 'WS~1' };
 *   shares  { '\\\\<host>\\<share>': '<the directory it exposes, as on disk>' }, one entry per name of
 *           its server, e.g. { '\\\\localhost\\C$': 'C:\\' };
 *   mapped  { '<drive>:': '\\\\<host>\\<share>[\\…]' }, a mapped network drive, e.g. { 'Z:': '\\\\localhost\\C$\\ws' }.
 *   realpathSync(p)         the JS one: p resolved, in the caller's spelling, or ENOENT;
 *   realpathSync.native(p)  the on-disk spelling (\\host\share\… through a share), or ENOENT.
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
  function native(p) {
    let abs = win32.resolve(p);
    if (/^\\\\\?\\UNC\\/i.test(abs)) abs = `\\${abs.slice(7)}`;          // \\?\UNC\host\share\… is \\host\share\…
    else if (/^\\\\[?.]\\[a-z]:/i.test(abs)) abs = abs.slice(4);          // \\?\C:\…, \\.\C:\… are C:\…
    const drive = drives.get(abs.slice(0, 2).toLowerCase());
    if (drive) abs = win32.join(drive, abs.slice(2));
    const { root } = win32.parse(abs);
    if (!root.startsWith('\\\\')) return onVolume(abs, p);
    const share = served.get(root.toLowerCase());
    if (!share) throw enoent(p);
    const local = onVolume(win32.join(share.dir, abs.slice(root.length)), p);
    return win32.join(share.unc, local.slice(onVolume(share.dir, p).length));
  }
  const realpathSync = (p) => { native(p); return win32.resolve(p); };
  realpathSync.native = native;
  return { realpathSync };
}
