#!/usr/bin/env node
/**
 * tools/test-verify-deploy.mjs
 *
 * Unit test for the post-deploy transition engine
 * (studio/verify-deploy.mjs). Hand-crafted diff fixtures exercise every
 * status: verified, drifted, pending (the propagation-lag contract: pending
 * NEVER counts as verified), shadow, multi-match precedence for per-SLO
 * recording rules, and the key-parsing edge cases. Exit 0 = pass.
 */

import {
  parseDiffKey, sliBaseOfSloId, matcherForDeployItem, computeDeployTransitions,
} from '../studio/verify-deploy.mjs';
import { catalogToDeployManifest } from '../studio/artifact-model.mjs';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness();

// ---------- key parsing ----------
assert(JSON.stringify(parseDiffKey('dashboard::{"id":"payment-overview"}'))
       === JSON.stringify({ kind: 'dashboard', identity: { id: 'payment-overview' } }),
       'parses kind::{json} keys');
assert(parseDiffKey('burn_rate::{"slo":"x"}#02')?.identity?.slo === 'x',
       'occurrence suffix #NN is stripped before parsing');
assert(parseDiffKey('not a key') === null, 'garbage keys parse to null, never throw');
assert(parseDiffKey('kind::{broken') === null, 'truncated json parses to null');

// ---------- SLI base derivation ----------
assert(sliBaseOfSloId('settlement_latency_99') === 'settlement_latency', 'strips trailing objective suffix');
assert(sliBaseOfSloId('availability_99_9') === 'availability', 'strips multi-segment numeric suffix');
assert(sliBaseOfSloId('api_latency') === 'api_latency', 'no suffix → unchanged');

// ---------- matchers ----------
const dashM = matcherForDeployItem({ type: 'dashboard', id: 'payment-overview' });
assert(dashM.match === 'exact' && dashM.test({ id: 'payment-overview' }) && !dashM.test({ id: 'other' }),
       'dashboard matcher is exact on dashboard id');
const alertM = matcherForDeployItem({ type: 'alert', id: 'settlement_latency_99' });
assert(alertM.kinds.includes('burn_rate') && alertM.test({ slo: 'settlement_latency_99' }),
       'alert matcher keys on the bound SLO');
const declM = matcherForDeployItem({ type: 'recording', id: 'svc:availability:ratio_5m', artifact: 'declared:0' });
assert(declM.match === 'exact' && declM.test({ record: 'svc:availability:ratio_5m' }),
       'declared recording matcher is exact on record name');
const sloRecM = matcherForDeployItem({ type: 'recording', id: 'settlement_latency_99', artifact: 'slo:settlement_latency_99' });
assert(sloRecM.match === 'fuzzy', 'per-SLO recording matcher is marked fuzzy');
assert(sloRecM.test({ record: 'payment:settlement_latency:ratio_5m' }), 'fuzzy matcher hits SLI-base rules');
assert(!sloRecM.test({ record: 'payment:other_metric:ratio_5m' }), 'fuzzy matcher rejects unrelated rules');
assert(matcherForDeployItem({ type: 'recording' }) === null, 'matcher without an id is null');
// Step 5: the assurance row — recognised structurally (kind=assurance on an alert_rule identity),
// never as a burn alert; the burn matcher is untouched.
const assuranceM = matcherForDeployItem({ type: 'alert', id: 'assurance', artifact: 'assurance' });
assert(assuranceM.kinds.join() === 'alert_rule' && assuranceM.match === 'exact' && assuranceM.test({ labels: { kind: 'assurance' } }) && assuranceM.test({ kind: 'assurance' }),
       'assurance matcher keys on alert_rule identities labelled kind=assurance');
assert(!assuranceM.test({ slo: 'settlement_latency_99' }) && !assuranceM.kinds.includes('burn_rate') && !alertM.test({ kind: 'assurance' }),
       'the assurance matcher never matches a burn alert and the burn matcher never matches an assurance alert');
{
  const manifest = catalogToDeployManifest({ groups: [{ id: 'rules', flavors: [{ id: 'prometheus', deployable: true }], items: [
    { id: 'all', kind: 'rules-bundle' },
    { id: 'assurance', kind: 'rules-assurance', label: 'Assurance · watchdog + instrument liveness', subtitle: '7 alerts · generic, prometheus' },
    { id: 'slo:x_99', kind: 'rules-slo', sloId: 'x_99', label: 'SLO · x_99' },
  ] }] });
  const row = manifest.find(r => r.key === 'rules:alert:assurance');
  assert(row && row.type === 'alert' && row.id === 'assurance' && row.group === 'rules' && row.flavor === 'prometheus' && row.artifact === 'assurance' && row.scope === 'alerting' && row.deployable === true && row.source === 'Repo' && row.name === 'Assurance · watchdog + instrument liveness',
         'catalogToDeployManifest maps the rules-assurance item to one alerting row rules:alert:assurance', row);
  assert(manifest.filter(r => r.type === 'alert').length === 2 && matcherForDeployItem(row).kinds.join() === 'alert_rule' && matcherForDeployItem(manifest.find(r => r.key === 'rules:alert:slo:x_99')).kinds.join() === 'burn_rate',
         'the manifest carries the assurance row beside the per-SLO alert row, each with its own matcher');
}

// ---------- fixtures ----------
const k = (kind, idn, n) => `${kind}::${JSON.stringify(idn)}${n ? `#0${n}` : ''}`;
const diffFor = (layers) => ({ summary: { alignment: 0.7 }, layers });

const items = [
  { type: 'dashboard', id: 'payment-overview' },
  { type: 'alert', id: 'settlement_latency_99' },
  { type: 'recording', id: 'settlement_latency_99', artifact: 'slo:settlement_latency_99' },
];

// All aligned → everything verified.
const allGood = diffFor({
  L3: {
    inBoth: [
      { key: k('dashboard', { id: 'payment-overview' }), match: 'aligned' },
      { key: k('recording_rule', { record: 'pay:settlement_latency:ratio_5m' }), match: 'aligned' },
      { key: k('recording_rule', { record: 'pay:settlement_latency:ratio_1h' }, 2), match: 'aligned' },
    ],
    onlyInA: [], onlyInB: [],
  },
  L4: { inBoth: [{ key: k('burn_rate', { slo: 'settlement_latency_99' }), match: 'aligned' }], onlyInA: [], onlyInB: [] },
});
let r = computeDeployTransitions(items, allGood);
assert(r.summary.allVerified === true, 'all aligned → allVerified', r.summary, 'allVerified');
assert(r.summary.outcome === 'verified', 'outcome is verified');
assert(r.alignment === 0.7, 'alignment passes through from diff.summary');
assert(r.transitions.every(t => t.status === 'verified'), 'every transition verified');

// Propagation lag: rules not visible yet → pending, never verified.
const lagging = diffFor({
  L3: {
    inBoth: [{ key: k('dashboard', { id: 'payment-overview' }), match: 'aligned' }],
    onlyInA: [{ key: k('recording_rule', { record: 'pay:settlement_latency:ratio_5m' }) }],
    onlyInB: [],
  },
  L4: { inBoth: [], onlyInA: [{ key: k('burn_rate', { slo: 'settlement_latency_99' }) }], onlyInB: [] },
});
r = computeDeployTransitions(items, lagging);
assert(r.transitions.find(t => t.type === 'dashboard').status === 'verified', 'dashboard verified while rules lag');
assert(r.transitions.find(t => t.type === 'alert').status === 'pending', 'alert still onlyInA → pending');
assert(r.transitions.find(t => t.type === 'recording').status === 'pending', 'recording still onlyInA → pending');
assert(r.summary.outcome === 'pending', 'any pending → outcome pending');
assert(r.summary.allVerified === false, 'pending NEVER counts as verified (Phase 1 contract)');

// Artefact absent from every bucket → pending (not yet visible at all).
const absent = diffFor({ L3: { inBoth: [], onlyInA: [], onlyInB: [] } });
r = computeDeployTransitions([{ type: 'dashboard', id: 'payment-overview' }], absent);
assert(r.transitions[0].status === 'pending', 'absent everywhere → pending');

// Drift: deployed but live contract differs.
const drifty = diffFor({
  L3: { inBoth: [{ key: k('dashboard', { id: 'payment-overview' }), match: 'drifted' }], onlyInA: [], onlyInB: [] },
});
r = computeDeployTransitions([{ type: 'dashboard', id: 'payment-overview' }], drifty);
assert(r.transitions[0].status === 'drifted', 'drifted match reported as drifted');
assert(r.summary.outcome === 'partial', 'no pending + not all verified → partial');

// Multi-match precedence: one of the SLO's rules pending keeps the item pending;
// pending beats drifted beats verified.
const mixedRules = diffFor({
  L3: {
    inBoth: [
      { key: k('recording_rule', { record: 'pay:settlement_latency:ratio_5m' }), match: 'aligned' },
      { key: k('recording_rule', { record: 'pay:settlement_latency:ratio_1h' }, 2), match: 'drifted' },
    ],
    onlyInA: [{ key: k('recording_rule', { record: 'pay:settlement_latency:ratio_1d' }, 3) }],
    onlyInB: [],
  },
});
r = computeDeployTransitions([{ type: 'recording', id: 'settlement_latency_99', artifact: 'slo:settlement_latency_99' }], mixedRules);
assert(r.transitions[0].status === 'pending', 'one missing rule keeps the whole item pending');
assert(r.transitions[0].counts.verified === 1 && r.transitions[0].counts.drifted === 1 && r.transitions[0].counts.pending === 1,
       'per-entry counts are reported for the drill-down', r.transitions[0].counts, { verified: 1, drifted: 1, pending: 1, shadow: 0 });

// Shadow: appears only on the live side.
const shadow = diffFor({
  L3: { inBoth: [], onlyInA: [], onlyInB: [{ key: k('dashboard', { id: 'payment-overview' }) }] },
});
r = computeDeployTransitions([{ type: 'dashboard', id: 'payment-overview' }], shadow);
assert(r.transitions[0].status === 'shadow', 'onlyInB match reported as shadow, not hidden');

// Empty deploy set → explicit nothing-to-verify, never a fake pass.
r = computeDeployTransitions([], allGood);
assert(r.summary.outcome === 'nothing-to-verify' && r.summary.allVerified === false,
       'empty item set is nothing-to-verify, not verified');

// Unmappable item type → unknown, surfaced.
r = computeDeployTransitions([{ type: 'mystery', id: 'x' }], allGood);
assert(r.transitions[0].status === 'unknown', 'unmappable item is reported unknown');

report('verify-deploy', 'all post-deploy transition assertions pass.');
