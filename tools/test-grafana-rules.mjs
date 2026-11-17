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
// A live draft as the Services Run reads one (tools/lib/journey.mjs resolvePackB).
async function livePack(tools, { scope = null, listed = true } = {}) {
  const fake = fakeMcp({ ...CORE, ...tools }, { listed });
  const fetched = await fetchMcp({ mcpUrl: 'https://mcp.shop.example/mcp', transport: fake.transport, ...(scope ? { scope } : {}) });
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
  // A read whose recording-rule family answered (vmalert): a Grafana-managed recording rule is still no ruler's.
  const vmRec = { groups: [{ name: 'slo', rules: [{ record: 'shop:requests:ratio_5m', query: 'sum(x)' }, { name: 'ShopDown', type: 'alerting', query: 'up{job="shop"} == 0', labels: {} }] }] };
  const withRecording = diffPacks(adapt(mixed), adapt((await livePack({ [T.vmalert]: () => vmRec, [T.grafana]: () => clone(PROVISIONING) })).canonical));
  assert.deepEqual(unreadOf(withRecording), [
    ['alert_rule::{"name":"shoplogerrors"}', 'no alert-rule tool reads a Loki ruler, so Loki rules were not read'],
    ['recording_rule::{"record":"shop:latency:p95_5m"}', 'no recording-rule tool reads Grafana-managed recording rules, so they were not read'],
  ]);
  assert.deepEqual(declaredNotLive(withRecording), [], 'the Prometheus rule pairs; nothing reads declared, not live');
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
