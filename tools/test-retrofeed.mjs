#!/usr/bin/env node
/**
 * tools/test-retrofeed.mjs
 *
 * Unit test for the repo retrofeed (tools/lib/retrofeed.mjs) — the reverse
 * remediation arrow. Exercises: dependency-ordered adoption (SLI→SLO→burn
 * rate), referential guards, dedup against existing declarations, honest
 * skips for non-declarable families, provenance annotations, input
 * immutability — and the law inherited from the crawler incident: the
 * updated pack must validate against the schema, proven end-to-end with
 * REAL packs (payment-service vs production-curated diff). Exit 0 = pass.
 */

import { readFileSync } from 'node:fs';
import { retrofeedShadowSignals } from './lib/retrofeed.mjs';
import { validateCanonical } from './lib/validator.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { diffPacks } from './lib/diff.mjs';
import { createHarness } from './lib/harness.mjs';

const SCHEMA = JSON.parse(readFileSync(
  new URL('../vendor/observability-pack-spec/v1.2/observability-pack.schema.json', import.meta.url), 'utf8'));
const { assert, report } = createHarness();

const k = (kind, idn) => `${kind}::${JSON.stringify(idn)}`;
const entry = (kind, idn, spec) => ({ key: k(kind, idn), artefact: { spec } });

// ---------- synthetic: dependency order + guards ----------
const baseA = {
  apiVersion: 'observability.platform/v1',
  kind: 'ObservabilityPack',
  metadata: { name: 'rf-test', version: '1.0.0' },
  spec: {
    slis: [{ id: 'existing_sli', type: 'threshold', query: 'up', threshold: 1 }],
    slos: [],
    queries: { recording_rules: [{ name: 'rf:existing:rule', expr: 'vector(1)' }] },
  },
};

// Entries deliberately listed burn-rate FIRST to prove dependency sorting.
const r1 = retrofeedShadowSignals(baseA, [
  entry('burn_rate', { slo: 'shadow_99' }, { slo: 'shadow_99', windows: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }] }),
  entry('slo', { id: 'shadow_99' }, { id: 'shadow_99', sli: 'shadow_sli', objective: 0.99, window: '30d' }),
  entry('sli', { id: 'shadow_sli' }, { id: 'shadow_sli', type: 'ratio', good: 'sum(rate(ok[5m]))', total: 'sum(rate(all[5m]))' }),
], { now: '2026-06-11T00:00:00.000Z' });

assert(r1.adopted.length === 3, 'SLI + SLO + burn-rate all adopt despite input order', r1.skipped);
assert(r1.adopted[0].kind === 'sli' && r1.adopted[1].kind === 'slo' && r1.adopted[2].kind === 'burn_rate',
       'adoption respects dependency order (SLI → SLO → burn-rate)');
assert(r1.updatedCanonical.spec.slos.some(s => s.id === 'shadow_99'), 'SLO lands in spec.slos');
assert(r1.updatedCanonical.spec.policy.burn_rate_alerts.some(b => b.slo === 'shadow_99'),
       'burn-rate lands in spec.policy (path created on demand)');
assert(baseA.spec.slos.length === 0 && !baseA.spec.policy,
       'input pack is never mutated');
assert(r1.updatedCanonical.metadata.annotations['observogram.retrofeed.adoptedAt'] === '2026-06-11T00:00:00.000Z',
       'provenance timestamp is caller-supplied (deterministic)');
assert(/sli:shadow_sli/.test(r1.updatedCanonical.metadata.annotations['observogram.retrofeed.adopted']),
       'provenance annotation lists the adopted identities');
assert(r1.fragment?.spec?.slis?.length === 1, 'fragment carries just the additions');

// Referential guard: SLO whose SLI is absent → skipped with a reason.
const r2 = retrofeedShadowSignals(baseA, [
  entry('slo', { id: 'dangling_99' }, { id: 'dangling_99', sli: 'nowhere', objective: 0.99, window: '30d' }),
]);
assert(r2.adopted.length === 0 && /references SLI 'nowhere'/.test(r2.skipped[0].reason),
       'SLO referencing an undeclared SLI is skipped, named', r2.skipped[0]);

// Dedup: already-declared identities are not re-adopted.
const r3 = retrofeedShadowSignals(baseA, [
  entry('recording_rule', { record: 'rf:existing:rule' }, { name: 'rf:existing:rule', expr: 'vector(2)' }),
  entry('sli', { id: 'existing_sli' }, { id: 'existing_sli', type: 'threshold', query: 'up', threshold: 1 }),
]);
assert(r3.adopted.length === 0 && r3.skipped.every(s => /already declared/.test(s.reason)),
       'pre-existing declarations are skipped, not duplicated', r3.skipped);

// Honest non-goals: inventory-level + unmapped families.
const r4 = retrofeedShadowSignals(baseA, [
  entry('metric', { name: 'http_requests_total' }, { name: 'http_requests_total' }),
  entry('pipeline_exporter', { signal: 'metrics' }, { kind: 'prometheusremotewrite' }),
  { key: 'garbage-key', artefact: { spec: {} } },
]);
assert(r4.adopted.length === 0 && r4.skipped.length === 3, 'non-declarable families all skip');
assert(/inventory-level evidence/.test(r4.skipped.find(s => s.kind === 'metric').reason),
       'metric skip names the inventory reason');
assert(r4.skipped.some(s => /unparseable diff key/.test(s.reason)), 'garbage keys skip without throwing');
assert(!('annotations' in (r4.updatedCanonical.metadata || {})) || !r4.updatedCanonical.metadata.annotations['observogram.retrofeed.adoptedAt'],
       'no provenance annotation when nothing was adopted');
assert(r4.fragment === null, 'no fragment when nothing was adopted');

// ---------- end-to-end with REAL packs: the output must validate ----------
const A = parseYaml(readFileSync(new URL('../vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml', import.meta.url), 'utf8'));
const B = parseYaml(readFileSync(new URL('../examples/production-curated.pack.yaml', import.meta.url), 'utf8'));
const diff = diffPacks(adapt(A), adapt(B), { scopeMode: 'off' });
const onlyInB = Object.values(diff.layers).flatMap(l => l.onlyInB || []);
assert(onlyInB.length > 0, 'fixture diff produces shadow signals to adopt', diff.summary);

const r5 = retrofeedShadowSignals(A, onlyInB, { now: '2026-06-11T00:00:00.000Z' });
assert(r5.adopted.length > 0, 'real shadow signals adopt', { adopted: r5.adopted.length, skipped: r5.skipped.length });
const errs = validateCanonical(r5.updatedCanonical, SCHEMA);
assert(errs.length === 0,
       'THE LAW: the retrofed pack validates against the schema', errs.slice(0, 3));
// Re-diff: adopted artefacts must no longer be onlyInB (the arrow closed).
const diff2 = diffPacks(adapt(r5.updatedCanonical), adapt(B), { scopeMode: 'off' });
assert(diff2.summary.onlyInB < diff.summary.onlyInB,
       're-diff confirms the gap shrank (onlyInB decreased)',
       { before: diff.summary.onlyInB, after: diff2.summary.onlyInB });
assert(diff2.summary.aligned > diff.summary.aligned,
       're-diff confirms adopted artefacts now align',
       { before: diff.summary.aligned, after: diff2.summary.aligned });

report('retrofeed', 'all retrofeed assertions pass.');
