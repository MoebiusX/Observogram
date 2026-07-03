# Slide notes — Quality Gates (CTO / board, 2026-06-12)

*Companion to `observogram-quality-gates-{light,dark}.png` and the updated
architecture diagrams. Every number below is verified at HEAD `795f122`
and enforced in CI — nothing on these slides is aspirational.*

## The one-sentence story

> Observogram no longer asks you to trust its output — **every artifact it
> compiles is accepted by the real backend's own validator, and the full
> compile → deploy → verify loop runs against a live Grafana on every
> push.**

## Slide 1 — the gates (use the quality-gates PNG)

Talk track, ~90 seconds:

1. **Eight gates, two halves.** The compile path (author → live) and the
   verify loop (live → verdict). Every hand-off between components has
   an input/output contract that CI enforces — a pack can't enter the
   catalog without validating against the pinned spec schema (G1), and a
   grade can't say PASS below the 85% audit bar (G8).
2. **G3 is the new muscle.** Until this week our compiler output was
   checked by shape tests. Now every emitted artifact — Prometheus
   rules, Alertmanager configs, OTel Collector configs — must be
   accepted by **that platform's own validator**: promtool 3.5.3 LTS,
   amtool 0.32.2, otelcol-contrib 0.154.0, all version-pinned and
   sha256-verified. 165 artifacts across 8 packs, including adversarial
   fixtures, strict on every push.
3. **G6 closes the product story.** In CI we spin up a real Grafana
   12.4.4, deploy through the production deploy path, fetch the live
   state back through the production fetcher, and run our own diff
   engine on the result: **24/24 deployed artifacts confirmed live,
   zero decision-bearing drift.** The tool's core promise — "what you
   declared is what's running" — is now a test we pass, not a claim.

## Slide 2 — what the gates caught (the credibility slide)

The honest punchline: **the gates paid for themselves on their first
run.** Nine real compiler bug classes, none visible to shape tests, all
fixed same-day and locked by regression tests:

| Found by | Bug | Blast radius |
|---|---|---|
| promtool | burn-rate alerts emitted invalid PromQL | every ratio SLO, every pack |
| amtool | secrets emitted as pseudo-comment "URLs" + invalid fields | **every** Alertmanager config rejected |
| live Grafana | rule-uid truncation collisions — deploys silently overwrote each other | only the last rule survived; deploy reported success |
| live Grafana | dashboard uids over the 40-char limit | all dashboard deploys rejected |
| otelcol | removed `jaeger` exporter emitted verbatim; empty required blocks | collector refuses to load |
| otelcol | signal-restricted components in wrong pipelines | collector refuses to load |
| promtool | unicode ids broke rule names + ref resolution | hostile-name packs |
| promtool | scalar SLI legs range-selected (`rate(1[5m])`) | live-drafted packs |
| diff engine | round-trip identity loss — deployed dashboards diffed as missing forever | fixed with `obs-pack-id` provenance tag |

Framing for the board: *"This is what it looks like when a tool tests
itself against reality instead of against its own opinions. The silent
rule-overwrite bug is the one to mention — the deploy reported success
while Grafana quietly kept one rule out of four. No human review would
have caught that; the live round trip did, in its first hour."*

## Numbers box (all CI-verified @ 795f122)

- **19** test suites, lint **0 errors**, golden output gate, dep audit
- **165** artifacts × **8** packs through backend validators (T1), strict
- **24/24** deployed artifacts confirmed live, **0** decision-bearing drift (T4)
- validators pinned + sha256-verified: promtool **3.5.3 LTS** · amtool **0.32.2** · otelcol-contrib **0.154.0** · Grafana **12.4.4**
- **9** compiler bug classes caught by the gates' first runs, fixed same-day
- zero runtime dependencies added — validators are fetched dev tooling

## Honesty footnotes (if asked)

- The MCP gateway bridge in the T4 job is the only test scaffolding;
  every other layer under test is production code.
- Studio UI views are still not unit-tested (the red note on the
  architecture diagram) — engine and round trip are where the guarantees
  live today.
- Remaining planned gates: **T2** (Grafana 13 version matrix,
  dashboard-linter, mimirtool for the "Mimir-compatible" claim) and
  **T3** (behavioral `promtool test rules` — alerts proven to fire on
  synthetic breach data). Both scoped in
  `docs/TEST_PLAN_COMPILER_VALIDITY.md`, ~2 days.
