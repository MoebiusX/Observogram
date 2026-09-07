// tools/lib/promql-canon.mjs
//
// Order-canonicalization for PromQL comparison — Phase 1 Workstream B
// (docs/PHASE_1_VERDICT_TRUST_RESEARCH.md), first semantic-equivalence
// slice. Exactly the two reorderings the ratified contract lists as safe:
//
//   1. label-matcher order inside a selector:  {b="2",a="1"} ≡ {a="1",b="2"}
//   2. aggregation grouping label order:       sum by (b, a) ≡ sum by (a, b)
//
// plus two whitespace tightenings that never touch tokens: structural
// punctuation (`rate( x [5m] )` ≡ `rate(x[5m])`) and the symbolic binary
// operators (`a / b` ≡ `a/b`; `-` and keyword operators excluded).
//
// Everything else on the contract's non-goals list stays untouched: no
// algebraic rewrites, no binary-expression reordering, no regex
// equivalence, no histogram folding. Canonicalization only applies when
// the expression PARSES cleanly (parser-proven); anything with parse
// errors falls back to the conservative comparison and says so via
// `method` — per the contract, every canonicalization records whether it
// was parser-proven or a textual fallback.
//
// Pure and browser-safe (same constraint as promql.mjs, which it gates on).

import { parsePromqlDependencies } from './promql.mjs';

// Split a selector body (the text between { and }) into top-level matchers,
// respecting quoted strings — label VALUES may contain commas and braces
// (`{path=~"/a{2,3}", code=~"5.."}`), which is why a naive regex is unsafe.
function splitMatchers(body) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < body.length) { cur += body[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === ',') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '' || out.length === 0) out.push(cur);
  return out;
}

// Rewrite every selector `{...}` outside of quoted strings with its matchers
// sorted. Returns null when the scan hits anything surprising (unbalanced
// braces) so the caller can fall back conservatively.
function sortSelectorMatchers(expr) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < expr.length) {
    const ch = expr[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < expr.length) { out += expr[++i]; }
      else if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; i++; continue; }
    if (ch !== '{') { out += ch; i++; continue; }
    // Scan to the matching close brace, string-aware.
    let j = i + 1;
    let q = null;
    for (; j < expr.length; j++) {
      const c = expr[j];
      if (q) {
        if (c === '\\') { j++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '}') break;
    }
    if (j >= expr.length) return null;   // unbalanced — bail out
    const body = expr.slice(i + 1, j);
    const matchers = splitMatchers(body).map(m => m.trim()).filter(Boolean);
    matchers.sort((a, b) => a.localeCompare(b));
    out += '{' + matchers.join(',') + '}';
    i = j + 1;
  }
  return quote ? null : out;
}

// Remove spaces adjacent to structural punctuation — `rate( x [5m] )` ≡
// `rate(x[5m])` (the model's long-standing claim, which run-collapse alone
// never actually delivered; this slice makes it true). String-aware so
// label values containing spaces or punctuation stay byte-identical.
// Keyword spacing (`a and b`) is untouched: only (){}[] and commas tighten.
function tightenStructuralWhitespace(expr) {
  let out = '';
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < expr.length) out += expr[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === ' ') {
      const prev = out[out.length - 1];
      const next = expr[i + 1];
      if ('({[,'.includes(prev) || ')}],'.includes(next) || '({['.includes(next) || ')}]'.includes(prev) || next === ',' ) continue;
      out += ch;
      continue;
    }
    out += ch;
  }
  return out;
}

// Symbolic binary / comparison operators whose surrounding spaces are
// cosmetic: `a / b` ≡ `a/b`, `rate(x[5m]) > 0.5` ≡ `rate(x[5m])>0.5`.
// Longest first so `<=` is never read as `<` + `=`. Deliberately absent:
//   - `-`: unary/binary ambiguity (`a - -b` must stay as written);
//   - `=` alone: a label matcher, not an operator (`a = "1"` is left to
//     the selector pass, which only trims);
//   - keyword operators (and/or/unless/by/on/ignoring/group_*/bool/offset):
//     the space IS the token boundary.
const BINARY_OPERATORS = ['==', '!=', '<=', '>=', '=~', '!~', '+', '*', '/', '%', '^', '<', '>'];
// Characters that could extend an operator token if glued to one: `a < = b`
// (which does not parse) must not tighten into `a<=b` (which does), so a
// single space is kept between an operator and one of these.
const OPERATOR_EXTENDERS = '=~!<>';

function operatorAt(expr, i) {
  for (const op of BINARY_OPERATORS) if (expr.startsWith(op, i)) return op;
  return null;
}

// Remove spaces adjacent to the symbolic binary operators, outside strings.
// Applied only to parser-proven expressions (see canonicalizePromql); it
// never merges identifiers because every operator here is punctuation.
function tightenOperatorWhitespace(expr) {
  let out = '';
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < expr.length) out += expr[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue; }
    const op = operatorAt(expr, i);
    if (!op) { out += ch; continue; }
    // Trailing spaces before the operator go, unless gluing would form a
    // different token (`a = <b` stays apart).
    let trimmed = out.replace(/ +$/, '');
    if (trimmed.length !== out.length && OPERATOR_EXTENDERS.includes(trimmed[trimmed.length - 1])) trimmed += ' ';
    out = trimmed + op;
    i += op.length - 1;
    // Leading spaces after the operator go, same guard.
    let j = i + 1;
    while (j < expr.length && expr[j] === ' ') j++;
    if (j > i + 1 && j < expr.length && OPERATOR_EXTENDERS.includes(expr[j])) out += ' ';
    i = j - 1;
  }
  return out;
}

// Sort the label list of aggregation grouping clauses. Strictly `by` and
// `without` — vector-matching clauses (on/ignoring/group_*) are adjacent
// to binary-expression semantics the contract fences off for this slice.
function sortGroupingLabels(expr) {
  return expr.replace(/\b(by|without)\s*\(([^()]*)\)/gi, (_, kw, body) => {
    const labels = body.split(',').map(s => s.trim()).filter(Boolean);
    labels.sort((a, b) => a.localeCompare(b));
    return `${kw} (${labels.join(', ')})`;
  });
}

// The dependency extractor tokenizes rather than validating syntax, so the
// proof gate adds the structural property the rewrites actually rely on:
// balanced (), {}, [] and closed strings. Unbalanced input must never be
// labelled parser-proven.
function isStructurallySound(expr) {
  const stack = [];
  const open = { '(': ')', '{': '}', '[': ']' };
  let quote = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (open[ch]) stack.push(open[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return false;
    }
  }
  return !quote && stack.length === 0;
}

// → { text, method: 'parser-proven' | 'textual-fallback', changed }
// `text` always has whitespace collapsed (the long-standing baseline);
// ordering canonicalization is applied ONLY when the parser proves the
// expression well-formed.
export function canonicalizePromql(value) {
  const collapsed = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return { text: collapsed, method: 'textual-fallback', changed: false };
  const parsed = parsePromqlDependencies(collapsed);
  if (!parsed.parseOk || !isStructurallySound(collapsed)) {
    return { text: collapsed, method: 'textual-fallback', changed: false };
  }
  const sortedSelectors = sortSelectorMatchers(collapsed);
  if (sortedSelectors === null) return { text: collapsed, method: 'textual-fallback', changed: false };
  // Tighten LAST so the canonical form is a fixed point (idempotent).
  const text = tightenOperatorWhitespace(tightenStructuralWhitespace(sortGroupingLabels(sortedSelectors)));
  return { text, method: 'parser-proven', changed: text !== collapsed };
}
