// server/store/paths.mjs — the form in which the store's offline operations
// compare two paths: an export target with the workspace (a directory
// export's refusal, the in-place detection), the database with the
// workspace, a purged org's root with <base>/orgs and the users file with
// that root, a backup or restore path with the database and its
// -wal/-shm/-journal.
//
// comparedPath(own) → the function a check compares through. Off Windows it
// is `own`, the calling module's realpath form, so Linux and macOS compare
// exactly as before. On Windows a spelling does not name a path: NTFS names
// are case-insensitive and a directory has a short (8.3) name beside its
// long one, so C:\ws, c:/WS and C:\WS~1 are one directory, and JS
// realpathSync keeps whichever the caller wrote. There a path is compared as
// the native realpath (long names, the case on disk) of its longest prefix
// that exists, the rest appended as written, with \ separators and case
// folded — the form a studio-run journey's org scope compares in
// (crawlScopeRefusal, tools/lib/journey.mjs). A path reached through a
// network share keeps the share's name in that form (\\localhost\C$\ws is
// not C:\ws here): the journey scope refuses such a path outside the
// workspace; these checks do not, since an export or a backup on a share is
// an ordinary target. That form only compares: every message, record and
// return value keeps the path as given. host =
// { windows, path, realpathSync } (the platform, node:path's and node:fs's
// realpathSync with its .native) is injectable (server/test-store-paths.mjs);
// the default is this host.

import { realpathSync } from 'node:fs';
import * as nodePath from 'node:path';

const ON_WINDOWS = process.platform === 'win32';

export function comparedPath(own, { windows = ON_WINDOWS, path = nodePath, realpathSync: fsRealpath = realpathSync } = {}) {
  if (!windows) return own;
  const real = (p) => {
    try { return fsRealpath.native(p); } catch {
      const parent = path.dirname(p);
      return parent === p ? p : path.join(real(parent), path.basename(p));
    }
  };
  return (p) => real(path.resolve(p)).replaceAll('/', '\\').toLowerCase();
}
