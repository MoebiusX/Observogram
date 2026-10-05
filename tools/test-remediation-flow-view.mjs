#!/usr/bin/env node
// tools/test-remediation-flow-view.mjs — the response-path panel (GAP batch 2, B3.3;
// studio/remediation-flow-view.mjs) over the engine (tools/lib/remediation-flow.mjs).
//
// The loader imports the engine once (cached; a rejection cached as null, one warning) and
// repaints once through the hook when it lands; the gate (`packDeclaresRemediation`) keeps every
// pack without spec.remediation off the import and off the DOM — the inert proof the Discover
// goldens and the three remediation-free catalogue packs rest on. The view model names the other
// side from the compare mode, counts a comparison only with Pack B and an errorless diff, and
// hands each deploy step its SLO's deploy surface. The HTML: '' without a model, the Diagnose
// block with the report's heading markup and its sticky-index target, the Remediate section after
// the plan; the deploy button on Remediate alone, only when compared, only for a deployable SLO;
// every operator string escaped. The renderer appends and returns the handlers (deploy through the
// host seam). The `.rflow-*` zone of studio/ux-remediate.css reads --ux-* tokens only, moves
// nothing, and its state colours clear WCAG AA on every theme surface (measured here).
//
// Run: node --test tools/test-remediation-flow-view.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import * as engine from './lib/remediation-flow.mjs';
import { deploySurfaceForArtefact } from '../studio/artifact-model.mjs';
import {
  ENGINE_SPECIFIER, SCREENS, buildRemediationFlowViewModel, packDeclaresRemediation, remediationFlowEngine, remediationFlowHtml,
  renderRemediationFlow, resetRemediationFlowEngine,
} from '../studio/remediation-flow-view.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(ROOT, ...p.split('/'));
const read = (p) => readFileSync(rel(p), 'utf8');
const loadPack = (p) => (p.endsWith('.json') ? JSON.parse(read(p)) : parseYaml(read(p)));
const PAYMENT_PATH = `${SPEC_SCHEMA_PATH.replace(/\/[^/]+$/, '')}/examples/payment-service.pack.yaml`;
const payment = () => loadPack(PAYMENT_PATH);
const paymentWith = (triggers, edit = () => {}) => {
  const c = payment();
  c.spec.remediation.forEach((r, i) => { if (triggers[i] !== undefined) r.trigger = triggers[i]; });
  edit(c);
  return c;
};
// Pack A with its three triggers resolved; Pack B lacks POL-01 (declared, not live) and drifts RULE-01.
const LINKED = ['alert:api_availability_99_9_burn_14x_5m_1h', 'alert:PaymentServicePodRestarting', 'alert:PaymentDbConnectionPoolSaturated'];
const packA = () => adapt(paymentWith(LINKED));
const packB = (id = 'payment-live') => {
  const c = payment();
  c.spec.policy.burn_rate_alerts.splice(0, 1);
  c.spec.alerting.rules[0].for = '30m';
  c.metadata.name = id;
  c.metadata.annotations = { ...(c.metadata.annotations || {}), 'mcp.discovered.alert_rules_unhealthy': 'PaymentDbConnectionPoolSaturated' };
  return adapt(c);
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- 1. the loader ----------

test('remediationFlowEngine imports once: undefined while loading, the module afterwards, onLoaded once when it lands and never for a later caller; reset forgets it', async () => {
  resetRemediationFlowEngine();
  let imports = 0;
  let loaded = 0;
  const importFn = () => { imports += 1; return Promise.resolve(engine); };
  assert.equal(remediationFlowEngine({ importFn, onLoaded: () => { loaded += 1; } }), undefined, 'loading');
  assert.equal(remediationFlowEngine({ importFn, onLoaded: () => { loaded += 100; } }), undefined, 'still loading: no second import, no second hook');
  await tick(); await tick();
  assert.equal(loaded, 1);
  assert.equal(imports, 1);
  assert.equal(remediationFlowEngine({ importFn }), engine, 'cached');
  assert.equal(imports, 1);
  assert.equal(ENGINE_SPECIFIER, '/lib/remediation-flow.mjs');
  assert.deepEqual([...SCREENS], ['diagnose', 'remediate']);
  resetRemediationFlowEngine();
});

test('a rejected import is cached as null with one console.warn naming the specifier, onLoaded never fires, and the panel stays off', async () => {
  resetRemediationFlowEngine();
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    let loaded = 0;
    assert.equal(remediationFlowEngine({ importFn: () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')), onLoaded: () => { loaded += 1; } }), undefined);
    await tick(); await tick();
    assert.equal(remediationFlowEngine({ importFn: () => { throw new Error('must not import again'); } }), null);
    assert.equal(loaded, 0);
    assert.equal(warned.length, 1);
    assert.match(warned[0], /\/lib\/remediation-flow\.mjs did not load \(ERR_MODULE_NOT_FOUND\)/);
    assert.equal(buildRemediationFlowViewModel(null, { pack: packA() }), null);
    assert.equal(remediationFlowHtml(buildRemediationFlowViewModel(null, { pack: packA() })), '');
  } finally {
    console.warn = warn;
    resetRemediationFlowEngine();
  }
});

// ---------- 2. the gate and the model ----------

test('the gate: packDeclaresRemediation is false for null and for every catalogue pack without an L4 healing artefact, the model null for them, for no engine and for an engine without the builder; true and a model for a pack with one', () => {
  assert.equal(packDeclaresRemediation(null), false);
  assert.equal(packDeclaresRemediation({ layers: { L4: { healing: [] } } }), false);
  for (const p of ['examples/demo-skeleton.pack.yaml', 'examples/production-curated.pack.yaml', 'examples/krystaline-repo-carlos.pack.yaml']) {
    const pack = adapt(loadPack(p));
    assert.equal(packDeclaresRemediation(pack), false, p);
    assert.equal(buildRemediationFlowViewModel(engine, { pack }), null, `${p}: nothing to draw`);
  }
  const pack = adapt(payment());
  assert.equal(packDeclaresRemediation(pack), true);
  assert.equal(buildRemediationFlowViewModel(undefined, { pack }), null, 'engine not loaded');
  assert.equal(buildRemediationFlowViewModel({}, { pack }), null, 'no builder');
  const m = buildRemediationFlowViewModel(engine, { pack, packId: 'abc123' });
  assert.equal(m.configured, true);
  assert.equal(m.compared, false);
  assert.equal(m.otherSide, 'live');
  assert.equal(m.packId, 'abc123');
  assert.equal(m.otherName, null);
  assert.equal(m.counts.remediations, 3);
  // A healing artefact the classifier does not call a remediation: declared, but nothing to draw.
  const odd = adapt(payment());
  odd.layers.L4.healing = [{ id: 'X-01', type: 'sli', spec: {} }];
  assert.equal(packDeclaresRemediation(odd), true);
  assert.equal(buildRemediationFlowViewModel(engine, { pack: odd }), null);
});

test('the view model: the other side is baseline for a gap comparison and live for a drift one; compared only with Pack B and an errorless diff; the live annotations only when compared; each deploy step carries its SLO\'s deploy surface', () => {
  const a = packA();
  const live = packB('payment-live');
  const diff = diffPacks(a, live);
  const drift = buildRemediationFlowViewModel(engine, { pack: a, packB: live, diff, compareBId: 'payment-live', packId: 'p1' });
  assert.equal(drift.otherSide, 'live');
  assert.equal(drift.compared, true);
  assert.equal(drift.otherName, 'payment-live');
  assert.deepEqual(drift.links.map((l) => [l.remediation.id, l.state]), [['HEAL-01', 'missing'], ['HEAL-02', 'drifted'], ['HEAL-03', 'unhealthy']], 'the unhealthy list is read from Pack B');
  const step = drift.links[0].steps[0];
  assert.equal(step.kind, 'deploy-alert');
  const surface = deploySurfaceForArtefact(a.layers.L1.find((x) => x.id === 'SLO-01'));
  assert.equal(surface.deployable, true);
  assert.deepEqual(step.action, { type: 'deploy', identity: surface.identity, artefactId: 'SLO-01', symbol: 'slos.api_availability_99_9', rows: 2, deployable: true });
  const gap = buildRemediationFlowViewModel(engine, { pack: a, packB: packB('grafana-reference'), diff, compareBId: 'grafana-reference' });
  assert.equal(gap.otherSide, 'baseline');
  assert.equal(gap.links[2].state, 'live', 'a baseline reports no unhealthy list');
  assert.equal(buildRemediationFlowViewModel(engine, { pack: a, packB: live, diff: { error: 'boom' }, compareBId: 'payment-live' }).compared, false);
  assert.equal(buildRemediationFlowViewModel(engine, { pack: a, packB: live, diff: null }).compared, false);
  assert.equal(buildRemediationFlowViewModel(engine, { pack: a, diff }).compared, false, 'a diff without Pack B is not a comparison');
  assert.equal(buildRemediationFlowViewModel(engine, { pack: a, packB: live, diff }).otherName, 'payment-live');
  // An SLO the pack does not carry as an L1 artefact: the step stays, not deployable.
  const noSlo = packA();
  noSlo.layers.L1 = noSlo.layers.L1.filter((x) => x.id !== 'SLO-01');
  const m = buildRemediationFlowViewModel(engine, { pack: noSlo, packB: live, diff: diffPacks(noSlo, live), compareBId: 'payment-live' });
  assert.equal(m.links[0].steps[0].action, null, 'the engine finds no SLO artefact: no action');
});

// ---------- 3. the HTML ----------

test('remediationFlowHtml: \'\' without a model; Diagnose draws a .diag-block #diag-flow with the report\'s heading markup and an Open Remediate action and never a deploy button; Remediate draws .ux-rm-flow #rm-flow; the state words follow the other side', () => {
  assert.equal(remediationFlowHtml(null), '');
  assert.equal(remediationFlowHtml({ configured: false }), '');
  const a = packA();
  const live = packB('payment-live');
  const diff = diffPacks(a, live);
  const model = buildRemediationFlowViewModel(engine, { pack: a, packB: live, diff, compareBId: 'payment-live', packId: 'p1' });
  const diag = remediationFlowHtml(model, { screen: 'diagnose' });
  assert.match(diag, /<section class="rflow diag-block ux-section-target" id="diag-flow" tabindex="-1" aria-labelledby="diag-flow-title">/);
  assert.match(diag, /<h2 class="diag-block-title" id="diag-flow-title">Response path — from a firing alert to its remediation<\/h2>/);
  assert.match(diag, /<p class="diag-block-lede">/);
  assert.match(diag, /data-ux-action="diag-remediate"/);
  assert.ok(!diag.includes('rflow-deploy'), 'Diagnose never deploys');
  assert.match(diag, /Compared with payment-live/);
  assert.match(diag, /<span class="rflow-state is-missing">not live<\/span>/);
  assert.match(diag, /<span class="rflow-state is-unhealthy">not evaluating<\/span>/);
  assert.match(diag, /<span class="rflow-state is-drifted">drifted<\/span>/);
  assert.match(diag, /by burn-rule name/);
  assert.match(diag, /by rule name/);
  assert.match(diag, /<details class="rflow-uncovered">\s*<summary>5 alerts without a remediation<\/summary>/);
  assert.match(diag, /<strong>3 remediations<\/strong> · 3 paths to an alert · <strong>3 paths<\/strong> blocked · 5 alerts without a remediation\./);
  const rm = remediationFlowHtml(model, { screen: 'remediate' });
  assert.match(rm, /<section class="rflow ux-rm-flow" id="rm-flow" aria-labelledby="rm-flow-title">/);
  assert.match(rm, /<h3 class="rflow-title" id="rm-flow-title">/);
  assert.ok(!rm.includes('diag-block') && !rm.includes('diag-remediate'));
  assert.equal((rm.match(/data-ux-action="rflow-deploy"/g) || []).length, 1, 'one deploy button: the missing burn alert');
  assert.match(rm, /<button type="button" class="ux-secondary-btn rflow-deploy" data-ux-action="rflow-deploy" data-identity="[^"]+"[^>]*>Deploy [^<]+ \(2 rows\)<\/button>/);
  assert.ok(!/<a class="rflow-link"/.test(rm), 'file:// runbooks are text, not links');
  // Baseline words.
  const gap = remediationFlowHtml(buildRemediationFlowViewModel(engine, { pack: a, packB: packB('grafana-reference'), diff, compareBId: 'grafana-reference' }), { screen: 'diagnose' });
  assert.match(gap, /<span class="rflow-state is-missing">not in the baseline<\/span>/);
  assert.match(gap, /<span class="rflow-state is-live">in the baseline<\/span>/);
  assert.match(gap, /what the baseline declares/);
  // Default screen is diagnose.
  assert.equal(remediationFlowHtml(model), diag);
});

test('the deploy button renders on Remediate only when compared and only for a deployable SLO; an uncompared panel says so and shows no button; unresolved triggers list their suggestions as suggestions and the annotation as code', () => {
  const a = packA();
  const uncompared = remediationFlowHtml(buildRemediationFlowViewModel(engine, { pack: a, packId: 'p' }), { screen: 'remediate' });
  assert.ok(!uncompared.includes('rflow-deploy'));
  assert.match(uncompared, /Not compared with live: every alert reads as declared, so nothing here can be deployed yet\./);
  assert.match(uncompared, /<span class="rflow-state is-uncompared">not compared<\/span>/);
  assert.match(uncompared, /<span class="rflow-state is-declared">declared<\/span>/);
  const diagUncompared = remediationFlowHtml(buildRemediationFlowViewModel(engine, { pack: a }), { screen: 'diagnose' });
  assert.match(diagUncompared, /Not compared yet: every alert reads as declared\. Pick a baseline or a live pack/);
  const noSlo = packA();
  noSlo.layers.L1 = noSlo.layers.L1.filter((x) => x.id !== 'SLO-01');
  const live = packB('payment-live');
  const compared = remediationFlowHtml(buildRemediationFlowViewModel(engine, { pack: noSlo, packB: live, diff: diffPacks(noSlo, live), compareBId: 'payment-live' }), { screen: 'remediate' });
  assert.ok(!compared.includes('rflow-deploy'), 'no deployable SLO: no button');
  assert.match(compared, /Deploy the burn-rate rules of api_availability_99_9: declared, not live\./);
  const catalogue = remediationFlowHtml(buildRemediationFlowViewModel(engine, { pack: adapt(payment()) }), { screen: 'remediate' });
  assert.match(catalogue, /<ol class="rflow-paths rflow-unresolved" aria-label="Triggers naming no alert">/);
  assert.equal((catalogue.match(/<span class="rflow-state is-unresolved">unresolved<\/span>/g) || []).length, 3);
  assert.match(catalogue, /Closest by name: <span class="rflow-id">RULE-03<\/span> PaymentCertificateExpiringSoon \(cert~, expiring\) — a suggestion, not a link\./);
  assert.match(catalogue, /No alert of this pack shares a name with it\./);
  assert.match(catalogue, /<code>metadata\.annotations\[&quot;observogram\.remediates\.remediation\[2\]&quot;\] = &quot;alerting\.rules\[2\]&quot;<\/code> — or rename the trigger/);
  assert.match(catalogue, /<code>metadata\.annotations\[&quot;observogram\.remediates\.remediation\[0\]&quot;\] = &quot;alerting\.rules\[&lt;j&gt;\]&quot;<\/code>\./);
  assert.match(catalogue, /<strong>3 triggers<\/strong> naming no alert of this pack/);
  assert.ok(!catalogue.includes('rflow-deploy'));
});

test('every operator string is escaped: a hostile trigger, rule name, runbook, automation and SLO id render as text, a javascript: runbook gets no link, an https one does', () => {
  const hostile = paymentWith(['alert:<img src=x onerror=alert(1)>', 'alert:PaymentServicePodRestarting', 'alert:"quoted" & <b>bold</b>'], (c) => {
    c.spec.alerting.rules[0].name = '<script>alert(1)</script>';
    c.spec.remediation[0].runbook = 'javascript:alert(1)';
    c.spec.remediation[1].runbook = 'https://runbooks.example/a?b=1&c=<x>';
    c.spec.remediation[1].automation = '<b>x</b>://y';
    c.spec.remediation[2].guardrails.requires_human_above = '<SEV1>';
  });
  const pack = adapt(hostile);
  for (const screen of SCREENS) {
    const html = remediationFlowHtml(buildRemediationFlowViewModel(engine, { pack }), { screen });
    assert.ok(!html.includes('<img'), 'no raw img');
    assert.ok(!html.includes('<script'), 'no raw script');
    assert.ok(!html.includes('<b>bold'), 'no raw bold');
    assert.ok(!/href="javascript:/.test(html), 'no javascript: link');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&lt;SEV1&gt; and above need a human/);
    assert.match(html, /Manual remediation \(&lt;b&gt;x&lt;\/b&gt;:\/\/y\)/, 'a non-URI automation is a manual step, escaped');
    assert.match(html, /<a class="rflow-link" href="https:\/\/runbooks\.example\/a\?b=1&amp;c=&lt;x&gt;" target="_blank" rel="noopener noreferrer">open the runbook ↗<\/a>/);
    assert.match(html, /Runbook: javascript:alert\(1\)\./, 'the javascript: runbook is quoted as text');
  }
});

// ---------- 4. the renderer ----------

// The DOM the renderer needs: createElement → an element whose innerHTML becomes child nodes
// that appendChild moves (so `while (wrap.firstChild) container.appendChild(…)` drains it).
const stubElement = () => ({
  _nodes: [],
  set innerHTML(v) { this._nodes = String(v).trim() ? [{ html: String(v), parent: this }] : []; },
  get innerHTML() { return this._nodes.map((n) => n.html).join(''); },
  get firstChild() { return this._nodes[0] ?? null; },
  appendChild(n) { n.parent?._nodes.shift(); n.parent = this; this._nodes.push(n); },
});

test('renderRemediationFlow appends the panel to the container and returns the rflow-deploy handler, which opens the deploy modal through the host with the button\'s identity; a null model draws nothing and returns {}', () => {
  globalThis.document = { createElement: stubElement };
  try {
    const a = packA();
    const live = packB('payment-live');
    const model = buildRemediationFlowViewModel(engine, { pack: a, packB: live, diff: diffPacks(a, live), compareBId: 'payment-live', packId: 'pack-1' });
    const container = stubElement();
    const opened = [];
    const host = { openDeployModal: (x) => opened.push(x), renderMainView() {}, renderTabs() {}, loadPackB: () => Promise.resolve() };
    const handlers = renderRemediationFlow(container, model, host, { screen: 'remediate' });
    assert.deepEqual(Object.keys(handlers), ['rflow-deploy']);
    assert.equal(container._nodes.length, 1);
    assert.match(container.innerHTML, /id="rm-flow"/);
    handlers['rflow-deploy'](null, { dataset: { identity: 'api_availability_99_9' } });
    assert.equal(opened.length, 1);
    assert.equal(opened[0].packId, 'pack-1');
    assert.deepEqual([...opened[0].presetIdentities], ['api_availability_99_9']);
    handlers['rflow-deploy'](null, { dataset: {} });
    assert.equal(opened.length, 1, 'no identity: nothing opens');
    const empty = stubElement();
    assert.deepEqual(renderRemediationFlow(empty, null, host), {});
    assert.equal(empty._nodes.length, 0);
    assert.deepEqual(renderRemediationFlow(null, model, host), {});
  } finally {
    delete globalThis.document;
  }
});

// ---------- 5. the wiring, the zone and the tokens ----------

test('the views reach the panel through the view module and the host seam: compile-view renders it after the plan behind the gate, compare-view inserts the block and its sticky-index entry; the view module imports neither app.mjs nor state.mjs', () => {
  const view = read('studio/remediation-flow-view.mjs');
  const imports = [...view.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./util.mjs', './ux-kit.mjs', './host.mjs', './diagnostic-grade.mjs', './artifact-model.mjs']);
  assert.ok(!view.includes("from './app.mjs'") && !view.includes("from './state.mjs'"));
  assert.match(view, /import\(ENGINE_SPECIFIER\)/, 'the engine is loaded at call time');
  const compile = read('studio/compile-view.mjs');
  assert.match(compile, /from '\.\/remediation-flow-view\.mjs'/);
  assert.match(compile, /packDeclaresRemediation\(state\.pack\)/);
  assert.match(compile, /renderRemediationFlow\(/);
  assert.match(compile, /screen: 'remediate'/);
  const compare = read('studio/compare-view.mjs');
  assert.match(compare, /from '\.\/remediation-flow-view\.mjs'/);
  assert.match(compare, /id: 'diag-flow', label: 'Response path'/);
  assert.match(compare, /remediationFlowHtml\(flowModel, \{ screen: 'diagnose' \}\)/);
  assert.match(read('docs/UI_CONVENTIONS.md'), /`\.rflow-\*`/, 'the zone is listed');
});

test('the .rflow-* zone in studio/ux-remediate.css: every token it reads is a --ux-* token (or the type faces and its own --rflow-tone), nothing fixed or sticky, the header names Diagnose; and its four state colours clear WCAG AA (4.5:1) on every surface of both themes', () => {
  const css = read('studio/ux-remediate.css');
  const at = css.indexOf('.rflow {');
  assert.ok(at > 0, 'the zone exists');
  const zone = css.slice(css.lastIndexOf('/* ====', at));
  assert.match(zone, /Diagnose/);
  assert.ok(!/position:\s*(fixed|sticky)/.test(zone), 'moves nothing');
  const tokens = new Set([...zone.matchAll(/var\(--([\w-]+)/g)].map((m) => m[1]));
  for (const t of tokens) assert.ok(/^ux-/.test(t) || ['sans', 'mono', 'rflow-tone'].includes(t), `--${t} is not a --ux-* token`);
  const ux = read('studio/ux.css');
  const app = read('studio/app.css');
  const hexes = (block) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
  const blockOf = (text, head) => { const i = text.indexOf(head); assert.ok(i >= 0, head); return text.slice(i, text.indexOf('}', i)); };
  const themes = {
    dark: { states: hexes(blockOf(ux, 'body {')), surfaces: { ...hexes(blockOf(app, '[data-theme="dark"] {')), ...hexes(blockOf(app, 'body.chrome-observa {')) } },
    light: { states: hexes(blockOf(ux, 'html[data-theme="light"] body {')), surfaces: { ...hexes(blockOf(app, ':root {')), ...hexes(blockOf(app, 'html[data-theme="light"] body.chrome-observa {')) } },
  };
  const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // The chip (13 px bold → 4.5:1) names one of the four state colours; it sits on --ux-bg-2 (a path)
  // or --ux-bg (the section), which resolve to --obs-bg-3 / --paper and --obs-bg-2 / --card.
  for (const state of ['live', 'missing', 'drifted', 'unresolved']) {
    const rule = zone.match(new RegExp(`\\.rflow-state\\.is-${state}[^{]*\\{([^}]*)\\}`));
    assert.ok(rule, `.rflow-state.is-${state} exists`);
    const token = rule[1].match(/color:\s*var\(--(ux-\w+)\)/)?.[1];
    assert.ok(token, `${state} names a state colour`);
    for (const [name, t] of Object.entries(themes)) {
      const colour = t.states[token];
      assert.ok(colour, `${name}: --${token} is a hex token of ux.css`);
      for (const surface of ['card', 'paper', 'obs-bg-2', 'obs-bg-3']) {
        const bg = t.surfaces[surface];
        assert.ok(bg, `${name}: --${surface} is a hex token of app.css`);
        const ratio = contrast(colour, bg);
        assert.ok(ratio >= 4.5, `${name}: ${state} (--${token} ${colour}) on --${surface} ${bg} is ${ratio.toFixed(2)}:1, below 4.5`);
      }
    }
  }
  assert.match(zone.match(/\.rflow-state\s*\{([^}]*)\}/)[1], /font:\s*600 13px/, 'small bold text: the 4.5:1 threshold applies');
});
