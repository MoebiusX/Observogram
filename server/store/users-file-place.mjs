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
//   - the walk: the root and everything under it, as rmSync takes it — lstat each entry, list each directory, never
//     through a link (a symlink, or a junction on Windows). A mount point under the root is refused: an entry on
//     another filesystem than the directory that holds it, a directory the walk reached already (one directory
//     mounted at a second place under the root), or on Windows a folder another volume is mounted in (lstatSync
//     answers the folder, statSync the volume). On Node 22 rmSync stops part-way at a mount point; on Node 23 and
//     later it first deletes the files of the filesystem mounted there; and a directory mounted from outside the
//     root may hold the users file. The root itself mounted (a volume per org) is refused alike. A directory the
//     walk cannot read is refused: what lies in it cannot be told, and rmSync would fail part-way there.
//   - the users file, its path followed through every link (statSync): it lies under the root when an entry the
//     walk found is the same file — the same device and inode (on Windows the volume serial's low 32 bits, all a
//     share reports, as server/store/paths.mjs places a path) — or, on another device, the same kind with the same
//     modification time, compared at the coarser of the two clocks' precision (an SMB view keeps 100 ns, an sshfs
//     one seconds), and for a file the same size, for a directory the same inode. That is a view of it through
//     another filesystem: an NFS or SMB mount of a directory under the root reports the server's inode with
//     another device; an overlay mount reports another device and, with xino or once the file is copied up into an
//     upper directory under the root, another inode too. A copy under the root that kept the users file's size and
//     modification time on another device reads the same (a declared false refusal; moving it out is the way out).
//     Every matching entry is named, so one move clears them all (hard links included).
//
// A same-filesystem bind mount under the root of a directory from outside it is a directory to lstatSync (the same
// device; /proc/self/mountinfo is not read), so the walk enters it as rmSync does; and a view that reports neither
// the inode nor the size and modification time (some FUSE filesystems) is not matched.
//
// usersFilePlace(file, root, { recorded, id, fs, path, windows }) → { exists, refusal }: exists is whether the users
// file's path leads to a file now (true), or not (false), or null when the check stopped before it; refusal is
// purge-org's message, or null when deleting the root takes nothing of the users file. recorded is false for
// <base>/users.json when nothing was recorded; id is the org's. fs = { lstatSync, statSync, readdirSync } (node:fs's,
// called with { bigint: true }), path (node:path's) and windows (the platform) are injectable
// (server/test-store-ops.mjs, over server/fixtures/mount-fs.mjs); the default is this host.

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

const ON_WINDOWS = process.platform === 'win32';
const GONE = new Set(['ENOENT', 'ENOTDIR']);
const SECOND = 1_000_000_000n;

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
  const under = (p) => p.startsWith(root + path.sep);
  const who = recorded ? `the recorded users file ${file}`
    : `the users file ${file} (the one a pre-store build reads: OBSERVOGRAM_USERS_FILE was not set at the import)`;
  const code = (e) => e?.code || e?.message || 'error';
  const stopped = (refusal) => ({ exists: null, refusal });

  // The walk: what rmSync(root, { recursive: true }) would delete.
  const denied = (e) => e?.code === 'EACCES' || e?.code === 'EPERM';
  const unreadable = (at, e) => stopped(`${at}${under(at) ? ` under ${root}` : ''} cannot be read (${code(e)}), so purge-org cannot `
    + `tell what deleting ${root} takes — nothing was deleted. `
    + (denied(e) ? `Run purge-org as a user who can read it; or, if ${who} does not lie under ${root}, delete ${root} by hand as such `
      + 'a user'
      : `If it is a filesystem mounted there that stopped answering, unmount it, then run purge-org again; or, if ${who} does not `
      + `lie under ${root}, delete ${root} by hand`)
    + `, then run purge-org again: it drops org ${id}'s records`);
  const entries = [];   // { path, st }
  const mounts = [];    // { at, why }
  const walked = new Map();   // a directory's device:inode → its path
  let above;
  try { above = dev(stat(path.dirname(root))); } catch (e) { return unreadable(path.dirname(root), e); }
  const stack = [{ at: root, parentDev: above }];
  while (stack.length) {
    const { at, parentDev } = stack.pop();
    let st;
    try { st = lstat(at); } catch (e) {
      if (GONE.has(e?.code) && at !== root) continue;   // gone while the walk ran: nothing of it to delete
      return unreadable(at, e);
    }
    entries.push({ path: at, st });
    if (dev(st) !== parentDev) { mounts.push({ at, why: `another filesystem than ${path.dirname(at)}` }); continue; }
    if (!st.isDirectory()) continue;
    let through;
    try { through = stat(at); } catch (e) { return unreadable(at, e); }
    if (dev(through) !== dev(st)) { mounts.push({ at, why: 'another volume mounted in it' }); continue; }
    const key = `${dev(st)}:${st.ino}`;
    if (walked.has(key)) { mounts.push({ at, why: `the directory ${walked.get(key)} again` }); continue; }
    walked.set(key, at);
    let names;
    try { names = fs.readdirSync(at); } catch (e) { return unreadable(at, e); }
    for (const name of [...names].sort().reverse()) stack.push({ at: path.join(at, name), parentDev: dev(st) });
  }
  if (mounts[0]?.at === root) {
    return stopped(`${root} (${mounts[0].why}) is a mount point: deleting it would take the files of the filesystem mounted there and then fail `
      + 'on the mount point itself (Node 23 and later; Node 22 fails at once) — nothing was deleted. Unmount it, then run purge-org '
      + `again: it deletes what is left at ${root} and drops org ${id}'s records, and the unmounted filesystem's files stay`);
  }
  if (mounts.length) {
    const named = mounts.map((m) => `${m.at} (${m.why})`).sort();
    return stopped(`${root} holds ${mounts.length === 1 ? 'a mount point' : 'mount points'}, ${list(named)}: deleting `
      + `${root} would take the files of the filesystem mounted there (Node 23 and later) or stop part-way at it (Node 22), and a `
      + `directory mounted from outside ${root} may hold the users file — nothing was deleted. Unmount what is mounted there, then `
      + 'run purge-org again');
  }

  // The users file, its path followed through every link.
  let st;
  try { st = stat(file); } catch { return { exists: null, refusal: null }; }
  const kin = entries.filter((e) => same(e.st, st));
  if (!kin.length) return { exists: true, refusal: null };
  const ids = kin.filter((e) => dev(e.st) === dev(st)).map((e) => e.path);
  const views = kin.filter((e) => dev(e.st) !== dev(st)).map((e) => e.path);
  return {
    exists: true,
    refusal: `${who} lies under ${root}: `
      + (ids.length ? `it is ${list(ids)} there` : '')
      + (views.length ? `${ids.length ? ', and ' : ''}${list(views)} under it ${views.length === 1 ? 'has' : 'have'} its `
        + `${st.isFile() ? 'size and ' : ''}modification time on another filesystem (the users file seen through a network or `
        + 'overlay mount, or a copy that kept them)' : '')
      + ` — nothing was deleted. Move ${list(kin.map((e) => e.path))} out of ${root}, then run purge-org again. If ${file} then `
      + 'no longer leads to the users file, make it lead there again before a pre-store build or the in-place '
      + '`packc store export` uses it',
  };
}
