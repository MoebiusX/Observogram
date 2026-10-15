#!/usr/bin/env node
// tools/test-remediation-flow.mjs — the diagnose → remediate flow engine (GAP batch 2, B3.3;
// tools/lib/remediation-flow.mjs).
//
// The linking rule: a remediation's trigger resolves to the alert artefacts it means through
// four tiers — the `observogram.remediates.*` annotation, the rule name, a compiled burn-rule
// name (cross-checked here against the names tools/lib/compile.mjs really emits), the SLO — the
// first tier with a hit wins, an exact slug match never a containment, and no hit is `unresolved`
// with suggestions that never link. The catalogue is pinned as it stands: 17 remediations across
// five packs, zero triggers resolve today (docs/DOWNSTREAM.md §14 `catalogue-triggers`), the
// three packs without a remediation are unconfigured and empty — the inert proof. States come
// from the comparison's buckets indexed by each entry's artefact (a real `…@a#01` scaffold key and
// a `#02` occurrence key never parsed), the unhealthy list from the live side's annotations, and
// a Scaffold remediation (the legacy upconvert's) is a placeholder with template values. Pure
// module under node:test; paths through fileURLToPath, nothing platform-specific.
//
// Run: node --test tools/test-remediation-flow.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { identityKeyOf } from './lib/artefact-model.mjs';
import { compilePrometheusRules } from './lib/compile.mjs';
import { compileTaxonomy, configureTaxonomy } from './lib/artefact-classify.mjs';
import { upconvertLegacyPack } from './lib/legacy.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { purityViolations } from './gen-vendor-manifest.mjs';
import {
  BLOCKING_STATES, FLOW_STATES, LINK_TIERS, MAX_SUGGESTIONS, OTHER_SIDES, REMEDIATES_ANNOTATION_PREFIX, STEP_KINDS,
  alertStatesFromDiff, buildRemediationFlowModel, burnRuleNames, remediationTargets, resolveTrigger, slugKey, triggerSlug,
} from './lib/remediation-flow.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(ROOT, ...p.split('/'));
const read = (p) => readFileSync(rel(p), 'utf8');
const loadPack = (p) => (p.endsWith('.json') ? JSON.parse(read(p)) : parseYaml(read(p)));
const clone = (x) => JSON.parse(JSON.stringify(x));

const PAYMENT_PATH = `${SPEC_SCHEMA_PATH.replace(/\/[^/]+$/, '')}/examples/payment-service.pack.yaml`;
const CATALOGUE = [
  PAYMENT_PATH, 'examples/demo-skeleton.pack.yaml', 'examples/production-curated.pack.yaml', 'examples/target-advanced.pack.yaml',
  'examples/krystaline-repo-carlos.pack.yaml',
  ...readdirSync(rel('reference-packs')).filter(f => f.endsWith('.pack.yaml')).sort().map(f => `reference-packs/${f}`),
];
const payment = () => loadPack(PAYMENT_PATH);
const TYPED = 'tools/fixtures/taxonomy/typed.pack.json';
const OVERRIDE = JSON.parse(read('tools/fixtures/taxonomy/taxonomy.json'));

/** payment-service with its three triggers replaced (and any other canonical edit applied). */
function paymentWith(triggers, edit = () => {}) {
  const c = payment();
  c.spec.remediation.forEach((r, i) => { if (triggers[i] !== undefined) r.trigger = triggers[i]; });
  edit(c);
  return c;
}
const linksOf = (m) => m.links.map(l => [l.remediation.symbol, l.tier, l.alerts.map(a => a.ref.id)]);

// ---------- 1. names ----------

test('the vocabulary: four tiers in precedence order, the eight states, the step kinds, both other sides; slugKey strips every non-alphanumeric and triggerSlug the ref:/alert: prefixes case-insensitively', () => {
  assert.deepEqual([...LINK_TIERS], ['annotation', 'rule-name', 'burn-name', 'slo']);
  assert.deepEqual([...FLOW_STATES], ['declared', 'live', 'drifted', 'missing', 'unhealthy', 'unverified', 'placeholder', 'uncompared']);
  for (const s of BLOCKING_STATES) assert.ok(FLOW_STATES.includes(s));
  assert.deepEqual([...STEP_KINDS], ['deploy-alert', 'fix-alert', 'reconcile-alert', 'complete-alert', 'route', 'register-automation', 'human', 'runbook', 'automation', 'guardrails', 'annotate']);
  assert.deepEqual([...OTHER_SIDES], ['live', 'baseline']);
  assert.equal(REMEDIATES_ANNOTATION_PREFIX, 'observogram.remediates.');
  assert.equal(MAX_SUGGESTIONS, 3);
  assert.equal(slugKey('High-Error Rate_v2'), 'higherrorratev2');
  assert.equal(slugKey(null), '');
  assert.equal(triggerSlug('alert:HighErrorRate'), 'higherrorrate');
  assert.equal(triggerSlug('ref:Alert:payment-api-pod-oom'), 'paymentapipodoom');
  assert.equal(triggerSlug(' ALERT:x '), 'x');
  assert.equal(triggerSlug(42), '');
});

test('burnRuleNames follows the compiler\'s formula — <slo>_burn_<factor>x_<short>_<long>, non-word runs to `_`, factor 1 by default, ref:/slos. stripped — and every burn alert compilePrometheusRules emits for payment-service is one of them', () => {
  assert.deepEqual(burnRuleNames({ slo: 'ref:slos.api_99', windows: [{ short: '5m', long: '1h', factor: 14.4 }, { short: '30m', long: '6h' }] }), ['api_99_burn_14_4x_5m_1h', 'api_99_burn_1x_30m_6h']);
  assert.deepEqual(burnRuleNames({ slo: 'x' }), []);
  assert.deepEqual(burnRuleNames(null), []);
  const canonical = payment();
  const pack = adapt(canonical);
  const computed = new Set(remediationTargets(pack).alerts.filter(a => a.family === 'burn_rate').flatMap(a => a.names));
  const doc = parseYaml(compilePrometheusRules(canonical));
  const emitted = doc.groups.flatMap(g => g.rules).filter(r => r.alert && r.labels?.burn_rate).map(r => r.alert);
  assert.ok(emitted.length >= 10, `payment-service compiles ${emitted.length} burn alerts`);
  for (const name of emitted) assert.ok(computed.has(name), `${name} is a name the engine predicts`);
  assert.equal(computed.size, emitted.length, 'and the engine predicts no name the compiler does not emit for this pack');
});

// ---------- 2. the linking rule ----------

test('T1 rule-name: the typed fixture under the override taxonomy links heal-rollout-restart (alert:HighErrorRate) to the PrometheusRule HighErrorRate by its name — exact slug, never containment; symbols are positional within the family', () => {
  configureTaxonomy(compileTaxonomy(OVERRIDE));
  try {
    const typed = loadPack(TYPED);
    const m = buildRemediationFlowModel({ pack: typed });
    assert.equal(m.configured, true);
    assert.equal(m.compared, false);
    assert.deepEqual(m.counts, { remediations: 1, alerts: 3, linked: 1, unresolved: 0, uncovered: 2, blocked: 0, suggestions: 0, placeholder: 0 });
    assert.deepEqual(linksOf(m), [['remediation[0]', 'rule-name', ['promrule-HighErrorRate']]]);
    const link = m.links[0];
    assert.equal(link.remediation.id, 'heal-rollout-restart');
    assert.equal(link.alerts[0].ref.symbol, 'alerting.rules[0]');
    assert.equal(link.alerts[0].ref.identityKey, identityKeyOf(typed.layers.L4.alerting.find(a => a.id === 'promrule-HighErrorRate')));
    assert.equal(link.alerts[0].state, 'declared');
    assert.equal(link.state, 'uncompared');
    assert.deepEqual(link.routes.map(r => r.id), ['route-sev2-chat'], 'SEV2 reaches the chat route');
    assert.deepEqual(link.steps.map(s => s.kind), ['route', 'human', 'runbook']);
    assert.equal(link.steps[1].text, 'Manual remediation (kubectl rollout restart deploy/checkout): a human runs the runbook; nothing fires automatically.');
    assert.equal(link.steps[2].href, null, 'a relative runbook path is text, not a link');
    // Containment is not a match: a rule named HighErrorRateV2 does not answer to alert:HighErrorRate.
    const renamed = clone(typed);
    renamed.layers.L4.alerting.find(a => a.id === 'promrule-HighErrorRate').spec.name = 'HighErrorRateV2';
    renamed.layers.L4.alerting.find(a => a.id === 'promrule-HighErrorRate').title = 'HighErrorRateV2';
    const m2 = buildRemediationFlowModel({ pack: renamed });
    assert.equal(m2.counts.linked, 0);
    assert.equal(m2.unresolved.length, 1);
  } finally {
    configureTaxonomy(null);
  }
});

test('T2 burn-name and T3 slo: a trigger naming a compiled burn rule links the burn alert, a trigger naming the SLO (any separators) links its burn alert; the first tier with a hit wins (rule name over SLO), every hit of that tier links, and a slugged 14.4 reads 14_4x', () => {
  const m = buildRemediationFlowModel({ pack: adapt(paymentWith(['alert:api_availability_99_9_burn_14x_5m_1h', 'alert:Checkout-Latency-99-5-P99-300ms', 'alert:PaymentDbConnectionPoolSaturated'])) });
  assert.deepEqual(linksOf(m), [
    ['remediation[0]', 'burn-name', ['POL-01']],
    ['remediation[1]', 'slo', ['POL-02']],
    ['remediation[2]', 'rule-name', ['RULE-02']],
  ]);
  assert.equal(m.links[0].alerts[0].ref.symbol, 'policy.burn_rate_alerts[0]');
  assert.equal(m.links[2].alerts[0].ref.symbol, 'alerting.rules[1]');
  assert.deepEqual(m.counts, { remediations: 3, alerts: 8, linked: 3, unresolved: 0, uncovered: 5, blocked: 0, suggestions: 0, placeholder: 0 });
  // Precedence: a rule named like an SLO wins over the SLO's burn alert; a second rule with the same slug links too.
  const both = paymentWith(['alert:api-availability-99-9'], (c) => {
    c.spec.alerting.rules[0].name = 'ApiAvailability999';
    c.spec.alerting.rules.push({ ...clone(c.spec.alerting.rules[1]), name: 'api_availability_99_9' });
  });
  const mb = buildRemediationFlowModel({ pack: adapt(both) });
  assert.deepEqual(linksOf(mb)[0], ['remediation[0]', 'rule-name', ['RULE-01', 'RULE-04']]);
  // 14.4 → 14_4x in the compiled name, and the trigger that quotes it resolves.
  const frac = paymentWith(['alert:api_availability_99_9_burn_14_4x_5m_1h'], (c) => { c.spec.policy.burn_rate_alerts[0].windows[0].factor = 14.4; });
  assert.deepEqual(linksOf(buildRemediationFlowModel({ pack: adapt(frac) }))[0], ['remediation[0]', 'burn-name', ['POL-01']]);
});

test('T0 annotation beats every name: observogram.remediates.remediation[<i>] names alerting.rules[j], policy.burn_rate_alerts[j], slos.<id> (every burn alert of the SLO) or alert:<slug>; a symbol resolving to nothing is a warning, an annotation resolving to nothing at all falls through to the names', () => {
  const ann = paymentWith(['alert:PaymentDbConnectionPoolSaturated', 'alert:nothing-here', 'alert:nothing-either'], (c) => {
    c.metadata.annotations = {
      ...(c.metadata.annotations || {}),
      'observogram.remediates.remediation[0]': 'policy.burn_rate_alerts[0], slos.checkout_latency_99_5_p99_300ms, alert:PaymentServicePodRestarting, alerting.rules[99], slos.nope',
      'observogram.remediates.remediation[1]': 'alerting.rules[2]',
      'observogram.remediates.remediation[2]': 'nope.symbol',
    };
  });
  const m = buildRemediationFlowModel({ pack: adapt(ann) });
  assert.deepEqual(linksOf(m), [
    ['remediation[0]', 'annotation', ['POL-01', 'POL-02', 'RULE-01']],
    ['remediation[1]', 'annotation', ['RULE-03']],
  ]);
  assert.deepEqual(m.unresolved.map(u => u.remediation.symbol), ['remediation[2]']);
  assert.deepEqual(m.warnings, [
    'remediation[0]: observogram.remediates.remediation[0] names alerting.rules[99], which resolves to no alert of this pack',
    'remediation[0]: observogram.remediates.remediation[0] names slos.nope, which resolves to no alert of this pack',
    'remediation[2]: observogram.remediates.remediation[2] names nope.symbol, which resolves to no alert of this pack',
  ]);
  // The annotation wins over the rule name the trigger would have met (remediation[0] no longer links RULE-02).
  assert.ok(!m.links[0].alerts.some(a => a.ref.id === 'RULE-02'));
  // resolveTrigger alone, for a reader that holds the targets.
  const targets = remediationTargets(adapt(ann));
  const warnings = [];
  const r = resolveTrigger(targets.remediations[2], targets, { annotations: ann.metadata.annotations, warnings });
  assert.equal(r.tier, null);
  assert.deepEqual(r.alerts, []);
  assert.equal(warnings.length, 1);
});

test('conservation: every remediation is a link or unresolved exactly once, every alert is covered by a link or listed uncovered exactly once, the counts are those lengths, and the families sum to the alerts', () => {
  for (const triggers of [[], ['alert:api_availability_99_9_burn_14x_5m_1h', 'alert:PaymentServicePodRestarting'], ['alert:api-availability-99-9', 'alert:api-availability-99-9', 'alert:PaymentCertificateExpiringSoon']]) {
    const pack = adapt(paymentWith(triggers));
    const m = buildRemediationFlowModel({ pack });
    const remediations = [...m.links.map(l => l.remediation.symbol), ...m.unresolved.map(u => u.remediation.symbol)].sort();
    assert.deepEqual(remediations, ['remediation[0]', 'remediation[1]', 'remediation[2]']);
    const covered = new Set(m.links.flatMap(l => l.alerts.map(a => a.ref.symbol)));
    const uncovered = m.uncovered.map(u => u.ref.symbol);
    assert.equal(covered.size + uncovered.length, m.counts.alerts);
    for (const u of uncovered) assert.ok(!covered.has(u), `${u} is uncovered and not linked`);
    assert.equal(m.counts.linked, m.links.length);
    assert.equal(m.counts.unresolved, m.unresolved.length);
    assert.equal(m.counts.uncovered, m.uncovered.length);
    assert.equal(m.counts.suggestions, m.unresolved.reduce((n, u) => n + u.suggestions.length, 0));
    assert.equal(m.families.reduce((n, f) => n + f.alerts, 0), m.counts.alerts);
    assert.equal(m.families.reduce((n, f) => n + f.covered, 0), covered.size);
    assert.deepEqual(m.families.map(f => f.family), ['burn_rate', 'alert_rule']);
  }
});

// ---------- 3. the catalogue as it stands ----------

test('the catalogue pin: 17 remediations across five packs and not one trigger resolves today (every remediation unresolved, zero links, zero blocked, every alert uncovered); the three packs without a remediation are unconfigured and empty', () => {
  const totals = { remediations: 0, linked: 0, unresolved: 0 };
  const configured = [];
  for (const p of CATALOGUE) {
    const pack = adapt(loadPack(p));
    const m = buildRemediationFlowModel({ pack });
    if (!pack.layers.L4.healing.length) {
      assert.equal(m.configured, false, `${pack.id} declares no remediation`);
      assert.deepEqual(m, { configured: false, compared: false, otherSide: 'live', counts: { remediations: 0, alerts: 0, linked: 0, uncovered: 0, unresolved: 0, blocked: 0, suggestions: 0, placeholder: 0 }, links: [], unresolved: [], uncovered: [], families: [], warnings: [] });
      continue;
    }
    configured.push(pack.id);
    assert.equal(m.configured, true);
    assert.equal(m.counts.linked, 0, `${pack.id}: no trigger resolves`);
    assert.equal(m.counts.blocked, 0);
    assert.equal(m.counts.placeholder, 0);
    assert.equal(m.counts.unresolved, m.counts.remediations);
    assert.equal(m.counts.uncovered, m.counts.alerts);
    assert.deepEqual(m.warnings, []);
    totals.remediations += m.counts.remediations; totals.linked += m.counts.linked; totals.unresolved += m.counts.unresolved;
  }
  assert.deepEqual(configured, ['payment-service', 'platform-edge', 'grafana', 'kafka', 'prometheus']);
  assert.deepEqual(totals, { remediations: 17, linked: 0, unresolved: 17 });
});

test('suggestion calibration, by pack file: shared name tokens with the service/pack name dropped, two shared or a unique single, at most three, in walk order — payment-service names RULE-03 for the cert trigger alone, target-advanced POL-04 and POL-03, grafana, kafka and prometheus as measured; a suggestion never links', () => {
  const suggest = (p) => buildRemediationFlowModel({ pack: adapt(loadPack(p)) }).unresolved.map(u => u.suggestions.map(s => `${s.ref.id}(${s.shared.join(',')})`));
  assert.deepEqual(suggest(PAYMENT_PATH), [[], [], ['RULE-03(cert~,expiring)']]);
  assert.deepEqual(suggest('examples/target-advanced.pack.yaml'), [['POL-04(upstream)'], ['POL-03(cache)']]);
  assert.deepEqual(suggest('reference-packs/grafana.pack.yaml'), [[], ['POL-03(datasource,proxy)', 'POL-04(datasource,proxy)'], [], ['POL-08(login,success)']]);
  assert.deepEqual(suggest('reference-packs/kafka.pack.yaml'), [['POL-01(broker)'], ['POL-02(partition)'], ['POL-05(consumer,lag)'], ['POL-06(controller)']]);
  assert.deepEqual(suggest('reference-packs/prometheus.pack.yaml'), [[], ['POL-04(rule,eval~)'], ['POL-08(tsdb,compaction)'], ['POL-03(wal)']]);
  const m = buildRemediationFlowModel({ pack: adapt(payment()) });
  const u = m.unresolved[2];
  assert.equal(u.steps[0].kind, 'annotate');
  assert.equal(u.steps[0].annotation, 'observogram.remediates.remediation[2]');
  assert.equal(u.steps[0].example, 'alerting.rules[2]');
  assert.match(u.steps[0].text, /metadata\.annotations\["observogram\.remediates\.remediation\[2\]"\] = "alerting\.rules\[2\]"/);
  assert.equal(m.counts.linked, 0, 'a suggestion is not a link');
  for (const s of u.suggestions) assert.ok(s.score >= 1 && s.score === s.shared.length);
});

// ---------- 4. states from the comparison ----------

test('states from a real diff: declared without one, live when aligned, drifted with the delta fields, missing when only declared, unhealthy when the live side lists the name; the path\'s state is its worst alert and blocked follows; the copy names the other side', () => {
  const a = adapt(paymentWith(['alert:api_availability_99_9_burn_14x_5m_1h', 'alert:PaymentServicePodRestarting', 'alert:PaymentDbConnectionPoolSaturated']));
  const bCanonical = payment();
  bCanonical.spec.alerting.rules[0].for = '30m';                 // RULE-01 drifts
  bCanonical.spec.alerting.rules.splice(1, 1);                   // RULE-02 is declared, not live
  const b = adapt(bCanonical);
  const declared = buildRemediationFlowModel({ pack: a });
  assert.equal(declared.compared, false);
  assert.deepEqual(declared.links.map(l => [l.state, l.alerts.map(x => x.state)]), [['uncompared', ['declared']], ['uncompared', ['declared']], ['uncompared', ['declared']]]);
  assert.equal(declared.counts.blocked, 0);
  assert.deepEqual(declared.links[0].steps.map(s => s.kind), ['route', 'route', 'register-automation', 'human', 'runbook', 'guardrails'], 'nothing to deploy or fix without a comparison');

  const diff = diffPacks(a, b);
  const m = buildRemediationFlowModel({ pack: a, diff, liveAnnotations: { 'mcp.discovered.alert_rules_unhealthy': 'api_availability_99_9_burn_14x_5m_1h,other' } });
  assert.equal(m.compared, true);
  assert.deepEqual(m.links.map(l => [l.remediation.id, l.state, l.blocked, l.alerts.map(x => `${x.ref.id}:${x.state}`)]), [
    ['HEAL-01', 'unhealthy', true, ['POL-01:unhealthy']],
    ['HEAL-02', 'drifted', true, ['RULE-01:drifted']],
    ['HEAL-03', 'missing', true, ['RULE-02:missing']],
  ]);
  assert.deepEqual(m.links[1].alerts[0].deltas, ['for']);
  assert.equal(m.counts.blocked, 3);
  assert.deepEqual(m.uncovered.map(u => `${u.ref.id}:${u.state}`), ['POL-02:live', 'POL-03:live', 'POL-04:live', 'POL-05:live', 'RULE-03:live']);
  assert.equal(m.links[0].steps[0].kind, 'fix-alert');
  assert.match(m.links[0].steps[0].text, /live but not evaluating/);
  assert.equal(m.links[1].steps[0].kind, 'reconcile-alert');
  assert.match(m.links[1].steps[0].text, /differs live \(for\)/);
  assert.equal(m.links[2].steps[0].kind, 'deploy-alert');
  assert.equal(m.links[2].steps[0].action, null, 'an alert rule is not a compiled artefact: no deploy action');
  assert.match(m.links[2].steps[0].text, /declared, not live/);
  // The other side as a baseline: the same states, the copy says so.
  const gap = buildRemediationFlowModel({ pack: a, diff, otherSide: 'baseline' });
  assert.equal(gap.otherSide, 'baseline');
  assert.equal(gap.links[0].state, 'live', 'no unhealthy list from a baseline');
  assert.match(gap.links[2].steps[0].text, /declared, not in the baseline/);
  assert.equal(buildRemediationFlowModel({ pack: a, otherSide: 'nope' }).otherSide, 'live');
  // An errored diff is no comparison.
  assert.equal(buildRemediationFlowModel({ pack: a, diff: { error: 'boom' } }).compared, false);
  assert.equal(alertStatesFromDiff({ error: 'x', layers: {} }), null);
  assert.equal(alertStatesFromDiff(null), null);
});

test('a missing burn alert carries the deploy action for its SLO (identity, the SLO artefact, 2 rule rows); states are read from the entry\'s artefact — a hand-built diff with a `…@a#01` scaffold key, a `#02` occurrence key and a notObserved entry yields placeholder, live, unverified; an entry without an artefact falls back to its key string', () => {
  const a = adapt(paymentWith(['alert:api_availability_99_9_burn_14x_5m_1h', 'alert:PaymentServicePodRestarting', 'alert:checkout_latency_99_5_p99_300ms']));
  const bCanonical = payment();
  bCanonical.spec.policy.burn_rate_alerts.splice(0, 1);          // POL-01 is declared, not live
  const m = buildRemediationFlowModel({ pack: a, diff: diffPacks(a, adapt(bCanonical)) });
  assert.equal(m.links[0].state, 'missing');
  const step = m.links[0].steps[0];
  assert.equal(step.kind, 'deploy-alert');
  assert.deepEqual(step.action, { type: 'deploy', identity: 'api_availability_99_9', artefactId: 'SLO-01', symbol: 'slos.api_availability_99_9', rows: 2 });
  assert.equal(step.alert, 'policy.burn_rate_alerts[0]');
  assert.match(step.text, /Deploy the burn-rate rules of api_availability_99_9/);

  const pol1 = a.layers.L4.policy[0];
  const rule1 = a.layers.L4.alerting.find(x => x.id === 'RULE-01');
  const pol2 = a.layers.L4.policy[1];
  const hand = { summary: {}, layers: { L4: {
    scaffold: [{ key: `${identityKeyOf(pol1)}@a#01`, side: 'a', artefact: { ...pol1, source: 'Scaffold' } }, { key: 'x@b#01', side: 'b', artefact: pol2 }],
    inBoth: [{ key: `${identityKeyOf(rule1)}#02`, a: rule1, b: rule1, match: 'aligned', deltas: [] }],
    notObserved: [{ key: identityKeyOf(pol2), side: 'a', artefact: pol2, reason: 'not scanned' }],
    onlyInA: [{ key: 'burn_rate::{"orphan":true}' }],
    onlyInB: [], outOfScope: [],
  } } };
  const states = alertStatesFromDiff(hand);
  assert.equal(states.get(identityKeyOf(pol1)).state, 'placeholder');
  assert.equal(states.get(identityKeyOf(rule1)).state, 'live');
  assert.equal(states.get(identityKeyOf(pol2)).state, 'unverified', 'the b-side scaffold does not overwrite a\'s notObserved');
  assert.equal(states.get('burn_rate::{"orphan":true}').state, 'missing', 'no artefact: the key string, suffix stripped');
  const hm = buildRemediationFlowModel({ pack: a, diff: hand });
  assert.deepEqual(hm.links.map(l => [l.state, l.alerts[0].state]), [['placeholder', 'placeholder'], ['live', 'live'], ['unverified', 'unverified']], 'the comparison parked the a-side artefact as a scaffold, so the path reads placeholder');
  assert.equal(hm.links[0].steps[0].kind, 'complete-alert');
  assert.equal(hm.counts.blocked, 1, 'a placeholder blocks, an unverified alert does not');
  const scaffoldA = clone(a); scaffoldA.layers.L4.policy[0].source = 'Scaffold';
  assert.equal(buildRemediationFlowModel({ pack: scaffoldA }).links[0].state, 'placeholder', 'a Scaffold alert is a placeholder without a comparison too');
  assert.equal(buildRemediationFlowModel({ pack: scaffoldA, diff: diffPacks(scaffoldA, a) }).links[0].alerts[0].state, 'placeholder');
});

// ---------- 5. steps ----------

test('steps: a severity without a route warns, one with routes names them; a URI automation registers, a non-URI one (manual-only) is one human step and no register-automation; requires_human_above is a human step; the runbook has an href for https only; the guardrails read as one line', () => {
  const c = paymentWith(['alert:PaymentServicePodRestarting', 'alert:PaymentDbConnectionPoolSaturated', 'alert:PaymentCertificateExpiringSoon'], (x) => {
    x.spec.alerting.routes = x.spec.alerting.routes.filter(r => r.severity !== 'SEV3');
    x.spec.remediation[1].automation = 'manual-only';
    x.spec.remediation[1].runbook = 'https://runbooks.example/settler';
    delete x.spec.remediation[1].guardrails.requires_human_above;
    x.spec.remediation[2].runbook = 'http://runbooks.example/cert';
    delete x.spec.remediation[2].guardrails;
  });
  const m = buildRemediationFlowModel({ pack: adapt(c) });
  const [sev3, sev2, cert] = m.links;
  assert.deepEqual(sev3.steps.map(s => [s.kind, s.tone]), [['route', 'warn'], ['register-automation', 'info'], ['human', 'info'], ['runbook', 'info'], ['guardrails', 'info']]);
  assert.equal(sev3.steps[0].text, 'No route carries SEV3: add an alerting.routes entry for it, or the alert fires into silence.');
  assert.deepEqual(sev3.routes, []);
  assert.equal(sev3.steps[1].text, 'Register argo-workflow://restart-with-bumped-limits to run when the alert fires.');
  assert.equal(sev3.steps[2].text, 'SEV1 and above need a human before the automation runs (requires_human_above).');
  assert.equal(sev3.steps[3].href, null, 'file:// is not a link');
  assert.equal(sev3.steps[4].text, 'Guardrails: at most 3/hour · cooldown 15m · rolls back on failure · circuit breaker 2 failures in 1h.');
  assert.deepEqual(sev2.steps.map(s => s.kind), ['route', 'human', 'runbook', 'guardrails']);
  assert.equal(sev2.steps[0].text, 'SEV2 reaches ALR-02 (msteams, voice).');
  assert.deepEqual(sev2.routes.map(r => r.symbol), ['alerting.routes[1]']);
  assert.equal(sev2.steps[1].text, 'Manual remediation (manual-only): a human runs the runbook; nothing fires automatically.');
  assert.equal(sev2.steps[2].href, 'https://runbooks.example/settler');
  assert.equal(sev2.steps[3].text, 'Guardrails: at most 2/hour · cooldown 30m · no rollback on failure.');
  assert.deepEqual(cert.steps.map(s => s.kind), ['route', 'register-automation', 'runbook']);
  assert.equal(cert.steps[2].href, 'http://runbooks.example/cert');
});

test('a Scaffold remediation (the legacy upconvert marks every one it invents) is a placeholder: counted, its path\'s state placeholder, its automation, guardrails and runbook labelled template values', () => {
  const { canonical } = upconvertLegacyPack(loadPack(TYPED));
  assert.equal(canonical.metadata.annotations['crawler.scaffold.remediation[0]'] !== undefined, true, 'the upconvert marks remediation[0]');
  const pack = adapt(canonical);
  assert.equal(pack.layers.L4.healing[0].source, 'Scaffold');
  const m = buildRemediationFlowModel({ pack });
  assert.equal(m.configured, true);
  assert.equal(m.counts.placeholder, 1);
  const item = m.links[0] || m.unresolved[0];
  assert.equal(item.placeholder, true);
  assert.equal(item.remediation.placeholder, true);
  const texts = item.steps.filter(s => ['register-automation', 'human', 'runbook', 'guardrails'].includes(s.kind)).map(s => s.text);
  assert.ok(texts.length >= 2);
  for (const t of texts) assert.match(t, /template values/);
  if (m.links[0]) assert.equal(m.links[0].state, 'placeholder');
  // A placeholder remediation over a live alert stays placeholder; over a missing alert the missing wins.
  const a = adapt(paymentWith(['alert:PaymentServicePodRestarting']));
  a.layers.L4.healing[0].source = 'Scaffold';
  const self = buildRemediationFlowModel({ pack: a, diff: diffPacks(a, a) });
  assert.equal(self.links[0].state, 'placeholder');
  assert.equal(self.links[0].blocked, true);
  const bCanonical = payment(); bCanonical.spec.alerting.rules.splice(0, 1);
  assert.equal(buildRemediationFlowModel({ pack: a, diff: diffPacks(a, adapt(bCanonical)) }).links[0].state, 'missing');
});

// ---------- 6. the module ----------

test('tools/lib/remediation-flow.mjs is browser-safe (imports ./artefact-model.mjs only, no node:*, no process, no DOM, no clock) and a listed module of VENDOR-MANIFEST.json', () => {
  const src = read('tools/lib/remediation-flow.mjs');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./artefact-model.mjs']);
  assert.deepEqual(purityViolations(src), [], 'the manifest\'s own purity rules: no node:*, process, DOM, import.meta or require');
  assert.ok(!/Date\.now|new Date/.test(src), 'no clock');
  const manifest = JSON.parse(read('VENDOR-MANIFEST.json'));
  assert.ok(manifest.modules['tools/lib/remediation-flow.mjs'], 'listed');
  assert.deepEqual(manifest.modules['tools/lib/remediation-flow.mjs'].imports, ['tools/lib/artefact-model.mjs']);
});

test('never throws, never mutates, deterministic: no input, a null pack, garbage layers and a garbage diff yield the unconfigured or an honest model; two runs over the same inputs are the same JSON; the pack and the diff are untouched', () => {
  assert.deepEqual(buildRemediationFlowModel().configured, false);
  assert.deepEqual(buildRemediationFlowModel({ pack: null }).configured, false);
  assert.deepEqual(buildRemediationFlowModel({ pack: { layers: { L4: { healing: 'nope', policy: 7 } } } }).configured, false);
  const odd = { layers: { L4: { healing: [{ id: 'HEAL-01', spec: 'nope' }, null, { id: 'HEAL-02', spec: { trigger: 5 } }], policy: [{ id: 'POL-01', spec: { slo: 'x', windows: 'nope' } }], alerting: [{ id: 'RULE-01', spec: { name: null } }] } } };
  const om = buildRemediationFlowModel({ pack: odd, diff: { layers: { L4: { inBoth: 'nope', onlyInA: [null, {}] } } } });
  assert.equal(om.configured, true);
  assert.equal(om.counts.remediations, 2);
  assert.equal(om.compared, true);
  const a = adapt(paymentWith(['alert:api_availability_99_9_burn_14x_5m_1h']));
  const b = adapt(payment());
  const diff = diffPacks(a, b);
  const before = JSON.stringify([a, diff]);
  const one = JSON.stringify(buildRemediationFlowModel({ pack: a, diff, liveAnnotations: b.meta.annotations }));
  const two = JSON.stringify(buildRemediationFlowModel({ pack: a, diff, liveAnnotations: b.meta.annotations }));
  assert.equal(one, two);
  assert.equal(JSON.stringify([a, diff]), before, 'inputs untouched');
});
