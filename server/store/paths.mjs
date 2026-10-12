// server/store/paths.mjs — the form in which the store's offline operations
// compare two paths: an export target with the workspace (a directory
// export's refusal, the in-place detection), the database with the
// workspace, a purged org's root with <base>/orgs and the users file with
// that root, a backup or restore path with the database and its
// -wal/-shm/-journal.
//
// comparedPath(own) → compared(p, beside), the function a check compares
// through: p's form, placed beside the path it is checked against when one
// is given. Off Windows it is `own`, the calling module's realpath form (which
// takes p alone), so Linux and macOS compare exactly as before. On Windows a
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
// and spelled from there. A share of another directory, or of another host, shares no
// directory with it and stays an ordinary target. The twin of this rule is
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
  const fileId = (p) => {
    try { const st = fsStat(p, { bigint: true }); return `${st.dev & 0xffffffffn}:${st.ino}`; } catch { return null; }
  };
  const lineage = (native) => {   // native and its ancestors, nearest first
    const dirs = [native];
    while (path.dirname(dirs.at(-1)) !== dirs.at(-1)) dirs.push(path.dirname(dirs.at(-1)));
    return dirs;
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
    return form(native);
  };
}
