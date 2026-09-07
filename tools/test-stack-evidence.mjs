#!/usr/bin/env node
/**
 * tools/test-stack-evidence.mjs
 *
 * Unit test for tools/lib/stack-evidence.mjs — the browser-safe history
 * helpers over journey run records (step 3). Pure functions over
 * hand-built records: series ordering from newest-first input, gaps,
 * non-data outcomes kept with value null, per-family preference, the
 * listing summary, the posture-budget cadence heuristic, nonzero counting
 * and the shared value formatter. Exit 0 = pass.
 */

import { readFileSync } from 'node:fs';
import { createHarness } from './lib/harness.mjs';
import {
  stackSeries, latestByFamily, stackSummary, stackPostureBudget, nonzeroRuns,
  formatStackValue, stackOutcomeLabel, STACK_BUDGET_MIN_ALLOWANCE,
} from './lib/stack-evidence.mjs';
import { STACK_SELF_METRIC_PROBES } from './lib/contracts/stack-self-metrics.mjs';

const { assert, report } = createHarness();

// --- browser-safety guard: no Node APIs, no environment, one import ---
const src = readFileSync(new URL('./lib/stack-evidence.mjs', import.meta.url), 'utf8');
assert(!/from\s+'node:/.test(src) && !/process\.env/.test(src), 'stack-evidence.mjs imports no node: module and reads no environment');
assert((src.match(/^import\s/mg) || []).length === 1 && /from '\.\/contracts\/stack-self-metrics\.mjs'/.test(src),
       'stack-evidence.mjs imports only the contracts table');

// --- fixtures: three runs, written newest first like readJourneyRuns ---
const row = (id, family, patch = {}) => ({
  id, family, product: 'generic', value: null, unit: 'per-second', direction: 'lower',
  outcome: 'data', hint: null, at: null, referenceSli: null, ...patch,
});
const run = (startedAt, rows, extra = {}) => ({
  journey: 'j', startedAt, outcome: 'pass',
  stackEvidence: rows === null ? null : { status: 'sampled', reason: null, rows, alertmanager: null, grafana: null },
  ...extra,
});
const t1 = '2026-09-07T10:00:00.000Z', t2 = '2026-09-07T10:15:00.000Z', t3 = '2026-09-07T10:30:00.000Z', t4 = '2026-09-07T10:45:00.000Z';
const runs = [
  run(t4, [
    row('scrape_targets_down', 'scrape', { value: 0, unit: 'count', at: t4 }),
    row('rule_evaluation_failures', 'ruler', { value: null, outcome: 'empty', at: t4 }),
  ]),
  run(t3, null),                                                 // file-sourced: a gap
  run(t2, [
    row('scrape_targets_down', 'scrape', { value: 2, unit: 'count', hint: 'nonzero', at: t2 }),
    row('rule_evaluation_failures', 'ruler', { value: 0.002, hint: 'nonzero', at: t2 }),
  ]),
  run(t1, [
    row('scrape_targets_down', 'scrape', { value: 1, unit: 'count', hint: 'nonzero', at: t1 }),
    // no ruler row at all in the first run
  ]),
];

// --- stackSeries ---
const s = stackSeries(runs, 'scrape_targets_down');
assert(s.map(x => x.at).join() === [t1, t2, t4].join(), 'stackSeries sorts newest-first input oldest → newest and skips the run without evidence', s.map(x => x.at));
assert(s.map(x => x.value).join() === '1,2,0' && s.map(x => x.hint).join() === 'nonzero,nonzero,', 'stackSeries carries value + hint per sample', s);
const rs = stackSeries(runs, 'rule_evaluation_failures');
assert(rs.length === 2 && rs[0].at === t2 && rs[1].outcome === 'empty' && rs[1].value === null,
       'stackSeries skips a run that lacks the row and keeps a non-data outcome with value null', rs);
assert(stackSeries(runs, 'no_such_row').length === 0 && stackSeries(null, 'x').length === 0 && stackSeries([{}], 'x').length === 0,
       'stackSeries is empty for an unknown row, a non-array and a record without evidence');
const unordered = stackSeries([runs[3], runs[0], runs[2]], 'scrape_targets_down');
assert(unordered.map(x => x.at).join() === [t1, t2, t4].join(), 'stackSeries ordering does not depend on input order');
const noAt = stackSeries([run(t1, [row('scrape_targets_down', 'scrape', { value: 3, unit: 'count' })])], 'scrape_targets_down');
assert(noAt[0].at === t1, 'a sample without its own `at` takes the run start time');

// --- latestByFamily ---
const rec = run(t4, [
  row('scrape_success_ratio', 'scrape', { value: null, outcome: 'empty', unit: 'ratio', direction: 'higher' }),
  row('scrape_targets_down', 'scrape', { value: 2, unit: 'count', hint: 'nonzero', referenceSli: 'prometheus-reference/scrape_targets_down' }),
  row('scrape_duration_max', 'scrape', { value: 1.5, unit: 'seconds', direction: 'info' }),
  row('rule_evaluation_staleness', 'ruler', { value: null, outcome: 'failed', reason: 'HTTP 500' }),
  row('rule_evaluation_failures', 'ruler', { value: null, outcome: 'not-in-inventory' }),
  row('retired_row_zzz', 'tsdb', { value: 9, unit: 'count' }),
  row('tsdb_active_series', 'tsdb', { value: 100, unit: 'count', direction: 'info' }),
]);
const fam = latestByFamily(rec);
assert(fam.scrape?.id === 'scrape_targets_down' && fam.scrape.value === 2 && fam.scrape.hint === 'nonzero' && fam.scrape.referenceSli === 'prometheus-reference/scrape_targets_down',
       'latestByFamily prefers a data row over an earlier empty one, then table order among data rows', fam.scrape);
assert(fam.ruler?.id === 'rule_evaluation_failures' && fam.ruler.outcome === 'not-in-inventory' && fam.ruler.value === null,
       'latestByFamily with no data row falls back to table order (rule_evaluation_failures precedes rule_evaluation_staleness)', fam.ruler);
assert(fam.tsdb?.id === 'tsdb_active_series', 'a row the table no longer declares sorts after every declared data row', fam.tsdb);
assert(Object.keys(fam).sort().join() === 'ruler,scrape,tsdb', 'latestByFamily yields one entry per family present', Object.keys(fam));
assert(Object.keys(latestByFamily(run(t1, null))).length === 0 && Object.keys(latestByFamily(null)).length === 0 && Object.keys(latestByFamily({})).length === 0,
       'latestByFamily is {} without evidence');
const onlyRetired = latestByFamily(run(t1, [row('retired_row_zzz', 'tsdb', { value: 9, unit: 'count' })]));
assert(onlyRetired.tsdb?.id === 'retired_row_zzz', 'a retired row still represents its family when nothing else does');
const reasonFam = latestByFamily(run(t1, [row('rule_evaluation_staleness', 'ruler', { value: null, outcome: 'failed', reason: 'HTTP 500' })]));
assert(reasonFam.ruler.reason === 'HTTP 500' && !('reason' in fam.scrape), 'reason rides along only when the row carries one');
assert(STACK_SELF_METRIC_PROBES.findIndex(r => r.id === 'rule_evaluation_failures') < STACK_SELF_METRIC_PROBES.findIndex(r => r.id === 'rule_evaluation_staleness'),
       'fixture assumption: table order of the two ruler rows');

// --- stackSummary ---
const sum = stackSummary(rec);
assert(sum.status === 'sampled' && sum.reason === null && sum.sampled === 4 && sum.families.scrape.id === 'scrape_targets_down',
       'stackSummary counts rows that answered data and carries the per-family pick', sum);
assert(stackSummary(run(t1, null)) === null && stackSummary(null) === null && stackSummary({ stackEvidence: {} }) === null,
       'stackSummary is null without evidence (file-sourced B, pre-step-3 record)');
const na = stackSummary({ startedAt: t1, stackEvidence: { status: 'not-attempted', reason: 'metrics_query not exposed by this MCP (restricted tier)', rows: [] } });
assert(na.status === 'not-attempted' && /restricted tier/.test(na.reason) && na.sampled === 0 && Object.keys(na.families).length === 0,
       'stackSummary keeps the not-attempted reason and zero families', na);

// --- nonzeroRuns ---
assert(nonzeroRuns(s) === 2, 'nonzeroRuns counts data samples with the nonzero hint', s);
assert(nonzeroRuns(rs) === 1, 'nonzeroRuns ignores a non-data sample even when a hint is present', rs);
assert(nonzeroRuns([{ outcome: 'empty', hint: 'nonzero' }]) === 0 && nonzeroRuns(null) === 0 && nonzeroRuns([]) === 0, 'nonzeroRuns: non-data, null and empty count 0');

// --- stackPostureBudget: the cadence heuristic ---
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const b1 = stackPostureBudget(s, { objective: 0.9999, cadenceMs: 15 * MIN, windowMs: 30 * DAY });
assert(Math.abs(b1.allowance - 0.288) < 1e-9 && b1.measurable === false, '99.99 % at a 15 min cadence over 30 d allows 0.288 bad samples — not measurable', b1);
assert(/not measurable/.test(b1.note) && /signal, not verdict/.test(b1.note), 'a non-measurable budget says so and stays a signal', b1.note);
const b2 = stackPostureBudget(s, { objective: 0.99, cadenceMs: 5 * MIN, windowMs: 7 * DAY });
assert(Math.abs(b2.allowance - 20.16) < 1e-9 && b2.measurable === true, '99 % at a 5 min cadence over 7 d allows 20.16 bad samples — measurable', b2);
assert(b2.samples === 3 && b2.bad === 2 && Math.abs(b2.fraction - 1 / 3) < 1e-12, 'budget arithmetic: samples, bad (nonzero hint), fraction = good / samples', b2);
assert(/signal, not verdict/.test(b2.note) && /2 bad of 3/.test(b2.note), 'a measurable budget still reads as a signal', b2.note);
assert(STACK_BUDGET_MIN_ALLOWANCE === 10, 'the measurability floor is 10 bad samples');
const edge = stackPostureBudget([], { objective: 0.9, cadenceMs: HOUR, windowMs: 100 * HOUR });
assert(edge.allowance === 10 && edge.measurable === true && edge.samples === 0 && edge.bad === 0 && edge.fraction === null,
       'allowance exactly 10 is measurable; fraction is null when there are no data samples', edge);
const custom = stackPostureBudget(s, { objective: 0.5, cadenceMs: MIN, windowMs: HOUR, isBad: (x) => x.value > 1 });
assert(custom.bad === 1 && Math.abs(custom.fraction - 2 / 3) < 1e-12 && custom.allowance === 30, 'isBad overrides the nonzero default', custom);
const nonData = stackPostureBudget(rs, { objective: 0.5, cadenceMs: MIN, windowMs: HOUR });
assert(nonData.samples === 1 && nonData.bad === 1, 'only data samples count toward the budget', nonData);
for (const bad of [{}, { objective: 1, cadenceMs: 1, windowMs: 1 }, { objective: 0.9, cadenceMs: 0, windowMs: 1 }, { objective: 0.9, cadenceMs: 1, windowMs: -1 }, { objective: '0.9', cadenceMs: 1, windowMs: 1 }]) {
  const b = stackPostureBudget(s, bad);
  assert(b.allowance === null && b.measurable === false && /no budget/.test(b.note) && /signal, not verdict/.test(b.note),
         `invalid budget inputs yield no allowance: ${JSON.stringify(bad)}`, b);
}
assert(stackPostureBudget(null).samples === 0, 'a null series is an empty series');

// --- formatStackValue + stackOutcomeLabel (shared vocabulary) ---
assert(formatStackValue(0.8333, 'ratio') === '83.3%' && formatStackValue(0.0041, 'per-second') === '0.004/s' && formatStackValue(0.04, 'per-hour') === '0.0/h'
       && formatStackValue(7.44, 'seconds') === '7.4s' && formatStackValue(1.2, 'count') === '1' && formatStackValue(3, 'unknown-unit') === '3',
       'formatStackValue formats each contracts unit');
assert(formatStackValue(null, 'count') === '—' && formatStackValue(NaN, 'ratio') === '—' && formatStackValue('7', 'count') === '—', 'formatStackValue never prints a non-number as a number');
assert(['empty', 'probe failed', 'not in inventory', 'not attempted', 'data'].join() === ['empty', 'failed', 'not-in-inventory', 'not-attempted', 'data'].map(stackOutcomeLabel).join(),
       'stackOutcomeLabel names every honest non-answer');
assert(stackOutcomeLabel('weird') === 'weird' && stackOutcomeLabel(null) === 'unknown', 'stackOutcomeLabel tolerates unknown and null');

// --- purity: inputs untouched ---
const before = JSON.stringify(runs);
stackSeries(runs, 'scrape_targets_down'); latestByFamily(runs[0]); stackSummary(runs[0]); stackPostureBudget(s, { objective: 0.9, cadenceMs: 1, windowMs: 100 });
assert(JSON.stringify(runs) === before, 'helpers never mutate the records');

report('stack-evidence', 'all stack-evidence helper assertions pass.');
