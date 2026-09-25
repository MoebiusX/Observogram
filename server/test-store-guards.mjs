#!/usr/bin/env node
/**
 * server/test-store-guards.mjs — the source guards of docs/STORE_PLAN.md §1.
 *
 * 1. Only server/store/db.mjs names node:sqlite. A static import anywhere
 *    else would load the built-in before db.mjs can check the Node floor
 *    and filter its ExperimentalWarning.
 * 2. Anywhere in the repo, only db.mjs opens a transaction: no BEGIN or
 *    SAVEPOINT in any other .mjs/.js (the store's own tests,
 *    server/test-store*.mjs, are exempt). A BEGIN (deferred) or an
 *    outermost SAVEPOINT fails with SQLITE_BUSY_SNAPSHOT at once on a
 *    shared file whatever the timeout, and a handle is reachable anywhere
 *    through openStore() and openRaw().
 * 3. Inside server/store/, only db.mjs touches a handle's prepare()/exec():
 *    a raw prepare() skips the '?NNN' and binding checks. This rule stays
 *    scoped to server/store because RegExp#exec would match repo-wide.
 *    Everything goes through tx(), atomic(), prepare(db, sql), pragma()
 *    and execScript().
 *
 * 4. The identity switch (slice 2): server/auth.mjs exports resolveSession
 *    and none of the file-era readers (readSession, readUsers, writeUsers,
 *    maybeSeedDefaultAdmin); no tools/lib module imports from server/ (the
 *    journey engine opens no database); and only the boot, the legacy
 *    migration, the store's import/ops/cli modules, the suites and their
 *    fixtures import server/store/legacy-files.mjs — nothing else reads
 *    users.json or orgs.json.
 *
 * The matchers are tested on known-good and known-bad snippets first, so
 * the guard cannot pass by matching nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).split(sep).join('/');
const DB_MODULE = 'server/store/db.mjs';

// Every .mjs/.js under the repo, skipping node_modules and dot-directories
// (.git, a workspace, agent worktrees).
function sourceFiles(dir = ROOT, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.isFile() && /\.(mjs|js)$/.test(e.name)) out.push(relative(ROOT, p).split(sep).join('/'));
  }
  return out;
}

// Comments may explain the rules; only code must follow them.
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

const NAMES_SQLITE = /node:sqlite/;
// A transaction BEGIN: followed by ';', a closing quote, the end, or a
// transaction keyword. A trigger body's `BEGIN SELECT …` is not one.
const TX_BEGIN = /\bBEGIN\b(?=\s*(?:;|['"`]|$|DEFERRED\b|IMMEDIATE\b|EXCLUSIVE\b|TRANSACTION\b))/i;
const SAVEPOINT = /\bSAVEPOINT\b/i;
const RAW_HANDLE_CALL = /\.(?:prepare|exec)\s*\(/;

function storeViolations(src) {
  const code = withoutComments(src);
  const found = [];
  if (TX_BEGIN.test(code)) found.push('BEGIN');
  if (SAVEPOINT.test(code)) found.push('SAVEPOINT');
  if (RAW_HANDLE_CALL.test(code)) found.push('raw .prepare(/.exec(');
  return found;
}

test('the matchers flag what they must and pass what they must', () => {
  for (const bad of [
    "db.exec('BEGIN')", "execScript(db, 'BEGIN IMMEDIATE;')", "x('begin transaction')", "x(`BEGIN DEFERRED`)",
    "x('SAVEPOINT a')", "db.prepare('SELECT 1')", 'handle.exec (sql)',
  ]) assert.ok(storeViolations(bad).length > 0, bad);
  for (const good of [
    "prepare(db, 'SELECT 1')", 'execScript(db, sql)', 'tx(db, () => {})',
    "x('CREATE TRIGGER t BEFORE UPDATE ON a BEGIN SELECT RAISE(ABORT, \\'no\\'); END;')",
    "x(`CREATE TRIGGER t BEFORE DELETE ON a\nBEGIN\n  SELECT RAISE(ABORT, 'no');\nEND;`)",
    '// a comment that says BEGIN IMMEDIATE; and db.prepare(sql)', '/* SAVEPOINT */ const a = 1;',
  ]) assert.deepEqual(storeViolations(good), [], good);
  assert.ok(NAMES_SQLITE.test("await import('node:sqlite')"));
});

test('only server/store/db.mjs names node:sqlite in the repo\'s .mjs/.js', () => {
  const files = sourceFiles();
  assert.ok(files.includes(DB_MODULE) && files.length > 100, `walked the repo (${files.length} files)`);
  assert.ok(NAMES_SQLITE.test(readFileSync(join(ROOT, DB_MODULE), 'utf8')), 'db.mjs itself is found');
  const offenders = files.filter((f) => f !== DB_MODULE && f !== SELF && NAMES_SQLITE.test(readFileSync(join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, [], 'import it through server/store/db.mjs (loadSqlite, openStore, openRaw) instead');
});

test('no transaction BEGIN or SAVEPOINT in the repo\'s .mjs/.js outside db.mjs', () => {
  const files = sourceFiles().filter((f) => f !== DB_MODULE && !/^server\/test-store[^/]*\.mjs$/.test(f));
  assert.ok(files.length > 100 && files.includes('server/store/users.mjs'), `walked the repo (${files.length} files)`);
  const offenders = [];
  for (const f of files) {
    const code = withoutComments(readFileSync(join(ROOT, f), 'utf8'));
    const v = [];
    if (TX_BEGIN.test(code)) v.push('BEGIN');
    if (SAVEPOINT.test(code)) v.push('SAVEPOINT');
    if (v.length) offenders.push(`${f}: ${v.join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'open transactions only through tx()/atomic() from server/store/db.mjs');
});

// Also re-checks BEGIN/SAVEPOINT here; the raw prepare()/exec() rule is
// server/store only.
test('no BEGIN, SAVEPOINT or raw handle prepare()/exec() in server/store outside db.mjs', () => {
  const files = sourceFiles(join(ROOT, 'server', 'store')).filter((f) => f !== DB_MODULE);
  assert.ok(files.length >= 1, 'server/store has modules besides db.mjs');
  const offenders = files
    .map((f) => [f, storeViolations(readFileSync(join(ROOT, f), 'utf8'))])
    .filter(([, v]) => v.length)
    .map(([f, v]) => `${f}: ${v.join(', ')}`);
  assert.deepEqual(offenders, [], 'use tx()/atomic() and prepare(db, sql)/pragma()/execScript() from db.mjs');
});

// ---------- 4. the identity switch ----------

const NAMES_LEGACY_FILES = /legacy-files\.mjs['"`]/;
const IMPORTS_SERVER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"`](?:\.\.\/)+server\//;
const LEGACY_FILES_IMPORTERS = [
  /^server\/boot\.mjs$/, /^server\/tenancy\.mjs$/, /^server\/store\/(?:import|ops|cli)\.mjs$/,
  /^server\/test-[^/]*\.mjs$/, /^server\/fixtures\//, /^tools\/test-store-prestore-live\.mjs$/,
];

test('the identity-switch matchers flag what they must and pass what they must', () => {
  for (const bad of ["import { x } from './store/legacy-files.mjs';", "await import('../server/store/legacy-files.mjs')"]) {
    assert.ok(NAMES_LEGACY_FILES.test(withoutComments(bad)), bad);
  }
  assert.ok(!NAMES_LEGACY_FILES.test(withoutComments('// see server/store/legacy-files.mjs')), 'a comment is not an import');
  for (const bad of ["import { a } from '../../server/store/db.mjs';", "import '../../server/org-context.mjs';", "const m = await import('../server/tenancy.mjs');", "export { b } from '../server/x.mjs';"]) {
    assert.ok(IMPORTS_SERVER.test(bad), bad);
  }
  for (const good of ["import { a } from './brand-env.mjs';", "import { b } from '../contracts/x.mjs';"]) assert.ok(!IMPORTS_SERVER.test(good), good);
});

test('server/auth.mjs exports resolveSession and none of the file-era readers', async () => {
  const auth = await import('./auth.mjs');
  assert.equal(typeof auth.resolveSession, 'function');
  for (const gone of ['readSession', 'readUsers', 'writeUsers', 'usersFilePath', 'maybeSeedDefaultAdmin', 'defaultAdminCredentialActive']) {
    assert.ok(!(gone in auth), `auth.mjs no longer exports ${gone}`);
  }
});

test('no tools/lib module imports from server/', () => {
  const files = sourceFiles(join(ROOT, 'tools', 'lib'));
  assert.ok(files.includes('tools/lib/journey.mjs'), `walked tools/lib (${files.length} files)`);
  const offenders = files.filter((f) => IMPORTS_SERVER.test(withoutComments(readFileSync(join(ROOT, f), 'utf8'))));
  assert.deepEqual(offenders, [], 'tools/lib stays free of server code (the journey engine opens no database)');
});

test('only the boot, the migration, the store import/ops/cli, the suites and fixtures import legacy-files.mjs', () => {
  const files = sourceFiles().filter((f) => f !== 'server/store/legacy-files.mjs' && f !== SELF);
  const importers = files.filter((f) => NAMES_LEGACY_FILES.test(withoutComments(readFileSync(join(ROOT, f), 'utf8'))));
  assert.ok(importers.includes('server/boot.mjs') && importers.includes('server/store/import.mjs'), `found the importers (${importers.join(', ')})`);
  const offenders = importers.filter((f) => !LEGACY_FILES_IMPORTERS.some((re) => re.test(f)));
  assert.deepEqual(offenders, [], 'nothing else reads users.json or orgs.json after the switch');
});
