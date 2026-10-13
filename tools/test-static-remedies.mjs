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
// so a new deploy entry point fails here until it is classified.
//
// Run: node --test tools/test-static-remedies.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from './gen-vendor-manifest.mjs';
import { DEFAULT_BRAND } from './lib/brand.mjs';
import { serverNeeded, DEPLOY_CONTROLS } from '../studio/static-remedies.mjs';
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
    assert.match(src, /^import \{ serverNeeded, DEPLOY_CONTROLS \} from '\.\/static-remedies\.mjs';$/m, `${view} takes the sentence and the selector from the model`);
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
