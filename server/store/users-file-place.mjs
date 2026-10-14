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
//     another filesystem than the directory that holds it, one /proc/self/mountinfo lists (Linux: a bind mount of a
//     directory of the same filesystem, which lstatSync cannot tell from a directory; matched by the root's real
//     path, as the kernel lists it), a directory the walk reached already (one directory mounted at a second place
//     under the root), or on Windows a folder another volume is mounted in (lstatSync answers the folder, statSync
//     the volume). On Node 22 rmSync stops part-way at a mount point; on Node 23 and later it first deletes the files
//     of the filesystem mounted there; and a directory mounted from outside the root may hold the users file. The
//     root itself mounted (a volume per org) is refused alike. A directory the walk cannot read is refused: what lies
//     in it cannot be told, and rmSync would fail part-way there.
//   - the users file, its path followed through every link (statSync): it lies under the root when an entry the
//     walk found is the same file — the same device and inode (on Windows the volume serial's low 32 bits, all a
//     share reports, as server/store/paths.mjs places a path) — or, on another device, the same kind with the same
//     modification time, compared at the coarser of the two clocks' precision (an SMB view keeps 100 ns, an sshfs
//     one seconds), and for a file the same size, for a directory the same inode. That is a view of it through
//     another filesystem: an NFS or SMB mount of a directory under the root reports the server's inode with
//     another device; an overlay mount reports another device and, with xino or once the file is copied up into an
//     upper directory under the root, another inode too. A copy under the root that kept the users file's size and
//     modification time on another device reads the same (a declared false refusal; moving it out is the way out).
//     Every matching entry is named, so one move clears them all (hard links included). Through a view whose
//     directories show another inode or modification time than theirs under the root (an overlay mount with an upper
//     directory shows that directory's), the path then leads where nothing traces it back, and it is refused as a users
//     file that does not exist (below): a view's refusal names that second step, deleting the root by hand.
//   - a users file that does not exist: nothing of it is under the root to delete, unless its path leads there through
//     what is not there now — a filesystem not mounted. So its place is found as the kernel would resolve the path,
//     every link that exists followed (a dangling one by its target), to the nearest directory that exists there. One
//     the walk read (by identity, as above) means it leads under the root — a users file moved out of the root,
//     recorded there or reached through a mount of a directory under it or a link into it — and the purge goes on;
//     any other is refused, failing closed: a mount that is down leaves its mount point an empty directory, which tells
//     nothing. So a recorded users file deleted outside the root is refused too (declared), and deleting the root by
//     hand is its way out. The default <base>/users.json, which nothing records, absent — nothing at its path, not even
//     a link — is nothing to keep (a store that keeps no local users may have none); a link there that leads nowhere
//     now is placed as a recorded path is, since through a mount that is down it may lead under the root.
//   - a users file that cannot be read — statSync failing otherwise (EACCES on a directory of its path, a link loop),
//     or a part of its path that cannot be read — is refused.
//   - a users file that exists and that no entry is: before the purge goes on, each directory the walk read is read
//     again — the same directory (device and inode), the same change time, which moves with every entry added, removed
//     or renamed in it, and the same names. The walk read each directory at its own moment, so an entry another process
//     renamed while it ran, from a directory not read yet into one read already (the users file, or a directory holding
//     it), was in neither listing. A directory that changed is refused; stopping what changes it and running purge-org
//     again is its way out.
//
// Without /proc/self/mountinfo (off Linux, or /proc not mounted), a bind mount under the root of a directory from
// outside it, on the same filesystem, is a directory to lstatSync (the same device), and the walk enters it. A view
// that reports neither the inode nor the size and modification time (some FUSE filesystems) is not matched; and a
// recorded path that passes through a link under the root keeps the file the link leads to (rmSync deletes the link
// alone), but leads nowhere once it is gone. Not seen either: what another process moves, links or mounts under the
// root after the check, before rmSync takes it; a directory changed and changed back within one tick of a coarse
// filesystem clock, its change time and names as they were; and a same-filesystem bind mount made on a directory under
// the root after /proc/self/mountinfo was read, before the walk reaches it.
//
// usersFilePlace(file, root, { recorded, id, fs, path, windows }) → { exists, refusal }: exists is whether the users
// file's path leads to a file now (true), or not (false), or null when the check stopped before it could tell;
// refusal is purge-org's message, or null when deleting the root takes nothing of the users file. recorded is false
// for <base>/users.json when nothing was recorded; id is the org's. fs = { lstatSync, statSync, readdirSync,
// readlinkSync, realpathSync, readFileSync } (node:fs's; the stats called with { bigint: true }), path (node:path's) and
// windows (the platform) are injectable
// (server/test-store-ops.mjs, over server/fixtures/mount-fs.mjs); the default is this host.

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

const ON_WINDOWS = process.platform === 'win32';
const GONE = new Set(['ENOENT', 'ENOTDIR']);
const SECOND = 1_000_000_000n;
const MAX_LINKS = 40;   // Linux's MAXSYMLINKS
const MOUNTINFO = '/proc/self/mountinfo';
// A mount point as /proc/self/mountinfo spells it (its fifth field): the kernel's octal escapes (\040 a space, \011,
// \012, \134) undone.
const unoctal = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)));

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
  const read = [];            // { at, was, names }: each directory the walk listed, as it found it
  // A directory as the walk found it: the same directory (device and inode) with the same change time — an entry
  // added, removed or renamed in it, or a mount over it, changes one of them.
  const state = (st) => `${dev(st)}:${st.ino}:${st.ctimeNs}`;
  let above;
  try { above = dev(stat(path.dirname(root))); } catch (e) { return unreadable(path.dirname(root), e); }
  // The mount points Linux lists at the root or under it, as paths relative to it ('' the root itself): a bind mount of a
  // directory of the same filesystem among them, which lstatSync cannot tell from a directory. The kernel lists real
  // paths, so the root's is compared. No such file (off Linux, /proc not mounted): only the walk tells.
  const listed = new Set();
  let info = null;
  if (!windows) {
    try { info = fs.readFileSync(MOUNTINFO, 'utf8'); } catch (e) { if (!GONE.has(e?.code)) return unreadable(MOUNTINFO, e); }
  }
  if (info !== null) {
    let real;
    try { real = fs.realpathSync(root); } catch (e) { return unreadable(root, e); }
    for (const line of info.split('\n')) {
      const field = line.split(' ')[4];
      const at = field === undefined ? null : unoctal(field);
      if (at === real) listed.add('');
      else if (at?.startsWith(real + path.sep)) listed.add(at.slice(real.length));
    }
  }
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
    if (listed.has(at.slice(root.length))) { mounts.push({ at, why: `the same filesystem as ${path.dirname(at)}, listed in ${MOUNTINFO}` }); continue; }
    if (!st.isDirectory()) continue;
    let through;
    try { through = stat(at); } catch (e) { return unreadable(at, e); }
    if (dev(through) !== dev(st)) { mounts.push({ at, why: 'another volume mounted in it' }); continue; }
    const key = `${dev(st)}:${st.ino}`;
    if (walked.has(key)) { mounts.push({ at, why: `the directory ${walked.get(key)} again` }); continue; }
    walked.set(key, at);
    let names;
    try { names = fs.readdirSync(at); } catch (e) { return unreadable(at, e); }
    names = [...names].sort();
    read.push({ at, was: state(st), names: names.join('\0') });
    for (const name of [...names].reverse()) stack.push({ at: path.join(at, name), parentDev: dev(st) });
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

  // Where a path that does not exist leads: each link that exists followed (a dangling one by its target), '..' taken
  // from the directory reached, as the kernel resolves a path; { place, nearest, nearestSt } or { at, error }.
  const split = (p) => p.split(windows ? /[\\/]+/ : /\/+/).filter(Boolean);
  const lead = (p) => {
    let todo;
    let cur;
    let curSt;
    let hops = 0;
    const from = (abs) => {
      cur = path.parse(abs).root;
      todo = split(abs.slice(cur.length));
      try { curSt = lstat(cur); } catch { curSt = null; }
    };
    from(path.resolve(p));
    while (todo.length && curSt) {
      const [name, ...rest] = todo;
      if (name === '.' || name === '..') {
        todo = rest;
        if (name === '..' && path.dirname(cur) !== cur) {
          cur = path.dirname(cur);
          try { curSt = lstat(cur); } catch (e) { return { at: cur, error: e }; }
        }
        continue;
      }
      const next = path.join(cur, name);
      let st;
      try { st = lstat(next); } catch (e) {
        if (GONE.has(e?.code)) break;
        return { at: next, error: e };
      }
      if (st.isSymbolicLink()) {
        if (++hops > MAX_LINKS) return { at: next, error: { code: 'ELOOP' } };
        let target;
        try { target = fs.readlinkSync(next); } catch (e) { return { at: next, error: e }; }
        if (path.isAbsolute(target)) {
          from(target);
          todo = [...todo, ...rest];
        } else {
          todo = [...split(target), ...rest];
        }
        continue;
      }
      if (!st.isDirectory()) break;
      cur = next;
      curSt = st;
      todo = rest;
    }
    return { place: todo.length ? path.join(cur, ...todo) : cur, nearest: curSt ? cur : null, nearestSt: curSt };
  };

  // The users file, its path followed through every link.
  const cannot = (at, e) => stopped(`${who} cannot be read on this host (${code(e)}${at === file ? '' : ` at ${at}`}`
    + `${e?.code === 'ELOOP' ? `: a link loop, or a chain of more than ${MAX_LINKS} links` : ''}), so nothing tells whether it lies `
    + `under ${root} — nothing was deleted. ${denied(e) ? `Run purge-org as a user who can read ${at}; or, if it` : 'If it'} does not `
    + `lie under ${root}, delete ${root} by hand, then run purge-org again: it drops org ${id}'s records`);
  let st;
  try { st = stat(file); } catch (e) {
    if (!GONE.has(e?.code)) return cannot(file, e);
    // It does not exist, so nothing of it is under the root to delete — unless its path leads there through what is not
    // there now: a filesystem not mounted. Where it leads (lead, above): under the root — the nearest directory that
    // exists is one the walk read — the purge goes on: a users file moved out of the root, recorded there or reached
    // through a mount of a directory under it or a link into it. Elsewhere nothing tells, so it is refused, failing
    // closed. <base>/users.json, the default nothing records, is absent on every store that keeps no local users:
    // absent — nothing at its path, not even a link — it is nothing to keep. A link there is placed as a recorded path is.
    const nothingAt = () => { try { lstat(file); return false; } catch (e2) { return GONE.has(e2?.code); } };
    if (!recorded && nothingAt()) return { exists: false, refusal: null };
    const led = lead(file);
    if (led.error) return cannot(led.at, led.error);
    if (led.nearestSt && entries.some((en) => en.st.isDirectory() && same(en.st, led.nearestSt))) return { exists: false, refusal: null };
    return stopped(`${who} does not exist, and nothing on this host tells where its path leads`
      + `${led.place === path.resolve(file) ? '' : ` (to ${led.place})`}: `
      + (led.nearest === null ? 'no part of it exists' : `the nearest part of it that exists, ${led.nearest}, is no directory under ${root}`)
      + `, and a filesystem not mounted now may lead it under ${root} — nothing was deleted. If it lies on a filesystem that is not `
      + `mounted now, mount it, then run purge-org again; if it does not lie under ${root}, delete ${root} by hand, then run purge-org `
      + `again: it drops org ${id}'s records`);
  }
  const kin = entries.filter((e) => same(e.st, st));
  if (!kin.length) {
    // The walk read each directory at its own moment: an entry another process renamed, while it ran, from a directory
    // not read yet into one read already (the users file, or a directory holding it) was in neither listing, and rmSync
    // deleted it. So before the purge goes on, each directory the walk read is read again, now that the users file is
    // placed: the same directory (device and inode), the same change time — which moves with every entry added, removed
    // or renamed in it — and the same names. Then none changed from its listing to now, and the walk is what lay under
    // the root at one moment, the users file placed in it. A directory that changed is refused.
    const changed = read.find(({ at, was, names }) => {
      try { return state(lstat(at)) !== was || [...fs.readdirSync(at)].sort().join('\0') !== names; } catch { return true; }
    });
    if (!changed) return { exists: true, refusal: null };
    const { at } = changed;
    return stopped(`${at === root ? root : `${at} under ${root}`} changed while purge-org read ${at === root ? 'it' : root} (an entry added, `
      + `removed or renamed in it, or a mount over it), so purge-org cannot tell what deleting ${root} takes — nothing was deleted. `
      + `Stop what changes files under ${root}, then run purge-org again`);
  }
  const ids = kin.filter((e) => dev(e.st) === dev(st)).map((e) => e.path);
  const views = kin.filter((e) => dev(e.st) !== dev(st)).map((e) => e.path);
  return {
    exists: true,
    refusal: `${who} lies under ${root}: `
      + (ids.length ? `it is ${list(ids)} there` : '')
      + (views.length ? `${ids.length ? ', and ' : ''}${list(views)} under it ${views.length === 1 ? 'has' : 'have'} its `
        + `${st.isFile() ? 'size and ' : ''}modification time on another filesystem (the users file seen through a network or `
        + 'overlay mount, or a copy that kept them)' : '')
      + ` — nothing was deleted. Move ${list(kin.map((e) => e.path))} out of ${root}, then run purge-org again`
      // Seen through a view, the path may then lead where nothing traces it back to the root, and a users file that does
      // not exist there is refused (above): an overlay mount's merged directory shows its upper directory's inode and time.
      + (views.length ? `; if it then refuses because ${file} does not exist (a mount whose directories show another inode or `
        + `modification time than theirs under ${root}, as an overlay mount with an upper directory does, cannot be traced back `
        + `there), delete ${root} by hand, then run purge-org again: it drops org ${id}'s records` : '')
      + `. If ${file} then no longer leads to the users file, make it lead there again before a pre-store build or the in-place `
      + '`packc store export` uses it',
  };
}
