#!/usr/bin/env node
/**
 * tools/test-atlases.mjs — the Atlas renderers (studio/atlases.mjs) read the
 * same counts as the rest of the studio, headless under node:test: a pack's
 * sibling layer L2X (RFC-0001) is counted in the Metrics/Logs/Traces band
 * (Discover and Atlas name the same total), and Strata's notches, "+N to add"
 * and bridge are the diff's one number — never a "0 gaps" beside a size
 * difference, and never "no gaps" when the diff is not there.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { render } from '../studio/atlases.mjs';

const KRYSTALINE = adapt(parseYaml(readFileSync(new URL('../examples/krystaline-repo-carlos.pack.yaml', import.meta.url), 'utf8')));
const count = (p) => Object.values(p.layers).reduce((n, v) => n + (Array.isArray(v) ? v.length : Object.values(v).reduce((m, l) => m + l.length, 0)), 0);
const host = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [] });
const drawn = (variant, dataset, opts) => { const h = host(); render(variant, h, dataset, opts); return h.innerHTML; };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Pack A without three of its counters: A lacks three things B has, in a
// family it still declares (a family A declares nothing of is outside its
// scope, not a gap).
const dropped = new Set(KRYSTALINE.layers.L2.filter((x) => x.tool === 'Prometheus counter').slice(0, 3).map((x) => x.id));
const lacking = { ...KRYSTALINE, layers: { ...KRYSTALINE.layers, L2: KRYSTALINE.layers.L2.filter((x) => !dropped.has(x.id)) } };

test('the L2X sibling layer is in the Metrics/Logs/Traces band: the atlases count every artefact, as Discover does', () => {
  assert.ok(KRYSTALINE.layers.L2X.length > 0, 'the fixture has an L2X artefact');
  const total = count(KRYSTALINE);
  const arbor = drawn('arbor', { a: KRYSTALINE, b: KRYSTALINE, diff: null });
  assert.match(arbor, new RegExp(`PACK A: ${total}\\)`), 'the arbor cap counts every artefact');
  const periodic = text(drawn('periodic', { a: KRYSTALINE, b: KRYSTALINE, diff: null }));
  assert.match(periodic, new RegExp(`${total} /${total} · 100% in common`), 'so does the periodic table');
  const strata = text(drawn('strata', { a: KRYSTALINE, b: KRYSTALINE, diff: diffPacks(KRYSTALINE, KRYSTALINE) }));
  assert.match(strata, new RegExp(`L2 · METRICS/LOGS/TRACES ${KRYSTALINE.layers.L2.length + KRYSTALINE.layers.L2X.length} present`), 'and the strata band');
});

test('Strata: the notches, the "+N to add" and the bridge are the diff\'s count of what A lacks', () => {
  const diff = diffPacks(lacking, KRYSTALINE, { scopeMode: 'service', service: 'krystaline' });
  const missing = diff.layers.L2.onlyInB.length + diff.layers.L2X.onlyInB.length;
  assert.equal(missing, 3, 'the diff finds the three');
  const t = text(drawn('strata', { a: { ...lacking, name: 'repo' }, b: { ...KRYSTALINE, name: 'live' }, diff }));
  assert.match(t, /METRICS\/LOGS\/TRACES \d+ present · 3 missing/);
  assert.match(t, /\+3 to add/, 'the ribbon says what is to add, not the bands\' size difference');
  assert.match(t, /close the gap \+3 artefacts to add 0 outside repo's scope/);
  assert.match(t, /Each notch in the left-hand strata is an artefact live has and repo lacks/);
});

test('Strata: a live pack much larger than the repository\'s is not that many artefacts to add — the rest is outside A\'s scope', () => {
  const other = { id: 'OTHER-1', title: 'other_service_requests_total', tool: 'Metric', desc: '', source: 'Verified', tags: [], spec: { name: 'other_service_requests_total', service: 'kx-other' } };
  const big = { ...KRYSTALINE, name: 'live', layers: { ...KRYSTALINE.layers, L2: [...KRYSTALINE.layers.L2, other] } };
  const diff = diffPacks(KRYSTALINE, big, { scopeMode: 'service', service: 'krystaline' });
  const t = text(drawn('strata', { a: KRYSTALINE, b: big, diff }));
  const outside = diff.layers.L2.outOfScope.length;
  const lacks = diff.layers.L2.onlyInB.length;
  assert.deepEqual([outside, lacks], [1, 0], 'another service\'s metric is outside the scope, not a gap');
  assert.match(t, /\+0 artefacts to add 1 outside krystaline's scope/);
  assert.match(t, /L2 · METRICS\/LOGS\/TRACES \d+ present · no gaps/);
  assert.doesNotMatch(t, /\+1 /, 'no "+1" beside "no gaps"');
  assert.match(t, /krystaline lacks nothing live has in its scope, so its strata have no notch/);
});

test('Strata without a diff says it has not compared: never "no gaps", never a count', () => {
  const loading = text(drawn('strata', { a: lacking, b: KRYSTALINE, diff: null }));
  assert.match(loading, /present · not compared/);
  assert.doesNotMatch(loading, /no gaps|artefacts to add|to add/);
  assert.match(loading, /not compared yet/);
  assert.match(loading, /No notch is drawn: the comparison of the two packs has not loaded/);
  const failed = text(drawn('strata', { a: lacking, b: KRYSTALINE, diff: { error: '502: Bad Gateway' } }));
  assert.match(failed, /No notch is drawn: the comparison of the two packs failed \(502: Bad Gateway\)/);
});
