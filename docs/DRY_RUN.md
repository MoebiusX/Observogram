# Dry Run Runbook

This runbook is for the Krystaline dry run on June 10, 2026.

The purpose is to demonstrate the main Observogram value loop:

```text
Discover -> Diagnose -> Remediate -> Validate again
```

The demo question is:

> Is our observability diagnostic-grade?

The OLA is represented by the repo-derived ObservabilityPack. The live MCP pack
is production evidence. The dry run is valuable only when Observogram compares
those two things directly.

## Success Criteria

The dry run is successful when Observogram can show all of the following:

- repo-derived Pack A loads cleanly
- live MCP-derived Pack B loads cleanly
- Diagnostic Grade renders from Pack A vs Pack B
- grade passes when score is greater than 85%
- remaining drift is visible and explainable
- traceability shows SLO-to-artifact chains
- Remediate identifies deployable vs manual follow-up work
- settlement latency rules can be compiled for Grafana-managed deploy
- deploy is attempted only if the MCP write target and client key are ready
- live validation can be re-run after deploy

## Inputs

Expected dry-run inputs:

```text
krystaline.service.repo.yaml
examples/production-live.pack.yaml  # generated locally or supplied for the run
```

`production-live.pack.yaml` is not a shipped example. Generate it from the live
MCP endpoint or upload the supplied live pack for the run. The repo-derived
`krystaline.service.repo.yaml` pack is the service fixture supplied for the dry
run; upload it through the picker or place it under `examples/` before the run.

Expected role:

| Pack | Role |
|---|---|
| `krystalinex-core` | Pack A, declared repo posture |
| `production-live` | Pack B, verified live posture |

## Preflight

Run from the repository root:

```bash
npm install
npm run lint:server
npm run lint:studio
npm run lint:crawler
npm run lint:fetcher
npm run test:fetch
npm run test:compile
npm run test:server
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:8000
```

Check health:

```bash
curl http://127.0.0.1:8000/healthz
```

Expected:

```json
{"ok":true,"specVersion":"1.2"}
```

## Clean State

If the pack picker contains stale uploads, clear the in-memory registry:

```bash
curl -X DELETE http://127.0.0.1:8000/api/uploads
```

Reload the browser.

## Main Browser Script

### 1. Discover

Load the repo pack as Pack A:

```text
krystaline.service.repo.yaml
```

Confirm the selector identifies the file source:

```text
krystalinex-core · v0.1.0-crawled · from krystaline.service.repo.yaml
```

Review the observogram layers quickly:

- L1 Contract
- L2 Telemetry
- L3 Insight
- L4 Action
- L5 Validation

### 2. Load Live

Load the live pack as Pack B:

```text
examples/production-live.pack.yaml
```

Confirm the selector identifies the file source:

```text
production-live · from production-live.pack.yaml
```

### 3. Diagnose

Open **Diagnose - Can We Trust It?**

Expected current shape:

```text
DIAGNOSTIC GRADE    A · DIAGNOSTIC / CLINICAL GRADE
Score    86% 6.04/7
Coverage 100% 4/4
Trust    68% 2.04/3
Audit    PASS (bar: above 85% — A and better)
Verified YES live signal present
```

(Grade schema 2: seven scored criteria; the Actionable check renders
separately under 2C Operability as informational. The headline stamp is
the instrument grade — D/C/B/B+/A/A+ with A++ shown as a reference-only
rung — and the full ladder renders below the summary with the current
rung highlighted.)

The exact live snapshot may change. The interpretation remains:

- PASS means score is greater than 85%
- trust can still be partial
- drift remains visible below the grade

Explain the two diagnostic questions:

1. Are we monitoring the right things?
2. Is what we say we monitor actually active in production?

Name the checks when asked how the grade is calculated (seven scored, one
informational):

| Area | Checks | Scored |
|---|---|---|
| Coverage | Multi-modal, Correlated, Calibrated, Comprehensive | yes |
| Trust | Chaos-validated, Drift-free, Fresh | yes |
| Operability | Actionable | no — informational |

Then explain the drift buckets:

- aligned
- drifted
- declared, not live
- live, not declared
- out of scope

### 4. Traceability

Open **Advanced -> Traceability**.

Use this view to show why a gap matters:

- SLO
- SLI
- metrics
- recording rules
- exporter
- scrape evidence
- dashboards
- alerts
- runbook/remediation

For settlement latency, confirm the chain includes:

- `slo_settlement_latency_99`
- `slo_settlement_latency`
- `settlement_latency_seconds_bucket`
- `settlement_latency_seconds_count`
- settlement latency recording rules
- burn-rate alert evidence

If scrape or dashboard evidence is missing, call that out as the diagnostic
finding rather than hiding it.

### 5. Remediate

Open **Remediate - Fix The Gaps**.

Confirm the plan separates:

- selected deployable rows
- manual follow-up rows
- compile preview
- deploy target

For settlement latency, compile the SLO-specific artifact. Expected compile
shape:

```text
4 recording rules
3 burn-rate alert rules
Grafana-managed flavor available
```

Open the deploy modal but do not submit unless the write target is ready.

## Deploy Gate

Do not deploy unless all of these are true:

- MCP endpoint is reachable
- MCP writes are enabled
- MCP client key is available
- Grafana service-account token is configured on the MCP server
- target product is `grafana`
- target version is selected
- selected rows are source-backed or compiler-materialized from source-backed contracts

Required MCP server environment:

```bash
MCP_ENABLE_WRITES=true
GRAFANA_URL=https://grafana.example.net
GRAFANA_AUTH_TOKEN=glsa_...
MCP_AUTH_KEYS='{"keys":[{"id":"observogram","key":"sk-observogram-prod"}]}'
```

## Post-Deploy Validation

After deploy:

1. Generate a new live pack from MCP.
2. Load it as Pack B.
3. Re-run Diagnose.
4. Confirm whether settlement latency drift changed.
5. Save or export the resulting delta.

The expected story is not "everything is perfect." The expected story is:

```text
Observogram found the gap, compiled the fix, deployed the source-backed delta,
and verified the new live state.
```

## Known Readiness Notes

- Diagnostic Grade renders PASS for scores greater than 85%.
- The grade header does not say `vs production-live`.
- The drift section still names live comparison context.
- Uploaded pack labels must include source filenames to avoid stale/typo inputs.
- Traceability may still show incomplete chains when scrape or dashboard
  evidence is absent from the repo-derived pack.
- Grafana writes require explicit MCP write configuration and a client key.
