// tools/test-svg-charts.mjs — the zero-dependency SVG builders behind the
// Neuron view: gaps stay gaps, time vs index axes, escaping, bar arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceTicks, fmtTime, timeTicks, lineChart, stackedBarChart, barChartH, stackedBarH, stepChart, legendHtml, seriesColor, PALETTE } from './lib/svg-charts.mjs';

const count = (s, re) => (s.match(re) || []).length;
const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const H = 3600e3;

test('niceTicks: round steps covering the range; degenerate inputs', () => {
  assert.deepEqual(niceTicks(0, 100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0, 7, 3), [0, 2.5, 5]);
  assert.deepEqual(niceTicks(5, 5), [5]);
  assert.deepEqual(niceTicks(NaN, 1), []);
  assert.deepEqual(niceTicks(10, 0, 2), [0, 5, 10], 'swapped bounds are tolerated');
});

test('fmtTime precision follows the span; timeTicks spans the range', () => {
  assert.match(fmtTime(T0, 2 * H), /^\d{2}:\d{2}$/);
  assert.match(fmtTime(T0, 3 * 86400e3), /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(fmtTime(T0, 40 * 86400e3), /^\d{2}-\d{2}$/);
  assert.equal(fmtTime(NaN, 1), '');
  const ticks = timeTicks(T0, T0 + 4 * H, 4);
  assert.equal(ticks.length, 5);
  assert.equal(ticks[0].t, T0);
  assert.equal(ticks[4].t, T0 + 4 * H);
  assert.deepEqual(timeTicks(T0, T0, 4), []);
});

test('lineChart: one polyline per unbroken segment, a hollow marker per gap, time axis, escaping', () => {
  const series = [
    { name: 'a<b', points: [{ t: T0, v: 10 }, { t: T0 + H, v: 20 }, { t: T0 + 2 * H, v: 30 }] },
    { name: 'b', points: [{ t: T0, v: 10 }, { t: T0 + H, v: null }, { t: T0 + 2 * H, v: 30 }, { t: T0 + 3 * H, v: 40 }] },
  ];
  const r = lineChart({ series, yMin: 0, yMax: 100, ariaLabel: 'x "y"' });
  assert.equal(r.xMode, 'time');
  assert.deepEqual(r.yDomain, [0, 100]);
  assert.equal(count(r.svg, /<polyline /g), 2, 'a: 1 segment; b: only (30,40) — a single leading point draws no line');
  assert.equal(count(r.svg, /stroke-dasharray="1.5 1.5"/g), 1, 'one gap marker');
  assert.equal(count(r.svg, /<circle [^>]*fill="#/g), 6, 'six value markers');
  assert.ok(r.svg.includes('a&lt;b'), 'series name escaped in titles');
  assert.ok(r.svg.includes('aria-label="x &quot;y&quot;"'));
  assert.ok(!r.svg.includes('<b'), 'no raw tag from a series name');
  assert.ok(r.svg.includes('>100<') && r.svg.includes('>0<'), 'y tick labels');
});

test('lineChart: index axis when points carry no time; empty series still render', () => {
  const r = lineChart({ series: [{ name: 's', points: [{ v: 1 }, { v: 2 }, { v: 3 }] }] });
  assert.equal(r.xMode, 'index');
  assert.ok(r.svg.includes('>oldest<') && r.svg.includes('>newest<'));
  const e = lineChart({ series: [] });
  assert.ok(e.svg.startsWith('<svg ') && e.svg.endsWith('</svg>'));
  const one = lineChart({ series: [{ name: 's', points: [{ t: T0, v: 5 }] }] });
  assert.equal(count(one.svg, /<polyline /g), 0);
  assert.equal(count(one.svg, /<circle /g), 1, 'a lone point is a marker');
});

test('stackedBarChart: one rect per positive slot, max = largest sum, keys in titles', () => {
  const r = stackedBarChart({ bars: [{ t: T0, values: [3, 1, 0, 0] }, { t: T0 + H, values: [2, 2, 1, 0] }], keys: ['healthy', 'degraded', 'broken', 'unobserved'] });
  assert.equal(count(r.svg, /<rect /g), 5);
  assert.equal(r.max, 5);
  assert.ok(r.svg.includes('healthy: 3') && r.svg.includes('broken: 1'));
  assert.equal(stackedBarChart({ bars: [] }).max, 1);
});

test('barChartH: rows, implicit max, truncation, escaping, explicit max', () => {
  const long = 'x'.repeat(50);
  const r = barChartH({ items: [{ label: 'a&b', value: 4 }, { label: long, value: 2, note: 'n' }, { label: 'skip', value: null }] });
  assert.equal(r.rows, 2);
  assert.equal(r.max, 4);
  assert.ok(r.svg.includes('a&amp;b: 4'));
  assert.ok(r.svg.includes(`${'x'.repeat(33)}…`), 'long labels are cut with an ellipsis');
  assert.ok(r.svg.includes(`${long} — n`), 'the full label and note stay in the tooltip');
  assert.equal(barChartH({ items: [{ label: 'a', value: 1 }], max: 10 }).max, 10);
});

test('stackedBarH: one rect per positive segment, total label, implicit max, truncation, escaping', () => {
  const r = stackedBarH({ items: [{ label: 'metrics-prom [backend] · a<b', values: [5, 4, 30], note: 'declared_only' }, { label: 'x', values: [0, 1, null] }, { label: 'skip' }], keys: ['SLOs', 'alerts', 'other'] });
  assert.equal(r.rows, 2);
  assert.equal(r.max, 39);
  assert.equal(count(r.svg, /<rect /g), 4, '3 segments on the first row, 1 on the second');
  assert.ok(r.svg.includes('>39<') && r.svg.includes('>1<'), 'totals at the end of each row');
  assert.ok(r.svg.includes('a&lt;b: SLOs 5'), 'segment tooltips name the key and are escaped');
  assert.ok(r.svg.includes(' — declared_only'), 'the note rides in the label tooltip');
  assert.ok(!r.svg.includes('<b'));
  const long = stackedBarH({ items: [{ label: 'y'.repeat(60), values: [1] }], max: 10 });
  assert.ok(long.svg.includes(`${'y'.repeat(37)}…`));
  assert.equal(long.max, 10);
  assert.equal(stackedBarH({ items: [] }).rows, 0);
});

test('stepChart: hollow marker for a missing sample, ring for nonzero, steps between values', () => {
  const pts = [
    { t: new Date(T0).toISOString(), value: 0, outcome: 'data', hint: null },
    { t: new Date(T0 + H).toISOString(), value: null, outcome: 'empty', hint: null },
    { t: new Date(T0 + 2 * H).toISOString(), value: 2, outcome: 'data', hint: 'nonzero' },
    { t: new Date(T0 + 3 * H).toISOString(), value: 0, outcome: 'data', hint: null },
  ];
  const r = stepChart({ points: pts, unit: 'count' });
  assert.equal(r.xMode, 'time');
  assert.equal(count(r.svg, /stroke-dasharray="1.5 1.5"/g), 1);
  assert.ok(r.svg.includes('no sample: empty'));
  assert.equal(count(r.svg, /r="3.2" fill="none"/g), 1, 'the nonzero ring');
  assert.equal(count(r.svg, /<polyline /g), 1, 'one step: the gap breaks the first pair, 2→0 draws');
  assert.ok(r.svg.includes('2 count · nonzero'));
  assert.deepEqual(r.yDomain[0], 0);
  // stackSeries emits `at`, not `t` — the same series drawn from it keeps the time axis.
  const viaAt = stepChart({ points: pts.map(({ t, ...p }) => ({ at: t, ...p })), unit: 'count' });
  assert.equal(viaAt.xMode, 'time');
  assert.equal(viaAt.svg, r.svg, 'identical output whichever field carries the time');
  assert.equal(stepChart({ points: pts.map(({ t: _t, ...p }) => p) }).xMode, 'index');
});

test('legendHtml and the palette', () => {
  const html = legendHtml([{ name: 'a<b' }, { name: 'c', color: '#123456' }]);
  assert.equal(count(html, /<button /g), 2);
  assert.ok(html.includes('data-series="a&lt;b"'));
  assert.ok(html.includes('background:#123456'));
  assert.equal(seriesColor(0), PALETTE[0]);
  assert.equal(seriesColor(PALETTE.length + 1), PALETTE[1]);
  assert.equal(seriesColor(-1), PALETTE[PALETTE.length - 1]);
});
