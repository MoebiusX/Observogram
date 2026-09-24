#!/usr/bin/env node
/**
 * tools/test-gen-pack.mjs
 *
 * Generator regression suite: dashboards and burn-rate rules for every reference pack.
 * Asserts what the platform relies on rather than the exact bytes:
 *   - one dashboard per spec.dashboards[] entry, uid equal to the pack id, panels with targets,
 *     every declared panel binding bound by a panel, no malformed expression;
 *   - the burn file parses, every policy window has its alert with the pack's slo/severity,
 *     every forecast has its alert, recording rules carry slo/sli/service labels;
 *   - the corrected PromQL forms are present (event denominators for rate-style ratios, bool
 *     comparisons for state-style ratios, the min-bad-samples floor, the capped forecast horizon);
 *   - the layout invariant: every visual row of every board is 24 columns wide at one height, no
 *     stat narrower than w3 or wider than w12 with a sparkline, no empty SLO selector — on the
 *     reference packs and on synthetic packs with 1, 2, 3, 5, 7, 9, 12, 13 and 25 SLIs and 1, 3, 4
 *     and 5 derived views — with the contract-block shapes, the tile rows, the legend by width, the
 *     bound-SLO bar-gauge filter, unknown bindings and a pack module's tiles pinned.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { genericBoards, checkBindings } from './lib/dashboards/generic.mjs';
import { derivedViewPanel, derivedSliTiles, derivedSliTrend, thresholdSteps, okAbove, splitWidths, tileRows, viewWidths, stat, C } from './lib/dashboards/lib.mjs';
import { compileGrafanaDashboard } from './lib/compile.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileBurnRules, toYaml, boolify, packStepSeconds, sliLegs, sliStepSeconds, forecastHorizon, forecastSeverity, metricPrefix, forFor,
  durationSeconds, packSnippet,
} from './lib/burn-rules.mjs';
import { compilePrometheusRules } from './lib/compile.mjs';
import { SPEC_DIR } from './lib/validator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKS = readdirSync(resolve(ROOT, 'reference-packs')).filter(f => f.endsWith('.pack.yaml')).map(f => `reference-packs/${f}`);
const load = (p) => parseYaml(readFileSync(resolve(ROOT, p), 'utf8'));

test('reference packs exist', () => { assert.ok(PACKS.length >= 3, `found ${PACKS.length}`); });

for (const packPath of PACKS) {
  const pack = load(packPath);
  const name = pack.metadata.name;

  test(`${name}: dashboards cover every declared board and binding`, () => {
    const boards = genericBoards(pack);
    const unifiedId = `${name}-unified`;
    const declaresUnified = pack.spec.dashboards.some(d => d.id === unifiedId);
    assert.equal(boards.length, pack.spec.dashboards.length + (declaresUnified ? 0 : 1), 'one board per declared dashboard plus the unified board');
    assert.deepEqual(checkBindings(pack, boards), []);
    // the unified board is the pack on one page: every SLI and SLO bound, in the pack's section order
    const unified = boards.find(b => b.id === unifiedId);
    assert.ok(unified, 'unified board generated');
    assert.equal(unified.file, `${unifiedId}.json`);
    const rows = unified.dashboard.panels.filter(p => p.type === 'row').map(p => p.title);
    assert.match(rows[0], /Contract/);
    assert.ok(rows.some(r => /Policy and alerting/.test(r)), 'unified board has the policy row');
    if ((pack.spec.validation?.chaos_experiments || []).length) assert.ok(rows.some(r => /MTTD, MTTR/.test(r)), 'unified board has the validation row');
    if ((pack.spec.validation?.synthetic_checks || []).length) assert.ok(rows.some(r => /synthetic/.test(r)), 'unified board lists the synthetic checks');
    assert.ok(rows.some(r => /Pipelines/.test(r)) && rows.some(r => /Logs and traces/.test(r)), 'unified board ends with pipelines, logs and traces');
    const bound = new Set(unified.dashboard.panels.flatMap(p => p.pack?.binds_to || []));
    for (const s of pack.spec.slis) assert.ok(bound.has(`slis.${s.id}`), `unified binds slis.${s.id}`);
    for (const s of pack.spec.slos) assert.ok(bound.has(`slos.${s.id}`), `unified binds slos.${s.id}`);
    for (const b of boards) {
      assert.equal(b.dashboard.uid, b.id);
      assert.ok(b.file.endsWith('.json'));
      const panels = b.dashboard.panels.filter(p => p.type !== 'row');
      assert.ok(panels.length >= 2, `${b.id} has ${panels.length} panels`);
      for (const p of panels) {
        assert.ok(p.gridPos && p.gridPos.w > 0 && p.gridPos.w <= 24, `${b.id}/${p.title} gridPos`);
        if (p.type !== 'text') assert.ok((p.targets || []).length > 0, `${b.id}/${p.title} has no target`);
      }
      // a dashboard serialises to JSON Grafana can read back (undefined-valued keys are dropped, as intended)
      const round = JSON.parse(JSON.stringify(b.dashboard));
      assert.equal(round.uid, b.id);
      assert.equal(round.panels.length, b.dashboard.panels.length);
      assert.equal(round.schemaVersion, 41);
    }
    // a declared board carries exactly what it declares: its bindings and the alert timelines
    for (const d of pack.spec.dashboards.filter(x => x.source)) {
      const b = boards.find(x => x.id === d.id);
      const bound = new Set(b.dashboard.panels.flatMap(p => p.pack?.binds_to || []));
      for (const x of d.panel_bindings || []) assert.ok(bound.has(x.binds_to), `${d.id} binds ${x.binds_to}`);
      assert.ok(b.dashboard.panels.some(p => p.type === 'row' && /Alerting/.test(p.title)), `${d.id} has the alerting row`);
    }
  });

  test(`${name}: burn rules cover the policy with the corrected PromQL`, () => {
    const r = compileBurnRules(pack, { step: packStepSeconds(pack) });
    const parsed = parseYaml(toYaml(r.groups, ['# test']));
    const rules = parsed.groups.flatMap(g => g.rules);
    const alerts = Object.fromEntries(rules.filter(x => x.alert).map(x => [x.alert, x]));
    let windows = 0;
    for (const ba of pack.spec.policy.burn_rate_alerts) for (const w of ba.windows) {
      windows++;
      const n = `${ba.slo}_burn_${w.factor}x_${w.short}_${w.long}`.replace(/[^a-zA-Z0-9_]/g, '_');
      assert.ok(alerts[n], `missing ${n}`);
      assert.equal(alerts[n].labels.slo, ba.slo);
      assert.equal(alerts[n].labels.severity, w.severity);
      assert.equal(alerts[n].labels.pack, name);
      assert.match(alerts[n].expr, />= 2\s*\)\s*$/, `${n} lacks the min-bad-samples floor`);
    }
    assert.equal(r.burnCount, windows);
    for (const f of pack.spec.policy.forecasts || []) {
      const a = alerts[`${f.slo}_forecast_breach`];
      assert.ok(a, `missing forecast for ${f.slo}`);
      assert.match(a.expr, /predict_linear\(.*\[1d\], (\d+)\)/);
      assert.ok(Number(/, (\d+)\) > 1/.exec(a.expr)[1]) <= 86400, 'horizon capped at 1d');
      assert.equal(a.labels.kind, 'forecast');
    }
    // error-budget records are per SLO (slo/sli/service); a threshold SLI's error ratio is per SLI (sli/service, once)
    for (const rec of rules.filter(x => x.record && /:errorbudget:/.test(x.record))) for (const l of ['slo', 'sli', 'service']) assert.ok(rec.labels[l], `${rec.record} lacks ${l}`);
    const ratioRecs = rules.filter(x => x.record && /:error_ratio_5m$/.test(x.record));
    for (const rec of ratioRecs) { assert.deepEqual(Object.keys(rec.labels), ['sli', 'service'], `${rec.record} labels`); }
    assert.equal(new Set(ratioRecs.map(r => r.record)).size, ratioRecs.length, 'one error_ratio_5m per threshold SLI');
    assert.doesNotMatch(packSnippet(r.recording), /undefined/, 'the pack snippet prints only the labels a record has');
    // every SLO has a 5m and a 1h burn recording rule
    for (const slo of pack.spec.slos) for (const w of ['5m', '1h']) assert.ok(rules.some(x => x.record === `${metricPrefix(name)}:errorbudget:burn_${w}` && x.labels.slo === slo.id), `${slo.id} burn_${w}`);
    // a threshold SLI is read from the pack's own recording rule at THAT rule's interval, never at the scrape step
    for (const sli of pack.spec.slis.filter(s => s.type === 'threshold')) {
      const slo = pack.spec.slos.find(s => s.sli === sli.id); if (!slo) continue;
      const rule = pack.spec.queries.recording_rules.find(x => String(x.expr).trim() === `ref:slis.${sli.id}`);
      const rec = rules.find(x => x.record === `${metricPrefix(name)}:errorbudget:burn_5m` && x.labels.slo === slo.id);
      if (!rule || !rec) continue;
      const step = durationSeconds(rule.interval) || 30;
      assert.ok(rec.expr.includes(`max(${rule.name}) > bool`) && rec.expr.includes(`[5m:${step}s]) / ${Math.round(300 / step)}`), `${sli.id}: ${rec.expr}`);
      // and the SLI's own error_ratio_5m record is that ratio (not `1 - ratio_5m`)
      const ratioRec = rules.find(x => x.record === `${metricPrefix(name)}:${sli.id}:error_ratio_5m`);
      assert.ok(ratioRec, `${sli.id}: error_ratio_5m record`);
      assert.ok(ratioRec.expr.startsWith(`(sum_over_time((max(${rule.name}) > bool`), `${sli.id}: ${ratioRec.expr}`);
      assert.ok(ratioRec.expr.endsWith(`[5m:${step}s]) / ${Math.round(300 / step)})`), `${sli.id}: ${ratioRec.expr}`);
    }
    // rate-style ratios divide by the events that happened; state-style ones use bool comparisons
    for (const sli of pack.spec.slis.filter(s => s.type === 'ratio')) {
      const slo = pack.spec.slos.find(s => s.sli === sli.id); if (!slo) continue;
      const rec = rules.find(x => x.record === `${metricPrefix(name)}:errorbudget:burn_5m` && x.labels.slo === slo.id);
      if (/\[\d+[smhd]\]/.test(sli.good)) assert.match(rec.expr, /clamp_min\(/, `${sli.id}: event denominator`);
      else assert.doesNotMatch(rec.expr, /(==|!=|<|>)\s+(?!bool)[^b]/, `${sli.id}: comparison without bool`);
    }
  });
}

// ---------------------------------------------------------------- layout invariant
/** Panels grouped by their visual row (gridPos.y), each row left to right. */
const rowsOf = (panels) => {
  const by = new Map();
  for (const p of panels) { if (!by.has(p.gridPos.y)) by.set(p.gridPos.y, []); by.get(p.gridPos.y).push(p); }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([y, ps]) => ({ y, panels: ps.sort((a, b) => a.gridPos.x - b.gridPos.x) }));
};
/**
 * Every row is exactly 24 wide, tiled from x = 0 without a gap, at one height; rows and text
 * panels are w24 on their own; no stat is narrower than w3 (a w2 stat with a title, a value, a
 * unit and a sparkline is not legible) or wider than w12 with a sparkline (a banner); and no
 * target carries the empty selector `{slo=~""}`.
 */
function assertSymmetric(boardId, panels) {
  for (const { y, panels: ps } of rowsOf(panels)) {
    const label = `${boardId} y=${y}: ${ps.map(p => `${p.type} ${p.gridPos.w}x${p.gridPos.h}`).join(' | ')}`;
    assert.equal(ps.reduce((n, p) => n + p.gridPos.w, 0), 24, `row is not 24 wide — ${label}`);
    assert.equal(new Set(ps.map(p => p.gridPos.h)).size, 1, `row has mixed heights — ${label}`);
    let x = 0;
    for (const p of ps) { assert.equal(p.gridPos.x, x, `gap at x=${x} — ${label}`); x += p.gridPos.w; }
    for (const p of ps) if (p.type === 'row' || p.type === 'text') assert.equal(p.gridPos.w, 24, `${p.type} panel narrower than the row — ${label}`);
    if (ps[0].type === 'row') assert.equal(ps[0].gridPos.h, 1, label);
    for (const p of ps) if (p.type === 'stat') {
      assert.ok(p.gridPos.w >= 3, `stat narrower than w3 — ${label}`);
      assert.ok(p.gridPos.w <= 12 || p.options.graphMode !== 'area', `stat wider than w12 with a sparkline — ${label}`);
    }
    for (const p of ps) for (const t of p.targets || []) assert.doesNotMatch(String(t.expr || ''), /\{slo=~""\}/, `empty SLO selector — ${label}`);
  }
}
/** The panels under the row whose title matches `re`, up to the next row. */
const section = (panels, re) => {
  const i = panels.findIndex(p => p.type === 'row' && re.test(p.title));
  assert.ok(i >= 0, `row ${re} exists`);
  const j = panels.findIndex((p, k) => k > i && p.type === 'row');
  return panels.slice(i + 1, j < 0 ? panels.length : j);
};
const shape = (panels) => panels.map(p => [p.type, p.gridPos.w, p.gridPos.h]);
const bound = (panels, prefix) => panels.filter(p => p.type === 'stat' && (p.pack?.binds_to || []).some(t => t.startsWith(prefix)));
/** The widths of a run of tiles per visual row: [[5,5,5,5,4],[6,6,6,6]]. */
const tileRowsOf = (tiles) => rowsOf(tiles).map(r => r.panels.map(p => p.gridPos.w));
// The contract-block shapes (generic.mjs contractBlock), by bound SLIs N and SLOs M.
const CURVES6 = [['bargauge', 12, 8], ['timeseries', 6, 8], ['timeseries', 6, 8]];
const ONE = [['stat', 6, 8], ['stat', 6, 8], ['timeseries', 6, 8], ['timeseries', 6, 8]];                       // N = 1, M = 1: tile, burn tile, curves
const ONE_MANY = [['stat', 6, 8], ['bargauge', 18, 8], ['timeseries', 12, 8], ['timeseries', 12, 8]];          // N = 1, M ≥ 2
const TWO = [['stat', 6, 8], ['stat', 6, 8], ['bargauge', 12, 8], ['timeseries', 12, 8], ['timeseries', 12, 8]]; // N = 2
const MANY = (n) => [...tileRows(n).flat().map(w => ['stat', w, 4]), ...CURVES6];                                 // N ≥ 3
const TILES_ONLY = (n) => (n === 1 ? [['stat', 6, 8], ['timeseries', 18, 8]] : tileRows(n).flat().map(w => ['stat', w, 4])); // M = 0
const contractOf = (n, m) => (m === 0 ? TILES_ONLY(n) : n === 0 ? CURVES6 : n >= 3 ? MANY(n) : n === 2 ? TWO : m === 1 ? ONE : ONE_MANY);
const PROVIDER = { kind: 'grafana', version: '11.3', schemaVersion: 41 };
const bindOf = (s, o, w) => [...s.map(x => ({ panel: `sli-${x}`, binds_to: `slis.${x}` })), ...o.map(x => ({ panel: `slo-${x}`, binds_to: `slos.${x}` })), ...w.map(x => ({ panel: `view-${x}`, binds_to: `ref:queries.${x}` }))];
const srcBoard = (id, panel_bindings) => ({ id, provider: PROVIDER, folder: 'kafka', source: `file://dashboards/${id}.json`, panel_bindings });
const burnBoard = (id, slos) => ({ id, provider: PROVIDER, folder: 'kafka', template: 'ref:platform/slo-burn-template', params: { slos } });
/**
 * A pack shaped like the kafka reference pack with n SLIs (its six, then synthesised threshold
 * SLIs) and one SLO, policy window and — for the first three — forecast each, v renderable
 * derived views plus the pack's golden-signals note view (first, so the layout has to move it
 * below the graphs), and boards rebuilt to bind them: a source board per contract shape (all,
 * first, pair, one SLI with two SLOs, a tile and a trend bound to the same SLI, SLOs only, SLIs
 * only), a burn board of every SLO, of the first one and of none, and a per-resource board.
 * checkBindings stays green on every one.
 */
function syntheticPack(n, v) {
  const p = structuredClone(load('reference-packs/kafka.pack.yaml'));
  const extra = (i) => ({ id: `synthetic_${i}`, type: 'threshold', description: `Synthetic SLI ${i}.`, query: `max(kafka_synthetic_${i})`, threshold: 10, unit: 'messages' });
  const slis = [...p.spec.slis, ...Array.from({ length: Math.max(0, n - p.spec.slis.length) }, (_, i) => extra(p.spec.slis.length + i + 1))].slice(0, n);
  const sliIds = slis.map(s => s.id);
  const slos = [...p.spec.slos, ...slis.filter(s => s.id.startsWith('synthetic_')).map(s => ({ id: `${s.id}_99`, sli: s.id, objective: 0.99, window: '7d' }))].filter(s => sliIds.includes(s.sli));
  const sloIds = slos.map(s => s.id);
  assert.equal(sloIds.length, n, 'one SLO per SLI');
  p.spec.slis = slis; p.spec.slos = slos;
  p.spec.policy.burn_rate_alerts = [...p.spec.policy.burn_rate_alerts, ...slos.filter(s => s.id.endsWith('_99')).map(s => ({ slo: s.id, windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] }))].filter(b => sloIds.includes(b.slo));
  p.spec.policy.forecasts = (p.spec.policy.forecasts || []).filter(f => sloIds.includes(f.slo));
  const graphs = Array.from({ length: v }, (_, i) => ({ id: `per_resource_${i + 1}`, bind: 'ref:platform/per-resource-rollup', params: { metric: `kafka_synthetic_${i + 1}_total{topic!=""}`, by: ['topic'] } }));
  const viewIds = graphs.map(g => g.id);
  p.spec.queries.derived_views = [p.spec.queries.derived_views.find(x => x.id === 'golden_signals_kafka'), ...graphs];
  p.spec.dashboards = [
    srcBoard('kafka-all', bindOf(sliIds, sloIds, viewIds)),
    srcBoard('kafka-first', bindOf(sliIds.slice(0, 1), sloIds.slice(0, 1), viewIds.slice(0, 1))),
    srcBoard('kafka-pair', bindOf(sliIds.slice(0, 2), sloIds.slice(0, 2), [])),
    srcBoard('kafka-one-two', bindOf(sliIds.slice(0, 1), sloIds.slice(0, 2), [])),
    srcBoard('kafka-dup', [...bindOf(sliIds.slice(0, 1), sloIds.slice(0, 1), []), { panel: 'trend', binds_to: `slis.${sliIds[0]}` }]),
    srcBoard('kafka-slos-only', bindOf([], sloIds.slice(0, 1), [])),
    srcBoard('kafka-slis-only', bindOf(sliIds, [], viewIds)),
    burnBoard('kafka-burn-all', sloIds),
    burnBoard('kafka-burn-first', sloIds.slice(0, 1)),
    burnBoard('kafka-burn-none', []),
    { id: 'kafka-view', provider: PROVIDER, folder: 'kafka', template: 'ref:platform/per-resource-template', params: { view: viewIds[0] } },
  ];
  return { pack: p, sliIds, sloIds, viewIds };
}

test('splitWidths, tileRows and viewWidths fill 24 columns with tiles that differ by at most one and are never narrower than w3', () => {
  assert.deepEqual(splitWidths(1), [24]);
  assert.deepEqual(splitWidths(2), [12, 12]);
  assert.deepEqual(splitWidths(3), [8, 8, 8]);
  assert.deepEqual(splitWidths(5), [5, 5, 5, 5, 4]);
  assert.deepEqual(splitWidths(6), [4, 4, 4, 4, 4, 4]);
  assert.deepEqual(splitWidths(7), [4, 4, 4, 3, 3, 3, 3]);
  assert.deepEqual(splitWidths(8), [3, 3, 3, 3, 3, 3, 3, 3]);
  assert.deepEqual(splitWidths(0), []);
  assert.deepEqual(splitWidths(-1), []);
  assert.deepEqual(splitWidths(25), Array(25).fill(1), 'more tiles than columns: every tile the narrowest column');
  for (let n = 1; n <= 24; n++) {
    const w = splitWidths(n);
    assert.equal(w.length, n);
    assert.equal(w.reduce((a, b) => a + b, 0), 24, `${n} tiles sum to 24`);
    assert.ok(Math.max(...w) - Math.min(...w) <= 1, `${n} tiles differ by at most one`);
    for (let i = 1; i < n; i++) assert.ok(w[i] <= w[i - 1], `${n}: the remainder sits on the first tiles`);
  }
  assert.deepEqual(splitWidths(3, 12), [4, 4, 4]);
  // tileRows: at most eight per row, the fewest rows, larger rows first, so 9 SLIs never get w2 tiles
  assert.deepEqual(tileRows(0), []);
  assert.deepEqual(tileRows(1), [[24]]);
  assert.deepEqual(tileRows(8), [Array(8).fill(3)]);
  assert.deepEqual(tileRows(9), [[5, 5, 5, 5, 4], [6, 6, 6, 6]]);
  assert.deepEqual(tileRows(12), [Array(6).fill(4), Array(6).fill(4)]);
  assert.deepEqual(tileRows(13), [[4, 4, 4, 3, 3, 3, 3], Array(6).fill(4)]);
  assert.deepEqual(tileRows(16), [Array(8).fill(3), Array(8).fill(3)]);
  assert.deepEqual(tileRows(25), [[4, 4, 4, 3, 3, 3, 3], Array(6).fill(4), Array(6).fill(4), Array(6).fill(4)]);
  for (let n = 1; n <= 64; n++) {
    const rows = tileRows(n);
    assert.equal(rows.length, Math.ceil(n / 8), `${n} tiles: the fewest rows of at most eight`);
    assert.equal(rows.flat().length, n);
    for (const r of rows) assert.equal(r.reduce((a, b) => a + b, 0), 24, `${n} tiles: every row sums to 24`);
    assert.ok(Math.min(...rows.flat()) >= 3, `${n} tiles: none narrower than w3`);
    const counts = rows.map(r => r.length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${n} tiles: row counts differ by at most one`);
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i] <= counts[i - 1], `${n} tiles: the larger rows come first`);
  }
  assert.deepEqual(viewWidths(0), []);
  assert.deepEqual(viewWidths(1), [24]);
  assert.deepEqual(viewWidths(2), [12, 12]);
  assert.deepEqual(viewWidths(3), [8, 8, 8]);
  assert.deepEqual(viewWidths(4), [12, 12, 12, 12]);
  assert.deepEqual(viewWidths(5), [12, 12, 8, 8, 8]);
  assert.deepEqual(viewWidths(7), [12, 12, 12, 12, 8, 8, 8]);
  // laid out left to right, every row of views closes at 24
  for (let n = 1; n <= 12; n++) {
    let x = 0;
    for (const w of viewWidths(n)) { x += w; if (x === 24) x = 0; assert.ok(x < 24, `${n} views: a row overflows`); }
    assert.equal(x, 0, `${n} views: the last row is full`);
  }
});

test('every generated row is 24 columns wide at one height: reference packs, and packs with 1, 2, 3, 5, 7, 9, 12, 13, 25 SLIs and 1, 3, 4, 5 derived views', () => {
  for (const packPath of PACKS) for (const b of genericBoards(load(packPath))) assertSymmetric(b.id, b.dashboard.panels);
  const burn1h = 'kafka:errorbudget:burn_1h';
  const legendOf = (p) => [p.gridPos.w, p.options.legend.displayMode, p.options.legend.placement];
  for (const n of [1, 2, 3, 5, 7, 9, 12, 13, 25]) for (const v of [1, 3, 4, 5]) {
    const { pack, sloIds } = syntheticPack(n, v);
    const boards = genericBoards(pack);
    const at = (id) => boards.find(b => b.id === id).dashboard.panels;
    assert.deepEqual(checkBindings(pack, boards), [], `${n} SLIs, ${v} views: every binding bound`);
    for (const b of boards) assertSymmetric(`${n} SLIs/${v} views ${b.id}`, b.dashboard.panels);
    // unified: the contract block holds every SLI and SLO, so it takes the same shape as a board binding them all
    const contract = (id) => shape(section(at(id), /Contract/));
    assert.deepEqual(contract('kafka-unified'), contractOf(n, n), `${n} SLIs: the unified contract block`);
    // ... and its tiles come in rows of at most eight (9 → 5,5,5,5,4 over 6,6,6,6; 25 → four rows), never a w2 tile
    const tiles = bound(at('kafka-unified'), 'slis.');
    assert.equal(tiles.length, n);
    if (n >= 3) assert.deepEqual(tileRowsOf(tiles), tileRows(n), `${n} SLIs: tile rows`);
    else assert.deepEqual(tiles.map(t => [t.gridPos.w, t.gridPos.h]), Array(n).fill([6, 8]), `${n} SLIs: the tiles sit at the burn panels' height`);
    // unified signals row: the graphs by viewWidths first, the pack's note view w24 below them
    const signals = section(at('kafka-unified'), /Signals/);
    const graphs = signals.filter(p => p.type === 'timeseries'), notes = signals.filter(p => p.type === 'text');
    assert.deepEqual(graphs.map(g => g.gridPos.w), viewWidths(v), `${v} views: viewWidths on the unified board`);
    assert.equal(notes.length, 1, 'the golden-signals view is a note');
    assert.ok(notes[0].gridPos.w === 24 && notes[0].gridPos.y > graphs.at(-1).gridPos.y, 'the note sits under the graphs on its own row');
    // a view on a trio row is w8 and gets the bottom list legend; on a full or half row the right-hand table (ts() legend 'auto')
    assert.deepEqual(graphs.map(legendOf), viewWidths(v).map(w => [w, w >= 12 ? 'table' : 'list', w >= 12 ? 'right' : 'bottom']), `${v} views: the legend follows the width`);
    // source boards: the contract block by the number of bound SLIs and SLOs
    assert.deepEqual(contract('kafka-all'), contractOf(n, n), `${n} SLIs: a board binding them all`);
    assert.deepEqual(contract('kafka-first'), ONE);
    assert.deepEqual(contract('kafka-dup'), ONE, 'a tile and a trend bound to the same SLI render one tile');
    assert.deepEqual(contract('kafka-pair'), n >= 2 ? TWO : ONE);
    assert.deepEqual(contract('kafka-one-two'), n >= 2 ? ONE_MANY : ONE, 'one SLI with two SLOs: the tile beside a w18 bar gauge');
    assert.deepEqual(contract('kafka-slos-only'), CURVES6);
    assert.deepEqual(contract('kafka-slis-only'), TILES_ONLY(n), n === 1 ? 'a lone tile sits beside its trend' : 'no bound SLO: the tiles only');
    if (n === 1) {
      const trend = section(at('kafka-slis-only'), /Contract/)[1];
      assert.deepEqual(trend.pack.binds_to, [`slis.${pack.spec.slis[0].id}`]);
      assert.match(trend.title, / · over time$/);
      assert.equal(trend.fieldConfig.defaults.custom.thresholdsStyle.mode, 'dashed', 'the objective is a dashed line');
    }
    // the burn tile that stands in for a one-bar gauge: bound to the SLO, its own series, its policy thresholds
    const burnStat = section(at('kafka-first'), /Contract/)[1];
    assert.deepEqual([burnStat.targets[0].expr, burnStat.pack.binds_to], [`${burn1h}{slo="${sloIds[0]}"}`, [`slos.${sloIds[0]}`]]);
    assert.equal(section(at('kafka-first'), /Contract/).filter(p => p.type === 'bargauge').length, 0, 'one SLO: no bar gauge');
    // derived views: viewWidths on a source board, the whole row on a per-resource board
    assert.deepEqual(section(at('kafka-all'), /Derived views/).map(p => p.gridPos.w), viewWidths(v));
    assert.deepEqual(section(at('kafka-first'), /Derived views/).map(p => p.gridPos.w), [24]);
    assert.equal(at('kafka-view').find(p => p.type === 'timeseries').gridPos.w, 24);
    // burn-template tiles: tile rows; a single SLO's tile stands beside the alert timeline with no bar gauge
    const burnTilesOf = (id) => bound(at(id), 'slos.');
    if (n >= 3) assert.deepEqual(tileRowsOf(burnTilesOf('kafka-burn-all')), tileRows(n));
    else if (n === 2) assert.deepEqual(burnTilesOf('kafka-burn-all').map(t => [t.gridPos.w, t.gridPos.h]), [[12, 4], [12, 4]]);
    assert.deepEqual(shape(at('kafka-burn-first').slice(1, 3)), [['stat', 6, 8], ['state-timeline', 18, 8]]);
    assert.equal(at('kafka-burn-first').filter(p => p.type === 'bargauge').length, 0);
    assert.equal(burnTilesOf('kafka-burn-none').length, 0);
    // the bar gauge: filtered to the bound SLOs, bare when the board binds every SLO of the pack (or names none)
    const bars = (id) => { const b = at(id).find(p => p.type === 'bargauge'); return [b.targets[0].expr, b.fieldConfig.overrides.map(o => o.matcher.options)]; };
    if (n >= 2) for (const id of ['kafka-unified', 'kafka-all', 'kafka-burn-all']) assert.deepEqual(bars(id), [burn1h, sloIds], `${id} holds every SLO: the bare series`);
    else assert.equal(bound(at('kafka-unified'), 'slos.')[0].targets[0].expr, `${burn1h}{slo="${sloIds[0]}"}`, 'a one-SLO pack: the unified board shows the burn tile');
    assert.deepEqual(bars('kafka-burn-none'), [burn1h, sloIds], 'params.slos [] is not a filter');
    assert.deepEqual(bars('kafka-slos-only'), [n === 1 ? burn1h : `${burn1h}{slo=~"${sloIds[0]}"}`, sloIds.slice(0, 1)]);
    if (n >= 3) {
      assert.deepEqual(bars('kafka-pair'), [`${burn1h}{slo=~"${sloIds[0]}|${sloIds[1]}"}`, sloIds.slice(0, 2)]);
      assert.deepEqual(bars('kafka-one-two'), [`${burn1h}{slo=~"${sloIds[0]}|${sloIds[1]}"}`, sloIds.slice(0, 2)]);
    }
  }
  // the committed kafka boards: consumer-lag binds one SLO and shows its burn tile instead of a one-bar gauge; the unified board's gauge is bare
  const kafka = genericBoards(load('reference-packs/kafka.pack.yaml'));
  const lag = kafka.find(b => b.id === 'kafka-consumer-lag').dashboard.panels;
  assert.equal(lag.filter(p => p.type === 'bargauge').length, 0);
  assert.equal(bound(lag, 'slos.')[0].targets[0].expr, `${burn1h}{slo="consumer_lag_99_under_60s"}`);
  assert.equal(kafka.find(b => b.id === 'kafka-unified').dashboard.panels.find(p => p.type === 'bargauge').targets[0].expr, burn1h);
  // eight SLOs on a burn-template board: eight tiles of w3 on one row
  const grafana = load('reference-packs/grafana.pack.yaml');
  assert.equal(grafana.spec.slos.length, 8);
  grafana.spec.dashboards.find(d => /slo-burn-template$/.test(d.template || '')).params.slos = grafana.spec.slos.map(s => s.id);
  const eight = bound(genericBoards(grafana).find(b => b.id === 'grafana-slo-burn').dashboard.panels, 'slos.');
  assert.deepEqual(eight.map(t => [t.gridPos.w, t.gridPos.y]), Array(8).fill([3, eight[0].gridPos.y]));
});

test('a binding that names no SLI or SLO of the pack is reported, never rendered as an empty filter', () => {
  const { pack } = syntheticPack(3, 1);
  pack.spec.dashboards = [
    srcBoard('kafka-typo', [{ panel: 'tile', binds_to: 'slis.nope' }, { panel: 'burn', binds_to: 'slos.nope' }, { panel: 'ok', binds_to: `slis.${pack.spec.slis[0].id}` }]),
    burnBoard('kafka-burn-typo', ['nope', pack.spec.slos[0].id]),
  ];
  const boards = genericBoards(pack);
  assert.deepEqual(checkBindings(pack, boards), [
    'kafka-typo: binding slis.nope names no SLI of the pack',
    'kafka-typo: binding slos.nope names no SLO of the pack',
    'kafka-burn-typo: params.slos nope names no SLO of the pack',
  ]);
  for (const b of boards) assertSymmetric(b.id, b.dashboard.panels);
  // the typo'd SLO does not shape the block: the board holds one SLI and no SLO, so the tile sits beside its trend
  assert.deepEqual(shape(section(boards.find(b => b.id === 'kafka-typo').dashboard.panels, /Contract/)), TILES_ONLY(1));
});

test('spec 1.3 good_when on the boards: a floor SLI\'s tile colours lower-is-worse (amber under the bound, red under half of it), a ceiling higher-is-worse as before, absent means below; the dashed line sits at the bound either way; the descriptions name the direction', () => {
  const sli = (over) => ({ id: 'members', type: 'threshold', description: 'Live settlement consumers.', query: 'min(members)', threshold: 2, unit: 'consumers', ...over });
  const packOf = (s) => ({ metadata: { name: 'settle', version: '0.0.1' }, spec: { slis: [s], slos: [{ id: 'members_99_9', sli: 'members', objective: 0.999, window: '30d' }] } });
  const floor = sli({ good_when: 'above' }), ceiling = sli({ good_when: 'below' }), plain = sli({});
  // Through the generator: the unified board's tile bound to the floor SLI, every binding satisfied.
  const boards = genericBoards(packOf(floor));
  assert.deepEqual(checkBindings(packOf(floor), boards), []);
  const tile = boards[0].dashboard.panels.find(p => p.type === 'stat' && p.pack?.binds_to?.includes('slis.members'));
  assert.deepEqual(tile.fieldConfig.defaults.thresholds.steps, [{ color: C.red, value: null }, { color: C.amber, value: 1 }, { color: C.green, value: 2 }], 'a floor: red under 1, amber under 2, green at or above the bound');
  assert.equal(tile.description, 'Live settlement consumers. SLO 99.9 % over 30d. Good when ≥ 2 consumers.');
  // The same tile built for a ceiling, declared or absent: okAbove as every 1.2 board had it, the description with ≤.
  const [ct] = derivedSliTiles(packOf(ceiling), null), [pt] = derivedSliTiles(packOf(plain), null);
  assert.deepEqual(ct.fieldConfig.defaults.thresholds.steps, [{ color: C.green, value: null }, { color: C.amber, value: 2 }, { color: C.red, value: 4 }], 'a ceiling: green under the bound, amber at it, red at twice it');
  assert.equal(ct.description, 'Live settlement consumers. SLO 99.9 % over 30d. Good when ≤ 2 consumers.');
  assert.deepEqual({ ...pt, id: 0 }, { ...ct, id: 0 }, 'absent means below: the tile of a 1.2 SLI is the tile of a declared ceiling');
  assert.deepEqual(thresholdSteps({ type: 'threshold', threshold: 0.5 }), okAbove(0.5, 1));
  assert.deepEqual(thresholdSteps({ type: 'threshold', good_when: 'above', threshold: -2 }).map(s => s.value), [null, -3, -2], 'a negative floor keeps its steps ascending');
  // A bound of 0 has no amber band (twice 0 and half of 0 are 0). Grafana paints the last step whose value is <= the
  // sample, so two steps at 0 painted the good 0 of a ceiling red (bf00c01: [green, amber 0, red 0]) while the tile's
  // description says "Good when ≤ 0 messages"; a floor at 0 got amber and green both at 0. The bound itself stays good.
  const paint = (steps, v) => steps.filter(st => st.value === null || v >= st.value).at(-1).color;   // Grafana's getActiveThreshold on ascending steps
  const zeroCeiling = thresholdSteps({ type: 'threshold', threshold: 0 }), zeroFloor = thresholdSteps({ type: 'threshold', good_when: 'above', threshold: 0 });
  assert.deepEqual(zeroCeiling, [{ color: C.green, value: null }, { color: C.red, value: Number.MIN_VALUE }], 'a ceiling at 0: green up to and including 0, red from the smallest value above it, no amber');
  assert.deepEqual(zeroFloor, [{ color: C.red, value: null }, { color: C.green, value: 0 }], 'a floor at 0: red under 0, green from 0, no amber');
  assert.deepEqual([paint(zeroCeiling, 0), paint(zeroCeiling, 1e-9), paint(zeroCeiling, 1), paint(zeroFloor, 0), paint(zeroFloor, -1e-9), paint(zeroFloor, -1)], [C.green, C.red, C.red, C.green, C.red, C.red], 'the good 0 is green on both sides; anything past the bound is red');
  assert.equal(JSON.parse(JSON.stringify(zeroCeiling))[1].value, Number.MIN_VALUE, 'the step survives the board JSON (5e-324 parses back)');
  assert.ok(new Set(zeroCeiling.map(st => st.value)).size === 2 && new Set(zeroFloor.map(st => st.value)).size === 2, 'no two steps share a value');
  const [zt] = derivedSliTiles(packOf(sli({ description: 'Dead-letter depth.', threshold: 0, unit: 'messages' })), null);
  assert.deepEqual(zt.fieldConfig.defaults.thresholds.steps, zeroCeiling, 'the tile of a 0-bound ceiling (the library entry dlq_depth) carries the guarded steps');
  assert.equal(zt.description, 'Dead-letter depth. SLO 99.9 % over 30d. Good when ≤ 0 messages.');
  // The trend: the dashed line at the bound whichever way the SLI faces; the description says which side is good.
  const ftr = derivedSliTrend(packOf(floor), floor), ctr = derivedSliTrend(packOf(ceiling), ceiling), ptr = derivedSliTrend(packOf(plain), plain);
  assert.deepEqual([ftr, ctr, ptr].map(p => p.fieldConfig.defaults.thresholds.steps.at(-1).value), [2, 2, 2]);
  assert.deepEqual([ftr, ctr, ptr].map(p => p.fieldConfig.defaults.custom.thresholdsStyle.mode), ['dashed', 'dashed', 'dashed']);
  assert.equal(ftr.description, 'Live settlement consumers. The dashed line is the threshold — good when ≥ 2 consumers.');
  assert.equal(ctr.description, 'Live settlement consumers. The dashed line is the threshold — good when ≤ 2 consumers.');
  assert.equal(ptr.description, ctr.description);
  // A ratio tile says nothing about a bound (it has none); a threshold SLI without a unit prints the bare bound.
  const ratioPack = { metadata: { name: 'r', version: '0.0.1' }, spec: { slis: [{ id: 'ok', type: 'ratio', description: 'Ok.', good: 'g', total: 't' }], slos: [{ id: 'ok_99', sli: 'ok', objective: 0.99, window: '30d' }] } };
  assert.equal(derivedSliTiles(ratioPack, null)[0].description, 'Ok. SLO 99 % over 30d.');
  assert.match(derivedSliTiles(packOf(sli({ unit: undefined })), null)[0].description, / Good when ≤ 2\.$/);
});

test('a pack module\'s sliTiles gets the layout hint; tiles that ignore it keep their own row above the standard burn panels', () => {
  const honouring = { sliTiles: (pack, ids, { widths, h }) => ids.map((id, i) => stat(`tile ${id}`, `up{sli="${id}"}`, { binds: `slis.${id}`, w: widths[i], h })) };
  const ignoring = { sliTiles: (pack, ids) => ids.map(id => stat(`tile ${id}`, `up{sli="${id}"}`, { binds: `slis.${id}`, w: 4 })) };
  for (const n of [1, 2, 3, 9]) {
    const { pack } = syntheticPack(n, 1);
    const own = genericBoards(pack, { module: honouring });
    assert.deepEqual(checkBindings(pack, own), []);
    for (const b of own) assertSymmetric(`honouring ${n} ${b.id}`, b.dashboard.panels);
    const contract = (boards, id) => shape(section(boards.find(b => b.id === id).dashboard.panels, /Contract/));
    assert.deepEqual(contract(own, 'kafka-first'), ONE);
    assert.deepEqual(contract(own, 'kafka-slis-only'), TILES_ONLY(n));
    assert.deepEqual(contract(own, 'kafka-unified'), contractOf(n, n));
    // the hint ignored: the module's w4 h4 tiles as returned, then always the bar gauge w12 with the curves w6 — never
    // the one- or two-tile shapes that assume w6 h8 tiles, and no trend appended to a lone tile
    const theirs = genericBoards(pack, { module: ignoring });
    assert.deepEqual(checkBindings(pack, theirs), []);
    const tilesOf = (k) => Array(k).fill(['stat', 4, 4]);
    assert.deepEqual(contract(theirs, 'kafka-first'), [...tilesOf(1), ...CURVES6]);
    assert.deepEqual(contract(theirs, 'kafka-pair'), [...tilesOf(Math.min(n, 2)), ...CURVES6]);
    assert.deepEqual(contract(theirs, 'kafka-unified'), [...tilesOf(n), ...CURVES6]);
    assert.deepEqual(contract(theirs, 'kafka-slis-only'), tilesOf(n));
  }
});

test('the §10 certification tiles render only for a pack that declares the certification scrape job', () => {
  // The MQ harness's alert-sink is scraped as job `certification`; the reference packs declare no
  // such job. The per-pack test above only checks the row header, which the note branch renders
  // too, so a regression dropping the tiles for a pack WITH the feed would pass without this.
  const section = (pack) => {
    const panels = genericBoards(pack).find(b => b.id === `${pack.metadata.name}-unified`).dashboard.panels;
    const i = panels.findIndex(p => p.type === 'row' && /MTTD, MTTR/.test(p.title));
    assert.ok(i >= 0, 'the validation row exists');
    const j = panels.findIndex((p, k) => k > i && p.type === 'row');
    return panels.slice(i + 1, j < 0 ? panels.length : j);
  };
  const committed = load('reference-packs/kafka.pack.yaml');
  const note = section(committed);
  assert.equal(note.length, 1, 'one panel under the row without a feed');
  assert.equal(note[0].type, 'text');
  assert.equal(note[0].title, 'No certification feed');
  assert.match(JSON.stringify(note[0]), /declares 4 chaos experiments \(chaos-mesh; staging, prod\) but no certification pipeline — a scrape job named `certification` — so nothing feeds MTTD, MTTR or a verdict here\./);
  const withJob = (job) => {
    const p = structuredClone(committed);
    p.spec.pipelines.receivers.find(r => r.scrape_configs).scrape_configs.push({ job_name: job, static_configs: [{ targets: ['sink:9095'] }] });
    return p;
  };
  const tiles = section(withJob('certification'));
  assert.ok(!tiles.some(p => p.type === 'text'), 'no note when the feed exists');
  assert.equal(tiles.length, 14, 'six verdict tiles, two bar gauges, six counters');
  const titles = tiles.map(p => p.title);
  for (const t of ['Last certification', 'Certified', 'MTTD p50', 'MTTD p95', 'MTTD per expected alert · against its budget', 'Resolution after recovery · per alert', 'Conformance passed', 'Synthetic passed', 'Chaos passed', 'Checks failed', 'Run duration', 'Webhooks in the ledger']) assert.ok(titles.includes(t), `${t} rendered`);
  for (const p of tiles) for (const t of p.targets || []) assert.ok(/job="certification"/.test(t.expr) && /pack="kafka"/.test(t.expr), `${p.title} reads this pack's certification feed: ${t.expr}`);
  // the job name is exact: one that merely starts with it is not the feed
  const near = section(withJob('certification-x'));
  assert.equal(near.length, 1);
  assert.equal(near[0].type, 'text');
});

test('a derived view rates a counter with or without a label selector, and reads anything else as a gauge', () => {
  // The selector is how a pack drops a series the rollup must not show: the JMX exporter's
  // broker-wide kafka_server_brokertopicmetrics_messagesin_total has no topic label and rendered
  // as a fourth "topic" {} equal to the sum of the others (measured 2026-09-22, kafka.md §1.4).
  const pack = { metadata: { name: 'x', version: '0' }, spec: { slis: [] } };
  const panel = (metric) => derivedViewPanel(pack, { id: 'per_topic', params: { metric, by: ['topic'] } }, 'ref:queries.per_topic');
  const selected = panel('kafka_server_brokertopicmetrics_messagesin_total{topic!=""}');
  assert.equal(selected.targets[0].expr, 'sum by (topic) (rate(kafka_server_brokertopicmetrics_messagesin_total{topic!=""}[5m]))');
  assert.equal(selected.fieldConfig.defaults.unit, 'ops');
  const bare = panel('kafka_server_brokertopicmetrics_messagesin_total');
  assert.equal(bare.targets[0].expr, 'sum by (topic) (rate(kafka_server_brokertopicmetrics_messagesin_total[5m]))');
  assert.equal(bare.fieldConfig.defaults.unit, 'ops');
  const gauge = panel('kafka_log_size{topic!=""}');
  assert.equal(gauge.targets[0].expr, 'max by (topic) (kafka_log_size{topic!=""})');
  assert.equal(gauge.fieldConfig.defaults.unit, 'none');
  // the committed kafka pack carries the selector, so its throughput board never shows the {} series
  const kafka = load('reference-packs/kafka.pack.yaml');
  const view = kafka.spec.queries.derived_views.find(v => v.id === 'per_topic_throughput');
  assert.equal(view.params.metric, 'kafka_server_brokertopicmetrics_messagesin_total{topic!=""}');
  const throughput = genericBoards(kafka).find(b => b.id === 'kafka-throughput');
  assert.ok(throughput.dashboard.panels.some(p => (p.targets || []).some(t => t.expr === 'sum by (topic) (rate(kafka_server_brokertopicmetrics_messagesin_total{topic!=""}[5m]))')), 'kafka-throughput rates the selected counter');
});

test('dashboards for a dash-named pack read the slugged metric prefix everywhere', () => {
  // payment-service: every recording rule the generators and the compiler emit is payment_service:*
  const pack = load(`${SPEC_DIR}/examples/payment-service.pack.yaml`);
  const boards = genericBoards(pack);
  const json = JSON.stringify(boards);
  assert.ok(boards.length >= 2);
  assert.ok(json.includes('payment_service:errorbudget:burn_1h'), 'boards read the slugged errorbudget series');
  assert.ok(!json.includes('payment-service:'), 'no expression, description or rename key carries the raw dashed prefix');
  const targets = boards.flatMap(b => b.dashboard.panels.flatMap(p => [p, ...(p.panels || [])])).flatMap(p => p.targets || []);
  const named = targets.map(t => t.expr).filter(e => typeof e === 'string' && e.includes('__name__=~"'));
  assert.ok(named.length >= 2, 'the __name__ selectors exist');
  for (const e of named) assert.match(e, /__name__=~"payment_service:/, e);
  // label VALUES keep the raw name (ALERTS{pack=...}, service_name=...)
  assert.ok(json.includes('pack=\\"payment-service\\"'), 'ALERTS selectors keep the raw pack name');
  // an in-memory pack: hyphenated name and a hostile SLI id in the rename map
  const hostile = {
    metadata: { name: 'a-b', version: '0.0.1' },
    spec: {
      slis: [{ id: 'latência', type: 'threshold', query: 'max(lat)', threshold: 0.5, unit: 'seconds' }],
      slos: [{ id: 'lat_99', sli: 'latência', objective: 0.99, window: '30d' }],
      policy: { burn_rate_alerts: [{ slo: 'lat_99', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] }] },
      dashboards: [{ id: 'a-b-burn', template: 'ref:platform/slo-burn-template', params: { slos: ['lat_99'] } }],
    },
  };
  const hb = genericBoards(hostile);
  // the declared burn board by id (genericBoards also emits the unified board, in front)
  const burnBoard = hb.find(b => b.id === 'a-b-burn');
  assert.ok(burnBoard, 'the declared burn board is generated');
  const ratioPanel = burnBoard.dashboard.panels.find(p => /Error ratio/.test(p.title));
  assert.ok(ratioPanel, 'the burn board has the per-SLI error ratio panel');
  assert.match(ratioPanel.targets[0].expr, /^{__name__=~"a_b:/);
  const hjson = JSON.stringify(hb);
  assert.ok(hjson.includes('a_b:lat_ncia:error_ratio_5m'), 'rename keys use metricSafe(sli id)');
  assert.ok(!hjson.includes('a-b:') && !hjson.includes('a_b:latência:'), hjson.slice(0, 200));
});

test('boolify rewrites filter comparisons and leaves boolean ones alone', () => {
  assert.equal(boolify('up == 1'), 'up == bool 1');
  assert.equal(boolify('up == bool 1'), 'up == bool 1');
  assert.equal(boolify('a == b'), 'a == bool b');
  assert.equal(boolify('x >= 2 and y < 3'), 'x >= bool 2 and y < bool 3');
  // idempotent for every operator: the two-character tokens must not split into `> bool = bool`
  for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
    const once = boolify(`a ${op} 1`);
    assert.equal(once, `a ${op} bool 1`, op);
    assert.equal(boolify(once), once, `${op} idempotent`);
  }
  assert.equal(boolify('a >= bool 1'), 'a >= bool 1');
  assert.equal(boolify('a <= bool 1'), 'a <= bool 1');
  // operators inside string literals and label matchers are not comparisons
  assert.equal(boolify('label_replace(a,"x","=","y","==") == 1'), 'label_replace(a,"x","=","y","==") == bool 1');
  assert.equal(boolify('up{job!="a",re=~"b>c"} == 1'), 'up{job!="a",re=~"b>c"} == bool 1');
});

test('sliLegs recognises every SLI shape and never throws on one', () => {
  const ctx = { step: 30 };
  const events = sliLegs({ id: 'e', type: 'ratio', good: 'sum(rate(ok_total[5m]))', total: 'sum(rate(all_total[5m]))' }, '1h', ctx);
  assert.equal(events.kind, 'events');
  // the difference falls back to the total when the good selector matches no series (a 100 % outage)
  assert.equal(events.bad, '(((sum(increase(all_total[1h]))) - (sum(increase(ok_total[1h])))) or (sum(increase(all_total[1h]))))');
  assert.equal(events.ratio, `(${events.bad} / clamp_min((sum(increase(all_total[1h]))), 1))`);
  const selector = sliLegs({ id: 's', type: 'ratio', good: 'good_total', total: 'req_total{job="x"}' }, '5m', ctx);
  assert.equal(selector.kind, 'selector');
  assert.match(selector.bad, /sum\(increase\(good_total\[5m\]\)\)/);
  const state = sliLegs({ id: 'st', type: 'ratio', good: 'sum(up == 1)', total: 'count(up)' }, '5m', { step: 10 });
  assert.equal(state.kind, 'state');
  assert.equal(state.bad, 'sum(sum_over_time((1 - (up == bool 1))[5m:10s]))');
  assert.equal(state.denom, '((count(up)) * 30)');
  const threshold = sliLegs({ id: 't', type: 'threshold', query: 'max(lag)', threshold: 60 }, '5m', { step: 15, series: 'svc:t:value_5m', seriesStep: 30 });
  assert.equal(threshold.kind, 'threshold');
  assert.equal(threshold.ratio, '(sum_over_time((max(svc:t:value_5m) > bool 60)[5m:30s]) / 10)');
  const inline = sliLegs({ id: 't', type: 'threshold', query: 'max(lag)', threshold: 0.5 }, '5m', ctx);
  assert.equal(inline.ratio, '(sum_over_time((max((max(lag))) > bool 0.5)[5m:30s]) / 10)');
  // a live-drafted `total: "1"` whose good is `<good> / <total>` splits into its two counter legs
  const split = sliLegs({ id: 'k', type: 'ratio', good: 'sum(rate(ok[5m])) / sum(rate(all[5m]))', total: '1' }, '1h', ctx);
  assert.equal(split.kind, 'events');
  assert.equal(split.bad, '(((sum(increase(all[1h]))) - (sum(increase(ok[1h])))) or (sum(increase(all[1h]))))');
  const splitParens = sliLegs({ id: 'kp', type: 'ratio', good: '(sum(rate(ok{path="/a/b"}[5m]))) / (sum(rate(all[5m])))', total: '1' }, '5m', ctx);
  assert.equal(splitParens.kind, 'events', 'a / inside a label value is not a division');
  assert.ok(splitParens.bad.includes('increase(ok{path="/a/b"}[5m])'), splitParens.bad);
  assert.equal(sliLegs({ id: 'ks', type: 'ratio', good: 'ok_total / all_total', total: '1' }, '5m', ctx).kind, 'selector');
  // a bare gauge over 1 (`up{job="x"}` / 1) is a 0/1 state series per series: sampled, floored, warned
  const gw = [];
  const gauge = sliLegs({ id: 'g', type: 'ratio', good: 'up{job="x"}', total: '1' }, '5m', { step: 10, warn: (m) => gw.push(m) });
  assert.equal(gauge.kind, 'state');
  assert.equal(gauge.ratio, '(sum_over_time((1 - (up{job="x"}))[5m:10s]) / 30)');
  assert.equal(gw.length, 1);
  assert.match(gw[0], /SLI g: total is the scalar 1 and good is the bare series up; read as a 0\/1 state gauge per series, sampled every 10s/);
  // a good that neither splits into two countable legs nor is a bare series has no event or sample
  // count: no policy rules (never the unfloored `1 - good` form), warned
  const sw = [];
  assert.equal(sliLegs({ id: 'k2', type: 'ratio', good: 'avg_over_time(probe_success[5m])', total: '1' }, '1h', { step: 30, warn: (m) => sw.push(m) }), null);
  assert.equal(sliLegs({ id: 'k3', type: 'ratio', good: 'a / b / c', total: '1' }, '5m', { step: 30, warn: (m) => sw.push(m) }), null, 'two top-level divisions do not split');
  assert.equal(sw.length, 2);
  assert.ok(sw.every(m => /neither two legs nor a bare state series; no event or sample count, no policy rules$/.test(m)), sw.join('; '));
  // a bare selector next to a range expression is countable: wrapped in sum(increase()) and read as events
  const mixed = sliLegs({ id: 'l', type: 'ratio', good: 'good_total', total: 'sum(rate(req_total[5m]))' }, '5m', ctx);
  assert.equal(mixed.kind, 'events');
  assert.equal(mixed.bad, '(((sum(increase(req_total[5m]))) - (sum(increase(good_total[5m])))) or (sum(increase(req_total[5m]))))');
  assert.equal(sliLegs({ id: 'l2', type: 'ratio', good: 'sum(rate(ok[5m]))', total: 'all' }, '1h', ctx).ratio,
    '((((sum(increase(all[1h]))) - (sum(increase(ok[1h])))) or (sum(increase(all[1h])))) / clamp_min((sum(increase(all[1h]))), 1))');
  // a scalar good over a range total has no event count: no policy rules (the former naive
  // `1 - 1 / total` had no floor and no expected-sample denominator), warned
  const lw = [];
  assert.equal(sliLegs({ id: 'lg', type: 'ratio', good: '1', total: 'sum(rate(req_total[5m]))' }, '5m', { step: 30, warn: (m) => lw.push(m) }), null);
  assert.deepEqual(lw, ['SLI lg: ratio shape not recognised (good=1, total=sum(rate(req_total[5m]))); no policy rules']);
  // a bare selector is read as a raw counter only when it can be one: a recording-rule name is a
  // rate or a gauge (null, warned), a name without a counter suffix is emitted but warned about
  const rw = [];
  assert.equal(sliLegs({ id: 'rr', type: 'ratio', good: 'svc:req:good_rate_5m', total: 'svc:req:total_rate_5m' }, '1h', { step: 30, warn: (m) => rw.push(m) }), null);
  assert.deepEqual(rw, ['SLI rr: svc:req:good_rate_5m is a recording rule (a rate or a gauge), which increase() cannot count; point the SLI at the counter; no policy rules']);
  rw.length = 0;
  assert.equal(sliLegs({ id: 'rr2', type: 'ratio', good: 'ok_total', total: 'svc:req:total_rate_5m' }, '1h', { step: 30, warn: (m) => rw.push(m) }), null, 'a recorded total is not countable either');
  assert.equal(rw.length, 1);
  rw.length = 0;
  const nosuffix = sliLegs({ id: 'ns', type: 'ratio', good: 'requests_ok', total: 'requests' }, '5m', { step: 30, warn: (m) => rw.push(m) });
  assert.equal(nosuffix.kind, 'selector');
  assert.ok(nosuffix.bad.includes('sum(increase(requests_ok[5m]))'), nosuffix.bad);
  assert.deepEqual(rw, [
    'SLI ns: requests_ok is read as a raw counter (sum(increase(requests_ok[w]))); a recorded rate cannot be counted, point the SLI at the counter',
    'SLI ns: requests is read as a raw counter (sum(increase(requests[w]))); a recorded rate cannot be counted, point the SLI at the counter',
  ]);
  assert.equal(sliLegs({ id: 'sfx', type: 'ratio', good: 'ok_count', total: 'all_bucket{le="+Inf"}' }, '5m', { step: 30, warn: (m) => rw.push(m) }).kind, 'selector');
  assert.equal(rw.length, 2, '_count / _bucket / _sum / _total names are counters, not warned about');
  // the empty-good fill needs the two legs to aggregate to the same label set: `sum by (route)`
  // over `sum` matches nothing, and the fill would read a healthy service as a 100 % outage —
  // the difference is emitted without the fill (as for a derived good), warned
  const mw = [];
  const mismatch = sliLegs({ id: 'mm', type: 'ratio', good: 'sum by (route) (rate(ok_total{job="x"}[5m]))', total: 'sum(rate(all_total{job="x"}[5m]))' }, '1h', { step: 30, warn: (m) => mw.push(m) });
  assert.equal(mismatch.kind, 'events');
  assert.equal(mismatch.bad, '((sum(increase(all_total{job="x"}[1h]))) - (sum by (route) (increase(ok_total{job="x"}[1h]))))');
  assert.deepEqual(mw, ['SLI mm: good groups by (route) but total does not; the two legs will not match']);
  mw.length = 0;
  const reversed = sliLegs({ id: 'mm2', type: 'ratio', good: 'sum(rate(ok_total[5m]))', total: 'sum by (route) (rate(all_total[5m]))' }, '5m', { step: 30, warn: (m) => mw.push(m) });
  assert.ok(!reversed.bad.includes(' or ('), reversed.bad);
  assert.deepEqual(mw, ['SLI mm2: good does not group but total groups by (route); the two legs will not match']);
  mw.length = 0;
  const byAB = sliLegs({ id: 'mm3', type: 'ratio', good: 'sum by (a) (rate(ok_total[5m]))', total: 'sum by (b) (rate(all_total[5m]))' }, '5m', { step: 30, warn: (m) => mw.push(m) });
  assert.ok(!byAB.bad.includes(' or ('), byAB.bad);
  assert.deepEqual(mw, ['SLI mm3: good groups by (a) but total groups by (b); the two legs will not match']);
  mw.length = 0;
  const sameBy = sliLegs({ id: 'mm4', type: 'ratio', good: 'sum by (route, job) (rate(ok_total[5m]))', total: 'sum by (job, route) (rate(all_total[5m]))' }, '5m', { step: 30, warn: (m) => mw.push(m) });
  assert.ok(sameBy.bad.includes(' or (sum by (job, route) (increase(all_total[5m])))'), sameBy.bad);
  assert.deepEqual(mw, [], 'the same label set in another order matches, fill kept');
  assert.ok(sliLegs({ id: 'mm5', type: 'ratio', good: 'sum(rate(ok_total[5m])) by (route)', total: 'sum by (route) (rate(all_total[5m]))' }, '5m', ctx).bad.includes(' or ('), 'the trailing-modifier spelling is the same grouping');
  // a range-looking label value is not a range: never rewritten, and a bare selector carrying one
  // is still a bare selector
  const lit = sliLegs({ id: 'lit', type: 'ratio', good: 'sum(rate(x{path="[5m]",code!~"5.."}[5m]))', total: 'sum(rate(x{path="[5m]"}[5m]))' }, '1h', ctx);
  assert.equal(lit.bad, '(((sum(increase(x{path="[5m]"}[1h]))) - (sum(increase(x{path="[5m]",code!~"5.."}[1h])))) or (sum(increase(x{path="[5m]"}[1h]))))');
  const litSel = sliLegs({ id: 'lit2', type: 'ratio', good: 'ok_total{path="[5m]"}', total: 'all_total{path="[5m]"}' }, '5m', ctx);
  assert.equal(litSel.kind, 'selector');
  assert.ok(litSel.bad.includes('sum(increase(ok_total{path="[5m]"}[5m]))'), litSel.bad);
  // `rate(` inside a label value is text too: it survives byte for byte in every leg
  const litRate = sliLegs({ id: 'lit3', type: 'ratio', good: 'sum(rate(x_total{path="/rate(a)",code!~"5.."}[5m]))', total: 'sum(rate(x_total{path="/rate(a)"}[5m]))' }, '1h', ctx);
  assert.equal(litRate.kind, 'events');
  assert.equal(litRate.bad, '(((sum(increase(x_total{path="/rate(a)"}[1h]))) - (sum(increase(x_total{path="/rate(a)",code!~"5.."}[1h])))) or (sum(increase(x_total{path="/rate(a)"}[1h]))))');
  assert.equal(litRate.denom, 'clamp_min((sum(increase(x_total{path="/rate(a)"}[1h]))), 1)');
  assert.ok(!litRate.ratio.includes('increase(a)'), litRate.ratio);
  // the empty-good fill is selector-only: a good derived by arithmetic gets the plain difference and a warning
  const dw = [];
  const derived = sliLegs({ id: 'dv', type: 'ratio', good: 'sum(rate(all[5m])) - sum(rate(err[5m]))', total: 'sum(rate(all[5m]))' }, '5m', { step: 30, warn: (m) => dw.push(m) });
  assert.equal(derived.kind, 'events');
  assert.equal(derived.bad, '((sum(increase(all[5m]))) - (sum(increase(all[5m])) - sum(increase(err[5m]))))');
  assert.equal(dw.length, 1);
  assert.match(dw[0], /SLI dv: good is derived by arithmetic.*or vector\(0\)/);
  assert.ok(!sliLegs({ id: 'dv2', type: 'ratio', good: 'sum(rate(a[5m])) + sum(rate(b[5m]))', total: 'sum(rate(t[5m]))' }, '5m', ctx).bad.includes(' or ('), '+ is derived');
  assert.ok(!sliLegs({ id: 'dv3', type: 'ratio', good: 'sum(rate(a[5m])) unless b', total: 'sum(rate(t[5m]))' }, '5m', ctx).bad.includes(' or ('), 'unless is derived');
  assert.ok(sliLegs({ id: 'nd', type: 'ratio', good: 'sum(rate(a{le="1e-3",p="/x-y"}[5m]))', total: 'sum(rate(t[5m]))' }, '5m', ctx).bad.includes(' or ('), 'a - inside a label value or an exponent is not an operator');
  // a subquery range is a range: read as counters with the subquery resolution kept
  const sq = sliLegs({ id: 'sq', type: 'ratio', good: 'sum(rate(ok[5m:1m]))', total: 'sum(rate(all[5m:1m]))' }, '1h', ctx);
  assert.equal(sq.kind, 'events');
  assert.equal(sq.bad, '(((sum(increase(all[1h:1m]))) - (sum(increase(ok[1h:1m])))) or (sum(increase(all[1h:1m]))))');
  assert.equal(sliLegs({ id: 'sq2', type: 'ratio', good: 'sum(rate(ok[5m:]))', total: 'sum(rate(all[5m:]))' }, '30m', ctx).denom, 'clamp_min((sum(increase(all[30m:]))), 1)');
  // state SLIs grouped by (...): the grouping is carried into the bad leg, both spellings
  const by1 = sliLegs({ id: 'by1', type: 'ratio', good: 'sum(up{job="x"} == 1) by (instance)', total: 'count by (instance) (up{job="x"})' }, '5m', { step: 10 });
  assert.equal(by1.kind, 'state');
  assert.equal(by1.ratio, '(sum by (instance) (sum_over_time((1 - (up{job="x"} == bool 1))[5m:10s])) / ((count by (instance) (up{job="x"})) * 30))');
  const by2 = sliLegs({ id: 'by2', type: 'ratio', good: 'sum by (instance, job) (up{job="x"} == bool 1)', total: 'count by (instance, job) (up{job="x"})' }, '5m', { step: 10 });
  assert.equal(by2.kind, 'state');
  assert.equal(by2.bad, 'sum by (instance, job) (sum_over_time((1 - (up{job="x"} == bool 1))[5m:10s]))');
  const bw = [];
  sliLegs({ id: 'by3', type: 'ratio', good: 'sum by (instance) (up == bool 1)', total: 'count(up)' }, '5m', { step: 10, warn: (m) => bw.push(m) });
  assert.deepEqual(bw, ['SLI by3: good groups by (instance) but total does not; the two legs will not match']);
  // `count(<state> == 1) / count(<state>)`: a filter comparison inside count() is the count of
  // matching series, read as sum(<state> == bool 1) so the down series count as bad; warned once
  const cw = [];
  const counted = sliLegs({ id: 'cnt', type: 'ratio', good: 'count(up{job="x"} == 1)', total: 'count(up{job="x"})' }, '5m', { step: 10, warn: (m) => cw.push(m) });
  assert.equal(counted.kind, 'state');
  assert.equal(counted.ratio, '(sum(sum_over_time((1 - (up{job="x"} == bool 1))[5m:10s])) / ((count(up{job="x"})) * 30))');
  assert.deepEqual(cw, ['SLI cnt: count(up{job="x"} == 1) read as sum(up{job="x"} == bool 1): a filter comparison inside count() drops the failing series, the bool form counts them as bad']);
  const countedBy = sliLegs({ id: 'cnt2', type: 'ratio', good: 'count by (instance) (up == 1)', total: 'count by (instance) (up)' }, '5m', { step: 10 });
  assert.equal(countedBy.bad, 'sum by (instance) (sum_over_time((1 - (up == bool 1))[5m:10s]))');
  const warned = [];
  const wctx = { step: 30, warn: (m) => warned.push(m) };
  // aggregations and binary expressions without a range have no valid naive form: null, never `sum(rate(avg(up)[5m]))`
  assert.equal(sliLegs({ id: 'l1', type: 'ratio', good: 'avg(up)', total: 'count(up)' }, '5m', wctx), null);
  assert.equal(sliLegs({ id: 'l2', type: 'ratio', good: 'sum(a == 1) + sum(b == 1)', total: 'count(a) + count(b)' }, '5m', wctx), null);
  assert.equal(sliLegs({ id: 'l3', type: 'ratio', good: 'count(up)', total: 'count(up)' }, '5m', wctx), null, 'a count() without a comparison is not a state leg');
  // irate / deriv / delta / idelta legs have no event count
  assert.equal(sliLegs({ id: 'i1', type: 'ratio', good: 'sum(irate(a[5m]))', total: 'sum(irate(b[5m]))' }, '1h', wctx), null);
  assert.equal(sliLegs({ id: 'i2', type: 'ratio', good: 'sum(rate(a[5m]))', total: 'sum(deriv(b[5m]))' }, '1h', wctx), null);
  assert.equal(sliLegs({ id: 'i3', type: 'ratio', good: 'sum(delta(a[5m]))', total: 'sum(rate(b[5m]))' }, '1h', wctx), null);
  // mixed rate / gauge legs are neither events nor state
  assert.equal(sliLegs({ id: 'm1', type: 'ratio', good: 'sum(rate(a[5m]))', total: 'sum(b)' }, '1h', wctx), null);
  assert.equal(sliLegs({ id: 'm2', type: 'ratio', good: 'sum(a)', total: 'sum(rate(b[5m]))' }, '1h', wctx), null);
  assert.equal(warned.length, 8, warned.join('; '));
  assert.ok(warned.every(m => /no policy rules$/.test(m)), warned.join('; '));
  const warned2 = [];
  assert.equal(sliLegs({ id: 'c', type: 'custom', expression: 'x' }, '5m', { step: 30, warn: (m) => warned2.push(m) }), null);
  assert.equal(sliLegs({ id: 'd', type: 'distribution', query: 'x' }, '5m', ctx), null);
  assert.equal(sliLegs({ id: 'n', type: 'threshold', query: 'x', threshold: 'x' }, '5m', ctx), null);
  assert.equal(sliLegs({ id: 'r', type: 'ratio', good: 'x' }, '5m', ctx), null);
  assert.equal(sliLegs({ id: 'w', type: 'ratio', good: 'sum(rate(a[5m]))', total: 'sum(rate(b[5m]))' }, 'soon', ctx), null, 'a window that is not a duration');
  assert.equal(warned2.length, 1);
});

test('whitespace inside a label value survives the burn legs byte for byte', () => {
  const ctx = { step: 30 };
  const good = 'sum(rate(http_requests_total{route="/a  b",code!~"5.."}[5m]))', total = 'sum(\n  rate(http_requests_total{route="/a  b"}[5m])\n)';
  const legs = sliLegs({ id: 'ws', type: 'ratio', good, total }, '5m', ctx);
  // whitespace OUTSIDE the strings is still collapsed (the newline layout of `total`), inside it is kept
  assert.equal(legs.bad, '(((sum( increase(http_requests_total{route="/a  b"}[5m]) )) - (sum(increase(http_requests_total{route="/a  b",code!~"5.."}[5m])))) or (sum( increase(http_requests_total{route="/a  b"}[5m]) )))');
  const nl = sliLegs({ id: 'nl', type: 'ratio', good: 'sum(rate(x{route=~"a\n b"}[5m]))', total: 'sum(rate(y[5m]))' }, '5m', ctx);
  assert.ok(nl.bad.includes('route=~"a\n b"'), nl.bad);
  const t = sliLegs({ id: 't', type: 'threshold', query: 'max(lag{q="A  B"})', threshold: 1 }, '5m', ctx);
  assert.ok(t.bad.includes('lag{q="A  B"}'), t.bad);
});

test('a threshold SLI with no declared direction is read as a ceiling; a ratio-valued one is warned about as a probable floor', () => {
  const warned = [];
  const ctx = { step: 30, series: 'svc:x:value_5m', seriesStep: 30, warn: (m) => warned.push(m) };
  assert.equal(sliLegs({ id: 'sat', type: 'threshold', query: 'max(sat)', threshold: 0.8, unit: 'ratio' }, '5m', ctx).kind, 'threshold');
  assert.equal(sliLegs({ id: 'avail', type: 'threshold', query: '(1 - error_ratio) * probe_success', threshold: 1 }, '5m', ctx).kind, 'threshold');
  assert.equal(sliLegs({ id: 'ok', type: 'threshold', query: 'a / b', threshold: 1, unit: 'percentunit' }, '5m', ctx).kind, 'threshold');
  assert.equal(warned.length, 3);
  assert.ok(warned.every(m => /as a ceiling \(bad = samples above it\)/.test(m) && /looks like a floor — declare good_when: above/.test(m)), warned.join('; '));
  assert.ok(warned.every(m => !/no direction field|cannot express/.test(m)), 'a floor is expressible now: the warning no longer says the spec cannot');
  warned.length = 0;
  sliLegs({ id: 'lat', type: 'threshold', query: 'histogram_quantile(0.99, sum(rate(x{path="/api"}[5m])) by (le))', threshold: 0.5, unit: 'seconds' }, '5m', ctx);
  sliLegs({ id: 'lag', type: 'threshold', query: 'max(lag)', threshold: 1 }, '5m', ctx);
  assert.deepEqual(warned, []);
});

test('spec 1.3 good_when: a floor SLI counts the samples UNDER its bound, a ceiling those above it, absent means below; a declared direction ends the floor guess; the bound stays strict; a negative bound is a number', () => {
  const warned = [];
  const ctx = { step: 30, series: 'svc:x:value_5m', seriesStep: 30, warn: (m) => warned.push(m) };
  const floor = sliLegs({ id: 'members', type: 'threshold', good_when: 'above', query: 'min(members)', threshold: 2, unit: 'consumers' }, '5m', ctx);
  assert.deepEqual([floor.kind, floor.bad, floor.denom, floor.ratio], ['threshold', 'sum_over_time((max(svc:x:value_5m) < bool 2)[5m:30s])', '10', '(sum_over_time((max(svc:x:value_5m) < bool 2)[5m:30s]) / 10)']);
  const ceiling = sliLegs({ id: 'lag', type: 'threshold', good_when: 'below', query: 'max(lag)', threshold: 60, unit: 'seconds' }, '5m', ctx);
  assert.equal(ceiling.ratio, '(sum_over_time((max(svc:x:value_5m) > bool 60)[5m:30s]) / 10)');
  assert.equal(sliLegs({ id: 'lag', type: 'threshold', query: 'max(lag)', threshold: 60, unit: 'seconds' }, '5m', ctx).ratio, ceiling.ratio, 'absent means below: a 1.2 SLI reads exactly as it did');
  assert.deepEqual(warned, []);
  // The comparison is strict on the bad side whichever way the SLI faces: 2 consumers satisfy a floor of 2, 60 s a ceiling of 60 (never >= / <=).
  assert.ok(!/<=|>=/.test(floor.bad) && !/<=|>=/.test(ceiling.bad));
  // The alert expression and the error-ratio record through the generator, on a pack whose floor SLI has its own recording rule.
  const pack = {
    metadata: { name: 'settle', version: '0.0.1' },
    spec: {
      slis: [{ id: 'members', type: 'threshold', good_when: 'above', query: 'min(kafka_consumer_group_members{group="settler"})', threshold: 2, unit: 'consumers' }],
      slos: [{ id: 'members_99_9', sli: 'members', objective: 0.999, window: '30d' }],
      queries: { recording_rules: [{ name: 'settle:members:min_5m', expr: 'ref:slis.members', interval: '30s' }] },
      policy: { burn_rate_alerts: [{ slo: 'members_99_9', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV2' }] }] },
    },
  };
  const r = compileBurnRules(pack);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.recording.find(x => x.record === 'settle:members:error_ratio_5m').expr, '(sum_over_time((max(settle:members:min_5m) < bool 2)[5m:30s]) / 10)');
  const alert = r.groups.flatMap(g => g.rules).find(x => x.alert === 'members_99_9_burn_14x_5m_1h');
  assert.equal(alert.expr, [
    '(', '  (sum_over_time((max(settle:members:min_5m) < bool 2)[5m:30s]) / 10) > 0.014', ') and (',
    '  (sum_over_time((max(settle:members:min_5m) < bool 2)[1h:30s]) / 120) > 0.014', ') and (',
    '  sum_over_time((max(settle:members:min_5m) < bool 2)[5m:30s]) >= 2', ')',
  ].join('\n'));
  assert.ok(!alert.expr.includes('> bool'), 'no leg of a floor alert counts samples above the bound');
  // The floor guess (a ratio unit, a ratio-shaped query at 1) is raised only while the pack declares nothing: a declared
  // `above` is the floor it guessed, a declared `below` states the ceiling on purpose (the MQ headroom SLI, measured).
  const ratioish = { id: 'ok', type: 'threshold', query: 'a / b', threshold: 1, unit: 'percentunit' };
  warned.length = 0;
  assert.equal(sliLegs({ ...ratioish, good_when: 'above' }, '5m', ctx).bad, 'sum_over_time((max(svc:x:value_5m) < bool 1)[5m:30s])');
  assert.equal(sliLegs({ ...ratioish, good_when: 'below' }, '5m', ctx).bad, 'sum_over_time((max(svc:x:value_5m) > bool 1)[5m:30s])');
  assert.deepEqual(warned, []);
  sliLegs(ratioish, '5m', ctx);
  assert.equal(warned.length, 1);
  // A bound is any finite number now (a floor at -1, a ceiling on a signed skew); only a non-number gets no policy rules.
  warned.length = 0;
  assert.equal(sliLegs({ id: 'n', type: 'threshold', query: 'x', threshold: -1 }, '5m', ctx).bad, 'sum_over_time((max(svc:x:value_5m) > bool -1)[5m:30s])');
  assert.equal(sliLegs({ id: 'n', type: 'threshold', good_when: 'above', query: 'x', threshold: -1.5 }, '5m', ctx).bad, 'sum_over_time((max(svc:x:value_5m) < bool -1.5)[5m:30s])');
  assert.deepEqual(warned, []);
  for (const bad of ['x', NaN, Infinity, -Infinity, undefined]) assert.equal(sliLegs({ id: 'n', type: 'threshold', good_when: 'above', query: 'x', threshold: bad }, '5m', ctx), null, `threshold ${String(bad)}`);
  assert.ok(warned.length === 5 && warned.every(m => /threshold must be a finite number/.test(m) && /no policy rules$/.test(m)), warned.join('; '));
  // A distribution SLI stays what it was: no error-ratio form, whatever its direction (nothing invented here).
  warned.length = 0;
  assert.equal(sliLegs({ id: 'd', type: 'distribution', good_when: 'above', query: 'x', threshold: 2, percentile: 0.99 }, '5m', ctx), null);
  assert.match(warned[0], /type distribution has no error-ratio form/);
});

test('durations accept every spec unit and never throw', () => {
  assert.equal(durationSeconds('5m'), 300);
  assert.equal(durationSeconds('1h30m'), 5400);
  assert.equal(durationSeconds('1mo'), 2628000);
  assert.equal(durationSeconds('1y'), 31536000);
  assert.equal(durationSeconds('500ms'), 0.5);
  assert.equal(durationSeconds('1w'), 604800);
  assert.equal(durationSeconds('bogus'), null);
  assert.equal(durationSeconds(undefined), null);
});

test('forecast, for and naming helpers', () => {
  assert.deepEqual(forecastHorizon('7d'), { declared: '7d', seconds: 86400, capped: true });
  assert.deepEqual(forecastHorizon('12h'), { declared: '12h', seconds: 43200, capped: false });
  assert.deepEqual(forecastHorizon('1mo'), { declared: '1mo', seconds: 86400, capped: true });
  assert.deepEqual(forecastHorizon('1y'), { declared: '1y', seconds: 86400, capped: true });
  assert.deepEqual(forecastHorizon('bogus'), { declared: '7d', seconds: 86400, capped: true });
  assert.equal(forecastSeverity('page_oncall'), 'SEV1');
  assert.equal(forecastSeverity(undefined), 'SEV2');
  assert.equal(forecastSeverity('post_warning'), 'SEV3');
  assert.equal(forecastSeverity('something-else'), 'SEV3');
  assert.equal(metricPrefix('payment-service'), 'payment_service');
  assert.equal(metricPrefix('grafana'), 'grafana');
  assert.equal(forFor('5m'), '2m');
  assert.equal(forFor('30m'), '5m');
  assert.equal(forFor('1h'), '10m');
  assert.equal(forFor('5m', { lab: true }), '30s');
});

test('a state-style leg is sampled at the scrape interval of the job it selects', () => {
  // deviation 2: the floor counts samples, so a 60 s job read at the pack's 15 s minimum would
  // count each sample four times and one bad sample would satisfy the two-sample floor
  const pack = {
    metadata: { name: 'two-jobs', version: '0.0.1' },
    spec: {
      pipelines: { receivers: [{ name: 'prometheus', scrape_configs: [
        { job_name: 'fast', scrape_interval: '15s' },
        { job_name: 'slow', scrape_interval: '60s' },
      ] }] },
      slis: [
        { id: 'slow_up', type: 'ratio', good: 'sum(up{job="slow"} == bool 1)', total: 'count(up{job="slow"})' },
        { id: 'fast_up', type: 'ratio', good: 'sum(up{job="fast"} == bool 1)', total: 'count(up{job="fast"})' },
        { id: 'no_job', type: 'ratio', good: 'sum(up == bool 1)', total: 'count(up)' },
        { id: 'gauge', type: 'ratio', good: 'up{job="slow"}', total: '1' },
        { id: 'lag', type: 'threshold', query: 'max(lag{job="slow"})', threshold: 60 },
      ],
      slos: [
        { id: 'slow_99', sli: 'slow_up', objective: 0.99, window: '30d' },
        { id: 'fast_99', sli: 'fast_up', objective: 0.99, window: '30d' },
        { id: 'no_job_99', sli: 'no_job', objective: 0.99, window: '30d' },
      ],
      policy: { burn_rate_alerts: ['slow_99', 'fast_99', 'no_job_99'].map(slo => ({ slo, windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] })) },
    },
  };
  const NO_JOB = 'SLI no_job: no job="..." matcher names one of the pack\'s scrape jobs (fast, slow), which are scraped at different intervals (15s, 60s); sampling at 15s';
  assert.equal(packStepSeconds(pack), 15);
  const w = [];
  assert.equal(sliStepSeconds(pack, ['sum(up{job="slow"} == bool 1)', 'count(up{job="slow"})'], 15, (m) => w.push(m), 'slow_up'), 60);
  assert.equal(sliStepSeconds(pack, ['up{job="fast"}'], 15, (m) => w.push(m), 'fast_up'), 15);
  assert.equal(sliStepSeconds(pack, ['up{job="slow"}', 'up{job="fast"}'], 15, (m) => w.push(m), 'both'), 15, 'several jobs: the smallest interval');
  assert.deepEqual(w, []);
  assert.equal(sliStepSeconds(pack, ['sum(up == bool 1)'], 15, (m) => w.push(m), 'no_job'), 15);
  assert.deepEqual(w, [NO_JOB]);
  assert.equal(sliStepSeconds(pack, ['up{job="unknown"}'], 15, () => {}, 'x'), 15, 'an unknown job falls back');
  const uniform = { spec: { pipelines: { receivers: [{ scrape_configs: [{ job_name: 'a', scrape_interval: '30s' }, { job_name: 'b', scrape_interval: '30s' }] }] } } };
  w.length = 0;
  assert.equal(sliStepSeconds(uniform, ['up'], 30, (m) => w.push(m), 'u'), 30);
  assert.deepEqual(w, [], 'one interval across the pack: nothing to warn about');
  // through sliLegs with the pack in the context, and through the compiler (which passes the pack
  // unless opts.step is given)
  const sli = (id) => pack.spec.slis.find(s => s.id === id);
  assert.equal(sliLegs(sli('slow_up'), '5m', { step: 15, pack }).ratio, '(sum(sum_over_time((1 - (up{job="slow"} == bool 1))[5m:60s])) / ((count(up{job="slow"})) * 5))');
  assert.equal(sliLegs(sli('fast_up'), '5m', { step: 15, pack }).denom, '((count(up{job="fast"})) * 20)');
  assert.equal(sliLegs(sli('gauge'), '5m', { step: 15, pack }).ratio, '(sum_over_time((1 - (up{job="slow"}))[5m:60s]) / 5)');
  assert.equal(sliLegs(sli('lag'), '5m', { step: 15, pack }).ratio, '(sum_over_time((max((max(lag{job="slow"}))) > bool 60)[5m:60s]) / 5)', 'an inlined threshold query is sampled at its job\'s interval');
  assert.equal(sliLegs(sli('lag'), '5m', { step: 15, pack, series: 'two_jobs:lag:value_5m', seriesStep: 30 }).ratio, '(sum_over_time((max(two_jobs:lag:value_5m) > bool 60)[5m:30s]) / 10)', 'a recorded threshold series keeps its own step');
  assert.equal(sliLegs(sli('slow_up'), '5m', { step: 15 }).denom, '((count(up{job="slow"})) * 20)', 'without the pack, ctx.step');
  const cw = [];
  const compiled = parseYaml(compilePrometheusRules(pack, { onWarning: (m) => cw.push(m) }).replace(/^#[^\n]*\n/gm, ''));
  const alerts = Object.fromEntries(compiled.groups.flatMap(g => g.rules).filter(r => r.alert).map(r => [r.alert, r.expr]));
  assert.match(alerts.slow_99_burn_14x_5m_1h, /\[5m:60s\]\)\) \/ \(\(count\(up\{job="slow"\}\)\) \* 5\)\)/);
  assert.match(alerts.slow_99_burn_14x_5m_1h, /\[1h:60s\]\)\) \/ \(\(count\(up\{job="slow"\}\)\) \* 60\)\)/);
  assert.match(alerts.fast_99_burn_14x_5m_1h, /\[5m:15s\]\)\) \/ \(\(count\(up\{job="fast"\}\)\) \* 20\)\)/);
  assert.match(alerts.no_job_99_burn_14x_5m_1h, /\[5m:15s\]/);
  assert.deepEqual(cw, [NO_JOB]);
  const explicit = compilePrometheusRules(pack, { step: 10 });
  assert.ok(explicit.includes('[5m:10s]') && !explicit.includes('[5m:60s]'), 'an explicit opts.step is the step everywhere');
  const gen = compileBurnRules(pack);
  assert.ok(gen.groups.flatMap(g => g.rules).some(r => r.alert === 'slow_99_burn_14x_5m_1h' && r.expr.includes('[5m:60s]')), 'the generator resolves the step per job too');
  assert.ok(compileBurnRules(pack, { step: 10 }).groups.flatMap(g => g.rules).every(r => !r.expr.includes(':60s]')), 'gen-burn-rules --step overrides the lookup');
});

test('the committed reference-pack rules and dashboards are what the generators emit today', () => {
  // The generators are what wrote reference-packs/rules/<name>.burn.yml and
  // reference-packs/dashboards/*.json; a builder change that moves their bytes must
  // regenerate them in the same commit (the same gate the compiler's goldens have).
  const dir = mkdtempSync(join(tmpdir(), 'obs-gen-'));
  try {
    for (const packPath of PACKS) {
      const pack = load(packPath);
      const name = pack.metadata.name;
      const rulesOut = join(dir, `${name}.burn.yml`);
      execFileSync(process.execPath, ['tools/gen-burn-rules.mjs', '--pack', packPath, '--out', rulesOut], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      const committedRules = readFileSync(resolve(ROOT, 'reference-packs', 'rules', `${name}.burn.yml`), 'utf8');
      assert.equal(readFileSync(rulesOut, 'utf8'), committedRules, `reference-packs/rules/${name}.burn.yml is not what gen-burn-rules.mjs emits; regenerate it`);
      const dashDir = join(dir, `${name}-dashboards`);
      execFileSync(process.execPath, ['tools/gen-dashboards.mjs', '--pack', packPath, '--out-dir', dashDir], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      const files = readdirSync(dashDir).filter(f => f.endsWith('.json'));
      assert.ok(files.length >= 2, `${name}: dashboards generated`);
      for (const f of files) {
        const committed = readFileSync(resolve(ROOT, 'reference-packs', 'dashboards', f), 'utf8');
        assert.equal(readFileSync(join(dashDir, f), 'utf8'), committed, `reference-packs/dashboards/${f} is not what gen-dashboards.mjs emits; regenerate it`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one engine: packc compile … grafana-dashboard emits the committed reference boards (the same object, tags aside)', () => {
  // compileGrafanaDashboard is genericBoards plus the platform contract (the version
  // profile, the datasource placeholders, the tags). With the lab's datasource uids
  // pinned — what the committed boards carry — every board is the same object, so the
  // studio compiles exactly what gen-dashboards wrote and the lab validated live.
  const lab = { prometheus: 'prom', loki: 'loki', tempo: 'tempo' };
  const dashDir = resolve(ROOT, 'reference-packs', 'dashboards');
  for (const packPath of PACKS) {
    const pack = load(packPath);
    const name = pack.metadata.name;
    const files = readdirSync(dashDir).filter(f => f.startsWith(`${name}-`) && f.endsWith('.json'));
    assert.ok(files.length >= 2, `${name}: committed boards found`);
    for (const f of files) {
      const committed = JSON.parse(readFileSync(join(dashDir, f), 'utf8'));
      const compiled = JSON.parse(compileGrafanaDashboard(pack, committed.uid, { datasourceUids: lab }));
      for (const t of committed.tags) assert.ok(compiled.tags.includes(t), `${f}: generator tag ${t} kept`);
      assert.ok(compiled.tags.includes('observability-pack') && compiled.tags.includes(`obs-pack-id:${committed.uid}`), `${f}: platform tags added`);
      assert.deepEqual({ ...compiled, tags: committed.tags }, committed, `${f}: the compiler's board differs from the generator's`);
    }
  }
  // Without pinned uids the compiler emits the gateway placeholders the MCP bridge maps.
  const placeholder = JSON.parse(compileGrafanaDashboard(load(PACKS[0]), `${load(PACKS[0]).metadata.name}-unified`));
  const dsUids = new Set(placeholder.panels.flatMap(p => [p.datasource?.uid, ...(p.targets || []).map(t => t.datasource?.uid)]).filter(Boolean));
  assert.ok(dsUids.has('${DS_PROMETHEUS}') && !dsUids.has('prom'), 'placeholders replace the lab uid');
});
