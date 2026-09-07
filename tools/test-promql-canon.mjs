#!/usr/bin/env node
/**
 * tools/test-promql-canon.mjs
 *
 * Unit test for the Workstream B semantic-equivalence slice
 * (tools/lib/promql-canon.mjs) and its integration into the behavioural
 * model. The ratified contract demands BOTH directions: positive
 * equivalences (cosmetic rewrites stop reading as drift) and negative
 * non-equivalences (decision-field changes still read as drift) — plus
 * the method record (parser-proven vs textual-fallback) and the
 * conservative parse-failure fallback. Exit 0 = pass.
 */

import { canonicalizePromql } from './lib/promql-canon.mjs';
import { behaviorOf } from './lib/artefact-model.mjs';
import { diffPacks } from './lib/diff.mjs';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness();

const canon = (s) => canonicalizePromql(s).text;
const equiv = (a, b) => canon(a) === canon(b);

// ---------- positive equivalences (the contract's safe candidates) ----------
assert(equiv('sum by (a, b) (rate(x[5m]))', 'sum by (b, a) (rate(x[5m]))'),
  'aggregation label order: by (a,b) ≡ by (b,a)');
assert(equiv('sum without (instance, pod) (x)', 'sum without (pod, instance) (x)'),
  'without label order is canonicalized too');
assert(equiv('http_requests_total{code="200",job="api"}', 'http_requests_total{job="api", code="200"}'),
  'selector matcher order is canonicalized');
assert(equiv('rate( x{b="2", a="1"} [5m] )', 'rate(x{a="1",b="2"}[5m])'),
  'whitespace + matcher order combine');
assert(equiv('SUM BY (b, a) (x)', 'SUM BY (a, b) (x)'),
  'keyword case-insensitive for by/without');

// ---------- the trap that makes naive regexes unsafe ----------
const trapA = 'sum(rate(http{path=~"/a{2,3}", code=~"5.."}[5m]))';
const trapB = 'sum(rate(http{code=~"5..", path=~"/a{2,3}"}[5m]))';
assert(equiv(trapA, trapB), 'braces and commas inside label-value regexes do not break selector scanning');
assert(canon(trapA).includes('/a{2,3}'), 'regex value content survives canonicalization untouched');

// ---------- negative non-equivalences (decision fields stay drift) ----------
assert(!equiv('sum by (a) (x)', 'sum by (a, b) (x)'), 'different grouping label SETS stay different');
assert(!equiv('x{a="1"}', 'x{a="2"}'), 'different matcher values stay different');
assert(!equiv('x{a="1"}', 'x{a="1",b="2"}'), 'extra matcher stays different');
assert(!equiv('rate(x[5m])', 'rate(x[1h])'), 'range windows stay different');
assert(!equiv('a / b', 'b / a'), 'binary expressions are NOT reordered (contract non-goal)');
assert(canon('a and on (b, a) c').includes('on(b,a)'),
  'vector-matching label ORDER is left untouched in this slice (fenced with binary semantics)');
assert(equiv('rate( x [5m] )', 'rate(x[5m])'),
  'structural whitespace tightens: the model\'s long-standing claim is now actually true');
assert(equiv('(a) and (b)', '(a)and(b)'),
  'keyword spacing adjacent to parens canonicalizes consistently');
assert(!equiv('a and b', 'aand b'),
  'identifier boundaries are never merged');

// ---------- binary-operator whitespace (this slice) ----------
assert(equiv('a / b', 'a/b'), 'operator whitespace: a / b ≡ a/b');
assert(equiv('rate(x[5m]) > 0.5', 'rate(x[5m])>0.5'), 'operator whitespace: comparison tightens');
assert(equiv('sum(rate(a[5m])) / sum(rate(b[5m])) >= 0.99', 'sum(rate(a[5m]))/sum(rate(b[5m]))>=0.99'),
  'operator whitespace: division and >= in one expression');
assert(equiv('a == b', 'a==b') && equiv('a != b', 'a!=b') && equiv('a <= b', 'a<=b')
    && equiv('a % b', 'a%b') && equiv('a ^ b', 'a^b') && equiv('a * b', 'a*b'),
  'operator whitespace: every listed symbolic operator tightens');
assert(equiv('x{a =~ "1"}', 'x{a=~"1"}') && equiv('x{a !~ "1"}', 'x{a!~"1"}'),
  'operator whitespace: regex matchers inside selectors tighten');
const opString = 'x{path="a / b > c"} > 0';
assert(canon(opString).includes('"a / b > c"'), 'operators inside label-value strings stay byte-identical');
assert(canon('a - -b') === 'a - -b', 'minus is never tightened (unary/binary ambiguity)');
assert(canon('a - b') === 'a - b', 'binary minus keeps its spacing');
assert(canon('a and b') === 'a and b', 'keyword operators keep their spacing');
assert(canon('a unless b') === 'a unless b' && canon('a > bool b').endsWith('bool b'),
  'keyword modifiers keep the space that bounds them');
assert(canon('a < = b') !== canon('a <= b'), 'a space inside an operator is never glued into a different operator');
// NEGATIVE: non-equivalent expressions must not collapse together.
assert(!equiv('rate(x[5m]) > 0.5', 'rate(x[5m]) >= 0.5'), 'NEGATIVE: > vs >= stay different');
assert(!equiv('a / b', 'a * b'), 'NEGATIVE: different operators stay different');
assert(!equiv('rate(x[5m]) > 0.5', 'rate(x[5m]) > 0.05'), 'NEGATIVE: different thresholds stay different');
assert(!equiv('x{a=~"1"}', 'x{a!~"1"}'), 'NEGATIVE: =~ vs !~ stay different');
assert(!equiv('x{path="a / b"}', 'x{path="a/b"}'), 'NEGATIVE: label-value string content is decision-bearing');
const opOnce = canon('sum by (b, a) (rate(x[5m])) / sum(y) > 0.5');
assert(canon(opOnce) === opOnce, 'operator tightening is idempotent');
assert(canonicalizePromql('a / b').method === 'parser-proven' && canonicalizePromql('a / b').changed === true,
  'operator tightening is recorded as a parser-proven change');
assert(canonicalizePromql('a / (b').text === 'a / (b', 'operator tightening is NOT applied on the textual fallback');

// ---------- method record + conservative fallback ----------
assert(canonicalizePromql('sum by (b, a) (x)').method === 'parser-proven',
  'clean parse records parser-proven');
assert(canonicalizePromql('sum by (b, a) (x)').changed === true, 'changed flag reports reordering');
const broken = canonicalizePromql('sum by (b, a (x');   // unbalanced — must not parse
assert(broken.method === 'textual-fallback', 'parse failure records textual-fallback', broken);
assert(broken.text === 'sum by (b, a (x', 'fallback only collapses whitespace, never reorders');
const unbalancedBrace = canonicalizePromql('x{a="1"');
assert(unbalancedBrace.method === 'textual-fallback', 'unbalanced selector falls back conservatively');
assert(canonicalizePromql('').method === 'textual-fallback' && canonicalizePromql('').text === '',
  'empty expression is a no-op fallback');
// Idempotency: canonical form is a fixed point.
const once = canon('sum by (b, a) (rate(x{z="9",y="8"}[5m]))');
assert(canon(once) === once, 'canonicalization is idempotent');

// ---------- integration: behaviorOf equality ----------
const ruleArt = (expr) => ({ id: 'QRY-01', title: 'r', tool: 'Prometheus recording rule', tags: ['recording'], spec: { name: 'svc:m:ratio_5m', expr } });
assert(JSON.stringify(behaviorOf(ruleArt('sum by (a, b) (rate(x{j="1",k="2"}[5m]))')))
   === JSON.stringify(behaviorOf(ruleArt('sum by (b, a) (rate(x{k="2", j="1"}[5m]))'))),
  'behaviorOf treats order-equivalent recording rules as identical');
assert(JSON.stringify(behaviorOf(ruleArt('sum by (a) (x)')))
   !== JSON.stringify(behaviorOf(ruleArt('sum by (a, b) (x)'))),
  'behaviorOf keeps genuinely different grouping as drift');

assert(JSON.stringify(behaviorOf(ruleArt('sum(rate(a[5m])) / sum(rate(b[5m]))')))
   === JSON.stringify(behaviorOf(ruleArt('sum(rate(a[5m]))/sum(rate(b[5m]))'))),
  'behaviorOf treats operator-spacing-only rewrites as identical');

// ---------- end-to-end: diff alignment ----------
const layered = (expr) => ({
  meta: { name: 'p' },
  layers: { L3: [{ id: 'QRY-01', title: 'svc:m:ratio_5m', tool: 'Prometheus recording rule', tags: ['recording'], spec: { name: 'svc:m:ratio_5m', expr } }] },
});
const d = diffPacks(layered('sum by (a, b) (rate(x{j="1",k="2"}[5m]))'),
                    layered('sum by (b, a) (rate(x{k="2", j="1"}[5m]))'), { scopeMode: 'off' });
assert(d.summary.aligned === 1 && d.summary.drifted === 0,
  'END-TO-END: order-only rewrites now diff as ALIGNED, not drift', d.summary);
const d2 = diffPacks(layered('sum by (a) (x)'), layered('sum by (a, b) (x)'), { scopeMode: 'off' });
assert(d2.summary.drifted === 1,
  'END-TO-END: real grouping changes still diff as DRIFTED', d2.summary);

report('promql-canon', 'all semantic-equivalence assertions pass.');
