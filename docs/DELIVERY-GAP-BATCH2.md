# Delivery report — rebadge batch 2, PR 2 (B3, GAP batch 2)

The short report the batch's acceptance asks for, per work item: what
shipped, the test counts, what is deferred and why. PR 2 of rebadge batch 2
(`codex/gap-batch2` → `develop`) delivers B3 — the five generic
reliability-workflow features the downstream retires its fork-unique UX
families against — each a **full build** behind a documented seam, inert
without data, free of downstream vocabulary. It is a reading aid over the
documents that carry the detail — `docs/CHANGELOG.md` (`## Unreleased`, the
five `Rebadge batch 2, B3.n` entries and the `PR 2` entry), `docs/UPDATE_JOURNEY.md`
("Rebadge batch 2, PR 2 — GAP batch 2", G1–G5), `docs/DOWNSTREAM.md` §14
(one `###` per feature name; downstreams plan retirement waves against these
names) and `docs/ADAPTER.md` (the JSON shapes) — and quotes nothing those
documents do not state. The totals below are the chain
`tools/test-doc-test-totals.mjs` guards: `npm test` on Linux, measured at
each feature's last commit, from 885 at the head of PR 1 to 998 at the head
of this PR. PR 1's report is [`docs/DELIVERY-REBADGE-BATCH2.md`](DELIVERY-REBADGE-BATCH2.md).

## The shared door — schema v2 and the conformance refactor

**Shipped.** One store migration for the whole PR (`server/store/migrations.mjs`
step `gap-batch-2`: the `verdicts` and `waivers` tables; every v1 row intact;
`user_version` 1 → 2 at the first boot of this build — the one unavoidable
default-output change, one-way: back up before upgrading, README "Upgrade
And Roll Back"). `tools/lib/adapter.mjs` exports `overlaidCanonical`;
`server/index.mjs` builds the `/conformance` body in one function,
`conformanceReportFor`, which the B3.2 overlay hooks and the B3.5 route
reads — `/conformance`, `/export.zip` and every compile and deploy answer
byte-identical, pinned.

## B3.1 — verdicts (`verdicts`)

**Shipped.** A reviewer's `trusted | suspect | failed` record with a reason,
the actor and the time on one artefact (the adapter's positional id, frozen
within a content-hash pack id) of one registered pack; `unreviewed` is the
absence of a row; never a scorer input. `GET/PUT/DELETE
/api/packs/:id/verdicts[/:artefact]` (viewer reads, operator writes; audit
`verdict.set` / `verdict.clear`), a label re-registration carrying verdicts
by behavioural identity (`verdict.carry`), Discover badges and chips, a
Verdict refine facet, the drawer's record form, `verdicts.json` in the export
ZIP only while a pack has a verdict; the bundle answers the empty document (a
bundled pack is never registered — the server's own answer). Inert: the 24
board goldens byte-identical, the rows pinned with `verdict: null`.

**Tests.** Tests: 885 → 911 — `server/test-verdict-admin.mjs` 9,
`server/test-verdicts-api.mjs` 9, five more in `server/test-store.mjs`,
three in `tools/test-discover-rows.mjs`.

**Deferred.** `verdicts-service-scope` (a verdict that follows the service
record across packs), `verdicts-bundle-bake` (verdicts baked into a static
bundle), `verdicts-cli` (`packc verdicts`), `verdicts-on-adapter-upgrade`
(a carry when the adapter's id scheme changes) — each a product call the
downstream has not yet asked for; the keying and the carry are the seam they
build on.

## B3.2 — waivers (`waivers`)

**Shipped.** A time-boxed, reasoned suppression of one conformance finding —
a rubric clause and, for the four per-item clauses, optionally one canonical
symbol — on the SERVICE record (`GET/POST /api/services/:id/waivers`, `POST
/api/waivers/:id/revoke`; audit `waiver.create` / `waiver.revoke`; a revoke is
history) or in a sidecar file (`packc conformance --waivers`). The report
keeps the engine's numbers and gains `waivers` with `effective`; a clause is
`waived` only when every failing subject is covered (`clauseSubjects`,
subjects ≡ verdict by construction), else `partial`; expired is failing again
with the lapsed waiver shown; the Conformance view renders waived
requirements and expired waivers; the placeholder rows gain the `waived`
partition. Inert: `/conformance` is the same object without an open waiver,
the CLI byte-identical without `--waivers`; the intended change is `DELETE
/api/services/:id` answering `waivers: n`.

**Tests.** Tests: 911 → 934 — `server/test-waivers-api.mjs` 9,
`tools/test-waivers.mjs` 12, two more in `tools/test-pack-conformance.mjs`.

**Deferred.** `B3.2-studio-waive` (recording a waiver from the studio),
`B3.2-bundle-waivers` (a sidecar baked into the bundle), `B3.2-env-scope`
(a waiver per environment — `serviceTierFor` already returns the
environment as the hook; D5), `B3.2-supersedes` (a renewal that names the
waiver it replaces).

## B3.3 — diagnose → remediate flow (`diagnose-remediate-flow`)

**Shipped.** The response path from a firing alert to the remediation the
pack declares for it, from pack data alone: `tools/lib/remediation-flow.mjs`
(listed) resolves a trigger by the `observogram.remediates.remediation[<i>]`
annotation, then the rule name, then a compiled burn-rule name, then the SLO;
no hit is `unresolved` with suggestions that never link; states come from
the comparison's buckets; the panel `studio/remediation-flow-view.mjs` on
Diagnose (`#diag-flow`) and Remediate (`#rm-flow`), the engine loaded at
call time, nothing for a pack without `spec.remediation`. No server, route,
store or env change. Inert: the goldens byte-identical; the intended change
is the panel on packs WITH remediations (all-unresolved for the catalogue
today, pinned).

**Tests.** Tests: 934 → 958 — `tools/test-remediation-flow.mjs` 14,
`tools/test-remediation-flow-view.mjs` 10.

**Deferred.** `remediation-trigger-ref` (the upstream spec proposal binding a
remediation to its alert by reference — the vendored spec cannot be edited
here), `remediation-flow-graph-unify` (one `remediates` edge for the graph
and the flow), `remediation-flow-live-state` (the live side's alert state in
the panel), `alert-rule-deploy` (an alert rule as a compiled artefact),
`catalogue-triggers` (the reference packs' triggers resolve to nothing; a
reviewed golden change).

## B3.4 — glossary widgets (`glossary`)

**Shipped.** Taxonomy schema version 2 adds a `glossary` of `{ term,
definition, family?, aliases?, link? }` (`TAXONOMY_VERSIONS [1, 2]`,
`TAXONOMY_VERSION_LATEST 2`, `TAXONOMY_VERSION` KEEPS 1 so a downstream's
files stay valid; every field bounded and refused with an exact text; a
glossary changes no classification); `studio/glossary.mjs` draws an
accessible toggletip mark beside the Discover row's kind, the board's group
titles and head facts and the drawer's labels; the bundle draws the same from
a baked v2 file; a browser smoke proves the keyboard toggle, the hover
preview and Escape precedence. Inert: `glossaryLabelHtml(text) ===
escapeHtml(text)` with no entry, so the 24 goldens and every row are
byte-identical; one new golden `typed.glossary.board.html`.

**Tests.** Tests: 958 → 975 — `tools/test-glossary.mjs` 9,
`server/test-glossary-shell.mjs` 1, four more in
`tools/test-artefact-classify.mjs`, one in `server/test-taxonomy.mjs`, one in
`tools/test-discover-rows.mjs`, one in `tools/test-studio-bundle.mjs`.

**Deferred.** `glossary-light-views` (marks on the Tiles, List and Cards
views, where the row is one button), `glossary-termhtml-override` (a v2
entry overriding a `termHtml` key's definition), `glossary-seed-from-spec`
(a generator seeding a v2 glossary from the vendored spec's descriptions).

## B3.5 — service audit report (`service-audit-report`)

**Shipped.** One exportable report per pack, HTML and JSON, in seven
sections that each quote an engine this repository ships: the maturity
rubric's grade (the engine's numbers headline, a waivers overlay's
`effective` beside them), the placeholders (`packConformance` rows beside
the library-todo and Scaffold counts), a reviewer's verdicts, the service's
waivers, the coverage by family (`required` = named by a rubric clause that
applies at the graded tier; required with nothing declared is `missing`),
the goes-blind risks (the blast radius over the traceability graph's shape)
and the declared response path (B3.3's model). `tools/lib/audit-report.mjs`
(listed; `buildAuditReport`, `renderAuditReportHtml` over the design tokens
and kit with the brand's chrome and tokens — the first standalone document
over the design kit; no script, every value escaped), `packc audit-report`
(`--env`, `--format json|html|both`, `--out`, `--brand` — the only brand it
reads — `--taxonomy`, `--top`, `--generated-at | --no-timestamp`,
`--verdicts`, `--waivers`, `--schema`), `GET /api/packs/:id/audit-report`
(its conformance section the one `conformanceReportFor()` body; real verdict
and waiver rows; branded like the shell) and the reserved `GET
/api/packs/:id/placeholders` (answered by the bundle too), the Conformance
view's two download anchors. A source not given reads "not recorded by this
build", an empty one "none recorded". Goldens for four inputs, unstamped.
Inert: crawl, compile and board goldens byte-identical, `/conformance` and
`/export.zip` unchanged; the intended changes are the two anchors and the
bundle's bytes (the shim imports `pack-conformance.mjs` for
`/placeholders`).

**Tests.** Tests: 975 → 998 — `tools/test-audit-report.mjs` 18 (13 at its
first commit: the vendoring guard, `CLAUSE_FAMILIES` over every rubric id,
the shared artefact walk, determinism, every section over real packs and
synthesised inputs, the hostile-input escaping, the goldens; four for the CLI;
one for the Conformance view's anchors) and `server/test-audit-report-api.mjs`
5 (the shapes and refusals, `?env=`, the HTML and the download names, a
registered pack's real rows and the waived clause, a branded child and a
taxonomy child, `/placeholders`).

**Deferred.** `B3.5-bundle-audit-report` (the bundle answers
`/audit-report` 501: the goes-blind section needs the PromQL parser — the
Compare blocker of `docs/DOWNSTREAM.md` §10), `B3.5-export-zip`
(`audit-report.json` / `.html` in the export ZIP, whose entry list the parity
suite pins and which is reproducible today), `B3.5-dark-print` (a dark and a
fuller print variant of the one light document).

## Whole-batch acceptance, as it stands at the head of this PR

- `npm test` green on Linux on Node 22.22 and 22.16 (998 tests; one
  environmental skip); green-with-counted-skips on Windows is expected as
  PR 1 stated, not verified (no Windows runner here).
- `npm run vendor-manifest:check` (54 modules: `waivers.mjs`,
  `remediation-flow.mjs`, `audit-report.mjs` added) and `node
  tools/sync-spec.mjs --check` green; `npm run lint` 0 errors, no new
  warning.
- Defaults byte-identical: `npm run test:golden`, `test:golden:compile` and
  `tools/test-golden-board.mjs` (24 goldens) prove it, with the declared
  exceptions named per feature above (schema `user_version` 1 → 2,
  `waivers: n` on a service's deletion, the panels and anchors on screens
  with data, the bundle's bytes).
- `docs/DOWNSTREAM.md` §14 names the five features with status, seams and
  follow-ups; §9, §10, §11 and §12 point to it where they reserved a name.
