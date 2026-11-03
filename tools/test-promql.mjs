#!/usr/bin/env node
/**
 * tools/test-promql.mjs
 *
 * PromQL dependency extraction tests. These protect the executable-declaration
 * spine: expressions should yield real series names, not grouping labels,
 * label matcher keys, Grafana helper names, or string literals.
 */

import { extractPromqlMetricNames as extractCore, parsePromqlDependencies as parseCore } from './lib/promql.mjs';
import { extractPromqlMetricNames as extractLezer, parsePromqlDependencies as parseLezer } from './lib/promql-lezer.mjs';

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness();

function eq(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label, actual, expected);
}

process.stdout.write('\n--- core PromQL extraction ---\n');
eq(
  extractCore('sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)'),
  ['http_requests_total'],
  'grouping labels and label matchers are not metrics',
);
eq(
  extractCore('1 - (1 - slo:http_request_duration:ratio_below_500ms_1d)/(1-0.95)'),
  ['slo:http_request_duration:ratio_below_500ms_1d'],
  'colon recording-rule output series is extracted',
);
eq(
  extractCore('histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))'),
  ['http_request_duration_seconds_bucket'],
  'histogram bucket metric extracted without le label',
);
eq(
  extractCore('ALERTS{alertname=~".*Forecast.*|.*Trend.*", alertstate="firing"}'),
  ['ALERTS'],
  'ALERTS pseudo-series extracted without alertname strings',
);
eq(
  extractCore('label_values(solace_client_username{dataCenter="$dataCenter"}, vpn)'),
  ['solace_client_username'],
  'Grafana label_values helper yields first-argument metric only',
);
eq(
  extractCore('{__name__="http_requests_total", job="api"}'),
  ['http_requests_total'],
  '__name__ exact matcher yields metric dependency',
);

// A colon at either end of an identifier is a fragment left by a stripped
// dashboard variable or a subquery resolution, never a metric. Both parsers
// must answer alike, or the Lezer union re-admits what core drops.
const COLON_EDGE_CASES = [
  ['sum(rate(http_requests_total[5m]))', ['http_requests_total'], 'plain name'],
  ['sum(rate($prefix:app_requests_total[5m]))', ['prefix:app_requests_total'], '`$` tokenises as punctuation (a recovery node in Lezer); the rest is one well-formed colon name (known gap, pinned)'],
  ['sum(rate(${prefix}:app_requests_total[5m]))', [], 'a braced variable leaves a leading-colon fragment: no metric'],
  ['app:slo:burn_rate_1h > 14', ['app:slo:burn_rate_1h'], 'interior colons are a recording-rule name'],
  ['max(app_queue_depth:)', [], 'a variable at the end of a name leaves a trailing-colon fragment: no metric'],
  ['sum(rate(x_total[5m:1m]))', ['x_total'], 'a subquery resolution is not a metric'],
  ['{__name__="a:b"}', ['a:b'], 'a __name__ matcher with an interior colon is a recording-rule name'],
  ['{__name__=":k"}', [], 'a __name__ matcher with a leading colon yields nothing'],
  ['{__name__="k:"}', [], 'a __name__ matcher with a trailing colon yields nothing'],
];
for (const [expr, expected, label] of COLON_EDGE_CASES) {
  eq(extractCore(expr), expected, `core: ${label}`);
  eq(extractLezer(expr), expected, `lezer: ${label}`);
}
// Only the colon rule is shared: the grammar proves `requests` is a selector,
// and the wrapper keeps reporting what core's heuristic cannot see.
eq(extractLezer('rate(requests[5m])'), ['requests'], 'lezer: a single-word metric the grammar yields is kept');

const coreParsed = parseCore('sum(rate(http_requests_total{status="200"}[5m]))');
assert(coreParsed.selectors[0]?.labels?.some(l => l.label === 'status' && l.value === '200'),
       'core parser preserves selector label evidence');

process.stdout.write('\n--- Lezer-backed extraction ---\n');
const valid = parseLezer('sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)');
assert(valid.parser === 'lezer-promql', 'Lezer wrapper identifies parser', valid.parser, 'lezer-promql');
assert(valid.parseOk === true, 'valid PromQL parses cleanly', valid.parseOk, true);
eq(valid.metrics, ['http_requests_total'], 'Lezer wrapper extracts valid expression metric');

const grafanaHelper = parseLezer('label_values(solace_client_username{dataCenter="$dataCenter"}, vpn)');
assert(grafanaHelper.metrics.includes('solace_client_username'),
       'Lezer wrapper salvages Grafana helper metric through core parser',
       grafanaHelper.metrics, ['solace_client_username']);
assert(grafanaHelper.parseOk === false,
       'Grafana helper is marked parse-warning, not clean PromQL',
       grafanaHelper.parseOk, false);

report('PromQL');
