// server/repository-folders.mjs — the folders a service's repository can be
// picked from (GET /api/repository-folders, Overview's Browse…): one folder
// on the server and the folders inside it, by name, each marked when it holds
// a repository (`.git`, a folder or a worktree's file).
//
// The rule is the one that decides which folder a service may name
// (server/service-admin.mjs folderRefusal), so the picker offers nothing a
// save would refuse: under the folders OBSERVOGRAM_REPO_ROOTS lists when it
// lists any — the top is those folders, and Up never leaves them — else only
// on the person's own machine (a request sent straight to a loopback server
// without sign-in), where the top is their home folder and the whole disk is
// theirs. Names only: no file is listed or read. A folder is judged by its
// real path too, so a link inside a listed folder that leads out of it is
// neither listed nor opened. A folder's list stops at FOLDER_LIST_LIMIT
// names (`truncated`); `.git` and `node_modules` are never listed.

import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { AdminRefusal } from './identity-admin.mjs';
import { WAYS, folderRefusal, repositoryRoots } from './service-admin.mjs';

export const FOLDER_LIST_LIMIT = 500;
const PATH_MAX = 4096;
const SKIPPED = new Set(['.git', 'node_modules']);

const ON_WINDOWS = process.platform === 'win32';
const same = (a, b) => (ON_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b);

export const FOLDER_WAYS = Object.freeze({
  notFolder: (x) => `${JSON.stringify(x)} is a file, not a folder`,
  noFolder: (x) => `there is no folder ${JSON.stringify(x)} on the server`,
  unreadable: (x) => `the server may not read the folder ${JSON.stringify(x)}`,
  pathParam: 'give one folder path, as ?path=<its full path>',
});

const refuse = (message, kind = 'invalid') => { throw new AdminRefusal(message, kind); };

// An fs failure on `shown` as the refusal it is; anything else is a bug.
function fsRefusal(e, shown) {
  if (e?.code === 'ENOENT') return new AdminRefusal(FOLDER_WAYS.noFolder(shown), 'missing');
  if (e?.code === 'ENOTDIR') return new AdminRefusal(FOLDER_WAYS.notFolder(shown), 'invalid');
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return new AdminRefusal(FOLDER_WAYS.unreadable(shown), 'invalid');
  return e;
}

// The listed folders and their real paths: a listed folder that is itself a
// link still holds what is under its target.
async function fenceOf(roots) {
  const out = [...roots];
  for (const r of roots) {
    try {
      const real = await realpath(r);
      if (!out.some((x) => same(x, real))) out.push(real);
    } catch { /* a listed folder that does not exist bounds nothing more */ }
  }
  return out;
}

const isDir = async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };
const holdsRepository = async (p) => { try { await stat(join(p, '.git')); return true; } catch { return false; } };

// Dot-folders after the others, then by name as a person reads it.
const byName = (a, b) => (Number(a.name.startsWith('.')) - Number(b.name.startsWith('.')))
  || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
  || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// listRepositoryFolders(path, caller, { roots, home, limit }) → the listing:
//   { ok, allowed, why, bounded, path, up, repository, folders: [{ name, path, repository }], truncated, limit }
//   path      the folder listed (its full path), or null for the top of a bounded server (the listed folders)
//   up        { path } — the folder above, path null for that top — or null at the top
//   bounded   true when OBSERVOGRAM_REPO_ROOTS lists folders
// With no path, the top; a caller the rule refuses there gets allowed: false
// and the rule's sentence (the studio shows it in place of Browse…). A named
// path the rule refuses, that is not a full path, not there or not a folder
// throws the AdminRefusal (400, or 404 for a folder not there).
export async function listRepositoryFolders(path, caller, { roots = repositoryRoots(), home = homedir(), limit = FOLDER_LIST_LIMIT } = {}) {
  const bounded = roots.length > 0;
  const base = { ok: true, allowed: true, why: null, bounded, limit };
  const fence = bounded ? await fenceOf(roots) : [];
  const allowedHere = (p) => !folderRefusal(p, caller, { roots: bounded ? fence : roots });
  let shown = typeof path === 'string' ? path.trim() : '';
  if (!shown) {
    if (bounded) {
      const folders = [];
      for (const r of roots) {
        if (await isDir(r)) folders.push({ name: r, path: r, repository: await holdsRepository(r) });
      }
      return { ...base, path: null, up: null, repository: false, folders, truncated: false };
    }
    const why = folderRefusal(home, caller, { roots });
    if (why) return { ...base, allowed: false, why, path: null, up: null, repository: false, folders: [], truncated: false };
    shown = home;
  }
  if (shown.length > PATH_MAX || !isAbsolute(shown)) refuse(WAYS.repositoryPath(shown));
  const abs = resolvePath(shown);
  const why = folderRefusal(abs, caller, { roots });
  if (why) refuse(why);
  let real;
  try { real = await realpath(abs); } catch (e) { throw fsRefusal(e, shown); }
  if (bounded && !allowedHere(real)) refuse(WAYS.repositoryFolderRoots(shown));
  let entries;
  try {
    if (!(await stat(real)).isDirectory()) refuse(FOLDER_WAYS.notFolder(shown));
    entries = await readdir(real, { withFileTypes: true });
  } catch (e) { throw fsRefusal(e, shown); }

  const candidates = [];
  for (const d of entries) {
    if (SKIPPED.has(d.name)) continue;
    const child = join(abs, d.name);
    if (d.isDirectory()) { candidates.push({ name: d.name, path: child }); continue; }
    if (!d.isSymbolicLink()) continue;
    // A link: listed when it leads to a folder the rule allows.
    try {
      const target = await realpath(child);
      if ((await stat(target)).isDirectory() && (!bounded || allowedHere(target))) candidates.push({ name: d.name, path: child });
    } catch { /* a broken link is not a folder */ }
  }
  candidates.sort(byName);
  const kept = candidates.slice(0, limit);
  const folders = await Promise.all(kept.map(async (f) => ({ ...f, repository: await holdsRepository(f.path) })));

  let up = null;
  const parent = dirname(abs);
  if (bounded) up = roots.some((r) => same(r, abs)) || !allowedHere(parent) ? { path: null } : { path: parent };
  else if (!same(parent, abs)) up = { path: parent };
  return {
    ...base, path: abs, name: basename(abs) || abs, up, repository: await holdsRepository(abs),
    folders, truncated: candidates.length > kept.length,
  };
}
