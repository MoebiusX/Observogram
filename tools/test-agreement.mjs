#!/usr/bin/env node
/**
 * tools/test-agreement.mjs — a service's operational agreement as the studio keeps it
 * (studio/agreement.mjs): what a client may send, the versions kept, what a repository's pack
 * declares that a commitment can be linked to, what of the agreement it covers, the words, the
 * form's links and pasted lines, and the module's own rule — zero imports.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LINK_KINDS, AGREEMENT_VERSIONS_MAX, COMMITMENTS_MAX, LINKS_MAX, agreementErrors, agreementRecord, agreementCurrent, sameAgreement, storedAgreementError,
  agreementCatalogue, agreementCoverage, coverageOver, coverageWords, coverageSummary, linkText, linksFromText, commitmentId, commitmentsFromText, linkKindLabel,
  agreementRoutes, commitmentFacts, gapsWords, targetMatch, AGREEMENT_OWNERS,
  isProduction, evidenceCap, liveStatusOf, commitmentEvidence, evidenceSummary,
} from '../studio/agreement.mjs';

const SOURCE = { document: 'Platform agreement', version: '2.1', effective: '2026-11-01' };
const C = (id, extra = {}) => ({ id, clause: '4.1', text: 'Requests succeed', target: '99.9% per calendar month, excluding planned maintenance', owner: 'service', links: [], ...extra });
const V = (commitments, source = SOURCE) => ({ source, commitments });

// A repository's pack, as the adapter lays it out: one of each kind, one of them the scan's placeholder.
const layered = { layers: {
  L1: [{ id: 'SLI-01', title: 'checkout_availability' }, { id: 'SLO-01', title: 'checkout_availability_99_9' }, { id: 'SLO-02', title: 'derived_from_alert', source: 'Scaffold' }],
  L2: [{ id: 'METRIC-SRC-01', title: 'http_requests_total' }, { id: 'METRIC-FAM-01', title: 'a family' }, { id: 'SCRAPE-SRC-01', title: 'checkout' }, { id: 'BAK-01', title: 'a backend' }],
  L3: [{ id: 'QRY-01', title: 'checkout:errors:ratio_5m' }, { id: 'DASH-01', title: 'checkout-overview' }, { id: 'PANEL-01', title: 'a panel' }],
  L4: { policy: [{ id: 'POL-01', title: 'burn-rate alert: checkout_availability_99_9', spec: { slo: 'ref:slos.checkout_availability_99_9' } }], alerting: [{ id: 'RULE-01', title: 'CheckoutErrorsHigh' }, { id: 'RULE-02', title: 'CheckoutErrorsHigh' }] },
  L5: [], GOV: [],
} };

test('the module imports nothing, and names the kinds a commitment links to', () => {
  const src = readFileSync(new URL('../studio/agreement.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...src.matchAll(/^import\s/gm)], []);
  assert.deepEqual(LINK_KINDS.map((k) => k.kind), ['slo', 'indicator', 'alert', 'burn_alert', 'recording_rule', 'dashboard', 'metric', 'exporter']);
  assert.deepEqual([linkKindLabel('burn_alert'), linkKindLabel('nope')], ['Burn-rate alert', 'nope']);
});

test('agreementErrors: the source document, its version and the day it comes into force; each commitment says what is promised; the target is kept as written', () => {
  assert.deepEqual(agreementErrors(null), []);
  assert.deepEqual(agreementErrors(V([C('a'), C('b', { owner: 'consumer', target: '', clause: '', links: [{ kind: 'dashboard', name: 'checkout-overview' }] })])), []);
  assert.deepEqual(agreementErrors(V([])), [], 'a document with nothing entered yet reads');
  for (const bad of [undefined, [], 'x', {}, { source: SOURCE }, { commitments: [] }]) assert.equal(agreementErrors(bad).length, 1, JSON.stringify(bad));
  assert.match(agreementErrors(V([], { ...SOURCE, document: '' }))[0], /source\.document names the document/);
  assert.match(agreementErrors(V([], { ...SOURCE, version: 'v'.repeat(41) }))[0], /source\.version/);
  for (const effective of ['2026-13-01', '2026-02-30', '1 Nov 2026', '', 20261101]) assert.match(agreementErrors(V([], { ...SOURCE, effective }))[0], /source\.effective is the day/, String(effective));
  assert.deepEqual(agreementErrors({ ...V([]), note: 1 }), ['note is not an agreement field']);
  // A target is text: a calendar month, exclusions, 100% — nothing an SLO's limits would take is refused.
  for (const target of ['100%', '99.9% per calendar month, excluding planned maintenance', 'within 15 minutes, business hours', 'p95 < 500 ms']) assert.deepEqual(agreementErrors(V([C('a', { target })])), [], target);
  assert.match(agreementErrors(V([C('a', { text: '' })]))[0], /commitments\[0\]\.text says what is promised/);
  assert.match(agreementErrors(V([C('a'), C('a')]))[0], /"a" is used twice/);
  assert.match(agreementErrors(V([C('Not An Id')]))[0], /\.id is a short id/);
  assert.match(agreementErrors(V([C('a', { owner: 'someone' })]))[0], /\.owner is one of service, consumer, both/);
  assert.deepEqual(agreementErrors(V([C('a', { owner: 'both', weight: 100 })])), []);
  for (const weight of [0, 101, 1.5, '3', null]) assert.match(agreementErrors(V([C('a', { weight })]))[0], /\.weight is a whole number from 1 to 100/, String(weight));
  assert.match(agreementErrors(V([C('a', { links: [{ kind: 'panel', name: 'x' }] })]))[0], /links\[0\] is \{ kind, name \}/);
  assert.match(agreementErrors(V([C('a', { links: Array.from({ length: LINKS_MAX + 1 }, (_, i) => ({ kind: 'metric', name: `m${i}` })) })]))[0], /more than 20 links/);
  assert.match(agreementErrors(V(Array.from({ length: COMMITMENTS_MAX + 1 }, (_, i) => C(`c${i}`))))[0], /more than 200 commitments/);
  assert.match(agreementErrors(V([C('a', { text: 'two\nlines' })]))[0], /on one line/);
});

test('agreementRecord: the same issue of the document corrects the newest version; another adds one; who and when are kept only when nothing changed', () => {
  const first = agreementRecord(V([C('a')]), { actor: 'ana', now: '2026-11-19T10:00:00.000Z' });
  assert.deepEqual(first.versions.map((v) => [v.source.version, v.commitments.length, v.by, v.at]), [['2.1', 1, 'ana', '2026-11-19T10:00:00.000Z']]);
  assert.deepEqual(first.versions[0].commitments[0], { id: 'a', clause: '4.1', text: 'Requests succeed', target: '99.9% per calendar month, excluding planned maintenance', owner: 'service', links: [] });
  const again = agreementRecord(V([C('a')]), { current: first, actor: 'ben', now: '2026-11-20T10:00:00.000Z' });
  assert.deepEqual(again, first, 'sent again unchanged: as it was, still ana\'s');
  const corrected = agreementRecord(V([C('a'), C('b')]), { current: first, actor: 'ben', now: '2026-11-20T10:00:00.000Z' });
  assert.deepEqual(corrected.versions.map((v) => [v.source.version, v.commitments.length, v.by]), [['2.1', 2, 'ben']], 'the same source: corrected in place, signed again');
  const next = agreementRecord(V([C('a')], { ...SOURCE, version: '3.0', effective: '2027-01-01' }), { current: corrected, actor: 'ana', now: '2026-12-20T10:00:00.000Z' });
  assert.deepEqual(next.versions.map((v) => v.source.version), ['2.1', '3.0']);
  assert.equal(agreementCurrent(next).source.version, '3.0');
  assert.ok(sameAgreement(first, again) && !sameAgreement(first, corrected) && sameAgreement(null, null) && !sameAgreement(first, null));
  assert.equal(agreementRecord(null, { current: next }), null, 'null: no agreement');
  assert.equal(agreementCurrent(null), null);
  // Past the cap the oldest version leaves.
  let many = null;
  for (let i = 0; i < AGREEMENT_VERSIONS_MAX + 2; i += 1) many = agreementRecord(V([C('a')], { ...SOURCE, version: String(i) }), { current: many, actor: 'ana', now: 'x' });
  assert.deepEqual([many.versions.length, many.versions[0].source.version], [AGREEMENT_VERSIONS_MAX, '2']);
  // Links said twice are kept once; text is trimmed; an unknown owner cannot arrive (agreementErrors), a missing one is the service's.
  const tidy = agreementRecord(V([{ id: 'a', text: '  Requests succeed ', links: [{ kind: 'metric', name: ' up ' }, { kind: 'metric', name: 'up' }] }]), {});
  assert.deepEqual(tidy.versions[0].commitments[0], { id: 'a', clause: '', text: 'Requests succeed', target: '', owner: 'service', links: [{ kind: 'metric', name: 'up' }] });
  assert.equal(storedAgreementError(first), '');
  assert.equal(storedAgreementError({ versions: [] }), 'it is not { versions: [...] }');
  assert.match(storedAgreementError({ versions: [{ source: { ...SOURCE, effective: 'soon' }, commitments: [] }] }), /source\.effective/);
});

test('agreementCatalogue: what the repository declares, by kind and name, each once; a placeholder the scan wrote is marked', () => {
  assert.deepEqual(agreementCatalogue(layered).map(({ kind, name, guessed }) => ({ kind, name, guessed })), [
    { kind: 'indicator', name: 'checkout_availability', guessed: false },
    { kind: 'slo', name: 'checkout_availability_99_9', guessed: false },
    { kind: 'slo', name: 'derived_from_alert', guessed: true },
    { kind: 'metric', name: 'http_requests_total', guessed: false },
    { kind: 'exporter', name: 'checkout', guessed: false },
    { kind: 'recording_rule', name: 'checkout:errors:ratio_5m', guessed: false },
    { kind: 'dashboard', name: 'checkout-overview', guessed: false },
    { kind: 'burn_alert', name: 'checkout_availability_99_9', guessed: false },
    { kind: 'alert', name: 'CheckoutErrorsHigh', guessed: false },
  ]);
  assert.deepEqual(agreementCatalogue(null), []);
});

test('agreementCoverage: covered, in part, not covered — by any kind or by none; the consumer\'s counted apart; a placeholder covers nothing; no pack read is never "not covered"', () => {
  const version = V([
    C('all', { links: [{ kind: 'slo', name: 'checkout_availability_99_9' }, { kind: 'alert', name: 'CheckoutErrorsHigh' }] }),
    C('dash-only', { links: [{ kind: 'dashboard', name: 'checkout-overview' }] }),
    C('some', { links: [{ kind: 'metric', name: 'http_requests_total' }, { kind: 'dashboard', name: 'gone' }] }),
    C('none-found', { links: [{ kind: 'alert', name: 'Nope' }] }),
    C('placeholder', { links: [{ kind: 'slo', name: 'derived_from_alert' }] }),
    C('unlinked'),
    C('theirs', { owner: 'consumer' }),
  ]);
  const cov = agreementCoverage(version, layered);
  assert.deepEqual(cov.commitments.map((c) => [c.id, c.state, coverageWords(c)]), [
    ['all', 'covered', 'Covered by the repository'],
    ['dash-only', 'covered', 'Covered by the repository'],
    ['some', 'part', 'Covered in part: 1 not in the repository'],
    ['none-found', 'not-covered', 'Not covered: 1 not in the repository'],
    ['placeholder', 'not-covered', 'Not covered: 1 only a placeholder the scan wrote'],
    ['unlinked', 'not-covered', 'Not covered: linked to nothing'],
    ['theirs', 'not-covered', 'Not covered: linked to nothing'],
  ]);
  assert.deepEqual(cov.counts, { total: 7, service: 6, consumer: 1, covered: 2, part: 1, notCovered: 3 });
  assert.equal(coverageSummary(cov.counts), "2 of 6 commitments covered by the repository, 1 in part, 3 not; 1 more is the consumer's.");
  assert.deepEqual(coverageOver(version, agreementCatalogue(layered)), cov, 'the same over a catalogue already read');
  const unread = agreementCoverage(version, null);
  assert.ok(unread.commitments.every((c) => c.state === 'not-read') && unread.read === false);
  assert.deepEqual(unread.counts, { total: 7, service: 6, consumer: 1, covered: null, part: null, notCovered: null });
  assert.equal(coverageWords(unread.commitments[0]), 'Not looked up: the repository is not read yet');
  assert.equal(coverageSummary(unread.counts), "6 commitments; the repository is not read yet. 1 more is the consumer's.");
  assert.equal(coverageSummary({ total: 0 }), 'No commitment recorded.');
  assert.equal(coverageSummary({ total: 1, service: 1, consumer: 0, covered: 1, part: 0, notCovered: 0 }), '1 of 1 commitment covered by the repository.');
  assert.equal(coverageSummary({ total: 2, service: 0, consumer: 2, covered: 0, part: 0, notCovered: 0 }), "2 are the consumer's.");
  assert.deepEqual(agreementCoverage(null, layered).counts.total, 0);
});

test('the form: links as kind:name, an id from the clause, several commitments pasted a line each', () => {
  assert.deepEqual(linksFromText('slo:checkout_availability_99_9, Alert: CheckoutErrorsHigh\nburn alert:x, recording-rule:shop:errors:ratio_5m, slo:checkout_availability_99_9'), {
    links: [{ kind: 'slo', name: 'checkout_availability_99_9' }, { kind: 'alert', name: 'CheckoutErrorsHigh' }, { kind: 'burn_alert', name: 'x' }, { kind: 'recording_rule', name: 'shop:errors:ratio_5m' }],
    problems: [],
  });
  assert.deepEqual(linksFromText('panel:x, justaname, slo:'), { links: [], problems: ['panel:x', 'justaname', 'slo:'] });
  assert.deepEqual(linksFromText(''), { links: [], problems: [] });
  assert.equal(linkText({ kind: 'alert', name: 'A' }), 'alert:A');
  assert.deepEqual([commitmentId('4.1'), commitmentId('4.1', ['4-1']), commitmentId(''), commitmentId('§§', ['c-1'])], ['4-1', '4-1-1', 'c-1', 'c-2']);
  const pasted = commitmentsFromText('4.1 | Requests succeed | 99.9% per calendar month | | slo:checkout_availability_99_9\n\n5.2 | Retries back off | | Consumer | \nIncidents are acknowledged within 15 minutes\n6 |  | x\n7 | Latency holds | | | nonsense', ['4-1']);
  assert.deepEqual(pasted.commitments, [
    { id: '4-1-1', clause: '4.1', text: 'Requests succeed', target: '99.9% per calendar month', owner: 'service', links: [{ kind: 'slo', name: 'checkout_availability_99_9' }] },
    { id: '5-2', clause: '5.2', text: 'Retries back off', target: '', owner: 'consumer', links: [] },
    { id: 'c-1', clause: '', text: 'Incidents are acknowledged within 15 minutes', target: '', owner: 'service', links: [] },
    { id: '7', clause: '7', text: 'Latency holds', target: '', owner: 'service', links: [] },
  ]);
  assert.deepEqual(pasted.problems, ['line 5: nothing says what is promised', 'line 6: "nonsense" is not kind:name']);
  assert.deepEqual(agreementErrors(V(pasted.commitments)), [], 'what the paste makes is what the server takes');
});

// A repository with its chains: an objective with all of it, one with nothing but its indicator (the
// scan's default objective), an alert rule at a severity routed nowhere.
const chained = {
  meta: { annotations: { 'crawler.guessMarks': '1', 'crawler.scaffold.slos.bare_99.objective': 'default' }, studioObjectives: {} },
  layers: {
    L1: [
      { id: 'SLI-01', title: 'checkout', spec: { id: 'checkout', good: 'sum(rate(ok[5m]))', total: 'sum(rate(all[5m]))' } },
      { id: 'SLI-02', title: 'bare', spec: { id: 'bare', description: 'Inferred from recording rules a and b.' } },
      { id: 'SLO-01', title: 'checkout_99_9', refs: ['slis.checkout'], spec: { id: 'checkout_99_9', sli: 'ref:slis.checkout', objective: 0.999, window: '30d' } },
      { id: 'SLO-02', title: 'bare_99', refs: ['slis.bare'], spec: { id: 'bare_99', sli: 'ref:slis.bare', objective: 0.99, window: '30d' } },
    ],
    L2: [{ id: 'METRIC-SRC-01', title: 'http_requests_total' }],
    L3: [
      { id: 'DASH-01', title: 'checkout-overview', refs: ['slos.checkout_99_9'] },
      { id: 'PANEL-01', title: 'availability', parent: 'checkout-overview', refs: ['slis.checkout'] },
      { id: 'PANEL-02', title: 'errors', parent: 'checkout-errors', refs: ['slis.checkout'] },
      { id: 'DASH-02', title: 'retention' },
    ],
    L4: {
      policy: [{ id: 'POL-01', title: 'burn-rate alert: checkout_99_9', refs: ['slos.checkout_99_9'], spec: { slo: 'checkout_99_9', windows: [{ severity: 'SEV1' }, { severity: 'SEV2' }] } }],
      alerting: [
        { id: 'ALR-01', title: 'SEV1 routes', spec: { severity: 'SEV1', channels: [{ voice: 'x' }] } },
        { id: 'ALR-02', title: 'SEV2 routes', spec: { severity: 'SEV2', channels: [{ chat: 'y' }] } },
        { id: 'ALR-03', title: 'SEV3 routes', spec: { severity: 'SEV3', channels: [] } },
        { id: 'RULE-01', title: 'QueueStuck', spec: { severity: 'SEV3' } },
        { id: 'RULE-02', title: 'DiskFull', spec: { labels: { severity: 'SEV1' } } },
      ],
    },
    L5: [], GOV: [],
  },
};

test('the catalogue carries what stands behind an objective and an indicator; the routes are the severities that go somewhere', () => {
  const by = Object.fromEntries(agreementCatalogue(chained).map((x) => [`${x.kind}:${x.name}`, x]));
  assert.deepEqual(by['slo:checkout_99_9'], { kind: 'slo', name: 'checkout_99_9', guessed: false, indicator: 'checkout', measured: true, objective: 0.999, window: '30d', objectiveSource: 'repository', burn: ['SEV1', 'SEV2'], dashboards: 2 });
  assert.deepEqual(by['slo:bare_99'], { kind: 'slo', name: 'bare_99', guessed: false, indicator: 'bare', measured: false, objective: 0.99, window: '30d', objectiveSource: 'guessed', burn: null, dashboards: 0 });
  assert.deepEqual(by['indicator:checkout'], { kind: 'indicator', name: 'checkout', guessed: false, measured: true, dashboards: 2 });
  assert.deepEqual([by['burn_alert:checkout_99_9'].severities, by['alert:QueueStuck'].severities, by['alert:DiskFull'].severities], [['SEV1', 'SEV2'], ['SEV3'], ['SEV1']]);
  assert.deepEqual(agreementRoutes(chained), ['SEV1', 'SEV2'], 'a route with no channel goes nowhere');
  // An objective stated in the studio for a guessed one is a person's.
  const stated = { ...chained, meta: { ...chained.meta, studioObjectives: { bare_99: { objective: 0.995, window: '30d' } } } };
  const entry = agreementCatalogue(stated).find((x) => x.name === 'bare_99' && x.kind === 'slo');
  assert.deepEqual([entry.objectiveSource, entry.objective, entry.window], ['studio', 0.995, '30d'], 'the stated number and window are the objective\'s');
  assert.equal(commitmentFacts(V([C('a', { target: '99.5% over 30 days', links: [{ kind: 'slo', name: 'bare_99' }] })]), agreementCatalogue(stated), []).commitments[0].target.state, 'same');
});

test('commitmentFacts: what the repository has behind each commitment and what it lacks, each gap with its fix — only what the commitment\'s own links call for', () => {
  const version = V([
    C('whole', { target: '99.9% over 30 days', links: [{ kind: 'slo', name: 'checkout_99_9' }] }),
    C('bare', { target: '99.5% per calendar month', owner: 'both', weight: 3, links: [{ kind: 'slo', name: 'bare_99' }] }),
    C('alert-only', { target: 'an alert must exist', links: [{ kind: 'alert', name: 'QueueStuck' }] }),
    C('routed-alert', { target: '', links: [{ kind: 'alert', name: 'DiskFull' }] }),
    C('dash-only', { target: 'kept for 13 months', links: [{ kind: 'dashboard', name: 'retention' }] }),
    C('unlinked', { target: 'within 15 minutes' }),
  ]);
  const facts = commitmentFacts(version, agreementCatalogue(chained), agreementRoutes(chained));
  const of = (id) => facts.commitments.find((c) => c.id === id);
  assert.deepEqual(of('whole').has, { kinds: ['slo'], measured: true, measure: 'indicator', alerts: [{ kind: 'burn_alert', name: 'checkout_99_9' }], severities: ['SEV1', 'SEV2'], unrouted: [], routed: true, dashboards: 2, objective: { slo: 'checkout_99_9', value: 0.999, window: '30d', source: 'repository' } });
  assert.deepEqual([of('alert-only').has.kinds, of('alert-only').has.measure, of('alert-only').has.severities, of('alert-only').has.unrouted, of('dash-only').has.kinds], [['alert'], null, ['SEV3'], ['SEV3'], ['dashboard']]);
  assert.deepEqual([of('whole').gaps, of('whole').target, gapsWords(of('whole').gaps)], [[], { state: 'same', words: 'The target and the objective agree: 99.9% over 30 days.' }, '']);
  assert.deepEqual([of('bare').owner, of('bare').weight, of('bare').has.routed, of('bare').gaps.map((g) => g.key), gapsWords(of('bare').gaps)],
    ['both', 3, null, ['measured', 'detected', 'seen', 'objective'], 'Lacks a measure, an alert, a dashboard, a stated objective.']);
  assert.equal(of('bare').gaps[1].words, 'No alert would fire: the objective bare_99 has no burn-rate alert.');
  assert.equal(of('bare').target.state, 'guessed');
  // An alert that must exist: it should go somewhere, and needs no measure, dashboard or objective.
  assert.deepEqual([of('alert-only').gaps.map((g) => [g.key, g.words]), of('alert-only').has.routed], [[['routed', 'Its alerts page at SEV3, which the repository routes nowhere.']], false]);
  assert.deepEqual([of('routed-alert').gaps, of('routed-alert').has.routed, of('routed-alert').target.state], [[], true, 'none']);
  // A dashboard that must exist lacks nothing; its target is in words and is not compared.
  assert.deepEqual([of('dash-only').gaps, of('dash-only').has.dashboards, of('dash-only').target.state], [[], 1, 'words']);
  assert.deepEqual([of('unlinked').has, of('unlinked').gaps.map((g) => g.key), of('unlinked').gaps[0].words], [null, ['in-pack'], 'It is linked to nothing in the repository.']);
  // No pack read: nothing is said to be lacking.
  const unread = commitmentFacts(version, null);
  assert.ok(unread.read === false && unread.commitments.every((c) => c.has === null && c.target === null && c.gaps.length === 0 && c.state === 'not-read'));
  // The service answers for its own and the shared ones; the consumer's alone are apart.
  assert.deepEqual(AGREEMENT_OWNERS, ['service', 'consumer', 'both']);
  assert.deepEqual(agreementCoverage(V([C('a', { owner: 'both' }), C('b', { owner: 'consumer' })]), chained).counts, { total: 2, service: 1, consumer: 1, covered: 0, part: 0, notCovered: 1 });
  // A weight of 1 is not written; a greater one is kept.
  assert.deepEqual(agreementRecord(V([C('a', { weight: 1 }), C('b', { weight: 5 })]), {}).versions[0].commitments.map((c) => c.weight), [undefined, 5]);
});

test('targetMatch: the target as written beside the objective — the same, approximated, looser, stricter; never changed, and not compared when it is in words', () => {
  const objective = (value, window = '30d', source = 'repository') => ({ slo: 's', value, window, source });
  assert.deepEqual(targetMatch('', objective(0.999)), { state: 'none', words: 'No target is written.' });
  assert.equal(targetMatch('acknowledged within 15 minutes', objective(0.999)).state, 'words');
  assert.deepEqual(targetMatch('99.9%', null), { state: 'no-objective', words: 'The target says 99.9%: nothing linked holds an objective to compare it with.' });
  assert.equal(targetMatch('99.9%', objective(0.99, '30d', 'guessed')).state, 'guessed');
  assert.equal(targetMatch('99.9% over 30 days', objective(0.999)).state, 'same');
  assert.equal(targetMatch('99.9%', objective(0.999)).state, 'same', 'no period written: the number alone');
  assert.equal(targetMatch('99.9 % availability', objective(0.999, '30d', 'studio')).state, 'same', 'an objective stated in the studio is a person\'s');
  assert.deepEqual(targetMatch('99.9% per calendar month, excluding planned maintenance', objective(0.999)), { state: 'approximated', words: 'The same number over another period: a calendar month in the agreement, 30 days in the repository.' });
  assert.equal(targetMatch('99.9% over 90 days', objective(0.999)).state, 'approximated');
  assert.deepEqual(targetMatch('100%', objective(0.9999)), { state: 'approximated', words: 'The target says 100%, which no objective can hold: 99.99% over 30 days approximates it.' });
  assert.deepEqual(targetMatch('99.9% monthly', objective(0.99)), { state: 'looser', words: 'The target says 99.9%; the objective asks less, 99% over 30 days.' });
  assert.equal(targetMatch('99%', objective(0.999)).state, 'stricter');
});

test('proven live, per environment: what a comparison says of each declared artefact; production proves up to 4, any other environment up to 3', () => {
  assert.deepEqual(['prod', 'production', 'PRD', 'live', 'staging', 'stg', 'dev', 'uat', ''].map(isProduction), [true, true, true, true, false, false, false, false, false]);
  assert.deepEqual(['prod', 'staging', 'dev'].map(evidenceCap), [4, 3, 3]);
  // A comparison as tools/lib/diff.mjs answers it: pairs (aligned, or with deltas), declared only, not seen; the worse of two of one name.
  const diff = { layers: {
    L1: { inBoth: [{ a: { id: 'SLO-01', title: 'checkout_99_9' }, deltas: [] }, { a: { id: 'SLI-01', title: 'checkout' }, deltas: [{ field: 'good' }] }], onlyInA: [], notObserved: [] },
    L3: { inBoth: [], onlyInA: [], notObserved: [{ side: 'a', artefact: { id: 'DASH-01', title: 'checkout-overview' }, reason: '401' }, { side: 'b', artefact: { id: 'DASH-09', title: 'theirs' } }] },
    L4: { inBoth: [{ a: { id: 'RULE-01', title: 'CheckoutErrorsHigh' }, deltas: [] }], onlyInA: [{ artefact: { id: 'POL-01', title: 'burn-rate alert: checkout_99_9', spec: { slo: 'checkout_99_9' } } }, { artefact: { id: 'RULE-02', title: 'CheckoutErrorsHigh' } }], notObserved: [] },
    L2: { inBoth: [{ a: { id: 'METRIC-FAM-01', title: 'a family' }, deltas: [] }] },
  } };
  assert.deepEqual(liveStatusOf(diff), {
    'slo:checkout_99_9': 'live', 'indicator:checkout': 'differs', 'dashboard:checkout-overview': 'unseen',
    'burn_alert:checkout_99_9': 'absent', 'alert:CheckoutErrorsHigh': 'absent',
  }, 'one of two rules of that name is not live: the worse; what only live holds, and a metric family, are no declared artefact');
  assert.deepEqual(liveStatusOf(null), {});
});

test('commitmentEvidence: proven (the environment\'s cap), in part (2), not live (0), not checked (no level); an objective is proven with its indicator and burn-rate alert', () => {
  const known = [{ kind: 'slo', name: 's', indicator: 'i', burn: ['SEV1'] }, { kind: 'slo', name: 'bare', indicator: '', burn: null }];
  const status = { 'slo:s': 'live', 'indicator:i': 'live', 'burn_alert:s': 'live', 'slo:bare': 'live', 'dashboard:d': 'live', 'alert:a': 'absent', 'metric:m': 'differs', 'dashboard:u': 'unseen', 'recording_rule:r': 'live' };
  const version = V([
    C('chain', { links: [{ kind: 'slo', name: 's' }] }),
    C('bare', { links: [{ kind: 'slo', name: 'bare' }] }),
    C('mixed', { links: [{ kind: 'dashboard', name: 'd' }, { kind: 'metric', name: 'm' }, { kind: 'alert', name: 'a' }] }),
    C('gone', { links: [{ kind: 'alert', name: 'a' }] }),
    C('unseen', { links: [{ kind: 'dashboard', name: 'd' }, { kind: 'dashboard', name: 'u' }] }),
    C('undeclared', { links: [{ kind: 'recording_rule', name: 'r' }, { kind: 'metric', name: 'nope' }] }),
    C('nowhere', { links: [{ kind: 'metric', name: 'nope' }] }),
    C('unlinked'),
    C('theirs', { owner: 'consumer', links: [{ kind: 'dashboard', name: 'd' }] }),
  ]);
  const prod = commitmentEvidence(version, known, status, { env: 'prod', checkedAt: '2026-11-19T10:00:00Z' });
  const of = (id) => prod.commitments.find((c) => c.id === id);
  assert.deepEqual([prod.env, prod.cap, prod.checkedAt], ['prod', 4, '2026-11-19T10:00:00Z']);
  assert.deepEqual([of('chain').state, of('chain').level, of('chain').why], ['proven', 4, 'Everything it is linked to runs live as declared in prod.']);
  assert.deepEqual([of('bare').state, of('bare').level], ['proven', 4], 'no indicator or burn-rate alert declared: the objective alone');
  assert.deepEqual([of('mixed').state, of('mixed').level, of('mixed').why], ['part', 2, 'In part, in prod: d runs live as declared; m runs live, not as declared; a is not live.']);
  assert.deepEqual([of('gone').state, of('gone').level, of('gone').why], ['not-live', 0, 'None of it runs live in prod: a is not there.']);
  assert.deepEqual([of('unseen').state, 'level' in of('unseen'), of('unseen').why], ['not-checked', false, 'The last check of prod could not see u.']);
  assert.deepEqual([of('undeclared').state, of('undeclared').why], ['part', 'In part, in prod: r runs live as declared; nope is not in its scan.']);
  assert.deepEqual([of('nowhere').state, of('nowhere').level, of('nowhere').why], ['not-live', 0, "Nothing it is linked to is declared in prod's scan."]);
  assert.deepEqual([of('unlinked').state, of('unlinked').why], ['not-live', 'It is linked to nothing, so nothing of it can be seen live.']);
  assert.deepEqual(prod.counts, { commitments: 8, proven: 2, part: 2, notLive: 3, notChecked: 1 }, 'the consumer\'s is shown, not counted');
  assert.equal(evidenceSummary(prod), '2 of 8 commitments proven live, 2 in part, 3 not live, 1 not checked.');
  // An objective whose burn-rate alert is not live: in part, the alert named as such.
  const half = commitmentEvidence(V([C('x', { links: [{ kind: 'slo', name: 's' }] })]), known, { ...status, 'burn_alert:s': 'absent' }, { env: 'prod' });
  assert.equal(half.commitments[0].why, 'In part, in prod: s, i run live as declared; the burn-rate alert on s is not live.');
  // Staging proves at most 3, and says so.
  const stg = commitmentEvidence(version, known, status, { env: 'staging' });
  assert.deepEqual([stg.cap, stg.commitments[0].level, stg.commitments[0].why], [3, 3, 'Everything it is linked to runs live as declared in staging (3 is the most staging can prove: 4 only with production).']);
  // No live check read: nothing has a level.
  const none = commitmentEvidence(version, known, null, { env: 'dev' });
  assert.ok(none.commitments.every((c) => c.state === 'not-checked' && !('level' in c) && c.why === 'No live check of dev has been read.'));
  assert.equal(evidenceSummary(none), 'Not checked live here yet.');
  assert.equal(evidenceSummary(commitmentEvidence(V([]), known, status, { env: 'prod' })), '');
});
