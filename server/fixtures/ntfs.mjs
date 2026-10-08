// server/fixtures/ntfs.mjs — an NTFS volume as Windows' realpath sees it, so
// the path-comparison suites prove the Windows rule on any host
// (tools/test-journey-scope.mjs). On NTFS a name is case-insensitive and a
// directory may also be named by its short (8.3) name. The native realpath
// (realpathSync.native) answers the on-disk spelling — the long names, the
// case they were created with, the drive letter upper case — while JS
// realpathSync answers the caller's own spelling of a path that exists.
//
// Imports nothing but node:path's Windows rules: no platform is read, so
// tools/test-platform.mjs's P5 holds.

import { win32 } from 'node:path';

const enoent = (p) => Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), { code: 'ENOENT' });

/**
 * ntfsVolume(files, { short }) → { realpathSync } — node:fs's realpathSync as Windows runs it on this volume:
 *   files  the on-disk spellings of the volume's files, e.g. 'C:\\ws\\orgs\\acme\\packs\\own.pack.yaml'
 *          (each one's directories exist too);
 *   short  { '<a directory, as on disk>': '<its short name>' }, e.g. { 'C:\\ws': 'WS~1' }.
 *   realpathSync(p)         the JS one: p resolved, in the caller's spelling, or ENOENT;
 *   realpathSync.native(p)  the on-disk spelling, or ENOENT.
 */
export function ntfsVolume(files, { short = {} } = {}) {
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

  function native(p) {
    const abs = win32.resolve(p);
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
  const realpathSync = (p) => { native(p); return win32.resolve(p); };
  realpathSync.native = native;
  return { realpathSync };
}
