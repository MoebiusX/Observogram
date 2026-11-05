#!/usr/bin/env node
/**
 * server/test-repository-folders.mjs — the folders a service's repository can
 * be picked from (server/repository-folders.mjs, GET /api/repository-folders:
 * Overview's Browse…).
 *
 * The listing against a tree of its own: the top (the listed folders, or the
 * home folder on the person's own machine), a folder's folders by name with
 * the repositories marked, what is never listed (files, `.git`,
 * `node_modules`, a link that leads out of the listed folders), Up, the cap;
 * every refusal, each the save's own sentence where the save has one
 * (server/service-admin.mjs folderRefusal); then the route in process over
 * HTTP, in the open posture on loopback. Who may reach the route in each
 * posture is test-authz's matrix.
 */

// Hermetic (§0): a developer shell's store, identity or per-org variables
// never reach this process's imports.
const { STRIP, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();
delete process.env.OBSERVOGRAM_REPO_ROOTS;

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join, parse, resolve, dirname } = await import('node:path');

const TREE = mkdtempSync(join(tmpdir(), 'observogram-repo-folders-'));
const ROOTS = join(TREE, 'repos');
const OUTSIDE = join(TREE, 'outside');
const HOME = join(TREE, 'home');
for (const d of ['alpha/.git', 'beta', 'gamma/inner', '.hidden', 'node_modules/pkg', 'Delta']) mkdirSync(join(ROOTS, d), { recursive: true });
writeFileSync(join(ROOTS, 'beta', '.git'), 'gitdir: ../somewhere/.git/worktrees/beta\n');   // a worktree's .git is a file
writeFileSync(join(ROOTS, 'notes.txt'), 'a file, never listed\n');
mkdirSync(join(OUTSIDE, 'elsewhere'), { recursive: true });
mkdirSync(join(HOME, 'src', 'shop', '.git'), { recursive: true });
// Links: a junction on Windows, which needs no privilege; elsewhere Node
// ignores the type and makes a plain link.
const link = (target, at) => symlinkSync(target, at, 'junction');
link(join(ROOTS, 'gamma'), join(ROOTS, 'link-in'));
link(OUTSIDE, join(ROOTS, 'link-out'));
// os.homedir() reads these: the own-machine top is this tree's home.
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;
// The open posture on loopback, as `npm run demo` serves it: no sign-in.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-repo-folders-ws-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;
process.env.OBSERVOGRAM_AUTH = 'off';

const { listRepositoryFolders, FOLDER_WAYS, FOLDER_LIST_LIMIT } = await import('./repository-folders.mjs');
const { WAYS } = await import('./service-admin.mjs');

const LOCAL = { posture: 'open-loopback', direct: true };
const SIGNED_IN = { posture: 'identity', direct: false };
const names = (listing) => listing.folders.map((f) => f.name);
const refusedWith = async (promise, message, kind = 'invalid') => {
  await assert.rejects(promise, (e) => {
    assert.equal(e.name, 'AdminRefusal');
    assert.equal(e.kind, kind);
    assert.equal(e.message, message);
    return true;
  });
};

// ---------- under OBSERVOGRAM_REPO_ROOTS ----------

test('under listed folders, the top is those folders, whoever asks; a folder lists its folders by name, dot-folders last, the repositories marked (a .git folder or a worktree\'s .git file), files, .git, node_modules and a link that leads out never', async () => {
  const roots = [ROOTS];
  const top = await listRepositoryFolders(null, SIGNED_IN, { roots });
  assert.deepEqual(top, {
    ok: true, allowed: true, why: null, bounded: true, limit: FOLDER_LIST_LIMIT,
    path: null, up: null, repository: false, folders: [{ name: ROOTS, path: ROOTS, repository: false }], truncated: false,
  });
  assert.deepEqual(await listRepositoryFolders('  ', SIGNED_IN, { roots }), top, 'a blank path is the top');

  const listed = await listRepositoryFolders(ROOTS, SIGNED_IN, { roots });
  assert.equal(listed.path, ROOTS);
  assert.deepEqual(listed.up, { path: null }, 'Up from a listed folder is the top');
  assert.deepEqual(names(listed), ['alpha', 'beta', 'Delta', 'gamma', 'link-in', '.hidden']);
  assert.deepEqual(listed.folders.filter((f) => f.repository).map((f) => f.name), ['alpha', 'beta']);
  assert.deepEqual(listed.folders.find((f) => f.name === 'link-in'), { name: 'link-in', path: join(ROOTS, 'link-in'), repository: false }, 'a link inside them is listed by its own path');
  assert.equal(listed.truncated, false);

  const inner = await listRepositoryFolders(join(ROOTS, 'gamma'), SIGNED_IN, { roots });
  assert.deepEqual(inner.up, { path: ROOTS });
  assert.deepEqual(names(inner), ['inner']);
  const repo = await listRepositoryFolders(join(ROOTS, 'alpha'), SIGNED_IN, { roots });
  assert.equal(repo.repository, true, 'the folder listed says when it is a repository');
  assert.deepEqual(names(repo), [], 'its .git is not a folder to pick');
  assert.deepEqual(names(await listRepositoryFolders(join(ROOTS, 'link-in'), SIGNED_IN, { roots })), ['inner'], 'a link inside opens');
});

test('under listed folders, nothing outside them is opened: a folder outside, a link inside that leads out, a path that is not a full one, a folder not there, a file — each the refusal a save would give where it has one', async () => {
  const roots = [ROOTS];
  await refusedWith(listRepositoryFolders(OUTSIDE, LOCAL, { roots }), WAYS.repositoryFolderRoots(OUTSIDE));
  await refusedWith(listRepositoryFolders(join(ROOTS, 'link-out'), LOCAL, { roots }), WAYS.repositoryFolderRoots(join(ROOTS, 'link-out')));
  await refusedWith(listRepositoryFolders(join(ROOTS, '..', 'outside'), LOCAL, { roots }), WAYS.repositoryFolderRoots(join(ROOTS, '..', 'outside')));
  await refusedWith(listRepositoryFolders('repos/alpha', LOCAL, { roots }), WAYS.repositoryPath('repos/alpha'));
  await refusedWith(listRepositoryFolders(join(ROOTS, 'nope'), LOCAL, { roots }), FOLDER_WAYS.noFolder(join(ROOTS, 'nope')), 'missing');
  await refusedWith(listRepositoryFolders(join(ROOTS, 'notes.txt'), LOCAL, { roots }), FOLDER_WAYS.notFolder(join(ROOTS, 'notes.txt')));
  await refusedWith(listRepositoryFolders(`${ROOTS}${'x'.repeat(5000)}`, LOCAL, { roots }), WAYS.repositoryPath(`${ROOTS}${'x'.repeat(5000)}`));
  // A listed folder that is not there is left out of the top, not an error.
  const top = await listRepositoryFolders(null, LOCAL, { roots: [ROOTS, join(TREE, 'gone')] });
  assert.deepEqual(names(top), [ROOTS]);
});

test('a folder lists at most `limit` names and says it stopped', async () => {
  const listed = await listRepositoryFolders(ROOTS, LOCAL, { roots: [ROOTS], limit: 2 });
  assert.deepEqual(names(listed), ['alpha', 'beta']);
  assert.equal(listed.truncated, true);
  assert.equal(listed.limit, 2);
});

// ---------- the person's own machine (no folder listed) ----------

test('with no folder listed, a direct request to a loopback server without sign-in starts in the home folder, and Up climbs to the top of the disk — the whole machine is the person\'s', async () => {
  const home = await listRepositoryFolders(undefined, LOCAL, { roots: [] });
  assert.equal(home.allowed, true);
  assert.equal(home.bounded, false);
  assert.equal(home.path, HOME);
  assert.deepEqual(home.up, { path: dirname(HOME) });
  assert.deepEqual(names(home), ['src']);
  const src = await listRepositoryFolders(join(HOME, 'src'), LOCAL, { roots: [] });
  assert.deepEqual(src.folders, [{ name: 'shop', path: join(HOME, 'src', 'shop'), repository: true }]);
  assert.deepEqual(names(await listRepositoryFolders(ROOTS, LOCAL, { roots: [] })), ['alpha', 'beta', 'Delta', 'gamma', 'link-in', 'link-out', '.hidden'], 'no fence: a link out is the person\'s own disk too');
  const disk = parse(HOME).root;
  assert.equal((await listRepositoryFolders(disk, LOCAL, { roots: [] })).up, null, 'the top of the disk has no Up');
});

test('with no folder listed, any other caller is told why at the top (the save\'s sentence) and refused a path', async () => {
  for (const caller of [SIGNED_IN, { posture: 'open-loopback', direct: false }, { posture: 'open-exposed', direct: false }, null]) {
    const top = await listRepositoryFolders(null, caller, { roots: [] });
    assert.deepEqual(top, {
      ok: true, allowed: false, why: WAYS.repositoryFolderPosture, bounded: false, limit: FOLDER_LIST_LIMIT,
      path: null, up: null, repository: false, folders: [], truncated: false,
    }, JSON.stringify(caller));
    await refusedWith(listRepositoryFolders(HOME, caller, { roots: [] }), WAYS.repositoryFolderPosture);
  }
});

// ---------- the route ----------

const { start } = await import('./index.mjs');
const { closeStore } = await import('./store/db.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(async () => {
  await new Promise((ok) => srv.close(ok));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
  rmSync(TREE, { recursive: true, force: true });
});

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json' } });
  return { status: r.status, json: await r.json(), cache: r.headers.get('cache-control') };
}

test('GET /api/repository-folders in the open posture on loopback: the home folder, a folder by ?path=, never cached; a bad path is the sentence, as a 400 or a 404', async () => {
  const top = await get('/api/repository-folders');
  assert.equal(top.status, 200);
  assert.equal(top.json.allowed, true);
  assert.equal(top.json.path, HOME);
  assert.equal(top.cache, 'no-store');
  const listed = await get(`/api/repository-folders?path=${encodeURIComponent(ROOTS)}`);
  assert.equal(listed.status, 200);
  assert.deepEqual(names(listed.json).slice(0, 3), ['alpha', 'beta', 'Delta']);
  assert.deepEqual(await get('/api/repository-folders?path=relative'), { status: 400, json: { ok: false, error: WAYS.repositoryPath('relative') }, cache: null });
  const missing = await get(`/api/repository-folders?path=${encodeURIComponent(join(ROOTS, 'nope'))}`);
  assert.deepEqual([missing.status, missing.json.error], [404, FOLDER_WAYS.noFolder(join(ROOTS, 'nope'))]);
  assert.deepEqual(await get('/api/repository-folders?path=a&path=b'), { status: 400, json: { ok: false, error: FOLDER_WAYS.pathParam }, cache: null });
});

test('GET /api/repository-folders reads OBSERVOGRAM_REPO_ROOTS per request: the top becomes the listed folders, and a folder outside them is refused', async () => {
  process.env.OBSERVOGRAM_REPO_ROOTS = ROOTS;
  try {
    const top = await get('/api/repository-folders');
    assert.equal(top.status, 200);
    assert.deepEqual([top.json.bounded, top.json.path, names(top.json)], [true, null, [resolve(ROOTS)]]);
    const out = await get(`/api/repository-folders?path=${encodeURIComponent(HOME)}`);
    assert.deepEqual([out.status, out.json.error], [400, WAYS.repositoryFolderRoots(HOME)]);
  } finally {
    delete process.env.OBSERVOGRAM_REPO_ROOTS;
  }
});
