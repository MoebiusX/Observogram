// tools/test-discover-rows.mjs
//
// Discover's artefact rows (studio/card-html.mjs artefactRowHtml and its pure
// helpers): the four-property status split, the task filters' definitions,
// the "Inferred from recording rule" relationship, and a row that leads with
// name + what it does + status while the id and tags wait in Details.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { inferSlisFromRecordingRules } from './lib/sli-inference.mjs';
import {
  artefactRowHtml, artefactStatus, matchesTask, inferredFrom, resolveInferredRule, artefactKind, DISCOVER_TASKS, artefactCardHtml,
} from '../studio/card-html.mjs';

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

test('the task filters have one definition each', () => {
  assert.deepEqual(DISCOVER_TASKS.map(t => t.id), ['attention', 'missingEvidence', 'scaffold', 'live', 'all']);
  assert.ok(DISCOVER_TASKS.every(t => t.label && t.tip));
  const s = (source, broken = 0) => artefactStatus({ source }, { broken });
  assert.equal(matchesTask(s('Scaffold'), 'missingEvidence'), true);
  assert.equal(matchesTask(s('Verified'), 'missingEvidence'), false);
  assert.equal(matchesTask(s('Verified', 1), 'attention'), true);
  assert.equal(matchesTask(s('Scaffold'), 'scaffold'), true);
  assert.equal(matchesTask(s('Declared'), 'live'), false);
  assert.equal(matchesTask(s('Declared'), 'all'), true);
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

test('Needs attention does not claim to cover required artefacts the pack lacks', () => {
  const tip = DISCOVER_TASKS.find(t => t.id === 'attention').tip;
  assert.ok(!/required artefact that is missing/.test(tip));
  assert.ok(/required check not met/.test(tip), 'and says where a missing required artefact shows instead');
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

test('the Build stack card body is unchanged by the Discover row', () => {
  assert.ok(artefactCardHtml({ id: 'X', title: 'x', source: 'Declared' }).includes('<span class="card-id">X</span>'));
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
  assert.ok(!/missing\b/.test(DISCOVER_TASKS.find(t => t.id === 'missingEvidence').tip.replace('Missing evidence', '')),
    'Missing evidence lists declared and template values only');
  const src = fs.readFileSync(new URL('../studio/layers-view.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('dv-show-missing'), 'no cause or action for missing artefacts');
  assert.ok(!/label: 'Missing'/.test(src), 'no Missing measure');
  assert.ok(!/statusChipHtml\('evidence', 'missing'/.test(src), 'no per-layer missing chip');
  assert.ok(!/required artefact'\)\} missing/.test(src));
});
