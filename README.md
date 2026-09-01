# Observogram

*(formerly **Tomograph** — pre-rebrand env vars, headers, workspaces, and pack annotations keep working; see docs/CHANGELOG.md.)*

**Observogram is the observability compiler and diagnostic workspace for
ObservabilityPack spec v1.2.**

It answers one operational question:

> Is this service's observability diagnostic-grade?

Observogram checks that in two parts:

1. **Coverage** - are we observing the right signals for the service's
   observability goals and OLA?
2. **Trust** - do the declared signals, rules, dashboards, alerts, and response
   paths match what is active in production?

The workflow is intentionally simple:

```text
Discover -> Diagnose -> Remediate
```

Use a repo scan, a live MCP scan, or an uploaded pack to create an
ObservabilityPack. Compare the declared repo posture with the live production
posture. Then compile and deploy the delta through the platform tools.

In Observogram, the OLA is represented as an observability contract inside the
pack: criticality, SLOs, SLIs, telemetry bindings, rules, dashboards, alerts,
runbooks, and validation expectations. A repo-derived pack captures what the
service declares. A live MCP-derived pack captures what production verifies.
The gap between those two packs is the diagnostic finding.

The canonical specification lives at
[MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack).
A checksummed copy is vendored under
[`vendor/observability-pack-spec/v1.2/`](vendor/observability-pack-spec/v1.2/).

## Why It Exists

Most observability failures are not caused by a missing chart. They come from
drift:

- the repo declares an SLO, but the recording rule is not in production
- Grafana has dashboards that no pack owns
- alerts still exist, but their thresholds no longer match the SLO
- live telemetry exists, but no OLA or runbook says why it matters
- the team cannot explain whether the service is truly diagnosable

Observogram treats observability as a compiled contract. The pack is the source
of truth. Native artifacts are generated from it. Live systems are scanned back
into pack shape. The diff between declared and live is the operational truth.

## Main Journey

### 1. Discover - What Do We Have?

Create or load a pack:

- scan a service repository
- generate a live pack from an OpenTelemetry MCP server
- upload a canonical YAML or JSON ObservabilityPack

The Discover view renders the observability Observogram across the layered model:

- L1 Contract: SLIs and SLOs
- L2 Telemetry: OTel, backends, collectors, pipelines
- L3 Insight: recording rules, dashboards, derived views
- L4 Action: alerts, routes, remediations
- L5 Validation: baselines, synthetics, chaos, release checks
- GOV: ownership and governance metadata

![Observogram Discover view showing the layered observability inventory](docs/img/xray-discover.png)

### 2. Diagnose - Can We Trust It?

Load the declared repo pack as **Pack A** and the live production pack as
**Pack B**. Observogram computes the Diagnostic Grade:

- **Score**: total criteria passed out of 7
- **Coverage**: four checks for "are we observing the right things?"
- **Trust**: three checks for "can we trust what the signals show?"
- **Operability**: one informational check (Actionable — runbooks linked),
  displayed but never scored
- **Verified**: whether a live MCP signal is present

The score maps onto a metrology-style **instrument grade** — the rating users
actually read; the full ladder renders on the grade card with the current rung
highlighted:

| Grade | Class | Score band |
|---|---|---|
| A++ | Calibration / Reference Grade | — (needs external reference benchmarking) |
| A+ | Laboratory / Research Grade | ≥ 95% |
| A | Diagnostic / Clinical Grade | > 85% (the audit bar) |
| B+ | Inspection Grade | ≥ 75% |
| B | Industrial Grade | ≥ 62.5% |
| C | Field Grade | ≥ 37.5% |
| D | Consumer Grade | < 37.5% |

The machine contract is unchanged: the audit **passes when the score is
greater than 85%** — i.e. exactly when the grade is A or better; the letter
and PASS/FAIL can never disagree. Failed criteria remain visible as evidence.
A pack can therefore pass the grade while still showing drift that belongs in
Remediate.

The checks are (grade schema 2):

| Area | Criteria | Scored |
|---|---|---|
| Coverage | Multi-modal, Correlated, Calibrated, Comprehensive | yes |
| Trust | Chaos-validated, Drift-free, Fresh | yes |
| Operability | Actionable | no — informational |

Runbooks measure response readiness of the overall solution, not diagnostic
capability — a perfectly diagnostic system tells you what is wrong even when
nobody wrote the response script. The runbook gap stays visible on the grade
card and in the posture matrix; it just no longer costs diagnostic credit.

The drift drill shows:

- aligned artifacts
- matched artifacts whose behavior drifted
- declared artifacts not confirmed live
- live-only shadow signals
- out-of-scope live inventory that belongs to the wider platform

Traceability shows requirement chains from SLO to SLI, metrics, recording
rules, exporters, scrape evidence, dashboards, alerts, and runbooks.

![Observogram Diagnose view showing Diagnostic Grade and live drift buckets](docs/img/xray-diagnose-drift.png)

### 3. Remediate - Fix The Gaps

Observogram compiles the pack delta into native backend artifacts:

- Prometheus recording and alerting rules
- Grafana-managed rules
- Grafana dashboards
- OTel Collector pipelines
- Alertmanager routes

Deployable artifacts can be pushed through an MCP write target. Non-deployable
or inferred artifacts remain visible as manual follow-up, not silent production
changes.

![Observogram Remediate view showing the Pack A minus Pack B deploy delta](docs/img/xray-remediate.png)

## Quickstart

```bash
git clone https://github.com/MoebiusX/Observogram.git
cd Observogram
npm install
npm run dev
```

Open `http://127.0.0.1:8000` and sign in with **admin / admin** — first
boot seeds this default user and asks for a password change at sign-in
(skippable for now; it asks again each sign-in until a real password
lands — or change it any time from the account menu, top right). From
there it's a signed-in app: your packs, deploy audit and run history
belong to you. (`OBSERVOGRAM_AUTH=off` skips login entirely
for a throwaway open sandbox.)

### Security Posture

1. **Local (default).** The server binds to `127.0.0.1` and ships like
   Grafana: first boot seeds a default `admin` user (password `admin`,
   change asked at every sign-in until it lands — skippable per
   session). The default credential is
   loopback-only — the server refuses to bind beyond loopback until it
   is changed; container/network first boots seed a real secret with
   `OBSERVOGRAM_ADMIN_PASSWORD` instead. `OBSERVOGRAM_AUTH=off` restores
   the pre-0.5 open mode: no login, a zero-friction local workspace.
2. **Exposed with a token.** Set `OBSERVOGRAM_API_TOKEN=<secret>` and bind
   wherever you need (`HOST=0.0.0.0`). Mutating `/api/*` routes (crawl,
   draft, validate-register, deploy, verify, reset) then require
   `Authorization: Bearer <secret>`; read routes stay open. Set
   `OBSERVOGRAM_API_TOKEN_LABEL=<team-or-owner>` to stamp the deploy audit
   log with the token's ownership — the secret itself never lands in any
   log. A token configured on a fresh workspace suppresses the
   default-admin seed: the token is the expressed auth intent.
3. **Exposed without any auth.** The server **refuses to start** with a
   clear message. `OBSERVOGRAM_INSECURE_NO_AUTH=1` overrides knowingly (it
   logs a loud warning) for trusted-network demos only.

Real users and SSO: `npm run users` manages locally-defined accounts,
`OBSERVOGRAM_OIDC_*` wires any OIDC provider, and `npm run orgs` arms
workspace-per-org tenancy — see
[docs/PRODUCTIZATION_PLAN.md](docs/PRODUCTIZATION_PLAN.md).

MCP write tokens are unrelated to the API token: they pass through per
request and are never stored server-side. Registered packs and the deploy
audit live in the `.observogram/` workspace (`OBSERVOGRAM_WORKSPACE`
relocates it).

Useful local checks:

```bash
npm run lint:server
npm run lint:studio
npm run lint:crawler
npm run lint:fetcher
npm run test
```

### Run In Docker Or Kubernetes

The whole app is one Express process, so the container story is one image:

```bash
docker build -t observogram:0.4.0 .
docker run --rm -p 8000:8000 observogram:0.4.0
```

Kubernetes manifests (Deployment + Service + Ingress, applied with Kustomize)
live in [`deploy/k8s/`](deploy/k8s/README.md):

```bash
kubectl apply -k deploy/k8s
```

## Common Operations

### Scan A Repo

```bash
npm run crawl -- path/to/service-repo --name krystalinex-core --env prod > repo.pack.yaml
npm run validate-pack -- repo.pack.yaml
```

The crawler reads source files such as:

- Prometheus rule files
- Grafana dashboard JSON
- Alertmanager config
- OTel Collector config
- Helm and Kubernetes manifests
- Docker Compose files

It emits a canonical v1.2 pack plus crawler annotations describing what was
scanned and what was inferred.

### Fetch Live From MCP

```bash
MCP_URL=https://otel-mcp.example.com/mcp \
MCP_AUTH=$MCP_CLIENT_KEY \
npm run fetch-live
```

The default output is the ignored local file `examples/production-live.pack.yaml`.

See [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) for the live fetch and
write-back contract.

### Validate Or Upload A Pack

```bash
npm run validate-pack -- path/to/pack.yaml
```

The studio also accepts drag-and-drop or file picker upload. Uploaded, crawled,
and MCP-drafted packs are registered in memory and become addressable through
the same `/api/packs/:id/*` endpoints as catalog packs.

### Compile Artifacts

```bash
# Enumerate the compile tree
curl http://127.0.0.1:8000/api/packs/<pack-id>/compile-catalog

# Compile one artifact
curl "http://127.0.0.1:8000/api/packs/<pack-id>/compile-artifact?group=rules&flavor=grafana-managed&artifact=slo:slo_settlement_latency_99"
```

The UI exposes the same path through **Remediate -> Compile & Deploy**.

### Saved Journeys — Repeatable Drift Checks

Freeze a comparison as a journey file and run it on demand or on a schedule:

```yaml
# .observogram/journeys/repo-vs-live.journey.yaml
name: repo-vs-live
packA:
  crawl: { path: ../my-service, name: my-service, env: prod }
packB:
  mcp: { url: https://otel-mcp.example.com/mcp, authEnv: MY_MCP_TOKEN }
gate:
  minAlignmentPct: 85
  requireGradePass: true
  maxLiveAgeHours: 24
```

```bash
node tools/cli.mjs journey run repo-vs-live          # markdown report
node tools/cli.mjs journey run repo-vs-live --json   # automation output
node tools/cli.mjs journey list                      # journeys + last outcome
```

Exit codes follow the gate contract: `0` verdict passes, `1` gate failed,
`2` tooling/config error — so the same command is a cron job, a Windows
scheduled task, or a CI gate. Every run appends a JSON record under
`.observogram/runs/<journey>/` (the drift-over-time series). Secrets never
live in journey files — MCP auth is referenced by env-var name.

## API Surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Health and vendored spec version |
| `GET` | `/api/packs` | In-memory and catalog pack registry |
| `GET` | `/api/examples` | Bundled example packs |
| `GET` | `/api/references` | Curated catalogue reference packs |
| `GET` | `/api/packs/:id` | Adapted layered pack |
| `GET` | `/api/packs/:id/canonical` | Canonical pack with env overlay |
| `GET` | `/api/packs/:id/conformance` | Maturity-rubric scoring |
| `GET` | `/api/diff?a=&b=` | Repo/live or pack/pack structural diff |
| `GET` | `/api/packs/:id/compile-catalog` | Per-artifact compile tree |
| `GET` | `/api/packs/:id/compile-artifact` | Compile one artifact or group |
| `POST` | `/api/validate` | Validate and register uploaded YAML/JSON |
| `POST` | `/api/crawl` | Draft a pack from uploaded repo files |
| `POST` | `/api/crawl-github` | Draft a pack from a GitHub URL |
| `POST` | `/api/draft-from-mcp` | Draft a live pack from an MCP endpoint |
| `POST` | `/api/packs/:id/deploy-bulk` | Deploy selected compiled artifacts |
| `POST` | `/api/packs/:id/deploy/:target` | Deploy one compiled target |
| `DELETE` | `/api/uploads` | Clear uploaded/crawled/drafted packs |

## Repository Map

```text
server/
  index.mjs                Express API, upload registry, compile/deploy routes
  test-smoke.mjs           End-to-end route smoke tests

studio/
  app.mjs                  Browser app shell and three-step workflow
  compare-view.mjs         Diagnostic Grade, drift, traceability entry points
  compile-view.mjs         Remediate, compile catalog, deploy surfaces
  layers-view.mjs          Discover Observogram and artifact cards

tools/
  crawl-repo.mjs           CLI repo crawler
  fetch-live-pack.mjs      MCP live-pack fetcher
  validate-pack.mjs        Canonical pack validator
  lib/
    adapter.mjs            Canonical pack -> layered UI model
    compile.mjs            packc compiler
    conformance.mjs        Maturity rubric
    diff.mjs               Structural pack diff
    traceability.mjs       Requirement chains

examples/
  production-curated.pack.yaml
  target-advanced.pack.yaml
  demo-skeleton.pack.yaml

vendor/observability-pack-spec/v1.2/examples/
  payment-service.pack.yaml

reference-packs/
  kafka.pack.yaml
  prometheus.pack.yaml
  grafana.pack.yaml

deploy/k8s/
  kustomization.yaml       Kustomize entry point (see deploy/k8s/README.md)
```

## Key Docs

- [`docs/USER_JOURNEY.md`](docs/USER_JOURNEY.md) - product journey and design invariants
- [`docs/DRY_RUN.md`](docs/DRY_RUN.md) - dry-run script and readiness checklist
- [`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md) - V1 release gate
- [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) - live fetch, verification, deploy writes
- [`docs/MODEL.md`](docs/MODEL.md) - the layered observability model (L1–L5, L2X, GOV)
- [`docs/DIFF.md`](docs/DIFF.md) - structural alignment and drift model
- [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) - maturity rubric scoring
- [`docs/DIAGNOSTIC_GRADE_FRAMEWORK.md`](docs/DIAGNOSTIC_GRADE_FRAMEWORK.md) - the eight coverage/trust criteria behind the Diagnose grade
- [`docs/PHASE_1_VERDICT_TRUST_RESEARCH.md`](docs/PHASE_1_VERDICT_TRUST_RESEARCH.md) - draft research/spec for the verdict-trust phase
- [`docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md`](docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md) - requirement-chain comparison semantics
- [`docs/USER_STORY_CRAWLER_PROVENANCE.md`](docs/USER_STORY_CRAWLER_PROVENANCE.md) - provenance requirements for deployable artifacts
- [`docs/USER_STORY_REQUIRED_DEPLOYMENT_ENVIRONMENT.md`](docs/USER_STORY_REQUIRED_DEPLOYMENT_ENVIRONMENT.md) - backlog story for required crawl environment selection
- [`docs/ADVANCED_FEATURE_AUDIT.md`](docs/ADVANCED_FEATURE_AUDIT.md) - per-view audit of the Advanced tools (References · Conformance · Schema · OTLP · Traceability · Atlas)
- [`docs/VALUE_BACKLOG.md`](docs/VALUE_BACKLOG.md) - prioritized product backlog for the next iterations
- [`docs/REFACTORING_PLAN.md`](docs/REFACTORING_PLAN.md) - maintainability refactor backlog from the 2026-06 audit
- [`docs/BRANCHING.md`](docs/BRANCHING.md) - the branching model: lanes, per-commit bar, multi-writer rules, promotion cadence
- [`docs/VENDORING.md`](docs/VENDORING.md) - vendoring the verdict/diff engines into a downstream studio, and how to stay current
- [`docs/UI_CONVENTIONS.md`](docs/UI_CONVENTIONS.md) - studio view-module conventions: the host seam, loader/renderer split, render signatures, CSS zones

Superseded planning docs live in [`docs/archive/`](docs/archive/README.md).

## License

MIT - see [LICENSE](LICENSE).
