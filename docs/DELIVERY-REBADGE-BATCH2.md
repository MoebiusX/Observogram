# Delivery report — rebadge batch 2, PR 1 (B1, B2, B4)

The short report the batch's acceptance asks for, per work item: what shipped,
the test counts, what is deferred and why. It is a reading aid over the
documents that carry the detail — `docs/CHANGELOG.md` (`## Unreleased`, the
four "Rebadge batch 2" entries), `docs/UPDATE_JOURNEY.md` (the B1, B2a, B2b
and B4 decision paragraphs) and `docs/DOWNSTREAM.md` (§10 bundle baking,
§11 the conformance workflow, §12 packs born canonical, §13 platforms) — and
quotes nothing those documents do not state. The totals below are the chain
`tools/test-doc-test-totals.mjs` guards: `npm test` on Linux, measured at
each item's last commit, from 843 on the base (`origin/develop`) to 884 at
the head of this PR. B3 is not in this PR (see "Deferred", last section).

## B1 — bundle parity: taxonomy and brand baked into the static bundle

**Shipped.** `tools/build-studio-bundle.mjs --taxonomy <file.json>` and
`--brand <file.json>`; `OBSERVOGRAM_TAXONOMY`, `OBSERVOGRAM_BRAND_FILE` and the
`OBSERVOGRAM_BRAND_*` scalars honoured when the flags are absent (legacy
`TOMOGRAPH_` spelling too). Validation at build time with the server's own
code — `validateTaxonomy` and its refusal texts, `loadBrand` and
`brandShellHtml` — so a baked bundle renders what a configured server
renders by construction. `studio/static-backend.mjs` answers `GET
/api/taxonomy` from `config.taxonomy` and names the product from
`#brand-config` in its notices. A root-relative brand URL (`favicon`,
`logo.url`, `hero.src`) is refused with the field, the fix and, for an
env-sourced brand, the variable that was set. The summary line and `--json`
always say what was baked (paths, never contents). Inert: a build with no
flags and none of the variables set produces, on the same tree, the bytes of
a build with the seams unset (T4b). Docs: README "Serve The Studio Without
The Server" (*Bake the seams*), `docs/DOWNSTREAM.md` §10, `docs/ADAPTER.md`,
`docs/UI_CONVENTIONS.md`, `.env.example`.

**Tests.** Tests: 843 → 847 — `tools/test-studio-bundle.mjs` 9 → 13 (T4b
inert proof; T8 taxonomy parity against a configured server, the board
byte-identical to the `typed-canonical.mapped` golden; T8b brand parity
against a branded server's shell; T9 the baked bundle in headless Chromium,
skipping like T7 without `OBSERVOGRAM_PLAYWRIGHT`); `tools/test-golden-board.mjs`
+4 goldens (`typed-canonical` fixture), none changed. No `tools/lib` module
changed: `VENDOR-MANIFEST.json` untouched.

**Deferred.** The stretch item — Compare inside the bundle by inlining the
lezer/PromQL dependency — with the exact blockers measured and written in
`docs/DOWNSTREAM.md` §10: the inlining is feasible (209,461 B of ESM, no
`node:` import); what blocks it is the port of `GET /api/diff` to the static
backend, the third-party licence embedding, the build's dependence on an
installed `node_modules`, and the bare-specifier allowlist the T1 guard would
need. Also named there: `--split`, a directory form without `data:` URLs.

## B2 — canonical pack production

### B2a — pack conformance and the merge-safe upconvert

**Shipped.** `tools/lib/pack-conformance.mjs` (new, zero-import,
browser-safe, listed in `VENDOR-MANIFEST.json` — 51 modules) and the CLI
`tools/pack-conformance.mjs` / `packc conformance` with `--json`, `--strict`,
`--quiet`: every scaffold placeholder and stub with its pack path, the field
that needs a real value, where that value normally comes from (crawl
evidence, operator input, telemetry) and the hint to delete the marker; exit
non-zero on rows only with `--strict`. A separate CLI rather than a
`validate-pack --conformance` mode (validate-pack's contract is pinned by the
README and every script that pipes it). No new marker: a placeholder is an
artefact whose adapter symbol carries one of the three scaffold prefixes, so
the report equals what the studio parks as Scaffold and packs already
upconverted downstream report correctly without re-conversion.
`tools/upconvert-legacy.mjs` is idempotent and merge-safe: a canonical input
is validated and passed through (exit 0), `-o` onto an existing canonical
pack merges into it (`mergeUpconvert` in `tools/lib/legacy.mjs`, "existing
wins" by artefact identity, a section the base removed stays removed), with
`--merge <base>` and `--overwrite`; an unreadable, non-canonical or
schema-invalid base — or an existing distinct `-o` — is refused, never
clobbered. Docs: `docs/DOWNSTREAM.md` §11, README, `docs/ADAPTER.md`,
`docs/CONFORMANCE.md`, `docs/VENDORING.md`, `legacy/README.md`.

**The one deliberate default-output change of the PR.** The six
shared-section scaffold markers (`crawler.scaffold.otel`,
`pipelines.receivers[0]`, `pipelines.processors[0]`,
`pipelines.exporters.{metrics,logs,traces}`) now ride in `report.scaffolded`
and the `legacy.scaffoldCount` annotation, which had undercounted them:
demo-skeleton 9 → 15, production-curated 27 → 33, production-live 29 → 35,
target-advanced 39 → 45. The annotation key order is unchanged (the six keys
stay last), so the output of `node tools/upconvert-legacy.mjs` differs from
the base in that one value only; `report.scaffolded` in the `POST
/api/validate` response and the studio's upload toast show the same number.
No golden covers the upconvert; `tools/test-legacy-pack.mjs` pins the count
to the key count. Default-behaviour changes of the CLI: a canonical input
exits 0 (was exit 1); `-o` onto an existing canonical pack merges (was an
overwrite; `--overwrite` restores it).

**Tests.** Tests: 847 → 864 — `tools/test-pack-conformance.mjs` (9 then; 12 at
the head of this PR — B2b's hostile crawl, the review fixes' phone
fingerprint and the flag-documentation pin, counted under 864 → 866,
881 → 883 and 883 → 884 below) and
`tools/test-upconvert-merge.mjs` (8, including the count pins and the
annotation key order, the never-regresses property over the four examples
and the CLI merge paths), plus one pin in `tools/test-legacy-pack.mjs`. Two
more tests landed in `tools/test-upconvert-merge.mjs` with the review fixes
(counted under 875 → 880 below).

### B2b — a fresh crawl is a valid pack, and it says what it invented

**Shipped.** `tools/crawl-repo.mjs` output audited against the v1.4 schema
and every gap fixed so a fresh crawl validates without upconversion
(`tools/lib/crawler.mjs`, `tools/lib/slug.mjs` `packSlug`,
`tools/lib/sli-inference.mjs` `isSpecRecordingRuleName` and
`SPEC_DURATION_RE`, `tools/lib/alert-routes.mjs`): names normalized to spec
Slugs with the original kept, closed vocabularies refused by the CLI (exit 2)
and defaulted-with-a-warning by the library, values the spec cannot hold
recorded as evidence (rule names, dashboard schemaVersions, intervals),
bounded tier-3 ids. Every invented value is marked `crawler.scaffold.<symbol>`
in the vocabulary B2a reads — artefact-level for the stub and alert-derived
SLI/SLO pairs, field-level for the five `otel.*` fields, `metadata.owners`,
invented endpoints and channels. `otel.sdk.languages` is read off the source
files; `provider.version` carries the Grafana image tag or nothing.
`VENDOR-MANIFEST.json` regenerated. Docs: `docs/DOWNSTREAM.md` §12 (the
recommended end state and the named follow-ups), README, `docs/ADAPTER.md`.

**Goldens.** `tools/fixtures/golden-crawl.pack.json` regenerated twice, each
diff stated in its commit and in the CHANGELOG: the validity commit left it
byte-identical; the provenance commit `crawler.scaffoldCount` 4 → 10, six
annotation keys appended, `spec.dashboards[0].provider.version` `"1"` →
`"12.0.0"`; the languages commit `spec.otel.sdk.languages` `["go"]` →
`["node"]`, one mark removed, `crawler.scaffoldCount` 10 → 9,
`crawler.discovered.sdk_languages` added. Every other golden is untouched.

**Tests.** Tests: 864 → 866 — `tools/test-crawl-canonical.mjs` (one harness
suite over three fixture repositories) and one more test in
`tools/test-pack-conformance.mjs`, plus pins in `tools/test-crawl.mjs` and
`tools/test-pack-conformance.mjs`.

**Deferred.** The named follow-ups of `docs/DOWNSTREAM.md` §12 (inference
defaults marked on both sides, the artefact-level `otel` scaffold, omitting
the fabricated synthetic check, HTTP 400 for invalid crawl options, the
`-burn-?rate` suffix, the `solace_` product rule, `legacy.liveness.mcpUrl`
through `stripMcpUrl`, imports as Scaffold) — each a product decision or a
joint crawler/fetcher change that would move Compare, so none belongs in a
validity fix.

## B4 — Windows portability

**Shipped.** Tests, fixtures and docs only; no module under `tools/lib`,
`server/` runtime or `studio/` changed, so the goldens and
`VENDOR-MANIFEST.json` are untouched. `fileURLToPath` replaces
`URL.pathname` in the three module-relative resolvers (`tools/test-brand.mjs`,
`tools/test-crawl-alerting-rules.mjs`, `tools/test-deploy-manifests.mjs`),
and the guard refuses the idiom under `server/`, `tools/` and `studio/`
outside a pinned allowlist of URL uses. The studio-bundle T1 missing-module
assertion normalises the host separator. `closeStore()` runs before the five
in-process suites remove their workspace (an open sqlite file cannot be
unlinked on win32). `server/fixtures/platform.mjs` (`isWin32`, `isLinux`,
`PLATFORM`, `win32Skip`, `skipOnWin32`, the three `WIN32` reasons) is the one
place a suite names the platform; the POSIX-only facts (mode bits, signal
semantics, symlinks) are explicit, reasoned, counted skips — 15 sites, never
a silent pass. `.gitattributes` gains `* text=auto eol=lf`. Docs: README
"Platforms" and Repository Map rows, `docs/DOWNSTREAM.md` §13 and §8,
`docs/UPDATE_JOURNEY.md`.

**Tests.** Tests: 866 → 875 — `tools/test-platform.mjs` (six Linux-runnable
proofs, in `npm test` and `npm run test:platform`), the three POSIX paragraphs
now subtests or their own test.

**Expected on Windows — predicted from code reading, not verified; no
Windows run exists here.** `npm test` green with 19 `SKIP win32:` lines (18
`# SKIP win32:` from node:test, one `- SKIP win32:` from
`tools/test-journey.mjs`), plus the PID 1 namespace test's `# SKIP unshare
--pid is unavailable here` and the browser suites' Playwright skips when
`OBSERVOGRAM_PLAYWRIGHT` is unset; an elevated runner sees the 4 symlink
skips as tests it could run. The downstream's first `npm test` on Windows is
the acceptance: report the `SKIP win32:` lines it prints (`docs/DOWNSTREAM.md`
§13 says what a different count means).

**Deferred.** The Windows CI leg (`windows-latest`, `npm ci && npm test`):
no Windows runner in this environment to prove it green before it gates
`develop`; it lands after that first run confirms the count.

## Review fixes and the totals guard

Tests: 875 → 880 — two in `tools/test-upconvert-merge.mjs` (the merge creates
a family's container on the first add only; `--merge <base>` refuses an
existing distinct `-o`), three in `tools/test-doc-test-totals.mjs` (new),
which keeps the `Tests: a → b` notes of `docs/UPDATE_JOURNEY.md`, the pairs
the CHANGELOG quotes under `## Unreleased` and this report one measured
chain. The other review fixes changed texts, not counts: the unbrand escape
hatch names its cmd and PowerShell forms beside `env -u`, and an env-sourced
brand's server-path refusal names the variable that was set.

Tests: 880 → 881 — one more in `tools/test-doc-test-totals.mjs`: this report
exists and every `Tests: a → b` it quotes is one the journey states.

Tests: 881 → 883 — one in `tools/test-pack-conformance.mjs` (the unmarked
`+0-000-` phone fingerprint, a review fix that had landed without its note,
leaving the chain one short of `npm test`) and one in
`tools/test-doc-test-totals.mjs`: for every flat suite this batch added, the
counts the journey narrates for it sum to the `test(` calls the file holds.

Tests: 883 → 884 — one more in `tools/test-pack-conformance.mjs`: `packc
--help` lists `--quiet` for `conformance` (the tool took it unadvertised), and
every flag the CLI parses stays in its usage, the `packc` help line, the README
synopsis and the CHANGELOG entry.

## Whole-batch acceptance, as it stands at the head of this PR

- `npm test` green on Linux (884 tests; the browser smokes skip without
  `OBSERVOGRAM_PLAYWRIGHT`); green-with-counted-skips on Windows is expected,
  not verified (above).
- `npm run vendor-manifest:check` and `node tools/sync-spec.mjs --check`
  green; `npm run lint` 0 errors.
- Defaults byte-identical: `npm run test:golden`, `test:golden:compile` and
  `tools/test-golden-board.mjs` prove it, with the two B2b crawl-golden
  regenerations and the one B2a `legacy.scaffoldCount` value as the stated
  exceptions.
- `docs/DOWNSTREAM.md`: §10 bundle baking, §11 conformance workflow, §12
  packs born canonical and the named follow-ups (two of them carry their GAP
  names, B3.2 and B3.5), §13 the Windows statement.

## Deferred — B3, GAP batch 2

The five generic reliability-workflow features (verdict / trust model,
waivers, diagnose → remediate flow, glossary widgets, service audit report)
are not in this PR by decision, not by omission: they are a second PR on the
same branch contract, so that B1, B2 and B4 — the three items the downstream's
cutover blocks on — review and land on their own. Nothing of B3 is designed
here; `docs/DOWNSTREAM.md` §12 only reserves the names *Waivers (GAP batch 2,
B3.2)* and *Service audit report (GAP batch 2, B3.5)* where the conformance
engine will meet them.
