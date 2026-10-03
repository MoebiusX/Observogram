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
 * the parser treats the three positions differently. Exit 0 = pass.
 */

import { parse, emit } from './lib/mini-yaml.mjs';
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

report('mini-yaml round-trip');
