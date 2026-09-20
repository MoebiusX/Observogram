// tools/lib/svg-charts.mjs
//
// Zero-dependency SVG chart builders for the studio (Advanced → Neuron).
// Pure string functions: input data in, an inline <svg> string out. Colours
// are CSS custom properties with fallbacks so the charts follow the studio
// theme (light / dark) without a re-render, and every text is escaped.
//
// Conventions the callers rely on:
//   - A point with v === null is a GAP: the line breaks, a hollow marker at
//     the baseline says "no value" (a vantage-lost run, a probe that did not
//     answer). Nothing is interpolated, nothing reads as 0.
//   - Time on the x axis when the points carry a time; index order when they
//     do not (or all times are equal) — `xMode` on the result says which.
//   - No chart encodes a verdict in colour by itself: the caller passes the
//     colours, and the stack-sample charts are drawn in one ink colour.

const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const fx = (n) => (Number.isFinite(n) ? Number(n.toFixed(1)).toString() : '0');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Okabe–Ito: distinguishable under the common colour-vision deficiencies.
export const PALETTE = Object.freeze(['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#B79F00', '#7F7F7F']);
export const INK = 'var(--ink-2, #1F3A5F)';
export const INK_MUTED = 'var(--ink-4, #6B6B6B)';
export const GRID = 'var(--line-2, #E5E8EC)';
export const AXIS = 'var(--line, #D4D9DF)';
export const FONT = 'var(--mono, ui-monospace, monospace)';

export function seriesColor(i) { return PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]; }

// "Nice" tick values covering [min, max] (inclusive) with about `count`
// steps; falls back to [min, max] when the range is degenerate.
export function niceTicks(min, max, count = 4) {
  if (!isNum(min) || !isNum(max)) return [];
  if (max < min) [min, max] = [max, min];
  if (max === min) return [min];
  const span = max - min;
  const rough = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-9 && out.length < 50; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
// A tick label whose precision follows the span it sits in.
export function fmtTime(t, spanMs) {
  if (!isNum(t)) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  const day = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (spanMs <= 36 * 3600e3) return hm;
  if (spanMs <= 14 * 86400e3) return `${day} ${hm}`;
  return day;
}

export function timeTicks(tMin, tMax, count = 5) {
  if (!isNum(tMin) || !isNum(tMax) || tMax <= tMin) return [];
  const span = tMax - tMin;
  const out = [];
  for (let i = 0; i <= count; i++) {
    const t = tMin + (span * i) / count;
    out.push({ t, label: fmtTime(t, span) });
  }
  return out;
}

// The x scale for a set of points: time when at least two distinct finite
// times exist, index otherwise.
function xScale(pointLists, x0, x1) {
  const times = pointLists.flat().map((p) => p?.t).filter(isNum);
  const tMin = times.length ? Math.min(...times) : null;
  const tMax = times.length ? Math.max(...times) : null;
  const maxLen = Math.max(0, ...pointLists.map((l) => l.length));
  if (tMin !== null && tMax !== null && tMax > tMin) {
    return { mode: 'time', tMin, tMax, x: (p, _i) => (isNum(p?.t) ? x0 + ((p.t - tMin) / (tMax - tMin)) * (x1 - x0) : null) };
  }
  const denom = Math.max(1, maxLen - 1);
  return { mode: 'index', tMin, tMax, x: (_p, i) => x0 + (i / denom) * (x1 - x0) };
}

function yDomain(values, yMin, yMax) {
  const ys = values.filter(isNum);
  let lo = isNum(yMin) ? yMin : (ys.length ? Math.min(...ys) : 0);
  let hi = isNum(yMax) ? yMax : (ys.length ? Math.max(...ys) : 1);
  if (!isNum(yMin) && !isNum(yMax) && lo === hi) { lo = lo > 0 ? 0 : lo - 1; hi = hi + 1; }
  if (!isNum(yMin) && lo > 0 && lo <= (hi - lo) * 0.5) lo = 0;
  if (hi === lo) hi = lo + 1;
  return [lo, hi];
}

function axes({ w, h, pad, yLo, yHi, yTicks, yFormat, xs, xTickCount = 5 }) {
  const x0 = pad.l, x1 = w - pad.r, y0 = pad.t, y1 = h - pad.b;
  const y = (v) => y1 - ((v - yLo) / (yHi - yLo)) * (y1 - y0);
  const parts = [];
  for (const v of yTicks) {
    const yy = y(v);
    parts.push(`<line x1="${fx(x0)}" x2="${fx(x1)}" y1="${fx(yy)}" y2="${fx(yy)}" stroke="${GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${fx(x0 - 4)}" y="${fx(yy + 3)}" text-anchor="end" font-size="9" font-family="${FONT}" fill="${INK_MUTED}">${esc(yFormat(v))}</text>`);
  }
  parts.push(`<line x1="${fx(x0)}" x2="${fx(x1)}" y1="${fx(y1)}" y2="${fx(y1)}" stroke="${AXIS}" stroke-width="1"/>`);
  if (xs.mode === 'time') {
    for (const tick of timeTicks(xs.tMin, xs.tMax, xTickCount)) {
      const xx = xs.x({ t: tick.t }, 0);
      parts.push(`<text x="${fx(xx)}" y="${fx(y1 + 12)}" text-anchor="middle" font-size="9" font-family="${FONT}" fill="${INK_MUTED}">${esc(tick.label)}</text>`);
    }
  } else {
    parts.push(`<text x="${fx(x0)}" y="${fx(y1 + 12)}" text-anchor="start" font-size="9" font-family="${FONT}" fill="${INK_MUTED}">oldest</text>`);
    parts.push(`<text x="${fx(x1)}" y="${fx(y1 + 12)}" text-anchor="end" font-size="9" font-family="${FONT}" fill="${INK_MUTED}">newest</text>`);
  }
  return { parts, y, x0, x1, y0, y1 };
}

const open = (w, h, cls, label) => `<svg viewBox="0 0 ${w} ${h}" width="100%" class="${esc(cls)}" role="img" aria-label="${esc(label)}" preserveAspectRatio="none">`;

// Multi-series line chart with gaps.
//   series: [{ name, points: [{ t, v, title? }], color? }]
export function lineChart({ series = [], w = 640, h = 200, pad = { l: 38, r: 12, t: 10, b: 20 }, yMin = null, yMax = null, yTicks = null, yFormat = (v) => String(v), ariaLabel = 'line chart', markers = true, gapMarkers = true, cls = 'nrn-svg' } = {}) {
  const lists = series.map((s) => (Array.isArray(s.points) ? s.points : []));
  const xs = xScale(lists, pad.l, w - pad.r);
  const [yLo, yHi] = yDomain(lists.flat().map((p) => p?.v), yMin, yMax);
  const ticks = Array.isArray(yTicks) && yTicks.length ? yTicks : niceTicks(yLo, yHi, 4);
  const ax = axes({ w, h, pad, yLo, yHi, yTicks: ticks, yFormat, xs });
  const parts = [open(w, h, cls, ariaLabel), ...ax.parts];
  series.forEach((s, si) => {
    const color = s.color || seriesColor(si);
    const pts = lists[si];
    let seg = [];
    const flush = () => {
      if (seg.length >= 2) parts.push(`<polyline points="${seg.map(([x, y]) => `${fx(x)},${fx(y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`);
      seg = [];
    };
    pts.forEach((p, i) => {
      const x = xs.x(p, i);
      if (x === null) { flush(); return; }
      if (isNum(p?.v)) {
        const y = ax.y(Math.min(yHi, Math.max(yLo, p.v)));
        seg.push([x, y]);
        if (markers || pts.length === 1) parts.push(`<circle cx="${fx(x)}" cy="${fx(y)}" r="${pts.length > 60 ? 1.4 : 2.2}" fill="${color}"><title>${esc(p.title ?? `${s.name}: ${yFormat(p.v)}${isNum(p.t) ? ` · ${new Date(p.t).toLocaleString()}` : ''}`)}</title></circle>`);
      } else {
        flush();
        if (gapMarkers) parts.push(`<circle cx="${fx(x)}" cy="${fx(ax.y1 - 3)}" r="2.4" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="1.5 1.5"><title>${esc(p.title ?? `${s.name}: no value${isNum(p.t) ? ` · ${new Date(p.t).toLocaleString()}` : ''}`)}</title></circle>`);
      }
    });
    flush();
  });
  parts.push('</svg>');
  return { svg: parts.join(''), xMode: xs.mode, yDomain: [yLo, yHi] };
}

// Stacked bars per run (index spaced — one bar per run whatever the cadence).
//   bars: [{ t, values: [n, n, …], title? }], keys: names per value slot
export function stackedBarChart({ bars = [], keys = [], colors = [], w = 640, h = 180, pad = { l: 30, r: 12, t: 10, b: 20 }, ariaLabel = 'stacked bars', cls = 'nrn-svg', yFormat = (v) => String(v) } = {}) {
  const sums = bars.map((b) => (Array.isArray(b.values) ? b.values : []).reduce((s, v) => s + (isNum(v) ? v : 0), 0));
  const yHi = Math.max(1, ...sums);
  const ticks = niceTicks(0, yHi, 3);
  const xs = xScale([bars], pad.l, w - pad.r);
  const ax = axes({ w, h, pad, yLo: 0, yHi, yTicks: ticks, yFormat, xs: { ...xs, mode: xs.mode }, xTickCount: 4 });
  const parts = [open(w, h, cls, ariaLabel), ...ax.parts];
  const n = Math.max(1, bars.length);
  const slot = (ax.x1 - ax.x0) / n;
  const bw = Math.max(1, Math.min(18, slot * 0.7));
  bars.forEach((b, i) => {
    const cx = ax.x0 + slot * (i + 0.5);
    let acc = 0;
    (Array.isArray(b.values) ? b.values : []).forEach((v, k) => {
      if (!isNum(v) || v <= 0) return;
      const yTop = ax.y(acc + v), yBot = ax.y(acc);
      parts.push(`<rect x="${fx(cx - bw / 2)}" y="${fx(yTop)}" width="${fx(bw)}" height="${fx(Math.max(0.5, yBot - yTop))}" fill="${colors[k] || seriesColor(k)}"><title>${esc(b.title ?? `${keys[k] ?? k}: ${v}${isNum(b.t) ? ` · ${new Date(b.t).toLocaleString()}` : ''}`)}</title></rect>`);
      acc += v;
    });
  });
  parts.push('</svg>');
  return { svg: parts.join(''), xMode: 'index', max: yHi };
}

// Horizontal bars: label left, value right, longest bar = max (or the largest value).
//   items: [{ label, value, note? }]
export function barChartH({ items = [], w = 640, rowH = 18, labelW = 220, max = null, color = INK, ariaLabel = 'bars', cls = 'nrn-svg', valueFormat = (v) => String(v) } = {}) {
  const rows = items.filter((it) => it && isNum(it.value));
  const hi = isNum(max) && max > 0 ? max : Math.max(1, ...rows.map((r) => r.value));
  const h = Math.max(rowH, rows.length * rowH + 4);
  const x0 = labelW, x1 = w - 44;
  const parts = [open(w, h, cls, ariaLabel)];
  rows.forEach((r, i) => {
    const y = 2 + i * rowH;
    const bw = Math.max(0, ((r.value / hi) * (x1 - x0)));
    const label = String(r.label ?? '');
    const shown = label.length > 34 ? `${label.slice(0, 33)}…` : label;
    parts.push(`<text x="${fx(x0 - 6)}" y="${fx(y + rowH * 0.68)}" text-anchor="end" font-size="10" font-family="${FONT}" fill="${INK}"><title>${esc(r.note ? `${label} — ${r.note}` : label)}</title>${esc(shown)}</text>`);
    parts.push(`<rect x="${fx(x0)}" y="${fx(y + 3)}" width="${fx(bw)}" height="${fx(rowH - 7)}" fill="${color}" opacity="0.85"><title>${esc(`${label}: ${valueFormat(r.value)}`)}</title></rect>`);
    parts.push(`<text x="${fx(x0 + bw + 4)}" y="${fx(y + rowH * 0.68)}" font-size="10" font-family="${FONT}" fill="${INK_MUTED}">${esc(valueFormat(r.value))}</text>`);
  });
  parts.push('</svg>');
  return { svg: parts.join(''), rows: rows.length, max: hi };
}

// One stack-sample row over runs: a step line in one ink colour, a hollow
// marker where the probe did not answer (its outcome in the tooltip) and a
// small ring on `nonzero` samples. Signal, not verdict — by construction.
//   points: [{ t | at, value, outcome, hint }] — `at` is what
//   stack-evidence.mjs stackSeries emits (an ISO string); `t` may be a
//   number (ms) or an ISO string.
export function stepChart({ points = [], w = 300, h = 90, pad = { l: 34, r: 8, t: 8, b: 16 }, unit = '', ariaLabel = 'samples', cls = 'nrn-svg nrn-svg-step', color = INK, valueFormat = null } = {}) {
  const timeOf = (p) => {
    const raw = p?.t ?? p?.at;
    if (isNum(raw)) return raw;
    const ms = typeof raw === 'string' && raw ? Date.parse(raw) : NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const pts = points.map((p) => ({ t: timeOf(p), v: isNum(p?.value) ? p.value : null, outcome: p?.outcome ?? null, hint: p?.hint ?? null }));
  const fmt = typeof valueFormat === 'function' ? valueFormat : (v) => `${Number.isInteger(v) ? v : Number(v.toFixed(3))}${unit ? ` ${unit}` : ''}`;
  const xs = xScale([pts], pad.l, w - pad.r);
  const [yLo, yHi] = yDomain(pts.map((p) => p.v), 0, null);
  const ticks = niceTicks(yLo, yHi, 2);
  const ax = axes({ w, h, pad, yLo, yHi, yTicks: ticks, yFormat: (v) => (Number.isInteger(v) ? String(v) : Number(v.toFixed(2)).toString()), xs, xTickCount: 2 });
  const parts = [open(w, h, cls, ariaLabel), ...ax.parts];
  let prev = null;
  pts.forEach((p, i) => {
    const x = xs.x(p, i);
    if (x === null) return;
    if (p.v === null) {
      prev = null;
      parts.push(`<circle cx="${fx(x)}" cy="${fx(ax.y1 - 3)}" r="2.4" fill="none" stroke="${color}" stroke-width="1.2" stroke-dasharray="1.5 1.5"><title>${esc(`no sample: ${p.outcome ?? 'unknown'}${isNum(p.t) ? ` · ${new Date(p.t).toLocaleString()}` : ''}`)}</title></circle>`);
      return;
    }
    const y = ax.y(Math.min(yHi, Math.max(yLo, p.v)));
    if (prev) parts.push(`<polyline points="${fx(prev[0])},${fx(prev[1])} ${fx(x)},${fx(prev[1])} ${fx(x)},${fx(y)}" fill="none" stroke="${color}" stroke-width="1.4"/>`);
    parts.push(`<circle cx="${fx(x)}" cy="${fx(y)}" r="${p.hint === 'nonzero' ? 3.2 : 2}" fill="${p.hint === 'nonzero' ? 'none' : color}" stroke="${color}" stroke-width="1.4"><title>${esc(`${fmt(p.v)}${p.hint === 'nonzero' ? ' · nonzero' : ''}${isNum(p.t) ? ` · ${new Date(p.t).toLocaleString()}` : ''}`)}</title></circle>`);
    prev = [x, y];
  });
  parts.push('</svg>');
  return { svg: parts.join(''), xMode: xs.mode, yDomain: [yLo, yHi] };
}

// A legend the caller places beside a lineChart: [{ name, color }] → HTML.
export function legendHtml(series, { attr = 'data-series' } = {}) {
  return series.map((s, i) => `<button type="button" class="nrn-legend-item" ${attr}="${esc(s.name)}"><span class="nrn-legend-swatch" style="background:${esc(s.color || seriesColor(i))}"></span>${esc(s.name)}</button>`).join('');
}
