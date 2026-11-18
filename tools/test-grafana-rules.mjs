#!/usr/bin/env node
/**
 * tools/test-grafana-rules.mjs — Grafana-managed alert rules pair with what
 * live reads (SPEC P4, defect 5: 208 declared, 330 live, 0 paired).
 *
 * A repository that provisions its alert rules as Grafana files and records no
 * SLI took the scan's no-recorded-SLI path: each rule became an SLO, an SLI and
 * a burn-rate entry named after its title — and alerting.rules held none, so
 * the 330 rules the ruler answered for the same folder were out of scope and
 * the 208 invented entries read "declared, not live". Now:
 *   - the scan declares every such rule in alerting.rules, as live lists it;
 *     the entries it invents from names are marked placeholders;
 *   - both readers state what a Grafana-managed rule says beyond the spec —
 *     uid, folder, group and its condition (the threshold node) — so a
 *     threshold changed in Grafana reads drifted and a rule renamed there pairs
 *     by its uid;
 *   - the ruler's answer is read; every draft reads every alert-rule engine;
 *   - what a read could not hold is not checked, never "declared, not live".
 * Fixture pair: tools/fixtures/crawl/grafana-rules (README there).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { crawlFiles } from './lib/crawler.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { scopeAnnotations } from './lib/live-fetch.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { grafanaRuleCondition, grafanaRuleFacts } from './lib/sli-inference.mjs';
import { fetchMcp, buildCanonicalPack, PROBES } from './fetch-live-pack.mjs';
import { probeCandidates, capabilityTool, productAttestedByTool } from './lib/contracts/mcp-capabilities.mjs';
import { evaluateGate } from './lib/journey.mjs';
import { partialLiveEvidence } from '../studio/diagnostic-grade.mjs';

delete process.env.OBSERVOGRAM_TRANSPORT_HOOK;
const SCHEMA = JSON.parse(readFileSync(new URL(`../${SPEC_SCHEMA_PATH}`, import.meta.url), 'utf8'));
const FIX = new URL('./fixtures/crawl/grafana-rules/', import.meta.url);
const read = (name) => readFileSync(new URL(name, FIX), 'utf8');
const YAML = read('shop.yaml');
const RULER = JSON.parse(read('live/ruler.json'));
const PROVISIONING = JSON.parse(read('live/provisioning.json'));
const FOLDER_UID = 'shop-alerts';
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---- the tools, by the registry's words (never a hardcoded name) ----
const nameOf = (c) => (typeof c === 'string' ? c : c.name);
const attesting = (id, product) => nameOf(probeCandidates(id).find((c) => productAttestedByTool(nameOf(c)) === product));
const T = {
  health: capabilityTool('system_health'), topology: capabilityTool('system_topology'),
  grafana: attesting('alert_rules', 'grafana'), vmalert: attesting('alert_rules', 'vmalert'),
  alertmanager: attesting('alert_rules', 'alertmanager'),
  // A Prometheus-API rule tool the registry attests to nothing.
  prometheus: probeCandidates('alert_rules').map(nameOf).find((n) => !productAttestedByTool(n)),
  // Another unattested one (a Grafana MCP's own listing, say).
  other: probeCandidates('alert_rules').map(nameOf).filter((n) => !productAttestedByTool(n))[1],
};

// An in-process MCP: `tools` name → (args) → answer ({ isError } for an error); `listed: false` answers no tools/list.
function fakeMcp(tools, { listed = true } = {}) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const msg = JSON.parse(init.body);
    if (msg.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (msg.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
    else if (msg.method === 'tools/list') {
      if (!listed) return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      result = { tools: Object.keys(tools).map((name) => ({ name, description: '' })) };
    } else {
      calls.push(msg.params.name);
      const fn = tools[msg.params.name];
      const out = fn ? fn(msg.params.arguments ?? {}) : { isError: `unknown tool: ${msg.params.name}` };
      result = out && typeof out === 'object' && 'isError' in out ? { isError: true, content: [{ type: 'text', text: out.isError }] } : { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { transport: { fetchImpl }, calls };
}
const CORE = { [T.health]: () => ({ services: [{ name: 'shop' }] }), [T.topology]: () => ({ dependencies: [] }) };
// A live draft as the Services Run reads one (tools/lib/journey.mjs resolvePackB); `mode: 'snapshot'`
// reads as a snapshot does, `probeMemory` is a journey's memory (fetchMcp's).
async function livePack(tools, { scope = null, listed = true, mode = 'draft', probeMemory = null } = {}) {
  const fake = fakeMcp({ ...CORE, ...tools }, { listed });
  const fetched = await fetchMcp({ mcpUrl: 'https://mcp.shop.example/mcp', transport: fake.transport, mode, ...(scope ? { scope } : {}), ...(probeMemory ? { probeMemory } : {}) });
  const canonical = buildCanonicalPack({ refreshedAt: '2026-11-16T00:00:00Z', mcpUrl: 'https://mcp.shop.example', ...fetched });
  if (fetched.liveScope) canonical.metadata.annotations = { ...canonical.metadata.annotations, ...scopeAnnotations(fetched.liveScope.scope, fetched.liveScope.learned) };
  return { canonical, fetched, calls: fake.calls };
}
const scan = (files) => crawlFiles(files, { repoName: 'shop', environment: 'staging', now: '2026-11-16T00:00:00.000Z' });
const DECLARED = scan({ 'grafana/provisioning/alerting/shop.yaml': YAML }).canonical;

// The alert-rule and burn-rate entries of a diff, by bucket.
function rules(d) {
  const out = { inBoth: [], onlyInA: [], onlyInB: [], notObserved: [], scaffold: [], outOfScope: [] };
  for (const layer of Object.values(d.layers)) {
    for (const bucket of Object.keys(out)) {
      for (const e of layer[bucket] || []) if (/^(alert_rule|burn_rate)::/.test(e.key)) out[bucket].push(e);
    }
  }
  return out;
}
const alertKeys = (list) => list.filter((e) => e.key.startsWith('alert_rule::')).map((e) => e.key).sort();

// ---------------------------------------------------------------------------

test('a repository holding only Grafana provisioning rules declares each in alerting.rules under its exact title (engine grafana, its uid, folder, group and condition beside it); the SLO, SLI and burn-rate entry derived from each name are placeholders', () => {
  const rules = DECLARED.spec.alerting.rules;
  assert.deepEqual(rules.map((r) => [r.name, r.engine]), [['CheckoutErrorRatioHigh', 'grafana'], ['PaymentsLatencyHigh', 'grafana'], ['CartPodRestarts', 'grafana']]);
  assert.deepEqual(JSON.parse(DECLARED.metadata.annotations['observogram.grafana_rule.alerting.rules[1]']),
    { uid: 'payments-latency', folder: 'Shop', group: 'shop', condition: 'B = reduce(last, A); C = threshold(B > 0.5); condition C' });
  const layered = adapt(DECLARED);
  assert.ok(layered.layers.L4.policy.filter((a) => a.id.startsWith('POL-')).every((a) => a.source === 'Scaffold'), 'every burn-rate entry a placeholder');
  assert.ok(layered.layers.L1.every((a) => a.source === 'Scaffold'), 'every SLO and SLI derived from a name a placeholder');
  assert.deepEqual(layered.layers.L4.alerting.filter((a) => a.id.startsWith('RULE-')).map((a) => [a.title, a.source, a.grafana?.uid]),
    [['CheckoutErrorRatioHigh', 'Declared', 'checkout-errors'], ['PaymentsLatencyHigh', 'Declared', 'payments-latency'], ['CartPodRestarts', 'Declared', 'cart-restarts']]);
  assert.equal(DECLARED.metadata.annotations['crawler.syntheticRecordingRulesSkipped'], '3', 'the invented SLOs stay (one per alert)');
  assert.deepEqual(validateCanonical(DECLARED, SCHEMA), []);
});

test('grafanaRuleCondition: one text for a provisioning file, the provisioning API and the ruler — thresholds (and recovery), reduce modes, math, classic conditions, resample, sql, another query, the condition reference, paused; none for a rule it cannot read; cut at 2000', () => {
  const file = scan({ 'shop.yaml': YAML }).canonical.metadata.annotations;
  const fromFile = JSON.parse(file['observogram.grafana_rule.alerting.rules[0]']).condition;
  const api = clone(PROVISIONING).find((r) => r.uid === 'checkout-errors');
  const ruler = clone(RULER).Shop[0].rules.find((r) => r.grafana_alert.uid === 'checkout-errors');
  assert.equal(fromFile, 'B = threshold(A > 0.05); condition B');
  assert.equal(grafanaRuleCondition(api), fromFile, 'the provisioning API');
  assert.equal(grafanaRuleCondition(ruler), fromFile, 'the ruler (its grafana_alert)');
  const q = (refId, expr) => ({ refId, datasourceUid: 'prom', model: { refId, expr } });
  const x = (refId, model) => ({ refId, datasourceUid: '__expr__', model: { refId, ...model } });
  const rule = (data, extra = {}) => ({ title: 'R', data, ...extra });
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), x('B', { type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'lt', params: ['3'] }, unloadEvaluator: { type: 'gte', params: [0.050] } }] })], { condition: 'B' })),
    'B = threshold(A < 3, recover >= 0.05); condition B');
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), x('B', { type: 'reduce', expression: 'A', reducer: 'mean', settings: { mode: 'dropNN' } }), x('C', { type: 'reduce', expression: 'A', reducer: 'max', settings: { mode: 'replaceNN', replaceWithValue: 7 } })])),
    'B = reduce(mean, A, dropNN); C = reduce(max, A, replaceNN 7)');
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), x('B', { type: 'math', expression: '$A * 100' }), x('C', { type: 'resample', expression: 'A', window: '1m', downsampler: 'mean', upsampler: 'fillna' }), x('D', { type: 'sql', expression: 'SELECT 1' })], { isPaused: true })),
    'B = math($A * 100); C = resample(A, 1m, mean, fillna); D = sql(SELECT 1); paused');
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), x('B', { type: 'classic_conditions', conditions: [{ query: { params: ['A'] }, reducer: { type: 'avg' }, evaluator: { type: 'within_range', params: [1, 2] } }, { operator: { type: 'or' }, query: { params: ['A'] }, reducer: { type: 'last' }, evaluator: { type: 'no_value', params: [] } }] })])),
    'B = classic(avg(A) within 1..2 or last(A) no value)');
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), q('B', 'down')], { condition: 'A' })), 'B = query(down); condition A', 'a second query');
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), x('B', { type: 'custom', zeta: { b: 1, a: 2 }, alpha: 1 })])), 'B = custom({"alpha":1,"type":"custom","zeta":{"a":2,"b":1}})', 'canonical JSON, keys sorted at every depth');
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), { refId: 'B', model: '{not json' }])), null, 'a model that does not parse: no condition stated');
  assert.equal(grafanaRuleCondition(rule([q('A', 'up'), { datasourceUid: '__expr__', model: { type: 'math', expression: 'A' } }])), null, 'a node with no ref');
  assert.equal(grafanaRuleCondition({ alert: 'X', expr: 'up == 0' }), null, 'not Grafana-managed');
  assert.equal(grafanaRuleFacts({ alert: 'X', expr: 'up == 0' }), null);
  const long = grafanaRuleCondition(rule([q('A', 'up'), x('B', { type: 'math', expression: 'a'.repeat(3000) })]));
  assert.ok(long.length === 2000 && long.endsWith('…'), 'cut at 2000');
});

test('the ruler\'s answer is read: each alerting rule with its uid, folder title and uid, group and condition; a Grafana-managed recording rule is no alert rule; an empty ruler is an honest zero; an unscoped draft reads the provisioning and ruler shapes', async () => {
  const alertProbe = PROBES.find((p) => p.name === 'alert_rules');
  const withRecording = clone(RULER);
  withRecording.Shop[0].rules.push({ grafana_alert: { title: 'shop:orders:rate5m', uid: 'rec', record: { metric: 'shop:orders:rate5m', from: 'A' }, data: [{ refId: 'A', model: { expr: 'rate(orders_total[5m])' } }] } });
  const read = alertProbe.adapt(withRecording);
  assert.deepEqual(read.map((r) => [r.name, r.folderUid, r.group]), [['CheckoutErrorRatioHigh', FOLDER_UID, 'shop'], ['PaymentsLatencyHigh', FOLDER_UID, 'shop'], ['CartPodRestarts #2', FOLDER_UID, 'shop']]);
  assert.deepEqual(read[1].grafana, { uid: 'payments-latency', folder: 'Shop', folderUid: FOLDER_UID, group: 'shop', condition: 'B = reduce(last, A); C = threshold(B > 0.8); condition C' });
  assert.ok(read.every((r) => r.expr && !r.expr.startsWith('B')), 'the query node, never the condition');
  assert.deepEqual(alertProbe.adapt({}), [], 'an empty ruler: no rule');
  for (const [label, answer] of [['ruler', RULER], ['provisioning', PROVISIONING]]) {
    const { canonical, fetched } = await livePack({ [T.grafana]: () => clone(answer) });
    assert.equal(fetched.probeResults.alert_rules.outcome, 'data', label);
    assert.deepEqual(canonical.spec.alerting.rules.map((r) => [r.name, r.engine]), [['CheckoutErrorRatioHigh', 'grafana'], ['PaymentsLatencyHigh', 'grafana'], ['CartPodRestarts #2', 'grafana']], label);
    assert.equal(JSON.parse(canonical.metadata.annotations['observogram.grafana_rule.alerting.rules[2]']).uid, 'cart-restarts', label);
    assert.deepEqual(validateCanonical(canonical, SCHEMA), [], label);
  }
  const empty = await livePack({ [T.grafana]: () => ({}) });
  assert.equal(empty.fetched.probeResults.alert_rules.outcome, 'empty', 'an empty ruler answers: nothing there');
});

test('the fixture pair: the provisioning file against what Grafana answers for the same three rules — one unchanged, one renamed with a suffix (its uid kept), one with its threshold raised — is 3 pairs, 1 aligned and 2 drifted (name, by uid; condition), 0 declared-not-live, 0 live-not-declared: through the ruler\'s and the provisioning API\'s answers, unscoped and folder-scoped', async () => {
  for (const [label, answer] of [['ruler', RULER], ['provisioning', PROVISIONING]]) {
    for (const scope of [null, { folderUids: [FOLDER_UID] }]) {
      const tools = { [T.grafana]: (args) => (args.folder_uid && Array.isArray(answer) ? clone(answer).filter((r) => r.folderUID === args.folder_uid) : clone(answer)) };
      const { canonical } = await livePack(tools, { scope });
      const d = diffPacks(adapt(DECLARED), adapt(canonical));
      const r = rules(d);
      const where = `${label}${scope ? ' + folder scope' : ''}`;
      assert.deepEqual(r.inBoth.map((e) => [e.key, e.match, e.matchedBy ?? null, e.deltas.map((x) => [x.field, x.a, x.b])]).sort(), [
        ['alert_rule::{"name":"cartpodrestarts"}', 'drifted', 'uid', [['name', 'CartPodRestarts', 'CartPodRestarts #2']]],
        ['alert_rule::{"name":"checkouterrorratiohigh"}', 'aligned', null, []],
        ['alert_rule::{"name":"paymentslatencyhigh"}', 'drifted', null, [['condition', 'B = reduce(last, A); C = threshold(B > 0.5); condition C', 'B = reduce(last, A); C = threshold(B > 0.8); condition C']]],
      ], where);
      assert.deepEqual([r.onlyInA.length, r.onlyInB.length, r.notObserved.length, r.outOfScope.length], [0, 0, 0, 0], where);
      assert.ok(r.scaffold.some((e) => e.side === 'a') && r.scaffold.every((e) => e.key.startsWith('burn_rate::')), `${where}: the burn-rate placeholders parked`);
      assert.deepEqual([d.summary.aligned, d.summary.drifted], [1, 2], where);
    }
  }
});

test('a rule renamed in Grafana counts once in the summary (C1 beside the uid pass): alone it is the comparison — a union of one, drifted, a figure of 0, never "nothing compared"; beside a live rule the repository does not declare, its family is still declared, so that rule reads live-not-declared, never out of scope', async () => {
  const only = (uids) => { const j = JSON.parse(read('shop.json')); j.groups[0].rules = j.groups[0].rules.filter((r) => uids.includes(r.uid)); return JSON.stringify(j); };
  const declared = adapt(scan({ 'alerting/shop.json': only(['cart-restarts']) }).canonical);
  // The alert rules alone, so the summary is theirs.
  const rulesOnly = (layered) => ({ ...layered, layers: { L4: { alerting: (layered.layers.L4?.alerting || []).filter((a) => a.id.startsWith('RULE-')) } } });
  const liveOf = async (uids) => adapt((await livePack({ [T.grafana]: () => clone(PROVISIONING).filter((r) => uids.includes(r.uid)) })).canonical);
  const alone = diffPacks(rulesOnly(declared), rulesOnly(await liveOf(['cart-restarts'])));
  const s = alone.summary;
  assert.deepEqual([s.inBoth, s.drifted, s.aligned, s.onlyInA, s.onlyInB, s.outOfScope, s.union], [1, 1, 0, 0, 0, 0, 1], JSON.stringify(s));
  assert.deepEqual([s.jaccard, s.alignment], [1, 0], 'a figure over the pair: never null, never 1');
  // The family scope: a family the repository declares holds every live member of it.
  const beside = diffPacks(rulesOnly(declared), rulesOnly(await liveOf(['cart-restarts', 'checkout-errors'])), { scopeMode: 'family' });
  const r = rules(beside);
  assert.deepEqual(r.inBoth.map((e) => [e.key, e.matchedBy]), [['alert_rule::{"name":"cartpodrestarts"}', 'uid']]);
  assert.deepEqual([alertKeys(r.onlyInB), r.outOfScope.length], [['alert_rule::{"name":"checkouterrorratiohigh"}'], 0], 'the family is declared');
  assert.deepEqual([beside.summary.union, beside.summary.alignment], [2, 0]);
});

test('a listing that shows no condition (the bridge\'s flat listing) compares on the query alone, never a difference: the pair says the condition went uncompared; with no uid on either side a renamed rule is one declared-not-live and one live-not-declared, and two rules under one name with two uids still pair by name; a non-default identity mode never pairs by uid', async () => {
  const flat = { rules: clone(PROVISIONING).map((r) => ({ name: r.title, type: 'alerting', expr: r.data[0].model.expr, for: r.for, labels: r.labels, annotations: r.annotations || {} })) };
  const { canonical } = await livePack({ [T.grafana]: () => flat });
  const d = diffPacks(adapt(DECLARED), adapt(canonical));
  const r = rules(d);
  const pay = r.inBoth.find((e) => e.key === 'alert_rule::{"name":"paymentslatencyhigh"}');
  assert.deepEqual([pay.match, pay.unobserved], ['aligned', [{ field: 'condition', side: 'b', keys: [] }]], 'the threshold went uncompared, said');
  assert.deepEqual(alertKeys(r.onlyInA), ['alert_rule::{"name":"cartpodrestarts"}'], 'no uid live: the rename is not paired');
  assert.deepEqual(alertKeys(r.onlyInB), ['alert_rule::{"name":"cartpodrestarts #2"}']);
  assert.ok(d.summary.partlyCompared >= 2, 'counted as compared in part');
  // Same name both sides: name pairing, whatever the uids.
  const twoUids = clone(PROVISIONING).map((r) => ({ ...r, uid: `${r.uid}-x`, title: r.uid === 'cart-restarts' ? 'CartPodRestarts' : r.title }));
  const byName = rules(diffPacks(adapt(DECLARED), adapt((await livePack({ [T.grafana]: () => twoUids })).canonical)));
  assert.equal(byName.inBoth.filter((e) => e.matchedBy).length, 0, 'never re-paired by uid');
  assert.equal(byName.inBoth.length, 3);
  // A mode that keys by name only (identity-modes.mjs) gets no uid pass.
  const named = rules(diffPacks(adapt(DECLARED), adapt((await livePack({ [T.grafana]: () => clone(PROVISIONING) })).canonical), { identity: 'name' }));
  assert.equal(named.inBoth.filter((e) => e.matchedBy === 'uid').length, 0, 'name mode: no uid pairing');
});

test('every draft reads every advertised alert-rule engine, unioned by store: a Grafana-managed rule whose title vmalert also holds is kept beside it; vmalert and a Prometheus-API tool listing one rule stay one; an unattested tool answering Grafana rules is Grafana\'s store', async () => {
  const vm = { groups: [{ name: 'shop', rules: [{ name: 'CheckoutErrorRatioHigh', type: 'alerting', query: 'up == 0', duration: 300, labels: { severity: 'critical' } }, { name: 'DiskFull', type: 'alerting', query: 'node_filesystem_avail_bytes < 1', labels: {} }] }] };
  const prom = { data: { groups: [{ name: 'shop', rules: [{ name: 'DiskFull', type: 'alerting', query: 'node_filesystem_avail_bytes < 1', labels: {} }] }] } };
  const { canonical, calls } = await livePack({ [T.vmalert]: () => vm, [T.prometheus]: () => prom, [T.grafana]: () => clone(PROVISIONING) });
  for (const t of [T.vmalert, T.prometheus, T.grafana]) assert.ok(calls.includes(t), `${t} called`);
  assert.deepEqual(canonical.spec.alerting.rules.map((r) => `${r.name}/${r.engine ?? 'prometheus'}`).sort(),
    ['CartPodRestarts #2/grafana', 'CheckoutErrorRatioHigh/grafana', 'CheckoutErrorRatioHigh/victoriametrics', 'DiskFull/victoriametrics', 'PaymentsLatencyHigh/grafana']);
  // An unattested tool whose answer is Grafana's provisioning shape.
  const other = await livePack({ [T.vmalert]: () => vm, [T.other]: () => clone(PROVISIONING) });
  assert.ok(other.canonical.spec.alerting.rules.filter((r) => r.engine === 'grafana').length === 3, 'its rules are Grafana-managed');
  assert.equal(JSON.parse(other.canonical.metadata.annotations['observogram.unread.alert_rule']).grafana, undefined, 'and Grafana\'s store is not "not read"');
});

test('without tools/list a draft does not call every candidate: each store stops at its first answer with rules, and the Alertmanager\'s firing alerts are asked only when no store had any', async () => {
  // A recording rule too, so the recording-rule probe (which shares vmalert's tool) stops there as well.
  const vm = { groups: [{ name: 'shop', rules: [{ name: 'DiskFull', type: 'alerting', query: 'node_filesystem_avail_bytes < 1', labels: {} }, { record: 'node:fs:ratio', query: 'sum(x)' }] }] };
  const { calls, fetched } = await livePack({ [T.vmalert]: () => vm, [T.grafana]: () => clone(PROVISIONING) }, { listed: false });
  const alertTools = probeCandidates('alert_rules').map(nameOf);
  const called = calls.filter((c) => alertTools.includes(c));
  assert.ok(called.includes(T.vmalert) && called.includes(T.grafana), JSON.stringify(called));
  assert.ok(!called.includes(T.alertmanager) && called.filter((c) => !productAttestedByTool(c)).length === 0, `the ruler store stopped at vmalert: ${called}`);
  assert.equal(fetched.probeResults.alert_rules.outcome, 'data');
  assert.equal(fetched.probeResults.alert_rules.partial, undefined, 'a tool that is not there is no failure');
});

test('a read refused (C6, inside the union): no engine with rules and one refused is a FAILED family, its refusal kept (never an honest zero); rules beside a refused engine stand, the read is partial (mcp.probesPartial) and the engine\'s error kept; the Alertmanager\'s evidence never fails the family', async () => {
  const refused = () => ({ isError: 'HTTP 403: Forbidden' });
  for (const scope of [null, { ruleGroups: ['shop'] }]) {
    const where = scope ? 'rule-group scope' : 'unscoped';
    const empty = await livePack({ [T.vmalert]: () => ({ groups: [] }), [T.grafana]: refused }, { scope });
    const a = empty.canonical.metadata.annotations;
    assert.equal(empty.fetched.probeResults.alert_rules.outcome, 'failed', where);
    assert.match(a['mcp.probeErrors.alert_rules'], /HTTP 403/, where);
    assert.match(a['mcp.probesFailed'], /alert_rules/, where);
    assert.match(a['observogram.unobserved.alert_rule'], /HTTP 403/, `${where}: every declared rule parked`);
    const beside = await livePack({ [T.vmalert]: () => ({ groups: [{ name: 'shop', rules: [{ name: 'DiskFull', type: 'alerting', query: 'up == 0', labels: {} }] }] }), [T.grafana]: refused }, { scope });
    const b = beside.canonical.metadata.annotations;
    assert.equal(beside.fetched.probeResults.alert_rules.outcome, 'data', where);
    assert.deepEqual([b['mcp.probesPartial'], /HTTP 403/.test(b['mcp.probeErrors.alert_rules']), b['mcp.probesFailed']], ['alert_rules', true, ''], where);
    assert.match(JSON.parse(b['observogram.unread.alert_rule']).grafana, /^the Grafana alert-rule tool got no answer: .*HTTP 403.*, so Grafana-managed rules were not read$/, where);
  }
  const evidence = await livePack({ [T.vmalert]: () => ({ groups: [] }), [T.alertmanager]: () => ({ isError: 'HTTP 500' }) });
  assert.equal(evidence.fetched.probeResults.alert_rules.outcome, 'empty', 'the firing-alerts tool failing is no failure of the declarations');
});

test('an answer in no alert-rule shape, or one listing rules without their expressions, is no answer — the family is not read and says why, never an honest zero', async () => {
  for (const [answer, why] of [[{ items: [1] }, /no alert-rule listing shape this reader knows/], [{ rules: [{ name: 'A' }, { name: 'B' }] }, /lists alert rules without their expressions/]]) {
    const { fetched, canonical } = await livePack({ [T.grafana]: () => answer });
    assert.equal(fetched.probeResults.alert_rules.outcome, 'failed', JSON.stringify(answer));
    assert.match(canonical.metadata.annotations['mcp.probeErrors.alert_rules'], why);
  }
  // Under a folder scope the same answer, given for a folder, is the engine's failure with that reason: the
  // whole estate is never asked for (on a shared Grafana its listing passed the response cap, and that error
  // replaced the true one).
  const seen = [];
  const scoped = await livePack({ [T.grafana]: (args) => { seen.push(args); return { rules: [{ name: 'A' }, { name: 'B' }] }; } }, { scope: { folderUids: ['shop-alerts', 'shop-more'] } });
  assert.ok(seen.length >= 1 && seen.every((a) => Object.keys(a).length > 0), `every call carried its folder: ${JSON.stringify(seen)}`);
  assert.equal(scoped.fetched.probeResults.alert_rules.outcome, 'failed');
  assert.match(scoped.canonical.metadata.annotations['mcp.probeErrors.alert_rules'], /lists alert rules without their expressions/);
});

test('what a read could not hold is not checked, with the reason: a declared Grafana-managed rule against a read with no Grafana alert-rule tool, a declared Prometheus rule against a Grafana-only read, a Loki rule and a Grafana-managed recording rule against any read; a draft whose whole alert-rule family is blind parks the alert rules too', async () => {
  const vmOnly = await livePack({ [T.vmalert]: () => ({ groups: [{ name: 'x', rules: [{ name: 'DiskFull', type: 'alerting', query: 'up == 0', labels: {} }] }] }) });
  const r1 = rules(diffPacks(adapt(DECLARED), adapt(vmOnly.canonical)));
  assert.equal(r1.onlyInA.length, 0, 'never declared-not-live');
  assert.deepEqual(alertKeys(r1.notObserved), ['alert_rule::{"name":"cartpodrestarts"}', 'alert_rule::{"name":"checkouterrorratiohigh"}', 'alert_rule::{"name":"paymentslatencyhigh"}']);
  assert.ok(r1.notObserved.every((e) => e.reason === 'this MCP offers no Grafana alert-rule tool, so Grafana-managed rules were not read'), r1.notObserved.map((e) => e.reason).join(' | '));
  // A repository with a Prometheus rule, a Loki rule and a Grafana-managed recording rule, against a Grafana-only read.
  const mixed = scan({
    'prometheus/shop.rules.yml': 'groups:\n  - name: shop\n    rules:\n      - alert: ShopDown\n        expr: up{job="shop"} == 0\n',
    'loki/rules.yaml': 'groups:\n  - name: logs\n    rules:\n      - alert: ShopLogErrors\n        expr: sum(rate({app="shop"} |= "error" [5m])) > 1\n',
    'grafana/provisioning/alerting/rec.yaml': 'apiVersion: 1\ngroups:\n  - name: rec\n    folder: Shop\n    rules:\n      - uid: rec-1\n        title: shop:latency:p95_5m\n        record:\n          metric: shop:latency:p95_5m\n          from: A\n        data:\n          - refId: A\n            model:\n              expr: histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))\n',
  }).canonical;
  assert.ok(mixed.metadata.annotations['observogram.grafana_rule.queries.recording_rules[0]'], 'the Grafana-managed recording rule says so');
  const unreadOf = (d) => Object.values(d.layers).flatMap((l) => l.notObserved).filter((e) => /^(alert_rule|recording_rule)::/.test(e.key)).map((e) => [e.key, e.reason]).sort();
  const declaredNotLive = (d) => Object.values(d.layers).flatMap((l) => l.onlyInA).filter((e) => /^(alert_rule|recording_rule)::/.test(e.key)).map((e) => e.key);
  // A Grafana-only read: the Prometheus rule and the Loki rule were not read (no ruler, no Loki tool); it offers no
  // recording-rule tool at all, so that family is parked whole.
  const grafanaOnly = diffPacks(adapt(mixed), adapt((await livePack({ [T.grafana]: () => clone(PROVISIONING) })).canonical));
  assert.deepEqual(unreadOf(grafanaOnly), [
    ['alert_rule::{"name":"shopdown"}', 'this MCP offers no Prometheus-compatible rule tool, so rules a Prometheus-compatible ruler evaluates were not read'],
    ['alert_rule::{"name":"shoplogerrors"}', 'no alert-rule tool reads a Loki ruler, so Loki rules were not read'],
    ['recording_rule::{"record":"shop:latency:p95_5m"}', 'this MCP offers no recording rules tool'],
  ]);
  assert.deepEqual(declaredNotLive(grafanaOnly), []);
  // A read whose recording-rule family answered (vmalert): a Grafana-managed recording rule is still no ruler's. Grafana's
  // alert-rule answer was read, and may hold it, but is read for its alert rules alone: not compared, and said so — never
  // "not read". With no Grafana alert-rule tool, it was not read.
  const vmRec = { groups: [{ name: 'slo', rules: [{ record: 'shop:requests:ratio_5m', query: 'sum(x)' }, { name: 'ShopDown', type: 'alerting', query: 'up{job="shop"} == 0', labels: {} }] }] };
  const withRecording = diffPacks(adapt(mixed), adapt((await livePack({ [T.vmalert]: () => vmRec, [T.grafana]: () => clone(PROVISIONING) })).canonical));
  assert.deepEqual(unreadOf(withRecording), [
    ['alert_rule::{"name":"shoplogerrors"}', 'no alert-rule tool reads a Loki ruler, so Loki rules were not read'],
    ['recording_rule::{"record":"shop:latency:p95_5m"}', 'Grafana-managed recording rules are not compared: no recording-rule tool reads them, and the Grafana alert-rule answer is read for its alert rules alone, so they were not checked'],
  ]);
  assert.deepEqual(declaredNotLive(withRecording), [], 'the Prometheus rule pairs; nothing reads declared, not live');
  const noGrafana = diffPacks(adapt(mixed), adapt((await livePack({ [T.vmalert]: () => vmRec })).canonical));
  assert.equal(unreadOf(noGrafana).find(([key]) => key.startsWith('recording_rule::'))?.[1], 'no recording-rule tool reads Grafana-managed recording rules, so they were not read');
  // The whole family blind (refused everywhere, or not offered): the declared alert rules are not checked.
  for (const tools of [{ [T.grafana]: () => ({ isError: 'HTTP 403: Forbidden' }) }, {}]) {
    const blind = await livePack(tools);
    const r3 = rules(diffPacks(adapt(DECLARED), adapt(blind.canonical)));
    assert.deepEqual([alertKeys(r3.onlyInA), alertKeys(r3.notObserved).length], [[], 3], JSON.stringify(Object.keys(tools)));
  }
});

test('a JSON export reads as the YAML one', () => {
  const fromJson = scan({ 'alerting/shop.json': read('shop.json') }).canonical;
  assert.deepEqual(fromJson.spec.alerting.rules.map((r) => [r.name, r.expr, r.for]), DECLARED.spec.alerting.rules.map((r) => [r.name, r.expr, r.for]));
  assert.equal(fromJson.metadata.annotations['observogram.grafana_rule.alerting.rules[2]'], DECLARED.metadata.annotations['observogram.grafana_rule.alerting.rules[2]']);
});

test('the rule groups a read listed are recorded before a rule-group scope narrows them, with their folder; a folder\'s title the ruler names is learned for the folder scope, so a declared rule that states only its folder title is compared', async () => {
  const vm = { groups: [{ name: 'infra', rules: [{ name: 'DiskFull', type: 'alerting', query: 'up == 0', labels: {} }, { record: 'node:cpu:ratio', query: 'sum(x)' }] }] };
  const scoped = await livePack({ [T.vmalert]: () => vm, [T.grafana]: () => clone(RULER) }, { scope: { ruleGroups: ['shop'] } });
  assert.deepEqual(JSON.parse(scoped.canonical.metadata.annotations['mcp.discovered.rule_groups']),
    [{ group: 'infra', alert: 1, recording: 1 }, { group: 'shop', folderUid: FOLDER_UID, alert: 3, recording: 0, folder: 'Shop' }]);
  assert.deepEqual(scoped.canonical.spec.alerting.rules.map((r) => r.name).sort(), ['CartPodRestarts #2', 'CheckoutErrorRatioHigh', 'PaymentsLatencyHigh'], 'the scope narrowed the rules');
  // Under a folder scope the ruler names the folder's title: the declared rule (folder "Shop") is inside.
  const folder = await livePack({ [T.grafana]: () => clone(RULER) }, { scope: { folderUids: [FOLDER_UID] } });
  assert.deepEqual(JSON.parse(folder.canonical.metadata.annotations['observogram.scope.alert_rule']).values, [{ uid: FOLDER_UID, title: 'Shop' }]);
  const declaredFolderOnly = clone(DECLARED);
  const r = rules(diffPacks(adapt(declaredFolderOnly), adapt(folder.canonical)));
  assert.deepEqual([r.inBoth.length, r.notObserved.length], [3, 0]);
  // A title the live read does not name: not checked, and the reason names the folder the repository states.
  const other = clone(DECLARED);
  other.metadata.annotations['observogram.grafana_rule.alerting.rules[0]'] = JSON.stringify({ ...JSON.parse(other.metadata.annotations['observogram.grafana_rule.alerting.rules[0]']), uid: 'other-uid', folder: 'Elsewhere' });
  other.spec.alerting.rules[0].name = 'SomethingElse';
  const r2 = rules(diffPacks(adapt(other), adapt(folder.canonical)));
  const parked = r2.notObserved.find((e) => e.key === 'alert_rule::{"name":"somethingelse"}');
  assert.equal(parked?.reason, 'outside the snapshot\'s alert rule folders (Shop)', 'every folder named and none so: outside');
});

test('a Grafana-managed rule on an SLO\'s recorded series states its condition among the rules of the burn-rate entry: a threshold loosened live reads drifted on condition, named by the rule', async () => {
  const rec = 'groups:\n  - name: slo\n    rules:\n      - record: checkout:requests:ratio_5m\n        expr: sum(rate(http_requests_total{code!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))\n';
  const alert = (threshold) => ({ uid: 'burn', title: 'CheckoutBurn', condition: 'B', for: '5m', labels: { severity: 'critical' }, data: [{ refId: 'A', datasourceUid: 'prom', model: { refId: 'A', expr: 'checkout:requests:ratio_5m < 0.99' } }, { refId: 'B', datasourceUid: '__expr__', model: { refId: 'B', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params: [threshold] } }] } }] });
  const file = `apiVersion: 1\ngroups:\n  - name: slo\n    folder: Shop\n    rules:\n      - uid: burn\n        title: CheckoutBurn\n        condition: B\n        for: 5m\n        labels:\n          severity: critical\n        data:\n          - refId: A\n            datasourceUid: prom\n            model:\n              refId: A\n              expr: checkout:requests:ratio_5m < 0.99\n          - refId: B\n            datasourceUid: __expr__\n            model:\n              refId: B\n              type: threshold\n              expression: A\n              conditions:\n                - evaluator:\n                    type: gt\n                    params: [0]\n`;
  const declared = scan({ 'prometheus/slo.rules.yml': rec, 'grafana/provisioning/alerting/burn.yaml': file }).canonical;
  const vm = { groups: [{ name: 'slo', rules: [{ record: 'checkout:requests:ratio_5m', query: 'sum(rate(http_requests_total{code!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))' }] }] };
  const live = await livePack({ [T.vmalert]: () => vm, [T.grafana]: () => [{ ...alert(0.5), folderUID: FOLDER_UID, ruleGroup: 'slo' }] });
  const d = diffPacks(adapt(declared), adapt(live.canonical));
  const burn = Object.values(d.layers).flatMap((l) => l.inBoth).find((e) => e.key.startsWith('burn_rate::'));
  assert.equal(burn?.match, 'drifted', JSON.stringify(burn?.deltas));
  assert.deepEqual(burn.deltas.filter((x) => x.field === 'condition').map((x) => [x.rule, x.a, x.b]), [['CheckoutBurn', 'B = threshold(A > 0); condition B', 'B = threshold(A > 0.5); condition B']]);
});

// ---- what a rule's own source states, one rule two tools list, a store that serves none ----

test('a rule is a Loki rule only when its own expression says so — a pipeline stage PromQL has no operator for — never by the path it ships under nor by a selector PromQL has too: a mixin\'s PromQL alert on loki_* series that is missing live reads declared-not-live wherever it ships, and fails the gate', async () => {
  const rec = 'groups:\n  - name: slo\n    rules:\n      - record: shop:requests:rate5m\n        expr: sum(rate(http_requests_total{job="shop"}[5m]))\n      - alert: ShopDown\n        expr: up{job="shop"} == 0\n';
  const mixin = 'groups:\n  - name: loki_alerts\n    rules:\n      - alert: LokiRequestErrors\n        expr: sum(rate(loki_request_duration_seconds_count{status_code=~"5.."}[2m])) by (job) / sum(rate(loki_request_duration_seconds_count[2m])) by (job) > 0.1\n        for: 15m\n';
  const vm = { groups: [{ name: 'slo', rules: [{ name: 'shop:requests:rate5m', type: 'recording', query: 'sum(rate(http_requests_total{job="shop"}[5m]))' }, { name: 'ShopDown', type: 'alerting', query: 'up{job="shop"} == 0', labels: {} }] }] };
  const live = adapt((await livePack({ [T.vmalert]: () => clone(vm) })).canonical);
  for (const path of ['monitoring/loki/alerts.yml', 'monitoring/rules/loki-mixin.yaml', 'prometheus/rules/loki.yaml', 'charts/monitoring/templates/loki-alerts.yaml']) {
    const declared = scan({ 'prometheus/slo.yaml': rec, [path]: mixin }).canonical;
    assert.equal(declared.spec.alerting.rules.find((x) => x.name === 'LokiRequestErrors')?.engine, 'prometheus', path);
    const d = diffPacks(adapt(declared), live);
    const r = rules(d);
    assert.deepEqual([alertKeys(r.onlyInA), alertKeys(r.notObserved)], [['alert_rule::{"name":"lokirequesterrors"}'], []], `${path}: missing live, never "not checked"`);
    assert.deepEqual(evaluateGate({ maxDeclaredNotLive: 0 }, { compared: d.summary.union, declaredNotLive: d.summary.onlyInA }).map((b) => b.criterion), ['maxDeclaredNotLive'], path);
  }
  // PromQL a selector heuristic took for LogQL: a selector over a range, a selector before `!=`.
  const lookalikes = scan({ 'prometheus/alerts.yml': 'groups:\n  - name: api\n    rules:\n      - alert: ApiErrorBurst\n        expr: sum(rate({__name__="http_requests_total",job="api",code=~"5.."}[5m])) > 10\n      - alert: ReplicasShort\n        expr: kube_deployment_status_replicas_available{deployment="api"} != kube_deployment_spec_replicas{deployment="api"}\n' }).canonical;
  assert.deepEqual(lookalikes.spec.alerting.rules.map((x) => [x.name, x.engine]), [['ApiErrorBurst', 'prometheus'], ['ReplicasShort', 'prometheus']]);
  // LogQL its expression states — a line filter (one against a string with `!=` too), a parser stage — wherever it ships:
  // Loki's, not checked against any read.
  const logs = scan({ 'prometheus/slo.yaml': rec, 'rules/logs.yaml': 'groups:\n  - name: logs\n    rules:\n      - alert: ShopPanics\n        expr: sum(count_over_time({app="shop"} |= "panic" [5m])) > 0\n      - alert: ShopErrors\n        expr: sum(rate({app="shop"} | json | level="error" [5m])) > 1\n      - alert: ShopNoise\n        expr: sum(count_over_time({app="shop"} != "debug" [5m])) > 1000\n' }).canonical;
  assert.deepEqual(logs.spec.alerting.rules.filter((x) => x.name !== 'ShopDown').map((x) => [x.name, x.engine]), [['ShopPanics', 'loki'], ['ShopErrors', 'loki'], ['ShopNoise', 'loki']]);
  const r = rules(diffPacks(adapt(logs), live));
  assert.deepEqual([alertKeys(r.onlyInA), alertKeys(r.notObserved)], [[], ['alert_rule::{"name":"shoperrors"}', 'alert_rule::{"name":"shopnoise"}', 'alert_rule::{"name":"shoppanics"}']]);
});

test('one Grafana-managed rule two tools list is one live rule: the provisioning answer beside the same rules in Grafana\'s Prometheus-compatible listing (names, queries, the group — with or without the uid beside each, whichever tool answers which, draft or snapshot) is three rules, never three more read live-not-declared, and the threshold raised in Grafana reads drifted on condition; never by name alone — a copy whose terms differ stays, and so does a ruler\'s rule of the same title and terms', async () => {
  const rec = 'groups:\n  - name: slo\n    rules:\n      - record: shop:requests:rate5m\n        expr: sum(rate(http_requests_total{job="shop"}[5m]))\n';
  const vmRec = { groups: [{ name: 'slo', rules: [{ name: 'shop:requests:rate5m', type: 'recording', query: 'sum(rate(http_requests_total{job="shop"}[5m]))' }] }] };
  const declared = adapt(scan({ 'grafana/provisioning/alerting/shop.yaml': YAML, 'prometheus/rules.yml': rec }).canonical);
  // Grafana as the fixture has it, the rename undone: only the threshold raised.
  const grafana = clone(PROVISIONING).map((r) => (r.uid === 'cart-restarts' ? { ...r, title: 'CartPodRestarts' } : r));
  const listing = (withUid, edit = (x) => x) => ({ status: 'success', data: { groups: [{ name: 'shop', file: 'Shop', interval: 60, rules: grafana.map((r) => edit({
    state: 'inactive', name: r.title, ...(withUid ? { uid: r.uid, folderUid: r.folderUID } : {}), query: r.data[0].model.expr,
    duration: Number.parseInt(r.for, 10) * 60, labels: r.labels, annotations: r.annotations || {}, health: 'ok', type: 'alerting',
  })) }] } });
  for (const withUid of [false, true]) {
    for (const [label, tools] of [
      ['an unattested tool lists them', { [T.vmalert]: () => clone(vmRec), [T.grafana]: () => clone(grafana), [T.other]: () => listing(withUid) }],
      ['the Grafana tool lists them, another tool answers the provisioning API', { [T.vmalert]: () => clone(vmRec), [T.grafana]: () => listing(withUid), [T.other]: () => clone(grafana) }],
    ]) {
      for (const mode of ['draft', 'snapshot']) {
        const where = `${label}${withUid ? ', uids listed' : ''} (${mode})`;
        const { canonical } = await livePack(tools, { mode });
        assert.deepEqual(canonical.spec.alerting.rules.map((r) => `${r.name}/${r.engine}`).sort(), ['CartPodRestarts/grafana', 'CheckoutErrorRatioHigh/grafana', 'PaymentsLatencyHigh/grafana'], where);
        const r = rules(diffPacks(declared, adapt(canonical)));
        assert.deepEqual(r.inBoth.map((e) => [e.key, e.match, e.deltas.map((x) => x.field)]).sort(), [
          ['alert_rule::{"name":"cartpodrestarts"}', 'aligned', []],
          ['alert_rule::{"name":"checkouterrorratiohigh"}', 'aligned', []],
          ['alert_rule::{"name":"paymentslatencyhigh"}', 'drifted', ['condition']],
        ], where);
        assert.deepEqual([r.onlyInA.length, r.onlyInB.length], [0, 0], where);
      }
    }
  }
  // Never by name alone: a copy whose query differs is another rule, and so is a ruler's (vmalert's) rule of the same title and terms.
  const first = grafana[0];
  const vmSame = { groups: [{ name: 'shop', rules: [{ name: first.title, type: 'alerting', query: first.data[0].model.expr, duration: Number.parseInt(first.for, 10) * 60, labels: first.labels }, ...vmRec.groups[0].rules] }] };
  const changed = listing(false, (x) => (x.name === 'CartPodRestarts' ? { ...x, query: `${x.query} * 2` } : x));
  const { canonical } = await livePack({ [T.vmalert]: () => vmSame, [T.grafana]: () => clone(grafana), [T.other]: () => changed });
  assert.deepEqual(canonical.spec.alerting.rules.map((r) => `${r.name}/${r.engine ?? 'prometheus'}`).sort(),
    ['CartPodRestarts/grafana', 'CartPodRestarts/prometheus', 'CheckoutErrorRatioHigh/grafana', 'CheckoutErrorRatioHigh/victoriametrics', 'PaymentsLatencyHigh/grafana']);
  // A listing whose uid names no rule Grafana's store holds, or whose group names another folder than the rule's: another rule.
  // Against the ruler's answer (it names each folder's title): a Prometheus ruler's group names its rule file, never a Grafana
  // folder, so its rule of the same name, query, wait, labels and group stays; Grafana's own listing names the folder, and is
  // its copy. A tool that listed Grafana's rules alone read Grafana's store, never a ruler's: a declared ruler rule is not checked.
  const sameTitles = clone(RULER);
  sameTitles.Shop[0].rules = sameTitles.Shop[0].rules.map((r) => (r.grafana_alert.uid === 'cart-restarts' ? { ...r, grafana_alert: { ...r.grafana_alert, title: 'CartPodRestarts' } } : r));
  const names = (c) => c.spec.alerting.rules.map((r) => `${r.name}/${r.engine ?? 'prometheus'}`).sort();
  const three = ['CartPodRestarts/grafana', 'CheckoutErrorRatioHigh/grafana', 'PaymentsLatencyHigh/grafana'];
  const foreignUid = listing(true, (x) => ({ ...x, uid: `${x.uid}-elsewhere` }));
  assert.deepEqual(names((await livePack({ [T.grafana]: () => clone(grafana), [T.other]: () => foreignUid })).canonical), [...three, 'CartPodRestarts/prometheus', 'CheckoutErrorRatioHigh/prometheus', 'PaymentsLatencyHigh/prometheus'].sort(), 'uids that are not these rules');
  const ruleFile = { ...listing(false), data: { groups: [{ ...listing(false).data.groups[0], file: '/etc/prometheus/rules/shop.yml' }] } };
  assert.deepEqual(names((await livePack({ [T.grafana]: () => clone(sameTitles), [T.other]: () => ruleFile })).canonical), [...three, 'CartPodRestarts/prometheus', 'CheckoutErrorRatioHigh/prometheus', 'PaymentsLatencyHigh/prometheus'].sort(), 'a rule file is no Grafana folder');
  const own = await livePack({ [T.grafana]: () => clone(sameTitles), [T.other]: () => listing(false) });
  assert.deepEqual(names(own.canonical), three, 'the folder the listing names is the rules\'');
  assert.equal(JSON.parse(own.canonical.metadata.annotations['observogram.unread.alert_rule']).ruler,
    `the Prometheus-compatible rule tools listed Grafana-managed rules only (${T.other}), so rules a Prometheus-compatible ruler evaluates were not read`);
});

test('an alert-rule engine whose store has no rules API — it answers 400, 404 or 405, the scrape targets\' rule (the capability row\'s unsupportedOnHttpStatus) — is not served, never a failure: beside rules it does not make the read partial, alone the family is unsupported; one a journey remembers keeps its first instant, and a mere error or a refusal later is a hole, never absorbed; one the journey saw answer by name fails, saying when; a tool failing beside another that read its store is no hole, a refusal beside an empty answer of its store still is (C6)', async () => {
  const vm = { groups: [{ name: 'shop', rules: [{ name: 'DiskFull', type: 'alerting', query: 'up == 0', labels: {} }] }] };
  for (const [status, words] of [[400, 'Bad Request'], [404, 'Not Found'], [405, 'Method Not Allowed']]) {
    const beside = await livePack({ [T.vmalert]: () => clone(vm), [T.grafana]: () => ({ isError: `HTTP ${status}: ${words}` }) });
    const a = beside.canonical.metadata.annotations;
    assert.deepEqual([beside.fetched.probeResults.alert_rules.outcome, a['mcp.probesPartial'], a['mcp.probeErrors.alert_rules'], partialLiveEvidence(beside.canonical).vantage],
      ['data', undefined, undefined, 'full'], `${status}: not served beside rules is no hole`);
    assert.equal(JSON.parse(a['observogram.unread.alert_rule']).grafana, `the Grafana alert-rule tool answered that its store serves none here (${T.grafana}: HTTP ${status} ${words}), so Grafana-managed rules were not read`, `${status}: the reason is the tool and the status`);
    const alone = await livePack({ [T.grafana]: () => ({ isError: `HTTP ${status}: ${words}` }) });
    assert.equal(alone.fetched.probeResults.alert_rules.outcome, 'unsupported', `${status}: alone, unsupported`);
    assert.deepEqual(JSON.parse(alone.canonical.metadata.annotations['mcp.probeUnsupported.alert_rules']).tools, [T.grafana], status);
  }
  // Remembered (the journey's probeMemory), read as the cascade reads it: the not-served answer again keeps the instant it was
  // first given; a mere error later is an outage, never absorbed — beside rules a hole, alone a failed family; a refusal is a hole.
  const memo = { reason: `${T.grafana}: HTTP 404 Not Found`, since: '2026-11-01T00:00:00.000Z', tools: [T.grafana] };
  const probeMemory = { unsupported: { alert_rules: memo } };
  const again = await livePack({ [T.grafana]: () => ({ isError: 'HTTP 404: Not Found' }) }, { probeMemory });
  assert.deepEqual(JSON.parse(again.canonical.metadata.annotations['mcp.probeUnsupported.alert_rules']), memo, 'not served again: since kept');
  const unavailable = () => ({ isError: 'HTTP 503: Service Unavailable' });
  const later = await livePack({ [T.vmalert]: () => clone(vm), [T.grafana]: unavailable }, { probeMemory });
  assert.deepEqual([later.canonical.metadata.annotations['mcp.probesPartial'], /HTTP 503/.test(later.canonical.metadata.annotations['mcp.probeErrors.alert_rules'] ?? ''), partialLiveEvidence(later.canonical).vantage],
    ['alert_rules', true, 'partial'], 'a mere error beside rules is a hole, whatever the memory');
  const laterAlone = await livePack({ [T.grafana]: unavailable }, { probeMemory });
  assert.deepEqual([laterAlone.fetched.probeResults.alert_rules.outcome, laterAlone.canonical.metadata.annotations['mcp.probeUnsupported.alert_rules']], ['failed', undefined], 'alone, a failed family');
  const refused = await livePack({ [T.vmalert]: () => clone(vm), [T.grafana]: () => ({ isError: 'HTTP 403: Forbidden' }) }, { probeMemory });
  assert.equal(refused.canonical.metadata.annotations['mcp.probesPartial'], 'alert_rules', 'a refusal is never not served');
  // E2, as the cascade has it: an engine the journey's records saw answer the family by name reads a store that serves it —
  // its 404 now is a lost route, a failure saying when it answered; a record that names no tool counts for no engine here.
  const servedBefore = { answered: { alert_rules: { tools: [T.grafana], at: '2026-11-15T08:00:00.000Z' } } };
  const lostRoute = await livePack({ [T.vmalert]: () => clone(vm), [T.grafana]: () => ({ isError: 'HTTP 404: Not Found' }) }, { probeMemory: servedBefore });
  const la = lostRoute.canonical.metadata.annotations;
  assert.deepEqual([la['mcp.probesPartial'], la['mcp.probeErrors.alert_rules'], la['mcp.probeUnsupported.alert_rules'], partialLiveEvidence(lostRoute.canonical).vantage],
    ['alert_rules', `${T.grafana}: it answered on 2026-11-15; now HTTP 404: Not Found`, undefined, 'partial'], 'a tool that answered before');
  const lostAlone = await livePack({ [T.grafana]: () => ({ isError: 'HTTP 404: Not Found' }) }, { probeMemory: servedBefore });
  assert.equal(lostAlone.fetched.probeResults.alert_rules.outcome, 'failed', 'alone, failed: never not served');
  const unnamed = await livePack({ [T.vmalert]: () => clone(vm), [T.grafana]: () => ({ isError: 'HTTP 404: Not Found' }) },
    { probeMemory: { answered: { alert_rules: { tools: [], at: '2026-11-15T08:00:00.000Z', anyTool: true } } } });
  assert.deepEqual([unnamed.canonical.metadata.annotations['mcp.probesPartial'], partialLiveEvidence(unnamed.canonical).vantage], [undefined, 'full'], 'a record naming no tool: not served');
  // The pack names the engines that answered with rules, for the next run's memory.
  assert.equal(la['mcp.probeAnsweredBy.alert_rules'], T.vmalert);
  // Under a folder scope the Grafana tool is asked per folder first: a folder its store does not know (404) says
  // nothing of a rules API, so the whole read decides — failing, the store is a hole; answering 404 too, not served.
  const scope = { folderUids: [FOLDER_UID] };
  const folderThenError = await livePack({ [T.vmalert]: () => clone(vm), [T.grafana]: (args) => ({ isError: args.folder_uid ? 'HTTP 404: Not Found' : 'HTTP 500: Internal Server Error' }) }, { scope });
  assert.deepEqual([folderThenError.canonical.metadata.annotations['mcp.probesPartial'], /HTTP 500/.test(folderThenError.canonical.metadata.annotations['mcp.probeErrors.alert_rules'] ?? '')], ['alert_rules', true], 'judged by the whole read');
  const notServedWhole = await livePack({ [T.vmalert]: () => clone(vm), [T.grafana]: () => ({ isError: 'HTTP 404: Not Found' }) }, { scope });
  assert.equal(notServedWhole.canonical.metadata.annotations['mcp.probesPartial'], undefined, '404 per folder and whole: not served');
  // One store, two tools: one failing while the other read the store is no hole; refused while the other answered empty is one.
  const prom = { data: { groups: [{ name: 'shop', rules: [{ name: 'DiskFull', type: 'alerting', query: 'up == 0', labels: {} }] }] } };
  const sameStore = await livePack({ [T.vmalert]: () => ({ isError: 'HTTP 500: Internal Server Error' }), [T.prometheus]: () => prom });
  assert.deepEqual([sameStore.fetched.probeResults.alert_rules.outcome, sameStore.canonical.metadata.annotations['mcp.probesPartial'], partialLiveEvidence(sameStore.canonical).vantage], ['data', undefined, 'full']);
  const refusedEmpty = await livePack({ [T.vmalert]: () => ({ isError: 'HTTP 403: Forbidden' }), [T.prometheus]: () => ({ data: { groups: [] } }), [T.grafana]: () => clone(PROVISIONING) });
  const ra = refusedEmpty.canonical.metadata.annotations;
  assert.deepEqual([ra['mcp.probesPartial'], /HTTP 403/.test(ra['mcp.probeErrors.alert_rules'] ?? '')], ['alert_rules', true], 'no honest zero beside a refusal of its store (C6)');
  assert.match(JSON.parse(ra['observogram.unread.alert_rule']).ruler ?? '', /HTTP 403/, 'and that store\'s declared rules are not checked');
});

test('a burn-rate entry read from a Grafana-managed rule lives in Grafana\'s store (its source rules say `engine: grafana`): against a read that did not cover that store — no Grafana alert-rule tool offered, or the tool refused — it is not checked with that store\'s reason, never declared-not-live; read from rules in two stores, its windows are not compared on the rule the read did not cover, the pair naming it, while a rule missing from a store the read covered still drifts them', async () => {
  const rec = 'groups:\n  - name: slo\n    rules:\n      - record: checkout:requests:ratio_5m\n        expr: sum(rate(http_requests_total{code!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))\n';
  const grafanaRule = (uid, title, expr, wait, severity) => `      - uid: ${uid}\n        title: ${title}\n        condition: B\n        for: ${wait}\n        labels:\n          severity: ${severity}\n        data:\n          - refId: A\n            datasourceUid: prom\n            model:\n              refId: A\n              expr: ${expr}\n          - refId: B\n            datasourceUid: __expr__\n            model:\n              refId: B\n              type: threshold\n              expression: A\n              conditions:\n                - evaluator:\n                    type: gt\n                    params: [0]\n`;
  const file = (...list) => `apiVersion: 1\ngroups:\n  - name: slo\n    folder: Shop\n    rules:\n${list.join('')}`;
  const declared = scan({ 'prometheus/slo.rules.yml': rec, 'grafana/provisioning/alerting/burn.yaml': file(grafanaRule('burn', 'CheckoutBurn', 'checkout:requests:ratio_5m < 0.99', '5m', 'critical')) }).canonical;
  assert.equal(JSON.parse(declared.metadata.annotations['observogram.source_rules.policy.burn_rate_alerts.checkout_requests_99'])[0].engine, 'grafana', 'the rule says its store');
  assert.equal(adapt(declared).layers.L4.policy.find((a) => a.sourceRules)?.sourceRules[0].engine, 'grafana', 'and the adapter keeps it beside the entry');
  const recorded = { name: 'checkout:requests:ratio_5m', type: 'recording', query: 'sum(rate(http_requests_total{code!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))' };
  const vm = { groups: [{ name: 'slo', rules: [recorded, { name: 'DiskFull', type: 'alerting', query: 'node_filesystem_avail_bytes < 1', labels: {} }] }] };
  const burn = (list) => list.filter((e) => e.key.startsWith('burn_rate::'));
  for (const [label, tools] of [['no Grafana alert-rule tool offered', {}], ['the Grafana alert-rule tool refused', { [T.grafana]: () => ({ isError: 'HTTP 403: Forbidden' }) }]]) {
    const live = (await livePack({ [T.vmalert]: () => clone(vm), ...tools })).canonical;
    const r = rules(diffPacks(adapt(declared), adapt(live)));
    assert.deepEqual(burn(r.onlyInA), [], `${label}: never declared, not live`);
    assert.deepEqual(burn(r.notObserved).map((e) => [e.key, e.side, e.reason]),
      [['burn_rate::{"slo":"checkout_requests_99"}', 'a', JSON.parse(live.metadata.annotations['observogram.unread.alert_rule']).grafana]], label);
  }
  // One SLO guarded by a Prometheus rule (the read covers it) and a Grafana-managed rule (it does not).
  const prom = `${rec}      - alert: CheckoutBurnFast\n        expr: checkout:requests:ratio_5m < 0.98\n        for: 2m\n        labels:\n          severity: critical\n`;
  const fast = { name: 'CheckoutBurnFast', type: 'alerting', query: 'checkout:requests:ratio_5m < 0.98', duration: 120, labels: { severity: 'critical' } };
  const liveFast = adapt((await livePack({ [T.vmalert]: () => ({ groups: [{ name: 'slo', rules: [recorded, fast] }] }) })).canonical);
  const mixed = scan({ 'prometheus/slo.rules.yml': prom, 'grafana/provisioning/alerting/slo.yaml': file(grafanaRule('burn-slow', 'CheckoutBurnSlow', 'checkout:requests:ratio_5m < 0.995', '30m', 'warning')) }).canonical;
  const d = diffPacks(adapt(mixed), liveFast);
  const pair = Object.values(d.layers).flatMap((l) => l.inBoth).find((e) => e.key === 'burn_rate::{"slo":"checkout_requests_99"}');
  assert.deepEqual([pair?.match, pair?.deltas, pair?.unobserved], ['aligned', [], [{ field: 'windows', side: 'b', keys: [], rule: 'CheckoutBurnSlow' }]]);
  assert.equal(d.summary.partlyCompared, 1, 'compared in part, counted once for the rule');
  // Both rules in the Prometheus file, the slow one missing from the ruler the read covered: still drifted on the windows.
  const both = scan({ 'prometheus/slo.rules.yml': `${prom}      - alert: CheckoutBurnSlow\n        expr: checkout:requests:ratio_5m < 0.995\n        for: 30m\n        labels:\n          severity: warning\n` }).canonical;
  const missing = Object.values(diffPacks(adapt(both), liveFast).layers).flatMap((l) => l.inBoth).find((e) => e.key.startsWith('burn_rate::'));
  assert.deepEqual([missing?.match, missing?.deltas.map((x) => x.field), missing?.unobserved], ['drifted', ['windows'], undefined]);
});

test('a ruler answer is told by its shape, whatever its folders are titled: a folder titled data, groups, rules or status beside the Shop folder is read with it and the three Shop rules pair as the fixture says; a listing\'s own empty keys still read as an honest zero', async () => {
  const other = (title) => [{ name: 'misc', interval: '1m', rules: [{ for: '5m', labels: {}, annotations: {}, grafana_alert: { title: `${title} rule`, uid: `${title}-1`, namespace_uid: `${title}-uid`, rule_group: 'misc', condition: 'B', data: [{ refId: 'A', datasourceUid: 'prom', model: { refId: 'A', expr: 'up == 0' } }, { refId: 'B', datasourceUid: '__expr__', model: { refId: 'B', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params: [0] } }] } }] } }] }];
  for (const title of ['data', 'groups', 'rules', 'status']) {
    const { canonical, fetched } = await livePack({ [T.grafana]: () => ({ ...clone(RULER), [title]: other(title) }) });
    assert.equal(fetched.probeResults.alert_rules.outcome, 'data', title);
    assert.deepEqual(canonical.spec.alerting.rules.map((r) => r.name).sort(), ['CartPodRestarts #2', 'CheckoutErrorRatioHigh', 'PaymentsLatencyHigh', `${title} rule`].sort(), title);
    assert.equal(JSON.parse(canonical.metadata.annotations['observogram.grafana_rule.alerting.rules[3]']).folder, title, `${title}: the folder's title is its key`);
    const r = rules(diffPacks(adapt(DECLARED), adapt(canonical)));
    assert.deepEqual([r.inBoth.length, r.onlyInA.length, r.notObserved.length], [3, 0, 0], title);
  }
  for (const answer of [{ groups: [] }, { data: { groups: [] } }, { rules: [] }]) {
    assert.equal((await livePack({ [T.grafana]: () => answer })).fetched.probeResults.alert_rules.outcome, 'empty', JSON.stringify(answer));
  }
});

test('a threshold the repository does not state — a chart value Grafana fills in at deploy time, a ${VAR} — is no stated condition: the pair is compared on the query, the condition said uncompared, never drifted against the number Grafana runs; grafanaRuleCondition states none for a value that is not a number', async () => {
  const rule = (params) => ({ title: 'R', condition: 'B', data: [{ refId: 'A', datasourceUid: 'prom', model: { refId: 'A', expr: 'up' } }, { refId: 'B', datasourceUid: '__expr__', model: { refId: 'B', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: 'gt', params } }] } }] });
  for (const params of [['helmvalue'], ['${THRESHOLD}'], [], [null], [true], ['']]) assert.equal(grafanaRuleCondition(rule(params)), null, JSON.stringify(params));
  assert.equal(grafanaRuleCondition(rule(['3'])), 'B = threshold(A > 3); condition B', 'a number written as text is that number');
  assert.equal(grafanaRuleCondition({ title: 'R', data: [{ refId: 'A', model: { expr: 'up' } }, { refId: 'B', datasourceUid: '__expr__', model: { type: 'reduce', expression: 'A', reducer: 'last', settings: { mode: 'replaceNN', replaceWithValue: 'helmvalue' } } }] }), null, 'a replacement value');
  // A chart ships its rule to Grafana's sidecar in a ConfigMap; the threshold — or a math node's — is a chart value.
  const head = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ include "shop.fullname" . }}-alerts\n  labels:\n    grafana_alert: "1"\ndata:\n  shop-alerts.yaml: |\n    apiVersion: 1\n    groups:\n      - orgId: 1\n        name: shop\n        folder: Shop\n        interval: 1m\n        rules:\n          - uid: cart-restarts\n            title: CartPodRestarts\n            condition: C\n            for: 15m\n            labels:\n              severity: warning\n            data:\n              - refId: A\n                datasourceUid: prom\n                model:\n                  refId: A\n                  expr: increase(kube_pod_container_status_restarts_total{container="cart"}[15m])\n              - refId: B\n                datasourceUid: __expr__\n                model:\n                  refId: B\n                  type: reduce\n                  expression: A\n                  reducer: last\n              - refId: C\n                datasourceUid: __expr__\n                model:\n                  refId: C\n';
  const threshold = '                  type: threshold\n                  expression: B\n                  conditions:\n                    - evaluator:\n                        type: gt\n                        params: [{{ .Values.alerts.restartThreshold }}]\n';
  const math = '                  type: math\n                  expression: $B > {{ .Values.alerts.restartThreshold }}\n';
  const nodeOf = { threshold: { type: 'threshold', expression: 'B', conditions: [{ evaluator: { type: 'gt', params: [3] } }] }, math: { type: 'math', expression: '$B > 3' } };
  for (const [label, node] of [['threshold', threshold], ['math', math]]) {
    const declared = scan({
      'charts/shop/Chart.yaml': 'apiVersion: v2\nname: shop\nversion: 1.0.0\n',
      'charts/shop/values.yaml': 'alerts:\n  restartThreshold: 3\n',
      'charts/shop/templates/alerts.yaml': head + node,
      'prometheus/rules.yml': 'groups:\n  - name: slo\n    rules:\n      - record: shop:requests:rate5m\n        expr: sum(rate(http_requests_total{job="shop"}[5m]))\n',
    }).canonical;
    assert.deepEqual(JSON.parse(declared.metadata.annotations['observogram.grafana_rule.alerting.rules[0]']), { uid: 'cart-restarts', folder: 'Shop', group: 'shop' }, `${label}: no condition stated`);
    const answer = [{ uid: 'cart-restarts', title: 'CartPodRestarts', folderUID: FOLDER_UID, ruleGroup: 'shop', condition: 'C', for: '15m', labels: { severity: 'warning' }, annotations: {}, data: [
      { refId: 'A', datasourceUid: 'prom', model: { refId: 'A', expr: 'increase(kube_pod_container_status_restarts_total{container="cart"}[15m])' } },
      { refId: 'B', datasourceUid: '__expr__', model: { refId: 'B', type: 'reduce', expression: 'A', reducer: 'last' } },
      { refId: 'C', datasourceUid: '__expr__', model: { refId: 'C', ...nodeOf[label] } },
    ] }];
    const vmRec = { groups: [{ name: 'slo', rules: [{ name: 'shop:requests:rate5m', type: 'recording', query: 'sum(rate(http_requests_total{job="shop"}[5m]))' }] }] };
    const { canonical } = await livePack({ [T.vmalert]: () => vmRec, [T.grafana]: () => answer });
    const pair = rules(diffPacks(adapt(declared), adapt(canonical))).inBoth.find((e) => e.key === 'alert_rule::{"name":"cartpodrestarts"}');
    assert.deepEqual([pair?.match, pair?.deltas, pair?.unobserved], ['aligned', [], [{ field: 'condition', side: 'a', keys: [] }]], label);
  }
});
