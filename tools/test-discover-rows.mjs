// tools/test-discover-rows.mjs
//
// Discover's artefact rows (studio/card-html.mjs artefactRowHtml and its pure
// helpers): the four-property status split, the task filters' definitions,
// the "Inferred from recording rule" relationship, a row that leads with
// name + what it does + status while the id and tags wait in Details, and the
// View control's lighter drawings of that row (Cards, Tiles, List).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { inferSlisFromRecordingRules } from './lib/sli-inference.mjs';
import {
  artefactRowHtml, artefactStatus, inferredFrom, resolveInferredRule, artefactKind, artefactCardHtml,
  DISCOVER_VIEWS, DISCOVER_VIEW_DEFAULT, discoverView, artefactLightRowHtml, artefactStatusMark, artefactStatusWords, STATUS_MARKS,
} from '../studio/card-html.mjs';
import { BOARD_LAYERS, BOARD_ITEMS_SHOWN, boardGroups, boardGroupsHtml, boardHeadHtml, objectivePct } from '../studio/discover-board.mjs';

const allArtefacts = (pack) => Object.values(pack.layers).flatMap(v => (Array.isArray(v) ? v : Object.values(v).flat()));
const carlos = adapt(parse(fs.readFileSync(new URL('../examples/krystaline-repo-carlos.pack.yaml', import.meta.url), 'utf8')));

test('the adapter source word splits onto evidence and completion; attention is what a person must act on', () => {
  assert.equal(artefactStatus({ source: 'Verified' }).evidence, 'live');
  assert.equal(artefactStatus({ source: 'Declared' }).evidence, 'declared');
  assert.equal(artefactStatus({ source: 'Missing' }).evidence, 'missing');
  const scaffold = artefactStatus({ source: 'Scaffold' });
  assert.equal(scaffold.completion, 'needsInput');
  assert.equal(scaffold.evidence, null, 'a template value has no evidence to speak of');
  assert.equal(scaffold.attention, true);
  assert.equal(artefactStatus({ source: 'Declared' }).attention, false, 'declared-only is not a defect');
  assert.equal(artefactStatus({ source: 'Declared' }, { broken: 2 }).attention, true);
});

test('every adapter id family has a plain kind and role', () => {
  const unnamed = allArtefacts(carlos).filter(a => !artefactKind(a).role).map(a => a.id);
  assert.deepEqual(unnamed, []);
  assert.equal(artefactKind({ id: 'METRIC-SRC-01' }).kind, 'Metric defined in the code', 'the longer prefix wins');
  assert.equal(artefactKind({ id: 'METRIC-01' }).kind, 'Live metric');
});

test('"Inferred from recording rule …" names the rules, and every inferred SLI in the Carlos scan resolves to its L3 rule', () => {
  assert.deepEqual(inferredFrom({ desc: 'Inferred from recording rule slo:http_requests:error_ratio_5m.' }).rules, ['slo:http_requests:error_ratio_5m']);
  assert.deepEqual(inferredFrom({ desc: 'Inferred from recording rules svc:lat:good/total.' }).rules, ['svc:lat:good', 'svc:lat:total']);
  assert.deepEqual(inferredFrom({ desc: 'Inferred from recording rules a:b:value_5m and a:b:error_ratio_5m.' }).rules, ['a:b:value_5m', 'a:b:error_ratio_5m']);
  assert.equal(inferredFrom({ desc: 'Share of good requests' }), null);
  const rules = new Set(carlos.layers.L3.filter(a => /^QRY-/.test(a.id)).map(a => a.title));
  const inferred = carlos.layers.L1.filter(a => inferredFrom(a));
  assert.equal(inferred.length, 18);
  assert.ok(inferred.every(a => inferredFrom(a).rules.every(n => rules.has(n))));
  assert.ok(inferred.every(a => inferredFrom(a).rules.every(n => resolveInferredRule(n, rules) === n)));
});

test('a good/total SLI the live fetcher infers names the two rules it read; the older shorthand still resolves to them', () => {
  const read = ['checkout:requests:good_5m', 'checkout:requests:total_5m'];
  const [{ sli }] = inferSlisFromRecordingRules(read.map(name => ({ name, expr: `sum(rate(${name}[5m]))` })));
  assert.equal(sli.description, 'Inferred from recording rules checkout:requests:good_5m and checkout:requests:total_5m.');
  const { rules } = inferredFrom({ spec: { description: sli.description } });
  assert.deepEqual(rules, read, 'the full rule names, not the shorthand stems');
  const names = [...read, 'checkout:requests:good_or_bad', 'other:x:good_5m'];
  assert.deepEqual(rules.map(n => resolveInferredRule(n, names)), read);
  // A pack fetched before the inference named both rules carries the shorthand.
  const legacy = inferredFrom({ spec: { description: 'Inferred from recording rules checkout:requests:good/total.' } }).rules;
  assert.deepEqual(legacy.map(n => resolveInferredRule(n, names)), read);
  assert.equal(resolveInferredRule('svc:lat:good', ['svc:lat:goodness']), null, 'a stem needs the _<window> separator');
  assert.equal(resolveInferredRule('svc:lat:p95', ['svc:lat:p95_5m']), null, 'only good/total stems widen; any other name is exact');
  assert.equal(resolveInferredRule('a:b:c', ['a:b:c']), 'a:b:c');
  assert.equal(resolveInferredRule('a:b:good', null), null);
});

test('the inference sentence claims no more than the evidence: declared is not live, and an absent rule is not traced', () => {
  const sli = (source) => ({ id: 'SLI-01', title: 's', source, desc: 'Inferred from recording rule slo:x:y.', spec: { description: 'Inferred from recording rule slo:x:y.' } });
  const found = { rules: [{ name: 'slo:x:y', found: true }] };
  const declared = artefactRowHtml(sli('Declared'), found);
  assert.ok(!/measurement exists/.test(declared), 'a declared rule is not a produced series');
  assert.ok(declared.includes('as declared in the pack; nothing live has confirmed that it runs'));
  const live = artefactRowHtml(sli('Verified'), found);
  assert.ok(live.includes('which the live platform reported') && !/measurement exists/.test(live));
  const absent = artefactRowHtml(sli('Verified'), { rules: [{ name: 'slo:x:y', found: false }] });
  assert.ok(absent.includes('That rule is not in this pack, so the query cannot be traced to it here.'));
  assert.ok(!absent.includes('Its query comes from') && !absent.includes('live platform reported'));
  const pair = { id: 'SLI-02', title: 'p', source: 'Declared', desc: 'Inferred from recording rules a:b:good/total.' };
  const partly = artefactRowHtml(pair, { rules: [{ name: 'a:b:good_5m', found: true }, { name: 'a:b:total', found: false }] });
  assert.ok(partly.includes('1 of those rules is not in this pack, so the query cannot be fully traced here.'), 'one absent rule is enough to drop the claim');
  assert.ok(!partly.includes('Its query comes from'));
  const unchecked = artefactRowHtml(sli('Declared'));
  assert.ok(!unchecked.includes('No recording rule of this name is in this pack'), 'nothing was checked, so nothing is claimed absent');
});

test('a row leads with name + what it does + status; the id and tags wait in Details', () => {
  const sli = { id: 'SLI-01', title: 'slo_http', desc: 'Inferred from recording rule slo:x:y.', source: 'Declared', tags: ['sli', '<b>'], defines: 'slis.slo_http', spec: { description: 'Inferred from recording rule slo:x:y.' } };
  const html = artefactRowHtml(sli, { rules: [{ name: 'slo:x:y', found: true }] });
  assert.ok(html.indexOf('dv-row-name') < html.indexOf('dv-row-status') && html.indexOf('dv-row-status') < html.indexOf('<details'));
  assert.ok(html.includes('data-dv-rule="slo:x:y"'), 'a found rule is a button that opens it');
  assert.ok(html.includes('Measures how the service behaves.'), 'the inference sentence is provenance, not the what line');
  assert.ok(html.includes('Its query comes from that rule as declared in the pack'), 'and says what the inference establishes, for a declared rule');
  assert.ok(/<details[\s\S]*<dd class="dv-mono">SLI-01<\/dd>/.test(html), 'the id sits in Details');
  assert.ok(html.includes('ux-chip-evidence') && html.includes('Declared only'), 'a status chip, not a bare word');
  assert.ok(!html.includes('<b>') && html.includes('&lt;b&gt;'));
  assert.ok(!artefactRowHtml(sli).includes('data-dv-rule'), 'an unresolved rule is plain code');
  const scaffold = artefactRowHtml({ id: 'POL-01', title: 'x', source: 'Scaffold' }, { broken: 1 });
  assert.ok(scaffold.includes('Template value') && scaffold.includes('1 unresolved reference<') && !scaffold.includes('ux-chip-evidence'));
  const authored = artefactRowHtml({ id: 'SLI-02', title: 'checkout', desc: 'Share of checkouts that succeed', source: 'Verified', spec: { description: 'Share of checkouts that succeed' }, mcp: '2026-09-01T00:00:00Z' });
  assert.ok(authored.includes('<p class="dv-row-what">Share of checkouts that succeed</p>') && authored.includes('Last seen live'));
  const qry = artefactRowHtml({ id: 'QRY-01', title: 'r', desc: 'recording rule @ 30s', source: 'Declared' });
  assert.ok(!qry.includes('dv-row-spec') && qry.includes('<dt>Summary</dt><dd>recording rule @ 30s</dd>'), 'a summary that repeats the kind waits in Details');
});

test('View has four degrees of detail, least first; Details is the full row and the default', () => {
  assert.deepEqual(DISCOVER_VIEWS.map(v => v.id), ['list', 'tiles', 'cards', 'details']);
  assert.ok(DISCOVER_VIEWS.every(v => v.label && v.tip && v.cap > 0));
  assert.deepEqual(DISCOVER_VIEWS.map(v => v.cap), [...DISCOVER_VIEWS.map(v => v.cap)].sort((a, b) => b - a), 'a lighter view draws more rows before "Show all"');
  assert.equal(DISCOVER_VIEW_DEFAULT, 'details');
  assert.equal(discoverView('tiles').id, 'tiles');
  assert.equal(discoverView('icons').id, 'details', 'an unknown (stale persisted) view is Details');
  assert.equal(discoverView(undefined).id, 'details');
  const sli = { id: 'SLI-01', title: 'slo_http', subtitle: '≤ 0.5 seconds', desc: 'Share of good requests', source: 'Verified', tags: ['sli'], spec: { description: 'Share of good requests' } };
  const opts = { broken: 1, outsideFilter: true };
  assert.equal(artefactRowHtml(sli, opts), artefactRowHtml(sli, { ...opts, view: 'details' }), 'no view is the full row');
  assert.equal(artefactRowHtml(sli, { ...opts, view: 'tiles' }), artefactLightRowHtml(sli, { ...opts, view: 'tiles' }));
  assert.equal(artefactRowHtml(sli, { ...opts, view: 'list' }), artefactLightRowHtml(sli, { ...opts, view: 'list' }));
  const src = fs.readFileSync(new URL('../studio/app.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes(`[${DISCOVER_VIEWS.map(v => `'${v.id}'`).join(', ')}].includes(saved.discoverDetail)`), 'a reload restores only a known view');
});

test('each lighter view draws less of the same artefact, and still opens the full record', () => {
  const sli = { id: 'SLI-01', title: 'slo_http_<b>', subtitle: '≤ 0.5 seconds', desc: 'Share of good requests', source: 'Verified', tags: ['sli'], defines: 'slis.slo_http', spec: { description: 'Share of good requests' } };
  const details = artefactRowHtml(sli);
  const card = artefactRowHtml(sli, { view: 'cards' });
  const tile = artefactRowHtml(sli, { view: 'tiles' });
  const line = artefactRowHtml(sli, { view: 'list' });
  assert.ok(line.length < tile.length && tile.length < details.length && card.length < details.length);
  for (const html of [details, card, tile, line]) {
    assert.equal(html.match(/class="[^"]*\bdv-row-main"/g).length, 1, 'one button opens the full record in every view');
    assert.ok(!html.includes('<b>') && html.includes('slo_') && html.includes('&lt;b&gt;'));
  }
  // Cards: the card the Build stack draws (id, source word, title, bound, summary, tags), its title the button.
  assert.ok(card.includes('<span class="card-id">SLI-01</span>') && card.includes('<span class="card-source" data-source="Verified">Verified</span>'));
  assert.ok(card.includes('<button type="button" class="card-title dv-row-main" title="Open the full record">slo_http_&lt;b&gt;</button>'));
  assert.ok(card.includes('<div class="card-sub">≤ 0.5 seconds</div>') && card.includes('<div class="card-desc">Share of good requests</div>') && card.includes('<span class="tag">sli</span>'));
  assert.ok(!card.includes('<details') && !card.includes('ux-chip') && !card.includes('dv-row-what'));
  const plain = artefactCardHtml(sli);
  assert.equal(card.replace(/<button type="button" class="card-title dv-row-main" title="Open the full record">(.*?)<\/button>/, '<div class="card-title">$1</div>'), plain, 'the same body as the Build stack card, but for the title button');
  assert.ok(artefactRowHtml(sli, { view: 'cards', broken: 2, outsideFilter: true, benchmark: { slug: 'grafana', refPackId: 'ref', label: 'Grafana' } })
    .match(/ref-indicator[\s\S]*benchmark-cta[\s\S]*<span class="card-note">Open in the detail panel · outside this filter<\/span>/), 'the card keeps its flags, the benchmark and the pinned note');
  // Tiles: name, kind, bound and status chips; what it does and Details are left out.
  assert.ok(tile.includes('Service level indicator') && tile.includes('≤ 0.5 seconds'));
  assert.ok(tile.includes('ux-chip-evidence') && tile.includes('>Live</span>') && tile.includes('The live platform reports this signal'), 'a short chip keeps its tooltip');
  assert.ok(tile.indexOf('dv-row-name') < tile.indexOf('dv-row-kind') && tile.indexOf('dv-row-kind') < tile.indexOf('dv-row-status'));
  assert.ok(!tile.includes('dv-row-what') && !tile.includes('<details') && !tile.includes('SLI-01'));
  // List: the name and a mark; kind, bound and status are words, not chips.
  assert.ok(line.includes('dv-mark dv-mark-live') && !line.includes('ux-chip'));
  assert.ok(!line.includes('dv-row-kind') && !line.includes('dv-row-bound') && !line.includes('<details'));
  assert.ok(line.includes('title="Service level indicator · ≤ 0.5 seconds · Live evidence found"'));
  assert.ok(line.includes('<span class="sr-text">Service level indicator. ≤ 0.5 seconds. Live evidence found.</span>'), 'the mark is never the only cue');
  assert.ok(/aria-hidden="true"><\/span>/.test(line));
  // A long name wraps after a separator, not mid-word.
  assert.ok(artefactLightRowHtml({ id: 'QRY-01', title: 'slo:http_requests:error-ratio.5m' }, { view: 'list' })
    .includes('slo:<wbr>http_<wbr>requests:<wbr>error-<wbr>ratio.<wbr>5m</span>'));
  // …and a number stays whole: no break between digits or after a leading minus.
  const nameOf = (title) => /<span class="dv-row-name">(.*?)<\/span>/.exec(artefactLightRowHtml({ id: 'X-01', title }, { view: 'list' }))[1];
  assert.equal(nameOf('OTel SemConv 1.27.0'), 'OTel SemConv 1.27.0');
  assert.equal(nameOf('p99.9 at 12:30 -5% base@1.4 sev1-3'), 'p99.9 at 12:30 -5% base@1.4 sev1-3');
  assert.equal(nameOf('a-1 b_2 v1.x'), 'a-<wbr>1 b_<wbr>2 v1.<wbr>x', 'a letter beside the separator still breaks');
  // The row's state survives the lighter views.
  const scaffold = { id: 'POL-01', title: 'x', source: 'Scaffold' };
  const pinnedTile = artefactLightRowHtml(scaffold, { broken: 2, outsideFilter: true, view: 'tiles' });
  assert.ok(pinnedTile.includes('Template value') && pinnedTile.includes('>2 unresolved</span>') && pinnedTile.includes('outside this filter'));
  const pinnedLine = artefactLightRowHtml(scaffold, { broken: 2, outsideFilter: true, view: 'list' });
  assert.ok(pinnedLine.includes('dv-mark-broken') && pinnedLine.includes('Template value. 2 unresolved references. Open in the detail panel, outside this filter.'));
});

test('one status mark per artefact: what a person must act on wins, and every mark has words and a shape', () => {
  const mark = (source, broken = 0) => artefactStatusMark(artefactStatus({ source }, { broken }));
  assert.equal(mark('Verified'), 'live');
  assert.equal(mark('Declared'), 'declared');
  assert.equal(mark('Scaffold'), 'needsInput');
  assert.equal(mark('Verified', 1), 'broken');
  assert.equal(mark('Scaffold', 1), 'broken');
  assert.deepEqual(artefactStatusWords(artefactStatus({ source: 'Scaffold' }, { broken: 1 })), ['Template value', '1 unresolved reference']);
  assert.deepEqual(artefactStatusWords(artefactStatus({ source: 'Declared' })), ['Declared only']);
  const ids = STATUS_MARKS.map(m => m.id);
  for (const s of ['Verified', 'Declared', 'Scaffold', 'Missing']) assert.ok(ids.includes(mark(s)), `${s} has a legend entry`);
  assert.ok(ids.includes('broken') && STATUS_MARKS.every(m => m.label));
  const css = fs.readFileSync(new URL('../studio/ux-discover.css', import.meta.url), 'utf8');
  for (const id of ids) assert.ok(css.includes(`.dv-mark-${id}`), `.dv-mark-${id} is drawn`);
  for (const v of DISCOVER_VIEWS.filter(x => x.id !== DISCOVER_VIEW_DEFAULT)) assert.ok(css.includes(`.dv-rows[data-view="${v.id}"]`), `${v.id} has its layout`);
});

test('the Build stack card body is unchanged by the Discover row', () => {
  assert.ok(artefactCardHtml({ id: 'X', title: 'x', source: 'Declared' }).includes('<span class="card-id">X</span>'));
  assert.ok(artefactCardHtml({ id: 'X', title: 'x', source: 'Declared' }).includes('<div class="card-title">x</div>'), 'its title is a button only where a caller asks (Discover\'s Cards view)');
});

test('no adapted artefact is ever Missing, so Discover never claims a missing artefact was detected', () => {
  const dir = new URL('../examples/', import.meta.url);
  const packs = fs.readdirSync(dir).filter(f => f.endsWith('.pack.yaml'));
  assert.ok(packs.length >= 1);
  for (const f of packs) {
    const sources = new Set(allArtefacts(adapt(parse(fs.readFileSync(new URL(f, dir), 'utf8')))).map(a => a.source));
    assert.ok(!sources.has('Missing'), `${f}: the adapter projects only what the pack holds`);
  }
  // The shared vocabulary still maps the word, but it never makes an artefact need attention.
  assert.equal(artefactStatus({ source: 'Missing' }).attention, false);
});

test('Discover is a catalogue: no verdict, no evidence count, no task filter, no next step', () => {
  const src = fs.readFileSync(new URL('../studio/layers-view.mjs', import.meta.url), 'utf8');
  const discover = src.slice(src.indexOf('export function renderLayersView'));
  for (const word of ['needs attention', 'Needs attention', 'live evidence', 'Live evidence', 'declared only', 'Declared only', 'required check', 'assessment'])
    assert.ok(!discover.includes(word), `the Discover screen says nothing about "${word}"`);
  for (const gone of ['statusChipHtml', 'matchesTask', 'DISCOVER_TASKS', 'dv-task', 'dv-review', 'dv-assess', 'dv-show-missing', 'primary:', 'causes', 'measures'])
    assert.ok(!src.includes(gone), `${gone} is not part of Discover`);
  const state = fs.readFileSync(new URL('../studio/state.mjs', import.meta.url), 'utf8');
  assert.ok(!state.includes('discoverTask'), 'no task filter is kept or restored');
});

test('the board places every artefact of a layer in a group, and hides none', () => {
  const layerEntries = (pack, L) => (L === 'L4'
    ? ['policy', 'alerting', 'healing'].flatMap(k => pack.layers.L4?.[k] || [])
    : pack.layers[L] || []).map((a, i) => ({ a, key: `${L}//${a.id}#${i}` }));
  for (const L of Object.keys(BOARD_LAYERS)) {
    const entries = layerEntries(carlos, L);
    const { groups } = boardGroups(L, entries);
    assert.equal(groups.reduce((n, g) => n + g.entries.length, 0), entries.length, `${L}: every artefact is in exactly one group`);
  }
  // An id no group claims lands in Other, drawn last.
  const odd = boardGroups('L1', [{ a: { id: 'ZZZ-01', title: 'odd' }, key: 'L1//ZZZ-01' }]).groups;
  assert.equal(odd.at(-1).id, 'other');
  assert.equal(odd.at(-1).entries.length, 1);
  // The longer families do not lose to the shorter ones on the same layer.
  const l2 = boardGroups('L2', [{ a: { id: 'SCRAPE-SRC-01' }, key: 'a' }, { a: { id: 'METRIC-SRC-01' }, key: 'b' }, { a: { id: 'PIP-EXP-MET' }, key: 'c' }]).groups;
  assert.deepEqual(l2.filter(g => g.entries.length).map(g => g.id), ['rcv', 'exp', 'metrics']);
});

test('a board group draws its artefacts as buttons that open the record, and caps a long family', () => {
  const sli = (i) => ({ a: { id: `SLI-0${i}`, title: `slo_<b>_${i}`, spec: { type: i % 2 ? 'ratio' : 'threshold' } }, key: `L1//SLI-0${i}` });
  const slo = { a: { id: 'SLO-01', title: 'x_99_9', spec: { sli: 'x', objective: 0.999, window: '30d' } }, key: 'L1//SLO-01' };
  const html = boardGroupsHtml('L1', [...[1, 2, 3, 4, 5, 6, 7, 8].map(sli), slo]);
  assert.equal((html.match(/data-ux-action="dv-item"/g) || []).length, BOARD_ITEMS_SHOWN + 1, 'six indicators and the objective');
  assert.ok(html.includes(`+${8 - BOARD_ITEMS_SHOWN} more`) && html.includes('data-ux-action="dv-open" data-layer="L1"'), 'the rest is one click away');
  assert.ok(html.includes('data-key="L1//SLO-01"') && html.includes('99.9%') && html.includes('/ 30d'));
  assert.ok(!html.includes('<b>') && html.includes('slo_&lt;b&gt;_1'));
  // An empty family of the layer's model is shown as empty, not as a gap or a failure.
  const l4 = boardGroupsHtml('L4', [{ a: { id: 'ALR-01', title: 'SEV1 routes', spec: { severity: 'SEV1', channels: [{ msteams: '#oncall' }] } }, key: 'L4/alerting/ALR-01' }]);
  assert.ok(l4.includes('data-sev="SEV1"') && l4.includes('msteams #oncall'));
  assert.ok(l4.includes('None in this pack') && l4.includes('is-flow'));
  assert.ok(!/missing|required|fail|attention/i.test(l4), 'the board judges nothing');
});

test('an objective reads as a percentage whatever its scale', () => {
  assert.equal(objectivePct(0.99), '99%');
  assert.equal(objectivePct(0.999), '99.9%');
  assert.equal(objectivePct(0.9995), '99.95%');
  assert.equal(objectivePct(99.5), '99.5%');
  assert.equal(objectivePct(undefined), null);
});

test('the board head states which pack this is, from the manifest', () => {
  const html = boardHeadHtml({
    meta: { service: 'pay<ments', name: 'payments', version: '1.2.0', criticality: 'tier-1', owners: ['team-a', 'team-b'] },
    env: 'prod', total: 30, layers: 5,
    artefacts: [{ id: 'OTEL-01', spec: { semconv: '1.27.0', sdk: { languages: ['go', 'java'] } } }, { id: 'BAK-01', spec: { product: 'prometheus' } }],
  });
  assert.ok(html.includes('ObservabilityPack') && html.includes('pay&lt;ments') && !html.includes('pay<ments'));
  assert.ok(html.includes('payments v1.2.0 · 30 artefacts across 5 layers'));
  for (const fact of ['tier-1', 'prod', 'team-a, team-b', '1.27.0', 'go, java', 'prometheus']) assert.ok(html.includes(fact), fact);
  assert.ok(!html.includes('Imports'), 'a fact the pack does not state is not drawn');
});
