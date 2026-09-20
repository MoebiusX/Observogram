# ObservabilityPack Spec v1.2 — Limitations & Proposed Additions

**Reviewed:** spec v1.2 (`spec.md`, `docs/maturity-model.md`, `observability-pack.schema.json`, commit `d13532b`)
**Lens:** platform-engineering / SRE adoption at scale
**Verdict:** Strong, unusually coherent standard. The gaps are mostly at the edges where a *declarative manifest* meets *running reality*, *cost*, and *cross-service* concerns — not in the core L1–L5 model.

---

## 1. What v1.2 already gets right

Worth stating, because it scopes the critique. The model is coherent (one service = one pack, strict L1→L4 consumption hierarchy, L5 validates the chain). The schema is **tighter than most real-world standards**: multi-window burn alerts are schema-enforced (`windows minItems: 2`, `factor exclusiveMinimum: 1`), SLO `objective` is bounded `0 < x < 1`, SLI requirements are *type-conditional* via `if/then` (a `ratio` SLI must carry `good`/`total`), and `resource_attributes.required` must `contain` `service.name`. Validation (chaos + synthetic) is a first-class MUST, not an afterthought — which is the standard's single best idea. The maturity rubric is cumulative, machine-checkable, and tied to an exception process with compensating controls.

So the following are refinements toward v1.3/v2.0, not corrections.

---

## 2. The headline gap: the spec verifies *manifests*, not *running systems*

This is the most important limitation. §8 conformance "scans every registered pack" — but it scans the **manifest**, statically. A pack can score 100% MUST-conformant and be completely drifted from the deployed system: the dashboard was hand-edited, the alert was silenced in Alertmanager, the chaos schedule is failing every run. The standard has **no concept of "verified" vs "declared"**, no freshness/attestation primitive, and no requirement that conformance evidence be *recent*.

That this exact gap is what Observogram's "diagnostic grade" had to bolt on (declared-vs-verified, `mcp.refreshedAt`, drift tolerance) is the tell: the trust model lives in the renderer, not the spec.

**Add — an attestation/evidence block as a first-class L5 concern:**

```yaml
attestation:
  last_verified: 2026-06-08T14:00:00Z      # set by the operator/scanner, not the author
  evidence:
    chaos:     { last_pass: 2026-06-02, expected_cadence: weekly }
    synthetic: { last_pass: 2026-06-08T13:59Z }
    drift:     { reconciled: true, source: mcp, probes_ok: 18, probes_total: 18 }
  freshness_window: 24h                      # conformance MUST require evidence within window
```

Then add a MUST: *a tier-1 pack's verification evidence must be within its freshness window* — turning conformance from "the YAML says so" into "the system proved it recently." This is the difference between an audit artifact and a clean scan of a body that has since changed.

---

## 3. Missing dimensions (model coverage)

### 3.1 Cost / cardinality governance is not first-class
Cardinality appears only as a SHOULD on scrape jobs (§5.2) and a CI "estimation against staging" (§6.2). There is **no cost dimension** — no per-signal spend budget, no enforced cardinality ceiling, no retention-cost tradeoff. Telemetry cost is now a top-three platform concern, and the reference packs themselves carry `finops_*` SLIs, so the need is already visible in practice. Add a `cost` block (per-signal budgets, cardinality limits with `gating: enforce`, sampling/retention levers) and a tier-1 MUST that high-cardinality metrics declare a budget.

### 3.2 Data governance / PII classification is unstructured
PII handling exists only as prose MUSTs ("declare a redaction pipeline"). For a standard whose audience explicitly includes "security & compliance" and whose §8 feeds SOC 2 / ISO 27001 / GDPR audits, there is no structured `data_classification` block: which fields are PII/PCI/PHI, data residency, lawful basis, retention-by-class. Auditors get the manifest; the manifest can't actually answer "where does PII flow and how long is it kept."

### 3.3 No dependency / service-graph dimension
A pack is one service, but reliability is cross-service. Alerting has a `dependency_outage` suppression context — but **nothing declares the dependencies** it would key off. There is no way to name upstreams (by pack ref), their expected SLOs, or how a dependency's burn correlates to yours. Add a `dependencies` block so error-budget math and correlated alert-suppression can span packs.

### 3.4 No real-user / client-side (RUM) surface
The model is server-side. "Customer-impact" is only a *dashboard* requirement; there is no client-side dimension (page-load, web-vitals, journey funnels). When we reconciled the KrystalineX pack, the UX layer was empty across both the crawl and the live draft precisely because the spec gives it nowhere to live. Add a `rum` / client-experience surface with journey SLIs.

### 3.5 No composite / journey SLOs
SLOs are strictly per-service. Real user journeys (checkout, settlement) span services, but the model can't express a composite SLO that aggregates SLIs across packs. This is the natural home for §3.3's "domain SLI" once services compose.

### 3.6 Batch/streaming are in-scope but under-served
§2 includes batch jobs and platform components, but the SLI vocabulary (`ratio`/`threshold`/`distribution`/`custom`) and the availability+latency MUSTs assume request/response. Freshness, completeness, watermark lag, and consumer lag deserve named SLI types or a documented pattern, or batch services will all land in `custom` and escape rubric coverage.

---

## 4. Reliability-model gaps

### 4.1 `error_budget_policy` is a dangling reference
Every SLO MUST reference an `error_budget_policy`, but the schema types it as a bare `string` and **the spec never defines the object it points to**. What does `ref:platform/default-budget` contain — burn thresholds, freeze actions, who's notified, reset semantics? The single most consequential L1 control is unmodeled. Define an `ErrorBudgetPolicy` object (inline or platform-imported) with actions per burn threshold.

### 4.2 No alert inhibition / dependency modeling
Suppression has three coarse contexts but no inhibition rules (a parent alert silencing its children) — a primary driver of alert storms and a native Alertmanager feature left unexpressed.

### 4.3 Ownership is a flat list
`owners` is `[team-slug]`. There is no on-call schedule reference, no escalation policy, no per-severity owner. Alerting routes to *channels* but never to *who* — which is where most "the alert fired and nobody owned it" post-mortems actually land.

---

## 5. Schema vs. prose: enforcement gaps

The schema is good, but several MUSTs live only in prose or the daily scanner, not in CI-time schema:

- **SemConv floor.** `otel.semconv` is pattern-checked (`X.Y.Z`) but the `>= 1.26.0` floor (§5.3 MUST) is **not** in the schema — it's prose + scanner only.
- **Cross-reference integrity.** `binds_to`, `ref:`, `trigger:` resolution is explicitly lint-only (§6.2). Acknowledged, but it means a schema-valid pack can be referentially broken — most consumers will need to re-implement the resolver (as the studio did).
- **`resource_attributes.required` is enum-locked** to 8 values. A team can't declare a genuinely service-specific required attribute as "required" without it being demoted to free-text `custom`.
- **The rubric isn't shipped as data.** The 29-clause maturity model is a markdown table plus a sample `packscan-result.yaml`. Every implementer re-encodes the clauses (Observogram hand-curated them in `conformance.mjs`). Ship a machine-readable `rubric.yaml` (clause id, tier, MUST/SHOULD, JSON-path/CEL check, `introduced_in`, `enforced_from`) as the canonical artifact so scanner and studio share one source of truth — and so the §8 "90-day grace window" for new clauses is actually implementable.
- **The product registry isn't shipped.** §5.12.1 promises an "open product registry recognised by lint," but no registry file exists in the repo — implementers guess valid `product` slugs.

---

## 6. Portability: the "abstract model" leaks its binding

The spec claims a binding-independent model with pluggable bindings (§1.2), but **MUST clauses hard-code the default stack**: maturity 2.2 requires `exporters.metrics.kind == "prometheusremotewrite"`, 1.2 requires logs/traces `kind == "elasticsearch"`, alerting checks look for `msteams:`/`voice:`. A second binding (`otel-grafanalabs`, `otel-aws-managed`) cannot satisfy the rubric without editing the rubric. Either lift the conformance checks to binding-neutral predicates (e.g. "a metrics exporter from the binding's allowed list") or make the rubric binding-parameterised. Until a second binding actually exists, the abstraction is untested and the leak is invisible.

---

## 7. Lifecycle & ergonomics

- **Clause lifecycle isn't expressed as data** (see §5). `introduced_in` / `enforced_from` per clause is what makes the grace-window policy real.
- **No `spec.imports` semantics defined.** `metadata.imports` and `imports` appear in the manifest shape, but inheritance/override resolution order is never specified — critical once platform-default packs exist.
- **Emergency-change (§6.5) has no manifest trace.** A hotfix with reduced review should stamp the pack (annotation) so the 24-hour "return to standard review" is auditable rather than tribal.

---

## 8. Prioritized recommendations

| # | Addition | Why it matters | Target | Effort |
|---|---|---|---|---|
| 1 | **Attestation/evidence block + freshness MUST** | Closes the declared-vs-verified gap; makes conformance mean the system, not the YAML | v1.3 | M |
| 2 | **Ship the rubric as machine-readable data** (clauses + `introduced_in`/`enforced_from`) | One source of truth for scanner + studio; makes the grace-window real | v1.3 | S |
| 3 | **Define `ErrorBudgetPolicy` object** | Removes the dangling ref on the most important L1 control | v1.3 | S |
| 4 | **`cost` / cardinality dimension** | Top platform concern; already implied by finops SLIs | v1.3 | M |
| 5 | **`data_classification` block** | Makes SOC2/ISO/GDPR claims answerable from the manifest | v1.3 | M |
| 6 | **`dependencies` block + cross-pack suppression** | Reliability is cross-service; activates the existing `dependency_outage` context | v2.0 | L |
| 7 | **RUM / client-experience surface + composite journey SLOs** | The genuinely missing layer (UX), proven empty in practice | v2.0 | L |
| 8 | **Ownership/escalation as data** (on-call ref, per-severity owner) | Fixes "fired and nobody owned it" | v1.3 | S |
| 9 | **Pull binding specifics out of MUST clauses** | Makes multi-binding real instead of aspirational | v2.0 | M |
| 10 | **Ship the product registry; add semconv floor to schema** | Removes guesswork; shifts a prose MUST into CI | v1.3 | S |

**If only three land in v1.3:** #1 (attestation), #2 (machine rubric), #3 (error-budget object). The first makes conformance honest, the second makes it portable across tools, the third closes the biggest hole in the core model — and all three are low-to-medium effort.

---

## 9. One structural observation

The recurring theme across §2, §4.1, and §6 is the same: **v1.2 is an excellent description of a desired state, but thin on the machinery that ties the description to reality** — attestation, error-budget semantics, cross-service edges, binding neutrality. That's exactly the seam a renderer/scanner (Observogram) is currently papering over. Folding those primitives back into the spec is what would let *any* conformant implementation — not just this studio — make trustworthy claims.

*Prepared from the vendored, checksummed v1.2 copy under `vendor/observability-pack-spec/v1.2/`. Line/section references are to `spec.md` and `docs/maturity-model.md` at commit `d13532b`.*
