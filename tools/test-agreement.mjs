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
  assert.match(agreementErrors(V([C('a', { owner: 'someone' })]))[0], /\.owner is one of service, consumer/);
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
  assert.deepEqual(agreementCatalogue(layered), [
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
