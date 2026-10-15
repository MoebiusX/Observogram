# Operational + burn-rate alert rules fixture (spec 1.4 `alerting.rules`)

A service repository as the crawler meets one: recording rules that define
two SLIs, and alert rules of both kinds side by side in every engine's own
format.

| File | Burn-rate rules (reference a recorded SLO series → `policy.burn_rate_alerts`) | Operational rules (→ `alerting.rules`) |
|---|---|---|
| `prometheus/rules.yml` | `PaymentsAvailabilityBurnFast` | `PaymentsPodRestarting`, `PaymentsDbPoolSaturated` |
| `grafana/provisioning/alerting/payments.yaml` | `PaymentsAvailabilityBurnSlow`, `PaymentsLatencyBurn` | `Payments: certificate expiring`, `Payments queue backlog`, `Payments 5xx spike` |
| `loki/rules.yaml` | — | `PaymentsErrorLogSpike` (LogQL) |

Six operational rules (N = 6) with their exact names — one with a colon and
spaces, as Grafana titles have — and three burn-rate rules that fold into
two policy entries (M = 2, one per SLO). One annotation value ends in `:`
and one in ` #`, the scalars the YAML emitter must quote for the pack to
round-trip. Read by tools/test-crawl-alerting-rules.mjs; not a golden input.
