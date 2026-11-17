# grafana-rules

Three Grafana-managed alert rules provisioned as files (`tools/test-grafana-rules.mjs`,
`server/test-service-run.mjs`), and nothing else — no recording rule, so the scan takes the
no-recorded-SLI path:

- `shop.yaml` — the Grafana provisioning format: one group `shop` in the folder titled `Shop`,
  rules `CheckoutErrorRatioHigh` (threshold node `B`), `PaymentsLatencyHigh` (reduce `B`,
  threshold `C` at `> 0.5`) and `CartPodRestarts` (reduce, threshold `> 3`), each with its `uid`.
- `shop.json` — the same export written as JSON (Grafana's alert-rule export offers both).

Their live counterparts, hand-written in the shapes Grafana answers, are `live/ruler.json` (the
ruler API's answer, `GET /api/ruler/grafana/api/v1/rules`) and `live/provisioning.json` (the
provisioning API's, `GET /api/v1/provisioning/alert-rules`), both holding the same three rules with two changes made in Grafana:
`PaymentsLatencyHigh`'s threshold raised to `> 0.8`, and `CartPodRestarts` renamed
`CartPodRestarts #2` (its uid kept). Compared, they are three pairs: one aligned, one drifted on
`condition`, one drifted on `name` (paired by uid) — and nothing declared and not live.

Generic names only (a shop, its checkout, payments and cart).
