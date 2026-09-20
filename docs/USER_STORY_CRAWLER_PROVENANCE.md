# User Story: Source-Backed Artifact Provenance

## Story

As an SRE reviewing a Observogram remediation plan, I want every deployable
artifact to show where it came from and what depends on it, so that I only
deploy source-backed observability changes and can explain why each change is
needed.

## Context

The crawler currently discovers Prometheus/Grafana rules, dashboards, routes,
and pipelines from source files. It also infers SLIs/SLOs from rule names and
expressions. That inference is useful for diagnostics, but it is not enough to
make an artifact deployable. A rule generated only to satisfy a rubric can look
like a real production change even though no repo file owns it.

The Krystaline reconciliation exposed this failure mode: source-authored
`slo:settlement_latency:*` recording rules were legitimate deploy candidates,
while crawler-synthesized `krystalinex_core:*:ratio_5m` candidates had no source
file and should not have appeared as deployable rows.

## Acceptance Criteria

- Each crawler artifact has a provenance object with file path, parser kind,
  source location when available, and whether it is source-backed or inferred.
- Synthetic or inferred artifacts are marked `deployable: false` unless a
  compiler step explicitly materializes them from a source-backed contract.
- The Remediate deploy modal excludes non-deployable artifacts by default and
  labels them as inferred guidance when shown.
- The artifact model exposes `requires` and `requiredBy` edges for rules, SLIs,
  SLOs, dashboards, alerts, routes, and pipelines.
- Rule expressions expose best-effort references to metrics, SLIs, SLOs, and
  upstream recording rules.
- The UI can answer "where did this artifact come from?" and "what breaks if I
  change or delete it?" for every deployable artifact.
- Crawler tests cover a source-backed rule, an inferred SLO, and a synthetic
  non-deployable rule candidate.

## Notes

The dependency view plan in `docs/archive/DEPENDENCY_VIEW_PLAN.md` (archived)
covers the UI shape for lineage. This story is the data contract needed before
that view can be trusted for deployment decisions.
