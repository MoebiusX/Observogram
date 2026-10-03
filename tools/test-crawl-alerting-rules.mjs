#!/usr/bin/env node
/**
 * tools/test-crawl-alerting-rules.mjs
 *
 * Acceptance test for spec 1.4 alerting.rules through the crawler and the
 * adapter: a repository holding operational alerts and burn-rate alerts
 * side by side — a Prometheus rule file, Grafana unified-alerting
 * provisioning YAML and a Loki rule file (tools/fixtures/crawl/
 * operational-alerts/) — crawls into a pack that
 *   1. validates against the vendored 1.4 schema;
 *   2. carries every operational rule (N = 6) in spec.alerting.rules with
 *      its EXACT name, expression, wait, the pack's severity beside the
 *      engine's label, its engine and its source, and every burn-rate rule
 *      in spec.policy.burn_rate_alerts (3 rules → M = 2 entries, one per
 *      SLO) — a rule in one place, never both;
 *   3. round-trips through mini-yaml (crawlToYaml → parse → deep-equal),
 *      colons at the end of a scalar and ` #` included;
 *   4. projects, through the adapter, N alerting artefacts titled by rule
 *      name with distinct name-keyed identities.
 * Exit 0 = pass.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crawlFiles, crawlToYaml, detectArtefactKind } from './lib/crawler.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { identityKeyOf } from './lib/artefact-model.mjs';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness({ truncate: 600 });
const SCHEMA = JSON.parse(readFileSync(new URL(`../${SPEC_SCHEMA_PATH}`, import.meta.url), 'utf8'));

// The fixture directory as a file map, every file under it (README aside).
const ROOT = new URL('./fixtures/crawl/operational-alerts/', import.meta.url).pathname;
const FILES = {};
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name !== 'README.md') FILES[relative(ROOT, p).replace(/\\/g, '/')] = readFileSync(p, 'utf8');
  }
})(ROOT);

const OPERATIONAL = [
  'Payments: certificate expiring', 'Payments queue backlog', 'Payments 5xx spike',   // Grafana provisioning
  'PaymentsErrorLogSpike',                                                           // Loki
  'PaymentsPodRestarting', 'PaymentsDbPoolSaturated',                                // Prometheus
];
const BURN_RULES = ['PaymentsAvailabilityBurnFast', 'PaymentsAvailabilityBurnSlow', 'PaymentsLatencyBurn'];
const N = OPERATIONAL.length;   // 6
const M = 2;                    // policy entries: payments_availability_99, payments_latency_99

assert(Object.keys(FILES).length === 3, 'the fixture holds three rule files', Object.keys(FILES));
assert(detectArtefactKind('grafana/provisioning/alerting/payments.yaml', FILES['grafana/provisioning/alerting/payments.yaml']) === 'prometheus-rules',
  'Grafana provisioning YAML is detected as a rule file');

const opts = { repoName: 'payments', now: '2026-10-03T00:00:00.000Z' };
const { canonical, summary, evidence } = crawlFiles(FILES, opts);

// 1. validates against 1.4
assert(validateCanonical(canonical, SCHEMA).length === 0, 'the crawled pack validates against the vendored 1.4 schema', validateCanonical(canonical, SCHEMA).slice(0, 3));

// 2. every rule in its place
const rules = canonical.spec.alerting.rules || [];
const names = rules.map(r => r.name);
assert(names.length === N && [...names].sort().join('|') === [...OPERATIONAL].sort().join('|'),
  `all ${N} operational rules are in alerting.rules under their exact names`, names, OPERATIONAL);
assert(names.includes('Payments: certificate expiring'), 'a Grafana title with a colon and spaces is kept as the name, never slugged');
const slos = canonical.spec.policy.burn_rate_alerts.map(a => a.slo).sort();
assert(slos.length === M && slos.join() === 'payments_availability_99,payments_latency_99',
  `the ${BURN_RULES.length} burn-rate rules fold into M = ${M} policy entries, one per recorded SLO`, slos);
assert(!names.some(n => BURN_RULES.includes(n)), 'no burn-rate rule is also an operational rule');
assert(!canonical.spec.policy.burn_rate_alerts.some(a => OPERATIONAL.some(n => a.slo.includes(n.toLowerCase().replace(/[^a-z0-9]+/g, '_')))),
  'no operational rule was manufactured into an SLO contract');
const avail = canonical.spec.policy.burn_rate_alerts.find(a => a.slo === 'payments_availability_99');
assert(avail.windows.map(w => w.short).sort().join() === '2m,30m',
  'the fast (Prometheus, 2m) and slow (Grafana, 30m) availability rules union their windows on the one entry', avail.windows);

const by = Object.fromEntries(rules.map(r => [r.name, r]));
assert(['Payments: certificate expiring', 'Payments queue backlog', 'Payments 5xx spike'].every(n => by[n].engine === 'grafana')
  && by.PaymentsErrorLogSpike.engine === 'loki' && by.PaymentsPodRestarting.engine === 'prometheus' && by.PaymentsDbPoolSaturated.engine === 'prometheus',
  'engine: grafana for provisioned rules, loki for the Loki rule file, prometheus for the Prometheus rule file', rules.map(r => [r.name, r.engine]));
assert(by['Payments queue backlog'].expr === 'sum(rabbitmq_queue_messages_ready{queue=~"payments\\\\..*"})',
  'a Grafana rule\'s expr is its query node (model mapping), not its reduce / threshold nodes', by['Payments queue backlog'].expr);
assert(by['Payments 5xx spike'].expr === 'sum(rate(http_requests_total{service="payments",code=~"5.."}[5m])) > 10',
  'a Grafana rule whose model is a JSON string reads the same way', by['Payments 5xx spike'].expr);
assert(by.PaymentsErrorLogSpike.expr === 'sum(rate({namespace="payments", app="payments"} |= "level=error" [5m])) > 5', 'LogQL is kept verbatim');
assert(by.PaymentsPodRestarting.severity === 'SEV2' && by.PaymentsPodRestarting.labels.severity === 'warning'
  && by.PaymentsDbPoolSaturated.severity === 'SEV1' && by.PaymentsDbPoolSaturated.labels.severity === 'critical'
  && by['Payments 5xx spike'].severity === 'SEV1' && by['Payments 5xx spike'].labels.severity === 'page',
  'severity is the pack\'s SEV from labels.severity (critical / page → SEV1, warning → SEV2); the engine\'s word stays in labels',
  rules.map(r => [r.name, r.severity, r.labels?.severity]));
assert(by.PaymentsDbPoolSaturated.for === '5m' && by.PaymentsPodRestarting.for === '10m' && by['Payments: certificate expiring'].for === '1h' && by['Payments 5xx spike'].for === undefined,
  'for is the canonical duration: 300s → 5m; 0s is no wait and omitted', rules.map(r => [r.name, r.for]));
assert(by.PaymentsPodRestarting.labels.team === 'payments' && by.PaymentsPodRestarting.annotations.runbook_url === 'https://runbooks.example.internal/payments/pod-restarts'
  && by['Payments: certificate expiring'].annotations.dashboard === 'https://grafana.example.internal/d/payments #certificates',
  'labels and annotations are kept verbatim');
assert(by.PaymentsPodRestarting.source === 'prometheus/rules.yml#payments.alerts/PaymentsPodRestarting'
  && by['Payments queue backlog'].source === 'grafana/provisioning/alerting/payments.yaml#payments-operational/Payments queue backlog'
  && by.PaymentsErrorLogSpike.source === 'loki/rules.yaml#payments.logs/PaymentsErrorLogSpike',
  'source is <file>#<group>/<name>, as the crawler records every rule\'s provenance', rules.map(r => r.source));
assert(rules.every(r => Object.keys(r).every(k => ['name', 'expr', 'severity', 'for', 'labels', 'annotations', 'engine', 'source'].includes(k))), 'a rule carries schema fields only');
assert(Object.entries(evidence).filter(([k]) => /^RULE-\d+$/.test(k)).length === N && evidence['RULE-1'] === rules[0].source,
  `evidence RULE-1..${N} records each rule's source`, Object.entries(evidence).filter(([k]) => /^RULE-/.test(k)));

// the summary says so, truthfully
assert(summary.discovered.alertRules === N, `summary.discovered.alertRules counts the ${N} operational rules`, summary.discovered.alertRules);
assert(summary.discovered.burnRateAlerts === N + BURN_RULES.length,
  'summary.discovered.burnRateAlerts still counts every alert rule discovered before classification (unchanged semantics); alertRules counts the operational ones', summary.discovered.burnRateAlerts);
const line = summary.warnings.find(w => /operational alert rule\(s\) kept in alerting\.rules/.test(w));
assert(line === `${N} operational alert rule(s) kept in alerting.rules — not SLO burn-rate alerts (no recorded-ratio reference): ${names.join(', ')}. ${M} burn-rate alert(s) in policy.burn_rate_alerts.`,
  'the summary line states the counts and the names', line);
assert(!summary.warnings.some(w => /Excluded .* operational alert/.test(w)), 'the "excluded … remain available" warning is gone');

// 3. YAML round-trip
const { yaml } = crawlToYaml(FILES, opts);
const back = parseYaml(yaml);
assert(JSON.stringify(back.spec) === JSON.stringify(canonical.spec), 'the pack\'s spec round-trips through mini-yaml: emit → parse → deep-equal (alerting.rules included)',
  JSON.stringify(back.spec.alerting) === JSON.stringify(canonical.spec.alerting) ? 'difference outside alerting' : [back.spec.alerting.rules, canonical.spec.alerting.rules]);
// KNOWN, PRE-EXISTING and outside this change: the emitter writes a
// multi-line scalar as a literal block (`|`), which re-parses with a trailing
// newline the value did not have; the crawler's crawler.discovered.*
// annotations are multi-line JSON, so metadata differs by exactly that.
// Pinned here so a fix in mini-yaml (`|-`) shows up as this assertion turning
// strict: every other metadata key is byte-equal.
{
  const a = canonical.metadata.annotations, b = back.metadata.annotations;
  const differing = Object.keys(a).filter(k => a[k] !== b[k]);
  assert(JSON.stringify({ ...canonical.metadata, annotations: null }) === JSON.stringify({ ...back.metadata, annotations: null })
    && differing.every(k => a[k].includes('\n') && b[k] === `${a[k]}\n`),
  'metadata round-trips except the known trailing newline on multi-line annotation values (mini-yaml literal block `|`; not alerting.rules)', differing.map(k => [k, JSON.stringify(a[k].slice(-20)), JSON.stringify(b[k].slice(-20))]));
}
assert(back.spec.alerting.rules.find(r => r.name === 'PaymentsDbPoolSaturated').annotations.summary.endsWith('runbook:'),
  'a scalar ending in ":" survives the round-trip (mini-yaml quotes it)');
assert(validateCanonical(back, SCHEMA).length === 0, 'the re-parsed pack validates too');

// 4. the adapter
const layered = adapt(canonical);
const artefacts = layered.layers.L4.alerting.filter(a => a.id.startsWith('RULE-'));
assert(artefacts.length === N && artefacts.map(a => a.title).join('|') === names.join('|'),
  `the adapter shows ${N} alerting artefacts titled by rule name`, artefacts.map(a => a.title));
assert(new Set(artefacts.map(identityKeyOf)).size === N && artefacts.every(a => identityKeyOf(a) === `alert_rule::{"name":"${a.title.toLowerCase()}"}`),
  'each is keyed by its name — the key a live listing of the same rules pairs on', artefacts.map(identityKeyOf));
assert(artefacts.every(a => a.source === 'Declared') && artefacts.filter(a => a.tool === 'Grafana alerting').length === 3
  && artefacts.filter(a => a.tool === 'PrometheusRule').length === 2 && artefacts.filter(a => a.tool === 'Loki ruler').length === 1,
  'Declared, tool by engine', artefacts.map(a => [a.title, a.tool, a.source]));
assert(layered.layers.L4.policy.filter(a => a.id.startsWith('POL-')).length === M, `and M = ${M} burn-rate artefacts`, layered.layers.L4.policy.map(a => a.title));

report('crawl alerting.rules', `N = ${N} operational rules in alerting.rules, M = ${M} burn-rate entries in policy; valid, round-trips, projects.`);
