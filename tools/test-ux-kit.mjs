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
  GLOSSARY, termHtml, LAYER_PURPOSE, layerTitle, decisionHeaderHtml, emptyStateHtml, sectionNavHtml,
  disclosureHtml, plural, listSentence, personalName,
  parseRecentServices, orderServicesByRecent,
} from '../studio/ux-kit.mjs';

test('four separate status properties, each with its own question', () => {
  assert.deepEqual(Object.keys(STATUS_PROPERTIES), ['origin', 'completion', 'evidence', 'assessment']);
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

test('every layer code travels with its plain purpose', () => {
  for (const code of ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV']) assert.ok(LAYER_PURPOSE[code]?.question.endsWith('?'), code);
  assert.equal(layerTitle('L1'), 'L1 Contract · What should we measure?');
  assert.equal(layerTitle('ZZ'), 'ZZ');
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

