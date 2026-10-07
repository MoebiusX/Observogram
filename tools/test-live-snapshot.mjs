#!/usr/bin/env node
/**
 * tools/test-live-snapshot.mjs
 *
 * The true-snapshot live pack (rebadge batch 3, C1).
 *
 * The contract module tools/lib/live-fetch.mjs — the stage ids and their
 * order, the plan a ping's mapped inventory implies (`run`, `gap`, or
 * `unknown` when tools/list was not read whole — never a claimed gap), the
 * scope's syntax and limits, the annotations that record a scope, and the
 * verdict and reason the diff reads back.
 *
 * The fetch in snapshot mode (tools/fetch-live-pack.mjs fetchMcp({ mode:
 * 'snapshot' }) → buildSnapshotPack) against an in-process MCP fake (the
 * transport's fetchImpl seam; it honours init.signal) that serves the
 * recorded fixtures (tools/fixtures/mcp/) and the synthetic dashboards of
 * tools/fixtures/snapshot/. The mock-MCP golden: the snapshot pack, every
 * clock masked, equals tools/fixtures/golden/snapshot/snapshot.pack.json,
 * and its diff against a repository CRAWLED from tools/fixtures/snapshot/repo/
 * pairs every dashboard (the crawler's id rule) and matches the per-kind
 * counts of snapshot-vs-repo.json. Then: the empty rules API (the recorded
 * series still feed the SLI/SLO inference), core tools only (every gap
 * named and parked, the repository's alert rules not checked), no core
 * abort (the draft still throws), the folder scope before the detail loop,
 * two alert-rule engines unioned, a two-page tools/list, the cancel, the
 * metric-name cap, the gate log's order and counts, a token an MCP echoes
 * never reaching a stage message, and the Grafana-managed rules of the
 * provisioning API (recorded from the local Docker stack's Grafana,
 * tools/fixtures/mcp/grafana_alert_rules.json) unioned with vmalert's, read
 * by title with their folder uid — the rule folder scope applied when every
 * rule names one — and paired with a crawled provisioning file
 * (tools/fixtures/snapshot/repo-grafana/). And pack-conformance's report
 * says liveKind: snapshot for a snapshot only (kept here, beside the
 * snapshot it reads, rather than in the ledger-counted
 * tools/test-pack-conformance.mjs). Tool names come from the capability
 * registry, never typed here.
 *
 *   node tools/test-live-snapshot.mjs            (npm run test:golden:snapshot)
 *   node tools/test-live-snapshot.mjs --update   (rewrite the goldens; review the diff)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIVE_STAGES, LIVE_KINDS, STAGE_STATES, SCOPE_LIMITS, SNAPSHOT_LIMITS, SCOPE_FAMILIES,
  stagesFor, stageNoun, fetchPlan, normalizeScope, scopeIsEmpty, scopeAnnotations, scopeOf, inScope, scopeReason, folderUidOf,
} from './lib/live-fetch.mjs';
import {
  CAPABILITIES, capabilityInventory, probeCandidates, capabilityTool, candidateTool, productAttestedByTool,
} from './lib/contracts/mcp-capabilities.mjs';
import { fetchMcp, buildSnapshotPack, buildCanonicalPack, TOOLS_LIST_MAX_PAGES } from './fetch-live-pack.mjs';
import { crawlFiles } from './lib/crawler.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { validateCanonical, SPEC_DIR } from './lib/validator.mjs';
import { packConformance } from './lib/pack-conformance.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';

delete process.env.OBSERVOGRAM_TRANSPORT_HOOK;
delete process.env.TOMOGRAPH_TRANSPORT_HOOK;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Every candidate tool name of some capabilities: an MCP that advertises them.
const namesOf = (...ids) => ids.flatMap((id) => probeCandidates(id).map((c) => (typeof c === 'string' ? c : c.name)));

test('the stages: ids in fetch order, the draft alone reads the stack signals, every capability a registry id, frozen; stagesFor refuses an unknown kind', () => {
  assert.deepEqual(LIVE_STAGES.map((s) => s.id), ['connect', 'services', 'backends', 'metric_names', 'recording_rules', 'alert_rules', 'dashboards', 'scrape_targets', 'alerting_routes', 'signals', 'build', 'register']);
  assert.deepEqual([...LIVE_KINDS], ['snapshot', 'draft']);
  assert.deepEqual([...STAGE_STATES], ['pending', 'running', 'done', 'failed', 'skipped']);
  assert.deepEqual(stagesFor('draft').map((s) => s.id), LIVE_STAGES.map((s) => s.id));
  assert.deepEqual(stagesFor('snapshot').map((s) => s.id), LIVE_STAGES.map((s) => s.id).filter((id) => id !== 'signals'));
  for (const stage of LIVE_STAGES) {
    for (const id of stage.capabilities) assert.ok(Object.hasOwn(CAPABILITIES, id), `${stage.id}: ${id} is a capability id`);
    assert.ok(Object.isFrozen(stage) && Object.isFrozen(stage.capabilities) && Object.isFrozen(stage.kinds));
  }
  assert.ok(Object.isFrozen(LIVE_STAGES));
  assert.throws(() => stagesFor('scaffold'), /unknown live fetch kind "scaffold" \(snapshot or draft\)/);
  assert.throws(() => stagesFor(undefined), TypeError);
  assert.equal(stageNoun(LIVE_STAGES[1]), 'services');
  assert.equal(stageNoun(LIVE_STAGES[7]), 'scrape targets');
  assert.deepEqual(SCOPE_LIMITS, { prefixes: 32, prefixLength: 100, folders: 32, uidLength: 40 });
  assert.deepEqual(SNAPSHOT_LIMITS, { metricNames: 20000, packBytes: 16777216, messageChars: 300 });
});

test('fetchPlan over a complete listing: a stage runs when any candidate of any of its capabilities is advertised, else it is a gap that says which tool is missing; the stages without capabilities always run', () => {
  const { capabilities } = capabilityInventory([...namesOf('system_health', 'system_topology', 'metric_names', 'dashboards'), 'something_else']);
  const plan = fetchPlan(capabilities, { kind: 'snapshot' });
  assert.deepEqual(plan.map((p) => [p.stage, p.will]), [
    ['connect', 'run'], ['services', 'run'], ['backends', 'gap'], ['metric_names', 'run'], ['recording_rules', 'gap'], ['alert_rules', 'gap'],
    ['dashboards', 'run'], ['scrape_targets', 'gap'], ['alerting_routes', 'gap'], ['build', 'run'], ['register', 'run'],
  ]);
  assert.equal(plan.find((p) => p.stage === 'scrape_targets').reason, 'this MCP offers no scrape targets tool');
  assert.equal(plan.find((p) => p.stage === 'backends').reason, 'this MCP offers no backends and versions tool');
  assert.ok(plan.filter((p) => p.will === 'run').every((p) => p.reason === null));
  // One candidate of a multi-capability stage is enough.
  const onlyDetail = fetchPlan(capabilityInventory(namesOf('dashboard_detail')).capabilities, { kind: 'draft' });
  assert.equal(onlyDetail.find((p) => p.stage === 'dashboards').will, 'run');
  assert.equal(onlyDetail.find((p) => p.stage === 'signals').will, 'run');
  // Every capability advertised: nothing but runs.
  const all = fetchPlan(capabilityInventory(namesOf(...Object.keys(CAPABILITIES))).capabilities, { kind: 'snapshot' });
  assert.ok(all.every((p) => p.will === 'run'));
});

test('fetchPlan over an incomplete or absent listing: a missing capability is unknown with the reason, never a gap; an empty list under a capability is not an offer', () => {
  const { capabilities } = capabilityInventory(namesOf('metric_names'));
  const partial = fetchPlan(capabilities, { kind: 'snapshot', complete: false });
  assert.equal(partial.find((p) => p.stage === 'metric_names').will, 'run');
  const rules = partial.find((p) => p.stage === 'alert_rules');
  assert.deepEqual(rules, { stage: 'alert_rules', will: 'unknown', reason: 'tools/list did not list every tool (a page was left), so whether this MCP offers an alert rules tool is not known' });
  assert.ok(!partial.some((p) => p.will === 'gap'));
  const none = fetchPlan(null, { kind: 'draft' });
  assert.ok(none.filter((p) => p.will !== 'run').every((p) => p.will === 'unknown' && /^tools\/list was not read/.test(p.reason)));
  assert.deepEqual(none.filter((p) => p.will === 'run').map((p) => p.stage), ['connect', 'signals', 'build', 'register']);
  assert.equal(fetchPlan({ metric_names: [] }, { kind: 'snapshot' }).find((p) => p.stage === 'metric_names').will, 'gap');
  assert.throws(() => fetchPlan({}, {}), /unknown live fetch kind/);
});

test('normalizeScope: arrays or comma lists, trimmed and deduplicated in order; nothing is an empty scope', () => {
  assert.deepEqual(normalizeScope(undefined), { scope: { metricPrefixes: [], folderUids: [], datasourceUid: null }, errors: [] });
  assert.deepEqual(normalizeScope({}), { scope: { metricPrefixes: [], folderUids: [], datasourceUid: null }, errors: [] });
  assert.deepEqual(normalizeScope({ metricPrefixes: ['payments_', ' checkout_', 'payments_', 'ns:job:'], folderUids: 'ab12, cd-34,,', datasourceUid: ' prom_1 ' }), {
    scope: { metricPrefixes: ['payments_', 'checkout_', 'ns:job:'], folderUids: ['ab12', 'cd-34'], datasourceUid: 'prom_1' },
    errors: [],
  });
  assert.ok(scopeIsEmpty(normalizeScope(null).scope));
  assert.ok(!scopeIsEmpty({ metricPrefixes: [], folderUids: [], datasourceUid: 'x' }));
  assert.ok(scopeIsEmpty(null));
});

test('normalizeScope refuses by field and rule: a prefix starting with a digit, a uid with a space, an over-long value, too many entries, a non-string, an unknown field, a non-object — a pasted blob is quoted cut', () => {
  const { scope, errors } = normalizeScope({ metricPrefixes: ['ok_', 'x', '1bad'], folderUids: ['x y', 'a'.repeat(41)], datasourceUid: 'p q', extra: 1 });
  assert.deepEqual(errors, [
    'scope.extra is not a scope field (metricPrefixes, folderUids, datasourceUid)',
    'scope.metricPrefixes[2] "1bad" is not a metric-name prefix (letters, digits, _ and :, not starting with a digit)',
    'scope.folderUids[0] "x y" is not a folder uid (1–40 letters, digits, _ and -)',
    `scope.folderUids[1] "${'a'.repeat(41)}" is not a folder uid (1–40 letters, digits, _ and -)`,
    'scope.datasourceUid "p q" is not a datasource uid (1–40 letters, digits, _ and -)',
  ]);
  assert.deepEqual(scope, { metricPrefixes: ['ok_', 'x'], folderUids: [], datasourceUid: null }, 'only what passed is kept');
  const long = normalizeScope({ metricPrefixes: ['a'.repeat(101)] });
  assert.deepEqual(long.errors, [`scope.metricPrefixes[0] "${'a'.repeat(60)}…" is longer than 100 characters`]);
  const many = normalizeScope({ folderUids: Array.from({ length: 33 }, (_, i) => `f${i}`) });
  assert.deepEqual(many.errors, ['scope.folderUids has 33 entries; at most 32']);
  assert.equal(many.scope.folderUids.length, 32);
  assert.deepEqual(normalizeScope({ metricPrefixes: [7] }).errors, ['scope.metricPrefixes[0] is not a string']);
  assert.deepEqual(normalizeScope({ metricPrefixes: { a: 1 } }).errors, ['scope.metricPrefixes is not a list']);
  assert.deepEqual(normalizeScope({ datasourceUid: 5 }).errors, ['scope.datasourceUid is not a string']);
  assert.deepEqual(normalizeScope(['a']).errors, ['scope is not an object (metricPrefixes, folderUids, datasourceUid)']);
  assert.deepEqual(normalizeScope('payments_').errors, ['scope is not an object (metricPrefixes, folderUids, datasourceUid)']);
  assert.deepEqual(normalizeScope({ metricPrefixes: [''] }).errors, ['scope.metricPrefixes[0] "" is not a metric-name prefix (letters, digits, _ and :, not starting with a digit)']);
});

test('scopeAnnotations: the live scope always, with appliesTo; a family\'s scope only where it was applied; folder titles from the search, cut at 100; scopeOf reads them back', () => {
  const scope = { metricPrefixes: ['payments_', 'checkout_'], folderUids: ['ab12', 'zz9'], datasourceUid: null };
  const ann = scopeAnnotations(scope, { folderTitles: { ab12: 'Payments', zz9: 'T'.repeat(120) } });
  assert.deepEqual(Object.keys(ann), ['observogram.live.scope', 'observogram.scope.metric', 'observogram.scope.dashboard']);
  assert.deepEqual(JSON.parse(ann['observogram.live.scope']), {
    metricPrefixes: ['payments_', 'checkout_'], folderUids: ['ab12', 'zz9'], datasourceUid: null,
    appliesTo: { metricPrefixes: ['metric'], folderUids: ['dashboard'] },
  });
  assert.equal(ann['observogram.scope.metric'], '{"by":"prefix","values":["payments_","checkout_"]}');
  assert.deepEqual(JSON.parse(ann['observogram.scope.dashboard']), { by: 'folder', values: [{ uid: 'ab12', title: 'Payments' }, { uid: 'zz9', title: 'T'.repeat(100) }] });
  // The fetcher applied the folders to alert rules too (every rule named its folder), not to recording rules.
  const rules = scopeAnnotations(scope, { applied: ['metric', 'dashboard', 'alert_rule'] });
  assert.deepEqual(Object.keys(rules).sort(), ['observogram.live.scope', 'observogram.scope.alert_rule', 'observogram.scope.dashboard', 'observogram.scope.metric']);
  assert.deepEqual(JSON.parse(rules['observogram.live.scope']).appliesTo, { metricPrefixes: ['metric'], folderUids: ['dashboard', 'alert_rule'] });
  assert.deepEqual(JSON.parse(rules['observogram.scope.alert_rule']).values, [{ uid: 'ab12', title: null }, { uid: 'zz9', title: null }]);
  // An unscoped snapshot says so, and parks nothing.
  const none = scopeAnnotations({ metricPrefixes: [], folderUids: [], datasourceUid: null });
  assert.deepEqual(none, { 'observogram.live.scope': '{"metricPrefixes":[],"folderUids":[],"datasourceUid":null,"appliesTo":{"metricPrefixes":[],"folderUids":[]}}' });
  assert.equal(scopeOf(none).size, 0);
  // Read back.
  const back = scopeOf({ ...ann, 'observogram.unobserved.dashboard': 'x', 'mcp.url': 'https://mcp.test' });
  assert.deepEqual([...back.keys()], ['metric', 'dashboard']);
  assert.deepEqual(back.get('metric'), { by: 'prefix', values: ['payments_', 'checkout_'] });
  assert.equal(back.get('dashboard').values[0].title, 'Payments');
  assert.deepEqual(SCOPE_FAMILIES.folderUids, ['dashboard', 'alert_rule', 'recording_rule']);
});

test('scopeOf ignores what does not parse or holds no value — a family is then compared unscoped, never parked on a guess', () => {
  const back = scopeOf({
    'observogram.scope.metric': '{not json',
    'observogram.scope.dashboard': '{"by":"folder","values":[]}',
    'observogram.scope.alert_rule': '{"by":"guess","values":["x"]}',
    'observogram.scope.recording_rule': '{"by":"folder","values":["ab12",{"uid":""},null,{"uid":"cd","title":7}]}',
    'observogram.scope.': '{"by":"prefix","values":["a"]}',
    'observogram.scope.scrape_job': '{"by":"prefix"}',
  });
  assert.deepEqual([...back.entries()], [['recording_rule', { by: 'folder', values: [{ uid: 'ab12', title: null }, { uid: 'cd', title: null }] }]]);
  assert.equal(scopeOf(null).size, 0);
  assert.equal(scopeOf('x').size, 0);
});

test('inScope: a metric by any of its names against the prefixes, a folded family by its series; a folder by uid; null when the artefact does not say; no entry is inside', () => {
  const prefix = { by: 'prefix', values: ['payments_', 'checkout_'] };
  assert.equal(inScope('metric', { spec: { name: 'payments_total' } }, prefix), true);
  assert.equal(inScope('metric', { spec: { name: 'orders_total' } }, prefix), false);
  assert.equal(inScope('metric', { title: 'checkout_latency', spec: {} }, prefix), true);
  assert.equal(inScope('metric', { spec: { name: 'req' }, series: ['checkout_req_bucket'] }, prefix), true);
  assert.equal(inScope('metric', { spec: {} }, prefix), null);
  assert.equal(inScope('metric', { spec: { name: 'Payments_total' } }, prefix), false, 'metric names are case-sensitive, as the fetch filters them');
  const folder = { by: 'folder', values: [{ uid: 'ab12', title: 'Payments' }] };
  assert.equal(inScope('dashboard', { spec: { params: { folderUid: 'ab12' } } }, folder), true);
  assert.equal(inScope('dashboard', { spec: { params: { folderUid: 'cd34' } } }, folder), false);
  assert.equal(inScope('dashboard', { spec: { folder: 'payments', params: { uid: 'x', title: 'X' } } }, folder), null, 'a crawled dashboard names a folder, not a folder uid');
  assert.equal(inScope('alert_rule', { spec: { folderUid: 'ab12' } }, folder), true);
  assert.equal(inScope('dashboard', { spec: {} }, null), true);
  assert.equal(inScope('dashboard', { spec: {} }, { by: 'other', values: ['x'] }), null);
  assert.equal(folderUidOf({ spec: { folder_uid: 'f1' } }), 'f1');
  assert.equal(folderUidOf(null), null);
});

test('scopeReason states only what is known: "outside" for false, the folders read and what the holder does not say for null, nothing for true', () => {
  const prefix = { by: 'prefix', values: ['payments_', 'checkout_'] };
  const folder = { by: 'folder', values: [{ uid: 'ab12', title: 'Payments' }, { uid: 'zz9', title: null }] };
  assert.equal(scopeReason('metric', false, prefix), "outside the snapshot's metric scope (prefixes payments_, checkout_)");
  assert.equal(scopeReason('metric', null, prefix), 'the snapshot read only metrics with the prefixes payments_, checkout_; Pack A gives this metric no name, so it was not checked');
  assert.equal(scopeReason('dashboard', false, folder), "outside the snapshot's dashboard folders (Payments, zz9)");
  assert.equal(scopeReason('dashboard', null, folder), 'the snapshot read only the folders Payments, zz9; Pack A does not say which folder this dashboard is in, so it was not checked');
  assert.equal(scopeReason('alert_rule', null, folder, { holder: 'b' }), 'the snapshot read only the folders Payments, zz9; Pack B does not say which folder this alert rule is in, so it was not checked');
  assert.equal(scopeReason('recording_rule', false, folder), "outside the snapshot's recording rule folders (Payments, zz9)");
  assert.equal(scopeReason('dashboard', true, folder), null);
  assert.equal(scopeReason('dashboard', false, null), null);
});

test('the module is pure and browser-safe: no import, no process, no node: specifier', () => {
  const src = readFileSync(resolve(__dirname, 'lib', 'live-fetch.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /\bprocess\./);
  assert.doesNotMatch(src, /node:/);
});

// ===========================================================================
// The fetch in snapshot mode, against an in-process MCP fake
// ===========================================================================

const UPDATE = process.argv.includes('--update');
const ROOT = resolve(__dirname, '..');
const GOLDEN_DIR = resolve(__dirname, 'fixtures', 'golden', 'snapshot');
const SNAP_DIR = resolve(__dirname, 'fixtures', 'snapshot');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, SPEC_DIR, 'observability-pack.schema.json'), 'utf8'));
const recorded = (f) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', 'mcp', f), 'utf8'));
const synthetic = (f) => JSON.parse(readFileSync(resolve(SNAP_DIR, f), 'utf8'));

// The tools, by capability (never spelled here).
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
const candidateAttesting = (id, product) => nameOf(probeCandidates(id).find((c) => productAttestedByTool(nameOf(c)) === product));
const T = {
  health: capabilityTool('system_health'),
  topology: capabilityTool('system_topology'),
  anomalies: capabilityTool('anomalies_active'),
  baselines: capabilityTool('anomalies_baselines'),
  vmalert: candidateAttesting('alert_rules', 'vmalert'),
  promRules: nameOf(probeCandidates('alert_rules')[1]),          // the Prometheus /api/v1/rules candidate (attests nothing)
  metricNames: nameOf(probeCandidates('metric_names')[0]),
  targets: nameOf(probeCandidates('scrape_configs')[0]),
  amStatus: nameOf(probeCandidates('alerting_routes')[0]),
  search: candidateTool('dashboards', 'search'),
  detail: capabilityTool('dashboard_detail'),
  grafanaHealth: capabilityTool('grafana_version'),
  grafanaRules: candidateAttesting('alert_rules', 'grafana'),
};
assert.equal(productAttestedByTool(T.promRules), null, 'the second alert-rule candidate is the plain Prometheus API');

const URL_ = 'https://mcp.snapshot.test/mcp';
const ORIGIN = 'https://mcp.snapshot.test';
const AT = '2026-10-07T12:00:00.000Z';
const TOKEN = 'tok-snapshot-SECRET-42';

const SEARCH = synthetic('grafana_dashboards_search.json');
const DETAIL = synthetic('grafana_dashboard_get.json');
const searchAnswer = () => ({ count: SEARCH.count, results: SEARCH.results });
const detailAnswer = (args) => DETAIL.byUid[args.uid] ?? { isError: `dashboard ${args.uid} not found` };

// The full fake: the recorded rules, metric names, targets and Alertmanager
// status; the synthetic dashboards; stub health and topology.
function fullTools(overrides = {}) {
  return {
    [T.health]: () => ({ services: [] }),
    [T.topology]: () => ({ dependencies: [] }),
    [T.anomalies]: () => ({}),
    [T.baselines]: () => ({ baselines: [] }),
    [T.vmalert]: () => recorded('vmalert_rules.json'),
    [T.metricNames]: () => recorded('metrics_label_values.json'),
    [T.targets]: () => recorded('metrics_targets.json'),
    [T.amStatus]: () => recorded('alertmanager_status.json'),
    [T.search]: searchAnswer,
    [T.detail]: detailAnswer,
    [T.grafanaHealth]: () => ({ version: '12.4.4', commit: 'synthetic', database: 'ok' }),
    ...overrides,
  };
}

// `tools`: { <name>: (args) => answer | { isError: text } }, advertised in
// insertion order over `pages` tools/list pages. `hang`: never answer a
// tools/call (it still rejects when init.signal aborts). `echo`: an isError
// text that repeats the Authorization header, for these tools.
function fakeMcp(tools, { pages = 1, hang = false, echo = [] } = {}) {
  const calls = [];
  const names = Object.keys(tools);
  const perPage = Math.max(1, Math.ceil(names.length / pages));
  const fetchImpl = (url, init) => new Promise((resolveP, rejectP) => {
    const msg = JSON.parse(init.body);
    calls.push({ method: msg.method, name: msg.params?.name ?? null, args: msg.params?.arguments ?? null });
    const onAbort = () => rejectP(init.signal.reason ?? new DOMException('aborted', 'AbortError'));
    if (init.signal?.aborted) return onAbort();
    init.signal?.addEventListener('abort', onAbort, { once: true });
    if (hang && msg.method === 'tools/call') return;
    init.signal?.removeEventListener('abort', onAbort);
    if (msg.id === undefined) return resolveP(new Response(null, { status: 202 }));
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
    else if (msg.method === 'tools/list') {
      const page = msg.params?.cursor ? Number(msg.params.cursor) : 0;
      const slice = names.slice(page * perPage, (page + 1) * perPage).map((name) => ({ name, description: '' }));
      result = { tools: slice, ...(page + 1 < pages ? { nextCursor: String(page + 1) } : {}) };
    } else if (msg.method === 'tools/call') {
      const name = msg.params.name;
      let out = tools[name] ? tools[name](msg.params.arguments ?? {}) : { isError: `unknown tool: ${name}` };
      if (echo.includes(name)) out = { isError: `upstream refused: Authorization: ${init.headers.Authorization ?? '(none)'}` };
      result = out && typeof out === 'object' && 'isError' in out
        ? { isError: true, content: [{ type: 'text', text: out.isError }] }
        : { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
    resolveP(new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });
  return { calls, transport: { fetchImpl } };
}

async function snapshotOf(tools, { scope = null, fakeOpts = {}, mcpAuth = null, signal = null } = {}) {
  const fake = fakeMcp(tools, fakeOpts);
  const records = [];
  const fetched = await fetchMcp({ mcpUrl: URL_, mcpAuth, refreshedAt: AT, transport: fake.transport, mode: 'snapshot', scope, onStage: (r) => records.push(r), signal });
  const pack = buildSnapshotPack(fetched, { refreshedAt: AT, origin: ORIGIN, endpoint: { id: 3, name: 'gw' }, scope });
  return { fake, records, fetched, pack };
}

// A pack with every clock masked (the fetcher's own instants).
function masked(pack) {
  const out = JSON.parse(JSON.stringify(pack));
  for (const k of Object.keys(out.metadata.annotations)) {
    if (k === 'mcp.fetchStartedAt' || k.startsWith('mcp.observedAt.')) out.metadata.annotations[k] = '<time>';
  }
  return out;
}

// The repository side: crawled, never hand-written.
function crawledRepo(dir = 'repo') {
  const root = resolve(SNAP_DIR, dir);
  const files = new Map();
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = resolve(d, f);
      if (statSync(p).isDirectory()) walk(p); else files.set(relative(root, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(root);
  return crawlFiles(files, { repoName: 'snapshot-repo', now: AT }).canonical;
}

const kindOf = (key) => key.slice(0, key.indexOf('::'));
// Per kind: how many entries each bucket holds.
function countsByKind(d) {
  const out = {};
  for (const bucket of ['inBoth', 'onlyInA', 'onlyInB', 'notObserved', 'outOfScope']) {
    for (const layer of Object.values(d.layers)) {
      for (const e of layer[bucket]) {
        const k = kindOf(e.key);
        out[k] ??= {};
        out[k][bucket] = (out[k][bucket] ?? 0) + 1;
      }
    }
  }
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}
const entries = (d, bucket, kind) => Object.values(d.layers).flatMap((l) => l[bucket]).filter((e) => kindOf(e.key) === kind);

function golden(name, value) {
  const file = resolve(GOLDEN_DIR, name);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) { mkdirSync(GOLDEN_DIR, { recursive: true }); writeFileSync(file, text); return; }
  assert.equal(text, readFileSync(file, 'utf8'), `${name}: the golden (node tools/test-live-snapshot.mjs --update, then review the diff)`);
}

const MAIN_SCOPE = { metricPrefixes: ['alertmanager_', 'up'] };

test('the mock-MCP golden: the snapshot pack is byte-identical to snapshot.pack.json, valid, and labelled; its diff against the crawled repository pairs every dashboard', async () => {
  const { pack, records } = await snapshotOf(fullTools(), { scope: MAIN_SCOPE, mcpAuth: TOKEN });
  assert.deepEqual(validateCanonical(pack, SCHEMA), [], 'the snapshot validates');
  golden('snapshot.pack.json', masked(pack));
  const ann = pack.metadata.annotations;
  assert.equal(pack.metadata.name, 'live-snapshot');
  assert.equal(ann['mcp.url'], ORIGIN, 'the origin only');
  assert.equal(ann['observogram.live.mode'], 'snapshot');
  assert.deepEqual(JSON.parse(ann['observogram.live.source']), { origin: ORIGIN, endpoint: { id: 3, name: 'gw' } });
  assert.deepEqual(JSON.parse(ann['observogram.live.scope']), { metricPrefixes: ['alertmanager_', 'up'], folderUids: [], datasourceUid: null, appliesTo: { metricPrefixes: ['metric'], folderUids: [] } });
  assert.deepEqual(JSON.parse(ann['observogram.scope.metric']), { by: 'prefix', values: ['alertmanager_', 'up'] });
  // The recorded Alertmanager status is scrubbed of its configuration: the
  // routes stage is a gap, named and parked.
  assert.deepEqual(JSON.parse(ann['observogram.live.gaps']).map((g) => g.stage), ['alerting_routes']);
  assert.match(ann['observogram.unobserved.alert_route'], /^the alerting routes tool got no answer/);
  assert.ok(!JSON.stringify(pack).includes(TOKEN), 'no token in the pack');
  // Real identities: the crawler's dashboard ids.
  assert.deepEqual(pack.spec.dashboards.map((d) => d.id).sort(), ['a--b', 'd-3b5d5c3712955042212316173ccf37be', 'd-9xyz-abc', 'node-exporter-full', 'orders-main']);
  assert.ok(pack.spec.dashboards.every((d) => (d.panel_bindings || []).every((p) => p.binds_to.startsWith(`ref:grafana/${d.id}/panels/`))), 'panel refs rebuilt from the same id');
  assert.ok(records.every((r) => r.stage !== 'signals'), 'a snapshot reads no stack signals');

  const repo = crawledRepo();
  const d = diffPacks(adapt(repo), adapt(pack));
  const byKind = countsByKind(d);
  assert.equal(byKind.dashboard.inBoth, 5, 'dashboard inBoth equals the dashboard count');
  assert.ok(!byKind.dashboard.onlyInA && !byKind.dashboard.onlyInB);
  assert.equal(byKind.alert_rule.inBoth, 2, 'both alert rules pair by name');
  assert.equal(byKind.scrape_job.inBoth, 1);
  assert.ok(byKind.metric.inBoth >= 2, 'the declared metrics under the prefixes pair by name');
  const orders = entries(d, 'notObserved', 'metric').find((e) => e.a?.title === 'checkout_orders_total' || JSON.stringify(e).includes('checkout_orders_total'));
  assert.ok(orders, 'the repository metric outside the prefixes is not checked');
  assert.equal(orders.reason, "outside the snapshot's metric scope (prefixes alertmanager_, up)");
  assert.ok(!entries(d, 'onlyInA', 'metric').some((e) => JSON.stringify(e).includes('checkout_orders_total')), 'never "declared, not live"');
  assert.ok(d.summary.inBoth > 0);
  golden('snapshot-vs-repo.json', { summary: d.summary, byKind });
});

test('the empty rules API: the recorded series in the metric names still feed recording rules, SLIs and SLOs — with a metric prefix set too', async () => {
  const inventory = recorded('metrics_label_values.json');
  const names = { ...inventory, values: [...inventory.values, 'checkout:requests:good_5m', 'checkout:requests:total_5m'] };
  const tools = fullTools({ [T.metricNames]: () => names, [T.promRules]: () => recorded('metrics_alerts.empty.json') });
  delete tools[T.vmalert];
  const repo = adapt(crawledRepo());
  for (const scope of [null, { metricPrefixes: ['alertmanager_'] }]) {
    const { pack, records } = await snapshotOf(tools, { scope });
    const d = diffPacks(repo, adapt(pack));
    const byKind = countsByKind(d);
    for (const kind of ['recording_rule', 'sli', 'slo']) assert.ok(byKind[kind]?.inBoth > 0, `${kind} pairs (scope ${JSON.stringify(scope)})`);
    const rec = records.filter((r) => r.stage === 'recording_rules').pop();
    assert.equal(rec.state, 'done');
    assert.equal(rec.counts.fromInventory, 2, 'counted under recording_rules');
    assert.ok(!records.some((r) => r.stage === 'alert_rules' && r.gap), 'an honest empty answer is no gap');
  }
});

test('core tools only: done, every other reading stage skipped and named, the gaps listed and parked — the repository alert rules not checked, never "declared, not live"', async () => {
  const tools = { [T.health]: () => ({ services: [] }), [T.topology]: () => ({ dependencies: [] }) };
  const { pack, records } = await snapshotOf(tools);
  assert.deepEqual(validateCanonical(pack, SCHEMA), []);
  const last = new Map(records.map((r) => [r.stage, r]));
  for (const stage of ['backends', 'metric_names', 'recording_rules', 'alert_rules', 'dashboards', 'scrape_targets', 'alerting_routes']) {
    assert.equal(last.get(stage).state, 'skipped', `${stage} skipped`);
    assert.equal(last.get(stage).gap.reason, `this MCP offers no ${stageNoun(LIVE_STAGES.find((s) => s.id === stage))} tool`);
  }
  assert.equal(last.get('services').state, 'done');
  const ann = pack.metadata.annotations;
  assert.deepEqual(JSON.parse(ann['observogram.live.gaps']).map((g) => g.stage), ['backends', 'metric_names', 'recording_rules', 'alert_rules', 'dashboards', 'scrape_targets', 'alerting_routes'], 'in stage order');
  assert.equal(ann['observogram.unobserved.alert_rule'], 'this MCP offers no alert rules tool');
  assert.equal(ann['observogram.unobserved.burn_rate'], 'this MCP offers no alert rules tool');
  assert.equal(ann['observogram.unobserved.dashboard'], 'this MCP offers no dashboards tool');
  const d = diffPacks(adapt(crawledRepo()), adapt(pack));
  const rules = entries(d, 'notObserved', 'alert_rule');
  assert.equal(rules.length, 2);
  assert.ok(rules.every((e) => e.reason === 'this MCP offers no alert rules tool'));
  assert.equal(entries(d, 'onlyInA', 'alert_rule').length, 0);
  for (const kind of ['dashboard', 'scrape_job', 'metric', 'recording_rule']) assert.equal(entries(d, 'onlyInA', kind).length, 0, `no ${kind} silently "declared, not live"`);
});

test('without system_health and system_topology a snapshot is done with the services gap; the draft over the same MCP still throws, and its canonical is the same with onStage set', async () => {
  const tools = fullTools();
  delete tools[T.health];
  delete tools[T.topology];
  const { pack, records } = await snapshotOf(tools);
  const services = records.filter((r) => r.stage === 'services').pop();
  assert.equal(services.state, 'skipped');
  assert.deepEqual(services.gap, { capability: 'system_health', reason: 'this MCP offers no service-health tool; the snapshot holds no service list' });
  assert.deepEqual(validateCanonical(pack, SCHEMA), []);
  await assert.rejects(fetchMcp({ mcpUrl: URL_, transport: fakeMcp(tools).transport }), /core MCP tools unavailable/);

  // The draft: byte-identical with and without the reporter and a signal.
  const draftOf = async (extra) => {
    const fetched = await fetchMcp({ mcpUrl: URL_, refreshedAt: AT, transport: fakeMcp(fullTools()).transport, ...extra });
    assert.equal(fetched.snapshot, undefined, 'a draft answer carries no snapshot key');
    return JSON.stringify(masked(buildCanonicalPack({ refreshedAt: AT, mcpUrl: URL_, ...fetched })));
  };
  const seen = [];
  const plain = await draftOf({});
  const reported = await draftOf({ onStage: (r) => seen.push(r), signal: new AbortController().signal });
  assert.equal(reported, plain);
  assert.ok(!plain.includes('observogram.live.'), 'a draft writes no observogram.live.* annotation');
  assert.ok(seen.some((r) => r.stage === 'signals' && r.state === 'done'), 'the draft reports its stack-signals stage');
  assert.ok(seen.every((r) => stagesFor('draft').some((s) => s.id === r.stage)));
  // A reporter that throws changes nothing.
  assert.equal(await draftOf({ onStage: () => { throw new Error('reporter down'); } }), plain);
});

test('the folder scope: dashboards narrowed before the detail loop, unfoldered ones counted; rule groups without folder uids leave the scope unapplied and say so; a datasource uid is named', async () => {
  const results = [...SEARCH.results, { uid: 'loose', title: 'No folder', type: 'dash-db', tags: [] }];
  const tools = fullTools({ [T.search]: () => ({ count: results.length, results }) });
  const scope = { folderUids: ['ab12'], datasourceUid: 'prom-main' };
  const { pack, fake, records } = await snapshotOf(tools, { scope });
  const details = fake.calls.filter((c) => c.name === T.detail).map((c) => c.args.uid);
  assert.deepEqual(details, ['node_exporter_full', '3b5d5c3712955042212316173ccf37be', 'a--b'], 'only the folder\'s dashboards are read in detail');
  const dash = records.filter((r) => r.stage === 'dashboards').pop();
  assert.equal(dash.state, 'done');
  assert.deepEqual(dash.counts, { listed: 6, kept: 3, unfoldered: 1, detailed: 3, detailFailed: 0 });
  assert.match(dash.message, /1 dashboard named no folder/);
  const alerts = records.filter((r) => r.stage === 'alert_rules').pop();
  assert.match(alerts.message, /^the rule groups name no folder uid; the folder scope was not applied to alert rules \(all \d+ kept\)$/);
  const metrics = records.filter((r) => r.stage === 'metric_names').pop();
  assert.equal(metrics.message, 'datasource uid "prom-main" not applied — no advertised tool takes a datasource uid');
  const ann = pack.metadata.annotations;
  assert.deepEqual(JSON.parse(ann['observogram.scope.dashboard']), { by: 'folder', values: [{ uid: 'ab12', title: 'Payments' }] });
  assert.equal(ann['observogram.scope.alert_rule'], undefined, 'not applied, not written');
  assert.deepEqual(JSON.parse(ann['observogram.live.scope']).appliesTo, { metricPrefixes: [], folderUids: ['dashboard'] });
  // The diff: crawled dashboards name no folder uid — the null reason, never "outside".
  const d = diffPacks(adapt(crawledRepo()), adapt(pack));
  const parked = entries(d, 'notObserved', 'dashboard');
  assert.equal(parked.length, 2);
  assert.ok(parked.every((e) => e.reason === 'the snapshot read only the folders Payments; Pack A does not say which folder this dashboard is in, so it was not checked'));
  assert.equal(entries(d, 'inBoth', 'dashboard').length, 3);
});

test('two alert-rule engines answering: the rules unioned by name, the first engine winning a clash, engines: 2; each rule\'s engine from its own tool', async () => {
  const prometheus = { data: { groups: [{ name: 'prom', rules: [
    { type: 'alerting', name: 'HighErrorRate', query: 'vector(1) > 0', labels: { severity: 'warning' } },
    { type: 'alerting', name: 'DiskAlmostFull', query: 'node_filesystem_avail_bytes / node_filesystem_size_bytes < 0.1', labels: { severity: 'warning' } },
  ] }] } };
  const { pack, records } = await snapshotOf(fullTools({ [T.promRules]: () => prometheus }));
  const alerts = records.filter((r) => r.stage === 'alert_rules').pop();
  assert.equal(alerts.state, 'done');
  assert.equal(alerts.counts.engines, 2);
  const rules = pack.spec.alerting.rules;
  const high = rules.find((r) => r.name === 'HighErrorRate');
  const disk = rules.find((r) => r.name === 'DiskAlmostFull');
  assert.equal(high.engine, 'victoriametrics', 'the first engine (vmalert) wins the clash');
  assert.notEqual(high.expr, 'vector(1) > 0');
  assert.ok(disk && disk.engine === undefined, 'a rule only the Prometheus API holds: its engine is the default');
  assert.equal(rules.filter((r) => r.name === 'HighErrorRate').length, 1);
});

test('a two-page tools/list is read whole; an MCP that does not answer tools/list fails connect', async () => {
  const { records, fetched } = await snapshotOf(fullTools(), { fakeOpts: { pages: 2 } });
  const connect = records.filter((r) => r.stage === 'connect').pop();
  assert.equal(connect.state, 'done');
  assert.deepEqual(connect.counts, { tools: Object.keys(fullTools()).length, pages: 2 });
  assert.ok(fetched.probeResults.dashboards.outcome === 'data', 'a tool on the second page is used');
  assert.ok(TOOLS_LIST_MAX_PAGES >= 2);
  const broken = { transport: { fetchImpl: async (url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.method === 'tools/list') return new Response('nope', { status: 404 });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  } } };
  const seen = [];
  await assert.rejects(fetchMcp({ mcpUrl: URL_, transport: broken.transport, mode: 'snapshot', onStage: (r) => seen.push(r) }), /^Error: connect: the MCP did not answer tools\/list/);
  assert.equal(seen.pop().state, 'failed');
});

test('cancel: a fetch whose MCP never answers a tool call ends promptly with an AbortError when its signal aborts', async () => {
  const ac = new AbortController();
  const started = Date.now();
  const pending = snapshotOf(fullTools(), { fakeOpts: { hang: true }, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.ok(Date.now() - started < 5000, 'promptly');
  // Aborted before it starts: nothing is called.
  const fake = fakeMcp(fullTools());
  const done = new AbortController();
  done.abort();
  await assert.rejects(fetchMcp({ mcpUrl: URL_, transport: fake.transport, mode: 'snapshot', signal: done.signal }), (e) => e.name === 'AbortError');
  assert.equal(fake.calls.length, 0);
});

test('the metric-name cap: kept the first 20000, the stage says so and how to narrow it', async () => {
  const many = Array.from({ length: SNAPSHOT_LIMITS.metricNames + 5 }, (_, i) => `m_${String(i).padStart(6, '0')}`);
  const { records, pack } = await snapshotOf(fullTools({ [T.metricNames]: () => ({ label: '__name__', values: many }) }));
  const rec = records.filter((r) => r.stage === 'metric_names').pop();
  assert.deepEqual(rec.counts, { listed: SNAPSHOT_LIMITS.metricNames + 5, kept: SNAPSHOT_LIMITS.metricNames });
  assert.equal(rec.message, `listed ${SNAPSHOT_LIMITS.metricNames + 5}, kept the first ${SNAPSHOT_LIMITS.metricNames} — set metric prefixes to narrow it`);
  assert.equal(pack.metadata.annotations['mcp.discovered.metric_names_count'], String(SNAPSHOT_LIMITS.metricNames));
});

test('the gate log: snapshot stage ids only, connect first, each reading stage running then ended, the counts of the full fake; a token an MCP echoes is in no stage message; a bad scope refused', async () => {
  const { records } = await snapshotOf(fullTools(), { scope: MAIN_SCOPE, mcpAuth: TOKEN, fakeOpts: { echo: [T.targets] } });
  const ids = stagesFor('snapshot').map((s) => s.id);
  assert.ok(records.every((r) => ids.includes(r.stage) && STAGE_STATES.includes(r.state)));
  assert.deepEqual(records.slice(0, 2).map((r) => [r.stage, r.state]), [['connect', 'running'], ['connect', 'done']]);
  for (const stage of ['services', 'backends', 'metric_names', 'recording_rules', 'alert_rules', 'dashboards', 'scrape_targets', 'alerting_routes']) {
    const own = records.filter((r) => r.stage === stage);
    assert.equal(own[0].state, 'running', `${stage} starts running`);
    assert.ok(['done', 'skipped', 'failed'].includes(own.at(-1).state), `${stage} ends`);
  }
  const last = new Map(records.map((r) => [r.stage, r]));
  const vm = recorded('vmalert_rules.json').groups.flatMap((g) => g.rules);
  assert.deepEqual(last.get('alert_rules').counts, { listed: vm.filter((r) => r.type === 'alerting').length, kept: vm.filter((r) => r.type === 'alerting').length, engines: 1 });
  assert.equal(last.get('dashboards').counts.detailed, 5);
  assert.deepEqual(last.get('metric_names').counts, { listed: recorded('metrics_label_values.json').values.length, kept: recorded('metrics_label_values.json').values.filter((n) => n.startsWith('alertmanager_') || n.startsWith('up')).length });
  const targets = last.get('scrape_targets');
  assert.equal(targets.state, 'failed');
  assert.ok(targets.gap.reason.includes('<redacted>'), 'the client redacted the echo');
  assert.ok(!JSON.stringify(records).includes(TOKEN), 'no token in any stage record');
  assert.ok(records.every((r) => (r.message ?? '').length <= SNAPSHOT_LIMITS.messageChars && (r.gap?.reason ?? '').length <= SNAPSHOT_LIMITS.messageChars));
  await assert.rejects(fetchMcp({ mcpUrl: URL_, transport: fakeMcp(fullTools()).transport, mode: 'snapshot', scope: { metricPrefixes: ['1bad'] } }), /scope\.metricPrefixes\[0\] "1bad" is not a metric-name prefix/);
  await assert.rejects(fetchMcp({ mcpUrl: URL_, transport: fakeMcp(fullTools()).transport, mode: 'nope' }), /unknown mode/);
  assert.throws(() => buildSnapshotPack({}, {}), /origin required/);
});

test('Grafana-managed rules (the recorded provisioning answer) join vmalert\'s: unioned by title, engine grafana, the recording rule left out; the folder scope is not applied while vmalert names no folder', async () => {
  const PROVISIONED = recorded('grafana_alert_rules.json');
  const scope = { folderUids: ['payments-alerts'] };
  const tools = fullTools({ [T.grafanaRules]: () => PROVISIONED });
  delete tools[T.search];
  delete tools[T.detail];
  const { pack, records } = await snapshotOf(tools, { scope });
  const alerts = records.filter((r) => r.stage === 'alert_rules').pop();
  const vmAlerting = recorded('vmalert_rules.json').groups.flatMap((g) => g.rules).filter((r) => r.type === 'alerting');
  const grafanaAlerting = PROVISIONED.filter((r) => !r.record);
  assert.equal(alerts.counts.engines, 2);
  assert.equal(alerts.counts.listed, vmAlerting.length + grafanaAlerting.length);
  assert.equal(alerts.message, `the rule groups name no folder uid; the folder scope was not applied to alert rules (all ${alerts.counts.kept} kept)`);
  const rules = pack.spec.alerting.rules;
  const payments = rules.find((r) => r.name === 'PaymentsErrorRatioHigh');
  assert.equal(payments.engine, 'grafana');
  assert.equal(payments.expr, PROVISIONED.find((r) => r.title === 'PaymentsErrorRatioHigh').data[0].model.expr, 'the query node, not an expression node');
  assert.equal(payments.for, '5m');
  assert.ok(rules.some((r) => r.name === 'StackValidationAlwaysFiring'));
  assert.ok(!rules.some((r) => r.name === PROVISIONED.find((x) => x.record).title), 'a Grafana-managed recording rule is no alert rule');
  assert.ok(rules.filter((r) => r.engine === 'victoriametrics').length > 0, 'vmalert\'s rules keep their engine');
  assert.equal(pack.metadata.annotations['observogram.scope.alert_rule'], undefined);
  assert.deepEqual(validateCanonical(pack, SCHEMA), []);
});

test('Grafana-managed rules alone: the rule folder scope is applied and recorded; the provisioned rule pairs with a crawled provisioning file, a Prometheus-format repository rule reads not checked (its folder unknown), never "declared, not live"', async () => {
  const PROVISIONED = recorded('grafana_alert_rules.json');
  const scope = { folderUids: ['payments-alerts'] };
  const tools = fullTools({ [T.grafanaRules]: () => PROVISIONED });
  for (const t of [T.vmalert, T.search, T.detail]) delete tools[t];
  const { pack, records } = await snapshotOf(tools, { scope });
  const alerts = records.filter((r) => r.stage === 'alert_rules').pop();
  assert.equal(alerts.state, 'done');
  assert.equal(alerts.message, null);
  assert.deepEqual({ engines: alerts.counts.engines, listed: alerts.counts.listed, kept: alerts.counts.kept }, { engines: 1, listed: 2, kept: 1 });
  assert.deepEqual(pack.spec.alerting.rules.map((r) => [r.name, r.engine]), [['PaymentsErrorRatioHigh', 'grafana']]);
  const ann = pack.metadata.annotations;
  assert.deepEqual(JSON.parse(ann['observogram.scope.alert_rule']), { by: 'folder', values: [{ uid: 'payments-alerts', title: null }] });
  assert.deepEqual(JSON.parse(ann['observogram.live.scope']).appliesTo.folderUids, ['alert_rule']);
  assert.deepEqual(validateCanonical(pack, SCHEMA), []);
  const d = diffPacks(adapt(crawledRepo('repo-grafana')), adapt(pack));
  assert.deepEqual(entries(d, 'inBoth', 'alert_rule').map((e) => e.key), ['alert_rule::{"name":"paymentserrorratiohigh"}']);
  const parked = entries(d, 'notObserved', 'alert_rule');
  assert.equal(parked.length, 1);
  assert.equal(parked[0].reason, 'the snapshot read only the folders payments-alerts; Pack A does not say which folder this alert rule is in, so it was not checked');
  assert.equal(entries(d, 'onlyInA', 'alert_rule').length, 0);
});

// ---------- pack-conformance: a live snapshot says so ----------

const LIVE_INPUTS = { health: { services: [{ name: 'svc-checkout' }] }, topology: { dependencies: [] }, anomaliesActive: {}, baselinesData: { baselines: [] }, errors: {} };

test('pack-conformance liveKind: a snapshot\'s report carries liveKind: snapshot beside writers.fetcher; another mode value has none', () => {
  const snap = buildSnapshotPack(LIVE_INPUTS, { refreshedAt: '2026-06-06T00:00:00Z', origin: 'https://fake-mcp.test' });
  const pc = packConformance(snap);
  assert.equal(pc.liveKind, 'snapshot');
  assert.equal(pc.writers.fetcher, true);
  assert.deepEqual(Object.keys(pc).slice(0, 3), ['name', 'writers', 'liveKind']);
  const other = packConformance({ ...snap, metadata: { ...snap.metadata, annotations: { ...snap.metadata.annotations, 'observogram.live.mode': 'draft' } } });
  assert.ok(!('liveKind' in other), 'only the snapshot mode is read');
});

test('pack-conformance: a draft\'s report is unchanged — no liveKind key, the keys in their order (a fetcher-written report without liveKind is a scaffold); no example pack has one', () => {
  const draft = buildCanonicalPack({ refreshedAt: '2026-06-06T00:00:00Z', mcpUrl: 'https://fake-mcp.test/observability', ...LIVE_INPUTS });
  const pc = packConformance(draft);
  assert.ok(!('liveKind' in pc));
  assert.equal(pc.writers.fetcher, true);
  assert.deepEqual(Object.keys(pc), ['name', 'writers', 'markers', 'rows', 'counts', 'conformant']);
  for (const f of readdirSync(resolve(ROOT, 'examples')).filter((x) => x.endsWith('.pack.yaml'))) {
    assert.ok(!('liveKind' in packConformance(parseYaml(readFileSync(resolve(ROOT, 'examples', f), 'utf8')))), `${f}: no liveKind`);
  }
});
