#!/usr/bin/env node
/**
 * tools/test-adapt.mjs
 *
 * Adapter regression test. Loads the vendored canonical example, runs the
 * adapter for each declared environment, and asserts layer counts, key
 * artefacts, source-tag derivation, environment overlay, and cross-reference
 * resolution.
 *
 * Exit 0 = all assertions pass. Exit 1 = at least one assertion failed.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt, listEnvironments, applyEnvironmentOverlay } from './lib/adapter.mjs';
import { brandEnvFrom } from './lib/brand-env.mjs';
import { diffPacks } from './lib/diff.mjs';
import { deltasOf, unobservedOf, partialAnnotation, parsePartialAnnotation, PARTIAL_ANNOTATION_PREFIX } from './lib/artefact-model.mjs';
import { SPEC_DIR } from './lib/validator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '..', SPEC_DIR, 'examples', 'payment-service.pack.yaml');

import { createHarness } from './lib/harness.mjs';
const { assert, report } = createHarness();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const text = readFileSync(FIXTURE, 'utf8');
const canonical = parseYaml(text);
const envs = listEnvironments(canonical);

assert(envs.length === 2, 'lists both environments', envs.length, 2);
assert(envs[0] === 'prod', 'prod is first env (default)', envs[0], 'prod');

// ---------- default-environment adapter pass ----------

const prod = adapt(canonical);

assert(prod.meta.apiVersion === 'observability.platform/v1', 'meta.apiVersion');
assert(prod.meta.kind === 'ObservabilityPack',               'meta.kind');
assert(prod.meta.binding === 'otel-elastic-prometheus-grafana', 'meta.binding');
assert(prod.meta.version === '1.5.0',                        'meta.version');
assert(prod.meta.environment === 'prod',                     'default env = prod');
assert(prod.meta.target === 'ske',                           'prod target');
assert(prod.meta.criticality === 'tier-1',                   'prod criticality');
assert(prod.badge === 'TIER-1',                              'badge derived from criticality');

// Layer counts (each section of the canonical example contributes a known number)
assert(prod.layers.L1.length === 12,           'L1 = 6 SLIs + 6 SLOs (the 1.3 example adds the settlement-consumers floor)', prod.layers.L1.length, 12);
assert(prod.layers.L2.length === 24,           'L2 = 1 otel + 9 backends + 8 pipelines + 3 exporters + 3 storage', prod.layers.L2.length, 24);
assert(prod.layers.L2X.length === 7,           'L2X = profiling + network + policy_engine + 2 mesh + 2 collection', prod.layers.L2X.length, 7);
assert(prod.layers.L3.length === 16,           'L3 = 5 recording + 2 derived + 4 dashboards + 5 panels (expand)', prod.layers.L3.length, 16);
assert(prod.layers.L4.policy.length === 7,    'L4.policy = 5 burn-rate + 2 forecasts', prod.layers.L4.policy.length, 7);
assert(prod.layers.L4.alerting.length === 6,  'L4.alerting = SEV1/SEV2/SEV3 routes + 3 operational alert rules (the 1.4 example)', prod.layers.L4.alerting.length, 6);
assert(prod.layers.L4.healing.length === 3,   'L4.healing = 3 remediations', prod.layers.L4.healing.length, 3);
assert(prod.layers.L5.length === 6,           'L5 = 1 baseline + 3 chaos + 2 synthetic', prod.layers.L5.length, 6);
assert(prod.layers.GOV.length === 3,          'GOV = 3 imports', prod.layers.GOV.length, 3);

// SLI/SLO shape
const sli = prod.layers.L1.find(a => a.title === 'api_availability');
assert(sli && sli.defines === 'slis.api_availability', 'SLI defines slis.<id>', sli && sli.defines, 'slis.api_availability');
assert(sli && sli.id === 'SLI-01',                     'SLI id pattern',         sli && sli.id, 'SLI-01');
assert(sli && sli.source === 'Declared',               'SLI source = Declared',  sli && sli.source, 'Declared');
// The bound with its direction as the card's subtitle (spec 1.3 good_when through good-when.mjs boundText):
// a ratio SLI has none; a threshold SLI without good_when is a ceiling (≤); a floor prints ≥.
assert(!('subtitle' in sli), 'a ratio SLI has no bound, no subtitle');
const latency = prod.layers.L1.find(a => a.title === 'api_latency_p99');
assert(latency?.subtitle === '≤ 0.5 seconds', 'a threshold SLI\'s subtitle is its bound with ≤ (absent good_when means below)', latency?.subtitle, '≤ 0.5 seconds');
{
  const floorPack = clone(canonical);
  const lat = floorPack.spec.slis.find(s => s.id === 'api_latency_p99');
  Object.assign(lat, { good_when: 'above', threshold: 2, unit: 'consumers' });
  const floor = adapt(floorPack).layers.L1.find(a => a.title === 'api_latency_p99');
  assert(floor?.subtitle === '≥ 2 consumers', 'a floor (good_when: above) prints ≥', floor?.subtitle, '≥ 2 consumers');
  delete lat.unit;
  assert(adapt(floorPack).layers.L1.find(a => a.title === 'api_latency_p99')?.subtitle === '≥ 2', 'no unit: the bare bound', adapt(floorPack).layers.L1.find(a => a.title === 'api_latency_p99')?.subtitle, '≥ 2');
  const noBound = clone(canonical);
  delete noBound.spec.slis.find(s => s.id === 'api_latency_p99').threshold;
  assert(!('subtitle' in adapt(noBound).layers.L1.find(a => a.title === 'api_latency_p99')), 'no bound, no subtitle');
}

const slo = prod.layers.L1.find(a => a.title === 'api_availability_99_9');
assert(slo && slo.defines === 'slos.api_availability_99_9',
       'SLO defines slos.<id>', slo && slo.defines, 'slos.api_availability_99_9');
assert(slo && slo.refs?.[0] === 'slis.api_availability',
       'SLO refs the SLI', slo && slo.refs?.[0], 'slis.api_availability');

// Backend shape — gating tags + defines
const bak = prod.layers.L2.find(a => a.title === 'metrics-prom');
assert(bak?.defines === 'telemetry.backends.metrics-prom', 'backend defines',  bak?.defines, 'telemetry.backends.metrics-prom');
assert(bak?.tags.includes('metrics'),                      'backend signal tag');
assert(bak?.tags.includes('gating-warn'),                  'backend gating tag from VersionSpec');
assert(bak?.tags.includes('default'),                      'default backend tag');

// L2X — extended surfaces present
const prof = prod.layers.L2X.find(a => a.id === 'PROF-01');
assert(prof?.refs?.[0] === 'telemetry.backends.profiles-pyroscope', 'profiling refs its backend');
const meshKong = prod.layers.L2X.find(a => a.title === 'gateway: kong');
assert(!!meshKong, 'kong mesh artefact present');

// Dashboard cross-refs
const dash = prod.layers.L3.find(a => a.title === 'payment-overview');
assert(dash?.refs?.includes('slis.api_availability'),    'dashboard panel binding ref to SLI');
assert(dash?.refs?.includes('slos.api_availability_99_9'),'dashboard panel binding ref to SLO');

// Chaos cross-refs
const chaos = prod.layers.L5.find(a => a.title === 'api-pod-kill');
assert(chaos?.refs?.includes('ref:slos.api_availability_99_9'), 'chaos steady-state-hypothesis ref kept verbatim');
assert(chaos?.refs?.includes('alert:payment-api-pod-down'),     'chaos expected_alerts ref normalized');

// Remediation refs (trigger preserved)
const heal = prod.layers.L4.healing.find(a => a.title === 'alert:payment-api-pod-oom');
assert(!!heal, 'remediation HEAL artefact present');

// ---------- staging-environment adapter pass: overlay verification ----------

const stg = adapt(canonical, { environment: 'staging' });
assert(stg.meta.environment === 'staging',   'env=staging selected');
assert(stg.meta.target === 'bare-k8s',       'staging target overridden');
assert(stg.meta.criticality === 'tier-2',    'staging criticality overridden');

const stgOtel = stg.layers.L2.find(a => a.id === 'OTEL-01').spec;
const prodOtel = prod.layers.L2.find(a => a.id === 'OTEL-01').spec;
assert(prodOtel.sdk.sampling.ratio === 0.1,  'prod sampling.ratio 0.1');
assert(stgOtel.sdk.sampling.ratio === 1,     'staging sampling.ratio overridden to 1.0');

// Override should NOT bleed across env passes (adapter does deep-clone per call)
const prod2 = adapt(canonical);
assert(prod2.layers.L2.find(a => a.id === 'OTEL-01').spec.sdk.sampling.ratio === 0.1,
       'prod sampling unchanged after a staging call (no shared mutable spec)');

// ---------- requirement traceability pass ----------

const traceFixture = {
  apiVersion: 'observability.platform/v1',
  kind: 'ObservabilityPack',
  metadata: {
    name: 'trace-fixture',
    version: '0.1.0',
    binding: 'otel-prometheus-grafana',
    annotations: {
      'crawler.discovered.metric_names': '["checkout_latency_seconds_bucket","checkout_latency_seconds_count"]',
      'crawler.discovered.metric_names_count': '2',
      'crawler.discovered.metric_origins': '{"checkout_latency_seconds_bucket":{"file":"src/metrics.ts","service":"checkout-api","type":"histogram","help":"checkout latency","labels":["route"]},"checkout_latency_seconds_count":{"file":"src/metrics.ts","service":"checkout-api","type":"histogram","help":"checkout latency","labels":["route"]}}',
      'crawler.discovered.scrape_jobs': '["checkout-api"]',
      'crawler.discovered.scrape_jobs_count': '1',
      'crawler.discovered.scrape_job_origins': '{"checkout-api":{"file":"prometheus/scrape.yml","metrics_path":"/metrics","interval":"10s","targets":["checkout-api:8080"]}}',
      'mcp.discovered.scrape_jobs': 'checkout-api,node-exporter',
      'mcp.discovered.metric_names': '2712',
      'mcp.discovered.metric_names_count': '2712',
      'mcp.discovered.metric_names_sample': 'checkout_latency_seconds_bucket,checkout_latency_seconds_count,process_cpu_seconds_total',
      'mcp.discovered.alert_rule_names': 'CheckoutLatencyBudgetBurn,NodeDown',
      'mcp.refreshedAt': '2026-06-09T00:00:00.000Z',
    },
  },
  spec: {
    slis: [{
      id: 'slo_checkout_latency',
      type: 'ratio',
      good: 'sum(rate(checkout_latency_seconds_bucket{le="2"}[5m]))',
      total: 'sum(rate(checkout_latency_seconds_count[5m]))',
    }],
    slos: [{
      id: 'slo_checkout_latency_99',
      sli: 'slo_checkout_latency',
      objective: 0.99,
      window: '30d',
    }],
    pipelines: {
      exporters: {
        metrics: { kind: 'prometheusremotewrite' },
      },
    },
    queries: {
      recording_rules: [{
        name: 'slo:checkout_latency:ratio_below_2s_5m',
        expr: 'sum(rate(checkout_latency_seconds_bucket{le="2"}[5m])) / sum(rate(checkout_latency_seconds_count[5m]))',
      }],
    },
    dashboards: [{
      id: 'checkout-slo',
      provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 },
      params: {
        panels: [{
          title: 'Checkout latency SLO',
          targets: [{ expr: 'slo:checkout_latency:ratio_below_2s_5m' }],
        }],
      },
      panel_bindings: [{
        panel: 'Checkout latency SLO',
        binds_to: 'slis.slo_checkout_latency',
      }],
    }],
    policy: {
      burn_rate_alerts: [{
        slo: 'slo_checkout_latency_99',
        windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }],
      }],
    },
  },
};

const traced = adapt(traceFixture);
const sourceMetric = traced.layers.L2.find(a => a.id.startsWith('METRIC-SRC-') && a.spec.name === 'checkout_latency_seconds_bucket');
const sourceScrape = traced.layers.L2.find(a => a.id.startsWith('SCRAPE-SRC-') && a.spec.job === 'checkout-api');
const scrape = traced.layers.L2.find(a => a.id === 'SCRAPE-01');
const metricInventory = traced.layers.L2.filter(a => (a.id || '').startsWith('METRIC-') && !(a.id || '').startsWith('METRIC-SRC-'));
assert(sourceMetric?.spec?.origin_file === 'src/metrics.ts',
       'L2 projects source metric origin from crawler annotations',
       sourceMetric?.spec?.origin_file, 'src/metrics.ts');
assert(sourceScrape?.spec?.origin_file === 'prometheus/scrape.yml',
       'L2 projects source scrape origin from crawler annotations',
       sourceScrape?.spec?.origin_file, 'prometheus/scrape.yml');
assert(sourceScrape?.spec?.exports?.includes('checkout_latency_seconds_bucket'),
       'source telemetry source lists exported metric series',
       sourceScrape?.spec?.exports, ['checkout_latency_seconds_bucket']);
assert(scrape?.spec?.job === 'checkout-api', 'L2 projects live scrape jobs from annotations', scrape?.spec?.job, 'checkout-api');
assert(metricInventory.length === 3,
       'legacy count-shaped metric_names falls back to metric_names_sample',
       metricInventory.length, 3);
assert(metricInventory[0]?._meta?.totalCount === 2712,
       'metric inventory preserves discovered total count',
       metricInventory[0]?._meta?.totalCount, 2712);
assert(traced.traceability?.summary?.requirements === 1, 'traceability summary counts one requirement',
       traced.traceability?.summary?.requirements, 1);
const chain = traced.traceability?.chains?.[0];
assert(chain?.slo?.id === 'slo_checkout_latency_99', 'traceability chain binds SLO',
       chain?.slo?.id, 'slo_checkout_latency_99');
assert(chain?.sli?.id === 'slo_checkout_latency', 'traceability chain binds SLI',
       chain?.sli?.id, 'slo_checkout_latency');
assert(chain?.metrics?.some(m => m.name === 'checkout_latency_seconds_bucket' && m.verified),
       'traceability extracts and verifies SLI metric');
assert(chain?.metrics?.some(m => m.name === 'checkout_latency_seconds_bucket' && m.declared && m.origin?.file === 'src/metrics.ts'),
       'traceability preserves declared metric origin separately from live verification');
assert(chain?.recordingRules?.some(r => r.name === 'slo:checkout_latency:ratio_below_2s_5m'),
       'traceability links recording rule');
assert(chain?.exporters?.some(e => e.id === 'PIP-EXP-MET'),
       'traceability links metrics exporter');
assert(chain?.scrapeJobs?.items?.some(j => j.name === 'checkout-api'),
       'traceability links matching scrape job');
assert(chain?.dashboards?.some(d => d.id === 'checkout-slo' && d.panels?.some(p => p.title === 'Checkout latency SLO')),
       'traceability links dashboard panel by binding/query');
assert(chain?.alerts?.some(a => a.name === 'CheckoutLatencyBudgetBurn'),
       'traceability links live alert rule by requirement tokens');
assert(chain?.gaps?.length === 0, 'traceability chain is complete', chain?.gaps, []);

// Alert evidence honesty in the requirement chain: a live alerting rule the
// ruler reports unhealthy is listed but is NOT evidence, and the fetcher's
// scaffold burn-rate placeholder is not an alert at all.
{
  const unhealthyFixture = clone(traceFixture);
  unhealthyFixture.metadata.annotations['mcp.discovered.alert_rules_unhealthy'] = 'CheckoutLatencyBudgetBurn';
  const c = adapt(unhealthyFixture).traceability.chains[0];
  const live = c.alerts.find(a => a.name === 'CheckoutLatencyBudgetBurn');
  assert(live?.verified === false && live?.health === 'err',
         'an unhealthy live alert rule is listed with verified:false and health:err', live);
  assert(c.alerts.some(a => a.type === 'burn_rate' && a.artefactId === 'POL-01'),
         'the declared burn-rate entry resolves to its POL artefact', c.alerts);
  assert(!c.gaps.includes('missing_alert_evidence'),
         'a declared (non-scaffold) burn-rate alert still counts as alert evidence', c.gaps);

  const scaffoldFixture = clone(traceFixture);
  scaffoldFixture.metadata.annotations['mcp.scaffold.policy.burn_rate_alerts[0]'] = 'schema-required fallback; no burn-rate alerting rule discovered via MCP';
  scaffoldFixture.metadata.annotations['mcp.discovered.alert_rule_names'] = 'NodeDown';
  const s = adapt(scaffoldFixture);
  const sc = s.traceability.chains[0];
  assert(s.layers.L4.policy[0].source === 'Scaffold', 'fixture: the burn-rate entry projects as Scaffold');
  assert(!sc.alerts.some(a => a.type === 'burn_rate'),
         'a scaffold burn-rate placeholder is not listed as alert evidence', sc.alerts);
  assert(sc.gaps.includes('missing_alert_evidence') && s.traceability.summary.withAlerts === 0,
         'the placeholder does not suppress missing_alert_evidence, and the summary counts no alerts',
         { gaps: sc.gaps, withAlerts: s.traceability.summary.withAlerts });

  const onlyUnhealthy = clone(scaffoldFixture);
  onlyUnhealthy.metadata.annotations['mcp.discovered.alert_rule_names'] = 'CheckoutLatencyBudgetBurn';
  onlyUnhealthy.metadata.annotations['mcp.discovered.alert_rules_unhealthy'] = 'CheckoutLatencyBudgetBurn';
  const u = adapt(onlyUnhealthy);
  const uc = u.traceability.chains[0];
  assert(uc.alerts.length === 1 && uc.alerts[0].verified === false
         && uc.gaps.includes('missing_alert_evidence') && u.traceability.summary.withAlerts === 0,
         'an unhealthy live rule alone leaves the alert gap open and withAlerts at 0',
         { alerts: uc.alerts, gaps: uc.gaps, withAlerts: u.traceability.summary.withAlerts });
}

const fullMetricFixture = clone(traceFixture);
fullMetricFixture.metadata.annotations['mcp.discovered.metric_names'] =
  '["checkout_latency_seconds_bucket","checkout_latency_seconds_count","process_cpu_seconds_total"]';
fullMetricFixture.metadata.annotations['mcp.discovered.metric_names_count'] = '3';
fullMetricFixture.metadata.annotations['mcp.discovered.metric_names_sample'] = '';
const fullMetricTraced = adapt(fullMetricFixture);
assert(fullMetricTraced.layers.L2.filter(a => (a.id || '').startsWith('METRIC-') && !(a.id || '').startsWith('METRIC-SRC-')).length === 3,
       'metric_names JSON array projects full metric inventory');
assert(fullMetricTraced.traceability?.chains?.[0]?.metrics?.some(m => m.name === 'checkout_latency_seconds_bucket' && m.verified),
       'traceability verifies metrics from full metric_names annotation');

const declaredOnlyMetricFixture = clone(traceFixture);
delete declaredOnlyMetricFixture.metadata.annotations['mcp.discovered.metric_names'];
delete declaredOnlyMetricFixture.metadata.annotations['mcp.discovered.metric_names_count'];
delete declaredOnlyMetricFixture.metadata.annotations['mcp.discovered.metric_names_sample'];
const declaredOnlyMetricTraced = adapt(declaredOnlyMetricFixture);
const declaredOnlyMetric = declaredOnlyMetricTraced.traceability?.chains?.[0]?.metrics?.find(m => m.name === 'checkout_latency_seconds_bucket');
assert(declaredOnlyMetric?.declared === true && declaredOnlyMetric?.verified === false,
       'crawler-declared metric does not count as live-verified without MCP inventory',
       { declared: declaredOnlyMetric?.declared, verified: declaredOnlyMetric?.verified },
       { declared: true, verified: false });

// ---------- rebrand shim: legacy annotation namespace ----------
// Packs crawled before the Observogram rename carry tomograph.* annotation
// keys; the adapter must keep honoring them (new key wins when both exist).
const legacyScopeFixture = clone(canonical);
legacyScopeFixture.metadata.annotations = {
  ...(legacyScopeFixture.metadata.annotations || {}),
  'tomograph.diff.scopeMode': 'family',
};
assert(adapt(legacyScopeFixture).meta.diffScopeMode === 'family',
       'legacy tomograph.diff.scopeMode annotation still resolves', adapt(legacyScopeFixture).meta.diffScopeMode, 'family');
legacyScopeFixture.metadata.annotations['observogram.diff.scopeMode'] = 'service';
assert(adapt(legacyScopeFixture).meta.diffScopeMode === 'service',
       'observogram.diff.scopeMode wins over the legacy key when both exist', adapt(legacyScopeFixture).meta.diffScopeMode, 'service');

// ---------- summary ----------

// ---------- operational alert rules (spec 1.4 alerting.rules) ----------
// One L4 alerting artefact per rule, titled by the rule's exact name, beside
// the routes; the artefact model keys an alert_rule on that name, so the
// rule a repository declares and the same rule a live listing reports pair.
{
  const rules = prod.layers.L4.alerting.filter(a => a.id.startsWith('RULE-'));
  assert(rules.map(a => a.id).join() === 'RULE-01,RULE-02,RULE-03', 'RULE-NN ids follow alerting.rules order', rules.map(a => a.id));
  assert(rules.map(a => a.title).join() === 'PaymentServicePodRestarting,PaymentDbConnectionPoolSaturated,PaymentCertificateExpiringSoon',
    'each alert rule artefact is titled by the rule\'s exact name', rules.map(a => a.title));
  assert(rules.map(a => a.tool).join() === 'PrometheusRule,PrometheusRule,Grafana alerting',
    'tool follows the engine: PrometheusRule for the PromQL rulers (absent engine means prometheus), Grafana alerting for a Grafana-managed rule', rules.map(a => a.tool));
  assert(rules.every(a => a.source === 'Declared') && rules[0].tags.includes('alert-rule') && rules[0].tags.includes('SEV3'),
    'alert rules project as Declared and carry the alert-rule tag and their severity', rules.map(a => [a.source, a.tags]));
  assert(rules[0].desc === 'prometheus alert rule · for 10m · SEV3 · labels.severity warning',
    'desc states engine, wait, the pack\'s severity and the engine\'s own label when they differ', rules[0].desc);
  assert(prod.layers.L4.alerting.filter(a => a.id.startsWith('ALR-')).length === 3, 'the three routes are still there beside the rules');

  // Pairing: a "live" pack that holds the same rules under other spellings
  // of everything but the name — a ruler's trailing newline in the
  // expression, no engine, no source, no annotations — pairs rule for rule
  // and reads aligned; a rule whose expression changed reads drifted; a
  // rule only one side holds reads only there.
  const live = clone(canonical);
  live.spec.alerting.rules = canonical.spec.alerting.rules.map(({ name, expr, severity, labels }, i) => ({
    name, expr: `${expr}\n`, severity, labels, ...(canonical.spec.alerting.rules[i].for ? { for: canonical.spec.alerting.rules[i].for } : {}),
  }));
  live.spec.alerting.rules[1].expr = live.spec.alerting.rules[1].expr.replace('> 0.9', '> 0.95');
  live.spec.alerting.rules.push({ name: 'PaymentNodeDown', expr: 'up{job="payment-service"} == 0', severity: 'SEV1' });
  const d = diffPacks(prod, adapt(live));
  const ruleEntries = (bucket) => d.layers.L4[bucket].filter(e => e.key.startsWith('alert_rule::'));
  assert(ruleEntries('inBoth').length === 3 && ruleEntries('inBoth').every(e => e.a.title === e.b.title),
    'the three rules pair by name — engine, source, annotations and a trailing newline in the expression are not identity', ruleEntries('inBoth').map(e => [e.key, e.match]));
  assert(ruleEntries('inBoth').filter(e => e.match === 'aligned').map(e => e.a.title).sort().join() === 'PaymentCertificateExpiringSoon,PaymentServicePodRestarting',
    'the unchanged rules read aligned although the live side states no engine and no source', ruleEntries('inBoth').map(e => [e.a.title, e.match, e.deltas]));
  const drifted = ruleEntries('inBoth').find(e => e.match === 'drifted');
  assert(drifted?.a.title === 'PaymentDbConnectionPoolSaturated' && drifted.deltas.map(x => x.field).join() === 'expr',
    'a rule whose expression changed reads drifted, on expr', drifted && [drifted.a.title, drifted.deltas]);
  assert(ruleEntries('onlyInB').map(e => e.artefact.title).join() === 'PaymentNodeDown' && ruleEntries('onlyInA').length === 0,
    'a rule only the live side holds reads "live, not declared"', [ruleEntries('onlyInA').length, ruleEntries('onlyInB').map(e => e.artefact.title)]);
}

// ---------- a rule the producer was shown only in part (observogram.partial.<symbol>) ----------
// A live listing that gives a rule's severity and no labels object showed
// that label and no other. The pack says so per rule; the adapter puts it on
// the artefact; the comparison holds the rule to the keys it was shown.
{
  const rulesOf = (layered) => layered.layers.L4.alerting.filter(a => a.id.startsWith('RULE-'));
  const pairOf = (d, title) => d.layers.L4.inBoth.find(e => e.key.startsWith('alert_rule::') && e.a.title === title);
  // The example's rules carry { severity, team }. A listing that shows severities only:
  const shown = (keys) => (rule) => ({ ...rule, labels: Object.fromEntries(Object.entries(rule.labels).filter(([k]) => keys.includes(k))) });
  const live = clone(canonical);
  live.spec.alerting.rules = canonical.spec.alerting.rules.map(shown(['severity']));
  const stated = clone(live);
  canonical.spec.alerting.rules.forEach((_, i) => { stated.metadata.annotations = { ...stated.metadata.annotations, [`${PARTIAL_ANNOTATION_PREFIX}alerting.rules[${i}]`]: 'labels=severity' }; });

  assert(rulesOf(adapt(stated)).every(a => JSON.stringify(a.partial) === JSON.stringify({ labels: ['severity'] }))
    && rulesOf(prod).every(a => !('partial' in a)) && rulesOf(adapt(live)).every(a => !('partial' in a)),
  'the adapter puts the statement on the rule as `partial`; without one, no key', rulesOf(adapt(stated)).map(a => a.partial));

  // Not stated: the missing team label is a difference, in full.
  const blind = diffPacks(prod, adapt(live));
  assert(blind.layers.L4.inBoth.filter(e => e.key.startsWith('alert_rule::')).length === 3 && !('partlyCompared' in blind.summary)
    && blind.layers.L4.inBoth.filter(e => e.key.startsWith('alert_rule::')).every(e => e.match === 'drifted' && e.deltas.map(x => x.field).join() === 'labels' && !('unobserved' in e)),
    'labels a pack does not say it saw in part are compared whole: three rules drifted on labels', blind.layers.L4.inBoth.filter(e => e.key.startsWith('alert_rule::')).map(e => [e.match, e.deltas]));

  // Stated: held to the severity it was shown; the team label is named as unobserved, on the side that did not see it.
  const seen = diffPacks(prod, adapt(stated));
  const pair = pairOf(seen, 'PaymentServicePodRestarting');
  assert(seen.layers.L4.inBoth.filter(e => e.key.startsWith('alert_rule::')).every(e => e.match === 'aligned' && e.deltas.length === 0)
    && JSON.stringify(pair.unobserved) === JSON.stringify([{ field: 'labels', side: 'b', keys: ['team'] }]) && seen.summary.drifted === blind.summary.drifted - 3 && seen.summary.partlyCompared === 3,
  'a rule shown only its severity is aligned, the label it was not shown named on the pair', pair && [pair.match, pair.deltas, pair.unobserved]);
  const swapped = pairOf(diffPacks(adapt(stated), prod), 'PaymentServicePodRestarting');
  assert(swapped.match === 'aligned' && JSON.stringify(swapped.unobserved) === JSON.stringify([{ field: 'labels', side: 'a', keys: ['team'] }]),
    'either side may be the one that saw in part', swapped && [swapped.match, swapped.unobserved]);

  // A severity that differs is still a difference, on the shown key alone.
  const wrong = clone(stated);
  wrong.spec.alerting.rules[0] = { ...wrong.spec.alerting.rules[0], severity: 'SEV1', labels: { severity: 'critical' } };
  const drifted = pairOf(diffPacks(prod, adapt(wrong)), 'PaymentServicePodRestarting');
  assert(drifted.match === 'drifted' && JSON.stringify(drifted.deltas) === JSON.stringify([
    { field: 'labels', a: { severity: 'warning' }, b: { severity: 'critical' } }, { field: 'severity', a: 'SEV3', b: 'SEV1' }]),
  'what was shown and differs is drift; the delta holds the shown keys only', drifted && drifted.deltas);

  // Nothing of the labels shown (`labels=`): neither the labels nor the severity read from them is compared.
  const none = clone(live);
  none.spec.alerting.rules[0] = (({ severity: _s, labels: _l, ...rest }) => rest)(none.spec.alerting.rules[0]);
  none.metadata.annotations = { ...none.metadata.annotations, [`${PARTIAL_ANNOTATION_PREFIX}alerting.rules[0]`]: 'labels=' };
  const dark = pairOf(diffPacks(prod, adapt(none)), 'PaymentServicePodRestarting');
  assert(dark.match === 'aligned' && JSON.stringify(dark.unobserved) === JSON.stringify([{ field: 'labels', side: 'b', keys: ['severity', 'team'] }]),
    'a rule shown nothing of its labels is not compared on them, nor on the severity read from them', dark && [dark.match, dark.deltas, dark.unobserved]);

  // A pack-level severity with no severity label, against a side shown nothing of the labels: uncompared, and named.
  const bare = { ...rulesOf(prod)[0], spec: (({ labels: _l, ...rest }) => rest)(rulesOf(prod)[0].spec) };
  const unseen = { ...rulesOf(adapt(none))[0] };
  assert(deltasOf(bare, unseen).length === 0 && JSON.stringify(unobservedOf(bare, unseen)) === JSON.stringify([{ field: 'labels', side: 'b', keys: ['severity'] }]),
    'a severity the pack states without the label is named as uncompared too', [bare.spec, unseen.spec, deltasOf(bare, unseen), unobservedOf(bare, unseen)]);

  // A whole match is taken before a match on part: a rule seen in part must not take the counterpart of one that matches in full.
  {
    const two = clone(canonical);
    const [first] = two.spec.alerting.rules;
    two.spec.alerting.rules = [{ ...first, labels: { severity: 'warning', team: 'b' } }, { ...first, labels: { severity: 'warning', team: 'a' } }];
    const other = clone(canonical);
    other.spec.alerting.rules = [{ ...first, labels: { severity: 'warning' } }, { ...first, labels: { severity: 'warning', team: 'b' } }];
    other.metadata.annotations = { ...other.metadata.annotations, [`${PARTIAL_ANNOTATION_PREFIX}alerting.rules[0]`]: 'labels=severity' };
    const pairs = diffPacks(adapt(two), adapt(other)).layers.L4.inBoth.filter(e => e.key.startsWith('alert_rule::'));
    assert(pairs.length === 2 && pairs.every(e => e.match === 'aligned')
      && JSON.stringify(pairs.map(e => [e.a.spec.labels.team, e.b.spec.labels.team ?? null, e.unobserved?.[0]?.keys ?? null])) === JSON.stringify([['b', 'b', null], ['a', null, ['team']]]),
    'two same-named rules against one seen whole and one seen in part: the whole match first, then the part — both aligned', pairs.map(e => [e.key, e.match, e.a.spec.labels, e.b.spec.labels, e.unobserved]));
  }

  // Both sides in part: compared on what both were shown.
  const [a] = rulesOf(adapt(stated));
  const b = { ...rulesOf(prod)[0], partial: { labels: ['team'] } };
  assert(deltasOf(a, b).length === 0 && JSON.stringify(unobservedOf(a, b)) === JSON.stringify([{ field: 'labels', side: 'a', keys: ['team'] }, { field: 'labels', side: 'b', keys: ['severity'] }]),
    'two sides that each saw a part are compared on the keys both saw (here none), each naming what it missed', [deltasOf(a, b), unobservedOf(a, b)]);

  // The statement's form.
  assert(partialAnnotation({ labels: ['team', 'severity', 'team'] }) === 'labels=severity,team' && partialAnnotation({ labels: [] }) === 'labels='
    && partialAnnotation({ labels: ['x'], annotations: [] }) === 'annotations=;labels=x',
  'partialAnnotation writes <field>=<keys>, fields and keys sorted, each key once', partialAnnotation({ labels: ['team', 'severity', 'team'] }));
  assert(JSON.stringify(parsePartialAnnotation('labels=severity,team')) === JSON.stringify({ labels: ['severity', 'team'] })
    && JSON.stringify(parsePartialAnnotation('annotations=;labels= severity ')) === JSON.stringify({ annotations: [], labels: ['severity'] })
    && [undefined, null, '', 'labels', '=x', 42].every(v => parsePartialAnnotation(v) === null),
  'parsePartialAnnotation reads it back; a value that states nothing is null', parsePartialAnnotation('labels=severity,team'));
  const sli = prod.layers.L1[0];
  assert(unobservedOf(sli, sli).length === 0 && unobservedOf(rulesOf(prod)[0], rulesOf(prod)[0]).length === 0,
    'a pair compared whole, and every other family, has nothing unobserved');
}

// ---------- an override path never walks the prototype chain ----------
//
// A pack stored before validation refused such keys still reaches the
// overlay: it skips the path, writes nothing outside the spec, and applies
// the pack's other overrides as before. And a value that did land on
// Object.prototype is never read as configuration.
{
  const hostile = clone(canonical);
  Object.assign(hostile.spec.environments.prod.overrides, {
    '__proto__.ogvPolluted': 'yes',
    'constructor.prototype.ogvPolluted': 'yes',
    'otel.__proto__.ogvPolluted': 'yes',
  });
  const { spec } = applyEnvironmentOverlay(hostile.spec, 'prod');
  assert(({}).ogvPolluted === undefined && !Object.hasOwn(Object.prototype, 'ogvPolluted'),
    'no override reaches Object.prototype', ({}).ogvPolluted);
  assert(spec.otel?.sdk?.sampling?.ratio === 0.1 && spec.storage?.metrics?.retention === '13mo',
    'the pack\'s ordinary overrides still apply', [spec.otel?.sdk?.sampling?.ratio, spec.storage?.metrics?.retention]);
  assert(adapt(hostile).meta?.environment === 'prod', 'the adapter still adapts the pack');
  assert(({}).ogvPolluted === undefined, 'nor does adapt() pollute', ({}).ogvPolluted);

  Object.defineProperty(Object.prototype, 'OBSERVOGRAM_OGV_INHERITED', { value: 'off', configurable: true });
  try {
    assert(process.env.OBSERVOGRAM_OGV_INHERITED === 'off', 'precondition: process.env reads fall through to Object.prototype');
    assert(brandEnvFrom(process.env, 'OGV_INHERITED') === '', 'brandEnvFrom reads only the env\'s own variables',
      brandEnvFrom(process.env, 'OGV_INHERITED'), '');
    assert(brandEnvFrom({ OBSERVOGRAM_OGV_INHERITED: 'on' }, 'OGV_INHERITED') === 'on', 'an own variable still wins');
    assert(brandEnvFrom({ TOMOGRAPH_OGV_INHERITED: 'legacy' }, 'OGV_INHERITED') === 'legacy', 'the legacy spelling still counts');
  } finally {
    delete Object.prototype.OBSERVOGRAM_OGV_INHERITED;
  }
}

// ---------- an SLO's objective as a percentage ----------
// Only the zeros after a decimal point go: 0.9 is "90%", not "9%"; 1 is
// "100%", not "1%".
{
  const objectives = [0.9, 1, 0.99, 0.999, 0.9995, 0.5];
  const layered = adapt({
    apiVersion: 'observability.platform/v1', kind: 'ObservabilityPack',
    metadata: { name: 'pct', version: '1.0.0' },
    spec: {
      slis: [{ id: 'avail', type: 'ratio', good: 'sum(rate(ok[5m]))', total: 'sum(rate(all[5m]))' }],
      slos: objectives.map((objective, i) => ({ id: `slo_${i}`, sli: 'avail', objective, window: '30d' })),
    },
  });
  const descs = layered.layers.L1.filter((a) => a.tool === 'SLO').map((a) => a.desc.split(' over ')[0]);
  assert(JSON.stringify(descs) === JSON.stringify(['90%', '100%', '99%', '99.9%', '99.95%', '50%']), 'an SLO objective prints every digit of its percentage', descs);
}

report('adapter');
