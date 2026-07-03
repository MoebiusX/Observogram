# Diff — Behavioural Artefact Matching

`tools/lib/diff.mjs` compares two adapted, layered packs and powers the
drift/gap view exposed by `GET /api/diff?a=<packId>&b=<packId>`.

The comparison is directional: **A is the declared pack under review, B is the
reference or live pack**. Observogram reports in-scope drift for A against B and
keeps unrelated live inventory in a separate `outOfScope` bucket.

## The Claim

Observogram separates two questions:

1. **Identity:** is this the same control?
2. **Agreement:** do both sides declare the same contract for that control?

This is the core matcher claim that is safe to repeat: a shared identity does
not receive credit unless the comparable contract also aligns.

## Identity

`keyOf(artefact)` delegates to `tools/lib/artefact-model.mjs`, which classifies
each artefact family and builds a behavioural identity object. The adapter's
positional ids (`SLI-01`, `BAK-03`, `ALR-02`) are never identity.

Representative identities:

| Family | Identity |
|---|---|
| SLI / SLO | declared contract id, because other controls bind to it |
| Backend | `product + signal` |
| Metric | series name |
| Recording rule | output series name |
| Dashboard | declared dashboard id |
| Panel | dashboard parent + `binds_to` target |
| Pipeline receiver/processor | stage name |
| Pipeline exporter | signal + exporter kind |
| Alert route | severity, with duplicate identities preserved |
| L2X profiling/network/policy | product |
| L2X mesh/collection | product + role |

The precise phrasing matters: Observogram matches on behaviour. For reliability
contract artefacts, the declared id is the behavioural handle by design.

## Collision Handling

Multiple artefacts in one pack can share the same identity key: multiple SEV2
routes, duplicate dashboard ids, or more than one Prometheus metrics backend.
`diffPacks` groups by identity instead of using a last-write-wins `Map`.

Within each identity group it:

1. Pairs exact behavioural matches first.
2. Pairs remaining same-identity artefacts as drifted, choosing the closest
   remaining contract.
3. Leaves surplus controls visible as `onlyInA` or `onlyInB`.

Duplicate entries receive stable occurrence suffixes such as
`alert_route::{"severity":"sev2"}#02`, so counts preserve artefacts instead of
collapsing them to identity classes.

## Agreement

`projectOf(artefact)` returns the canonical comparable contract, and
`deltasOf(a, b)` reports top-level fields that differ. A matched pair is:

```js
{ key, a, b, match: 'aligned' | 'drifted', deltas }
```

`aligned` means the declared contract matches after normalisation. It does not
mean byte-identical source.

Normalisation rules:

- Object keys are sorted.
- Arrays are normalised element-wise, sorted, and empty arrays are treated like
  absent fields.
- Empty `null`, `undefined`, `''`, `{}`, and `[]` values are dropped.
- Expressions in `expr`, `query`, `promql`, and `expression` are
  order-canonicalized when the expression parses cleanly (parser-proven):
  selector matcher order (`{b="2",a="1"}` ≡ `{a="1",b="2"}`), aggregation
  grouping label order (`sum by (a,b)` ≡ `sum by (b,a)`), and structural
  whitespace (`rate( x [5m] )` ≡ `rate(x[5m])`). Anything that fails to
  parse falls back to whitespace collapse only — recorded as
  `textual-fallback` by `tools/lib/promql-canon.mjs`. Explicit non-goals
  (per `PHASE_1_VERDICT_TRUST_RESEARCH.md` Workstream B): no algebraic
  rewrites, no binary-expression or vector-matching reordering, no regex
  equivalence, no histogram folding.
- `version` blocks compare by `declared` when present.
- Deployment/presentation fields are stripped:

```text
endpoints, endpoint, url, address, host, auth,
description, desc, title, summary, annotations,
source, evidence, mcp, default, folder, provider
```

## Buckets

Each layer (`L1`, `L2`, `L2X`, `L3`, `L4`, `L5`, `GOV`) contains:

| Bucket | Meaning |
|---|---|
| `onlyInA` | A declares it; B does not have an in-scope counterpart |
| `onlyInB` | B has it in a family A participates in; A does not |
| `inBoth` | same identity on both sides, with `aligned` or `drifted` verdict |
| `outOfScope` | B has it, but A declares nothing in that artefact family |

`outOfScope` prevents a single-service drift view from being flooded by the
rest of a platform's live inventory. It is reported, but excluded from the
in-scope ratios.

## Summary Ratios

`union = onlyInA + onlyInB + inBoth` is the **in-scope** union. `outOfScope` is
reported separately.

- `jaccard = inBoth / union`: identity overlap.
- `alignment = aligned / union`: true agreement ratio.

The strongest diagnostic signal is the gap between them: high Jaccard and low
alignment means Observogram found the same controls, but their definitions drift.

## Weighted Drift Fidelity

The Diagnose view does not score every delta equally. It uses weighted badness:

| Bucket | Weight | Rationale |
|---|---:|---|
| Declared, not live | 1.0 | false reassurance: the pack claims production protection that live did not confirm |
| Drifted | 0.5 default | miscalibration: same control exists, but fields differ |
| Drifted decision field | 1.0 | SLO objective, query, alert window, severity, route/channel, MTTD/MTTR, etc. |
| Drifted cosmetic field | 0.1 | label, display, folder, tag, description, etc. |
| Live, not declared | 0.15 | shadow signal: useful inventory gap, but less dangerous than false reassurance |
| Out-of-scope live | 0.0 | excluded platform inventory |
| Scaffold | 0.0 | schema-required fallback with no source evidence |

Weighted fidelity is:

```text
aligned / (aligned + weighted_badness)
```

The current trusted-fidelity threshold is derived from decision cost: weighted
badness must stay below about `0.176` per confirmed artefact, roughly one
high-cost false reassurance per six confirmed controls. That maps to about
85% fidelity. The drift-free criterion contributes fractional credit equal to
the measured weighted fidelity; crossing the threshold decides whether the row
is safe to trust.

## Public API

```js
import { keyOf, projectOf, deltasOf, diffPacks } from './tools/lib/diff.mjs';

keyOf(artefact);              // behavioural identity key
projectOf(artefact);          // comparable contract projection
deltasOf(a, b);               // top-level contract deltas
diffPacks(aLayered, bLayered); // directional drift report
```

## Regression Coverage

`tools/test-diff.mjs` verifies:

- pack-vs-self preserves every artefact, including duplicate identity keys;
- duplicate SEV2 routes survive as distinct controls;
- surplus duplicate controls are reported as drift rather than dropped;
- empty arrays normalise like absent fields.
