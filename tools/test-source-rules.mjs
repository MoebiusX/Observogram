#!/usr/bin/env node
/**
 * tools/test-source-rules.mjs
 *
 * The alerting rules a burn-rate entry was read from.
 *
 * A hand-written alerting rule on an SLO's recorded series is declared as
 * that SLO's burn-rate entry, { slo, windows }, and the windows are the
 * reading's own — so the rule's expression (its threshold), its wait and its
 * severity were in no field of a pack, and a rule loosened in production
 * compared as aligned with the one the repository declares. Both readings now
 * state the rules beside the entry (observogram.source_rules.<symbol>), the
 * adapter puts them on the burn-rate artefact as `sourceRules`, and the
 * comparison holds each rule to its counterpart as it holds an operational
 * alert rule.
 *
 * Everything here goes through the real scan (crawlFiles), the real live
 * builder (buildCanonicalPack over a ruler's listing), the adapter, the flat
 * diff and the requirement chain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { crawlFiles } from './lib/crawler.mjs';
import { buildCanonicalPack, PROBES } from './fetch-live-pack.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { comparePackBranches } from './lib/traceability-graph.mjs';
import { sourceRuleTerms, operationalAlertRules } from './lib/sli-inference.mjs';
import {
  SOURCE_RULES_ANNOTATION_PREFIX, sourceRulesAnnotationKey, parseSourceRulesAnnotation, deltasOf, unobservedOf,
} from './lib/artefact-model.mjs';
import { validateCanonical } from './lib/validator.mjs';
import { emit as emitYaml, parse as parseYaml } from './lib/mini-yaml.mjs';
import { readFileSync } from 'node:fs';

const SCHEMA = JSON.parse(readFileSync(new URL('../vendor/observability-pack-spec/v1.5/observability-pack.schema.json', import.meta.url), 'utf8'));
const SLO = 'shop_checkout_99';
const KEY = sourceRulesAnnotationKey(SLO);

// ---------------------------------------------------------------------------
// One system: a rule file, and the ruler that loaded it
// ---------------------------------------------------------------------------

const RECORDING = `groups:
  - name: shop
    rules:
      - record: shop:checkout:good_5m
        expr: sum(rate(shop_checkout_requests_total{code!~"5.."}[5m]))
      - record: shop:checkout:total_5m
        expr: sum(rate(shop_checkout_requests_total[5m]))
      - record: shop:checkout:error_ratio_5m
        expr: 1 - shop:checkout:good_5m / shop:checkout:total_5m
`;

// rules: [{ name, expr, for?, labels? }] as a rule file writes them.
const ruleFile = (rules) => `groups:
  - name: shop-alerts
    rules:
${rules.map((r) => [
    `      - alert: ${r.name}`,
    `        expr: ${r.expr}`,
    ...(r.for ? [`        for: ${r.for}`] : []),
    ...(r.labels ? ['        labels:', ...Object.entries(r.labels).map(([k, v]) => `          ${k}: ${v}`)] : []),
  ].join('\n')).join('\n')}
`;

const ERRORS_HIGH = { name: 'ShopCheckoutErrorsHigh', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', labels: { severity: 'critical', team: 'shop' } };
const DISK = { name: 'DiskAlmostFull', expr: 'node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1', labels: { severity: 'warning' } };

const scan = (rules, files = {}) => crawlFiles(
  { 'rules/recording.yml': RECORDING, 'rules/alerts.yml': ruleFile(rules), ...files },
  { repoName: 'shop', environment: 'prod', now: '2026-11-16T00:00:00.000Z' },
).canonical;

const SECONDS = { '2m': 120, '5m': 300, '10m': 600, '30m': 1800, '2h': 7200 };
const probe = (name) => PROBES.find((p) => p.name === name);
// The ruler's listing of the same rules. `projection` (the default) is what an MCP that projects the ruler's answer
// gives: `query` for expr with a trailing newline, `duration` in seconds, a flat `severity` and no labels map.
// `labels` gives each rule its labels map instead, as a ruler's own API does.
const SEARCH_RECORDING = [
  { name: 'shop:search:good_5m', type: 'recording', health: 'ok', query: 'sum(rate(shop_search_requests_total{code!~"5.."}[5m]))\n' },
  { name: 'shop:search:total_5m', type: 'recording', health: 'ok', query: 'sum(rate(shop_search_requests_total[5m]))\n' },
  { name: 'shop:search:error_ratio_5m', type: 'recording', health: 'ok', query: '1 - shop:search:good_5m / shop:search:total_5m\n' },
];
function listing(rules, { shape = 'projection', recording = true, search = false } = {}) {
  const alerting = rules.map((r) => ({
    name: r.name, type: 'alerting', health: 'ok', state: 'inactive',
    query: `${r.expr}\n`,
    duration: r.for ? (SECONDS[r.for] ?? r.for) : 0,
    ...(shape === 'labels' ? { labels: { ...(r.labels || {}) } } : (r.labels?.severity ? { severity: r.labels.severity } : {})),
    ...(r.omitQuery ? { query: undefined } : {}),
  }));
  return { groups: [
    ...(recording ? [{ name: 'shop', interval: 30, rules: [
      { name: 'shop:checkout:good_5m', type: 'recording', health: 'ok', query: 'sum(rate(shop_checkout_requests_total{code!~"5.."}[5m]))\n' },
      { name: 'shop:checkout:total_5m', type: 'recording', health: 'ok', query: 'sum(rate(shop_checkout_requests_total[5m]))\n' },
      { name: 'shop:checkout:error_ratio_5m', type: 'recording', health: 'ok', query: '1 - shop:checkout:good_5m / shop:checkout:total_5m\n' },
      ...(search ? SEARCH_RECORDING : []),
    ] }] : []),
    { name: 'shop-alerts', interval: 30, rules: alerting },
  ] };
}
function live(rules, options = {}, annotations = {}) {
  const answer = listing(rules, options);
  const pack = buildCanonicalPack({
    refreshedAt: '2026-11-16T00:00:00Z', mcpUrl: 'https://mcp.shop.example/mcp', packName: 'production-live',
    health: { services: [{ name: 'shop' }] }, topology: { dependencies: [] }, capabilities: null,
    probeResults: {
      recording_rules: { tool: 'vmalert_rules', outcome: 'data', adapted: probe('recording_rules').adapt(answer) },
      alert_rules: { tool: 'vmalert_rules', outcome: 'data', adapted: probe('alert_rules').adapt(answer) },
    },
    probeFailures: {},
  });
  Object.assign(pack.metadata.annotations, annotations);
  return pack;
}

const stated = (pack, key = KEY) => parseSourceRulesAnnotation(pack.metadata.annotations[key]);
const without = (pack) => {
  const copy = structuredClone(pack);
  for (const k of Object.keys(copy.metadata.annotations)) if (k.startsWith(SOURCE_RULES_ANNOTATION_PREFIX)) delete copy.metadata.annotations[k];
  return copy;
};
function compare(repoPack, livePack) {
  const a = adapt(repoPack, { environment: 'prod' });
  const b = adapt(livePack, {});
  const diff = diffPacks(a, b, {});
  const pair = Object.values(diff.layers).flatMap((l) => l.inBoth).find((e) => e.key.startsWith('burn_rate::'));
  const chains = comparePackBranches(a, b);
  const branch = chains.branches.find((x) => x.nodes.some((n) => n.kind === 'burn_rate'));
  const node = branch?.nodes.find((n) => n.kind === 'burn_rate');
  return { a, b, diff, pair, chains, branch, node };
}
const fieldsOf = (deltas) => deltas.map((d) => `${d.rule ?? '-'}:${d.field}`).sort();

// ---------------------------------------------------------------------------
// The reading and the statement
// ---------------------------------------------------------------------------

test('sourceRuleTerms: every rule on an SLO\'s series, by SLO, read as an operational rule is read — a file and a listing give one list', () => {
  const hasSlo = (id) => id === SLO;
  const fromFile = sourceRuleTerms([
    { alert: 'B', expr: 'shop:checkout:error_ratio_5m > 0.05', for: '600s', labels: { severity: 'warning' } },
    { alert: 'A', expr: 'shop:checkout:error_ratio_5m > 0.01\n', for: '5m', labels: { severity: 'critical', team: 'shop' }, annotations: { summary: 'x' } },
    { alert: 'A', expr: 'shop:checkout:error_ratio_5m > 0.001', labels: { severity: 'page' } },
    { alert: 'Disk', expr: 'node_filesystem_avail_bytes < 1' },
    { alert: 'NoExpr' },
    { expr: 'shop:checkout:error_ratio_5m > 1' },
  ], hasSlo);
  assert.deepEqual([...fromFile.keys()], [SLO]);
  assert.deepEqual(fromFile.get(SLO), [
    { name: 'A', expr: 'shop:checkout:error_ratio_5m > 0.001', severity: 'SEV1', labels: { severity: 'page' } },
    { name: 'A', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', severity: 'SEV1', labels: { severity: 'critical', team: 'shop' } },
    { name: 'B', expr: 'shop:checkout:error_ratio_5m > 0.05', for: '10m', severity: 'SEV2', labels: { severity: 'warning' } },
  ], 'sorted by name then expression; both rules of one name kept; annotations, a rule with no link, no expression or no name left out');
  const fromRuler = sourceRuleTerms([
    { name: 'A', query: 'shop:checkout:error_ratio_5m > 0.01\n', duration: 300, labels: { severity: 'critical' }, labelsObserved: ['severity'] },
  ], hasSlo, { partialOf: (r) => (r.labelsObserved ? { labels: r.labelsObserved } : null) });
  assert.deepEqual(fromRuler.get(SLO), [{ name: 'A', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', severity: 'SEV1', labels: { severity: 'critical' }, partial: { labels: ['severity'] } }],
    '`query` for expr, `duration` seconds for `for`, and what the listing showed of the labels rides with the rule');
  // The complement of operationalAlertRules, rule for rule.
  const rules = [{ alert: 'A', expr: 'shop:checkout:error_ratio_5m > 0.01' }, { alert: 'Disk', expr: 'node_filesystem_avail_bytes < 1' }];
  const operational = operationalAlertRules(rules, hasSlo).kept.map((r) => r.name);
  const folded = [...sourceRuleTerms(rules, hasSlo).values()].flat().map((r) => r.name);
  assert.deepEqual([operational, folded], [['Disk'], ['A']], 'a rule is an operational rule or a source rule, never both, never neither');
  assert.equal(sourceRuleTerms(null, hasSlo).size, 0);
  // Two rules of one name and one expression: the list is in one order whichever was read first.
  const page = { alert: 'A', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '2m', labels: { severity: 'critical', team: 'shop' } };
  const ticket = { alert: 'A', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '10m', labels: { team: 'shop', severity: 'warning' } };
  assert.deepEqual(sourceRuleTerms([page, ticket], hasSlo).get(SLO), sourceRuleTerms([ticket, page], hasSlo).get(SLO));
});

test('the annotation: keyed by SLO id, a JSON list, and it states nothing unless every item is a rule', () => {
  assert.equal(SOURCE_RULES_ANNOTATION_PREFIX, 'observogram.source_rules.');
  assert.equal(KEY, 'observogram.source_rules.policy.burn_rate_alerts.shop_checkout_99');
  assert.equal(sourceRulesAnnotationKey('ref:slos.shop_checkout_99'), KEY, 'the reference syntax is not part of the key');
  const terms = [{ name: 'A', expr: 'x:y:z > 1', for: '5m', severity: 'SEV1', labels: { severity: 'critical' }, partial: { labels: ['severity'] } }];
  assert.deepEqual(parseSourceRulesAnnotation(JSON.stringify(terms)), terms);
  assert.deepEqual(parseSourceRulesAnnotation(`${JSON.stringify(terms, null, 2)}\n`), terms, 'a long value is written over several lines and gains a newline through YAML');
  assert.deepEqual(parseSourceRulesAnnotation(JSON.stringify([{ name: 'A', expr: 'x', engine: 'loki', source: 'f#g/A', annotations: { a: 'b' }, unstated: ['expr'], labels: { n: 1, s: 'v' }, partial: { labels: ['a', 2], expr: [] } }])),
    [{ name: 'A', expr: 'x', labels: { s: 'v' }, partial: { labels: ['a'] } }], 'only what the comparison reads is kept');
  // A key that would reach an object's prototype is not copied.
  const hostile = parseSourceRulesAnnotation('[{"name":"A","expr":"x","labels":{"__proto__":"p","team":"shop"},"partial":{"__proto__":["labels"]}}]');
  assert.deepEqual(hostile, [{ name: 'A', expr: 'x', labels: { team: 'shop' } }]);
  assert.equal(Object.getPrototypeOf(hostile[0].labels), Object.prototype);
  for (const bad of [undefined, null, '', '   ', 'not json', '{}', '[]', '"A"', JSON.stringify([{ name: 'A' }]), JSON.stringify([{ expr: 'x' }]),
    JSON.stringify([{ name: 'A', expr: 'x' }, null]), JSON.stringify([{ name: 'A', expr: 'x' }, { name: 'B', expr: '' }])]) {
    assert.equal(parseSourceRulesAnnotation(bad), null, `states nothing: ${String(bad)}`);
  }
  // A list put on an artefact by hand that is not a list of rules states nothing either: no throw, no rule held.
  const entry = { id: 'POL-01', spec: { slo: SLO, windows: [] } };
  for (const list of [[null], ['A'], [{ name: 'A' }], [{ name: 'A', expr: 'x' }, 7], 'A', {}]) {
    assert.deepEqual(deltasOf({ ...entry, sourceRules: list }, { ...entry, sourceRules: [{ name: 'A', expr: 'y' }] }), []);
    assert.deepEqual(unobservedOf({ ...entry, sourceRules: list }, { ...entry, sourceRules: [{ name: 'A', expr: 'y' }] }), []);
  }
  assert.deepEqual(deltasOf({ ...entry, sourceRules: [{ name: 'A', expr: 'x' }] }, { ...entry, sourceRules: [{ name: 'a', expr: 'y' }] }).map((d) => d.field), ['expr', 'name'],
    'names pair whatever their case, and the case that differs is said, as for an operational rule');
});

test('the scan and the live fetch state the same rules, each beside its entry; the packs stay valid and the entry itself is untouched', () => {
  const repoPack = scan([ERRORS_HIGH, DISK]);
  const livePack = live([ERRORS_HIGH, DISK]);
  assert.deepEqual(validateCanonical(repoPack, SCHEMA), []);
  assert.deepEqual(validateCanonical(livePack, SCHEMA), []);
  const keysOf = (pack) => Object.keys(pack.metadata.annotations).filter((k) => k.startsWith(SOURCE_RULES_ANNOTATION_PREFIX));
  assert.deepEqual(keysOf(repoPack), [KEY], 'the scan writes the key the comparison reads (its own mirror of sourceRulesAnnotationKey)');
  assert.deepEqual(keysOf(livePack), [KEY]);
  assert.deepEqual(stated(repoPack), [{ name: 'ShopCheckoutErrorsHigh', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', severity: 'SEV1', labels: { severity: 'critical', team: 'shop' } }]);
  assert.deepEqual(stated(livePack), [{ name: 'ShopCheckoutErrorsHigh', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', severity: 'SEV1', labels: { severity: 'critical' }, partial: { labels: ['severity'] } }],
    'the listing gave a flat severity and no labels map: the rule says the severity is all it was shown');
  for (const pack of [repoPack, livePack]) {
    assert.deepEqual(Object.keys(pack.spec.policy.burn_rate_alerts[0]).sort(), ['slo', 'windows'], 'the entry is the spec\'s closed shape');
    assert.ok(!(pack.spec.alerting.rules || []).some((r) => r.name === 'ShopCheckoutErrorsHigh'), 'and the rule is still in one place: not in alerting.rules');
  }
  // Through YAML and back, as a stored pack travels.
  assert.deepEqual(stated(parseYaml(emitYaml(repoPack))), stated(repoPack));
  // On the artefact: beside the spec, never in it; no statement, no key.
  const pol = adapt(repoPack, { environment: 'prod' }).layers.L4.policy[0];
  assert.deepEqual(pol.sourceRules, stated(repoPack));
  assert.deepEqual(Object.keys(pol.spec).sort(), ['slo', 'windows']);
  const bare = adapt(without(repoPack), { environment: 'prod' }).layers.L4.policy[0];
  assert.ok(!('sourceRules' in bare), 'a pack that states none adds no key to the artefact');
  const { sourceRules: _rules, ...rest } = pol;
  assert.deepEqual(rest, bare, 'and is otherwise the artefact it always was');
});

// ---------------------------------------------------------------------------
// The fault: a rule loosened in production
// ---------------------------------------------------------------------------

test('the same rule on both sides is aligned, and every number is what it was without the statement', () => {
  const repoPack = scan([ERRORS_HIGH, DISK]);
  const livePack = live([ERRORS_HIGH, DISK]);
  const now = compare(repoPack, livePack);
  assert.equal(now.pair.match, 'aligned');
  assert.deepEqual(now.pair.deltas, []);
  assert.equal(now.node.status, 'aligned');
  const before = compare(without(repoPack), without(livePack));
  const { partlyCompared: nowPartly, ...nowSummary } = now.diff.summary;
  const { partlyCompared: beforePartly, ...beforeSummary } = before.diff.summary;
  assert.deepEqual(nowSummary, beforeSummary, 'the flat counts');
  assert.deepEqual(now.chains.rollup, before.chains.rollup, 'the chains');
  assert.deepEqual([now.branch.verdict, now.branch.integrity], [before.branch.verdict, before.branch.integrity]);
  // What is new is said, not hidden: the file's `team` label was never shown by the listing.
  assert.deepEqual(now.pair.unobserved, [{ field: 'labels', side: 'b', keys: ['team'], rule: 'ShopCheckoutErrorsHigh' }]);
  assert.equal(nowPartly, (beforePartly || 0) + 1, 'one more alert rule compared without labels the live side does not show');
});

test('a rule loosened live — threshold, wait, severity — is a difference in the flat diff and in the requirement chain', () => {
  const repoPack = scan([ERRORS_HIGH, DISK]);
  const same = compare(repoPack, live([ERRORS_HIGH, DISK]));
  const loose = compare(repoPack, live([{ ...ERRORS_HIGH, expr: 'shop:checkout:error_ratio_5m > 0.5', for: '2h', labels: { severity: 'info', team: 'shop' } }, DISK]));
  // The entries themselves are still equal: the default pair on both sides.
  assert.deepEqual(loose.pair.a.spec, loose.pair.b.spec);
  assert.equal(loose.pair.match, 'drifted');
  assert.deepEqual(loose.pair.deltas, [
    { field: 'expr', a: 'shop:checkout:error_ratio_5m>0.01', b: 'shop:checkout:error_ratio_5m>0.5', rule: 'ShopCheckoutErrorsHigh' },
    { field: 'for', a: '5m', b: '2h', rule: 'ShopCheckoutErrorsHigh' },
    { field: 'labels', a: { severity: 'critical' }, b: { severity: 'info' }, rule: 'ShopCheckoutErrorsHigh' },
    { field: 'severity', a: 'SEV1', b: 'SEV3', rule: 'ShopCheckoutErrorsHigh' },
  ], 'each term of the rule, under the alert rule\'s own field names, with the rule\'s name beside them');
  assert.equal(loose.diff.summary.drifted, same.diff.summary.drifted + 1);
  assert.equal(loose.diff.summary.aligned, same.diff.summary.aligned - 1);
  // The chain, which the grade's Drift-free and the board's promises read.
  assert.equal(loose.node.status, 'drifted');
  assert.deepEqual(loose.node.deltas.map((d) => d.field), ['expr', 'for', 'labels', 'severity']);
  assert.ok(loose.branch.integrity < same.branch.integrity, `integrity ${same.branch.integrity} → ${loose.branch.integrity}`);
  assert.ok(loose.chains.rollup.integrityMean < same.chains.rollup.integrityMean);
  // Before the statement: aligned, as the fault was.
  const blind = compare(without(repoPack), without(live([{ ...ERRORS_HIGH, expr: 'shop:checkout:error_ratio_5m > 0.5', for: '2h', labels: { severity: 'info', team: 'shop' } }, DISK])));
  assert.equal(blind.pair.match, 'aligned');
  assert.equal(blind.node.status, 'aligned');
});

test('one term at a time: the threshold, the wait, the severity', () => {
  const repoPack = scan([ERRORS_HIGH]);
  const against = (change) => compare(repoPack, live([{ ...ERRORS_HIGH, ...change }])).pair;
  assert.deepEqual(fieldsOf(against({ expr: 'shop:checkout:error_ratio_5m > 0.02' }).deltas), ['ShopCheckoutErrorsHigh:expr']);
  assert.deepEqual(fieldsOf(against({ expr: 'shop:checkout:error_ratio_5m >= 0.01' }).deltas), ['ShopCheckoutErrorsHigh:expr']);
  assert.deepEqual(fieldsOf(against({ for: '10m' }).deltas), ['ShopCheckoutErrorsHigh:for']);
  assert.deepEqual(fieldsOf(against({ for: undefined }).deltas), ['ShopCheckoutErrorsHigh:for'], 'no wait at all is a wait that differs');
  assert.deepEqual(fieldsOf(against({ labels: { severity: 'warning', team: 'shop' } }).deltas), ['ShopCheckoutErrorsHigh:labels', 'ShopCheckoutErrorsHigh:severity']);
  // Re-printed, not changed: spacing, a trailing newline, seconds for the wait.
  assert.deepEqual(against({ expr: 'shop:checkout:error_ratio_5m   >   0.01' }).deltas, []);
  // A listing that gives the labels map is read whole: a label that differs is a difference, one that is equal is not.
  const whole = (labels) => compare(repoPack, live([{ ...ERRORS_HIGH, labels }], { shape: 'labels' })).pair;
  assert.deepEqual(whole({ severity: 'critical', team: 'shop' }).deltas, []);
  assert.equal(whole({ severity: 'critical', team: 'shop' }).unobserved, undefined, 'compared whole: nothing to note');
  assert.deepEqual(whole({ severity: 'critical', team: 'payments' }).deltas, [
    { field: 'labels', a: { severity: 'critical', team: 'shop' }, b: { severity: 'critical', team: 'payments' }, rule: 'ShopCheckoutErrorsHigh' },
  ]);
});

// ---------------------------------------------------------------------------
// No new false difference
// ---------------------------------------------------------------------------

test('a pack that states no rules holds the other to nothing: the pair compares as it did before', () => {
  const repoPack = scan([ERRORS_HIGH]);
  const loosened = live([{ ...ERRORS_HIGH, expr: 'shop:checkout:error_ratio_5m > 0.5' }]);
  for (const [a, b, label] of [[repoPack, without(loosened), 'a live pack kept from before'], [without(repoPack), loosened, 'a scan kept from before']]) {
    const { pair, node } = compare(a, b);
    assert.equal(pair.match, 'aligned', label);
    assert.deepEqual(pair.deltas, [], label);
    assert.equal(pair.unobserved, undefined, label);
    assert.equal(node.status, 'aligned', label);
  }
  // And there the windows are still what is compared.
  const a = adapt(without(repoPack), { environment: 'prod' }).layers.L4.policy[0];
  const b = { ...a, spec: { ...a.spec, windows: [{ short: '1m', long: '1h', factor: 14, severity: 'SEV1' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV2' }] } };
  assert.deepEqual(deltasOf(a, b).map((d) => d.field), ['windows']);
  assert.deepEqual(deltasOf({ ...a, sourceRules: stated(repoPack) }, b).map((d) => d.field), ['windows'], 'one side stating rules changes nothing');
});

test('the rules are compared as well as the entry, never in its place: what read as a difference before still does', () => {
  // A wait changed on an SLO with two rules already showed, as a window: it still does, and now says which rule.
  const fast = { name: 'ShopErrorsFast', expr: 'shop:checkout:error_ratio_5m > 0.05', for: '2m', labels: { severity: 'critical' } };
  const slow = { name: 'ShopErrorsSlow', expr: 'shop:checkout:error_ratio_5m > 0.02', for: '30m', labels: { severity: 'warning' } };
  const repoPack = scan([fast, slow]);
  const livePack = live([fast, { ...slow, for: '2h' }]);
  const before = compare(without(repoPack), without(livePack)).pair;
  assert.deepEqual(before.deltas.map((d) => d.field), ['windows']);
  const now = compare(repoPack, livePack).pair;
  assert.deepEqual(now.deltas.slice(0, 1), before.deltas, 'the entry\'s own delta, as it was');
  assert.deepEqual(now.deltas.slice(1), [{ field: 'for', a: '30m', b: '2h', rule: 'ShopErrorsSlow' }]);
  // A statement left on a pack whose windows were then written by hand overrules nothing: the windows are still held.
  const edited = structuredClone(repoPack);
  edited.spec.policy.burn_rate_alerts[0].windows = [{ short: '5m', long: '1h', factor: 14.4, severity: 'SEV1' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV2' }];
  const held = compare(edited, live([fast, slow])).pair;
  assert.equal(held.match, 'drifted');
  assert.deepEqual(held.deltas.map((d) => d.field), ['windows']);
  // The compiler's own alerts, in a rule file and in the ruler that loaded it: the scan reads each wait as a window,
  // the live fetch the labels' windows. They differed on windows before; the rules themselves agree and add nothing.
  const compiled = [
    { name: 'shop_checkout_99_burn_14x_5m_1h', expr: 'shop:checkout:error_ratio_5m > 0.14', for: '2m', labels: { severity: 'SEV1', slo: SLO, burn_rate: '14', window_short: '5m', window_long: '1h' } },
    { name: 'shop_checkout_99_burn_6x_30m_6h', expr: 'shop:checkout:error_ratio_5m > 0.06', for: '5m', labels: { severity: 'SEV2', slo: SLO, burn_rate: '6', window_short: '30m', window_long: '6h' } },
  ];
  const fromFile = scan(compiled);
  const fromRuler = live(compiled, { shape: 'labels' });
  assert.deepEqual(stated(fromRuler).map((r) => r.name), compiled.map((r) => r.name), 'the live side states the two rules too');
  const compiledNow = compare(fromFile, fromRuler).pair;
  assert.deepEqual(compiledNow.deltas, compare(without(fromFile), without(fromRuler)).pair.deltas);
  assert.deepEqual(compiledNow.deltas.map((d) => d.field), ['windows']);
  assert.equal(compiledNow.b.source, 'Verified', 'the live entry is still the compiler-shaped, attested one');
});

test('rules under one name are paired closest first: by what they say, never by where a side lists them', () => {
  const warning = { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '10m', labels: { severity: 'warning' } };
  const critical = { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.05', for: '2m', labels: { severity: 'critical' } };
  const repoPack = scan([warning, critical]);
  assert.equal(stated(repoPack).length, 2, 'both are stated: the second of a name is not lost');
  assert.deepEqual(stated(scan([critical, warning])), stated(repoPack), 'in one order, whichever the file gives first');
  assert.deepEqual(compare(repoPack, live([critical, warning])).pair.deltas, []);
  const changed = compare(repoPack, live([{ ...critical, for: '5m' }, warning])).pair;
  assert.deepEqual(changed.deltas.map(({ nth: _nth, ...d }) => d), [{ field: 'for', a: '2m', b: '5m', rule: 'ShopErrors' }], 'the critical one changed its wait; the warning one is not blamed');
  assert.ok([1, 2].includes(changed.deltas[0].nth), 'and, the name holding two pairs, the delta says which of them it is');
  assert.deepEqual(compare(repoPack, live([warning, { ...critical, for: '5m' }])).pair.deltas, changed.deltas, 'the same answer whatever order the ruler lists them in');
  // Both changed their wait and their severity, neither its threshold: each pairs with the rule of its own
  // expression, though the other one would differ in fewer fields. Nothing here is a changed threshold.
  const both = compare(repoPack, live([{ ...critical, for: '10m', labels: { severity: 'warning' } }, { ...warning, for: '2m', labels: { severity: 'critical' } }])).pair;
  assert.deepEqual([...new Set(both.deltas.map((d) => d.field))].sort(), ['for', 'labels', 'severity']);
  assert.ok(!both.deltas.some((d) => d.field === 'expr'), 'no expression is reported changed');

  // More rules under the name in the repository than live runs — a rule file per environment, scanned whole. The one
  // live runs is held to the rule it is nearest to, its own, not to the first one listed: only its threshold moved.
  const perEnvironment = [
    { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '1m', labels: { severity: 'info' } },
    { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.02', for: '2m', labels: { severity: 'warning' } },
    { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.05', for: '5m', labels: { severity: 'critical' } },
  ];
  const three = scan(perEnvironment);
  const prodLoosened = live([{ ...perEnvironment[2], expr: 'shop:checkout:error_ratio_5m > 0.08' }]);
  const uneven = compare(three, prodLoosened).pair;
  assert.deepEqual(uneven.deltas, [{ field: 'expr', a: 'shop:checkout:error_ratio_5m>0.05', b: 'shop:checkout:error_ratio_5m>0.08', rule: 'ShopErrors' }]);
  // And the answer is its own mirror with the sides swapped.
  const swapped = compare(prodLoosened, three).pair;
  assert.deepEqual(swapped.deltas, uneven.deltas.map((d) => ({ ...d, a: d.b, b: d.a })));
  // A rule that matches whole takes the counterpart before one that only matches on the part it was shown: the
  // listing gave one rule and its severity alone, the repository holds that rule with and without a team label.
  const withTeam = { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', labels: { severity: 'critical', team: 'shop' } };
  const plain = { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', labels: { severity: 'critical' } };
  const whole = compare(scan([withTeam, plain]), live([plain])).pair;
  assert.deepEqual(whole.deltas, []);
  assert.equal(whole.unobserved, undefined, 'compared whole: the rule with nothing unseen was the one paired');
});

test('a rule only one side states is held against nothing: the entry reads as it did before', () => {
  // A rule may be missing from a side's list because that side never looked where it lives — another engine, a rule
  // scope, a file the scan did not read, a chart condition — so its absence is not said to be a rule that does not run.
  const twin = { name: 'ShopErrorsTwin', expr: 'shop:checkout:error_ratio_5m > 0.02', for: '5m', labels: { severity: 'warning' } };
  const slow = { name: 'ShopErrorsSlow', expr: 'shop:checkout:error_ratio_5m > 0.02', for: '30m', labels: { severity: 'warning' } };
  for (const [declared, running, label] of [
    [[ERRORS_HIGH, twin], [ERRORS_HIGH], 'declared only, the same wait as its sibling'],
    [[ERRORS_HIGH], [ERRORS_HIGH, twin], 'live only, the same wait'],
    [[ERRORS_HIGH, slow], [ERRORS_HIGH], 'declared only, another wait: the windows differ, as they did'],
    [[ERRORS_HIGH], [ERRORS_HIGH, slow], 'live only, another wait'],
  ]) {
    const repoPack = scan(declared);
    const livePack = live(running);
    const now = compare(repoPack, livePack).pair;
    const before = compare(without(repoPack), without(livePack)).pair;
    assert.deepEqual([now.match, now.deltas], [before.match, before.deltas], label);
    assert.ok(!now.deltas.some((d) => d.rule), label);
  }
  // The rule both sides do state is still held, whatever else one side lists.
  const loosened = compare(scan([ERRORS_HIGH, twin]), live([{ ...ERRORS_HIGH, expr: 'shop:checkout:error_ratio_5m > 0.5' }])).pair;
  assert.deepEqual(fieldsOf(loosened.deltas), ['ShopCheckoutErrorsHigh:expr']);
  // A rule the listing gave no expression cannot be placed on an SLO: it is in no list, and blames nothing.
  const unplaced = live([ERRORS_HIGH, { ...twin, omitQuery: true }]);
  assert.deepEqual(stated(unplaced).map((r) => r.name), ['ShopCheckoutErrorsHigh']);
  assert.deepEqual(compare(scan([ERRORS_HIGH, twin]), unplaced).pair.deltas, []);
});

test('labels a listing never showed are not a difference, and each rule compared in part is counted once', () => {
  const second = { name: 'ShopErrorsSlow', expr: 'shop:checkout:error_ratio_5m > 0.02', for: '30m', labels: { severity: 'warning', team: 'shop', tier: 'gold' } };
  const repoPack = scan([ERRORS_HIGH, second, DISK]);
  const { pair, diff } = compare(repoPack, live([ERRORS_HIGH, second, DISK]));
  assert.equal(pair.match, 'aligned');
  assert.deepEqual(pair.unobserved, [
    { field: 'labels', side: 'b', keys: ['team'], rule: 'ShopCheckoutErrorsHigh' },
    { field: 'labels', side: 'b', keys: ['team', 'tier'], rule: 'ShopErrorsSlow' },
  ]);
  assert.deepEqual(unobservedOf(pair.a, pair.b), pair.unobserved);
  assert.equal(diff.summary.partlyCompared, 2, 'two alert rules, in one burn-rate pair');
  // The severity the listing did show is compared.
  const changed = compare(repoPack, live([ERRORS_HIGH, { ...second, labels: { ...second.labels, severity: 'critical' } }, DISK])).pair;
  assert.deepEqual(fieldsOf(changed.deltas.filter((d) => d.rule)), ['ShopErrorsSlow:labels', 'ShopErrorsSlow:severity']);
  assert.deepEqual(changed.deltas.find((d) => d.field === 'labels'), { field: 'labels', a: { severity: 'warning' }, b: { severity: 'critical' }, rule: 'ShopErrorsSlow' }, 'reported on the shown key alone');
  // Two rules under ONE name, both compared in part, are two rules: the notes say which, and the count is 2 either way round.
  const fast = { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.05', for: '5m', labels: { severity: 'critical', team: 'shop' } };
  const slow = { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', labels: { severity: 'warning', team: 'shop' } };
  const sameName = compare(scan([fast, slow]), live([fast, slow]));
  assert.deepEqual(sameName.pair.unobserved.map((u) => [u.rule, u.nth, u.keys.join()]).sort(), [['ShopErrors', 1, 'team'], ['ShopErrors', 2, 'team']]);
  assert.equal(sameName.diff.summary.partlyCompared, 2);
  assert.equal(compare(live([fast, slow]), scan([fast, slow])).diff.summary.partlyCompared, 2);
});

test('an SLO any of whose rules holds a value the repository does not state itself states no rules, and compares as before', () => {
  const searchRecording = RECORDING.replaceAll('checkout', 'search').replace('groups:\n  - name: shop\n', '  - name: shop-search\n');
  const template = `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-rules
data:
  recording.yml: |
${(RECORDING + searchRecording).replace(/^/gm, '    ')}
  alerts.yml: |
    groups:
      - name: shop-alerts
        rules:
          - alert: ShopCheckoutErrorsHigh
            expr: shop:checkout:error_ratio_5m > {{ .Values.alerts.errorRatio }}
            for: 5m
            labels:
              severity: critical
          - alert: ShopCheckoutErrorsSlow
            expr: shop:checkout:error_ratio_5m > 0.02
            for: 30m
            labels:
              severity: warning
          - alert: ShopSearchErrorsHigh
            expr: shop:search:error_ratio_5m > 0.01
            for: 5m
            labels:
              severity: critical
`;
  const repoPack = crawlFiles({ 'charts/shop/templates/rules.yaml': template },
    { repoName: 'shop', environment: 'prod', now: '2026-11-16T00:00:00.000Z' }).canonical;
  const SEARCH_KEY = sourceRulesAnnotationKey('shop_search_99');
  assert.equal(stated(repoPack), null, 'the chart fills in one threshold on this SLO: neither of its two rules is stated');
  assert.deepEqual(stated(repoPack, SEARCH_KEY).map((r) => r.name), ['ShopSearchErrorsHigh'], 'the SLO whose rules the file states whole is');
  const rendered = [
    { name: 'ShopCheckoutErrorsHigh', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', labels: { severity: 'critical' } },
    { name: 'ShopCheckoutErrorsSlow', expr: 'shop:checkout:error_ratio_5m > 0.5', for: '30m', labels: { severity: 'warning' } },
    { name: 'ShopSearchErrorsHigh', expr: 'shop:search:error_ratio_5m > 0.5', for: '5m', labels: { severity: 'critical' } },
  ];
  const livePack = live(rendered, { search: true });
  const pairsOf = (a, b) => Object.fromEntries(Object.values(diffPacks(adapt(a, { environment: 'prod' }), adapt(b, {}), {}).layers)
    .flatMap((l) => l.inBoth).filter((e) => e.key.startsWith('burn_rate::')).map((e) => [e.a.spec.slo, e]));
  const now = pairsOf(repoPack, livePack);
  const before = pairsOf(without(repoPack), without(livePack));
  assert.deepEqual([now.shop_checkout_99.match, now.shop_checkout_99.deltas], [before.shop_checkout_99.match, before.shop_checkout_99.deltas],
    'that SLO compares exactly as it did: no rule of it is held to what live renders');
  assert.deepEqual(now.shop_search_99.deltas.filter((d) => d.rule), [{ field: 'expr', a: 'shop:search:error_ratio_5m>0.01', b: 'shop:search:error_ratio_5m>0.5', rule: 'ShopSearchErrorsHigh' }]);
  // The same for a value a deploy step substitutes, in a plain rule file.
  const substituted = scan([{ ...ERRORS_HIGH, expr: 'shop:checkout:error_ratio_5m > ${ERROR_RATIO}' }]);
  assert.equal(stated(substituted), null);
  assert.deepEqual(Object.keys(substituted.metadata.annotations).filter((k) => k.startsWith(SOURCE_RULES_ANNOTATION_PREFIX)), []);
});

test('the scan states no rules where the file does not say what the ruler will list, and a delta handed out is the caller\'s own', () => {
  const file = ({ group = '', expr = 'shop:checkout:error_ratio_5m > 0.01', wait = '5m', labels = '        labels:\n          severity: critical\n          team: shop\n' } = {}) => [
    'groups:', '  - name: shop-alerts', group, '    rules:', '      - alert: ShopCheckoutErrorsHigh', `        expr: ${expr}`, `        for: ${wait}`, labels,
  ].filter(Boolean).join('\n');
  const scanOf = (options) => scan([], { 'rules/alerts.yml': file(options) });
  assert.equal(stated(scanOf({})).length, 1, 'the control states its rule');
  const notStated = {
    'a labels map filled in whole': { labels: '        labels: ${RULE_LABELS}\n' },
    'labels the group gets filled in whole': { group: '    labels: ${GROUP_LABELS}' },
    'a label a deploy step fills in on the group': { group: '    labels:\n      owner: ${OWNER}' },
    'an alias to an anchor the file does not define': { labels: '        labels: *page\n' },
    'a merge key whose anchor the file does not define': { labels: '        labels:\n          <<: *common\n          severity: critical\n' },
    'a threshold substituted at deploy time, without braces': { expr: 'shop:checkout:error_ratio_5m > $ERROR_RATIO' },
    'a threshold a template engine fills in': { expr: 'shop:checkout:error_ratio_5m > {{ .threshold }}' },
    'a wait substituted at deploy time': { wait: '$WAIT' },
    'a label value substituted at deploy time': { labels: '        labels:\n          severity: critical\n          team: $TEAM\n' },
  };
  for (const [what, options] of Object.entries(notStated)) {
    const pack = scanOf(options);
    assert.equal(stated(pack), null, `states nothing: ${what}`);
    assert.equal(pack.spec.policy.burn_rate_alerts.some((e) => e.slo === SLO), true, `the entry is still there: ${what}`);
  }
  // What is the rule's own text is stated: a capture group, the ruler's own label templating, a word that merely
  // contains the chart placeholder's letters.
  const isStated = {
    'a capture group': { expr: 'label_replace(shop:checkout:error_ratio_5m, "service", "$1", "job", "(.*)-prod") > 0.05' },
    'a capture group in braces': { expr: 'label_replace(shop:checkout:error_ratio_5m, "service", "${1}", "job", "(.*)-prod") > 0.05' },
    'a label the ruler templates': { labels: '        labels:\n          severity: critical\n          instance: "{{ $labels.instance }}"\n' },
    'a label that holds the placeholder\'s letters': { labels: '        labels:\n          severity: critical\n          origin: helmvalues-repo\n' },
    'a quoted label value that starts with a star': { labels: '        labels:\n          severity: critical\n          hosts: "*.shop.example"\n' },
  };
  for (const [what, options] of Object.entries(isStated)) assert.equal(stated(scanOf(options))?.length, 1, `stated: ${what}`);

  // A delta's values are copies: what a caller does to one answer does not reach the next, nor the chain.
  const repoPack = scan([ERRORS_HIGH]);
  const moved = live([{ ...ERRORS_HIGH, labels: { severity: 'critical', team: 'payments' } }], { shape: 'labels' });
  const { a: polA, b: polB } = compare(repoPack, moved).pair;
  const first = deltasOf(polA, polB);
  assert.deepEqual(first.map((d) => d.field), ['labels']);
  const asGiven = structuredClone(first);
  first[0].a.team = '***';
  first[0].b.team = '***';
  assert.deepEqual(deltasOf(polA, polB), asGiven);
});

test('a rule file is read as the ruler reads it: the group\'s labels, anchors and merge keys, bare numbers and booleans, values over several lines', () => {
  const head = 'groups:\n  - name: shop-alerts\n';
  const disk = (labels) => `      - alert: DiskAlmostFull\n        expr: node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1\n${labels}`;
  const errors = (labels, expr = 'shop:checkout:error_ratio_5m > 0.01') => `      - alert: ShopCheckoutErrorsHigh\n        expr: ${expr}\n        for: 5m\n${labels}`;
  // Each file, the labels the ruler lists for each of its rules, the same for every form.
  const cases = {
    'labels the group gives every rule, the rule\'s own label winning': {
      file: `${head}    labels:\n      team: shop\n      severity: warning\n    rules:\n${disk('')}${errors('        labels:\n          severity: critical\n')}`,
      listed: { DiskAlmostFull: { severity: 'warning', team: 'shop' }, ShopCheckoutErrorsHigh: { severity: 'critical', team: 'shop' } },
    },
    'an anchor on one rule\'s labels, an alias on the next': {
      file: `${head}    rules:\n${disk('        labels: &page { severity: critical, team: shop }\n')}${errors('        labels: *page\n')}`,
      listed: { DiskAlmostFull: { severity: 'critical', team: 'shop' }, ShopCheckoutErrorsHigh: { severity: 'critical', team: 'shop' } },
    },
    'a merge key under the rule\'s own label': {
      file: `${head}    rules:\n${disk('        labels: &common\n          severity: warning\n          team: shop\n')}${errors('        labels:\n          <<: *common\n          severity: critical\n')}`,
      listed: { DiskAlmostFull: { severity: 'warning', team: 'shop' }, ShopCheckoutErrorsHigh: { severity: 'critical', team: 'shop' } },
    },
    'numbers and booleans written bare, as the ruler lists their text': {
      file: `${head}    labels:\n      tier: 01\n    rules:\n${disk('        labels:\n          severity: warning\n          ratio: 1.0\n')}${errors('        labels:\n          severity: critical\n          objective: 99.0\n          page: True\n')}`,
      listed: {
        DiskAlmostFull: { severity: 'warning', ratio: '1.0', tier: '01' },
        ShopCheckoutErrorsHigh: { severity: 'critical', objective: '99.0', page: 'True', tier: '01' },
      },
    },
    'an expression over several lines, as a YAML writer wraps one, with a rule after it': {
      file: `${head}    rules:\n${errors('        labels:\n          severity: critical\n          team: shop\n', 'shop:checkout:error_ratio_5m\n          > 0.01')}${disk('        labels:\n          severity: warning\n')}`.replace(
        'node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1', '"node_filesystem_avail_bytes /\n          node_filesystem_size_bytes < 0.1"'),
      listed: { ShopCheckoutErrorsHigh: { severity: 'critical', team: 'shop' }, DiskAlmostFull: { severity: 'warning' } },
    },
  };
  const ruleOf = (name, labels) => (name === 'DiskAlmostFull'
    ? { ...DISK, labels }
    : { ...ERRORS_HIGH, labels });
  const alertPair = (diff, name) => Object.values(diff.layers).flatMap((l) => l.inBoth).find((e) => e.key === `alert_rule::{"name":"${name.toLowerCase()}"}`);
  for (const [what, { file, listed }] of Object.entries(cases)) {
    const repoPack = scan([], { 'rules/alerts.yml': file });
    // The SLO's rule is stated with the labels the ruler lists; the operational rule is declared with them.
    assert.deepEqual(stated(repoPack)?.map((r) => [r.name, r.labels]), [['ShopCheckoutErrorsHigh', listed.ShopCheckoutErrorsHigh]], `stated as listed: ${what}`);
    const operational = repoPack.spec.alerting.rules.find((r) => r.name === 'DiskAlmostFull');
    assert.deepEqual(operational?.labels, listed.DiskAlmostFull, `the operational rule as listed: ${what}`);
    assert.equal(operational?.expr.replace(/\s+/g, ' '), DISK.expr, `the operational rule's whole expression: ${what}`);
    // Against the ruler's listing of the same rules: aligned, the statement held and the operational rule matched.
    const rules = Object.entries(listed).map(([name, labels]) => ruleOf(name, labels));
    for (const shape of ['labels', 'projection']) {
      const same = compare(repoPack, live(rules, { shape }));
      assert.equal(same.pair.match, 'aligned', `the same system is aligned (${shape}): ${what}`);
      assert.deepEqual(same.pair.deltas, [], `no rule blamed (${shape}): ${what}`);
      assert.equal(same.node.status, 'aligned', `the chain agrees (${shape}): ${what}`);
      assert.equal(alertPair(same.diff, 'DiskAlmostFull')?.match, 'aligned', `the operational rule matches (${shape}): ${what}`);
    }
    // A label changed live is the rule's difference.
    const moved = rules.map((r) => (r.name === 'ShopCheckoutErrorsHigh' ? { ...r, labels: { ...r.labels, severity: 'info' } } : r));
    const changed = compare(repoPack, live(moved, { shape: 'labels' }));
    assert.equal(changed.pair.match, 'drifted', `a label changed live is a difference: ${what}`);
    assert.deepEqual([...new Set(changed.pair.deltas.map((d) => `${d.rule}:${d.field}`))].sort(), ['ShopCheckoutErrorsHigh:labels', 'ShopCheckoutErrorsHigh:severity'], what);
  }
});

test('the labels one scan copies from rule groups into rules are bounded: past the budget a group states no rules, and the scan says so', () => {
  const groupFile = (rules, labels) => [
    'groups:', '  - name: shop-alerts', '    labels:', ...Array.from({ length: labels }, (_, i) => `      l${i}: v${i}`), '    rules:',
    ...Array.from({ length: rules }, (_, i) => `      - alert: ShopCheckoutErrorsHigh${i === 0 ? '' : i}\n        expr: shop:checkout:error_ratio_5m > 0.0${(i % 9) + 1}\n        labels:\n          severity: critical`),
  ].join('\n') + '\n';
  const crawl = (text) => crawlFiles({ 'rules/recording.yml': RECORDING, 'rules/alerts.yml': text }, { repoName: 'shop', environment: 'prod', now: '2026-11-16T00:00:00.000Z' });
  const under = crawl(groupFile(2, 3));
  assert.deepEqual(stated(under.canonical)?.find((r) => r.name === 'ShopCheckoutErrorsHigh')?.labels, { l0: 'v0', l1: 'v1', l2: 'v2', severity: 'critical' });
  const over = crawl(groupFile(501, 500));
  assert.equal(stated(over.canonical), null, 'past the budget the group states no rules');
  assert.ok(over.summary.warnings.some((w) => /the labels of group "shop-alerts" were not added to its 501 alerting rule\(s\): past 250000 label copies/.test(w)), 'and the scan says so');
  assert.ok(over.canonical.spec.policy.burn_rate_alerts.some((e) => e.slo === SLO), 'the entry is still there');
  // A rule file whose aliases use over half the scan's budget, its labels holding a bare number: the second reading
  // (numbers and booleans as written) is apart from that budget and made once, so its rules are kept.
  const heavy = [
    'groups:', '  - name: busy', '    rules:',
    ...Array.from({ length: 3 }, (_, i) => [
      `      - alert: Busy${i}`, `        expr: node_load1{job="j${i}"} > 4`, '        labels:', '          severity: warning', '          priority: 2',
      ...(i === 0 ? ['        annotations:', '          a0: &a0 [{a: 1, b: 2}]', ...Array.from({ length: 12 }, (_, k) => `          a${k + 1}: &a${k + 1} [*a${k}, *a${k}]`)] : []),
    ].join('\n')),
  ].join('\n') + '\n';
  const kept = scan([], { 'rules/alerts.yml': heavy });
  assert.deepEqual(kept.spec.alerting.rules.filter((r) => /^Busy/.test(r.name)).map((r) => [r.name, r.labels.priority]), [['Busy0', '2'], ['Busy1', '2'], ['Busy2', '2']]);
  // Past the budget the group's labels are not looked at again for each rule: the scan stays fast.
  const t0 = Date.now();
  crawl(groupFile(1000, 20000));
  assert.ok(Date.now() - t0 < 3000, `a thousand rules under twenty thousand group labels scan in ${Date.now() - t0} ms`);
});

test('not covered: a rule whose alert name an earlier rule took leaves its SLO without an entry live, so nothing there states it', () => {
  // The fold reads the first rule of an alert name, on both sides. Here that one guards no SLO, so the SLO's own rule
  // of that name never becomes an entry on the live side and is in no list there: it is compared with nothing.
  const down = { name: 'ShopErrors', expr: 'up{job="shop"} == 0', labels: { severity: 'critical' } };
  const onSeries = { name: 'ShopErrors', expr: 'shop:checkout:error_ratio_5m > 0.01', for: '5m', labels: { severity: 'critical' } };
  const livePack = live([down, { ...onSeries, expr: 'shop:checkout:error_ratio_5m > 0.5' }]);
  assert.equal(stated(livePack), null);
  assert.equal(compare(scan([down, onSeries]), livePack).pair, undefined, 'no pair of burn-rate entries, so no rule is held');
});
