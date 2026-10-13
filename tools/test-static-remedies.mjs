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
// so a new deploy entry point fails here until it is classified (each is
// drawn without the title that says what it would open). S3 holds each
// static text to its exact words for every input (the product named where a
// server is, what is built in, no server action told to the reader as
// something to do in the bundle), Traceability's live-evidence texts to
// theirs, the shared modules' options to their defaults (the live studio's
// and the journey's words are unchanged), and the texts both postures now
// share (the taxonomy and the stale-pair reasons Pair by gives, the bind
// error) to theirs. S4 is the phrase ledger: every line of a studio module
// that names a server action (re-scan, Connect MCP, redraft, deploy what is
// missing, …) or describes the deploy review the static posture never opens
// (deploy review, after a review, …) is listed below with its disposition —
// the row of the design's table that gives it a static-posture text, why a
// bundle reader cannot reach it, a control, a comment, or what it describes —
// so a new such phrase fails npm test until it is given a static text or
// recorded. S5 is the wiring:
// each static text is shown by the view its row names, every staticRemedy
// call in the studio sits behind an isStatic() test, and every Traceability
// reading takes the static posture's live-evidence texts — deleting a view's
// static branch fails here.
//
// Run: node --test tools/test-static-remedies.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from './gen-vendor-manifest.mjs';
import { DEFAULT_BRAND } from './lib/brand.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { serverNeeded, DEPLOY_CONTROLS, staticRemedy, STATIC_REMEDY_KEYS, staticInputOf, staticTraceActions } from '../studio/static-remedies.mjs';
import { LIVE_ACTION_TEXT, readTraceability, traceIssue } from '../studio/trace-chain.mjs';
import { computeDiagnosticGrade } from '../studio/diagnostic-grade.mjs';
import { remediationFlowHtml } from '../studio/remediation-flow-view.mjs';
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
    assert.match(draw, /^\s*if \(!isStatic\(\)[^)]*\) return;\s*const reason = serverNeeded\('Deploy', state\.brand\.chrome\.name\);\s*for \(const control of root\.querySelectorAll\(DEPLOY_CONTROLS\)\) \{ markUnavailable\(control, reason\); control\.removeAttribute\('title'\); \}\s*$/,
      `${view}: every DEPLOY_CONTROLS match under the root, behind isStatic(), marked with the shim's Deploy sentence and without the title that says what it would open`);
    const render = functionBody(src, RENDERERS[view]);
    assert.ok(render, `${view} defines ${RENDERERS[view]}`);
    assert.match(render, /\n\s*drawDeployUnavailable\((view|root)\);\s*$/, `${view}: ${RENDERERS[view]} draws the controls unavailable last, once the view has rendered`);
  }

  // (4) openDeployModal: in the static posture it explains the reason and returns before it touches the modal.
  const app = read('studio/app.mjs');
  assert.match(app, /^import \{ serverNeeded(?:, \w+)* \} from '\.\/static-remedies\.mjs';$/m);
  const open = functionBody(app, 'openDeployModal');
  assert.ok(open, 'studio/app.mjs defines openDeployModal');
  const guard = "if (state.access?.posture === 'static') { explainUnavailable(serverNeeded('Deploy', state.brand.chrome.name)); return; }";
  const firstStatement = open.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))[0];
  assert.equal(firstStatement, guard, 'the static posture explains first');
  assert.ok(open.indexOf(guard) < open.indexOf("$('#deploy-modal')"), 'before the modal is looked up');
});

// A phrase that tells the reader to take a server action (design A.8, the phrase ledger's pattern), or describes the
// deploy review the static posture never opens (deploy review, review the destination, after a review, then deploy,
// confirmed separately — Remediate's deploy texts, rows 20–27).
const SERVER_ACTION = /\b(re-?scan|rescan|scan (?:live|a repo(?:sitory)?)|connect mcp|from (?:its |a live )?mcp|redraft|re-?upload|refresh(?:es|ing)? (?:the )?live|refresh live evidence|capture a live draft|live draft again|deploy what is missing|deploy the repository|deploy review|review (?:of |the )?destination|after a review|then deploy|confirmed separately)\b/i;


// Each static text, exactly, for a product whose name takes "an" and one whose name takes "a", for each input: whether
// a live pack other than Pack A is built in, whether any pack is.
const NOLIVE = (server) => `this bundle carries no live pack; whoever builds it can add one (a live draft made on ${server}, built in with --pack)`;
const NEWDRAFT = (server) => `a new live draft, made on ${server} and built into the bundle by whoever builds it (--pack)`;
const TRACE_LEDE = 'Traceability follows each objective to the metrics, rules, scrape jobs, dashboards and alerts that prove it.';
const TEXTS = {
  'retrofeed-result': (server) => `commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance); whether the gap closed shows against a new live draft — on ${server}, or in a bundle whoever builds it rebuilds with that draft and the updated pack`,
  'drift-partial': (server) => `Before acting on this drift, get a complete live draft: drafting needs ${server}, and whoever builds this bundle builds the new draft in (--pack).`,
  'compare-one-pack': () => 'This bundle carries no other pack that loads, so there is nothing to compare this one with; whoever builds the bundle can add another with --pack (a live draft, or a curated repository pack).',
  'drift-free-fix': (server) => `Review the differences, then update the repository from live; deploying what is missing needs ${server}.`,
  'live-missing-fix': (server) => `Review them, then update the repository from live; deploying what is missing needs ${server}.`,
  'trace-no-b': (server, { liveBuiltIn }) => (liveBuiltIn
    ? `${TRACE_LEDE} Declare an SLO, or pick a live pack as Pack B to compare the repository with live.`
    : `${TRACE_LEDE} Declare an SLO. To compare the repository with live, pick a live pack as Pack B: ${NOLIVE(server)}.`),
  'diagnose-banner': (server, { liveBuiltIn }) => `Nothing live backs this pack. “Drift-free” and “Fresh” need a live pack: ${liveBuiltIn ? 'choose the live pack built into this bundle as Pack B.' : `${NOLIVE(server)}.`}`,
  'fresh-fix': (server) => `The live pack in this bundle is as fresh as when it was drafted; a fresh look needs ${NEWDRAFT(server)}.`,
  'drift-free-no-live': (server, { liveBuiltIn }) => (liveBuiltIn
    ? 'Choose the live pack built into this bundle as the baseline (Pack B) to compare.'
    : `Nothing live is built into this bundle; whoever builds it can add a live draft made on ${server} (--pack), to choose as the baseline (Pack B).`),
  'live-evidence-fix': (server) => `A complete live pack needs ${NEWDRAFT(server)}, once the endpoint is healthy.`,
  'live-measure': (server, { liveBuiltIn }) => (liveBuiltIn ? 'compare with the live pack built in to verify' : 'no live pack is built in to verify against'),
  'no-live-hint': (server, { liveBuiltIn }) => (liveBuiltIn ? 'choose the live pack built into this bundle as Pack B' : 'no live pack is built into this bundle'),
  'flow-not-compared-diagnose': (server, { liveBuiltIn }) => `Not compared yet: every alert reads as declared. ${liveBuiltIn
    ? 'Pick the live pack built into this bundle as Pack B to see which alerts are live.'
    : `Seeing which alerts are live needs a live pack: ${NOLIVE(server)}.`}`,
  'flow-not-compared-remediate': (server) => `Not compared with live: every alert reads as declared; deploying needs ${server}.`,
  'remediate-no-b': (server, { liveBuiltIn }) => `${liveBuiltIn ? 'Compare with the live pack built into this bundle to get a recommendation' : `A recommendation needs a live pack: ${NOLIVE(server)}`}; deploying needs ${server}.`,
  'need-pack': (server, { packsBuiltIn }) => (packsBuiltIn
    ? 'Head to Discover and open one of the packs built into this bundle — then come back here.'
    : `This bundle carries no pack; whoever builds it can add one with --pack (a curated repository pack, or a live draft made on ${server}).`),
  'remediate-deploy-hint': (server) => `Deploying needs ${server}; nothing is written to live from this bundle.`,
  'remediate-next-deploy': (server) => `Deploy, on ${server}`,
  'remediate-next-both': (server) => `Generate patch; deploying needs ${server}`,
  'remediate-effect-live': (server) => `only from ${server}; nothing is written to live from this bundle`,
  'remediate-effect-both': (server) => `the patch is made here; the deploy needs ${server}`,
  'remediate-deploy-meaning': (server) => `Deploying the ticked rows needs ${server}`,
  'remediate-rows-hint': (server) => `Ticked rows can be deployed from ${server}; this bundle deploys nothing, so the boxes cannot be changed here. Rows without a box need a repository patch, a decision or a manual fix.`,
  'remediate-not-compared-summary': (server) => `not compared with live; deploying them needs ${server}`,
};
// Traceability's live-evidence texts in the static posture (rows 14, 15), exactly; metricConfirm takes the metric.
const TRACE_TEXTS = (server) => ({
  scrapeEvidenceFix: `Declare the scrape configuration, then check again; observing it live needs ${NEWDRAFT(server)}.`,
  sliRulesHealthy: 'Check the rules behind the SLI are healthy (a new live draft confirms it)',
  sliMeasured: `Confirm the SLI is measured with a live draft (made on ${server})`,
  metricConfirm: `Confirm http_requests_total with a live draft (made on ${server})`,
  scrapeEvidence: `Capture scrape evidence with a live draft (made on ${server})`,
  dashboardDeploy: `Deploy the dashboard on ${server}; a new live draft confirms it`,
  alertDeploy: `Deploy the burn-rate alert on ${server}; a new live draft confirms it`,
});
// The live studio's, unchanged (the journey and every server reader see these).
const LIVE_TRACE_TEXTS = {
  scrapeEvidenceFix: 'Refresh the live draft (or declare the scrape configuration), then check again.',
  sliRulesHealthy: 'Check the rules behind the SLI are healthy, then refresh live evidence',
  sliMeasured: 'Capture a live draft to confirm the SLI is measured',
  metricConfirm: 'Capture a live draft to confirm http_requests_total',
  scrapeEvidence: 'Capture scrape evidence: refresh the live draft',
  dashboardDeploy: 'Deploy the dashboard, then refresh live evidence',
  alertDeploy: 'Deploy the burn-rate alert, then refresh live evidence',
};
const textsOf = (actions) => Object.fromEntries(Object.entries(actions).map(([k, v]) => [k, typeof v === 'function' ? v('http_requests_total') : v]));
const packOf = (rel) => { const t = read(rel); return adapt(rel.endsWith('.json') ? JSON.parse(t) : parseYaml(t)); };

test('S3 — the static texts, exact for three products (the article by the name) and every input, naming the product where they name a server and no server action as the reader\'s to take here; Traceability\'s live-evidence texts; the shared modules\' options, defaults unchanged; the reasons both postures now share', () => {
  assert.deepEqual([...STATIC_REMEDY_KEYS], Object.keys(TEXTS), 'every key has its exact text here');
  const inputs = [{ liveBuiltIn: false, packsBuiltIn: false }, { liveBuiltIn: true, packsBuiltIn: true }, { liveBuiltIn: false, packsBuiltIn: true }];
  for (const [product, server] of [[DEFAULT_BRAND.name, 'an Observogram server'], ['Acme Watch', 'an Acme Watch server'], ['Zed Console', 'a Zed Console server']]) {
    for (const key of STATIC_REMEDY_KEYS) {
      for (const input of inputs) {
        const text = staticRemedy(key, { product, ...input });
        assert.equal(text, TEXTS[key](server, input), `${key} / ${product} / ${JSON.stringify(input)}`);
        if (/\bserver\b/.test(text)) assert.ok(text.includes(server), `${key}: the server it names is the product's`);
        assert.doesNotMatch(text, SERVER_ACTION, `${key}: no server action the reader cannot take here`);
      }
    }
    const trace = staticTraceActions(product);
    assert.deepEqual(Object.keys(trace), Object.keys(LIVE_ACTION_TEXT), 'staticTraceActions has LIVE_ACTION_TEXT\'s keys');
    for (const k of Object.keys(trace)) assert.equal(typeof trace[k], typeof LIVE_ACTION_TEXT[k], `${k}: the same kind (a text, or a function of the metric)`);
    assert.deepEqual(textsOf(trace), TRACE_TEXTS(server), `the static live-evidence texts / ${product}`);
    for (const [k, text] of Object.entries(textsOf(trace))) assert.doesNotMatch(text, SERVER_ACTION, `${k}: no server action the reader cannot take here`);
  }
  // Which input each text reads: liveBuiltIn for seven, packsBuiltIn for one, neither for the rest.
  const reads = (field) => STATIC_REMEDY_KEYS.filter((key) => staticRemedy(key, { product: 'P', [field]: true }) !== staticRemedy(key, { product: 'P' }));
  assert.deepEqual(reads('liveBuiltIn'), ['trace-no-b', 'diagnose-banner', 'drift-free-no-live', 'live-measure', 'no-live-hint', 'flow-not-compared-diagnose', 'remediate-no-b']);
  assert.deepEqual(reads('packsBuiltIn'), ['need-pack']);
  // Row 1 with a live pack built in is the view's own text: nothing in it names a server action.
  assert.ok(read('studio/compare-view.mjs').includes(`: '${TEXTS['trace-no-b']('', { liveBuiltIn: true })}',`), 'trace-no-b with a live pack built in is the live studio\'s words');
  assert.match('then re-scan to confirm the gap closed', SERVER_ACTION, 'the pattern finds what the live text says');
  assert.match('Redraft from MCP before acting on this drift.', SERVER_ACTION);
  assert.match('Review them, then deploy what is missing live or update the repository from live.', SERVER_ACTION);
  // Remediate's deploy texts, each a description of the deploy review the static posture never opens.
  for (const live of ['Opens the deploy review with every deployable artefact; nothing is written until you confirm there.', 'Opens a review of destination, environment and artefacts; nothing is written until you confirm there.',
    'Deploy, after a review', 'Generate patch, then deploy', 'only after you review the destination, environment and artefacts', 'the patch and the deploy are confirmed separately',
    'Ticked rows go to the deploy review; untick a row to leave it out.', 'not compared with live, so the deploy review lists every deployable artefact',
    'You review the destination, environment and artefacts before anything is written.']) assert.match(live, SERVER_ACTION, live);
  assert.throws(() => staticRemedy('nope', { product: 'P' }), { message: 'staticRemedy: no static text for "nope"' });

  // What is built in, read from the catalogue: a live pack other than Pack A, and any pack, that loads.
  const cat = [{ id: 'a', ok: true }, { id: 'live', ok: true, live: 'snapshot' }, { id: 'broken', ok: false, live: 'scaffold' }];
  assert.deepEqual(staticInputOf('P', cat, 'a'), { product: 'P', liveBuiltIn: true, packsBuiltIn: true });
  assert.deepEqual(staticInputOf('P', cat, 'live'), { product: 'P', liveBuiltIn: false, packsBuiltIn: true }, 'Pack A itself is not another live pack');
  assert.deepEqual(staticInputOf('P', [cat[0], cat[2]], 'a'), { product: 'P', liveBuiltIn: false, packsBuiltIn: true }, 'a live pack that did not load is not built in');
  assert.deepEqual(staticInputOf('P', [], null), { product: 'P', liveBuiltIn: false, packsBuiltIn: false });
  assert.deepEqual(staticInputOf('P', undefined, null), { product: 'P', liveBuiltIn: false, packsBuiltIn: false });

  // The shared modules take the static texts as options; their defaults are today's words, so the live studio, every
  // server reader and the journey (tools/lib/journey.mjs grades through computeDiagnosticGrade) are unchanged.
  assert.deepEqual(textsOf(LIVE_ACTION_TEXT), LIVE_TRACE_TEXTS, 'LIVE_ACTION_TEXT is the live studio\'s words');
  assert.ok(Object.isFrozen(LIVE_ACTION_TEXT));
  // Every text the Traceability reading words through `actions`, and nothing else moves: over the fixtures, a probe
  // set of markers gives the default model once each marker is read back as the live text.
  const probe = Object.fromEntries(Object.entries(LIVE_ACTION_TEXT).map(([k, v]) => [k, typeof v === 'function' ? (m) => `«${k}:${m}»` : `«${k}»`]));
  const seen = new Set();
  for (const rel of ['vendor/observability-pack-spec/v1.4/examples/payment-service.pack.yaml', 'examples/krystaline-repo-carlos.pack.yaml', 'tools/fixtures/golden/snapshot/snapshot.pack.json']) {
    const pack = packOf(rel);
    const live = JSON.stringify(readTraceability(pack));
    assert.equal(JSON.stringify(readTraceability(pack, { actions: LIVE_ACTION_TEXT })), live, `${rel}: the default is LIVE_ACTION_TEXT`);
    const probed = JSON.stringify(readTraceability(pack, { actions: probe }));
    for (const m of probed.matchAll(/«([A-Za-z]+)(?::([^»]*))?»/g)) seen.add(m[1]);
    const readBack = probed.replace(/«([A-Za-z]+)(?::([^»]*))?»/g, (_, k, metric) => JSON.stringify(metric === undefined ? LIVE_ACTION_TEXT[k] : LIVE_ACTION_TEXT[k](metric)).slice(1, -1));
    assert.equal(readBack, live, `${rel}: only the live-evidence texts move`);
    const statics = JSON.stringify(readTraceability(pack, { actions: staticTraceActions('Acme Watch') }));
    assert.doesNotMatch(statics, SERVER_ACTION, `${rel}: the static reading names no server action`);
  }
  assert.deepEqual([...seen].sort(), ['scrapeEvidence', 'scrapeEvidenceFix', 'sliMeasured'], 'the fixtures reach these through actions');
  // The rest are read the same way, by name — no live-evidence text is written anywhere in the module but its table.
  const traceSrc = read('studio/trace-chain.mjs');
  const traceCode = tokenize(traceSrc).code;
  for (const k of Object.keys(LIVE_ACTION_TEXT)) {
    assert.ok(k === 'scrapeEvidenceFix' ? /missing_scrape_evidence: 'scrapeEvidenceFix'/.test(traceSrc) : new RegExp(`\\bactions\\.${k}\\b`).test(traceCode), `trace-chain.mjs reads ${k} through actions`);
  }
  for (const text of Object.values(LIVE_TRACE_TEXTS).filter((t) => !t.includes('http_requests_total'))) assert.equal(traceSrc.split(text).length - 1, 1, `"${text}" is written once, in LIVE_ACTION_TEXT`);
  assert.equal(traceIssue('missing_scrape_evidence').fix, LIVE_TRACE_TEXTS.scrapeEvidenceFix);
  assert.equal(traceIssue('missing_scrape_evidence', { actions: staticTraceActions('Acme Watch') }).fix, TRACE_TEXTS('an Acme Watch server').scrapeEvidenceFix);
  assert.deepEqual(traceIssue('missing_sli', { actions: staticTraceActions('Acme Watch') }), traceIssue('missing_sli'), 'an issue whose fix is no live-evidence text is the same');
  // computeDiagnosticGrade's noLiveHint: the drift-free check's detail when nothing live backs the pack.
  const payment = packOf('vendor/observability-pack-spec/v1.4/examples/payment-service.pack.yaml');
  const driftDetail = (opts) => computeDiagnosticGrade(payment, null, null, null, null, opts).trust.criteria.find((c) => c.key === 'drift-free').detail;
  assert.equal(driftDetail(), 'declared-only - no live signal to verify against (connect MCP or scan live)', 'the default, today\'s');
  assert.equal(driftDetail({ noLiveHint: '' }), driftDetail(), 'an empty hint is the default');
  assert.equal(driftDetail({ noLiveHint: staticRemedy('no-live-hint', { product: 'P' }) }), 'declared-only - no live signal to verify against (no live pack is built into this bundle)');
  // remediationFlowHtml's notComparedNote: the caller's text, escaped, where the note before a comparison was; the
  // defaults are today's on both screens.
  const model = { configured: true, compared: false, otherSide: 'live', otherName: null, counts: { remediations: 1, linked: 0, unresolved: 0, blocked: 0, uncovered: 0, placeholder: 0 }, links: [], unresolved: [], uncovered: [], warnings: [] };
  assert.match(remediationFlowHtml(model, { screen: 'diagnose' }), /<p class="rflow-note">Not compared yet: every alert reads as declared\. Pick a baseline or a live pack to see which alerts are live\.<\/p>/);
  assert.match(remediationFlowHtml(model, { screen: 'remediate' }), /<p class="rflow-note">Not compared with live: every alert reads as declared, so nothing here can be deployed yet\.<\/p>/);
  assert.match(remediationFlowHtml(model, { screen: 'remediate', notComparedNote: 'Not <compared> & so on' }), /<p class="rflow-note">Not &lt;compared&gt; &amp; so on<\/p>/);
  assert.match(remediationFlowHtml({ ...model, compared: true, otherName: 'live-pack' }, { screen: 'remediate', notComparedNote: 'ignored' }), /<p class="rflow-note">Compared with live-pack: /, 'once compared, the comparison speaks');

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
// A.8 tables, and row 19 — Diagnose's and Remediate's prompt before a pack is chosen — which this build adds: a
// static-posture text replaces it, S5 holds the wiring), `unreachable: <why>` (no bundle reader gets there), `control:
// <why>` (a control that answers the 501 sentence on use), `comment`, or `description: <why>` (it says what something
// is, not what to do). No line is deferred: every remedy a bundle reader can reach in Compare, Diagnose, Traceability
// and Remediate has its static text. Rows 20–27 are Remediate's deploy texts, which describe the deploy review a
// deploy control opens on a server and which the static posture never opens.
const LEDGER = [
  ["studio/app.mjs", "<span class=\"discover-journey-label\">Scan a repo</span>", "control: Discover's Scan a repo — answers the 501 sentence on use since W6; drawing it unavailable is bundle-discover-controls"],
  ["studio/app.mjs", "<span class=\"discover-load-label\">① Scan a repository</span>", "control: Discover's Scan a repository — answers the 501 sentence on use since W6 (bundle-discover-controls)"],
  ["studio/app.mjs", "<span class=\"discover-load-label\">② Generate live from MCP</span>", "control: Discover's Generate live from MCP — answers the 501 sentence on use since W6 (bundle-discover-controls)"],
  ["studio/app.mjs", "<strong>Discover</strong> to crawl a repo, generate from a live MCP server, or", "row 19"],
  ["studio/app.mjs", "//     (\"verified\") — so \"scan a repo, then scan the live deployment\"", "comment"],
  ["studio/app.mjs", "? `<p class=\"deploy-verify-note\">Still not visible after ${attempt} checks — rules may need an evaluation cycle. Re-open this modal later or refresh live from the MCP panel.</p>`", "unreachable: inside the deploy modal, which never opens in the static posture (openDeployModal explains instead)"],
  ["studio/app.mjs", "// \"New pack from a live MCP server\" (#draft-mcp-panel, rebadge batch 3, C1):", "comment"],
  ["studio/app.mjs", "// The deploy review (compile-view.mjs readDeployReview) says which selected", "comment"],
  ["studio/compare-view.mjs", "notice.textContent = 'Traceability needs Pack A registered on the server — re-upload or rescan it, then retry.';", "unreachable: Pack A has no id only after an upload, and a bundle has none (handleFile → /api/validate is a 501)"],
  ["studio/compare-view.mjs", "body: 'Re-upload or rescan the pack, then open Diagnose again.',", "unreachable: Pack A has no id only after an upload, and a bundle has none (handleFile → /api/validate is a 501)"],
  ["studio/compare-view.mjs", "${isStatic() ? escapeHtml(staticRemedy('drift-partial', { product: state.brand.chrome.name })) : 'Redraft from MCP before acting on this drift.'}${(liveEvidence.unsupported || []).length ? ` restricted MCP tier — not exposed: ${escapeHtml(liveEvidence.unsupported.join(', '))}` : ''}", "row 2"],
  ["studio/compare-view.mjs", "<span class=\"drift-retrofeed-note\">${isStatic() ? escapeHtml(staticRemedy('retrofeed-result', { product: state.brand.chrome.name })) : 'commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance), then re-scan to confirm the gap closed'}</span>", "row 11"],
  ["studio/compare-view.mjs", "err.textContent = 'Compare needs this pack registered on the server — re-upload or rescan it, then retry.';", "unreachable: Pack A has no id only after an upload, and a bundle has none (handleFile → /api/validate is a 501)"],
  ["studio/compare-view.mjs", "fix: 'Review the differences, then deploy what is missing live or update the repository from live.',", "row 12"],
  ["studio/compare-view.mjs", "fix: 'Refresh the live draft: scan live or fetch again from MCP.',", "row 5"],
  ["studio/compare-view.mjs", "b.fix = remedy ? remedy('drift-free-no-live') : 'Connect MCP or scan live, then choose the live draft as the baseline (Pack B) to compare.';", "row 6"],
  ["studio/compare-view.mjs", "fix: remedy ? remedy('live-evidence-fix') : 'Draft the live pack again from MCP once the endpoint is healthy, then re-check.',", "row 7"],
  ["studio/compare-view.mjs", "fix: remedy ? remedy('live-missing-fix') : 'Review them, then deploy what is missing live or update the repository from live.',", "row 12"],
  ["studio/compare-view.mjs", "const live = !d.hasLive ? { v: 'Not checked', note: isStatic() ? staticRemedy('live-measure', staticInput()) : 'connect MCP or scan live to verify', tone: 'warn' }", "row 8"],
  ["studio/compile-view.mjs", "note = isStatic() ? staticRemedy('remediate-no-b', staticInput()) : 'Compare with a live pack to get a recommendation, or deploy the repository’s artefacts directly.';", "row 18"],
  ["studio/compile-view.mjs", "// and the deploy modal's pre-deploy review panel.", "comment"],
  ["studio/compile-view.mjs", "//           live     changes live systems (after the deploy review)", "comment"],
  ["studio/compile-view.mjs", "//           both     repository and live, each confirmed separately", "comment"],
  ["studio/compile-view.mjs", "{ id: 'deploy',    term: 'deploy',        next: 'Deploy, after a review',      effect: 'live',    needsB: false },", "row 21"],
  ["studio/compile-view.mjs", "{ id: 'all',       term: 'bidirectional', next: 'Generate patch, then deploy', effect: 'both',    needsB: true  },", "row 22"],
  ["studio/compile-view.mjs", "live:    { label: 'Changes live systems',   note: 'only after you review the destination, environment and artefacts' },", "row 23"],
  ["studio/compile-view.mjs", "both:    { label: 'Changes the repository and live systems', note: 'the patch and the deploy are confirmed separately' },", "row 24"],
  ["studio/compile-view.mjs", ": `Artefacts the repository declares that ${other} does not have. ${isStatic() ? staticRemedy('remediate-deploy-meaning', staticInput()) : 'Ticked rows go to the deploy review'}; the rest need a manual fix in the pack, instrumentation or platform.`;", "row 25"],
  ["studio/compile-view.mjs", "// No live pack to compare: the deploy review opens with every deployable", "comment"],
  ["studio/compile-view.mjs", "] : [isStatic() ? staticRemedy('remediate-not-compared-summary', staticInput()) : 'not compared with live, so the deploy review lists every deployable artefact'];", "row 27"],
  ["studio/compile-view.mjs", "${resolved.deployable ? `<p class=\"ux-rm-changes-hint\">${isStatic() ? escapeHtml(staticRemedy('remediate-rows-hint', staticInput())) : 'Ticked rows go to the deploy review; untick a row to leave it out. Rows without a box need a repository patch, a decision or a manual fix.'}</p>` : ''}", "row 26"],
  ["studio/compile-view.mjs", "<span class=\"remediate-action-hint\"><span class=\"ux-rm-effect is-live\">Changes live systems</span> ${isStatic() ? escapeHtml(staticRemedy('remediate-deploy-hint', staticInput())) : 'Opens the deploy review with every deployable artefact; nothing is written until you confirm there.'}</span>", "row 20"],
  ["studio/compile-view.mjs", ": (isStatic() ? escapeHtml(staticRemedy('remediate-deploy-hint', staticInput())) : 'Opens a review of destination, environment and artefacts; nothing is written until you confirm there.')}</span>", "row 20"],
  ["studio/compile-view.mjs", "// The deploy review preselects the artefact being compiled (the manifest", "comment"],
  ["studio/compile-view.mjs", "<p class=\"ux-rm-output-note\">Writes to ${escapeHtml(activeFlavor?.platform || 'the live platform')}${envLabel ? ` for <strong>${escapeHtml(envLabel)}</strong>` : ''} through your MCP gateway. You review the destination, environment and artefacts before anything is written.</p>", "unreachable: the compiler draws its Deploy to live only where the server's deploy matrix says the target deploys, and a bundle has none (GET /api/deploy/matrix is a 501)"],
  ["studio/compile-view.mjs", "// The deploy modal's pre-deploy review.", "comment"],
  ["studio/diagnostic-grade.mjs", "//   errors      — { family: last error message } from mcp.probeErrors.<family>.", "comment"],
  ["studio/diagnostic-grade.mjs", "const NO_LIVE_HINT = 'connect MCP or scan live';", "row 13"],
  ["studio/live-model.mjs", "if (live === 'scaffold') return 'Scaffold — drafted from MCP discovery; sections marked scaffold are not compared';", "description: how a pack was made (drafted from MCP discovery), true in a bundle too — no action"],
  ["studio/services-model.mjs", "return { text: `No pack for ${where} yet — scan its repository, draft from its MCP, upload one, or Build one (the DEFINE step is prefilled).`, build: true };", "unreachable: Discover opened from a service page, which needs /api/services (a 501 in a bundle)"],
  ["studio/trace-chain.mjs", "scrapeEvidenceFix: 'Refresh the live draft (or declare the scrape configuration), then check again.',", "row 14"],
  ["studio/trace-chain.mjs", "sliRulesHealthy: 'Check the rules behind the SLI are healthy, then refresh live evidence',", "row 15"],
  ["studio/trace-chain.mjs", "sliMeasured: 'Capture a live draft to confirm the SLI is measured',", "row 15"],
  ["studio/trace-chain.mjs", "metricConfirm: (metric) => `Capture a live draft to confirm ${metric}`,", "row 15"],
  ["studio/trace-chain.mjs", "scrapeEvidence: 'Capture scrape evidence: refresh the live draft',", "row 15"],
  ["studio/trace-chain.mjs", "dashboardDeploy: 'Deploy the dashboard, then refresh live evidence',", "row 15"],
  ["studio/trace-chain.mjs", "alertDeploy: 'Deploy the burn-rate alert, then refresh live evidence',", "row 15"],
  ["studio/verify-deploy.mjs", "// ---------- pre-deploy review ----------", "comment"],
  ["studio/verify-deploy.mjs", "// kept here beside the deploy review so tools/test-verify-deploy.mjs pins", "comment"],
  ["studio/verify-deploy.mjs", "return `${countWords(selected, ['selected artefact', 'selected artefacts'])} · ${countWords(rows, ['deploy row', 'deploy rows'])} — an artefact can compile to more than one row. Opens the deploy review; nothing changes until you confirm there.`;", "control: the title of Remediate's Review and deploy button, which the static posture draws unavailable and without its title (drawDeployUnavailable, S2)"],
];
const DISPOSITION = /^(?:row \d+|unreachable: .+|control: .+|description: .+|comment)$/;
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
  // The remedies a bundle reader could reach before Compare answered are rows too (the design's A.8.3; row 19 this
  // build's), each with its static text.
  assert.deepEqual(rowOf('studio/compare-view.mjs', 'scan live or fetch again from MCP'), ['row 5']);
  assert.deepEqual(rowOf('studio/compare-view.mjs', 'Connect MCP or scan live, then choose'), ['row 6']);
  assert.deepEqual(rowOf('studio/compare-view.mjs', 'Draft the live pack again from MCP'), ['row 7']);
  assert.deepEqual(rowOf('studio/compare-view.mjs', 'connect MCP or scan live to verify'), ['row 8']);
  assert.deepEqual(rowOf('studio/diagnostic-grade.mjs', 'connect MCP or scan live'), ['row 13']);
  assert.deepEqual(rowOf('studio/trace-chain.mjs', 'live'), ['row 14', 'row 15', 'row 15', 'row 15', 'row 15', 'row 15', 'row 15']);
  assert.deepEqual(rowOf('studio/compile-view.mjs', 'deploy the repository'), ['row 18']);
  assert.deepEqual(rowOf('studio/app.mjs', 'to crawl a repo, generate from a live MCP server'), ['row 19']);
  // Remediate's deploy texts: none describes the deploy review in the static posture.
  assert.deepEqual(rowOf('studio/compile-view.mjs', "staticRemedy('remediate-deploy-hint'"), ['row 20', 'row 20']);
  assert.deepEqual(rowOf('studio/compile-view.mjs', "next: '"), ['row 21', 'row 22']);
  assert.deepEqual(rowOf('studio/compile-view.mjs', "note: '"), ['row 23', 'row 24']);
  assert.deepEqual(rowOf('studio/compile-view.mjs', 'Ticked rows go to the deploy review'), ['row 25', 'row 26']);
  assert.deepEqual(rowOf('studio/compile-view.mjs', 'so the deploy review lists every deployable artefact'), ['row 27']);
});

// Which view shows each static text (the design's A.8 rows, and rows 19–27, which this build adds).
const WIRED_IN = {
  'retrofeed-result': 'studio/compare-view.mjs',
  'drift-partial': 'studio/compare-view.mjs',
  'compare-one-pack': 'studio/compare-view.mjs',
  'drift-free-fix': 'studio/compare-view.mjs',
  'live-missing-fix': 'studio/compare-view.mjs',
  'trace-no-b': 'studio/compare-view.mjs',
  'diagnose-banner': 'studio/compare-view.mjs',
  'fresh-fix': 'studio/compare-view.mjs',
  'drift-free-no-live': 'studio/compare-view.mjs',
  'live-evidence-fix': 'studio/compare-view.mjs',
  'live-measure': 'studio/compare-view.mjs',
  'no-live-hint': 'studio/compare-view.mjs',
  'flow-not-compared-diagnose': 'studio/compare-view.mjs',
  'flow-not-compared-remediate': 'studio/compile-view.mjs',
  'remediate-no-b': 'studio/compile-view.mjs',
  'need-pack': 'studio/app.mjs',
  'remediate-deploy-hint': 'studio/compile-view.mjs',
  'remediate-next-deploy': 'studio/compile-view.mjs',
  'remediate-next-both': 'studio/compile-view.mjs',
  'remediate-effect-live': 'studio/compile-view.mjs',
  'remediate-effect-both': 'studio/compile-view.mjs',
  'remediate-deploy-meaning': 'studio/compile-view.mjs',
  'remediate-rows-hint': 'studio/compile-view.mjs',
  'remediate-not-compared-summary': 'studio/compile-view.mjs',
};
// The one way a pure function takes the static texts: an explicit `remedy` input, bound where the view asks isStatic().
const REMEDY_BINDING = 'remedy: isStatic() ? (key) => staticRemedy(key, staticInput()) : null,';
// How a view reads the static texts' inputs (what is built in, from the catalogue) and Traceability's texts.
const STATIC_INPUT = 'const staticInput = () => staticInputOf(state.brand.chrome.name, state.catalog, state.selectedPackId);';
const TRACE_ACTIONS = "const traceActions = () => (isStatic() ? { actions: staticTraceActions(state.brand.chrome.name) } : {});";
const IS_STATIC = "const isStatic = () => state.access?.posture === 'static';";

test('S5 — the wiring: each static text is shown by the view its row names, behind an isStatic() test, the live text kept beside it; no staticRemedy call in the studio escapes that test; every Traceability reading takes the static posture\'s texts', () => {
  assert.deepEqual(Object.keys(WIRED_IN), [...STATIC_REMEDY_KEYS], 'every key is wired somewhere');
  // Every staticRemedy and staticTraceActions call in a studio module: behind `isStatic() ?` on its line.
  const stray = [];
  for (const file of ledgerFiles().filter((f) => f !== 'studio/static-remedies.mjs')) {
    const src = read(file);
    const { code } = tokenize(src);
    const lines = src.split('\n');
    for (const m of code.matchAll(/\b(staticRemedy|staticTraceActions)\s*\(/g)) {
      const n = code.slice(0, m.index).split('\n').length;
      const line = lines[n - 1];
      const before = line.slice(0, line.indexOf(`${m[1]}(`));
      if (!/\bisStatic\(\) \?/.test(before)) stray.push(`${file}:${n}: ${m[1]} outside an isStatic() test`);
    }
  }
  assert.deepEqual(stray, []);
  for (const [key, file] of Object.entries(WIRED_IN)) {
    const src = read(file);
    const direct = new RegExp(`isStatic\\(\\) \\? [^\\n]*?staticRemedy\\('${key}', (?:\\{ product: state\\.brand\\.chrome\\.name \\}|staticInput\\(\\))\\)`);
    const viaRemedy = new RegExp(`(?:remedy \\? remedy\\('${key}'\\) : '[^']+'|if \\(remedy\\) b\\.fix = remedy\\('${key}'\\);)`);
    if (direct.test(src)) continue;
    assert.match(src, viaRemedy, `${file} shows ${key} in the static posture, today's text otherwise`);
    assert.ok(src.includes(REMEDY_BINDING), `${file} binds remedy to the static texts under isStatic()`);
  }
  // Each view that shows one reads the posture and the inputs the one way.
  for (const file of [...new Set(Object.values(WIRED_IN))]) {
    const src = read(file);
    assert.ok(src.includes(IS_STATIC), `${file}: isStatic() reads the posture`);
    assert.ok(src.includes(STATIC_INPUT), `${file}: staticInput() reads what is built in from the catalogue`);
    assert.match(src, /^import \{ [^}]*\bstaticRemedy\b[^}]*\bstaticInputOf\b[^}]*\} from '\.\/static-remedies\.mjs';$/m, `${file} takes the texts and the inputs from the model`);
  }
  // Every Traceability reading in the studio — the screen and the drawer's trace panel — passes the static posture's
  // live-evidence texts, the module's own otherwise.
  const readers = [];
  for (const file of ledgerFiles().filter((f) => f !== 'studio/trace-chain.mjs')) {
    const src = read(file);
    const { code } = tokenize(src);
    const calls = [...code.matchAll(/\b(readTraceability|readChain|traceIssue)\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)];
    if (!calls.length) continue;
    readers.push(file);
    assert.ok(src.includes(IS_STATIC) && src.includes(TRACE_ACTIONS), `${file}: traceActions() gives the static posture's texts`);
    for (const c of calls) assert.match(c[2], /, traceActions\(\)$/, `${file}: ${c[1]}(${c[2]}) takes traceActions()`);
  }
  assert.deepEqual(readers, ['studio/compare-view.mjs', 'studio/drawer.mjs'], 'the screen and the drawer read the trace');
  // The live texts beside the static ones, unchanged.
  const view = read('studio/compare-view.mjs');
  for (const live of [
    "'commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance), then re-scan to confirm the gap closed'",
    "'Redraft from MCP before acting on this drift.'",
    "'Load or scan another pack (for example a live draft, or a curated repository pack) from Discover, then come back to compare.'",
    "fix: 'Review the differences, then deploy what is missing live or update the repository from live.',",
    "'Review them, then deploy what is missing live or update the repository from live.'",
    "'Traceability follows each objective to the metrics, rules, scrape jobs, dashboards and alerts that prove it. Declare an SLO, or pick a live pack as Pack B to compare the repository with live.'",
    "'Nothing live backs this pack. “Drift-free” and “Fresh” need a live draft (MCP) or a live refresh to verify.'",
    "fix: 'Refresh the live draft: scan live or fetch again from MCP.',",
    "'Connect MCP or scan live, then choose the live draft as the baseline (Pack B) to compare.'",
    "'Draft the live pack again from MCP once the endpoint is healthy, then re-check.'",
    "'connect MCP or scan live to verify'",
  ]) assert.ok(view.includes(live), `the live studio keeps ${live.slice(0, 60)}`);
  const remediate = read('studio/compile-view.mjs');
  for (const live of [
    "'Compare with a live pack to get a recommendation, or deploy the repository’s artefacts directly.'",
    "next: 'Deploy, after a review',", "next: 'Generate patch, then deploy',",
    "note: 'only after you review the destination, environment and artefacts' },", "note: 'the patch and the deploy are confirmed separately' },",
    "'Ticked rows go to the deploy review'}; the rest need a manual fix in the pack, instrumentation or platform.`",
    "'not compared with live, so the deploy review lists every deployable artefact'",
    "'Ticked rows go to the deploy review; untick a row to leave it out. Rows without a box need a repository patch, a decision or a manual fix.'",
    "'Opens the deploy review with every deployable artefact; nothing is written until you confirm there.'",
    "'Opens a review of destination, environment and artefacts; nothing is written until you confirm there.'",
  ]) assert.ok(remediate.includes(live), `the live studio keeps ${live.slice(0, 60)}`);
  // The deployable rows' boxes choose what the deploy review takes; the static posture, where none opens, draws them
  // disabled (row 26's hint says why).
  assert.ok(remediate.includes("const boxDisabled = isStatic() ? ' disabled' : '';") && remediate.includes("<input type=\"checkbox\" ${checked ? 'checked' : ''}${boxDisabled}>"), 'the boxes are disabled in the static posture');
  assert.ok(read('studio/app.mjs').includes('<strong>Discover</strong> to crawl a repo, generate from a live MCP server, or\n        upload a manifest — then come back here.'));
  // The pure decision takes the texts as an input; criterionBlocker passes it through.
  assert.match(view, /export function buildAssessmentDecision\(\{[^}]*remedy = null \} = \{\}\)/);
  assert.ok(view.includes('const b = criterionBlocker(c, lost, { hasLive, haveB, digest, roles, pointsPerCheck, lensLabel, remedy });'));
  // The shared modules take theirs as options and import nothing to know them: the grade's hint, the response path's
  // note (its imports pinned by tools/test-remediation-flow-view.mjs), the trace's actions.
  assert.ok(view.includes("computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, diffSafe, isStatic() ? { noLiveHint: staticRemedy('no-live-hint', staticInput()) } : {});"));
  for (const file of ['studio/diagnostic-grade.mjs', 'studio/remediation-flow-view.mjs', 'studio/trace-chain.mjs']) assert.doesNotMatch(read(file), /from '\.\/static-remedies\.mjs'|import\('\.\/static-remedies\.mjs'\)/, `${file} does not import the model`);
});
