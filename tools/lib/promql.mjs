// tools/lib/promql.mjs
//
// Browser-safe PromQL dependency extraction.
//
// Observogram treats PromQL as an executable declaration language: the series
// named in an SLI, recording rule, alert rule, or dashboard panel are the
// dependency edges. This module extracts those series with PromQL-aware
// tokenisation instead of free-text matching. The Node-only Lezer wrapper in
// promql-lezer.mjs can add grammar validation, but this core stays free of
// bare npm imports because crawler.mjs is also served directly to the browser.

export const PROMQL_KEYWORDS = new Set([
  'abs', 'absent', 'absent_over_time', 'acos', 'acosh', 'and', 'asin', 'asinh',
  'atan', 'atan2', 'atanh', 'avg', 'avg_over_time', 'bottomk', 'bool', 'by',
  'ceil', 'changes', 'clamp', 'clamp_max', 'clamp_min', 'cos', 'cosh', 'count',
  'count_over_time', 'count_values', 'day_of_month', 'day_of_week',
  'day_of_year', 'days_in_month', 'deg', 'delta', 'deriv',
  'double_exponential_smoothing', 'end', 'exp', 'first_over_time', 'floor',
  'group', 'group_left', 'group_right', 'histogram_avg', 'histogram_count',
  'histogram_fraction', 'histogram_quantile', 'histogram_quantiles',
  'histogram_stddev', 'histogram_stdvar', 'histogram_sum', 'holt_winters',
  'hour', 'idelta', 'ignoring', 'increase', 'info', 'irate', 'label_join',
  'label_replace', 'label_values', 'last_over_time', 'limit_ratio', 'limitk',
  'ln', 'log10', 'log2', 'mad_over_time', 'max', 'max_over_time', 'min',
  'min_over_time', 'minute', 'month', 'nan', 'offset', 'on', 'or', 'pi',
  'predict_linear', 'present_over_time', 'quantile', 'quantile_over_time',
  'query_result', 'rad', 'range', 'rate', 'resets', 'round', 'scalar', 'sgn',
  'sin', 'sinh', 'smoothed', 'sort', 'sort_by_label', 'sort_by_label_desc',
  'sort_desc', 'sqrt', 'start', 'stddev', 'stddev_over_time', 'stdvar',
  'stdvar_over_time', 'sum', 'sum_over_time', 'tan', 'tanh', 'time',
  'timestamp', 'topk', 'ts_of_first_over_time', 'ts_of_last_over_time',
  'ts_of_max_over_time', 'ts_of_min_over_time', 'unless', 'vector', 'without',
  'year',
]);

const GROUPING_MODIFIERS = new Set([
  'by', 'without', 'on', 'ignoring', 'group_left', 'group_right',
]);

const MATCH_OP_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`)/;

export function extractPromqlMetricNames(value) {
  return parsePromqlDependencies(value).metrics;
}

export function parsePromqlDependencies(value, opts = {}) {
  const expressions = expressionList(value);
  const metrics = new Set();
  const selectors = [];
  const errors = [];

  for (const expr of expressions) {
    const parsed = parseOneExpression(expr, opts);
    for (const metric of parsed.metrics) metrics.add(metric);
    selectors.push(...parsed.selectors);
    errors.push(...parsed.errors);
  }

  return {
    parser: 'observogram-promql-core',
    parseOk: errors.length === 0,
    confidence: errors.length ? 'derived-promql-with-warnings' : 'derived-promql',
    metrics: [...metrics].sort(),
    selectors: dedupeSelectors(selectors),
    errors,
  };
}

function parseOneExpression(input, opts = {}) {
  const expr = stripLineComments(String(input || ''));
  const tokens = tokenize(expr);
  const metrics = new Set();
  const selectors = [];
  const errors = [];

  let braceDepth = 0;
  let groupParenDepth = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.value === '{') {
      braceDepth++;
      const close = matchingToken(tokens, i, '{', '}');
      const labels = close > i ? parseLabelMatchers(expr.slice(token.to + 0, tokens[close].from + 1)) : [];
      const nameMatcher = labels.find((label) => label.label === '__name__' && label.op === '=' && metricish(label.value));
      if (nameMatcher) {
        metrics.add(nameMatcher.value);
        selectors.push({
          metric: nameMatcher.value,
          labels,
          range: rangeAfter(tokens, close),
          raw: expr.slice(token.from, close > i ? tokens[close].to : token.to),
          source: opts.source || null,
        });
      }
      continue;
    }
    if (token.value === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (braceDepth > 0) continue;

    if (groupParenDepth > 0) {
      if (token.value === '(') groupParenDepth++;
      else if (token.value === ')') groupParenDepth--;
      continue;
    }

    if (token.type !== 'ident') continue;

    const rawName = token.value;
    const low = rawName.toLowerCase();
    const next = nextToken(tokens, i);
    const prev = prevToken(tokens, i);

    if (GROUPING_MODIFIERS.has(low) && next?.value === '(') {
      groupParenDepth = 1;
      i = tokens.indexOf(next);
      continue;
    }
    if (PROMQL_KEYWORDS.has(low)) continue;
    if (next?.value === '(') continue;
    if (prev?.value === '.') continue;
    if (!metricish(rawName)) continue;

    const selector = selectorForMetric(expr, tokens, i);
    metrics.add(rawName);
    selectors.push({ source: opts.source || null, ...selector });
  }

  return {
    metrics: [...metrics].sort(),
    selectors: dedupeSelectors(selectors),
    errors,
  };
}

function selectorForMetric(expr, tokens, index) {
  const metric = tokens[index].value;
  const next = nextToken(tokens, index);
  let labels = [];
  let endIndex = index;
  if (next?.value === '{') {
    const open = tokens.indexOf(next);
    const close = matchingToken(tokens, open, '{', '}');
    if (close > open) {
      labels = parseLabelMatchers(expr.slice(tokens[open].from, tokens[close].to));
      endIndex = close;
    }
  }
  const range = rangeAfter(tokens, endIndex);
  const end = range?.tokenIndex != null ? tokens[range.tokenIndex].to : tokens[endIndex].to;
  return {
    metric,
    labels,
    range: range?.value || '',
    raw: expr.slice(tokens[index].from, end),
  };
}

function rangeAfter(tokens, index) {
  const next = nextToken(tokens, index);
  if (next?.value !== '[') return null;
  const open = tokens.indexOf(next);
  const close = matchingToken(tokens, open, '[', ']');
  if (close <= open) return null;
  return {
    value: tokens.slice(open + 1, close).map((token) => token.value).join(''),
    tokenIndex: close,
  };
}

function parseLabelMatchers(text) {
  const body = String(text || '').replace(/^\s*\{|\}\s*$/g, '');
  const parts = splitTopLevel(body, ',');
  const labels = [];
  for (const part of parts) {
    const match = part.match(MATCH_OP_RE);
    if (!match) continue;
    labels.push({
      label: match[1],
      op: match[2],
      value: unescapeLabelValue(match[3] ?? match[4] ?? match[5] ?? ''),
    });
  }
  return labels;
}

function unescapeLabelValue(value) {
  return String(value || '').replace(/\\(["'`\\nrt])/g, (_, ch) => {
    if (ch === 'n') return '\n';
    if (ch === 'r') return '\r';
    if (ch === 't') return '\t';
    return ch;
  });
}

function expressionList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => expressionList(item));
  if (typeof value === 'object') {
    const out = [];
    for (const key of ['expr', 'query', 'promql', 'expression', 'good', 'total', 'record']) {
      if (value[key]) out.push(...expressionList(value[key]));
    }
    return out;
  }
  const s = String(value || '').trim();
  return s ? [s] : [];
}

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#') {
      while (i < expr.length && expr[i] !== '\n') i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i++;
      while (i < expr.length) {
        if (expr[i] === '\\') { i += 2; continue; }
        if (expr[i] === quote) { i++; break; }
        i++;
      }
      tokens.push({ type: 'string', value: expr.slice(start, i), from: start, to: i });
      continue;
    }
    if (/[A-Za-z_:]/.test(ch)) {
      const start = i++;
      while (i < expr.length && /[A-Za-z0-9_:]/.test(expr[i])) i++;
      tokens.push({ type: 'ident', value: expr.slice(start, i), from: start, to: i });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const start = i++;
      while (i < expr.length && /[0-9A-Za-z_.]/.test(expr[i])) i++;
      tokens.push({ type: 'number', value: expr.slice(start, i), from: start, to: i });
      continue;
    }
    const two = expr.slice(i, i + 2);
    if (['=~', '!~', '!=', '==', '>=', '<='].includes(two)) {
      tokens.push({ type: 'op', value: two, from: i, to: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ type: 'punct', value: ch, from: i, to: i + 1 });
    i++;
  }
  return tokens;
}

function stripLineComments(value) {
  let out = '';
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < value.length) out += value[++i];
      } else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') {
      while (i < value.length && value[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function matchingToken(tokens, start, open, close) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].value === open) depth++;
    if (tokens[i].value === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function nextToken(tokens, index) {
  return tokens[index + 1] || null;
}

function prevToken(tokens, index) {
  return tokens[index - 1] || null;
}

function metricish(name) {
  if (typeof name !== 'string') return false;
  if (!/^[A-Za-z_:][A-Za-z0-9_:]*$/.test(name)) return false;
  const low = name.toLowerCase();
  if (PROMQL_KEYWORDS.has(low)) return false;
  if (/^__/.test(name) && name !== '__name__') return false;
  return name.includes('_') || name.includes(':') || /^[A-Z0-9_]+$/.test(name) || name === 'up';
}

function splitTopLevel(value, sep) {
  const out = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

function dedupeSelectors(selectors) {
  const seen = new Set();
  const out = [];
  for (const selector of selectors) {
    if (!selector?.metric) continue;
    const key = `${selector.metric}|${selector.range || ''}|${JSON.stringify(selector.labels || [])}|${selector.raw || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(selector);
  }
  return out.sort((a, b) => `${a.metric}:${a.raw || ''}`.localeCompare(`${b.metric}:${b.raw || ''}`));
}
