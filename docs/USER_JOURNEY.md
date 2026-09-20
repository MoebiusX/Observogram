# User Journey

Observogram has one product journey:

```text
Discover -> Diagnose -> Remediate
```

The journey is not a marketing funnel and not a dashboard catalogue. It is a
diagnostic workflow for one question:

> Is this service's observability diagnostic-grade?

Design and implementation decisions must shorten the path from raw inputs to
that answer.

## The Three Questions

| Step | User question | Product answer |
|---|---|---|
| Discover | What do we have? | Render the observogram from a repo, live scan, or pack. |
| Diagnose | Can we trust it? | Score coverage and trust; show declared-vs-live drift. |
| Remediate | How do we fix it? | Compile and deploy the source-backed delta. |

The primary chrome uses these questions directly:

1. **Discover - What Do We Have?**
2. **Diagnose - Can We Trust It?**
3. **Remediate - Fix The Gaps**

Advanced views exist, but they are not the core journey. They support expert
analysis: References, Conformance, Schema, OTLP Coverage, Traceability, Atlas.

## OLA And Observability Contract

The OLA is the service's observability intent. Observogram represents that intent
as a canonical ObservabilityPack:

- criticality and ownership
- SLOs and SLIs
- telemetry and backend bindings
- recording rules and dashboards
- alerts, routes, and remediations
- validation evidence and freshness expectations

During the main dry-run flow, Pack A is the declared contract from the service
repo and Pack B is the verified live state from MCP. Diagnose answers whether
the live production posture satisfies the declared contract well enough to be
diagnostic-grade.

## North-Star Flow

```text
Open app
  |
  v
Discover
  |
  |-- scan a service repo
  |-- generate from a live MCP endpoint
  |-- upload a YAML/JSON pack
  v
Pack A loaded: declared observability posture
  |
  v
Load Pack B: live production posture
  |
  v
Diagnose
  |
  |-- Diagnostic Grade
  |-- Coverage criteria
  |-- Trust criteria
  |-- Drift drill
  |-- Traceability chains
  v
Remediate
  |
  |-- A minus B delta
  |-- deployable source-backed artifacts
  |-- manual follow-up items
  |-- compile selected artifacts
  |-- deploy through MCP write tools
  v
Re-run live scan and compare again
```

## Diagnostic Grade Contract

The Diagnostic Grade is the top-level answer. It is scored from seven
criteria (grade schema 2), plus one informational operability check:

### Coverage - Are We Observing The Right Things?

1. **Multi-modal** - metrics, logs, traces, or profiles cover the service.
2. **Correlated** - telemetry can be joined through trace context or log
   correlation.
3. **Calibrated** - SLOs have numeric objectives and baselines exist.
4. **Comprehensive** - coverage spans the major service layers.

### Trust - Can We Trust What The Signals Show?

5. **Chaos-validated** - recovery has fault-injection evidence.
6. **Drift-free** - declared artifacts match live state.
7. **Fresh** - the live signal was verified recently.

### Operability - Can Oncall Act On What It Sees? (informational, not scored)

- **Actionable** - alerts lead to a runbook or remediation path. This
  measures response readiness of the overall observability solution, not
  diagnostic capability, so it is observed and displayed but never moves
  the score (reclassified 2026-06-10; journey run records carry
  `grade.schema` so score history steps are explainable).

The audit verdict (the machine contract journeys gate on) is:

```text
PASS when score > 85%
FAIL otherwise
```

The displayed verdict is the **instrument grade** the score lands on,
rendered as a full ladder with the current rung highlighted:

| Grade | Class | Score band |
|---|---|---|
| A++ | Calibration / Reference Grade | not score-reachable (external benchmarking) |
| A+ | Laboratory / Research Grade | ≥ 95% |
| A | Diagnostic / Clinical Grade | > 85% — anchored to the audit bar |
| B+ | Inspection Grade | ≥ 75% |
| B | Industrial Grade | ≥ 62.5% |
| C | Field Grade | ≥ 37.5% |
| D | Consumer Grade | < 37.5% |

A or better and audit PASS are by construction the same statement. Journey
run records carry `grade.letter` alongside `grade.score`.

Failed criteria still render as evidence. A score can pass while drift remains
visible. That is intentional: the grade answers whether the posture is
diagnostic-grade overall; the drill-down tells the team what to fix next.

## Pack Roles

| Role | Meaning |
|---|---|
| Pack A | The declared posture, usually generated from the service repo. |
| Pack B | The verified/live posture, usually generated from MCP. |
| Reference pack | A curated target posture used for benchmarking, not the default dry-run path. |

The dry-run path is **repo vs live**, not repo vs aspirational reference.

## Required UI Invariants

1. **The first screen must be useful.** Discover is the entry point and must let
   a user create or load a pack immediately.

2. **The three primary tabs are the workflow.** Do not add another first-class
   navigation layer that competes with Discover, Diagnose, Remediate.

3. **Pack identity must be explicit.** Uploaded/crawled/drafted pack selectors
   must show enough source context to prevent stale or typo uploads from being
   mistaken for the dry-run input.

4. **Pack B means comparison.** When a live pack is loaded as Pack B, Diagnose
   must be able to answer repo-vs-live drift without another conceptual mode.

5. **Diagnostic heading stays focused.** The heading is `DIAGNOSTIC GRADE`
   plus PASS/FAIL. The live target belongs in the drift section, not in the
   grade title.

6. **Drift remains evidence, not decoration.** Declared-not-live, drifted, and
   live-only signals must stay visible even when the overall grade passes.

7. **Remediate separates deployable from manual.** Source-backed artifacts may
   be selected for deploy. Inferred guidance must be labelled and kept out of
   default deploy selections.

8. **State must not create false confidence.** Persisted local state is useful,
   but reset and source labels must make stale comparisons easy to clear.

## What Belongs In Each Step

### Discover

Belongs here:

- repo scan
- live MCP generation
- YAML/JSON upload
- pack catalog selection
- layered artifact inventory
- source metadata and crawler summary

Does not belong here:

- final diagnostic verdict
- deploy actions
- benchmark marketing copy

### Diagnose

Belongs here:

- Diagnostic Grade
- score, coverage, trust, verified status
- evidence table
- drift drill
- traceability to explain why an artifact matters
- comparison and atlas analysis as advanced diagnostics

Does not belong here:

- deploy submission
- compile output as the main surface
- unrelated reference browsing

### Remediate

Belongs here:

- A minus B delta
- deployable rows
- manual follow-up rows
- compile preview
- deploy modal
- validation status
- rollback/dry-run affordances

Does not belong here:

- hiding drift because the grade passed
- deploying artifacts without provenance
- forcing all artifacts through the same deploy path

## Dry-Run Golden Path

For the Krystaline dry run:

1. Clear stale uploads if needed.
2. Load the supplied `krystaline.service.repo.yaml` repo pack as Pack A.
3. Load the generated or supplied `production-live.pack.yaml` as Pack B.
4. Open Diagnose.
5. Confirm Diagnostic Grade renders PASS when score is greater than 85%.
6. Explain remaining drift from the drill-down.
7. Open Traceability for SLO-to-artifact evidence.
8. Open Remediate.
9. Compile the settlement latency remediation artifacts.
10. Deploy only when the MCP write target and token are ready.
11. Re-run live generation and compare again.

See [`DRY_RUN.md`](DRY_RUN.md) for the executable checklist.

## See Also

- [`DIFF.md`](DIFF.md) - structural drift model
- [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) - live scan and write-back path
- [`CONFORMANCE.md`](CONFORMANCE.md) - maturity rubric scoring
- [`USER_STORY_CRAWLER_PROVENANCE.md`](USER_STORY_CRAWLER_PROVENANCE.md) - provenance for deployable artifacts
