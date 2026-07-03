# User Story: Required Deployment Environment For Repo Crawl

## Story

As an operator generating an ObservabilityPack from a repository, I must choose
the deployment environment being inspected, so Observogram compares declared
artefacts against the matching live runtime instead of blending Docker Desktop,
local Kubernetes, generic Kubernetes, and EKS surfaces into one pack.

## Problem

The crawler can currently default to `prod`. In repositories that contain
multiple deployment surfaces, that creates false declarations:

- Docker Desktop files can be read as production intent.
- Local Kubernetes overlays can be read as production intent.
- EKS overlays can be blended into generic Kubernetes intent.
- Schema-required scaffold can look like source-backed monitoring.

Those false declarations inflate the `Declared, not live` bucket. Because that
bucket carries the highest drift cost, the Diagnostic Grade can fail for the
wrong reason.

## Acceptance Criteria

- The repo crawl UI requires an explicit environment before scan starts.
- The CLI requires `--env` unless a non-interactive compatibility flag is set.
- Supported values are named in product language: `docker-desktop`,
  `local-k8s`, `kube-helm`, and `eks`.
- The selected environment is written to pack metadata and crawler annotations.
- The crawler output includes a concise inclusion/exclusion summary.
- Drift comparison warns when Pack A and Pack B environment labels differ.
- Source-less scaffold remains visible but is excluded from drift badness.

## Notes

The immediate fix is stricter environment scoping plus scaffold marking. This
story is the product hardening step: make the environment choice impossible to
skip.
