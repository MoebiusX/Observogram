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
import { fileURLToPath } from 'node:url';
import { parse } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { classify } from './lib/artefact-model.mjs';
import { BOARD_LAYERS } from '../studio/discover-board.mjs';
import { WIN32_PLATFORM } from '../server/fixtures/platform.mjs';
import {
  FAMILIES, FAMILY_HOME, DEFINES_RULES, ID_RULES, ID_MATCH_LENGTH, PATTERN_MAX_LENGTH,
  TAXONOMY_VERSION, TAXONOMY_VERSIONS, TAXONOMY_VERSION_LATEST, GLOSSARY_LIMITS,
  classifyArtefact, familyOf, compileTaxonomy, validateTaxonomy, configureTaxonomy, activeTaxonomy, describeTaxonomy,
  compileBoundedPattern,
  glossaryFor, glossaryByText, glossaryEntries,
} from './lib/artefact-classify.mjs';
import * as artefactClassify from './lib/artefact-classify.mjs';
import { bindTaxonomy } from '../studio/taxonomy.mjs';
import { loadTaxonomyFile } from './build-studio-bundle.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const allArtefacts = (pack) => Object.values(pack.layers).flatMap(v => (Array.isArray(v) ? v : Object.values(v).flat()));
const payment = adapt(parse(read(`../${SPEC_DIR}/examples/payment-service.pack.yaml`)));
const carlos = adapt(parse(read('../examples/krystaline-repo-carlos.pack.yaml')));
const V1 = JSON.parse(read('./fixtures/taxonomy/taxonomy.json'));
const V2 = JSON.parse(read('./fixtures/taxonomy/taxonomy.v2.json'));

// The override is process-wide module state: never leak one into the next test.
afterEach(() => { configureTaxonomy(null); });

// ---------- purity ----------

test('artefact-classify.mjs is zero-import, reads no node: module and no environment; its runtime reads are the id clocks\' guarded CPU time and the platform its slack depends on', () => {
  const src = read('./lib/artefact-classify.mjs');
  assert.ok(!/^\s*import\s/m.test(src), 'zero-import (vendored verbatim downstream)');
  assert.ok(!/from\s+'node:/.test(src) && !/\bprocess\./.test(src), 'no node: module, no process');
  assert.deepEqual(src.match(/\bglobalThis\.process\b.*$/gm), ['globalThis.process?.cpuUsage?.();', "globalThis.process?.platform === 'win32' ? 15.625 + 1 : 0,"],
    'the CPU clock and its slack — a 15.625 ms tick and the truncated millisecond on Windows, else 0 — read only where the runtime has them (a browser has no process)');
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

test('compileBoundedPattern is the taxonomy\'s pattern rule: each refusal names its reason, and a passing pattern comes back compiled', () => {
  const ok = compileBoundedPattern('^svc-[a-z]+$', { flags: 'i' });
  assert.deepEqual(Object.keys(ok), ['re']);
  assert.ok(ok.re instanceof RegExp);
  assert.equal(ok.re.flags, 'i');
  assert.equal(ok.re.test('SVC-abc'), true);
  assert.equal(compileBoundedPattern('^x').re.flags, '', 'flags default to ""');
  const reason = (pattern, opts) => compileBoundedPattern(pattern, opts).reason;
  assert.equal(reason(''), 'pattern must be a non-empty string');
  assert.equal(reason(undefined), 'pattern must be a non-empty string');
  assert.equal(reason(7), 'pattern must be a non-empty string');
  assert.equal(reason(`^${'a'.repeat(PATTERN_MAX_LENGTH)}`), `pattern longer than ${PATTERN_MAX_LENGTH} characters`);
  assert.equal(compileBoundedPattern(`^${'a'.repeat(PATTERN_MAX_LENGTH - 1)}`).reason, undefined, 'exactly the maximum is allowed');
  assert.equal(reason('svc-'), 'pattern must be anchored (start with ^)');
  assert.equal(reason('^svc-', { flags: 'g' }), 'flags must be "" or "i"');
  assert.equal(reason('^(a+)+$'), 'nested quantifier');
  assert.equal(reason('^(ab){2,}'), 'nested quantifier');
  assert.equal(reason('^svc-('), 'invalid regex: Invalid regular expression: /^svc-(/: Unterminated group');
});

test('compileBoundedPattern names the pattern by `noun` and leaves the rule itself unchanged', () => {
  const reason = (pattern, opts) => compileBoundedPattern(pattern, { noun: 'when.pattern', ...opts }).reason;
  assert.equal(reason(''), 'when.pattern must be a non-empty string');
  assert.equal(reason(`^${'a'.repeat(PATTERN_MAX_LENGTH)}`), `when.pattern longer than ${PATTERN_MAX_LENGTH} characters`);
  assert.equal(reason('x'), 'when.pattern must be anchored (start with ^)');
  assert.equal(reason('^x', { flags: 'm' }), 'flags must be "" or "i"');
  assert.equal(reason('^(a|aa)*b'), 'nested quantifier');
  // The taxonomy's own texts are the ones it always had (the noun defaults to `pattern`).
  assert.deepEqual(validateTaxonomy({ version: 1, ids: [{ pattern: 'svc-', family: 'sli' }, { pattern: '^(a+)+$', family: 'sli' }] }),
    ['taxonomy: ids[0]: pattern must be anchored (start with ^)', 'taxonomy: ids[1]: nested quantifier']);
});

// ---------- the id clocks ----------

// A scripted id clock: each call answers the next { wall, cpu } reading (ms), from the first again once they run out
// (a re-time reads like the passes before it), and counts the reads.
function scripted(...readings) {
  const clock = () => readings[clock.reads++ % readings.length];
  clock.reads = 0;
  return clock;
}
// A clock on which every pass reads a second, on both clocks.
function alwaysSlow() {
  let t = 0;
  const clock = () => { clock.reads++; t += 1000; return { wall: t, cpu: t }; };
  clock.reads = 0;
  return clock;
}
const TOO_SLOW = `pattern too slow against a ${ID_MATCH_LENGTH}-character id`;

test('compileBoundedPattern with timed: false skips only the id clocks', () => {
  assert.equal(compileBoundedPattern('^svc-[a-z]+$', { clock: alwaysSlow() }).reason, TOO_SLOW);
  assert.equal(compileBoundedPattern('^svc-[a-z]+$', { noun: 'when.pattern', clock: alwaysSlow() }).reason, `when.pattern too slow against a ${ID_MATCH_LENGTH}-character id`);
  const clock = alwaysSlow();
  const untimed = compileBoundedPattern('^svc-[a-z]+$', { timed: false, clock });
  assert.ok(untimed.re instanceof RegExp);
  assert.equal(clock.reads, 0, 'timed: false never reads the clock');
  // …and every static check still runs.
  assert.equal(compileBoundedPattern('svc-', { timed: false, clock }).reason, 'pattern must be anchored (start with ^)');
  assert.equal(compileBoundedPattern('^(a+)+$', { timed: false, clock }).reason, 'nested quantifier');
  assert.equal(compileBoundedPattern('^x', { timed: false, flags: 'g', clock }).reason, 'flags must be "" or "i"');
});

test('the id clocks hold the pattern\'s own work to the 50 ms budget: a stalled pass is not refused, a slow one is — the smaller of the wall clock and the CPU time plus its slack, the wall clock alone without a CPU clock, a first pass within twice the budget re-timed up to twice', () => {
  const verdict = (t0, t1) => compileBoundedPattern('^svc-[a-z]+$', { clock: scripted(t0, t1) }).reason ?? 'compiled';
  // The thread descheduled for a second mid-pass, the CPU time barely moving: not the pattern's work.
  assert.equal(verdict({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 0.2 }), 'compiled', 'a stalled first pass on a fast pattern is not refused');
  // The process's other threads busy while the pass itself took a millisecond: not the pattern's work either.
  assert.equal(verdict({ wall: 0, cpu: 0 }, { wall: 1, cpu: 900 }), 'compiled');
  // Over the budget on both clocks: refused, with the text it always had. The budget is 50 ms, inclusive.
  assert.equal(verdict({ wall: 0, cpu: 0 }, { wall: 51, cpu: 51 }), TOO_SLOW, 'a slow pattern is refused');
  assert.equal(verdict({ wall: 0, cpu: 0 }, { wall: 50, cpu: 50 }), 'compiled');
  assert.equal(verdict({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 50.5 }), TOO_SLOW, 'stalled and slow: refused on its own work');
  assert.equal(verdict({ wall: 100, cpu: 7 }, { wall: 1100, cpu: 57.5 }), TOO_SLOW, 'the readings are differenced');
  // No CPU clock (a browser): the wall clock decides, as it always did.
  assert.equal(verdict({ wall: 0, cpu: null }, { wall: 51, cpu: null }), TOO_SLOW);
  assert.equal(verdict({ wall: 0, cpu: null }, { wall: 50, cpu: null }), 'compiled');
  assert.equal(verdict({ wall: 0, cpu: 0 }, { wall: 51, cpu: null }), TOO_SLOW, 'a CPU time on one reading only is no CPU clock');
  // A coarse CPU clock (Windows: whole 15.625 ms ticks, each reading truncated to the millisecond) reads a pass short by
  // less than its slack, a tick and a millisecond: it overturns a wall-clock refusal only when under the budget by more.
  const SLACK = 15.625 + 1;
  const coarse = (wall, cpu) => verdict({ wall: 0, cpu: 0, slack: SLACK }, { wall, cpu, slack: SLACK });
  assert.equal(coarse(55, 46.875), TOO_SLOW, 'three ticks — what a pass of up to 62.5 ms can read — refused, deterministically');
  assert.equal(coarse(62, 46), TOO_SLOW, 'three ticks, read to the millisecond');
  assert.equal(coarse(1000, 46.875), TOO_SLOW, 'stalled at three ticks on every pass: a pass over the budget can read that too — refused, as on the wall clock alone');
  assert.equal(coarse(1000, 32), 'compiled', 'stalled at two ticks (31.25 ms, read 31 or 32): under the budget by more than the slack');
  assert.equal(coarse(1000, 0), 'compiled', 'stalled, no tick charged');
  assert.equal(coarse(1000, 50 - SLACK), 'compiled', 'inclusive, as the budget is');
  assert.equal(coarse(1000, 50.5 - SLACK), TOO_SLOW);
  assert.equal(coarse(50, 46.875), 'compiled', 'the wall clock within the budget decides');
  assert.equal(verdict({ wall: 0, cpu: 0, slack: SLACK }, { wall: 55, cpu: 46.875 }), TOO_SLOW, 'the slack of either reading counts');
  // One pass, timed once: a reading before it and one after.
  const clock = scripted({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 0.2 }, { wall: 0, cpu: 0 });
  assert.ok(compileBoundedPattern('^svc-[a-z]+$', { clock }).re);
  assert.equal(clock.reads, 2);
  // A first pass over the budget but within twice it is re-timed, up to two more passes, and refused only when none fits:
  // one reading can overstate a pass whose own work fits — the process's other threads busy in the same window, or a
  // stall Windows' coarse clock charges three ticks. A first pass over twice the budget is refused on it.
  const passes = (...readings) => {
    const timed = scripted(...readings);
    return { verdict: compileBoundedPattern('^svc-[a-z]+$', { clock: timed }).reason ?? 'compiled', reads: timed.reads };
  };
  assert.deepEqual(passes({ wall: 0, cpu: 0, slack: SLACK }, { wall: 323.8, cpu: 46, slack: SLACK }, { wall: 400, cpu: 46, slack: SLACK }, { wall: 700, cpu: 77, slack: SLACK }),
    { verdict: 'compiled', reads: 4 }, 'win32: a stalled pass charged three ticks, re-timed at two — compiled');
  assert.deepEqual(passes({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 60 }, { wall: 1000, cpu: 60 }, { wall: 2000, cpu: 80 }),
    { verdict: 'compiled', reads: 4 }, 'the process\'s other threads busy through the first pass, not the second — compiled');
  assert.deepEqual(passes({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 60 }, { wall: 1000, cpu: 60 }, { wall: 2000, cpu: 120 }, { wall: 2000, cpu: 120 }, { wall: 3000, cpu: 150 }),
    { verdict: 'compiled', reads: 6 }, 'the third pass fits — compiled');
  assert.deepEqual(passes({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 60 }), { verdict: TOO_SLOW, reads: 6 }, 'no pass of three fits — refused, and never a fourth');
  assert.deepEqual(passes({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 51 }), { verdict: TOO_SLOW, reads: 6 }, 'a pattern over the budget is over on every pass');
  assert.deepEqual(passes({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 100 }, { wall: 1000, cpu: 100 }, { wall: 2000, cpu: 101 }),
    { verdict: 'compiled', reads: 4 }, 'twice the budget, inclusive: re-timed');
  assert.deepEqual(passes({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 100.5 }, { wall: 1000, cpu: 100.5 }, { wall: 2000, cpu: 101.5 }),
    { verdict: TOO_SLOW, reads: 2 }, 'over twice the budget: refused on the first pass, never re-timed');
  assert.deepEqual(passes({ wall: 0, cpu: null }, { wall: 80, cpu: null }, { wall: 80, cpu: null }, { wall: 81, cpu: null }),
    { verdict: 'compiled', reads: 4 }, 'without a CPU clock, a stall within twice the budget is re-timed');
  assert.deepEqual(passes({ wall: 0, cpu: null }, { wall: 101, cpu: null }, { wall: 101, cpu: null }, { wall: 102, cpu: null }),
    { verdict: TOO_SLOW, reads: 2 }, 'without a CPU clock, one past it is refused, as it always was');
});

test('a first pass over twice the budget is refused on it — a catastrophic pattern runs once on each adversarial id; a re-time runs a fresh compilation of the same pattern', () => {
  // ~18 s on one 256-character 'a' id. Never executed here: RegExp.prototype.test answers for this one
  // pattern and counts, while the clock says the pass took 18 s.
  const CATASTROPHIC = '^.*a{0,60}a{0,60}a{0,60}a{0,60}b$';
  const realTest = RegExp.prototype.test;
  const runs = [];
  RegExp.prototype.test = function test(s) {
    if (this.source === CATASTROPHIC) { runs.push(s); return false; }
    return realTest.call(this, s);
  };
  try {
    const clock = scripted({ wall: 0, cpu: 0 }, { wall: 18_000, cpu: 18_000 }, { wall: 18_000, cpu: 18_000 }, { wall: 36_000, cpu: 36_000 });
    assert.equal(compileBoundedPattern(CATASTROPHIC, { clock }).reason, TOO_SLOW, 'the static checks admit it; the clocks refuse it');
    assert.equal(clock.reads, 2, 'timed once');
    assert.deepEqual(runs, ['a'.repeat(ID_MATCH_LENGTH), 'ab'.repeat(ID_MATCH_LENGTH / 2), '-'.repeat(ID_MATCH_LENGTH), `${'x'.repeat(ID_MATCH_LENGTH - 1)}!`],
      'run once on each of the four adversarial ids, which are the ones they always were');
  } finally {
    RegExp.prototype.test = realTest;
  }
  // V8 keeps one compilation per source and runs its second pass warm (a pattern of 55 ms ran in 8): re-running the same
  // RegExp would admit what the first pass refused. Each re-time compiles the source anew, wrapped in non-capturing groups.
  const P = '^svc-[a-z]+$';
  const passes = [];
  RegExp.prototype.test = function test(s) {
    if (s.length === ID_MATCH_LENGTH) passes.push(`${this.source}/${this.flags}`);
    return realTest.call(this, s);
  };
  let slow;
  try {
    slow = compileBoundedPattern(P, { flags: 'i', clock: scripted({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 60 }) });
  } finally {
    RegExp.prototype.test = realTest;
  }
  assert.equal(slow.reason, TOO_SLOW);
  assert.deepEqual(passes, [P, P, P, P, `(?:${P})`, `(?:${P})`, `(?:${P})`, `(?:${P})`, `(?:(?:${P}))`, `(?:(?:${P}))`, `(?:(?:${P}))`, `(?:(?:${P}))`].map(src => `${src}/i`),
    'three passes over the four ids, each on its own compilation, with the flags');
  const fit = compileBoundedPattern(P, { flags: 'i', clock: scripted({ wall: 0, cpu: 0 }, { wall: 1000, cpu: 60 }, { wall: 1000, cpu: 60 }, { wall: 2000, cpu: 61 }) });
  assert.deepEqual([fit.re.source, fit.re.flags], [P, 'i'], 'a re-time that fits compiles the pattern itself');
  // The wrapping matches exactly what the source matches, even where what follows a source could change how it parses.
  for (const p of ['^a{1,2', '^a{', '^\\c', '^\\x4', '^a]', '^a|b', '^(a)\\1', '^\\8', '^(?<n>a)\\k<n>', '^a(?=b)', '^\\k']) {
    const once = new RegExp(p);
    const wrapped = new RegExp(`(?:(?:${p}))`);
    for (const s of ['a', 'aa', 'ab', 'b', 'a{1,2', 'a{', '\\c', 'x4', 'a]', '8', 'k', '', 'ba']) assert.equal(wrapped.test(s), once.test(s), `${p} on ${JSON.stringify(s)}`);
  }
});

test('the default id clock reads performance.now() and the process\'s CPU time, never Date.now(): a stall alone never refuses, both over refuses, without a CPU clock the wall clock decides, and the CPU time\'s slack is Windows\' alone, a 15.625 ms tick and a millisecond', () => {
  const ownNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const ownPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realCpuUsage = process.cpuUsage;
  const realDateNow = Date.now;
  let wall = 0;
  let user = 0;
  let system = 0;
  performance.now = () => (wall += 1000);   // every reading a second later: the thread was descheduled
  Date.now = () => { throw new Error('Date.now() is not an id clock'); };
  try {
    process.cpuUsage = () => ({ user, system });   // …and the CPU time stood still
    assert.ok(compileBoundedPattern('^svc-[a-z]+$').re, 'stalled, not working: compiled');
    assert.equal(compileTaxonomy(V1).ids.length, 1);
    assert.deepEqual(validateTaxonomy(V1), []);
    process.cpuUsage = () => ({ user: (user += 30_000), system });   // 30 ms of user CPU per reading (µs)
    assert.ok(compileBoundedPattern('^svc-[a-z]+$').re, '30 ms of CPU: within the budget');
    process.cpuUsage = () => ({ user: (user += 30_000), system: (system += 30_000) });   // 60 ms per reading, user + system
    assert.equal(compileBoundedPattern('^svc-[a-z]+$').reason, TOO_SLOW, 'over on both clocks: refused (user + system)');
    assert.throws(() => compileTaxonomy(V1), { message: `taxonomy: ids[0]: ${TOO_SLOW}` });
    assert.deepEqual(validateTaxonomy(V1), [`taxonomy: ids[0]: ${TOO_SLOW}`]);
    assert.equal(compileTaxonomy(V1, { timed: false }).ids.length, 1, 'compileTaxonomy(json, { timed: false }) reads no clock');
    process.cpuUsage = undefined;   // a runtime without a CPU clock (a browser)
    assert.equal(compileBoundedPattern('^svc-[a-z]+$').reason, TOO_SLOW, 'the wall clock decides alone');
    // The slack the default clock reads with the CPU time, on whichever platform runs the suite: on win32 a 15.625 ms
    // tick and a millisecond, elsewhere 0. Every pass stalled a second on the wall clock; the k-th pass charged `us[k]`
    // of user CPU (µs), the last one repeated.
    const onPlatform = (platform, ...us) => {
      Object.defineProperty(process, 'platform', { ...ownPlatform, value: platform });
      let cpu = 0;
      let reads = 0;
      process.cpuUsage = () => ({ user: (cpu += us[Math.min(reads++ >> 1, us.length - 1)]), system: 0 });
      return compileBoundedPattern('^svc-[a-z]+$').reason ?? 'compiled';
    };
    assert.equal(onPlatform(WIN32_PLATFORM, 46_875), TOO_SLOW, 'win32, stalled at three ticks on every pass: refused, as on the wall clock alone');
    assert.equal(onPlatform(WIN32_PLATFORM, 46_875, 31_250), 'compiled', 'win32, stalled at three ticks, re-timed at two: compiled');
    assert.equal(onPlatform(WIN32_PLATFORM, 46_875, 46_875, 31_250), 'compiled', 'win32: the third pass at two ticks: compiled');
    assert.equal(onPlatform('linux', 46_875), 'compiled', 'linux: no slack, 46.875 ms of CPU is within the budget');
    assert.equal(onPlatform('darwin', 46_875), 'compiled', 'darwin: no slack');
    assert.equal(onPlatform(WIN32_PLATFORM, 33_375), 'compiled', 'win32: 33.375 ms + 16.625 is the budget, inclusive');
    assert.equal(onPlatform(WIN32_PLATFORM, 33_376), TOO_SLOW, 'win32: a microsecond more is over');
    assert.equal(onPlatform(WIN32_PLATFORM, 0), 'compiled', 'win32, stalled, no tick charged');
  } finally {
    if (ownNow) Object.defineProperty(performance, 'now', ownNow); else delete performance.now;
    Object.defineProperty(process, 'platform', ownPlatform);
    process.cpuUsage = realCpuUsage;
    Date.now = realDateNow;
  }
});

test('the taxonomy binds as it is served: compileTaxonomy and validateTaxonomy take { timed }, the studio binds untimed, and the builder that bakes a bundle\'s document still times it', () => {
  // Every clock a runtime offers steps past the 50 ms budget on each read — Date.now, performance.now and the process's
  // CPU time — so a timed run reads as too slow whichever one the id check reads (a slow phone, a throttled tab).
  const realNow = Date.now;
  const ownPerfNow = Object.getOwnPropertyDescriptor(performance, 'now');
  const realCpuUsage = process.cpuUsage;
  let t = 0;
  let cpu = 0;
  Date.now = () => (t += 100);
  performance.now = () => (t += 100);
  process.cpuUsage = () => ({ user: (cpu += 100_000), system: 0 });
  const TOO_SLOW = `taxonomy: ids[0]: pattern too slow against a ${ID_MATCH_LENGTH}-character id`;
  try {
    for (const doc of [V1, V2]) {
      assert.throws(() => compileTaxonomy(doc), { message: TOO_SLOW }, 'timed by default, as the server compiles at start');
      assert.deepEqual(validateTaxonomy(doc), [TOO_SLOW], 'timed by default, as the server and the builder validate');
      assert.equal(compileTaxonomy(doc, { timed: false }).ids.length, 1, 'timed: false reads no clock');
      assert.deepEqual(validateTaxonomy(doc, { timed: false }), []);
    }
    // …and every static check still runs untimed.
    const unanchored = { ...V1, ids: [{ pattern: 'promrule-', family: 'alert_rule' }] };
    assert.throws(() => compileTaxonomy(unanchored, { timed: false }), { message: 'taxonomy: ids[0]: pattern must be anchored (start with ^)' });
    assert.deepEqual(validateTaxonomy(unanchored, { timed: false }), ['taxonomy: ids[0]: pattern must be anchored (start with ^)']);
    // The studio binds the document it is served without the clocks: the server timed it at start, the builder at bake.
    assert.equal(bindTaxonomy(artefactClassify, V1), artefactClassify);
    assert.equal(activeTaxonomy()?.ids.length, 1, 'bound: the served override, not the default families');
    assert.equal(classifyArtefact({ id: 'promrule-HighErrorRate' }).via, 'override');
    assert.throws(() => bindTaxonomy(artefactClassify, unanchored), { message: 'taxonomy: ids[0]: pattern must be anchored (start with ^)' });
    // The builder's side: --taxonomy (or OBSERVOGRAM_TAXONOMY at build) is read through the timed validator.
    assert.throws(() => loadTaxonomyFile(fileURLToPath(new URL('./fixtures/taxonomy/taxonomy.json', import.meta.url))), { message: /: taxonomy: ids\[0\]: pattern too slow against a 256-character id$/ });
  } finally {
    Date.now = realNow;
    if (ownPerfNow) Object.defineProperty(performance, 'now', ownPerfNow); else delete performance.now;
    process.cpuUsage = realCpuUsage;
    bindTaxonomy(artefactClassify, null);
  }
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
