// tools/test-metric-readers.mjs
//
// What reads a metric one pack holds and the other does not
// (studio/metric-readers.mjs): the readers a repository scan records on each
// metric, counted once per group, said in words that claim no more than the
// two packs show — and the Compare view that prints them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { crawlFiles } from './lib/crawler.mjs';
import { adapt } from './lib/adapter.mjs';
import {
  metricReaders, readersDigest, readerCounts, alertNames, readerLine, readersSentence, readerRank, ALERT_NAMES_SHOWN,
} from '../studio/metric-readers.mjs';

const metric = (name, origin_kind, used_by) => ({ id: `M-${name}`, title: name, spec: { name, origin_kind, used_by } });

test('readers come from used_by: alert rules, dashboard panels and recording rules, each once', () => {
  const r = metricReaders(metric('rabbitmq_up', 'promql-reference', [
    'alert:RabbitMQDown', 'alert:RabbitMQDown', 'dashboard:unified/queue_depth', 'dashboard:unified/throughput',
    'dashboard:ops/queue_depth', 'recording_rule:mq:up:avg5m', 'nonsense', 'webhook:x', 'alert:',
  ]));
  assert.deepEqual(r.alerts, ['RabbitMQDown']);
  assert.deepEqual(r.panels, ['ops/queue_depth', 'unified/queue_depth', 'unified/throughput']);
  assert.deepEqual(r.dashboards, ['ops', 'unified']);
  assert.deepEqual(r.rules, ['mq:up:avg5m']);
  assert.equal(r.count, 5);
  assert.equal(r.origin, 'query');
  assert.equal(r.known, true);
});

test('a recording rule is not a reader of its own output; another rule reading it is', () => {
  const r = metricReaders(metric('finops:cpu:usage_5m', 'recording-rule-output', [
    'recording_rule:finops:cpu:usage_5m', 'recording_rule:finops:cost:index_1h', 'dashboard:finops/cpu',
  ]));
  assert.deepEqual(r.rules, ['finops:cost:index_1h']);
  assert.equal(r.origin, 'ruleOutput');
  assert.equal(r.count, 2);
});

test('a metric family is read through its series: the members\' readers are one set', () => {
  const r = metricReaders([
    metric('order_duration_seconds', 'source-code', []),
    metric('order_duration_seconds_bucket', 'promql-reference', ['alert:SlowOrders', 'dashboard:shop/latency']),
    metric('order_duration_seconds_count', 'promql-reference', ['dashboard:shop/latency', 'dashboard:shop/rate']),
  ]);
  assert.deepEqual(r.alerts, ['SlowOrders']);
  assert.deepEqual(r.panels, ['shop/latency', 'shop/rate']);
  assert.equal(r.origin, 'code', 'what the code emits is emitted by code, whatever else names it');
});

test('a pack that records nothing about a metric is unknown, not unread', () => {
  const live = metricReaders({ id: 'METRIC-1', title: 'up', spec: { name: 'up' } });
  assert.equal(live.known, false);
  assert.equal(readerLine(live), '');
  assert.equal(readerRank(live), 2);
  const d = readersDigest([[{ id: 'METRIC-1', spec: { name: 'up' } }]]);
  assert.deepEqual([d.metrics, d.known, d.read, d.unread], [1, 0, 0, 0]);
  assert.equal(readersSentence(d), '');
});

test('the digest counts a reader once however many metrics it reads', () => {
  const d = readersDigest([
    [metric('container_cpu', 'promql-reference', ['dashboard:k8s/cpu', 'recording_rule:finops:cpu'])],
    [metric('container_mem', 'promql-reference', ['dashboard:k8s/cpu', 'dashboard:k8s/mem'])],
    [metric('rabbitmq_up', 'promql-reference', ['alert:RabbitMQDown'])],
    [metric('orders_failed_total', 'promql-reference', ['alert:OrderFailures'])],
    [metric('kx_trades_today', 'source-code', [])],
    [metric('finops:cpu', 'recording-rule-output', ['recording_rule:finops:cpu'])],
  ]);
  assert.deepEqual([d.metrics, d.known, d.read, d.unread], [6, 6, 4, 2]);
  assert.deepEqual(d.alerts, ['OrderFailures', 'RabbitMQDown']);
  assert.deepEqual(d.panels, ['k8s/cpu', 'k8s/mem']);
  assert.deepEqual(d.dashboards, ['k8s']);
  assert.deepEqual(d.rules, ['finops:cpu']);
  assert.deepEqual(d.unreadByOrigin, { code: 1, ruleOutput: 1, query: 0, other: 0 });
  assert.equal(readerCounts(d), '2 alert rules, 2 dashboard panels and 1 recording rule');
});

test('the words: counts, names, and no claim the packs do not support', () => {
  assert.equal(readerCounts({ alerts: ['A'] }), '1 alert rule');
  assert.equal(readerCounts({ alerts: ['A'], rules: ['r'] }), '1 alert rule and 1 recording rule');
  assert.equal(readerCounts({}), '');
  const many = Array.from({ length: ALERT_NAMES_SHOWN + 3 }, (_, i) => `Alert${i}`);
  assert.equal(alertNames(many), `${many.slice(0, ALERT_NAMES_SHOWN).join(', ')} and 3 more`);
  assert.equal(alertNames([]), '');

  assert.equal(readerLine(metricReaders(metric('rabbitmq_up', 'promql-reference', ['alert:RabbitMQDown']))), 'Read by alert rule RabbitMQDown');
  assert.equal(readerLine(metricReaders(metric('c', 'promql-reference', ['alert:A', 'alert:B', 'dashboard:d/p', 'recording_rule:r']))),
    'Read by 2 alert rules, 1 dashboard panel and recording rule r');
  assert.equal(readerLine(metricReaders(metric('kx_trades_today', 'source-code', []))), 'Emitted by code; nothing in this pack reads it');
  assert.equal(readerLine(metricReaders(metric('x:y', 'recording-rule-output', ['recording_rule:x:y']))), 'A recording rule’s output; nothing in this pack reads it');
  assert.equal(readerLine(metricReaders(metric('q', 'promql-reference', []))), '');

  const d = readersDigest([
    [metric('rabbitmq_up', 'promql-reference', ['alert:RabbitMQDown'])],
    [metric('container_cpu', 'promql-reference', ['dashboard:k8s/cpu'])],
    [metric('kx_trades_today', 'source-code', [])],
  ]);
  const live = readersSentence(d, { holder: 'A', other: 'B', otherIsLive: true });
  assert.equal(live, 'Pack B was drafted from the live system, which reported none of these 3 metrics. '
    + 'In Pack A, 1 alert rule and 1 dashboard panel read 2 of them, on 1 dashboard. Alert rules: RabbitMQDown. '
    + 'The other 1 is read by nothing in Pack A (1 emitted by code).');
  const repo = readersSentence(d, { holder: 'B', other: 'A' });
  assert.ok(!/live system/.test(repo) && /^In Pack B, /.test(repo), 'between two repository packs nothing is said about a live system');
  for (const s of [live, repo]) assert.ok(!/never fire|cannot fire|broken|blind/i.test(s), 'no verdict the packs do not show');

  const allRead = readersSentence(readersDigest([[metric('a', 'promql-reference', ['alert:A'])], [metric('b', 'promql-reference', ['alert:A'])]]));
  assert.equal(allRead, 'In Pack A, 1 alert rule read them. Alert rules: A.');
  const mixed = readersSentence(readersDigest([[metric('a', 'promql-reference', ['alert:A'])], [{ id: 'SCRAPE-1', spec: { job: 'x' } }]]), { otherIsLive: true });
  assert.equal(mixed, 'Pack B was drafted from the live system, which reported no such metric. In Pack A, 1 alert rule read it. Alert rules: A.',
    'an artefact the pack says nothing about is not counted among the metrics');
  const noneRead = readersSentence(readersDigest([[metric('a', 'source-code', [])], [metric('b', 'source-code', [])]]));
  assert.equal(noneRead, 'All 2 are read by nothing in Pack A (2 emitted by code).');
});

test('rank: what an alert reads first, then what anything reads, then the rest', () => {
  assert.equal(readerRank(metricReaders(metric('a', 'promql-reference', ['alert:A', 'dashboard:d/p']))), 0);
  assert.equal(readerRank(metricReaders(metric('b', 'promql-reference', ['dashboard:d/p']))), 1);
  assert.equal(readerRank(metricReaders(metric('c', 'source-code', []))), 2);
});

test('a scanned repository carries the record these helpers read', () => {
  const { canonical } = crawlFiles({
    'shop/k8s/prometheus/rules.yaml': [
      'groups:',
      '- name: shop',
      '  rules:',
      '  - record: shop:orders:rate5m',
      '    expr: sum(rate(shop_orders_total[5m]))',
      '  - alert: ShopQueueDown',
      '    expr: shop_queue_up == 0',
      '    for: 5m',
      '    labels: {severity: critical}',
      '',
    ].join('\n'),
  }, { repoName: 'shop', environment: 'prod', now: '2026-10-02T08:00:00.000Z' });
  const pack = adapt(canonical);
  const metrics = (pack.layers.L2 || []).filter(a => a.spec?.origin_kind);
  const byName = Object.fromEntries(metrics.map(a => [a.spec.name, a]));
  assert.deepEqual(metricReaders(byName.shop_queue_up).alerts, ['ShopQueueDown'], 'the alert rule that reads a metric is on the metric');
  assert.deepEqual(metricReaders(byName.shop_orders_total).rules, ['shop:orders:rate5m'], 'so is the recording rule');
  assert.equal(metricReaders(byName['shop:orders:rate5m']).count, 0, 'and a rule does not read its own output');
});

test('Compare prints the readers: the group paragraph, each card and the summary', () => {
  const src = fs.readFileSync(new URL('../studio/compare-view.mjs', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/metric-readers\.mjs'/, 'the view reads the helper');
  const col = src.slice(src.indexOf('function renderCompareLayerColumn'), src.indexOf('function compareKeyOf'));
  assert.match(col, /readersSentence\(/, 'the Only-in group says what reads its metrics');
  assert.match(col, /readerRank\(/, 'and leads with what an alert reads');
  const card = src.slice(src.indexOf('function renderCompareCard'), src.indexOf('function renderCompareCard') + 4000);
  assert.match(card, /readerLine\(/, 'a card says what reads it');
  assert.match(src, /compare-readers-item/, 'the summary names the readers among the quality gaps');
});
