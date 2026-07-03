# Release Readiness

This document defines the V1 release gate for Observogram. The gate is centered
on the product promise:

```text
Generate an ObservabilityPack, compare it with the OLA-backed declared posture,
validate live drift, and compile a remediation delta.
```

## V1 Release Standard

V1 is ready when the main user journey works end to end for the Krystaline dry
run and remains repeatable without hand-editing browser state or YAML during
the demo.

The release question is:

> Can Observogram prove whether a service is diagnostic-grade, explain the gaps,
> and produce the next deployable observability fix?

## Required Capabilities

| Capability | Release gate |
|---|---|
| Discover | Load a repo-derived pack, a live MCP pack, and an uploaded YAML/JSON pack. |
| Diagnose | Render Diagnostic Grade, coverage, trust, live verification, drift, and evidence rows. |
| OLA comparison | Treat Pack A as declared observability intent and Pack B as live production evidence. |
| Traceability | Show SLO-to-artifact chains for critical signals such as settlement latency. |
| Remediate | Separate deployable rows from manual follow-up rows. |
| Compile | Produce Grafana-managed settlement latency recording and alerting rules. |
| Deploy gate | Block or explain deploy when MCP writes, client key, or Grafana token are missing. |
| Re-validate | Generate a fresh live pack after deploy and compare again. |

## Diagnostic Grade Contract

The grade is binary for release-readiness purposes:

```text
PASS when score > 85%
FAIL otherwise
```

Users see the score as a metrology-style instrument grade (D < 37.5% · C ≥
37.5% · B ≥ 62.5% · B+ ≥ 75% · A > 85% · A+ ≥ 95%; A++ requires
external reference evidence and is not score-reachable). A is anchored
strictly above the audit bar, so "A or better" and PASS are the same
statement — gates and run records keep keying off PASS/FAIL.

The seven scored criteria are (grade schema 2, ratified 2026-06-10):

| Area | Criteria | Scored |
|---|---|---|
| Coverage | Multi-modal, Correlated, Calibrated, Comprehensive | yes |
| Trust | Chaos-validated, Drift-free, Fresh | yes |
| Operability | Actionable (runbooks linked) | no — informational |

Actionable was reclassified out of the scored grade because runbooks measure
response readiness of the overall observability solution, not diagnostic
capability. It remains observed and displayed on the grade card (section 2C)
and keeps a scored home in the posture matrix's runbook mechanism column.

A passing grade does not hide drift. Remaining failed criteria,
declared-not-live artifacts, drifted artifacts, and live-only artifacts stay
visible as evidence for Remediate.

## Dry-Run Acceptance

The June 10, 2026 dry run is ready when:

- `npm run lint:server` passes
- `npm run lint:studio` passes
- `npm run lint:crawler` passes
- `npm run lint:fetcher` passes
- `npm run test:fetch` passes
- `npm run test:compile` passes
- `npm run test:server` passes
- the browser can load `krystaline.service.repo.yaml` as Pack A
- the browser can load a generated or supplied `production-live.pack.yaml` as Pack B
- Diagnose renders `DIAGNOSTIC GRADE` without appending `vs production-live`
- scores greater than 85% render `PASS`
- Traceability explains settlement latency from SLO to live evidence
- Remediate compiles the settlement latency Grafana-managed rules
- Deploy stays gated until the MCP write target has explicit credentials

## Production Hardening Gate

Before a broad V1 release, complete these gates:

| Area | Gate |
|---|---|
| Persistence | Decide whether uploaded/crawled/drafted packs remain in memory or move to durable storage. |
| Auth | Protect MCP write paths and document token ownership. |
| Audit | Record who deployed which artifact, to which MCP endpoint, with which source pack version. |
| Rollback | Preserve the pre-deploy compiled artifact or live snapshot for rollback review. |
| Provenance | Mark every deployable row as source-backed or compiler-materialized from source-backed inputs. |
| Live completeness | Keep dashboard detail fetches, metric inventory, scrape evidence, and rule bodies visible in MCP annotations. |
| UX safety | Keep stale pack labels and reset controls visible enough to avoid false comparisons. |
| Regression | Add a browser-level journey test for Discover -> Diagnose -> Remediate when the UI stabilizes. |

## Known Non-Goals For V1

- multi-tenant persistence
- automatic production deploy without an operator gate
- arbitrary backend writes beyond the configured MCP write tools
- hiding live-only platform inventory to make the grade look cleaner
- replacing human OLA ownership with inferred crawler guesses

## See Also

- [`DRY_RUN.md`](DRY_RUN.md) - executable dry-run checklist
- [`USER_JOURNEY.md`](USER_JOURNEY.md) - product journey and UI invariants
- [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) - live evidence and write path
- [`USER_STORY_CRAWLER_PROVENANCE.md`](USER_STORY_CRAWLER_PROVENANCE.md) - deploy provenance story
