#!/usr/bin/env node
// tools/test-waivers.mjs — waivers (GAP batch 2, B3.2): the per-item clauses' subjects
// (tools/lib/conformance.mjs clauseSubjects) and the waiver engine (tools/lib/waivers.mjs).
//
// The subjects are the seam a waiver scopes to: for every catalogue pack and every per-item
// clause, the clause passes exactly when its subject list is empty (subjects ≡ verdict), and
// the subjects of the spec's own example are the measured lists. The engine: the waiver object
// and its refusals, the computed states, the findings seam (scoped beats pack-level, newest
// wins, expired surfaces, revoked is history), the conformance overlay — the SAME report object
// without an open waiver (the inert proof), the engine's numbers untouched and `effective`
// beside them with one — and the sidecar file. Pure modules under node:test; paths through
// fileURLToPath, nothing platform-specific. The Conformance view (studio/conformance-view.mjs) is
// rendered headless over a document stub: a bare report renders byte for byte what it did before
// waivers existed (tools/fixtures/golden/conformance-view/payment-service.bare.html, captured at
// the commit before the view learned of them), a report with a waivers block gains the Waived
// group, measure and caveats with every operator text escaped.
//
// Run: node --test tools/test-waivers.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUBRIC, SUBJECT_CLAUSES, clauseSubjects, evaluateConformance } from './lib/conformance.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import {
  CLAUSE_WAIVER_STATUSES, FINDING_STATUSES, MAX_REASON, MAX_TEXT, WAIVER_FILE_VERSION, WAIVER_STATES,
  applyWaiversToConformance, applyWaiversToFindings, expiresInDays, matchesFinding, normalizeWaiver, oneLine, readWaiverFile, waiverState, waiverView,
} from './lib/waivers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(ROOT, ...p.split('/'));
const read = (p) => readFileSync(rel(p), 'utf8');
const loadPack = (p) => (p.endsWith('.json') ? JSON.parse(read(p)) : parseYaml(read(p)));
const clone = (x) => JSON.parse(JSON.stringify(x));

const PAYMENT_PATH = `${SPEC_SCHEMA_PATH.replace(/\/[^/]+$/, '')}/examples/payment-service.pack.yaml`;
const CATALOGUE = [
  PAYMENT_PATH, 'examples/demo-skeleton.pack.yaml', 'examples/production-curated.pack.yaml', 'examples/target-advanced.pack.yaml',
  'examples/krystaline-repo-carlos.pack.yaml',
  ...readdirSync(rel('reference-packs')).filter(f => f.endsWith('.pack.yaml')).sort().map(f => `reference-packs/${f}`),
];
const payment = () => loadPack(PAYMENT_PATH);

// ---------- 1. the per-item clauses and their subjects ----------

test('SUBJECT_CLAUSES names four MUST clauses of the rubric; clauseSubjects answers null for every other clause and for an unknown id', () => {
  assert.deepEqual([...SUBJECT_CLAUSES], ['L1.MUST.sli_covered_by_slo', 'L3.MUST.recording_rule_per_slo', 'L4.MUST.multi_window_burn_rate', 'L5.MUST.tier1_chaos_for_each_slo']);
  for (const id of SUBJECT_CLAUSES) {
    const clause = RUBRIC.find(c => c.id === id);
    assert.ok(clause && clause.severity === 'MUST', `${id} is a MUST clause of the rubric`);
  }
  for (const c of RUBRIC) {
    if (SUBJECT_CLAUSES.includes(c.id)) continue;
    assert.equal(clauseSubjects(c.id, payment()), null, `${c.id} grades the whole pack`);
  }
  assert.equal(clauseSubjects('nope', payment()), null);
  assert.deepEqual(clauseSubjects('L1.MUST.sli_covered_by_slo', {}), [], 'an empty pack has no uncovered SLI');
});

test('subjects ≡ verdict over the catalogue: for every pack and per-item clause, the clause passes exactly when its subject list is empty; every subject is a symbol of the pack, in declaration order', () => {
  let failing = 0;
  for (const p of CATALOGUE) {
    const pack = loadPack(p);
    const before = clone(pack);
    const report = evaluateConformance(pack);
    for (const id of SUBJECT_CLAUSES) {
      const subjects = clauseSubjects(id, pack);
      assert.ok(Array.isArray(subjects), `${p} ${id}: a list`);
      const clause = report.clauses.find(c => c.id === id);
      // The verdict is graded only where the clause applies; the subjects say the same of every tier.
      const pass = RUBRIC.find(c => c.id === id).evaluate(pack);
      assert.equal(pass, subjects.length === 0, `${p} ${id}: passes ⇔ no subject (${subjects.join(', ')})`);
      if (clause.applies) assert.equal(clause.pass, subjects.length === 0, `${p} ${id}: the graded verdict agrees`);
      if (subjects.length) failing++;
      const family = id.startsWith('L1.') ? 'slis' : 'slos';
      const declared = (pack.spec?.[family] || []).map(x => `${family}.${x.id}`);
      assert.deepEqual(subjects, declared.filter(s => subjects.includes(s)), `${p} ${id}: subjects in declaration order, each a declared ${family} symbol`);
      assert.deepEqual(new Set(subjects).size, subjects.length, `${p} ${id}: no subject twice`);
    }
    assert.deepEqual(pack, before, `${p}: the pack is not mutated`);
  }
  assert.ok(failing > 0, 'the catalogue has failing per-item clauses to scope a waiver to');
});

test('the measured subjects of the spec\'s payment-service example: L3 names consumer_success_99_95 only, L4 api_latency_99_p99_500ms only, L5 chaos three SLOs, L1 none', () => {
  const pack = payment();
  assert.deepEqual(clauseSubjects('L1.MUST.sli_covered_by_slo', pack), []);
  assert.deepEqual(clauseSubjects('L3.MUST.recording_rule_per_slo', pack), ['slos.consumer_success_99_95']);
  assert.deepEqual(clauseSubjects('L4.MUST.multi_window_burn_rate', pack), ['slos.api_latency_99_p99_500ms']);
  assert.deepEqual(clauseSubjects('L5.MUST.tier1_chaos_for_each_slo', pack), ['slos.api_latency_99_p99_500ms', 'slos.settlement_consumers_99_9_min_2', 'slos.consumer_success_99_95']);
  const report = evaluateConformance(pack);
  assert.deepEqual([report.must.passed, report.must.total, report.scorePercent, report.mustPercent, report.conformant], [21, 25, 85, 84, false]);
  // Edits move the subjects as the clause moves: an SLI without an SLO, a recording rule by name, every SLO stressed.
  const a = clone(pack); a.spec.slis.push({ id: 'orphan_sli', type: 'ratio', good: 'x', total: 'y', description: 'orphan' });
  assert.deepEqual(clauseSubjects('L1.MUST.sli_covered_by_slo', a), ['slis.orphan_sli']);
  assert.equal(RUBRIC.find(c => c.id === 'L1.MUST.sli_covered_by_slo').evaluate(a), false);
  const b = clone(pack); b.spec.queries.recording_rules.push({ name: 'payment:consumer_success_99_95:ratio', expr: 'vector(1)' });
  assert.deepEqual(clauseSubjects('L3.MUST.recording_rule_per_slo', b), [], 'a rule named after the SLO covers it');
  const c = clone(pack); c.spec.queries.recording_rules = [];
  assert.equal(clauseSubjects('L3.MUST.recording_rule_per_slo', c).length, pack.spec.slos.length, 'no rules at all: every SLO is a subject');
  const d = clone(pack); d.spec.slos = [];
  assert.deepEqual(clauseSubjects('L3.MUST.recording_rule_per_slo', { ...d, spec: { ...d.spec, queries: { recording_rules: [] } } }), [], 'no rules and no SLOs: the clause passes (the evaluator\'s rule)');
  const e = clone(pack);
  for (const s of e.spec.slos) e.spec.validation.chaos_experiments.push({ id: `chaos-${s.id}`, target: 't', fault: 'f', steady_state_hypothesis: `ref:slos.${s.id}`, schedule: 'weekly', environment: 'staging' });
  assert.deepEqual(clauseSubjects('L5.MUST.tier1_chaos_for_each_slo', e), [], 'a ref:slos.<id> hypothesis counts, as the evaluator strips it');
});

// ---------- 2. the waiver object and its states ----------

const NOW = '2026-10-05T12:00:00.000Z';
const IN_30D = '2026-11-04T12:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';
const base = (over = {}) => ({ ruleId: 'L5.MUST.tier1_chaos_for_each_slo', reason: 'chaos day is scheduled for Q1', expiresAt: IN_30D, author: 'oscar', createdAt: NOW, ...over });

test('normalizeWaiver: the shape, the defaults (id and createdAt null, artefactId null), the times normalised, unknown keys dropped; every refusal names the field and control characters are refused everywhere', () => {
  const w = normalizeWaiver({ ...base(), expiresAt: '2026-11-04T12:00:00Z', serviceId: 7, state: 'active', extra: 1 });
  assert.deepEqual(w, { id: null, artefactId: null, ruleId: 'L5.MUST.tier1_chaos_for_each_slo', reason: 'chaos day is scheduled for Q1', expiresAt: IN_30D, author: 'oscar', createdAt: NOW, revokedAt: null, revokedBy: null, revokeReason: null });
  assert.deepEqual(Object.keys(normalizeWaiver(base({ id: 3, artefactId: 'slos.x', revokedAt: PAST, revokedBy: 'ada', revokeReason: 'done' }))), ['id', 'artefactId', 'ruleId', 'reason', 'expiresAt', 'author', 'createdAt', 'revokedAt', 'revokedBy', 'revokeReason']);
  assert.equal(normalizeWaiver(base({ createdAt: undefined })).createdAt, null);
  const refuses = (raw, re) => assert.throws(() => normalizeWaiver(raw), re);
  refuses(null, /^Error: waiver: a waiver is an object$/);
  refuses([], /a waiver is an object/);
  refuses(base({ ruleId: '' }), /waiver: ruleId is a clause id/);
  refuses(base({ ruleId: 'L1 MUST' }), /ruleId is a clause id/);
  refuses(base({ artefactId: 'slos.x y' }), /artefactId is a canonical symbol/);
  refuses(base({ artefactId: 7 }), /artefactId is a canonical symbol/);
  refuses(base({ reason: '' }), /^Error: waiver: a reason is one line of 1–2000 characters$/);
  refuses(base({ reason: 'x'.repeat(2001) }), /a reason is one line/);
  refuses(base({ reason: 'two\nlines' }), /a reason is one line/);
  refuses(base({ author: 'o\u0007' }), /author is one line of 1–200 characters/);
  refuses(base({ ruleId: 'L1.MUST.x\u001f' }), /ruleId is a clause id/);
  refuses(base({ artefactId: 'slos.\u007f' }), /artefactId is a canonical symbol/);
  refuses(base({ expiresAt: 'tomorrow' }), /expiresAt is an ISO time \(toISOString\(\)\), not "tomorrow"/);
  refuses(base({ expiresAt: undefined }), /expiresAt is an ISO time/);
  refuses(base({ createdAt: 12 }), /createdAt is an ISO time/);
  refuses(base({ revokedAt: PAST }), /a revoked waiver names who revoked it/);
  refuses(base({ revokedAt: PAST, revokedBy: 'ada', revokeReason: 'a\nb' }), /a revoke reason is one line/);
  assert.equal(normalizeWaiver(base({ reason: 'x'.repeat(2000) })).reason.length, 2000);
  assert.equal(normalizeWaiver(base({ id: 'w-1' })).id, 'w-1');
  assert.equal(normalizeWaiver(base({ id: {} })).id, null);
  assert.deepEqual([oneLine('ok', 2), oneLine('', 2), oneLine('abc', 2), oneLine('a\tb', 5), oneLine('a\u007fb', 5), oneLine(7, 5), oneLine('é', 1)], [true, false, false, false, false, false, true]);
});

test('waiverState, expiresInDays and waiverView: active until the expiry, expired at and after it, revoked whenever revokedAt is set; `now` defaults to the clock', () => {
  const w = normalizeWaiver(base());
  assert.equal(waiverState(w, NOW), 'active');
  assert.equal(waiverState(w, '2026-11-04T11:59:59.999Z'), 'active');
  assert.equal(waiverState(w, IN_30D), 'expired');
  assert.equal(waiverState(w, '2026-11-04T12:00:00Z'), 'expired', 'a `now` without milliseconds is read as a time, not compared as text');
  assert.equal(waiverState(normalizeWaiver(base({ revokedAt: PAST, revokedBy: 'ada' })), NOW), 'revoked');
  assert.equal(expiresInDays(w, NOW), 30);
  assert.equal(expiresInDays(w, '2026-11-04T11:00:00.000Z'), 1);
  assert.equal(expiresInDays(w, '2026-11-05T12:00:00.000Z'), -1);
  assert.deepEqual(waiverView(w, NOW), { ...w, state: 'active', expiresInDays: 30 });
  assert.ok(['active', 'expired'].includes(waiverState(w)), 'the clock decides when now is omitted');
  assert.deepEqual([...WAIVER_STATES], ['active', 'expired', 'revoked']);
  assert.deepEqual([...FINDING_STATUSES], ['failing', 'waived', 'expired']);
  assert.deepEqual([...CLAUSE_WAIVER_STATUSES], ['waived', 'partial', 'expired']);
  assert.deepEqual([MAX_REASON, MAX_TEXT, WAIVER_FILE_VERSION], [2000, 200, 1]);
});

// ---------- 3. the findings seam ----------

test('applyWaiversToFindings: a pack-level waiver covers every subject of its clause, a scoped one its subject alone and beats the pack-level one, the newest among equals wins; a revoked waiver matches nothing, an expired one marks the finding expired; unused waivers are listed', () => {
  const findings = [
    { ruleId: 'L5.MUST.tier1_chaos_for_each_slo', subject: 'slos.a' }, { ruleId: 'L5.MUST.tier1_chaos_for_each_slo', subject: 'slos.b' },
    { ruleId: 'L3.MUST.recording_rule_per_slo', subject: 'slos.a' }, { ruleId: 'L2.MUST.tail_sampling' },
    { ruleId: 'placeholder.slos.objective', subject: 'slos.b' },
  ];
  const pack = normalizeWaiver(base({ id: 1, reason: 'pack-level', createdAt: '2026-10-01T00:00:00.000Z' }));
  const scoped = normalizeWaiver(base({ id: 2, artefactId: 'slos.a', reason: 'scoped', createdAt: '2026-09-01T00:00:00.000Z' }));
  const revoked = normalizeWaiver(base({ id: 3, ruleId: 'L3.MUST.recording_rule_per_slo', reason: 'revoked', revokedAt: NOW, revokedBy: 'ada' }));
  const expired = normalizeWaiver(base({ id: 4, ruleId: 'L3.MUST.recording_rule_per_slo', artefactId: 'slos.a', reason: 'lapsed', expiresAt: PAST }));
  const other = normalizeWaiver(base({ id: 5, ruleId: 'L1.MUST.availability_slo', reason: 'matches nothing' }));
  const row = normalizeWaiver(base({ id: 6, ruleId: 'placeholder.slos.objective', artefactId: 'slos.b', reason: 'the objective is agreed, not yet written' }));
  const r = applyWaiversToFindings(findings, [pack, scoped, revoked, expired, other, row], { now: NOW });
  assert.deepEqual(r.findings.map(f => [f.subject ?? null, f.status, f.waiver?.id ?? null]), [
    ['slos.a', 'waived', 2], ['slos.b', 'waived', 1], ['slos.a', 'expired', 4], [null, 'failing', null], ['slos.b', 'waived', 6],
  ], 'scoped beats pack-level on slos.a; the pack-level covers slos.b; the L3 waiver has lapsed; the L2 finding has no waiver');
  assert.deepEqual(r.counts, { failing: 1, waived: 3, expired: 1, unused: 1 });
  assert.deepEqual(r.unused.map(w => [w.id, w.state]), [[5, 'active']], 'the revoked waiver is neither used nor unused: it is history');
  assert.deepEqual(Object.keys(r.findings[0].waiver), ['id', 'artefactId', 'ruleId', 'reason', 'expiresAt', 'author', 'createdAt', 'revokedAt', 'revokedBy', 'revokeReason', 'state', 'expiresInDays']);
  assert.deepEqual(r.findings[2].waiver.state, 'expired');
  // Among equals the newest wins; an active waiver beats an expired one whatever its scope.
  const older = normalizeWaiver(base({ id: 7, reason: 'older', createdAt: '2026-01-01T00:00:00.000Z' }));
  const newer = normalizeWaiver(base({ id: 8, reason: 'newer', createdAt: '2026-06-01T00:00:00.000Z' }));
  const lapsedScoped = normalizeWaiver(base({ id: 9, artefactId: 'slos.a', expiresAt: PAST }));
  const t = applyWaiversToFindings([findings[0]], [older, newer, lapsedScoped], { now: NOW });
  assert.deepEqual([t.findings[0].status, t.findings[0].waiver.id, t.counts.unused], ['waived', 8, 0]);
  // Two undated entries: the later entry of the list wins.
  const u = applyWaiversToFindings([findings[0]], [normalizeWaiver(base({ id: 'a', createdAt: null })), normalizeWaiver(base({ id: 'b', createdAt: null }))], { now: NOW });
  assert.equal(u.findings[0].waiver.id, 'b');
  assert.deepEqual(applyWaiversToFindings([], [pack], { now: NOW }), { findings: [], counts: { failing: 0, waived: 0, expired: 0, unused: 1 }, unused: [waiverView(pack, NOW)] });
  assert.deepEqual(applyWaiversToFindings(findings.slice(3, 4), [], { now: NOW }).findings, [{ ruleId: 'L2.MUST.tail_sampling', status: 'failing', waiver: null }]);
  assert.equal(matchesFinding(scoped, { ruleId: scoped.ruleId }), false, 'a scoped waiver never covers a whole-pack finding');
  assert.equal(matchesFinding(pack, { ruleId: pack.ruleId }), true);
});

// ---------- 4. the conformance overlay ----------

test('applyWaiversToConformance is inert: with no waivers, [] or revoked-only waivers the SAME report object comes back; with an open waiver the engine\'s numbers are untouched and `waivers` is added', () => {
  const pack = payment();
  const report = evaluateConformance(pack);
  const frozen = clone(report);
  assert.equal(applyWaiversToConformance(report, [], { now: NOW, canonical: pack }), report);
  assert.equal(applyWaiversToConformance(report, undefined, { now: NOW, canonical: pack }), report);
  assert.equal(applyWaiversToConformance(report, null, { now: NOW, canonical: pack }), report);
  const revoked = normalizeWaiver(base({ revokedAt: NOW, revokedBy: 'ada' }));
  assert.equal(applyWaiversToConformance(report, [revoked], { now: NOW, canonical: pack }), report, 'a revoked waiver is history: the same object');
  const applied = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 1 }))], { now: NOW, canonical: pack });
  assert.notEqual(applied, report);
  assert.deepEqual(report, frozen, 'the input report is not mutated');
  const { waivers, ...rest } = applied;
  assert.deepEqual(rest, frozen, 'every engine field is as it was; `waivers` is the one addition');
  assert.deepEqual(Object.keys(waivers), ['counts', 'clauses', 'effective', 'unused']);
  assert.deepEqual(Object.keys(waivers.effective), ['conformant', 'scorePercent', 'mustPercent', 'must', 'should', 'byDimension']);
});

test('the overlay on payment-service: a pack-level L5 waiver waives the clause (three subjects covered); one scoped waiver is `partial` (remaining named) and three scoped ones `waived`; effective recomputes MUST, score, conformant and byDimension; an L3 waiver on the SLO that passes L3 is unused; an expired one is `expired`', () => {
  const pack = payment();
  const report = evaluateConformance(pack);
  const L5 = 'L5.MUST.tier1_chaos_for_each_slo';
  const L3 = 'L3.MUST.recording_rule_per_slo';
  const three = ['slos.api_latency_99_p99_500ms', 'slos.settlement_consumers_99_9_min_2', 'slos.consumer_success_99_95'];
  // Pack-level.
  const whole = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 1 }))], { now: NOW, canonical: pack });
  assert.deepEqual(Object.keys(whole.waivers.clauses), [L5]);
  assert.deepEqual(whole.waivers.clauses[L5].status, 'waived');
  assert.deepEqual(whole.waivers.clauses[L5].subjects, { failing: three, waived: three, remaining: [] });
  assert.deepEqual(whole.waivers.clauses[L5].waivers.map(w => [w.id, w.state]), [[1, 'active']]);
  assert.deepEqual(whole.waivers.counts, { failing: 3, waived: 3, expired: 0, unused: 0 }, 'L3 one subject, L4 one subject and the whole-pack weekly-chaos clause failing; the three L5 subjects waived');
  assert.deepEqual([whole.must, whole.waivers.effective.must], [{ passed: 21, total: 25 }, { passed: 22, total: 25 }]);
  assert.deepEqual([whole.waivers.effective.scorePercent, whole.waivers.effective.mustPercent, whole.waivers.effective.conformant], [89, 88, false]);
  assert.deepEqual(whole.waivers.effective.byDimension.L5, { ...report.byDimension.L5, mustPassed: report.byDimension.L5.mustPassed + 1 });
  assert.deepEqual(Object.keys(whole.waivers.effective.byDimension), Object.keys(report.byDimension), 'the per-layer grid keeps its shape');
  for (const d of Object.keys(report.byDimension)) assert.deepEqual(Object.keys(whole.waivers.effective.byDimension[d]), ['applicable', 'mustPassed', 'mustTotal', 'shouldPassed', 'shouldTotal']);
  // One scoped waiver: partial; the remaining subjects named; the clause still fails in `effective`.
  const one = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 2, artefactId: three[0] }))], { now: NOW, canonical: pack });
  assert.equal(one.waivers.clauses[L5].status, 'partial');
  assert.deepEqual(one.waivers.clauses[L5].subjects, { failing: three, waived: [three[0]], remaining: three.slice(1) });
  assert.deepEqual([one.waivers.effective.must.passed, one.waivers.counts.waived, one.waivers.counts.failing], [21, 1, 5]);
  // Three scoped waivers: waived, three waivers quoted once each.
  const all = applyWaiversToConformance(report, three.map((s, i) => normalizeWaiver(base({ id: 10 + i, artefactId: s }))), { now: NOW, canonical: pack });
  assert.equal(all.waivers.clauses[L5].status, 'waived');
  assert.deepEqual(all.waivers.clauses[L5].waivers.map(w => w.id), [10, 11, 12]);
  assert.equal(all.waivers.effective.must.passed, 22);
  // The whole pack waived: effective conformant, the engine still says no.
  const failing = report.clauses.filter(c => c.applies && !c.pass).map(c => c.id);
  assert.deepEqual(failing, [L3, 'L4.MUST.multi_window_burn_rate', L5, 'L5.MUST.tier1_weekly_prod_chaos']);
  const every = applyWaiversToConformance(report, failing.map((id, i) => normalizeWaiver(base({ id: 20 + i, ruleId: id }))), { now: NOW, canonical: pack });
  assert.deepEqual([every.conformant, every.waivers.effective.conformant, every.waivers.effective.must.passed, every.waivers.effective.scorePercent], [false, true, 25, 100]);
  assert.equal(every.waivers.clauses['L5.MUST.tier1_weekly_prod_chaos'].subjects, null, 'a whole-pack clause has no subjects');
  // An L3 waiver scoped to the SLO that passes L3 covers no finding: unused, no clause entry.
  const unused = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 30, ruleId: L3, artefactId: 'slos.api_latency_99_p99_500ms' }))], { now: NOW, canonical: pack });
  assert.deepEqual([Object.keys(unused.waivers.clauses), unused.waivers.unused.map(w => w.id), unused.waivers.counts.unused], [[], [30], 1]);
  assert.deepEqual(unused.waivers.effective.must, report.must);
  // Expired: the clause fails again, the lapsed waiver surfaced on it.
  const lapsed = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 40, expiresAt: PAST }))], { now: NOW, canonical: pack });
  assert.deepEqual([lapsed.waivers.clauses[L5].status, lapsed.waivers.clauses[L5].waivers[0].state, lapsed.waivers.effective.must.passed, lapsed.waivers.counts.expired], ['expired', 'expired', 21, 3]);
  // A waiver on a clause that passes, or that does not apply, is unused — nothing is ever un-passed.
  const passes = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 50, ruleId: 'L1.MUST.availability_slo' }))], { now: NOW, canonical: pack });
  assert.deepEqual([Object.keys(passes.waivers.clauses), passes.waivers.unused.length], [[], 1]);
  // Without a canonical every failing clause is one whole-pack finding; a scoped waiver then covers nothing.
  const bare = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 60 })), normalizeWaiver(base({ id: 61, ruleId: L3, artefactId: 'slos.consumer_success_99_95' }))], { now: NOW });
  assert.deepEqual([bare.waivers.clauses[L5].status, bare.waivers.clauses[L5].subjects, bare.waivers.unused.map(w => w.id)], ['waived', null, [61]]);
  // An injected subjectsOf.
  const injected = applyWaiversToConformance(report, [normalizeWaiver(base({ id: 70, artefactId: 'slos.only' }))], { now: NOW, canonical: pack, subjectsOf: () => ['slos.only'] });
  assert.equal(injected.waivers.clauses[L5].status, 'waived');
  // Deterministic and pure.
  assert.deepEqual(applyWaiversToConformance(report, [normalizeWaiver(base({ id: 1 }))], { now: NOW, canonical: pack }), whole);
  assert.deepEqual(evaluateConformance(pack), report);
});

// ---------- 5. the sidecar file ----------

test('readWaiverFile: { version: 1, waivers: [...] } → normalized waivers with their states counted; every refusal names the entry', () => {
  const doc = { version: 1, waivers: [base({ id: 1 }), base({ id: 2, expiresAt: PAST }), base({ id: 3, revokedAt: NOW, revokedBy: 'ada' })] };
  const r = readWaiverFile(doc, { now: NOW });
  assert.deepEqual([r.version, r.waivers.length, r.counts], [1, 3, { active: 1, expired: 1, revoked: 1 }]);
  assert.deepEqual(r.waivers[0], normalizeWaiver(base({ id: 1 })));
  assert.deepEqual(readWaiverFile({ version: 1, waivers: [] }, { now: NOW }), { version: 1, waivers: [], counts: { active: 0, expired: 0, revoked: 0 } });
  assert.throws(() => readWaiverFile(null), /^Error: waiver file: the document is an object \{ version: 1, waivers: \[\.\.\.\] \}$/);
  assert.throws(() => readWaiverFile([]), /the document is an object/);
  assert.throws(() => readWaiverFile({ waivers: [] }), /^Error: waiver file: version must be 1, not undefined$/);
  assert.throws(() => readWaiverFile({ version: 2, waivers: [] }), /version must be 1, not 2/);
  assert.throws(() => readWaiverFile({ version: 1 }), /^Error: waiver file: waivers must be an array$/);
  assert.throws(() => readWaiverFile({ version: 1, waivers: [base(), { ruleId: 'x' }] }), /^Error: waiver file: waivers\[1\]: a reason is one line of 1–2000 characters$/);
  assert.throws(() => readWaiverFile({ version: 1, waivers: [base({ expiresAt: 'soon' })] }), /waivers\[0\]: expiresAt is an ISO time/);
});

// ---------- 6. purity and listing ----------

test('tools/lib/waivers.mjs is browser-safe (imports ./conformance.mjs only, no node:*, no process, no DOM) and a listed module; the subjects it reads are conformance.mjs\'s own', () => {
  const src = read('tools/lib/waivers.mjs');
  assert.deepEqual([...src.matchAll(/^import .* from '([^']+)';$/gm)].map(m => m[1]), ['./conformance.mjs']);
  assert.ok(!/\bprocess\.|node:|\bdocument\.|\bwindow\.|import\.meta/.test(src.replace(/\/\/.*$/gm, '')), 'no node, process, DOM or import.meta reference');
  const manifest = JSON.parse(read('VENDOR-MANIFEST.json'));
  assert.ok(manifest.modules['tools/lib/waivers.mjs'], 'listed in VENDOR-MANIFEST.json');
  assert.deepEqual(manifest.modules['tools/lib/waivers.mjs'].imports, ['tools/lib/conformance.mjs']);
  assert.ok(read('docs/CHANGELOG.md').includes('`tools/lib/waivers.mjs`'), 'the CHANGELOG names the new module');
});

// ---------- 7. the Conformance view, headless ----------

// The DOM the view needs: createElement → an element with className, dataset, innerHTML and the
// query/listener methods wireUxActions and wireSectionNav call (each answering "nothing here").
const stubElement = () => ({ className: '', dataset: {}, innerHTML: '', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; } });
async function renderHeadless(conformance) {
  globalThis.document = { createElement: stubElement };
  try {
    const { state } = await import('../studio/state.mjs');
    const { renderConformanceView } = await import('../studio/conformance-view.mjs');
    state.pack = adapt(payment());
    state.conformance = conformance;
    const wrap = renderConformanceView();
    return `${wrap.className}|${JSON.stringify(wrap.dataset)}\n${wrap.innerHTML}`;
  } finally {
    delete globalThis.document;
  }
}
const bareReport = () => {
  const report = evaluateConformance(payment());
  return { environment: null, ...report, tier: { graded: report.declaredTier, pack: report.declaredTier, from: 'pack', service: null, environment: null, mismatch: false } };
};
const FIXTURE = 'tools/fixtures/golden/conformance-view/payment-service.bare.html';

test('the Conformance view over a bare report renders byte for byte what it rendered before waivers existed (the committed capture); readConformance defaults waived [], effective null, waiverCounts null, expiringSoon 0 and names no waiver', async () => {
  const { readConformance } = await import('../studio/conformance-view.mjs');
  const c = bareReport();
  const model = readConformance(c, adapt(payment()));
  assert.deepEqual([model.waived, model.effective, model.waiverCounts, model.expiringSoon, model.unused, model.groups.waived], [[], null, null, 0, [], []]);
  assert.ok(model.groups.blocking.every(r => r.waiver === null));
  const html = await renderHeadless(c);
  assert.equal(html, read(FIXTURE), 'the bare render is the capture, byte for byte');
  assert.ok(!/conf-waived|Waived|waiver/i.test(html), 'no waiver word on a bare report');
  // The gate is the object: an array or a string in `waivers` is not a block.
  assert.equal(await renderHeadless({ ...c, waivers: [] }), html);
  assert.equal(await renderHeadless({ ...c, waivers: 'yes' }), html);
});

test('the Conformance view over a report with a waivers block: the waived clause leaves Blocking for the Waived group (nav item, measure, scoring bullet), a partial clause stays blocking with its caveat and remaining subjects, an expired one says so; every reason, author and symbol is escaped', async () => {
  const { readConformance, CLAUSE_FIX } = await import('../studio/conformance-view.mjs');
  const pack = payment();
  const c = bareReport();
  const L5 = 'L5.MUST.tier1_chaos_for_each_slo';
  const L3 = 'L3.MUST.recording_rule_per_slo';
  const L4 = 'L4.MUST.multi_window_burn_rate';
  const hostile = '<img src=x onerror=alert(1)> & "quotes"';
  const waivers = [
    normalizeWaiver(base({ id: 1, reason: hostile, author: 'o<b>scar</b>' })),
    normalizeWaiver(base({ id: 2, ruleId: L4, artefactId: 'slos.api_latency_99_p99_500ms', expiresAt: '2026-10-15T12:00:00.000Z' })),
    normalizeWaiver(base({ id: 3, ruleId: L3, artefactId: 'slos.consumer_success_99_95', expiresAt: PAST })),
  ];
  const applied = applyWaiversToConformance(c, waivers, { now: NOW, canonical: pack });
  // Make the L4 one partial: pretend a second subject remains.
  applied.waivers.clauses[L4].status = 'partial';
  applied.waivers.clauses[L4].subjects = { failing: ['slos.api_latency_99_p99_500ms', 'slos.<other>'], waived: ['slos.api_latency_99_p99_500ms'], remaining: ['slos.<other>'] };
  const model = readConformance(applied, adapt(pack));
  assert.deepEqual(model.groups.waived.map(r => r.id), [L5]);
  assert.deepEqual(model.groups.blocking.map(r => [r.id, r.waiver?.status ?? null]), [[L3, 'expired'], [L4, 'partial'], ['L5.MUST.tier1_weekly_prod_chaos', null]]);
  assert.deepEqual([model.waived.length, model.effective.must.passed, model.waiverCounts.waived, model.expiringSoon], [1, 23, 4, 2], 'one clause shown waived (the engine read L4 as waived too before the test pretended it partial: effective 23); the L5 and L4 waivers lapse within 30 days');
  const html = await renderHeadless(applied);
  assert.notEqual(html, read(FIXTURE));
  assert.ok(html.includes('id="conf-waived"') && html.includes('data-ux-section="conf-waived"'), 'the group and its nav item');
  assert.match(html, /<dt>Waived<\/dt>\s*<dd><span class="ux-measure-val">1<\/span><span class="ux-measure-note">effective 23 \/ 25 MUST · 2 waivers expiring within 30 days<\/span>/);
  assert.ok(html.includes(`data-group="waived" data-dim="L5"`) && html.includes(escapeHtmlLike(CLAUSE_FIX[L5].reason)), 'the L5 row in the waived group');
  assert.ok(!html.includes(hostile) && html.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;'), 'the reason is escaped');
  assert.ok(!html.includes('o<b>scar</b>') && html.includes('o&lt;b&gt;scar&lt;/b&gt;'), 'the author is escaped');
  assert.ok(html.includes('Partially waived') && html.includes('<code>slos.&lt;other&gt;</code>'), 'the partial caveat names the remaining subject, escaped');
  assert.ok(html.includes('Waiver expired') && html.includes('Lapsed:'), 'the expired caveat and its lapsed waiver line');
  assert.ok(html.includes('<strong>Waivers</strong> suppress a finding for a time') && html.includes('required 23 of 25'), 'the scoring bullet with the effective numbers');
  assert.match(html, /Not conformant at tier 1: three required clauses need attention\. 1 further required clause is waived for a time\./, 'the headline stays the rubric\'s');
  assert.ok(html.includes('Covered:') && html.includes('<code>slos.settlement_consumers_99_9_min_2</code>'), 'the covered subjects');
  // An overlay with nothing waived (every waiver unused): the measure reads 0, no Waived group, no nav item —
  // and the unused waivers are named (the API lists them active; the CLI prints "n waiver(s) match no failing
  // clause"): a group of their own with a nav item, each with its clause, symbol, author, expiry and reason,
  // escaped, and the count on the Waived measure.
  const none = applyWaiversToConformance(c, [
    normalizeWaiver(base({ id: 9, ruleId: 'L1.MUST.availability_slo', reason: hostile })),
    normalizeWaiver(base({ id: 10, ruleId: L4, artefactId: 'slos.nope_not_in_pack', reason: 'a typo, or a renamed SLO' })),
  ], { now: NOW, canonical: pack });
  const m2 = readConformance(none, adapt(pack));
  assert.deepEqual([m2.groups.waived, m2.waiverCounts.unused, m2.unused.map(w => [w.id, w.ruleId, w.artefactId, w.state])], [[], 2, [[9, 'L1.MUST.availability_slo', null, 'active'], [10, L4, 'slos.nope_not_in_pack', 'active']]]);
  const h2 = await renderHeadless(none);
  assert.ok(h2.includes('<dt>Waived</dt>') && h2.includes('<span class="ux-measure-val">0</span>') && !h2.includes('id="conf-waived"') && !h2.includes('data-ux-section="conf-waived"'));
  assert.match(h2, /<dt>Waived<\/dt>\s*<dd><span class="ux-measure-val">0<\/span><span class="ux-measure-note">effective 21 \/ 25 MUST · 2 waivers match nothing<\/span>/);
  assert.ok(h2.includes('id="conf-unused"') && h2.includes('data-ux-section="conf-unused"') && h2.includes('Waivers that match nothing <span class="conf-group-count">2</span>'), 'the group and its nav item');
  assert.ok(h2.includes('2 active waivers name nothing that fails here') && h2.includes('revoked or recorded again'), 'the note says why and names the way out');
  assert.ok(h2.includes(`<code>${L4}</code><p class="conf-row-waiver"><span class="conf-row-fix-key">Waiver:</span> <span>by oscar on <code>slos.nope_not_in_pack</code> until 2026-11-04 (in 30 days) — a typo, or a renamed SLO</span></p>`), 'the symbol that is not in the pack, named');
  assert.ok(h2.includes('<code>L1.MUST.availability_slo</code><p class="conf-row-waiver">') && !h2.includes(hostile) && h2.includes('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;'), 'the pack-level one, its reason escaped');
  // One unused waiver beside a waived clause: the group sits under Waived, the measure counts both.
  const h3 = await renderHeadless(applyWaiversToConformance(c, [normalizeWaiver(base({ id: 1 })), normalizeWaiver(base({ id: 10, ruleId: L4, artefactId: 'slos.nope_not_in_pack' }))], { now: NOW, canonical: pack }));
  assert.ok(h3.indexOf('id="conf-waived"') < h3.indexOf('id="conf-unused"') && h3.includes('1 waiver matches nothing</span>') && h3.includes('1 active waiver names nothing'));
  // ux-kit: the assessment vocabulary gained `waived` and nothing else moved.
  const { STATUS_PROPERTIES } = await import('../studio/ux-kit.mjs');
  assert.deepEqual(Object.keys(STATUS_PROPERTIES.assessment.values), ['pass', 'placeholder', 'waived', 'warning', 'fail', 'notEvaluated', 'notApplicable']);
  assert.equal(STATUS_PROPERTIES.assessment.values.waived.tone, 'info');
});

const escapeHtmlLike = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
