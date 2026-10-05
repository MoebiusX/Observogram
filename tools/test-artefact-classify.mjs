// tools/test-artefact-classify.mjs
//
// The artefact taxonomy classifier (tools/lib/artefact-classify.mjs): the
// rule order (type → defines → override ids → id prefix), the family
// vocabulary against the Discover board's groups and the adapter's id
// templates, the override file's compile/validate contract with its exact
// refusal texts (schema v1 and v2 — the glossary), the glossary accessors,
// and artefact-model.classify() delegating to it.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { classify } from './lib/artefact-model.mjs';
import { BOARD_LAYERS } from '../studio/discover-board.mjs';
import {
  FAMILIES, FAMILY_HOME, DEFINES_RULES, ID_RULES, ID_MATCH_LENGTH, PATTERN_MAX_LENGTH,
  TAXONOMY_VERSION, TAXONOMY_VERSIONS, TAXONOMY_VERSION_LATEST, GLOSSARY_LIMITS,
  classifyArtefact, familyOf, compileTaxonomy, validateTaxonomy, configureTaxonomy, activeTaxonomy, describeTaxonomy,
  glossaryFor, glossaryByText, glossaryEntries,
} from './lib/artefact-classify.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const allArtefacts = (pack) => Object.values(pack.layers).flatMap(v => (Array.isArray(v) ? v : Object.values(v).flat()));
const payment = adapt(parse(read(`../${SPEC_DIR}/examples/payment-service.pack.yaml`)));
const carlos = adapt(parse(read('../examples/krystaline-repo-carlos.pack.yaml')));
const V1 = JSON.parse(read('./fixtures/taxonomy/taxonomy.json'));
const V2 = JSON.parse(read('./fixtures/taxonomy/taxonomy.v2.json'));

// The override is process-wide module state: never leak one into the next test.
afterEach(() => { configureTaxonomy(null); });

// ---------- purity ----------

test('artefact-classify.mjs is zero-import, reads no node: module and no environment', () => {
  const src = read('./lib/artefact-classify.mjs');
  assert.ok(!/^\s*import\s/m.test(src), 'zero-import (vendored verbatim downstream)');
  assert.ok(!/from\s+'node:/.test(src) && !/\bprocess\./.test(src), 'no node: module, no process');
  assert.ok(!/\b(window|document|localStorage)\s*(?:\.\s*[A-Za-z_$]|\[)/.test(src), 'no DOM');
});

// ---------- the vocabulary ----------

test('every family but unknown has a home whose group exists on its board layer, and every board group is some family\'s home', () => {
  for (const f of FAMILIES) {
    if (f === 'unknown') { assert.equal(FAMILY_HOME[f], undefined); continue; }
    const h = FAMILY_HOME[f];
    assert.ok(h, `${f} has a home`);
    assert.ok(BOARD_LAYERS[h.layer], `${f}: layer ${h.layer} is a board layer`);
    assert.ok(BOARD_LAYERS[h.layer].groups.some(g => g.id === h.group), `${f}: group ${h.group} exists on ${h.layer}`);
    assert.ok(h.label && h.role, `${f} has a label and a role`);
  }
  for (const [layer, def] of Object.entries(BOARD_LAYERS)) {
    for (const g of def.groups) {
      assert.ok(Object.values(FAMILY_HOME).some(h => h.layer === layer && h.group === g.id), `${layer}/${g.id} is the home of a family`);
    }
  }
  assert.deepEqual(Object.keys(FAMILY_HOME).sort(), FAMILIES.filter(f => f !== 'unknown').sort());
  for (const [, family] of [...DEFINES_RULES, ...ID_RULES]) assert.ok(FAMILY_HOME[family], `${family} is a family`);
  assert.ok(Object.isFrozen(FAMILIES) && Object.isFrozen(FAMILY_HOME) && Object.isFrozen(ID_RULES));
});

test('ID_RULES: the longer prefix comes first (METRIC-SRC- before METRIC-, SCRAPE-SRC- before SCRAPE-)', () => {
  const prefixes = ID_RULES.map(([p]) => p);
  for (let i = 0; i < prefixes.length; i++) {
    for (let j = i + 1; j < prefixes.length; j++) {
      assert.ok(!prefixes[j].startsWith(prefixes[i]), `${prefixes[i]} (rule ${i}) shadows ${prefixes[j]} (rule ${j}): the longer prefix must come first`);
    }
  }
  assert.ok(prefixes.indexOf('METRIC-SRC-') < prefixes.indexOf('METRIC-'));
  assert.ok(prefixes.indexOf('SCRAPE-SRC-') < prefixes.indexOf('SCRAPE-'));
  assert.equal(new Set(prefixes).size, prefixes.length, 'no duplicate prefix');
});

test('every id template of tools/lib/adapter.mjs is covered by ID_RULES, with the family classify() gives its first id', () => {
  const src = read('./lib/adapter.mjs');
  const templates = [...src.matchAll(/^\s*id: (?:`([^`$]+)\$\{|'([^']+)')/gm)].map(m => m[1] ?? m[2]);
  assert.ok(templates.length >= 29, `found ${templates.length} id templates`);
  // PIP-EXP-${FAM[family]} and STO-${FAM[family]}-01 expand per signal (adapter.mjs FAM = { metrics: 'MET', logs: 'LOG', traces: 'TRC' }).
  const SIGNALS = ['MET', 'LOG', 'TRC'];
  const samples = templates.flatMap(t => (t === 'PIP-EXP-' ? SIGNALS.map(s => `PIP-EXP-${s}`) : t === 'STO-' ? SIGNALS.map(s => `STO-${s}-01`) : [t.endsWith('-') ? `${t}01` : t]));
  assert.ok(samples.includes('PIP-EXP-MET') && samples.includes('STO-TRC-01') && samples.includes('OTEL-01') && samples.includes('METRIC-SRC-01'));
  const covered = new Set();
  for (const sample of samples) {
    const rule = ID_RULES.find(([p]) => sample.startsWith(p));
    assert.ok(rule, `${sample} is matched by an ID_RULES prefix`);
    covered.add(rule[0]);
    assert.equal(classifyArtefact({ id: sample }).family, rule[1], `${sample} classifies as ${rule[1]}`);
    assert.notEqual(rule[1], 'unknown');
  }
  const uncovered = ID_RULES.map(([p]) => p).filter(p => !covered.has(p));
  assert.deepEqual(uncovered, [], 'an ID_RULES prefix no adapter template produces');
  assert.equal(classifyArtefact({ id: 'PIP-EXP-MET' }).family, 'pipeline_exporter_metrics');
  assert.equal(classifyArtefact({ id: 'STO-LOG-01' }).family, 'storage_logs');
  assert.equal(classifyArtefact({ id: 'BASE-02' }).family, 'baselines', 'the once-exact ids are prefixes now');
  assert.equal(classifyArtefact({ id: 'PIP-EXP-PROFILES' }).family, 'unknown', 'a signal segment the adapter never emits has no family');
});

// ---------- the order ----------

test('type first: a family name in `type` wins over the id; an unknown type falls through to the id', () => {
  assert.deepEqual(classifyArtefact({ type: 'sli', id: 'ZZZ-1' }), { family: 'sli', via: 'type', layer: 'L1', group: 'sli', ...pick(FAMILY_HOME.sli, 'label', 'role') });
  assert.equal(classifyArtefact({ type: 'PackSLI', id: 'DASH-01' }).family, 'dashboard');
  assert.equal(classifyArtefact({ type: 'PackSLI', id: 'DASH-01' }).via, 'id');
  assert.equal(classifyArtefact({ type: 'SLI', id: 'x' }).family, 'unknown', 'type names match exactly, case-sensitive');
  assert.equal(classifyArtefact({ type: 'unknown', id: 'SLI-01' }).via, 'id', '"unknown" is not a family declaration');
  assert.equal(classifyArtefact({ type: 42, id: 'SLI-01' }).via, 'id');
});

test('defines beats the id and beats the override regex; the id rules beat nothing but the fallback', () => {
  assert.deepEqual(pick(classifyArtefact({ id: 'DASH-01', defines: 'slis.x' }), 'family', 'via'), { family: 'sli', via: 'defines' });
  const tx = compileTaxonomy({ version: 1, ids: [{ pattern: '^SLI-', family: 'chaos' }] });
  assert.deepEqual(pick(classifyArtefact({ id: 'SLI-01', defines: 'slis.x' }, tx), 'family', 'via'), { family: 'sli', via: 'defines' });
  assert.deepEqual(pick(classifyArtefact({ id: 'SLI-01' }, tx), 'family', 'via'), { family: 'chaos', via: 'override' }, 'without defines the regex wins over the prefix');
  assert.deepEqual(pick(classifyArtefact({ id: 'nothing-here' }), 'family', 'via', 'layer', 'group', 'label', 'role'),
    { family: 'unknown', via: 'none', layer: null, group: 'other', label: null, role: null });
  assert.equal(classifyArtefact(null).via, 'none');
  assert.equal(classifyArtefact('SLI-01').family, 'unknown');
});

test('an override of ^SLI- leaves classify() of the vendored example byte-identical (defines can never be re-homed)', () => {
  const before = JSON.stringify(allArtefacts(payment).map(a => [a.id, classify(a)]));
  configureTaxonomy(compileTaxonomy({ version: 1, ids: [{ pattern: '^SLI-', family: 'chaos' }, { pattern: '^(?:SLO|DASH)-', family: 'imports' }] }));
  assert.equal(JSON.stringify(allArtefacts(payment).map(a => [a.id, classify(a)])), before);
  assert.equal(classify({ id: 'SLI-99' }), 'chaos', 'a hand-made id without defines does follow the override');
  configureTaxonomy(null);
  assert.equal(classify({ id: 'SLI-99' }), 'sli');
});

test('classify() of artefact-model equals familyOf for every artefact of two adapted packs, and none is unknown', () => {
  for (const pack of [payment, carlos]) {
    for (const a of allArtefacts(pack)) {
      assert.equal(classify(a), familyOf(a), a.id);
      assert.notEqual(classify(a), 'unknown', a.id);
      assert.ok(['defines', 'id'].includes(classifyArtefact(a).via), `${a.id}: an adapted artefact classifies by defines or id`);
    }
  }
  assert.equal(classify(null), 'unknown');
});

// ---------- the override ----------

test('compileTaxonomy: types map a foreign name to a family or to { family, label, role }; ids are first-match', () => {
  const tx = compileTaxonomy({
    version: 1,
    types: { PackSLI: 'sli', PrometheusRule: { family: 'alert_rule', label: 'Prometheus rule', role: 'Fires on a PromQL condition.' } },
    ids: [{ pattern: '^svc-[a-z]+-slo-', family: 'slo', flags: 'i' }, { pattern: '^svc-', family: 'sli', label: 'Service indicator' }],
  });
  assert.equal(tx.types.size, 2);
  assert.equal(tx.ids.length, 2);
  assert.ok(Object.isFrozen(tx) && Object.isFrozen(tx.ids));
  assert.deepEqual(classifyArtefact({ type: 'PackSLI', id: 'anything' }, tx), { family: 'sli', via: 'type', layer: 'L1', group: 'sli', ...pick(FAMILY_HOME.sli, 'label', 'role') });
  assert.deepEqual(classifyArtefact({ type: 'PrometheusRule', id: 'HighErrorRate' }, tx),
    { family: 'alert_rule', via: 'type', layer: 'L4', group: 'rule', label: 'Prometheus rule', role: 'Fires on a PromQL condition.' });
  assert.deepEqual(pick(classifyArtefact({ id: 'SVC-Checkout-SLO-availability' }, tx), 'family', 'via'), { family: 'slo', via: 'override' }, 'flags i');
  assert.deepEqual(pick(classifyArtefact({ id: 'svc-checkout-availability' }, tx), 'family', 'via', 'label', 'role'),
    { family: 'sli', via: 'override', label: 'Service indicator', role: FAMILY_HOME.sli.role }, 'first match; the label overrides, the role is the home\'s');
  assert.equal(classifyArtefact({ id: 'other' }, tx).family, 'unknown');
  assert.equal(describeTaxonomy(tx), '2 types, 2 id rules');
  assert.equal(describeTaxonomy(compileTaxonomy({ version: 1, types: { A: 'sli' }, ids: [{ pattern: '^a', family: 'sli' }] })), '1 type, 1 id rule');
  assert.equal(describeTaxonomy(null), 'no override');
});

test('an id is matched on its first 256 characters only', () => {
  const tx = compileTaxonomy({ version: 1, ids: [{ pattern: '^a+z$', family: 'sli' }] });
  assert.equal(classifyArtefact({ id: `${'a'.repeat(ID_MATCH_LENGTH - 1)}z` }, tx).family, 'sli');
  assert.equal(classifyArtefact({ id: `${'a'.repeat(ID_MATCH_LENGTH)}z` }, tx).family, 'unknown', 'the z is beyond the window');
});

test('compileTaxonomy refuses with exact texts; validateTaxonomy lists every reason and never throws', () => {
  const refuses = (json, message) => {
    assert.throws(() => compileTaxonomy(json), (e) => e.message === message, `${JSON.stringify(json)} → ${message}`);
    assert.ok(validateTaxonomy(json).includes(message), `validateTaxonomy lists ${JSON.stringify(message)}: ${JSON.stringify(validateTaxonomy(json))}`);
  };
  refuses(null, 'taxonomy: must be an object');
  refuses([], 'taxonomy: must be an object');
  refuses('x', 'taxonomy: must be an object');
  refuses({ version: 3 }, 'taxonomy: version must be 1 or 2');
  refuses({}, 'taxonomy: version must be 1 or 2');
  refuses({ version: '1' }, 'taxonomy: version must be 1 or 2');
  refuses({ version: 1, layers: {} }, 'taxonomy: unknown key "layers"');
  refuses({ version: 1, types: { PackSLI: 'indicator' } }, 'taxonomy: types.PackSLI: unknown family "indicator"');
  refuses({ version: 1, types: { PackSLI: 'unknown' } }, 'taxonomy: types.PackSLI: unknown family "unknown"');
  refuses({ version: 1, types: { PackSLI: { label: 'x' } } }, 'taxonomy: types.PackSLI: unknown family undefined');
  refuses({ version: 1, types: { PackSLI: { family: 'sli', label: '' } } }, 'taxonomy: types.PackSLI: label must be a non-empty string');
  refuses({ version: 1, types: { PackSLI: 3 } }, 'taxonomy: types.PackSLI: expected a family name or { family, label?, role? }');
  refuses({ version: 1, types: [] }, 'taxonomy: types must be an object of type name → family');
  refuses({ version: 1, ids: {} }, 'taxonomy: ids must be an array');
  refuses({ version: 1, ids: ['^x'] }, 'taxonomy: ids[0]: expected { pattern, family, flags?, label?, role? }');
  refuses({ version: 1, ids: [{ family: 'sli' }] }, 'taxonomy: ids[0]: pattern must be a non-empty string');
  refuses({ version: 1, ids: [{ pattern: `^${'a'.repeat(PATTERN_MAX_LENGTH)}`, family: 'sli' }] }, 'taxonomy: ids[0]: pattern longer than 200 characters');
  refuses({ version: 1, ids: [{ pattern: 'svc-', family: 'sli' }] }, 'taxonomy: ids[0]: pattern must be anchored (start with ^)');
  refuses({ version: 1, ids: [{ pattern: '^svc-', family: 'sli', flags: 'g' }] }, 'taxonomy: ids[0]: flags must be "" or "i"');
  refuses({ version: 1, ids: [{ pattern: '^svc-', family: 'sli', flags: 'gi' }] }, 'taxonomy: ids[0]: flags must be "" or "i"');
  refuses({ version: 1, ids: [{ pattern: '^(a+)+$', family: 'sli' }] }, 'taxonomy: ids[0]: nested quantifier');
  refuses({ version: 1, ids: [{ pattern: '^(a|aa)*b', family: 'sli' }] }, 'taxonomy: ids[0]: nested quantifier');
  refuses({ version: 1, ids: [{ pattern: '^(ab){2,}', family: 'sli' }] }, 'taxonomy: ids[0]: nested quantifier');
  refuses({ version: 1, ids: [{ pattern: '^svc-(', family: 'sli' }] }, 'taxonomy: ids[0]: invalid regex: Invalid regular expression: /^svc-(/: Unterminated group');
  refuses({ version: 1, ids: [{ pattern: '^svc-', family: 'nope' }] }, 'taxonomy: ids[0]: unknown family "nope"');
  refuses({ version: 1, ids: [{ pattern: '^svc-', family: 'sli', role: 7 }] }, 'taxonomy: ids[0]: role must be a non-empty string');
  // Every reason, in order; a passing file validates to [].
  assert.deepEqual(validateTaxonomy({ version: 3, types: { A: 'x' }, ids: [{ pattern: 'u', family: 'sli' }] }),
    ['taxonomy: version must be 1 or 2', 'taxonomy: types.A: unknown family "x"', 'taxonomy: ids[0]: pattern must be anchored (start with ^)']);
  assert.deepEqual(validateTaxonomy({ version: 1 }), []);
  assert.deepEqual(validateTaxonomy({ version: 1, types: {}, ids: [] }), []);
  assert.deepEqual(validateTaxonomy({ version: 2 }), [], 'a v2 file without a glossary is valid');
  assert.deepEqual(validateTaxonomy({ version: 1, glossary: [] }), ['taxonomy: unknown key "glossary"'], 'the glossary needs version 2');
  // A plain group is fine — only a quantified one is refused.
  assert.equal(compileTaxonomy({ version: 1, ids: [{ pattern: '^(?:svc|app)-[a-z0-9-]+$', family: 'sli' }] }).ids.length, 1);
});

test('configureTaxonomy installs the override process-wide, null restores the defaults, and anything else is refused', () => {
  assert.equal(activeTaxonomy(), null);
  assert.equal(classifyArtefact({ type: 'PackSLI', id: 'x' }).family, 'unknown');
  const tx = compileTaxonomy({ version: 1, types: { PackSLI: 'sli' } });
  assert.equal(configureTaxonomy(tx), tx);
  assert.equal(activeTaxonomy(), tx);
  assert.equal(classifyArtefact({ type: 'PackSLI', id: 'x' }).family, 'sli');
  assert.equal(classify({ type: 'PackSLI', id: 'x' }), 'sli', 'artefact-model reads the same override');
  assert.equal(configureTaxonomy(null), null);
  assert.equal(activeTaxonomy(), null);
  assert.equal(classify({ type: 'PackSLI', id: 'x' }), 'unknown');
  assert.equal(configureTaxonomy(undefined), null);
  assert.throws(() => configureTaxonomy({ version: 1, types: {} }), /taxonomy: configureTaxonomy expects compileTaxonomy\(\) output or null/);
  assert.throws(() => configureTaxonomy('x'), /compileTaxonomy\(\) output or null/);
  // An explicit taxonomy argument neither reads nor touches the active one.
  assert.equal(classifyArtefact({ type: 'PackSLI', id: 'x' }, tx).family, 'sli');
  assert.equal(activeTaxonomy(), null);
});

// ---------- schema v2: the glossary ----------

test('TAXONOMY_VERSION stays 1 (a downstream writes it); TAXONOMY_VERSIONS and TAXONOMY_VERSION_LATEST name what compiles; the fixtures are one v1 and one v2 file', () => {
  assert.equal(TAXONOMY_VERSION, 1);
  assert.deepEqual([...TAXONOMY_VERSIONS], [1, 2]);
  assert.equal(TAXONOMY_VERSION_LATEST, 2);
  assert.ok(Object.isFrozen(TAXONOMY_VERSIONS) && Object.isFrozen(GLOSSARY_LIMITS));
  assert.deepEqual(GLOSSARY_LIMITS, { term: 80, definition: 600, alias: 80, link: 2000, entries: 500 });
  assert.equal(V1.version, 1);
  assert.ok(!('glossary' in V1), 'taxonomy.json stays v1 (the 24 board goldens and the typed.mapped goldens rest on it)');
  assert.equal(V2.version, 2);
  assert.deepEqual({ ...V2, glossary: undefined, version: 1 }, { ...V1, glossary: undefined }, 'taxonomy.v2.json is taxonomy.json plus the glossary');
  assert.deepEqual(validateTaxonomy(V1), []);
  assert.deepEqual(validateTaxonomy(V2), []);
  assert.equal(V2.glossary.length, 6);
});

test('a v2 glossary compiles to { entries, byFamily, byText }; a v1 file and a v2 file without one compile to the frozen empty glossary; classification is unchanged by it', () => {
  const v2 = compileTaxonomy(V2);
  assert.ok(Object.isFrozen(v2) && Object.isFrozen(v2.glossary) && Object.isFrozen(v2.glossary.entries));
  assert.equal(v2.glossary.entries.length, 6);
  assert.deepEqual(v2.glossary.entries.map(e => e.family), ['sli', 'slo', 'alert_rule', 'backend', null, null]);
  assert.deepEqual([...v2.glossary.byFamily.keys()], ['sli', 'slo', 'alert_rule', 'backend']);
  assert.ok(v2.glossary.byText.has('service level indicator') && v2.glossary.byText.has('sli') && v2.glossary.byText.has('slos · targets') && v2.glossary.byText.has('criticality'));
  assert.equal(v2.glossary.byText.get('sli'), v2.glossary.byFamily.get('sli'), 'an alias and the family reach the same entry');
  const rule = v2.glossary.byFamily.get('alert_rule');
  assert.deepEqual(rule, { term: 'Alert rule', definition: 'An operational alert the engine evaluates: something is wrong now, not a budget burning.', family: 'alert_rule', aliases: ['Prometheus rule', 'Operational alert rules'], link: 'https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/' });
  assert.ok(Object.isFrozen(rule) && Object.isFrozen(rule.aliases));
  assert.deepEqual(v2.glossary.entries[4], { term: 'Error budget', definition: 'The share of the window an objective allows to fail: 1 − target. A burn-rate alert fires when it is spent too fast.', family: null, aliases: ['Budget'], link: null });
  // Whitespace is trimmed on the way in; the text key collapses inner whitespace and case.
  const spaced = compileTaxonomy({ version: 2, glossary: [{ term: '  Error   budget ', definition: ' d ', aliases: [' EB '] }] });
  assert.deepEqual(spaced.glossary.entries[0], { term: 'Error   budget', definition: 'd', family: null, aliases: ['EB'], link: null });
  assert.ok(spaced.glossary.byText.has('error budget') && spaced.glossary.byText.has('eb'));
  // v1 and a glossary-less v2: the same frozen empty glossary.
  const v1 = compileTaxonomy(V1);
  assert.deepEqual([...v1.glossary.entries], []);
  assert.ok(Object.isFrozen(v1.glossary) && Object.isFrozen(v1.glossary.entries));
  assert.equal(v1.glossary.byFamily.size, 0);
  assert.equal(compileTaxonomy({ version: 2 }).glossary, v1.glossary, 'one frozen empty glossary object');
  assert.equal(compileTaxonomy({ version: 2, glossary: [] }).glossary.entries.length, 0);
  // The glossary changes no classification: types and ids are the same compiled rules.
  assert.equal(v2.types.size, v1.types.size);
  assert.equal(v2.ids.length, v1.ids.length);
  for (const a of [{ type: 'PackSLI', id: 'x' }, { type: 'PrometheusRule', id: 'HighErrorRate' }, { id: 'promrule-Latency' }, { id: 'SLI-01' }, { id: 'nothing' }, ...allArtefacts(payment)]) {
    assert.deepEqual(classifyArtefact(a, v2), classifyArtefact(a, v1), a.id);
  }
  assert.equal(describeTaxonomy(v2), '7 types, 1 id rule, 6 glossary terms');
  assert.equal(describeTaxonomy(v1), '7 types, 1 id rule');
  assert.equal(describeTaxonomy(compileTaxonomy({ version: 2, glossary: [{ term: 'A', definition: 'd' }] })), '0 types, 0 id rules, 1 glossary term');
  assert.equal(describeTaxonomy(compileTaxonomy({ version: 2 })), '0 types, 0 id rules', 'no glossary, no mention');
});

test('every glossary refusal, with its exact text; validateTaxonomy lists them in file order', () => {
  const refuses = (glossary, message, extra = {}) => {
    const json = { version: 2, glossary, ...extra };
    assert.throws(() => compileTaxonomy(json), (e) => e.message === message, `${JSON.stringify(glossary)} → ${message}`);
    assert.ok(validateTaxonomy(json).includes(message), `validateTaxonomy lists ${JSON.stringify(message)}: ${JSON.stringify(validateTaxonomy(json))}`);
  };
  const ok = { term: 'Term', definition: 'A definition.' };
  refuses({}, 'taxonomy: glossary must be an array');
  refuses('x', 'taxonomy: glossary must be an array');
  refuses(Array.from({ length: GLOSSARY_LIMITS.entries + 1 }, (_, i) => ({ term: `T${i}`, definition: 'd' })), 'taxonomy: glossary: more than 500 entries');
  refuses(['x'], 'taxonomy: glossary[0]: expected { term, definition, family?, aliases?, link? }');
  refuses([null], 'taxonomy: glossary[0]: expected { term, definition, family?, aliases?, link? }');
  refuses([{ ...ok, label: 'x' }], 'taxonomy: glossary[0]: unknown key "label"');
  refuses([{ definition: 'd' }], 'taxonomy: glossary[0]: term must be one line of 1–80 characters');
  refuses([{ term: '   ', definition: 'd' }], 'taxonomy: glossary[0]: term must be one line of 1–80 characters');
  refuses([{ term: 'a'.repeat(81), definition: 'd' }], 'taxonomy: glossary[0]: term must be one line of 1–80 characters');
  refuses([{ term: 'two\nlines', definition: 'd' }], 'taxonomy: glossary[0]: term must be one line of 1–80 characters');
  refuses([{ term: 'T' }], 'taxonomy: glossary[0]: definition must be one line of 1–600 characters');
  refuses([{ term: 'T', definition: 'd'.repeat(601) }], 'taxonomy: glossary[0]: definition must be one line of 1–600 characters');
  refuses([{ term: 'T', definition: 'd\u0007' }], 'taxonomy: glossary[0]: definition must be one line of 1–600 characters');
  refuses([{ ...ok, family: 'indicator' }], 'taxonomy: glossary[0]: unknown family "indicator"');
  refuses([{ ...ok, family: 'unknown' }], 'taxonomy: glossary[0]: unknown family "unknown"');
  refuses([{ ...ok, family: null }], 'taxonomy: glossary[0]: unknown family null');
  refuses([{ ...ok, aliases: 'SLI' }], 'taxonomy: glossary[0]: aliases must be an array of one-line strings of 1–80 characters');
  refuses([{ ...ok, aliases: ['ok', ''] }], 'taxonomy: glossary[0]: aliases must be an array of one-line strings of 1–80 characters');
  refuses([{ ...ok, aliases: ['a'.repeat(81)] }], 'taxonomy: glossary[0]: aliases must be an array of one-line strings of 1–80 characters');
  refuses([{ ...ok, link: 'docs/glossary.md' }], 'taxonomy: glossary[0]: link must be an http(s) URL of at most 2000 characters');
  refuses([{ ...ok, link: 'ftp://example.com/x' }], 'taxonomy: glossary[0]: link must be an http(s) URL of at most 2000 characters');
  refuses([{ ...ok, link: 'javascript:alert(1)' }], 'taxonomy: glossary[0]: link must be an http(s) URL of at most 2000 characters');
  refuses([{ ...ok, link: `https://example.com/${'a'.repeat(2000)}` }], 'taxonomy: glossary[0]: link must be an http(s) URL of at most 2000 characters');
  refuses([{ ...ok, link: 'https://example.com/a b' }], 'taxonomy: glossary[0]: link must be an http(s) URL of at most 2000 characters');
  refuses([{ ...ok, link: 'https://user:secret@example.com/x' }], 'taxonomy: glossary[0]: link must not carry credentials');
  refuses([{ ...ok, link: 'http://token@example.com/' }], 'taxonomy: glossary[0]: link must not carry credentials');
  refuses([{ term: 'A', definition: 'd' }, { term: ' a ', definition: 'd' }], 'taxonomy: glossary[1]: "a" is already defined by glossary[0]');
  refuses([{ term: 'A', definition: 'd', aliases: ['B'] }, { term: 'C', definition: 'd', aliases: ['b'] }], 'taxonomy: glossary[1]: "b" is already defined by glossary[0]');
  refuses([{ term: 'A', definition: 'd', aliases: ['a'] }], 'taxonomy: glossary[0]: "a" is already defined by glossary[0]');
  refuses([{ term: 'A', definition: 'd', family: 'sli' }, { term: 'B', definition: 'd', family: 'sli' }], 'taxonomy: glossary[1]: family "sli" is already defined by glossary[0]');
  // Every reason, in order; the glossary's reasons come after the types' and the ids'.
  assert.deepEqual(validateTaxonomy({ version: 2, types: { A: 'x' }, ids: [{ pattern: 'u', family: 'sli' }], glossary: [{ term: 'T' }, 5] }),
    ['taxonomy: types.A: unknown family "x"', 'taxonomy: ids[0]: pattern must be anchored (start with ^)', 'taxonomy: glossary[0]: definition must be one line of 1–600 characters', 'taxonomy: glossary[1]: expected { term, definition, family?, aliases?, link? }']);
  // A query string and a fragment are fine; `@` after the host is a path character, not userinfo.
  assert.equal(compileTaxonomy({ version: 2, glossary: [{ ...ok, link: 'https://example.com/a?b=c#d@e' }] }).glossary.entries[0].link, 'https://example.com/a?b=c#d@e');
  assert.equal(compileTaxonomy({ version: 2, glossary: [{ ...ok, link: 'HTTP://example.com/' }] }).glossary.entries[0].link, 'HTTP://example.com/');
});

test('glossaryFor / glossaryByText / glossaryEntries read the active override by default, an explicit one when given, and the empty glossary from nothing, a v1 override or an older compiled object', () => {
  const v2 = compileTaxonomy(V2);
  // Nothing active: empty.
  assert.equal(glossaryFor('sli'), null);
  assert.equal(glossaryByText('SLI'), null);
  assert.deepEqual([...glossaryEntries()], []);
  assert.ok(Object.isFrozen(glossaryEntries()));
  // Explicit.
  assert.equal(glossaryFor('sli', v2).term, 'Service level indicator');
  assert.equal(glossaryFor('chaos', v2), null, 'a family without an entry');
  assert.equal(glossaryFor('unknown', v2), null);
  for (const bad of [null, undefined, '', 42, {}]) assert.equal(glossaryFor(bad, v2), null, JSON.stringify(bad));
  assert.equal(glossaryByText('sli', v2), glossaryFor('sli', v2));
  assert.equal(glossaryByText('  Service  level   INDICATOR ', v2), glossaryFor('sli', v2), 'trimmed, collapsed, case-insensitive');
  assert.equal(glossaryByText('Criticality', v2).term, 'Criticality tier', 'an alias');
  assert.equal(glossaryByText('SLOs · targets', v2).family, 'slo', 'the board group title is an alias in the fixture');
  assert.equal(glossaryByText('Owners', v2), null);
  for (const bad of [null, undefined, '', '   ', 42]) assert.equal(glossaryByText(bad, v2), null, JSON.stringify(bad));
  assert.equal(glossaryEntries(v2).length, 6);
  assert.equal(glossaryEntries(v2), v2.glossary.entries, 'the frozen array itself');
  // Active.
  configureTaxonomy(v2);
  assert.equal(glossaryFor('slo').term, 'Service level objective');
  assert.equal(glossaryByText('Error budget').aliases[0], 'Budget');
  assert.equal(glossaryEntries().length, 6);
  // A v1 override active: the empty glossary, classification as before.
  configureTaxonomy(compileTaxonomy(V1));
  assert.equal(glossaryFor('sli'), null);
  assert.equal(glossaryByText('SLI'), null);
  assert.deepEqual([...glossaryEntries()], []);
  assert.equal(classifyArtefact({ type: 'PackSLI', id: 'x' }).family, 'sli');
  // A compiled object from an older build has no `glossary` key: isCompiled installs it, the accessors read nothing.
  const legacy = Object.freeze({ types: new Map([['PackSLI', Object.freeze({ family: 'sli' })]]), ids: Object.freeze([]) });
  assert.equal(configureTaxonomy(legacy), legacy);
  assert.equal(classifyArtefact({ type: 'PackSLI', id: 'x' }).family, 'sli');
  assert.equal(glossaryFor('sli'), null);
  assert.equal(glossaryByText('SLI'), null);
  assert.deepEqual([...glossaryEntries()], []);
  assert.equal(describeTaxonomy(legacy), '1 type, 0 id rules');
  configureTaxonomy(null);
  assert.equal(glossaryFor('sli'), null);
});

function pick(o, ...keys) { return Object.fromEntries(keys.map(k => [k, o[k]])); }
