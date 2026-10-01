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
  deployReviewModel, reviewHostOf, hiddenSelectionNote, recommendRemediation, remediationDeployPhrase,
  remediationDeployActionLabel, remediationDeployActionTitle, remediationSideOnlyMeasure,
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

// ---------- pre-deploy review ----------
// The one panel before a deploy: destination, environment, what changes and
// whether it is ready. Blocking = nothing selected, no gateway, no product,
// an invalid schema. The tier rubric informs but never blocks: conformance
// is not deployment readiness.
const reviewRows = [
  { type: 'recording', id: 'settlement_latency_99', name: 'SLO · settlement_latency_99 (recording rules)' },
  { type: 'alert', id: 'settlement_latency_99', name: 'SLO · settlement_latency_99 (burn-rate alerts)' },
  { type: 'dashboard', id: 'payment-overview', name: 'payment-overview' },
];
const readyReview = deployReviewModel({
  target: { product: 'grafana', version: '12', url: 'https://grafana.example.net/d/x', folder: 'observability-pack', mcpUrl: 'https://user:secret@mcp.example.com/observability?token=abc' },
  source: { id: 'payment-service', label: 'Payment service', version: 'v0.4.0' },
  env: 'prod',
  rows: reviewRows,
  validation: { schemaValid: true, rubric: { conformant: false, tier: 'tier-2' } },
});
assert(readyReview.ready === true, 'a complete form with a valid pack is ready, even when the rubric is not met');
assert(readyReview.headline === 'Ready to deploy 3 artefacts to grafana 12 (prod).', 'the ready headline names count, destination and environment', readyReview.headline);
assert(readyReview.destination.gateway === 'mcp.example.com' && !JSON.stringify(readyReview).includes('secret') && !JSON.stringify(readyReview).includes('token'),
       'the gateway is shown by host only: no userinfo, no query credentials');
assert(readyReview.destination.host === 'grafana.example.net' && readyReview.destination.folder === 'observability-pack',
       'destination carries the Grafana host and folder');
assert(readyReview.changes.summary === '1 recording rule, 1 alert rule, 1 dashboard', 'changed artefacts are summarised by type', readyReview.changes.summary);
assert(readyReview.source.version === '0.4.0', 'a leading v on the source version is not doubled');
const rubricCheck = readyReview.checks.find(c => c.id === 'rubric');
assert(rubricCheck.status === 'warning' && rubricCheck.blocking === false && rubricCheck.label === 'Does not meet tier-2 rubric',
       'an unmet rubric warns without blocking');

const blockedReview = deployReviewModel({ target: { product: 'grafana', version: '12' }, rows: [], validation: { schemaValid: false } });
assert(blockedReview.ready === false, 'no rows, no gateway and an invalid schema block the deploy');
assert(blockedReview.blockers.map(b => b.id).join() === 'selection,gateway,schema', 'every blocker is named, in form order', blockedReview.blockers.map(b => b.id));
assert(blockedReview.headline === 'Not ready to deploy: select at least one artefact, add the MCP gateway URL and fix the pack’s schema errors.',
       'the not-ready headline lists what to fix', blockedReview.headline);
const unknownSchema = deployReviewModel({ target: { product: 'grafana', mcpUrl: 'https://mcp.example.com' }, rows: reviewRows.slice(0, 1) });
assert(unknownSchema.ready === true && unknownSchema.checks.find(c => c.id === 'schema').status === 'notEvaluated'
       && unknownSchema.checks.find(c => c.id === 'rubric').status === 'notEvaluated',
       'an unchecked schema or rubric reads not evaluated, never pass, and does not block');
// A met rubric is "met with real values" only when nothing says it rests on
// template values: placeholder passes or template values in the pack turn it
// into the Represented (placeholder) state, still non-blocking.
const rubricOf = (rubric) => deployReviewModel({
  target: { product: 'grafana', mcpUrl: 'https://mcp.example.com' }, rows: reviewRows.slice(0, 1),
  validation: { schemaValid: true, rubric },
}).checks.find(c => c.id === 'rubric');
const onPh = rubricOf({ conformant: true, tier: 'tier-2', placeholders: 1, templates: 0 });
assert(onPh.status === 'placeholder' && onPh.label === 'Meets tier-2 rubric on placeholder values' && onPh.blocking === false,
       'a rubric met on placeholder passes is never a plain pass', onPh);
const onTpl = rubricOf({ conformant: true, tier: 'tier-2', templates: 3 });
assert(onTpl.status === 'placeholder' && onTpl.label === 'Meets tier-2 rubric; template values remain',
       'a rubric met while the pack still carries template values is never a plain pass', onTpl);
const clean = rubricOf({ conformant: true, tier: 'tier-2', placeholders: 0, templates: 0 });
assert(clean.status === 'pass' && clean.label === 'Meets tier-2 rubric', 'a rubric met with no template values is a pass', clean);
assert(rubricOf({ conformant: false, tier: 'tier-2', placeholders: 2 }).status === 'warning',
       'an unmet rubric warns whatever the placeholders');

// The type-filter note says the true effect: hidden selected rows are NOT
// deployed. With per-type counts it appears only when a hidden type holds
// selected rows; without counts it still never says "review everything".
const dashHidden = [{ value: 'dashboard', label: 'Dashboard' }];
assert(hiddenSelectionNote({ hiddenTypes: dashHidden, hiddenSelected: { dashboard: 2 } })
       === '2 selected dashboards are filtered out of the table and will not be deployed. Show every type to include them.',
       'hidden selected rows are counted and said not to deploy');
assert(hiddenSelectionNote({ hiddenTypes: [...dashHidden, { value: 'alert', label: 'Alert rule' }], hiddenSelected: { dashboard: 0, alert: 1, recording: 4 } })
       === '1 selected alert rule is filtered out of the table and will not be deployed. Show every type to include it.',
       'only hidden types with selected rows are named; visible types never count');
assert(hiddenSelectionNote({ hiddenTypes: dashHidden, hiddenSelected: { dashboard: 0 } }) === '',
       'no note when the hidden types hold no selected row');
const noCounts = hiddenSelectionNote({ hiddenTypes: dashHidden });
assert(/not deployed/.test(noCounts) && !/review everything/.test(noCounts) && noCounts.includes('Dashboard'),
       'without counts the note still says filtered-out selections are not deployed', noCounts);
assert(hiddenSelectionNote({ hiddenTypes: [] }) === '', 'no hidden type, no note');

// ---------- Remediate: recommendation and deploy counts ----------
// Deploy is recommended only when something repo-only can be deployed.
assert(recommendRemediation({ haveB: true, mode: 'drift', repoOnly: 19, repoDeployable: 0 }) === null,
       'repo-only artefacts that all need a manual fix never recommend "deploy to live"');
assert(recommendRemediation({ haveB: true, mode: 'drift', repoOnly: 19, repoDeployable: 0, drift: 2 })?.op === 'drift',
       'with nothing deployable, drift is the recommendation when present');
assert(recommendRemediation({ haveB: true, mode: 'drift', repoOnly: 30, repoDeployable: 11 })?.op === 'deploy',
       'deployable repo-only artefacts recommend deploy');
assert(recommendRemediation({ haveB: true, mode: 'drift', liveOnly: 3, repoOnly: 19, repoDeployable: 0 })?.op === 'retrofeed',
       'the "both directions" recommendation needs a deployable half');
assert(recommendRemediation({ haveB: true, mode: 'drift', liveOnly: 3, repoOnly: 5, repoDeployable: 2 })?.op === 'all',
       'both sides with a deployable half recommend both directions');
assert(recommendRemediation({ haveB: true, mode: 'gap', repoOnly: 5, repoDeployable: 5 }) === null,
       'gap mode never recommends pushing the pack\'s extras');
assert(recommendRemediation({ haveB: false, repoDeployable: 5 }) === null, 'no Pack B, no recommendation');

// Deploy counts stay in artefacts, so they add up with "need a manual fix";
// deploy rows only qualify them (an SLO is two rows).
assert(remediationDeployPhrase({ selected: 11, deployable: 11, rows: 16 }) === '11 to deploy (16 deploy rows)',
       'all selected: artefacts to deploy, rows in brackets');
assert(remediationDeployPhrase({ selected: 4, deployable: 11, rows: 6 }) === '4 of 11 selected to deploy (6 deploy rows)',
       'partly selected: selected of deployable artefacts');
assert(remediationDeployPhrase({ selected: 0, deployable: 0, rows: 0 }) === '', 'nothing deployable, no deploy phrase');
// The deploy button counts artefacts like the phrase beside it; the deploy rows go in its tooltip.
assert(remediationDeployActionLabel({ selected: 11, rows: 16 }) === 'Review and deploy 11 artefacts to live',
       'deploy action: selected artefacts');
assert(remediationDeployActionLabel({ selected: 1, rows: 1 }) === 'Review and deploy 1 artefact to live',
       'deploy action: singular artefact');
assert(remediationDeployActionTitle({ selected: 11, rows: 16 }).startsWith('11 selected artefacts · 16 deploy rows'),
       'deploy action tooltip: artefacts and the deploy rows behind them');
assert(remediationDeployActionTitle({ selected: 1, rows: 1 }).startsWith('1 selected artefact · 1 deploy row'),
       'deploy action tooltip: singular'); 

// "Only in live/baseline" = 0 only covers the checked scope when Pack B
// artefacts were parked: in gap mode it is never "nothing to import".
{
  const gapParked = remediationSideOnlyMeasure({ mode: 'gap', liveOnly: 0, outOfScope: 6 });
  assert(gapParked.tone === 'warn' && !/nothing to import/.test(gapParked.note) && /not compared/.test(gapParked.note),
         'gap mode with parked baseline artefacts: warn, says the rest was not compared', gapParked);
  const liveParked = remediationSideOnlyMeasure({ mode: 'drift', liveOnly: 0, outOfScope: 6 });
  assert(/checked scope/.test(liveParked.note), 'live mode with parked artefacts: bounded to the checked scope', liveParked);
  assert(remediationSideOnlyMeasure({ mode: 'gap', liveOnly: 0, outOfScope: 0 }).note === 'nothing to import',
         'nothing parked and nothing missing: nothing to import');
  assert(remediationSideOnlyMeasure({ mode: 'gap', liveOnly: 3, outOfScope: 6 }).tone === 'warn',
         'missing artefacts: warn');
}

assert(reviewHostOf('not a url/with/path') === 'not a url' && reviewHostOf('') === '' && reviewHostOf('mcp.example.com/x?t=1') === 'mcp.example.com',
       'reviewHostOf degrades to the leading host-like segment for unparseable input');

report('verify-deploy', 'all post-deploy transition assertions pass.');
