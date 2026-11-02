#!/usr/bin/env node
/**
 * tools/test-lifecycle.mjs
 *
 * A statement that rules were authored ahead of an environment
 * (tools/lib/lifecycle.mjs): the comment block is read or warned about, the
 * crawler covers only what one file alone declares, the adapter stamps it and
 * tools/lib/diff.mjs parks an unpaired artefact whose state for the compared
 * environment is explicitly not deployed. A pack with no statement gains no key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawlFiles } from './lib/crawler.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { foldMetricFamilies } from './lib/artefact-model.mjs';
import { alertStatesFromDiff } from './lib/remediation-flow.mjs';
import { evaluateGate } from './lib/journey.mjs';
import {
  LIFECYCLE_ANNOTATION, readLifecycleBlock, lifecycleBySymbol, lifecycleStateFor, normalizeLifecycleEnvironment,
} from './lib/lifecycle.mjs';

const NOW = '2026-11-02T00:00:00.000Z';
const BLOCK = (state = 'planned', env = 'prod') => `# observogram-lifecycle:\n#   maturity: authored\n#   deployment:\n#     ${env}: ${state}\n#     staging: deployed\n`;
const RULES = (service, extra = '') => `groups:
  - name: ${service}-slo
    rules:
      - record: ${service}:availability:good
        expr: sum(rate(${service}_requests_total{code!~"5.."}[5m]))
      - record: ${service}:availability:total
        expr: sum(rate(${service}_requests_total[5m]))
      - alert: ${service}AvailabilityBurn
        expr: 1 - ${service}:availability:good / ${service}:availability:total > 0.01
        for: 5m
      - alert: ${service}QueueStuck
        expr: ${service}_queue_depth > 100
${extra}`;
const crawl = (files, environment) => {
  const out = crawlFiles(files, { repoName: 'acme', now: NOW, ...(environment ? { environment } : {}) });
  return out;
};
const empty = (environment = 'prod') => {
  const pack = crawl({ 'rules/other.rules.yml': RULES('other') }).canonical;
  return { pack, environment };
};
const keysOf = (entries) => entries.map(e => e.key);
const allOf = (diff, bucket) => Object.values(diff.layers).flatMap(l => l[bucket] || []);
const statementOf = (canonical) => JSON.parse(canonical.metadata.annotations[LIFECYCLE_ANNOTATION]);

test('the block reads: maturity and a nested deployment, environments in one spelling', () => {
  assert.deepEqual(readLifecycleBlock(`${BLOCK()}groups: []\n`), { statement: { maturity: 'authored', deployment: { prod: 'planned', stg: 'deployed' } } });
  assert.equal(readLifecycleBlock('groups: []\n# a comment\n'), null, 'no block, no answer');
  assert.equal(readLifecycleBlock(undefined), null);
  assert.deepEqual(readLifecycleBlock('  # observogram-lifecycle:\n  #   deployment:\n  #     production: not-deployed\ngroups: []\n').statement, { deployment: { prod: 'not-deployed' } });
  assert.equal(normalizeLifecycleEnvironment(' Production '), 'prod');
  assert.equal(normalizeLifecycleEnvironment('prd'), 'prod');
  assert.equal(normalizeLifecycleEnvironment('stage'), 'stg');
  assert.ok(readLifecycleBlock(`# a header\n---\n{{- if .Values.rules }}\n${BLOCK()}groups: []\n`).statement, 'comments, a document marker and a Helm directive may stand above it');
});

test('a block that does not read says why and never quotes the file', () => {
  const secret = 'hunter2';
  const cases = [
    `# observogram-lifecycle:\n#   maturity: authored\n`,
    `# observogram-lifecycle:\n#   deployment:\n#     prod: ${secret}\n`,
    `# observogram-lifecycle:\n#   deployment: { prod: planned }\n`,
    `# observogram-lifecycle:\n#   owner: ${secret}\n`,
    `# observogram-lifecycle:\n#   deployment:\n#     prod:\n`,
    `# observogram-lifecycle:\n#   deployment:\n#     prod: planned\n#     production: deployed\n`,
    `${BLOCK()}${BLOCK()}`,
  ];
  for (const text of cases) {
    const read = readLifecycleBlock(text);
    assert.ok(read.problem, text);
    assert.ok(!read.problem.includes(secret), read.problem);
  }
});

test('a block ends at the first line that is not indented under the marker', () => {
  const read = readLifecycleBlock(`${BLOCK()}# deployment:\n#   prod: deployed\n`);
  assert.deepEqual(read.statement.deployment, { prod: 'planned', stg: 'deployed' });
});

test('the crawler covers what the file declares, and the annotation names it', () => {
  const { canonical, summary } = crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}` });
  const [statement, ...rest] = statementOf(canonical);
  assert.equal(rest.length, 0);
  assert.equal(statement.source, 'rules/acme.rules.yml');
  assert.deepEqual(statement.deployment, { prod: 'planned', stg: 'deployed' });
  for (const symbol of [
    'queries.recording_rules.acme:availability:good',
    'queries.recording_rules.acme:availability:total',
    'slis.acme_availability', 'slos.acme_availability_99',
    'policy.burn_rate_alerts.acme_availability_99',
    'alerting.rules.acmeQueueStuck',
    'metrics.acme_requests_total', 'metrics.acme_queue_depth',
  ]) assert.ok(statement.symbols.includes(symbol), symbol);
  assert.deepEqual(statement.symbols, [...statement.symbols].sort());
  assert.equal(summary.discovered.lifecycleStatements, 1);
});

test('a symbol another file also speaks for is not covered: a statement hides only what its own file declares', () => {
  const shared = `groups:\n  - name: shared\n    rules:\n      - alert: SharedDepth\n        expr: acme_queue_depth > 5\n`;
  const { canonical } = crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}`, 'rules/shared.rules.yml': shared });
  const { symbols } = statementOf(canonical)[0];
  assert.ok(!symbols.includes('metrics.acme_queue_depth'), 'the metric the other file reads is not covered');
  assert.ok(symbols.includes('metrics.acme_requests_total'));
});

test('the crawl warns about a block it cannot read or that covers nothing, and carries no statement for it', () => {
  const bad = crawl({ 'rules/acme.rules.yml': `# observogram-lifecycle:\n#   deployment:\n#     prod: someday\n${RULES('acme')}` });
  assert.ok(!(LIFECYCLE_ANNOTATION in bad.canonical.metadata.annotations));
  assert.ok(bad.summary.warnings.some(w => w.startsWith('rules/acme.rules.yml: the lifecycle block is not read')), bad.summary.warnings);
  assert.ok(!bad.summary.warnings.some(w => w.includes('someday')));
  const hollow = crawl({ 'rules/none.rules.yml': `${BLOCK()}groups:\n  - name: g\n    rules: []\n` });
  assert.ok(hollow.summary.warnings.some(w => w.startsWith('rules/none.rules.yml: the lifecycle block covers nothing')), hollow.summary.warnings);
});

test('with recorded SLIs absent, the ids an alert derives are covered too', () => {
  const rules = `${BLOCK()}groups:\n  - name: g\n    rules:\n      - alert: OrdersBurn\n        expr: orders_errors_total > 1\n`;
  const { canonical } = crawl({ 'rules/orders.rules.yml': rules });
  const { symbols } = statementOf(canonical)[0];
  const layered = adapt(canonical);
  const stamped = Object.values(layered.layers).flatMap(l => Array.isArray(l) ? l : Object.values(l).flat()).filter(a => a?.lifecycle);
  assert.ok(symbols.some(s => s.startsWith('policy.burn_rate_alerts.')) && symbols.some(s => s.startsWith('slos.')) && symbols.some(s => s.startsWith('slis.')), symbols);
  assert.ok(stamped.some(a => a.id.startsWith('POL-')) && stamped.some(a => a.id.startsWith('SLO-')) && stamped.some(a => a.id.startsWith('SLI-')), stamped.map(a => a.id));
});

test('an annotation that does not read is left out, and the first statement naming a symbol holds it', () => {
  assert.equal(lifecycleBySymbol('{not json').size, 0);
  assert.equal(lifecycleBySymbol('{"a":1}').size, 0);
  assert.equal(lifecycleBySymbol(undefined).size, 0);
  assert.equal(lifecycleBySymbol(JSON.stringify([{ symbols: ['slis.a'], deployment: { prod: 'someday' } }])).size, 0);
  const map = lifecycleBySymbol(JSON.stringify([
    { source: 'one.yml', symbols: ['slis.a', 7], deployment: { production: 'planned' } },
    { source: 'two.yml', symbols: ['slis.a', 'slis.b'], deployment: { prod: 'deployed' } },
  ]));
  assert.equal(map.get('slis.a').source, 'one.yml');
  assert.equal(map.get('slis.b').source, 'two.yml');
  assert.equal(map.size, 2);
  assert.equal(lifecycleStateFor(map.get('slis.a'), 'prod'), 'planned');
  assert.equal(lifecycleStateFor(map.get('slis.a'), 'staging'), null);
  assert.equal(lifecycleStateFor(null, 'prod'), null);
  assert.equal(lifecycleStateFor({ deployment: { prod: 'someday' } }, 'prod'), null);
});

test('declared ahead: nothing of the file reads declared-not-live, and the ratios do not count it', () => {
  const ahead = crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}` }).canonical;
  const plain = crawl({ 'rules/acme.rules.yml': RULES('acme') }).canonical;
  const live = empty().pack;
  const d = diffPacks(adapt(ahead), adapt(live), { environment: 'prod', scopeMode: 'all' });
  const without = diffPacks(adapt(plain), adapt(live), { environment: 'prod', scopeMode: 'all' });
  const parked = allOf(d, 'declaredAhead');
  assert.ok(parked.length >= 6, keysOf(parked));
  assert.ok(parked.every(e => e.side === 'a' && /^Declared ahead: planned in prod, as rules\/acme\.rules\.yml states\.$/.test(e.reason)), parked.map(e => e.reason));
  assert.ok(!allOf(d, 'onlyInA').some(e => /acme/i.test(e.key)), keysOf(allOf(d, 'onlyInA')));
  assert.equal(d.summary.declaredAhead, parked.length);
  assert.deepEqual(d.summary.lifecycleEnvironments, ['prod']);
  assert.equal(d.summary.union, without.summary.union - parked.length, 'parked artefacts leave the union');
  assert.ok(d.summary.alignment >= without.summary.alignment);
});

test('the state decides: deployed, or an environment the statement does not name, reads as usual', () => {
  const live = empty().pack;
  const deployed = crawl({ 'rules/acme.rules.yml': `${BLOCK('deployed')}${RULES('acme')}` }).canonical;
  const d = diffPacks(adapt(deployed), adapt(live), { environment: 'prod', scopeMode: 'all' });
  assert.equal(d.summary.declaredAhead, 0);
  assert.ok(allOf(d, 'onlyInA').some(e => /acme/i.test(e.key)));
  const elsewhere = crawl({ 'rules/acme.rules.yml': `${BLOCK('planned', 'dr')}${RULES('acme')}` }).canonical;
  const e = diffPacks(adapt(elsewhere), adapt(live), { environment: 'prod', scopeMode: 'all' });
  assert.equal(e.summary.declaredAhead, 0, 'prod is not named');
  const dr = diffPacks(adapt(elsewhere), adapt(live), { environment: 'dr', scopeMode: 'all' });
  assert.ok(dr.summary.declaredAhead > 0, 'the option names the environment');
  assert.deepEqual(dr.summary.lifecycleEnvironments, ['dr']);
  const staged = diffPacks(adapt(elsewhere), adapt(live), { environment: 'staging', scopeMode: 'all' });
  assert.equal(staged.summary.declaredAhead, 0, 'an alias reads the same state: staging is deployed');
});

test('with no environment to compare for, nothing is parked and the summary says so', () => {
  const ahead = adapt(crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}` }).canonical);
  const live = adapt(empty().pack);
  delete ahead.meta.environment;
  delete live.meta.environment;
  const d = diffPacks(ahead, live, { scopeMode: 'all' });
  assert.equal(d.summary.declaredAhead, 0);
  assert.deepEqual(d.summary.lifecycleEnvironments, []);
  assert.ok(allOf(d, 'onlyInA').some(e => /acme/i.test(e.key)));
});

test('an artefact that pairs is compared as usual, with no delta from its statement', () => {
  const ahead = adapt(crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}` }).canonical);
  const plain = adapt(crawl({ 'rules/acme.rules.yml': RULES('acme') }).canonical);
  const d = diffPacks(ahead, plain, { environment: 'prod', scopeMode: 'all' });
  assert.equal(d.summary.declaredAhead, 0);
  assert.equal(d.summary.drifted, 0, allOf(d, 'inBoth').filter(e => e.match === 'drifted').map(e => e.key));
  assert.equal(d.summary.onlyInA, 0);
});

test('either side: a statement in pack B parks its artefact too', () => {
  const ahead = adapt(crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}` }).canonical);
  const live = adapt(empty().pack);
  const d = diffPacks(live, ahead, { environment: 'prod', scopeMode: 'all' });
  const parked = allOf(d, 'declaredAhead');
  assert.ok(parked.length && parked.every(e => e.side === 'b'), keysOf(parked));
  assert.ok(!allOf(d, 'onlyInB').some(e => /acme/i.test(e.key)));
});

test('notObserved wins: what could not be checked at all stays unchecked', () => {
  const ahead = crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}` }).canonical;
  const blind = empty().pack;
  blind.metadata.annotations['observogram.unobserved.alert_rule'] = 'no tool for it';
  const d = diffPacks(adapt(ahead), adapt(blind), { environment: 'prod', scopeMode: 'all' });
  assert.ok(allOf(d, 'notObserved').some(e => e.reason === 'no tool for it'), allOf(d, 'notObserved').map(e => e.reason));
  assert.ok(!allOf(d, 'declaredAhead').some(e => e.reason === 'no tool for it'));
  assert.ok(allOf(d, 'declaredAhead').length > 0, 'the other families are still parked');
});

test('every artefact of a group must say so', () => {
  const stamped = (id, state) => ({ id, title: 'x', spec: { name: 'x' }, tool: 'PrometheusRule', lifecycle: { source: 'f', deployment: { prod: state } } });
  const pack = (items) => ({ id: 'p', meta: { environment: 'prod', annotations: { [LIFECYCLE_ANNOTATION]: '[]' } }, layers: { L4: { policy: items } } });
  const same = diffPacks(pack([stamped('RULE-01', 'planned'), stamped('RULE-02', 'deployed')]), pack([]), { scopeMode: 'all' });
  assert.equal(same.summary.declaredAhead, 0);
});

test('a folded family keeps the statement only when every series carries it', () => {
  const metric = (name, lifecycle) => ({ id: name, title: name, type: 'metric', tags: ['metric'], tool: 'Prometheus metric', parent: 'telemetry.metric_inventory', spec: { name, metric_type: 'histogram', source: 'crawler.discovered' }, ...(lifecycle ? { lifecycle } : {}) });
  const planned = { source: 'a.yml', deployment: { prod: 'planned' } };
  const both = foldMetricFamilies([metric('x_bucket', planned), metric('x_count', planned), metric('x_sum', planned)], []).a[0];
  assert.deepEqual(both.lifecycle, planned);
  const partial = foldMetricFamilies([metric('x_bucket', planned), metric('x_count'), metric('x_sum', planned)], []).a[0];
  assert.ok(!('lifecycle' in partial));
  const otherFile = foldMetricFamilies([metric('x_bucket', planned), metric('x_count', { ...planned, source: 'b.yml' }), metric('x_sum', planned)], []).a[0];
  assert.deepEqual(otherFile.lifecycle, planned, 'two files that say the same agree');
});

test('no statement, no key: adapter and diff bytes are what they were', () => {
  const plain = crawl({ 'rules/acme.rules.yml': RULES('acme') }).canonical;
  const layered = adapt(plain);
  assert.ok(!JSON.stringify(layered).includes('lifecycle'));
  const d = diffPacks(layered, adapt(empty().pack), { environment: 'prod' });
  assert.ok(!('declaredAhead' in d.summary) && !('lifecycleEnvironments' in d.summary));
  assert.ok(Object.values(d.layers).every(l => !('declaredAhead' in l)));
});

test("the response path reads a parked alert as unverified, not missing", () => {
  const ahead = crawl({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}` }).canonical;
  const d = diffPacks(adapt(ahead), adapt(empty().pack), { environment: 'prod', scopeMode: 'all' });
  const states = [...alertStatesFromDiff(d).values()].map(s => s.state);
  assert.ok(states.includes('unverified'), states);
  assert.ok(allOf(d, 'declaredAhead').length > 0);
});

const AHEAD = (extra = {}) => ({ 'rules/acme.rules.yml': `${BLOCK()}${RULES('acme')}`, ...extra });
const symbolsOf = (files) => statementOf(crawl(files).canonical)[0].symbols;

test('a marker inside a YAML string is not a statement: a rule\'s prose cannot hide its file', () => {
  const quoted = `groups:
  - name: g
    rules:
      - alert: AcmeDown
        expr: up == 0
        annotations:
          description: |
            To mark a file, write:
            # observogram-lifecycle:
            #   deployment:
            #     prod: planned
`;
  const { canonical, summary } = crawl({ 'rules/acme.rules.yml': quoted });
  assert.ok(!(LIFECYCLE_ANNOTATION in canonical.metadata.annotations));
  assert.ok(summary.warnings.some(w => w.includes('the block must open the file')), summary.warnings);
  const expr = `groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: |\n          up == 0\n          # observogram-lifecycle:\n          #   deployment:\n          #     prod: planned\n`;
  assert.ok(readLifecycleBlock(expr).problem);
});

test('the environment: a repo read for staging against a pack bound to prod parks nothing deployed in either', () => {
  const live = empty().pack;
  const staged = crawl(AHEAD(), 'staging').canonical;
  const d = diffPacks(adapt(staged), adapt(live), { scopeMode: 'all' });
  assert.deepEqual(d.summary.lifecycleEnvironments, ['prod', 'stg']);
  assert.equal(d.summary.declaredAhead, 0, 'staging: deployed');
  assert.ok(allOf(d, 'onlyInA').some(e => /acme/i.test(e.key)));
  const both = crawl({ 'rules/acme.rules.yml': `# observogram-lifecycle:\n#   deployment:\n#     prod: planned\n#     staging: not-deployed\n${RULES('acme')}` }, 'staging').canonical;
  const parked = diffPacks(adapt(both), adapt(live), { scopeMode: 'all' });
  assert.ok(parked.summary.declaredAhead > 0, 'not deployed in either');
  assert.ok(allOf(parked, 'declaredAhead').every(e => e.reason.includes('planned in prod, not-deployed in stg')), allOf(parked, 'declaredAhead')[0].reason);
  const blankOption = diffPacks(adapt(crawl(AHEAD()).canonical), adapt(live), { environment: '  ', scopeMode: 'all' });
  assert.deepEqual(blankOption.summary.lifecycleEnvironments, ['prod'], 'a blank option falls through');
});

test('what reads a series speaks for it: an alert in another file keeps the SLO, the rules and the metric visible', () => {
  const guard = `groups:\n  - name: g\n    rules:\n      - alert: AcmeBurn\n        expr: 1 - acme:availability:good / acme:availability:total > 0.01\n`;
  const rules = `${BLOCK()}groups:\n  - name: s\n    rules:\n      - record: acme:availability:good\n        expr: sum(rate(acme_requests_total{code!~"5.."}[5m]))\n      - record: acme:availability:total\n        expr: sum(rate(acme_requests_total[5m]))\n`;
  const files = { 'rules/acme.rules.yml': rules, 'rules/z.rules.yml': guard };
  const { canonical, summary } = crawl(files);
  assert.ok(!(statementOf(canonical)[0].symbols.length), statementOf(canonical)[0].symbols);
  assert.ok(summary.warnings.some(w => w.includes('the lifecycle block covers nothing')), summary.warnings);
});

test('each kind stays visible when a second file also declares it', () => {
  const second = (body) => AHEAD({ 'rules/z.rules.yml': `groups:\n  - name: z\n    rules:\n${body}` });
  const rule = symbolsOf(second('      - record: acme:availability:good\n        expr: sum(rate(acme_requests_total[5m]))\n'));
  assert.ok(!rule.includes('queries.recording_rules.acme:availability:good') && !rule.includes('slis.acme_availability') && !rule.includes('slos.acme_availability_99'), rule);
  assert.ok(!rule.includes('metrics.acme_requests_total'), rule);
  const alert = symbolsOf(second('      - alert: acmeQueueStuck\n        expr: other_depth > 1\n'));
  assert.ok(!alert.includes('alerting.rules.acmeQueueStuck'), alert);
  const burn = symbolsOf(second('      - alert: AcmeFast\n        expr: 1 - acme:availability:good / acme:availability:total > 0.1\n'));
  assert.ok(!burn.includes('policy.burn_rate_alerts.acme_availability_99'), burn);
});

test('a second alert of the same derived SLO still speaks for the metric it reads', () => {
  const a = `${BLOCK()}groups:\n  - name: a\n    rules:\n      - alert: OrdersStuck\n        expr: orders_depth > 1\n`;
  const z = 'groups:\n  - name: z\n    rules:\n      - alert: OrdersStuck\n        expr: orders_depth > 100\n';
  assert.ok(!symbolsOf({ 'rules/a.rules.yml': a, 'rules/z.rules.yml': z }).includes('metrics.orders_depth'));
});

test('a manifest\'s dynamic family speaks for the names it matches', () => {
  const manifest = JSON.stringify({ exporter: 'acme-exporter', metrics: [], dynamicFamilies: [{ pattern: '^acme_queue_[a-z]+$' }] });
  const symbols = symbolsOf(AHEAD({ 'exporter/metrics-manifest.json': manifest }));
  assert.ok(!symbols.includes('metrics.acme_queue_depth'), symbols);
  assert.ok(symbols.includes('metrics.acme_requests_total'), symbols);
});

test('a Helm ConfigMap template: the block on top covers its alerts too', () => {
  const template = `${BLOCK()}apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "acme.fullname" . }}
data:
  acme.rules.yml: |
    groups:
      - name: acme
        rules:
          - record: acme:availability:good
            expr: sum(rate(acme_requests_total[5m]))
          - alert: AcmeStuck
            expr: acme_queue_depth > 100
`;
  const files = { 'charts/acme/Chart.yaml': 'apiVersion: v2\nname: acme\nversion: 0.1.0\n', 'charts/acme/templates/cm.yaml': template };
  const { canonical } = crawl(files);
  const { symbols, source } = statementOf(canonical)[0];
  assert.equal(source, 'charts/acme/templates/cm.yaml');
  assert.ok(symbols.includes('alerting.rules.AcmeStuck') && symbols.includes('queries.recording_rules.acme:availability:good'), symbols);
});

test('a burn alert no rule wrote goes with its SLO', () => {
  const rules = `${BLOCK()}groups:\n  - name: s\n    rules:\n      - record: acme:availability:good\n        expr: sum(rate(acme_requests_total[5m]))\n`;
  const { canonical } = crawl({ 'rules/acme.rules.yml': rules });
  const { symbols } = statementOf(canonical)[0];
  for (const a of canonical.spec.policy.burn_rate_alerts) assert.ok(symbols.includes(`policy.burn_rate_alerts.${a.slo}`), [a.slo, symbols]);
});

test('every spelling of a name finds its artefact', () => {
  const pack = crawl(AHEAD()).canonical;
  const burn = pack.spec.policy.burn_rate_alerts[0];
  const slo = burn.slo;
  for (const spelled of [slo, `ref:${slo}`, `slos.${slo}`, `ref:slos.${slo}`]) {
    const copy = structuredClone(pack);
    copy.spec.policy.burn_rate_alerts[0].slo = spelled;
    const stamped = adapt(copy).layers.L4.policy.find(a => a.id === 'POL-01');
    assert.ok(stamped.lifecycle, spelled);
  }
  const spaced = crawl({ 'rules/acme.rules.yml': `${BLOCK()}groups:\n  - name: g\n    rules:\n      - record: a:b:c\n        expr: up\n      - alert: "Spaced Name "\n        expr: other_depth > 1\n` }).canonical;
  assert.ok(statementOf(spaced)[0].symbols.includes('alerting.rules.Spaced Name'), statementOf(spaced)[0].symbols);
});

test('a folded family keeps nothing when the series disagree or carry no statement of their own', () => {
  const metric = (name, lifecycle) => ({ id: name, title: name, type: 'metric', tags: ['metric'], tool: 'Prometheus metric', parent: 'telemetry.metric_inventory', spec: { name, metric_type: 'histogram', source: 'crawler.discovered' }, ...(lifecycle ? { lifecycle } : {}) });
  const noSource = { deployment: { prod: 'planned' } };
  assert.ok(!('lifecycle' in foldMetricFamilies([metric('x_bucket', noSource), metric('x_count'), metric('x_sum')], []).a[0]), 'no source does not excuse an unstamped series');
  const states = foldMetricFamilies([metric('x_bucket', { source: 'a', deployment: { prod: 'planned' } }), metric('x_count', { source: 'a', deployment: { prod: 'deployed' } }), metric('x_sum', { source: 'a', deployment: { prod: 'planned' } })], []).a[0];
  assert.ok(!('lifecycle' in states), 'the states must agree');
});

test('service scope comes first on side B: an inventory outside the service is out of scope, not declared ahead', () => {
  const live = adapt(crawlFiles({ 'rules/other.rules.yml': RULES('other') }, { repoName: 'other', now: NOW }).canonical);
  const ahead = adapt(crawl(AHEAD()).canonical);
  const d = diffPacks(live, ahead, { environment: 'prod', scopeMode: 'service', service: 'other' });
  const parkedKeys = keysOf(allOf(d, 'declaredAhead'));
  assert.ok(!parkedKeys.some(k => k.startsWith('metric::')), parkedKeys);
  assert.ok(keysOf(allOf(d, 'outOfScope')).some(k => /acme/.test(k)), keysOf(allOf(d, 'outOfScope')));
});

test('a source longer than the limit is left out of the reason', () => {
  const map = lifecycleBySymbol(JSON.stringify([{ source: 'x'.repeat(513), symbols: ['slis.a'], deployment: { prod: 'planned' } }]));
  assert.ok(!('source' in map.get('slis.a')));
});

test('a gate can refuse what is parked; without the criterion it does not', () => {
  assert.deepEqual(evaluateGate({ maxDeclaredAhead: 0 }, { declaredAhead: 3 }).map(b => b.criterion), ['maxDeclaredAhead']);
  assert.equal(evaluateGate({ maxDeclaredAhead: 3 }, { declaredAhead: 3 }).length, 0);
  assert.equal(evaluateGate({ maxDeclaredAhead: 0 }, { declaredAhead: 0 }).length, 0);
  assert.equal(evaluateGate({}, { declaredAhead: 3 }).length, 0);
});

const SERIES = (s) => `groups:\n  - name: s\n    rules:\n      - record: ${s}:availability:good\n        expr: sum(rate(${s}_requests_total{code!~"5.."}[5m]))\n      - record: ${s}:availability:total\n        expr: sum(rate(${s}_requests_total[5m]))\n`;
const GUARD = (s) => `groups:\n  - name: g\n    rules:\n      - alert: ${s}Burn\n        expr: 1 - ${s}:availability:good / ${s}:availability:total > 0.01\n      - alert: ${s}Stuck\n        expr: ${s}_queue_depth > 100\n`;

test('rules and alerts split across two files with the same block both park', () => {
  const files = { 'rules/acme.rules.yml': `${BLOCK()}${SERIES('acme')}`, 'rules/acme.alerts.yml': `${BLOCK()}${GUARD('acme')}` };
  const { canonical, summary } = crawl(files);
  assert.ok(!summary.warnings.some(w => w.includes('covers nothing')), summary.warnings);
  const d = diffPacks(adapt(canonical), adapt(empty().pack), { environment: 'prod', scopeMode: 'all' });
  assert.ok(!allOf(d, 'onlyInA').some(e => /acme/i.test(e.key)), keysOf(allOf(d, 'onlyInA')));
  assert.ok(allOf(d, 'declaredAhead').length >= 6);
});

test('two files that disagree keep what they share visible', () => {
  const files = { 'rules/acme.rules.yml': `${BLOCK()}${SERIES('acme')}`, 'rules/acme.alerts.yml': `${BLOCK('planned', 'dev')}${GUARD('acme')}` };
  const [first, second] = statementOf(crawl(files).canonical);
  for (const { symbols } of [first, second]) {
    assert.ok(!symbols.includes('slos.acme_availability_99') && !symbols.includes('queries.recording_rules.acme:availability:good'), symbols);
  }
});

test('a dashboard or a rule the spec omits speaks for what it reads, down the chain', () => {
  const dashboard = JSON.stringify({ title: 'Acme', schemaVersion: 39, uid: 'acme', panels: [{ title: 'Good', type: 'timeseries', targets: [{ expr: 'acme:availability:good' }] }] });
  const viaBoard = symbolsOf({ 'rules/acme.rules.yml': `${BLOCK()}${SERIES('acme')}`, 'grafana/acme.json': dashboard });
  for (const held of ['queries.recording_rules.acme:availability:good', 'slis.acme_availability', 'slos.acme_availability_99', 'metrics.acme_requests_total']) assert.ok(!viaBoard.includes(held), [held, viaBoard]);
  const omitted = 'groups:\n  - name: o\n    rules:\n      - record: acme_good_rate\n        expr: acme:availability:good\n';
  const viaRule = symbolsOf({ 'rules/acme.rules.yml': `${BLOCK()}${SERIES('acme')}`, 'rules/o.rules.yml': omitted });
  assert.ok(!viaRule.includes('slos.acme_availability_99') && !viaRule.includes('metrics.acme_requests_total'), viaRule);
  const nonSpec = `${BLOCK()}groups:\n  - name: n\n    rules:\n      - record: acme_good\n        expr: sum(rate(acme_raw_total[5m]))\n      - alert: Other\n        expr: other_depth > 1\n`;
  const reader = 'groups:\n  - name: r\n    rules:\n      - alert: Reader\n        expr: acme_good > 1\n';
  const viaAlert = symbolsOf({ 'rules/n.rules.yml': nonSpec, 'rules/r.rules.yml': reader });
  assert.ok(!viaAlert.includes('metrics.acme_raw_total') && !viaAlert.includes('metrics.acme_good'), viaAlert);
  assert.ok(viaAlert.includes('metrics.other_depth'), viaAlert);
});
