// tools/test-inventory-coverage.mjs — the inventory-coverage arithmetic, gate, summary and series.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVENTORY_STATUSES, validateInventoryBlock, validateGateInventory, expectedFromSite, promqlForKind,
  coverageOfKind, buildInventoryRecord, evaluateInventoryGate, inventorySummary, inventoryStatusLine, inventorySeries, unknownKinds,
} from './lib/inventory-coverage.mjs';

const SITE = {
  environment: 'prod',
  expected: {
    generated_from: 'gen-site inventory v1', environment: 'prod', series_prefix: 'ibmmq:inventory:',
    kinds: {
      qmgr: { title: 'queue manager', label: 'qmgr', series: 'ibmmq:inventory:qmgr', jobs: ['ibmmq-exporter', 'ibmmq-native'], names: ['QMORD1', 'QMPAY1', 'QMFIN1'], by: { QMORD1: { site: 'dc1' } } },
      host: { title: 'host', label: 'host', series: 'ibmmq:inventory:host', jobs: [], names: ['h1', 'h2'], by: {} },
      queue: { title: 'queue', label: 'queue', per: 'qmgr', query: 'count by (qmgr) (last_over_time(ibmmq_queue_depth{queue=~"ORD.*"}[5m]))', min: { QMORD1: 12, QMPAY1: 4 } },
      bogus: 'not an object',
    },
  },
};

test('validation: the inventory block and the gate block refuse unknown keys and bad shapes', () => {
  assert.doesNotThrow(() => validateInventoryBlock({ site: 'sites/prod/site.json' }, 'j'));
  assert.doesNotThrow(() => validateInventoryBlock({ site: 'x', kinds: ['qmgr'] }, 'j'));
  assert.throws(() => validateInventoryBlock('sites/prod/site.json', 'j'), /inventory must be a mapping/);
  assert.throws(() => validateInventoryBlock({ site: '' }, 'j'), /inventory\.site must name/);
  assert.throws(() => validateInventoryBlock({ site: 'x', kinds: [] }, 'j'), /inventory\.kinds must be a non-empty list/);
  assert.throws(() => validateInventoryBlock({ site: 'x', typo: 1 }, 'j'), /inventory\.typo is not a known key/);
  assert.doesNotThrow(() => validateGateInventory({ maxSilent: 0, minCoveragePct: 90, requireChecked: false, kinds: ['qmgr'] }, 'j'));
  assert.throws(() => validateGateInventory({ maxSilent: -1 }, 'j'), /maxSilent must be a non-negative integer/);
  assert.throws(() => validateGateInventory({ minCoveragePct: 101 }, 'j'), /minCoveragePct must be a number between 0 and 100/);
  assert.throws(() => validateGateInventory({ requireChecked: 'yes' }, 'j'), /requireChecked must be true or false/);
  assert.throws(() => validateGateInventory({ maxSilence: 1 }, 'j'), /gate\.inventory\.maxSilence is not a known key/);
});

test('expectedFromSite normalises kinds and drops garbage; promqlForKind reads up by label or the counted query', () => {
  const e = expectedFromSite(SITE);
  assert.deepEqual(Object.keys(e.kinds), ['qmgr', 'host', 'queue']);
  assert.equal(e.environment, 'prod');
  assert.deepEqual(promqlForKind(e.kinds.qmgr), { mode: 'enumerated', query: 'max by (qmgr) (up{job=~"ibmmq-exporter|ibmmq-native"})', by: 'qmgr' });
  assert.deepEqual(promqlForKind(e.kinds.host), { mode: 'enumerated', query: 'max by (host) (up)', by: 'host' });
  assert.deepEqual(promqlForKind(e.kinds.queue), { mode: 'counted', query: e.kinds.queue.query, by: 'qmgr' });
  assert.equal(expectedFromSite({ environment: 'x' }), null);
  assert.equal(expectedFromSite(null), null);
  // a job name with regex characters is escaped
  assert.match(promqlForKind({ label: 'l', jobs: ['a.b+c'], names: [] }).query, /up\{job=~"a\\\\\.b\\\\\+c"\}/);
});

test('coverageOfKind: up / down / silent / unexpected for an enumerated kind; floors for a counted kind', () => {
  const e = expectedFromSite(SITE);
  const c = coverageOfKind(e.kinds.qmgr, { values: { QMORD1: 1, QMPAY1: 0, QMNEW9: 1 } });
  assert.equal(c.mode, 'enumerated');
  assert.deepEqual([c.expected, c.observed, c.up], [3, 2, 1]);
  assert.deepEqual(c.upNames, ['QMORD1']);
  assert.deepEqual(c.down, ['QMPAY1']);
  assert.deepEqual(c.silent, ['QMFIN1']);
  assert.deepEqual(c.unexpected, ['QMNEW9']);
  assert.equal(c.coveragePct, 33.3);
  assert.equal(c.status, 'checked');
  const failed = coverageOfKind(e.kinds.qmgr, { values: { QMORD1: 1 }, error: 'HTTP 502' });
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'HTTP 502');
  assert.deepEqual([failed.expected, failed.up, failed.observed, failed.silent, failed.coveragePct], [3, null, null, [], null], 'a failed query is not an outage: no numbers, nothing silent');
  const failedCounted = coverageOfKind(e.kinds.queue, { values: {}, error: 'timeout' });
  assert.deepEqual([failedCounted.status, failedCounted.total, failedCounted.below, failedCounted.missing], ['failed', null, [], ['QMORD1', 'QMPAY1']]);
  const zeroFloor = coverageOfKind({ ...e.kinds.queue, min: { QMORD1: 0, QMPAY1: 4 } }, { values: {} });
  assert.deepEqual(zeroFloor.missing, ['QMPAY1'], 'a floor of 0 is met by a parent with no series (count by cannot say 0)');
  const q = coverageOfKind(e.kinds.queue, { values: { QMORD1: 12, QMPAY1: 3 } });
  assert.equal(q.mode, 'counted');
  assert.equal(q.total, 15);
  assert.deepEqual(q.below, [{ parent: 'QMPAY1', count: 3, min: 4 }]);
  assert.deepEqual(q.missing, []);
  const q2 = coverageOfKind(e.kinds.queue, { values: { QMORD1: 12 } });
  assert.deepEqual(q2.missing, ['QMPAY1']);
  const empty = coverageOfKind({ title: 't', label: 'l', jobs: [], names: [], series: null }, { values: {} });
  assert.equal(empty.coveragePct, null, 'an empty expected set is not 100 %');
});

test('buildInventoryRecord: status from the kinds, the not-attempted shape, overrides and the kinds filter', () => {
  const e = expectedFromSite(SITE);
  const obs = { qmgr: { values: { QMORD1: 1, QMPAY1: 1, QMFIN1: 1 } }, host: { values: { h1: 1, h2: 1 } }, queue: { values: { QMORD1: 12, QMPAY1: 4 } } };
  const rec = buildInventoryRecord({ site: 'sites/prod/site.json', expected: e, observations: obs, checkedAt: 't' });
  assert.equal(rec.status, 'checked'); assert.equal(rec.reason, null); assert.equal(rec.environment, 'prod'); assert.equal(rec.site, 'sites/prod/site.json');
  assert.deepEqual(Object.keys(rec.kinds), ['qmgr', 'host', 'queue']);
  const partial = buildInventoryRecord({ expected: e, observations: { ...obs, host: { values: {}, error: 'timeout' } } });
  assert.equal(partial.status, 'partial'); assert.match(partial.reason, /host: timeout/);
  const none = buildInventoryRecord({ expected: e, observations: {} });
  assert.equal(none.status, 'not-attempted');
  assert.deepEqual(none.kinds.qmgr, { mode: 'enumerated', title: 'queue manager', label: 'qmgr', series: e.kinds.qmgr.series, jobs: e.kinds.qmgr.jobs, status: 'not-attempted', error: null, expected: 3, observed: null, up: null, upNames: [], down: [], silent: [], unexpected: [], coveragePct: null }, 'the not-attempted shape keeps the expected count and the series/jobs, no numbers');
  assert.deepEqual(none.kinds.queue.missing, ['QMORD1', 'QMPAY1']);
  const sub = buildInventoryRecord({ expected: e, observations: obs, kinds: ['qmgr'] });
  assert.deepEqual(Object.keys(sub.kinds), ['qmgr']);
  const over = buildInventoryRecord({ expected: e, observations: {}, status: 'not-attempted', reason: 'file-sourced Pack B' });
  assert.equal(over.reason, 'file-sourced Pack B');
  // a kinds: entry the site does not declare is a named failure, not an empty not-attempted
  const typo = buildInventoryRecord({ site: 'sites/prod/site.json', expected: e, observations: obs, kinds: ['qmgrs', 'host'] });
  assert.equal(typo.status, 'failed');
  assert.equal(typo.reason, "inventory.kinds names qmgrs — not in sites/prod/site.json's expected block (kinds: qmgr, host, queue)");
  assert.deepEqual(Object.keys(typo.kinds), ['host'], 'the kinds that do exist are still recorded');
  assert.deepEqual(unknownKinds(e, ['qmgr']), []);
  assert.deepEqual(unknownKinds(e, null), []);
  assert.equal(buildInventoryRecord({ expected: e, observations: obs, status: 'weird' }).status, 'failed', 'an unknown status reads failed');
  assert.deepEqual([...INVENTORY_STATUSES], ['checked', 'partial', 'not-attempted', 'failed']);
});

test('evaluateInventoryGate: requireChecked, the per-kind maxima, coverage, and floors always', () => {
  const e = expectedFromSite(SITE);
  const rec = buildInventoryRecord({ expected: e, observations: { qmgr: { values: { QMORD1: 1, QMPAY1: 0, QMNEW9: 1 } }, host: { values: { h1: 1, h2: 1 } }, queue: { values: { QMORD1: 12, QMPAY1: 3 } } } });
  const run = (gate, inv = rec) => { const out = []; evaluateInventoryGate(gate, inv, (c, d) => out.push({ c, d })); return out; };
  const all = run({ maxSilent: 0, maxDown: 0, maxUnexpected: 0, minCoveragePct: 50 });
  assert.deepEqual(all.map(b => b.c), ['inventory.qmgr.silent', 'inventory.qmgr.down', 'inventory.qmgr.unexpected', 'inventory.qmgr.coverage', 'inventory.queue.min']);
  assert.match(all[0].d, /1 inventoried queue manager with no up series \(max 0\): QMFIN1/);
  assert.match(all[4].d, /3 queues on QMPAY1 \(min 4\)/);
  assert.deepEqual(run({ maxSilent: 1, maxDown: 1, maxUnexpected: 1 }).map(b => b.c), ['inventory.queue.min'], 'floors breach whatever the maxima say');
  assert.deepEqual(run({ kinds: ['host'], maxSilent: 0 }), [], 'kinds narrows the gate');
  const na = buildInventoryRecord({ expected: e, observations: {}, status: 'not-attempted', reason: 'metrics_query not exposed' });
  assert.deepEqual(run({ maxSilent: 0 }, na).map(b => b.c), ['inventory']);
  assert.match(run({ maxSilent: 0 }, na)[0].d, /inventory coverage not-attempted \(metrics_query not exposed\)/);
  assert.deepEqual(run({ maxSilent: 0, requireChecked: false }, na), [], 'requireChecked: false tolerates an unchecked run');
  assert.deepEqual(run({ maxSilent: 0 }, null).map(b => b.c), ['inventory'], 'a gate without an inventory block breaches');
  assert.deepEqual(run(null), []);
});

test('summary, status line and series', () => {
  const e = expectedFromSite(SITE);
  const mk = (i, values) => ({ startedAt: new Date(Date.UTC(2026, 8, 20, 10, i)).toISOString(), inventory: buildInventoryRecord({ expected: e, observations: { qmgr: { values }, host: { values: { h1: 1, h2: 1 } }, queue: { values: { QMORD1: 12, QMPAY1: 4 } } } }) });
  const r = mk(0, { QMORD1: 1, QMPAY1: 0, QMNEW9: 1 });
  const s = inventorySummary(r);
  assert.deepEqual(s.kinds.qmgr, { mode: 'enumerated', title: 'queue manager', status: 'checked', expected: 3, up: 1, down: 1, silent: 1, unexpected: 1, coveragePct: 33.3 });
  assert.deepEqual(s.kinds.queue, { mode: 'counted', title: 'queue', status: 'checked', total: 16, below: 0, missing: 0 });
  assert.equal(inventorySummary({}), null);
  assert.equal(inventoryStatusLine(r), 'inventory 1/3 qmgr (1 down, 1 silent, 1 unexpected) · 2/2 host · 16 queues');
  assert.equal(inventoryStatusLine({ inventory: { status: 'not-attempted', reason: 'file-sourced Pack B', kinds: {} } }), 'inventory not-attempted (file-sourced Pack B)');
  assert.equal(inventoryStatusLine({}), null);
  const runs = [mk(2, { QMORD1: 1, QMPAY1: 1, QMFIN1: 1 }), mk(0, { QMORD1: 1 }), { startedAt: 'x', outcome: 'vantage-lost' }];
  const series = inventorySeries(runs, 'qmgr');
  assert.deepEqual(series.map(p => [p.up, p.silent, p.coveragePct]), [[1, 2, 33.3], [3, 0, 100]]);
  assert.deepEqual(inventorySeries(runs, 'queue'), [], 'counted kinds have no coverage series');
});
