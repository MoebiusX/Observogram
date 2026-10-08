#!/usr/bin/env node
/**
 * server/test-hermetic-suites.mjs — the in-process suites never read the
 * developer's shell (docs/STORE_PLAN.md §0).
 *
 * Every server is a child in most suites (server/fixtures/serve-child.mjs
 * gives it an explicit env: this process's minus STRIP). The suites that
 * import server code INTO THIS PROCESS — start() in-process, bootContext(),
 * or a module that reads the environment at import (server/index.mjs runs
 * initAuth() at import, which asserts the reverse-proxy mode's contract;
 * start() loads the taxonomy, the brand and the MCP transport hook) — must
 * delete the same list first. Hand-kept lists drifted (they omitted
 * TAXONOMY and TRANSPORT_HOOK), and a static import is hoisted above any
 * strip loop written below it, so a shell with OBSERVOGRAM_TAXONOMY,
 * OBSERVOGRAM_TRANSPORT_HOOK or OBSERVOGRAM_TRUST_PROXY_AUTH exported
 * failed seven suites. This guard pins the shape: for every server/test-*.mjs
 * that imports a server module (anything under ./ except ./fixtures/),
 *
 *   1. STRIP comes from ./fixtures/serve-child.mjs (never a hand list);
 *   2. the loop deletes both spellings of every name;
 *   3. no server module is imported statically (hoisted above the loop);
 *   4. every dynamic import of a server module is after the loop;
 *   5. no process.env.OBSERVOGRAM_* / TOMOGRAPH_* write precedes the loop
 *      (the suite's own posture is set after the shell is cleared, never
 *      wiped by it).
 *
 * The scan runs over tools/gen-vendor-manifest.mjs's tokenizer output —
 * comments and string bodies blanked — so a specifier quoted in a comment
 * or an assertion text (server/test-store-guards.mjs tests its own guards
 * on such literals) is not an import. The negative cases prove each rule
 * bites on a synthetic source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from '../tools/gen-vendor-manifest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = basename(fileURLToPath(import.meta.url));
export const SERVE_CHILD = './fixtures/serve-child.mjs';

const isServerModule = (spec) => spec.startsWith('./') && !spec.startsWith('./fixtures/');

/** The import specifiers of a source: [{ spec, index, kind: 'static' | 'dynamic' }], from the tokenizer's string table. */
export function importsOf(src) {
  const { code, strings } = tokenize(src);
  const out = [];
  for (const str of strings) {
    const before = code.slice(0, str.start).trimEnd();
    if (/\bimport\s*\($/.test(before)) out.push({ spec: str.value, index: str.start, kind: 'dynamic' });
    else if (/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom$/.test(before) || /(?:^|\n)\s*import$/.test(before)) {
      out.push({ spec: str.value, index: str.start, kind: 'static' });
    }
  }
  return out;
}

const LOOP_RE = /for \(const k of STRIP\) \{\s*delete process\.env\[`OBSERVOGRAM_\$\{k\}`\];\s*delete process\.env\[`TOMOGRAPH_\$\{k\}`\];\s*\}/;
// Matched over the blanked code (a comment never counts); the specifier is read back from the source at the quotes.
const STRIP_BINDING_RE = /\{[^}]*\bSTRIP\b[^}]*\}\s*=\s*await import\(\s*'[^']*'\s*\)|import\s*\{[^}]*\bSTRIP\b[^}]*\}\s*from\s*'[^']*'/g;
export function stripComesFromServeChild(src, code = tokenize(src).code) {
  for (const m of code.matchAll(STRIP_BINDING_RE)) {
    const q1 = m.index + m[0].indexOf('\'');
    const q2 = m.index + m[0].lastIndexOf('\'');
    if (src.slice(q1 + 1, q2) === SERVE_CHILD) return true;
  }
  return false;
}
const ENV_WRITE_RE = /(?:delete\s+process\.env\.(?:OBSERVOGRAM|TOMOGRAPH)_\w+)|(?:process\.env\.(?:OBSERVOGRAM|TOMOGRAPH)_\w+\s*=[^=])|(?:process\.env\[\s*`(?:OBSERVOGRAM|TOMOGRAPH)_)/;

/** The hermeticity problems of one suite's source, [] when it is sound or imports no server code. */
export function hermeticityProblems(src) {
  const imports = importsOf(src);
  const server = imports.filter((i) => isServerModule(i.spec));
  if (server.length === 0) return [];
  const problems = [];
  const { code } = tokenize(src);
  if (!stripComesFromServeChild(src, code)) problems.push(`STRIP is not imported from ${SERVE_CHILD} (a hand list drifts)`);
  const loop = LOOP_RE.exec(src);
  if (!loop) {
    problems.push('no `for (const k of STRIP)` loop deleting both OBSERVOGRAM_${k} and TOMOGRAPH_${k}');
    return problems;
  }
  for (const i of server) {
    if (i.kind === 'static') problems.push(`static import of ${i.spec} is hoisted above the strip loop — import it dynamically after the loop`);
    else if (i.index < loop.index) problems.push(`dynamic import of ${i.spec} runs before the strip loop`);
  }
  const prefix = code.slice(0, loop.index);
  const write = ENV_WRITE_RE.exec(prefix);
  if (write) problems.push(`an environment write precedes the strip loop (it would be wiped or leak): ${write[0].trim()}`);
  return problems;
}

const suites = readdirSync(HERE).filter((f) => /^test-.*\.mjs$/.test(f) && f !== SELF).sort();

test('every server suite that imports server code strips the children\'s STRIP list first, both spellings, before any such import', () => {
  const inProcess = [];
  const report = [];
  for (const f of suites) {
    const src = readFileSync(join(HERE, f), 'utf8');
    if (importsOf(src).some((i) => isServerModule(i.spec))) inProcess.push(f);
    for (const p of hermeticityProblems(src)) report.push(`${f}: ${p}`);
  }
  assert.deepEqual(report, [], report.join('\n'));
  // The seven suites the shell reached, and the ones that import server code beside them, are all scanned.
  for (const f of ['test-auth-local.mjs', 'test-auth-oidc.mjs', 'test-smoke.mjs', 'test-store-import.mjs', 'test-store-ops.mjs', 'test-store.mjs', 'test-tenancy.mjs', 'test-workspace.mjs', 'test-deploy-helpers.mjs']) {
    assert.ok(inProcess.includes(f), `${f} is recognised as an in-process suite`);
  }
});

test('the children\'s STRIP list carries every variable the series added, both spellings deleted by the loop', async () => {
  const { STRIP, childEnv } = await import(SERVE_CHILD);
  for (const k of ['TAXONOMY', 'TRANSPORT_HOOK', 'TRUST_PROXY_AUTH', 'BRAND_FILE', 'BRAND_NAME']) assert.ok(STRIP.includes(k), `STRIP names ${k}`);
  const env = childEnv(null);
  for (const k of STRIP) {
    assert.equal(env[`OBSERVOGRAM_${k}`], undefined);
    assert.equal(env[`TOMOGRAPH_${k}`], undefined);
  }
});

test('a child never sees the fetcher knobs a boot imports, nor an inherited per-org variable; a suite passes its own through extra', async () => {
  const { STRIP, childEnv, ORG_PREFIX, dropInheritedOrgVars } = await import(SERVE_CHILD);
  for (const k of ['ALLOW_LOCAL_MCP', 'MCP_TIMEOUT_MS', 'GRAFANA_DASHBOARD_LIMIT', 'GRAFANA_PANEL_LIMIT', 'GRAFANA_INCLUDE_JSON', 'DEBUG']) assert.ok(STRIP.includes(k), `STRIP names ${k}`);
  assert.equal(ORG_PREFIX, 'OBSERVOGRAM_ORG_');
  // Windows reads an environment name in any case, so a lower- or mixed-case name a shell exported is the
  // upper-case variable to a child there: both kinds are planted.
  const planted = {
    OBSERVOGRAM_ORG_ACME_MCP_TOKEN: 'from-the-shell', OBSERVOGRAM_ORG_DEFAULT_X: 'y', OBSERVOGRAM_MCP_TIMEOUT_MS: '1', TOMOGRAPH_DEBUG: '1',
    observogram_org_beta_mcp_token: 'lower-case', Observogram_Auth: 'off',
  };
  const saved = Object.fromEntries(Object.keys(planted).map((k) => [k, process.env[k]]));
  Object.assign(process.env, planted);
  const upper = (env) => Object.keys(env).map((k) => k.toUpperCase());
  try {
    const env = childEnv(null);
    assert.deepEqual(upper(env).filter((k) => k.startsWith(ORG_PREFIX)), [], 'every inherited OBSERVOGRAM_ORG_* is deleted, whatever its case');
    assert.equal(env.OBSERVOGRAM_MCP_TIMEOUT_MS, undefined);
    assert.equal(env.TOMOGRAPH_DEBUG, undefined);
    assert.equal(upper(env).includes('OBSERVOGRAM_AUTH'), false, 'a STRIP name is deleted whatever its case');
    const own = childEnv(null, { OBSERVOGRAM_ORG_ACME_MCP_TOKEN: 'the-suite-s-own' });
    assert.deepEqual(upper(own).filter((k) => k.startsWith(ORG_PREFIX)), ['OBSERVOGRAM_ORG_ACME_MCP_TOKEN']);
    assert.equal(own.OBSERVOGRAM_ORG_ACME_MCP_TOKEN, 'the-suite-s-own', 'extra is applied after the strip');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // The suites' half, over an environment of their own: a per-org name in any case goes, nothing else does.
  const suiteEnv = { observogram_org_beta_mcp_token: 'a', OBSERVOGRAM_ORG_ACME_MCP_TOKEN: 'b', Observogram_Org_X: 'c', OBSERVOGRAM_WORKSPACE: 'w', PATH: 'p' };
  dropInheritedOrgVars(suiteEnv);
  assert.deepEqual(suiteEnv, { OBSERVOGRAM_WORKSPACE: 'w', PATH: 'p' });
  // No suite drops them with a loop of its own: a hand loop compares the name's spelling.
  const HAND_LOOP_RE = /for \(const k of Object\.keys\(process\.env\)\)[^\n]*delete process\.env\[k\]/;
  const hand = suites.filter((f) => HAND_LOOP_RE.test(readFileSync(join(HERE, f), 'utf8')));
  assert.deepEqual(hand, [], `a suite drops the inherited per-org variables with dropInheritedOrgVars() from ${SERVE_CHILD}, never a loop of its own: ${hand.join(', ')}`);
});

const GOOD = `import { readFileSync } from 'node:fs';
// a comment naming import { x } from './index.mjs' is not an import
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[\`OBSERVOGRAM_\${k}\`];
  delete process.env[\`TOMOGRAPH_\${k}\`];
}
process.env.OBSERVOGRAM_WORKSPACE = '/tmp/x';
const literal = "import { a } from './store/db.mjs';";
const { start } = await import('./index.mjs');
`;

test('the guard: a sound suite has no problems; a suite importing no server code is out of scope', () => {
  assert.deepEqual(hermeticityProblems(GOOD), []);
  assert.deepEqual(importsOf(GOOD).map((i) => [i.spec, i.kind]), [['node:fs', 'static'], ['./fixtures/serve-child.mjs', 'dynamic'], ['./index.mjs', 'dynamic']]);
  assert.deepEqual(hermeticityProblems("import { boot } from './fixtures/serve-child.mjs';\nimport { x } from '../tools/lib/harness.mjs';\n"), []);
});

test('the guard bites: a hand list, a hoisted static import, an import before the loop, one spelling, an env write before the loop', () => {
  const handList = GOOD.replace("const { STRIP } = await import('./fixtures/serve-child.mjs');", "// const { STRIP } = await import('./fixtures/serve-child.mjs');\nconst STRIP = ['DB', 'TRUST_PROXY_AUTH'];");
  assert.match(hermeticityProblems(handList).join('\n'), /STRIP is not imported from \.\/fixtures\/serve-child\.mjs/);
  const elsewhere = GOOD.replace("await import('./fixtures/serve-child.mjs')", "await import('./fixtures/other.mjs')");
  assert.match(hermeticityProblems(elsewhere).join('\n'), /STRIP is not imported from \.\/fixtures\/serve-child\.mjs/);

  const hoisted = GOOD.replace("const { start } = await import('./index.mjs');", "import { start } from './index.mjs';");
  assert.match(hermeticityProblems(hoisted).join('\n'), /static import of \.\/index\.mjs is hoisted above the strip loop/);

  const early = `const { start } = await import('./index.mjs');\n${GOOD}`;
  assert.match(hermeticityProblems(early).join('\n'), /dynamic import of \.\/index\.mjs runs before the strip loop/);

  const oneSpelling = GOOD.replace('  delete process.env[`TOMOGRAPH_${k}`];\n', '');
  assert.match(hermeticityProblems(oneSpelling).join('\n'), /no `for \(const k of STRIP\)` loop deleting both/);

  const noLoop = GOOD.replace(LOOP_RE, '');
  assert.match(hermeticityProblems(noLoop).join('\n'), /no `for \(const k of STRIP\)` loop/);

  const writeFirst = `process.env.OBSERVOGRAM_AUTH = 'off';\n${GOOD}`;
  assert.match(hermeticityProblems(writeFirst).join('\n'), /an environment write precedes the strip loop.*OBSERVOGRAM_AUTH/);
  const deleteFirst = `delete process.env.TOMOGRAPH_AUTH;\n${GOOD}`;
  assert.match(hermeticityProblems(deleteFirst).join('\n'), /an environment write precedes the strip loop.*TOMOGRAPH_AUTH/);

  // A write mentioned in a comment before the loop is not a write; a comparison is not a write.
  const commented = `// process.env.OBSERVOGRAM_AUTH = 'off' is set below\nconst same = process.env.OBSERVOGRAM_AUTH === 'off';\n${GOOD}`;
  assert.deepEqual(hermeticityProblems(commented), []);
});
