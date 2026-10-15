// tools/test-glossary.mjs — the glossary marks (studio/glossary.mjs; GAP
// batch 2, B3.4): the byte-identity rule with no glossary bound (unbound, a
// v1 file, a v2 file without a match), the toggletip's anatomy and ids, the
// board-group and head-fact marks, the Discover row's mark position, the
// wiring (toggle, Escape precedence, outside click) over a DOM stub, the
// stripGlossaryMarks proof helper and the `.ux-gloss*` CSS zone.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import * as artefactClassify from './lib/artefact-classify.mjs';
import { bindTaxonomy, familiesAt, glossaryFor, glossaryByText } from '../studio/taxonomy.mjs';
import { escapeHtml } from '../studio/util.mjs';
import { artefactRowHtml, artefactKind, DISCOVER_VIEWS } from '../studio/card-html.mjs';
import { boardGroupsHtml, boardHeadHtml, BOARD_LAYERS } from '../studio/discover-board.mjs';
import {
  resetGlossaryIds, glossaryEntryFor, glossaryEntryForGroup, glossaryMarkHtml, glossaryMarkFor, glossaryLabelHtml,
  glossaryGroupMarkHtml, wireGlossary, closeGlossaryMarks, stripGlossaryMarks,
} from '../studio/glossary.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const V1 = JSON.parse(read('./fixtures/taxonomy/taxonomy.json'));
const V2 = JSON.parse(read('./fixtures/taxonomy/taxonomy.v2.json'));
const payment = adapt(parse(read(`../${SPEC_DIR}/examples/payment-service.pack.yaml`)));
const allArtefacts = (pack) => Object.values(pack.layers).flatMap(v => (Array.isArray(v) ? v : Object.values(v).flat()));
const OPEN = '.ux-gloss-btn[aria-expanded="true"]';

// Every test says which taxonomy it binds; none leaks into the next.
afterEach(() => { bindTaxonomy(artefactClassify, null); resetGlossaryIds(); });

// A DOM stub: `n` marks under one root, the two selectors the wiring uses,
// delegated listeners, events with closest() targets.
function stubRoot(n) {
  const btns = [];
  for (let i = 0; i < n; i++) {
    const def = { hidden: true, classList: { contains: (c) => c === 'ux-gloss-def' }, closest: (s) => (s === '.ux-gloss-def' ? def : null) };
    const btn = { attrs: { 'aria-expanded': 'false' }, focused: 0, nextElementSibling: def,
      getAttribute(k) { return this.attrs[k]; }, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused++; },
      closest: (s) => (s === '.ux-gloss-btn' ? btn : null) };
    def.btn = btn;
    btns.push(btn);
  }
  const listeners = {};
  const root = {
    dataset: {}, listeners,
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    contains: () => true,
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) { if (sel === '.ux-gloss-btn') return btns; if (sel === OPEN) return btns.filter(b => b.attrs['aria-expanded'] === 'true'); return []; },
  };
  const fire = (type, target, key) => {
    const ev = { key, target, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } };
    for (const f of listeners[type] || []) f(ev);
    return ev;
  };
  return { root, btns, fire, outside: { closest: () => null } };
}

test('glossary.mjs is pure: it imports util.mjs and taxonomy.mjs only, no fetch, no DOM read, no state, no product name', () => {
  const src = read('../studio/glossary.mjs');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./taxonomy.mjs', './util.mjs']);
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\bfetch\(|\bdocument\b|\bwindow\b|\bstate\b|\blocalStorage\b/.test(code), 'no fetch, no document, no state');
  assert.ok(!/observogram/i.test(code), 'no product name');
});

test('nothing bound, a v1 file, or a v2 file with no matching entry: glossaryLabelHtml is escapeHtml, the marks are empty strings, and every Discover row and board drawing is byte-identical', () => {
  const labels = ['Service level indicator', 'SLIs', 'Criticality', 'a <b> & "c"', '', 'Owners'];
  const rows = (pack) => allArtefacts(pack).flatMap(a => DISCOVER_VIEWS.map(v => artefactRowHtml(a, { view: v.id })));
  const board = (pack) => ['L1', 'L2', 'L3', 'L4', 'L5', 'GOV'].map(L => boardGroupsHtml(L, (L === 'L4' ? ['policy', 'alerting', 'healing'].flatMap(k => pack.layers.L4?.[k] || []) : pack.layers[L] || []).map(a => ({ a, key: `${L}//${a.id}` })))).join('')
    + boardHeadHtml({ meta: pack.meta, total: 3, layers: 2, artefacts: allArtefacts(pack) });
  // The default families (no override): the glossary passthroughs answer nothing; the homes are known.
  assert.equal(glossaryFor('sli'), null);
  assert.equal(glossaryByText('SLI'), null);
  assert.deepEqual(familiesAt('L1', 'sli'), ['sli']);
  for (const t of labels) {
    assert.equal(glossaryLabelHtml(t, { family: 'sli' }), escapeHtml(t), `default: ${t}`);
    assert.equal(glossaryMarkFor(t, { family: 'sli' }), '');
  }
  assert.equal(glossaryGroupMarkHtml('L1', 'sli', 'SLIs'), '');
  assert.equal(glossaryEntryFor('SLI', { family: 'sli' }), null);
  // v1 bound: the same, and the row/board bytes of the default binding.
  bindTaxonomy(artefactClassify, null);
  const plainRows = rows(payment);
  const plainBoard = board(payment);
  assert.ok(!plainRows.join('').includes('ux-gloss') && !plainBoard.includes('ux-gloss'), 'no mark anywhere without a glossary');
  bindTaxonomy(artefactClassify, V1);
  for (const t of labels) assert.equal(glossaryLabelHtml(t, { family: 'sli' }), escapeHtml(t), `v1: ${t}`);
  assert.equal(glossaryGroupMarkHtml('L1', 'sli', 'SLIs'), '');
  assert.deepEqual(rows(payment), plainRows, 'v1: every row of every view is byte-identical');
  assert.equal(board(payment), plainBoard, 'v1: the board is byte-identical');
  // v2 bound, labels the glossary does not know.
  bindTaxonomy(artefactClassify, V2);
  for (const t of ['Owners', 'Environment', 'Languages', 'Chaos experiments', '']) {
    assert.equal(glossaryLabelHtml(t), escapeHtml(t), `v2 no match: ${t}`);
    assert.equal(glossaryMarkFor(t, { family: 'chaos' }), '');
  }
  assert.equal(glossaryGroupMarkHtml('L5', 'chaos', 'Chaos experiments'), '');
  assert.equal(glossaryGroupMarkHtml('GOV', 'imp', 'Imports'), '');
  // wireGlossary on a root without a mark: false, and not one listener added.
  const { root } = stubRoot(0);
  assert.equal(wireGlossary(root), false);
  assert.deepEqual(Object.keys(root.listeners), []);
  assert.deepEqual(root.dataset, {});
  for (const bad of [null, undefined, {}]) assert.equal(wireGlossary(bad), false);
  assert.equal(closeGlossaryMarks(root), 0);
  assert.equal(closeGlossaryMarks(null), 0);
});

test('the mark is a toggletip: a named button with aria-expanded/aria-controls/aria-describedby, the definition hidden with that id, a Learn-more anchor for an http(s) link only, everything escaped', () => {
  bindTaxonomy(artefactClassify, V2);
  resetGlossaryIds();
  const sli = glossaryMarkFor('Service level indicator', { family: 'sli' });
  assert.equal(sli, '<span class="ux-gloss"><button type="button" class="ux-gloss-btn" aria-label="What is Service level indicator?" aria-expanded="false" aria-controls="ux-gloss-1" aria-describedby="ux-gloss-1">?</button><span class="ux-gloss-def" id="ux-gloss-1" role="note" hidden><strong class="ux-gloss-term">Service level indicator</strong> <span class="ux-gloss-text">A measurement of how the service behaves for its users: a ratio of good events to all events, or a threshold on a latency distribution.</span></span></span>');
  assert.ok(!sli.includes('title='), 'no title attribute: the definition is real content, not a tooltip');
  // The family wins over the text; the text alone (an alias) reaches the same entry; the label names the button.
  assert.equal(glossaryMarkFor('Anything', { family: 'sli' }).replace(/ux-gloss-\d+/g, 'ID'), sli.replace(/ux-gloss-\d+/g, 'ID').replace('What is Service level indicator?', 'What is Anything?'));
  assert.equal(glossaryEntryFor('SLIs'), glossaryFor('sli'));
  assert.equal(glossaryEntryFor('nothing', { family: 'nope' }), null);
  // A link: the anchor after the text, new tab, rel set.
  const rule = glossaryMarkFor('Alert rule', { family: 'alert_rule' });
  assert.match(rule, /<\/span> <a class="ux-gloss-link" href="https:\/\/prometheus\.io\/docs\/prometheus\/latest\/configuration\/alerting_rules\/" target="_blank" rel="noopener noreferrer">Learn more<span class="sr-text"> about Alert rule \(opens in a new tab\)<\/span><\/a><\/span><\/span>$/);
  assert.ok(!glossaryMarkFor('Error budget').includes('ux-gloss-link'), 'no link, no anchor');
  // Escaping: a hostile entry handed straight to glossaryMarkHtml.
  const hostile = glossaryMarkHtml({ term: '<b>x</b>', definition: 'a "quote" & <i>', family: null, aliases: [], link: 'javascript:alert(1)' }, { label: '<img>' });
  assert.ok(!hostile.includes('<b>') && !hostile.includes('<i>') && !hostile.includes('<img>'), 'tags escaped');
  assert.ok(hostile.includes('aria-label="What is &lt;img&gt;?"') && hostile.includes('&lt;b&gt;x&lt;/b&gt;') && hostile.includes('a &quot;quote&quot; &amp; &lt;i&gt;'));
  assert.ok(!hostile.includes('javascript:') && !hostile.includes('ux-gloss-link'), 'a non-http link draws no anchor (the classifier refuses it anyway)');
  assert.equal(glossaryMarkHtml(null), '');
  assert.equal(glossaryMarkHtml({ term: 'x' }), '', 'no definition, no mark');
  // glossaryLabelHtml is the escaped label then the mark.
  resetGlossaryIds();
  const label = glossaryLabelHtml('Criticality');
  resetGlossaryIds();
  assert.equal(label, `Criticality${glossaryMarkFor('Criticality')}`);
  assert.ok(glossaryLabelHtml('Criticality').startsWith('Criticality<span class="ux-gloss">'));
  assert.ok(glossaryLabelHtml('Criticality').includes('<strong class="ux-gloss-term">Criticality tier</strong>'), 'an alias shows the term');
});

test('ids: each mark takes the next ux-gloss-N; resetGlossaryIds() restarts at 1, so a render from a reset is deterministic', () => {
  bindTaxonomy(artefactClassify, V2);
  resetGlossaryIds();
  const a = glossaryMarkFor('SLI');
  const b = glossaryMarkFor('SLO');
  assert.ok(a.includes('id="ux-gloss-1"') && a.includes('aria-controls="ux-gloss-1"') && a.includes('aria-describedby="ux-gloss-1"'));
  assert.ok(b.includes('id="ux-gloss-2"'));
  assert.equal(glossaryMarkFor('Owners'), '', 'a miss takes no id');
  assert.ok(glossaryMarkFor('Budget').includes('id="ux-gloss-3"'));
  resetGlossaryIds();
  assert.equal(glossaryMarkFor('SLI'), a);
  assert.equal(glossaryMarkFor('SLO'), b);
});

test('board groups: the first family at home in the group that has an entry, else the title as a term or alias; head facts match by label', () => {
  bindTaxonomy(artefactClassify, V2);
  assert.deepEqual(familiesAt('L1', 'sli'), ['sli']);
  assert.deepEqual(familiesAt('L2', 'exp'), ['pipeline_exporter_metrics', 'pipeline_exporter_logs', 'pipeline_exporter_traces', 'backend', 'storage_metrics', 'storage_logs', 'storage_traces']);
  assert.deepEqual(familiesAt('L9', 'x'), []);
  assert.equal(glossaryEntryForGroup('L1', 'sli', 'SLIs'), glossaryFor('sli'));
  assert.equal(glossaryEntryForGroup('L1', 'slo', 'SLOs · targets'), glossaryFor('slo'));
  assert.equal(glossaryEntryForGroup('L2', 'exp', 'Exporters & storage'), glossaryFor('backend'), 'the exporters have no entry; the backend (fourth at home) does');
  assert.equal(glossaryEntryForGroup('L4', 'rule', 'Operational alert rules'), glossaryFor('alert_rule'));
  assert.equal(glossaryEntryForGroup('L4', 'pol', 'Policy & detection'), null);
  assert.equal(glossaryEntryForGroup('L2', 'other', 'Other'), null, 'no family is at home in Other');
  // A title that is an alias of an entry without a family.
  assert.equal(glossaryEntryForGroup('L5', 'base', 'Error budget'), glossaryByText('Error budget'));
  resetGlossaryIds();
  const mark = glossaryGroupMarkHtml('L1', 'sli', 'SLIs');
  assert.ok(mark.startsWith('<span class="ux-gloss"><button type="button" class="ux-gloss-btn" aria-label="What is SLIs?"'), 'the group title names the button');
  // On the board: the mark inside the group title, before the count; the head's Criticality and Backends facts carry one.
  const sli = payment.layers.L1.filter(a => a.id.startsWith('SLI-')).map(a => ({ a, key: `L1//${a.id}` }));
  const html = boardGroupsHtml('L1', sli);
  assert.match(html, /<h4 class="dvb-group-title">SLIs<span class="ux-gloss">[\s\S]*?<\/span><\/span> <span class="dvb-group-n">\d+<\/span><\/h4>/);
  assert.match(html, /<h4 class="dvb-group-title">SLOs · targets<span class="ux-gloss">/, 'an empty group still explains itself');
  const head = boardHeadHtml({ meta: payment.meta, total: 3, layers: 1, artefacts: allArtefacts(payment) });
  assert.match(head, /<dt>Criticality<span class="ux-gloss">[\s\S]*?Criticality tier<\/strong>/);
  assert.match(head, /<dt>Backends<span class="ux-gloss">[\s\S]*?Telemetry backend<\/strong>/);
  assert.match(head, /<dt>Owners<\/dt>/, 'a fact without an entry is plain');
  for (const [layer, def] of Object.entries(BOARD_LAYERS)) for (const g of def.groups) assert.equal(typeof glossaryGroupMarkHtml(layer, g.id, g.title), 'string');
});

test('a Discover row: the mark sits between the name button and .dv-row-status on the details view only; stripped, the row is the v1 row', () => {
  bindTaxonomy(artefactClassify, null);
  const sli = payment.layers.L1.find(a => a.id.startsWith('SLI-'));
  const plain = Object.fromEntries(DISCOVER_VIEWS.map(v => [v.id, artefactRowHtml(sli, { view: v.id })]));
  bindTaxonomy(artefactClassify, V2);
  resetGlossaryIds();
  const row = artefactRowHtml(sli);
  const { kind } = artefactKind(sli);
  assert.equal(kind, 'Service level indicator');
  const at = row.indexOf('<span class="ux-gloss">');
  assert.ok(at > 0, 'one mark');
  assert.ok(row.slice(0, at).trimEnd().endsWith('</button>'), 'right after the name button');
  assert.match(row.slice(at), /^<span class="ux-gloss">[\s\S]*?<\/span><\/span>\s*<span class="dv-row-status">/, 'right before the status chips');
  assert.ok(row.includes('aria-label="What is Service level indicator?"'));
  assert.equal((row.match(/<span class="ux-gloss">/g) || []).length, 1);
  assert.equal(stripGlossaryMarks(row), plain.details);
  for (const view of ['tiles', 'list', 'cards']) assert.equal(artefactRowHtml(sli, { view }), plain[view], `${view}: the lighter views carry no mark (glossary-light-views)`);
  // An artefact whose family has no entry: the row is the v1 row.
  const chaos = payment.layers.L5.find(a => a.id.startsWith('CHAOS-'));
  bindTaxonomy(artefactClassify, null);
  const plainChaos = artefactRowHtml(chaos);
  bindTaxonomy(artefactClassify, V2);
  assert.equal(artefactRowHtml(chaos), plainChaos);
});

test('wireGlossary: a click toggles one mark and closes the others, a click elsewhere closes them, Escape closes the open one — swallowed then, untouched otherwise — and returns the focus; wired once', () => {
  const { root, btns, fire, outside } = stubRoot(3);
  assert.equal(wireGlossary(root), true);
  assert.equal(wireGlossary(root), true, 'a second call wires nothing more');
  assert.equal(root.listeners.click.length, 1);
  assert.equal(root.listeners.keydown.length, 1);
  const open = () => btns.map(b => b.attrs['aria-expanded'] === 'true');
  const hidden = () => btns.map(b => b.nextElementSibling.hidden);
  // Escape with nothing open: not stopped, not prevented.
  let ev = fire('keydown', outside, 'Escape');
  assert.equal(ev.stopped, false);
  assert.equal(ev.prevented, false);
  // Click opens; the click is stopped (the row behind it must not open the drawer).
  ev = fire('click', btns[0]);
  assert.deepEqual(open(), [true, false, false]);
  assert.deepEqual(hidden(), [false, true, true]);
  assert.equal(ev.stopped && ev.prevented, true);
  // Another mark: the first closes.
  fire('click', btns[2]);
  assert.deepEqual(open(), [false, false, true]);
  // The same again: closed.
  fire('click', btns[2]);
  assert.deepEqual(open(), [false, false, false]);
  // Open, then a click inside the definition keeps it; a click elsewhere closes it.
  fire('click', btns[1]);
  ev = fire('click', btns[1].nextElementSibling);
  assert.deepEqual(open(), [false, true, false]);
  assert.equal(ev.stopped, false, 'the definition click is left alone (a link in it works)');
  ev = fire('click', outside);
  assert.deepEqual(open(), [false, false, false]);
  assert.equal(ev.stopped, false, 'an outside click is not swallowed');
  // Escape with one open: closed, stopped, prevented, focus back on its button; a tab key is ignored.
  fire('click', btns[1]);
  ev = fire('keydown', outside, 'Tab');
  assert.deepEqual(open(), [false, true, false]);
  assert.equal(ev.stopped, false);
  ev = fire('keydown', outside, 'Escape');
  assert.deepEqual(open(), [false, false, false]);
  assert.deepEqual(hidden(), [true, true, true]);
  assert.equal(ev.stopped && ev.prevented, true);
  assert.equal(btns[1].focused, 1);
  ev = fire('keydown', outside, 'Escape');
  assert.equal(ev.stopped, false, 'with nothing open again, Escape passes to the drawer');
  assert.equal(closeGlossaryMarks(root), 0);
  fire('click', btns[0]);
  assert.equal(closeGlossaryMarks(root), 1);
});

test('stripGlossaryMarks walks the spans in balance: nested spans and the anchor go with the mark, many marks, text without marks is returned as is, an unbalanced mark throws', () => {
  bindTaxonomy(artefactClassify, V2);
  resetGlossaryIds();
  const rule = glossaryMarkFor('Alert rule', { family: 'alert_rule' });
  assert.ok(rule.includes('<a class="ux-gloss-link"'));
  const html = `<h4 class="t">Rules${rule}<span class="n">2</span></h4><p>x${glossaryMarkFor('SLI')}</p><span>keep</span>`;
  assert.equal(stripGlossaryMarks(html), '<h4 class="t">Rules<span class="n">2</span></h4><p>x</p><span>keep</span>');
  assert.equal(stripGlossaryMarks('<span>a</span><span class="x">b</span>'), '<span>a</span><span class="x">b</span>');
  assert.equal(stripGlossaryMarks(''), '');
  assert.throws(() => stripGlossaryMarks('<span class="ux-gloss"><button>?</button>'), /unbalanced/);
  // The whole payment-service board with the glossary, stripped, is the board without it.
  const entries = (L) => (L === 'L4' ? ['policy', 'alerting', 'healing'].flatMap(k => payment.layers.L4?.[k] || []) : payment.layers[L] || []).map(a => ({ a, key: `${L}//${a.id}` }));
  const withGloss = ['L1', 'L2', 'L3', 'L4', 'L5'].map(L => boardGroupsHtml(L, entries(L))).join('\n');
  assert.ok(withGloss.includes('ux-gloss'));
  bindTaxonomy(artefactClassify, null);
  assert.equal(stripGlossaryMarks(withGloss), ['L1', 'L2', 'L3', 'L4', 'L5'].map(L => boardGroupsHtml(L, entries(L))).join('\n'));
});

test('the .ux-gloss* zone in studio/ux.css: --ux-* tokens only, the focus ring restated after all: unset, the row and drawer placement rules, nothing fixed or sticky; the zone is listed in UI_CONVENTIONS', () => {
  const css = read('../studio/ux.css');
  const at = css.indexOf('.ux-gloss {');
  assert.ok(at > 0, 'the zone exists');
  const zone = css.slice(css.lastIndexOf('/* ----------', at), css.indexOf('\n\n/* ----------', at + 1) > 0 ? css.indexOf('\n\n/* ----------', at + 1) : undefined);
  assert.ok(zone.includes('studio/glossary.mjs'), 'the header names the module');
  assert.ok(!/position:\s*(fixed|sticky)/.test(zone), 'moves nothing');
  for (const t of new Set([...zone.matchAll(/var\(--([\w-]+)/g)].map(m => m[1]))) assert.ok(/^ux-/.test(t) || t === 'sans', `--${t} is a --ux-* token`);
  assert.match(zone, /\.ux-gloss-btn \{[^}]*all: unset;/);
  assert.match(zone, /\.ux-gloss-btn:focus-visible \{ outline: 2px solid var\(--ux-accent\); outline-offset: 2px; \}/, 'all: unset drops the shared ring, so it is restated');
  assert.match(zone, /\.ux-gloss:hover > \.ux-gloss-def\[hidden\], \.ux-gloss-btn:focus-visible \+ \.ux-gloss-def\[hidden\] \{ display: block; \}/, 'hover and keyboard focus preview the definition');
  assert.match(zone, /\.dv-row-head > \.dv-row-main \+ \.ux-gloss \{ margin-right: auto; \}/, 'the status chips keep the right edge');
  assert.match(zone, /\.drawer \.ux-gloss-def \{ position: static;/, 'in the drawer the definition opens in the flow');
  assert.ok(css.indexOf('.ux-term {') < at, 'next to .ux-term, the hover-term of ux-kit');
  assert.match(read('../docs/UI_CONVENTIONS.md'), /`\.ux-gloss-\*`/, 'the zone is listed');
  // The stylesheet list is unchanged: no new file (index.html keeps its links).
  assert.ok(!read('../studio/index.html').includes('glossary.css'));
});
