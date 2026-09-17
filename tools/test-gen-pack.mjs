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
import { compileBurnRules, toYaml, boolify, packStepSeconds } from './lib/burn-rules.mjs';

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
    for (const rec of rules.filter(x => x.record)) for (const l of ['slo', 'sli', 'service']) assert.ok(rec.labels[l], `${rec.record} lacks ${l}`);
    // every SLO has a 5m and a 1h burn recording rule
    for (const slo of pack.spec.slos) for (const w of ['5m', '1h']) assert.ok(rules.some(x => x.record === `${name}:errorbudget:burn_${w}` && x.labels.slo === slo.id), `${slo.id} burn_${w}`);
    // rate-style ratios divide by the events that happened; state-style ones use bool comparisons
    for (const sli of pack.spec.slis.filter(s => s.type === 'ratio')) {
      const slo = pack.spec.slos.find(s => s.sli === sli.id); if (!slo) continue;
      const rec = rules.find(x => x.record === `${name}:errorbudget:burn_5m` && x.labels.slo === slo.id);
      if (/\[\d+[smhd]\]/.test(sli.good)) assert.match(rec.expr, /clamp_min\(/, `${sli.id}: event denominator`);
      else assert.doesNotMatch(rec.expr, /(==|!=|<|>)\s+(?!bool)[^b]/, `${sli.id}: comparison without bool`);
    }
  });
}

test('boolify rewrites filter comparisons and leaves boolean ones alone', () => {
  assert.equal(boolify('up == 1'), 'up == bool 1');
  assert.equal(boolify('up == bool 1'), 'up == bool 1');
  assert.equal(boolify('a == b'), 'a == bool b');
  assert.equal(boolify('x >= 2 and y < 3'), 'x >= bool 2 and y < bool 3');
});
