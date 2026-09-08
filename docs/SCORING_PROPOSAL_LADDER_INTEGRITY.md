# Scoring proposal — Drift-free reads the ladder integrity

**Status:** proposal — not applied. The engine ships the per-node ladder as an
additive, unscored field (`docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md` §5b);
nothing in this document changes a score until it is accepted through the path
in §5.

## 1. What changes

| Today (gradeSchema 2) | Proposed (gradeSchema 3) |
|---|---|
| `studio/diagnostic-grade.mjs` Drift-free reads `diff.traceabilityGraph.rollup.integrityMean` | Drift-free reads `rollup.ladder.integrityMean` (same 0–1 scale, same `DRIFT_FIDELITY_TRUST_THRESHOLD` ≈ 85%) |
| an aligned node earns full credit whether or not it is doing its job | a node that is present but `present_unhealthy` / `present_stale` earns 0.25 (the drift-credit floor); healthy / alive / exists keep 1 |
| a declared node the vantage could not look for is `declared_only` and penalised as missing | an `unobserved` node (probe family failed or not exposed) leaves the denominator, exactly as `unverifiable` kinds do today |
| a scrape job the fetcher observed down but withheld from Pack B is scored absent | it is scored present-but-unhealthy (0.25) — on the wire beats absent |
| `gradeSchema: 2` | `gradeSchema: 3`, with the schema comment naming this switch and its date |

Everything else — limb weights, drift credit, missing-role weights, the
branch verdict labels, `rollup.integrityMean`, `intact / partial / broken /
undeclared` — stays as it is. `rollup.integrityMean` remains on the record
beside the ladder mean so the discontinuity is explainable run to run.

## 2. Why

Observogram is a monitor of monitors: it assures that observability artefacts
keep doing their job, continuously, with early warning. Two readings of the
current score contradict that thesis.

- **Presence at fetch time is not doing-the-job.** A recording rule the ruler
  reports `health: err` with a `lastError`, or that last evaluated twenty
  minutes ago at a 30s interval, is `aligned` today and earns full credit: the
  declaration matches the rule definition on the wire. The SLI it feeds has no
  data. The grade says the chain is intact while the commitment is unmeasured.
- **A hole in the vantage is not a hole in production.** When an MCP tier does
  not expose `scrape_configs`, or `recording_rules` returns HTTP 502, every
  declared artefact of that kind reads `declared_only` and is scored as missing.
  The score falls because Observogram could not look, and the studio's
  remediation arrow offers to "deploy" artefacts that may well be running. That
  is false assurance in the other direction: a verdict that blames production
  for the instrument's blind spot.

The ladder already carries both distinctions per node (`present_unhealthy`,
`present_stale`, `unobserved`) and per branch (`ladderVerdict`,
`ladderIntegrity`). This proposal only moves the grade's input to it.

## 3. What moves — worked example on the test fixture

`tools/test-traceability-graph.mjs` `completePack()`: one SLO branch, every
node aligned in the healthy live draft. Branch weight sum = 20.7 (slo 3, sli 3,
recording rule 2, three metrics 2 each, burn-rate alert 2, scrape job 1, two
routes 1 each, backend 0.5, metrics exporter 0.5, panel 0.35, dashboard 0.35).

| Scenario (Pack B annotations) | `rollup.integrityMean` (today) | `rollup.ladder.integrityMean` (proposed) | Drift-free today → proposed |
|---|---|---|---|
| healthy draft: rule ok / fresh, target up, both burn rules ok | 1.00 · intact | 1.00 · healthy | pass → pass |
| rule `health: err`, `lastError`, listed in `recording_rules_unhealthy`; SLI in `slis_unhealthy` | 1.00 · intact | 0.8188 · degraded (rule 2 and SLI 3 at 0.25: 20.7 − 0.75·5 = 16.95 / 20.7) | pass → **fail** (82% < 85%) |
| rule ok but `lastEvaluation` 20 min before `refreshedAt` at interval 30s | 1.00 · intact | 0.9275 · degraded (rule at 0.25) | pass → pass, 7 points lower |
| scrape job absent from B, `mcp.probesUnsupported: scrape_configs` | 0.9517 · intact (job scored missing) | 1.00 · healthy (job unobserved, out of the denominator) | pass → pass, 5 points higher |

The first row is the point: today the grade cannot tell a working chain from
one whose rule stopped evaluating. The last row is the mirror: today a tier
that cannot show scrape configs loses 5 points it did nothing to earn.

## 4. Risks

- **Score discontinuity on existing journeys.** Runs recorded under schema 2
  and 3 are not comparable; the `gradeSchema` bump exists so the record can
  say so, and the journey transition logic should treat a schema change as a
  reason, not a regression. (Since slices 3–4 the run record carries
  `transition` and `causes` — `tools/lib/chain-history.mjs` — but neither
  reads `grade.schema`: `diffRunBranches` compares chain verdicts and ladder
  verdicts only, and `rankCauses` knows deploys, drift, versions and stack
  samples. The switch commit should make a schema change visible on the
  record's transition surface rather than leave it as a step the ranker
  cannot explain.)
- **Trust in the on-wire signals.** `health` / `lastError` / `lastEvaluation`
  come from the ruler and target APIs as the MCP relays them. A tier that
  relays rule definitions but not evaluation state reads `alive` / `exists`
  (credit 1), never worse — the ladder only lowers credit on positive evidence
  of unhealth or staleness. Staleness needs both a timestamp and an interval;
  either missing means no judgement.
- **Unobserved leaves the denominator, so a blind tier can score 100%.** The
  branch still reads `ladderVerdict: unobserved`, and the grade's Real-live
  evidence criteria already cap what a partial vantage can claim; the
  proposal should pair the switch with an "unobserved load-bearing nodes"
  line in the Drift-free detail so a perfect score under a blind vantage is
  never silent.
- **Burn-rate linkage by naming convention.** Live POL entries carry no rule
  names, so alert liveness is linked through `<slo>_burn_<factor>x_<short>_<long>`.
  Alerts mapped through labels only cannot be linked and read `exists`.

## 5. Acceptance path (PHASE_1 guardrails)

`docs/PHASE_1_VERDICT_TRUST_RESEARCH.md` forbids re-weighting drift fidelity
without a separate, maintainer-reviewed scoring proposal. This is that
proposal. To apply it:

1. Maintainer review of this document by PR — no direct push to `develop`.
2. One commit that (a) switches the Drift-free input in
   `studio/diagnostic-grade.mjs`, (b) bumps `gradeSchema` to 3 with a dated
   comment, (c) extends `tools/test-diagnostic-grade.mjs` with the four rows of
   §3 and (d) updates `docs/DIAGNOSTIC_GRADE_FRAMEWORK.md` / CHANGELOG. No other scoring
   arithmetic changes in that commit.
3. Re-run the golden crawl and compile suites; only the grade snapshot rows
   whose fixtures carry `mcp.observed.*` or `mcp.probes*` annotations may move,
   and each move must be explainable by one row of §3.
4. Verification, not validation: the switch makes the verdict more honest
   about the instrument's own evidence; it does not make the verdict validated
   against incident ground truth, and the studio copy must keep saying so.
