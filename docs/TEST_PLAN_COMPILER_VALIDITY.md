# Test Plan — Compiler Validity Against Real Backends

*Commissioned 2026-06-11. The claim under test: "the pack is the
program" — every artifact Observogram compiles must be **ingestible by
the platform it targets**, attested by that platform's own validator,
not by our shape assertions. Today `tools/test-compile.mjs` checks that
outputs are well-shaped (YAML round-trips, `groups:` present, schema
floors); nothing checks that Prometheus, Grafana, Alertmanager, or the
OTel Collector would actually accept the files. That gap is what this
plan closes.*

> **P1 status — DELIVERED (same day).** `npm run fetch-validators` +
> `npm run test:backend[:strict]` are live; the strict run joins CI and
> the default `npm test`. On its FIRST run the suite caught six classes
> of real compiler bugs (every fixture pack affected — none of the
> emitted files would have loaded), all fixed in the same change:
> 1. burn-rate alerts double-wrapped expression-shaped SLI legs in
>    `sum(rate(...))` — invalid PromQL on every ratio SLO;
> 2. scalar SLI legs (`total: "1"`) were range-selected (`rate(1[5m])`);
> 3. unicode SLI ids landed raw in recording-rule names (and unresolved
>    in `ref:` substitution) — promtool parse errors;
> 4. Alertmanager receivers emitted `"# secret: …"` pseudo-comments as
>    URLs plus schema-invalid fields (`room`, `target`) — amtool
>    rejected every config; now `*_file` secret refs + SMTP globals;
> 5. the removed `jaeger` exporter was emitted verbatim, and exporters/
>    processors with required fields round-tripped as empty blocks;
> 6. every receiver/processor was wired into every pipeline — the
>    collector refuses signal-restricted components (prometheus
>    receiver in traces, tail_sampling in metrics).
>
> 165 artifacts across 8 packs now pass strict T1. T2 (Grafana
> container), T3 (promtool behavioral), T4 (round trip) remain per §8.

> **T4 status — DELIVERED.** `npm run test:backend:live[:strict]`
> (CI job `backend-live`) runs the full product story against a real
> Grafana 12.4.4 (docker/validate.compose.yaml): compile → the server's
> real `deploy-bulk` MCP path → fetch-live builder → diff engine →
> aligned. `tools/lib/grafana-mcp-bridge.mjs` plays otel-mcp-server's
> gateway role over the Grafana HTTP API (including its
> ${DS_PROMETHEUS}→datasource mapping), so every ratified layer is the
> production code. The first runs caught and fixed:
> 1. dashboard uids over Grafana's 40-char limit — every payment-service
>    dashboard deploy was rejected outright;
> 2. rule-uid truncation COLLISIONS — `…good_5m`/`…total_5m`/`…ratio_5m`
>    sliced to the same 40 chars, so deploys silently overwrote each
>    other and only the last rule survived (now fingerprint-suffixed);
> 3. round-trip identity loss for dashboards — fixed by the new
>    `obs-pack-id:<id>` tag the compiler stamps and the live fetcher
>    honours, so deployed dashboards come back under their declared
>    canonical id (untagged dashboards keep the uid-first derivation);
> 4. Grafana-managed recording rules were invisible to the fetcher's
>    vmalert-first probe — the gateway exposes `list_recording_rules`.
>
> Result: 24 deployed artefacts (15 recording + 5 alerting rules, 4
> dashboards) → 100% confirmed live by the diff, 0 decision-bearing
> drift (4 cosmetic Grafana-normalisation rewrites, tolerated by
> design). Remaining: T2 version matrix (Grafana 13), T3.

> **T2 status — DELIVERED.** The "Grafana 12 / 13" flavor claim is now
> attested on both versions (12.4.4 + 13.0.2 in the compose stack):
> full deploy through the real path to EACH version, then a deep
> round-trip comparison of the decision-bearing fields — dashboard
> title/uid/panel-count/schemaVersion, alert-rule title/condition/
> refIds/PromQL, recording-rule record.metric — all field-exact on both
> versions (4 dashboards + 20 rules each). T2a covers the flavor's
> documented FILE path: the compiled provisioning YAML (with the
> operator's documented `${DS_PROMETHEUS}` substitution) is mounted,
> reloaded via the admin provisioning endpoint, and all 20 rules load.
> T1 additions: `mimirtool rules lint` (strict, linux/darwin — attests
> the "Mimir-compatible" claim; no Windows build upstream) and
> `dashboard-linter` (advisory, per §3.3). Remaining: T3.

## 1 · What the compiler emits (the surface under test)

From `tools/lib/compile.mjs` (`compileCatalog` / `compileArtifact`):

| # | Group | Flavor | Output | Claimed consumer | Items |
|---|---|---|---|---|---|
| 1 | rules | `prometheus` | Prometheus rules YAML (recording + multi-window burn alerts + forecast) | Prometheus / **Mimir** / Grafana Cloud Metrics — `rule_files:` or Mimir ruler API | `all`, per-SLO, per-declared-rule |
| 2 | rules | `grafana-managed` | Grafana provisioning YAML (`apiVersion: 1`) | Grafana 9+ unified alerting — `provisioning/alerting/` or `POST /api/v1/provisioning/alert-rules` | `all`, per-SLO, per-rule |
| 3 | dashboards | `grafana` | Dashboard JSON (schemaVersion ≥ 30, default 41) | Grafana 12/13 dashboards API / UI import | bundle, per-dashboard |
| 4 | pipelines | `collector-yaml` | Full OTel Collector config | otelcol / otelcol-contrib `--config` | `all` |
| 5 | alertmanager | `alertmanager-yaml` | Full Alertmanager config (route tree + receivers) | standalone Alertmanager | `all` |

Every cell in this table gets a backend validator. A flavor whose
*claimed consumer* we cannot validate against (e.g. "Mimir-compatible")
either gets its own validator tier or the claim gets softened — no
unverifiable platform claims in the catalog copy.

## 2 · Validation tiers

| Tier | Question | Mechanism | Where it runs |
|---|---|---|---|
| **T0** | is it well-shaped? | existing `test-compile.mjs` assertions | every `npm test` (already green) |
| **T1** | does the backend's offline validator accept it? | pinned validator binaries (`promtool`, `amtool`, `otelcol-contrib validate`, `mimirtool`) | every `npm test` when binaries present; **mandatory in CI** |
| **T2** | does a live backend accept it? | disposable Grafana container; provisioning load + HTTP import APIs | CI job (docker), nightly + on compile-path PRs |
| **T3** | does it *behave* right? | `promtool test rules` with synthetic series generated from the SLO objectives | every `npm test` (promtool only) |
| **T4** | does the loop close? | compile → deploy to the T2 Grafana → fetch back via API → diff → expect aligned | CI nightly (reuses verify-deploy + diff engines) |

T1 is the heart of the request and ships first. T3 is where compiler
*validity* (not just acceptability) lives: a rules file can be
syntactically perfect and still encode a burn-rate alert that can never
fire.

## 3 · Per-artifact validation

### 3.1 Prometheus rules (`rules` / `prometheus`)

- **T1:** `promtool check rules <file>` — parses YAML structure, every
  PromQL expression, duplicate rule names, label validity. Run against
  the `all` item AND every per-SLO / per-declared item (per-item
  emission has its own code path in `compileArtifact`).
- **T1b (Mimir claim):** `mimirtool rules lint --rule-files <file>` +
  `mimirtool rules check --rule-files <file>`. The flavor label says
  "Mimir-compatible" — attest it or relabel it.
- **T3 (behavioral):** generate a `promtool test rules` fixture per
  SLO from the canonical pack itself:
  - synthetic `input_series` where the good/total ratio sits clearly
    ABOVE the objective → assert **no** burn alert fires;
  - series sitting clearly BELOW (fast-burn rate) → assert the
    `<slo>_burn_<factor>x` alert fires with the expected `severity`
    label and `for:` behaviour;
  - recording rules: assert `:ratio_5m` / `:error_ratio_5m` evaluate
    to the analytically expected value at a fixed eval time.
  The fixture generator is pure (canonical → test YAML) and lives next
  to the compiler, so it stays in lock-step with rule emission.
- **Failure semantics:** any promtool non-zero exit fails the suite
  with promtool's stderr verbatim (it names line + expression).

### 3.2 Grafana-managed rules (`rules` / `grafana-managed`)

No offline validator exists for unified-alerting provisioning YAML —
the truth is Grafana itself. Two-stage:

- **T2a (provisioning load):** start the pinned Grafana container with
  the emitted file mounted under `/etc/grafana/provisioning/alerting/`;
  poll `/api/health`, then assert (a) the container is healthy and (b)
  `grep -i "error.*provisioning"` of the container log is empty —
  Grafana logs loudly and keeps running on bad provisioning files, so
  the log grep is the actual assertion.
- **T2b (API path):** `POST /api/v1/provisioning/alert-rules` per rule
  (the deploy modal's real path) → expect 2xx; then GET it back and
  compare the round-tripped rule (title, condition, data refIds).
- **Version matrix:** Grafana **12** and **13** images (the flavor
  label claims both).

### 3.3 Dashboards (`dashboards` / `grafana`)

- **T1 (lint):** `dashboard-linter lint <file>` (grafana/dashboard-linter,
  pinned) — catches template/datasource/panel-shape issues offline.
  Advisory at first (warnings reported, not failing) because the linter
  encodes opinions beyond validity; promote rules we agree with to
  failing one by one.
- **T2 (authoritative):** `POST /api/dashboards/db` with
  `{"dashboard": <json>, "overwrite": true}` against Grafana 12 and 13
  → expect 200 and a returned uid; then `GET /api/dashboards/uid/:uid`
  and assert panel count and schemaVersion survived import (Grafana
  rewrites schemas on import — a big delta here means we emit something
  Grafana only half-understands).
- Cover the bundle item AND each per-dashboard item; cover a pack with
  `provider.schemaVersion` pinned low (30) to attest the floor really
  is accepted by Grafana 12/13, or tighten the floor.

### 3.4 OTel Collector config (`pipelines` / `collector-yaml`)

- **T1:** `otelcol-contrib validate --config=<file>` with the pinned
  contrib distribution (the emitted exporters — prometheus/loki/tempo
  kinds — live in contrib). `validate` instantiates the full component
  graph: unknown components, bad pipeline references, and type errors
  all fail here without starting the collector.
- Also run against **core** `otelcol` and record the result: the flavor
  copy says "contrib or core" — if core lacks an emitted component,
  the copy must say contrib-only.

### 3.5 Alertmanager config (`alertmanager` / `alertmanager-yaml`)

- **T1:** `amtool check-config <file>` (pinned alertmanager release).
  The compiler emits a complete config (route + receivers), so no
  wrapping is needed. Known edge to attest: the crawler already
  excludes unresolved `${VAR}` receivers — add a fixture that would
  have contained one and assert the emitted config still passes.

## 4 · Fixture matrix

Validators run over every (pack × group × flavor × item) combination:

| Pack | Why it's in the matrix |
|---|---|
| `vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml` | the canonical spec example — must always pass everything |
| `examples/production-curated.pack.yaml` | curated rich pack |
| every pack in `examples/` and the reference packs | breadth: each exercises different layers |
| a crawled pack (krystaline repo crawl, regenerated in CI from a committed crawl fixture) | crawler-emitted artefacts are the messy real-world path — synthetic recording-rule candidates, inferred bindings |
| an MCP-drafted live pack (committed snapshot, not fetched in CI) | live-drafted shape — annotations, discovered dashboards |
| **adversarial micro-packs** (new, committed under `tools/fixtures/compile/`) | empty SLO list · SLO without objective · unicode/quote-hostile names · 100-SLO scale pack · dashboard with pinned schemaVersion 30 |

Rule: any pack the studio can load is a pack the compiler must emit
valid artifacts for — if a fixture can't compile validly, either the
compiler or the fixture's right to exist gets fixed, never the test.

## 5 · Harness design

```
tools/fetch-validators.mjs       # downloads pinned binaries → .tools/ (gitignored)
tools/test-backend-validate.mjs  # T1 + T3: promtool/amtool/otelcol/mimirtool/linter
tools/test-backend-live.mjs      # T2 + T4: docker compose up grafana-12, grafana-13
tools/lib/promtest-gen.mjs       # canonical pack → promtool test-rules fixture (pure)
docker/validate.compose.yaml     # grafana:12.x, grafana:13.x pinned digests
```

- **Binary acquisition:** `fetch-validators.mjs` downloads pinned
  releases (version + sha256 hardcoded; fail on mismatch) for
  linux/darwin/windows into `.tools/`. No npm dependencies — keeps the
  zero-dep stance; validators are dev tooling, never shipped.
  Pins (initial): Prometheus 3.x LTS (promtool) + 2.53 LTS in the CI
  matrix, Alertmanager 0.28.x, otelcol-contrib + core (matching
  versions), mimirtool 2.x, dashboard-linter (latest tagged).
- **Local behaviour:** `npm run test:backend` runs what it finds in
  `.tools/`, and prints ONE loud `SKIPPED (missing promtool — run npm
  run fetch-validators)` line per absent binary. `--strict` turns every
  skip into a failure.
- **CI behaviour:** `fetch-validators` (cached by version key) then
  `--strict`. T1/T3 join the main `validate` job; T2/T4 are a separate
  docker job — required on PRs that touch `tools/lib/compile.mjs`,
  `tools/lib/adapter.mjs`, or `vendor/observability-pack-spec/**`,
  nightly otherwise.
- **Windows note (maintainer's dev box):** promtool/amtool/otelcol all
  ship windows-amd64 releases — T1/T3 run natively; T2/T4 need Docker
  Desktop and otherwise skip loudly.
- Reuses `createHarness` from the existing suites so reporting matches
  `npm test` output.

## 6 · T4 — the round trip (closing the loop)

The deepest validity claim Observogram makes is its own product story:
compile → deploy → verify. In CI, against the disposable Grafana:

1. compile `payment-service` rules (grafana-managed) + dashboards;
2. deploy through the server's real `/api/packs/:id/deploy-bulk` path
   (the same code the deploy modal calls, snapshots and all);
3. fetch the live state back via the Grafana HTTP API into a Pack B;
4. run the diff engine and assert: every deployed artefact lands
   **aligned** — zero `declared, not live`, zero drifted fields for
   decision-bearing keys.

Anything non-aligned is, by definition, either a compiler emission bug
or a diff/identity bug — both are exactly what this plan exists to
catch, and today nothing catches them automatically.
(`tools/test-verify-deploy.mjs` already models transitions; T4 feeds it
a real backend instead of fixtures.)

## 7 · Acceptance criteria (definition of done)

1. Every row of the §1 table has at least a T1 (or T2 where no offline
   validator exists) check running in CI, strict.
2. Every fixture in §4 passes every applicable validator, or carries a
   tracked issue with the failing validator output quoted.
3. `promtool test rules` behavioral fixtures exist for the burn-rate
   and recording-rule families, generated from the pack (not
   hand-written), asserting fires/doesn't-fire both ways.
4. Platform claims in catalog copy ("Mimir-compatible", "12 / 13",
   "contrib or core") are each backed by a passing check or reworded.
5. The suite stays usable: T1+T3 add < 60 s locally; CI total stays
   inside a 10-minute budget (binaries cached, containers parallel).
6. A new red test reproduces before any compiler fix lands (the suite
   is the regression net, not decoration).

## 8 · Phasing

| Phase | Scope | Effort | Value |
|---|---|---|---|
| **P1** | `fetch-validators` + T1 for promtool, amtool, otelcol-contrib over the full fixture matrix; CI strict | ~½ day | catches the whole class of "backend rejects our file" bugs |
| **P2** | T3 promtool behavioral fixtures (generator + burn/recording assertions) | ~1 day | catches "valid but wrong" rules — true compiler validity |
| **P3** | T2 Grafana 12/13 container: provisioning load, alert-rule POST, dashboard import round-trip; mimirtool + dashboard-linter | ~1 day | attests the Grafana-facing flavors + version claims |
| **P4** | T4 full round trip via deploy-bulk + diff | ~½ day | guards the product story end-to-end |

## 9 · Risks & calls

- **Validator drift:** pinned versions go stale — pin review rides the
  monthly dependency pass; the version matrix makes bumps observable.
- **dashboard-linter opinions ≠ validity:** start advisory, promote
  selectively; the T2 import is the authoritative dashboard check.
- **Grafana import rewrites:** the T2b/3.3 round-trip comparison must
  ignore Grafana-injected defaults (compare a projected subset, reuse
  the diff engine's volatile-field stripping rather than inventing a
  second comparator).
- **CI time:** containers only in the docker job; T1 binaries are
  seconds. The 5-minute `validate` job budget grows to ~7 with T1+T3.
- **No new runtime deps:** everything lands in `tools/` + `.tools/` +
  one compose file; `package.json` dependencies untouched.
