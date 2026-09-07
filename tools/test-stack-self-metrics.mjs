#!/usr/bin/env node
/**
 * tools/test-stack-self-metrics.mjs
 *
 * Table-integrity tests for the stack self-metric alias table
 * (tools/lib/contracts/stack-self-metrics.mjs) — the data the step-2
 * sampler reads to acquire the observability stack's own health signals.
 *
 * What is pinned:
 *   - unique row ids; families / units / directions from the allowed sets;
 *     every row names its documentation source and carries >= 1 alias
 *   - every alias's `requires` names appear as whole tokens in its `expr`
 *     (an alias can never demand a metric its query does not read)
 *   - every non-null referenceSli resolves to a real SLI id in the named
 *     reference pack (reference-packs/<pack>.pack.yaml)
 *   - the registry row the sampler gates on (stack_self_metrics) rides the
 *     same tool as build_info_versions and declares the instant-vector shape
 *   - resolvers are pure: no mutation, stable ordering, honest null answers
 *
 * Nothing here samples anything: the table is data, the tests are about
 * the data staying coherent.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STACK_SELF_METRIC_PROBES, STACK_FAMILIES, STACK_UNITS, STACK_DIRECTIONS, STACK_OUTCOMES,
  probeRows, rowsForFamily, eligibleAliases, productPreferenceOrder, displayHint, bestOutcome,
} from './lib/contracts/stack-self-metrics.mjs';
import { capability, capabilityTool } from './lib/contracts/mcp-capabilities.mjs';
import { RESPONSE_SHAPES } from './lib/contracts/response-shapes.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { createHarness } from './lib/harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const { assert, report } = createHarness({ indent: '  ', truncate: 160 });

// ---------- table integrity ----------

const rows = probeRows();
assert(rows === STACK_SELF_METRIC_PROBES && rows.length === 24, `probeRows() is the frozen table (24 rows)`, rows.length);
assert(Object.isFrozen(rows) && rows.every((r) => Object.isFrozen(r) && Object.isFrozen(r.aliases)),
  'table, rows and alias lists are frozen');

const ids = rows.map((r) => r.id);
assert(new Set(ids).size === ids.length, 'row ids are unique', ids.filter((id, i) => ids.indexOf(id) !== i));
const ID_RE = /^[a-z][a-z0-9_]*$/;
assert(ids.every((id) => ID_RE.test(id)), 'row ids are snake_case slugs', ids.filter((id) => !ID_RE.test(id)));

const badFamily = rows.filter((r) => !STACK_FAMILIES.includes(r.family)).map((r) => r.id);
assert(badFamily.length === 0, 'every family is in STACK_FAMILIES', badFamily);
const badUnit = rows.filter((r) => !STACK_UNITS.includes(r.unit)).map((r) => r.id);
assert(badUnit.length === 0, 'every unit is in STACK_UNITS', badUnit);
const badDir = rows.filter((r) => !STACK_DIRECTIONS.includes(r.direction)).map((r) => r.id);
assert(badDir.length === 0, 'every direction is in STACK_DIRECTIONS', badDir);
assert(rows.every((r) => typeof r.signal === 'string' && r.signal.length > 0), 'every row states its signal in plain English');
assert(rows.every((r) => typeof r.source === 'string' && r.source.length > 0), 'every row names the upstream docs its metric names follow');
assert(rows.every((r) => Array.isArray(r.aliases) && r.aliases.length > 0), 'every row carries at least one alias');
assert(STACK_FAMILIES.every((f) => rows.some((r) => r.family === f)), 'every family has at least one row',
  STACK_FAMILIES.filter((f) => !rows.some((r) => r.family === f)));

// requires ⊆ tokens(expr): a metric name is a whole PromQL identifier token.
const TOKEN_RE = /[A-Za-z_:][A-Za-z0-9_:]*/g;
const PRODUCT_RE = /^[a-z][a-z0-9]*$/;
// `verified` (optional per alias): `<image:tag> <how> + PromQL, <date>` —
// the pinned product image whose exposition carried the required names and
// whose PromQL evaluated the expr (tools/test-stack-live.mjs re-checks it).
const VERIFIED_RE = /^[a-z0-9][a-z0-9./-]*:[A-Za-z0-9._-]+ (exposition|TSDB inventory|probe output) \+ PromQL, \d{4}-\d{2}-\d{2}$/;
// The metric names an expr reads: label matchers, range selectors and
// grouping clauses (`by (…)`, `ignoring (…)`) stripped, PromQL words dropped.
const PROMQL_WORDS = new Set(['sum', 'count', 'max', 'min', 'avg', 'rate', 'increase', 'time', 'vector', 'or', 'and', 'unless', 'by', 'without', 'on', 'ignoring', 'group_left', 'group_right']);
const metricNamesIn = (expr) => [...new Set((expr
  .replace(/\{[^}]*\}/g, '').replace(/\[[^\]]*\]/g, '')
  .replace(/\b(by|without|on|ignoring)\s*\([^)]*\)/g, '')
  .match(TOKEN_RE) || []).filter((t) => !PROMQL_WORDS.has(t)))];
let verifiedAliases = 0;
let lazyAliases = 0;
for (const r of rows) {
  for (const [i, a] of r.aliases.entries()) {
    const tokens = new Set(a.expr.match(TOKEN_RE) || []);
    const missing = a.requires.filter((name) => !tokens.has(name));
    assert(missing.length === 0 && a.requires.length > 0,
      `${r.id}[${i}] (${a.product}): requires ⊆ metric names read by expr`, { missing, requires: a.requires });
    assert(PRODUCT_RE.test(a.product), `${r.id}[${i}]: product "${a.product}" is a slug`);
    if (a.verified !== undefined) {
      verifiedAliases += 1;
      assert(typeof a.verified === 'string' && VERIFIED_RE.test(a.verified),
        `${r.id}[${i}]: verified stamp has the shape "<image:tag> <how> + PromQL, <date>"`, a.verified);
    }
    assert(!/vector\(0\)/.test(a.expr), `${r.id}[${i}]: never \`or vector(0)\` — zeros are presence-guarded`, a.expr);
    // Lazily-registered counters: an expr that reads a name `requires` does
    // not demand must end with the presence-guarded zero of a REQUIRED
    // sibling, so the row reads 0 only when the product is doing that work.
    const lazy = metricNamesIn(a.expr).filter((n) => !a.requires.includes(n));
    if (lazy.length) {
      lazyAliases += 1;
      const guarded = a.requires.some((s) => a.expr.endsWith(`or (count(${s}) * 0)`));
      assert(guarded, `${r.id}[${i}]: lazily-registered counter(s) ${lazy.join(', ')} are guarded by a required sibling's presence (or (count(<sibling>) * 0))`, a.expr);
    }
  }
}
assert(verifiedAliases === rows.reduce((n, r) => n + r.aliases.length, 0) && verifiedAliases === 32,
  'every alias carries a verified stamp (32 aliases after the 2026-09-07 live correction)', verifiedAliases);
assert(lazyAliases === 6, 'exactly the six otelcol counter rows (send_failed_*, receiver_refused_*) use the lazy-counter policy', lazyAliases);
assert(rows.every((r) => r.aliases.every((a) => !/otelcol_[a-z_]+_total\b/.test(a.expr) && !/otelcol_processor_dropped/.test(a.expr))),
  'no otelcol alias reads a `_total`-suffixed or processor_dropped_* name (neither exists on 0.115.1 nor 0.154.0)');

// referenceSli resolves in the named reference pack.
const packCache = {};
const sliIdsOf = (pack) => {
  if (!packCache[pack]) {
    const file = resolve(ROOT, 'reference-packs', `${pack.replace(/-reference$/, '')}.pack.yaml`);
    const doc = parseYaml(readFileSync(file, 'utf8'));
    packCache[pack] = new Set((doc?.spec?.slis || []).map((s) => s.id));
  }
  return packCache[pack];
};
for (const r of rows.filter((x) => x.referenceSli !== null)) {
  const [pack, sli] = String(r.referenceSli).split('/');
  let ok; let ids = [];
  try { ids = [...sliIdsOf(pack)]; ok = sliIdsOf(pack).has(sli); } catch { ok = false; }
  assert(ok, `${r.id}: referenceSli ${r.referenceSli} names a real reference-pack SLI`, ids.slice(0, 12));
}
// The documented discrepancies stay visible on the rows they concern.
const dur = rows.find((r) => r.id === 'scrape_duration_max');
assert(dur.referenceSli === 'prometheus-reference/scrape_duration_p99' && dur.aliases[0].expr === 'max(scrape_duration_seconds)',
  'scrape_duration_max samples the gauge (max) while pointing at the histogram-worded reference SLI (documented discrepancy 1)');
const ql = rows.find((r) => r.id === 'query_latency_p99');
assert(ql.referenceSli === 'prometheus-reference/query_latency_p99'
  && ql.aliases.every((a) => !/_bucket/.test(a.expr) && !a.requires.some((n) => /_bucket$/.test(n)))
  && ql.aliases[0].requires.includes('prometheus_engine_query_duration_seconds'),
  'query_latency_p99 reads the summary quantile of prometheus_engine_query_duration_seconds — never a _bucket Prometheus does not expose (documented discrepancy 2)', ql.aliases[0]);

// Upstream names pinned against the products' own source (reviewed 2026-09-07).
const ruler = rows.find((r) => r.id === 'rule_evaluation_failures');
const vmAlias = ruler.aliases.find((a) => a.product === 'victoriametrics');
assert(vmAlias.requires.includes('vmalert_recording_rules_errors_total') && vmAlias.requires.includes('vmalert_alerting_rules_errors_total')
  && !ruler.aliases.some((a) => a.requires.some((n) => /_error_total$/.test(n))),
  'vmalert names use the plural errors_total (app/vmalert/rule/recording.go, alerting.go)', vmAlias.requires);

// Lower-is-comfortable COUNT rows read 0 when healthy without fabricating
// 0 when the base metric is absent: the guard is `or (count(<m>) * 0)`,
// never `or vector(0)`.
for (const id of ['scrape_targets_down', 'synthetic_probe_failures']) {
  const r = rows.find((x) => x.id === id);
  const g = r.aliases[0];
  const base = g.requires[0];
  assert(g.expr.endsWith(`or (count(${base}) * 0)`) && !/vector\(0\)/.test(g.expr),
    `${id}: the count alias carries the presence-guarded zero (or (count(${base}) * 0)), not vector(0)`, g.expr);
}
const ratio = rows.find((x) => x.id === 'scrape_success_ratio');
assert(ratio.aliases[0].expr === 'sum(up) / count(up)', 'scrape_success_ratio is sum(up) / count(up) so an all-down stack reads 0, not empty', ratio.aliases[0].expr);
// Rate rows whose label filter matches nothing on a healthy product carry
// the same guard (documented discrepancy 3 for the datasource row).
for (const id of ['datasource_errors', 'grafana_http_errors']) {
  const r = rows.find((x) => x.id === id);
  assert(r.aliases.every((a) => a.expr.endsWith(`or (count(${a.requires[0]}) * 0)`)),
    `${id}: the 5xx rate alias(es) carry the presence-guarded zero of their base metric`, r.aliases.map((a) => a.expr));
}
const ds = rows.find((x) => x.id === 'datasource_errors');
assert(ds.aliases.length === 2 && ds.aliases[0].requires[0] === 'grafana_proxy_response_status_total' && ds.aliases[1].requires[0] === 'grafana_datasource_request_total',
  'datasource_errors reads the pre-registered grafana_proxy_response_status_total first, the lazily-registered reference-pack name second', ds.aliases.map((a) => a.requires));
// The lazy otelcol rows require the sibling that registers with the counter.
for (const [id, counter, sibling] of [
  ['collector_export_failures_spans', 'otelcol_exporter_send_failed_spans', 'otelcol_exporter_sent_spans'],
  ['collector_refused_spans', 'otelcol_receiver_refused_spans', 'otelcol_receiver_accepted_spans'],
]) {
  const a = rows.find((x) => x.id === id).aliases[0];
  assert(a.requires.join() === sibling && a.expr === `sum(rate(${counter}[5m])) or (count(${sibling}) * 0)`,
    `${id}: requires the sibling ${sibling}, reads ${counter} guarded by it`, a);
}

// Registry seam: the sampler gates on metrics_query, same tool as build_info.
assert(capabilityTool('stack_self_metrics') === capabilityTool('build_info_versions'),
  'stack_self_metrics rides the same tool as build_info_versions (the sampler gate)');
assert(capability('stack_self_metrics').responseShape === 'instant-vector' && !!RESPONSE_SHAPES['instant-vector'],
  'stack_self_metrics declares the instant-vector response shape');
for (const id of ['alertmanager_status', 'alertmanager_silences', 'grafana_datasources', 'grafana_datasource_health', 'grafana_contact_points']) {
  const cap = capability(id);
  assert(!!RESPONSE_SHAPES[cap.responseShape], `${id}: declared responseShape "${cap.responseShape}" exists`);
}

// ---------- resolvers ----------

assert(rowsForFamily('collector').length === 7 && rowsForFamily('collector').every((r) => r.family === 'collector'),
  'rowsForFamily filters by family (collector has 7 rows)', rowsForFamily('collector').map((r) => r.id));
assert(rowsForFamily('collector').map((r) => r.id).join(',') === 'collector_export_failures_metrics,collector_export_failures_spans,collector_export_failures_logs,collector_refused_metrics,collector_refused_spans,collector_refused_logs,collector_queue_saturation',
  'the collector rows are export failures, receiver refusals (the retired processor_dropped_* rows) and queue saturation', rowsForFamily('collector').map((r) => r.id));
assert(rowsForFamily('nope').length === 0, 'rowsForFamily of an unknown family is empty');

const ruleFailures = rows.find((r) => r.id === 'rule_evaluation_failures');
const vmInventory = new Set(['vmalert_recording_rules_errors_total', 'vmalert_alerting_rules_errors_total', 'up']);
const elig = eligibleAliases(ruleFailures, vmInventory);
assert(elig.length === 1 && elig[0].product === 'victoriametrics',
  'eligibleAliases keeps only aliases whose EVERY required name is in the inventory', elig.map((a) => a.product));
const partial = eligibleAliases(ruleFailures, ['vmalert_recording_rules_errors_total']);
assert(partial.length === 0, 'eligibleAliases: one of two required names present → not eligible (array inventory accepted)');
assert(eligibleAliases(ruleFailures, null) === ruleFailures.aliases && eligibleAliases(ruleFailures, undefined).length === 3,
  'eligibleAliases without an inventory returns every alias in declared order');
const queue = rows.find((r) => r.id === 'collector_queue_saturation');
assert(eligibleAliases(queue, new Set(['otelcol_exporter_queue_size'])).length === 0
  && eligibleAliases(queue, new Set(['otelcol_exporter_queue_size', 'otelcol_exporter_queue_capacity'])).length === 1,
  'eligibleAliases: a two-metric alias needs both names');

const before = JSON.stringify(ruleFailures.aliases);
const pref = productPreferenceOrder(ruleFailures, new Set(['grafana']));
assert(pref.map((a) => a.product).join(',') === 'grafana,prometheus,victoriametrics',
  'productPreferenceOrder: seen products first, the rest in declared order', pref.map((a) => a.product));
assert(JSON.stringify(ruleFailures.aliases) === before && pref !== ruleFailures.aliases,
  'productPreferenceOrder is pure (new array, row untouched)');
const down = rows.find((r) => r.id === 'scrape_targets_down');
assert(productPreferenceOrder(down, ['victoriametrics']).map((a) => a.product).join(',') === 'generic,victoriametrics',
  'productPreferenceOrder: generic always first, even when a seen product is present');
assert(productPreferenceOrder(ruleFailures, null).map((a) => a.product).join(',') === 'prometheus,victoriametrics,grafana',
  'productPreferenceOrder with nothing seen keeps the declared order');

assert(displayHint(down, 3) === 'nonzero' && displayHint(down, 0) === null && displayHint(down, null) === null,
  'displayHint: nonzero only for a lower-is-comfortable row with value > 0');
const sent = rows.find((r) => r.id === 'notifications_sent');
const succ = rows.find((r) => r.id === 'scrape_success_ratio');
assert(displayHint(sent, 5) === null && displayHint(succ, 0.5) === null,
  'displayHint is null for info and higher directions (never a verdict)');

assert(STACK_OUTCOMES.join(',') === 'data,empty,failed,not-in-inventory,not-attempted', 'STACK_OUTCOMES rank order pinned');
assert(bestOutcome(['not-attempted', 'failed', 'empty']) === 'empty' && bestOutcome(['not-in-inventory', 'data']) === 'data',
  'bestOutcome picks the best-ranked outcome');
assert(bestOutcome([]) === null && bestOutcome(null) === null && bestOutcome(['weird', 'not-attempted']) === 'not-attempted',
  'bestOutcome: empty → null, unknown outcomes rank last');

report('stack-self-metrics', 'the stack self-metric alias table is coherent; samples are signals, never verdicts.');
