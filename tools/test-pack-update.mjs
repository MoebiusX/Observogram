#!/usr/bin/env node
/**
 * tools/test-pack-update.mjs — the UPDATE journey's engine (docs/UPDATE_JOURNEY.md; tools/lib/pack-update.mjs).
 *
 * The two tests the journey asked for first, then the rest:
 *   1. The round trip: every library entry at every tier, with and without edits (overrides, a custom SLI, a
 *      second SLI selection, params), saved as YAML and reloaded, recovers its inputs, regenerates and compares
 *      equal to itself (rebuildPack exact) — the normal form absorbs the newline YAML adds to a multi-line
 *      expression. The one case the pack cannot say (a custom SLI's objective with SLOs off) is a note, and the
 *      pack still reopens exactly.
 *   2. The change list is true: for a scripted set of edits comparePacks reports exactly the artefacts that
 *      differ — a changed objective renames the SLO and moves the artefacts that name it; an addition adds
 *      exactly its artefacts; nothing else.
 * Then the additions (applied in order, recorded in the pack, re-applied after a regenerate, schema-valid and
 * compiling through every target; every refusal named), the origin reader, foreign artefacts read in as
 * additions, the version rules and the version chains.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml, emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical } from './lib/validator.mjs';
import { compile, TARGETS } from './lib/compile.mjs';
import { instantiatePack, TIERS } from './lib/library.mjs';
import { loadLibrary, findEntry } from '../server/library.mjs';
import {
  recoverBuildInputs, readAdditions, applyAdditions, checkAddition, additionLabel, defaultBurnWindows, normalize, artefactIndex,
  parseArtefactKey, artefactLabel, comparePacks, fieldDiff, rebuildPack, foreignAsAdditions, packOrigin, nextVersion, previousOf,
  stampUpdate, versionChains, ADDITIONS_KEY, UPDATE_PREVIOUS_KEY, MAX_ADDITIONS,
} from './lib/pack-update.mjs';

const lib = loadLibrary();
const resolveEntry = (id) => findEntry(lib, id);
const roundTrip = (c) => parseYaml(emitYaml(c));
const make = (opts) => instantiatePack(opts.entries ? opts.entries.map(resolveEntry) : resolveEntry(opts.entry || 'http-service'), { name: 'checkout', tier: 'tier-2', environment: 'prod', owners: ['team-a'], ...opts });
const SLO_ADD = { kind: 'slo', slo: { sli: 'availability', objective: 0.9995, window: '30d' }, burn_rate: { windows: defaultBurnWindows('ratio', 'tier-2') } };
const ROUTE_ADD = { kind: 'route', route: { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/x' }] } };
const RULE_ADD = { kind: 'alert_rule', rule: { name: 'QueueDepthHigh', expr: 'queue_depth > 1000', for: '5m', severity: 'SEV3' } };

// ---------- 1. the round trip ----------

test('round trip: every entry at every tier, through YAML, reopens exactly', () => {
  const failures = [];
  for (const en of lib.entries) {
    for (const tier of TIERS) {
      const { canonical } = instantiatePack(en, { name: 'checkout', tier, environment: 'prod', owners: ['team-a'], params: { oncall_channel: '#x' } });
      const rb = rebuildPack(roundTrip(canonical), { resolveEntry });
      if (!rb.exact) failures.push(`${en.id}@${tier}: ${JSON.stringify({ d: rb.differences.map(x => x.key), f: rb.foreign.map(x => x.key), m: rb.missing.map(x => x.key), e: rb.errors })}`);
      assert.equal(rb.origin, 'build');
      assert.deepEqual(rb.inputs.entries, [{ id: en.id, version: String(en.version) }]);
      assert.equal(rb.inputs.tier, tier);
      assert.deepEqual(rb.inputs.params, { oncall_channel: '#x' });
    }
  }
  assert.deepEqual(failures, []);
});

test('round trip: with edits — overrides, a custom SLI, a narrowed SLI selection, a section off, two entries composed', () => {
  const edited = make({ overrides: { availability: { objective: 0.999 }, latency_p99: { threshold: 0.3, description: 'p99 under 300 ms' } }, custom: [{ id: 'checkout_rate', type: 'ratio', objective: 0.98, window: '28d', good: 'sum(rate(a[5m]))', total: 'sum(rate(b[5m]))' }] });
  const rb = rebuildPack(roundTrip(edited.canonical), { resolveEntry });
  assert.equal(rb.exact, true, JSON.stringify({ d: rb.differences.map(x => [x.key, x.fields]), f: rb.foreign.map(x => x.key), m: rb.missing.map(x => x.key) }));
  assert.deepEqual(rb.inputs.overrides, { availability: { objective: 0.999 }, latency_p99: { threshold: 0.3, description: 'p99 under 300 ms' } });
  assert.deepEqual(rb.inputs.custom, [{ id: 'checkout_rate', type: 'ratio', description: 'custom ratio SLI — written in the studio', good: 'sum(rate(a[5m]))', total: 'sum(rate(b[5m]))', objective: 0.98, window: '28d' }]);
  const narrowed = make({ toggles: { slis: ['availability'], dashboards: false } });
  const rb2 = rebuildPack(roundTrip(narrowed.canonical), { resolveEntry });
  assert.equal(rb2.exact, true);
  assert.deepEqual(rb2.inputs.toggles, { slos: true, policy: true, routes: true, dashboards: false, validation: true, slis: ['availability'] });
  const composed = make({ entries: ['http-service', 'kafka'] });
  const rb3 = rebuildPack(roundTrip(composed.canonical), { resolveEntry });
  assert.equal(rb3.exact, true, JSON.stringify(rb3.differences.map(x => x.key)));
  assert.deepEqual(rb3.inputs.entries.map(e => e.id), ['http-service', 'kafka']);
});

test('round trip: a custom SLI in a pack with SLOs off stores its objective nowhere — a note says what was assumed, and the pack still reopens exactly', () => {
  const made = make({ toggles: { slos: false, policy: false }, custom: [{ id: 'checkout_rate', type: 'ratio', objective: 0.98, window: '28d', good: 'sum(rate(a[5m]))', total: 'sum(rate(b[5m]))' }] });
  const rb = rebuildPack(roundTrip(made.canonical), { resolveEntry });
  assert.equal(rb.exact, true, JSON.stringify(rb.differences.map(x => x.key)));
  assert.ok(rb.notes.some(n => n.field === 'custom.checkout_rate.objective' && /99% over 30d assumed/.test(n.note)));
});

test('recoverBuildInputs: null for a pack Build did not make; the library version mismatch is a note of rebuildPack', () => {
  assert.equal(recoverBuildInputs({ metadata: { annotations: {} } }), null);
  assert.equal(recoverBuildInputs(null), null);
  const c = make({}).canonical;
  c.metadata.annotations['library.source'] = 'http-service@0.9.0';
  const rb = rebuildPack(c, { resolveEntry });
  assert.ok(rb.notes.some(n => /http-service is 1\.0\.0; the pack was built from 0\.9\.0/.test(n.note)));
  const gone = make({}).canonical;
  gone.metadata.annotations['library.source'] = 'no-such-entry@1.0.0';
  const rb2 = rebuildPack(gone, { resolveEntry });
  assert.deepEqual(rb2.errors, ['the library has no entry no-such-entry (the pack was built from no-such-entry@1.0.0)']);
  assert.equal(rb2.rebuilt, null);
  const noLib = rebuildPack(make({}).canonical, {});
  assert.deepEqual(noLib.errors, ['no library to rebuild from']);
});

// ---------- 2. the change list is true ----------

test('comparePacks: a changed objective renames the SLO and moves exactly the artefacts that name it; everything else is the same', () => {
  const a = make({}).canonical;
  const b = make({ overrides: { availability: { objective: 0.999 } } }).canonical;
  const cmp = comparePacks(a, b);
  assert.deepEqual(cmp.onlyInA.map(x => x.key), ['slo:availability_99_5', 'burn_rate:availability_99_5']);
  assert.deepEqual(cmp.onlyInB.map(x => x.key), ['slo:availability_99_9', 'burn_rate:availability_99_9']);
  // The boards and the chaos experiment name the SLO: they change; nothing else does.
  const changedKinds = cmp.changed.map(x => parseArtefactKey(x.key).kind);
  assert.ok(changedKinds.every(k => ['dashboard', 'chaos', 'section', 'metadata'].includes(k)), JSON.stringify(cmp.changed.map(x => x.key)));
  assert.ok(cmp.changed.some(x => x.key === 'dashboard:checkout-slo-burn'));
  for (const c of cmp.changed) assert.ok(fieldDiff(c.a, c.b).length > 0, `${c.key} has a field that differs`);
  assert.ok(cmp.same.length > 20);
  assert.deepEqual(comparePacks(a, roundTrip(a)), { onlyInA: [], onlyInB: [], changed: [], same: comparePacks(a, a).same });
});

test('comparePacks: an addition adds exactly its artefacts', () => {
  const a = make({}).canonical;
  const { canonical: b, applied, refused } = applyAdditions(a, [SLO_ADD, ROUTE_ADD, RULE_ADD]);
  assert.equal(refused.length, 0);
  assert.equal(applied.length, 3);
  const cmp = comparePacks(a, b);
  assert.deepEqual(cmp.onlyInA, []);
  assert.deepEqual(cmp.changed, []);
  assert.deepEqual(cmp.onlyInB.map(x => x.key), ['slo:availability_99_95', 'burn_rate:availability_99_95', 'alert_rule:QueueDepthHigh', 'route:SEV2#2']);
  assert.deepEqual(cmp.onlyInB.map(x => artefactLabel(x.key, x.value)), ['SLO availability_99_95', 'burn-rate alert on availability_99_95', 'alert rule QueueDepthHigh', 'route SEV2 → webhook https://hooks.example/x']);
});

test('artefactIndex covers the whole spec: every family by key, the rest of each section once, the identity without version and annotations', () => {
  const c = make({}).canonical;
  const idx = artefactIndex(c);
  const keys = [...idx.keys()];
  assert.ok(keys.includes('metadata'));
  assert.ok(!('version' in idx.get('metadata')) && !('annotations' in idx.get('metadata')));
  for (const k of ['sli:availability', 'slo:availability_99_5', 'burn_rate:availability_99_5', 'route:SEV1', 'dashboard:checkout-overview', 'section:otel', 'section:pipelines', 'section:baselines', 'section:alerting']) assert.ok(keys.includes(k), k);
  assert.deepEqual(Object.keys(idx.get('section:alerting')).sort(), ['dedup', 'suppress']);   // routes and rules are families
  assert.ok(!keys.includes('section:slis') && !keys.includes('section:slos') && !keys.includes('section:dashboards'));
  assert.deepEqual(parseArtefactKey('route:SEV2#2'), { kind: 'route', id: 'SEV2', n: 2 });
  assert.equal(artefactLabel('route:SEV2#2'), 'route SEV2 (2nd)');
  assert.equal(artefactLabel('metadata'), 'the pack\'s identity (name, owners, bindings)');
  assert.deepEqual(normalize({ b: 'x\n\n', a: [{ d: 1, c: undefined }] }), { a: [{ d: 1 }], b: 'x' });
});

// ---------- additions ----------

test('additions: applied in order, recorded in the pack, schema-valid, compiling through every target, and re-applied after a regenerate', () => {
  const a = make({}).canonical;
  const { canonical: b } = applyAdditions(a, [SLO_ADD, ROUTE_ADD, RULE_ADD]);
  assert.deepEqual(validateCanonical(b), []);
  for (const t of Object.keys(TARGETS)) assert.doesNotThrow(() => compile(b, t), t);
  const recorded = readAdditions(b);
  assert.equal(recorded.length, 3);
  assert.equal(recorded[0].slo.id, 'availability_99_95');
  assert.equal(recorded[0].slo.error_budget_policy, 'ref:platform/std-budget-policy');
  assert.equal(recorded[0].burn_rate.slo, 'availability_99_95');
  // Reopened: the regenerate re-applies the recorded additions and the pack is itself again.
  const rb = rebuildPack(roundTrip(b), { resolveEntry });
  assert.equal(rb.exact, true, JSON.stringify({ d: rb.differences.map(x => x.key), f: rb.foreign.map(x => x.key), m: rb.missing.map(x => x.key), r: rb.refused }));
  assert.equal(rb.additions.length, 3);
  // The input is never mutated; without additions the annotation is absent.
  assert.equal(a.spec.slos.length, 2);
  assert.equal(readAdditions(a).length, 0);
  assert.equal(applyAdditions(a, []).canonical.metadata.annotations[ADDITIONS_KEY], undefined);
  assert.deepEqual(readAdditions({ metadata: { annotations: { [ADDITIONS_KEY]: 'not json' } } }), []);
});

test('additions: every refusal is named, in the field\'s own words, and the rest still applies', () => {
  const a = make({}).canonical;
  const bad = [
    { kind: 'nope' },
    { kind: 'slo', slo: { sli: 'nope', objective: 0.5, window: '30d' }, burn_rate: { windows: [] } },
    { kind: 'slo', slo: { sli: 'availability', objective: 1.5, window: '30d' }, burn_rate: { windows: defaultBurnWindows('ratio', 'tier-2') } },
    { kind: 'slo', slo: { sli: 'availability', objective: 0.995, window: '30d' }, burn_rate: { windows: defaultBurnWindows('ratio', 'tier-2') } },   // the generated SLO's id
    { kind: 'slo', slo: { sli: 'availability', objective: 0.9995, window: '14d' }, burn_rate: { windows: defaultBurnWindows('ratio', 'tier-2') } },
    { kind: 'slo', slo: { sli: 'availability', objective: 0.9995, window: '30d' }, burn_rate: { windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] } },
    { kind: 'slo', slo: { sli: 'availability', objective: 0.9995, window: '30d' }, burn_rate: { windows: [{ short: 'five', long: '1h', factor: 14, severity: 'SEV1' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV2' }] } },
    { kind: 'route', route: { severity: 'SEV9', channels: [{ msteams: '#x' }] } },
    { kind: 'route', route: { severity: 'SEV2', channels: [] } },
    { kind: 'route', route: { severity: 'SEV2', channels: [{ pigeon: 'x' }] } },
    { kind: 'route', route: { severity: 'SEV2', channels: [{ webhook: 'not a url' }] } },
    { kind: 'route', route: { severity: 'SEV3', channels: [{ msteams: '#checkout-team' }] } },   // the generated SEV3 route
    { kind: 'alert_rule', rule: { name: '', expr: 'x' } },
    { kind: 'alert_rule', rule: { name: 'availability_99_5_burn_14x_5m_1h', expr: 'x' } },   // a burn-rate alert's name
    { kind: 'alert_rule', rule: { name: 'Ok', expr: '' } },
    { kind: 'alert_rule', rule: { name: 'Ok', expr: 'x', for: 'soon' } },
    { kind: 'alert_rule', rule: { name: 'Ok', expr: 'x', engine: 'nagios' } },
    RULE_ADD,
    RULE_ADD,   // twice: the second clashes with the first
  ];
  const { canonical, applied, refused } = applyAdditions(a, bad);
  assert.equal(applied.length, 1);
  assert.equal(canonical.spec.alerting.rules.length, 1);
  assert.deepEqual(refused.map(r => r.reason), [
    'kind "nope" — expected slo | route | alert_rule',
    'slo.sli: the pack has no SLI "nope"',
    'slo.objective: a number between 0 and 1 (0.9995 for 99.95%)',
    'slo.id: the pack already has an SLO availability_99_5',
    'slo.window: expected 7d | 28d | 30d | 90d',
    'burn_rate.windows: at least two windows { short, long, factor, severity }',
    'burn_rate.windows[0].short: not a duration ("five")',
    'route.severity: expected SEV1 | SEV2 | SEV3 | SEV4',
    'route.channels: at least one channel { <kind>: <address> }',
    'route.channels[0]: kind "pigeon" — expected msteams | voice | whatsapp | email | webhook',
    'route.channels[0].webhook: an http(s) URL is required',
    'route: the pack already routes SEV3 to exactly these channels',
    'rule.name: 1 to 190 characters',
    'rule.name: availability_99_5_burn_14x_5m_1h is a burn-rate alert of this pack; a rule may not appear in both',
    'rule.expr: the condition in the engine\'s own language is required',
    'rule.for: not a duration ("soon")',
    'rule.engine: expected prometheus | mimir | thanos | victoriametrics | loki | grafana | alertmanager',
    'rule.name: the pack already has an alert rule named QueueDepthHigh',
  ]);
  assert.equal(refused[0].index, 0);
  assert.equal(checkAddition(null, {}).error, 'an addition is an object { kind, … }');
  const many = applyAdditions(a, Array.from({ length: MAX_ADDITIONS + 1 }, () => ROUTE_ADD));
  assert.ok(many.refused.some(r => r.reason === `at most ${MAX_ADDITIONS} additions`));
});

test('additionLabel and defaultBurnWindows speak the user\'s terms', () => {
  assert.equal(additionLabel({ ...SLO_ADD, slo: { ...SLO_ADD.slo, id: 'availability_99_95' } }), 'SLO availability_99_95 99.95% on availability, with its burn-rate alert');
  assert.equal(additionLabel(ROUTE_ADD), 'route SEV2 → webhook https://hooks.example/x');
  assert.equal(additionLabel(RULE_ADD), 'alert rule QueueDepthHigh (SEV3)');
  assert.equal(additionLabel(null), 'an addition');
  assert.deepEqual(defaultBurnWindows('threshold', 'tier-3').map(w => w.severity), ['SEV3', 'SEV3']);
  assert.deepEqual(defaultBurnWindows('ratio', 'tier-1').map(w => w.severity), ['SEV1', 'SEV2']);
});

// ---------- origin, foreign artefacts, versions ----------

test('packOrigin reads the pack alone: build, scan, live, hand, and example when the caller says it ships', () => {
  const c = make({}).canonical;
  assert.equal(packOrigin(c), 'build');
  assert.equal(packOrigin(c, { shipped: true }), 'example');
  assert.equal(packOrigin({ metadata: { annotations: { 'crawler.discoveredAt': '2026-10-01' } } }), 'scan');
  assert.equal(packOrigin({ metadata: { annotations: { 'mcp.refreshedAt': '2026-10-01', 'library.source': 'x@1' } } }), 'live');
  assert.equal(packOrigin({ metadata: { annotations: {} } }), 'hand');
  assert.equal(packOrigin(null), 'hand');
});

test('a hand-edited pack: what Build did not write is foreign; an SLO with its alert, a route and a rule read in as additions, the rest is left over with its reason', () => {
  const c = make({}).canonical;
  c.spec.slos.push({ id: 'availability_99_99', sli: 'availability', objective: 0.9999, window: '30d', error_budget_policy: 'ref:platform/std-budget-policy' });
  c.spec.policy.burn_rate_alerts.push({ slo: 'availability_99_99', windows: defaultBurnWindows('ratio', 'tier-2') });
  c.spec.slos.push({ id: 'latency_p99_95', sli: 'latency_p99', objective: 0.95, window: '30d', error_budget_policy: 'ref:platform/std-budget-policy' });   // no alert
  c.spec.alerting.routes.push({ severity: 'SEV4', channels: [{ email: 'a@b.c' }] });
  c.spec.alerting.rules = [{ name: 'Manual', expr: 'up == 0' }];
  c.spec.dashboards.push({ ...JSON.parse(JSON.stringify(c.spec.dashboards[0])), id: 'extra' });
  const rb = rebuildPack(c, { resolveEntry });
  assert.equal(rb.exact, false);
  assert.deepEqual(rb.foreign.map(f => f.key), ['slo:availability_99_99', 'slo:latency_p99_95', 'burn_rate:availability_99_99', 'alert_rule:Manual', 'route:SEV4', 'dashboard:extra']);
  const { additions, leftover } = foreignAsAdditions(rb.foreign);
  assert.deepEqual(additions.map(additionLabel), ['SLO availability_99_99 99.99% on availability, with its burn-rate alert', 'alert rule Manual', 'route SEV4 → email a@b.c']);
  assert.deepEqual(leftover.map(l => [l.key, l.reason]), [
    ['slo:latency_p99_95', 'an SLO without its burn-rate alert — Build writes one per SLO'],
    ['dashboard:extra', 'a dashboard Build did not write cannot be opened here yet (by file until slice 3)'],
  ]);
  // Read in as additions and regenerated, the three come back; the pack then differs from the stored one by exactly the leftovers.
  const again = applyAdditions(rb.generated, additions);
  const cmp = comparePacks(c, again.canonical);
  assert.deepEqual(cmp.onlyInA.map(x => x.key), ['slo:latency_p99_95', 'dashboard:extra']);
  assert.deepEqual(cmp.onlyInB, []);
  // A removal by hand is "missing": Build would write it.
  const c2 = make({}).canonical;
  c2.spec.dashboards.pop();
  assert.deepEqual(rebuildPack(c2, { resolveEntry }).missing.map(m => m.key), ['dashboard:checkout-slo-burn']);
  // A value changed by hand is a difference, with the field named.
  const c3 = make({}).canonical;
  c3.spec.slos[0].window = '90d';
  const d = rebuildPack(c3, { resolveEntry }).differences;
  assert.deepEqual(d.map(x => [x.key, x.fields]), [['slo:availability_99_5', [{ field: 'window', a: '90d', b: '30d' }]]]);
});

test('versions: the next version bumps the minor; stampUpdate records the lineage; versionChains reads heads and earlier versions', () => {
  assert.equal(nextVersion('0.1.0'), '0.2.0');
  assert.equal(nextVersion('1.9.3-rc1+build'), '1.10.0');
  assert.equal(nextVersion('nope'), '0.2.0');
  assert.equal(nextVersion(undefined), '0.2.0');
  const c = make({}).canonical;
  const v2 = stampUpdate(c, { previousId: 'uploaded-checkout-aaaa', previousVersion: '0.1.0' });
  assert.equal(v2.metadata.version, '0.2.0');
  assert.equal(previousOf(v2), 'uploaded-checkout-aaaa');
  assert.equal(v2.metadata.annotations['library.update.previousVersion'], '0.1.0');
  assert.equal(c.metadata.version, '0.1.0');   // not mutated
  assert.equal(previousOf(c), null);
  assert.equal(stampUpdate(c, { version: '3.0.0' }).metadata.version, '3.0.0');
  assert.equal(stampUpdate(v2, {}).metadata.annotations[UPDATE_PREVIOUS_KEY], undefined);
  const pack = (prev) => ({ metadata: { annotations: prev ? { [UPDATE_PREVIOUS_KEY]: prev } : {} } });
  const chains = versionChains([{ id: 'a1', canonical: pack() }, { id: 'a2', canonical: pack('a1') }, { id: 'a3', canonical: pack('a2') }, { id: 'b1', canonical: pack() }, { id: 'c2', canonical: pack('c1-gone') }]);
  assert.deepEqual(chains.heads, [{ id: 'a3', earlier: ['a2', 'a1'] }, { id: 'b1', earlier: [] }, { id: 'c2', earlier: [] }]);
  assert.deepEqual([...chains.superseded].sort(), ['a1', 'a2']);
  assert.equal(chains.replacedBy.get('a2'), 'a3');
});
