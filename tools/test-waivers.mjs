#!/usr/bin/env node
// tools/test-waivers.mjs — waivers (GAP batch 2, B3.2): the per-item clauses' subjects
// (tools/lib/conformance.mjs clauseSubjects) and the waiver engine (tools/lib/waivers.mjs).
//
// The subjects are the seam a waiver scopes to: for every catalogue pack and every per-item
// clause, the clause passes exactly when its subject list is empty (subjects ≡ verdict), and
// the subjects of the spec's own example are the measured lists. Pure modules under node:test;
// paths through fileURLToPath, nothing platform-specific.
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
