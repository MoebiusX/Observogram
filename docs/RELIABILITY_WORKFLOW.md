# Reliability-workflow features (GAP batch 2)

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §14.*

The five generic reliability-workflow features of rebadge batch 2 (B3), one
`##` per feature name; downstreams plan retirement waves against these
names. Each is a full build behind a documented seam, inert without data
and free of downstream vocabulary; the follow-ups are named, with their
blocker, so a wave can be scheduled against them.

| feature | status | seam | what a downstream retires | follow-ups |
|---|---|---|---|---|
| `waivers` | shipped — full build | `GET/POST /api/services/:id/waivers`, `POST /api/waivers/:id/revoke`, the `waivers` block of `GET /api/packs/:id/conformance` (`docs/ADAPTER.md` "Waivers"), the sidecar file of `packc conformance --waivers`, `tools/lib/waivers.mjs` (listed), the `waiver.create` / `waiver.revoke` audit rows | its exception / suppression list for conformance findings and its expiry bookkeeping | `B3.2-studio-waive`, `B3.2-bundle-waivers`, `B3.2-env-scope`, `B3.2-supersedes` |
| `diagnose-remediate-flow` | shipped — full build | `tools/lib/remediation-flow.mjs` (listed): `buildRemediationFlowModel`, the linking rule and the `observogram.remediates.remediation[<i>]` annotation (`docs/ADAPTER.md` "Response path"); the panel `studio/remediation-flow-view.mjs` on Diagnose (`#diag-flow`) and Remediate (`#rm-flow`), the `.rflow-*` zone | its alert → runbook / automation "what next" page and its trigger-to-alert matching | `remediation-trigger-ref`, `remediation-flow-graph-unify`, `remediation-flow-live-state`, `alert-rule-deploy`, `catalogue-triggers` |
| `glossary` | shipped — full build | the taxonomy file's schema version 2 `glossary` (`OBSERVOGRAM_TAXONOMY` / `--taxonomy`; README "Classify Typed Packs"), `tools/lib/artefact-classify.mjs` `glossaryFor` / `glossaryByText` / `glossaryEntries` (listed), the mark `studio/glossary.mjs` (`.ux-gloss-*`) on Discover rows, board titles, head facts and the drawer | its hover/inline definitions for artefact families and domain terms, and the file that held them | `glossary-light-views`, `glossary-termhtml-override`, `glossary-seed-from-spec` |
| `verdicts` | shipped — full build | `GET/PUT/DELETE /api/packs/:id/verdicts[/:artefact]` (`docs/ADAPTER.md` "Verdicts"), the `verdicts.json` entry of `/export.zip`, the `verdict.set` / `verdict.clear` / `verdict.carry` audit rows, the `verdict` status property (`studio/ux-kit.mjs`) and `studio/verdict-html.mjs` | its per-artefact review / trust record and its badge, filter and record form | `verdicts-service-scope`, `verdicts-bundle-bake`, `verdicts-cli`, `verdicts-on-adapter-upgrade` |
| `service-audit-report` | shipped — full build | `GET /api/packs/:id/audit-report?format=json\|html` and `GET /api/packs/:id/placeholders` (`docs/ADAPTER.md` "The service audit report"), `packc audit-report` (`--verdicts`, `--waivers`, `--brand`, `--taxonomy`, `--no-timestamp`), `tools/lib/audit-report.mjs` (listed: `buildAuditReport`, `renderAuditReportHtml`), the Conformance view's two download anchors; in the static bundle too (follow-up `compare-in-bundle`, [`DOWNSTREAM.md`](DOWNSTREAM.md) §10) | its per-service audit page and export (conformance, exceptions, review state, coverage, single points of failure, runbook linkage) | `B3.5-export-zip`, `B3.5-dark-print` |

## waivers

A time-boxed, reasoned suppression of one conformance finding: a rubric
clause and, for the four per-item clauses, optionally one canonical symbol
of it (`slos.<id>` / `slis.<id>` — the adapter's `defines` vocabulary, never
a JSONPath). Persisted on the service record (schema v2, `waivers`,
cascading with the service; a revoke keeps the row as history), applied by
`GET /api/packs/:id/conformance` as a `waivers` block beside the engine's
untouched numbers (`effective` carries the numbers with the waived clauses
met), read by the CLI from a sidecar file (`packc conformance --waivers
<file>`: the rubric line and `rubric.waivers`, and the placeholder rows'
`waived` partition — the seam [`PACK_CONFORMANCE.md`](PACK_CONFORMANCE.md) reserved). Everything a downstream
integrates against is in `docs/ADAPTER.md` ("Waivers — a service record's
suppression of a finding": the waiver object, the overlay block, the POST
body, every refusal text), `docs/CONFORMANCE.md` "Waivers" and README "Waive
A Conformance Finding".

Follow-ups, by name:

- *`B3.2-studio-waive`* — the studio shows waivers on the Conformance view
  and does not record one; the record form is the API's (`curl` in the
  README) until a downstream asks for it in the drawer.
- *`B3.2-bundle-waivers`* — the static bundle grades a pack bare (no service
  record); baking a sidecar file into a `--pack` needs a build flag and a
  shim read, like the taxonomy and the brand.
- *`B3.2-env-scope`* — a waiver applies to every environment of its service;
  `?env=` grades per overlay, so a per-environment scope is the next shape
  (`serviceTierFor` already returns the environment as the hook).
- *`B3.2-supersedes`* — a renewal is a new row after an expiry; a
  `supersedes` link from the renewal to the lapsed waiver would keep the
  chain readable in the audit.

## diagnose-remediate-flow

The response path from a firing alert to the remediation the pack declares
for it, computed from pack data alone (the existing `spec.remediation`
family; no external call, no store, no route, no env). The spec names a
remediation's trigger as an alert id (`trigger: alert:<slug>`) and nothing
else binds the two, so `tools/lib/remediation-flow.mjs` is the one linking
rule — the annotation `metadata.annotations["observogram.remediates.remediation[<i>]"]`
(`alerting.rules[<j>]`, `policy.burn_rate_alerts[<j>]`, `slos.<id>`,
`alert:<slug>`, comma-separated), then the rule name, then a compiled
burn-rule name (`<slo>_burn_<factor>x_<short>_<long>`), then the SLO; the
first tier with a hit wins and every hit of it links; no hit is `unresolved`
with name-based suggestions that never link. States come from the comparison
(`live`, `drifted`, `missing`, `unverified`, `placeholder`, `unhealthy` from
the live side's `mcp.discovered.alert_rules_unhealthy`; `declared` without
one) and the steps are what a responder walks (deploy the missing burn alert
through the deploy modal, reconcile, fix, route, register the automation,
open the runbook, annotate an unresolved trigger). The studio draws it on
Diagnose (a `.diag-block` in a folded row of the Assessment) and on Remediate (after
the plan, where the deploy button lives); the static bundle draws it too (the
engine rides the import map). Everything a downstream integrates against is
in `docs/ADAPTER.md` ("Response path": the annotation grammar, the model
shape, the states and steps). **Honest status**: not one trigger of the
catalogue's 17 remediations resolves today — the panel lists them all as
unresolved with their suggestions (pinned in `tools/test-remediation-flow.mjs`).

Follow-ups, by name:

- *`remediation-trigger-ref`* — the spec could let a remediation name its
  alert as a reference (`trigger: ref:alerting.rules[0]`) instead of a free
  slug; an upstream proposal (the vendored spec is pinned by `sync-spec`),
  after which the annotation becomes the fallback.
- *`remediation-flow-graph-unify`* — the traceability graph infers its own
  `remediates` edges by text; one rule should serve both, and the graph's
  verdicts should feed the path's states.
- *`remediation-flow-live-state`* — the path reads the comparison; a live
  probe of the automation backend (did the workflow run?) and of the route
  (did the channel receive?) is the next evidence rung.
- *`alert-rule-deploy`* — a declared alert rule (`alerting.rules[j]`) is not a
  compiled artefact, so a missing one has no deploy action; compiling the
  declared rules as a deploy surface would give it one.
- *`catalogue-triggers`* — the reference packs' triggers resolve to nothing;
  renaming them to their alerts (or annotating them) is a reviewed golden
  change (the board goldens and `tools/test-remediation-flow.mjs` pin the
  catalogue), to land with a maintainer's eye on each pack.

## verdicts

A reviewer's `trusted | suspect | failed` record, with a reason, the actor
and the time, on one artefact of one registered pack; `unreviewed` is the
absence of a record. Persisted in the store (schema v2, `verdicts`, cascading
with the pack), surfaced on Discover as a board badge, a row chip and a
Refine facet, recorded from the drawer, exported as `verdicts.json`. Never a
scorer input: the conformance score and the diagnostic grade do not read it.
The artefact address is the adapter's positional id (`SLI-01`) within a
content-hash pack id; a re-upload under the same label carries each record
by behavioural identity (`identityKeyOf`) and drops the rest, counted in
`verdict.carry`. Everything a downstream integrates against is in
`docs/ADAPTER.md` ("Verdicts — a reviewer's record per artefact": the
VerdictView, the document, the PUT body, every refusal text) and README
"Record Verdicts".

Follow-ups, by name:

- *`verdicts-service-scope`* — a verdict is per pack; a service-level record
  that survives a pack's eviction (the service row outlives its packs) is
  the next shape, keyed by the canonical symbol as the waivers are.
- *`verdicts-bundle-bake`* — the static bundle answers the empty document;
  baking a `verdicts.json` into a `--pack` (a read-only badge in a bundle)
  needs a build flag and a shim read, like the taxonomy and the brand.
- *`verdicts-cli`* — no `packc verdicts` yet: the API is the one door
  (`curl` in README "Record Verdicts"); a CLI over the same admin module is
  a small follow-up once a downstream asks for a batch path.
- *`verdicts-on-adapter-upgrade`* — a positional id is frozen within a pack
  id, but an adapter change that renumbers artefacts of an already-registered
  pack would orphan its rows (served flagged `orphaned: true`, counted in
  `summary.orphaned`); a migration-time re-key by identity key is the fix
  when such an upgrade ships.

## glossary

Definitions for the taxonomy's families and for spec terms, sourced from a
`glossary` section of the taxonomy file — the W3 seam at schema version 2
(`TAXONOMY_VERSION_LATEST`; `TAXONOMY_VERSION` stays 1 so a file written for
an older server keeps validating, and a v1 file stays valid here). An entry
is `{ term, definition, family?, aliases?, link? }`; the classifier refuses a
bad one with an exact text and compiles a good one to `{ entries, byFamily,
byText }` behind `glossaryFor`, `glossaryByText`, `glossaryEntries` (listed,
`tools/lib/artefact-classify.mjs`). A glossary changes no classification. The
studio draws an entry as an accessible mark (`studio/glossary.mjs`: a named
button, the definition opened in place, hover and focus previews, Escape,
a "Learn more" anchor for `link`) beside the Discover row's kind, the board's
group titles and head facts, and the drawer's kind row and labels; the static
bundle draws the same from a baked v2 file (B1's bake carries the document,
`tools/test-studio-bundle.mjs` T8c). Byte-identical without one: the 24 board
goldens, every row (README "Classify Typed Packs", *The glossary marks*).

Follow-ups, by name:

- *`glossary-light-views`* — the Tiles, List and Cards views draw no mark
  (the row is one button there, and a button cannot hold a button); a
  side-mark outside the button is the next shape.
- *`glossary-termhtml-override`* — `termHtml()` (the studio's own formal
  terms, `studio/ux-kit.mjs` GLOSSARY) and the operator's glossary are two
  voices; letting a v2 entry override a `termHtml` key's definition by name
  is a small follow-up once a downstream asks for it.
- *`glossary-seed-from-spec`* — the vendored spec names every family and
  term; a generator that seeds a v2 glossary from the spec's descriptions
  (`tools/sync-spec.mjs` pins the spec, so the seed is a tool, not an edit)
  would give every downstream a starting file.

## service-audit-report

One exportable report per pack, HTML and JSON, in seven sections that each
quote an engine this repository already ships: the maturity rubric's grade
(the engine's numbers headline; a waivers overlay's `effective` sits beside
them), the placeholders (`packConformance` rows beside the library-todo and
Scaffold counts), a reviewer's verdicts, the service's waivers, the coverage
by family (`required` = named by a rubric clause that applies at the graded
tier; required with nothing declared is `missing`, else `absent`), the
goes-blind risks (`tools/lib/blast-radius.mjs` over the traceability graph:
what WOULD go blind, never that something is blind) and the declared response
path (B3.3's model, never compared). Nothing in the report grades, scores or
classifies on its own, and a verdict never feeds the conformance numbers.
Two artefact addresses appear and each engine's own is printed — a verdict by
the adapter's positional id (`SLI-01`, card `L1/SLI-01`), a waiver or a
placeholder row by the canonical symbol (`slos.<id>`) — `docs/ADAPTER.md`
"Artefact addresses".

The seams: `GET /api/packs/:id/audit-report?format=json|html&top=&download=1&env=`
(viewer; its conformance section is the one `conformanceReportFor()` body the
`/conformance` route sends, its verdict and waiver rows the store's), `GET
/api/packs/:id/placeholders` (the rows `packc conformance` prints; answered
by the static bundle too), `packc audit-report <pack> [--env] [--format]
[--out] [--brand] [--taxonomy] [--top] [--generated-at | --no-timestamp]
[--verdicts] [--waivers] [--schema]` (the CLI has no store: `--verdicts` is a
saved `GET /verdicts` document, `--waivers` the sidecar file; without them
the sections read "not recorded by this build"; `--brand` is the only brand
it reads, so a report is reproducible from its arguments), the model and the
renderer in `tools/lib/audit-report.mjs` (listed; `buildAuditReport(input)`,
`renderAuditReportHtml(report, { brand, styles })` over
`studio/design-tokens.css` + `design-kit.css` and the `.ar-*` zone — the first
standalone document over the design kit), the Conformance view's two
download anchors. Goldens `tools/fixtures/golden/audit-report/*` pin the
document and the HTML for four inputs (unstamped). A downstream with its own
sections writes a sibling renderer over the same document: the JSON shape is
the contract (`reportVersion: 1`).

Follow-ups, by name:

- *`B3.5-bundle-audit-report`* — closed by follow-up `compare-in-bundle`
  ([`DOWNSTREAM.md`](DOWNSTREAM.md) §10): the bundle inlines the PromQL parser, and the shim builds the report
  in the browser with `goesBlind.available: true`, its verdicts and waivers
  sections "not recorded by this build".
- *`B3.5-export-zip`* — `GET /api/packs/:id/export.zip` could carry
  `audit-report.json` / `.html` beside `verdicts.json`; held back because the
  ZIP's entry list is pinned by the bundle parity suite and the report is
  stamped (the ZIP is reproducible today).
- *`B3.5-dark-print`* — the HTML is one light theme; a `prefers-color-scheme`
  dark variant and a print stylesheet beyond `@media print` basics wait for a
  downstream that prints or embeds it.
