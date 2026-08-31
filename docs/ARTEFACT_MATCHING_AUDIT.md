# Artefact-Matching Correctness Audit

> **Point-in-time record (2026-06-09) — findings since resolved.** F2 (the
> last-write-wins drop) was fixed in the same commit that added this audit
> (`4c5bae4`): the diff now groups identity keys, preserves duplicates with
> `#NN` occurrence ordinals, and — as of the collision-reporting change —
> surfaces every duplicated key on `diffPacks().collisions`. F6's empty-array
> asymmetry was fixed alongside it. The "no PromQL semantic equivalence"
> limitation has since been narrowed by parser-proven canonicalisation
> (`tools/lib/promql-canon.mjs`). Alert-route identity deliberately remains
> severity-keyed — live connectors fabricate channel kinds for unresolved
> routing, so channel precision belongs to drift, not identity. See
> `docs/DIFF.md` for current behaviour; the text below is preserved as
> written.

**Scope:** `tools/lib/diff.mjs` + `tools/lib/artefact-model.mjs` (the structural/behavioural matcher), checked against `docs/DIFF.md`.
**Why:** pre-flight for a national CIO talk — confirm the matching claims are sound and not overstated.
**Method:** code review of the real implementation + an executable audit harness exercising the actual `adapt → diffPacks` path on the bundled example packs and a synthetic stress pack.

---

## Bottom line

The **engine is sound for what it actually does**, and the core intellectual claim — *match on identity, then separately judge agreement* — is real, implemented, and defensible. Two things need care before you put them on a stage:

1. **One slogan is over-stated.** "We never match by name" is not literally true: four artefact families (SLI, SLO, dashboard, derived view) are matched **by their declared id on purpose**, because for those the id *is* the contract. The honest framing is "we match on *what an artefact does*, and for contract artefacts the id is what it does."
2. **One real bug.** Within a single pack, two artefacts that resolve to the same identity key are silently de-duplicated (last-writer-wins in a `Map`). On clean hand-authored packs this never fires; on realistic packs (duplicate dashboards, multiple same-severity alert routes, multi-instance backends) it **drops artefacts from the comparison and under-counts**. Demonstrated below: a 20-artefact pack compares as 16.

Everything else is accurate or a precisely-stateable limitation. Details follow with severity ratings.

---

## What is correct and safe to claim

These held up under code review and execution:

- **Two-stage design is real.** Identity (`identityKeyOf`) pairs A↔B; agreement (`deltasOf` over `behaviorOf`) decides aligned vs drifted. They are genuinely separate steps. ✅
- **Identity is content-derived, never positional.** The `XXX-NN` ids the adapter assigns (`SLI-07`, `BAK-02`) are never used as identity. A backend keys on `product+signal`, a recording rule on its output series, a metric on its series name, a pipeline exporter on `signal+target`. So `prom-1` in one pack and `prometheus-metrics` in another **do** match. ✅ This is the genuinely novel, defensible part.
- **Agreement compares the full contract, not a sample.** `behaviorOf` canonicalises the *entire* spec object, so any contract-affecting field that diverges shows up as a delta. Nothing load-bearing is sampled away. ✅
- **Canonicalisation is order-independent.** Object keys sorted; arrays normalised element-wise then sorted; so declaration order and key order cannot masquerade as drift. ✅ (Verified: self-diff of every example pack is `alignment: 1.0`.)
- **Reflexivity holds.** A pack vs itself scores `alignment: 1.0` on all four example packs — the property the docs claim. ✅
- **The jaccard-vs-alignment distinction is genuine and valuable.** `jaccard = sharedIdentity / union` (do the names line up) vs `alignment = aligned / union` (do the definitions actually agree). On `target-advanced` vs `production-curated`, 18 artefacts share identity but only 3 agree — exactly the "high jaccard, low alignment = drift" signal the docs advertise. ✅ **This is your strongest, fully-honest talking point.**

---

## Findings

### F1 — "Never by name" is an over-claim (accuracy, not a bug) · **Medium for the talk**

`artefact-model.mjs` opens with *"we do NOT compare names."* But the identity functions for the four **contract families** are literally the declared id:

```js
sli:          (s, a) => ({ id: definedId(a, 'slis.') }),
slo:          (s, a) => ({ id: definedId(a, 'slos.') }),
derived_view: (s, a) => ({ id: definedId(a, 'queries.derived_views.') }),
dashboard:    (s, a) => ({ id: definedId(a, 'dashboards.') }),
```

This is **defensible** — the code comment argues it well: an SLO id is referenced by alerts, dashboards and burn rules, so renaming it *is* a behavioural change. But it means the blanket "identity is never a name" is false as stated. **Say instead:** "identity is behavioural; for telemetry/insight/action artefacts that means product, signal, series, or binding; for the reliability contract (SLIs/SLOs/dashboards) the declared id *is* the behaviour, so we key on it deliberately." That's both true and still a strong story.

### F2 — Intra-pack identity collisions silently drop artefacts (correctness **bug**) · **High**

`diffPacks` builds `aByKey`/`bByKey` as plain `Map`s:

```js
for (const a of aItems) aByKey.set(keyOf(a), a);   // last write wins
```

If two artefacts in the same pack produce the same identity key, the earlier one is **overwritten and disappears** from every downstream set, count, and ratio. The comparison is therefore over *identity classes*, not artefacts — and nothing flags the collapse.

**Demonstrated** (synthetic pack, full `adapt → diffPacks` path):

```
artefacts = 20   unique identity keys = 16   dropped = 4
  DROPPED  L2  BAK-02 -> backend::{"product":"prometheus","signal":"metrics"}
  DROPPED  L3  DASH-02 -> dashboard::{"id":"overview"}
  DROPPED  L4  ALR-02 -> alert_route::{"severity":"sev2"}
  DROPPED  L4  ALR-03 -> alert_route::{"severity":"sev2"}
self-diff: inBoth = 16  (artefacts = 20)   alignment = 1.0
```

Worst offender is **`alert_route`, which keys on severity alone** (`{ severity }`). Every route of a given severity collapses to one. A pack with five SEV2 routes and a pack with one SEV2 route compare as **aligned** — the four extra routes (different channels, webhooks, escalation) are invisible. The KrystalineX pack we reconciled has ~15 SEV2 routes; the diff sees one. Duplicate-id dashboards and multi-instance same-product backends (e.g. two Prometheus replicas) collapse the same way.

The bundled hand-authored packs (`target-advanced`, `production-curated`, `payment-service`) have **zero collisions** — which is why this has gone unnoticed and why the demos look perfect. It bites on crawled and live packs.

**Implication for the talk:** do **not** claim "pack arithmetic preserves every artefact" or show artefact counts as exact. Either fix it (suffix colliding keys with an occurrence index, or make `alert_route` identity include a channel/ordinal) or state the metric as "distinct artefact identities," not "artefacts."

### F3 — The set-algebra identities no longer hold literally · **Medium**

`DIFF.md` claims `A ∪ B = onlyInA ∪ inBoth ∪ onlyInB`. The code adds a fourth bucket, **`outOfScope`** (live artefacts whose whole family A never declares), and **excludes it from `union`, `jaccard`, and `alignment`**:

```js
union: onlyInA + onlyInB + inBoth        // outOfScope deliberately omitted
```

So the ratios are **in-scope** ratios, and `B − A = onlyInB ∪ outOfScope`. That scoping is a *reasonable* product decision (don't flood a one-service drift view with the whole platform inventory) — but it means the clean "A ∪ B" identities in the doc are no longer literally true, and the diff is **directional/asymmetric** (`diff(A,B) ≠ diff(B,A)`). Present it as "drift of A against B," not "the symmetric difference of two sets."

### F4 — Equality is contract-scoped, and that scope must be stated · **Low–Medium**

`aligned` does **not** mean "byte-identical." Before comparison the matcher strips/normalises:

- **Volatile fields** removed entirely: `endpoints, endpoint, url, address, host, auth, description, desc, title, summary, annotations, source, evidence, mcp, default, folder, provider`.
- **`version` collapses to `{ declared }`** — so two backends differing only in `min`/`max`/`gating`/`capabilities` read as aligned.
- **Expressions are whitespace-normalised only** (`expr`, `query`, `promql`, `expression`). This is **textual**, not semantic: `rate(x[5m])` == `rate( x[5m] )`, but `sum by (a,b)` vs `sum by (b,a)`, or an equivalent rewrite, will report as **drifted**. There is no PromQL parse/semantic-equivalence.

None of this is wrong — it's the right call for "same contract." But if you say "identical behaviour," be ready to qualify: *identical declared contract modulo deployment coordinates, declared-version, and expression whitespace.* Don't imply semantic query equivalence.

### F5 — `DIFF.md` documents a superseded implementation (doc drift) · **Medium for the talk**

`DIFF.md` describes `keyOf` synthesising keys like `recording_rule:<name>`, `alerting.route:<severity>`, `telemetry.backends.<id>`, and a 14-entry `VOLATILE_SPEC_KEYS`. The shipping code lives in `artefact-model.mjs` with **different** behaviour: backends key on `product+signal` (not `telemetry.backends.<id>`), the volatile set has 16 entries (adds `folder`, `provider`), and identity is the `{kind, identity}` model. If you prep slides from `DIFF.md`, you'll describe an engine you no longer run. Reconcile the doc first.

### F6 — Minor: empty-array vs absent asymmetry · **Low**

`canonicalize` drops empty objects but keeps empty arrays (`[]`). So an artefact with `foo: []` and one with `foo` absent will show a spurious `foo` delta, while `foo: {}` vs absent compare equal. Edge case, rarely hit, worth a one-line fix for consistency.

---

## Severity summary

| ID | Finding | Type | Severity | Before the talk |
|----|---------|------|----------|-----------------|
| F1 | "Never by name" overstated (4 contract families key on id) | Accuracy | Medium | Reword the claim |
| F2 | Intra-pack identity collisions drop artefacts (`alert_route` worst) | **Bug** | **High** | Fix, or stop quoting exact artefact counts |
| F3 | `union`/ratios exclude `outOfScope`; diff is directional | Accuracy | Medium | Frame as directional drift, not symmetric set diff |
| F4 | `aligned` is contract-scoped; expr equality is textual | Limitation | Low–Med | Qualify "identical behaviour" |
| F5 | `DIFF.md` describes the old `keyOf`/`canonicalize` design | Doc drift | Medium | Update doc before slides |
| F6 | empty-array vs absent asymmetry | Bug (minor) | Low | Optional fix |

---

## Recommended fixes (in priority order)

1. **F2 — make identity collision-safe.** Either (a) detect collisions and disambiguate (append an occurrence ordinal to the key so all artefacts survive the set), and/or (b) enrich the thin identity functions — `alert_route` should key on `severity + channel-kind/target` (or an ordinal), `burn_rate`/`forecast` likewise if multiple per SLO are legal. Add a regression test asserting `inBoth(self) === artefactCount` for a pack that contains duplicate-severity routes and duplicate dashboards.
2. **F5 — rewrite `DIFF.md`** to match `artefact-model.mjs` (identity table per family, 16-entry volatile set, scoped union + `outOfScope`).
3. **F1/F3/F4 — adjust the narrative** (and any in-product copy) to the precise claims above.
4. **F6 — normalise empty arrays to absent** in `canonicalize`.

---

## Talking points you *can* stand behind on stage

- "We match observability artefacts by **behaviour, not by their position in a file** — a backend is identified by the product and signal it serves, a recording rule by the series it emits, a metric by its series name. Rename the file entry and the match still holds."
- "We separate **identity** from **agreement**: sharing an identity means 'this is the same control'; agreement means 'both definitions would actually deploy the same way.' Two packs can share 18 controls by identity and agree on only 3 — and that gap *is* the drift."
- "Compared to a naïve name-overlap (Jaccard) score, our alignment score only credits controls whose full contract matches — so it can't be gamed by matching labels."

## Claims to retire or qualify

- ❌ "We never match on names." → ✅ "Identity is behavioural; for the reliability contract itself the declared id *is* the behaviour."
- ❌ "Pack arithmetic preserves every artefact / exact counts." → not currently true (F2).
- ❌ "Aligned means identical." → "Aligned means identical declared contract, ignoring endpoints, credentials, placement, declared-version metadata, and expression whitespace."
- ❌ "It's the symmetric set difference of two packs." → "It's directional drift of a declared pack against a reference."

---

*Findings produced by reading the shipping code and running an executable harness over the real `adapt → diffPacks` path (bundled example packs + a synthetic collision pack). The example packs are collision-free; the synthetic pack reproduces the F2 drop deterministically (20 artefacts → 16 identities).*
