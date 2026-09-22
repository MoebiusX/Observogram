#!/usr/bin/env node
/**
 * tools/test-compile.mjs
 *
 * Compiler regression suite. Compiles bundled canonical packs to every
 * target and asserts the output is real, ingestible, and traceable back
 * to the source pack.
 *
 * Sanity checks (not full ingestion — we don't run promtool / otelcol /
 * grafana-cli in CI):
 *   - prometheus-rules:  YAML with `groups:`; each group has rules;
 *                         alerts carry the slo label; recording-rule
 *                         names follow the <service>:<sli>:<expr> convention.
 *   - otel-collector:    YAML with receivers / processors / exporters /
 *                         service.pipelines.{metrics,logs,traces}.
 *   - alertmanager:      YAML with `route:` tree and per-severity receivers.
 *   - grafana-dashboard: JSON with schemaVersion 39, panels[], non-empty
 *                         targets[].expr per panel.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { compile, compilePrometheusRules, compileOtelCollector,
  compileAlertmanager, compileGrafanaDashboard, listTargets, TARGETS,
  compileSloPrometheusRules, compileGrafanaManagedRules, compileCatalog, compileArtifact } from './lib/compile.mjs';
import { compileBurnRules, metricPrefix } from './lib/burn-rules.mjs';
import { metricNamesOf, ASSURANCE_MODES, ASSURANCE_ANNOTATION } from './lib/assurance-rules.mjs';
import { STACK_SELF_METRIC_PROBES } from './lib/contracts/stack-self-metrics.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Bundled packs live under examples/ since Phase 7q archived them out
// of packs/ so the studio boots empty. payment-service is the vendored
// spec example and stays under vendor/.
const FIXTURES = [
  { id: 'payment-service',     path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml' },
  { id: 'target-advanced',     path: 'examples/target-advanced.pack.yaml' },
  { id: 'production-curated',  path: 'examples/production-curated.pack.yaml' },
  { id: 'demo-skeleton',       path: 'examples/demo-skeleton.pack.yaml' },
];

import { createHarness } from './lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 120 });

function check(file) {
  process.stdout.write(`\n[${file.id}] ${file.path}\n`);
  const text = readFileSync(resolve(ROOT, file.path), 'utf8');
  const canonical = parseYaml(text);

  // ---------- listTargets / TARGETS ----------
  const targets = listTargets();
  assert(targets.length === 4, 'four compile targets registered', targets.length, 4);
  assert(targets.every(t => t.id && t.label && t.extension), 'all targets describe themselves');

  // ---------- prometheus-rules ----------
  const rules = compilePrometheusRules(canonical);
  assert(typeof rules === 'string' && rules.length > 0, 'prometheus-rules produces text');
  assert(/^groups:/m.test(rules) || /\ngroups:/.test(rules), 'prometheus-rules has groups:');
  // Recording rules for ratio SLIs should include :ratio_5m
  const sloCount = (canonical?.spec?.slos || []).length;
  if (sloCount > 0) {
    assert(/:ratio_5m/.test(rules), 'prometheus-rules emits :ratio_5m recording rules');
    assert(/:error_ratio_5m/.test(rules), 'prometheus-rules emits :error_ratio_5m');
    // Burn-rate alerts carry the slo label
    if ((canonical?.spec?.policy?.burn_rate_alerts || []).length > 0) {
      assert(/severity:/.test(rules) && /SEV[1-4]/.test(rules), 'burn-rate alerts carry severity labels');
      assert(/burn_/.test(rules), 'burn-rate alert names follow <slo>_burn_<factor>x convention');
    }
  }
  // Round-trip through YAML parser
  let parsedRules;
  try { parsedRules = parseYaml(rules.replace(/^#[^\n]*\n/gm, '')); }
  catch (e) { parsedRules = null; }
  assert(parsedRules && Array.isArray(parsedRules.groups), 'prometheus-rules YAML round-trips');
  if (parsedRules?.groups) {
    assert(parsedRules.groups.every(g => g.name && Array.isArray(g.rules)),
           'every rule group has name and rules[]');
  }

  // ---------- otel-collector ----------
  const otel = compileOtelCollector(canonical);
  assert(typeof otel === 'string' && otel.length > 0, 'otel-collector produces text');
  assert(/receivers:/m.test(otel),  'otel has receivers:');
  assert(/processors:/m.test(otel), 'otel has processors:');
  assert(/exporters:/m.test(otel),  'otel has exporters:');
  assert(/service:/m.test(otel),    'otel has service: section');
  assert(/pipelines:/.test(otel),   'otel.service.pipelines present');
  const expMetrics = canonical?.spec?.pipelines?.exporters?.metrics?.kind;
  if (expMetrics) {
    assert(otel.includes(expMetrics), `otel exporters include declared metrics kind (${expMetrics})`);
  }

  // ---------- alertmanager ----------
  const am = compileAlertmanager(canonical);
  assert(typeof am === 'string' && am.length > 0, 'alertmanager produces text');
  assert(/^route:/m.test(am) || /\nroute:/.test(am), 'alertmanager has route: tree');
  assert(/^receivers:/m.test(am) || /\nreceivers:/.test(am), 'alertmanager has receivers:');
  const routesCount = (canonical?.spec?.alerting?.routes || []).length;
  if (routesCount > 0) {
    assert(/severity=/.test(am) || /matchers:/.test(am), 'alertmanager routes have matchers');
  }

  // ---------- grafana-dashboard ----------
  const dashboards = canonical?.spec?.dashboards || [];
  if (dashboards.length > 0) {
    const dashId = dashboards[0].id;
    const json = compileGrafanaDashboard(canonical, dashId);
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) { parsed = null; }
    assert(!!parsed, 'grafana-dashboard JSON parses');
    if (parsed) {
      // The schema's documented floor is 30 (legacy Grafana 9 era).
      // Spec-mandated support window today is Grafana 12 / 13. Bundled
      // packs declare their own schemaVersion when they need an older
      // installation supported; when they don't, the compiler emits 41+
      // (Grafana 12 baseline).
      assert(parsed.schemaVersion >= 30, 'grafana schemaVersion meets schema floor (≥30)', parsed.schemaVersion, '≥ 30');
      if (file.id === 'demo-skeleton') {
        assert(parsed.schemaVersion >= 41,
               'default schemaVersion targets Grafana 12+ when pack does not pin one',
               parsed.schemaVersion, '≥ 41');
      }
      if (file.id === 'target-advanced') {
        assert(parsed.schemaVersion === 41,
               'target-advanced dashboards pin Grafana 12 schemaVersion (41)',
               parsed.schemaVersion, 41);
      }
      assert(parsed.uid === dashId, 'grafana uid is the dashboard id (the boards link to each other at /d/<id>)', parsed.uid, dashId);
      assert(parsed.tags?.includes(`obs-pack-id:${dashId}`), 'grafana dashboard carries the obs-pack-id tag');
      assert(Array.isArray(parsed.panels), 'grafana panels is an array');
      assert(parsed.tags?.includes('observability-pack'), 'grafana dashboard tagged observability-pack');
      // If the dashboard has panel bindings, the compiled panels should
      // have non-empty expr targets.
      if ((dashboards[0].panel_bindings || []).length > 0) {
        const exprs = parsed.panels.flatMap(p => (p.targets || []).map(t => t.expr));
        assert(exprs.some(e => typeof e === 'string' && e.length > 0),
               'grafana panels have non-empty PromQL targets');
      }
    }
  }

  // ---------- one engine: the unified board, the id-less default, opts forwarding ----------
  if (file.id === 'payment-service') {
    const cat = compileCatalog(canonical);
    const dg = (cat.groups || []).find(g => g.id === 'dashboards');
    const uni = dg?.items.find(i => i.id === 'dash:payment-service-unified');
    assert(!!uni && uni.generated === true && uni.dashboardId === 'payment-service-unified',
           'the catalog lists the generated unified board, flagged generated', uni);
    assert(dg && dg.items[1] === uni, 'the unified board comes right after the bundle item');
    const bundle = compileArtifact(canonical, { group: 'dashboards', flavor: 'grafana', artifact: 'all' });
    assert(bundle.content.startsWith('/* === payment-service-unified === */'), 'the bundle starts with the unified board');
    // A pack that declares no dashboards[]: the id-less target compiles the unified board (it used to throw).
    const bare = parseYaml(readFileSync(resolve(ROOT, 'tools/fixtures/compile/policy-shapes.pack.yaml'), 'utf8'));
    const out0 = compile(bare, 'grafana-dashboard');
    assert(JSON.parse(out0.content).uid === `${bare.metadata.name}-unified` && out0.filename.endsWith(`${bare.metadata.name}-unified.json`),
           'id-less compile() of a pack without dashboards[] yields the unified board', out0.filename);
    // opts reach the dashboard compiler through compileArtifact: the >40-char uid cap warns, pinned uids replace the placeholder.
    const longId = 'payment-overview-with-a-very-long-dashboard-identifier';
    const wide = JSON.parse(JSON.stringify(canonical)); wide.spec.dashboards[0].id = longId;
    const warnings = [];
    const art = compileArtifact(wide, { group: 'dashboards', flavor: 'grafana', artifact: 'dash:' + longId, onWarning: (m) => warnings.push(m) });
    assert(JSON.parse(art.content).uid.length <= 40 && warnings.some(w => w.includes('uid longer than 40')),
           'compileArtifact forwards onWarning; the capped uid warns', warnings);
    const pinned = compileArtifact(canonical, { group: 'dashboards', flavor: 'grafana', artifact: 'dash:payment-overview', datasourceUids: { prometheus: 'prom' } });
    assert(pinned.content.includes('"uid": "prom"') && !pinned.content.includes('${DS_PROMETHEUS}'), 'compileArtifact forwards datasourceUids');
  }

  // ---------- dispatcher ----------
  const out = compile(canonical, 'prometheus-rules');
  assert(out.target === 'prometheus-rules', 'dispatcher echoes target');
  assert(out.contentType === 'application/x-yaml', 'dispatcher returns YAML content-type for rules');
  assert(out.filename.endsWith('.rules.yaml'), 'dispatcher suggests *.rules.yaml');
  assert(out.content === rules, 'dispatcher matches direct call');
}

for (const f of FIXTURES) {
  try { check(f); }
  catch (e) {
    failures.push(`${f.id}: threw ${e.message}`);
    process.stdout.write(`  ✗ ${f.id}: threw ${e.message}\n`);
  }
}

// ---------- duplicate-severity routes ----------
// Packs can legally declare several routes of one severity (crawled packs
// do). Alertmanager rejects duplicate notification-config names, and stops
// at the first matching sibling route — so duplicates must get unique
// ordinal names and be chained with `continue: true` or every receiver
// after the first is silently unreachable.
process.stdout.write('\n[duplicate-severity alertmanager routes]\n');
const dupRoutePack = {
  metadata: { name: 'dup-route-demo' },
  spec: {
    alerting: {
      routes: [
        { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/a' }] },
        { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/b' }] },
        { severity: 'SEV2', channels: [{ email: 'oncall@example.com' }] },
        { severity: 'SEV1', channels: [{ webhook: 'https://hooks.example/page' }] },
      ],
    },
  },
};
const dupAm = parseYaml(compileAlertmanager(dupRoutePack).replace(/^#[^\n]*\n/gm, ''));
const recNames = (dupAm.receivers || []).map(r => r.name);
assert(new Set(recNames).size === recNames.length,
       'duplicate-severity routes get unique receiver names', recNames.join(','), 'all unique');
assert(recNames.filter(n => /-sev2(-\d+)?$/.test(n)).length === 3,
       'all three SEV2 routes keep their own receiver', recNames.join(','), '3 sev2 receivers');
const sev2Routes = (dupAm.route?.routes || []).filter(r => (r.matchers || []).some(m => /SEV2/.test(m)));
assert(sev2Routes.length === 3
         && sev2Routes.slice(0, -1).every(r => r.continue === true)
         && sev2Routes[sev2Routes.length - 1].continue !== true,
       'identical-matcher siblings chain with continue so every channel fires',
       JSON.stringify(sev2Routes.map(r => !!r.continue)), '[true,true,false]');
const sev1Routes = (dupAm.route?.routes || []).filter(r => (r.matchers || []).some(m => /SEV1/.test(m)));
assert(sev1Routes.length === 1 && sev1Routes[0].continue !== true,
       'a lone route in its matcher group stays terminal');

// ---------- policy PromQL from burn-rules.mjs ----------
// compile.mjs no longer builds a burn expression itself: every burn-rate
// alert, forecast and error-budget record comes from tools/lib/burn-rules.mjs
// (the forms measured on a live queue manager). These assertions pin the
// contract on the payment-service pack and on in-memory shapes.
process.stdout.write('\n[policy PromQL] burn-rules.mjs is the single source\n');
{
  // A `|` block scalar keeps its final newline through mini-yaml; the in-memory
  // rule has none, so parsed exprs are normalised before any comparison.
  const parseRules = (text) => {
    const doc = parseYaml(text.replace(/^#[^\n]*\n/gm, ''));
    for (const r of doc.groups.flatMap(g => g.rules)) {
      if (typeof r.expr === 'string') r.expr = r.expr.replace(/\n$/, '');
      for (const d of r.data || []) if (typeof d.model?.expr === 'string') d.model.expr = d.model.expr.replace(/\n$/, '');
    }
    return doc;
  };
  const pack = parseYaml(readFileSync(resolve(ROOT, FIXTURES[0].path), 'utf8'));
  const sliOf = (id) => pack.spec.slis.find(s => s.id === id);
  const fmt = (x) => Number(x).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  const doc = parseRules(compilePrometheusRules(pack));
  const rules = doc.groups.flatMap(g => g.rules);
  const alerts = rules.filter(r => r.alert);
  const burnAlerts = alerts.filter(a => a.labels?.burn_rate);
  const assuranceAlerts = alerts.filter(a => a.labels?.kind === 'assurance');
  const records = rules.filter(r => r.record);
  const groupsByName = Object.fromEntries(doc.groups.map(g => [g.name, g]));

  // 1. no naive form survives; every burn alert is the three-clause block
  assert(burnAlerts.length === 8, 'payment-service emits eight burn-rate alerts (ratio and threshold SLOs)', burnAlerts.length, 8);
  assert(alerts.every(a => !/\(1 - \(?sum\(rate\(/.test(a.expr)), 'no alert carries the naive (1 - sum(rate(...))) error ratio');
  assert(alerts.every(a => !/\brate\(/.test(a.expr)), 'no alert uses rate(): counters are read with increase()');
  const BLOCK = /^\(\n {2}.+ > [0-9.]+\n\) and \(\n {2}.+ > [0-9.]+\n\) and \(\n {2}.+ >= 2\n\)$/;
  assert(burnAlerts.every(a => BLOCK.test(a.expr)), 'every burn alert is short > t, long > t, short bad >= 2', burnAlerts.filter(a => !BLOCK.test(a.expr)).map(a => a.alert), []);
  // a vector subtraction with no right-hand match is EMPTY: during a 100 % outage (no series
  // satisfies the good selector) `total - good` returns nothing and the alert could not fire,
  // so every ratio leg falls back to the total: `((T) - (G)) or (T)` (measured with promtool
  // test rules: one status="500" series, 100 requests in 5m, no alert without the `or`).
  const ratioBurn = burnAlerts.filter(a => sliOf(a.labels.sli).type === 'ratio');
  const OR_LEG = /^\(\(\(sum\(increase\((.+?)\[(5m|30m)\]\)\)\) - \(sum\(increase\(.+?\)\)\)\) or \(sum\(increase\(\1\[\2\]\)\)\)\) >= 2$/;
  assert(ratioBurn.length === 4 && ratioBurn.every(a => OR_LEG.test(a.expr.split('\n')[5].trim())),
         'every ratio burn alert\'s floor leg is (total - good) or total on the short window', ratioBurn.map(a => a.expr.split('\n')[5].trim()));
  assert(ratioBurn.every(a => (a.expr.match(/ or \(/g) || []).length === 3), 'the or-fallback is in all three ratio clauses (short, long, floor)');

  // 2. ratio SLOs count events; threshold SLOs count recorded samples above the bound
  const expectedSamples = (w) => Math.round(({ m: 60, h: 3600 }[w.slice(-1)] * parseFloat(w)) / 30);
  for (const a of burnAlerts) {
    const sli = sliOf(a.labels.sli);
    if (sli.type === 'ratio') {
      assert(a.expr.includes('clamp_min(') && a.expr.includes('increase('), `${a.alert}: events over the events that happened`);
    } else {
      const series = `payment_service:${sli.id.replace(/[^a-zA-Z0-9_]/g, '_')}:value_5m`;
      assert(a.expr.includes('> bool ') && a.expr.includes(series), `${a.alert}: reads ${series} above its threshold`);
      assert(a.expr.includes(`[${a.labels.window_short}:30s]`) && a.expr.includes(`/ ${expectedSamples(a.labels.window_short)}`),
             `${a.alert}: short window sampled at the 30s recording interval`, a.expr.split('\n')[1], `[${a.labels.window_short}:30s] / ${expectedSamples(a.labels.window_short)}`);
    }
  }
  const checkoutFast = burnAlerts.find(a => a.alert === 'checkout_latency_99_5_p99_300ms_burn_14x_5m_1h');
  assert(!!checkoutFast && checkoutFast.expr.includes('[5m:30s]') && checkoutFast.expr.includes('/ 10'), 'checkout 14x: ten expected samples in 5m');

  // 3. policy records per SLO
  for (const slo of pack.spec.slos) {
    const sli = sliOf(slo.sli);
    const budget = fmt(1 - slo.objective);
    for (const w of ['5m', '1h']) {
      const rec = records.find(r => r.record === `payment_service:errorbudget:burn_${w}` && r.labels?.slo === slo.id);
      assert(!!rec && rec.expr.endsWith(`/ ${budget}`), `${slo.id}: errorbudget:burn_${w} divides by its budget ${budget}`, rec?.expr?.slice(-12), `/ ${budget}`);
    }
    // <svc>:<sli>:error_ratio_5m is the SLI's one error ratio (labels { sli, service }, no slo): the
    // policy's own form, never the naive `1 - ratio_5m` that is empty during a 100 % outage
    const ratioRecs = records.filter(r => r.record === `payment_service:${sli.id}:error_ratio_5m`);
    assert(ratioRecs.length === 1 && Object.keys(ratioRecs[0].labels).join(',') === 'sli,service' && ratioRecs[0].labels.sli === sli.id,
           `${slo.id}: its SLI has exactly one error_ratio_5m record, labelled by SLI only`, ratioRecs.map(r => r.labels), [{ sli: sli.id, service: 'payment-service' }]);
    if (sli.type === 'threshold') {
      const want = `(sum_over_time((max(payment_service:${sli.id.replace(/[^a-zA-Z0-9_]/g, '_')}:value_5m) > bool ${sli.threshold})[5m:30s]) / 10)`;
      assert(ratioRecs[0].expr === want, `${slo.id}: the threshold error_ratio_5m counts recorded samples above ${sli.threshold} over 10 expected`, ratioRecs[0].expr, want);
    } else {
      assert(ratioRecs[0].expr.includes('increase(') && ratioRecs[0].expr.includes('clamp_min(') && !ratioRecs[0].expr.includes('1 - '),
             `${slo.id}: the ratio error_ratio_5m counts bad events over the events that happened`, ratioRecs[0].expr.slice(0, 80));
    }
  }
  assert(records.filter(r => /:error_ratio_5m$/.test(r.record)).every(r => r.expr.includes('sum_over_time(') || r.expr.includes('increase(')),
         'every error_ratio_5m record is bad-over-expected or bad-over-happened', records.filter(r => /:error_ratio_5m$/.test(r.record) && !(r.expr.includes('sum_over_time(') || r.expr.includes('increase('))).map(r => r.expr), []);
  // promtool's duplicate-rule lint keys on (record, labels): nothing in the recording group may repeat
  const recordKey = (r) => `${r.record}|${JSON.stringify(Object.entries(r.labels || {}).sort())}`;
  const uniqueRecords = (grp) => { const keys = grp.rules.filter(r => r.record).map(recordKey); return new Set(keys).size === keys.length; };
  assert(uniqueRecords(groupsByName['payment_service_recording']), 'no (record, labels) pair repeats in the recording group');
  const recIdx = records.map(r => r.record);
  assert(recIdx.indexOf('payment_service:api_availability:error_ratio_5m') < recIdx.indexOf('payment_service:errorbudget:burn_5m'),
         'policy records follow the SLI records of their SLO');
  const customPack = {
    metadata: { name: 'custom-only', version: '0.0.1' },
    spec: {
      slis: [{ id: 'c1', type: 'custom', expression: 'vector(1)' }],
      slos: [{ id: 'c1_99', sli: 'c1', objective: 0.99, window: '30d' }],
      policy: { burn_rate_alerts: [{ slo: 'c1_99', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] }], forecasts: [{ slo: 'c1_99', horizon: '7d' }] },
    },
  };
  const customWarnings = [];
  const customDoc = parseRules(compilePrometheusRules(customPack, { onWarning: (m) => customWarnings.push(m) }));
  // (the assurance group aside — step 5 adds it to every file; it is pinned in section 15)
  const customRules = customDoc.groups.flatMap(g => g.rules).filter(r => r.labels?.kind !== 'assurance');
  assert(customRules.length === 1 && customRules[0].record === 'custom_only:c1:value_5m', 'a custom SLI gets value_5m only', customRules.map(r => r.record || r.alert), ['custom_only:c1:value_5m']);
  assert(customWarnings.length === 1, 'the custom SLI is warned about once', customWarnings, 1);

  // 4. threshold SLOs now get their policy groups
  const checkoutGroup = groupsByName['payment_service_checkout_latency_99_5_p99_300ms_burn'];
  const freshGroup = groupsByName['payment_service_consumer_freshness_99_under_60s_burn'];
  assert(!!checkoutGroup && !!freshGroup, 'threshold SLOs get their burn groups');
  const byName = Object.fromEntries(burnAlerts.map(a => [a.alert, a]));
  const forAndThreshold = (name) => [byName[name]?.for, /> ([0-9.]+)\n/.exec(byName[name]?.expr || '')?.[1]];
  assert(JSON.stringify([
    forAndThreshold('checkout_latency_99_5_p99_300ms_burn_14x_5m_1h'), forAndThreshold('checkout_latency_99_5_p99_300ms_burn_6x_30m_6h'),
    forAndThreshold('consumer_freshness_99_under_60s_burn_10x_10m_1h'), forAndThreshold('consumer_freshness_99_under_60s_burn_4x_1h_6h'),
  ]) === JSON.stringify([['2m', '0.07'], ['5m', '0.03'], ['5m', '0.1'], ['10m', '0.04']]), 'threshold burn alerts: for 2m/5m/5m/10m, thresholds 0.07/0.03/0.1/0.04');

  // 5. forecasts on the recorded 1h burn
  const forecasts = alerts.filter(a => a.labels?.kind === 'forecast');
  assert(forecasts.length === pack.spec.policy.forecasts.length, 'one forecast per policy entry', forecasts.length, pack.spec.policy.forecasts.length);
  const FORECAST = /^predict_linear\(payment_service:errorbudget:burn_1h\{slo="([^"]+)"\}\[1d\], (\d+)\) > 1 and min_over_time\(payment_service:errorbudget:burn_1h\{slo="\1"\}\[2h\]\) > 1$/;
  for (const f of forecasts) {
    const m = FORECAST.exec(f.expr);
    assert(!!m && Number(m[2]) <= 86400, `${f.alert}: regresses burn_1h over 1d, sustained 2h, horizon capped at 1d`, f.expr);
    assert(f.annotations.horizon === '1d', `${f.alert}: horizon annotation says 1d was evaluated`, f.annotations.horizon, '1d');
  }
  const fc = Object.fromEntries(forecasts.map(f => [f.alert, f]));
  assert(fc['api_availability_99_9_forecast_breach']?.labels.severity === 'SEV2' && fc['api_availability_99_9_forecast_breach']?.annotations.horizon_declared === '7d',
         'open_ticket forecast is SEV2 and declares 7d');
  assert(fc['checkout_latency_99_5_p99_300ms_forecast_breach']?.labels.severity === 'SEV3' && fc['checkout_latency_99_5_p99_300ms_forecast_breach']?.annotations.horizon_declared === '3d',
         'post_warning forecast is SEV3 and declares 3d');

  // 6. contract keys
  const LABEL_KEYS = 'severity,slo,sli,service,burn_rate,window_short,window_long,pack';
  const ANNOTATION_KEYS = 'summary,description,slo_objective,slo_window,runbook';
  assert(burnAlerts.every(a => Object.keys(a.labels).join(',') === LABEL_KEYS), 'burn alert label keys are exactly the contract, pack last', Object.keys(burnAlerts[0].labels).join(','), LABEL_KEYS);
  assert(burnAlerts.every(a => Object.keys(a.annotations).join(',') === ANNOTATION_KEYS), 'burn alert annotation keys are exactly the contract', Object.keys(burnAlerts[0].annotations).join(','), ANNOTATION_KEYS);
  assert(burnAlerts.every(a => a.annotations.summary.includes('×') && a.labels.pack === 'payment-service'), 'summary keeps the × sign and pack label carries the pack name');
  assert(byName['api_availability_99_9_burn_14x_5m_1h'].annotations.slo_objective === '99.900%', 'slo_objective keeps its three decimals');
  assert(burnAlerts.every(a => a.annotations.runbook === '(supply runbook URL)'), 'runbook placeholder without opts.runbooks');
  const FORECAST_LABEL_KEYS = 'severity,slo,kind,service,sli,pack';
  const FORECAST_ANNOTATION_KEYS = 'summary,method,on_projected_breach,horizon,horizon_declared';
  const sliOfSlo = (sloId) => pack.spec.slos.find(s => s.id === sloId)?.sli;
  assert(forecasts.every(f => Object.keys(f.labels).join(',') === FORECAST_LABEL_KEYS), 'forecast label keys are exactly the contract, sli then pack last', forecasts.map(f => Object.keys(f.labels).join(',')), FORECAST_LABEL_KEYS);
  assert(forecasts.every(f => Object.keys(f.annotations).join(',') === FORECAST_ANNOTATION_KEYS), 'forecast annotation keys are exactly the contract', forecasts.map(f => Object.keys(f.annotations).join(',')), FORECAST_ANNOTATION_KEYS);
  assert(forecasts.every(f => f.labels.pack === 'payment-service' && f.labels.service === 'payment-service' && f.labels.sli === sliOfSlo(f.labels.slo)),
         'forecast pack/service carry the pack name and sli is the SLO\'s SLI', forecasts.map(f => [f.labels.pack, f.labels.sli]));
  const withRunbook = parseRules(compilePrometheusRules(pack, { runbooks: { api_availability: 'https://x' } })).groups.flatMap(g => g.rules).filter(r => r.labels?.burn_rate);
  assert(withRunbook.filter(a => a.labels.sli === 'api_availability').every(a => a.annotations.runbook === 'https://x')
         && withRunbook.filter(a => a.labels.sli !== 'api_availability').every(a => a.annotations.runbook === '(supply runbook URL)'),
         'opts.runbooks supplies the runbook per SLI');

  // 7. one source of truth: the generator and the compiler emit the same PromQL for ratio SLOs and forecasts
  const gen = compileBurnRules(pack, { step: 15 });
  const genRules = gen.groups.flatMap(g => g.rules);
  const genAlerts = Object.fromEntries(genRules.filter(r => r.alert).map(r => [r.alert, r]));
  // The generator reads a threshold SLI from the pack's own `ref:slis.<id>` recording rule, the
  // compiler from its `<svc>:<sli>:value_5m`; with the series name normalised the PromQL must be
  // byte-identical (same 30 s series step, same expected-sample counts, same floor).
  const declaredSeries = (sliId) => pack.spec.queries.recording_rules.find(r => String(r.expr).trim() === `ref:slis.${sliId}`)?.name;
  // (A threshold SLI without such a rule — api_latency_p99 — is inlined by the generator at the
  // scrape step and read from value_5m by the compiler: not comparable, and it has no policy.)
  const normalise = (expr, sliId) => {
    const sli = sliOf(sliId);
    if (sli?.type !== 'threshold') return expr;
    const theirs = declaredSeries(sliId);
    return theirs ? expr.split(theirs).join(`payment_service:${sli.id.replace(/[^a-zA-Z0-9_]/g, '_')}:value_5m`) : null;
  };
  // Step 5: the parity holds over the POLICY alerts (burn + forecast); the assurance group is the
  // compiler's own (the generator is not extended — mq-observability-pack's ibmmq.burn.yml and the
  // reference packs' *.burn.yml stay as they are).
  const policyAlerts = alerts.filter(a => a.labels?.burn_rate || a.labels?.kind === 'forecast');
  const shared = policyAlerts.filter(a => genAlerts[a.alert]);
  assert(shared.length === policyAlerts.length && shared.length === 10, 'the generator and the compiler emit the same policy alert names (8 burn + 2 forecast)', shared.length, 10);
  assert(alerts.length === policyAlerts.length + assuranceAlerts.length, 'every other alert of the full file is an assurance alert', alerts.length - policyAlerts.length - assuranceAlerts.length, 0);
  const differing = shared.filter(a => normalise(genAlerts[a.alert].expr, a.labels.sli) !== a.expr).map(a => a.alert);
  assert(differing.length === 0, 'every shared alert has byte-identical expr modulo the threshold series name', differing, []);
  assert(shared.filter(a => a.labels.burn_rate && sliOf(a.labels.sli)?.type === 'threshold').length === 4, 'four threshold burn alerts took part in the comparison');
  const genRecords = genRules.filter(r => r.record);
  const comparableSlos = pack.spec.slos.filter(slo => normalise('', slo.sli) !== null);
  assert(comparableSlos.length === 4, 'four of the five SLOs are comparable (api_latency_p99 declares no ref:slis record)', comparableSlos.length, 4);
  for (const slo of comparableSlos) for (const w of ['5m', '1h']) {
    const mine = records.find(r => r.record === `payment_service:errorbudget:burn_${w}` && r.labels.slo === slo.id);
    const theirs = genRecords.find(r => r.record === `${metricPrefix(pack.metadata.name)}:errorbudget:burn_${w}` && r.labels.slo === slo.id);
    assert(!!mine && !!theirs && mine.expr === normalise(theirs.expr, slo.sli), `${slo.id} burn_${w}: generator and compiler agree`, mine?.expr?.slice(0, 60), theirs?.expr?.slice(0, 60));
  }

  // 8. SLI shapes
  const shapePack = (sli, extra = {}) => ({
    metadata: { name: 'shape', version: '0.0.1' },
    spec: {
      slis: [{ id: 's', ...sli }],
      slos: [{ id: 's_99', sli: 's', objective: 0.99, window: '30d' }],
      policy: { burn_rate_alerts: [{ slo: 's_99', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] }] },
      ...extra,
    },
  });
  const burnOf = (p, opts) => {
    const warnings = [];
    const doc = parseRules(compilePrometheusRules(p, { ...opts, onWarning: (m) => warnings.push(m) }));
    // the first POLICY alert (step 5 adds an assurance group to every file; its Watchdog is not the burn alert under test)
    const a = doc.groups.flatMap(g => g.rules).find(r => r.alert && r.labels?.kind !== 'assurance');
    return { expr: a?.expr, for: a?.for, alert: a, records: doc.groups.flatMap(g => g.rules).filter(r => r.record), warnings };
  };
  const bare = burnOf(shapePack({ type: 'ratio', good: 'good_total', total: 'req_total' }));
  assert(bare.expr.includes('sum(increase(good_total[5m]))') && />= 2\n\)$/.test(bare.expr), 'bare selectors are wrapped in sum(increase()) and floored');
  assert(bare.for === '2m', 'production for: 2m on a 5m short window', bare.for, '2m');
  // the studio's live-draft shape (sli-inference: `total: "1"`, good = the ratio_* rule's expr) splits
  // into its two counter legs: floored, event-counted, no naive `1 - rate/rate`, no warning
  const splitTotal = burnOf(shapePack({ type: 'ratio', good: 'sum(rate(ok_total{svc="a"}[5m])) / sum(rate(all_total{svc="a"}[5m]))', total: '1' }));
  assert(splitTotal.expr.split('\n').length === 7 && />= 2\n\)$/.test(splitTotal.expr) && !/\(1 - /.test(splitTotal.expr) && splitTotal.expr.includes('clamp_min((sum(increase(all_total{svc="a"}[5m]))), 1)') && splitTotal.warnings.length === 0,
         'total: "1" with good = a / b is read as events on its two legs (floored, no warning)', [splitTotal.expr.split('\n').length, splitTotal.warnings], [7, []]);
  assert(splitTotal.records.some(r => r.record === 'shape:errorbudget:burn_5m' && r.expr.includes(') or (sum(increase(all_total{svc="a"}[5m])))) / clamp_min(')),
         'its errorbudget records carry the same event legs');
  // a good that neither splits into two countable legs nor is a bare series has no event or sample
  // count: no alert (never the former unfloored two-clause `1 - good` form), its SLI records only
  // (good/total/ratio; no error_ratio_5m, no errorbudget), one warning
  const scalarTotal = burnOf(shapePack({ type: 'ratio', good: 'avg_over_time(probe_success[5m])', total: '1' }));
  assert(scalarTotal.expr === undefined && scalarTotal.records.map(r => r.record).join() === 'shape:s:good_5m,shape:s:total_5m,shape:s:ratio_5m'
         && scalarTotal.warnings.length === 1 && /no event or sample count, no policy rules$/.test(scalarTotal.warnings[0]),
         'an opaque total: "1" ratio gets no alert, no error_ratio_5m and one warning', [scalarTotal.expr, scalarTotal.records.map(r => r.record), scalarTotal.warnings]);
  // the live drafter's bare-gauge shape (`up{job="x"}` over 1) is a 0/1 state series: sampled, floored, warned
  const gauge = burnOf(shapePack({ type: 'ratio', good: 'up{job="x"}', total: '1' }), { step: 10 });
  assert(gauge.expr.split('\n').length === 7 && gauge.expr.split('\n')[1].trim() === '(sum_over_time((1 - (up{job="x"}))[5m:10s]) / 30) > 0.14' && />= 2\n\)$/.test(gauge.expr)
         && gauge.warnings.length === 1 && /read as a 0\/1 state gauge per series, sampled every 10s$/.test(gauge.warnings[0]),
         'a bare gauge over 1 is read as a state series with windows and the floor, one warning', [gauge.expr.split('\n')[1], gauge.warnings]);
  assert(gauge.records.some(r => r.record === 'shape:s:error_ratio_5m' && r.expr === '(sum_over_time((1 - (up{job="x"}))[5m:10s]) / 30)'), 'its error_ratio_5m record is the same sampled ratio');
  // a ratio no valid naive form exists for (aggregation legs without a range) emits nothing, never `sum(rate(avg(up)[5m]))`
  const noForm = burnOf(shapePack({ type: 'ratio', good: 'avg(up)', total: 'count(up)' }));
  assert(noForm.expr === undefined && noForm.records.length === 3 && noForm.warnings.length === 1 && /no policy rules$/.test(noForm.warnings[0]),
         'an aggregation ratio without a range gets its SLI records (no error_ratio_5m), no alert and one warning', [noForm.expr, noForm.records.length, noForm.warnings], [undefined, 3, ['... no policy rules']]);
  // `count(<state> == 1) / count(<state>)` is read as sum(<state> == bool 1): burn alerts, forecast base, one warning
  const filtered = burnOf(shapePack({ type: 'ratio', good: 'count(up == 1)', total: 'count(up)' }), { step: 10 });
  assert(filtered.expr?.split('\n')[1].trim() === '(sum(sum_over_time((1 - (up == bool 1))[5m:10s])) / ((count(up)) * 30)) > 0.14' && />= 2\n\)$/.test(filtered.expr)
         && filtered.warnings.length === 1 && /count\(up == 1\) read as sum\(up == bool 1\)/.test(filtered.warnings[0]),
         'count() over a filter comparison gets the state form (boolified) and one warning', [filtered.expr?.split('\n')[1], filtered.warnings]);
  assert(filtered.records.some(r => r.record === 'shape:errorbudget:burn_1h' && r.expr.includes('[1h:10s]')), 'and its errorbudget records');
  // the empty-good fill needs both legs to aggregate to the same label set: `sum by (route)` over
  // `sum` matches nothing, and the fill would page a healthy service as a 100 % outage
  // (promtool test rules: policy-shapes.test.yml, route_99 on healthy input → no sample, no alert)
  const mismatch = burnOf(shapePack({ type: 'ratio', good: 'sum by (route) (rate(ok_total{job="x"}[5m]))', total: 'sum(rate(all_total{job="x"}[5m]))' }));
  assert(!mismatch.expr.includes(' or (') && />= 2\n\)$/.test(mismatch.expr) && mismatch.warnings.length === 1
         && mismatch.warnings[0] === 'SLI s: good groups by (route) but total does not; the two legs will not match',
         'mismatched groupings get the difference without the fill and one warning', [mismatch.expr.split('\n')[5], mismatch.warnings]);
  assert(!mismatch.records.find(r => r.record === 'shape:errorbudget:burn_5m').expr.includes(' or ('), 'its errorbudget records carry no fill either');
  // a bare selector named like a recording rule is a rate or a gauge: increase() cannot count it — no policy rules
  const recorded = burnOf(shapePack({ type: 'ratio', good: 'svc:req:good_rate_5m', total: 'svc:req:total_rate_5m' }));
  assert(recorded.expr === undefined && recorded.records.length === 3 && recorded.warnings.length === 1 && /is a recording rule \(a rate or a gauge\), which increase\(\) cannot count.*no policy rules$/.test(recorded.warnings[0]),
         'recording-rule selectors get no increase() legs, no error_ratio_5m and one warning', [recorded.expr, recorded.records.length, recorded.warnings]);
  const unsuffixed = burnOf(shapePack({ type: 'ratio', good: 'requests_ok', total: 'requests' }));
  assert(unsuffixed.expr.includes('sum(increase(requests_ok[5m]))') && unsuffixed.warnings.length === 2 && unsuffixed.warnings.every(w => /is read as a raw counter/.test(w)),
         'selectors without a counter suffix are counted but warned about', unsuffixed.warnings);
  const irate = burnOf(shapePack({ type: 'ratio', good: 'sum(irate(ok[5m]))', total: 'sum(irate(all[5m]))' }));
  assert(irate.expr === undefined && irate.warnings.length === 1 && /irate/.test(irate.warnings[0]), 'irate legs have no event count and emit no alert', irate.warnings);
  // a bare selector next to a range expression is countable too: wrapped in sum(increase()) and read as events
  // (the naive `1 - sum(rate(sel)) / total` used to survive for this shape, by tested contract)
  const mixed = burnOf(shapePack({ type: 'ratio', good: 'good_total', total: 'sum(rate(req_total[5m]))' }));
  assert(mixed.expr.split('\n').length === 7 && />= 2\n\)$/.test(mixed.expr) && !/\(1 - /.test(mixed.expr) && !/\brate\(/.test(mixed.expr)
         && mixed.expr.includes('sum(increase(good_total[5m]))') && mixed.expr.includes('clamp_min((sum(increase(req_total[5m]))), 1)') && mixed.warnings.length === 0,
         'a bare selector over a rate is wrapped in sum(increase()) and floored as events, no warning', [mixed.expr.split('\n')[1], mixed.warnings]);
  // the empty-good fill is selector-only: a good derived by subtraction (total - errors) is empty
  // whenever the error counter has never been exposed, and the fill would read that healthy
  // service as a 100 % outage (promtool test rules: tools/fixtures/compile/policy-shapes.test.yml)
  const derived = burnOf(shapePack({ type: 'ratio', good: 'sum(rate(all_total[5m])) - sum(rate(err_total[5m]))', total: 'sum(rate(all_total[5m]))' }));
  assert(!derived.expr.includes(' or (') && />= 2\n\)$/.test(derived.expr) && derived.expr.split('\n')[5].trim() === '((sum(increase(all_total[5m]))) - (sum(increase(all_total[5m])) - sum(increase(err_total[5m])))) >= 2'
         && derived.warnings.length === 1 && /derived by arithmetic/.test(derived.warnings[0]) && /or vector\(0\)/.test(derived.warnings[0]),
         'a good derived by arithmetic gets no empty-good fill and one warning naming the fix', [derived.expr.split('\n')[5], derived.warnings]);
  assert(!derived.records.find(r => r.record === 'shape:errorbudget:burn_5m').expr.includes(' or ('), 'its errorbudget records carry no fill either');
  const derivedOr = burnOf(shapePack({ type: 'ratio', good: 'sum(rate(a[5m])) or sum(rate(b[5m]))', total: 'sum(rate(a[5m]))' }));
  assert(!derivedOr.expr.includes(') or (sum(increase(a[5m]))))') && derivedOr.warnings.length === 1, 'a good joined with `or` counts as derived');
  // a subtracted leg that already carries `or vector(0)` took the advice: still derived (no fill), no warning
  const guarded = burnOf(shapePack({ type: 'ratio', good: 'sum(rate(all_total[5m])) - (sum(rate(err_total[5m])) or vector(0))', total: 'sum(rate(all_total[5m]))' }));
  assert(!guarded.expr.includes(' or (sum(increase(all_total') && guarded.expr.includes('(sum(increase(err_total[5m])) or vector(0))') && guarded.warnings.length === 0,
         'a guarded subtraction gets no empty-good fill and no "add or vector(0)" warning', [guarded.expr.split('\n')[5], guarded.warnings]);
  const guardedStr = burnOf(shapePack({ type: 'ratio', good: 'sum(rate(all_total{note="or vector(0)"}[5m])) - sum(rate(err_total[5m]))', total: 'sum(rate(all_total[5m]))' }));
  assert(guardedStr.warnings.length === 1 && /or vector\(0\)/.test(guardedStr.warnings[0]), 'the guard is looked for outside string literals only');
  // a numeric literal in a label value or an exponent is not an operator
  const notDerived = burnOf(shapePack({ type: 'ratio', good: 'sum(rate(ok{le="1e-3", path="/a-b"}[5m]))', total: 'sum(rate(all[5m]))' }));
  assert((notDerived.expr.match(/ or \(/g) || []).length === 3 && notDerived.warnings.length === 0, 'a selector good with `-` inside strings keeps the fill');
  // a scalar good over a range total has no event count: no alert, no error_ratio_5m, one warning
  // (the former naive `1 - 1 / total` carried no floor and no expected-sample denominator)
  const legacy = burnOf(shapePack({ type: 'ratio', good: '1', total: 'sum(rate(req_total[5m]))' }));
  assert(legacy.expr === undefined && legacy.records.length === 3 && legacy.warnings.length === 1 && /ratio shape not recognised.*no policy rules$/.test(legacy.warnings[0]),
         'a scalar good over a rate gets no policy rules and warns once', [legacy.expr, legacy.records.length, legacy.warnings]);
  const state = burnOf(shapePack({ type: 'ratio', good: 'sum(up == 1)', total: 'count(up)' }), { step: 10 });
  assert(state.expr.includes('== bool 1') && state.expr.includes('[5m:10s]') && state.expr.includes('* 30'),
         'a state-style ratio is boolified and sampled at opts.step', state.expr.split('\n')[1]);
  // opts.lab and opts.minBadSamples reach the builders through the public API
  const lab = burnOf(shapePack({ type: 'ratio', good: 'good_total', total: 'req_total' }), { lab: true });
  assert(lab.for === '30s', 'opts.lab gives the lab for: 30s on a 5m short window', lab.for, '30s');
  const floor3 = burnOf(shapePack({ type: 'ratio', good: 'good_total', total: 'req_total' }), { minBadSamples: 3 });
  assert(/>= 3\n\)$/.test(floor3.expr) && /at least 3 bad samples/.test(floor3.alert.annotations.description), 'opts.minBadSamples sets the floor and the description', floor3.expr.split('\n')[5]);
  assert(compileSloPrometheusRules(shapePack({ type: 'ratio', good: 'good_total', total: 'req_total' }), 's_99', { lab: true }).includes('for: 30s'), 'compileSloPrometheusRules forwards opts.lab');

  // 9. per-SLO files
  const perSlo = compileSloPrometheusRules(pack, 'api_availability_99_9');
  assert(perSlo.includes('payment_service:errorbudget:burn_1h') && perSlo.includes('predict_linear(payment_service:errorbudget:burn_1h{slo="api_availability_99_9"}')
         && perSlo.includes('keep_firing_for'), 'per-SLO file carries the policy records, the forecast and keep_firing_for (pack declares prometheus 2.55)');
  assert(!compileSloPrometheusRules(pack, 'api_availability_99_9', { product: 'victoriametrics', version: '1.99' }).includes('keep_firing_for'),
         'per-SLO file for vmalert omits keep_firing_for');
  // contract: a per-SLO file is the SLO's slice of the full file, same profile knob, same field
  // placement (before this round per-SLO files never emitted keep_firing_for)
  const kffOf = (text) => parseRules(text).groups.flatMap(g => g.rules).filter(r => r.labels?.burn_rate).map(r => `${r.alert}=${r.keep_firing_for ?? '-'}`).sort();
  for (const [product, version] of [['prometheus', '3.0'], ['prometheus', '2.30'], ['victoriametrics', '1.99'], ['mimir', '2.15']]) {
    const full = kffOf(compilePrometheusRules(pack, { product, version })).filter(k => k.startsWith('api_availability_99_9_burn'));
    const slice = kffOf(compileSloPrometheusRules(pack, 'api_availability_99_9', { product, version }));
    assert(JSON.stringify(full) === JSON.stringify(slice) && full.length === 2, `${product} ${version}: per-SLO keep_firing_for equals the full file's`, slice, full);
  }
  const sloArtifact = compileArtifact(pack, { group: 'rules', flavor: 'prometheus', artifact: 'slo:api_availability_99_9', product: 'victoriametrics', version: '1.99' }).content;
  assert(!sloArtifact.includes('keep_firing_for'), 'compileArtifact forwards product/version to the per-SLO compiler');
  const refPack = JSON.parse(JSON.stringify(pack));
  refPack.spec.policy.burn_rate_alerts.push({ slo: 'ref:slos.api_availability_99_9', windows: [{ short: '1h', long: '6h', factor: 2, severity: 'SEV3' }] });
  assert(compileSloPrometheusRules(refPack, 'api_availability_99_9').includes('api_availability_99_9_burn_2x_1h_6h'), 'a ref:slos.<id> policy entry lands in the per-SLO file');

  // 10. Grafana-managed shares the PromQL and keeps uids unique
  const gm = parseRules(compileGrafanaManagedRules(pack));
  const gmRules = gm.groups.flatMap(g => g.rules);
  const uids = gmRules.map(r => r.uid), titles = gmRules.map(r => r.title);
  assert(new Set(uids).size === uids.length, 'Grafana-managed uids are unique', uids.length - new Set(uids).size, 0);
  assert(new Set(titles).size === titles.length, 'Grafana-managed titles are unique', titles.length - new Set(titles).size, 0);
  assert(gmRules.filter(r => r.record?.metric === 'payment_service:errorbudget:burn_5m').length === 5, 'one burn_5m record per burnable SLO', gmRules.filter(r => r.record?.metric === 'payment_service:errorbudget:burn_5m').length, 5);
  // Grafana's recording-rule writer accepts only reduced numeric frames: an instant query (one value
  // per series), never a range query (time-series frames need a Reduce expression). The threshold burn
  // alerts and every forecast read these records, so a range query here would leave them blind.
  const gmRecords = gmRules.filter(r => r.record);
  assert(gmRecords.length > 0 && gmRecords.every(r => r.data.length === 1 && r.data[0].model.instant === true && r.data[0].model.range === false && r.record.from === r.data[0].refId),
         'every Grafana-managed recording rule is a single instant query its record block reads from', gmRecords.filter(r => r.data[0].model.instant !== true).map(r => r.title), []);
  assert(gmRules.filter(r => !r.record).every(r => r.data[0].model.instant === true && r.data[1].model.type === 'threshold'), 'alert rules stay instant query + threshold expression');
  const gmAlerts = Object.fromEntries(gmRules.filter(r => !r.record).map(r => [r.title, r]));
  assert(alerts.every(a => gmAlerts[a.alert]?.data[0].model.expr === a.expr), 'Grafana-managed alert expr equals the Prometheus flavour', alerts.filter(a => gmAlerts[a.alert]?.data[0].model.expr !== a.expr).map(a => a.alert), []);
  // and every recording rule's expr too, keyed on (record, labels): the threshold burn alerts and the
  // forecasts read these records, so a drifted record expr is wrong output no alert assertion sees
  const recKey = (r) => `${r.record}|${JSON.stringify(Object.entries(r.labels || {}).sort())}`;
  const promRecs = new Map(records.map(r => [recKey(r), r.expr]));
  assert(gmRecords.length === records.length && gmRecords.every(r => promRecs.get(`${r.record.metric}|${JSON.stringify(Object.entries(r.labels || {}).sort())}`) === r.data[0].model.expr),
         'every Grafana-managed record expr equals the Prometheus record with the same (record, labels)',
         gmRecords.filter(r => promRecs.get(`${r.record.metric}|${JSON.stringify(Object.entries(r.labels || {}).sort())}`) !== r.data[0].model.expr).map(r => r.title), []);
  // uids are stable by default: a record whose name is unique in the file is keyed by that name
  // (the uid and title a deployed pack already carries), only a repeated name is keyed by its slo
  const gmRecByMetric = gmRecords.reduce((m, r) => m.set(r.record.metric, [...(m.get(r.record.metric) || []), r]), new Map());
  for (const [metric, rs] of gmRecByMetric) {
    if (rs.length === 1) assert(rs[0].title === metric, `Grafana-managed: unique record ${metric} is titled by its bare name`, rs[0].title, metric);
    else assert(rs.every(r => r.title === `${metric}{slo="${r.labels.slo}"}`), `Grafana-managed: repeated record ${metric} is titled by record and slo`, rs.map(r => r.title));
  }
  assert(gmRecords.find(r => r.record.metric === 'payment_service:api_availability:good_5m')?.uid === 'rec-payment_service-api_availabi-16chy4y',
         'the uid of a per-SLO record on an unshared SLI is what origin/develop deployed', gmRecords.find(r => r.record.metric === 'payment_service:api_availability:good_5m')?.uid, 'rec-payment_service-api_availabi-16chy4y');

  // 11. warnings and the catalog
  const compiled = compile(pack, 'prometheus-rules');
  assert(Array.isArray(compiled.warnings) && compiled.warnings.length === 0, 'compile() returns an empty warnings array for payment-service', compiled.warnings, []);
  const catalog = compileCatalog(pack).groups.find(g => g.id === 'rules').items;
  const subtitle = (id) => catalog.find(i => i.id === id)?.subtitle;
  assert(subtitle('slo:checkout_latency_99_5_p99_300ms') === '4 recording · 2 burn-rate · 1 forecast', 'catalog counts a threshold SLO from the builders', subtitle('slo:checkout_latency_99_5_p99_300ms'), '4 recording · 2 burn-rate · 1 forecast');
  assert(subtitle('slo:api_latency_99_p99_500ms') === '4 recording · 0 burn-rate · 0 forecast', 'catalog counts an unpolicied threshold SLO', subtitle('slo:api_latency_99_p99_500ms'), '4 recording · 0 burn-rate · 0 forecast');
  assert(compileArtifact(pack, { group: 'rules', flavor: 'prometheus', artifact: 'all', runbooks: { api_availability: 'https://y' } }).content.includes('runbook: https://y'),
         'compileArtifact forwards opts to the rules compilers');

  // 12. one threshold SLI shared by two SLOs: the error ratio is recorded once, the burn records per SLO
  const twoSlos = {
    metadata: { name: 'svc', version: '0.0.1' },
    spec: {
      slis: [{ id: 'lat', type: 'threshold', query: 'max(lat)', threshold: 0.5, unit: 'seconds' }],
      slos: [{ id: 'lat_99', sli: 'lat', objective: 0.99, window: '30d' }, { id: 'lat_999', sli: 'lat', objective: 0.999, window: '30d' }],
      policy: { burn_rate_alerts: [
        { slo: 'lat_99', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] },
        { slo: 'lat_999', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] },
      ] },
    },
  };
  const twoDoc = parseRules(compilePrometheusRules(twoSlos));
  const twoRecs = twoDoc.groups.flatMap(g => g.rules).filter(r => r.record);
  assert(twoRecs.filter(r => r.record === 'svc:lat:error_ratio_5m').length === 1, 'a shared threshold SLI records error_ratio_5m once', twoRecs.map(r => r.record));
  assert(twoRecs.filter(r => r.record === 'svc:errorbudget:burn_1h').map(r => r.labels.slo).join(',') === 'lat_99,lat_999', 'each SLO keeps its own burn records');
  assert(uniqueRecords(twoDoc.groups[0]), 'no (record, labels) pair repeats with two SLOs on one SLI');
  for (const sloId of ['lat_99', 'lat_999']) {
    assert(compileSloPrometheusRules(twoSlos, sloId).includes('record: svc:lat:error_ratio_5m'), `${sloId}: the per-SLO file still carries the SLI's error ratio`);
  }
  const twoGm = parseRules(compileGrafanaManagedRules(twoSlos)).groups.flatMap(g => g.rules);
  const ratioUids = twoGm.filter(r => r.record?.metric === 'svc:lat:error_ratio_5m').map(r => r.uid);
  assert(ratioUids.length === 1, 'Grafana-managed: one error_ratio_5m recording rule, one uid', ratioUids, 1);
  const burnUids = twoGm.filter(r => /errorbudget:burn_/.test(r.record?.metric || '')).map(r => r.uid);
  assert(new Set(burnUids).size === 4, 'Grafana-managed: four distinct burn record uids for two SLOs', burnUids.length - new Set(burnUids).size, 0);
  const twoUids = twoGm.map(r => r.uid), twoTitles = twoGm.map(r => r.title);
  assert(new Set(twoUids).size === twoUids.length && new Set(twoTitles).size === twoTitles.length,
         'Grafana-managed: every uid and title is unique with two SLOs on one SLI (value_5m is emitted per SLO)', twoUids.filter((u, i) => twoUids.indexOf(u) !== i), []);
  assert(twoGm.filter(r => r.record?.metric === 'svc:lat:value_5m').map(r => r.title).join(',') === 'svc:lat:value_5m{slo="lat_99"},svc:lat:value_5m{slo="lat_999"}',
         'per-SLO SLI records are titled by record and SLO', twoGm.filter(r => r.record?.metric === 'svc:lat:value_5m').map(r => r.title));
  // the per-SLO files of the two SLOs deploy by uid (server/deploy-helpers.mjs upserts one rule per
  // uid): the SLI-level record they share sits in the same per-SLI group (`svc_lat_sli_recording`,
  // never the full file's `svc_recording`, which a ruler keyed by (namespace, group) would replace)
  // under the same uid in both files, every other uid appears in one file only, and every uid is the full file's
  const perSloGm = ['lat_99', 'lat_999'].map(id => parseRules(compileArtifact(twoSlos, { group: 'rules', flavor: 'grafana-managed', artifact: `slo:${id}` }).content));
  const placements = perSloGm.flatMap(doc => doc.groups.flatMap(g => g.rules.map(r => ({ uid: r.uid, group: g.name }))));
  const groupsByUid = placements.reduce((m, p) => m.set(p.uid, new Set([...(m.get(p.uid) || []), p.group])), new Map());
  assert([...groupsByUid.values()].every(s => s.size === 1), 'a uid repeated across the two per-SLO Grafana files sits in the same group name', [...groupsByUid].filter(([, s]) => s.size > 1).map(([u, s]) => `${u}: ${[...s].join(' | ')}`), []);
  const sharedUids = [...placements.reduce((m, p) => m.set(p.uid, (m.get(p.uid) || 0) + 1), new Map())].filter(([, n]) => n > 1).map(([u]) => u);
  assert(sharedUids.length === 1 && groupsByUid.get(sharedUids[0]).has('svc_lat_sli_recording') && perSloGm.every(doc => doc.groups[0].name === 'svc_lat_sli_recording' && doc.groups[0].rules[0].record.metric === 'svc:lat:error_ratio_5m'),
         'only the SLI-level error_ratio_5m is shared, in the per-SLI svc_lat_sli_recording group', [sharedUids, perSloGm.map(d => d.groups.map(g => g.name))]);
  const fullUids = new Set(twoGm.map(r => r.uid));
  assert(placements.every(p => fullUids.has(p.uid)), 'every per-SLO Grafana uid is the full file\'s uid for that rule', placements.filter(p => !fullUids.has(p.uid)).map(p => p.uid), []);
  const fullGroups = new Set(parseRules(compilePrometheusRules(twoSlos)).groups.map(g => g.name));
  for (const sloId of ['lat_99', 'lat_999']) {
    const perSloProm = parseRules(compileSloPrometheusRules(twoSlos, sloId));
    assert(perSloProm.groups[0].name === 'svc_lat_sli_recording' && perSloProm.groups[0].rules.map(r => r.record).join() === 'svc:lat:error_ratio_5m' && perSloProm.groups[1].name === `svc_${sloId}_recording`,
           `${sloId}: the per-SLO Prometheus file keeps the SLI-level record in svc_lat_sli_recording, the SLO's own in svc_${sloId}_recording`, perSloProm.groups.map(g => `${g.name}: ${g.rules.map(r => r.record || r.alert).join(',')}`));
    // no per-SLO group name is a full-file group name (a ruler keyed by (namespace, group) would
    // otherwise replace the full file's 28-rule recording group with one rule)
    assert(perSloProm.groups.every(g => !fullGroups.has(g.name) || /_burn$/.test(g.name)), `${sloId}: per-SLO group names are disjoint from the full file's (burn groups excepted, same rules)`, perSloProm.groups.map(g => g.name).filter(n => fullGroups.has(n)), []);
  }
  const perSloPayment = parseRules(compileSloPrometheusRules(pack, 'api_availability_99_9')).groups.map(g => g.name);
  assert(!perSloPayment.includes('payment_service_recording') && perSloPayment[0] === 'payment_service_api_availability_sli_recording',
         'payment-service per-SLO file never carries the full file\'s payment_service_recording group', perSloPayment);

  // 13. a pack that pasted the generator's --pack-snippet declares the policy records itself:
  //     the pack's definition wins and nothing is recorded twice (promtool: duplicate rule)
  const pasted = JSON.parse(JSON.stringify(pack));
  const snippet = compileBurnRules(pack).recording;
  pasted.spec.queries.recording_rules.push(...snippet.map(r => ({ name: r.record, expr: r.expr, interval: '30s', labels: r.labels })));
  const pastedWarnings = [];
  const pastedDoc = parseRules(compilePrometheusRules(pasted, { onWarning: (m) => pastedWarnings.push(m) }));
  const pastedGroup = pastedDoc.groups.find(g => g.name === 'payment_service_recording');
  assert(uniqueRecords(pastedGroup), 'pasted policy records are not recorded twice', pastedGroup.rules.filter(r => r.record).map(recordKey).filter((k, i, a) => a.indexOf(k) !== i), []);
  assert(pastedWarnings.length === snippet.length && pastedWarnings.every(m => /is declared by the pack and generated by the policy; keeping the pack's$/.test(m)),
         'each collision is warned about once, keeping the pack\'s', pastedWarnings.length, snippet.length);
  const pastedBurn1h = pastedGroup.rules.filter(r => r.record === 'payment_service:errorbudget:burn_1h' && r.labels?.slo === 'checkout_latency_99_5_p99_300ms');
  assert(pastedBurn1h.length === 1 && pastedBurn1h[0].expr === snippet.find(r => r.record.endsWith('burn_1h') && r.labels.slo === 'checkout_latency_99_5_p99_300ms').expr,
         'the surviving record is the pack\'s own definition');
  assert(pastedDoc.groups.flatMap(g => g.rules).filter(r => r.alert).length === alerts.length, 'the alerts are unaffected by the pasted records');
  const pastedGm = parseRules(compileGrafanaManagedRules(pasted)).groups.flatMap(g => g.rules);
  assert(new Set(pastedGm.map(r => r.uid)).size === pastedGm.length && new Set(pastedGm.map(r => r.title)).size === pastedGm.length,
         'Grafana-managed uids and titles stay unique with pasted policy records', pastedGm.length - new Set(pastedGm.map(r => r.uid)).size, 0);
  const pastedRecordNames = pastedGm.filter(r => r.record).map(r => `${r.record.metric}|${JSON.stringify(Object.entries(r.labels || {}).sort())}`);
  assert(new Set(pastedRecordNames).size === pastedRecordNames.length, 'Grafana-managed records are not duplicated either');

  // 14. schema-valid forecast horizons in months and years compile (capped at 1d) and never throw
  for (const horizon of ['1mo', '1y']) {
    const hp = JSON.parse(JSON.stringify(pack));
    hp.spec.policy.forecasts = [{ slo: 'api_availability_99_9', horizon, method: 'linear', on_projected_breach: 'page_oncall' }];
    let hDoc = null, hErr = null;
    try { hDoc = parseRules(compilePrometheusRules(hp)); } catch (e) { hErr = e; }
    assert(!hErr, `horizon ${horizon}: compilePrometheusRules does not throw`, hErr?.message);
    const hf = hDoc?.groups.flatMap(g => g.rules).find(r => r.labels?.kind === 'forecast');
    assert(!!hf && /\[1d\], 86400\) > 1/.test(hf.expr) && hf.annotations.horizon === '1d' && hf.annotations.horizon_declared === horizon && hf.labels.severity === 'SEV1',
           `horizon ${horizon}: capped at 1d, declared horizon kept, page_oncall is SEV1`, hf && [hf.expr.slice(0, 90), hf.annotations.horizon, hf.annotations.horizon_declared, hf.labels.severity]);
    let cat = null;
    try { cat = compileCatalog(hp); } catch (e) { hErr = e; }
    assert(!hErr && cat?.groups.find(g => g.id === 'rules').items.find(i => i.id === 'slo:api_availability_99_9')?.subtitle === '6 recording · 2 burn-rate · 1 forecast',
           `horizon ${horizon}: compileCatalog counts the forecast without throwing`, hErr?.message || cat?.groups.find(g => g.id === 'rules').items.find(i => i.id === 'slo:api_availability_99_9')?.subtitle);
  }
}

// 15. Step 5 — the `<svc>_assurance` group: Watchdog, declared-job target-down, instrument liveness
// from the stack self-metric alias table. Default on; product-gated; opt-out by annotation.
{
  const pack = parseYaml(readFileSync(resolve(ROOT, FIXTURES[0].path), 'utf8'));
  const stripBanner = (text) => text.replace(/^(#[^\n]*\n)+/, '');
  const rulesOf = (text) => parseYaml(stripBanner(text));
  const doc = rulesOf(compilePrometheusRules(pack));
  const groupsByName = Object.fromEntries(doc.groups.map(g => [g.name, g]));
  const alerts = doc.groups.flatMap(g => g.rules).filter(r => r.alert);
  const assuranceAlerts = alerts.filter(a => a.labels?.kind === 'assurance');
  const ag = groupsByName.payment_service_assurance;
  assert(ag && ag.interval === '30s' && ag.rules.length === 7 && doc.groups[doc.groups.length - 1] === ag,
         'payment-service emits a payment_service_assurance group at 30s with seven rules, last in the file', ag && ag.rules.map(r => r.alert));
  assert(assuranceAlerts.map(a => a.alert).join() === 'Watchdog,payment_service_scrape_target_down,payment_service_ruler_silent_prometheus,payment_service_notify_silent_prometheus,payment_service_ruler_stale_prometheus,payment_service_ruler_errors_prometheus,payment_service_notify_errors_prometheus',
         'the assurance rules come in a fixed order: Watchdog, target-down, silent (ruler, notify), degraded (stale, ruler errors, notify errors)', assuranceAlerts.map(a => a.alert));
  const wd = ag.rules[0];
  assert(wd.alert === 'Watchdog' && wd.expr === 'vector(1)' && !('for' in wd) && wd.labels.severity === 'none' && wd.labels.kind === 'assurance' && wd.labels.instrument === 'watchdog' && wd.labels.pack === 'payment-service' && wd.labels.service === 'payment-service',
         'the Watchdog is vector(1), no for, severity none, kind assurance, instrument watchdog, pack/service labels', wd);
  assert(/heartbeat receiver/.test(wd.annotations.description) && /alertname="Watchdog", pack="payment-service"/.test(wd.annotations.description) && /null receiver/.test(wd.annotations.description) && wd.annotations.summary === 'payment-service assurance watchdog — always firing',
         'the Watchdog annotations state the dead-man contract and the null-receiver default');
  const td = ag.rules[1];
  assert(td.alert === 'payment_service_scrape_target_down' && td.expr === 'up{job=~"payment-api"} == 0' && td.for === '2m' && td.labels.severity === 'SEV2' && td.labels.instrument === 'scrape' && /payment-api/.test(td.annotations.description),
         'target-down selects the declared job with =~ even for one job, for 2m, SEV2', td);
  assert(ag.rules.every(r => r.labels.kind === 'assurance' && r.labels.pack === 'payment-service' && r.labels.service === 'payment-service' && !('keep_firing_for' in r) && typeof r.annotations.summary === 'string' && typeof r.annotations.description === 'string' && r.annotations.runbook === '(supply runbook URL)'),
         'every assurance rule carries kind/pack/service labels, summary/description/runbook and never keep_firing_for');
  const byName = Object.fromEntries(ag.rules.map(r => [r.alert, r]));
  assert(byName.payment_service_ruler_silent_prometheus.expr === 'absent_over_time(prometheus_rule_group_last_evaluation_timestamp_seconds[5m])' && byName.payment_service_ruler_silent_prometheus.for === '10m' && byName.payment_service_ruler_silent_prometheus.labels.severity === 'SEV2' && byName.payment_service_ruler_silent_prometheus.labels.instrument === 'ruler/prometheus',
         'ruler_silent_prometheus watches the last-evaluation timestamp (from rule_evaluation_staleness), 10m, SEV2', byName.payment_service_ruler_silent_prometheus);
  assert(byName.payment_service_notify_silent_prometheus.expr === 'absent_over_time(prometheus_notifications_sent_total[5m])' && byName.payment_service_notify_silent_prometheus.for === '10m' && byName.payment_service_notify_silent_prometheus.labels.instrument === 'notify/prometheus',
         'notify_silent_prometheus watches prometheus_notifications_sent_total (from notifications_sent)', byName.payment_service_notify_silent_prometheus);
  assert(!ag.rules.some(r => /rule_evaluation_failures_total\[5m\]\)$/.test(r.expr) && /absent_over_time/.test(r.expr)) && ag.rules.filter(r => /_silent_/.test(r.alert)).length === 2,
         'rule_evaluation_failures / notification_errors produce no second silent alert (one per family/product)');
  assert(byName.payment_service_ruler_stale_prometheus.expr === 'max(time() - prometheus_rule_group_last_evaluation_timestamp_seconds) > 120' && byName.payment_service_ruler_stale_prometheus.for === '2m' && byName.payment_service_ruler_stale_prometheus.labels.severity === 'SEV3' && /Watchdog covers/.test(byName.payment_service_ruler_stale_prometheus.annotations.description),
         'ruler_stale_prometheus: > 120 s since the last evaluation, 2m, SEV3, with the stopped-ruler caveat', byName.payment_service_ruler_stale_prometheus);
  assert(byName.payment_service_ruler_errors_prometheus.expr === 'increase(prometheus_rule_evaluation_failures_total[5m]) > 0' && byName.payment_service_notify_errors_prometheus.expr === 'increase(prometheus_notifications_errors_total[5m]) > 0' && byName.payment_service_notify_errors_prometheus.for === '2m' && byName.payment_service_notify_errors_prometheus.labels.severity === 'SEV3',
         'ruler_errors / notify_errors read increase() over 5m, 2m, SEV3');
  const allRequires = new Set(STACK_SELF_METRIC_PROBES.flatMap(r => r.aliases.flatMap(a => a.requires || [])).concat(['up']));
  const usedNames = [...new Set(assuranceAlerts.flatMap(a => metricNamesOf(a.expr)))];
  assert(usedNames.length >= 5 && usedNames.every(n => allRequires.has(n)), 'every metric name an assurance expr reads is a requires[] name of the stack self-metric table (or up)', usedNames.filter(n => !allRequires.has(n)), []);
  assert(assuranceAlerts.every(a => !/\brate\(/.test(a.expr)), 'no assurance expr uses rate() (absent_over_time / increase / time / vector only)');
  // several jobs, regex-escaped, de-duplicated
  const jobs = JSON.parse(JSON.stringify(pack));
  jobs.spec.pipelines.receivers.find(r => Array.isArray(r.scrape_configs)).scrape_configs.push({ job_name: 'api.v2+beta', scrape_interval: '15s' }, { job_name: 'payment-api', scrape_interval: '30s' });
  const jobsTd = rulesOf(compilePrometheusRules(jobs)).groups.flatMap(g => g.rules).find(r => r.alert === 'payment_service_scrape_target_down');
  assert(jobsTd.expr === 'up{job=~"payment-api|api\\\\.v2\\\\+beta"} == 0' && /payment-api, api\.v2\+beta/.test(jobsTd.annotations.description), 'target-down lists every declared job once, escaped for RE2 inside a PromQL string (two backslashes on the wire)', jobsTd.expr);
  // Fix round 0: a single backslash (`api\.v2`) was an invalid PromQL string escape — promtool rejected the
  // ENTIRE rules file ("unknown escape sequence U+002E"). The matcher must be a valid escaped string literal
  // (Go/JSON escape vocabulary) whose VALUE is the single-backslash RE2 pattern that matches the jobs literally.
  const tdMatcher = jobsTd.expr.match(/^up\{job=~"(.*)"\} == 0$/)[1];
  let tdRe2; try { tdRe2 = JSON.parse('"' + tdMatcher + '"'); } catch { tdRe2 = null; }
  assert(tdRe2 === 'payment-api|api\\.v2\\+beta', 'the job matcher unescapes (Go/JSON escapes only) to the single-backslash RE2 pattern', tdMatcher);
  assert(tdRe2 !== null && new RegExp(`^(?:${tdRe2})$`).test('api.v2+beta') && new RegExp(`^(?:${tdRe2})$`).test('payment-api') && !new RegExp(`^(?:${tdRe2})$`).test('apiXv2+beta') && !new RegExp(`^(?:${tdRe2})$`).test('api.v2beta'),
         'the RE2 pattern matches the declared job names literally and nothing else');
  const jobsGm = parseYaml(stripBanner(compileGrafanaManagedRules(jobs))).groups.flatMap(g => g.rules).find(r => r.title === 'payment_service_scrape_target_down');
  assert(jobsGm && jobsGm.data[0].model.expr === jobsTd.expr, 'the Grafana-managed flavour carries the same two-backslash expr', jobsGm?.data?.[0]?.model?.expr);
  const jobsArtifact = compileArtifact(jobs, { group: 'rules', flavor: 'prometheus', artifact: 'assurance' }).content;
  assert(jobsArtifact.split('\n').some(l => l === '        expr: up{job=~"payment-api|api\\\\.v2\\\\+beta"} == 0'), 'the emitted YAML line is a plain scalar with the two backslashes intact (mini-yaml does not re-escape it)', jobsArtifact.split('\n').filter(l => /scrape_target_down|up\{job/.test(l)));
  const noJobs = JSON.parse(JSON.stringify(pack));
  for (const r of noJobs.spec.pipelines.receivers) delete r.scrape_configs;
  assert(!rulesOf(compilePrometheusRules(noJobs)).groups.flatMap(g => g.rules).some(r => r.alert === 'payment_service_scrape_target_down'), 'no declared scrape job → no target-down rule (an instrument nobody scrapes would fire forever)');
  // product gating: prometheus rows on payment-service; vmalert_* under victoriametrics; generic-only under mimir
  const names = (text) => rulesOf(text).groups.flatMap(g => g.rules).filter(r => r.labels?.kind === 'assurance').map(r => r.alert);
  const vm = rulesOf(compile(pack, 'prometheus-rules', { product: 'victoriametrics', version: '1.99' }).content);
  const vmA = Object.fromEntries(vm.groups.flatMap(g => g.rules).filter(r => r.labels?.kind === 'assurance').map(r => [r.alert, r]));
  assert(Object.keys(vmA).join() === 'Watchdog,payment_service_scrape_target_down,payment_service_ruler_silent_victoriametrics,payment_service_notify_silent_victoriametrics,payment_service_ruler_errors_victoriametrics,payment_service_notify_errors_victoriametrics',
         'under victoriametrics the group carries the vmalert_* rows (no staleness row exists for VM) and no prometheus_* row', Object.keys(vmA));
  assert(vmA.payment_service_ruler_silent_victoriametrics.expr === 'absent_over_time(vmalert_recording_rules_errors_total[5m]) or absent_over_time(vmalert_alerting_rules_errors_total[5m])'
         && vmA.payment_service_notify_silent_victoriametrics.expr === 'absent_over_time(vmalert_alerts_send_errors_total[5m])'
         && vmA.payment_service_ruler_errors_victoriametrics.expr === 'sum(increase(vmalert_recording_rules_errors_total[5m])) + sum(increase(vmalert_alerting_rules_errors_total[5m])) > 0'
         && vmA.payment_service_notify_errors_victoriametrics.expr === 'increase(vmalert_alerts_send_errors_total[5m]) > 0',
         'the VM rows: a multi-requires alias becomes `or` of absents / a sum of increases', Object.values(vmA).map(r => r.expr));
  assert(!Object.values(vmA).some(r => /prometheus_/.test(r.expr)) && !Object.values(vmA).some(r => 'keep_firing_for' in r), 'no prometheus_* name and no keep_firing_for under VM');
  assert(names(compile(pack, 'prometheus-rules', { product: 'mimir', version: '2.15' }).content).join() === 'Watchdog,payment_service_scrape_target_down', 'under mimir only the generic rows remain (Watchdog + target-down)');
  assert(names(compile(pack, 'prometheus-rules', { product: 'prometheus', version: '2.30' }).content).join() === names(compilePrometheusRules(pack)).join(), 'the prometheus bands emit the same assurance rules (no band-dependent knob)');
  // alertmanager rows only with an alertmanager backend
  const withAm = JSON.parse(JSON.stringify(pack));
  withAm.spec.telemetry.backends.push({ signal: 'alerting', product: 'alertmanager', version: { declared: '0.27' } });
  const amA = Object.fromEntries(rulesOf(compilePrometheusRules(withAm)).groups.flatMap(g => g.rules).filter(r => r.labels?.kind === 'assurance').map(r => [r.alert, r]));
  assert(amA.payment_service_notify_silent_alertmanager?.expr === 'absent_over_time(alertmanager_notifications_total[5m])' && amA.payment_service_notify_errors_alertmanager?.expr === 'increase(alertmanager_notifications_failed_total[5m]) > 0' && !('payment_service_ruler_silent_alertmanager' in amA),
         'an alertmanager backend adds notify_silent_alertmanager / notify_errors_alertmanager (no ruler row)', Object.keys(amA));
  assert(!assuranceAlerts.some(a => /alertmanager/.test(a.alert)), 'without an alertmanager backend no alertmanager row is emitted');
  // grafana rows only with a /grafana/ scrape job; a backend alone warns
  const withGrafanaJob = JSON.parse(JSON.stringify(pack));
  withGrafanaJob.spec.pipelines.receivers.find(r => Array.isArray(r.scrape_configs)).scrape_configs.push({ job_name: 'grafana', scrape_interval: '30s' });
  const gA = Object.fromEntries(rulesOf(compilePrometheusRules(withGrafanaJob)).groups.flatMap(g => g.rules).filter(r => r.labels?.kind === 'assurance').map(r => [r.alert, r]));
  assert(gA.payment_service_ruler_silent_grafana?.expr === 'absent_over_time(grafana_alerting_rule_evaluation_failures_total[5m])' && gA.payment_service_ruler_errors_grafana?.expr === 'increase(grafana_alerting_rule_evaluation_failures_total[5m]) > 0' && gA.payment_service_scrape_target_down.expr === 'up{job=~"payment-api|grafana"} == 0',
         'a grafana scrape job adds ruler_silent_grafana / ruler_errors_grafana and joins target-down', Object.keys(gA));
  const withGrafanaBackend = JSON.parse(JSON.stringify(pack));
  withGrafanaBackend.spec.telemetry.backends.push({ signal: 'dashboards', product: 'grafana', version: { declared: '12.0' } });
  const gWarnings = [];
  const gbNames = names(compilePrometheusRules(withGrafanaBackend, { onWarning: (m) => gWarnings.push(m) }));
  assert(!gbNames.some(n => /grafana/.test(n)) && gWarnings.some(w => /assurance: grafana is declared as a backend but no scrape job names it/.test(w)),
         'a grafana backend without a scrape job emits no grafana row and warns', { names: gbNames, warnings: gWarnings });
  // opt-out: annotation off / watchdog-only, opts override, unknown value
  const off = JSON.parse(JSON.stringify(pack)); off.metadata.annotations = { ...(off.metadata.annotations || {}), [ASSURANCE_ANNOTATION]: 'off' };
  const offDoc = rulesOf(compilePrometheusRules(off));
  assert(!offDoc.groups.some(g => g.name === 'payment_service_assurance') && offDoc.groups.length === doc.groups.length - 1 && !compileCatalog(off).groups.find(g => g.id === 'rules').items.some(i => i.id === 'assurance'),
         'observogram.assurance: off removes the group and the catalog item, everything else unchanged', offDoc.groups.map(g => g.name));
  assert(JSON.stringify(offDoc.groups) === JSON.stringify(doc.groups.filter(g => g.name !== 'payment_service_assurance')), 'the other groups are byte-identical with and without the assurance group');
  const wo = JSON.parse(JSON.stringify(pack)); wo.metadata.annotations = { ...(wo.metadata.annotations || {}), [ASSURANCE_ANNOTATION]: 'watchdog-only' };
  assert(names(compilePrometheusRules(wo)).join() === 'Watchdog' && compileCatalog(wo).groups.find(g => g.id === 'rules').items.find(i => i.id === 'assurance').subtitle === '1 alert · watchdog only',
         'watchdog-only leaves exactly the Watchdog', names(compilePrometheusRules(wo)));
  assert(names(compilePrometheusRules(pack, { assurance: 'off' })).length === 0 && names(compilePrometheusRules(off, { assurance: 'on' })).length === 7, 'opts.assurance overrides the annotation both ways');
  const bogus = JSON.parse(JSON.stringify(pack)); bogus.metadata.annotations = { ...(bogus.metadata.annotations || {}), [ASSURANCE_ANNOTATION]: 'sometimes' };
  const bWarnings = [];
  assert(names(compilePrometheusRules(bogus, { onWarning: (m) => bWarnings.push(m) })).length === 7 && bWarnings.some(w => /observogram\.assurance: unknown mode "sometimes"/.test(w)) && ASSURANCE_MODES.join() === 'on,watchdog-only,off',
         'an unknown mode warns and reads as on', bWarnings);
  // per-SLO files carry no assurance group (:586 stays: per-SLO group names are disjoint from the full file's)
  assert(!rulesOf(compileSloPrometheusRules(pack, 'api_availability_99_9')).groups.some(g => /_assurance$/.test(g.name)), 'a per-SLO Prometheus file carries no assurance group');
  // Grafana-managed: same exprs, uids unique across two packs in one folder, Watchdog for: 0s
  const gm = rulesOf(compileGrafanaManagedRules(pack));
  const gmA = gm.groups.find(g => g.name === 'payment_service_assurance');
  assert(gmA && gmA.interval === '30s' && gmA.rules.length === 7 && gmA.rules[0].uid === 'alr-payment_service_watchdog' && gmA.rules[0].for === '0s' && gmA.rules[0].title === 'Watchdog' && gmA.rules[0].data[0].model.expr === 'vector(1)',
         'Grafana-managed carries the assurance group with the Watchdog at uid alr-payment_service_watchdog and for: 0s', gmA && gmA.rules.map(r => [r.uid, r.for]));
  assert(gmA.rules.slice(1).map(r => r.for).join() === '2m,10m,10m,2m,2m,2m' && gmA.rules.every((r, i) => r.data[0].model.expr === ag.rules[i].expr && r.title === ag.rules[i].alert), 'the other rules keep their Prometheus for: and exprs');
  assert(!rulesOf(compileSloPrometheusRules(pack, 'api_availability_99_9')).groups.some(g => /_assurance$/.test(g.name)), 'per-SLO Grafana-managed files carry no assurance group either');
  const sharedSli = parseYaml(readFileSync(resolve(ROOT, 'tools/fixtures/compile/shared-sli.pack.yaml'), 'utf8'));
  const gmShared = rulesOf(compileGrafanaManagedRules(sharedSli)).groups.find(g => /_assurance$/.test(g.name));
  const uidsA = new Set(gmA.rules.map(r => r.uid)), uidsB = gmShared.rules.map(r => r.uid);
  assert(uidsB.length > 0 && uidsB.every(u => !uidsA.has(u)) && new Set(uidsB).size === uidsB.length && gmShared.rules[0].uid === 'alr-shared_sli_watchdog',
         'two packs compiled into the same folder get disjoint assurance uids (the Watchdog uid is keyed by svc)', { a: [...uidsA], b: uidsB });
  // catalog + artifacts
  const cat = compileCatalog(pack).groups.find(g => g.id === 'rules').items;
  assert(cat[0].id === 'all' && cat[0].subtitle === '5 SLO(s) · 4 declared' && cat[1].id === 'assurance' && cat[1].kind === 'rules-assurance' && cat[1].label === 'Assurance · watchdog + instrument liveness' && cat[1].subtitle === '7 alerts · generic, prometheus' && cat[2].kind === 'rules-slo',
         'the catalog lists the assurance item after all and before the per-SLO items; the all subtitle is unchanged', cat.slice(0, 3));
  const artProm = compileArtifact(pack, { group: 'rules', flavor: 'prometheus', artifact: 'assurance' });
  const artGm = compileArtifact(pack, { group: 'rules', flavor: 'grafana-managed', artifact: 'assurance' });
  assert(artProm.filename === 'payment_service.assurance.rules.yaml' && rulesOf(artProm.content).groups.length === 1 && rulesOf(artProm.content).groups[0].name === 'payment_service_assurance' && JSON.stringify(rulesOf(artProm.content).groups[0]) === JSON.stringify(ag),
         'compileArtifact(assurance, prometheus) is a one-group file identical to the full file\'s group', artProm.filename);
  assert(artGm.filename === 'payment_service.assurance.grafana-rules.yaml' && rulesOf(artGm.content).apiVersion === 1 && JSON.stringify(rulesOf(artGm.content).groups[0]) === JSON.stringify(gmA),
         'compileArtifact(assurance, grafana-managed) is a one-group provisioning file identical to the full file\'s group', artGm.filename);
  assert(rulesOf(compileArtifact(off, { group: 'rules', flavor: 'prometheus', artifact: 'assurance' }).content).groups.length === 0, 'the assurance artifact of an opted-out pack has no group (never a fabricated rule)');
  // lab timings
  const lab = rulesOf(compilePrometheusRules(pack, { lab: true })).groups.find(g => g.name === 'payment_service_assurance').rules;
  assert(lab.slice(1).map(r => r.for).join() === '30s,2m,2m,30s,30s,30s', 'lab: for 30s (fast) / 2m (silent)', lab.map(r => r.for));
}

// The reference packs through the compiler: Grafana provisioning rejects a file whose uids or
// titles repeat, and kafka declares unlabelled `kafka:broker_availability:ratio_5m` /
// `error_ratio_5m` next to the generated labelled ones (the uid class that used to collide).
process.stdout.write('\n[reference packs] Grafana-managed uids and same-name declared records\n');
{
  const parseRules = (text) => parseYaml(text.replace(/^#[^\n]*\n/gm, ''));
  for (const id of ['grafana', 'kafka', 'prometheus']) {
    const pack = parseYaml(readFileSync(resolve(ROOT, `reference-packs/${id}.pack.yaml`), 'utf8'));
    const gm = parseRules(compileArtifact(pack, { group: 'rules', flavor: 'grafana-managed', artifact: 'all' }).content).groups.flatMap(g => g.rules);
    const uids = gm.map(r => r.uid), titles = gm.map(r => r.title);
    assert(new Set(uids).size === uids.length, `${id}: Grafana-managed uids are unique (${uids.length} rules)`, uids.filter((u, i) => uids.indexOf(u) !== i), []);
    assert(new Set(titles).size === titles.length, `${id}: Grafana-managed titles are unique`, titles.filter((t, i) => titles.indexOf(t) !== i), []);
    assert(uids.every(u => u.length <= 40), `${id}: every uid fits Grafana's 40 characters`, uids.filter(u => u.length > 40), []);
  }
  const kafka = parseYaml(readFileSync(resolve(ROOT, 'reference-packs/kafka.pack.yaml'), 'utf8'));
  const kafkaOut = compile(kafka, 'prometheus-rules');
  const kafkaRecords = parseRules(kafkaOut.content).groups.flatMap(g => g.rules).filter(r => r.record);
  assert(!kafkaRecords.some(r => r.record === 'kafka:errorbudget:burn_6h') && kafkaRecords.filter(r => r.record === 'kafka:errorbudget:burn_1h').every(r => r.labels?.slo),
         'kafka no longer declares an unlabelled errorbudget:burn_* next to the generated per-SLO ones');
  const SAME_NAME = /^declared (\S+?)\{\} and generated \1\{[^}]+\} write the same metric name; series may collide at runtime$/;
  const sameName = kafkaOut.warnings.filter(w => SAME_NAME.test(w)).map(w => SAME_NAME.exec(w)[1]).sort();
  // (partition_health's declarations do not collide: the SLI id is partition_replica_health)
  assert(JSON.stringify(sameName) === JSON.stringify(['kafka:broker_availability:ratio_5m']),
         'kafka\'s pre-existing unlabelled broker_availability:ratio_5m declaration is warned about as a same-name collision with the per-SLO record', sameName);
  // the SLI-level error_ratio_5m the pack declares is the SLI's definition: the generated one is dropped
  const KEPT = /^recording rule kafka:broker_availability:error_ratio_5m\{\} is declared by the pack and generated by the policy as kafka:broker_availability:error_ratio_5m\{sli="broker_availability",service="kafka"\}; keeping the pack's$/;
  assert(kafkaOut.warnings.filter(w => KEPT.test(w)).length === 1 && kafkaRecords.filter(r => r.record === 'kafka:broker_availability:error_ratio_5m').length === 1,
         'kafka\'s declared broker_availability:error_ratio_5m is kept alone, the generated SLI-level one dropped with a warning', kafkaOut.warnings.filter(w => /error_ratio_5m/.test(w)));
  // a pack of the generator's lineage declares `<svc>:<sli>:error_ratio_5m{slo,sli,service}` for its
  // threshold SLI (its own denominator): exactly one error_ratio_5m for that SLI, no same-name warning
  const declaredRatio = {
    metadata: { name: 'svc', version: '0.0.1' },
    spec: {
      slis: [{ id: 'lag', type: 'threshold', query: 'max(lag)', threshold: 60, unit: 'seconds' }],
      slos: [{ id: 'lag_99', sli: 'lag', objective: 0.99, window: '30d' }],
      queries: { recording_rules: [{ name: 'svc:lag:error_ratio_5m', expr: '(sum_over_time((max(svc:lag:value_5m) > bool 60)[5m:10s]) / 30)', interval: '30s', labels: { slo: 'lag_99', sli: 'lag', service: 'svc' } }] },
      policy: { burn_rate_alerts: [{ slo: 'lag_99', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] }] },
    },
  };
  const declaredRatioOut = compile(declaredRatio, 'prometheus-rules');
  const declaredRatioRecs = parseRules(declaredRatioOut.content).groups.flatMap(g => g.rules).filter(r => r.record === 'svc:lag:error_ratio_5m');
  assert(declaredRatioRecs.length === 1 && declaredRatioRecs[0].labels?.slo === 'lag_99' && declaredRatioRecs[0].expr.includes('[5m:10s]) / 30'),
         'a declared <sli>:error_ratio_5m with its own labels is the one record for that SLI', declaredRatioRecs.map(r => [r.labels, r.expr]));
  assert(declaredRatioOut.warnings.filter(w => /same metric name/.test(w)).length === 0 && declaredRatioOut.warnings.length === 1 && /keeping the pack's$/.test(declaredRatioOut.warnings[0]),
         'no same-name warning for it, one keeping-the-pack\'s warning', declaredRatioOut.warnings);
  const declaredRatioGm = parseRules(compileArtifact(declaredRatio, { group: 'rules', flavor: 'grafana-managed', artifact: 'all' }).content).groups.flatMap(g => g.rules);
  assert(declaredRatioGm.filter(r => r.record?.metric === 'svc:lag:error_ratio_5m').length === 1, 'the Grafana-managed flavour drops the generated one too');
  // and the per-SLO artefacts go through the same de-duplication: a per-SLO deploy must never
  // overwrite the pack's own definition (Prometheus: one (record, labels) with two exprs across the
  // files; Grafana: the generated record's bare-name uid IS the pack's rule's uid)
  const declaredUid = declaredRatioGm.find(r => r.record?.metric === 'svc:lag:error_ratio_5m').uid;
  const perSloDeclaredProm = parseRules(compileArtifact(declaredRatio, { group: 'rules', flavor: 'prometheus', artifact: 'slo:lag_99' }).content);
  const perSloDeclaredRecs = perSloDeclaredProm.groups.flatMap(g => g.rules).filter(r => r.record);
  assert(!perSloDeclaredRecs.some(r => r.record === 'svc:lag:error_ratio_5m') && !perSloDeclaredProm.groups.some(g => /_sli_recording$/.test(g.name)) && perSloDeclaredRecs.map(r => r.record).join() === 'svc:lag:value_5m,svc:errorbudget:burn_5m,svc:errorbudget:burn_1h',
         'per-SLO Prometheus file: a declared <sli>:error_ratio_5m removes the generated one (and its group)', perSloDeclaredProm.groups.map(g => `${g.name}: ${g.rules.map(r => r.record || r.alert).join(',')}`));
  const perSloDeclaredGm = parseRules(compileArtifact(declaredRatio, { group: 'rules', flavor: 'grafana-managed', artifact: 'slo:lag_99' }).content).groups.flatMap(g => g.rules);
  assert(!perSloDeclaredGm.some(r => r.record?.metric === 'svc:lag:error_ratio_5m') && !perSloDeclaredGm.some(r => r.uid === declaredUid) && perSloDeclaredGm.filter(r => r.record).length === 3,
         'per-SLO Grafana-managed file: no generated error_ratio_5m and no uid equal to the pack\'s rule', perSloDeclaredGm.map(r => `${r.uid} ${r.title}`));
  const declaredCatalog = compileCatalog(declaredRatio).groups.find(g => g.id === 'rules').items.find(i => i.id === 'slo:lag_99')?.subtitle;
  assert(declaredCatalog === '3 recording · 1 burn-rate · 0 forecast', 'the catalog counts the de-duplicated per-SLO records', declaredCatalog, '3 recording · 1 burn-rate · 0 forecast');
  // a partially pasted --pack-snippet (one burn_5m{slo=A}) does not warn against the other SLOs' burn_5m
  const partial = JSON.parse(JSON.stringify(parseYaml(readFileSync(resolve(ROOT, 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml'), 'utf8'))));
  const one = compileBurnRules(partial).recording.find(r => r.record.endsWith(':errorbudget:burn_5m') && r.labels.slo === 'api_availability_99_9');
  partial.spec.queries.recording_rules.push({ name: one.record, expr: one.expr, interval: '30s', labels: one.labels });
  const partialOut = compile(partial, 'prometheus-rules');
  assert(partialOut.warnings.length === 1 && /is declared by the pack and generated by the policy; keeping the pack's$/.test(partialOut.warnings[0]),
         'one pasted burn_5m{slo=A} warns once, never against burn_5m{slo=B..E}', partialOut.warnings);
  // the finding's shape: a pack declares <svc>:errorbudget:burn_1h unlabelled, reading <svc>:<sli>:error_ratio_5m
  const declaredBurn = {
    metadata: { name: 'svc', version: '0.0.1' },
    spec: {
      slis: [{ id: 'avail', type: 'ratio', good: 'sum(rate(ok_total[5m]))', total: 'sum(rate(all_total[5m]))' }],
      slos: [{ id: 'avail_99_9', sli: 'avail', objective: 0.999, window: '30d' }],
      queries: { recording_rules: [{ name: 'svc:errorbudget:burn_1h', expr: 'svc:avail:error_ratio_5m / (1 - 0.999)', interval: '1m' }] },
    },
  };
  const declaredOut = compile(declaredBurn, 'prometheus-rules');
  assert(declaredOut.warnings.length === 1 && declaredOut.warnings[0] === 'declared svc:errorbudget:burn_1h{} and generated svc:errorbudget:burn_1h{slo="avail_99_9",sli="avail",service="svc"} write the same metric name; series may collide at runtime',
         'an unlabelled declared errorbudget:burn_1h is warned about, once, naming both rules', declaredOut.warnings);
  const declaredRecords = parseRules(declaredOut.content).groups.flatMap(g => g.rules).filter(r => r.record === 'svc:errorbudget:burn_1h');
  assert(declaredRecords.length === 2 && declaredRecords[0].labels?.slo === 'avail_99_9' && !declaredRecords[1].labels,
         'both rules are kept (generated first, the pack\'s own last)', declaredRecords.map(r => r.labels));
}

report('compile');
