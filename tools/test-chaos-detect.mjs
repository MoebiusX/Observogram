#!/usr/bin/env node
/**
 * tools/test-chaos-detect.mjs — the chaos experiments a repository holds, read into the pack.
 *
 * Spec 1.5 (RFC-0004) lets a pack declare an experiment however it is run and record its newest
 * run. This suite pins:
 *   - the browser-safe mirrors in tools/lib/chaos-detect.mjs against the vendored $defs, and
 *     chaosExperimentErrors against validateCanonical, entry for entry;
 *   - the in-process reader: a scenario table (durationSeconds at the entry's own level, delayMs
 *     or errorRate in its body), in a file whose path names chaos — nothing else;
 *   - the corroboration: routes, header, toggle; it annotates and declares nothing on its own;
 *   - Chaos Mesh and Litmus resources, a Schedule's cron as the spec's calendar, a Litmus
 *     ChaosExperiment counted as a template;
 *   - detected → declared: expected alerts from the scenario's own text, MTTD from the slowest
 *     one's `for:`, the hypothesis that fits the fault, every inferred field marked;
 *   - the repository's own pack (.observability/*.yaml): merged by id, the declared entry winning,
 *     an invalid entry left out with a warning, never a failed scan;
 *   - the crawl end to end: a schema-valid pack, evidence paths, annotations, the tier, the
 *     GitHub / ADO file rule;
 *   - what the 0.8.7 walkthrough found: the Expert door sends every file the scan uses
 *     (crawler.mjs scanUsesFile), a scanned experiment's references resolve in its own pack
 *     (studio/symbol-refs.mjs), and Diagnose words its blocker from the proof (studio/chaos-copy.mjs).
 * Every fixture here is synthetic.
 *
 * Run: node --test tools/test-chaos-detect.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, parseAll as parseYamlAll } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH, SPEC_DIR } from './lib/validator.mjs';
import {
  CHAOS_ENGINES, CHAOS_SCHEDULES, CHAOS_RUN_OUTCOMES, CHAOS_REQUIRED, CHAOS_PATTERNS, UNRESOLVED_EXPECTED_ALERT,
  chaosExperimentErrors, chaosRunErrors, durationSeconds, formatDuration, isChaosCodePath, scenarioTablesIn,
  chaosControlIn, chaosToggleIn, chaosResourcesIn, scheduleOfCron, detectChaos, chaosExperimentsFrom, chaosControlSummary, chaosPassReads,
} from './lib/chaos-detect.mjs';
import { isRepoPackPath, readRepoPack } from './lib/repo-pack.mjs';
import { crawlFiles, detectArtefactKind, scanUsesFile } from './lib/crawler.mjs';
import { adapt } from './lib/adapter.mjs';
import { isCrawlerFile, selectCrawlerFiles } from '../server/github-crawl.mjs';
import { refResolves, refSymbol, UNRESOLVED_ALERT_PLACEHOLDER } from '../studio/symbol-refs.mjs';
import { chaosBlockerCopy } from '../studio/chaos-copy.mjs';
import { chaosProof } from '../studio/diagnostic-grade.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, SPEC_SCHEMA_PATH), 'utf8'));
const example = () => parseYaml(readFileSync(resolve(ROOT, SPEC_DIR, 'examples', 'payment-service.pack.yaml'), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// synthetic fixtures
// ---------------------------------------------------------------------------

const SCENARIO_TS = `
import { log } from '../log';

export type FaultName = 'slow-checkout' | 'payment-errors' | 'ramp-up';

export interface Fault { durationSeconds: number; delayMs: number; errorRate: number }

export const FAULTS: Record<FaultName, any> = {
  'slow-checkout': {
    name: 'Slow checkout',
    description: 'Adds 4 s to /api/checkout; should fire CheckoutLatencyHigh within minutes',
    durationSeconds: 120,
    config: { delayMs: 4000, errorRate: 0, targetRoutes: ['/api/checkout'] },
  },
  'payment-errors': {
    name: 'Payment errors',
    description: 'Fails 30% of payment calls with a 503, firing PaymentErrorRate and CheckoutLatencyHigh',
    durationSeconds: 90,
    config: { delayMs: 100, errorRate: 0.3, errorCode: 503, targetRoutes: ['/api/pay', "/api/refund"] },
  },
  'ramp-up': {
    name: 'Ramp up',
    description: 'Latency that grows over time', // no alert named
    durationSeconds: 300,
    config: { delayMs: 200 },
    phases: [
      { atSeconds: 0, config: { delayMs: 200 } },
      { atSeconds: 120, config: { delayMs: 2500, errorRate: 0.05 } },
    ],
  },
};

// a settings block with a duration and no fault: not an entry
export const settings = { timing: { durationSeconds: 5, retries: 2 } };
`;

const SCENARIO_PY = `
SCENARIOS = {
    "db-stall": {"duration_seconds": 60, "delay_ms": 3000, "description": "stalls the DB pool"},
}
`;

const ROUTES_TS = `
router.post('/chaos/start', requireKey, start);
router.post('/chaos/stop', requireKey, stop);
router.get("/chaos/status", requireKey, status);
const key = req.headers['x-chaos-key'];
`;

const RULES_YAML = `
groups:
  - name: checkout
    rules:
      - alert: CheckoutLatencyHigh
        expr: histogram_quantile(0.99, sum(rate(http_server_duration_seconds_bucket{route="/api/checkout"}[5m])) by (le)) > 2
        for: 5m
        labels: { severity: warning }
      - alert: CheckoutLatencyHighCritical
        expr: histogram_quantile(0.99, sum(rate(http_server_duration_seconds_bucket{route="/api/checkout"}[5m])) by (le)) > 5
        for: 2m
        labels: { severity: critical }
      - alert: PaymentErrorRate
        expr: sum(rate(http_requests_total{route="/api/pay",code=~"5.."}[5m])) / sum(rate(http_requests_total{route="/api/pay"}[5m])) > 0.05
        for: 2m
        labels: { severity: critical }
`;

const VALUES_BASE = `
api:
  chaos:
    enabled: true
  image: { repository: shop/api, tag: "1.2.0" }
`;
const VALUES_PROD = `
api:
  chaos:
    enabled: false
`;

const MESH_YAML = `
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata: { name: api-pod-kill }
spec:
  action: pod-kill
  mode: fixed-percent
  value: "50"
  duration: 60s
  selector: { labelSelectors: { app: shop-api } }
---
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata: { name: weekly-network-delay }
spec:
  schedule: "0 3 * * 1"
  type: NetworkChaos
  networkChaos:
    action: delay
    duration: 5m
    selector: { namespaces: [shop] }
---
apiVersion: chaos-mesh.org/v1alpha1
kind: Workflow
metadata: { name: game-day }
spec:
  entry: entry
  templates:
    - { name: entry, templateType: Serial, children: [kill, delay] }
    - { name: kill, templateType: PodChaos }
    - { name: delay, templateType: NetworkChaos }
`;

const LITMUS_YAML = `
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata: { name: shop-engine }
spec:
  appinfo: { appns: shop, applabel: "app=shop-api" }
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - { name: TOTAL_CHAOS_DURATION, value: "30" }
    - name: pod-network-latency
---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosSchedule
metadata: { name: shop-weekly }
spec:
  schedule:
    repeat:
      properties: { minChaosInterval: 168h }
  engineTemplateSpec:
    appinfo: { applabel: "app=shop-api" }
    experiments:
      - name: pod-cpu-hog
---
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosExperiment
metadata: { name: pod-delete }
spec: {}
`;

const REPO_PACK = `
apiVersion: observability.platform/v1
kind: ObservabilityPack
metadata: { name: shop-api, version: 0.1.0, owners: [team-shop], bindings: { service: shop-api, environments: [prod], criticality: tier-2 } }
spec:
  validation:
    chaos_experiments:
      - id: ramp-up
        engine: in-process
        target: shop-api
        steady_state_hypothesis: ref:slos.checkout_latency
        fault: { kind: latency, duration: 5m }
        expected_alerts: [CheckoutLatencyHigh]
        expected_mttd: 6m
        schedule: on-demand
        last_result:
          at: "2026-11-01T10:00:00Z"
          outcome: pass
          observed_mttd: 4m30s
          alerts_fired: [CheckoutLatencyHigh]
          evidence: game-day 2026-11-01
      - id: region-failover
        engine: custom
        target: shop-api
        steady_state_hypothesis: ref:slos.checkout_latency
        fault: { kind: region-outage }
        expected_alerts: [CheckoutLatencyHighCritical]
        expected_mttd: 5m
        schedule: ci
      - id: Not A Slug
        engine: in-process
`;

const repoFiles = (extra = {}) => ({
  'src/chaos/faults.ts': SCENARIO_TS,
  'src/routes/chaos-routes.ts': ROUTES_TS,
  'deploy/prometheus/checkout.rules.yaml': RULES_YAML,
  'deploy/helm/values.yaml': VALUES_BASE,
  'deploy/helm/values-prod.yaml': VALUES_PROD,
  ...extra,
});

// ---------------------------------------------------------------------------
// the mirrors
// ---------------------------------------------------------------------------

test('the mirrors equal the vendored spec 1.5 $defs: engines, schedules, outcomes, required keys, patterns', () => {
  const item = SCHEMA.$defs.Validation.properties.chaos_experiments.items;
  assert.deepEqual([...CHAOS_ENGINES], item.properties.engine.enum);
  assert.deepEqual([...CHAOS_SCHEDULES], item.properties.schedule.enum);
  assert.deepEqual([...CHAOS_REQUIRED], item.required);
  assert.deepEqual([...CHAOS_RUN_OUTCOMES], SCHEMA.$defs.ChaosRunResult.properties.outcome.enum);
  assert.equal(CHAOS_PATTERNS.Slug, SCHEMA.$defs.Slug.pattern);
  assert.equal(CHAOS_PATTERNS.Duration, SCHEMA.$defs.Duration.pattern);
  assert.equal(CHAOS_PATTERNS.Ref, SCHEMA.$defs.Ref.pattern);
});

test('chaosExperimentErrors agrees with the schema, entry for entry', () => {
  const good = { id: 'x-kill', engine: 'in-process', target: 'svc', steady_state_hypothesis: 'ref:slos.a', fault: { kind: 'latency', duration: '2m', delay_ms: 10 }, expected_alerts: ['A'], expected_mttd: '3m', schedule: 'on-demand' };
  const cases = [
    good,
    { ...good, environment: 'prod', last_result: { at: '2026-11-01T10:00:00Z', outcome: 'pass', alerts_fired: ['A'], observed_mttd: '1m', evidence: 'run 1', environment: 'staging' } },
    { ...good, engine: 'toxiproxy' },
    { ...good, schedule: 'hourly' },
    { ...good, id: 'Bad Id' },
    { ...good, expected_alerts: [] },
    { ...good, expected_mttd: 'soon' },
    { ...good, steady_state_hypothesis: 'not a ref!' },
    { ...good, fault: {} },
    { ...good, fault: { kind: 'x', fraction: 2 } },
    { ...good, extra: 1 },
    { ...good, last_result: { outcome: 'pass' } },
    { ...good, last_result: { at: 'yesterday', outcome: 'pass' } },
    { ...good, last_result: { at: '2026-11-01T10:00:00Z', outcome: 'passed' } },
    { ...good, last_result: { at: '2026-11-01T10:00:00Z', outcome: 'pass', history: [] } },
    (() => { const e = clone(good); delete e.schedule; return e; })(),
  ];
  for (const entry of cases) {
    const pack = example();
    pack.spec.validation.chaos_experiments = [entry];
    const schemaSays = validateCanonical(pack, SCHEMA).length === 0;
    const mirrorSays = chaosExperimentErrors(entry).length === 0;
    assert.equal(mirrorSays, schemaSays, `${JSON.stringify(entry)}: schema ${schemaSays}, mirror ${mirrorSays} (${chaosExperimentErrors(entry).join('; ')})`);
  }
  assert.deepEqual(chaosRunErrors({ at: '2026-11-01T10:00:00Z', outcome: 'aborted' }), []);
  assert.match(chaosRunErrors({ at: '2026-11-01T10:00:00Z' })[0], /'outcome'/);
});

test('durations: spec / Prometheus text to seconds and back', () => {
  assert.equal(durationSeconds('5m'), 300);
  assert.equal(durationSeconds('1h30m'), 5400);
  assert.equal(durationSeconds('90s'), 90);
  assert.equal(durationSeconds('2mo'), 5184000);
  assert.equal(durationSeconds('soon'), null);
  assert.equal(formatDuration(360), '6m');
  assert.equal(formatDuration(210), '3m30s');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(45), '45s');
});

// ---------------------------------------------------------------------------
// in-process systems
// ---------------------------------------------------------------------------

test('a scenario table is read entry by entry: own-level durationSeconds, delayMs / errorRate in the body, phases and routes', () => {
  const rows = scenarioTablesIn('src/chaos/faults.ts', SCENARIO_TS);
  assert.deepEqual(rows.map(r => r.key), ['slow-checkout', 'payment-errors', 'ramp-up'], 'a duration with no fault is not an entry; the interface is not one either');
  // durationSeconds must sit at the entry's own level: a wrapper whose child carries it is not an entry, the child is
  const nested = scenarioTablesIn('src/chaos/x.ts', "const T = { group: { 'child-a': { durationSeconds: 3, errorRate: 0.5 } } };");
  assert.deepEqual(nested.map(r => r.key), ['child-a']);
  const [slow, pay, ramp] = rows;
  assert.equal(slow.table, 'FAULTS');
  assert.deepEqual([slow.durationSeconds, slow.delayMs, slow.errorRate, slow.routes], [120, 4000, 0, ['/api/checkout']]);
  assert.deepEqual([pay.errorRate, pay.errorCodes, pay.routes], [0.3, [503], ['/api/pay', '/api/refund']]);
  assert.deepEqual([ramp.durationSeconds, ramp.delayMs, ramp.errorRate, ramp.phases], [300, 2500, 0.05, 2]);
  assert.match(pay.text, /PaymentErrorRate/);
  assert.ok(!/no alert named/.test(ramp.text), 'a comment is not the scenario\'s text');
  // snake_case (Python) reads the same way
  const py = scenarioTablesIn('ops/chaos_scenarios.py', SCENARIO_PY);
  assert.deepEqual(py.map(r => [r.key, r.table, r.durationSeconds, r.delayMs]), [['db-stall', 'SCENARIOS', 60, 3000]]);
});

test('a table outside a chaos path, or a chaos file with no table, declares nothing', () => {
  assert.deepEqual(scenarioTablesIn('src/load/faults.ts', SCENARIO_TS), [], 'the path must name chaos');
  assert.deepEqual(scenarioTablesIn('src/chaos/routes.ts', ROUTES_TS), []);
  assert.equal(isChaosCodePath('server/middleware/chaos.ts'), true);
  assert.equal(isChaosCodePath('types/chaos.d.ts'), false);
  assert.equal(isChaosCodePath('docs/chaos.md'), false);
});

test('the control surface corroborates: routes, header, key variable; the toggle follows the override order', () => {
  assert.deepEqual(chaosControlIn('src/routes/chaos-routes.ts', ROUTES_TS), { routes: ['start', 'stop', 'status'], header: true, keyVariable: false });
  assert.deepEqual(chaosControlIn('README.md', ROUTES_TS).routes, [], 'only code files');
  const toggle = chaosToggleIn([{ relPath: 'values.yaml', content: VALUES_BASE }, { relPath: 'values-prod.yaml', content: VALUES_PROD }]);
  assert.deepEqual(toggle, { path: 'api.chaos.enabled', enabled: false, file: 'values-prod.yaml' });
  const detected = detectChaos(new Map(Object.entries({ 'src/routes/chaos-routes.ts': ROUTES_TS, 'scripts/run.js': 'process.env.CHAOS_API_KEY' })));
  assert.deepEqual(detected.control.files, ['src/routes/chaos-routes.ts'], 'a script that only names the key variable is not a control file');
  assert.equal(detected.control.keyVariable, true);
  assert.equal(chaosControlSummary(detected), 'API /chaos/start|stop|status, gated by the X-Chaos-Key header, keyed by CHAOS_API_KEY (src/routes/chaos-routes.ts)');
  const none = chaosExperimentsFrom(detected, { repoName: 'shop-api' });
  assert.deepEqual(none.experiments, [], 'a control API alone declares no experiment');
  assert.match(none.notes[0], /control API was found .* but no scenario table/);
});

// ---------------------------------------------------------------------------
// Chaos Mesh and Litmus
// ---------------------------------------------------------------------------

test('Chaos Mesh: a chaos kind, a Schedule (its cron as the calendar) and a Workflow, one experiment each', () => {
  const { resources, templates } = chaosResourcesIn('deploy/chaos/mesh.yaml', parseYamlAll(MESH_YAML));
  assert.equal(templates, 0);
  assert.deepEqual(resources.map(r => [r.name, r.kind, r.fault.kind, r.target, r.schedule]), [
    ['api-pod-kill', 'PodChaos', 'pod-kill', 'shop-api', 'on-demand'],
    ['weekly-network-delay', 'Schedule', 'network-delay', 'shop', 'weekly'],
    ['game-day', 'Workflow', 'workflow', null, 'on-demand'],
  ]);
  assert.deepEqual(resources[0].fault, { kind: 'pod-kill', duration: '60s', fraction: 0.5 });
  assert.deepEqual(resources[2].fault, { kind: 'workflow', steps: 2 });
  assert.equal(resources[1].source, 'deploy/chaos/mesh.yaml#Schedule/weekly-network-delay');
});

test('Litmus: one experiment per engine experiment, a ChaosSchedule\'s interval as the calendar, a ChaosExperiment counted as a template', () => {
  const { resources, templates } = chaosResourcesIn('deploy/chaos/litmus.yaml', parseYamlAll(LITMUS_YAML));
  assert.equal(templates, 1);
  assert.deepEqual(resources.map(r => [r.name, r.fault.kind, r.target, r.schedule]), [
    ['shop-engine-pod-delete', 'pod-delete', 'shop-api', 'on-demand'],
    ['shop-engine-pod-network-latency', 'pod-network-latency', 'shop-api', 'on-demand'],
    ['shop-weekly', 'pod-cpu-hog', 'shop-api', 'weekly'],
  ]);
  assert.deepEqual(resources[0].fault, { kind: 'pod-delete', duration: '30s' });
});

test('a cron line as the spec calendar', () => {
  for (const [cron, want] of [['@daily', 'daily'], ['@hourly', 'daily'], ['@weekly', 'weekly'], ['@monthly', 'monthly'], ['@every 12h', 'daily'], ['@every 168h', 'weekly'], ['@every 720h', 'monthly'],
    ['0 3 * * *', 'daily'], ['*/15 * * * *', 'daily'], ['0 3 * * 1', 'weekly'], ['0 3 1 * *', 'monthly'], ['0 0 3 * * 1', 'weekly'], ['', null], ['nonsense', null]]) {
    assert.equal(scheduleOfCron(cron), want, cron);
  }
});

// ---------------------------------------------------------------------------
// detected → declared
// ---------------------------------------------------------------------------

const CTX = {
  repoName: 'shop-api',
  alertRules: [
    { name: 'CheckoutLatencyHigh', for: '5m', slo: null },
    { name: 'CheckoutLatencyHighCritical', for: '2m', slo: null },
    { name: 'PaymentErrorRate', for: '2m', slo: 'payment_availability' },
  ],
  slos: [{ id: 'checkout_latency', sli: 'checkout_latency_p99' }, { id: 'payment_availability', sli: 'payment_ok' }],
  slis: new Map([['checkout_latency_p99', { type: 'threshold' }], ['payment_ok', { type: 'ratio' }]]),
  mttdFallback: '15m',
};

test('declared from code: the alerts the scenario names, MTTD from the slowest for:, the hypothesis that fits, every inferred field marked', () => {
  const detected = detectChaos(new Map(Object.entries(repoFiles())));
  const out = chaosExperimentsFrom(detected, CTX);
  const by = Object.fromEntries(out.experiments.map(e => [e.id, e]));
  assert.deepEqual(Object.keys(by), ['slow-checkout', 'payment-errors', 'ramp-up']);
  assert.deepEqual(by['slow-checkout'], {
    id: 'slow-checkout', engine: 'in-process', target: 'shop-api', steady_state_hypothesis: 'ref:slos.checkout_latency',
    fault: { kind: 'latency', duration: '2m', delay_ms: 4000, routes: ['/api/checkout'] },
    expected_alerts: ['CheckoutLatencyHigh'], expected_mttd: '6m', schedule: 'on-demand',
  }, 'CheckoutLatencyHigh, not CheckoutLatencyHighCritical: names match whole');
  assert.deepEqual(by['payment-errors'].expected_alerts, ['CheckoutLatencyHigh', 'PaymentErrorRate']);
  assert.equal(by['payment-errors'].expected_mttd, '6m', 'the slowest of the two (5m) plus one evaluation interval');
  assert.equal(by['payment-errors'].steady_state_hypothesis, 'ref:slos.payment_availability', 'the SLO a matched burn-rate alert protects');
  assert.deepEqual(by['payment-errors'].fault, { kind: 'http-errors', duration: '1m30s', delay_ms: 100, error_rate: 0.3, error_codes: [503], routes: ['/api/pay', '/api/refund'] });
  assert.deepEqual(by['ramp-up'].expected_alerts, [UNRESOLVED_EXPECTED_ALERT]);
  assert.equal(by['ramp-up'].expected_mttd, '15m', 'no alert to time: the baselines target');
  assert.equal(by['ramp-up'].fault.kind, 'latency-and-errors');
  const marks = new Map(out.marks);
  assert.match(marks.get('validation.chaos_experiments.slow-checkout.expected_mttd'), /for: \(5m\) plus one evaluation interval/);
  assert.match(marks.get('validation.chaos_experiments.ramp-up.expected_alerts'), /names no alert rule/);
  assert.match(marks.get('validation.chaos_experiments.ramp-up.steady_state_hypothesis'), /fits a latency-and-errors fault/);
  assert.match(marks.get('validation.chaos_experiments.slow-checkout.schedule'), /on-demand/);
  assert.ok(!marks.has('validation.chaos_experiments.slow-checkout.expected_alerts'), 'a matched alert is not marked');
  assert.ok(![...marks.keys()].some(k => k === 'validation.chaos_experiments.slow-checkout'), 'no artefact-level mark: discovered, not scaffold');
  assert.equal(out.evidence['validation.chaos_experiments.payment-errors'], 'src/chaos/faults.ts#FAULTS.payment-errors');
  for (const e of out.experiments) assert.deepEqual(chaosExperimentErrors(e), [], e.id);
});

test('declared from resources: unique ids, the resource\'s target, the toggle note only for in-process scenarios', () => {
  const files = new Map(Object.entries({ 'deploy/chaos/mesh.yaml': MESH_YAML, 'deploy/chaos/litmus.yaml': LITMUS_YAML, 'deploy/chaos/again.yaml': MESH_YAML.split('---')[0] }));
  const out = chaosExperimentsFrom(detectChaos(files), CTX);
  assert.deepEqual(out.experiments.map(e => [e.id, e.engine, e.target, e.schedule]), [
    ['api-pod-kill', 'chaos-mesh', 'shop-api', 'on-demand'],
    ['weekly-network-delay', 'chaos-mesh', 'shop', 'weekly'],
    ['game-day', 'chaos-mesh', 'shop-api', 'on-demand'],
    ['shop-engine-pod-delete', 'litmus', 'shop-api', 'on-demand'],
    ['shop-engine-pod-network-latency', 'litmus', 'shop-api', 'on-demand'],
    ['shop-weekly', 'litmus', 'shop-api', 'weekly'],
    ['api-pod-kill-2', 'chaos-mesh', 'shop-api', 'on-demand'],
  ].sort((a, b) => out.experiments.findIndex(e => e.id === a[0]) - out.experiments.findIndex(e => e.id === b[0])));
  assert.ok(out.experiments.every(e => e.expected_alerts[0] === UNRESOLVED_EXPECTED_ALERT), 'a resource names no alert');
  assert.match(out.notes.join(' '), /1 Litmus ChaosExperiment template/);
  assert.equal(out.experiments.find(e => e.id === 'weekly-network-delay').steady_state_hypothesis, 'ref:slos.checkout_latency', 'a delay fault fits the latency SLO');
  assert.equal(out.experiments.find(e => e.id === 'api-pod-kill').steady_state_hypothesis, 'ref:slos.payment_availability', 'a pod kill fits the availability SLO');
  for (const e of out.experiments) assert.deepEqual(chaosExperimentErrors(e), [], e.id);
});

// ---------------------------------------------------------------------------
// the repository's own pack
// ---------------------------------------------------------------------------

test('a repository pack: .observability/*.yaml only, entries checked one by one', () => {
  assert.equal(isRepoPackPath('.observability/pack.yaml'), true);
  assert.equal(isRepoPackPath('svc/.observability/chaos.yml'), true);
  assert.equal(isRepoPackPath('.observability/deep/pack.yaml'), false);
  assert.equal(isRepoPackPath('observability/pack.yaml'), false);
  assert.equal(readRepoPack('.observability/x.yaml', 'groups: []'), null, 'not a pack');
  const read = readRepoPack('.observability/pack.yaml', REPO_PACK);
  assert.deepEqual(read.chaos.map(c => [c.entry.id, c.source]), [
    ['ramp-up', '.observability/pack.yaml#spec.validation.chaos_experiments.ramp-up'],
    ['region-failover', '.observability/pack.yaml#spec.validation.chaos_experiments.region-failover'],
  ]);
  assert.equal(read.refused.length, 1);
  assert.equal(read.refused[0].id, 'Not A Slug');
  assert.match(read.refused[0].reason, /missing required key 'target'/);
});

// ---------------------------------------------------------------------------
// the crawl, end to end
// ---------------------------------------------------------------------------

test('the crawl declares the experiments, merges the repository pack by id, and stays schema-valid', () => {
  const files = repoFiles({ '.observability/pack.yaml': REPO_PACK, 'k8s/chaos/mesh.yaml': MESH_YAML.split('---')[0] });
  assert.equal(detectArtefactKind('.observability/pack.yaml', REPO_PACK), 'observability-pack');
  assert.notEqual(detectArtefactKind('.observability/rules.yaml', RULES_YAML), 'observability-pack', 'a non-pack file under .observability keeps its own kind');
  const { canonical, summary, evidence } = crawlFiles(files, { repoName: 'shop-api', environment: 'prod', now: '2026-11-06T00:00:00.000Z' });
  assert.deepEqual(validateCanonical(canonical, SCHEMA), []);
  const list = canonical.spec.validation.chaos_experiments;
  assert.deepEqual(list.map(e => e.id), ['slow-checkout', 'payment-errors', 'ramp-up', 'api-pod-kill', 'region-failover']);
  // the declared ramp-up replaced the discovered one, last_result and all; its field marks went with it
  const ramp = list.find(e => e.id === 'ramp-up');
  assert.equal(ramp.last_result.outcome, 'pass');
  const ann = canonical.metadata.annotations;
  assert.ok(!Object.keys(ann).some(k => k.startsWith('crawler.scaffold.validation.chaos_experiments.ramp-up')), 'no mark survives on a declared entry');
  assert.ok(ann['crawler.scaffold.validation.chaos_experiments.payment-errors.steady_state_hypothesis']);
  assert.equal(evidence['validation.chaos_experiments.ramp-up'], '.observability/pack.yaml#spec.validation.chaos_experiments.ramp-up');
  assert.equal(evidence['validation.chaos_experiments.slow-checkout'], 'src/chaos/faults.ts#FAULTS.slow-checkout');
  assert.equal(evidence['validation.chaos_experiments.api-pod-kill'], 'k8s/chaos/mesh.yaml#PodChaos/api-pod-kill');
  const discovered = JSON.parse(ann['crawler.discovered.chaos_experiments']);
  assert.deepEqual(discovered.find(d => d.id === 'ramp-up'), { id: 'ramp-up', engine: 'in-process', source: '.observability/pack.yaml#spec.validation.chaos_experiments.ramp-up', from: 'repo-pack', replaces: 'src/chaos/faults.ts#FAULTS.ramp-up' });
  assert.equal(ann['crawler.chaos.disabled'], 'api.chaos.enabled: false (deploy/helm/values-prod.yaml)');
  assert.match(ann['crawler.chaos.control'], /^API \/chaos\/start\|stop\|status, gated by the X-Chaos-Key header/);
  assert.equal(summary.files.byKind['observability-pack'], 1);
  assert.equal(summary.discovered.chaosExperiments, 5);
  assert.deepEqual(summary.discovered.chaosSources, ['.observability/pack.yaml', 'k8s/chaos/mesh.yaml', 'src/chaos/faults.ts']);
  assert.ok(summary.warnings.some(w => /\.observability\/pack\.yaml: chaos experiment Not A Slug is not a valid spec 1\.5 experiment and is left out/.test(w)));
  assert.ok(summary.warnings.some(w => /5 chaos experiment\(s\) in spec\.validation\.chaos_experiments \(2 from code, 1 from Chaos Mesh \/ Litmus resources, 2 declared in \.observability\/\)/.test(w)), 'ramp-up now counts as declared, not as code');
  assert.ok(summary.warnings.some(w => /switched off in this environment \(api\.chaos\.enabled: false/.test(w)));
  // the adapter reads them as Declared — never Scaffold — experiments
  const chaosCards = adapt(canonical).layers.L5.filter(a => /^CHAOS-/.test(a.id));
  assert.deepEqual(chaosCards.map(a => [a.title, a.source]), list.map(e => [e.id, 'Declared']));
});

test('a repository with no chaos gains no chaos key, and the tier reads chaos only on top of tier-2', () => {
  const plain = crawlFiles({ 'deploy/prometheus/checkout.rules.yaml': RULES_YAML }, { repoName: 'shop-api', now: '2026-11-06T00:00:00.000Z' });
  assert.equal('chaos_experiments' in plain.canonical.spec.validation, false);
  assert.ok(!Object.keys(plain.canonical.metadata.annotations).some(k => /chaos/.test(k)));
  const withChaos = crawlFiles(repoFiles(), { repoName: 'shop-api', now: '2026-11-06T00:00:00.000Z' });
  assert.equal(withChaos.summary.inferred.tier, plain.summary.inferred.tier, 'chaos alone, without rules, dashboards and routes, does not raise the tier');
  assert.notEqual(withChaos.summary.inferred.tier, 'tier-1');
});

test('the GitHub / ADO file rule fetches chaos code and the repository pack', () => {
  for (const p of ['server/middleware/chaos.ts', 'src/chaos/faults.ts', '.observability/pack.yaml', 'svc/.observability/chaos.yml']) assert.equal(isCrawlerFile(p), true, p);
  assert.equal(isCrawlerFile('src/chaos.test.ts'), false, 'tests stay out');
  const picked = selectCrawlerFiles([{ type: 'blob', path: '.observability/pack.yaml' }, { type: 'blob', path: 'server/middleware/chaos.ts' }, { type: 'blob', path: 'README.md' }]);
  assert.deepEqual(picked.map(n => n.path), ['.observability/pack.yaml', 'server/middleware/chaos.ts']);
});

// ---------------------------------------------------------------------------
// the doors and the screens (the 0.8.7 walkthrough)
// ---------------------------------------------------------------------------

// j6-13: the Expert panel sent only the files the browser classified as artefacts, so the chaos
// controller, its middleware and a scenario script never reached the chaos pass; an Overview Run of
// the same folder found every experiment. The door now sends what crawler.mjs scanUsesFile names.
test('scanUsesFile: a door that sends only the files the scan uses gets the whole folder\'s experiments; artefacts alone lose them', () => {
  assert.equal(chaosPassReads('server/monitor/chaos-controller.ts', 'export const x = 1;'), true, 'a chaos code path');
  assert.equal(chaosPassReads('server/routes.ts', "router.post('/api/chaos/start', start);"), true, 'code that serves the chaos API');
  assert.equal(chaosPassReads('k8s/pod-kill.yaml', 'apiVersion: chaos-mesh.org/v1alpha1\nkind: PodChaos\n'), true, 'a Chaos Mesh resource');
  assert.equal(chaosPassReads('docs/chaos.md', '# chaos'), false, 'not code, not a resource');
  assert.equal(chaosPassReads('src/app.ts', 'export const x = 1;'), false);
  assert.equal(chaosPassReads('src/chaos/faults.ts', null), false, 'no content, nothing read');
  const files = repoFiles({
    'k8s/chaos/mesh.yaml': MESH_YAML.split('---')[0],
    'src/app.ts': 'export const port = 8080;\n',
    'README.md': '# shop-api\nRun chaos with npm run chaos.\n',
  });
  const crawl = (subset) => crawlFiles(subset, { repoName: 'shop-api', environment: 'prod', now: '2026-11-06T00:00:00.000Z' }).canonical;
  const sent = Object.fromEntries(Object.entries(files).filter(([p, c]) => scanUsesFile(p, c)));
  assert.deepEqual(Object.keys(sent).sort(), Object.keys(files).filter(p => !['src/app.ts', 'README.md'].includes(p)).sort(), 'the controller and its routes go; plain code and docs stay');
  const whole = crawl(files);
  const chaosAnnotations = (c) => Object.fromEntries(Object.entries(c.metadata.annotations).filter(([k]) => /chaos/.test(k)));
  assert.deepEqual(crawl(sent).spec.validation.chaos_experiments, whole.spec.validation.chaos_experiments);
  assert.deepEqual(chaosAnnotations(crawl(sent)), chaosAnnotations(whole), 'the same marks, control and toggle notes');
  const artefactsOnly = Object.fromEntries(Object.entries(files).filter(([p, c]) => detectArtefactKind(p, c) !== 'unknown'));
  const lost = (crawl(artefactsOnly).spec.validation.chaos_experiments || []).map(e => e.id);
  assert.ok(!lost.includes('slow-checkout') && !lost.includes('payment-errors'), 'the old filter lost the in-process scenarios');
  assert.equal(scanUsesFile('src/chaos/faults.ts', SCENARIO_TS, 'unknown'), true, 'a caller\'s kind saves the second classification');
});

// j2-107: latency-spike's ref:slos.slo_latency_99 and alert:HighLatencyP99 were listed as broken
// although the pack declares both. The rule (studio/symbol-refs.mjs) reads `ref:slos.x` as the
// symbol `slos.x` and any alert name as resolved, CamelCase included; the scan's placeholder for
// an alert the code never names stays unresolved, because it names none.
test('a scanned experiment\'s references resolve in its own pack; only the "no alert named" placeholder stays unresolved', () => {
  assert.equal(UNRESOLVED_ALERT_PLACEHOLDER, UNRESOLVED_EXPECTED_ALERT, 'the studio mirrors the scan\'s placeholder (a live studio module never imports tools/lib)');
  assert.equal(refSymbol('ref:slos.a'), 'slos.a');
  assert.equal(refSymbol('ref:platform/base'), 'ref:platform/base', 'an import keeps its form');
  const defined = new Set(['slos.a', 'slis.a']);
  for (const [ref, want] of [
    ['ref:slos.a', true], ['slos.a', true], ['ref:slis.a', true], ['ref:slos.nope', false], ['slos.nope', false],
    ['alert:HighLatencyP99', true], ['alert:checkout-latency', true], [`alert:${UNRESOLVED_EXPECTED_ALERT}`, false], ['alert:', false],
    ['ref:platform/base-pack', true], ['', true], [null, true],
  ]) assert.equal(refResolves(ref, defined), want, String(ref));
  // The prod scope of a Helm repository reads Kubernetes paths only, so the rules sit under k8s/.
  const { canonical } = crawlFiles(repoFiles({ 'k8s/monitoring/checkout.rules.yaml': RULES_YAML }), { repoName: 'shop-api', environment: 'prod', now: '2026-11-06T00:00:00.000Z' });
  const pack = adapt(canonical);
  const all = Object.values(pack.layers).flatMap(v => (Array.isArray(v) ? v : Object.values(v).flat()));
  const symbols = new Set(all.map(a => a.defines).filter(Boolean));
  const unresolved = (card) => (card.refs || []).filter(r => !refResolves(r, symbols));
  const cards = pack.layers.L5.filter(a => /^CHAOS-/.test(a.id));
  const byTitle = Object.fromEntries(cards.map(c => [c.title, c]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['payment-errors', 'ramp-up', 'slow-checkout']);
  assert.ok(byTitle['slow-checkout'].refs.some(r => /^ref:slos\./.test(r)) && byTitle['slow-checkout'].refs.includes('alert:CheckoutLatencyHigh'), 'the spec Ref form and a CamelCase alert', byTitle['slow-checkout'].refs);
  assert.deepEqual(unresolved(byTitle['slow-checkout']), []);
  assert.deepEqual(unresolved(byTitle['payment-errors']), []);
  assert.deepEqual(unresolved(byTitle['ramp-up']), [`alert:${UNRESOLVED_EXPECTED_ALERT}`], 'the code names no alert for ramp-up');
});

// j3-72: Diagnose's gap card said "No chaos experiment is declared" beside its own evidence line
// "5 chaos experiments declared, never recorded as run". The copy (studio/chaos-copy.mjs) follows
// the engine's proof, state by state.
test('the Diagnose blocker for Chaos-validated is worded from the proof: none, declared, stale, failed, part-proven', () => {
  const nowMs = Date.parse('2026-11-06T12:00:00Z');
  const ago = (days) => new Date(nowMs - days * 86400e3).toISOString();
  const exp = (id, last_result) => ({ id, schedule: 'weekly', expected_alerts: ['HighLatencyP99'], expected_mttd: '6m', ...(last_result ? { last_result } : {}) });
  const copyFor = (experiments, extra = {}) => chaosBlockerCopy({ proof: chaosProof(experiments, { nowMs }), declared: experiments.length, ...extra });
  assert.deepEqual(copyFor([]), {}, 'none, on a pack nobody scanned: the generic "declare one" copy stands');
  assert.match(copyFor([], { fromScan: true }).fix, /found no chaos experiment: no scenario table in code, no Chaos Mesh or Litmus resource, nothing in \.observability\/\*\.yaml/);
  assert.match(copyFor([], { fromScan: true, unobserved: { repository: 'the repository scan has no chaos-experiment detector' } }).fix, /could not read chaos experiments\. Scan the repository again/);
  const declared = copyFor([exp('latency-spike'), exp('error-burst')], { fromScan: true });
  assert.equal(declared.title, 'No chaos experiment has a recorded run');
  assert.doesNotMatch(`${declared.title} ${declared.why} ${declared.fix}`, /No chaos experiment is declared|only when the pack declares/);
  assert.match(declared.why, /earns a quarter of this check/);
  assert.match(declared.fix, /^Run the experiments, then record each run in the repository as the experiment’s last_result in \.observability\/pack\.yaml/);
  assert.match(copyFor([exp('a')]).fix, /^Run the experiments, then record each run as the experiment’s last_result, or let the live check read the chaos run feed\.$/, 'a pack nobody scanned records it where it is');
  assert.equal(copyFor([exp('a', { at: ago(20), outcome: 'pass' })]).title, 'The last chaos pass is too old');
  assert.equal(copyFor([exp('a', { at: ago(1), outcome: 'fail', alerts_fired: [] })]).title, 'A chaos experiment failed its last run');
  const part = copyFor([exp('a', { at: ago(1), outcome: 'pass' }), exp('b')]);
  assert.equal(part.title, 'Not every chaos experiment has a recent pass');
  assert.match(part.fix, /^Run the remaining experiments\. Record each run as/);
  assert.equal(chaosBlockerCopy({ declared: 2 }).title, 'No chaos experiment has a recorded run', 'a criterion without proof (an older engine) reads its count');
});
