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
 * 5. The route table (slice 3): server/route-table.mjs is pure data — it
 *    imports nothing — and only server/authz.mjs, the route-inventory
 *    fixture and the suites import it.
 *
 * 6. The docs and the request (slice 5): every `req.observogram<Name>` a
 *    doc names (README and docs/, outside the CHANGELOG's history and
 *    docs/archive) is a property the server stamps. Slice 5 replaced
 *    observogramActor / observogramSub with observogramPrincipal and a
 *    status-quo row kept naming the old seam.
 *
 * The matchers are tested on known-good and known-bad snippets first, so
 * the guard cannot pass by matching nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Hermetic (§0): one case imports server/auth.mjs in-process; the children's
// STRIP list, both spellings, goes first (serve-child.mjs imports no server
// code). server/test-hermetic-suites.mjs guards the shape.
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

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
// pack-import.mjs (slice 4, boot step 5) reads each org root's
// packs/index.json once, with the strict reader legacy-files.mjs holds, and
// hashes it: the same "read once, never again" rule as users.json.
const LEGACY_FILES_IMPORTERS = [
  /^server\/boot\.mjs$/, /^server\/tenancy\.mjs$/, /^server\/store\/(?:import|ops|cli|pack-import)\.mjs$/,
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

// The request properties the docs name (`req.observogram<Name>`, outside the
// CHANGELOG's history and docs/archive) are ones the server stamps: slice 5
// replaced req.observogramActor / req.observogramSub with req.observogramPrincipal
// and a plan's status-quo row kept naming the old seam.
const REQ_PROP = /\breq\.(observogram[A-Z]\w*)\b/g;
function markdownFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'archive') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) markdownFiles(p, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(relative(ROOT, p).split(sep).join('/'));
  }
  return out;
}

test('every req.observogram<Name> the docs name is a property the server stamps', () => {
  const stamped = new Set();
  for (const f of sourceFiles().filter((f) => f.startsWith('server/'))) {
    for (const m of withoutComments(readFileSync(join(ROOT, f), 'utf8')).matchAll(/\breq\.(observogram[A-Z]\w*)\s*=[^=]/g)) stamped.add(m[1]);
  }
  assert.ok(stamped.has('observogramPrincipal'), 'the server stamps req.observogramPrincipal');
  const docs = ['README.md', ...markdownFiles(join(ROOT, 'docs'))].filter((f) => f !== 'docs/CHANGELOG.md');
  const stale = [];
  for (const f of docs) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(REQ_PROP)) {
      if (!stamped.has(m[1])) stale.push(`${f}: req.${m[1]}`);
    }
  }
  assert.deepEqual(stale, [], `docs name request properties the server no longer stamps: ${stale.join(', ')}`);
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

// ---------- 4b. new SQL lives in repositories only (slice 4) ----------

// A string literal that opens an SQL statement. The modules that compose
// repository calls — the registry over files and rows, the pack → service
// rule, boot step 5, the file-first routes' after-the-file audit row
// (slice 5) — hold none of their own.
const SQL_LITERAL = /['"`]\s*(?:SELECT\s|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|WITH\s+\w+\s+AS\b)/i;
const SQL_FREE = ['server/pack-registry.mjs', 'server/service-admin.mjs', 'server/store/pack-links.mjs', 'server/store/pack-import.mjs', 'server/audit-after.mjs', 'server/audit-admin.mjs'];

test('the SQL-literal matcher flags what it must and passes what it must', () => {
  for (const bad of ["prepare(db, 'SELECT * FROM packs')", 'prepare(db, `\n  UPDATE packs SET x = 1`)', 'x("delete from a")']) assert.ok(SQL_LITERAL.test(bad), bad);
  for (const good of ["removePack(db, actor, id, { action: 'pack.remove' })", "'DELETE /api/uploads'", "const selected = 'yes'", "'update the label'"]) assert.ok(!SQL_LITERAL.test(good), good);
});

test('server/pack-registry.mjs, service-admin.mjs, pack-links.mjs, pack-import.mjs, audit-after.mjs and audit-admin.mjs hold no SQL of their own (the repositories do)', () => {
  for (const f of SQL_FREE) {
    const code = withoutComments(readFileSync(join(ROOT, f), 'utf8'));
    assert.ok(!SQL_LITERAL.test(code), `${f}: new SQL lives in server/store/{packs,pack-services,services,environments,mcp-endpoints,audit}.mjs`);
  }
});

// ---------- 5. the route table ----------

const NAMES_ROUTE_TABLE = /route-table\.mjs['"`]/;
const ANY_IMPORT = /(?:^|[\s;])(?:import\b\s*(?:[\w{*]|['"`]|\()|export\s*(?:\*|\{[^}]*\})\s*from\b)/m;
const ROUTE_TABLE_IMPORTERS = [/^server\/authz\.mjs$/, /^server\/fixtures\/route-inventory\.mjs$/, /^server\/test-[^/]*\.mjs$/];

test('the route-table matchers flag what they must and pass what they must', () => {
  for (const bad of ["import { ROUTES } from './route-table.mjs';", "const t = await import('../route-table.mjs');"]) {
    assert.ok(NAMES_ROUTE_TABLE.test(withoutComments(bad)), bad);
  }
  assert.ok(!NAMES_ROUTE_TABLE.test(withoutComments('// server/route-table.mjs classifies it')), 'a comment is not an import');
  for (const bad of ["import { a } from './x.mjs';", "import './x.mjs';", "const m = await import('node:fs');", "export { b } from './y.mjs';", "export * from './z.mjs';"]) {
    assert.ok(ANY_IMPORT.test(bad), bad);
  }
  for (const good of ["export const ROUTES = Object.freeze({ 'GET /api/packs': { class: 'viewer' } });", "// import nothing", "const important = 1;"]) {
    assert.ok(!ANY_IMPORT.test(withoutComments(good)), good);
  }
});

test('server/route-table.mjs imports nothing, and only authz, the inventory fixture and the suites import it', () => {
  assert.ok(!ANY_IMPORT.test(withoutComments(readFileSync(join(ROOT, 'server', 'route-table.mjs'), 'utf8'))), 'the route table is pure data');
  const files = sourceFiles().filter((f) => f !== 'server/route-table.mjs' && f !== SELF);
  const importers = files.filter((f) => NAMES_ROUTE_TABLE.test(withoutComments(readFileSync(join(ROOT, f), 'utf8'))));
  assert.ok(importers.includes('server/authz.mjs'), `found the importers (${importers.join(', ')})`);
  const offenders = importers.filter((f) => !ROUTE_TABLE_IMPORTERS.some((re) => re.test(f)));
  assert.deepEqual(offenders, [], 'the table is read through server/authz.mjs');
});
