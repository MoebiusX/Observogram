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
 *     comparisons for state-style ratios, the min-bad-samples floor, the capped forecast horizon).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { genericBoards, checkBindings } from './lib/dashboards/generic.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compileBurnRules, toYaml, boolify, packStepSeconds, sliLegs, sliStepSeconds, forecastHorizon, forecastSeverity, metricPrefix, forFor,
  durationSeconds, packSnippet,
} from './lib/burn-rules.mjs';
import { compilePrometheusRules } from './lib/compile.mjs';

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

test('dashboards for a dash-named pack read the slugged metric prefix everywhere', () => {
  // payment-service: every recording rule the generators and the compiler emit is payment_service:*
  const pack = load('vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml');
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
  assert.equal(sliLegs({ id: 'n', type: 'threshold', query: 'x', threshold: -1 }, '5m', ctx), null);
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

test('threshold SLIs are upper bounds; a ratio-valued one is warned about', () => {
  const warned = [];
  const ctx = { step: 30, series: 'svc:x:value_5m', seriesStep: 30, warn: (m) => warned.push(m) };
  assert.equal(sliLegs({ id: 'sat', type: 'threshold', query: 'max(sat)', threshold: 0.8, unit: 'ratio' }, '5m', ctx).kind, 'threshold');
  assert.equal(sliLegs({ id: 'avail', type: 'threshold', query: '(1 - error_ratio) * probe_success', threshold: 1 }, '5m', ctx).kind, 'threshold');
  assert.equal(sliLegs({ id: 'ok', type: 'threshold', query: 'a / b', threshold: 1, unit: 'percentunit' }, '5m', ctx).kind, 'threshold');
  assert.equal(warned.length, 3);
  assert.ok(warned.every(m => /upper bound/.test(m) && /no direction field/.test(m)), warned.join('; '));
  warned.length = 0;
  sliLegs({ id: 'lat', type: 'threshold', query: 'histogram_quantile(0.99, sum(rate(x{path="/api"}[5m])) by (le))', threshold: 0.5, unit: 'seconds' }, '5m', ctx);
  sliLegs({ id: 'lag', type: 'threshold', query: 'max(lag)', threshold: 1 }, '5m', ctx);
  assert.deepEqual(warned, []);
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
