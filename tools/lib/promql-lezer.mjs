// tools/lib/promql-lezer.mjs
//
// PromQL dependency extraction backed by Prometheus' Lezer grammar.
// Imports a bare npm package: served to a browser only through the static
// bundle, whose builder inlines the package and what it imports
// (tools/build-studio-bundle.mjs); the live studio never imports it — it has
// no import map, and tools/test-studio-bundle.mjs T1 asserts its graph
// reaches no package.

import { parser } from '@prometheus-io/lezer-promql';
import { parsePromqlDependencies as parseCoreDependencies } from './promql.mjs';

export function extractPromqlMetricNames(value) {
  return parsePromqlDependencies(value).metrics;
}

export function parsePromqlDependencies(value, opts = {}) {
  const core = parseCoreDependencies(value, opts);
  const expressions = expressionList(value);
  const lezerMetrics = new Set();
  const errors = [];

  for (const expr of expressions) {
    const parsed = parseOneWithLezer(expr);
    for (const metric of parsed.metrics) lezerMetrics.add(metric);
    errors.push(...parsed.errors);
  }

  const metrics = new Set([...core.metrics, ...lezerMetrics]);
  const parseOk = errors.length === 0;
  return {
    ...core,
    parser: 'lezer-promql',
    parseOk,
    confidence: parseOk ? 'derived-promql' : 'derived-promql-with-warnings',
    metrics: [...metrics].sort(),
    errors: [...core.errors, ...errors],
  };
}

function parseOneWithLezer(expr) {
  const metrics = new Set();
  const errors = [];
  const text = String(expr || '');
  if (!text.trim()) return { metrics: [], errors: [] };

  const tree = parser.parse(text);
  const cursor = tree.cursor();

  function walk() {
    do {
      if (cursor.name === '⚠') {
        errors.push({
          message: 'PromQL parse recovery node',
          from: cursor.from,
          to: cursor.to,
          text: text.slice(cursor.from, cursor.to),
        });
      }
      if (cursor.name === 'VectorSelector') {
        const metric = vectorMetricName(cursor, text);
        if (metric) metrics.add(metric);
      }
      if (cursor.firstChild()) {
        walk();
        cursor.parent();
      }
    } while (cursor.nextSibling());
  }

  walk();
  return { metrics: [...metrics].sort(), errors };
}

function vectorMetricName(cursor, text) {
  let metric = '';
  if (!cursor.firstChild()) return '';
  do {
    if (cursor.name === 'Identifier' || cursor.name === 'MetricName') {
      metric = text.slice(cursor.from, cursor.to);
      break;
    }
    // MetricName can be wrapped in a parser recovery node for Grafana helper
    // expressions. Do not descend into recovery nodes here; the browser-safe
    // core parser handles those cases and avoids counting helper names such as
    // label_values as metrics.
  } while (cursor.nextSibling());
  cursor.parent();
  return metric;
}

function expressionList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => expressionList(item));
  if (typeof value === 'object') {
    const out = [];
    for (const key of ['expr', 'query', 'promql', 'expression', 'good', 'total']) {
      if (value[key]) out.push(...expressionList(value[key]));
    }
    return out;
  }
  const s = String(value || '').trim();
  return s ? [s] : [];
}
