# Functional Spec — Requirement-Rooted Derivation-Graph Comparison

**Status:** design for implementation
**Replaces / augments:** the flat per-artefact set diff in `tools/lib/diff.mjs` (kept for cross-cutting leaves; see §8).
**Why:** the flat diff answers "do the two bags of artefacts overlap?" The diagnostic question is "for each reliability commitment, is its full derivation chain — requirement → telemetry → insight → action — present and matching live?" This spec defines the comparison that answers the second question. It maps directly onto the spec's L1→L4 consumption hierarchy and onto the existing Traceability drawer (REQUIRES / USED BY / DATA SOURCES / RULE LOGIC / DASHBOARDS).

No new pack shape is required. Everything below is computed from fields the adapter already attaches (`defines`, `refs`) and the canonical reference fields the spec already defines.

---

## 1. Core concept

For each **requirement root** (an SLO, or an SLI with no SLO), assemble the **derivation branch** — the transitive closure of artefacts that derive from or serve that requirement. Compare branch_A(R) against branch_B(R) **structurally** (node-by-node, by role + behavioural identity), and emit a per-requirement **chain-integrity verdict**. Roll up to: *"N of M reliability commitments have a fully intact, live-verified chain."*

Artefacts that belong to **no** requirement branch (cross-cutting telemetry: backends, pipelines, storage) are compared by the existing flat diff. A live artefact in no branch is the true **shadow** signal.

---

## 2. Data model

```
DependencyGraph {
  nodes: Map<nodeKey, Node>
  edges: Edge[]
}
Node {
  key        // behavioural identity key from identityKeyOf() (artefact-model.mjs)
  kind       // classify() family: sli | slo | recording_rule | metric | backend
             //   | burn_rate | forecast | panel | dashboard | alert_route
             //   | remediation | chaos | synthetic | otel | storage | pipeline_*
  layer      // L1 | L2 | L2X | L3 | L4 | L5 | GOV
  behavior   // behaviorOf() — canonicalised spec, for aligned/drifted decision
  artefact   // back-reference to the adapted artefact
}
Edge {
  from, to     // nodeKeys
  type         // see §3 (sli_of, materialises, protects, visualises, routes, remediates, sources, validates)
  provenance   // 'declared' (explicit ref field) | 'inferred' (heuristic match)
}
```

`identityKeyOf`, `behaviorOf`, `classify` already exist in `tools/lib/artefact-model.mjs` and are the node primitives. The new module only adds **edges** and **branch assembly**.

---

## 3. Edge resolution (the load-bearing part)

Edges come from canonical reference fields and from executable declarations. Each edge is tagged `declared` when it comes from an explicit reference, `derived-promql` when recovered by parsing a PromQL expression, and `inferred` only when resolved by a heuristic such as name similarity. A chain held together by inference is lower-confidence and must be reported as such; a chain held together by parsed executable config is a high-confidence derived chain.

| Edge `type` | From → To | Source field (declared) | Inferred fallback |
|---|---|---|---|
| `sli_of` | SLO → SLI | `slo.sli` (`ref:slis.X` / `slis.X`) | — (always declared) |
| `materialises` | recording_rule → SLI | `rule.expr` = `ref:slis.X` | rule `name` ≈ SLI's `good`/`total`/`query` series |
| `sources` | SLI/recording_rule → metric series | series names parsed from `expr`/`good`/`total`/`query` (`derived-promql`) | metric-name match |
| `produced_by` | metric → backend | `ref:telemetry.backends.X`, or signal→backend wiring | product/signal of the emitting backend |
| `protects` | burn_rate alert → SLO | `policy.burn_rate_alerts[].slo` | — |
| `forecasts` | forecast → SLO | `policy.forecasts[].slo` | — |
| `visualises` | panel → SLI/SLO | `dashboards[].panel_bindings[].binds_to` | — |
| `contains` | dashboard → panel | structural (panel belongs to dashboard) | — |
| `routes` | alert_route → burn_rate alert | `route.match` / severity correlation | severity match (weak) |
| `remediates` | remediation → alert | `remediation[].trigger` (alert id) | — |
| `validates` | chaos/synthetic → SLO | `validation.chaos_experiments[].steady_state_hypothesis` (`ref:slos.X`); `expected_alerts[]` | — |

**Requirement:** the resolver must record `provenance` per edge. Where the crawler currently emits `INFERRED` badges (Traceability drawer), those become `provenance: 'inferred'` edges. PromQL-derived metric edges are `provenance: 'derived-promql'`; they are not fuzzy matches.

---

## 4. Branch assembly

```
buildBranch(graph, rootKey) -> Branch
```
1. Start at the requirement root (SLO; if the SLI has no SLO, root at the SLI).
2. Follow edges **outward by role** to collect the expected chain:
   - SLO → SLI (`sli_of`) → recording_rule (`materialises`) → metric (`sources`) → backend (`produced_by`)
   - SLO → burn_rate alert (`protects`) → alert_route (`routes`) → remediation (`remediates`)
   - SLO → forecast (`forecasts`)
   - SLO → panel (`visualises`) → dashboard (`contains`)
   - SLO → chaos/synthetic (`validates`)
3. The branch is a **DAG**, not a tree: shared leaves (a backend, a metric) may appear in many branches. Keep them; dedup within a branch.
4. Record, per branch, the **expected roles** present vs absent (a branch with an SLI + recording rule + SLO but **no alert** has a broken action limb).

Roots present in A, in B, or both are all assembled (a requirement that exists only live → an undeclared-requirement branch).

---

## 5. Branch comparison

```
compareBranch(branchA, branchB) -> BranchVerdict
```
Align nodes by `(role, identityKey)` within the branch (not globally — this is what fixes the alert-route/severity collapse and the panel flood). For each expected node:

| Node status | Meaning |
|---|---|
| `aligned` | present both sides, `behaviorOf` equal |
| `drifted` | present both sides, behaviour differs (carry the diverging fields from `deltasOf`) |
| `declared_only` | in A's branch, absent in B's branch **and** the node type is live-verifiable (§6) → genuine missing-in-live |
| `unverifiable` | in A's branch, absent in B, but the node type is **not** live-introspectable (§6) → neutral, not a gap |
| `live_only` | in B's branch, absent in A → genuine drift/shadow *within a declared requirement* |

Edges carry through: an edge present in A but absent in B (e.g. the SLO→alert link missing live) is a **broken limb**, scored by the limb's role weight (§7).

### 5b. Per-node ladder (additive, unscored)

Beside `status`, every node verdict carries `ladder: { rung, status, detail }`, read from the on-wire liveness the live fetcher writes into Pack B's annotations (`mcp.observed.scrape_targets` / `recording_rules` / `alert_rules`; the `mcp.discovered.*_unhealthy` and `scrape_jobs_down` lists; `mcp.probesFailed` / `mcp.probesUnsupported` with `mcp.probeErrors.<family>`; `mcp.refreshedAt` as "now"). It answers the monitor-of-monitors question the scored status cannot: is the artefact merely present, or doing its job — or could the vantage not look at all.

| `ladder.rung` | `ladder.status` | Meaning |
|---|---|---|
| `unobserved` | `unobserved` | declared, absent from B, and the probe family that would carry the kind failed or is not exposed by this MCP tier — the vantage could not look; never "absent" |
| `unobserved` | `null` | `unverifiable` kind — not live-introspectable from any MCP vantage |
| `absent` | `null` | declared, absent from B, and the probe family answered without it (or B is file-sourced) |
| `exists` | `null` | present; no liveness field on the wire for the kind (metric, panel, route…), or Pack B is not a live draft |
| `exists` | `present_unhealthy` | present, but the ruler/target reports it unhealthy: health not ok / down, a `lastError`, or the name is in the matching `*_unhealthy` / `scrape_jobs_down` list |
| `exists` | `present_stale` | present and healthy, but `lastEvaluation` / `lastScrape` is older than 2× the artefact's interval at `mcp.refreshedAt` |
| `alive` | `null` | observation present and fresh, health not reported (or a backend that answered its version probe) |
| `healthy` | `null` | observation present, health ok/up, no `lastError`, fresh (interval unknown → staleness not judged) |

Evidence rules: scrape_job ↔ `scrape_targets` by `job`; recording_rule ↔ `recording_rules` by `name`; burn_rate ↔ `alert_rules` by the compiler's `<slo>_burn_<factor>x_<short>_<long>` naming convention on the SLO id, narrowed to the declared windows (the live POL entry carries no rule names); sli → `present_unhealthy` iff its id is in `slis_unhealthy`, else `exists` ("liveness rides on its recording rules"); slo → `exists` (declaration); backend → `alive` when `mcp.versions.<product>` is present. Kind → probe family: scrape_job → `scrape_configs`, recording_rule → `recording_rules`, burn_rate → `alert_rules`, metric → `metric_names`, panel/dashboard → `dashboards`, sli/slo → `recording_rules` OR `metric_names` (unobserved only when both are gone); backends have none (the version probes run outside the probe cascade). A `declared_only` artefact the fetcher observed but withheld from Pack B (a scrape job whose every target is down) reads from the observation, not `absent`. Intervals accept `10s` / `5m` / `1h` / plain seconds, B's value first then A's; a missing interval means no staleness judgement. Without any `mcp.` annotation every present node is `exists` — "no on-wire liveness (Pack B is not a live draft)".

Per branch: `ladderVerdict` — `broken` (a load-bearing node absent, or a load-bearing role missing) > `degraded` (a load-bearing node present_unhealthy / present_stale, or any node drifted) > `unobserved` (a load-bearing node unobserved) > `healthy`; `undeclared` for live-only branches. `ladderIntegrity` / `ladderIntegrityPct` use the §7 weights: healthy / alive / exists credit 1, drifted keeps its drift credit (capped at 0.25 when also unhealthy or stale), present_unhealthy and present_stale credit 0.25, absent credit 0, unobserved nodes leave the denominator (as unverifiable ones do), missing roles as in §7. `rollup.ladder = { healthy, degraded, broken, unobserved, integrityMean, integrityPct }` over declared branches.

The scored quantities — `integrity`, `verdict`, `counts`, node `status`, `rollup.integrityMean` and the grade's Drift-free criterion — are unchanged by the ladder, pending `docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md`.

### 5c. Blast radius (additive)

Beside `status` and `ladder`, every node verdict carries `blastRadius` — the **structural exposure** of that node, computed from the declared edges by the zero-import `tools/lib/blast-radius.mjs` (`docs/VENDORING.md`): what WOULD go blind (its transitive consumers) and what WOULD lose protection if the node died. It is never a claim that anything IS blind — liveness is the ladder's business (§5b), and the module never reads it.

Assurance flows along the declared edges; the **consumer** is the side that goes blind when the other side dies. For every edge type the consumer is the `from` side, except `materialises`, where the SLI consumes the recording rule's series:

| edge type | from → to | consumer |
|---|---|---|
| `sli_of` | slo → sli | `from` (the SLO consumes its SLI) |
| `materialises` | recording_rule → sli | `to` (the SLI consumes the rule's series) |
| `sources` | sli \| recording_rule → metric | `from` |
| `exported_by` | metric → scrape_job \| exporter | `from` |
| `produced_by` | metric → backend | `from` |
| `protects` | burn_rate → slo | `from` (the alert consumes the SLO's data path) |
| `forecasts` | forecast → slo | `from` |
| `visualises` | panel → sli \| slo | `from` |
| `contains` | dashboard → panel | `from` |
| `routes` | alert_route → burn_rate | `from` |
| `remediates` | remediation → burn_rate | `from` |
| `validates` | chaos \| synthetic → slo | `from` |

**Protection** is a second, separate relation (`PROTECTION_SIDE`): the `to` side loses when the `from` side dies — an SLO loses its protection when its alert dies (`protects`), an alert loses delivery when its route dies (`routes`) and its remediation when the remediation dies (`remediates`). It is transitive: a dead route means an undelivered alert means an unprotected SLO. Edge types outside the tables carry no known direction and are ignored; edges whose endpoints are unknown are dropped. Scaffold placeholders never blind anything, are never traversed and are never listed. The walk is breadth-first over the reverse adjacency, cycle-safe, with deterministic ordering (hop, then `KIND_ORDER` — slo, sli, burn_rate, recording_rule, metric, scrape_job, backend, alert_route, remediation, forecast, panel, dashboard, chaos, synthetic — then label, then key).

On the node verdict only the **summary** rides: `blastRadius: { slos, alerts, panels, dashboards, routes, remediations, total } | null` — `slos` counts the SLOs that would go blind plus those that would lose protection, `alerts` the burn-rate alerts that would go blind plus those that would lose delivery or remediation, `panels` / `dashboards` / `routes` / `remediations` the blinded ones by kind, `total` every blinded node plus the unprotected SLOs and alerts; `null` when the graph index has no entry for the node. `compareBranches` computes the index once per graph (`blastRadiusIndex(graphShape(graph))`): the A-graph index serves `aligned` / `drifted` / `declared_only` / `unverifiable` nodes, the B-graph index `live_only` ones. The full result — `blastRadiusOf(shape, key)` → `{ key, kind, label, blinded: { total, weight, byKind, nodes: [{ key, kind, label, hop }] (listing capped at 64; `total` and `byKind` uncapped) }, unprotected: { slos: [{ key, label, hop }], alerts: [...] }, summary }` — is available to any caller through `graphShape(graph)`; `weight` sums the §7 limb weights over the blinded nodes (unknown kind 0.5).

Consumers: `studio/compare-view.mjs` appends `· blinds N SLO(s)` to `declared_only` / `drifted` nodes in the chain-card evidence line (a node that is missing or wrong live is the case where the exposure matters; an aligned node's exposure is not shown); `tools/lib/chain-history.mjs` keeps the summary on every degraded node of a journey run record, orders ties by `total` and picks the run's `topExposure` (most `slos`, then `alerts`, then `total`). Nothing here touches `integrity`, `verdict`, `counts`, node `status` or `rollup.integrityMean`.

---

## 6. Live-verifiability map (must be explicit)

Not every node type can be reconstructed from the live MCP vantage. Folding "live can't see it" into "declared-not-live" is the current scoring bug. Define per node type:

| Node kind | Live-verifiable from MCP? |
|---|---|
| sli, slo, recording_rule, metric, backend, burn_rate alert | **yes** |
| alert_route, remediation, forecast | partial (depends on connector) |
| panel, dashboard | **no** (live exposes dashboards opaquely, not panel bindings) |
| chaos, synthetic | depends on validation connector |

A `declared_only` node of a **not-verifiable** type → status `unverifiable` (excluded from the drift penalty; surfaced separately as "declared, can't confirm from this vantage").

---

## 7. Verdict & scoring

**Per-branch integrity** = weighted fraction of the expected chain that is `aligned` (with `drifted` partial-credited, `unverifiable` excluded from the denominator):

```
limbWeight: contract(sli/slo)=highest, detection(rule/metric/alert)=high,
            response(route/remediation)=medium, visualisation(panel/dashboard)=low,
            validation(chaos/synthetic)=medium
branchIntegrity(R) = Σ aligned·w + drifted·w·driftCredit
                     ────────────────────────────────────
                     Σ (verifiable expected nodes)·w
```

**Branch verdict label** (for UI + talk):
- `intact` — every load-bearing limb (contract + detection + action) aligned in live.
- `partial` — chain present but ≥1 limb drifted.
- `broken` — a load-bearing limb (`declared_only` of a verifiable type, e.g. SLO has no live alert) missing → the commitment is not actually protected live.
- `undeclared` — branch exists only live (a real requirement running with no repo declaration).

**Roll-up (the headline):** `intactCount / declaredRequirementCount` — "8 of 10 SLOs have a fully intact, live-verified protection chain." This replaces the flat 65/14/15/51 as the trust signal and feeds the grade's drift-free criterion (§8).

---

## 8. Integration

- **Grade.** `computeDiagnosticGrade`'s drift-free criterion (currently weighted-fidelity over flat buckets) takes its value from **branch integrity roll-up** instead: `drift-free.score = mean(branchIntegrity over declared requirements)`. Same fractional-credit mechanism already wired; new input.
- **Hybrid with flat diff.** Cross-cutting leaves not reachable from any requirement root (backends/pipelines/storage with no `produced_by`/`sources` edge into a branch) stay in the flat `diffPacks` path. A **live leaf in no branch = shadow** (the platform fleet) — reported, low-weighted, candidate for `outOfScope`.
- **Provenance surfaces.** Branch verdicts must show edge provenance: an `intact` branch held together by `inferred` edges is reported as "intact (inferred)" — lower confidence than "intact (declared)."

---

## 9. API surface

New module `tools/lib/traceability-graph.mjs`:
```js
export function buildDependencyGraph(adaptedPack) -> DependencyGraph
export function requirementRoots(graph) -> nodeKey[]        // SLOs, then SLI-without-SLO
export function buildBranch(graph, rootKey) -> Branch
export function compareBranches(graphA, graphB) -> {
  branches: BranchVerdict[],          // one per union of roots
  rollup: { intact, partial, broken, undeclared, declaredTotal, integrityMean },
  crosscutting: <delegated to diffPacks for unattached leaves>
}
```
`diffPacks` gains an optional structural pass; the studio's Diagnose view renders `branches` (per-requirement chain cards) above the flat buckets.

Additive since 2026-09 (§5b, §5c; keys only ever added, never renamed or removed):
```js
export function graphShape(graph) -> {          // the artefact-free projection the zero-import blast-radius module reads
  nodes: [{ key, identityKey, kind, layer, label, virtual, scaffold }],
  edges: [{ key, from, to, type, provenance }],
}
// on every node verdict, appended after `deltas`:
//   blastRadius: { slos, alerts, panels, dashboards, routes, remediations, total } | null   (§5c)
//   ladder: { rung, status, detail }                                                       (§5b)
// on every BranchVerdict, beside verdict / integrity / integrityPct:
//   ladderVerdict: 'healthy' | 'degraded' | 'broken' | 'unobserved' | 'undeclared'
//   ladderIntegrity, ladderIntegrityPct
// on rollup, appended last:
//   ladder: { healthy, degraded, broken, unobserved, integrityMean, integrityPct }
```
`tools/lib/blast-radius.mjs` (zero-import) exports `CONSUMER_SIDE`, `PROTECTION_SIDE`, `KIND_ORDER`, `DEFAULT_WEIGHTS`, `BLINDED_NODES_CAP`, `normalizeGraphShape(input)`, `blastRadiusOf(shape, key, { weights })` and `blastRadiusIndex(shape, { weights })` → `Map key → summary` (non-scaffold nodes, sorted key order). The scored quantities are pinned byte-identical with and without these fields (`tools/test-traceability-graph.mjs`).

---

## 10. Tests required (no fabricated packs — use the real example packs)

In `tools/test-diff.mjs` / a new `tools/test-traceability.mjs`, against the **bundled** `examples/*.pack.yaml`:
1. **Edge resolution:** `payment-service.pack.yaml` — assert each SLO resolves a declared `sli_of` edge; each burn-rate resolves a `protects` edge to its SLO; each panel `binds_to` resolves a `visualises` edge.
2. **Provenance:** assert edges from explicit `ref:`/`binds_to`/`slo:` are `declared`; series-name-matched edges are `inferred`.
3. **Branch assembly:** for a known SLO, assert the branch contains the expected roles (sli, recording_rule, burn_rate, panel) and no foreign nodes.
4. **Self-comparison:** `compareBranches(pack, pack)` → every branch `intact`, integrityMean = 1.0 (the reflexivity guard, analogous to the diff self-test).
5. **Verifiability:** a pack whose SLO has a panel but the "live" side lacks panel introspection → panel node `unverifiable`, **not** `declared_only`; branch still `intact`.
6. **Broken limb:** a pack whose SLO has no burn-rate alert → branch `broken` on the action limb.

---

## 11. What this fixes (traceable to the forensic findings)

- **Alert-route severity collapse** → routes compared inside their SLO's branch, not globally by severity. The "7 phantom declared-not-live routes" disappear.
- **Dashboard-panel flood** → panels are `unverifiable` leaves, not `declared_only` drift. Stops tanking the score for something live can't expose.
- **Backend version skew** → backends are shared infra leaves, low limb-weight; a version delta on a leaf can't sink a contract branch.
- **Platform shadow fleet** → backends in no branch are cleanly `shadow`, separable from in-branch drift.
- **The verdict** → per-commitment chain integrity, which is the *validity* question (does the declared machinery actually produce the reliability it claims), not artefact overlap.

---

## 12. Open decisions (call before building)

1. **Root set:** SLOs only, or SLOs + standalone SLIs + standalone alerts? (Recommend: SLO-rooted, with SLI-without-SLO and alert-without-SLO as degenerate single-limb branches so nothing is uncounted.)
2. **Inferred-edge confidence:** report-only, or down-weight branch integrity when the chain leans on inferred edges? (Recommend: report first; down-weight once edge inference is measured.)
3. **outOfScope boundary:** which unattached live leaves count as shadow vs out-of-scope platform inventory (ties to the env-scoping work).
