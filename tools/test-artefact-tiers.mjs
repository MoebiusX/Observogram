#!/usr/bin/env node
/**
 * tools/test-artefact-tiers.mjs — the tiers people see (studio/artefact-tiers.mjs): the chain
 * (exporters, alerts, dashboards, MTTD / MTTR), the detail, the machinery.
 *
 * The module mirrors the artefact model's id rules (it never imports tools/lib); the first test
 * holds the two equal, and every family of the model has a tier. The rest pins what a layered
 * pack and a comparison count as, with set-asides, placeholders and families the live side could
 * not read.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ID_RULES, FAMILIES } from './lib/artefact-classify.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { applySetAsides } from '../studio/set-asides.mjs';
import {
  TIERS, CHAIN_LINKS, FAMILY_TIERS, FAMILY_WORDS, FAMILY_BY_ID_PREFIX, MTTX_FAMILIES,
  tierOfFamily, isMachinery, chainLinkOf, familyOfArtefact, familyOfKey, packArtefacts, declaredByTier,
  comparisonByTier, differencesOf, familyWords, linkLine, chainLine,
} from '../studio/artefact-tiers.mjs';

test('the id prefixes are the artefact model\'s, in its order, and every family has a tier and words', () => {
  assert.deepEqual(FAMILY_BY_ID_PREFIX.map((r) => [...r]), ID_RULES.map((r) => [...r]));
  for (const f of FAMILIES) {
    assert.ok([1, 2, 3].includes(FAMILY_TIERS[f]), `${f} has a tier`);
    assert.ok(Array.isArray(FAMILY_WORDS[f]) && FAMILY_WORDS[f].length === 2, `${f} has its words`);
  }
  assert.deepEqual(Object.keys(FAMILY_TIERS).sort(), [...FAMILIES].sort(), 'no tier for a family the model does not have');
  assert.deepEqual(TIERS.map((t) => t.key), ['chain', 'detail', 'machinery']);
  assert.deepEqual(CHAIN_LINKS.map((l) => l.key), ['exporters', 'alerts', 'dashboards']);
  for (const l of CHAIN_LINKS) for (const f of l.families) assert.equal(tierOfFamily(f), 1, `${f} is the chain`);
  for (const f of MTTX_FAMILIES) assert.equal(tierOfFamily(f), 1);
  assert.equal(tierOfFamily('panel'), 3);
  assert.equal(tierOfFamily('recording_rule'), 3);
  assert.equal(tierOfFamily('metric'), 2);
  assert.equal(tierOfFamily('slo'), 2);
  assert.equal(tierOfFamily('no-such-family'), 2, 'a family the table does not know is shown, never folded');
  assert.equal(tierOfFamily('unknown'), 2, 'what the classifier could not place is shown, never folded');
  assert.equal(isMachinery('panel'), true);
  assert.equal(isMachinery('scrape_job'), false);
  assert.equal(chainLinkOf('burn_rate'), 'alerts');
  assert.equal(chainLinkOf('alert_rule'), 'alerts');
  assert.equal(chainLinkOf('scrape_job'), 'exporters');
  assert.equal(chainLinkOf('panel'), null);
});

test('an artefact\'s family by its id, a key\'s by its prefix', () => {
  assert.equal(familyOfArtefact({ id: 'SCRAPE-SRC-03' }), 'scrape_job');
  assert.equal(familyOfArtefact({ id: 'SCRAPE-01' }), 'scrape_job');
  assert.equal(familyOfArtefact({ id: 'POL-02' }), 'burn_rate');
  assert.equal(familyOfArtefact({ id: 'PIP-EXP-LOG-1' }), 'pipeline_exporter_logs');
  assert.equal(familyOfArtefact({ id: 'PANEL-12' }), 'panel');
  assert.equal(familyOfArtefact({ id: 'ZZZ-1' }), '');
  assert.equal(familyOfArtefact(null), '');
  assert.equal(familyOfKey('metric::family:http_'), 'metric');
  assert.equal(familyOfKey('alert_rule::HighErrorRate#02'), 'alert_rule');
  assert.equal(familyOfKey('no-prefix'), '');
  assert.equal(familyWords('slo', 1), '1 objective');
  assert.equal(familyWords('slo', 18), '18 objectives');
  assert.equal(familyWords('made_up', 2), '2 made up');
});

// A small pack in the spec's shape: two exporters (declared by the scan's annotations), three
// alert rules, two objectives of which one has a burn-rate alert, a dashboard with two panels,
// a recording rule, the scan's placeholder baselines, and a chaos run that measured MTTD.
function canonical({ baselines = { mttd_target_p50: '15m', mttr_target_p50: '1d' }, placeholderBaselines = true, chaosRun = null } = {}) {
  const marks = placeholderBaselines ? { 'crawler.scaffold.baselines': 'stub' } : {};
  return {
    apiVersion: 'observability.platform/v1', kind: 'ObservabilityPack',
    metadata: {
      name: 'tiers', version: '1.0.0',
      annotations: {
        'crawler.discovered.scrape_jobs': 'api,worker',
        'crawler.discovered.scrape_jobs_count': '2',
        ...marks,
      },
    },
    spec: {
      otel: {},
      slis: [{ id: 'req_ok', kind: 'availability', good: 'http_requests_total{code!~"5.."}', total: 'http_requests_total' }, { id: 'req_fast', kind: 'latency', good: 'a', total: 'b' }],
      slos: [{ id: 'avail', sli: 'slis.req_ok', objective: 0.999, window: '30d' }, { id: 'fast', sli: 'slis.req_fast', objective: 0.99, window: '30d' }],
      pipelines: {},
      queries: { recording_rules: [{ record: 'job:http_requests:rate5m', expr: 'sum(rate(http_requests_total[5m]))' }] },
      dashboards: [{ id: 'svc', provider: { kind: 'grafana' }, params: { panels: [{ title: 'Requests', expr: 'rate(http_requests_total[5m])' }, { title: 'Errors', expr: 'rate(http_errors_total[5m])' }] } }],
      policy: { burn_rate_alerts: [{ slo: 'slos.avail', windows: [{ long: '1h', short: '5m', factor: 14.4, severity: 'SEV1' }] }] },
      alerting: {
        routes: [],
        rules: [
          { alert: 'HighErrorRate', expr: 'rate(http_errors_total[5m]) > 1', severity: 'SEV2' },
          { alert: 'ServiceDown', expr: 'up == 0', severity: 'SEV1' },
        ],
      },
      baselines,
      validation: chaosRun ? { chaos_experiments: [{ id: 'kill-pod', engine: 'chaos-mesh', target: 'api', schedule: 'weekly', expected_alerts: ['ServiceDown'], last_result: chaosRun }] } : {},
    },
  };
}

test('declaredByTier counts the chain, the objectives without an alert, the detail and the machinery', () => {
  const layered = adapt(canonical(), {});
  const d = declaredByTier(layered);
  assert.equal(d.links.exporters.count, 2);
  assert.deepEqual(d.links.exporters.families, { scrape_job: 2 });
  assert.equal(d.links.alerts.count, 3, 'two alert rules and one burn-rate alert');
  assert.deepEqual(d.links.alerts.families, { alert_rule: 2, burn_rate: 1 });
  assert.equal(d.links.dashboards.count, 1, 'a dashboard counts once, its panels are machinery');
  assert.deepEqual(d.objectives, { total: 2, withoutAlert: 1 });
  assert.equal(d.mttx.declared, false, 'the scan\'s placeholder targets are not declared');
  assert.equal(d.mttx.scaffold, true);
  assert.equal(d.mttx.mttd, '15m');
  assert.equal(d.mttx.measured, null);
  assert.ok(d.machinery.families.some((x) => x.family === 'panel' && x.count === 2));
  assert.ok(d.machinery.families.some((x) => x.family === 'recording_rule'));
  assert.ok(d.detail.families.some((x) => x.family === 'slo' && x.words === '2 objectives'));
  assert.equal(d.detail.count, d.detail.families.reduce((n, x) => n + x.count, 0));
});

test('declaredByTier: the repository\'s own targets are declared, and a chaos run\'s observed MTTD is measured', () => {
  const layered = adapt(canonical({
    baselines: { mttd_target_p50: '5m', mttr_target_p50: '2h', mttd_target_p95: '10m' },
    placeholderBaselines: false,
    chaosRun: { at: '2026-11-01T10:00:00Z', outcome: 'pass', observed_mttd: '3m', alerts_fired: ['ServiceDown'] },
  }), {});
  const d = declaredByTier(layered);
  assert.equal(d.mttx.declared, true);
  assert.equal(d.mttx.scaffold, false);
  assert.deepEqual([d.mttx.mttd, d.mttx.mttr, d.mttx.mttd95, d.mttx.mttr95], ['5m', '2h', '10m', null]);
  assert.deepEqual(d.mttx.measured, { mttd: '3m', at: '2026-11-01T10:00:00Z', experiment: 'kill-pod', outcome: 'pass' });
});

test('declaredByTier on nothing, and packArtefacts counts each artefact once', () => {
  const d = declaredByTier(null);
  assert.equal(d.links.alerts.count, 0);
  assert.deepEqual(d.objectives, { total: 0, withoutAlert: 0 });
  assert.equal(d.mttx.declared, false);
  const a = { id: 'RULE-01' };
  assert.equal(packArtefacts({ layers: { L4: [a], L5: { rules: [a, { id: 'RULE-02' }] } } }).length, 2);
});

test('comparisonByTier sorts a comparison into the chain\'s links, the detail and the machinery', () => {
  const diff = {
    layers: {
      L3: {
        inBoth: [{ key: 'scrape_job::api', match: 'aligned' }, { key: 'scrape_job::worker', match: 'drifted' }, { key: 'metric::family:http_', match: 'aligned' }],
        onlyInA: [{ key: 'metric::x' }, { key: 'metric::y' }, { key: 'recording_rule::r' }],
        onlyInB: [{ key: 'scrape_job::extra' }],
        notObserved: [{ key: 'dashboard::svc', side: 'a' }, { key: 'dashboard::live-only', side: 'b' }],
        outOfScope: [{ key: 'metric::other' }],
        scaffold: [{ key: 'baselines::x@a#01' }],
      },
      L4: {
        inBoth: [{ key: 'alert_rule::HighErrorRate', match: 'aligned' }, { key: 'burn_rate::avail', match: 'aligned' }, { key: 'baselines::b', match: 'aligned' }],
        onlyInA: [{ key: 'alert_rule::ServiceDown' }],
        onlyInB: [{ key: 'panel::p' }],
        setAside: [{ key: 'metric::z', side: 'a' }],
      },
    },
  };
  const t = comparisonByTier(diff);
  assert.deepEqual(t.exporters, { aligned: 1, drifted: 1, declaredNotLive: 0, liveNotDeclared: 1, notRead: 0, setAside: 0 });
  assert.deepEqual(t.alerts, { aligned: 2, drifted: 0, declaredNotLive: 1, liveNotDeclared: 0, notRead: 0, setAside: 0 });
  assert.deepEqual(t.dashboards, { aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0, notRead: 1, setAside: 0 }, 'only what the repository declares is "not read live"');
  assert.deepEqual(t.detail, { aligned: 1, drifted: 0, declaredNotLive: 2, liveNotDeclared: 0, notRead: 0, setAside: 1, families: { metric: 2 } });
  assert.deepEqual(t.machinery, { aligned: 0, drifted: 0, declaredNotLive: 1, liveNotDeclared: 1, notRead: 0, setAside: 0, families: { recording_rule: 1 } }, 'a live-only panel is no difference from what the repository declares');
  assert.equal(differencesOf(t.exporters), 1, 'what differs from the declaration: the live-only exporter apart');
  assert.equal(differencesOf(t.detail), 2);
  assert.equal(differencesOf(null), 0);
  assert.deepEqual(comparisonByTier(null).alerts, { aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0, notRead: 0, setAside: 0 });
});

test('comparisonByTier over a real comparison adds up to its summary, with set-asides moved out', () => {
  const A = adapt(canonical(), {});
  const liveCanon = canonical();
  liveCanon.metadata.annotations = { 'mcp.discovered.scrape_jobs': 'api' };
  liveCanon.spec.alerting.rules = liveCanon.spec.alerting.rules.slice(0, 1);
  const B = adapt(liveCanon, {});
  const diff = diffPacks(A, B, {});
  const t = comparisonByTier(diff);
  const all = [t.exporters, t.alerts, t.dashboards, t.mttx, t.detail, t.machinery];
  const sum = (k) => all.reduce((n, x) => n + x[k], 0);
  assert.equal(sum('aligned') + sum('drifted'), diff.summary.inBoth, 'every pair counted once, the MTTD / MTTR targets in their own slot');
  assert.equal(sum('declaredNotLive'), diff.summary.onlyInA);
  assert.equal(sum('liveNotDeclared'), diff.summary.onlyInB);
  const missing = Object.values(diff.layers).flatMap((b) => b.onlyInA || []);
  assert.ok(missing.length > 0, 'the fixture has something declared and not live');
  const aside = applySetAsides(diff, missing.map((e) => ({ key: e.key, side: 'declared', kind: 'not-this-service' })), { now: '2026-11-10T00:00:00Z' });
  const u = comparisonByTier(aside);
  const after = [u.exporters, u.alerts, u.dashboards, u.mttx, u.detail, u.machinery];
  assert.equal(after.reduce((n, x) => n + x.declaredNotLive, 0), 0);
  assert.equal(after.reduce((n, x) => n + x.setAside, 0), missing.length);
});

test('linkLine and chainLine say a link in a few words', () => {
  assert.equal(linkLine({ aligned: 21 }), '21 of 21 live');
  assert.equal(linkLine({ aligned: 4, drifted: 1, declaredNotLive: 2, liveNotDeclared: 3 }), '5 of 7 live (1 not as declared) · 3 live, not declared');
  assert.equal(linkLine({ notRead: 7 }), '7 not read live');
  assert.equal(linkLine({ setAside: 2 }), '2 set aside');
  assert.equal(linkLine({}), 'none declared');
  assert.equal(chainLine({ exporters: { aligned: 21 }, alerts: { aligned: 66 }, dashboards: { notRead: 7 } }), 'Exporters: 21 of 21 live · Alerts: 66 of 66 live · Dashboards: 7 not read live');
  assert.equal(chainLine(null), '');
});
