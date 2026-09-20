# Phase 1 Verdict Trust Research Draft

Status: draft for maintainer review.

This document scopes the Phase 1 research/specification pass for making
Observogram's verdict harder to dispute. It is intentionally docs/spec only.
It does not change crawler behavior, diff behavior, PromQL parsing,
artifact identity, Diagnostic Grade semantics, or drift-fidelity weights.

## Review Guardrails

- No engine implementation in this pass. In particular, this draft does not
  modify `tools/lib/diff.mjs`, `tools/lib/artefact-model.mjs`,
  `tools/lib/promql.mjs`, `studio/diagnostic-grade.mjs`, or the grade
  weighting model.
- No direct pushes to `develop`. The draft is reviewed by PR before merge.
- No verification/validation conflation. Manifest checks, schema checks,
  conformance checks, and live artifact existence checks are verification
  evidence. Observogram is not called validated until its verdict is checked
  against incident ground truth for the intended use.
- No drift-fidelity re-weighting in this draft. Existing weighted-fidelity
  semantics remain the baseline until the maintainer explicitly reviews a
  separate scoring proposal.

## Purpose

Phase 1 answers this research question:

> What must Observogram specify, measure, and display before its Diagnostic
> Grade and drift verdict can be trusted as a decision aid?

The current product already has strong verification machinery: deterministic
pack adaptation, structural diff, live MCP evidence, traceability, and a
repeatable Diagnostic Grade. The remaining credibility gap is not whether the
pipeline runs. It is whether the verdict is true enough, fresh enough, and
validated enough for the decision Observogram asks users to make.

This research track runs alongside the active execution track in
`docs/VALUE_BACKLOG.md`: post-deploy re-verify, workspace persistence, audit,
rollback, and journeys. The research output should guide later implementation
without moving the load-bearing semantics while transition verification is
being built.

## Terms

Use these words narrowly:

| Term | Meaning in this draft |
|---|---|
| Verification | Evidence that an artifact, manifest, rule, route, dashboard, or pack satisfies specified requirements. |
| Validation | Evidence that the specified requirements are adequate for the intended operational decision. Incident back-testing is validation evidence; schema or manifest checks are not. |
| Verdict | The combined user-facing result: Diagnostic Grade, drift buckets, traceability evidence, and freshness state. |
| Freshness | Whether the live evidence used for a verdict is recent enough for the stated decision. |
| Trueness | Whether the verdict is free from systematic bias, especially over-declaration caused by comparing the wrong environment or counting disabled components. |

## Workstream A: Environment-Aware Trueness

### Current understanding

The crawler already contains environment scoping and Helm `enabled: false`
handling. That means Phase 1 should not describe this as absent from the
codebase. The open problem is the product contract around environment
selection, evidence, and comparison scope:

- the selected environment should be explicit in CLI, API, Studio, generated
  pack annotations, and comparison output;
- disabled components should be visible as evidence, not silently counted as
  declared production controls;
- live-vs-declared comparisons should preserve the same environment and
  service scope across refresh, deploy, and re-verify flows;
- non-Helm environment conventions need a reviewed contract before they are
  counted as supported.

### Specification questions

- What is the canonical field for the selected crawl environment?
- Which environment sources are supported in v1: Helm values, Kustomize
  overlays, raw Kubernetes manifests, Docker Compose profiles, CI variables?
- How should a disabled component appear in pack annotations?
- Should missing environment selection fail, warn, or default visibly?
- How should out-of-scope or disabled evidence affect Diagnostic Grade
  display without changing grade weights?

### Acceptance criteria for a later implementation

- A repo crawl declares the environment used to produce the pack.
- Disabled components are excluded from declared-live drift badness when the
  selected environment disables them.
- The UI and CLI never require a user to infer which environment was compared.
- Existing regression coverage for Helm `enabled: false` remains intact.
- New tests cover at least one non-Helm environment convention before it is
  marked supported.

## Workstream B: Semantic Drift Equivalence

### Current understanding

`docs/DIFF.md` says expression fields currently collapse whitespace only.
That is an honest and useful baseline: it avoids pretending Observogram has
semantic equivalence it does not yet prove. The research task is to define
which future equivalences are safe enough to canonicalize and which must stay
textual.

### Safe equivalence candidates

These are plausible candidates for a later reviewed implementation:

- PromQL selector label matcher order.
- PromQL aggregation label order, for example `sum by(a,b)` versus
  `sum by(b,a)`.
- PromQL whitespace and redundant parenthesis normalization when a parser can
  prove the tree is equivalent.
- Alertmanager matcher order.
- Alertmanager `group_by` label order.

### Explicit non-goals for the first semantic pass

- No algebraic PromQL rewrites.
- No reordering of binary expressions.
- No regex equivalence.
- No histogram semantic folding.
- No receiver-rename inference.
- No route child reordering where Alertmanager first-match behavior could
  change the result.
- No dashboard JSON equivalence beyond a separately reviewed panel-query and
  threshold contract.

### Acceptance criteria for a later implementation

- Every canonicalization records whether it was parser-proven or fallback
  textual normalization.
- Parse failure falls back to the current conservative comparison.
- Semantic equivalence reduces known false drift without hiding decision-field
  drift.
- Tests demonstrate both positive equivalence and negative non-equivalence.
- `docs/DIFF.md` is updated only when the implementation lands.

## Workstream C: Freshness And Attestation

### Current understanding

Observogram already carries live MCP evidence and a freshness idea through
`mcp.refreshedAt` and the Fresh criterion. The gap is precision: pack-level
freshness is not the same as per-artifact attestation, and a write
acknowledgement is not live verification.

### Specification questions

- What evidence must exist for an artifact to be called verified live?
- Which artifact families can carry per-artifact freshness immediately?
- What should the UI say when a pack is fresh but a specific artifact is stale
  or unobserved?
- Is the default freshness window still 24 hours for all artifact families?
- How should post-deploy transition verification record "deployed but not yet
  visible live" without granting verification credit?

### Required language discipline

- "Verified live" means the read path observed the artifact.
- "Deployed" means a write path acknowledged the operation.
- "Fresh" means the relevant verification evidence is inside the accepted
  freshness window.
- "Validated" is reserved for incident-ground-truth evidence.

### Acceptance criteria for a later implementation

- Stale evidence is visible in Diagnostic Grade and traceability output.
- Missing artifact-level freshness does not get silently upgraded by a fresh
  pack-level timestamp.
- Post-deploy re-verify can record pending visibility without counting it as
  aligned live evidence.
- Freshness failures do not require changing drift-fidelity weights.

## Workstream D: CI Gate And Journey Fit

### Current understanding

`tools/detect-drift.mjs` already has the shape of a gate: markdown output,
JSON output, and distinct exit codes. `docs/VALUE_BACKLOG.md` now frames saved
journeys as the repeatable execution layer that can subsume a CI gate.

The research output should therefore specify the gate contract once, so the
future CLI and journeys work can share it.

### Gate contract

A CI or journey verdict should report:

- declared pack identity;
- live or reference pack identity;
- environment and service scope;
- Diagnostic Grade score and pass/fail state;
- drift bucket counts;
- freshness state and stale reasons;
- policy thresholds used for the decision;
- markdown summary suitable for PR comments;
- JSON summary suitable for automation.

Exit-code intent:

| Code | Meaning |
|---|---|
| 0 | Verdict passes the configured gate. |
| 1 | Verdict ran successfully but failed the gate. |
| 2 | Tooling, configuration, input, or live-fetch error. |

### Acceptance criteria for a later implementation

- CI output and saved-journey output use the same result schema.
- The gate reports verification evidence as verification, not validation.
- The gate does not change existing grade weights.
- A stale-live-evidence failure is distinguishable from a drift failure.

## Workstream E: Incident Back-Testing

### Purpose

Incident back-testing is the validation track. It asks whether Observogram's
verdict corresponds to operational reality for a service and a stated
decision. This is the point where Observogram can move from "verified" toward
"validated."

### Minimum incident record

An incident back-test fixture should capture:

- incident id;
- service;
- environment;
- incident start and end;
- user impact statement;
- expected SLO or SLI affected;
- expected alert or detection path;
- actual alert fired, if any;
- detection timestamp;
- MTTD target and observed MTTD;
- remediation or runbook used;
- pack version or commit under test;
- live evidence timestamp;
- back-test outcome and reviewer notes.

### Release criterion

Before Observogram claims the Diagnostic Grade is validated for a given use, it
should back-test against 3-5 real incidents for that service class and publish:

- incident catch rate;
- missed incidents;
- false or noisy alerts observed in the same window;
- MTTD target adherence;
- limitations and sampling bias.

This criterion does not need to block docs, CI, or workspace implementation.
It should block stronger public language that implies clinical-style
validation.

## Proposed Review Sequence

1. Review this research draft for terminology and scoring safety.
2. Decide the accepted environment and freshness evidence contracts.
3. Decide the first semantic equivalence subset and its non-goals.
4. Decide whether CI gate output should be a standalone `packc` command, a
   journey runner mode, or both sharing one result schema.
5. Only after review, open implementation PRs in narrow slices.

## Future Implementation Slices

These are intentionally future PRs, not part of this draft:

1. Environment/trueness hardening.
2. Semantic PromQL and Alertmanager equivalence.
3. Artifact-level freshness and stale-evidence surfacing.
4. Shared CI/journey gate result schema.
5. Incident back-test fixture schema and examples.

Each slice should be built on its own branch and merged by PR before another
feature branch is opened.

## Maintainer Review Checklist

- Does the draft avoid calling manifest or live-existence checks
  "validated"?
- Does it preserve existing drift-fidelity weights?
- Does it avoid implementation requirements that would break #9 transition
  verification?
- Does it distinguish deployed acknowledgement from read-path verification?
- Does it define enough evidence to prevent false reassurance?
- Does it leave source-code metric extraction, fleet views, auth, audit, and
  rollback outside this research track?
