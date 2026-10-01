# The `${svc}_assurance` group — monitoring the monitors, compiled

*Roadmap step 5 (early-warning delivery). Source: `tools/lib/assurance-rules.mjs`,
wired by `tools/lib/compile.mjs`; suite `tools/test-compile.mjs` section 15; goldens
under `tools/fixtures/golden/compile/`.*

Observogram is not there to monitor the system but the artefacts that monitor the
system. A journey run samples the stack's own self-metrics from the outside every
N minutes; the assurance group makes the ruler itself say, continuously, whether
the artefacts Observogram compiled are being **evaluated** and **delivered** at
all. Every compiled rules file (`packc compile <pack> prometheus-rules`, the
Grafana-managed bundle, the studio's `all`) carries it by default.

## The rules

| rule | expr | for | severity | when |
|---|---|---|---|---|
| `Watchdog` | `vector(1)` | — | `none` | always — the dead-man contract (below) |
| `<svc>_scrape_target_down` | `up{job=~"<declared jobs>"} == 0` | 2m | SEV2 | only when the pack declares `scrape_configs` (an instrument nobody scrapes would fire forever) |
| `<svc>_ruler_silent_<product>` | `absent_over_time(<liveness metric>[5m])` | 10m | SEV2 | the ruler stopped exposing itself — stopped, unscraped or renamed |
| `<svc>_notify_silent_<product>` | `absent_over_time(<liveness metric>[5m])` | 10m | SEV2 | the notifier stopped exposing itself |
| `<svc>_ruler_stale_<product>` | `max(time() - <last evaluation ts>) > 120` | 2m | SEV3 | rules are evaluated late (a *stopped* ruler cannot evaluate this — the Watchdog covers it) |
| `<svc>_ruler_errors_<product>` | `increase(<eval failures>[5m]) > 0` | 2m | SEV3 | some rules fail to evaluate — a failing rule records nothing and its burn alert can never fire |
| `<svc>_notify_errors_<product>` | `increase(<notification errors>[5m]) > 0` | 2m | SEV3 | notifications fail to deliver — alerts may fire unseen |

Lab mode (`opts.lab`) shortens the `for:` to 30s / 2m. Labels on every rule:
`severity`, `kind: assurance`, `instrument` (`watchdog` · `scrape` ·
`<family>/<product>`), `service`, `pack`. Annotations: `summary`, `description`,
`runbook` (`opts.runbooks.assurance`, else `(supply runbook URL)`). No rule carries
`keep_firing_for`, so the VictoriaMetrics / Prometheus 2.30 goldens differ from
the Prometheus 3 ones only where burn alerts already did.

Every metric name is a `requires[]` entry of the stack self-metric alias table
(`tools/lib/contracts/stack-self-metrics.mjs` — names verified live against the
real products), never an alias `expr` (those carry `rate()`, which the compiler's
alert contract forbids). Per family the **liveness** row is preferred for the
silent alert (`rule_evaluation_staleness`, `notifications_sent`), the error row
when the product has no alias there; one silent alert per family and product.

## Which products, and why

| product | rows | gate |
|---|---|---|
| `generic` | `up` (target-down) | always |
| `prometheus` | `prometheus_rule_group_last_evaluation_timestamp_seconds`, `prometheus_notifications_sent_total`, `prometheus_rule_evaluation_failures_total`, `prometheus_notifications_errors_total` | the metrics profile is Prometheus (the pack's declared metrics backend, or `--product`) |
| `victoriametrics` | `vmalert_recording_rules_errors_total` + `vmalert_alerting_rules_errors_total` (silent: `or` of absents; errors: a sum of increases), `vmalert_alerts_send_errors_total` | the metrics profile is VictoriaMetrics |
| `alertmanager` | `alertmanager_notifications_total`, `alertmanager_notifications_failed_total` | a `spec.telemetry.backends[]` product matches `/alertmanager/i` |
| `grafana` | `grafana_alerting_rule_evaluation_failures_total` | a declared `job_name` matches `/grafana/` (a Grafana backend without a job **warns** and emits nothing) |
| mimir / thanos | — | no `prometheus_*` rows → generic only |

otelcol rows are omitted in step 5: the table proves their `_sent_` / `_accepted_`
siblings register lazily and `otelcol_exporter_queue_capacity`'s startup presence
is watched (`tools/test-stack-live.mjs`) but not asserted — a follow-up, not a guess.

## Opt-out

```yaml
metadata:
  annotations:
    observogram.assurance: watchdog-only   # on (default) · watchdog-only · off
```

`compile(..., { assurance: 'off' })` overrides the annotation. An unknown value
warns once and reads as `on`. `spec` is `additionalProperties: false`, hence an
annotation (precedent: `observogram.diff.scopeMode`).

## The Watchdog's heartbeat route (deploy time, outside the compiled config)

The Watchdog fires **by construction**. The compiled Alertmanager config routes
it to the `null` receiver; the value comes from a heartbeat receiver that pages
when the heartbeat *stops*. Add the route at deploy time (Healthchecks.io,
Better Uptime, PagerDuty heartbeat, Grafana OnCall heartbeat — any endpoint that
alarms on silence):

```yaml
# alertmanager.yml — add above the pack's routes
route:
  routes:
    - matchers:
        - alertname = "Watchdog"
        - pack = "payment-service"
      receiver: heartbeat-payment-service
      group_wait: 0s
      group_interval: 1m
      repeat_interval: 1m          # the heartbeat endpoint expects a ping at least this often
      continue: false
receivers:
  - name: heartbeat-payment-service
    webhook_configs:
      - url: https://hc-ping.com/<uuid>   # the endpoint alarms when pings stop
        send_resolved: false
```

Silence on the heartbeat means one of: the ruler is not evaluating this pack's
groups, Alertmanager is down, or the notification path from Alertmanager out is
broken — exactly the three failures none of the pack's own alerts can report.

## Where it shows up

- `packc compile <pack> prometheus-rules` and the Grafana-managed bundle: the
  last group of the file.
- Compile catalog item `assurance` (kind `rules-assurance`, after `all`), its
  own files `<svc>.assurance.rules.yaml` / `<svc>.assurance.grafana-rules.yaml`,
  deployable from the studio as the row `rules:alert:assurance`. The post-deploy
  verifier reads it as `pending` until the diff carries a kind for non-burn
  alerts (the graph has none today) — never as `verified`.
- Dashboards count symptoms with `kind=""`, so the Watchdog stays out of the
  symptom counters; alignment is unaffected (the live fetcher lands it only in
  `mcp.discovered.alert_rule_names`).
- The generator (`tools/gen-burn-rules.mjs` → `*.burn.yml` in the reference
  packs and mq-observability-pack) is **not** extended.
