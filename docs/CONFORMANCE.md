# Conformance

The conformance scorer (`tools/lib/conformance.mjs`) evaluates a canonical
pack against a hand-curated subset of the maturity rubric from
[spec §5 + §7](../vendor/observability-pack-spec/v1.3/spec.md). The studio
exposes the scoring under **Advanced -> Conformance** and via
`GET /api/packs/:id/conformance?env=<name>`.

## Rubric

30 clauses across L1–L5 plus L2X. Each clause is `{ id, dimension, severity, minTier, description, specRef, evaluate }`:

- `severity`: `MUST` (weight 1) or `SHOULD` (weight 0.5).
- `minTier`: the least-stringent tier at which the clause applies. Rank `tier-3 < tier-2 < tier-1`. A clause with `minTier: tier-3` applies to every pack; one with `minTier: tier-1` only applies to tier-1 packs.
- `evaluate(canonical) → boolean`: run against the env-overlaid spec.
- `specRef`: section in the upstream spec.md where the rule is defined.

The rubric is intentionally **content-focused** — schema-enforced rules (e.g. "every SLO has `objective + window`") aren't duplicated here because the validator already covers them. Conformance only checks what sits above the schema floor.

| ID | Dimension | Severity | applies @ | Spec |
|---|---|---|---|---|
| `L1.MUST.availability_slo` | L1 | MUST | tier-3 | §5.1 |
| `L1.MUST.sli_covered_by_slo` | L1 | MUST | tier-3 | §5.1 |
| `L1.MUST.latency_slo` | L1 | MUST | tier-2 | §5.1 |
| `L1.SHOULD.domain_slo` | L1 | SHOULD | tier-1 | §5.1 |
| `L2.MUST.otlp_receiver` | L2 | MUST | tier-3 | §5.2 |
| `L2.MUST.service_name_required` | L2 | MUST | tier-3 | §5.3 |
| `L2.MUST.semconv_floor` | L2 | MUST | tier-3 | §5.3 |
| `L2.MUST.metrics_exporter` | L2 | MUST | tier-2 | §5.2 |
| `L2.MUST.metrics_logs_traces_backends` | L2 | MUST | tier-2 | §5.12.1 |
| `L2.MUST.semconv_current` | L2 | MUST | tier-1 | §5.3 |
| `L2.MUST.resource_attrs_5plus` | L2 | MUST | tier-1 | §5.3 |
| `L2.MUST.log_correlation` | L2 | MUST | tier-1 | §5.3 |
| `L2.MUST.logs_and_traces_exporters` | L2 | MUST | tier-1 | §5.2 |
| `L2.MUST.tail_sampling` | L2 | MUST | tier-1 | §5.2 |
| `L2.SHOULD.backend_gating_enforce` | L2 | SHOULD | tier-1 | §5.12.3 |
| `L2X.MUST.extended_backend_refs_resolve` | L2X | MUST | tier-3 | §5.12.4 |
| `L3.MUST.recording_rule_per_slo` | L3 | MUST | tier-3 | §5.5 |
| `L3.MUST.service_overview_dashboard` | L3 | MUST | tier-3 | §5.6 |
| `L3.MUST.slo_burn_dashboard` | L3 | MUST | tier-2 | §5.6 |
| `L3.SHOULD.derived_view` | L3 | SHOULD | tier-2 | §5.5 |
| `L3.MUST.tier1_dashboards` | L3 | MUST | tier-1 | §5.6 |
| `L4.MUST.multi_window_burn_rate` | L4 | MUST | tier-2 | §5.7 |
| `L4.MUST.tier1_voice_route` | L4 | MUST | tier-1 | §5.8 |
| `L4.MUST.tier1_at_least_one_automation` | L4 | MUST | tier-1 | §5.9 |
| `L4.SHOULD.forecast_on_availability` | L4 | SHOULD | tier-1 | §5.7 |
| `L5.MUST.synthetic_probe` | L5 | MUST | tier-3 | §5.11 |
| `L5.MUST.tier2_chaos_staging` | L5 | MUST | tier-2 | §5.11 |
| `L5.MUST.tier1_chaos_for_each_slo` | L5 | MUST | tier-1 | §5.11 |
| `L5.MUST.tier1_weekly_prod_chaos` | L5 | MUST | tier-1 | §5.11 |
| `L5.SHOULD.tier1_release_gate` | L5 | SHOULD | tier-1 | §5.10 |

## Scoring

```
must.passed   = applicable MUSTs that pass
must.total    = applicable MUSTs
should.passed = applicable SHOULDs that pass
should.total  = applicable SHOULDs

mustPercent    = must.passed / must.total * 100
scorePercent   = (must.passed + 0.5*should.passed) / (must.total + 0.5*should.total) * 100
conformant     = must.passed === must.total   (per spec §8 definition)
```

## Bundled-pack scores

| Pack | Tier | MUST | SHOULD | Conformant |
|---|---|---|---|---|
| `demo-skeleton.pack.yaml` | tier-3 | 9/9 (100%) | 0/0 | yes |
| `production-curated.pack.yaml` | tier-2 | 13/15 (87%) | 0/1 | no — 2 honest gaps |
| `target-advanced.pack.yaml` | tier-1 | 25/25 (100%) | 5/5 (100%) | yes |
| `payment-service.pack.yaml` (canonical example) | tier-1 | 21/25 (84%) | 5/5 (100%) | no — 4 orphan SLOs |

The canonical example itself fails 4 MUSTs (`L3.MUST.recording_rule_per_slo`, `L4.MUST.multi_window_burn_rate`, `L5.MUST.tier1_chaos_for_each_slo`, `L5.MUST.tier1_weekly_prod_chaos`) because two of its five SLOs (`api_latency_99_p99_500ms`, `consumer_success_99_95`) aren't covered by a recording rule, burn-rate alert, or chaos experiment. The studio surfaces these as red-X items in Advanced -> Conformance: visible drift the spec's own reference example carries.

## Extending the rubric

Each clause is a self-contained `{...}` block in `tools/lib/conformance.mjs`. Add new ones inline with their `specRef`. The server's `GET /api/maturity-rubric` will pick them up automatically; `tools/test-packs.mjs` will re-score every bundled pack against the new clause set.
