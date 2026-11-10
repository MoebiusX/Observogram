#!/usr/bin/env node
/**
 * tools/test-ux-kit.mjs — the studio's shared screen grammar (studio/ux-kit.mjs, docs/UX_SCREEN_GRAMMAR.md), headless
 * under node:test: the four status properties and the legacy-word mapping, the chips' property shapes and tooltips, the
 * decision header's order (context → decision → action → causes → measures), empty states, the section index, the
 * glossary terms, layer purposes and the greeting rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_PROPERTIES, statusFromLegacy, statusRecord, statusChipHtml, legacyStatusChipHtml,
  GLOSSARY, termHtml, LAYER_PURPOSE, layerTitle, layerSpecTip, decisionHeaderHtml, contextLineHtml, emptyStateHtml, sectionNavHtml,
  disclosureHtml, plural, listSentence, personalName,
  parseRecentServices, orderServicesByRecent,
} from '../studio/ux-kit.mjs';
import { LAYER_NAMES } from '../studio/constants.mjs';

test('five separate status properties, each with its own question', () => {
  assert.deepEqual(Object.keys(STATUS_PROPERTIES), ['origin', 'completion', 'evidence', 'assessment', 'verdict']);
  for (const p of Object.values(STATUS_PROPERTIES)) {
    assert.ok(p.question.endsWith('?'));
    assert.ok(Object.keys(p.values).length >= 3);
  }
});

test('legacy badge words map onto the property they actually describe', () => {
  assert.deepEqual(statusFromLegacy('VERIFIED'), { property: 'evidence', value: 'live' });
  assert.deepEqual(statusFromLegacy('declared'), { property: 'evidence', value: 'declared' });
  assert.deepEqual(statusFromLegacy('scaffold'), { property: 'completion', value: 'needsInput' });
  assert.deepEqual(statusFromLegacy('todo'), { property: 'completion', value: 'needsInput' });
  assert.deepEqual(statusFromLegacy('pass on placeholder'), { property: 'assessment', value: 'placeholder' });
  assert.deepEqual(statusFromLegacy('conformant'), { property: 'assessment', value: 'pass' });
  assert.deepEqual(statusFromLegacy('gap'), { property: 'assessment', value: 'fail' });
  assert.equal(statusFromLegacy('nonsense'), null);
  assert.equal(statusFromLegacy(null), null);
});

test('a chip names its plain meaning, carries its property class and explains itself', () => {
  const html = statusChipHtml('evidence', 'live');
  assert.match(html, /class="ux-chip ux-chip-ok ux-chip-evidence"/);
  assert.match(html, />Live evidence found</);
  assert.match(html, /title="Evidence — What supports it\?/);
  assert.match(statusChipHtml('assessment', 'notApplicable'), /ux-chip-muted/);
  assert.match(statusChipHtml('verdict', 'suspect'), /class="ux-chip ux-chip-warn ux-chip-verdict"[^>]*title="Verdict — Does a reviewer trust it\?/);
  assert.equal(statusRecord('verdict', 'unreviewed').tone, 'neutral');
  assert.match(statusChipHtml('completion', 'needsInput', { showProperty: true }), /<span class="ux-chip-prop">Completion<\/span>Needs input/);
  assert.match(statusChipHtml('evidence', 'live', { label: '12' }), />12<\/span>$/);
  assert.equal(statusChipHtml('evidence', 'nope'), '');
  assert.equal(statusRecord('assessment', 'placeholder').tone, 'warn');
  // An unknown engine word still renders, neutrally, and escaped.
  assert.match(legacyStatusChipHtml('<odd>'), /ux-chip-neutral">&lt;odd&gt;</);
  assert.match(legacyStatusChipHtml('verified'), /Live evidence found/);
});

test('the decision header renders context, decision, one primary action, causes and measures — in that order', () => {
  const html = decisionHeaderHtml({
    context: [{ key: 'Service', value: 'orders' }, { key: 'Env', value: 'prod' }, { key: 'Empty', value: '' }],
    eyebrow: 'Assessment',
    decision: 'Field grade: live telemetry exists, but the pack does not meet the audit requirement.',
    tone: 'warn', verdict: 'C',
    primary: { id: 'go', label: 'Review required gaps', action: 'gaps' },
    secondary: [{ label: 'How it is calculated', action: 'how' }],
    causes: [{ title: 'Dashboard evidence missing', why: 'No board links the SLO', actionLabel: 'Add a dashboard', actionId: 'add' }],
    measures: [{ label: 'Coverage', value: '75%', note: '3 of 4' }],
  });
  const at = (s) => html.indexOf(s);
  assert.ok(at('ux-ctx') < at('ux-decision-sentence'));
  assert.ok(at('ux-decision-sentence') < at('ux-primary-btn'));
  assert.ok(at('ux-primary-btn') < at('ux-causes'));
  assert.ok(at('ux-causes') < at('ux-measures'));
  assert.equal((html.match(/ux-primary-btn/g) || []).length, 1);
  assert.match(html, /id="go" data-ux-action="gaps">Review required gaps</);
  assert.match(html, /ux-verdict">C</);
  assert.doesNotMatch(html, /Empty/, 'an empty context value is dropped');
  assert.match(html, /data-ux-action="add">Add a dashboard →/);
  assert.match(html, /ux-tone-warn/);
});

test('the decision sentence is escaped unless the caller passes HTML on purpose', () => {
  assert.match(decisionHeaderHtml({ decision: '<b>x</b>' }), /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(decisionHeaderHtml({ decisionHtml: '<b>x</b>' }), /<b>x<\/b>/);
  // The context line on its own, for a screen with a header of its own (Diagnose's Assessment): the header's, byte for byte.
  const context = [{ key: 'Service', value: 'checkout' }, null, { key: 'Baseline', value: '' }, { value: 'payment <b>', title: 'Pack A' }];
  const line = contextLineHtml(context);
  assert.ok(decisionHeaderHtml({ context, decision: 'd' }).includes(line), 'the decision header draws the same line');
  assert.equal((line.match(/class="ux-ctx-item"/g) || []).length, 2, 'an item with no value is not drawn');
  assert.ok(line.startsWith('<div class="ux-ctx">') && line.includes('<span class="ux-ctx-key">Service</span>') && line.includes('title="Pack A"') && line.includes('payment &lt;b&gt;'));
  assert.equal(contextLineHtml([]), '');
  assert.equal(contextLineHtml([{ key: 'Service', value: '' }]), '', 'nothing with a value: no line');
});

test('an empty state says what was checked and offers the next step', () => {
  const html = emptyStateHtml({ title: 'Nothing to import from the selected live scope.', checked: 'service scope · orders', actions: [{ action: 'other', label: 'Review other gaps' }] });
  assert.match(html, /role="note"/);
  assert.match(html, /Checked:<\/span> service scope · orders/);
  assert.match(html, /data-ux-action="other">Review other gaps/);
});

test('the section index links each section with its count; empty input renders nothing', () => {
  const html = sectionNavHtml([{ id: 'gaps', label: 'Gaps', count: 5, tone: 'fail' }, null, { id: 'evidence', label: 'Evidence' }]);
  assert.match(html, /href="#gaps" data-ux-section="gaps">\s*Gaps <span class="ux-section-count">5<\/span>/);
  assert.match(html, /data-ux-section="evidence"/);
  assert.equal(sectionNavHtml([]), '');
});

test('plain words first, the formal term and its definition on hover', () => {
  assert.match(termHtml('retrofeed'), />Update repository from live</);
  assert.match(termHtml('retrofeed'), /title="Retrofeed: Copies signals/);
  assert.match(termHtml('coverage'), /title="How much/, 'no "Coverage: " prefix when the plain word is the term');
  assert.equal(termHtml('unknown-key', 'x'), 'x');
  assert.equal(GLOSSARY.conformant.plain, 'Meets tier rubric');
  assert.equal(GLOSSARY.placeholder.plain, 'Requirement represented; real value still needed');
});

test('every layer code travels with the name users asked for, the spec name behind it, and no question', () => {
  for (const code of ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV']) {
    const p = LAYER_PURPOSE[code];
    assert.ok(p && p.name && p.spec && p.blurb, code);
    assert.equal(p.name, LAYER_NAMES[code], `${code}: the one name every screen shows`);
    assert.equal(p.question, undefined, `${code}: no "What should we measure?" line`);
  }
  assert.deepEqual(['L1', 'L2', 'L3', 'L4', 'L5'].map(c => LAYER_NAMES[c]),
    ['SLI/SLO', 'Metrics/Logs/Traces', 'Dashboards/Recording Rules', 'Alerts/Policy/Self-healing', 'Self-check']);
  assert.equal(layerTitle('L1'), 'L1 SLI/SLO');
  assert.equal(layerTitle('ZZ'), 'ZZ');
  assert.equal(layerSpecTip('L1'), 'In the ObservabilityPack spec: L1 Contract.');
  assert.equal(layerSpecTip('GOV'), '', 'no tooltip where the spec says the same word');
  assert.equal(layerSpecTip('ZZ'), '');
});

test('small grammar helpers', () => {
  assert.equal(plural(1, 'gap'), '1 gap');
  assert.equal(plural(5, 'gap'), '5 gaps');
  assert.equal(plural(2, 'query', 'queries'), '2 queries');
  assert.equal(listSentence(['a', 'b', 'c']), 'a, b and c');
  assert.equal(listSentence(['a', '', null]), 'a');
  assert.match(disclosureHtml('How the grade is calculated', '<p>x</p>'), /<details class="ux-disclosure"><summary>How the grade is calculated<\/summary>/);
});

test('a greeting uses a person’s name, never a role label or an address', () => {
  assert.equal(personalName({ name: 'Carlos Montero' }), 'Carlos');
  assert.equal(personalName({ name: 'Admin' }), '');
  assert.equal(personalName({ name: 'admin user' }), '');
  assert.equal(personalName({ name: 'someone@example.com' }), '');
  assert.equal(personalName({ sub: 'admin' }), '');
  assert.equal(personalName(null), '');
});

test('the recent-services record reads only its own string entries', () => {
  const opened = parseRecentServices('{"api":"2026-09-01T00:00:00.000Z","bad":42}');
  assert.equal(opened.api, '2026-09-01T00:00:00.000Z');
  assert.equal(opened.bad, undefined);
  // An Object.prototype name is a service like any other: never opened here.
  assert.equal(opened.constructor, undefined);
  assert.equal(opened.toString, undefined);
  for (const junk of [null, '', 'not json', '[1,2]', '"x"', 'null']) {
    assert.deepEqual(Object.keys(parseRecentServices(junk)), []);
  }
  assert.equal(JSON.stringify(Object.assign(parseRecentServices('{}'), { a: 'x' })), '{"a":"x"}');
});

test('services order by when they were opened, then by name, whatever the key', () => {
  const services = [{ key: 'constructor', label: 'constructor' }, { key: 'web', label: 'web' }, { key: 'api', label: 'api' }];
  const none = parseRecentServices('{}');
  assert.deepEqual(orderServicesByRecent(services, none).map(s => s.key), ['api', 'constructor', 'web']);
  const opened = parseRecentServices('{"web":"2026-09-02T00:00:00.000Z","api":"2026-09-01T00:00:00.000Z"}');
  assert.deepEqual(orderServicesByRecent(services, opened).map(s => s.key), ['web', 'api', 'constructor']);
  // Even a plain object with an inherited "constructor" does not throw or sort it first.
  assert.deepEqual(orderServicesByRecent(services, {}).map(s => s.key), ['api', 'constructor', 'web']);
  assert.deepEqual(services.map(s => s.key), ['constructor', 'web', 'api'], 'input left as it was');
});


test('wireSectionNav: a jump lights its own link and holds it until the scroll ends (a short page never brings its last sections into the band); the band is rebuilt on resize; a replaced index lets go', async () => {
  const { wireSectionNav } = await import('../studio/ux-kit.mjs');
  const navListeners = {};
  const winListeners = {};
  const classList = () => { const s = new Set(); return { toggle: (c, on) => { if (on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c) }; };
  const ids = ['summary', 'gaps', 'evidence'];
  const links = ids.map((id) => ({ dataset: { uxSection: id }, classList: classList() }));
  const targets = Object.fromEntries(ids.map((id) => [id, { id, scrollIntoView() {}, focus() {} }]));
  const lit = () => links.filter((l) => l.classList.contains('is-current')).map((l) => l.dataset.uxSection);
  const ios = [];
  const prevIO = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class { constructor(cb, opts) { this.cb = cb; this.opts = opts; this.off = false; ios.push(this); } observe() {} disconnect() { this.off = true; } };
  const view = {
    addEventListener: (n, f) => { (winListeners[n] ||= []).push(f); },
    removeEventListener: (n, f) => { winListeners[n] = (winListeners[n] || []).filter((x) => x !== f); },
    setTimeout: () => 0,
    getComputedStyle: () => ({ position: 'static', scrollMarginTop: '200px' }),
  };
  const doc = { defaultView: view, getElementById: (id) => targets[id], documentElement: { clientHeight: 900 } };
  const nav = { isConnected: true, parentElement: null, addEventListener: (n, f) => { navListeners[n] = f; }, querySelectorAll: () => links };
  const root = { ownerDocument: doc, querySelector: () => nav, style: { setProperty() {} } };
  try {
    wireSectionNav(root);
    assert.equal(ios.length, 1);
    assert.equal(ios[0].opts.rootMargin, '-200px 0px -676px 0px', 'a 24px band just below the sticky stack');
    navListeners.click({ target: { closest: () => links[2] }, preventDefault() {} });
    assert.deepEqual(lit(), ['evidence'], 'the jump lights its own link at once');
    ios[0].cb([{ isIntersecting: true, target: targets.gaps }]);
    assert.deepEqual(lit(), ['evidence'], 'a section passed on the way does not take over');
    for (const f of winListeners.scrollend || []) f();
    ios[0].cb([{ isIntersecting: true, target: targets.gaps }]);
    assert.deepEqual(lit(), ['gaps'], 'after the scroll ends, the band rules again');
    winListeners.resize[0]();
    assert.equal(ios.length, 2, 'a resize rebuilds the band');
    assert.ok(ios[0].off && !ios[1].off);
    nav.isConnected = false;
    winListeners.resize[0]();
    assert.ok(ios[1].off, 'a replaced index disconnects');
    assert.equal(ios.length, 2);
    assert.equal((winListeners.resize || []).length, 0, 'and stops listening to resizes');
  } finally {
    globalThis.IntersectionObserver = prevIO;
  }
});
