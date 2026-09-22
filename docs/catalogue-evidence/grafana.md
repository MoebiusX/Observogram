# Evidence — `observability/grafana` reference pack

Every non-obvious choice in [`reference-packs/grafana.pack.yaml`](../../reference-packs/grafana.pack.yaml) is grounded in a public, citeable source. This document is the audit trail.

**Pack target:** Grafana 12.x and 11.x (current) + 10.4 LTS; every SLI query measured live on 12.4.11 OSS (§10).
**Tier:** tier-2 (production BAU floor).
**Last reviewed:** 2026-09-22 (live measurement; content review 2026-06-06).
**Paired with:** [`observability/prometheus`](prometheus.md) — Grafana queries Prometheus, so they appear together in every observability stack.

---

## 1. SLI selection — why these eight vital signs

### `http_request_success_ratio` (ratio)
**What it measures:** fraction of HTTP responses that are not 5xx.

**Rationale:** the foundational availability SLI for the Grafana web tier. 4xx responses are intentional (auth failures, validation errors) and excluded — only 5xx counts as the failure class.

**Sources:**
- Grafana Internal Metrics documentation — https://grafana.com/docs/grafana/latest/setup-grafana/set-up-grafana-monitoring/
- Grafana Labs *Operating Grafana at Scale* — https://grafana.com/blog/

**PromQL metrics:** `grafana_http_request_duration_seconds_count{status_code}` — Grafana exposes this on `/metrics`.

### `http_request_latency_p99` (threshold)
**What it measures:** 99th-percentile latency across all HTTP handlers.

**Rationale:** dashboard interactivity depends on API latency under 1s. The 1s threshold is the Grafana team's published recommended ceiling for user-perceptible response time.

### `datasource_proxy_success_ratio` (ratio)
**What it measures:** fraction of datasource proxy requests (Grafana → Prometheus / Loki / Tempo / Elasticsearch / Influx) returning non-5xx.

**Rationale:** this is the **most operationally important SLI** for Grafana. When the datasource proxy fails, dashboards break in a user-visible way before any other Grafana metric degrades. Grafana Labs' own SRE team treats this as the #1 SLI.

**Sources:**
- Grafana Cloud SRE *Datasource Reliability* docs — https://grafana.com/docs/grafana-cloud/account-management/
- Grafana Labs blog, *How we monitor Grafana at scale*

**PromQL metrics:** `grafana_datasource_request_total{code}` for the success/failure split.

### `datasource_proxy_latency_p99` (threshold)
**What it measures:** 99th-percentile datasource proxy request latency.

**Rationale:** datasource latency directly drives dashboard render time. 2s threshold reflects acceptable upstream latency before users notice; for tier-1 deployments this tightens to 500ms.

### `database_query_latency_p99` (threshold)
**What it measures:** 99th-percentile latency of Grafana's *internal* database queries (the metadata / dashboards / users / orgs store, typically SQLite, MySQL, or Postgres).

**Rationale:** slow internal database queries degrade the entire UI. The 500ms threshold matches the Grafana team's published target for the metadata layer.

**PromQL metric:** `grafana_database_queries_duration_seconds_bucket` (plural *queries*). **Prerequisite:** Grafana exposes this histogram only with `[database] instrument_queries = true` (`GF_DATABASE_INSTRUMENT_QUERIES=true`), which is **off by default** — without it the SLI reads nothing, and the pack declares that in `metadata.annotations.prerequisites`. Until 2026-09-22 the pack named `grafana_database_query_duration_seconds_bucket` (singular), a family no Grafana exposes (0 series on 12.4.11, §10).

**Sources:**
- Grafana Internal Metrics documentation
- *Database Performance Tuning for Grafana* (Grafana Cloud ops docs)
- Grafana configuration reference, `[database] instrument_queries` — https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/#instrument_queries

### `alerting_rule_evaluation_success_ratio` (ratio)
**What it measures:** fraction of unified alerting rule evaluations that succeeded vs. attempted.

**Rationale:** Grafana Unified Alerting evaluates rules against datasources; failures here mean alerts FIRE-OR-NOT incorrectly. This silently undermines the entire alerting contract. The 99.95% objective reflects that we want near-perfect rule evaluation; 5min of evaluation failure per month is the budget.

**PromQL metrics:** `grafana_alerting_rule_evaluations_total` and `grafana_alerting_rule_evaluation_failures_total`. On 12.4.11 both appear together as soon as the instance has one Grafana-managed rule (the failures counter is exposed at 0 before any failure, §10); on an instance with no rules neither exists and the SLI is empty, which is correct (nothing to evaluate). The subtracted leg is written `(sum(rate(grafana_alerting_rule_evaluation_failures_total[5m])) or vector(0))` so the good leg stays defined on any release where the failures counter is registered lazily, and so the burn-rate generator's derived-good fill is not needed.

**Sources:**
- Grafana Unified Alerting documentation — https://grafana.com/docs/grafana/latest/alerting/
- Grafana Labs blog, *Lessons from running unified alerting at scale*

### `plugin_request_success_ratio` (ratio)
**What it measures:** fraction of plugin requests (datasource and app plugins) completing without error.

**Rationale:** plugin failures often surface as "broken panel" errors to users before the plugin itself is suspected. Catching plugin-level failure rates early reduces mean-time-to-triage for dashboard issues.

**Sources:**
- Grafana Plugin Developer docs — https://grafana.com/developers/plugin-tools/

### `login_success_ratio` (ratio)
**What it measures:** fraction of form logins (`POST /login`) answered 200, from Grafana's HTTP request histogram: good = `sum(rate(grafana_http_request_duration_seconds_count{handler="/login",method="POST",status_code="200"}[5m]))`, total = the same selector without `status_code`.

**PromQL metrics — what a login moves (measured 2026-09-22, §10):** every successful form login increments `grafana_api_login_post_total`, `grafana_authn_authn_successful_login_total{client="auth.client.form"}` and `grafana_http_request_duration_seconds_count{handler="/login",method="POST",status_code="200"}` by exactly one each (3.009 each over the same hour). Only the HTTP histogram can form a ratio without waiting for a failure to register a series: `grafana_api_login_post_total` / `_oauth_total` / `_saml_total` and `grafana_authn_authn_successful_login_total` count successes only, `grafana_user_login_errors_total` (which the pack named until 2026-09-22) does not exist on 12.4.11, and neither does a `grafana_authn_authn_failed_login_total` (`grafana_authn_authn_failed_authentication_total` counts every failed authentication of any client — API keys, sessions — not logins). The pack also named `grafana_api_login_post` without the `_total` suffix Grafana exposes. **Scope:** form logins only; OAuth and SAML logins return through `/login/<provider>` callbacks and are not in this ratio. **Not verified:** the status code of a failed form login (no failed login was made against the lab).

**Rationale:** sudden drops indicate an IDP outage (Auth0, Okta, Azure AD, Google IAM down) — not Grafana itself. Catching this fast and routing it to identity-team on-call (NOT observability on-call) saves incident triage time. The 7d window reflects that login health is checked weekly in business reviews.

**Sources:**
- Grafana Authentication documentation — https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/
- Production incident retros from Grafana Cloud (publicly summarized)

---

## 2. SLOs — chosen thresholds

| SLO | Objective | Window | Rationale |
|---|---|---|---|
| `http_request_success_99_9` | 99.9% | 30d | Three-nines is the BAU floor; 43 min/month of 5xx tolerance. |
| `datasource_proxy_99_5` | 99.5% | 30d | Slightly relaxed because datasource availability is *partly* upstream-determined. |
| `alerting_evaluation_99_95` | 99.95% | 30d | Tight because rule evaluation failure silently breaks alerting. |
| `database_query_99_p99_500ms` | 99% | 30d | 1% budget covers index rebuilds + planned maintenance. |
| `login_success_99_9` | 99.9% | 7d | Weekly window because IDP outages are weekly cadence events. |
| `plugin_request_99_9` | 99.9% | 30d | Plugin failures shouldn't be common; 99.9% is appropriate. |

---

## 3. Burn-rate windows — Google SRE playbook

All multi-window burn-rate alerts follow the **Google SRE Workbook chapter 5** ("Alerting on SLOs") with table 5-1 windows. SEV1 for fast-burn on user-visible SLOs (HTTP success, datasource proxy, alerting evaluation, login). SEV2 for latency SLOs because latency burn isn't immediately user-impacting.

**Citation:** Google SRE Workbook — https://sre.google/workbook/alerting-on-slos/

---

## 4. Backend choices

### Metrics — Prometheus + Mimir (long-term)
**Rationale:** Grafana exposes `/metrics` in Prometheus exposition format. Mimir for 13mo long-term retention.

### Logs — **Loki** (not Elasticsearch)
**Rationale:** for Grafana's *own* logs, Loki is the natural choice (Grafana-stack-native, supports LogQL which Grafana queries the same way as PromQL). The kafka and prometheus packs use Elasticsearch because they're often deployed in mixed-vendor environments; Grafana's pack uses Loki because Grafana shops typically already have Loki running.

### Traces — Tempo
**Rationale:** same as Prometheus pack; Tempo is the lightweight Grafana-stack-native trace backend. Tail-sampling preserves slow + error traces.

---

## 5. Chaos experiments

| Experiment | Tests | MTTD target | Source |
|---|---|---|---|
| `grafana-pod-kill` | request continuity through restart | 2m | Grafana Labs *operating at scale* notes |
| `grafana-database-slow` | metadata DB latency degradation | 5m | Grafana DB tuning docs |
| `datasource-isolate` | upstream datasource isolation | 2m | Grafana datasource reliability docs |
| `alerting-engine-stress` | rule evaluation under CPU pressure | 5m | Grafana unified alerting at scale post |

All run via Chaos Mesh (CNCF graduated). Steady-state hypothesis ties to the relevant SLO.

---

## 6. Remediation — why one explicit human-only path

The four remediation paths:

- `grafana-http-5xx-burn` → rolling pod restart (safe, idempotent, capped at 2/h)
- `grafana-datasource-proxy-burn` → reload datasource config (safe; reload-only, never modifies)
- `grafana-database-latency-burn` → trigger database vacuum/optimize (safe but slow; 6h cooldown)
- `grafana-login-success-burn` → **explicit `automation: "manual-only"`**

Login failures usually indicate an **IDP outage** (Okta down, Azure AD down). Auto-acting on Grafana itself here risks LOCKING USERS OUT or creating inconsistent state if the IDP recovers mid-action. The right action is human triage with the identity team. The pack declares this explicitly.

---

## 7. Synthetic checks — three layers

The pack declares three complementary synthetic checks:

1. **`grafana-api-canary`** (blackbox-exporter, 30s) — `/api/health` endpoint, asserts database connection is OK. SEV1 on fail.
2. **`grafana-login-canary`** (k6, 5m) — actual login flow with session cookie validation. SEV2 on fail.
3. **`grafana-dashboard-render`** (grafana-synthetics, 5m) — renders an actual dashboard and checks for panel errors. SEV2 on fail.

The three layers detect failures at different abstraction levels: health endpoint catches infrastructure, login canary catches auth integration, dashboard render catches the end-to-end user experience.

---

## 8. What this pack deliberately does NOT cover

- **Multi-tenant operation** — Grafana Cloud SREs handle this with org-isolated SLIs; tier-2 baseline assumes single-org or org-aggregated SLOs.
- **Grafana Image Renderer / reporting** — these are separate services with their own metrics; a future `observability/grafana-image-renderer` pack should cover them.
- **Pyroscope / continuous profiling integration** — covered by a separate `observability/pyroscope` pack when shipped.

---

## 9. Pack lifecycle

- **Last reviewed:** 2026-09-22 (SLI queries measured live on 12.4.11, §10); content review 2026-06-06
- **Review cadence:** monthly (Cowork agent audits citation freshness; quarterly human review)
- **Backward compatibility:** SLI / SLO ids and recording-rule names stable (unchanged on 2026-09-22); three SLI queries were re-pointed at names Grafana exposes
- **Next planned revision:** Grafana 13 — re-run §10 against it

For changes, file a PR against this evidence document AND the pack YAML simultaneously. Reviewers must verify all citations resolve.

---

## 10. Measured live — 2026-09-22

**Where:** the mq-observability-pack lab (loopback-only): Grafana 12.4.11 OSS (`grafana_build_info{version="12.4.11", edition="oss", goversion="go1.26.6"}`), scraped as job `grafana` by Prometheus 3.14.0; `GF_DATABASE_INSTRUMENT_QUERIES=true`; one Grafana-managed alert rule ("Prometheus self-scrape down") evaluating every 10 s; a login canary POSTing `/login` with the committed dev credentials every 5 minutes, first login 2026-09-22T13:52:10Z; the reference pack's recording rules from origin/develop 54223dd loaded as `rules-reference/grafana.recording.yml`. Read-only instant queries against Prometheus, 2026-09-22T14:01Z.

| expression | result |
|---|---|
| `count(grafana_database_query_duration_seconds_bucket)` (the pack's name until this date) | **0 series** |
| `count by (__name__)({__name__=~"grafana_database_queries_duration_seconds.*"})` | `_bucket` 22, `_sum` 2, `_count` 2 series (with `instrument_queries` on) |
| `histogram_quantile(0.99, sum by (le)(rate(grafana_database_queries_duration_seconds_bucket[5m])))` | 1 series, **0.0085 s** (threshold 0.5 s); `sum(rate(…_count[5m]))` 1.83 queries/s |
| `count(grafana_api_login_post)`, `count(grafana_user_login_errors_total)` (the pack's names until this date) | **0 series** each |
| `count by (__name__)({__name__=~"grafana_api_login.*"})` | `grafana_api_login_post_total`, `grafana_api_login_oauth_total`, `grafana_api_login_saml_total`: 1 series each (post 2, oauth 0, saml 0) |
| `count by (__name__)({__name__=~"grafana_authn.*"})` | `grafana_authn_authn_successful_login_total` (1 series, `client="auth.client.form"`, 2), `grafana_authn_authn_successful_authentication_total` (2), `grafana_authn_authn_failed_authentication_total` (1); `grafana_authn_authn_failed_login_total` **0 series** |
| `sum by (status_code)(grafana_http_request_duration_seconds_count{handler="/login",method="POST"})` | 1 series, `{status_code="200"}` = 2 |
| `sum(increase(X[1h]))` for X = `grafana_api_login_post_total`, `grafana_authn_authn_successful_login_total`, `grafana_http_request_duration_seconds_count{handler="/login",method="POST"}` and the same with `status_code="200"` | **3.009 each** — the canary's logins move the three counters identically (the gap between the instant value 2 and the 1 h increase was not investigated; `increase()` extrapolates and handles resets) |
| login ratio: `sum(rate(…{handler="/login",method="POST",status_code="200"}[5m])) / sum(rate(…{handler="/login",method="POST"}[5m]))` | 1 series, **1** (also 1 over 30m) |
| `count by (__name__)({__name__=~"grafana_alerting_rule_evaluation.*"})` | 7 families: `grafana_alerting_rule_evaluations_total` (1), `grafana_alerting_rule_evaluation_failures_total` (1, value 0), `_attempts_total`, `_attempt_failures_total`, `_duration_seconds_{bucket,sum,count}` |
| `sum(rate(grafana_alerting_rule_evaluations_total[5m]))` | 0.100/s (one rule every 10 s); failures 0/s |
| guarded ratio: `(sum(rate(evaluations[5m])) - (sum(rate(failures[5m])) or vector(0))) / sum(rate(evaluations[5m]))` | 1 series, **1** |
| `grafana:database_query:p99_5m`, `grafana:login_success:ratio_5m` (rules of the pack at 54223dd) | **0 series each** — the only empty `grafana:*` records of the 23 loaded; `grafana:alerting_evaluation:ratio_5m` = 1, `error_ratio_5m` = 0 |
| the regenerated `grafana:errorbudget:burn_5m` / `burn_1h` records for `login_success_99_9` and `alerting_evaluation_99_95` (rules/grafana.burn.yml, executed verbatim) | 1 series each, value 0 |

The other SLIs answered on the same run: HTTP success ratio 1, HTTP p99 0.024 s, datasource proxy success 1 and p99 0.0093 s, plugin success 1.

**Not verified in this run:** the status code of a failed form login; OAuth / SAML logins (no IdP in the lab); `grafana_database_queries_duration_seconds` on a Grafana with `instrument_queries` off (expected absent, per the configuration reference — not executed).
