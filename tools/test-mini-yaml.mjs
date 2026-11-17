#!/usr/bin/env node
/**
 * tools/test-mini-yaml.mjs
 *
 * Round-trip suite for the mini-yaml emitter/parser pair
 * (tools/lib/mini-yaml.mjs). The emitter promises that emit(v) re-parses to
 * a value structurally equal to v; a scalar the emitter leaves unquoted that
 * the parser then reads as structure (a mapping head, a comment, a keyword)
 * silently corrupts crawler output. Each case runs the scalar as a mapping
 * value, as a sequence item and (where it says so) as a mapping key, because
 * the parser treats the three positions differently. Then what the reader
 * reads as a YAML reader does — values over several lines, anchors, aliases,
 * merge keys — each as PyYAML reads the same text. Exit 0 = pass.
 */

import { parse, parseAll, emit, withAliasBudget, apartFromAliasBudget } from './lib/mini-yaml.mjs';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// emit -> parse must give back `doc`; on failure show the YAML we emitted.
function roundTrip(label, doc) {
  const yaml = emit(doc);
  let back;
  try { back = parse(yaml); } catch (e) { back = `THROWS ${e.message}`; }
  assert(same(back, doc), label, { yaml, back }, doc);
}

function scalarRoundTrip(label, s) {
  roundTrip(`${label}: ${JSON.stringify(s)} as mapping value`, { k: s });
  roundTrip(`${label}: ${JSON.stringify(s)} as sequence item`, { list: [s] });
  roundTrip(`${label}: ${JSON.stringify(s)} as first key of a sequence-of-mappings item`, { list: [{ k: s, next: 1 }] });
}

process.stdout.write('--- scalars ending in ":" (recording-rule names) ---\n');
for (const s of ['job:metric:', 'svc:availability:ratio_5m:', 'x:', ':']) scalarRoundTrip('trailing colon', s);

process.stdout.write('\n--- scalars containing ": " / ":<tab>" / " #" ---\n');
for (const s of ['a: b', 'a:\tb', 'key: value: more', 'x #y', 'x\t#y', 'a #', 'rate(x[5m]) # comment']) {
  scalarRoundTrip('embedded mapping/comment indicator', s);
}

process.stdout.write('\n--- leading sigils ---\n');
for (const sigil of ['-', '?', ':', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', "'", '"', '%', '@', '`', '#']) {
  scalarRoundTrip('leading sigil', `${sigil}x`);
  scalarRoundTrip('leading sigil + space', `${sigil} x`);
}
scalarRoundTrip('lone dash', '-');
scalarRoundTrip('document marker', '---');

process.stdout.write('\n--- special words and numbers stay strings ---\n');
for (const s of ['true', 'false', 'null', '~', 'yes', 'no', 'on', 'off', 'True', 'FALSE', 'Null', 'NULL', 'Yes', 'NO', 'On', 'OFF',
  '0', '1', '-1', '+1', '1.5', '-0.5', '.5', '1e3', '1E-3', '1.5e+3', '007']) {
  scalarRoundTrip('special word / number', s);
}

process.stdout.write('\n--- whitespace ---\n');
for (const s of [' x', 'x ', '\tx', 'x\t', ' ', '  leading and trailing  ']) scalarRoundTrip('whitespace', s);
roundTrip('empty string as value', { k: '' });
roundTrip('empty string in sequence', { list: [''] });

process.stdout.write('\n--- plain scalars that must stay unquoted ---\n');
// These are already correct and must keep emitting bare (the goldens pin the
// bytes); here we only assert they still round-trip.
for (const s of ['job:metric', 'a:b', 'svc:availability:ratio_5m', 'http://example.com/x', 'a#b', 'rate(x{job="a"}[5m])', 'x-', 'x?', 'x:y?']) {
  const yaml = emit({ k: s });
  assert(yaml === `k: ${s}\n`, `unambiguous scalar ${JSON.stringify(s)} emits bare`, yaml, `k: ${s}\n`);
  scalarRoundTrip('unambiguous scalar', s);
}

process.stdout.write('\n--- mapping keys ---\n');
roundTrip('key ending in ":"', { 'job:metric:': 1 });
roundTrip('key ending in ":" with nested value', { 'job:metric:': { expr: 'up' } });
roundTrip('key ending in ":" with sequence value', { 'job:metric:': ['a', 'b'] });
roundTrip('key ending in ":" inside a sequence item', { rules: [{ 'job:metric:': 'x', other: 1 }] });
roundTrip('key containing ": "', { 'a: b': 1 });
roundTrip('key that is a special word', { true: 1, null: 2, yes: 3, 1: 4 });
roundTrip('key with leading sigil', { '-x': 1, '#x': 2, '[x': 3 });
roundTrip('empty key', { '': 1 });

process.stdout.write('\n--- nested structures ---\n');
roundTrip('crawler-shaped document', {
  queries: {
    recording_rules: [
      { name: 'job:metric:', expr: 'sum(rate(x[5m]))', interval: '30s' },
      { name: 'svc:ratio:5m', expr: 'a / b # not a comment' },
    ],
  },
  labels: { severity: 'SEV1', 'rule:': 'yes', note: 'true' },
  multiline: 'line one\nline two: with colon\n',
});

process.stdout.write('\n--- double-quoted escapes ---\n');
// JSON's escapes, decoded exactly as before.
for (const [yaml, want] of [
  ['"a\\"b"', 'a"b'], ['"a\\\\b"', 'a\\b'], ['"a\\/b"', 'a/b'], ['"\\b\\f\\n\\r\\t"', '\b\f\n\r\t'],
  ['"\\u00e9"', 'é'], ['"\\ud83d\\ude80"', '🚀'], ['"{\\"expr\\": \\"up{job=\\\\\\"a\\\\\\"}\\"}"', '{"expr": "up{job=\\"a\\"}"}'],
]) {
  assert(same(parse(`k: ${yaml}\n`), { k: want }), `JSON-compatible escape ${yaml}`, parse(`k: ${yaml}\n`), { k: want });
}
// YAML's own escapes (§5.7), the ones PyYAML writes for non-ASCII text.
for (const [yaml, want] of [
  ['"Latence \\xE9lev\\xE9e"', 'Latence élevée'], ['"\\U0001F6A8 alert"', '🚨 alert'], ['"\\u2014"', '—'],
  ['"\\0\\a\\v\\e"', '\0\x07\v\x1b'], ['"a\\ b"', 'a b'], ['"\\N\\_\\L\\P"', '\u0085\u00a0\u2028\u2029'],
  ['"tab\there"', 'tab\there'],
]) {
  let got; try { got = parse(`k: ${yaml}\n`); } catch (e) { got = `THROWS ${e.message}`; }
  assert(same(got, { k: want }), `YAML escape ${yaml}`, got, { k: want });
}
const tryParse = (yaml) => { try { return parse(yaml); } catch (e) { return `THROWS ${e.message}`; } };
assert(same(tryParse('- "\\xE9"\n'), ['é']), 'YAML escape in a sequence item', tryParse('- "\\xE9"\n'));
assert(same(tryParse('m: {k: "\\xE9", "\\xE9": v}\n'), { m: { k: 'é', 'é': 'v' } }), 'YAML escape in a flow mapping value and key', tryParse('m: {k: "\\xE9", "\\xE9": v}\n'));
for (const bad of ['k: "\\q"\n', 'k: "\\x4"\n', 'k: "\\xZZ"\n', 'k: "\\U00110000"\n', 'k: "abc\\"\n']) {
  let msg = null; try { parse(bad); } catch (e) { msg = e.message; }
  assert(msg !== null && /^yaml: /.test(msg), `invalid escape ${JSON.stringify(bad.trim())} is a yaml error`, msg);
}
// The emitter's JSON-style quoting still reads back through the YAML decoder.
roundTrip('emitted escapes', { k: 'tab\t"quote" back\\slash é 🚀 \u0085' });

process.stdout.write('\n--- read as a YAML reader reads it (each as PyYAML reads the same text) ---\n');
// [label, yaml, value]: what a reader that loads the file — PyYAML, go-yaml, the ruler — makes of it.
for (const [label, yaml, want] of [
  ['a plain scalar run on over a deeper line', 'k: foo\n  bar\nnext: 1\n', { k: 'foo bar', next: 1 }],
  ['an empty line in it reads as a newline', 'k: foo\n\n  bar\nnext: 1\n', { k: 'foo\nbar', next: 1 }],
  ['two empty lines, two newlines', 'k: foo\n\n\n  bar\nnext: 1\n', { k: 'foo\n\nbar', next: 1 }],
  ['a deeper line that starts with a dash runs it on', 'k: foo\n  - bar\nnext: 1\n', { k: 'foo - bar', next: 1 }],
  ['a sequence item run on', '- foo\n  bar\n- baz\n', ['foo bar', 'baz']],
  ['a comment line ends it', 'k: foo\n  bar\n  # note\nnext: 1\n', { k: 'foo bar', next: 1 }],
  ['a comment after the text ends it', 'k: foo\n  bar # note\nnext: 1\n', { k: 'foo bar', next: 1 }],
  ['the first key of a sequence item run on', '- alert: A\n    B\n  for: 5m\n', [{ alert: 'A B', for: '5m' }]],
  ['an expression wrapped by a YAML writer, and the rule after it',
    'rules:\n- alert: A\n  expr: sum(rate(x[5m]))\n    / sum(rate(y[5m])) > 0.1\n  for: 5m\n- alert: B\n  expr: up == 0\n',
    { rules: [{ alert: 'A', expr: 'sum(rate(x[5m])) / sum(rate(y[5m])) > 0.1', for: '5m' }, { alert: 'B', expr: 'up == 0' }] }],
  ['a double-quoted scalar over lines', 'k: "foo\n  bar"\nnext: 1\n', { k: 'foo bar', next: 1 }],
  ['an empty line in it, a newline', 'k: "foo\n\n  bar"\nnext: 1\n', { k: 'foo\nbar', next: 1 }],
  ['a backslash at a line end joins without a space', 'k: "foo\\\n    bar"\nnext: 1\n', { k: 'foobar', next: 1 }],
  ['white space before a break goes', 'k: "foo   \n  bar"\nnext: 1\n', { k: 'foo bar', next: 1 }],
  ['an escaped space before a break stays', 'k: "foo\\ \n  bar"\nnext: 1\n', { k: 'foo  bar', next: 1 }],
  ['a hash inside the quotes is text', 'k: "foo\n  # not a comment"\nnext: 1\n', { k: 'foo # not a comment', next: 1 }],
  ['escapes are decoded over lines', 'k: "Latence \\xE9lev\\xE9e\n  \\"quoted\\""\n', { k: 'Latence élevée "quoted"' }],
  ['a single-quoted scalar over lines', "k: 'it''s\n  here'\nnext: 1\n", { k: "it's here", next: 1 }],
  ['a flow mapping over lines', 'k: { a: 1,\n  b: two }\nnext: 1\n', { k: { a: 1, b: 'two' }, next: 1 }],
  ['a flow sequence over lines, a comment in it', 'k: [a, # first\n  b]\nnext: 1\n', { k: ['a', 'b'], next: 1 }],
  ['a comma after the last entry adds none, the bracket closing in the key\'s column', 'k: [\n  a,\n  b,\n]\n', { k: ['a', 'b'] }],
  ['a nested flow closing in its key\'s column, the next key read', 'm:\n  k: [\n    a,\n  ]\n  n: 2\n', { m: { k: ['a'], n: 2 } }],
  ['a quoted scalar closing in its key\'s column', 'k: "open\n"\nn: 1\n', { k: 'open ', n: 1 }],
  ['an anchor and an alias', 'a: &x { s: critical, t: shop }\nb: *x\n', { a: { s: 'critical', t: 'shop' }, b: { s: 'critical', t: 'shop' } }],
  ['an anchor on a block', 'a: &x\n  s: critical\nb: *x\n', { a: { s: 'critical' }, b: { s: 'critical' } }],
  ['an anchor on a sequence item', '- &x foo\n- *x\n', ['foo', 'foo']],
  ['an anchor on a scalar of a flow sequence', 'k: [&x 5, *x]\n', { k: [5, 5] }],
  ['a merge key, the mapping\'s own key after it winning', 'base: &b { s: warning, t: shop }\nm:\n  <<: *b\n  s: critical\n',
    { base: { s: 'warning', t: 'shop' }, m: { s: 'critical', t: 'shop' } }],
  ['a merge key, the mapping\'s own key before it winning', 'base: &b { s: warning, t: shop }\nm:\n  s: critical\n  <<: *b\n',
    { base: { s: 'warning', t: 'shop' }, m: { s: 'critical', t: 'shop' } }],
  ['merge keys from a list, the earlier first', 'a: &a { s: one }\nb: &b { s: two, t: shop }\nm:\n  <<: [*a, *b]\n',
    { a: { s: 'one' }, b: { s: 'two', t: 'shop' }, m: { s: 'one', t: 'shop' } }],
  ['a merge key in a sequence item', 'base: &b { for: 5m, s: x }\nr:\n  - alert: A\n    <<: *b\n    s: y\n',
    { base: { for: '5m', s: 'x' }, r: [{ alert: 'A', s: 'y', for: '5m' }] }],
  ['a merge key as the first key of a sequence item', 'base: &b { for: 5m }\nr:\n  - <<: *b\n    alert: A\n',
    { base: { for: '5m' }, r: [{ alert: 'A', for: '5m' }] }],
  ['a merge key in a flow mapping', 'base: &b { s: x, t: y }\nm: { <<: *b, s: z }\n', { base: { s: 'x', t: 'y' }, m: { s: 'z', t: 'y' } }],
  ['a sequence item past a wide dash', '-   a: 1\n    b: 2\n', [{ a: 1, b: 2 }]],
  ['a sequence as a sequence item', 'k:\n- - a\n  - b\n- - c\n', { k: [['a', 'b'], ['c']] }],
  ['an apostrophe inside a plain scalar is text, the comment after it a comment', "k: it's down # note\nn: 1\n", { k: "it's down", n: 1 }],
  ['an apostrophe inside a plain scalar of a flow mapping', "k: {summary: it's down, team: shop}\n", { k: { summary: "it's down", team: 'shop' } }],
  ['an apostrophe in a key', "don't: x\n", { "don't": 'x' }],
  ['a doubled quote in a single-quoted item holding ": "', "- 'it''s here : there'\n", ["it's here : there"]],
  ['a doubled quote in a single-quoted flow entry holding a comma', "k: ['it''s, here', b]\n", { k: ["it's, here", 'b'] }],
  ['a flow mapping over lines with an apostrophe in a plain scalar', "s: {\n  name: it's  >\n    0.01,\n  t: '%pct'}\nn: 1\n", { s: { name: "it's  > 0.01", t: '%pct' }, n: 1 }],
  ['a mapping in a sequence in a sequence item', '- - x: 1\n    y: 2\n  - z\n', [[{ x: 1, y: 2 }, 'z']]],
  ['a quoted scalar folded over lines inside a flow mapping', "k: {a: 'two\n\n\n    breaks', b: \"long\\\n    \\ tail\"}\n", { k: { a: 'two\n\nbreaks', b: 'long tail' } }],
]) {
  const got = tryParse(yaml);
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  assert(same(sorted(got), sorted(want)), label, got, want);
}
// Numbers and booleans as written: the text a Go reader keeps decoding into a string. null is still null.
{
  const yaml = 'a: 99.0\nb: 007\nc: True\nd: 1e3\ne: ~\nf:\ng: 0x1F\nh: [1.0, false]\ni: { j: 01 }\n';
  const want = { a: '99.0', b: '007', c: 'True', d: '1e3', e: null, f: null, g: '0x1F', h: ['1.0', 'false'], i: { j: '01' } };
  assert(same(parse(yaml, { asWritten: true }), want), 'numbers and booleans as written', parse(yaml, { asWritten: true }), want);
  assert(same(parseAll(yaml, { asWritten: true }), [want]), 'parseAll as written', parseAll(yaml, { asWritten: true }), [want]);
  assert(same(parse(yaml).a, 99) && parse(yaml).c === true && parse(yaml).b === 7, 'typed by default, as before', parse(yaml));
}
// An alias is a copy: the two places are two values.
{
  const doc = parse('a: &x { s: [1] }\nb: *x\nc: *x\n');
  doc.b.s.push(2);
  assert(same(doc, { a: { s: [1] }, b: { s: [1, 2] }, c: { s: [1] } }), 'an alias reads as a copy', doc);
}
// What still reads as before: an alias to no anchor is its text; a merge key that names none stays a key; a quoted
// scalar left open before a shallower line, and a plain one before a `key: value` line, read as they did.
for (const [label, yaml, want] of [
  ['an alias to no anchor reads as its text', 'k: *missing\n', { k: '*missing' }],
  ['a merge key with no mapping stays a key', 'm:\n  <<: *missing\n  s: x\n', { m: { '<<': '*missing', s: 'x' } }],
  ['a quoted merge key is a key', 'm:\n  "<<": { a: 1 }\n', { m: { '<<': { a: 1 } } }],
  ['a quote left open before a shallower line', 'k: "open\nnext: 1\n', { k: '"open', next: 1 }],
  ['a flow left open before a shallower line', 'k: { a: 1,\nnext: 1\n', { k: '{ a: 1,', next: 1 }],
  ['a deeper key: value line runs nothing on', 'k: foo\n  bar: baz\n', { k: 'foo' }],
  ['an alias does not run on', 'a: &x 1\nk: *x\n', { a: 1, k: 1 }],
  ['a scalar on the line below its key is not read: it throws, as before', 'k:\n  foo\nnext: 1\n', 'THROWS yaml line 2: expected "key: value", got "foo"'],
]) {
  const got = tryParse(yaml);
  assert(same(got, want), label, got, want);
}
// The writer leaves a key with a line break in it unquoted: read back, it does not come back as other keys.
for (const doc of [{ gate: { 'k\nnotify': 1 } }, { m: { a: 1, 'k\nnotify': 1 } }]) {
  const back = tryParse(emit(doc));
  assert(typeof back === 'string' && back.startsWith('THROWS'), `a key with a line break does not read back as other keys: ${JSON.stringify(doc)}`, back);
}
// Aliases of aliases that double at each step are refused before they are built.
{
  const lines = ['a0: &a0 [x, x, x, x, x, x, x, x, x, x]'];
  for (let i = 1; i < 12; i++) lines.push(`a${i}: &a${i} [${Array.from({ length: 10 }, () => `*a${i - 1}`).join(', ')}]`);
  const t0 = Date.now();
  const got = tryParse(lines.join('\n') + '\n');
  assert(typeof got === 'string' && got.startsWith('THROWS yaml: aliases copy more than 1000000 nodes') && Date.now() - t0 < 5000,
    'a document whose aliases grow exponentially is refused, quickly', typeof got === 'string' ? got : 'read');
  const fine = tryParse('a: &a { k: [1, 2, 3] }\nlist:\n' + '  - *a\n'.repeat(5000));
  assert(Array.isArray(fine?.list) && fine.list.length === 5000, 'five thousand aliases of a small anchor read', typeof fine === 'string' ? fine : fine?.list?.length);
}
// The writer quotes a `<<` key, which the reader would otherwise take for a merge key.
roundTrip('a key named "<<" with a mapping value', { m: { '<<': { a: 1 }, b: 2 } });
roundTrip('a key named "<<" in a sequence item', { list: [{ '<<': { a: 1 } }] });

process.stdout.write('\n--- where a quote opens, a comment starts, a key ends (each as PyYAML reads it) ---\n');
for (const [label, yaml, want] of [
  ['a bracket inside a quoted regex of a plain scalar hides no comment', 'expr: sum(rate(x{msg=~"\\\\[ERROR.*"}[5m])) > 0 # tagged [ERROR\nnext: 1\n',
    { expr: 'sum(rate(x{msg=~"\\\\[ERROR.*"}[5m])) > 0', next: 1 }],
  ['a quote after an anchor opens: a hash inside it', 'k: &a "x # y"\nj: *a\n', { k: 'x # y', j: 'x # y' }],
  ['a quote after an anchor opens: a colon inside it', '- &a "x: y"\n- *a\n', ['x: y', 'x: y']],
  ['a quote after an anchor opens: a comma inside it, in a flow', 'k: [&a "x, y", *a]\nm: {a: &x "p, q", b: *x}\n', { k: ['x, y', 'x, y'], m: { a: 'p, q', b: 'p, q' } }],
  ['an apostrophe and a later quote inside a plain scalar hide no comment', "summary: It's slow, 'til the cache warms # known\n", { summary: "It's slow, 'til the cache warms" }],
  ['quotes inside a plain scalar of an item', '- size: 5" wide, "x # c\n', [{ size: '5" wide, "x' }]],
  ['an item whose key holds quotes', "- it's down, 'cause: x\n", [{ "it's down, 'cause": 'x' }]],
  ['flow entries with quotes inside plain scalars', "k: [it's - 'b, c]\n", { k: ["it's - 'b", 'c'] }],
  ['a key with an apostrophe, a dash and a quote', "it's a - 'b: value\n", { "it's a - 'b": 'value' }],
  ['a key with a bracket between apostrophes', "it's ]' x: v\n", { "it's ]' x": 'v' }],
  ['an alias as a key', 'a: &sev severity\nlabels:\n  *sev : critical\n', { a: 'severity', labels: { severity: 'critical' } }],
  ['a JSON-like flow mapping', 'k: {"a":1, "b":"x, y"}\n', { k: { a: 1, b: 'x, y' } }],
  ['a comment line inside a flow over lines', 'args: [\n  --verbose,\n# --debug,\n  --port=8080,\n]\nnext: 1\n', { args: ['--verbose', '--port=8080'], next: 1 }],
  ['an escaped break, then an empty line: a newline', 'k: "foo\\\n\n  bar"\nnext: 1\n', { k: 'foo\nbar', next: 1 }],
  ['in a flow, an escaped break, then an empty line', 'k: ["a\\\n\n  b"]\n', { k: ['a\nb'] }],
  ['in a flow, an escaped space before a break', 'k: ["a\\ \n  b"]\n', { k: ['a  b'] }],
  ['in a flow, an empty line inside a plain scalar', 'k: [a\n\n  b]\n', { k: ['a\nb'] }],
  ['a quote starting a continuation line is text', "k: a\n  'it # here\n", { k: "a 'it" }],
  ['a space other than space or tab before a fold stays', 'summary: errors\u3000\n  above\n', { summary: 'errors\u3000 above' }],
]) {
  const got = tryParse(yaml);
  assert(same(got, want), label, got, want);
}
for (const key of ["it's a - 'b", "don't, 'x", "a 'b' c", 'x "y" z']) roundTrip(`a key with quotes inside it: ${key}`, { [key]: 1, next: { [key]: 'v' } });

process.stdout.write('\n--- bounded: what aliases copy, how deep items nest, how long a line takes ---\n');
{
  const chain = (levels, leaf, fan = 2) => {
    const lines = [`a0: &a0 [${leaf}]`];
    for (let k = 1; k <= levels; k++) lines.push(`a${k}: &a${k} [${Array.from({ length: fan }, () => `*a${k - 1}`).join(', ')}]`);
    return lines.join('\n') + '\n';
  };
  const refused = (yaml) => { const t0 = Date.now(); const got = tryParse(yaml); return typeof got === 'string' && got.startsWith('THROWS yaml: aliases copy more than') && Date.now() - t0 < 2000; };
  assert(refused(chain(17, 'x'.repeat(40000))), 'a long string in a doubling chain is refused: a string costs its length');
  assert(refused(`a: &a ${'x'.repeat(1 << 20)}\nl:\n${'  - *a\n'.repeat(2000)}`), 'two thousand aliases of a long scalar are refused');
  // A 12-level doubling chain of a small mapping copies over half the budget (nodes, their depth, characters): one
  // fits, two do not.
  const single = chain(12, '{a: 1, b: 2}');
  assert(!refused(single) && tryParse(single)?.a12?.length === 2, 'one such document fits the budget', typeof tryParse(single));
  assert(refused(`${single}---\n${single}`), 'one budget for all the documents of a text: a `---` does not renew it');
  // A line of dashes nests each item in the first: seventeen dashes are sixteen levels inside the first, the most read.
  const deep = tryParse(`${'- '.repeat(18)}x\n`);
  assert(typeof deep === 'string' && /nested past 16 levels/.test(deep), 'items nested past 16 levels on one line are refused', deep);
  assert(same(tryParse(`${'- '.repeat(17)}x\n`), JSON.parse('['.repeat(17) + '"x"' + ']'.repeat(17))), 'sixteen levels inside the first read');
  const fast = (label, yaml) => { const t0 = Date.now(); tryParse(yaml); const ms = Date.now() - t0; assert(ms < 2000, `${label} reads in linear time (${ms} ms)`); };
  fast('a double-quoted scalar over 40,000 lines in a flow', `k: ["start\n${' word\n'.repeat(40000)} end"]\n`);
  fast('a key opening a bracket, then 32,000 lines of closers and openers', `a: [\n${'][: [\n'.repeat(32000)}`);
  fast('a 60,000-space run inside a value', `k: a${' '.repeat(60000)}b\n`);
}

process.stdout.write('\n--- a value on the line below its key, where asked for ---\n');
{
  const yaml = 'environment:\n  ADMIN:\n    ${CRED:-admin}\n  MODE: dev\n';
  assert(same(parse(yaml, { valueBelowKey: true }), { environment: { ADMIN: '${CRED:-admin}', MODE: 'dev' } }), 'read with valueBelowKey', parse(yaml, { valueBelowKey: true }));
  assert(typeof tryParse(yaml) === 'string' && tryParse(yaml).startsWith('THROWS'), 'refused without it, as before', tryParse(yaml));
}

process.stdout.write('\n--- merge keys name aliases; flow pairs; folded scalars; nesting ---\n');
for (const [label, yaml, want] of [
  // (merged keys follow the mapping's own)
  ['a merge key naming an alias merges', 'a: &a { x: 1 }\nm:\n  <<: *a\n  y: 2\n', { a: { x: 1 }, m: { y: 2, x: 1 } }],
  ['a merge key naming a list of aliases merges', 'a: &a { x: 1 }\nb: &b { z: 3 }\nm: { <<: [*a, *b], y: 2 }\n', { a: { x: 1 }, b: { z: 3 }, m: { y: 2, x: 1, z: 3 } }],
  ['a merge key with its mapping written in place stays a key, as the earlier writer wrote it', 'm:\n  <<:\n    x: 1\n  y: 2\n', { m: { '<<': { x: 1 }, y: 2 } }],
  ['the same in a flow mapping', 'm: { <<: { x: 1 }, y: 2 }\n', { m: { '<<': { x: 1 }, y: 2 } }],
  ['a single pair in a flow sequence is a mapping of one key', 'k: [a: 1, b]\n', { k: [{ a: 1 }, 'b'] }],
  ['a flow mapping entry with no value is a key whose value is null', 'k: {a, b: 1}\n', { k: { a: null, b: 1 } }],
  ['a flow mapping as a key still throws', 'k: {{ .Values.x }}\n', 'THROWS yaml flow mapping: expected "k: v" in "{ .Values.x }"'],
  ['a folded scalar: an empty line between paragraphs is one newline', 'k: >\n  a\n  b\n\n  c\n', { k: 'a b\nc\n' }],
  ['a folded scalar: two empty lines are two newlines', 'k: >\n  a\n\n\n  c\n', { k: 'a\n\nc\n' }],
  ['a folded scalar: a more-indented line keeps its line breaks', 'k: >\n  a\n    b\n  c\n', { k: 'a\n  b\nc\n' }],
  ['a staircase of `- - ` items, one more level a line, reads', Array.from({ length: 20 }, (_, i) => `${' '.repeat(i * 2)}- - v${i}`).join('\n') + '\n',
    // as PyYAML reads it: [["v0", ["v1", ["v2", …]]]]
    JSON.parse(`[${Array.from({ length: 20 }, (_, i) => `["v${i}"`).join(',')}${']'.repeat(20)}]`)],
  ['an escaped space at the end of a flow continuation line stays', 'k: [x,\n  "a\\ \n  b"]\n', { k: ['x', 'a  b'] }],
  ['a comment after a no-break space is a comment, as before', 'k: a\u00a0# note\nj: 1\n', { k: 'a', j: 1 }],
]) {
  const got = tryParse(yaml);
  assert(same(got, want), label, got, want);
}
{
  const nested = (n) => `k: ${'['.repeat(n)}x${']'.repeat(n)}\n`;
  assert(same(tryParse(nested(64)), { k: JSON.parse(`${'['.repeat(64)}"x"${']'.repeat(64)}`) }), 'flow collections nested 64 deep read');
  const deeper = tryParse(nested(65));
  assert(typeof deeper === 'string' && /nested past 64 levels/.test(deeper), 'nested 65 deep, refused', deeper);
  const t0 = Date.now();
  tryParse(`a: ["x\n${'", "k": ["x\n'.repeat(20000)}z"${']'.repeat(20001)}\n`);
  assert(Date.now() - t0 < 2000, `quote-led lines in a key's column read in linear time (${Date.now() - t0} ms)`);
}
{
  // One budget for every parse inside withAliasBudget: each of these fits alone, the two together do not.
  const chain = ['a0: &a0 [{a: 1, b: 2}]', ...Array.from({ length: 12 }, (_, k) => `a${k + 1}: &a${k + 1} [*a${k}, *a${k}]`)].join('\n') + '\n';
  assert(Array.isArray(parse(chain).a12) && Array.isArray(parse(chain).a12), 'each text fits the budget alone');
  let refused = null;
  withAliasBudget(() => { try { parse(chain); parse(chain); } catch (e) { refused = e.message; } });
  assert(/aliases copy more than/.test(refused ?? ''), 'two texts read under one withAliasBudget share it', refused);
  assert(Array.isArray(parse(chain).a12), 'and outside it each call has its own again');
}

process.stdout.write('\n--- merge keys by what aliases name, however written; block scalars of spaces ---\n');
for (const [label, yaml, want] of [
  ['a merge key over a block list of aliases', 'a: &a { x: 1 }\nb: &b { z: 3 }\nm:\n  <<:\n    - *a\n    - *b\n  y: 2\n', { a: { x: 1 }, b: { z: 3 }, m: { y: 2, x: 1, z: 3 } }],
  ['a merge key over a flow list of aliases on two lines', 'a: &a { x: 1 }\nb: &b { z: 3 }\nm:\n  <<: [*a,\n    *b]\n  y: 2\n', { a: { x: 1 }, b: { z: 3 }, m: { y: 2, x: 1, z: 3 } }],
  ['a merge key over an anchored list of aliases', 'a: &a { x: 1 }\nm:\n  <<: &l [*a]\n  y: 2\n', { a: { x: 1 }, m: { y: 2, x: 1 } }],
  ['a block scalar: a line of spaces past its indent keeps them (folded)', 'k: >\n  a\n   \n  b\n', { k: 'a\n \nb\n' }],
  ['a block scalar: a line of spaces past its indent keeps them (literal)', 'k: |\n  a\n   \n  b\n', { k: 'a\n \nb\n' }],
  ['an empty folded scalar is empty', 'k: >\nj: 1\n', { k: '', j: 1 }],
  ['an empty literal scalar is empty', 'k: |\nj: 1\n', { k: '', j: 1 }],
  ['an inner flow closed in the key\'s column, the outer one still open', 'k: [\n [a, b\n],\n [c]\n]\nj: 1\n', { k: [['a', 'b'], ['c']], j: 1 }],
]) {
  const got = tryParse(yaml);
  assert(same(got, want), label, got, want);
}
{
  const nbsp = tryParse(`${'- \u00a0'.repeat(30)}x\n`);
  assert(typeof nbsp === 'string' && /nested past 16 levels/.test(nbsp), 'dashes parted by a no-break space count toward the nesting limit', nbsp);
  // apartFromAliasBudget: reads inside it get their own budget again, the outer one untouched.
  const chain = ['a0: &a0 [{a: 1, b: 2}]', ...Array.from({ length: 12 }, (_, k) => `a${k + 1}: &a${k + 1} [*a${k}, *a${k}]`)].join('\n') + '\n';
  let outcome = null;
  withAliasBudget(() => {
    parse(chain);
    try { apartFromAliasBudget(() => parse(chain)); outcome = 'apart read'; } catch (e) { outcome = e.message; }
    try { parse(chain); } catch (e) { outcome += ` · then: ${e.message}`; }
  });
  assert(/^apart read · then: yaml: aliases copy more than 1000000 nodes and characters in the texts read together/.test(outcome ?? ''),
    'a read apart from the shared budget has its own; back inside, the shared one is still spent, and says so', outcome);
}

process.stdout.write('\n--- where the reader stops: onStop ---\n');
{
  // Each document the reader ends at a line it cannot place, by that line's number in the whole text.
  const read = (text, fn = parseAll) => {
    const lines = [];
    let value;
    try { value = fn(text, { onStop: (line) => lines.push(line) }); } catch (e) { value = `THROWS ${e.message}`; }
    return { lines, value };
  };
  const plain = (text) => { try { return parseAll(text); } catch (e) { return `THROWS ${e.message}`; } };
  for (const [label, text, want] of [
    ['a document read to its end reports nothing', 'a: 1\nb:\n  c: 2\n', []],
    ['a deeper key under a value stops the document there', 'a: 1\n  b: 2\nc: 3\n', [2]],
    ['a tag on a block mapping: the reader stops at the line below it', 'a: !!map\n  b: 1\nc: 2\n', [2]],
    ['a document that starts indented stops at the first line left of it', '  a: 1\nb: 2\n', [2]],
    ['the count runs over the whole text, `---` and comments too', 'a: 1\n---\n# c\nb: 1\n    x: 2\nc: 3\n', [5]],
    ['one report for each document that stops', 'a: 1\n  b: 2\n---\nc: 1\n  d: 2\n', [2, 5]],
    ['a byte-order mark and CRLF line ends do not move the count', '﻿a: 1\r\n  b: 2\r\nc: 3\r\n', [2]],
    ['a document that throws reports nothing more', 'a: 1\nnot a pair\n', []],
  ]) {
    const got = read(text);
    assert(same(got.lines, want), `onStop: ${label}`, got.lines, want);
    assert(same(read(text, parse).lines, want), `onStop through parse(): ${label}`, read(text, parse).lines, want);
    assert(same(got.value, plain(text)), `onStop changes nothing read: ${label}`, got.value, plain(text));
  }
  // An error names its line in the whole text as well, not in its document.
  const second = plain('a: 1\n---\nb: 1\nnot a pair\n');
  assert(/^THROWS yaml line 4: expected "key: value"/.test(second), 'an error in a second document names its line in the text', second);
}

report('mini-yaml round-trip');
