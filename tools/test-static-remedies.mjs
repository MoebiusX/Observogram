#!/usr/bin/env node
// tools/test-static-remedies.mjs — the static posture's texts and controls
// (studio/static-remedies.mjs; follow-up compare-in-bundle, design A.8).
//
// A static bundle has no server behind the page, so nothing in it can deploy.
// S1 holds the model's sentence to the shim's 501 text, character for
// character (no live studio module may import the shim, so the sentence is
// written twice). S2 holds every deploy entry point outside prototype space to
// its control: the non-prototype openDeployModal( calls are exactly the seven
// classified below, each control is matched by DEPLOY_CONTROLS through the id,
// class or data-* attribute its source writes, the view that draws it marks
// it unavailable after it renders under an isStatic() test, and
// openDeployModal itself explains instead of opening in the static posture —
// so a new deploy entry point fails here until it is classified. S3 holds
// each static text to its exact words (the product named where a server is,
// no server action told to the reader as something to do in the bundle), and
// the texts both postures now share (the taxonomy and the stale-pair reasons
// Pair by gives, the bind error) to theirs. S4 is the phrase ledger: every
// line of a studio module that names a server action (re-scan, Connect MCP,
// redraft, deploy what is missing, …) is listed below with its disposition —
// the row of the design's table that gives it a static-posture text, why a
// bundle reader cannot reach it, a control, a comment, what it describes, or
// pre-existing (W6) for a remedy a bundle reader could reach before Compare
// answered — so a new such phrase fails npm test until it is given a static
// text or recorded. S5 is the wiring: each static text is shown by the view
// its row names, and every staticRemedy call in the studio sits behind an
// isStatic() test — deleting a view's static branch fails here.
//
// Run: node --test tools/test-static-remedies.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from './gen-vendor-manifest.mjs';
import { DEFAULT_BRAND } from './lib/brand.mjs';
import { serverNeeded, DEPLOY_CONTROLS, staticRemedy, STATIC_REMEDY_KEYS } from '../studio/static-remedies.mjs';
import { FEATURES, denialText } from '../studio/static-backend.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, ...p.split('/')), 'utf8');

// Every deploy entry point outside prototype space: the module whose openDeployModal( call serves the control, and the
// view that draws the control (the response path's buttons are drawn into Remediate, which marks them).
const ENTRY_POINTS = [
  { file: 'studio/compare-view.mjs', control: '#drift-deploy-missing', drawnBy: 'studio/compare-view.mjs' },
  { file: 'studio/compare-view.mjs', control: '.diag-chain-deploy', drawnBy: 'studio/compare-view.mjs' },
  { file: 'studio/compare-view.mjs', control: '[data-action="deploy"]', drawnBy: 'studio/compare-view.mjs' },
  { file: 'studio/compile-view.mjs', control: '[data-ux-action="rm-deploy"]', drawnBy: 'studio/compile-view.mjs' },
  { file: 'studio/compile-view.mjs', control: '[data-ux-action="rm-deploy-all"]', drawnBy: 'studio/compile-view.mjs' },
  { file: 'studio/compile-view.mjs', control: '#deploy-compiled', drawnBy: 'studio/compile-view.mjs' },
  { file: 'studio/remediation-flow-view.mjs', control: '.rflow-deploy', drawnBy: 'studio/compile-view.mjs' },
];
// How a call site's source names the control it serves, nearest first within the lines above the call.
const SPELLINGS = [
  ['#drift-deploy-missing', /#drift-deploy-missing\b/],
  ['.diag-chain-deploy', /\.diag-chain-deploy\b/],
  ['[data-action="deploy"]', /\[data-action="deploy"\]/],
  ['[data-ux-action="rm-deploy"]', /\['rm-deploy'\]/],
  ['[data-ux-action="rm-deploy-all"]', /\['rm-deploy-all'\]/],
  ['.rflow-deploy', /'rflow-deploy'/],
  ['#deploy-compiled', /#deploy-compiled\b/],
];
// The exported render function of each drawing view: its last statement draws the deploy controls unavailable.
const RENDERERS = { 'studio/compare-view.mjs': 'renderBenchmarkView', 'studio/compile-view.mjs': 'renderCompileView' };

/** The body of `function <name>(…) {…}` in src, by brace depth over the tokenized code. */
function functionBody(src, name) {
  const { code } = tokenize(src);
  const head = new RegExp(`\\bfunction ${name}\\s*\\(`).exec(code);
  if (!head) return null;
  let i = code.indexOf('{', code.indexOf(')', head.index));
  // Skip a destructured parameter list: the body opens after the parameter list's closing paren.
  let depth = 0;
  for (let k = head.index + head[0].length - 1; k < code.length; k++) {
    if (code[k] === '(') depth++;
    else if (code[k] === ')' && --depth === 0) { i = code.indexOf('{', k); break; }
  }
  depth = 0;
  for (let k = i; k < code.length; k++) {
    if (code[k] === '{') depth++;
    else if (code[k] === '}' && --depth === 0) return src.slice(i + 1, k);
  }
  return null;
}

test('S1 — serverNeeded is the shim\'s 501 sentence for every feature it names, unbranded and branded; the model imports nothing', () => {
  const names = [...new Set([...FEATURES.map(([, name]) => name), 'Deploy', 'This action'])];
  assert.ok(names.length >= 15, `the shim's features were read (${names.length})`);
  for (const product of [DEFAULT_BRAND.name, 'Acme Watch']) {
    for (const feature of names) assert.equal(serverNeeded(feature, product), denialText(feature, product), `${feature} / ${product}`);
  }
  assert.equal(serverNeeded('Deploy', 'Acme Watch'), 'Deploy needs the Acme Watch server; this studio is a static bundle built without one.');
  const src = read('studio/static-remedies.mjs');
  assert.ok(!/^\s*import\s/m.test(src) && !/\bimport\s*\(/.test(tokenize(src).code), 'zero imports: a pure view model');
  assert.ok(!/\b(state|document|window|fetch)\b/.test(tokenize(src).code), 'no state, no DOM, no network');
});

test('S2 — every deploy entry point outside prototype space is drawn unavailable in the static posture, and openDeployModal explains instead of opening', () => {
  // (1) The non-prototype openDeployModal( calls, each with the control it serves.
  const files = readdirSync(join(ROOT, 'studio')).filter((f) => f.endsWith('.mjs') && !f.startsWith('proto-') && f !== 'verdict-ui.mjs').sort();
  const found = [];
  const unclassified = [];
  for (const f of files) {
    const file = `studio/${f}`;
    const src = read(file);
    const lines = src.split('\n');
    const { code } = tokenize(src);
    for (const m of code.matchAll(/\bopenDeployModal\s*\(/g)) {
      if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue;   // the definition (studio/app.mjs)
      const line = code.slice(0, m.index).split('\n').length;
      let control = null;
      for (let l = line - 1; l >= Math.max(0, line - 13) && !control; l--) control = SPELLINGS.find(([, re]) => re.test(lines[l]))?.[0] ?? null;
      if (control) found.push({ file, control });
      else unclassified.push(`${file}:${line} calls openDeployModal — a new deploy entry point: draw its control unavailable in the static posture (DEPLOY_CONTROLS, studio/static-remedies.mjs) and classify it in tools/test-static-remedies.mjs`);
    }
  }
  assert.deepEqual(unclassified, []);
  assert.deepEqual(found, ENTRY_POINTS.map(({ file, control }) => ({ file, control })), 'the seven non-prototype deploy entry points, in file order');

  // (2) DEPLOY_CONTROLS is exactly those controls, and each matches the markup its source writes.
  assert.deepEqual(DEPLOY_CONTROLS.split(', ').sort(), ENTRY_POINTS.map((e) => e.control).sort(), 'DEPLOY_CONTROLS names each entry point\'s control, and nothing else');
  const uxKit = read('studio/ux-kit.mjs');
  for (const { file, control } of ENTRY_POINTS) {
    const src = read(file);
    let m;
    if ((m = /^#([\w-]+)$/.exec(control))) assert.match(src, new RegExp(`\\bid="${m[1]}"`), `${file} writes id="${m[1]}"`);
    else if ((m = /^\.([\w-]+)$/.exec(control))) assert.match(src, new RegExp(`\\bclass="[^"]*\\b${m[1]}\\b[^"]*"`), `${file} writes the class ${m[1]}`);
    else if ((m = /^\[data-action="([\w-]+)"\]$/.exec(control))) assert.match(src, new RegExp(`\\bdata-action="${m[1]}"`), `${file} writes data-action="${m[1]}"`);
    else if ((m = /^\[data-ux-action="([\w-]+)"\]$/.exec(control))) {
      // A decision header's action: the view names it, ux-kit's button writes it as data-ux-action.
      assert.match(src, new RegExp(`\\baction: '${m[1]}'[,\\s}]`), `${file} names the action ${m[1]}`);
      assert.match(uxKit, /data-ux-action="\$\{escapeHtml\(b\.action\)\}"/, 'decisionHeaderHtml writes a button\'s action as data-ux-action');
    } else assert.fail(`${control}: a selector form this test does not read`);
  }

  // (3) Each drawing view marks DEPLOY_CONTROLS unavailable under an isStatic() test, after its render.
  for (const view of [...new Set(ENTRY_POINTS.map((e) => e.drawnBy))]) {
    const src = read(view);
    assert.match(src, /^import \{ serverNeeded, DEPLOY_CONTROLS(?:, \w+)* \} from '\.\/static-remedies\.mjs';$/m, `${view} takes the sentence and the selector from the model`);
    assert.match(src, /^import \{ markUnavailable \} from '\.\/services-view\.mjs';$/m, `${view} draws with the honesty rule's atom`);
    assert.match(src, /^const isStatic = \(\) => state\.access\?\.posture === 'static';$/m, `${view}: isStatic() reads the posture`);
    const draw = functionBody(src, 'drawDeployUnavailable');
    assert.ok(draw, `${view} defines drawDeployUnavailable`);
    assert.match(draw, /^\s*if \(!isStatic\(\)[^)]*\) return;\s*const reason = serverNeeded\('Deploy', state\.brand\.chrome\.name\);\s*for \(const control of root\.querySelectorAll\(DEPLOY_CONTROLS\)\) markUnavailable\(control, reason\);\s*$/,
      `${view}: every DEPLOY_CONTROLS match under the root, behind isStatic(), marked with the shim's Deploy sentence`);
    const render = functionBody(src, RENDERERS[view]);
    assert.ok(render, `${view} defines ${RENDERERS[view]}`);
    assert.match(render, /\n\s*drawDeployUnavailable\((view|root)\);\s*$/, `${view}: ${RENDERERS[view]} draws the controls unavailable last, once the view has rendered`);
  }

  // (4) openDeployModal: in the static posture it explains the reason and returns before it touches the modal.
  const app = read('studio/app.mjs');
  assert.match(app, /^import \{ serverNeeded \} from '\.\/static-remedies\.mjs';$/m);
  const open = functionBody(app, 'openDeployModal');
  assert.ok(open, 'studio/app.mjs defines openDeployModal');
  const guard = "if (state.access?.posture === 'static') { explainUnavailable(serverNeeded('Deploy', state.brand.chrome.name)); return; }";
  const firstStatement = open.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))[0];
  assert.equal(firstStatement, guard, 'the static posture explains first');
  assert.ok(open.indexOf(guard) < open.indexOf("$('#deploy-modal')"), 'before the modal is looked up');
});

// A phrase that tells the reader to take a server action (design A.8, the phrase ledger's pattern).
const SERVER_ACTION = /\b(re-?scan|rescan|scan (?:live|a repo(?:sitory)?)|connect mcp|from (?:its |a live )?mcp|redraft|re-?upload|refresh(?:es|ing)? (?:the )?live|refresh live evidence|capture a live draft|live draft again|deploy what is missing|deploy the repository)\b/i;


// Each static text, exactly, for a product whose name takes "an" and one whose name takes "a".
const TEXTS = {
  'retrofeed-result': (server) => `commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance); whether the gap closed shows against a new live draft — on ${server}, or in a bundle whoever builds it rebuilds with that draft and the updated pack`,
  'drift-partial': (server) => `Before acting on this drift, get a complete live draft: drafting needs ${server}, and whoever builds this bundle builds the new draft in (--pack).`,
  'compare-one-pack': () => 'This bundle carries no other pack that loads, so there is nothing to compare this one with; whoever builds the bundle can add another with --pack (a live draft, or a curated repository pack).',
  'drift-free-fix': (server) => `Review the differences, then update the repository from live; deploying what is missing needs ${server}.`,
  'live-missing-fix': (server) => `Review them, then update the repository from live; deploying what is missing needs ${server}.`,
};

test('S3 — the static texts, exact for three products (the article by the name), naming the product where they name a server and no server action as the reader\'s to take here; the reasons both postures now share', () => {
  assert.deepEqual([...STATIC_REMEDY_KEYS], Object.keys(TEXTS), 'every key has its exact text here');
  for (const [product, server] of [[DEFAULT_BRAND.name, 'an Observogram server'], ['Acme Watch', 'an Acme Watch server'], ['Zed Console', 'a Zed Console server']]) {
    for (const key of STATIC_REMEDY_KEYS) {
      const text = staticRemedy(key, { product });
      assert.equal(text, TEXTS[key](server), `${key} / ${product}`);
      if (/\bserver\b/.test(text)) assert.ok(text.includes(server), `${key}: the server it names is the product's`);
      assert.doesNotMatch(text, SERVER_ACTION, `${key}: no server action the reader cannot take here`);
    }
  }
  assert.match('then re-scan to confirm the gap closed', SERVER_ACTION, 'the pattern finds what the live text says');
  assert.match('Redraft from MCP before acting on this drift.', SERVER_ACTION);
  assert.match('Review them, then deploy what is missing live or update the repository from live.', SERVER_ACTION);
  assert.throws(() => staticRemedy('nope', { product: 'P' }), { message: 'staticRemedy: no static text for "nope"' });

  // Both postures (row 10): Pair by's reasons and the bind error name what is true on a server and in a bundle alike —
  // the comparison may be the page's own, the override the builder's.
  const identity = read('studio/compare-identity.mjs');
  assert.ok(identity.includes("unavailable: `the artefact taxonomy the comparison used did not bind in this page: ${taxonomyError}`"));
  assert.ok(identity.includes("unavailable: 'the packs on screen are not the ones the comparison was computed for'"));
  assert.ok(!/did not bind as the server's|the ones the server compared/.test(identity), 'nothing names the server as the one that compared');
  const app = read('studio/app.mjs');
  assert.ok(app.includes("state.taxonomyBindError = 'the served taxonomy override does not compile here';"));
  assert.ok(!app.includes("the server\\'s override does not compile here"));
});

// The phrase ledger: every line of a studio module (prototype space — proto-*.mjs and verdict-ui.mjs — and the shim
// aside) that matches SERVER_ACTION, as [file, the line trimmed, disposition]. A disposition is `row <n>` (the design's
// A.8 table: a static-posture text replaces it, S5 holds the wiring), `unreachable: <why>` (no bundle reader gets
// there), `control: <why>` (a control that answers the 501 sentence on use), `comment`, `description: <why>` (it says
// what something is, not what to do), or `pre-existing (W6)` (a remedy a bundle reader could reach before Compare
// answered; the design's rows 1, 3, 5–8 and 13–18).
const LEDGER = [
  ["studio/app.mjs", "<span class=\"discover-journey-label\">Scan a repo</span>", "control: Discover's Scan a repo — answers the 501 sentence on use since W6; drawing it unavailable is bundle-discover-controls"],
  ["studio/app.mjs", "<span class=\"discover-load-label\">① Scan a repository</span>", "control: Discover's Scan a repository — answers the 501 sentence on use since W6 (bundle-discover-controls)"],
  ["studio/app.mjs", "<span class=\"discover-load-label\">② Generate live from MCP</span>", "control: Discover's Generate live from MCP — answers the 501 sentence on use since W6 (bundle-discover-controls)"],
  ["studio/app.mjs", "<strong>Discover</strong> to crawl a repo, generate from a live MCP server, or", "pre-existing (W6)"],
  ["studio/app.mjs", "//     (\"verified\") — so \"scan a repo, then scan the live deployment\"", "comment"],
  ["studio/app.mjs", "? `<p class=\"deploy-verify-note\">Still not visible after ${attempt} checks — rules may need an evaluation cycle. Re-open this modal later or refresh live from the MCP panel.</p>`", "unreachable: inside the deploy modal, which never opens in the static posture (openDeployModal explains instead)"],
  ["studio/app.mjs", "// \"New pack from a live MCP server\" (#draft-mcp-panel, rebadge batch 3, C1):", "comment"],
  ["studio/compare-view.mjs", "notice.textContent = 'Traceability needs Pack A registered on the server — re-upload or rescan it, then retry.';", "unreachable: Pack A has no id only after an upload, and a bundle has none (handleFile → /api/validate is a 501)"],
  ["studio/compare-view.mjs", "body: 'Re-upload or rescan the pack, then open Diagnose again.',", "unreachable: Pack A has no id only after an upload, and a bundle has none (handleFile → /api/validate is a 501)"],
  ["studio/compare-view.mjs", "${isStatic() ? escapeHtml(staticRemedy('drift-partial', { product: state.brand.chrome.name })) : 'Redraft from MCP before acting on this drift.'}${(liveEvidence.unsupported || []).length ? ` restricted MCP tier — not exposed: ${escapeHtml(liveEvidence.unsupported.join(', '))}` : ''}", "row 2"],
  ["studio/compare-view.mjs", "<span class=\"drift-retrofeed-note\">${isStatic() ? escapeHtml(staticRemedy('retrofeed-result', { product: state.brand.chrome.name })) : 'commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance), then re-scan to confirm the gap closed'}</span>", "row 11"],
  ["studio/compare-view.mjs", "err.textContent = 'Compare needs this pack registered on the server — re-upload or rescan it, then retry.';", "unreachable: Pack A has no id only after an upload, and a bundle has none (handleFile → /api/validate is a 501)"],
  ["studio/compare-view.mjs", "fix: 'Review the differences, then deploy what is missing live or update the repository from live.',", "row 12"],
  ["studio/compare-view.mjs", "fix: 'Refresh the live draft: scan live or fetch again from MCP.',", "pre-existing (W6)"],
  ["studio/compare-view.mjs", "b.fix = 'Connect MCP or scan live, then choose the live draft as the baseline (Pack B) to compare.';", "pre-existing (W6)"],
  ["studio/compare-view.mjs", "fix: 'Draft the live pack again from MCP once the endpoint is healthy, then re-check.',", "pre-existing (W6)"],
  ["studio/compare-view.mjs", "fix: remedy ? remedy('live-missing-fix') : 'Review them, then deploy what is missing live or update the repository from live.',", "row 12"],
  ["studio/compare-view.mjs", "const live = !d.hasLive ? { v: 'Not checked', note: 'connect MCP or scan live to verify', tone: 'warn' }", "pre-existing (W6)"],
  ["studio/compile-view.mjs", "note = 'Compare with a live pack to get a recommendation, or deploy the repository’s artefacts directly.';", "pre-existing (W6)"],
  ["studio/diagnostic-grade.mjs", "//   errors      — { family: last error message } from mcp.probeErrors.<family>.", "comment"],
  ["studio/diagnostic-grade.mjs", "driftDetail = 'declared-only - no live signal to verify against (connect MCP or scan live)';", "pre-existing (W6)"],
  ["studio/live-model.mjs", "if (live === 'scaffold') return 'Scaffold — drafted from MCP discovery; sections marked scaffold are not compared';", "description: how a pack was made (drafted from MCP discovery), true in a bundle too — no action"],
  ["studio/services-model.mjs", "return { text: `No pack for ${where} yet — scan its repository, draft from its MCP, upload one, or Build one (the DEFINE step is prefilled).`, build: true };", "unreachable: Discover opened from a service page, which needs /api/services (a 501 in a bundle)"],
  ["studio/trace-chain.mjs", "fix: 'Refresh the live draft (or declare the scrape configuration), then check again.',", "pre-existing (W6)"],
  ["studio/trace-chain.mjs", "case 'sli:unverified':       return l.scaffold ? at('Replace the placeholder SLI with the real one', true) : at(l.inLiveDraft ? 'Check the rules behind the SLI are healthy, then refresh live evidence' : 'Capture a live draft to confirm the SLI is measured', true);", "pre-existing (W6)"],
  ["studio/trace-chain.mjs", "case 'metric:unverified':    return at(l.noInventory ? `Capture a live draft to confirm ${firstMetric || 'the metric'}` : `Confirm ${firstMetric || 'the metric'} is emitted live`, true);", "pre-existing (W6)"],
  ["studio/trace-chain.mjs", "case 'scrape:missing':       return at('Capture scrape evidence: refresh the live draft');", "pre-existing (W6)"],
  ["studio/trace-chain.mjs", "case 'dashboard:unverified': return at('Deploy the dashboard, then refresh live evidence', true);", "pre-existing (W6)"],
  ["studio/trace-chain.mjs", "case 'alert:unverified':     return (l.broken || l.unhealthy) ? at('Repair the unhealthy alert rule') : at('Deploy the burn-rate alert, then refresh live evidence', true);", "pre-existing (W6)"],
];
const DISPOSITION = /^(?:row \d+|unreachable: .+|control: .+|description: .+|comment|pre-existing \(W6\))$/;
// The studio modules the ledger reads: every one but prototype space and the shim.
const ledgerFiles = () => readdirSync(join(ROOT, 'studio')).filter((f) => f.endsWith('.mjs') && !f.startsWith('proto-') && f !== 'verdict-ui.mjs' && f !== 'static-backend.mjs').sort().map((f) => `studio/${f}`);

test('S4 — the phrase ledger: every studio line that names a server action is listed with its disposition, and every listed line is still there', () => {
  const listed = new Map(LEDGER.map(([file, text, disposition]) => [`${file}\n${text}`, disposition]));
  assert.equal(listed.size, LEDGER.length, 'one entry per line text');
  const unlisted = [];
  const seen = new Set();
  for (const file of ledgerFiles()) {
    read(file).split('\n').forEach((line, i) => {
      const m = SERVER_ACTION.exec(line);
      if (!m) return;
      const key = `${file}\n${line.trim()}`;
      if (!listed.has(key)) unlisted.push(`${file}:${i + 1} names a server action ('${m[0]}') — give it a static-posture text in studio/static-remedies.mjs, or record in tools/test-static-remedies.mjs why a bundle reader cannot reach it`);
      seen.add(key);
    });
  }
  assert.deepEqual(unlisted, []);
  assert.deepEqual(LEDGER.filter(([file, text]) => !seen.has(`${file}\n${text}`)).map(([file, text]) => `${file}: "${text.slice(0, 80)}" is in the ledger but no longer in the source — drop it`), []);
  for (const [file, text, disposition] of LEDGER) {
    assert.match(disposition, DISPOSITION, `${file}: "${text.slice(0, 60)}"`);
    if (disposition === 'comment') assert.match(text, /^(?:\/\/|\*|\/\*)/, `${file}: "${text.slice(0, 60)}" is a comment`);
  }
  // Compare's rows land with Compare: the texts it newly reaches are rows, not deferrals.
  const rowOf = (file, needle) => LEDGER.filter(([f, t]) => f === file && t.includes(needle)).map(([, , d]) => d);
  assert.deepEqual(rowOf('studio/compare-view.mjs', 'Redraft from MCP before acting on this drift.'), ['row 2']);
  assert.deepEqual(rowOf('studio/compare-view.mjs', 'then re-scan to confirm the gap closed'), ['row 11']);
  assert.deepEqual(rowOf('studio/compare-view.mjs', 'deploy what is missing live'), ['row 12', 'row 12']);
});

// Which view shows each static text (the design's A.8 rows).
const WIRED_IN = {
  'retrofeed-result': 'studio/compare-view.mjs',
  'drift-partial': 'studio/compare-view.mjs',
  'compare-one-pack': 'studio/compare-view.mjs',
  'drift-free-fix': 'studio/compare-view.mjs',
  'live-missing-fix': 'studio/compare-view.mjs',
};
// The one way a pure function takes the static texts: an explicit `remedy` input, bound where the view asks isStatic().
const REMEDY_BINDING = 'remedy: isStatic() ? (key) => staticRemedy(key, { product: state.brand.chrome.name }) : null,';

test('S5 — the wiring: each static text is shown by the view its row names, behind an isStatic() test, the live text kept beside it; no staticRemedy call in the studio escapes that test', () => {
  assert.deepEqual(Object.keys(WIRED_IN), [...STATIC_REMEDY_KEYS], 'every key is wired somewhere');
  // Every staticRemedy call in a studio module: behind `isStatic() ?` on its line, or the one remedy binding.
  const stray = [];
  for (const file of ledgerFiles().filter((f) => f !== 'studio/static-remedies.mjs')) {
    const src = read(file);
    const { code } = tokenize(src);
    const lines = src.split('\n');
    for (const m of code.matchAll(/\bstaticRemedy\s*\(/g)) {
      const n = code.slice(0, m.index).split('\n').length;
      const line = lines[n - 1];
      const before = line.slice(0, line.indexOf('staticRemedy('));
      if (!/\bisStatic\(\) \?/.test(before)) stray.push(`${file}:${n}: staticRemedy outside an isStatic() test`);
    }
  }
  assert.deepEqual(stray, []);
  for (const [key, file] of Object.entries(WIRED_IN)) {
    const src = read(file);
    const direct = new RegExp(`isStatic\\(\\) \\? (?:escapeHtml\\()?staticRemedy\\('${key}', \\{ product: state\\.brand\\.chrome\\.name \\}\\)\\)? : '[^']+'`);
    const viaRemedy = new RegExp(`(?:remedy \\? remedy\\('${key}'\\) : '[^']+'|if \\(remedy\\) b\\.fix = remedy\\('${key}'\\);)`);
    if (direct.test(src)) continue;
    assert.match(src, viaRemedy, `${file} shows ${key} in the static posture, today's text otherwise`);
    assert.ok(src.includes(REMEDY_BINDING), `${file} binds remedy to the static texts under isStatic()`);
  }
  // The live texts beside the static ones, unchanged.
  const view = read('studio/compare-view.mjs');
  for (const live of [
    "'commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance), then re-scan to confirm the gap closed'",
    "'Redraft from MCP before acting on this drift.'",
    "'Load or scan another pack (for example a live draft, or a curated repository pack) from Discover, then come back to compare.'",
    "fix: 'Review the differences, then deploy what is missing live or update the repository from live.',",
    "'Review them, then deploy what is missing live or update the repository from live.'",
  ]) assert.ok(view.includes(live), `the live studio keeps ${live.slice(0, 60)}`);
  // The pure decision takes the texts as an input; criterionBlocker passes it through.
  assert.match(view, /export function buildAssessmentDecision\(\{[^}]*remedy = null \} = \{\}\)/);
  assert.ok(view.includes('const b = criterionBlocker(c, lost, { hasLive, haveB, digest, roles, pointsPerCheck, lensLabel, remedy });'));
});
